/**
 * 의존성 없는 정적 개발 서버.
 *
 * npm install 없이 `npm run dev` 만으로 뜨는 게 목적이라 외부 패키지를 쓰지 않는다.
 * 두 가지가 이 데모에 특히 중요하다.
 *   - Range 요청: video.currentTime 으로 구간을 건너뛰려면 206 응답이 필요하다.
 *     (파이썬 http.server 는 Range 를 지원하지 않아 전체를 받아야만 탐색이 됐다)
 *   - no-store: 개발 중 JS/CSS 를 고쳐도 새로고침이 먹히게 한다.
 */

import { spawn } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 8777;
// 기본값은 모든 인터페이스. 같은 네트워크의 다른 기기에서도 열어 볼 수 있어야 한다.
// 이 기기에서만 보려면 HOST=localhost npm run dev
const HOST = process.env.HOST || '0.0.0.0';
const ENTRY = '/app/index.html';        // '/' 로 들어오면 여기로 보낸다.
                                        // 파일을 그대로 서빙하지 않고 리다이렉트하는 이유:
                                        // 루트에서 서빙하면 페이지의 상대 경로(./data/…)가
                                        // /app/ 이 아니라 / 기준으로 풀려 전부 404 가 된다.

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** URL 경로를 루트 밖으로 못 나가게 잠근 실제 파일 경로로 바꾼다. */
function toFilePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    // 잘못된 %-escape (예: "/%"). 던지게 두면 async 핸들러가 reject 되고
    // Node 기본값에서 프로세스가 통째로 죽는다 — 요청 한 번에 서버가 내려간다.
    return null;
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const full = join(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;   // 경로 탈출 차단
  return full;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body === undefined) res.end();
  else res.end(body);
}

/* ── 운영자 API ─────────────────────────────────────────────────────
   브라우저에서 영상을 넣고 주석을 고칠 수 있게 하는 최소한의 엔드포인트.
   쓰기가 가능한 경로는 references/ 의 .mp4 와 app/data/clips.json 둘뿐이고,
   파일명은 안전한 문자로 강제 변환한다. ADMIN=off 로 통째로 끌 수 있다. */

const ADMIN = process.env.ADMIN !== 'off';
const CLIPS_JSON = join(ROOT, 'app', 'data', 'clips.json');
const REFS_DIR = join(ROOT, 'references');
const MAX_UPLOAD = 400 * 1024 * 1024;   // 400MB

const json = (res, status, obj) =>
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    JSON.stringify(obj));

/** 업로드 파일명을 안전한 형태로 강제한다. 경로 요소는 전부 버린다. */
function safeName(raw) {
  const base = basename(String(raw || '')).replace(/\\/g, '/').split('/').pop();
  const stem = base.replace(/\.[^.]*$/, '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return (stem || 'clip') + '.mp4';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        // 즉시 destroy 하면 응답을 쓸 소켓까지 닫혀 413 이 전달되지 않는다.
        // 읽기만 멈추고 소켓은 살려 둔 채 거절 응답을 보낸다.
        req.pause();
        fail(new Error('too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', fail);
  });
}

