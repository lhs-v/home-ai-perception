"""references/ 의 영상을 스캔해 clips.json 을 만든다.

새 mp4 를 references/ 에 넣고 `npm run ingest` 만 돌리면 데모가 그 영상을 쓴다.

기계가 잴 수 있는 것은 전부 여기서 잰다.
  - 코덱 정규화 (H.264 + AAC)
  - 길이, 오디오 온셋/피크, 1막에서 들려줄 집중 구간
  - 재생 게인 (피크와 평균을 함께 보고 클리핑 없이 체감 음량을 맞춘다)
  - 무음 판정 (소리로 상황을 알리는 데모라 사실상 무음이면 뽑기에서 뺀다)
  - 움직임 엔벨로프 (프레임 변화율 — 링의 구역별 결을 만든다)
  - 측정으로 유도할 수 있는 음향 질감

기계가 못 정하는 것은 자리표시자로 채우고 annotated: false 를 단다.
  - 무슨 사건인지(event_type), 얼마나 위험한지(threat), 어느 공간인지(room),
    소리가 어떻게 들리는지(cue_line), 화면에 무엇이 보이는지(description_ko)
  이건 사람이 쓰거나 프레임을 본 에이전트가 써야 한다. 지어내면 데모가 거짓말을 한다.

사람이 써둔 주석은 절대 덮어쓰지 않는다. 측정값만 갱신한다.
"""
import array
import glob
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFS = os.path.join(ROOT, "references")
DATA = os.path.join(ROOT, "app", "data")


def find_tool(name):
    """ffmpeg/ffprobe 를 찾는다.

    PATH 에 있으면 그걸 쓰고, 없으면 winget 이 깔아 두는 자리를 뒤진다.
    경로를 하드코딩하면 다른 사람 PC 에서 그대로 죽는다.
    FFMPEG_DIR 로 직접 지정할 수도 있다.
    """
    import shutil
    env = os.environ.get("FFMPEG_DIR")
    if env:
        p = os.path.join(env, name + (".exe" if os.name == "nt" else ""))
        if os.path.exists(p):
            return p
    found = shutil.which(name)
    if found:
        return found
    pattern = os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\bin" + os.sep + name + ".exe")
    hits = glob.glob(pattern, recursive=True)
    if hits:
        return hits[0]
    raise SystemExit(
        f"{name} 을 찾을 수 없다.\n"
        "  Windows:  winget install Gyan.FFmpeg\n"
        "  macOS:    brew install ffmpeg\n"
        "  Linux:    apt install ffmpeg\n"
        "  또는 FFMPEG_DIR 환경변수로 bin 폴더를 지정할 것.")


FFMPEG = find_tool("ffmpeg")
FFPROBE = find_tool("ffprobe")

SR, HOP = 16000, 800          # 오디오 엔벨로프: 16kHz, 50ms
FOCUS_LEN = 5.6               # 1막에서 들려줄 구간 길이(초)
MW, MH, MFPS, MBINS = 64, 36, 10, 48    # 움직임 분석 해상도
TARGET_PEAK, TARGET_MEAN = -3.0, -21.0
GAIN_MIN, GAIN_MAX = 0.6, 14.0
AUDIBLE_DB = -25.0            # 이보다 조용하면 뽑기 풀에서 제외


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, errors="replace", **kw)


def probe(path):
    out = run([FFPROBE, "-v", "error", "-show_entries",
               "format=duration:stream=codec_type,codec_name,width,height",
               "-of", "json", path]).stdout
    try:
        d = json.loads(out)
    except json.JSONDecodeError:
        return None
    v = next((s for s in d.get("streams", []) if s["codec_type"] == "video"), None)
    a = next((s for s in d.get("streams", []) if s["codec_type"] == "audio"), None)
    if not v:
        return None
    return {"duration": float(d["format"]["duration"]),
            "vcodec": v["codec_name"], "acodec": a["codec_name"] if a else None,
            "width": v.get("width"), "height": v.get("height")}


def normalize(path, info):
    """H.264 + AAC 가 아니면 다시 인코딩한다. 브라우저 디코더 호환성 문제를 미리 없앤다."""
    if info["vcodec"] == "h264" and info["acodec"] == "aac":
        return info
    tmp = path + ".norm.mp4"
    vargs = ["-c:v", "copy"] if info["vcodec"] == "h264" else \
            ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
             "-vf", "scale='min(1280,iw)':-2"]
    aargs = ["-c:a", "copy"] if info["acodec"] == "aac" else \
            (["-c:a", "aac", "-b:a", "128k", "-ac", "2"] if info["acodec"] else ["-an"])
    r = run([FFMPEG, "-y", "-v", "error", "-i", path, *vargs, *aargs,
             "-movflags", "+faststart", tmp])
    if os.path.exists(tmp) and r.returncode == 0:
        os.replace(tmp, path)
        print("      코덱 정규화 완료")
        return probe(path) or info
    if os.path.exists(tmp):
        os.remove(tmp)
    return info


