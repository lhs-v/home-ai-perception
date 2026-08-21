"""불량 클립 5개를 검증 통과한 실사 클립으로 교체하고 최종 clips.json 을 만든다.

스테이징 파일(480p)을 그대로 잘라 쓴다. 데모 화면에서는 4분할로 축소 재생되므로
원본 재다운로드로 얻는 화질 이득보다 시간 손해가 크다.
"""
import array
import glob
import json
import math
import os
import subprocess
import tempfile
import wave

ROOT = r"C:\Claude\perception"
REFS = os.path.join(ROOT, "references")
STAGE = os.path.join(ROOT, "tools", "stage")
DATA = os.path.join(ROOT, "app", "data")
FFDIR = (r"C:\Users\ruee1\AppData\Local\Microsoft\WinGet\Packages"
         r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin")
FFMPEG = os.path.join(FFDIR, "ffmpeg.exe")
FFPROBE = os.path.join(FFDIR, "ffprobe.exe")

SR, HOP = 16000, 800
FOCUS_LEN = 5.6

REPLACEMENTS = [
    {
        "idx": "05", "slug": "wine-rack-collapse",
        "src": "05_glass__dUmWMSSzbuw.mp4", "trim": [11.0, 26.0],
        "annotation": {
            "title_ko": "와인랙 붕괴",
            "sound": {"onomatopoeia": "우르릉 와장창",
                      "cue_line": "낮은 우르릉 소리에 이어 유리 깨지는 파열음이 겹겹이 쏟아진다",
                      "texture": "저음 우르릉 뒤 고음 파열",
                      "acoustic_tags": ["low_rumble", "impact", "high_freq", "broadband"],
                      "distance": "near", "loudness": 9},
            "visual": {"description_ko": "고정 카메라 시점에서 벽면 와인 랙이 통째로 무너지며 병들이 바닥에 쏟아져 깨지고 붉은 액체가 타일 위로 번진다",
                       "room": "홈바", "actors": ["성인 남성", "반려견"],
                       "time_of_day": "day", "camera_view": "실내 광각캠"},
            "semantics": {"event_type": "glass_break", "threat": 48, "urgency": "medium",
                          "tags": ["breakage", "noise", "pet"],
                          "fusion_note": "소리만으로는 침입이나 대형 파손으로 들리지만, 사람 없는 실내에서 선반이 스스로 무너진 사고다. 파편 위로 사람과 반려견이 들어오면 부상 위험 알림이 필요하다"},
        },
    },
    {
        "idx": "06", "slug": "front-door-banging-night",
        "src": "06alt__yScJ_GBDbcw.mp4", "trim": [8.0, 20.0],
        "annotation": {
            "title_ko": "야간 현관 두드림",
            "sound": {"onomatopoeia": "쿵쿵쿵",
                      "cue_line": "묵직한 두드림이 여러 번 몰아치고 그때마다 낮은 울림이 길게 남는다",
                      "texture": "반복되는 저역 충격",
                      "acoustic_tags": ["impact", "repetitive", "low_rumble", "transient"],
                      "distance": "mid", "loudness": 7},
            "visual": {"description_ko": "타임스탬프가 찍힌 야간 흑백 CCTV 화면에 주택가 도로와 주차된 차들이 보이고, 누군가 현관 쪽에서 문을 세게 두드린다",
                       "room": "현관", "actors": ["신원 미상 1명"],
                       "time_of_day": "night", "camera_view": "외벽 야간캠"},
            "semantics": {"event_type": "door_slam", "threat": 55, "urgency": "medium",
                          "tags": ["entry_point", "intrusion", "noise"],
                          "fusion_note": "심야의 반복적인 현관 충격은 방문이라기엔 과격하다. 초인종이나 말소리가 함께면 급한 방문, 없이 두드림만 계속되면 진입 시도로 본다"},
        },
    },
    {
        "idx": "07", "slug": "hallway-footsteps-cctv",
        "src": "07_footsteps__c7epRGF_EgM.mp4", "trim": [0.0, 12.0],
        "annotation": {
            "title_ko": "복도 발소리",
            "sound": {"onomatopoeia": "저벅저벅",
                      "cue_line": "둔탁한 발소리가 일정한 간격으로 울리다 서서히 멀어진다",
                      "texture": "먹먹하고 낮은 울림",
                      "acoustic_tags": ["repetitive", "impact", "transient"],
                      "distance": "mid", "loudness": 4},
            "visual": {"description_ko": "천장에 달린 감시 카메라 시점으로 카펫이 깔린 실내 복도가 보이고, 사람들이 안쪽 문 근처를 걸어 지나간다",
                       "room": "복도", "actors": ["성인 1~2명"],
                       "time_of_day": "day", "camera_view": "천장 고정캠"},
            "semantics": {"event_type": "footsteps", "threat": 15, "urgency": "low",
                          "tags": ["resident_activity", "noise"],
                          "fusion_note": "단독이면 거주자의 평범한 이동, 유리 파손이나 강제 개방 직후면 침입자의 실내 동선"},
        },
    },
    {
        "idx": "09", "slug": "deadbolt-picking",
        "src": "09_doorentry__0xTZRV97WcQ.mp4", "trim": [4.5, 16.1],
        "annotation": {
            "title_ko": "현관 잠금해제",
            "sound": {"onomatopoeia": "드르륵 딸깍",
                      "cue_line": "가느다란 금속이 반복해 긁히다 짧게 딸깍, 끝에 묵직한 걸림 한 번",
                      "texture": "가늘고 마른 금속 마찰",
                      "acoustic_tags": ["transient", "high_freq", "repetitive", "mechanical"],
                      "distance": "near", "loudness": 5},
            "visual": {"description_ko": "현관문 황동 데드볼트에 얇은 금속 도구 두 개를 찔러 넣고 손가락으로 실린더를 돌려 잠금을 푸는 클로즈업",
                       "room": "현관", "actors": ["신원 미상의 손"],
                       "time_of_day": "unknown", "camera_view": "문 근접샷"},
            "semantics": {"event_type": "door_unlock", "threat": 72, "urgency": "high",
                          "tags": ["intrusion", "entry_point"],
                          "fusion_note": "소리만으로는 열쇠로 문을 여는 귀가와 구분되지 않는다. 화면에서 열쇠가 아닌 도구가 확인되면 위협도가 급등한다"},
        },
    },
    {
        "idx": "10", "slug": "newborn-crying",
        "src": "10_baby__NB1uUmEBBg0.mp4", "trim": [3.0, 18.0],
        "annotation": {
            "title_ko": "아기 울음",
            "sound": {"onomatopoeia": "으앙 으아앙",
                      "cue_line": "높고 날카로운 울음이 겹쳐 끊겼다 이어지며 아주 가까이서 울린다",
                      "texture": "새된 고음의 떨림",
                      "acoustic_tags": ["human_voice", "high_freq", "repetitive", "sustained"],
                      "distance": "near", "loudness": 8},
            "visual": {"description_ko": "속싸개에 싸인 신생아 둘이 침대 위 담요에 나란히 누워 입을 크게 벌리고 동시에 울고 있다",
                       "room": "침실", "actors": ["신생아 2명"],
                       "time_of_day": "unknown", "camera_view": "근접 고정캠"},
            "semantics": {"event_type": "infant_distress", "threat": 40, "urgency": "medium",
                          "tags": ["infant", "medical", "noise"],
                          "fusion_note": "보호자의 발소리나 말소리가 뒤따르면 곧 진정될 상황, 울음만 길게 이어지면 보호자 부재로 보고 호출한다"},
        },
    },
]


def dur_of(path):
    return float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                 "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())


def envelope(path):
    wav = os.path.join(tempfile.gettempdir(), "swap_env.wav")
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
                    "-vn", wav], check=True)
    with wave.open(wav) as w:
        s = array.array("h", w.readframes(w.getnframes()))
    os.remove(wav)
    env = []
    for i in range(0, len(s) - HOP, HOP):
        ch = s[i:i + HOP]
        env.append(math.sqrt(sum(x * x for x in ch) / len(ch)) / 32768.0)
    pk = max(env) or 1.0
    return [round(v / pk, 4) for v in env]


