"""클립별 '움직임 엔벨로프'를 뽑아 clips.json 에 넣는다.

소리만으로는 네 클립의 결이 비슷해진다. 화면의 프레임 변화율을 같이 쓰면
정지된 감지기 클로즈업과 유리가 쏟아지는 순간이 실제 데이터에서 갈린다.

프레임을 64x36 그레이로 낮춰 10fps 로 뽑고, 이웃 프레임의 평균 절대차를 잰다.
정규화는 **클립별이 아니라 전체 공통 스케일**로 한다 — 클립마다 자기 피크를 1로
맞추면 미동도 없는 화면의 노이즈가 1.0 이 되어 버려 정반대 결과가 나온다.
"""
import json
import os
import subprocess

ROOT = r"C:\Claude\perception"
REFS = os.path.join(ROOT, "references")
DATA = os.path.join(ROOT, "app", "data")
FFMPEG = (r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages"
          r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe")

W, H, FPS = 64, 36, 10
FRAME = W * H
BINS = 48                 # 링이 재생할 엔벨로프 길이


def motion_series(path):
    """이웃 프레임의 평균 절대차 시계열."""
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", path, "-r", str(FPS),
         "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "-"],
        capture_output=True).stdout
    n = len(raw) // FRAME
    if n < 2:
        return []
    out = []
    for k in range(1, n):
        a = raw[(k - 1) * FRAME:k * FRAME]
        b = raw[k * FRAME:(k + 1) * FRAME]
        out.append(sum(abs(b[j] - a[j]) for j in range(FRAME)) / FRAME / 255.0)
    return out


def resample(series, bins):
    """길이가 제각각인 시계열을 같은 칸 수로 맞춘다(구간 최댓값 — 순간 사건을 놓치지 않게)."""
    if not series:
        return [0.0] * bins
    out = []
    for k in range(bins):
        lo = int(k * len(series) / bins)
        hi = max(lo + 1, int((k + 1) * len(series) / bins))
        out.append(max(series[lo:hi]))
    return out


clips = json.load(open(os.path.join(DATA, "clips.json"), encoding="utf-8"))
series = {}
for c in clips:
    s = motion_series(os.path.join(REFS, c["file"]))
    series[c["idx"]] = resample(s, BINS)
    peak = max(s) if s else 0.0
    mean = (sum(s) / len(s)) if s else 0.0
    print(f"{c['idx']} {c['file'][:34]:34s} peak={peak:.4f} mean={mean:.4f}  {c['title_ko']}", flush=True)

def pct(xs, q):
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, int(len(s) * q)))]


# 장면 전환은 한두 프레임짜리 거대 스파이크라 그대로 두면 스케일을 독점한다.
# 클립별 97퍼센타일로 먼저 눌러 컷을 제거한 뒤 공통 스케일을 잡는다.
for idx, s in series.items():
    cap = pct(s, 0.97) * 1.25 or 1.0
    series[idx] = [min(v, cap) for v in s]

allv = [v for s in series.values() for v in s]
scale = pct(allv, 0.92) or 1.0
GAMMA = 0.55              # 낮은 쪽을 들어 올려 조용한 클립도 결이 남게 한다

for c in clips:
    s = [round(min(1.0, (v / scale)) ** GAMMA, 4) for v in series[c["idx"]]]
    c["motion"] = s
    c["motion_avg"] = round(sum(s) / len(s), 4)
    c["motion_peak"] = round(max(s), 4)

json.dump(clips, open(os.path.join(DATA, "clips.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)

print(f"\n공통 스케일 {scale:.4f} 기준 정규화")
for c in sorted(clips, key=lambda x: -x["motion_avg"]):
    bar = "#" * int(c["motion_avg"] * 44)
    print(f"  {c['idx']} 평균 {c['motion_avg']:.3f} 피크 {c['motion_peak']:.3f} |{bar:<44}| {c['title_ko']}")
