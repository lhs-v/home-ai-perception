"""후보 클립마다 오디오 온셋을 재고 대표 프레임 4장을 뽑는다."""
import json, os, subprocess, wave, array, math, tempfile, glob

ROOT   = r"C:\Claude\perception"
STAGE  = os.path.join(ROOT, "tools", "stage")
FRAMES = os.path.join(ROOT, "tools", "stage_frames")
FFDIR  = r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin"
FFMPEG = os.path.join(FFDIR, "ffmpeg.exe")
FFPROBE = os.path.join(FFDIR, "ffprobe.exe")
SR, HOP = 16000, 800

os.makedirs(FRAMES, exist_ok=True)

def envelope(path):
    wav = os.path.join(tempfile.gettempdir(), "stg.wav")
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-vn", wav], check=True)
    with wave.open(wav) as w:
        s = array.array("h", w.readframes(w.getnframes()))
    os.remove(wav)
    env = []
    for i in range(0, len(s) - HOP, HOP):
        ch = s[i:i + HOP]
        env.append(math.sqrt(sum(x * x for x in ch) / len(ch)) / 32768.0)
    pk = max(env) or 1.0
    return [v / pk for v in env]

out = {}
for path in sorted(glob.glob(os.path.join(STAGE, "*.mp4"))):
    stem = os.path.splitext(os.path.basename(path))[0]
    dur = float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())
    env = envelope(path)
    hop_s = HOP / SR
    # 시작 0.25초는 인코딩 클릭이 섞이므로 피크 탐색에서 제외한다
    skip = int(0.25 / hop_s)
    body = env[skip:] or env
    top = skip + max(range(len(body)), key=lambda i: body[i])
    i = top
    while i > skip and env[i] > 0.22:
        i -= 1
    onset, peak_t = i * hop_s, top * hop_s

    shots = []
    for tag, t in [("a", dur * 0.12), ("b", dur * 0.40),
                   ("evt", min(dur - 0.1, peak_t + 0.25)), ("d", dur * 0.82)]:
        png = os.path.join(FRAMES, f"{stem}__{tag}.jpg")
        subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", path,
                        "-frames:v", "1", "-vf", "scale=560:-1", "-q:v", "4", png], check=True)
        shots.append(os.path.basename(png))
    slot = stem.split("__")[0]
    out.setdefault(slot, []).append({"stem": stem, "id": stem.split("__")[1],
                                     "dur": round(dur, 2), "onset": round(onset, 2),
                                     "peak": round(peak_t, 2), "frames": shots})

json.dump(out, open(os.path.join(ROOT, "tools", "stage_index.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("슬롯별 후보:", {k: len(v) for k, v in out.items()})
