"""각 레퍼런스 클립의 오디오 RMS 엔벨로프 / 이벤트 온셋 / 대표 프레임을 추출한다."""
import json, os, subprocess, wave, array, math, tempfile

ROOT   = r"C:\Claude\perception"
REFS   = os.path.join(ROOT, "references")
FRAMES = os.path.join(ROOT, "tools", "frames")
FFDIR  = r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin"
FFMPEG = os.path.join(FFDIR, "ffmpeg.exe")

SR, HOP = 16000, 800          # 16kHz, 50ms hop
FOCUS   = 6.0                 # Act 1에서 들려줄 이벤트 집중 구간 길이(초)

os.makedirs(FRAMES, exist_ok=True)

def envelope(path):
    """50ms 단위 RMS 엔벨로프를 0~1로 정규화해 반환."""
    wav = os.path.join(tempfile.gettempdir(), "env_probe.wav")
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
                    "-vn", wav], check=True)
    with wave.open(wav) as w:
        s = array.array("h", w.readframes(w.getnframes()))
    os.remove(wav)
    env = []
    for i in range(0, len(s) - HOP, HOP):
        chunk = s[i:i + HOP]
        env.append(math.sqrt(sum(x * x for x in chunk) / len(chunk)) / 32768.0)
    peak = max(env) or 1.0
    return [round(v / peak, 4) for v in env]

def onset_of(env, hop_s):
    """최대 RMS 지점에서 되짚어 올라가 급상승이 시작된 프레임 인덱스를 찾는다.

    맨 앞 0.25초는 인코딩 클릭이 섞여 진짜 피크를 가리는 경우가 있어 제외한다.
    """
    skip = min(int(0.25 / hop_s), max(len(env) - 1, 0))
    body = env[skip:] or env
    top = skip + max(range(len(body)), key=lambda i: body[i])
    i = top
    while i > skip and env[i] > 0.22:
        i -= 1
    return i, top

clips = json.load(open(os.path.join(REFS, "index.json"), encoding="utf-8"))
out = []
for c in clips:
    path = os.path.join(REFS, c["file"])
    env  = envelope(path)
    hop_s = HOP / SR
    on_i, top_i = onset_of(env, hop_s)
    onset, peak_t, dur = on_i * hop_s, top_i * hop_s, c["duration_sec"]

    focus_start = max(0.0, min(onset - 0.8, dur - FOCUS))
    focus_end   = min(dur, focus_start + FOCUS)

    stem = c["file"][:-4]
    shots = []
    for tag, t in [("a", dur * 0.10), ("b", dur * 0.35), ("evt", min(dur - 0.1, peak_t + 0.25)),
                   ("c", dur * 0.65), ("d", dur * 0.90)]:
        png = os.path.join(FRAMES, f"{stem}__{tag}.jpg")
        subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", path,
                        "-frames:v", "1", "-vf", "scale=640:-1", "-q:v", "4", png], check=True)
        shots.append(png)

    out.append({**c, "onset_sec": round(onset, 2), "peak_sec": round(peak_t, 2),
                "focus": [round(focus_start, 2), round(focus_end, 2)],
                "env_hop_sec": hop_s, "envelope": env})
    print(f"{c['idx']} {stem:38s} onset={onset:5.2f} peak={peak_t:5.2f} focus={focus_start:.1f}-{focus_end:.1f}")

json.dump(out, open(os.path.join(ROOT, "app", "data", "clips.raw.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print(f"\n{len(out)}개 분석 완료 -> app/data/clips.raw.json, 프레임 {len(out)*5}장 -> tools/frames/")