def onset_of(env, hop_s):
    skip = min(int(0.25 / hop_s), max(len(env) - 1, 0))
    body = env[skip:] or env
    top = skip + max(range(len(body)), key=lambda i: body[i])
    i = top
    while i > skip and env[i] > 0.22:
        i -= 1
    return i * hop_s, top * hop_s


def norm_loud(v):
    v = int(v)
    return max(1, min(10, round(v / 10) if v > 10 else v))


def main():
    anns = {a["idx"]: a for a in json.load(open(os.path.join(DATA, "annotations.json"), encoding="utf-8"))}

    for rep in REPLACEMENTS:
        src = os.path.join(STAGE, rep["src"])
        if not os.path.exists(src):
            print(f"  ! {rep['idx']} 원본 없음: {rep['src']}")
            continue
        for old in glob.glob(os.path.join(REFS, f"{rep['idx']}_*.mp4")):
            os.remove(old)
        dest = os.path.join(REFS, f"{rep['idx']}_{rep['slug']}.mp4")
        a, b = rep["trim"]
        subprocess.run([FFMPEG, "-y", "-v", "error", "-i", src,
                        "-ss", f"{a:.2f}", "-t", f"{b - a:.2f}",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                        "-movflags", "+faststart", dest], check=True)
        anns[rep["idx"]] = dict(rep["annotation"], idx=rep["idx"])
        print(f"교체 {rep['idx']} -> {os.path.basename(dest)}  {dur_of(dest):.2f}s", flush=True)

    for a in anns.values():
        a["sound"]["loudness"] = norm_loud(a["sound"]["loudness"])

    ordered = [anns[k] for k in sorted(anns)]
    json.dump(ordered, open(os.path.join(DATA, "annotations.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    clips = []
    for a in ordered:
        found = glob.glob(os.path.join(REFS, f"{a['idx']}_*.mp4"))
        if not found:
            continue
        path = found[0]
        d = dur_of(path)
        env = envelope(path)
        hop_s = HOP / SR
        onset, peak = onset_of(env, hop_s)
        start = max(0.0, min(onset - 0.9, max(0.0, d - FOCUS_LEN)))
        clips.append({"idx": a["idx"], "file": os.path.basename(path), "title_ko": a["title_ko"],
                      "duration": round(d, 2), "onset": round(onset, 2), "peak": round(peak, 2),
                      "focus": [round(start, 2), round(min(d, start + FOCUS_LEN), 2)],
                      "sound": a["sound"], "visual": a["visual"], "semantics": a["semantics"]})

    json.dump(clips, open(os.path.join(DATA, "clips.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"\nclips.json — {len(clips)}개")
    for c in clips:
        print(f"  {c['idx']} {c['file'][:36]:36s} {c['duration']:5.2f}s onset={c['onset']:5.2f} "
              f"focus={c['focus'][0]:.1f}~{c['focus'][1]:.1f}  {c['title_ko']}")


if __name__ == "__main__":
    main()