/** 로컬 오리진만 허용한다. 브라우저가 붙여 주는 Origin 은 위조할 수 없다. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|(?:\d{1,3}\.){3}\d{1,3})(:\d+)?$/;

async function handleApi(req, res, url) {
  if (!ADMIN) return json(res, 403, { error: '운영자 API 가 꺼져 있다 (ADMIN=off)' });
  const path = url.pathname;

  // ── CSRF 방어.
  // 이게 없으면 npm run dev 가 떠 있는 동안 운영자가 아무 웹페이지나 열기만 해도
  // 그 페이지가 localhost 로 POST 를 쏴서 영상을 지우고 clips.json 을 덮어쓸 수 있다.
  // HOST=localhost 로 묶어도 막히지 않는다 — 요청이 운영자 자신의 브라우저에서 나가기 때문이다.
  // Content-Type 을 강제하면 브라우저가 preflight 를 띄우게 되어 simple-request 우회도 끊긴다.
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      return json(res, 403, { error: 'cross-origin 요청은 거부한다' });
    }
    const want = path === '/api/upload' ? 'application/octet-stream' : 'application/json';
    const ct = String(req.headers['content-type'] || '');
    if (path !== '/api/ingest' && !ct.startsWith(want)) {
      return json(res, 415, { error: `Content-Type 은 ${want} 이어야 한다` });
    }
    // 본문이 없는 /api/ingest 는 form 자동 제출로도 발화하므로 Origin 을 반드시 요구한다
    if (path === '/api/ingest' && !origin) {
      return json(res, 403, { error: 'Origin 헤더가 필요하다' });
    }
  }

  if (path === '/api/clips' && req.method === 'GET') {
    try {
      return json(res, 200, JSON.parse(await fs.readFile(CLIPS_JSON, 'utf8')));
    } catch {
      return json(res, 200, []);
    }
  }

  if (path === '/api/clips' && req.method === 'POST') {
    const body = await readBody(req, 8 * 1024 * 1024);
    let data;
    try { data = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: 'JSON 파싱 실패' }); }
    if (!Array.isArray(data)) return json(res, 400, { error: '배열이 아니다' });
    await fs.writeFile(CLIPS_JSON, JSON.stringify(data, null, 1), 'utf8');
    return json(res, 200, { ok: true, count: data.length });
  }

  if (path === '/api/upload' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name'));
    let body;
    try { body = await readBody(req, MAX_UPLOAD); } catch { return json(res, 413, { error: '파일이 너무 크다 (400MB 초과)' }); }
    if (!body.length) return json(res, 400, { error: '빈 파일' });
    // 컨테이너 서명 확인 — mp4/mov 는 4바이트 뒤에 'ftyp'
    if (body.length < 12 || body.subarray(4, 8).toString('latin1') !== 'ftyp') {
      return json(res, 415, { error: 'mp4 가 아닌 것 같다 (ftyp 서명 없음)' });
    }
    let target = join(REFS_DIR, name);
    if (!target.startsWith(REFS_DIR + sep)) return json(res, 400, { error: '잘못된 경로' });
    // 같은 이름이 있으면 덮어쓰지 않고 번호를 붙인다
    let n = 1;
    while (true) {
      try { await fs.access(target); } catch { break; }
      target = join(REFS_DIR, name.replace(/\.mp4$/, `-${n++}.mp4`));
    }
    await fs.writeFile(target, body);
    return json(res, 200, { ok: true, file: basename(target), bytes: body.length });
  }

  if (path === '/api/delete' && req.method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    let file;
    try { file = JSON.parse(body.toString('utf8')).file; } catch { return json(res, 400, { error: 'JSON 파싱 실패' }); }
    const target = join(REFS_DIR, basename(String(file || '')));
    if (!target.startsWith(REFS_DIR + sep) || extname(target).toLowerCase() !== '.mp4') {
      return json(res, 400, { error: '삭제할 수 없는 경로' });
    }
    try { await fs.unlink(target); } catch { return json(res, 404, { error: '파일 없음' }); }
    return json(res, 200, { ok: true, file: basename(target) });
  }

  if (path === '/api/ingest' && req.method === 'POST') {
    const py = process.env.PYTHON || 'python';
    const child = spawn(py, [join(ROOT, 'tools', 'ingest.py')], {
      cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    return new Promise((done) => {
      child.on('error', (e) => { json(res, 500, { error: 'python 실행 실패: ' + e.message }); done(); });
      child.on('close', (code) => {
        json(res, code === 0 ? 200 : 500, { ok: code === 0, code, log: out + (err ? '\n' + err : '') });
        done();
      });
    });
  }

  return json(res, 404, { error: '없는 엔드포인트: ' + path });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const urlPath = url.pathname;

  // 운영자 API 는 POST 를 쓰므로 메서드 검사보다 먼저 처리한다
  if (urlPath.startsWith('/api/')) {
    try {
      return await handleApi(req, res, url);
    } catch (e) {
      return json(res, 500, { error: String((e && e.message) || e) });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'Content-Type': 'text/plain' }, 'Method Not Allowed');
  }

  if (urlPath === '/' || urlPath === '') {
    return send(res, 302, { Location: ENTRY, 'Cache-Control': 'no-store' });
  }

  let path = toFilePath(req.url);
  if (!path) return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');

  let stat;
  try {
    stat = await fs.stat(path);
    if (stat.isDirectory()) {
      path = join(path, 'index.html');
      stat = await fs.stat(path);
    }
  } catch {
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, `Not Found: ${req.url}`);
  }

  const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    // 개발 중에는 캐시를 완전히 끈다 — 고친 파일이 바로 반영돼야 한다
    'Cache-Control': 'no-store, must-revalidate',
  };

  // ── Range: 영상 탐색에 필요하다
  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && (m[1] || m[2])) {
    const size = stat.size;
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return send(res, 416, { ...base, 'Content-Range': `bytes */${size}` });
    }
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(path, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...base, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).pipe(res);
});

/** 같은 네트워크의 다른 기기가 쓸 수 있는 IPv4 주소를 모은다. */
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (isV4 && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const lines = ['', '  Home AI 데모', '',
    `  데모      http://localhost:${PORT}/`,
    `  운영자    http://localhost:${PORT}/admin/`];
  if (HOST === '0.0.0.0') {
    const lan = lanAddresses();
    if (lan.length) {
      for (const { name, address } of lan) {
        lines.push(`  네트워크  http://${address}:${PORT}/   (${name})`);
      }
      lines.push('', '  같은 네트워크의 다른 기기에서 위 주소로 접속하면 된다.');
      lines.push('  처음 실행할 때 Windows 방화벽이 물어보면 "개인 네트워크"를 허용할 것.');
      if (ADMIN) {
        lines.push('  ! 운영자 탭은 인증이 없다. 같은 네트워크의 누구나 영상을 올리고 지울 수 있다.');
        lines.push('    끄려면: ADMIN=off npm run dev');
      }
    } else {
      lines.push('  네트워크  (외부 IPv4 주소를 찾지 못했다 — 네트워크 연결을 확인할 것)');
    }
    lines.push('  이 기기에서만 열려면: HOST=localhost npm run dev');
  } else {
    lines.push(`  바인딩    ${HOST}`);
  }
  lines.push('', '  Ctrl+C 로 종료', '');
  process.stdout.write(lines.join('\n') + '\n');
});

// 어떤 요청도 프로세스를 죽이지 못하게 하는 마지막 안전망.
// 데모 도중 서버가 내려가는 것보다 나쁜 실패는 없다.
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
process.on('uncaughtException', (e) => console.error('[uncaught]', e));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`\n  포트 ${PORT} 가 이미 사용 중입니다. PORT=8778 npm run dev 처럼 바꿔서 실행하세요.\n\n`);
    process.exit(1);
  }
  throw err;
});
