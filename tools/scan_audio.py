"""스테이징된 후보 전체의 실제 음량과 화면 상태를 함께 재서 표로 뽑는다.

무음 감시영상(피크 -80dB 이하)은 소리로 상황을 알리는 이 데모에서 쓸 수 없다.
"""
import glob
import json
import os
import re
import subprocess

ROOT = r"C:\Claude\perception"
STAGE = os.path.join(ROOT, "tools", "stage")
FFMPEG = (r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages"
          r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe")


def measure(path):
    log = subprocess.run([FFMPEG, "-v", "info", "-i", path,
                          "-af", "volumedetect", "-vn", "-f", "null", "-"],
                         capture_output=True, text=True, errors="replace").stderr
    mx = re.search(r"max_volume:\s*(-?[\d.]+) dB", log)
    mn = re.search(r"mean_volume:\s*(-?[\d.]+) dB", log)
    return (float(mx.group(1)) if mx else -99.0,
            float(mn.group(1)) if mn else -99.0)


rows = []
for p in sorted(glob.glob(os.path.join(STAGE, "*.mp4"))):
    stem = os.path.splitext(os.path.basename(p))[0]
    peak, mean = measure(p)
    rows.append({"stem": stem, "slot": stem.split("__")[0], "peak": peak, "mean": mean,
                 "usable": peak > -20.0 and mean > -45.0})

rows.sort(key=lambda r: (r["slot"], -r["peak"]))
json.dump(rows, open(os.path.join(ROOT, "tools", "audio_scan.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)

slot = None
for r in rows:
    if r["slot"] != slot:
        slot = r["slot"]
        print(f"\n=== {slot}")
    flag = "OK  " if r["usable"] else "quiet"
    print(f"  {flag} peak={r['peak']:7.1f} mean={r['mean']:7.1f}  {r['stem']}")
