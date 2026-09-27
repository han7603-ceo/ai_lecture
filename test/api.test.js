'use strict';
// 서버 API 통합 테스트: 실제 서버를 임시 폴더로 띄워 입장 → 업로드 → ZIP 흐름을 확인
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-test-'));
let proc;

async function call(method, url, { body, token, student } = {}) {
  const headers = {};
  if (token) headers['x-master-token'] = token;
  if (student) headers['x-student-token'] = student;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, MASTER_PASSWORD: 'test-pw' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/public/config`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('입장 → 업로드 → 교사 조회 → ZIP 다운로드', async () => {
  assert.equal((await call('POST', '/api/master/login', { body: { password: 'nope' } })).status, 401);
  const { data: { token } } = await call('POST', '/api/master/login', { body: { password: 'test-pw' } });
  assert.ok(token);

  const { data: { course } } = await call('POST', '/api/master/courses', { token, body: { name: '미디어 실습', maxStudents: 2 } });
  assert.equal(course.maxStudents, 2);
  assert.match(course.code, /^[A-Z0-9]{6}$/);

  // 정원 50명 초과 요청은 50으로 제한
  const big = await call('POST', '/api/master/courses', { token, body: { name: '대형', maxStudents: 999 } });
  assert.equal(big.data.course.maxStudents, 50);

  assert.equal((await call('POST', '/api/join', { body: { code: 'WRONG1', name: 'x' } })).status, 404);
  const a = await call('POST', '/api/join', { body: { code: course.code.toLowerCase(), name: '김학생' } });
  assert.equal(a.status, 200);
  const dup = await call('POST', '/api/join', { body: { code: course.code, name: '김학생' } });
  assert.equal(dup.status, 409);
  await call('POST', '/api/join', { body: { code: course.code, name: '이학생' } });
  const full = await call('POST', '/api/join', { body: { code: course.code, name: '박학생' } });
  assert.equal(full.status, 403, '정원 초과');

  const form = new FormData();
  form.append('files', new Blob(['hello']), '과제 1.txt');
  form.append('files', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'photo.png');
  const up = await call('POST', '/api/student/upload', { student: a.data.token, body: form });
  assert.equal(up.status, 200);
  assert.deepEqual(up.data.student.files.map((f) => f.name), ['과제 1.txt', 'photo.png']);

  const bad = new FormData();
  bad.append('files', new Blob(['x']), 'virus.exe');
  assert.equal((await call('POST', '/api/student/upload', { student: a.data.token, body: bad })).status, 415);

  const st = await call('GET', '/api/master/state', { token });
  const kim = st.data.students.find((s) => s.name === '김학생');
  assert.equal(kim.seat, 1);
  assert.equal(kim.files.length, 2);

  // 파일 접근 권한: 다른 학생 토큰으로는 불가
  const b = st.data.students.find((s) => s.name === '이학생');
  assert.ok(b);
  const fid = kim.files[0].id;
  assert.equal((await call('GET', `/files/${fid}?t=${token}`)).data.toString(), 'hello');
  assert.equal((await call('GET', `/files/${fid}?t=invalid`)).status, 404);

  const zip = await call('GET', `/api/master/courses/${course.id}/zip?t=${token}`);
  assert.equal(zip.status, 200);
  assert.equal(zip.data.subarray(0, 2).toString(), 'PK');
  const listing = zip.data.toString('latin1');
  assert.ok(listing.includes(Buffer.from('01_김학생/과제 1.txt').toString('latin1')), '학생별 폴더 구조');

  // 정원을 등록된 자리보다 작게 줄일 수 없음
  assert.equal((await call('PATCH', `/api/master/courses/${course.id}`, { token, body: { maxStudents: 1 } })).status, 400);

  // 마감 시 업로드 차단
  await call('PATCH', `/api/master/courses/${course.id}`, { token, body: { open: false } });
  const closed = new FormData();
  closed.append('files', new Blob(['x']), 'a.txt');
  assert.equal((await call('POST', '/api/student/upload', { student: a.data.token, body: closed })).status, 403);

  // 과목 초기화 → 학생 토큰 무효
  await call('POST', `/api/master/courses/${course.id}/clear`, { token });
  assert.equal((await call('GET', '/api/student/me', { student: a.data.token })).status, 401);
});
