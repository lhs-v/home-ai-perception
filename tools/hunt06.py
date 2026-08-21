"""06 슬롯 재수집. 문 닫힘이 안 나오면 다른 생활 이벤트라도 확보한다."""
import json, os, re, subprocess, sys, glob

ROOT   = r"C:\Claude\perception"
STAGE  = os.path.join(ROOT, "tools", "stage")
FFDIR  = r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin"
FFMPEG, FFPROBE = os.path.join(FFDIR, "ffmpeg.exe"), os.path.join(FFDIR, "ffprobe.exe")
DENO = os.path.dirname(glob.glob(os.path.expandvars(
       r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\DenoLand.Deno*\deno.exe"))[0])
os.environ["PATH"] = DENO + os.pathsep + os.environ["PATH"]

QUERIES = [
  # 1순위: 실내 문 닫힘
  "front door closing loudly home security camera indoor",
  "roommate slams bedroom door video",
  "cctv indoor door closes person leaves room",
  "kid slams bedroom door home video",
  # 2순위: 다른 생활 이벤트 (문 닫힘이 안 나올 경우 대체)
  "vacuum cleaner cleaning the living room video",
  "someone knocking on apartment door loudly camera",
  "kettle boiling whistling on stove kitchen video",
  "washing machine spinning loud laundry room video",
]
PER_QUERY, LO, HI, LIMIT = 25, 9, 45, 22

def yt(*a):
    return subprocess.run([sys.executable, "-m", "yt_dlp", *a], capture_output=True, text=True, errors="replace")

def measure(path):
    dur = float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip() or 0)
    if dur <= 0: return None
    audio = bool(subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a", "-show_entries",
                                 "stream=codec_type", "-of", "csv=p=0", path],
                                capture_output=True, text=True).stdout.strip())
    log = subprocess.run([FFMPEG, "-v", "info", "-i", path, "-an",
                          "-vf", "freezedetect=n=0.004:d=1.0,blackdetect=d=0.5:pic_th=0.98:pix_th=0.08",
                          "-f", "null", "-"], capture_output=True, text=True, errors="replace").stderr
    fz = sum(float(m) for m in re.findall(r"freeze_duration:\s*([\d.]+)", log))
    bk = sum(float(m) for m in re.findall(r"black_duration:\s*([\d.]+)", log))
    return {"len": round(dur, 1), "audio": audio,
            "freeze": round(min(fz / dur, 1), 2), "black": round(min(bk / dur, 1), 2)}

seen, cands = set(), []
for q in QUERIES:
    p = yt(f"ytsearch{PER_QUERY}:{q}", "--flat-playlist",
           "--print", "%(duration)s|%(id)s|%(title)s", "--no-warnings")
    for line in p.stdout.splitlines():
        parts = line.split("|", 2)
        if len(parts) < 3: continue
        try: d = int(float(parts[0]))
        except ValueError: continue
        if LO <= d <= HI and parts[1] not in seen:
            seen.add(parts[1]); cands.append({"dur": d, "id": parts[1], "title": parts[2]})

kept = []
for c in cands:
    if len([k for k in kept if k["pass"]]) >= 12: break
    dest = os.path.join(STAGE, f"06alt__{c['id']}.mp4")
    if not os.path.exists(dest):
        yt(f"https://www.youtube.com/watch?v={c['id']}", "-f", "bv*[height<=480]+ba/bv*+ba/b",
           "--merge-output-format", "mp4", "--ffmpeg-location", FFDIR, "--no-playlist",
           "--no-warnings", "--quiet", "--no-progress", "-o", dest)
    if not os.path.exists(dest): continue
    m = measure(dest)
    if not m or not m["audio"]:
        os.remove(dest); continue
    ok = m["freeze"] <= 0.55 and m["black"] <= 0.35
    if not ok: os.remove(dest)
    kept.append({**c, **m, "pass": ok})
    if len(kept) >= LIMIT: break

json.dump(kept, open(os.path.join(ROOT, "tools", "hunt06.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print(f"검사 {len(kept)} / 통과 {sum(1 for k in kept if k['pass'])}")
