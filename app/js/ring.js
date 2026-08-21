/**
 * 오디오 반응형 링.
 *
 * AnalyserNode의 주파수 스펙트럼을 원 둘레에 로그 간격으로 펼쳐서
 * 반지름 변위로 그린다. 실제 소리와 무관하게 흔들리는 "가짜 파형"을
 * 피하는 것이 이 모듈의 유일한 목표다.
 *
 * 처리 순서
 *   1) 로그 간격 빈 샘플링   — 저역이 화면을 독점하지 않게
 *   2) 비대칭 시간 스무딩    — 어택은 빠르게, 릴리즈는 느리게 (타격음이 살아난다)
 *   3) 원형 공간 스무딩      — 이웃 포인트와 섞어 톱니 제거
 *   4) 유휴 호흡과 크로스페이드 — 무음일 때도 살아있게
 */

const POINTS = 240;             // 링 둘레 샘플 수 (짝수, 좌우 대칭)
const HALF = POINTS / 2;
const ATTACK = 0.50;            // 값이 올라갈 때 따라가는 속도
const RELEASE = 0.085;          // 값이 내려갈 때 따라가는 속도
const SPATIAL_PASSES = 2;
const F_LO = 55;                // 링에 반영할 최저 주파수 (Hz)
const F_HI = 9000;              // 최고 주파수 (Hz)

/**
 * 여무는 결 스윕 — 분석 진행률을 링 옆의 아크가 아니라 파형 자체의 "성숙도"로 표현한다.
 * 링 둘레의 한 지점(출발선)에서 시작한 경계가 돌고, 지나간 쪽은 결이 촘촘하고
 * 진폭이 온전하고 밝다. 새 도형을 하나도 추가하지 않는 것이 핵심이다.
 */
const SWEEP_W = 0.12;           // 전이대 폭(둘레 비율). 43° — '선'이 아니라 '구간'으로 보이게
const SWEEP_SEAM = 0.025;       // 출발선 봉합 폭. conic gradient 이음매의 1px 경계선을 없앤다
const SWEEP_STOPS = 64;         // conic 정지점 수. 전이대 안에 7.7개가 들어가 계단이 안 보인다
const SWEEP_D_HI = 0.92;        // 여문 쪽 밀도 (마루 약 19개)
const SWEEP_D_LO = 0.06;        // 아직 안 여문 쪽 밀도 (마루 약 3개)
const SWEEP_AMP_LO = 0.55;      // 안 여문 쪽 진폭 배율 — 기준원에 납작하게 붙는다
const SWEEP_HOLD = 0.85;        // 진행률 0.85에서 봉합 완료. 남은 시간은 정지 박자

/**
 * 네 목소리 위상 잠금 — 삼킨 넷이 하나의 상황 인식이 되는 과정.
 *
 * 링 둘레에 네 소스의 각도 영역을 세우고, 영역마다 자기 조화 차수·위상·이동 방향을
 * 가진 "억양"을 기존 6항 파형 위에 얹는다. 융합도가 오르면 영역이 서로를 덮고
 * 위상이 합의 위상으로 끌려가, 이음매 넷이 제자리에서 동시에 옅어지며 사라진다.
 *
 * 스윕이 '이동하는 경계 하나'로 진행률을 말한다면 이건 '이동 없는 경계 넷'이
 * 개수만 4→1 로 줄어드는 이야기다. 두 문법이 겹치지 않는 것이 설계의 핵심이다.
 */
const VOICE_N = [7, 11, 15, 19];              // 지배 차수. 정수라 둘레 이음매가 안 생긴다
const VOICE_SPD = [0.16, -0.11, 0.09, -0.20]; // 억양의 공간 이동 속도 rad/s (방향이 갈린다)
const VOICE_ID = [0, Math.PI, Math.PI * 0.5, Math.PI * 1.5]; // 각도 순 교대 배치
const VOICE_NC = 9;             // 합의 차수. 넷이 여기로 등파워 교차한다
const VOICE_DC = 0.62;          // 합의 위상의 각속도
const VOICE_K0 = 6.0;           // 영역 집중도. 반치폭 55° — '선'이 아니라 연속장의 극소점
// 융합 구간에는 목소리가 '공통 파형에 얹힌 장식'이 아니라 파형 그 자체여야 한다.
// 공통 파형을 크게 덜어내고(COMP) 억양을 그만큼 키워야(AMP) 네 구역의 결이 구분된다.
// 둘은 반드시 같이 움직인다 — COMP 만 키우면 결이 물러지고 AMP 만 키우면 진폭이 넘친다.
const VOICE_AMP = 0.34;         // 억양 진폭 기준값 (움직임량이 여기에 곱해진다)
const VOICE_COMP = 0.72;        // 억양이 실린 만큼 공통 파형에서 덜어내는 비율
// 클립의 프레임 변화율(움직임)이 그 목소리의 크기와 박자를 좌우한다.
// 합성 사인파만 쓰면 넷이 결국 비슷해진다 — 실제 데이터가 들어와야 결이 갈린다.
const VOICE_MOT_LO = 0.35;      // 움직임 0 일 때의 진폭 배율 (고정 CCTV = 잔잔한 구역)
const VOICE_MOT_HI = 1.55;      // 움직임 1 일 때의 진폭 배율 (사건이 터지는 구역)
const VOICE_KEEP = 0.62;        // 목소리가 살아 있는 동안의 최소 실효 밀도.
                                // 공간 스무딩을 물러나게 해 n=15·19 같은 고차가 살아남는다
const VOICE_LOCK = 0.085;       // 위상 인력 계수
const VOICE_STOPS = 96;         // 목소리가 켜졌을 때 conic 정지점 수

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (x) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
/** 최단각으로 감싼다. 위상을 lerp 하지 않고 이걸로 당겨야 순간 주파수가 안 튄다. */
const wrapPi = (x) => { const y = (x + Math.PI) % (Math.PI * 2); return (y < 0 ? y + Math.PI * 2 : y) - Math.PI; };

