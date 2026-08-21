/**
 * Home AI — 영상 관리
 *
 * 브라우저에서 mp4 를 올리고, 인제스트를 돌리고, 주석을 채운다.
 * 측정값(길이·온셋·게인·움직임)은 인제스트가 정하므로 여기서는 읽기 전용이고,
 * 기계가 못 정하는 것 — 무슨 사건인지, 얼마나 위험한지, 어떻게 들리는지 — 만 편집한다.
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/** 융합 규칙엔진이 실제로 매칭에 쓰는 값들. 여기서 벗어나면 시나리오가 안 걸린다. */
const EVENT_TYPES = [
  'unknown', 'glass_break', 'forced_entry', 'alarm_fire', 'theft', 'impact_fall',
  'door_slam', 'footsteps', 'appliance', 'door_unlock', 'infant_distress',
  'pet_vocal', 'pet_activity',
];
const TAGS = [
  'intrusion', 'breakage', 'fire', 'medical', 'infant', 'pet',
  'resident_activity', 'entry_point', 'appliance', 'noise',
];
const DISTANCES = [['near', '가까움'], ['mid', '중간'], ['far', '멀리']];
const TIMES = [['unknown', '알 수 없음'], ['day', '낮'], ['night', '밤']];
const URGENCY = ['none', 'low', 'medium', 'high', 'critical'];

let clips = [];
let dirty = false;

/* ── 공통 ────────────────────────────────────────────────── */

function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, bad ? 5200 : 2600);
}

function markDirty() {
  dirty = true;
  $('#save').disabled = false;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── 목록 렌더 ───────────────────────────────────────────── */

function stats() {
  const total = clips.length;
  const audible = clips.filter((c) => c.audible !== false).length;
  const todo = clips.filter((c) => c.annotated === false).length;
  $('#stat').textContent =
    `전체 ${total} · 뽑기 가능 ${audible}` + (todo ? ` · 주석 필요 ${todo}` : '');
  $('#empty').hidden = total > 0;
}

function opts(list, cur) {
  return list.map((o) => {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

function clipCard(c, i) {
  const s = c.sound || {};
  const v = c.visual || {};
  const m = c.semantics || {};
  const todo = c.annotated === false;
  const mute = c.audible === false;
  // 온셋 지점에서 멈춰 있는 프레임을 썸네일로 쓴다 — 그 클립의 사건 순간이다
  const poster = `/references/${encodeURIComponent(c.file)}#t=${(c.onset || 0).toFixed(2)}`;

  return `
  <article class="clip${todo ? ' todo' : ''}${mute ? ' mute' : ''}" data-i="${i}">
    <div class="clip-media">
      <video src="${poster}" preload="metadata" muted playsinline controls></video>
      <div class="badges">
        <span class="badge">${(c.duration ?? 0).toFixed(1)}s</span>
        <span class="badge">온셋 ${(c.onset ?? 0).toFixed(1)}s</span>
        <span class="badge">게인 x${(c.gain ?? 1).toFixed(2)}</span>
        <span class="badge">${(c.peak_db ?? 0).toFixed(0)}dB</span>
        <span class="badge">움직임 ${(c.motion_avg ?? 0).toFixed(2)}</span>
        <span class="badge ${mute ? 'bad' : 'on'}">${mute ? '무음 · 제외됨' : '가청'}</span>
        ${todo ? '<span class="badge warn">주석 필요</span>' : ''}
      </div>
    </div>

    <div class="clip-body">
      <div class="clip-head">
        <span class="clip-file">${esc(c.file)}</span>
        <button class="btn danger" data-del="${i}">삭제</button>
      </div>

      <div class="fields">
        <div class="f"><label>이름</label>
          <input data-p="title_ko" value="${esc(c.title_ko)}" placeholder="유리 파손" /></div>
        <div class="f"><label>의성어</label>
          <input data-p="sound.onomatopoeia" value="${esc(s.onomatopoeia)}" placeholder="쨍그랑" /></div>
        <div class="f"><label>음향 질감</label>
          <input data-p="sound.texture" value="${esc(s.texture)}" placeholder="짧고 날카로운 파열음" /></div>
        <div class="f"><label>거리감</label>
          <select data-p="sound.distance">${opts(DISTANCES, s.distance)}</select></div>
        <div class="f"><label>체감 음량 1~10</label>
          <input type="number" min="1" max="10" data-p="sound.loudness" value="${s.loudness ?? 5}" /></div>

        <div class="f wide"><label>소리 설명 — 귀로만 알 수 있는 것 (1막 큐)</label>
          <textarea data-p="sound.cue_line"
            placeholder="높고 날카로운 파열음 한 번, 곧이어 잔 조각들이 흩어진다">${esc(s.cue_line)}</textarea></div>

        <div class="f wide"><label>장면 설명 — 영상에서 확인되는 것 (3막)</label>
          <textarea data-p="visual.description_ko"
            placeholder="고정 카메라에 벽면 선반이 무너지며 병들이 바닥에 쏟아진다">${esc(v.description_ko)}</textarea></div>

        <div class="f"><label>공간</label>
          <input data-p="visual.room" value="${esc(v.room)}" placeholder="거실" /></div>
        <div class="f"><label>카메라 시점</label>
          <input data-p="visual.camera_view" value="${esc(v.camera_view)}" placeholder="천장 고정캠" /></div>
        <div class="f"><label>시간대</label>
          <select data-p="visual.time_of_day">${opts(TIMES, v.time_of_day)}</select></div>

        <div class="f"><label>사건 종류</label>
          <select data-p="semantics.event_type">${opts(EVENT_TYPES, m.event_type)}</select></div>
        <div class="f"><label>위협도 0~100</label>
          <input type="number" min="0" max="100" data-p="semantics.threat" value="${m.threat ?? 30}" /></div>
        <div class="f"><label>긴급도</label>
          <select data-p="semantics.urgency">${opts(URGENCY, m.urgency)}</select></div>

        <div class="f wide"><label>태그 — 쉼표로 구분 (${TAGS.join(', ')})</label>
          <input data-p="semantics.tags" value="${esc((m.tags || []).join(', '))}" placeholder="breakage, noise" /></div>

        <div class="f wide"><label>융합 메모 — 다른 소리와 겹쳤을 때 해석이 어떻게 달라지는지</label>
          <textarea data-p="semantics.fusion_note"
            placeholder="발소리와 함께면 거주자의 실수, 창틀 충격음 뒤라면 침입 동선">${esc(m.fusion_note)}</textarea></div>
      </div>
    </div>
  </article>`;
}

function render() {
  const onlyTodo = $('#only-todo').checked;
  const onlyMute = $('#only-mute').checked;
  const html = clips
    .map((c, i) => [c, i])
    .filter(([c]) => (!onlyTodo || c.annotated === false) && (!onlyMute || c.audible === false))
    .map(([c, i]) => clipCard(c, i))
    .join('');
  $('#list').innerHTML = html;
  stats();
}

/* ── 편집 ────────────────────────────────────────────────── */

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let k = 0; k < keys.length - 1; k++) {
    if (!cur[keys[k]] || typeof cur[keys[k]] !== 'object') cur[keys[k]] = {};
    cur = cur[keys[k]];
  }
  cur[keys[keys.length - 1]] = value;
}

$('#list').addEventListener('input', (e) => {
  const el = e.target;
  const p = el.dataset.p;
  if (!p) return;
  const card = el.closest('.clip');
  const c = clips[Number(card.dataset.i)];
  let val = el.value;
  if (el.type === 'number') val = Number(val) || 0;
  if (p === 'semantics.tags') {
    val = val.split(',').map((t) => t.trim()).filter(Boolean);
  }
  setPath(c, p, val);
  // 사람이 한 글자라도 손대면 자리표시자가 아니다
  if (c.annotated === false) delete c.annotated;
  el.closest('.f').classList.add('dirty');
  markDirty();
});

$('#list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (!del) return;
  const c = clips[Number(del.dataset.del)];
  if (!confirm(`${c.file} 을(를) 삭제한다. 파일도 함께 지워진다. 계속할까?`)) return;
  try {
    await api('/api/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: c.file }),
    });
    clips = clips.filter((x) => x !== c);
    await save(true);
    render();
    toast(`삭제됨 — ${c.file}`);
  } catch (err) {
    toast('삭제 실패: ' + err.message, true);
  }
});

