"""교체 후보를 대량으로 받아 정지화면/암전/무음을 기계적으로 걸러낸다.

효과음 채널 영상이 이 데모의 함정이다 — 소리는 좋은데 화면이 정지 이미지라
2막(영상으로 확인)이 성립하지 않는다. 받아보고 직접 재는 수밖에 없다.
"""
import json, os, re, subprocess, sys, glob

ROOT   = r"C:\Claude\perception"
STAGE  = os.path.join(ROOT, "tools", "stage")
FFDIR  = r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin"
FFMPEG = os.path.join(FFDIR, "ffmpeg.exe")
FFPROBE = os.path.join(FFDIR, "ffprobe.exe")
DENO   = os.path.dirname(glob.glob(os.path.expandvars(
         r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\DenoLand.Deno*\deno.exe"))[0])
os.environ["PATH"] = DENO + os.pathsep + os.environ["PATH"]

SLOTS = {
  "05_glass": [
    "glass jar drops and breaks on kitchen floor",
    "dropping a glass it shatters on the floor real",
    "cctv shelf falls glass shatters shop camera",
    "wine glass falls off table breaks video",
    "plate falls and breaks kitchen floor real footage",
  ],
  "06_doorslam": [
    "door slams shut caught on camera",
    "wind slams the door shut video",
    "slamming the door angry real footage",
    "screen door slam shut home video",
    "cctv door slams closed indoor",
  ],
  "07_footsteps": [
    "pov walking on wooden floor inside house",
    "cctv night hallway person walking home camera",
    "walking around apartment pov footsteps sound",
    "security camera person walking inside house night",
    "walking down stairs inside house pov",
  ],
  "09_doorentry": [
    "unlocking front door with key pov coming home",
    "opening apartment door with keys close up",
    "door opening key turning lock real video",
    "coming home opening the door vlog",
    "front door opens security camera home",
  ],
  "10_baby": [
    "baby crying in crib real video",
    "newborn baby crying loud",
    "baby monitor night baby crying footage",
    "toddler crying at home video",
    "baby cries in the middle of the night camera",
  ],
}
PER_QUERY = 25
MAX_PER_SLOT = 9
LO, HI = 9, 40

os.makedirs(STAGE, exist_ok=True)

def yt(*args):
    return subprocess.run([sys.executable, "-m", "yt_dlp", *args],
                          capture_output=True, text=True, errors="replace")

def search(q):
    p = yt(f"ytsearch{PER_QUERY}:{q}", "--flat-playlist",
           "--print", "%(duration)s|%(id)s|%(title)s", "--no-warnings")
    out = []
    for line in p.stdout.splitlines():
        parts = line.split("|", 2)
        if len(parts) < 3: continue
        try: d = int(float(parts[0]))
        except ValueError: continue
        if LO <= d <= HI: out.append({"dur": d, "id": parts[1], "title": parts[2]})
    return out

def download(vid, dest):
    yt(f"https://www.youtube.com/watch?v={vid}",
       "-f", "bv*[height<=480]+ba/bv*+ba/b", "--merge-output-format", "mp4",
       "--ffmpeg-location", FFDIR, "--no-playlist", "--no-warnings",
       "--quiet", "--no-progress", "-o", dest)
    return os.path.exists(dest)

def measure(path):
    dur = float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip() or 0)
    if dur <= 0: return None
    has_audio = bool(subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a",
                                     "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
                                    capture_output=True, text=True).stdout.strip())
    log = subprocess.run([FFMPEG, "-v", "info", "-i", path, "-an",
                          "-vf", "freezedetect=n=0.004:d=1.0,blackdetect=d=0.5:pic_th=0.98:pix_th=0.08",
                          "-f", "null", "-"], capture_output=True, text=True, errors="replace").stderr
    freeze = sum(float(m) for m in re.findall(r"freeze_duration:\s*([\d.]+)", log))
    black = sum(float(m) for m in re.findall(r"black_duration:\s*([\d.]+)", log))
    return {"len": round(dur, 1), "audio": has_audio,
            "freeze": round(min(freeze / dur, 1), 2), "black": round(min(black / dur, 1), 2)}

results = {}
for slot, queries in SLOTS.items():
    seen, cands = set(), []
    for q in queries:
        for c in search(q):
            if c["id"] in seen: continue
            seen.add(c["id"]); cands.append(c)

    kept, tried = [], 0
    for c in cands:
        if len([k for k in kept if k["pass"]]) >= MAX_PER_SLOT or tried >= MAX_PER_SLOT * 3:
            break
        tried += 1
        dest = os.path.join(STAGE, f"{slot}__{c['id']}.mp4")
        if not os.path.exists(dest) and not download(c["id"], dest):
            continue
        m = measure(dest)
        if not m or not m["audio"]:
            if os.path.exists(dest): os.remove(dest)
            continue
        ok = m["freeze"] <= 0.55 and m["black"] <= 0.35
        rec = {**c, **m, "pass": ok}
        if not ok: os.remove(dest)
        kept.append(rec)
    results[slot] = kept
    print(f"[{slot}] 검사 {len(kept)} / 통과 {sum(1 for k in kept if k['pass'])}", flush=True)

json.dump(results, open(os.path.join(ROOT, "tools", "hunt.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
lines = []
for slot, ks in results.items():
    lines.append(f"=== {slot}")
    for k in sorted(ks, key=lambda x: (not x["pass"], x["freeze"])):
        lines.append(f"  {'PASS' if k['pass'] else 'drop'}  {k['len']:5.1f}s  fz={k['freeze']:.2f} "
                     f"bk={k['black']:.2f}  {k['id']}  {k['title'][:70]}")
open(os.path.join(ROOT, "tools", "hunt.txt"), "w", encoding="utf-8").write("\n".join(lines))
print("\n저장: tools/hunt.txt")