def envelope(path):
    wav = os.path.join(tempfile.gettempdir(), "ingest_env.wav")
    if run([FFMPEG, "-y", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
            "-vn", wav]).returncode != 0 or not os.path.exists(wav):
        return []
    with wave.open(wav) as w:
        s = array.array("h", w.readframes(w.getnframes()))
    os.remove(wav)
    env = []
    for i in range(0, len(s) - HOP, HOP):
        ch = s[i:i + HOP]
        env.append(math.sqrt(sum(x * x for x in ch) / len(ch)) / 32768.0)
    pk = max(env) if env else 0
    return [v / pk for v in env] if pk else env


def onset_of(env, hop_s):
    """맨 앞 0.25초는 인코딩 클릭이 섞이므로 피크 탐색에서 제외한다."""
    if not env:
        return 0.0, 0.0
    skip = min(int(0.25 / hop_s), max(len(env) - 1, 0))
    body = env[skip:] or env
    top = skip + max(range(len(body)), key=lambda i: body[i])
    i = top
    while i > skip and env[i] > 0.22:
        i -= 1
    return i * hop_s, top * hop_s


def volume(path):
    log = run([FFMPEG, "-v", "info", "-i", path, "-af", "volumedetect",
               "-vn", "-f", "null", "-"]).stderr
    mx = re.search(r"max_volume:\s*(-?[\d.]+) dB", log)
    mn = re.search(r"mean_volume:\s*(-?[\d.]+) dB", log)
    return (float(mx.group(1)) if mx else -99.0,
            float(mn.group(1)) if mn else -99.0)


def motion_series(path):
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", path, "-r", str(MFPS),
         "-vf", f"scale={MW}:{MH},format=gray", "-f", "rawvideo", "-"],
        capture_output=True).stdout
    frame = MW * MH
    n = len(raw) // frame
    out = []
    for k in range(1, n):
        a = raw[(k - 1) * frame:k * frame]
        b = raw[k * frame:(k + 1) * frame]
        out.append(sum(abs(b[j] - a[j]) for j in range(frame)) / frame / 255.0)
    return out


def resample(series, bins):
    if not series:
        return [0.0] * bins
    out = []
    for k in range(bins):
        lo = int(k * len(series) / bins)
        hi = max(lo + 1, int((k + 1) * len(series) / bins))
        out.append(max(series[lo:hi]))
    return out


def pct(xs, q):
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, int(len(s) * q)))] if s else 0.0


