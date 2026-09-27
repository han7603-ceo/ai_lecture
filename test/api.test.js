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

test('수업 시작/종료: 새 코드 발급, 입장·제출 열고 닫기', async () => {
  const { data: { token } } = await call('POST', '/api/master/login', { body: { password: 'test-pw' } });
  const { data: { course } } = await call('POST', '/api/master/courses', { token, body: { name: '세션', maxStudents: 5 } });
  const a = await call('POST', '/api/join', { body: { code: course.code, name: '학생A' } });

  const ended = await call('POST', `/api/master/courses/${course.id}/end`, { token });
  assert.equal(ended.data.course.open, false);
  assert.equal((await call('POST', '/api/join', { body: { code: course.code, name: '학생B' } })).status, 403);

  const started = await call('POST', `/api/master/courses/${course.id}/start`, { token });
  assert.equal(started.data.course.open, true);
  assert.notEqual(started.data.course.code, course.code, '새 코드 발급');
  assert.ok(started.data.course.sessionStartedAt);
  assert.equal((await call('POST', '/api/join', { body: { code: course.code, name: '학생B' } })).status, 404, '지난 코드는 무효');
  assert.equal((await call('POST', '/api/join', { body: { code: started.data.course.code, name: '학생B' } })).status, 200);
  // 이미 입장한 학생은 코드와 무관하게 유지
  assert.equal((await call('GET', '/api/student/me', { student: a.data.token })).status, 200);
});

test('자료 보내기: 전체/선택 대상, 권한, 확인 기록, 회수', async () => {
  const { data: { token } } = await call('POST', '/api/master/login', { body: { password: 'test-pw' } });
  const { data: { course } } = await call('POST', '/api/master/courses', { token, body: { name: '자료반', maxStudents: 5 } });
  const a = (await call('POST', '/api/join', { body: { code: course.code, name: '가' } })).data;
  const b = (await call('POST', '/api/join', { body: { code: course.code, name: '나' } })).data;

  const send = (target, name, text) => {
    const form = new FormData();
    form.append('files', new Blob([text]), name);
    form.append('note', '실습 예제');
    form.append('target', target);
    return call('POST', `/api/master/courses/${course.id}/materials`, { token, body: form });
  };
  const all = await send('all', '전체자료.txt', 'ALL');
  assert.equal(all.status, 200);
  const only = await send(JSON.stringify([b.studentId]), '개별자료.txt', 'ONLY');
  assert.equal(only.status, 200);
  assert.deepEqual(only.data.materials[0].target, [b.studentId]);
  assert.equal((await send(JSON.stringify(['없는학생']), 'x.txt', 'x')).status, 400, '대상 없음');

  const meA = (await call('GET', '/api/student/me', { student: a.token })).data;
  const meB = (await call('GET', '/api/student/me', { student: b.token })).data;
  assert.deepEqual(meA.materials.map((m) => m.name), ['전체자료.txt']);
  assert.deepEqual(meB.materials.map((m) => m.name).sort(), ['개별자료.txt', '전체자료.txt']);

  // 나중에 입장한 학생도 전체 자료를 받음
  const c = (await call('POST', '/api/join', { body: { code: course.code, name: '다' } })).data;
  assert.deepEqual((await call('GET', '/api/student/me', { student: c.token })).data.materials.map((m) => m.name), ['전체자료.txt']);

  // 대상이 아닌 학생은 파일 접근 불가
  const onlyId = only.data.materials[0].id;
  assert.equal((await call('GET', `/materials/${onlyId}?t=${a.token}`)).status, 404);
  // 썸네일(nt=1) 요청은 확인으로 치지 않음, 실제 열람은 기록
  assert.equal((await call('GET', `/materials/${onlyId}?t=${b.token}&nt=1`)).data.toString(), 'ONLY');
  let st = (await call('GET', '/api/master/state', { token })).data.materials.find((m) => m.id === onlyId);
  assert.equal(Object.keys(st.seen).length, 0);
  await call('GET', `/materials/${onlyId}?t=${b.token}&download=1`);
  st = (await call('GET', '/api/master/state', { token })).data.materials.find((m) => m.id === onlyId);
  assert.ok(st.seen[b.studentId]);
  assert.ok((await call('GET', '/api/student/me', { student: b.token })).data.materials.find((m) => m.id === onlyId).seenAt);

  // 수업 종료 후에도 자료는 볼 수 있음
  await call('POST', `/api/master/courses/${course.id}/end`, { token });
  assert.equal((await call('GET', `/materials/${all.data.materials[0].id}?t=${a.token}`)).status, 200);

  // 회수
  assert.equal((await call('DELETE', `/api/master/materials/${onlyId}`, { token })).status, 200);
  assert.equal((await call('GET', `/materials/${onlyId}?t=${b.token}`)).status, 404);
  assert.equal((await call('GET', '/api/student/me', { student: b.token })).data.materials.length, 1);
});

// 로그인 차단 테스트는 이 IP 를 15분간 막으므로 항상 마지막에 둔다
test('로그인 실패가 반복되면 차단', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/api/master/login', { body: { password: 'wrong' } });
  assert.equal(last.status, 429);
  // 차단 중에는 올바른 비밀번호도 거부
  assert.equal((await call('POST', '/api/master/login', { body: { password: 'test-pw' } })).status, 429);
});
