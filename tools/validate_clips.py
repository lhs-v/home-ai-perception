"""클립이 데모에 쓸 수 있는 상태인지 기계적으로 검증한다.

두 가지가 치명적이다.
  - 정지 이미지: 소리만 있고 화면이 안 움직이면 2막(영상 확인)이 성립하지 않는다
  - 암전 화면: 마찬가지로 확인할 것이 없다
freezedetect / blackdetect 로 직접 잰다.
"""
import json, os, re, subprocess, sys

FFDIR  = r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin"
FFMPEG = os.path.join(FFDIR, "ffmpeg.exe")

def check(path, dur):
    p = subprocess.run(
        [FFMPEG, "-v", "info", "-i", path, "-an",
         "-vf", "freezedetect=n=0.004:d=1.0,blackdetect=d=0.5:pic_th=0.98:pix_th=0.08",
         "-f", "null", "-"],
        capture_output=True, text=True, errors="replace")
    log = p.stderr

    freeze = sum(float(m) for m in re.findall(r"freeze_duration:\s*([\d.]+)", log))
    black = sum(float(m) for m in re.findall(r"black_duration:\s*([\d.]+)", log))
    return {
        "freeze_ratio": round(min(freeze / dur, 1.0), 3),
        "black_ratio": round(min(black / dur, 1.0), 3),
    }

def audio_shape(env):
    """엔벨로프 모양으로 '사건성'을 잰다. 피크는 1.0으로 정규화되어 있다."""
    s = sorted(env)
    median = s[len(s) // 2] or 0.001
    loud = sum(1 for v in env if v > 0.5) / len(env)
    quiet = sum(1 for v in env if v < 0.12) / len(env)
    return {"crest": round(1 / median, 1), "loud_frac": round(loud, 3), "quiet_frac": round(quiet, 3)}

raw = json.load(open(r"C:\Claude\perception\app\data\clips.raw.json", encoding="utf-8"))
anns = {a["idx"]: a for a in json.load(open(r"C:\Claude\perception\app\data\annotations.json", encoding="utf-8"))}

report = []
for c in raw:
    path = os.path.join(r"C:\Claude\perception\references", c["file"])
    v = check(path, c["duration_sec"])
    a = audio_shape(c["envelope"])
    bad = []
    if v["freeze_ratio"] > 0.65: bad.append("정지화면")
    if v["black_ratio"] > 0.55:  bad.append("암전")
    report.append({"idx": c["idx"], "file": c["file"], **v, **a,
                   "title": anns[c["idx"]]["title_ko"], "verdict": "REJECT" if bad else "OK",
                   "why": ",".join(bad)})

json.dump(report, open(r"C:\Claude\perception\app\data\validation.json", "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)

out = ["idx  freeze  black  crest  loud  quiet  verdict   title"]
for r in report:
    out.append(f"{r['idx']}   {r['freeze_ratio']:5.2f}  {r['black_ratio']:5.2f}  "
               f"{r['crest']:5.1f}  {r['loud_frac']:4.2f}  {r['quiet_frac']:4.2f}  "
               f"{r['verdict']:8s}  {r['title']} {r['why']}")
open(r"C:\Claude\perception\app\data\validation.txt", "w", encoding="utf-8").write("\n".join(out))
print("\n".join(out).encode("ascii", "replace").decode())
