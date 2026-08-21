# 홈캠 / 실내 이벤트 사운드 레퍼런스 클립 12선

실내 오디오 이벤트 인지(perception) 실험용 레퍼런스 세트. 모든 클립은 10~20초, H.264 + AAC mp4로 통일되어 있다.

| # | 파일 | 이벤트 | 카테고리 | 길이 | 출처 유형 | 원본 |
|---|------|--------|----------|------|-----------|------|
| 01 | [`01_glass-window-break-burglary.mp4`](01_glass-window-break-burglary.mp4) | 유리창 파손 / 침입 | 위험/이상 상황 | 16.02s | home security camera | [YouTube](https://www.youtube.com/watch?v=Y-cK7n7bzVY) |
| 02 | [`02_window-smash-hammer.mp4`](02_window-smash-hammer.mp4) | 망치로 창문 파손 | 위험/이상 상황 | 16.45s | security camera | [YouTube](https://www.youtube.com/watch?v=QdfHQ-21Oao) |
| 03 | [`03_smoke-alarm.mp4`](03_smoke-alarm.mp4) | 화재경보기 경보음 | 위험/이상 상황 | 16.02s | indoor recording | [YouTube](https://www.youtube.com/watch?v=N_QbmkVdNSc) |
| 04 | [`04_package-theft-porch.mp4`](04_package-theft-porch.mp4) | 택배 절도 | 위험/이상 상황 | 15.67s | video doorbell cam | [YouTube](https://www.youtube.com/watch?v=XHwBbSbuEBs) |
| 05 | [`05_glass-drop-shatter-floor.mp4`](05_glass-drop-shatter-floor.mp4) | 유리컵 낙하·파손 | 위험/이상 상황 | 16.77s | indoor recording | [YouTube](https://www.youtube.com/watch?v=Mal5_-xPFHA) |
| 06 | [`06_door-slam.mp4`](06_door-slam.mp4) | 문 쾅 닫힘 | 일상 생활음 | 13.57s | indoor recording | [YouTube](https://www.youtube.com/watch?v=iMQk__GkT84) |
| 07 | [`07_footsteps-wood-floor.mp4`](07_footsteps-wood-floor.mp4) | 마룻바닥 발소리 | 일상 생활음 | 11.61s | indoor recording | [YouTube](https://www.youtube.com/watch?v=Hc3Xn0u6_pE) |
| 08 | [`08_microwave-beep.mp4`](08_microwave-beep.mp4) | 전자레인지 완료 알림음 | 일상 생활음 | 17.51s | kitchen recording | [YouTube](https://www.youtube.com/watch?v=ck-fO81QCeI) |
| 09 | [`09_keys-unlock-front-door.mp4`](09_keys-unlock-front-door.mp4) | 열쇠로 현관문 개방 | 일상 생활음 | 11.15s | indoor recording | [YouTube](https://www.youtube.com/watch?v=NdfSgg762QE) |
| 10 | [`10_baby-dropped-cctv.mp4`](10_baby-dropped-cctv.mp4) | 아기 낙상 + 울음 | 아기/반려동물 | 12.33s | indoor CCTV | [YouTube](https://www.youtube.com/watch?v=vUMDyfskRCo) |
| 11 | [`11_cat-at-home-camera.mp4`](11_cat-at-home-camera.mp4) | 고양이 울음/움직임 | 아기/반려동물 | 10.01s | home security camera | [YouTube](https://www.youtube.com/watch?v=KyMU9IkuKm0) |
| 12 | [`12_dog-rings-doorbell.mp4`](12_dog-rings-doorbell.mp4) | 개 초인종 누름 + 짖음 | 아기/반려동물 | 14.07s | Ring doorbell cam | [YouTube](https://www.youtube.com/watch?v=A-FF7NntUzY) |

## 사양

- 클립 수: 12개 / 총 용량 20.0 MB
- 길이 범위: 10.01s ~ 17.51s
- 비디오: H.264 (720p 이하), 오디오: AAC 스테레오

## 재현

```bash
powershell -File _meta/download.ps1  # manifest.json 기준 다운로드
python _meta/trim.py               # 20초 초과분을 오디오 피크 기준으로 트리밍
python _meta/build_index.py        # index.json / README.md 재생성
```

## 라이선스 주의

원본은 각 YouTube 업로더에게 저작권이 있다. 개인 연구·모델 평가 용도로만 사용하고 재배포하지 말 것.
`index.json`에 원본 URL이 기록되어 있으니 인용이 필요하면 그쪽을 참조한다.
