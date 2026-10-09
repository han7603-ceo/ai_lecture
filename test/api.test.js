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

  assert.equal((await call('POST', '/api/join', { body: { code: 'WRONG1', name: 'x', pin: '1234' } })).status, 404);
  const a = await call('POST', '/api/join', { body: { code: course.code.toLowerCase(), name: '김학생', pin: '1234' } });
  assert.equal(a.status, 200);
  const dup = await call('POST', '/api/join', { body: { code: course.code, name: '김학생', pin: '9999' } });
  assert.equal(dup.status, 401, '같은 이름 + 다른 PIN 은 거부');
  await call('POST', '/api/join', { body: { code: course.code, name: '이학생', pin: '1234' } });
  const full = await call('POST', '/api/join', { body: { code: course.code, name: '박학생', pin: '1234' } });
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
  const a = await call('POST', '/api/join', { body: { code: course.code, name: '학생A', pin: '1234' } });

  const ended = await call('POST', `/api/master/courses/${course.id}/end`, { token });
  assert.equal(ended.data.course.open, false);
  assert.equal((await call('POST', '/api/join', { body: { code: course.code, name: '학생B', pin: '1234' } })).status, 403);

  const started = await call('POST', `/api/master/courses/${course.id}/start`, { token });
  assert.equal(started.data.course.open, true);
  assert.notEqual(started.data.course.code, course.code, '새 코드 발급');
  assert.ok(started.data.course.sessionStartedAt);
  assert.equal((await call('POST', '/api/join', { body: { code: course.code, name: '학생B', pin: '1234' } })).status, 404, '지난 코드는 무효');
  assert.equal((await call('POST', '/api/join', { body: { code: started.data.course.code, name: '학생B', pin: '1234' } })).status, 200);
  // 이미 입장한 학생은 코드와 무관하게 유지
  assert.equal((await call('GET', '/api/student/me', { student: a.data.token })).status, 200);
});