export class Ring {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./audio.js').AudioBus} bus
   */
  constructor(canvas, bus) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bus = bus;

    this.amp = new Float32Array(POINTS);      // 스무딩된 변위 0~1
    this.tmp = new Float32Array(POINTS);
    this.binMap = null;                       // 로그 간격 빈 인덱스

    this.liveness = 0;      // 소리 있음(1) ↔ 무음(0)
    this.level = 0;         // 현재 RMS
    this.prevLevel = 0;
    // 클립마다 절대 음량이 10배 넘게 차이 나서, 최근 최대치를 기준으로
    // 자동 레인지를 잡는다. 없으면 조용한 클립에서 링이 거의 죽는다.
    this.ref = 0.05;        // 최근 최대 레벨 추정치
    this.norm = 0;          // ref 대비 정규화된 현재 음량 0~1
    this.specGain = 1;      // 스펙트럼 보정 이득
    this.flash = 0;         // 타격음 순간 번쩍임
    this.rotation = 0;
    // 막 전환용 외부 제어값. 목표치를 향해 매 프레임 수렴시킨다.
    // 캔버스를 CSS로 변형하면 흐려지므로, 중심과 반지름을 직접 옮겨 선명도를 지킨다.
    this.scale = 1;
    this.scaleTarget = 1;
    this.center = { x: 0.5, y: 0.5 };
    this.centerTarget = { x: 0.5, y: 0.5 };
    this.follow = 0.08;     // 수렴 속도
    this.spin = 0;          // 막 전환 때 실어주는 일시적 회전 가속
    this.thinking = 0;      // 통합 인지 상태 0~1 (오디오가 아니라 연산이 링을 움직인다)
    this.thinkTarget = 0;
    this.density = 0;       // 분석이 깊어질수록 파형이 촘촘해진다 0~1
    this.densityTarget = 0;
    // 여무는 결 스윕 상태.
    // mat 을 1로 채워두는 게 중요하다 — 고역 틱이 이 배열을 읽는데
    // _thinkShape 은 thinking > 0.002 일 때만 돌기 때문이다.
    this.mat = new Float32Array(POINTS).fill(1);   // 점별 실효 성숙도 0~1
    this.dens = new Float32Array(POINTS);          // 점별 실효 밀도 (_smooth 가 쓴다)
    this._passF = new Float32Array(POINTS);        // 점별 공간 스무딩 패스 수
    this.sweepOn = false;
    this.sweepTarget = 0;
    this.sweepF = 0;        // 실제 선단. setInterval 계단을 lerp 로 지운 값
    this.sweepMix = 0;      // 0 이면 스윕 이전 동작과 수치까지 동일 (무해한 no-op)
    this.sweepOrigin = 0;   // 출발선. 각도가 아니라 인덱스라 rotation 을 따라 함께 돈다
    this.headPhase = 0;     // 스캔 꼬리 자유 회전 위상. 해제 시 연속성을 지킨다

    // 네 목소리 상태. voices 가 비면 아래 값이 전부 무해한 기본값으로 돌아간다.
    this.voices = [];
    this.voiceOn = false;
    this.voiceMix = 0;      // 목소리 존재감 0~1
    this.vCommon = 0;       // 합의 위상
    this.vT = 0;            // 목소리 전용 시계(초). 흔들림 항이 쓴다
    this.fusion = 0;        // 융합도 0~1
    this.fusionTarget = 0;
    this.vGain = 0;         // 억양 봉투. 융합 0.96 에서 정확히 0
    this.cohMean = 1;       // 둘레 평균 결속도
    this.vLocked = false;   // 잠금 사건 1회 가드. 매 프레임 치면 flash 가 포화돼 흰 링이 된다
    this.vPeriod = 4;       // 움직임 엔벨로프를 한 번 재생하는 데 걸리는 시간(초)
    this.vCursor = 0;       // 그 재생 위치 0~1
    this._vLive = false;
    this.vAcc = new Float32Array(POINTS);            // 억양(파형에 더해지는 항)
    this.vCoh = new Float32Array(POINTS).fill(1);    // 결속도. mat 과 같은 이유로 1 로 채운다
    this._vcs = new Float32Array(8);                 // 정체성 각의 cos/sin
    // 둘레 각의 cos/sin 테이블. 창 가중치의 cosθ 를 곱셈으로 풀어
    // 프레임당 cos 960회를 없앤다.
    this._ca = new Float32Array(POINTS);
    this._sa = new Float32Array(POINTS);
    for (let i = 0; i < POINTS; i++) {
      const a = (i / POINTS) * Math.PI * 2;
      this._ca[i] = Math.cos(a);
      this._sa[i] = Math.sin(a);
    }
    this.opacity = 1;
    this.tint = { h: 205, s: 92, l: 62 };
    this.targetTint = { h: 205, s: 92, l: 62 };

