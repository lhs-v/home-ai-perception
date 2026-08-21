/**
 * 4개 영상 엘리먼트를 하나의 Web Audio 그래프로 묶는다.
 *
 *   video ─ MediaElementSource ─ GainNode ┐
 *   video ─ MediaElementSource ─ GainNode ┼─ master ─ analyser ─ destination
 *   ...                                   ┘
 *
 * 링 파형은 analyser 하나만 읽으면 되므로, 몇 개가 동시에 울리든
 * "지금 실제로 들리는 소리"가 그대로 시각화된다.
 */

const FFT_SIZE = 2048;

export class AudioBus {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.analyser = null;
    this.freq = null;
    this.time = null;
    /** @type {Map<HTMLMediaElement, GainNode>} */
    this.gains = new Map();
  }

  /** 사용자 제스처 이후에 호출해야 한다(자동재생 정책). */
  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      // 시각적 스무딩은 ring.js에서 직접 제어하므로 여기선 최소로 둔다.
      this.analyser.smoothingTimeConstant = 0.6;
      // 홈캠 클립은 대체로 녹음 레벨이 낮다. 범위를 넓게 잡아야
      // 조용한 소리도 링에서 형태를 드러낸다.
      this.analyser.minDecibels = -96;
      this.analyser.maxDecibels = -24;

      // 네 클립이 동시에 울리고 소스별 보정 게인이 1을 넘기도 해서
      // 마스터에 컴프레서를 물려 피크를 잡는다. 믹스가 한결 정돈되어 들린다.
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -18;
      this.comp.knee.value = 24;
      this.comp.ratio.value = 6;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.22;

      this.master.connect(this.comp);
      this.comp.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.time = new Uint8Array(this.analyser.fftSize);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  /** 영상 엘리먼트를 그래프에 등록한다. 엘리먼트당 한 번만 유효하다. */
  attach(el) {
    if (this.gains.has(el)) return this.gains.get(el);
    const src = this.ctx.createMediaElementSource(el);
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    g.connect(this.master);
    this.gains.set(el, g);
    return g;
  }

  /** 지정 시간에 걸쳐 볼륨을 램프한다. 클릭 노이즈를 막기 위해 항상 램프를 쓴다. */
  ramp(el, value, seconds = 0.25) {
    const g = this.gains.get(el);
    if (!g) return;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(Math.max(g.gain.value, 1e-4), t);
    // 지수 램프가 자연스럽지만 0을 다룰 수 없어 선형으로 마감한다.
    g.gain.linearRampToValueAtTime(Math.max(value, 0), t + seconds);
  }

  silenceAll(seconds = 0.15) {
    for (const el of this.gains.keys()) this.ramp(el, 0, seconds);
  }

  /**
   * 회차가 끝나면 이전 영상 엘리먼트를 그래프에서 떼어낸다.
   * createMediaElementSource는 엘리먼트당 한 번뿐이라 재사용할 수 없고,
   * 남겨두면 지난 회차의 소리가 새 회차에 섞여 들어온다.
   */
  detachAll() {
    for (const g of this.gains.values()) {
      try { g.disconnect(); } catch { /* 이미 끊긴 노드 */ }
    }
    this.gains.clear();
  }

  /** 링 렌더러가 매 프레임 호출한다. */
  read() {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.time);
    return { freq: this.freq, time: this.time, sampleRate: this.ctx.sampleRate };
  }

  /** 시간영역 데이터의 RMS(0~1). 전체 음량 감각에 쓴다. */
  level() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.time);
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.time.length);
  }
}
