/**
 * Home AI — 청각 상황 인지 데모 (연출 제어)
 *
 *  1막 청취  검은 화면 + 링. 4개 클립의 소리만 순차 재생, 링이 실제 오디오에 반응.
 *            들리는 순간 링 바깥 사분면에 "귀로만 알 수 있는" 소리 묘사가 떠오른다.
 *  2막 전개  링이 감겨 돌며 물러나고 4분할 그리드가 펼쳐진다.
 *  3막 확인  4개 영상 동시 재생. 초점이 옮겨갈 때마다 그 영상의 소리가 앞으로 나오고
 *            옆에 설명이 어절 단위로 쓰인다.
 *  4막 통합  네 장면이 상단 스트립으로 수축하고 하나의 상황 서술이 떠오른다.
 *  5막 판단  개입 여부, 위협도, 근거, 조치.
 */

import { AudioBus } from './audio.js';
import { Ring } from './ring.js';
import { fuse, orderByStory, TONE_TINT, mixTint } from './fusion.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const CFG = {
  // 1막은 네 소리가 "같은 순간 같은 집에서" 울린다는 전제라 동시 재생한다.
  // 다만 완전히 같은 시각에 터지면 한 덩어리로 뭉쳐 들리므로 살짝 어긋나게 띄운다.
  listenStagger: 420,   // 클립 간 시작 간격
  focusMs: 5600,        // 클립당 들려주는 길이 (clips.json 의 focus 구간)
  listenTail: 1600,     // 마지막 소리 뒤 여운
  mixLevel: 0.62,       // 4개가 겹치므로 개별 볼륨을 낮춘다
  fadeIn: 0.26,
  fadeOut: 0.5,

  // 3막은 반대로 하나씩 짚는다. 동시에 들은 것을 하나씩 확인시켜야
  // "무슨 상황이었는지"가 각각 또렷해진다.
  gridFocus: 4200,      // 패널 하나에 머무는 시간
  duckLevel: 0.14,      // 초점이 아닌 영상의 볼륨
  typeBudget: 1250,     // 타이핑이 이 시간을 넘지 않게 속도를 보정한다
  gridHold: 500,        // 넷을 다 설명한 뒤 짧은 숨

  // 4막: 네 장면이 하나의 인식으로 합쳐지는 구간. 서두르면 의미가 안 산다.
  fuseIdle: 4000,       // 영상도 설명도 그대로 둔 채 눈으로 훑을 시간.
                        // 여기가 짧으면 무엇이 합쳐지는지 모른 채 합쳐지는 걸 보게 된다.
  fuseFreeze: 950,      // 그다음에야 화면이 얼어붙고 채도가 빠진다
  fuseLink: 1250,       // 중심에서 네 장면으로 곡선이 뻗는 시간
  fuseFlight: 1500,     // 패널이 링으로 빨려 들어가는 시간
  fusePerceive: 5600,   // 넷을 삼킨 링이 통합 인지를 수행하는 시간
  fuseUtter: 700,       // 결론을 내뱉기 직전의 숨
  fusionHold: 5000,     // 통합 서술을 읽을 시간

  // 5막: 통합 상황이 링으로 녹아든 뒤 위험도를 분석하고 판단을 내놓는다
  meltMs: 1700,         // 서술과 증거가 링으로 빨려드는 시간
  analyzeMs: 6200,      // 파형이 여물어 가며 위험도를 재는 시간
  lockMs: 1000,         // 판단이 확정되며 색이 바뀌는 순간

  // 링은 축소 없이 자라기만 한다. 영상 뒤 배경일 때가 가장 작고,
  // 정보를 하나씩 삼킬 때마다 커져 마지막에 가장 큰 파형링이 된다.
  ringGrid: 1.50,       // 3막 배경일 때 (이전 1.95보다 작다)
  ringStep: 0.16,       // 영상 하나를 삼킬 때마다 자라는 폭 → 최종 2.14
  ringOvershoot: 0.10,  // 단계마다 살짝 넘겼다 되돌아오는 탄성
};

const stage = $('#stage');
const bus = new AudioBus();
let ring;
let CLIPS = [];
let FUSION = null;