$('#only-todo').addEventListener('change', render);
$('#only-mute').addEventListener('change', render);

/* ── 저장 ────────────────────────────────────────────────── */

async function save(quiet = false) {
  try {
    await api('/api/clips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clips),
    });
    dirty = false;
    $('#save').disabled = true;
    $$('.f.dirty').forEach((f) => f.classList.remove('dirty'));
    if (!quiet) toast(`저장됨 — ${clips.length}개`);
  } catch (err) {
    toast('저장 실패: ' + err.message, true);
  }
}
$('#save').addEventListener('click', () => save());

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ── 업로드 ──────────────────────────────────────────────── */

async function upload(files) {
  const list = [...files].filter((f) => /\.mp4$/i.test(f.name) || f.type === 'video/mp4');
  if (!list.length) return toast('mp4 파일만 올릴 수 있다', true);

  const logEl = $('#log');
  logEl.hidden = false;
  logEl.textContent = '';
  let ok = 0;
  for (const f of list) {
    logEl.textContent += `올리는 중 ${f.name} (${(f.size / 1048576).toFixed(1)} MB)\n`;
    try {
      const r = await api(`/api/upload?name=${encodeURIComponent(f.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f,
      });
      logEl.textContent += `  → ${r.file}\n`;
      ok++;
    } catch (err) {
      logEl.textContent += `  ! 실패: ${err.message}\n`;
    }
    logEl.scrollTop = logEl.scrollHeight;
  }
  if (ok) {
    logEl.textContent += `\n${ok}개 업로드 완료. 인제스트를 실행해야 목록에 등록된다.\n`;
    toast(`${ok}개 업로드됨 — 인제스트를 실행할 것`);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => upload(e.dataTransfer.files));
$('#browse').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => { upload(e.target.files); e.target.value = ''; });

/* ── 인제스트 ────────────────────────────────────────────── */

$('#ingest').addEventListener('click', async () => {
  if (dirty && !confirm('저장하지 않은 변경사항이 있다. 인제스트가 덮어쓸 수 있다. 계속할까?')) return;
  const btn = $('#ingest');
  const logEl = $('#log');
  btn.disabled = true;
  btn.textContent = '분석 중…';
  logEl.hidden = false;
  logEl.textContent = '인제스트 실행 중 — 클립 수에 따라 수십 초 걸린다.\n\n';
  try {
    const r = await api('/api/ingest', { method: 'POST' });
    logEl.textContent += r.log || '(출력 없음)';
    await load();
    toast('인제스트 완료');
  } catch (err) {
    logEl.textContent += '\n! 실패: ' + err.message;
    toast('인제스트 실패: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '인제스트 실행';
    logEl.scrollTop = logEl.scrollHeight;
  }
});

/* ── 시작 ────────────────────────────────────────────────── */

async function load() {
  try {
    clips = await api('/api/clips');
    dirty = false;
    $('#save').disabled = true;
    render();
  } catch (err) {
    toast('목록을 읽지 못했다: ' + err.message, true);
  }
}

load();
