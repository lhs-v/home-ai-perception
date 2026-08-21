"""references/sources.json 을 읽어 데모용 클립을 내려받는다.

저장소에는 영상이 없다(저작권). clone 한 뒤 한 번 돌리면 references/ 가 채워진다.

  python tools/fetch_clips.py          이미 있는 파일은 건너뛴다
  python tools/fetch_clips.py --force  전부 다시 받는다

영상이 내려갔거나 지역 차단이면 그 클립만 빠지고 나머지로 데모가 돈다.
받은 뒤에는 ingest 를 돌려야 측정값이 채워진다 (npm run setup 이 둘을 이어서 한다).
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFS = os.path.join(ROOT, "references")
SOURCES = os.path.join(REFS, "sources.json")


def find_tool(name):
    """PATH 를 먼저 보고, 없으면 winget 이 깔아 두는 자리를 뒤진다."""
    env = os.environ.get("FFMPEG_DIR")
    if env:
        p = os.path.join(env, name + (".exe" if os.name == "nt" else ""))
        if os.path.exists(p):
            return p
    found = shutil.which(name)
    if found:
        return found
    hits = glob.glob(os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\bin" + os.sep + name + ".exe"),
        recursive=True)
    return hits[0] if hits else None


FFMPEG = find_tool("ffmpeg")
FFPROBE = find_tool("ffprobe")


def ensure_deps():
    missing = []
    if not FFMPEG or not FFPROBE:
        missing.append(
            "ffmpeg — Windows: winget install Gyan.FFmpeg / macOS: brew install ffmpeg / Linux: apt install ffmpeg")
    try:
        subprocess.run([sys.executable, "-m", "yt_dlp", "--version"],
                       capture_output=True, check=True)
    except Exception:
        missing.append("yt-dlp — pip install yt-dlp")
    if not shutil.which("deno") and not glob.glob(os.path.expandvars(
            r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\DenoLand.Deno*\deno.exe")):
        print("  ! JS 런타임(deno)이 없다. yt-dlp 가 일부 포맷을 못 가져와 403 이 날 수 있다.")
        print("    Windows: winget install DenoLand.Deno / 그 외: https://deno.com")
    if missing:
        print("필요한 도구가 없다:")
        for m in missing:
            print("  -", m)
        raise SystemExit(1)


def deno_on_path():
    """yt-dlp 가 JS 런타임을 찾을 수 있게 PATH 에 얹는다."""
    if shutil.which("deno"):
        return
    hits = glob.glob(os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\DenoLand.Deno*\deno.exe"))
    if hits:
        os.environ["PATH"] = os.path.dirname(hits[0]) + os.pathsep + os.environ["PATH"]


def duration(path):
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    try:
        return float(out.strip())
    except ValueError:
        return 0.0


def fetch(entry, force):
    dest = os.path.join(REFS, entry["file"])
    if os.path.exists(dest) and not force:
        print(f"  건너뜀 (이미 있음)  {entry['file']}")
        return "skip"

    vid = entry["youtube"]
    tmp = os.path.join(tempfile.gettempdir(), f"haip_{vid}.mp4")
    if not os.path.exists(tmp):
        r = subprocess.run(
            [sys.executable, "-m", "yt_dlp", f"https://www.youtube.com/watch?v={vid}",
             "-f", "bv*[height<=720]+ba/b[height<=720]/b",
             "--merge-output-format", "mp4", "--no-playlist", "--no-warnings",
             "--quiet", "--no-progress", "-o", tmp],
            capture_output=True, text=True, errors="replace")
        if not os.path.exists(tmp):
            msg = (r.stderr or "").strip().splitlines()
            why = msg[-1][:110] if msg else "알 수 없는 이유"
            print(f"  실패              {entry['file']}  ({vid})\n                    {why}")
            return "fail"

    # 자르고 H.264 + AAC 로 통일한다. -ss 를 -i 뒤에 두어 프레임 단위로 정확히 자른다.
    trim = entry.get("trim")
    args = [FFMPEG, "-y", "-v", "error", "-i", tmp]
    if trim:
        args += ["-ss", f"{trim[0]:.2f}", "-t", f"{trim[1] - trim[0]:.2f}"]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
             "-vf", "scale='min(1280,iw)':-2",
             "-c:a", "aac", "-b:a", "128k", "-ac", "2",
             "-movflags", "+faststart", dest]
    subprocess.run(args, check=False)
    if not os.path.exists(dest):
        print(f"  변환 실패          {entry['file']}")
        return "fail"
    print(f"  받음              {entry['file']}  {duration(dest):5.2f}s  ({vid})")
    return "ok"


def main():
    force = "--force" in sys.argv
    ensure_deps()
    deno_on_path()
    os.makedirs(REFS, exist_ok=True)
    data = json.load(open(SOURCES, encoding="utf-8"))
    entries = data["clips"]

    print(f"references/sources.json — {len(entries)}개\n")
    counts = {"ok": 0, "skip": 0, "fail": 0}
    failed = []
    for e in entries:
        r = fetch(e, force)
        counts[r] += 1
        if r == "fail":
            failed.append(e)

    print(f"\n받음 {counts['ok']} · 건너뜀 {counts['skip']} · 실패 {counts['fail']}")
    if failed:
        print("\n받지 못한 클립 — 영상이 내려갔거나 지역 차단일 수 있다:")
        for e in failed:
            print(f"  {e['file']}  https://www.youtube.com/watch?v={e['youtube']}")
        print("\n  그 클립만 빠지고 나머지로 데모는 정상 동작한다.")
        print("  직접 다른 영상을 references/ 에 넣어도 된다 — 운영자 탭에서 주석을 채우면 된다.")

    have = len(glob.glob(os.path.join(REFS, "*.mp4")))
    print(f"\nreferences/ 에 mp4 {have}개")
    if have:
        print("다음: python tools/ingest.py  (측정값을 채운다)")
    return 0 if have else 1


if __name__ == "__main__":
    raise SystemExit(main())
