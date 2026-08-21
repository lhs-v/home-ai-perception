"""다운로드된 클립을 스캔해 index.json / README.md를 생성한다."""
import json, os, subprocess, glob

ROOT = r"C:\Claude\perception\references"
FFPROBE = r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffprobe.exe"
CAT_KO = {"danger": "위험/이상 상황", "daily": "일상 생활음", "baby_pet": "아기/반려동물"}

def probe(path):
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries",
                          "format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels",
                          "-of", "json", path], capture_output=True, text=True).stdout
    d = json.loads(out)
    v = next(s for s in d["streams"] if s["codec_type"] == "video")
    a = next(s for s in d["streams"] if s["codec_type"] == "audio")
    return {"duration_sec": round(float(d["format"]["duration"]), 2),
            "size_mb": round(os.path.getsize(path) / 1048576, 2),
            "video": f"{v['codec_name']} {v['width']}x{v['height']}",
            "audio": f"{a['codec_name']} {a['sample_rate']}Hz {a['channels']}ch"}

items = json.load(open(os.path.join(ROOT, "_meta", "manifest.json"), encoding="utf-8"))
rows = []
for it in items:
    fname = f"{it['idx']}_{it['slug']}.mp4"
    path = os.path.join(ROOT, fname)
    if not os.path.exists(path):
        print("MISSING", fname); continue
    rows.append({**it, "file": fname, "url": f"https://www.youtube.com/watch?v={it['id']}", **probe(path)})

json.dump(rows, open(os.path.join(ROOT, "index.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)

lines = ["# 홈캠 / 실내 이벤트 사운드 레퍼런스 클립 12선", "",
         "실내 오디오 이벤트 인지(perception) 실험용 레퍼런스 세트. 모든 클립은 10~20초, H.264 + AAC mp4로 통일되어 있다.", "",
         "| # | 파일 | 이벤트 | 카테고리 | 길이 | 출처 유형 | 원본 |",
         "|---|------|--------|----------|------|-----------|------|"]
for r in rows:
    lines.append(f"| {r['idx']} | [`{r['file']}`]({r['file']}) | {r['event_ko']} | {CAT_KO[r['category']]} "
                 f"| {r['duration_sec']}s | {r['source']} | [YouTube]({r['url']}) |")
total = sum(r["size_mb"] for r in rows)
lines += ["", "## 사양", "",
          f"- 클립 수: {len(rows)}개 / 총 용량 {total:.1f} MB",
          f"- 길이 범위: {min(r['duration_sec'] for r in rows)}s ~ {max(r['duration_sec'] for r in rows)}s",
          "- 비디오: H.264 (720p 이하), 오디오: AAC 스테레오",
          "", "## 재현", "",
          "```bash", "powershell -File _meta/download.ps1  # manifest.json 기준 다운로드",
          "python _meta/trim.py               # 20초 초과분을 오디오 피크 기준으로 트리밍",
          "python _meta/build_index.py        # index.json / README.md 재생성", "```",
          "", "## 라이선스 주의", "",
          "원본은 각 YouTube 업로더에게 저작권이 있다. 개인 연구·모델 평가 용도로만 사용하고 재배포하지 말 것.",
          "`index.json`에 원본 URL이 기록되어 있으니 인용이 필요하면 그쪽을 참조한다."]
open(os.path.join(ROOT, "README.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
print(f"index.json / README.md 생성 완료 ({len(rows)}개, {total:.1f} MB)")
