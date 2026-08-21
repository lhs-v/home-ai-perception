"""20초를 넘는 클립을 오디오 에너지 피크 중심으로 잘라낸다."""
import subprocess, wave, array, os, glob, sys, tempfile

FFDIR = r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin"
FFMPEG, FFPROBE = os.path.join(FFDIR, "ffmpeg.exe"), os.path.join(FFDIR, "ffprobe.exe")
TARGET, MAXLEN = 16.0, 20.0

def duration(p):
    return float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                 "-of", "csv=p=0", p], capture_output=True, text=True).stdout.strip())

def peak_start(path, dur):
    """1초 단위 RMS를 구해 에너지 합이 가장 큰 TARGET초 창의 시작 시각을 반환."""
    wav = os.path.join(tempfile.gettempdir(), "trim_probe.wav")
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", path, "-ac", "1", "-ar", "8000",
                    "-vn", wav], check=True)
    with wave.open(wav) as w:
        samples = array.array("h", w.readframes(w.getnframes()))
    os.remove(wav)
    sr, step = 8000, 8000
    rms = [sum(x * x for x in samples[i:i + step]) for i in range(0, len(samples), step)]
    win = int(TARGET)
    if len(rms) <= win:
        return 0.0
    best = max(range(len(rms) - win + 1), key=lambda i: sum(rms[i:i + win]))
    # 이벤트 앞부분 여유 1초 확보
    return max(0.0, min(best - 1, dur - TARGET))

for path in sorted(glob.glob(r"C:\Claude\perception\references\*.mp4")):
    dur = duration(path)
    if dur <= MAXLEN:
        print(f"KEEP  {os.path.basename(path):40s} {dur:5.1f}s")
        continue
    start = peak_start(path, dur)
    tmp = path + ".trim.mp4"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{start:.2f}", "-i", path,
                    "-t", f"{TARGET}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tmp], check=True)
    os.replace(tmp, path)
    print(f"TRIM  {os.path.basename(path):40s} {dur:5.1f}s -> {duration(path):4.1f}s (start {start:.1f}s)")