test('자료 보내기: 전체/선택 대상, 권한, 확인 기록, 회수', async () => {
  const { data: { token } } = await call('POST', '/api/master/login', { body: { password: 'test-pw' } });
  const { data: { course } } = await call('POST', '/api/master/courses', { token, body: { name: '자료반', maxStudents: 5 } });
  const a = (await call('POST', '/api/join', { body: { code: course.code, name: '가', pin: '1234' } })).data;
  const b = (await call('POST', '/api/join', { body: { code: course.code, name: '나', pin: '1234' } })).data;

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
  const c = (await call('POST', '/api/join', { body: { code: course.code, name: '다', pin: '1234' } })).data;
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

test('링크(URL) 보내기: 주소 검사, 확인 기록 후 이동, 회수', async () => {
  const { data: { token } } = await call('POST', '/api/master/login', { body: { password: 'test-pw' } });
  const { data: { course } } = await call('POST', '/api/master/courses', { token, body: { name: '링크반', maxStudents: 5 } });
  const a = (await call('POST', '/api/join', { body: { code: course.code, name: '가', pin: '1234' } })).data;
  const b = (await call('POST', '/api/join', { body: { code: course.code, name: '나', pin: '1234' } })).data;

  const send = (links, target = 'all', file) => {
    const form = new FormData();
    if (file) form.append('files', new Blob(['F']), file);
    form.append('links', JSON.stringify(links));
    form.append('note', '수업 링크');
    form.append('target', target);
    return call('POST', `/api/master/courses/${course.id}/materials`, { token, body: form });
  };
  // javascript: 등 http(s) 가 아닌 주소, 오타는 거부
  assert.equal((await send([{ url: 'javascript:alert(1)' }])).status, 400);
  assert.equal((await send([{ url: 'abc' }])).status, 400);
  assert.equal((await send([])).status, 400, '파일도 링크도 없음');

  // 파일과 링크를 함께, 스킴 없이 입력하면 https:// 를 붙이고 제목이 없으면 주소로 대신
  const r = await send([{ url: 'www.youtube.com/watch?v=abc', title: '' }, { url: 'https://padlet.com/x', title: '패들렛' }], 'all', '함께.txt');
  assert.equal(r.status, 200);
  const [file, yt, pd] = r.data.materials;
  assert.equal(file.kind, 'file');
  assert.equal(yt.kind, 'link');
  assert.equal(yt.url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(yt.name, 'youtube.com/watch');
  assert.equal(pd.name, '패들렛');

  const only = (await send([{ url: 'https://example.com/b' }], JSON.stringify([b.studentId]))).data.materials[0];
  const meA = (await call('GET', '/api/student/me', { student: a.token })).data;
  assert.ok(!meA.materials.some((m) => m.id === only.id), '대상 아닌 학생에게는 안 보임');
  assert.equal(meA.materials.find((m) => m.id === yt.id).url, yt.url);

  // 학생이 열면 확인 기록 후 원래 주소로 이동, 대상이 아니면 404
  const go = (id, t) => fetch(`${BASE}/materials/${id}?t=${t}`, { redirect: 'manual' });
  assert.equal((await go(only.id, a.token)).status, 404);
  const res = await go(yt.id, a.token);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), yt.url);
  const st = (await call('GET', '/api/master/state', { token })).data.materials.find((m) => m.id === yt.id);
  assert.ok(st.seen[a.studentId]);
  assert.ok(!st.seen[b.studentId]);
  assert.equal((await fetch(`${BASE}/materials/${yt.id}/pdf?t=${a.token}`)).status, 415);

  // 회수 (저장된 파일이 없어도 정상 처리)
  assert.equal((await call('DELETE', `/api/master/materials/${yt.id}`, { token })).status, 200);
  assert.equal((await go(yt.id, a.token)).status, 404);
});

test('학생 링크 제출: 주소 검사, 교사 조회, 이동, ZIP·CSV, 삭제, 마감', async () => {
  const { data: { token } } = await call('POST', '/api/master/login', { body: { password: 'test-pw' } });
  const { data: { course } } = await call('POST', '/api/master/courses', { token, body: { name: '링크제출반', maxStudents: 5 } });
  const a = (await call('POST', '/api/join', { body: { code: course.code, name: '가', pin: '1234' } })).data;
  const other = (await call('POST', '/api/join', { body: { code: course.code, name: '나', pin: '1234' } })).data;
  const submit = (body, t = a.token) => call('POST', '/api/student/links', { student: t, body });

  assert.equal((await submit({ url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await submit({ url: '' })).status, 400);
  assert.equal((await submit({ url: 'https://x.com' }, 'bad-token')).status, 401);

  const r = await submit({ url: 'docs.google.com/document/d/abc/edit', title: '조별 보고서' });
  assert.equal(r.status, 200);
  const link = r.data.student.files.find((f) => f.kind === 'link');
  assert.equal(link.url, 'https://docs.google.com/document/d/abc/edit');
  assert.equal(link.name, '조별 보고서');
  assert.equal(link.ext, 'link');
  const yt = (await submit({ url: 'https://www.youtube.com/watch?v=1' })).data.student.files.at(-1);
  assert.equal(yt.name, 'youtube.com/watch');

  // 교사 대시보드에 보이고, 교사·본인만 열 수 있음 (원래 주소로 이동)
  const st = (await call('GET', '/api/master/state', { token })).data;
  assert.equal(st.students.find((x) => x.id === a.studentId).files.filter((f) => f.kind === 'link').length, 2);
  const go = (t) => fetch(`${BASE}/files/${link.id}?t=${t}`, { redirect: 'manual' });
  assert.equal((await go(token)).headers.get('location'), link.url);
  assert.equal((await go(a.token)).status, 302);
  assert.equal((await go(other.token)).status, 404);

  // ZIP: 학생 폴더에 링크.txt, 제출현황.csv 에 주소 (압축 레벨 1이라 본문을 그대로 찾기 어려워 파일 이름과 CSV 만 확인)
  const zip = await call('GET', `/api/master/courses/${course.id}/zip?t=${token}`);
  assert.equal(zip.status, 200);
  const JSZip = require('jszip');
  const z = await JSZip.loadAsync(zip.data);
  const names = Object.keys(z.files);
  assert.ok(names.some((n) => n.endsWith('/링크.txt')), names.join(','));
  const txt = await z.file(names.find((n) => n.endsWith('/링크.txt'))).async('string');
  assert.ok(txt.includes('조별 보고서') && txt.includes(link.url));
  const csv = await z.file(names.find((n) => n.endsWith('제출현황.csv'))).async('string');
  assert.ok(csv.includes(`조별 보고서 (${link.url})`));

  // 삭제 (저장 파일 없음)
  assert.equal((await call('DELETE', `/api/student/files/${yt.id}`, { student: a.token })).status, 200);
  // 마감되면 제출 불가
  await call('POST', `/api/master/courses/${course.id}/end`, { token });
  assert.equal((await submit({ url: 'https://example.com' })).status, 403);
});

test('인증 메일 연결: 키 검사, 코드 추출, 계정별 코드 확인 링크', async () => {
  const { data: { token } } = await call('POST', '/api/master/login', { body: { password: 'test-pw' } });
  const st = (await call('GET', '/api/master/state', { token })).data;
  assert.match(st.inboxKey, /^[0-9a-f]{32}$/);
  const post = (body, key = st.inboxKey) => fetch(`${BASE}/api/inbox`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-inbox-key': key }, body: JSON.stringify(body),
  });
  const mail = (id, to, code) => ({
    id, to: `"학생" <${to}>`, from: 'OpenAI <noreply@tm.openai.com>', subject: `Your ChatGPT code is ${code}`,
    text: `Enter this code: ${code}\nhttps://auth.openai.com/verify?token=abc\nhttps://openai.com/privacy`,
  });
  assert.equal((await post(mail('m0', 'x@y.com', '000000'), 'wrong')).status, 401);

  // 계정 등록 (한 줄에 하나, 이름 선택, 형식 오류는 건너뜀, 대소문자 무시)
  const reg = await call('POST', '/api/master/mailboxes', { token, body: { text: 'Han7603+S01@gmail.com 홍길동\nhan7603+s02@gmail.com\nnot-an-email' } });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.added, 2);
  assert.deepEqual(reg.data.bad, ['not-an-email']);
  const b1 = reg.data.mailboxes.find((b) => b.address === 'han7603+s01@gmail.com');
  const b2 = reg.data.mailboxes.find((b) => b.address === 'han7603+s02@gmail.com');
  assert.equal(b1.label, '홍길동');
  assert.equal(b2.label, 'han7603+s02');
  assert.equal((await call('POST', '/api/master/mailboxes', { token, body: { text: 'han7603+s01@gmail.com' } })).data.added, 0, '중복 무시');

  assert.equal((await post(mail('m1', 'han7603+s01@gmail.com', '123456'))).status, 200);
  assert.equal((await post(mail('m1', 'han7603+s01@gmail.com', '123456'))).status, 200, '중복은 무시');
  await post(mail('m2', 'han7603+s09@gmail.com', '999999'));

  const inboxM = (await call('GET', '/api/master/state', { token })).data.inbox;
  assert.equal(inboxM.length, 2);
  const m1 = inboxM.find((m) => m.id === 'm1');
  assert.equal(m1.code, '123456');
  assert.deepEqual(m1.to, ['han7603+s01@gmail.com']);
  assert.deepEqual(m1.links, ['https://auth.openai.com/verify?token=abc']);

  // 코드 확인 링크: 자기 주소 것만, 본문 없음, 과목·입장과 무관
  const c1 = (await call('GET', `/api/code/${b1.token}`)).data;
  assert.equal(c1.label, '홍길동');
  assert.deepEqual(c1.inbox.map((m) => m.code), ['123456']);
  assert.equal(c1.inbox[0].text, undefined);
  assert.equal((await call('GET', `/api/code/${b2.token}`)).data.inbox.length, 0);
  assert.equal((await call('GET', '/api/code/nope')).status, 404);
  assert.equal((await call('GET', `/code/${b1.token}`)).status, 200);

  // 통합 링크: 등록한 모든 계정의 코드 + 계정 이름 (등록 안 된 주소의 메일은 제외)
  const allTok = (await call('GET', '/api/master/state', { token })).data.codeAllToken;
  assert.match(allTok, /^[0-9a-f]{48}$/);
  const all = (await call('GET', `/api/code/${allTok}`)).data;
  assert.equal(all.all, true);
  assert.deepEqual(all.inbox.map((m) => `${m.label}:${m.code}`), ['홍길동:123456']);
  const allTok2 = (await call('POST', '/api/master/mailboxes/all-link/regen', { token })).data.codeAllToken;
  assert.equal((await call('GET', `/api/code/${allTok}`)).status, 404, '예전 통합 링크 무효');
  assert.equal((await call('GET', `/api/code/${allTok2}`)).status, 200);

  // 링크 다시 만들기 → 예전 링크 무효, 삭제
  const re = (await call('PATCH', `/api/master/mailboxes/${b1.id}`, { token, body: { regen: true, label: '홍길동(1)' } })).data.mailbox;
  assert.notEqual(re.token, b1.token);
  assert.equal(re.label, '홍길동(1)');
  assert.equal((await call('GET', `/api/code/${b1.token}`)).status, 404);
  assert.equal((await call('GET', `/api/code/${re.token}`)).status, 200);
  assert.equal((await call('DELETE', `/api/master/mailboxes/${b2.id}`, { token })).status, 200);
  assert.equal((await call('GET', `/api/code/${b2.token}`)).status, 404);
  // 학생·참관자는 계정 관리 불가
  assert.equal((await call('POST', '/api/master/mailboxes', { body: { text: 'a@b.com' } })).status, 401);

  // 키 재발급 후 예전 키 거부
  const { data: { inboxKey } } = await call('POST', '/api/master/inbox/regen-key', { token });
  assert.equal((await post(mail('m3', 'a@b.com', '111111'))).status, 401);
  assert.equal((await post(mail('m3', 'a@b.com', '111111'), inboxKey)).status, 200);
});

test('수업 시작: 지난 수업 자료는 학생 화면에서 내리고 다시 보내기 가능', async () => {
  const { data: { token } } = await call('POST', '/api/master/login', { body: { password: 'test-pw' } });
  const { data: { course } } = await call('POST', '/api/master/courses', { token, body: { name: '보관반', maxStudents: 5 } });
  const a = (await call('POST', '/api/join', { body: { code: course.code, name: '가', pin: '1234' } })).data;
  const form = new FormData();
  form.append('files', new Blob(['W1']), '1주차.txt');
  form.append('target', 'all');
  const m = (await call('POST', `/api/master/courses/${course.id}/materials`, { token, body: form })).data.materials[0];
  await call('GET', `/materials/${m.id}?t=${a.token}`); // 학생이 확인
  assert.equal((await call('GET', '/api/student/me', { student: a.token })).data.materials.length, 1);

  await call('POST', `/api/master/courses/${course.id}/start`, { token });
  assert.equal((await call('GET', '/api/student/me', { student: a.token })).data.materials.length, 0, '새 수업에선 안 보임');
  assert.equal((await call('GET', `/materials/${m.id}?t=${a.token}`)).status, 404);
  const archived = (await call('GET', '/api/master/state', { token })).data.materials.find((x) => x.id === m.id);
  assert.equal(archived.archived, true, '교사에겐 보관');

  const r = await call('POST', `/api/master/materials/${m.id}/restore`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.data.material.archived, false);
  assert.deepEqual(r.data.material.seen, {}, '확인 기록 초기화');
  const me = (await call('GET', '/api/student/me', { student: a.token })).data;
  assert.equal(me.materials.length, 1);
  assert.equal(me.materials[0].seenAt, null, '다시 NEW');
});

test('참관(게스트) 링크: 읽기 전용, 과목 범위, 민감 정보 제외, 취소', async () => {
  const { data: { token } } = await call('POST', '/api/master/login', { body: { password: 'test-pw' } });
  const c1 = (await call('POST', '/api/master/courses', { token, body: { name: '참관반', maxStudents: 5 } })).data.course;
  const c2 = (await call('POST', '/api/master/courses', { token, body: { name: '다른반', maxStudents: 5 } })).data.course;
  const a = (await call('POST', '/api/join', { body: { code: c1.code, name: '가', pin: '1234' } })).data;
  const b = (await call('POST', '/api/join', { body: { code: c2.code, name: '나', pin: '1234' } })).data;
  const form = new FormData(); form.append('files', new Blob(['HELLO']), 'a.txt');
  const fa = (await call('POST', '/api/student/upload', { student: a.token, body: form })).data.student.files[0];
  const form2 = new FormData(); form2.append('files', new Blob(['OTHER']), 'b.txt');
  const fb = (await call('POST', '/api/student/upload', { student: b.token, body: form2 })).data.student.files[0];

  const g = (await call('POST', '/api/master/guests', { token, body: { label: '김 선생님', courseId: c1.id, hours: 2 } })).data.guest;
  assert.match(g.token, /^[0-9a-f]{48}$/);
  assert.ok(g.expiresAt - Date.now() > 1.9 * 3600000);

  const st = await call('GET', '/api/guest/state', { token: g.token });
  assert.equal(st.status, 200);
  assert.deepEqual(st.data.courses.map((c) => c.name), ['참관반'], '허락한 과목만');
  assert.deepEqual(st.data.students.map((s) => s.name), ['가']);
  for (const k of ['inbox', 'inboxKey', 'guests', 'mailboxes']) assert.equal(st.data[k], undefined, k);

  // 파일: 허락한 과목만 열람
  assert.equal((await call('GET', `/files/${fa.id}?t=${g.token}`)).data.toString(), 'HELLO');
  assert.equal((await call('GET', `/files/${fb.id}?t=${g.token}`)).status, 404);
  // 교사 기능은 전부 거부
  assert.equal((await call('GET', '/api/master/state', { token: g.token })).status, 401);
  assert.equal((await call('DELETE', `/api/master/students/${a.studentId}/files/${fa.id}`, { token: g.token })).status, 401);
  assert.equal((await call('POST', `/api/master/courses/${c1.id}/end`, { token: g.token })).status, 401);
  assert.equal((await call('GET', `/api/master/courses/${c1.id}/zip?t=${g.token}`)).status, 401);
  assert.equal((await call('POST', '/api/master/guests', { token: g.token, body: {} })).status, 401);

  // 전체 과목 링크
  const gAll = (await call('POST', '/api/master/guests', { token, body: { label: '교감', hours: 1 } })).data.guest;
  assert.equal((await call('GET', '/api/guest/state', { token: gAll.token })).data.courses.length >= 2, true);
  assert.equal((await call('GET', '/api/master/state', { token })).data.guests.length >= 2, true);

  // 취소하면 즉시 막힘
  assert.equal((await call('DELETE', `/api/master/guests/${g.id}`, { token })).status, 200);
  assert.equal((await call('GET', '/api/guest/state', { token: g.token })).status, 401);
  assert.equal((await call('GET', `/files/${fa.id}?t=${g.token}`)).status, 404);
  assert.equal((await call('GET', '/api/guest/state', { token: 'nope' })).status, 401);
});

test('학생 PIN·개인 링크: 재입장 확인, 잠금, 교사 초기화, 링크 다시 만들기', async () => {
  const { data: { token } } = await call('POST', '/api/master/login', { body: { password: 'test-pw' } });
  const { data: { course } } = await call('POST', '/api/master/courses', { token, body: { name: '핀반', maxStudents: 5 } });
  const join = (name, pin, code = course.code) => call('POST', '/api/join', { body: { code, name, pin } });
  assert.equal((await join('가', '12')).status, 400, 'PIN 형식');
  assert.equal((await join('가', 'abcd')).status, 400);
  const a = (await join('가', '4321')).data;
  assert.match(a.key, /^[0-9a-f]{48}$/);

  // 개인 링크로 입장: 코드·이름·PIN 없이 같은 학생
  assert.equal((await call('GET', `/s/${a.key}`)).status, 200); // /student?k= 로 이동 후 페이지
  const byKey = await call('POST', '/api/join/key', { body: { key: a.key } });
  assert.equal(byKey.data.studentId, a.studentId);
  assert.equal(byKey.data.code, course.code);
  assert.equal((await call('POST', '/api/join/key', { body: { key: 'nope' } })).status, 404);

  // 같은 이름 + 맞는 PIN → 본인 재입장 (새 세션, 이전 토큰 무효)
  const re = await join('가', '4321');
  assert.equal(re.status, 200);
  assert.equal(re.data.studentId, a.studentId);
  assert.equal((await call('GET', '/api/student/me', { student: a.token })).status, 401, '이전 기기 로그아웃');
  assert.equal((await call('GET', '/api/student/me', { student: re.data.token })).data.student.key, a.key, '본인은 개인 링크 확인 가능');

  // 5번 틀리면 잠금 → 맞는 PIN 도 거부
  for (let i = 0; i < 4; i++) assert.equal((await join('가', '0000')).status, 401);
  assert.equal((await join('가', '0000')).status, 401);
  assert.equal((await join('가', '4321')).status, 423, '잠김');
  let st = (await call('GET', '/api/master/state', { token })).data.students.find((x) => x.id === a.studentId);
  assert.equal(st.pinLocked, true);
  assert.equal(st.hasPin, true);

  // 교사 PIN 초기화 → 다음 입장 때 새 PIN 으로 설정
  await call('POST', `/api/master/students/${a.studentId}/reset-pin`, { token });
  const after = await join('가', '5555');
  assert.equal(after.status, 200);
  assert.equal((await join('가', '4321')).status, 401, '예전 PIN 무효');
  assert.equal((await join('가', '5555')).status, 200);

  // 개인 링크 다시 만들기 → 예전 링크 무효
  const nk = (await call('POST', `/api/master/students/${a.studentId}/regen-key`, { token })).data.key;
  assert.notEqual(nk, a.key);
  assert.equal((await call('POST', '/api/join/key', { body: { key: a.key } })).status, 404);
  assert.equal((await call('POST', '/api/join/key', { body: { key: nk } })).status, 200);

  // 수업이 끝나도 본인 재입장·개인 링크는 가능, 새 학생은 불가
  await call('POST', `/api/master/courses/${course.id}/end`, { token });
  assert.equal((await join('가', '5555')).status, 200);
  assert.equal((await join('새학생', '1111')).status, 403);
  assert.equal((await call('POST', '/api/join/key', { body: { key: nk } })).status, 200);

  // 참관자에게는 개인 링크가 보이지 않음
  const g = (await call('POST', '/api/master/guests', { token, body: { label: '참관', hours: 1 } })).data.guest;
  st = (await call('GET', '/api/guest/state', { token: g.token })).data.students.find((x) => x.id === a.studentId);
  assert.equal(st.key, undefined);
});

// 로그인 차단 테스트는 이 IP 를 15분간 막으므로 항상 마지막에 둔다
test('로그인 실패가 반복되면 차단', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/api/master/login', { body: { password: 'wrong' } });
  assert.equal(last.status, 429);
  // 차단 중에는 올바른 비밀번호도 거부
  assert.equal((await call('POST', '/api/master/login', { body: { password: 'test-pw' } })).status, 429);
});
