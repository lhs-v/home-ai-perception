"""06 슬롯: 앞선 검색에서 실사로 확인된 홈캠/도어벨 클립을 직접 지정해 받는다.

검색 룰렛보다 이미 실사로 확인된 채널(RingTV 등) 영상을 찍어 오는 편이 확실하다.
"""
import json, os, re, subprocess, sys, glob

ROOT  = r"C:\Claude\perception"
STAGE = os.path.join(ROOT, "tools", "stage")
FFDIR = r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin"
FFMPEG, FFPROBE = os.path.join(FFDIR, "ffmpeg.exe"), os.path.join(FFDIR, "ffprobe.exe")
DENO = os.path.dirname(glob.glob(os.path.expandvars(
       r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\DenoLand.Deno*\deno.exe"))[0])
os.environ["PATH"] = DENO + os.pathsep + os.environ["PATH"]

PICKS = [
  ("LxNxqhvKhfw", "Ring video captures teen kicking door, homeowner spooked"),
  ("8lC_HyuazWs", "Would-be porch pirate scared off by homeowner"),
  ("63W4wdAE7tE", "Doorbell Camera Catches Rottweiler Chasing Neighbor"),
  ("kXd2XZlFPJk", "Ring Floodlight Cam two-way talk sent these two running"),
  ("hRyShQ0nSyw", "Close Call: Bear Chases Woman And Dog Into House | RingTV"),
  ("NEKZF90PS-A", "REAL Doorbell sound and dogs barking"),
  ("yScJ_GBDbcw", "Banging the front door"),
  ("4zacupzimrE", "Doorbell cam shows suspicious person trying to enter Phoenix home"),
  ("NQptIEoqCGk", "DING DONG DITCH GONE WRONG"),
  ("SJ1_q07Toqo", "Ring Alarm Siren stops break-in attempt"),
]

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

out = []
for vid, title in PICKS:
    dest = os.path.join(STAGE, f"06alt__{vid}.mp4")
    if not os.path.exists(dest):
        yt(f"https://www.youtube.com/watch?v={vid}", "-f", "bv*[height<=480]+ba/bv*+ba/b",
           "--merge-output-format", "mp4", "--ffmpeg-location", FFDIR, "--no-playlist",
           "--no-warnings", "--quiet", "--no-progress", "-o", dest)
    if not os.path.exists(dest):
        out.append({"id": vid, "title": title, "pass": False, "note": "download failed"}); continue
    m = measure(dest)
    if not m or not m["audio"]:
        os.remove(dest); out.append({"id": vid, "title": title, "pass": False, "note": "no audio"}); continue
    ok = m["freeze"] <= 0.60 and m["black"] <= 0.35
    if not ok: os.remove(dest)
    out.append({"id": vid, "title": title, **m, "pass": ok})

json.dump(out, open(os.path.join(ROOT, "tools", "hunt06b.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
for o in out:
    print(f"{'PASS' if o.get('pass') else 'drop'}  {o.get('len','-'):>6}  fz={o.get('freeze','-')} bk={o.get('black','-')}  {o['id']}  {o['title'][:56]}")