def texture_from(env, hop_s):
    """엔벨로프 모양에서 음향 질감을 유도한다. 이건 측정으로 알 수 있는 것이다."""
    if not env:
        return "무음"
    med = sorted(env)[len(env) // 2] or 0.001
    crest = 1 / med
    loud_frac = sum(1 for v in env if v > 0.5) / len(env)
    # 큰 값 구간이 몇 덩어리인지 — 반복성 판단
    runs, prev = 0, False
    for v in env:
        cur = v > 0.45
        if cur and not prev:
            runs += 1
        prev = cur
    if crest > 12 and loud_frac < 0.12:
        return "짧고 날카로운 충격" if runs <= 2 else "반복되는 짧은 충격"
    if loud_frac > 0.4:
        return "길게 이어지는 소리"
    if runs >= 4:
        return "규칙적으로 반복되는 소리"
    return "완만하게 오르내리는 소리"


def slug_title(fname):
    s = os.path.splitext(fname)[0]
    s = re.sub(r"^\d+[_-]", "", s)
    return s.replace("-", " ").replace("_", " ").strip() or "미분류"


def placeholder(fname, env, hop_s, loud):
    """기계가 못 정하는 것은 지어내지 않고 자리표시자로 둔다."""
    return {
        "title_ko": slug_title(fname),
        "annotated": False,
        "sound": {
            "onomatopoeia": "—",
            "cue_line": "아직 소리 설명이 작성되지 않았다",
            "texture": texture_from(env, hop_s),      # 이건 실제 측정값이다
            "acoustic_tags": [],
            "distance": "mid",
            "loudness": loud,                          # 이것도 측정값이다
        },
        "visual": {
            "description_ko": "아직 장면 설명이 작성되지 않았다",
            "room": "미분류", "actors": [],
            "time_of_day": "unknown", "camera_view": "미분류",
        },
        "semantics": {
            "event_type": "unknown", "threat": 30, "urgency": "low",
            "tags": ["noise"],
            "fusion_note": "",
        },
    }


def main():
    # --all: 사람이 써둔 주석까지 버리고 전부 자리표시자로 되돌린다
    force = "--all" in sys.argv
    os.makedirs(DATA, exist_ok=True)
    prev_path = os.path.join(DATA, "clips.json")
    prev = {}
    if os.path.exists(prev_path):
        for c in json.load(open(prev_path, encoding="utf-8")):
            prev[c["file"]] = c

    files = sorted(os.path.basename(p) for p in glob.glob(os.path.join(REFS, "*.mp4")))
    if not files:
        print("references/ 에 mp4 가 없다.")
        return

    # 이미 쓰이고 있는 idx 를 피해서 새 번호를 준다
    used = {c.get("idx") for c in prev.values() if c.get("idx")}
    next_idx = [1]
    while f"{next_idx[0]:02d}" in used:
        next_idx[0] += 1

    clips, raw_motion = [], {}
    for n, fname in enumerate(files, 1):
        path = os.path.join(REFS, fname)
        old = prev.get(fname)
        fresh = old is None
        print(f"[{n}/{len(files)}] {fname}" + ("  (신규)" if fresh else ""), flush=True)

        info = probe(path)
        if not info:
            print("      ! 읽을 수 없는 파일 — 건너뜀")
            continue
        info = normalize(path, info)

        env = envelope(path)
        hop_s = HOP / SR
        onset, peak = onset_of(env, hop_s)
        dur = info["duration"]
        start = max(0.0, min(onset - 0.9, max(0.0, dur - FOCUS_LEN)))
        pk_db, mn_db = volume(path)
        gain = max(GAIN_MIN, min(GAIN_MAX, min(
            10 ** ((TARGET_PEAK - pk_db) / 20), 10 ** ((TARGET_MEAN - mn_db) / 20))))
        loud = max(1, min(10, round((pk_db + 40) / 4))) if pk_db > -99 else 1
        raw_motion[fname] = resample(motion_series(path), MBINS)

        # 사람이 써둔 주석은 그대로 둔다. 측정값만 새로 쓴다. (--all 이면 전부 초기화)
        ann = None if force else (old if (old and old.get("annotated") is not False) else None)
        base = ann or placeholder(fname, env, hop_s, loud)

        # 순번(n)을 그대로 쓰면 파일을 지웠다 새로 올렸을 때 기존 idx 와 충돌한다.
        # 기존 것은 자기 idx 를 지키고, 신규는 안 쓰인 번호를 받는다.
        if old and old.get("idx"):
            idx = old["idx"]
        else:
            while f"{next_idx[0]:02d}" in used:
                next_idx[0] += 1
            idx = f"{next_idx[0]:02d}"
            next_idx[0] += 1
        used.add(idx)

        clips.append({
            "idx": idx,
            "file": fname,
            "title_ko": base["title_ko"],
            "annotated": base.get("annotated", True),
            "duration": round(dur, 2),
            "onset": round(onset, 2),
            "peak": round(peak, 2),
            "focus": [round(start, 2), round(min(dur, start + FOCUS_LEN), 2)],
            "gain": round(gain, 2),
            "peak_db": round(pk_db, 1),
            "mean_db": round(mn_db, 1),
            "audible": pk_db > AUDIBLE_DB,
            "sound": base["sound"], "visual": base["visual"], "semantics": base["semantics"],
        })
        print(f"      {dur:5.2f}s  온셋 {onset:5.2f}  피크 {pk_db:6.1f}dB  게인 x{gain:.2f}"
              f"  {'가청' if pk_db > AUDIBLE_DB else '무음(제외)'}", flush=True)

    # 움직임은 전체를 함께 봐야 정규화가 맞는다.
    # 장면 전환은 한두 프레임짜리 스파이크라 클립별로 먼저 눌러낸 뒤 공통 스케일을 잡는다.
    for f, s in raw_motion.items():
        cap = pct(s, 0.97) * 1.25 or 1.0
        raw_motion[f] = [min(v, cap) for v in s]
    allv = [v for s in raw_motion.values() for v in s]
    scale = pct(allv, 0.92) or 1.0
    for c in clips:
        s = [round(min(1.0, v / scale) ** 0.55, 4) for v in raw_motion[c["file"]]]
        c["motion"] = s
        c["motion_avg"] = round(sum(s) / len(s), 4)

    json.dump(clips, open(prev_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    usable = [c for c in clips if c["audible"]]
    todo = [c for c in clips if not c.get("annotated", True)]
    print(f"\nclips.json — 전체 {len(clips)}개 / 뽑기 가능 {len(usable)}개")
    if todo:
        print(f"\n주석이 필요한 클립 {len(todo)}개 (지금은 자리표시자로 재생된다):")
        for c in todo:
            print(f"  {c['idx']} {c['file']}  움직임 {c['motion_avg']:.2f}  질감 \"{c['sound']['texture']}\"")
        print("\n  app/data/clips.json 의 title_ko / sound / visual / semantics 를 채우고")
        print("  annotated 를 지우면 그때부터 온전히 연출된다.")


if __name__ == "__main__":
    main()
