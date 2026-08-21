"""클립별 재생 게인을 실측해 clips.json 에 넣는다.

홈캠 소스는 녹음 레벨이 제각각이라(피크 -40dB짜리부터 -1dB짜리까지) 그대로 재생하면
어떤 클립은 링이 죽고 어떤 클립은 화면을 뚫는다. ffmpeg volumedetect 로 실측해
피크와 평균을 함께 보고 클리핑 없이 체감 음량을 맞춘다.
"""
import json
import os
import re
import subprocess

ROOT = r"C:\Claude\perception"
REFS = os.path.join(ROOT, "references")
DATA = os.path.join(ROOT, "app", "data")
FFMPEG = (r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages"
          r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe")

TARGET_PEAK = -3.0     # dBFS. 이보다 위로는 올리지 않는다
TARGET_MEAN = -21.0    # dBFS. 체감 음량 기준
GAIN_MIN, GAIN_MAX = 0.6, 14.0


def measure(path):
    log = subprocess.run([FFMPEG, "-v", "info", "-i", path, "-af", "volumedetect",
                          "-vn", "-f", "null", "-"],
                         capture_output=True, text=True, errors="replace").stderr
    mx = re.search(r"max_volume:\s*(-?[\d.]+) dB", log)
    mn = re.search(r"mean_volume:\s*(-?[\d.]+) dB", log)
    return (float(mx.group(1)) if mx else 0.0,
            float(mn.group(1)) if mn else -30.0)


clips = json.load(open(os.path.join(DATA, "clips.json"), encoding="utf-8"))
for c in clips:
    peak, mean = measure(os.path.join(REFS, c["file"]))
    g_peak = 10 ** ((TARGET_PEAK - peak) / 20)
    g_mean = 10 ** ((TARGET_MEAN - mean) / 20)
    gain = max(GAIN_MIN, min(GAIN_MAX, min(g_peak, g_mean)))
    c["gain"] = round(gain, 2)
    c["peak_db"] = round(peak, 1)
    c["mean_db"] = round(mean, 1)
    print(f"{c['idx']} {c['file'][:34]:34s} peak={peak:7.1f}dB mean={mean:7.1f}dB -> gain x{gain:.2f}  {c['title_ko']}")

json.dump(clips, open(os.path.join(DATA, "clips.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("\nclips.json 갱신 완료")
