"""교체 클립을 원본 화질로 다시 받아 잘라 넣고, 최종 데이터셋을 재생성한다.

  1) replacements.json 의 각 항목을 720p로 재다운로드 → trim → h264+aac 정규화
  2) references/ 의 해당 idx 파일 교체, manifest 갱신
  3) app/data/annotations.json 갱신
  4) 오디오 온셋 재분석 후 app/data/clips.json 생성
"""
import glob
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import wave
import array

ROOT = r"C:\Claude\perception"
REFS = os.path.join(ROOT, "references")
DATA = os.path.join(ROOT, "app", "data")
FFDIR = (r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages"
         r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin")
FFMPEG = os.path.join(FFDIR, "ffmpeg.exe")
FFPROBE = os.path.join(FFDIR, "ffprobe.exe")

_deno = glob.glob(os.path.expandvars(
    r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\DenoLand.Deno*\deno.exe"))
if _deno:
    os.environ["PATH"] = os.path.dirname(_deno[0]) + os.pathsep + os.environ["PATH"]

SR, HOP = 16000, 800
FOCUS_LEN = 5.6          # 1막에서 들려줄 이벤트 집중 구간 길이(초)


def probe_duration(path):
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return float(out.strip())


def fetch_and_trim(video_id, start, end, dest):
    """원본을 720p로 받아 지정 구간만 잘라 정규화한다."""
    tmp = os.path.join(tempfile.gettempdir(), f"src_{video_id}.mp4")
    if not os.path.exists(tmp):
        subprocess.run([sys.executable, "-m", "yt_dlp",
                        f"https://www.youtube.com/watch?v={video_id}",
                        "-f", "bv*[height<=720]+ba/bv*+ba/b", "--merge-output-format", "mp4",
                        "--ffmpeg-location", FFDIR, "--no-playlist", "--no-warnings",
                        "--quiet", "--no-progress", "-o", tmp], check=False)
    if not os.path.exists(tmp):
        raise RuntimeError(f"다운로드 실패: {video_id}")

    # -ss 를 -i 앞에 두면 키프레임 단위로 건너뛰어 빠르지만 오차가 생긴다.
    # 재인코딩하므로 -i 뒤에 두어 프레임 단위로 정확히 자른다.
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", tmp,
                    "-ss", f"{start:.2f}", "-t", f"{end - start:.2f}",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p",
                    "-vf", "scale='min(1280,iw)':-2",
                    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                    "-movflags", "+faststart", dest], check=True)
    return probe_duration(dest)


def envelope(path):
    wav = os.path.join(tempfile.gettempdir(), "fin_env.wav")
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
                    "-vn", wav], check=True)
    with wave.open(wav) as w:
        s = array.array("h", w.readframes(w.getnframes()))
    os.remove(wav)
    env = []
    for i in range(0, len(s) - HOP, HOP):
        ch = s[i:i + HOP]
        env.append(math.sqrt(sum(x * x for x in ch) / len(ch)) / 32768.0)
    peak = max(env) or 1.0
    return [round(v / peak, 4) for v in env]


def onset_of(env, hop_s):
    """맨 앞 0.25초는 인코딩 클릭이 섞이므로 피크 탐색에서 제외한다."""
    skip = min(int(0.25 / hop_s), max(len(env) - 1, 0))
    body = env[skip:] or env
    top = skip + max(range(len(body)), key=lambda i: body[i])
    i = top
    while i > skip and env[i] > 0.22:
        i -= 1
    return i * hop_s, top * hop_s


def norm_loudness(v):
    """에이전트가 0~100으로 답한 경우가 있어 1~10으로 맞춘다."""
    v = int(v)
    return max(1, min(10, round(v / 10) if v > 10 else v))


def main():
    reps = json.load(open(os.path.join(ROOT, "tools", "replacements.json"), encoding="utf-8"))
    manifest = json.load(open(os.path.join(REFS, "_meta", "manifest.json"), encoding="utf-8"))
    anns = {a["idx"]: a for a in json.load(open(os.path.join(DATA, "annotations.json"), encoding="utf-8"))}

    for rep in reps:
        idx = rep["idx"]
        for old in glob.glob(os.path.join(REFS, f"{idx}_*.mp4")):
            os.remove(old)
        dest = os.path.join(REFS, f"{idx}_{rep['slug']}.mp4")
        dur = fetch_and_trim(rep["video_id"], rep["trim_start"], rep["trim_end"], dest)
        print(f"{idx} {rep['slug']:32s} {dur:5.2f}s  ({rep['trim_start']}~{rep['trim_end']})", flush=True)

        for m in manifest:
            if m["idx"] == idx:
                m.update({"id": rep["video_id"], "slug": rep["slug"],
                          "event_ko": rep["annotation"]["title_ko"],
                          "source": rep["annotation"]["visual"]["camera_view"]})
        a = dict(rep["annotation"], idx=idx)
        a["sound"] = dict(a["sound"], loudness=norm_loudness(a["sound"]["loudness"]))
        anns[idx] = a

    json.dump(manifest, open(os.path.join(REFS, "_meta", "manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    # 남아 있는 기존 주석의 loudness 스케일도 함께 정리한다
    for a in anns.values():
        a["sound"]["loudness"] = norm_loudness(a["sound"]["loudness"])

    ordered = [anns[k] for k in sorted(anns)]
    json.dump(ordered, open(os.path.join(DATA, "annotations.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    # ── 최종 clips.json 생성
    clips = []
    for a in ordered:
        found = glob.glob(os.path.join(REFS, f"{a['idx']}_*.mp4"))
        if not found:
            print(f"  ! {a['idx']} 파일 없음 — 건너뜀")
            continue
        path = found[0]
        dur = probe_duration(path)
        env = envelope(path)
        hop_s = HOP / SR
        onset, peak = onset_of(env, hop_s)
        start = max(0.0, min(onset - 0.9, max(0.0, dur - FOCUS_LEN)))
        clips.append({
            "idx": a["idx"],
            "file": os.path.basename(path),
            "title_ko": a["title_ko"],
            "duration": round(dur, 2),
            "onset": round(onset, 2),
            "peak": round(peak, 2),
            "focus": [round(start, 2), round(min(dur, start + FOCUS_LEN), 2)],
            "sound": a["sound"],
            "visual": a["visual"],
            "semantics": a["semantics"],
        })

    json.dump(clips, open(os.path.join(DATA, "clips.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    print(f"\nclips.json 생성 완료 — {len(clips)}개")
    for c in clips:
        print(f"  {c['idx']} {c['file'][:38]:38s} {c['duration']:5.2f}s "
              f"onset={c['onset']:5.2f} focus={c['focus'][0]:.1f}~{c['focus'][1]:.1f}  {c['title_ko']}")


if __name__ == "__main__":
    main()