/** 회차 토큰. 리플레이하면 증가하고, 진행 중이던 연출은 즉시 중단된다. */
let session = 0;
class Aborted extends Error {}
const guard = (my) => { if (my !== session) throw new Aborted(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 부트 ─────────────────────────────────────────────── */

async function boot() {
  const [clips, fusionSpec] = await Promise.all([
    fetch('./data/clips.json').then((r) => r.json()),
    fetch('./data/fusion.json').then((r) => r.json()),
  ]);
  // 사실상 무음인 감시영상은 1막이 성립하지 않으므로 뽑기 대상에서 뺀다
  const audible = clips.filter((c) => c.audible !== false).map(normalizeClip);
  // 저장소에는 영상이 없다(저작권). clone 직후엔 clips.json 만 있고 파일이 없으므로
  // 실제로 존재하는 것만 남긴다 — 없는 채로 시작하면 조용히 아무 소리도 안 난다.
  CLIPS = await onlyPresent(audible);
  FUSION = fusionSpec;

  if (CLIPS.length < 4) return showSetupNotice(clips.length, CLIPS.length);

  ring = new Ring($('#ring-canvas'), bus);
  ring.start();

  // 연출 타이밍을 손볼 때 콘솔에서 바로 들여다볼 수 있게 열어둔다
  window.__homeai = { bus, ring, CFG, get clips() { return CLIPS; } };
  followRing();
  startClock();

  $('#start-btn').addEventListener('click', begin, { once: true });
  $('#replay').addEventListener('click', () => { run().catch(swallow); });
}

function swallow(e) { if (!(e instanceof Aborted)) console.error(e); }

/** 실제로 서버에 존재하는 클립만 남긴다. HEAD 한 번이면 충분하다. */
async function onlyPresent(list) {
  const checks = await Promise.all(list.map(async (c) => {
    try {
      const r = await fetch(`../references/${encodeURIComponent(c.file)}`, { method: 'HEAD' });
      return r.ok ? c : null;
    } catch {
      return null;
    }
  }));
  return checks.filter(Boolean);
}

/**
 * 영상이 없으면 검은 화면에서 아무 일도 안 일어난다.
 * 무엇을 해야 하는지 화면에서 바로 알려준다.
 */
function showSetupNotice(total, found) {
  $('#prompt').innerHTML = `
    <div class="setup">
      <h1>영상이 없습니다</h1>
      <p>
        원본은 각 YouTube 업로더에게 저작권이 있어 저장소에 포함하지 않았습니다.
        아래를 한 번 실행하면 <code>references/</code> 가 채워지고 측정값까지 자동으로 잡힙니다.
      </p>
      <pre>npm run setup</pre>
      <p class="setup-sub">
        ${found > 0
          ? `현재 ${total}개 중 ${found}개만 받아져 있습니다 (4개 이상 필요).`
          : `<code>references/sources.json</code> 에 출처 12개가 기록되어 있습니다.`}
        직접 넣으실 거면 mp4 를 <code>references/</code> 에 두고
        <a href="/admin/">운영자 탭</a>에서 인제스트를 실행하세요.
      </p>
    </div>`;
  $('#prompt').classList.remove('gone');
  $('#hud-mode').textContent = 'NO MEDIA';
  $('#ring-status').textContent = '대기';
}

/**
 * 클립 하나가 빠진 필드 때문에 데모 전체를 죽이지 않게 기본값을 채운다.
 *
 * references/ 에 mp4 를 넣고 `npm run ingest` 만 돌리면 측정값(길이·온셋·게인·움직임)은
 * 자동으로 채워지지만, 무슨 사건인지·어떻게 들리는지는 사람이 써야 한다.
 * 안 쓴 상태로도 재생은 되어야 새 영상을 바로 확인해 볼 수 있다.
 */
function normalizeClip(c) {
  const dur = Number(c.duration) || 10;
  const onset = Number.isFinite(c.onset) ? c.onset : 0;
  const focus = Array.isArray(c.focus) && c.focus.length === 2
    ? c.focus
    : [Math.max(0, Math.min(onset - 0.9, Math.max(0, dur - 5.6))), 0];
  if (!focus[1]) focus[1] = Math.min(dur, focus[0] + 5.6);

  const s = c.sound || {};
  const v = c.visual || {};
  const m = c.semantics || {};
  return {
    ...c,
    duration: dur,
    onset,
    focus,
    gain: Number(c.gain) || 1,
    title_ko: c.title_ko || '미분류 신호',
    sound: {
      onomatopoeia: s.onomatopoeia || '—',
      cue_line: s.cue_line || '아직 소리 설명이 작성되지 않았다',
      texture: s.texture || '분류되지 않은 소리',
      distance: s.distance || 'mid',
      loudness: Number.isFinite(s.loudness) ? s.loudness : 5,
      acoustic_tags: s.acoustic_tags || [],
    },
    visual: {
      description_ko: v.description_ko || '아직 장면 설명이 작성되지 않았다',
      room: v.room || '미분류',
      camera_view: v.camera_view || '미분류',
      time_of_day: v.time_of_day || 'unknown',
      actors: v.actors || [],
    },
    semantics: {
      event_type: m.event_type || 'unknown',
      threat: Number.isFinite(m.threat) ? m.threat : 30,
      urgency: m.urgency || 'low',
      tags: m.tags || ['noise'],
      fusion_note: m.fusion_note || '',
    },
  };
}

async function begin() {
  await bus.unlock();
  $('#prompt').classList.add('gone');
  $('#acts').classList.add('on');
  run().catch(swallow);
}

/** 링 중심이 매 프레임 움직이므로 코어 텍스트도 같은 시계로 따라붙인다. */
function followRing() {
  const core = $('#ring-core');
  const loop = () => {
    const g = ring.geometry();
    core.style.transform = `translate(-50%, -50%) translate(${g.cx}px, ${g.cy}px)`;
    core.style.left = '0px';
    core.style.top = '0px';
    // 글자 크기를 링 반지름에 묶는다. 인지·분석 구간에서 링이 2배 넘게 커지는데
    // 글자만 고정이면 거대한 파형 한가운데 작은 글씨가 떠 있는 꼴이 된다.
    core.style.setProperty('--ring-r', `${g.r}px`);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function startClock() {
  const tick = () => {
    const d = new Date();
    $('#hud-clock').textContent =
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  tick();
  setInterval(tick, 20000);
}

/* ── 회차 진행 ────────────────────────────────────────── */

function sample(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function run() {
  const my = ++session;
  const picks = orderByStory(sample(CLIPS, 4));

  resetStage(picks);
  await preload(picks, my);

  await act1(picks, my);
  await act2(my);
  await act3(picks, my);

  const result = fuse(picks, FUSION);
  await act4(picks, result, my);
  await act5(picks, result, my);
}

function resetStage(picks) {
  bus.silenceAll(0.05);
  bus.detachAll();

  stage.dataset.act = 'idle';
  stage.dataset.tone = 'listen';
  stage.style.removeProperty('--accent');   // 지난 회차의 판단색을 걷어낸다
  $('#replay').classList.remove('on');
  $('#replay').hidden = true;
  $('#grid').classList.remove('on');
  $('#fusion').classList.remove('on', 'compact');
  $('#verdict').classList.remove('on');
  $('#connectors').classList.remove('on');
  $('#connectors').innerHTML = '';
  $('#cues').innerHTML = '';
  $('#fusion-strip').innerHTML = '';
  // 링으로 녹아들며 남은 인라인 변형을 지운다
  $('#fusion-narrative').innerHTML = '';
  $('#fusion-name').style.cssText = '';
  $('#fusion-name').textContent = '';
  $('#onomatopoeia').classList.remove('show');
  $$('.act-step').forEach((s) => s.classList.remove('now', 'done'));

  ring.snapTo(0.5, 0.5, 1);
  ring.setOpacity(1);
  ring.setTint(205, 92, 62);
  ring.setThinking(false);
  ring.thinking = 0;
  ring.setDensity(0);
  ring.density = 0;
  ring.setProgress(-1);
  ring.setFusion(-1);
  ring.voices = [];
  ring.voiceMix = 0;
  ring.fusion = 0;
  ring.fusionTarget = 0;
  ring.cohMean = 1;
  ring.follow = 0.08;

  $('#hud-session').textContent =
    'SESSION ' + Math.random().toString(16).slice(2, 6).toUpperCase();
  $('#hud-sources').textContent = `${picks.length} SOURCES`;

  buildPanels(picks);
  buildCues(picks);
}

/** 지금 막에서 실제로 보이는 영역만 접근성 트리에 남긴다. */
const ACT_REGIONS = {
  grid: '#grid',
  fuse: '#fusion',
  perceive: '#fusion',
  verdict: '#verdict',
};

function setAct(name, step) {
  stage.dataset.act = name;
  // aria-hidden 을 한 번 걸어놓고 안 풀면 3~5막이 스크린리더에서 영구히 사라진다
  const shown = ACT_REGIONS[name];
  for (const sel of ['#grid', '#fusion', '#verdict']) {
    const el = $(sel);
    if (el) el.setAttribute('aria-hidden', sel === shown ? 'false' : 'true');
  }
  if (step) {
    $$('.act-step').forEach((el) => {
      const n = Number(el.dataset.step);
      el.classList.toggle('now', n === step);
      el.classList.toggle('done', n < step);
    });
  }
}

const status = (t) => { $('#ring-status').textContent = t; };
const mode = (t) => { $('#hud-mode').textContent = t; };

/* ── 영상 패널 ───────────────────────────────────────── */

function buildPanels(picks) {
  const grid = $('#grid');
  grid.innerHTML = '';
  picks.forEach((c, i) => {
    const el = document.createElement('article');
    el.className = 'panel';
    el.dataset.q = String(i);
    el.innerHTML = `
      <div class="panel-media">
        <span class="media-badge"><b></b> CAM ${esc(c.idx)} · ${esc(c.visual.camera_view)}</span>
        <video playsinline preload="auto" src="../references/${esc(encodeURIComponent(c.file))}"></video>
        <div class="panel-prog"></div>
      </div>
      <div class="panel-copy">
        <div class="copy-meta">
          <span class="chip hot">${esc(c.visual.room)}</span>
          <span class="chip">${esc(c.sound.texture)}</span>
          <span class="chip">위협도 ${esc(c.semantics.threat)}</span>
        </div>
        <h3 class="copy-title">${esc(c.title_ko)}</h3>
        <p class="copy-sound">${esc(c.sound.onomatopoeia)} — ${esc(c.sound.cue_line)}</p>
        <p class="copy-desc"><span class="t"></span></p>
      </div>`;
    grid.appendChild(el);
    c._panel = el;
    c._video = el.querySelector('video');
    c._desc = el.querySelector('.copy-desc .t');
    c._prog = el.querySelector('.panel-prog');
    c._video.volume = 1;      // 실제 음량은 Web Audio 게인으로 제어한다
  });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function preload(picks, my) {
  status('감지 준비');
  await Promise.all(picks.map((c) => new Promise((res) => {
    const v = c._video;
    if (v.readyState >= 2) return res();
    const done = () => { v.removeEventListener('loadeddata', done); res(); };
    v.addEventListener('loadeddata', done);
    setTimeout(done, 4000);   // 네트워크가 느려도 데모가 멈추진 않게
  })));
  guard(my);
  picks.forEach((c) => bus.attach(c._video));
}

/* ── 1막: 청취 ───────────────────────────────────────── */

/**
 * 큐 카드 = 하나의 소리를 들은 하나의 장치가 보고한 내용.
 * 네 소리가 동시에 울리므로 카드도 각자의 노드 이름을 달고 거의 함께 뜬다.
 */
function buildCues(picks) {
  const wrap = $('#cues');
  picks.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'cue';
    el.dataset.q = String(i);
    const bars = [1, 2, 3].map((n) => `<i class="${c.sound.loudness >= n * 3 ? 'on' : ''}"></i>`).join('');
    const dist = { near: '가까움', mid: '중간', far: '멀리' }[c.sound.distance] || '—';
    // 1막은 화면을 완전히 가린 채 소리만 들려주는 구간이다.
    // 여기에 공간 이름(visual.room)을 띄우면 "귀로만 알 수 있는 정보" 규칙이 깨지고,
    // 2막의 "아, 저거였구나"가 미리 소진된다. 노드 번호와 시각만 남긴다.
    el.innerHTML = `
      <div class="cue-top">
        <span class="t">NODE ${esc(c.idx)}</span>
        <span class="spacer"></span>
        <span class="cue-time">—</span>
      </div>
      <div class="cue-onom">${esc(c.sound.onomatopoeia)}</div>
      <div class="cue-line">${esc(c.sound.cue_line)}</div>
      <div class="cue-foot">
        <span class="cue-tex">${esc(c.sound.texture)}</span>
        <span class="cue-dist">${dist}</span>
        <span class="meter">${bars}</span>
      </div>`;
    wrap.appendChild(el);
    c._cue = el;
  });
}

/** 큐 카드를 링 바깥 사분면에 놓는다. 이 자리가 곧 3막 그리드의 자리다. */
function placeCue(el, i) {
  const g = ring.geometry();
  const sx = i % 2 === 0 ? -1 : 1;
  const sy = i < 2 ? -1 : 1;
  const w = el.offsetWidth || 250;
  const x = g.cx + sx * (g.r * 1.55 + w * 0.5 + 46);
  const y = g.cy + sy * (g.r * 1.05 + 34);
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

function drawConnector(c, i) {
  const svg = $('#connectors');
  const g = ring.geometry();
  const r = c._cue.getBoundingClientRect();
  const sx = i % 2 === 0 ? -1 : 1;
  const ex = sx < 0 ? r.right : r.left;      // 카드의 링 쪽 모서리
  const ey = r.top + r.height / 2;
  const ang = Math.atan2(ey - g.cy, ex - g.cx);
  const bx = g.cx + Math.cos(ang) * (g.r * 1.42);
  const by = g.cy + Math.sin(ang) * (g.r * 1.42);

  const ns = 'http://www.w3.org/2000/svg';
  const line = document.createElementNS(ns, 'line');
  line.setAttribute('x1', bx); line.setAttribute('y1', by);
  line.setAttribute('x2', ex + sx * -6); line.setAttribute('y2', ey);
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', bx); dot.setAttribute('cy', by); dot.setAttribute('r', 2);
  svg.append(line, dot);
}

/**
 * 네 소리를 한 장면으로 동시에 들려준다.
 * 각 장치는 같은 순간을 저마다 다르게 듣고, 카드로 자기가 들은 것만 보고한다.
 */
async function act1(picks, my) {
  setAct('listen', 1);
  mode('MULTI-NODE ACOUSTIC CAPTURE');
  status('동시 청취');
  $('#connectors').classList.add('on');

  const t0 = performance.now();
  const timers = [];
  let detected = 0;

  picks.forEach((c, i) => {
    const v = c._video;
    const delay = i * CFG.listenStagger;

    timers.push(setTimeout(() => {
      if (my !== session) return;
      v.currentTime = c.focus[0];
      v.play().catch(() => { /* 시작 제스처로 자동재생은 이미 해제됨 */ });
      bus.ramp(v, (c.gain || 1) * CFG.mixLevel, CFG.fadeIn);
    }, delay));

    // 그 장치가 실제로 소리를 들은 순간에 맞춰 카드가 올라온다
    const cueAt = delay + Math.max(150, (c.onset - c.focus[0]) * 1000);
    timers.push(setTimeout(() => {
      if (my !== session) return;
      placeCue(c._cue, i);
      c._cue.querySelector('.cue-time').textContent =
        '+' + ((performance.now() - t0) / 1000).toFixed(1) + 's';
      c._cue.classList.add('show');
      drawConnector(c, i);
      detected += 1;
      const o = $('#onomatopoeia');
      o.textContent = `${detected}개 지점 감지`;
      o.classList.add('show');
    }, cueAt));
  });

  await wait((picks.length - 1) * CFG.listenStagger + CFG.focusMs + CFG.listenTail);
  timers.forEach(clearTimeout);
  guard(my);

  picks.forEach((c) => bus.ramp(c._video, 0, CFG.fadeOut));
  $('#onomatopoeia').classList.remove('show');
  await wait(CFG.fadeOut * 1000 + 80);
  picks.forEach((c) => c._video.pause());
}

/* ── 2막: 전개 ───────────────────────────────────────── */

async function act2(my) {
  guard(my);
  setAct('unfold', 2);
  status('영상 확인');
  mode('VISUAL CONFIRMATION');

  $('#connectors').classList.remove('on');
  $$('.cue').forEach((el) => { el.classList.remove('show'); });

  ring.kick(3.1);
  await wait(420);
  guard(my);

  // 링은 뒤로 물러나 배경의 존재감만 남긴다.
  // 여기가 가장 작다 — 이후로는 정보를 삼키며 커지기만 한다.
  ring.setScale(CFG.ringGrid);
  ring.setOpacity(0.1);

  setAct('grid', 2);
  $('#grid').classList.add('on');
  $$('.panel').forEach((el, i) => setTimeout(() => el.classList.add('in'), i * 90));
  await wait(900);
}

/* ── 3막: 확인 ───────────────────────────────────────── */

/**
 * 1막에서 한꺼번에 들은 것을 여기서는 하나씩 짚는다.
 * 네 영상은 계속 같이 돌아가되 초점이 옮겨갈 때마다 그 소리가 앞으로 나오고
 * 그 장면의 설명이 쓰인다 — 각각이 무슨 상황이었는지 먼저 또렷해져야
 * 4막에서 합쳐질 때 합쳐졌다는 감각이 생긴다.
 */
async function act3(picks, my) {
  guard(my);

  picks.forEach((c) => {
    c._video.currentTime = 0;
    c._video.loop = true;
    c._video.play().catch(() => {});
    bus.ramp(c._video, (c.gain || 1) * CFG.duckLevel, 0.6);
  });
  trackProgress(picks, my);

  for (let i = 0; i < picks.length; i++) {
    guard(my);
    picks.forEach((c, j) => {
      c._panel.classList.toggle('active', j === i);
      c._panel.classList.toggle('idle', j !== i);
      bus.ramp(c._video, (c.gain || 1) * (j === i ? CFG.mixLevel * 1.5 : CFG.duckLevel), 0.42);
    });
    mode(`SOURCE ${picks[i].idx} · ${picks[i].visual.room}`);
    await typeWords(picks[i]._desc, picks[i].visual.description_ko, my);
    await wait(Math.max(600, CFG.gridFocus - CFG.typeBudget));
  }

  guard(my);
  // 넷을 다 짚고 나서의 정적. 이 침묵이 있어야 다음 장면이 결론처럼 읽힌다.
  picks.forEach((c) => {
    c._panel.classList.remove('active', 'idle');
    bus.ramp(c._video, (c.gain || 1) * CFG.duckLevel, 0.5);
  });
  mode('ACOUSTIC SCENE ANALYSIS');
  await wait(CFG.gridHold);
}

/** 패널 하단의 재생 진행 바. 지금 어느 소리가 울리는지 눈으로도 보이게 한다. */
function trackProgress(picks, my) {
  const loop = () => {
    if (my !== session) return;
    picks.forEach((c) => {
      const v = c._video;
      if (v.duration) c._prog.style.width = `${(v.currentTime / v.duration) * 100}%`;
    });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/**
 * 어절 단위로 밀어 넣는다. 글자 단위는 한국어에서 너무 느려 지루해지고,
 * 총 시간을 예산 안에 묶어야 4개 패널이 리듬을 유지한다.
 */
async function typeWords(el, text, my) {
  const parts = text.split(/(\s+)/).filter(Boolean);
  const step = Math.max(16, Math.min(70, CFG.typeBudget / parts.length));
  el.textContent = '';
  el.parentElement.classList.add('typing');
  for (const p of parts) {
    guard(my);
    el.textContent += p;
    await wait(step);
  }
  el.parentElement.classList.remove('typing');
}

/* ── 4막: 통합 ───────────────────────────────────────── */

/**
 * 4막 — 네 개의 인식이 하나가 되는 구간.
 *
 *   A 유휴   영상도 설명도 그대로 둔다. 넷을 눈으로 훑는 시간.
 *   B 정지   그다음에야 프레임이 얼고 채도가 빠지며 설명이 물러난다.
 *   C 연결   링이 자리를 지킨 채 밝아지며 네 장면으로 곡선을 뻗는다.
 *   D 수렴   네 패널이 그 곡선을 타고 삼켜진다. 삼킬 때마다 그 방향에서 파형이
 *            부풀고 링이 한 단씩 커진다 — 링은 한 번도 줄지 않는다.
 *   E 인지   가장 커진 파형링이 3~4초간 통합 인지를 수행한다.
 *   F 발화   결론을 내뱉듯 링이 한 번 터지고 통합 서술이 나온다.
 */
async function act4(picks, result, my) {
  guard(my);
  setAct('fuse', 3);
  status('상황 통합');
  mode('SITUATION FUSION');

  // ── A. 유휴: 아직 아무것도 건드리지 않는다. 넷을 다 볼 시간을 준다.
  await wait(CFG.fuseIdle);
  guard(my);

  // ── B. 정지: 이제야 얼어붙는다
  picks.forEach((c) => bus.ramp(c._video, 0, 0.9));
  await wait(420);
  guard(my);
  picks.forEach((c) => {
    c._video.pause();
    c._panel.classList.add('frozen');
  });
  buildStrip(picks);                 // 얼어붙은 그 프레임을 증거로 붙잡아 둔다
  await wait(CFG.fuseFreeze);
  guard(my);

  // ── C. 연결: 링은 크기를 그대로 두고 밝아지기만 한다
  ring.follow = 0.09;
  ring.setOpacity(0.42);
  drawConvergence(picks);
  await wait(CFG.fuseLink);
  guard(my);

  // ── D. 수렴: 삼킬 때마다 그 방향에서 파형이 솟고 링이 한 단씩 자란다
  const g = ring.geometry();
  const angles = picks.map((c) => {
    const r = c._panel.getBoundingClientRect();
    return Math.atan2(r.top + r.height / 2 - g.cy, r.left + r.width / 2 - g.cx);
  });

  flyPanels(picks);
  retractLinks(picks);
  const swallow = [];
  picks.forEach((_, i) => {
    const target = CFG.ringGrid + (i + 1) * CFG.ringStep;
    swallow.push(setTimeout(() => {
      if (my !== session) return;
      ring.inject(angles[i], 0.95);        // 영상이 들어온 방향에서 파형이 솟는다
      ring.pulse(0.5);
      ring.kick(0.8);
      ring.setOpacity(0.42 + (i + 1) * 0.05);
      // 목표를 살짝 넘겼다 되돌려야 단계마다 부풀어 오르는 탄성이 생긴다.
      // 같은 간격으로 곧장 키우면 기계적으로 늘어나는 것처럼 보인다.
      ring.setScale(target + CFG.ringOvershoot);
      setTimeout(() => { if (my === session) ring.setScale(target); }, 260);
    }, FLY_STEP * i + CFG.fuseFlight * 0.78));
  });
  // 곡선이 다 걷히기 직전에 레이어째 페이드아웃 — 혹시 남는 획이 있어도 흔적이 없다
  const flightSpan = FLY_STEP * (picks.length - 1) + CFG.fuseFlight;
  const sweep = setTimeout(() => {
    if (my === session) $('#connectors').classList.remove('on');
  }, flightSpan * 0.82);

  // 마지막 패널이 링에 닿을 때까지 기다린다. 여기서 끊으면 넷째가 허공에서 잘린다.
  await wait(flightSpan + 320);
  clearTimeout(sweep);
  swallow.forEach(clearTimeout);
  guard(my);

  const svg = $('#connectors');
  svg.classList.remove('on', 'converge');
  svg.innerHTML = '';                 // 트랜지션에 기대지 않고 확실히 치운다
  picks.forEach((c) => { c._link = null; });
  $('#grid').classList.remove('on');
  resetPanels(picks);

  // ── E. 인지: 소리는 없고 연산만 있는 구간.
  //    파형을 오디오인 척 흔들면 거짓말이 되므로, 확연히 다른 결의 진행파로 돌린다.
  setAct('perceive', 3);
  status('통합 인지 중');
  mode('FORMING SINGLE PERCEPTION');
  ring.setThinking(true);
  ring.setDensity(0.30);          // 억양이 얹힐 저차 바탕. 0 이면 얹을 결이 없다
  ring.setOpacity(0.74);
  // 네 영상이 들어온 그 각도에 목소리를 세운다 — D 의 inject 가 찍은 융기가
  // 릴리즈로 사라지는 자리를 그대로 이어받는다.
  // 소리만이 아니라 그 클립의 프레임 변화율도 함께 넣는다 —
  // 고정 CCTV 구역은 잔잔하고 사건이 터진 구역은 결이 요동친다.
  ring.setVoices(angles.map((a, i) => ({
    angle: a,
    threat: picks[i].semantics.threat,
    motion: picks[i].motion,
  })), CFG.fusePerceive / 1000);
  ring.setFusion(0);
  const fuseT0 = performance.now();
  const fuseTick = setInterval(() => {
    if (my !== session) { clearInterval(fuseTick); return; }
    // 목표를 구간의 86% 지점에 1 로 세팅해야(fusion 은 0.055 lerp) 3.6초 안에
    // 억양 봉투가 정확히 0 으로 닫힌다. 100% 지점을 목표로 잡으면 잔재가 남는다.
    ring.setFusion(Math.min(1, (performance.now() - fuseT0) / (CFG.fusePerceive * 0.86)));
  }, 60);
  await wait(CFG.fusePerceive);
  clearInterval(fuseTick);
  guard(my);

  // ── F. 발화: 결론이 터져 나온다
  setAct('fuse', 3);
  // 인지 모드를 끄지 않는다. 여기서 유휴로 떨어뜨리면 결론을 읽는 5초 내내
  // 링이 거의 정지해 결과가 빛바랜 정지화면처럼 보인다.
  // 목소리만 놓아주면(융합 완료) 하나로 합쳐진 파형이 잔잔하게 계속 돈다.
  ring.setFusion(-1);
  ring.setDensity(0.18);
  ring.pulse(1);
  ring.kick(1.7);
  ring.setScale(CFG.ringGrid + picks.length * CFG.ringStep + 0.34);
  ring.setOpacity(0.38);

  // 판단색을 절반쯤 미리 입힌다. 통합 상황은 이미 심각도를 품고 있는데
  // 끝까지 청취색으로 두면 결론이 흑백 캡션처럼 보인다.
  // 나머지 절반은 '판단 완료' 순간에 마저 간다 — 색의 도착이 두 번에 나뉜다.
  const half = mixTint(result.tone, 0.5);
  stage.style.setProperty('--accent', `hsl(${half.h.toFixed(1)} ${half.s.toFixed(1)}% ${half.l.toFixed(1)}%)`);
  ring.setTint(half.h, half.s, half.l);
  ring.follow = 0.08;
  await wait(CFG.fuseUtter);
  guard(my);

  $('#fusion').classList.add('on');
  $$('.fusion-thumb').forEach((el, i) => setTimeout(() => el.classList.add('in'), i * 95));
  await wait(560);
  guard(my);

  $('#fusion-name').textContent = result.name;
  await wait(480);
  await revealWords($('#fusion-narrative'), result.narrative, my);

  // 읽을 시간. 여기서 서두르면 통합 서술이 스쳐 지나간다.
  await wait(CFG.fusionHold);
}

const NS = 'http://www.w3.org/2000/svg';

/**
 * 네 장면을 링 중심으로 잇는다.
 *
 * 직선 네 개는 화면에 X자를 박아 넣어 뻣뻣하고, 무엇보다 "선"으로만 남는다.
 * 그래서 한쪽으로 일정하게 휘는 곡선으로 긋고, 중심에서 밝고 바깥으로 갈수록
 * 사라지는 그라디언트를 입혀 신호가 중심으로 빨려드는 흐름처럼 보이게 한다.
 * 곡선 위로는 짧은 파선이 계속 중심을 향해 흘러간다.
 *
 * 경로는 반드시 중심 → 패널 방향으로 그린다. 그래야 dashoffset 을 양수 구간에서만
 * 움직여 "중심에서 뻗어 나갔다가 중심으로 걷히는" 두 동작을 모두 만들 수 있다.
 * (Chrome 은 음수 stroke-dashoffset 을 0 으로 잘라내므로 반대 방향으로는 못 걷는다.)
 */
function drawConvergence(picks) {
  const svg = $('#connectors');
  svg.innerHTML = '';
  const g = ring.geometry();

  const defs = document.createElementNS(NS, 'defs');
  const grad = document.createElementNS(NS, 'radialGradient');
  grad.setAttribute('id', 'convGrad');
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  grad.setAttribute('cx', g.cx);
  grad.setAttribute('cy', g.cy);
  grad.setAttribute('r', Math.max(window.innerWidth, window.innerHeight) * 0.55);
  [['0', 0.9], ['0.4', 0.45], ['1', 0]].forEach(([offset, alpha]) => {
    const s = document.createElementNS(NS, 'stop');
    s.setAttribute('offset', offset);
    s.style.stopColor = 'var(--accent)';
    s.style.stopOpacity = String(alpha);
    grad.appendChild(s);
  });
  defs.appendChild(grad);
  svg.appendChild(defs);

  picks.forEach((c, i) => {
    const r = c._panel.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;

    // 네 곡선이 같은 방향으로 휘어야 X자가 아니라 하나의 소용돌이로 읽힌다
    const dx = g.cx - x;
    const dy = g.cy - y;
    const dist = Math.hypot(dx, dy) || 1;
    const bow = 0.17;
    const cpx = (x + g.cx) / 2 + (-dy / dist) * dist * bow;
    const cpy = (y + g.cy) / 2 + (dx / dist) * dist * bow;
    const d = `M ${g.cx} ${g.cy} Q ${cpx} ${cpy} ${x} ${y}`;

    const main = document.createElementNS(NS, 'path');
    main.setAttribute('d', d);
    main.setAttribute('class', 'link');
    svg.appendChild(main);
    const len = main.getTotalLength();
    main.style.strokeDasharray = String(len);
    main.style.strokeDashoffset = String(len);   // 중심에서 바깥으로 자라난다
    main.style.transition = `stroke-dashoffset 700ms linear ${i * 95}ms`;

    const flow = document.createElementNS(NS, 'path');
    flow.setAttribute('d', d);
    flow.setAttribute('class', 'flow');
    flow.style.opacity = '0';
    flow.style.transition = `opacity 520ms var(--ease-out) ${i * 95 + 520}ms`;
    svg.appendChild(flow);

    c._link = { main, flow, len };
    setTimeout(() => {
      main.style.strokeDashoffset = '0';
      flow.style.opacity = '1';
    }, 25);
  });
  svg.classList.add('on', 'converge');
}

/**
 * 패널이 출발할 때 그 패널의 곡선도 함께 중심으로 걷힌다.
 * 이게 없으면 이미지가 날아간 뒤에도 선만 X자로 남는다.
 */
function retractLinks(picks) {
  picks.forEach((c, i) => {
    if (!c._link) return;
    const { main, flow, len } = c._link;
    const delay = i * FLY_STEP;
    main.style.transition =
      `stroke-dashoffset ${CFG.fuseFlight}ms cubic-bezier(0.62, 0, 0.2, 1) ${delay}ms`;
    main.style.strokeDashoffset = String(len);   // 패널 쪽 끝부터 중심으로 걷힌다
    flow.style.transition = `opacity 420ms var(--ease-soft) ${delay}ms`;
    flow.style.opacity = '0';
  });
}

/** 패널이 하나씩 출발하는 간격. 비행 시간 계산과 CSS 지연이 같은 값을 써야 한다. */
const FLY_STEP = 210;

/** 패널을 격자에서 떼어내 링 중심으로 날려 보낸다(FLIP). */
function flyPanels(picks) {
  const g = ring.geometry();
  const rects = picks.map((c) => c._panel.getBoundingClientRect());

  picks.forEach((c, i) => {
    const el = c._panel;
    const r = rects[i];
    el.style.position = 'fixed';
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
    el.style.margin = '0';
    el.classList.add('flying');
  });

  // 레이아웃이 확정된 다음 프레임에 목표 변환을 건다.
  // rAF는 백그라운드 탭에서 멎으므로 타이머를 쓴다.
  setTimeout(() => {
    picks.forEach((c, i) => {
      const r = rects[i];
      const dx = g.cx - (r.left + r.width / 2);
      const dy = g.cy - (r.top + r.height / 2);
      const spin = (i % 2 === 0 ? -1 : 1) * (4 + i);
      const el = c._panel;
      el.style.transitionDelay = `${i * FLY_STEP}ms`;
      el.style.transform = `translate(${dx}px, ${dy}px) scale(0.08) rotate(${spin}deg)`;
      el.style.opacity = '0';
      el.style.filter = 'blur(6px)';
    });
  }, 30);
}

function resetPanels(picks) {
  picks.forEach((c) => {
    const el = c._panel;
    el.classList.remove('flying', 'frozen');
    // 인라인 스타일을 그냥 비우면 안 된다. 비행이 끝난 패널은 opacity 0 에
    // position:fixed 로 링 한가운데 접혀 있는데, 스타일을 지우는 순간 격자 자리로
    // 되돌아가며 불투명해진다. #grid 는 아직 400ms 페이드 중이라 그 사이에
    // 네 영상이 사방으로 튀어나왔다 사라지는 것처럼 보인다.
    // 다음 회차에 buildPanels 가 그리드를 통째로 다시 만드니 여기선 감추기만 한다.
    el.style.cssText = 'display:none';
  });
}

/** 3막에서 본 마지막 장면을 그대로 캡처해 상단 스트립으로 올린다. */
function buildStrip(picks) {
  const strip = $('#fusion-strip');
  strip.innerHTML = '';
  picks.forEach((c) => {
    const el = document.createElement('figure');
    el.className = 'fusion-thumb';
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 180;
    const v = c._video;
    try {
      if (v.videoWidth) cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
    } catch { /* 캡처 실패해도 자리는 유지한다 */ }
    const cap = document.createElement('span');
    cap.textContent = c.title_ko;
    el.append(cv, cap);
    strip.appendChild(el);
  });
}

/**
 * 4막은 타이핑이 아니라 어절 페이드다.
 * 3막에서 이미 타이핑을 썼고, 여기서는 "입력받는 중"이 아니라
 * "이미 이해한 것을 말하는 중"이라 질감이 달라야 한다.
 */
async function revealWords(el, text, my) {
  el.innerHTML = '';
  const words = text.split(' ');
  const spans = words.map((w) => {
    const s = document.createElement('span');
    s.textContent = w + ' ';
    s.style.cssText = 'opacity:0;filter:blur(3px);transition:opacity 380ms var(--ease-out),filter 380ms var(--ease-out)';
    el.appendChild(s);
    return s;
  });
  for (const s of spans) {
    guard(my);
    s.style.opacity = '1';
    s.style.filter = 'blur(0)';
    await wait(Math.max(22, Math.min(60, 1600 / spans.length)));
  }
}

/* ── 5막: 판단 ───────────────────────────────────────── */

/**
 * 통합 서술과 증거를 링으로 되돌려 보낸다.
 * 판단은 화면에 남은 글을 읽고 내리는 게 아니라, 링이 삼킨 것으로 내리는 것이다.
 */
function meltFusion(my) {
  const g = ring.geometry();
  const melt = (el, i, step, scale) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const dx = g.cx - (r.left + r.width / 2);
    const dy = g.cy - (r.top + r.height / 2);
    const delay = i * step;
    el.style.transition =
      `transform ${CFG.meltMs - 300}ms cubic-bezier(0.62, 0, 0.2, 1) ${delay}ms,` +
      `opacity ${CFG.meltMs - 600}ms ease-in ${delay}ms,` +
      `filter ${CFG.meltMs - 600}ms ease-in ${delay}ms`;
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    el.style.opacity = '0';
    el.style.filter = 'blur(5px)';
  };

  const thumbs = $$('.fusion-thumb');
  const thumbAngles = [];
  thumbs.forEach((el, i) => {
    melt(el, i, 100, 0.14);
    // 증거가 링에 닿는 순간 그 방향에서 파형이 다시 솟고, 그쪽 목소리의 위상이 걷어차인다
    const r = el.getBoundingClientRect();
    const angle = Math.atan2(r.top + r.height / 2 - g.cy, r.left + r.width / 2 - g.cx);
    thumbAngles.push(angle);
    setTimeout(() => {
      if (my !== session) return;
      ring.inject(angle, 0.6, 22);
      ring.pulse(0.3);
    }, i * 100 + CFG.meltMs * 0.66);
  });

  melt($('#fusion-name'), 0, 0, 0.5);
  [...$('#fusion-narrative').children].forEach((s, i) => melt(s, i, 16, 0.55));
  return thumbAngles;   // 인덱스가 picks 와 정렬된다
}

async function act5(picks, result, my) {
  guard(my);

  // ── 녹아듦: 통합 상황이 링으로 되돌아간다
  setAct('perceive', 4);
  status('위험도 분석');
  mode('RISK ANALYSIS');
  ring.setOpacity(0.5);
  ring.setThinking(true);
  ring.setDensity(0.05);
  const backAngles = meltFusion(my);
  // 증거 넷이 되돌아오며 목소리가 다시 갈라진다.
  // 0.22 는 '이미 한 번 합의해 본' 상태 — 처음부터 다시 시작하지 않는다.
  ring.setVoices(backAngles.map((a, i) => ({
    angle: a,
    threat: picks[i].semantics.threat,
    motion: picks[i].motion,
  })), (CFG.meltMs + CFG.analyzeMs) / 1000);
  ring.setFusion(0.22);
  await wait(CFG.meltMs);
  guard(my);

  $('#fusion').classList.remove('on');
  $('#fusion-strip').innerHTML = '';
  $('#fusion-narrative').innerHTML = '';
  $('#fusion-name').style.cssText = '';
  $('#fusion-name').textContent = '';

  // ── 분석: 파형이 한 바퀴에 걸쳐 여물어 간다.
  //    전역 밀도는 고정하고 진행은 스윕이 전담한다 — 둘이 함께 움직이면
  //    "차는 건가 촘촘해지는 건가"로 읽기가 흐려진다.
  ring.setOpacity(0.78);
  ring.setDensity(1);
  const t0 = performance.now();
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (my !== session) { clearInterval(tick); resolve(); return; }
      const p = Math.min(1, (performance.now() - t0) / CFG.analyzeMs);
      ring.setProgress(p);
      // 융합은 진행률 65% 에서 먼저 목표에 닿는다. 마지막 구간은 스윕만 남아
      // 두 뜻이 같은 순간에 절정을 다투지 않는다 —
      // "무엇인지 합의한 뒤 얼마나 위험한지 확정"의 순서가 생긴다.
      ring.setFusion(0.22 + 0.78 * Math.min(1, p / 0.65));
      $('#ring-status').textContent = `위험도 분석 ${Math.round(p * 100)}%`;
      if (p >= 1) { clearInterval(tick); resolve(); }
    }, 60);
  });
  guard(my);

  // ── 확정: 판단이 잠기며 색이 바뀐다
  // 나머지 절반. 인라인 override 를 걷어내야 data-tone 규칙이 다시 살아난다.
  stage.style.removeProperty('--accent');
  stage.dataset.tone = result.tone;
  const tint = TONE_TINT[result.tone];
  if (tint) ring.setTint(tint.h, tint.s, tint.l);
  $('#ring-status').textContent = '판단 완료';
  ring.setFusion(-1);
  ring.pulse(1);
  ring.kick(2.0);
  ring.setDensity(0.12);
  await wait(CFG.lockMs);
  guard(my);

  // 판단이 끝나도 링은 계속 낮게 돈다 — 배경까지 멈추면 판단 화면이 정지컷이 된다
  ring.setProgress(-1);
  ring.setDensity(0.12);
  ring.setScale(2.3);
  ring.setOpacity(0.2);

  setAct('verdict', 4);
  status('판단');
  mode('INTERVENTION DECISION');

  $('#verdict-label').textContent = result.label;
  $('#verdict-scenario').textContent = result.name;
  $('#verdict').classList.add('on');

  // 게이지와 숫자는 같은 시간 동안 함께 움직여야 하나의 동작으로 읽힌다
  const C = 2 * Math.PI * 52;
  $('#gauge-value').style.strokeDashoffset = String(C * (1 - result.score / 100));
  countUp($('#gauge-score'), result.score, 1500, my);
  countUp($('#verdict-confidence'), result.confidence, 1200, my);

  fillList($('#verdict-reasons'), result.reasons);
  $('#actions-title').textContent = result.decision === 'standby' ? '기록' : '조치';
  fillList($('#verdict-actions'), result.actions);

  await wait(900);
  guard(my);
  $$('#verdict-reasons li').forEach((li, i) => setTimeout(() => li.classList.add('in'), i * 90));
  await wait(300 + result.reasons.length * 90);
  guard(my);
  $$('#verdict-actions li').forEach((li, i) => setTimeout(() => li.classList.add('in'), i * 90));

  await wait(900);
  guard(my);
  const btn = $('#replay');
  btn.hidden = false;
  // rAF는 탭이 백그라운드일 때 멎는다. 다시 보기 버튼은 그래도 나타나야 한다.
  setTimeout(() => { if (my === session) btn.classList.add('on'); }, 30);
}

function fillList(ul, items) {
  ul.innerHTML = '';
  (items || []).forEach((text) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="mark"></span><span>${esc(text)}</span>`;
    ul.appendChild(li);
  });
}

function countUp(el, target, ms, my) {
  const t0 = performance.now();
  const step = (now) => {
    if (my !== session) return;
    const p = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(target * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // 탭이 백그라운드면 rAF가 멎어 숫자가 0에 멈춘다. 최종값은 반드시 찍히게 한다.
  setTimeout(() => { if (my === session) el.textContent = String(target); }, ms + 250);
}

boot();