    this.cx = 0; this.cy = 0; this.r0 = 0;
    this._raf = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
    this.cx = w * this.center.x;
    this.cy = h * this.center.y;
    this.r0 = Math.min(w, h) * 0.148;
  }

  /** 링 중심과 반지름(px, 뷰포트 기준). 큐 카드 연결선을 그리는 쪽에서 쓴다. */
  geometry() {
    const rect = this.canvas.getBoundingClientRect();
    return { cx: rect.left + this.cx, cy: rect.top + this.cy, r: this.r0 * this.scale };
  }

  setTint(h, s, l) { this.targetTint = { h, s, l }; }
  /** 막이 넘어갈 때 링을 한 번 감아 돌린다. 감쇠하며 자연스럽게 멎는다. */
  kick(v = 2.6) { this.spin = v; }
  /** 오디오와 무관하게 링을 한 번 번쩍이게 한다. 무언가를 삼킨 순간에 쓴다. */
  pulse(v = 0.6) { this.flash = Math.min(1, this.flash + v); }

  /**
   * 통합 인지 모드. 소리가 없는 구간이라 파형을 오디오로 만들 수 없다.
   * 유휴 호흡과는 확연히 다른, 둘레를 훑어 도는 진행파로 "연산 중"을 표현한다.
   * 오디오 반응인 척하지 않는 것이 중요하다 — 이건 다른 상태다.
   */
  setThinking(on) { this.thinkTarget = on ? 1 : 0; }

  /** 분석 밀도. 올릴수록 파형의 공간 주파수가 높아져 촘촘하고 조밀해진다. */
  setDensity(v) { this.densityTarget = clamp(v, 0, 1); }

  /**
   * 분석 진행률 0~1. 음수면 해제.
   * 아크를 그리는 대신 "여무는 결"의 선단을 민다.
   */
  setProgress(v) {
    if (v < 0) {
      if (this.sweepOn) {
        // 해제 순간 스캔 꼬리의 자유 회전이 지금 머리가 있는 자리에서 이어지도록
        // 위상을 맞춘다. 없으면 꼬리가 순간이동한다.
        const parked = (this.sweepOrigin / POINTS +
          Math.min(this.sweepF * (1 + SWEEP_W), 1)) * Math.PI * 2 + this.rotation;
        this.headPhase = parked - performance.now() / 780;
        this.sweepOn = false;
      }
      return;
    }
    if (!this.sweepOn) {
      // 출발선은 지금 스캔 머리가 있는 자리. 각도가 아니라 인덱스로 잡아야
      // rotation 을 따라 함께 돌고, 그래서 시계판이나 파이 차트로 읽히지 않는다.
      const head = performance.now() / 780 + this.headPhase;
      this.sweepOrigin =
        (((((head - this.rotation) / (Math.PI * 2)) * POINTS) % POINTS) + POINTS) % POINTS;
      this.sweepF = 0;
      this.sweepOn = true;
    }
    this.sweepTarget = clamp(v / SWEEP_HOLD, 0, 1);
  }

  /**
   * 성숙도 단일 소스. 파형·스트로크·틱·스무딩이 전부 이 함수만 쓴다 —
   * 하나라도 따로 계산하면 무늬와 밝기가 어긋나 오버레이처럼 보인다.
   * @param {number} u 출발선 기준 정규화 위치 0~1
   * @param {number} F 선단 위치
   */
  _matAt(u, F) {
    const ss = (x) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
    const m = ss((F - u) / SWEEP_W);
    if (u >= SWEEP_SEAM) return m;
    // 출발선 봉합: u=1 과 u=0 의 값을 일치시킨다.
    // 이게 없으면 conic gradient 의 wrap 지점에 1px 경계선이 선다.
    return lerp(ss((F - 0.9999) / SWEEP_W), m, ss(u / SWEEP_SEAM));
  }

  /**
   * 네 소스를 링 둘레의 목소리로 세운다.
   * @param {{angle:number, threat:number}[]} list angle 은 월드 rad (inject 와 같은 규약)
   *
   * 앵커를 각도가 아니라 인덱스로 굳히는 것이 유일하게 중요한 결정이다.
   * 화면에 고정된 사분면이면 즉시 계기판으로 읽힌다. 인덱스로 굳혀야
   * rotation 을 따라 함께 돌고, 그래야 링 자신의 결로 읽힌다.
   */
  setVoices(list, periodSec = 4) {
    if (!list || !list.length) { this.voiceOn = false; return; }
    const src = list.slice(0, 4);
    this.vPeriod = Math.max(0.5, periodSec);
    this.vCursor = 0;
    // 링에서 이웃한 목소리끼리 정체성이 가장 멀어지도록 각도 순으로 정렬해 교대 배치한다
    const ord = src.map((v, k) => k).sort((a, b) => src[a].angle - src[b].angle);
    this.voices = src.map((v, k) => {
      const s = 0.45 + 0.55 * clamp((v.threat ?? 50) / 100, 0, 1);   // 위협도 = 목소리 크기
      const i0 = ((((v.angle - this.rotation) / (Math.PI * 2)) * POINTS % POINTS) + POINTS) % POINTS;
      const t = (i0 / POINTS) * Math.PI * 2;
      return {
        i0, s, ca: Math.cos(t), sa: Math.sin(t),
        amp: VOICE_AMP * (0.62 + 0.62 * s),
        motion: (v.motion && v.motion.length) ? v.motion : null,
        mCur: v.motion && v.motion.length ? v.motion[0] : 0.5,
        n: VOICE_N[k], spd: VOICE_SPD[k],
        phase: (k * 2.3999) % (Math.PI * 2),      // 황금각 — 넷이 고르게 어긋난 채 출발
        ident: VOICE_ID[ord.indexOf(k)],
      };
    });
    this.voiceOn = true;
    this.fusion = 0;
    this.fusionTarget = 0;
    this.vLocked = false;
  }

  /** 융합도 0~1. 음수면 해제. */
  setFusion(v) {
    if (v < 0) { this.voiceOn = false; return; }
    this.fusionTarget = clamp(v, 0, 1);
  }

  /**
   * 목소리 한 프레임 전진.
   *
   * 파수를 점마다 바꾸면 처프가 생겨 240포인트에서 결이 찢어진다.
   * 그래서 차수는 정수 상수로 고정하고, 점마다 바뀌는 것은 가중치뿐이다.
   * 억양은 밀도와 무관하므로 _thinkShape 밖에서 한 번만 계산한다.
   */
  _voices(dt) {
    this.fusion = lerp(this.fusion, this.fusionTarget, 0.055);
    this.voiceMix = lerp(this.voiceMix, this.voiceOn ? 1 : 0, this.voiceOn ? 0.09 : 0.05);
    const vis = this.voiceMix * clamp(this.thinking, 0, 1);   // thinking 이 꺼지면 통째로 no-op
    if (vis < 0.002 || !this.voices.length) {
      if (this._vLive) { this.vAcc.fill(0); this.vCoh.fill(1); this._vLive = false; }
      this.vGain = 0;
      this.cohMean = 1;
      return;
    }
    this._vLive = true;

    const dts = dt / 1000;
    const TAU = Math.PI * 2;
    const cvg = sstep(this.fusion);
    this.vGain = vis * (1 - sstep((this.fusion - 0.60) / 0.36));   // 융합 0.96 에서 정확히 0
    this.vCommon += VOICE_DC * dts;
    this.vT += dts;
    // 초반 결합을 사실상 0 으로 눌러야 이음매 이야기가 첫 1초에 끝나지 않는다
    const pull = clamp(VOICE_LOCK * cvg * cvg * (dt / 16.7), 0, 0.5);

    // 움직임 커서. 각 목소리가 자기 클립의 프레임 변화율을 이 구간에 걸쳐 재생한다.
    this.vCursor = Math.min(1, this.vCursor + dts / this.vPeriod);

    const V = this.voices, K = V.length, cs = this._vcs;
    for (let k = 0; k < K; k++) {
      const v = V[k];
      if (v.motion) {
        const j = Math.min(v.motion.length - 1, Math.floor(this.vCursor * v.motion.length));
        // 부드럽게 따라가되 솟는 쪽은 빠르게 — 사건이 터지는 순간을 놓치지 않는다
        const tgt = v.motion[j];
        v.mCur = lerp(v.mCur, tgt, tgt > v.mCur ? 0.16 : 0.05);
      }
      // 자기 박자로 흐르다 합의 위상에 끌려간다. 드리프트도 함께 수렴시켜야
      // 잔류 위상차가 0 으로 닫힌다(안 하면 결속도가 0.91 에서 멈춘다).
      // 움직임이 많은 클립은 그만큼 빠르게 흐른다.
      const drift = v.n * v.spd * (0.45 + 1.1 * v.mCur);
      v.phase += lerp(drift, VOICE_DC, cvg) * dts + wrapPi(this.vCommon - v.phase) * pull;
      // 정체성 각. (1−cvg) 인자가 있어 융합 완료 시 전부 0 → 결속도 1 로 결정적으로 착지한다.
      const A = (v.ident + 0.6 * wrapPi(v.phase - this.vCommon)
        + 0.55 * Math.sin(0.45 * this.vT + 1.7 * v.n)) * (1 - cvg);
      cs[k] = Math.cos(A);
      cs[4 + k] = Math.sin(A);
    }

    const kap = VOICE_K0 * Math.pow(1 - cvg, 1.5);   // 영역 폭. cvg→1 이면 0 = 경계 소멸
    const cb = Math.cos(cvg * Math.PI / 2), sb = Math.sin(cvg * Math.PI / 2);
    const ca = this._ca, sa = this._sa;
    let sum = 0;
    for (let i = 0; i < POINTS; i++) {
      const a = (i / POINTS) * TAU;
      const sh = Math.sin(a * VOICE_NC + this.vCommon);   // 합의된 공통 억양
      let ws = 0, ac = 0, rx = 0, ry = 0;
      for (let k = 0; k < K; k++) {
        const v = V[k];
        // 감긴 가우시안(폰미제스). cos 가 주기적이라 둘레 이음매가 없다.
        const g = v.s * Math.exp(kap * (ca[i] * v.ca + sa[i] * v.sa - 1));
        ws += g;
        // 파수 보간은 처프를 낳는다 → 완성된 두 억양을 등파워로 교차(스윕과 같은 규약)
        // 그 클립이 지금 얼마나 움직이는지가 이 구역의 결 크기를 정한다
        const ma = v.amp * lerp(VOICE_MOT_LO, VOICE_MOT_HI, v.mCur);
        ac += g * ma * (cb * Math.sin(a * v.n + v.phase) + sb * sh);
        rx += g * cs[k];
        ry += g * cs[4 + k];
      }
      const inv = 1 / (ws || 1e-6);
      this.vAcc[i] = ac * inv * this.vGain;
      // 결속도 = 국소 질서 파라미터. 위상이 어긋난 영역이 맞닿는 이음매에서 꺼진다.
      const c = 1 - (1 - clamp(Math.sqrt(rx * rx + ry * ry) * inv, 0, 1)) * vis;
      this.vCoh[i] = c;
      sum += c;
    }
    this.cohMean = lerp(this.cohMean, sum / POINTS, 0.08);

    // 넷이 하나가 된 그 순간에 못을 박는다. 기존 flash 경로라 새 레이어가 0 개다.
    if (!this.vLocked && this.fusion > 0.90 && this.cohMean > 0.985) {
      this.vLocked = true;
      this.pulse(0.34);
    }
  }

  /**
   * 특정 방향에서 들어온 정보를 파형에 밀어 넣는다.
   * 영상이 링에 흡수될 때 그 영상이 왔던 각도에서 파형이 부풀어 오른다.
   */
  inject(angleRad, strength = 0.9, width = 30) {
    const center = ((angleRad - this.rotation) / (Math.PI * 2)) * POINTS;
    const sigma = width / 2.2;
    for (let k = -width; k <= width; k++) {
      const i = (((Math.round(center + k) % POINTS) + POINTS) % POINTS);
      const g = Math.exp(-(k * k) / (2 * sigma * sigma));
      this.amp[i] = Math.min(1, this.amp[i] + strength * g);
    }
    // 새 증거가 들어오면 그 방향 목소리의 위상이 걷어차인다 — 합의가 잠깐 흐트러졌다
    // 다시 맞춰진다. 착지한 상태는 절대 건드리지 않는다.
    if (this.voiceOn && this.fusion < 0.92) {
      for (const v of this.voices) {
        const va = (v.i0 / POINTS) * Math.PI * 2 + this.rotation;
        const d = Math.abs(wrapPi(angleRad - va));
        if (d < 0.8) v.phase += strength * 0.9 * (1 - d / 0.8) * (v.spd >= 0 ? 1 : -1);
      }
    }
  }

  /**
   * 연산이 만드는 파형.
   * density 를 올리면 고차 성분의 차수와 세기가 함께 올라가 파형이 촘촘해진다 —
   * "분석이 깊어진다"를 진폭이 아니라 밀도로 표현한다.
   */
  _thinkShape(now) {
    const t = now / 1000;
    const mix = this.sweepMix;
    const dHi = lerp(this.density, SWEEP_D_HI, mix);
    const dLo = lerp(this.density, SWEEP_D_LO, mix);
    const F = this.sweepF * (1 + SWEEP_W);   // 마지막 점까지 여물도록 1 을 넘겨 보낸다
    const o = this.sweepOrigin;

    // 밀도가 오르면 저차 성분은 물러나고 고차 성분이 앞으로 나온다.
    // 진폭이 아니라 결의 촘촘함이 바뀌어야 "분석이 깊어진다"로 읽힌다.
    const w = (a, d) =>
      (0.42 - 0.30 * d) * Math.sin(a * 3 - t * 1.65) +
      (0.26 - 0.16 * d) * Math.sin(a * 5 + t * 1.10) +
      (0.14 + 0.20 * d) * Math.sin(a * (8 + 6 * d) - t * (2.3 + 0.9 * d)) +
      (0.04 + 0.26 * d) * Math.sin(a * (13 + 9 * d) + t * (3.1 + 1.2 * d)) +
      (0.28 * d) * Math.sin(a * (20 + 8 * d) - t * (4.0 + 1.6 * d)) +
      (0.10 * d) * Math.sin(a * 2 + t * 0.55);

    // 억양이 실린 만큼 기본 파형을 미리 덜어낸다 — 진폭 상한이 지금 수준을 안 넘게.
    // vGain=0(융합 완료 또는 목소리 없음)이면 bs=1 이라 아래 두 줄은 기존과 완전히 같다.
    const bs = 1 - VOICE_COMP * this.vGain;

    const off = mix < 0.002;
    for (let i = 0; i < POINTS; i++) {
      const a = (i / POINTS) * Math.PI * 2;
      let v, m = 1;
      if (off) {
        v = w(a, dHi) * bs + this.vAcc[i];  // dHi === density → 억양만 얹힌다
      } else {
        const u = ((((i - o) % POINTS) + POINTS) % POINTS) / POINTS;
        m = 1 - (1 - this._matAt(u, F)) * mix;
        // 파수를 점마다 바꾸면(sin(a*(8+6*d_i))) 순간 파수가 튀어 240포인트에서
        // 결이 찢어진다. 완성된 두 파형을 등파워로 섞어야 경계에서 진폭이 꺼지지 않고
        // 무늬만 갈아탄다. 가중치 제곱합이 1이라 한가운데(0.707/0.707)도 안전하다.
        const g = m * Math.PI / 2;
        // 진폭 봉투는 AC 성분에만. DC 0.30 은 아래에서 따로 더하므로 자동으로 보호된다.
        // 억양도 이 봉투 안으로 들어간다 — 안 여문 쪽에서 55% 로 눌리므로
        // 스윕의 '덜 익음' 인상을 훼손하지 않는다. 진폭 소유권은 계속 스윕에 있다.
        v = ((w(a, dHi) * Math.sin(g) + w(a, dLo) * Math.cos(g)) * bs + this.vAcc[i])
          * lerp(SWEEP_AMP_LO, 1, m);
      }
      this.mat[i] = m;
      this.dens[i] = off ? this.density : lerp(dLo, dHi, m);
      this.tmp[i] = clamp(0.30 + v * 0.30, 0, 1);
    }
  }
  setScale(v) { this.scaleTarget = v; }
  setCenter(x, y) { this.centerTarget = { x, y }; }
  setOpacity(v) { this.opacity = v; }
  /** 전환 없이 즉시 반영 — 리플레이로 초기 상태를 되돌릴 때 쓴다. */
  snapTo(x, y, scale) {
    this.center = { x, y }; this.centerTarget = { x, y };
    this.scale = scale; this.scaleTarget = scale;
    this.cx = this.w * x; this.cy = this.h * y;
  }

  /** 주파수 빈 → 링 포인트 매핑 테이블. sampleRate를 알아야 만들 수 있다. */
  _buildBinMap(sampleRate, binCount) {
    const nyquist = sampleRate / 2;
    const map = new Int32Array(HALF);
    for (let i = 0; i < HALF; i++) {
      const t = i / (HALF - 1);
      const f = F_LO * Math.pow(F_HI / F_LO, t);          // 로그 간격
      map[i] = clamp(Math.round((f / nyquist) * binCount), 1, binCount - 2);
    }
    this.binMap = map;
  }

  _sampleSpectrum() {
    const data = this.bus.read();
    if (!data) return false;
    if (!this.binMap) this._buildBinMap(data.sampleRate, data.freq.length);

    const freq = data.freq;
    for (let i = 0; i < HALF; i++) {
      // 인접 빈 3개의 최댓값 — 좁은 피크가 프레임 사이에서 깜빡이는 걸 막는다
      const b = this.binMap[i];
      const v = Math.max(freq[b - 1], freq[b], freq[b + 1]) / 255;
      // 고역은 에너지가 원래 작으므로 살짝 보정해 균형을 맞춘다
      const tilt = 1 + 0.55 * (i / HALF);
      this.tmp[i] = clamp(v * tilt * this.specGain, 0, 1);
    }
    // 좌우 대칭으로 미러링 — 설계된 형태로 읽히게 한다
    for (let i = 0; i < HALF; i++) this.tmp[POINTS - 1 - i] = this.tmp[i];
    return true;
  }

  _smooth(dt) {
    // 시간축: 비대칭 EMA. 60fps 기준 계수를 실제 dt로 보정한다.
    const k = clamp(dt / (1000 / 60), 0.2, 3);
    const atk = 1 - Math.pow(1 - ATTACK, k);
    const rel = 1 - Math.pow(1 - RELEASE, k);
    for (let i = 0; i < POINTS; i++) {
      const target = this.tmp[i];
      this.amp[i] = lerp(this.amp[i], target, target > this.amp[i] ? atk : rel);
    }
    // 공간축: 원형 5탭. 밀도가 높을수록 덜 돌려야 촘촘한 결이 살아남는다.
    // 단수를 정수로 끊으면 결이 툭 튀므로 소수 단위로 섞는다.
    // 스윕 중에는 점마다 밀도가 다르므로 패스 수도 점마다 달라야 한다 —
    // 전역 density 로 정하면 안 여문 쪽 기준 2패스가 여문 쪽 결까지 뭉갠다.
    const useMat = this.sweepMix > 0.002 && this.thinking > 0.002;
    // 목소리가 살아 있으면 스무딩을 물러나게 한다. 밀도가 낮다고 2패스를 돌리면
    // 억양의 고차 성분(n=15·19)이 통째로 뭉개져 네 구역이 다 같아 보인다.
    const keep = this.vGain > 0.02 ? VOICE_KEEP : 0;
    const passF = this._passF;
    let maxPass = 0;
    for (let i = 0; i < POINTS; i++) {
      const dd = Math.max(useMat ? this.dens[i] : this.density, keep);
      const pf = SPATIAL_PASSES * (1 - clamp((dd - 0.15) / 0.6, 0, 1));
      passF[i] = pf;
      if (pf > maxPass) maxPass = pf;
    }
    for (let p = 0; p < SPATIAL_PASSES && p < maxPass; p++) {
      const src = Float32Array.from(this.amp);
      for (let i = 0; i < POINTS; i++) {
        const blend = clamp(passF[i] - p, 0, 1);   // 소수 패스를 그대로 구현한다
        if (blend < 0.002) continue;
        const a = src[(i - 2 + POINTS) % POINTS], b = src[(i - 1 + POINTS) % POINTS];
        const c = src[i];
        const d = src[(i + 1) % POINTS], e = src[(i + 2) % POINTS];
        const sm = (a + 2 * b + 3 * c + 2 * d + e) / 9;
        this.amp[i] = blend >= 0.998 ? sm : lerp(c, sm, blend);
      }
    }
  }

  _idleShape(now) {
    // 무음일 때: 위상이 다른 사인 3개를 겹쳐 미세하게 일렁이게 한다
    const t = now / 1000;
    for (let i = 0; i < POINTS; i++) {
      const a = (i / POINTS) * Math.PI * 2;
      const v = 0.5 + 0.5 * (
        0.55 * Math.sin(a * 2 + t * 0.55) +
        0.30 * Math.sin(a * 3 - t * 0.38) +
        0.15 * Math.sin(a * 5 + t * 0.9)
      );
      this.tmp[i] = v * 0.085;   // 유휴 진폭은 아주 작게
    }
  }

  start() {
    if (this._raf) return;
    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(now - last, 50);
      last = now;
      this.frame(now, dt);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() { cancelAnimationFrame(this._raf); this._raf = null; }

  frame(now, dt) {
    const lv = this.bus.level();
    this.prevLevel = this.level;
    this.level = lerp(this.level, lv, 0.35);

    // 자동 레인지: 최근 최대치를 천천히 떨어뜨리며 기준으로 삼는다.
    // 조용한 클립이 오면 ref가 내려가 링이 다시 크게 반응한다.
    this.ref = Math.max(this.ref * Math.pow(0.9986, dt / 16.7), lv, 0.012);
    this.specGain = clamp(0.085 / this.ref, 1, 3.4);
    this.norm = clamp(this.level / (this.ref * 0.85), 0, 1);

    // 급격한 상승 = 타격음. 짧게 번쩍이고 즉시 감쇠한다.
    const jump = (lv - this.prevLevel) / Math.max(this.ref, 0.02);
    if (jump > 0.35) this.flash = Math.min(1, this.flash + jump * 0.9);
    this.flash *= Math.pow(0.86, dt / 16.7);

    // 소리 유무에 따라 실시간 스펙트럼과 유휴 호흡을 섞는다
    const targetLive = clamp(this.norm * 1.7, 0, 1);
    this.liveness = lerp(this.liveness, targetLive, targetLive > this.liveness ? 0.25 : 0.03);

    const hasAudio = this._sampleSpectrum();
    if (!hasAudio) {
      this._idleShape(now);
    } else if (this.liveness < 0.999) {
      const live = Float32Array.from(this.tmp);
      this._idleShape(now);
      for (let i = 0; i < POINTS; i++) {
        this.tmp[i] = lerp(this.tmp[i], live[i], this.liveness);
      }
    }

    // 통합 인지 모드는 오디오 경로를 덮어쓴다 — 소리가 아니라 연산이 만드는 파형이다
    this.thinking = lerp(this.thinking, this.thinkTarget,
      this.thinkTarget > this.thinking ? 0.045 : 0.06);
    this.density = lerp(this.density, this.densityTarget, 0.05);
    // 스윕 수렴. sweepF 의 0.22 가 진행률 업데이트 간격(60ms)의 계단을 지운다.
    this.sweepMix = lerp(this.sweepMix, this.sweepOn ? 1 : 0, this.sweepOn ? 0.12 : 0.08);
    if (this.sweepOn) this.sweepF = lerp(this.sweepF, this.sweepTarget, 0.22);

    // 인지 모드가 완전히 꺼지면 목소리도 접는다. 이미 화면에서 사라진 뒤에 정리되므로
    // 해제 아티팩트가 없고, vAcc→0 / vCoh→1 로 기존 동작과 수치까지 같아진다.
    if (this.thinkTarget === 0 && this.thinking < 0.002 && this.voiceOn) this.voiceOn = false;
    this._voices(dt);
    if (this.thinking > 0.002) {
      const base = Float32Array.from(this.tmp);
      this._thinkShape(now);
      for (let i = 0; i < POINTS; i++) {
        this.tmp[i] = lerp(base[i], this.tmp[i], this.thinking);
      }
    }

    this._smooth(dt);

    // 색은 항상 부드럽게 수렴시킨다 — 갑작스러운 색 전환은 싸구려로 보인다
    this.tint.h = lerp(this.tint.h, this.targetTint.h, 0.04);
    this.tint.s = lerp(this.tint.s, this.targetTint.s, 0.04);
    this.tint.l = lerp(this.tint.l, this.targetTint.l, 0.04);

    // 위치·크기도 같은 방식으로 수렴시킨다. 캔버스 좌표를 직접 옮기므로 항상 선명하다.
    const f = 1 - Math.pow(1 - this.follow, clamp(dt / (1000 / 60), 0.2, 3));
    this.center.x = lerp(this.center.x, this.centerTarget.x, f);
    this.center.y = lerp(this.center.y, this.centerTarget.y, f);
    this.scale = lerp(this.scale, this.scaleTarget, f);
    this.cx = this.w * this.center.x;
    this.cy = this.h * this.center.y;

    this.rotation += (0.00016 + this.norm * 0.0009) * dt + this.spin * (dt / 1000);
    this.spin *= Math.pow(0.90, dt / 16.7);

    this.draw(now);
  }

  /**
   * 각도별 밝기를 원뿔 그라디언트 한 장으로 준다.
   * 세그먼트 분할 stroke 를 쓰지 않는 이유: 이음매마다 alpha<1 스트로크가 겹쳐
   * 어두운 점이 찍히고, blur(7px) 잔광까지 조각내면 filter 가 조각 수만큼 걸린다.
   * startAngle 에 rotation 을 넣었으므로 그라디언트가 링과 함께 돈다 —
   * 이게 conic 을 쓰는 진짜 이유다. 안 넣으면 파형 위에 얹힌 별개의 오버레이로 읽힌다.
   * 스칼라를 (m, c) 2차원으로 넓혀 스윕과 목소리가 레이어를 나누지 않고 공유한다.
   * m 은 더하는 쪽(여묾), c 는 곱해서 빼는 쪽(결속)이라 서로를 지우지 않는다 —
   * 여문 자리에 이음매가 걸리면 "여물었지만 아직 합의 안 된 구간"으로 정확히 읽힌다.
   * @param {(m:number, c:number)=>string} f
   */
  _sweepPaint(ctx, f) {
    const sw = this.sweepMix > 0.002;
    const vx = this.voiceMix > 0.002;
    if ((!sw && !vx) || !ctx.createConicGradient) return f(1, 1);
    const o = sw ? this.sweepOrigin : 0;
    const N = vx ? VOICE_STOPS : SWEEP_STOPS;
    const g = ctx.createConicGradient((o / POINTS) * Math.PI * 2 + this.rotation, this.cx, this.cy);
    const F = this.sweepF * (1 + SWEEP_W);
    for (let k = 0; k <= N; k++) {
      const u = k / N;
      // u=1 을 0.9999 로 눌러 봉합 결과와 stop 0 의 값을 정확히 일치시킨다
      const m = sw ? 1 - (1 - this._matAt(Math.min(u, 0.9999), F)) * this.sweepMix : 1;
      const i = (((Math.round(o + u * POINTS) % POINTS) + POINTS) % POINTS);
      g.addColorStop(u, f(m, this.vCoh[i]));
    }
    return g;
  }

  _path(ctx, radiusAt) {
    const pts = [];
    for (let i = 0; i < POINTS; i++) {
      const a = (i / POINTS) * Math.PI * 2 + this.rotation;
      const r = radiusAt(i);
      pts.push([this.cx + Math.cos(a) * r, this.cy + Math.sin(a) * r]);
    }
    // 중점 이차베지어로 닫힌 곡선을 그린다 — 톱니 없이 부드럽다
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    ctx.beginPath();
    const m = mid(pts[POINTS - 1], pts[0]);
    ctx.moveTo(m[0], m[1]);
    for (let i = 0; i < POINTS; i++) {
      const cur = pts[i], nxt = pts[(i + 1) % POINTS];
      const e = mid(cur, nxt);
      ctx.quadraticCurveTo(cur[0], cur[1], e[0], e[1]);
    }
    ctx.closePath();
    return pts;
  }

  draw(now) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.opacity <= 0.001) return;

    ctx.save();
    ctx.globalAlpha = this.opacity;

    const h = this.tint.h, s = this.tint.s, l = this.tint.l;
    const R = this.r0 * this.scale;
    const breathe = 1 + 0.014 * Math.sin(now / 1400) + this.flash * 0.055;
    // 밝기·두께는 정규화된 음량을 따르되, 인지 모드에서는 연산이 그 자리를 대신한다
    // 인지 모드에서는 링 자체가 커져 있으므로 변위 계수를 낮춰야 화면을 넘지 않는다
    const energy = Math.max(this.norm, this.thinking * 0.45);
    const spread = R * (0.40 + energy * 0.42);
    const radiusAt = (i) => R * breathe + this.amp[i] * spread;
    // 스윕이 꺼져 있으면 아래 모든 계수가 이전 값과 동일해진다
    const live = this.sweepMix > 0.002;
    const fill = live ? this.sweepMix * clamp(this.sweepF, 0, 1) : 0;

    // ── 안쪽 은은한 채움: 링에 부피감을 준다.
    // 진행에 따라 속이 밝아진다 — 각도 방향의 '여묾'에 반지름 방향의 '차오름'을 겹친다.
    const g = ctx.createRadialGradient(this.cx, this.cy, R * 0.25, this.cx, this.cy, R * 1.5);
    // 마지막 항: 넷이 하나로 합의될수록 링 속이 밝아진다(각도에 균일 = 스윕과 축이 다르다)
    g.addColorStop(0, `hsla(${h}, ${s}%, ${l}%, ${0.11 + energy * 0.20 + this.flash * 0.12
      + 0.07 * this.thinking * fill
      + 0.06 * this.thinking * this.voiceMix * clamp((this.cohMean - 0.80) / 0.20, 0, 1)})`);
    g.addColorStop(0.55, `hsla(${h}, ${s}%, ${l}%, ${0.05 + energy * 0.09})`);
    g.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`);
    ctx.fillStyle = g;
    this._path(ctx, (i) => radiusAt(i) * 1.02);
    ctx.fill();

    // ── 바깥 잔광: 같은 경로를 두껍고 흐리게 한 겹 더
    ctx.lineWidth = 10 + energy * 16;
    // 결속도는 바닥 60% 를 둬 얕게만 — blur 위에 무늬를 세게 얹으면 얼룩진다
    ctx.strokeStyle = this._sweepPaint(ctx, (m, c) =>
      `hsla(${h}, ${s}%, ${l}%, ${(0.05 + energy * 0.14 + this.flash * 0.10)
        * (0.28 + 0.72 * m) * (0.45 + 0.55 * c)})`);
    ctx.filter = 'blur(7px)';
    this._path(ctx, radiusAt);
    ctx.stroke();
    ctx.filter = 'none';

    // ── 본체 선.
    // e 는 전이대 한가운데(m=0.5)에서만 1인 봉우리 — 지금 여물고 있는 구간이 살짝 뜨거워진다.
    // 새 레이어가 아니라 이 스트로크 한 겹 안에서만 일어난다. m=1 이면 e=0 이라 이전 값과 같다.
    ctx.lineWidth = 1.8;
    // d = 1 − 결속도. 이음매의 주 채널이다. 어두워질 뿐 사라지지는 않게
    // alpha 바닥을 두고 명도도 −13L 까지만 내린다. 반지름은 결속도의 영향을
    // 전혀 안 받으므로 형상의 연속성이 끊길 수 없다.
    ctx.strokeStyle = this._sweepPaint(ctx, (m, c) => {
      const e = 4 * m * (1 - m);
      const d = 1 - c;
      return `hsla(${h}, ${Math.min(100, s + 6 + 8 * d)}%, ` +
        `${Math.min(92, l + 4 + 16 * m + 6 * e + this.flash * 14 - 22 * d)}%, ` +
        `${clamp((0.34 + 0.48 * m + 0.06 * e + this.flash * 0.18) * (1 - 0.55 * d), 0, 1)})`;
    });
    this._path(ctx, radiusAt);
    ctx.stroke();

    // ── 안쪽 기준 링: 파형이 없어도 형태가 유지되게 한다.
    // 인지 모드에서는 거의 지운다 — 회전하지 않는 완전한 정원은
    // 아크를 지운 뒤 화면에 남는 유일한 '계기판' 어휘라 스윕의 인상을 깎는다.
    ctx.lineWidth = 1;
    ctx.strokeStyle = `hsla(${h}, ${s}%, ${l}%, ${0.20 * (1 - 0.9 * this.thinking)})`;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, R * 0.80, 0, Math.PI * 2);
    ctx.stroke();

    // ── 고역 틱: 스펙트럼의 결이 바깥으로 새어나오는 느낌.
    // 스윕 중에는 여문 쪽에만 잔가시가 돋아 진행량이 '셀 수 있는' 양으로도 읽힌다.
    if (energy > 0.06) {
      const useMat = live && this.thinking > 0.002;
      ctx.lineWidth = 1;
      for (let i = 0; i < POINTS; i += 4) {
        const v = this.amp[i];
        if (v < 0.22) continue;
        // 이음매에서는 잔가시도 함께 죽는다
        const tm = (useMat ? Math.pow(this.mat[i], 1.5) : 1) * (0.30 + 0.70 * this.vCoh[i]);
        if (tm < 0.02) continue;
        const a = (i / POINTS) * Math.PI * 2 + this.rotation;
        const r1 = radiusAt(i) + 5;
        const r2 = r1 + v * R * 0.20;
        ctx.strokeStyle = `hsla(${h}, ${s}%, ${l + 12}%, ${(v - 0.22) * 0.55 * tm})`;
        ctx.beginPath();
        ctx.moveTo(this.cx + Math.cos(a) * r1, this.cy + Math.sin(a) * r1);
        ctx.lineTo(this.cx + Math.cos(a) * r2, this.cy + Math.sin(a) * r2);
        ctx.stroke();
      }
    }

    // ── 인지 모드의 스캔 꼬리: 링 둘레를 훑고 도는 밝은 자취.
    // 자유 회전 부호를 인덱스 증가 방향과 맞춰 꼬리가 머리 뒤로 눕게 했다.
    // 스윕 중에는 머리를 선단에 고정해 경계를 앞장서서 끌고 간다.
    if (this.thinking > 0.05) {
      const sweep = this.sweepOn
        ? (this.sweepOrigin / POINTS + Math.min(this.sweepF * (1 + SWEEP_W), 1)) * Math.PI * 2 + this.rotation
        : now / 780 + this.headPhase;
      const steps = 34;
      ctx.lineWidth = 2;
      for (let j = 0; j < steps; j++) {
        const a = sweep - j * 0.028;
        const fade = Math.pow(1 - j / steps, 2.2) * this.thinking;
        if (fade < 0.02) continue;
        const idx = (((Math.round(((a - this.rotation) / (Math.PI * 2)) * POINTS) % POINTS) + POINTS) % POINTS);
        const r1 = R * breathe + this.amp[idx] * spread;
        ctx.strokeStyle = `hsla(${h}, ${s}%, ${Math.min(94, l + 24)}%, ${fade * 0.6})`;
        ctx.beginPath();
        ctx.moveTo(this.cx + Math.cos(a) * (r1 - 3), this.cy + Math.sin(a) * (r1 - 3));
        ctx.lineTo(this.cx + Math.cos(a) * (r1 + 6), this.cy + Math.sin(a) * (r1 + 6));
        ctx.stroke();
      }
    }

    ctx.restore();
  }
}
