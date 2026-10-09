'use strict';
/**
 * 실시간 과제 제출 보드 서버
 * - Express: REST API + 정적 파일
 * - Socket.IO: 접속 상태/업로드 현황 실시간 반영
 * - 파일은 서버 디스크(data/uploads)에 임시 저장 (외부 DB 불필요)
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const express = require('express');
const multer = require('multer');
const { startImapInbox } = require('./inbox-imap');
const archiver = require('archiver');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MATERIAL_DIR = path.join(DATA_DIR, 'materials'); // 교사가 학생에게 보낸 자료
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 300;
const MAX_FILES_PER_UPLOAD = 20;
const MAX_STUDENTS = 50;
const DEFAULT_PASSWORD = 'admin1234';
const ENV_PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// 학생 접속 주소 (QR). 실행 중 터널 주소가 생기면 setPublicUrl 로 바뀜
let publicUrl = ENV_PUBLIC_URL;
let publicUrlSource = ENV_PUBLIC_URL ? 'env' : null;

const ALLOWED_EXT = new Set([
  // 이미지
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic',
  // 영상
  'mp4', 'mov', 'webm', 'm4v',
  // 음향
  'wav', 'wave', 'mp3', 'm4a', 'ogg', 'aac',
  // 문서
  'pdf', 'hwp', 'hwpx', 'doc', 'docx', 'ppt', 'pptx', 'pps', 'ppsx', 'xls', 'xlsx', 'csv', 'txt',
  // 기타
  'zip',
]);
// LibreOffice 로 PDF 변환을 시도할 확장자
const CONVERTIBLE_EXT = new Set(['doc', 'docx', 'ppt', 'pptx', 'pps', 'ppsx', 'xls', 'xlsx', 'hwp']);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 상태 저장 (JSON 파일)
// ---------------------------------------------------------------------------
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    s.courses ||= {};
    s.students ||= {};
    s.materials ||= {};
    s.guests ||= {};
    s.mailboxes ||= {};
    return s;
  } catch {
    return {
      siteTitle: '실시간 과제 제출 보드',
      passwordHash: null,
      courses: {},
      students: {},
      materials: {},
      guests: {},
      mailboxes: {},
    };
  }
}
const state = loadState();
// 개인 입장 링크가 없던 기존 학생에게 발급
for (const st of Object.values(state.students)) st.key ||= crypto.randomBytes(24).toString('hex');
// 환경변수 MASTER_PASSWORD 가 있으면 항상 우선
if (process.env.MASTER_PASSWORD) {
  state.passwordHash = hashPassword(process.env.MASTER_PASSWORD);
  delete state.usingDefaultPassword;
} else if (!state.passwordHash) {
  state.passwordHash = hashPassword(DEFAULT_PASSWORD);
  state.usingDefaultPassword = true;
}

let saveTimer = null;
function writeState() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeState(); }, 200);
}
// 종료 직전에 아직 저장되지 않은 변경을 즉시 기록
function flushState() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeState();
}

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
const newId = () => crypto.randomBytes(8).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O/1/I 제외

function newJoinCode() {
  const used = new Set(Object.values(state.courses).map((c) => c.code));
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!used.has(code)) return code;
  }
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const extOf = (name) => (path.extname(String(name)).slice(1) || '').toLowerCase();
const safeFsName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '_';

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}`);
    }
  }
  return urls;
}

// LibreOffice 위치 (있으면 hwp/doc/ppt/xls 등을 PDF 로 변환해 미리보기)
function findSoffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['soffice', 'libreoffice', 'soffice.exe']) {
      const p = path.join(dir, name);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}
const sofficePath = findSoffice();

// ---------------------------------------------------------------------------
// 직렬화 (클라이언트에 보낼 형태)
// ---------------------------------------------------------------------------
const online = new Map(); // studentId -> 접속 소켓 수
const masterTokens = new Set();

function publicFile(f) {
  return {
    id: f.id, kind: f.kind || 'file', url: f.url || null, name: f.name, ext: f.ext, size: f.size, mime: f.mime,
    uploadedAt: f.uploadedAt,
  };
}
function publicStudent(s) {
  return {
    id: s.id, courseId: s.courseId, name: s.name, seat: s.seat,
    joinedAt: s.joinedAt, lastSeen: s.lastSeen, reviewedAt: s.reviewedAt || 0,
    online: (online.get(s.id) || 0) > 0,
    hasPin: !!s.pinHash,
    pinLocked: (s.pinLockUntil || 0) > Date.now(),
    key: s.key, // 개인 입장 링크 (교사·본인에게만 — 참관자에게는 지움)
    files: s.files.map(publicFile),
  };
}
function publicCourse(c) {
  return {
    id: c.id, name: c.name, code: c.code, maxStudents: c.maxStudents,
    open: c.open !== false, createdAt: c.createdAt,
    sessionStartedAt: c.sessionStartedAt || null, sessionEndedAt: c.sessionEndedAt || null,
  };
}
const studentsOf = (courseId) =>
  Object.values(state.students).filter((s) => s.courseId === courseId).sort((a, b) => a.seat - b.seat);

// ---------------------------------------------------------------------------
// 서버 / 소켓
// ---------------------------------------------------------------------------
const app = express();
// 클라우드(Railway 등) 앞단 프록시 1단계만 신뢰 → X-Forwarded-For 위조로 IP 를 속이기 어렵게
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// 참관(게스트) 링크: 교사가 허락한 사람이 대시보드를 읽기 전용으로 봄. 링크 토큰 자체가 인증 수단이며
// 만료되거나 교사가 취소하면 바로 막힌다. 인증 메일·연결 키·학생 가입 메일 등은 보내지 않는다.
const guestByToken = (t) => {
  if (!t) return null;
  const g = Object.values(state.guests).find((x) => x.token === t);
  return g && g.expiresAt > Date.now() ? g : null;
};
const guestSees = (g, courseId) => !g.courseId || g.courseId === courseId;
const guestStudent = ({ key, ...rest }) => rest;
const GUEST_EVENTS = new Set(['student:update', 'student:remove', 'course:update', 'course:remove', 'material:update', 'material:remove', 'site:update', 'config:update']);
const guestRooms = () => [...io.sockets.adapter.rooms.keys()].filter((r) => r.startsWith('guest:'));
const toMasters = (event, payload) => {
  io.to('master').emit(event, payload);
  if (!GUEST_EVENTS.has(event)) return;
  const cid = payload.courseId ?? (event.startsWith('course:') ? payload.id : undefined);
  const rooms = cid ? ['guest:all', `guest:${cid}`] : guestRooms();
  if (rooms.length) io.to(rooms).emit(event, event === 'student:update' ? guestStudent(payload) : payload);
};
const toCourse = (courseId, event, payload) => io.to(`course:${courseId}`).emit(event, payload);
const toStudent = (studentId, event, payload) => io.to(`student:${studentId}`).emit(event, payload);
const pushStudent = (s) => toMasters('student:update', publicStudent(s));

io.use((socket, next) => {
  const { role, token } = socket.handshake.auth || {};
  if (role === 'master' && masterTokens.has(token)) {
    socket.data.role = 'master';
    return next();
  }
  if (role === 'code' && isCodeAllToken(token)) {
    socket.data.role = 'code';
    socket.data.mailboxId = 'all';
    return next();
  }
  const box = role === 'code' && mailboxByToken(token);
  if (box) {
    socket.data.role = 'code';
    socket.data.mailboxId = box.id;
    return next();
  }
  const g = role === 'guest' && guestByToken(token);
  if (g) {
    socket.data.role = 'guest';
    socket.data.guestId = g.id;
    return next();
  }
  if (role === 'student') {
    const s = Object.values(state.students).find((x) => x.token === token);
    if (s) {
      socket.data.role = 'student';
      socket.data.studentId = s.id;
      return next();
    }
  }
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  if (socket.data.role === 'master') {
    socket.join('master');
    return;
  }
  if (socket.data.role === 'code') {
    socket.join(`mbox:${socket.data.mailboxId}`);
    return;
  }
  if (socket.data.role === 'guest') {
    const g = state.guests[socket.data.guestId];
    socket.join(`guest:${g?.courseId || 'all'}`);
    socket.join(`guestid:${socket.data.guestId}`);
    return;
  }
  const sid = socket.data.studentId;
  const s = state.students[sid];
  if (!s) return socket.disconnect(true);
  socket.join(`course:${s.courseId}`);
  socket.join(`student:${sid}`);
  online.set(sid, (online.get(sid) || 0) + 1);
  s.lastSeen = Date.now();
  pushStudent(s);

  socket.on('disconnect', () => {
    const n = (online.get(sid) || 1) - 1;
    if (n <= 0) online.delete(sid); else online.set(sid, n);
    const st = state.students[sid];
    if (st) {
      st.lastSeen = Date.now();
      saveState();
      pushStudent(st);
    }
  });
});

// ---------------------------------------------------------------------------
// 미들웨어
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '100kb' }));

function getToken(req, header) {
  return req.get(header) || req.query.t || '';
}
function requireMaster(req, res, next) {
  if (masterTokens.has(getToken(req, 'x-master-token'))) return next();
  res.status(401).json({ error: '교사 로그인이 필요합니다.' });
}
function requireStudent(req, res, next) {
  const token = getToken(req, 'x-student-token');
  const s = token && Object.values(state.students).find((x) => x.token === token);
  if (!s) return res.status(401).json({ error: '입장 정보가 없습니다. 다시 입장해 주세요.' });
  const c = state.courses[s.courseId];
  if (!c) return res.status(410).json({ error: '과목이 삭제되었습니다.' });
  req.student = s;
  req.course = c;
  next();
}

// 정적 파일 + 브라우저 라이브러리
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
const vendor = (route, file) => app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'node_modules', file)));
vendor('/vendor/jszip.min.js', 'jszip/dist/jszip.min.js');
vendor('/vendor/docx-preview.min.js', 'docx-preview/dist/docx-preview.min.js');
vendor('/vendor/pdf.min.mjs', 'pdfjs-dist/legacy/build/pdf.min.mjs');
vendor('/vendor/pdf.worker.min.mjs', 'pdfjs-dist/legacy/build/pdf.worker.min.mjs');

// QR 코드 입장 링크: /j/ABC123
app.get('/j/:code', (req, res) => res.redirect(`/student?code=${encodeURIComponent(normCode(req.params.code))}`));

// ---------------------------------------------------------------------------
// 공용 API
// ---------------------------------------------------------------------------
app.get('/api/public/config', (req, res) => {
  res.json({ siteTitle: state.siteTitle });
});

app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 500);
  if (!text) return res.status(400).end();
  const png = await QRCode.toBuffer(text, { width: 600, margin: 2, errorCorrectionLevel: 'M' });
  res.type('png').set('Cache-Control', 'public, max-age=3600').send(png);
});

function findCourseByCode(code) {
  code = normCode(code);
  return code && Object.values(state.courses).find((c) => c.code === code);
}

app.post('/api/join/check', (req, res) => {
  const c = findCourseByCode(req.body.code);
  if (!c) return res.status(404).json({ error: '입장 코드가 올바르지 않습니다.' });
  const count = studentsOf(c.id).length;
  res.json({
    siteTitle: state.siteTitle, courseName: c.name, open: c.open !== false,
    full: count >= c.maxStudents,
  });
});

// PIN: 4자리 숫자. 학생별 5회 틀리면 15분 잠금 + IP 당 15분에 30회 실패 시 차단 (추측 방지)
const PIN_RE = /^\d{4}$/;
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const pinIpFails = new Map(); // ip -> { count, since }
function pinIpBlocked(ip) {
  const f = pinIpFails.get(ip);
  if (f && Date.now() - f.since > PIN_LOCK_MS) pinIpFails.delete(ip);
  return (pinIpFails.get(ip)?.count || 0) >= 30;
}
function pinIpFail(ip) {
  const f = pinIpFails.get(ip) || { count: 0, since: Date.now() };
  f.count++;
  pinIpFails.set(ip, f);
  if (pinIpFails.size > 10000) pinIpFails.clear();
}
const ensureKey = (s) => { if (!s.key) { s.key = newToken(); saveState(); } return s.key; };
// 다른 기기에서 다시 들어오면 새 세션 토큰 발급 (이전 기기는 로그아웃)
function rotateSession(s) {
  s.token = newToken();
  io.in(`student:${s.id}`).disconnectSockets(true);
}

app.post('/api/join', (req, res) => {
  const c = findCourseByCode(req.body.code);
  if (!c) return res.status(404).json({ error: '입장 코드가 올바르지 않습니다.' });
  const name = cleanText(req.body.name, 30);
  if (!name) return res.status(400).json({ error: '이름을 입력해 주세요.' });
  const pin = String(req.body.pin ?? '');
  if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'PIN은 숫자 4자리로 입력해 주세요.' });
  const ip = req.ip || 'unknown';

  const list = studentsOf(c.id);
  const same = list.find((s) => s.name === name);
  if (same) {
    // 같은 이름 = 본인 재입장 시도 → PIN 확인 (수업이 끝났어도 본인은 들어와서 확인 가능)
    if (pinIpBlocked(ip)) return res.status(429).json({ error: '시도가 너무 많습니다. 15분 후 다시 시도하세요.' });
    if ((same.pinLockUntil || 0) > Date.now()) {
      return res.status(423).json({ error: 'PIN을 여러 번 틀려 잠겼습니다. 15분 후 다시 시도하거나 선생님께 초기화를 요청하세요.' });
    }
    if (same.pinHash && !verifyPassword(pin, same.pinHash)) {
      pinIpFail(ip);
      same.pinFails = (same.pinFails || 0) + 1;
      if (same.pinFails >= PIN_MAX_FAILS) { same.pinLockUntil = Date.now() + PIN_LOCK_MS; same.pinFails = 0; }
      saveState();
      pushStudent(same);
      const left = same.pinLockUntil > Date.now() ? 0 : PIN_MAX_FAILS - same.pinFails;
      return res.status(401).json({
        error: left ? `이미 같은 이름의 학생이 있습니다. 본인이면 PIN을 확인하세요 (남은 횟수 ${left}번). 본인이 아니면 이름 뒤에 숫자 등을 붙여 입장하세요.`
          : 'PIN을 여러 번 틀려 15분 동안 잠겼습니다. 선생님께 초기화를 요청할 수 있습니다.',
      });
    }
    // PIN 이 없던 학생(이전 버전 또는 교사가 초기화)은 이번에 입력한 PIN 으로 설정
    if (!same.pinHash) same.pinHash = hashPassword(pin);
    same.pinFails = 0;
    same.pinLockUntil = 0;
    rotateSession(same);
    ensureKey(same);
    saveState();
    pushStudent(same);
    return res.json({ token: same.token, studentId: same.id, key: same.key, reclaimed: true });
  }
  if (c.open === false) return res.status(403).json({ error: '현재 입장이 마감된 과목입니다.' });
  if (list.length >= c.maxStudents) return res.status(403).json({ error: `정원(${c.maxStudents}명)이 가득 찼습니다.` });

  const usedSeats = new Set(list.map((s) => s.seat));
  let seat = 1;
  while (usedSeats.has(seat)) seat++;
  const s = {
    id: newId(), courseId: c.id, name, seat, token: newToken(), key: newToken(), pinHash: hashPassword(pin),
    joinedAt: Date.now(), lastSeen: Date.now(), files: [],
  };
  state.students[s.id] = s;
  saveState();
  pushStudent(s);
  res.json({ token: s.token, studentId: s.id, key: s.key });
});

// 개인 입장 링크(/s/<key>): 입장 코드·이름·PIN 없이 본인 자리로 (기기 여러 대에서 같이 사용 가능)
app.get('/s/:key', (req, res) => res.redirect(`/student?k=${encodeURIComponent(req.params.key)}`));
app.post('/api/join/key', (req, res) => {
  const k = String(req.body?.key || '');
  const s = k && Object.values(state.students).find((x) => x.key === k);
  if (!s || !state.courses[s.courseId]) return res.status(404).json({ error: '개인 링크가 올바르지 않거나 다시 만들어졌습니다. 선생님께 새 링크를 받거나, 입장 코드와 이름·PIN으로 들어오세요.' });
  res.json({ token: s.token, studentId: s.id, key: s.key, code: state.courses[s.courseId].code });
});

// 교사: PIN 초기화(다음 입장 때 새로 정함) / 개인 링크 다시 만들기(예전 링크 무효)
app.post('/api/master/students/:id/reset-pin', requireMaster, (req, res) => {
  const s = state.students[req.params.id];
  if (!s) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  delete s.pinHash;
  s.pinFails = 0;
  s.pinLockUntil = 0;
  saveState();
  pushStudent(s);
  res.json({ ok: true });
});
app.post('/api/master/students/:id/regen-key', requireMaster, (req, res) => {
  const s = state.students[req.params.id];
  if (!s) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  s.key = newToken();
  rotateSession(s); // 예전 링크로 열어 둔 기기도 로그아웃
  saveState();
  pushStudent(s);
  res.json({ key: s.key });
});

// ---------------------------------------------------------------------------
// 학생 API
// ---------------------------------------------------------------------------
app.get('/api/student/me', requireStudent, (req, res) => {
  res.json({
    siteTitle: state.siteTitle,
    course: publicCourse(req.course),
    student: publicStudent(req.student),
    maxFileMB: MAX_FILE_MB,
    allowedExt: [...ALLOWED_EXT],
    canConvert,
    materials: materialsFor(req.student).map((m) => studentMaterial(m, req.student.id)),
  });
});

app.patch('/api/student/name', requireStudent, (req, res) => {
  const name = cleanText(req.body.name, 30);
  if (!name) return res.status(400).json({ error: '이름을 입력해 주세요.' });
  if (studentsOf(req.course.id).some((s) => s.id !== req.student.id && s.name === name)) {
    return res.status(409).json({ error: '같은 이름의 학생이 이미 있습니다.' });
  }
  req.student.name = name;
  saveState();
  pushStudent(req.student);
  res.json({ student: publicStudent(req.student) });
});

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(UPLOAD_DIR, req.course.id, req.student.id);
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename(req, file, cb) {
      // busboy 는 파일명을 latin1 로 해석하므로 UTF-8 로 복원 (한글 파일명)
      const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
      file.originalname = original.normalize('NFC');
      file.fileId = newId();
      const ext = extOf(original);
      cb(null, `${file.fileId}${ext ? '.' + ext : ''}`);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES_PER_UPLOAD },
  fileFilter(req, file, cb) {
    const ext = extOf(Buffer.from(file.originalname, 'latin1').toString('utf8'));
    if (!ALLOWED_EXT.has(ext)) return cb(Object.assign(new Error(`지원하지 않는 파일 형식입니다: .${ext || '?'}`), { status: 415 }));
    cb(null, true);
  },
});

app.post('/api/student/upload', requireStudent, (req, res) => {
  if (req.course.open === false) return res.status(403).json({ error: '제출이 마감되었습니다.' });
  upload.array('files', MAX_FILES_PER_UPLOAD)(req, res, (err) => {
    if (err) {
      for (const f of req.files || []) fs.rm(f.path, { force: true }, () => {});
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `파일 용량은 ${MAX_FILE_MB}MB 이하만 가능합니다.`
        : err.code === 'LIMIT_FILE_COUNT' ? `한 번에 ${MAX_FILES_PER_UPLOAD}개까지 업로드할 수 있습니다.`
          : err.message;
      return res.status(err.status || 400).json({ error: msg });
    }
    const s = req.student;
    for (const f of req.files || []) {
      s.files.push({
        id: f.fileId, name: f.originalname, ext: extOf(f.originalname), size: f.size,
        mime: f.mimetype, stored: path.relative(UPLOAD_DIR, f.path), uploadedAt: Date.now(),
      });
    }
    saveState();
    pushStudent(s);
    res.json({ student: publicStudent(s) });
    // 교사가 열어볼 때 바로 보이도록 문서는 미리 PDF 로 변환 (백그라운드, 순차 처리)
    if (canConvert) {
      for (const f of req.files || []) {
        if (CONVERTIBLE_EXT.has(extOf(f.originalname))) convertToPdf(f.path).catch(() => {});
      }
    }
  });
});

// 링크 제출: 파일 대신 주소만 저장 (ext 'link' 로 두면 화면에서 🔗 아이콘으로 표시됨)
app.post('/api/student/links', requireStudent, (req, res) => {
  if (req.course.open === false) return res.status(403).json({ error: '제출이 마감되었습니다.' });
  const url = normalizeUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: '올바른 인터넷 주소가 아닙니다. (예: https://docs.google.com/…)' });
  const s = req.student;
  s.files.push({
    id: newId(), kind: 'link', url, name: linkTitle(url, req.body?.title), ext: 'link', size: 0,
    mime: '', stored: null, uploadedAt: Date.now(),
  });
  saveState();
  pushStudent(s);
  res.json({ student: publicStudent(s) });
});

async function removeFileRecord(s, fileId) {
  const idx = s.files.findIndex((f) => f.id === fileId);
  if (idx < 0) return false;
  const [f] = s.files.splice(idx, 1);
  if (!f.stored) return true; // 링크
  const abs = path.join(UPLOAD_DIR, f.stored);
  await fsp.rm(abs, { force: true });
  await fsp.rm(abs + '.pdf', { force: true });
  return true;
}

app.delete('/api/student/files/:fileId', requireStudent, async (req, res) => {
  if (!(await removeFileRecord(req.student, req.params.fileId))) return res.status(404).json({ error: '파일이 없습니다.' });
  saveState();
  pushStudent(req.student);
  res.json({ student: publicStudent(req.student) });
});

// ---------------------------------------------------------------------------
// 파일 제공 (학생 본인 또는 교사)
// ---------------------------------------------------------------------------
function resolveFileAccess(req) {
  const fileId = req.params.fileId;
  const owner = Object.values(state.students).find((s) => s.files.some((f) => f.id === fileId));
  if (!owner) return null;
  const t = req.query.t || '';
  const g = guestByToken(t);
  const isMaster = masterTokens.has(t) || (g && guestSees(g, owner.courseId));
  if (!isMaster && owner.token !== t) return null;
  return { owner, file: owner.files.find((f) => f.id === fileId) };
}

app.get('/files/:fileId', (req, res) => {
  const a = resolveFileAccess(req);
  if (!a) return res.status(404).send('파일을 찾을 수 없습니다.');
  if (a.file.kind === 'link') return res.redirect(302, a.file.url);
  const abs = path.join(UPLOAD_DIR, a.file.stored);
  if (req.query.download) return res.download(abs, a.file.name);
  res.sendFile(abs, { headers: { 'Content-Type': a.file.mime || 'application/octet-stream' } });
});

// LibreOffice 로 문서를 PDF 로 변환 (순차 처리 + 결과 캐시)
let convertQueue = Promise.resolve();
const PROFILE_DIR = path.join(os.tmpdir(), 'lecture-board-lo-profile');
function convertToPdf(abs) {
  const out = abs + '.pdf';
  const job = convertQueue.then(async () => {
    if (fs.existsSync(out)) return out;
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'conv-'));
    try {
      await new Promise((resolve, reject) => {
        execFile(sofficePath, [
          `-env:UserInstallation=${pathToFileURL(PROFILE_DIR).href}`,
          '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmpDir, abs,
        ], { timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
      });
      const produced = path.join(tmpDir, path.basename(abs).replace(/\.[^.]+$/, '') + '.pdf');
      if (!fs.existsSync(produced)) throw new Error('변환 결과가 없습니다.');
      // 변환 중에 원본이 삭제됐으면 결과도 버림
      if (!fs.existsSync(abs)) throw new Error('원본이 삭제되었습니다.');
      await fsp.copyFile(produced, out);
      return out;
    } finally {
      fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
  convertQueue = job.catch(() => {});
  return job;
}

// 설치만 되어 있고 문서 모듈이 빠진 LibreOffice 도 있으므로 시작 시 실제 변환을 한 번 시험
let canConvert = false;
async function selfTestConvert() {
  if (!sofficePath) return;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-test-'));
  const file = path.join(dir, 'test.txt');
  await fsp.writeFile(file, 'test');
  try {
    await convertToPdf(file);
    canConvert = true;
  } catch { /* 변환 불가 */ }
  await fsp.rm(dir, { recursive: true, force: true });
  console.log(`    PDF 변환(LibreOffice): ${canConvert ? '사용 가능' : '사용 불가 — 문서는 브라우저 간이 미리보기로 표시'}`);
}

app.get('/files/:fileId/pdf', async (req, res) => {
  const a = resolveFileAccess(req);
  if (!a) return res.status(404).send('파일을 찾을 수 없습니다.');
  if (!canConvert || !CONVERTIBLE_EXT.has(a.file.ext)) return res.status(415).send('PDF 변환을 지원하지 않습니다.');
  try {
    const out = await convertToPdf(path.join(UPLOAD_DIR, a.file.stored));
    res.type('pdf').sendFile(out);
  } catch (e) {
    res.status(500).send('PDF 변환에 실패했습니다.');
  }
});

// ---------------------------------------------------------------------------
// 교사(마스터) API
// ---------------------------------------------------------------------------
// 로그인 무차별 대입 방지: 15분 동안 IP 당 10회, 전체 100회 실패 시 잠시 차단
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map(); // ip -> { count, since }
let globalFails = { count: 0, since: Date.now() };
function tooManyLoginFails(ip) {
  const now = Date.now();
  if (now - globalFails.since > LOGIN_WINDOW_MS) globalFails = { count: 0, since: now };
  const f = loginFails.get(ip);
  if (f && now - f.since > LOGIN_WINDOW_MS) loginFails.delete(ip);
  return (loginFails.get(ip)?.count || 0) >= 10 || globalFails.count >= 100;
}
function recordLoginFail(ip) {
  const f = loginFails.get(ip) || { count: 0, since: Date.now() };
  f.count++;
  loginFails.set(ip, f);
  globalFails.count++;
  if (loginFails.size > 10000) loginFails.clear();
}

app.post('/api/master/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (tooManyLoginFails(ip)) {
    return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도하세요.' });
  }
  if (!verifyPassword(req.body.password || '', state.passwordHash)) {
    recordLoginFail(ip);
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  loginFails.delete(ip);
  const token = newToken();
  masterTokens.add(token);
  res.json({ token });
});

app.post('/api/master/logout', requireMaster, (req, res) => {
  masterTokens.delete(getToken(req, 'x-master-token'));
  res.json({ ok: true });
});

app.post('/api/master/password', requireMaster, (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  state.passwordHash = hashPassword(pw);
  delete state.usingDefaultPassword;
  saveState();
  res.json({ ok: true });
});

app.get('/api/master/state', requireMaster, (req, res) => {
  res.json({
    siteTitle: state.siteTitle,
    courses: Object.values(state.courses).sort((a, b) => a.createdAt - b.createdAt).map(publicCourse),
    students: Object.values(state.students).map(publicStudent),
    materials: Object.values(state.materials).map(publicMaterial),
    publicUrl,
    publicUrlSource,
    lanUrls: lanUrls(),
    canConvert,
    usingDefaultPassword: !!state.usingDefaultPassword,
    maxFileMB: MAX_FILE_MB,
    inbox: inbox.map(publicInbox),
    guests: Object.values(state.guests).map(publicGuest),
    mailboxes: Object.values(state.mailboxes).map(publicMailbox),
    codeAllToken: ensureCodeAllToken(),
    inboxKey: ensureInboxKey(),
    inboxTtlMin: INBOX_TTL_MIN,
    inboxImap: imapStatus,
  });
});

app.patch('/api/master/site', requireMaster, (req, res) => {
  const title = cleanText(req.body.siteTitle, 60);
  if (!title) return res.status(400).json({ error: '홈페이지 이름을 입력해 주세요.' });
  state.siteTitle = title;
  saveState();
  toMasters('site:update', { siteTitle: title });
  io.emit('site:update', { siteTitle: title });
  res.json({ siteTitle: title });
});

const clampMax = (n) => Math.min(MAX_STUDENTS, Math.max(1, Math.round(Number(n) || 30)));

app.post('/api/master/courses', requireMaster, (req, res) => {
  const name = cleanText(req.body.name, 60) || '새 과목';
  const c = {
    id: newId(), name, code: newJoinCode(), maxStudents: clampMax(req.body.maxStudents),
    open: true, createdAt: Date.now(),
  };
  state.courses[c.id] = c;
  saveState();
  toMasters('course:update', publicCourse(c));
  res.json({ course: publicCourse(c) });
});

function getCourse(req, res) {
  const c = state.courses[req.params.id];
  if (!c) res.status(404).json({ error: '과목을 찾을 수 없습니다.' });
  return c;
}

app.patch('/api/master/courses/:id', requireMaster, (req, res) => {
  const c = getCourse(req, res);
  if (!c) return;
  if (req.body.name !== undefined) {
    const name = cleanText(req.body.name, 60);
    if (!name) return res.status(400).json({ error: '과목명을 입력해 주세요.' });
    c.name = name;
  }
  if (req.body.maxStudents !== undefined) {
    const n = clampMax(req.body.maxStudents);
    const registered = studentsOf(c.id);
    const maxSeat = registered.reduce((m, s) => Math.max(m, s.seat), 0);
    if (n < maxSeat) {
      return res.status(400).json({ error: `현재 ${maxSeat}번 자리까지 학생이 있어 ${maxSeat}명 미만으로 줄일 수 없습니다.` });
    }
    c.maxStudents = n;
  }
  if (req.body.open !== undefined) c.open = !!req.body.open;
  saveState();
  toMasters('course:update', publicCourse(c));
  toCourse(c.id, 'course:update', publicCourse(c));
  res.json({ course: publicCourse(c) });
});

app.post('/api/master/courses/:id/regen-code', requireMaster, (req, res) => {
  const c = getCourse(req, res);
  if (!c) return;
  c.code = newJoinCode();
  saveState();
  toMasters('course:update', publicCourse(c));
  res.json({ course: publicCourse(c) });
});

// 수업 시작: 새 입장 코드 발급 + 입장·제출 열기 (이미 입장한 학생은 그대로 유지)
app.post('/api/master/courses/:id/start', requireMaster, (req, res) => {
  const c = getCourse(req, res);
  if (!c) return;
  c.code = newJoinCode();
  c.open = true;
  c.sessionStartedAt = Date.now();
  c.sessionEndedAt = null;
  for (const m of materialsOfCourse(c.id)) {
    if (m.archived) continue;
    notifyMaterialTargets(m, 'material:remove', () => ({ id: m.id })); // 보관 전에 대상 학생에게 알림
    m.archived = true;
    toMasters('material:update', publicMaterial(m));
  }
  saveState();
  toMasters('course:update', publicCourse(c));
  toCourse(c.id, 'course:update', publicCourse(c));
  res.json({ course: publicCourse(c) });
});

// 수업 종료: 입장·제출 마감 (코드를 알아도 새로 들어오거나 제출할 수 없음)
app.post('/api/master/courses/:id/end', requireMaster, (req, res) => {
  const c = getCourse(req, res);
  if (!c) return;
  c.open = false;
  c.sessionEndedAt = Date.now();
  saveState();
  toMasters('course:update', publicCourse(c));
  toCourse(c.id, 'course:update', publicCourse(c));
  res.json({ course: publicCourse(c) });
});

async function removeStudent(s) {
  delete state.students[s.id];
  await fsp.rm(path.join(UPLOAD_DIR, s.courseId, s.id), { recursive: true, force: true });
  toStudent(s.id, 'kicked', {});
  io.in(`student:${s.id}`).disconnectSockets(true);
  online.delete(s.id);
  toMasters('student:remove', { id: s.id, courseId: s.courseId });
}

// 과목 초기화: 학생/파일 전부 삭제 (과목 설정은 유지)
app.post('/api/master/courses/:id/clear', requireMaster, async (req, res) => {
  const c = getCourse(req, res);
  if (!c) return;
  for (const s of studentsOf(c.id)) await removeStudent(s);
  await fsp.rm(path.join(UPLOAD_DIR, c.id), { recursive: true, force: true });
  // 보낸 자료는 과목 콘텐츠이므로 유지하고, 학생별 확인 기록과 개별 대상만 초기화
  for (const m of materialsOfCourse(c.id)) {
    m.seen = {};
    if (Array.isArray(m.target)) m.target = [];
    toMasters('material:update', publicMaterial(m));
  }
  saveState();
  res.json({ ok: true });
});

app.delete('/api/master/courses/:id', requireMaster, async (req, res) => {
  const c = getCourse(req, res);
  if (!c) return;
  for (const s of studentsOf(c.id)) await removeStudent(s);
  await fsp.rm(path.join(UPLOAD_DIR, c.id), { recursive: true, force: true });
  for (const m of materialsOfCourse(c.id)) delete state.materials[m.id];
  await fsp.rm(path.join(MATERIAL_DIR, c.id), { recursive: true, force: true });
  delete state.courses[c.id];
  for (const g of Object.values(state.guests)) if (g.courseId === c.id) dropGuest(g.id);
  saveState();
  toMasters('course:remove', { id: c.id });
  pushGuests();
  res.json({ ok: true });
});

app.delete('/api/master/students/:id', requireMaster, async (req, res) => {
  const s = state.students[req.params.id];
  if (!s) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  await removeStudent(s);
  saveState();
  res.json({ ok: true });
});

// 교사가 학생의 제출물을 확인함 → 이후 올라오는 파일만 NEW 로 표시
app.post('/api/master/students/:id/reviewed', requireMaster, (req, res) => {
  const s = state.students[req.params.id];
  if (!s) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  s.reviewedAt = Date.now();
  saveState();
  pushStudent(s);
  res.json({ ok: true });
});

app.delete('/api/master/students/:id/files/:fileId', requireMaster, async (req, res) => {
  const s = state.students[req.params.id];
  if (!s || !(await removeFileRecord(s, req.params.fileId))) return res.status(404).json({ error: '파일이 없습니다.' });
  saveState();
  pushStudent(s);
  toStudent(s.id, 'student:update', publicStudent(s));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 교사 → 학생 자료 보내기
//   kind:   'file'(파일) 또는 'link'(URL — 파일 없이 주소만 저장)
//   target: 'all'(과목 전체, 나중에 입장한 학생 포함) 또는 학생 id 배열
//   seen:   { studentId: 처음 연 시각 } — 교사 화면의 '확인' 표시
// ---------------------------------------------------------------------------
const materialsOfCourse = (courseId) => Object.values(state.materials).filter((m) => m.courseId === courseId);
// archived: 새 수업을 시작하면 지난 수업 자료는 학생 화면에서 내림 (교사 화면 '지난 수업 자료'에 보관, 다시 보내기 가능)
const canSeeMaterial = (m, s) => !m.archived && m.courseId === s.courseId && (m.target === 'all' || m.target.includes(s.id));
const materialsFor = (s) => Object.values(state.materials).filter((m) => canSeeMaterial(m, s)).sort((a, b) => b.createdAt - a.createdAt);

function publicMaterial(m) {
  return {
    id: m.id, courseId: m.courseId, kind: m.kind || 'file', url: m.url || null, name: m.name, ext: m.ext,
    size: m.size, mime: m.mime, note: m.note, target: m.target, createdAt: m.createdAt, seen: m.seen,
    archived: !!m.archived,
  };
}
function studentMaterial(m, studentId) {
  return {
    id: m.id, kind: m.kind || 'file', url: m.url || null, name: m.name, ext: m.ext, size: m.size, mime: m.mime,
    note: m.note, createdAt: m.createdAt, seenAt: m.seen[studentId] || null,
  };
}
// 대상 학생들에게만 실시간 알림 (전체 대상이면 과목 방 전체)
function notifyMaterialTargets(m, event, payloadFor) {
  if (m.target === 'all') {
    for (const s of studentsOf(m.courseId)) toStudent(s.id, event, payloadFor(s));
  } else {
    for (const id of m.target) if (state.students[id]) toStudent(id, event, payloadFor(state.students[id]));
  }
}

// 공유할 URL: http/https 만 허용 (javascript: 등 차단), 'naver.com' 처럼 입력하면 https:// 를 붙임
function normalizeUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s || s.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null; // 'abc' 같은 오타 방지
  return u.href;
}
function parseLinks(raw) {
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch { list = null; }
  if (!Array.isArray(list)) throw Object.assign(new Error('링크 형식이 올바르지 않습니다.'), { status: 400 });
  return list.slice(0, MAX_FILES_PER_UPLOAD).map((x) => {
    const url = normalizeUrl(x?.url);
    if (!url) throw Object.assign(new Error(`올바른 인터넷 주소가 아닙니다: ${String(x?.url ?? '').slice(0, 80)}`), { status: 400 });
    return { url, title: linkTitle(url, x?.title) };
  });
}
// 제목이 없으면 도메인+경로로 대신 (예: youtube.com/watch)
function linkTitle(url, title) {
  const u = new URL(url);
  let fallback = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  try { fallback = decodeURI(fallback); } catch { /* 그대로 사용 */ }
  return cleanText(title, 100) || fallback.slice(0, 100);
}

const materialUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(MATERIAL_DIR, req.course.id);
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename(req, file, cb) {
      const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
      file.originalname = original.normalize('NFC');
      file.fileId = newId();
      const ext = extOf(original);
      cb(null, `${file.fileId}${ext ? '.' + ext : ''}`);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES_PER_UPLOAD },
  fileFilter(req, file, cb) {
    const ext = extOf(Buffer.from(file.originalname, 'latin1').toString('utf8'));
    if (!ALLOWED_EXT.has(ext)) return cb(Object.assign(new Error(`지원하지 않는 파일 형식입니다: .${ext || '?'}`), { status: 415 }));
    cb(null, true);
  },
});

app.post('/api/master/courses/:id/materials', requireMaster, (req, res) => {
  const c = getCourse(req, res);
  if (!c) return;
  req.course = c;
  materialUpload.array('files', MAX_FILES_PER_UPLOAD)(req, res, (err) => {
    const cleanup = () => { for (const f of req.files || []) fs.rm(f.path, { force: true }, () => {}); };
    if (err) {
      cleanup();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `파일 용량은 ${MAX_FILE_MB}MB 이하만 가능합니다.`
        : err.code === 'LIMIT_FILE_COUNT' ? `한 번에 ${MAX_FILES_PER_UPLOAD}개까지 보낼 수 있습니다.`
          : err.message;
      return res.status(err.status || 400).json({ error: msg });
    }
    let links;
    try { links = parseLinks(req.body.links); } catch (e) { cleanup(); return res.status(e.status || 400).json({ error: e.message }); }
    if (!req.files?.length && !links.length) return res.status(400).json({ error: '보낼 파일이나 링크를 추가해 주세요.' });
    let target = 'all';
    if (req.body.target && req.body.target !== 'all') {
      let ids;
      try { ids = JSON.parse(req.body.target); } catch { ids = null; }
      ids = Array.isArray(ids) ? [...new Set(ids.map(String))].filter((id) => state.students[id]?.courseId === c.id) : [];
      if (!ids.length) { cleanup(); return res.status(400).json({ error: '받을 학생을 선택해 주세요.' }); }
      target = ids;
    }
    const note = cleanText(req.body.note, 300);
    const created = [];
    const records = [
      ...req.files.map((f) => ({
        id: f.fileId, courseId: c.id, kind: 'file', name: f.originalname, ext: extOf(f.originalname), size: f.size,
        mime: f.mimetype, stored: path.relative(DATA_DIR, f.path), note, target,
        createdAt: Date.now(), seen: {},
      })),
      ...links.map((l) => ({
        id: newId(), courseId: c.id, kind: 'link', url: l.url, name: l.title, ext: '', size: 0,
        mime: '', stored: null, note, target, createdAt: Date.now(), seen: {},
      })),
    ];
    for (const m of records) {
      state.materials[m.id] = m;
      created.push(m);
      toMasters('material:update', publicMaterial(m));
      notifyMaterialTargets(m, 'material:new', (st) => studentMaterial(m, st.id));
    }
    saveState();
    res.json({ materials: created.map(publicMaterial) });
    if (canConvert) {
      for (const m of created) if (CONVERTIBLE_EXT.has(m.ext)) convertToPdf(path.join(DATA_DIR, m.stored)).catch(() => {});
    }
  });
});

app.delete('/api/master/materials/:id', requireMaster, async (req, res) => {
  const m = state.materials[req.params.id];
  if (!m) return res.status(404).json({ error: '자료를 찾을 수 없습니다.' });
  delete state.materials[m.id];
  if (m.stored) {
    const abs = path.join(DATA_DIR, m.stored);
    await fsp.rm(abs, { force: true });
    await fsp.rm(abs + '.pdf', { force: true });
  }
  saveState();
  toMasters('material:remove', { id: m.id });
  notifyMaterialTargets(m, 'material:remove', () => ({ id: m.id }));
  res.json({ ok: true });
});

// 지난 수업 자료 다시 보내기: 학생 화면에 새 자료로 다시 나타남 (확인 기록 초기화)
app.post('/api/master/materials/:id/restore', requireMaster, (req, res) => {
  const m = state.materials[req.params.id];
  if (!m) return res.status(404).json({ error: '자료를 찾을 수 없습니다.' });
  m.archived = false;
  m.createdAt = Date.now();
  m.seen = {};
  if (Array.isArray(m.target)) m.target = m.target.filter((id) => state.students[id]);
  saveState();
  toMasters('material:update', publicMaterial(m));
  notifyMaterialTargets(m, 'material:new', (st) => studentMaterial(m, st.id));
  res.json({ material: publicMaterial(m) });
});

// 자료 파일: 교사 또는 대상 학생만. 학생이 처음 열면 확인 시각 기록 (nt=1 은 썸네일용, 기록 안 함)
function resolveMaterialAccess(req) {
  const m = state.materials[req.params.id];
  if (!m) return null;
  const t = req.query.t || '';
  if (masterTokens.has(t)) return { m };
  const g = guestByToken(t);
  if (g && guestSees(g, m.courseId)) return { m }; // 참관자가 열어도 학생 '확인'으로 치지 않음
  const s = Object.values(state.students).find((x) => x.token === t);
  if (!s || !canSeeMaterial(m, s)) return null;
  if (!req.query.nt && !m.seen[s.id]) {
    m.seen[s.id] = Date.now();
    saveState();
    toMasters('material:update', publicMaterial(m));
    toStudent(s.id, 'material:new', studentMaterial(m, s.id));
  }
  return { m };
}

app.get('/materials/:id', (req, res) => {
  const a = resolveMaterialAccess(req);
  if (!a) return res.status(404).send('자료를 찾을 수 없습니다.');
  // 링크: 확인 기록을 남긴 뒤 원래 주소로 이동
  if (a.m.kind === 'link') return res.redirect(302, a.m.url);
  const abs = path.join(DATA_DIR, a.m.stored);
  if (req.query.download) return res.download(abs, a.m.name);
  res.sendFile(abs, { headers: { 'Content-Type': a.m.mime || 'application/octet-stream' } });
});

app.get('/materials/:id/pdf', async (req, res) => {
  const a = resolveMaterialAccess(req);
  if (!a) return res.status(404).send('자료를 찾을 수 없습니다.');
  if (!canConvert || a.m.kind === 'link' || !CONVERTIBLE_EXT.has(a.m.ext)) return res.status(415).send('PDF 변환을 지원하지 않습니다.');
  try {
    res.type('pdf').sendFile(await convertToPdf(path.join(DATA_DIR, a.m.stored)));
  } catch {
    res.status(500).send('PDF 변환에 실패했습니다.');
  }
});

// ---------------------------------------------------------------------------
// 인증 메일 연결: 교사 Gmail 의 Apps Script 가 특정 메일(예: OpenAI 인증 메일)만 골라 보내면
// 교사 대시보드에 표시하고, 받는 주소가 학생이 등록한 '가입 메일'과 같으면 그 학생 화면에도 표시.
// 메일은 메모리에만 두고 INBOX_TTL_MIN 분 뒤 지운다.
// ---------------------------------------------------------------------------
const INBOX_TTL_MIN = 60;
const INBOX_MAX = 300;
let inbox = []; // 최신이 앞
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const normEmail = (s) => String(s ?? '').trim().toLowerCase();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 120;

function ensureInboxKey() {
  if (!state.inboxKey) { state.inboxKey = crypto.randomBytes(16).toString('hex'); saveState(); }
  return state.inboxKey;
}
function inboxKeyOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(ensureInboxKey());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const publicInbox = (m) => ({
  id: m.id, at: m.at, date: m.date, from: m.from, to: m.to, subject: m.subject, code: m.code, links: m.links, text: m.text,
});
const studentInbox = (m) => ({ id: m.id, at: m.at, date: m.date, subject: m.subject, code: m.code, links: m.links });

// 계정별 '코드 확인 링크': 과목·좌석과 상관없이, 등록한 주소로 온 코드만 그 링크에서 보임
//   mailboxes: { id: { id, address, label, token, createdAt } }
const publicMailbox = (b) => ({ id: b.id, address: b.address, label: b.label, token: b.token, createdAt: b.createdAt });
const mailboxByToken = (t) => (t ? Object.values(state.mailboxes).find((b) => b.token === t) : null);
// 통합 링크: 등록한 모든 계정의 코드를 한 화면에 (프로젝터용). 교사가 만들고 다시 만들 수 있음
const ensureCodeAllToken = () => { if (!state.codeAllToken) { state.codeAllToken = newToken(); saveState(); } return state.codeAllToken; };
const isCodeAllToken = (t) => !!t && t === state.codeAllToken;
const allMailboxInbox = () => {
  const boxes = Object.values(state.mailboxes);
  return inbox.map((m) => ({ m, b: boxes.find((x) => m.to.includes(x.address)) }))
    .filter((x) => x.b).map(({ m, b }) => ({ ...studentInbox(m), label: b.label, address: b.address }));
};
const mailboxInbox = (b) => inbox.filter((m) => m.to.includes(b.address)).map(studentInbox);
const pushMailboxes = () => toMasters('mailboxes:update', Object.values(state.mailboxes).map(publicMailbox));

// 메일 본문에서 인증 코드(6자리)와 인증용 링크만 추림
function parseInbound(b) {
  const id = cleanText(b?.id, 100);
  if (!id) return null;
  const subject = cleanText(b.subject, 200);
  const text = String(b.text ?? '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 8000);
  const to = [...new Set((String(b.to ?? '').match(EMAIL_RE) || []).map(normEmail))].slice(0, 10);
  const code = (subject.match(/\b(\d{6})\b/) || text.match(/\b(\d{6})\b/) || [])[1] || null;
  const links = [...new Set(text.match(/https:\/\/[^\s<>"'()[\]]+/g) || [])]
    .filter((u) => /verif|auth|login|log-in|confirm|magic|token|activate/i.test(u)).slice(0, 3);
  const at = Date.now();
  return { id, at, date: Number(b.date) || at, from: cleanText(b.from, 200), to, subject, code, links, text };
}

// Apps Script(POST /api/inbox) 와 IMAP(서버가 직접 확인) 두 경로 모두 여기로 들어옴
function ingestInbound(raw) {
  const m = parseInbound(raw);
  if (!m) return 'invalid';
  if (inbox.some((x) => x.id === m.id)) return 'duplicate';
  inbox.unshift(m);
  inbox.length = Math.min(inbox.length, INBOX_MAX);
  toMasters('inbox:new', publicInbox(m));
  for (const b of Object.values(state.mailboxes)) {
    if (!m.to.includes(b.address)) continue;
    io.to(`mbox:${b.id}`).emit('inbox:new', studentInbox(m));
    io.to('mbox:all').emit('inbox:new', { ...studentInbox(m), label: b.label, address: b.address });
    break;
  }
  return 'ok';
}
app.post('/api/inbox', (req, res) => {
  if (!inboxKeyOk(req.get('x-inbox-key'))) return res.status(401).json({ error: '연결 키가 올바르지 않습니다.' });
  const r = ingestInbound(req.body);
  if (r === 'invalid') return res.status(400).json({ error: '메일 형식이 올바르지 않습니다.' });
  res.json({ ok: true, duplicate: r === 'duplicate' });
});

// IMAP: 환경 변수 INBOX_IMAP_USER / INBOX_IMAP_PASSWORD 가 있으면 서버가 메일함을 30초마다 확인
let imapStatus = { configured: false };
startImapInbox({
  maxAgeMs: INBOX_TTL_MIN * 60000,
  onMessage: (raw) => ingestInbound(raw),
  onStatus: (st) => {
    const changed = st.ok !== imapStatus.ok || st.error !== imapStatus.error;
    imapStatus = st;
    if (changed) toMasters('inbox:imap', imapStatus);
    if (changed && st.configured) console.log(st.ok ? `    인증 메일(IMAP): ${st.user} 연결됨` : `    인증 메일(IMAP): ${st.error}`);
  },
});

setInterval(() => {
  const cut = Date.now() - INBOX_TTL_MIN * 60000;
  const gone = inbox.filter((m) => m.at < cut).map((m) => m.id);
  if (!gone.length) return;
  inbox = inbox.filter((m) => m.at >= cut);
  io.emit('inbox:remove', { ids: gone }); // id 만 보내므로 전체에 알려도 됨
}, 60000).unref();

// 계정 등록: 한 줄에 하나 "주소 이름" (이름은 선택). 이미 있는 주소는 이름만 갱신
app.post('/api/master/mailboxes', requireMaster, (req, res) => {
  const lines = String(req.body?.text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
  const bad = [];
  let added = 0;
  for (const line of lines) {
    const [first, ...rest] = line.split(/[\s,]+/);
    const address = normEmail(first);
    if (!isEmail(address)) { bad.push(first); continue; }
    const label = cleanText(rest.join(' '), 40);
    const old = Object.values(state.mailboxes).find((b) => b.address === address);
    if (old) { if (label) old.label = label; continue; }
    const b = { id: newId(), address, label: label || address.split('@')[0], token: newToken(), createdAt: Date.now() };
    state.mailboxes[b.id] = b;
    added++;
  }
  saveState();
  pushMailboxes();
  res.json({ added, bad, mailboxes: Object.values(state.mailboxes).map(publicMailbox) });
});
app.patch('/api/master/mailboxes/:id', requireMaster, (req, res) => {
  const b = state.mailboxes[req.params.id];
  if (!b) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  if (req.body?.label !== undefined) b.label = cleanText(req.body.label, 40) || b.label;
  if (req.body?.regen) {
    b.token = newToken(); // 링크가 샜을 때: 예전 링크는 바로 무효
    io.in(`mbox:${b.id}`).disconnectSockets(true);
  }
  saveState();
  pushMailboxes();
  res.json({ mailbox: publicMailbox(b) });
});
app.delete('/api/master/mailboxes/:id', requireMaster, (req, res) => {
  const b = state.mailboxes[req.params.id];
  if (!b) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  delete state.mailboxes[b.id];
  io.in(`mbox:${b.id}`).disconnectSockets(true);
  saveState();
  pushMailboxes();
  res.json({ ok: true });
});
// 학생용 코드 확인 페이지 데이터 (/code/:token)
app.post('/api/master/mailboxes/all-link/regen', requireMaster, (req, res) => {
  state.codeAllToken = newToken();
  io.in('mbox:all').disconnectSockets(true);
  saveState();
  toMasters('mailboxes:all', { codeAllToken: state.codeAllToken });
  res.json({ codeAllToken: state.codeAllToken });
});
app.get('/api/code/:token', (req, res) => {
  if (isCodeAllToken(req.params.token)) {
    return res.json({ siteTitle: state.siteTitle, all: true, label: '전체 계정', address: `${Object.keys(state.mailboxes).length}개 계정`, ttlMin: INBOX_TTL_MIN, inbox: allMailboxInbox() });
  }
  const b = mailboxByToken(req.params.token);
  if (!b) return res.status(404).json({ error: '링크가 올바르지 않거나 다시 만들어졌습니다. 선생님께 새 링크를 받아 주세요.' });
  res.json({ siteTitle: state.siteTitle, label: b.label, address: b.address, ttlMin: INBOX_TTL_MIN, inbox: mailboxInbox(b) });
});
app.get('/code/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'code.html')));

app.post('/api/master/inbox/regen-key', requireMaster, (req, res) => {
  state.inboxKey = crypto.randomBytes(16).toString('hex');
  saveState();
  toMasters('inbox:config', { inboxKey: state.inboxKey });
  res.json({ inboxKey: state.inboxKey });
});
app.delete('/api/master/inbox/:id', requireMaster, (req, res) => {
  inbox = inbox.filter((m) => m.id !== req.params.id);
  toMasters('inbox:remove', { ids: [req.params.id] });
  io.emit('inbox:remove', { ids: [req.params.id] });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 참관(게스트) 링크 관리 + 참관자용 읽기 전용 상태
// ---------------------------------------------------------------------------
const publicGuest = (g) => ({ id: g.id, token: g.token, label: g.label, courseId: g.courseId, createdAt: g.createdAt, expiresAt: g.expiresAt });
const pushGuests = () => toMasters('guests:update', Object.values(state.guests).map(publicGuest));
function dropGuest(id) {
  delete state.guests[id];
  io.in(`guestid:${id}`).disconnectSockets(true);
}

app.post('/api/master/guests', requireMaster, (req, res) => {
  const courseId = req.body?.courseId || null;
  if (courseId && !state.courses[courseId]) return res.status(404).json({ error: '과목을 찾을 수 없습니다.' });
  const hours = Math.min(24 * 30, Math.max(1, Math.round(Number(req.body?.hours) || 24)));
  const g = {
    id: newId(), token: newToken(), label: cleanText(req.body?.label, 40) || '참관자',
    courseId, createdAt: Date.now(), expiresAt: Date.now() + hours * 3600000,
  };
  state.guests[g.id] = g;
  saveState();
  pushGuests();
  res.json({ guest: publicGuest(g) });
});
app.delete('/api/master/guests/:id', requireMaster, (req, res) => {
  if (!state.guests[req.params.id]) return res.status(404).json({ error: '링크를 찾을 수 없습니다.' });
  dropGuest(req.params.id);
  saveState();
  pushGuests();
  res.json({ ok: true });
});
// 만료된 링크 정리 (접속 중인 참관자도 끊음)
setInterval(() => {
  const expired = Object.values(state.guests).filter((g) => g.expiresAt <= Date.now());
  if (!expired.length) return;
  for (const g of expired) dropGuest(g.id);
  saveState();
  pushGuests();
}, 60000).unref();

app.get('/api/guest/state', (req, res) => {
  const g = guestByToken(getToken(req, 'x-master-token'));
  if (!g) return res.status(401).json({ error: '참관 링크가 만료되었거나 취소되었습니다.' });
  const courses = Object.values(state.courses).filter((c) => guestSees(g, c.id));
  const ids = new Set(courses.map((c) => c.id));
  res.json({
    guest: { label: g.label, courseId: g.courseId, expiresAt: g.expiresAt },
    siteTitle: state.siteTitle,
    courses: courses.sort((a, b) => a.createdAt - b.createdAt).map(publicCourse),
    students: Object.values(state.students).filter((s) => ids.has(s.courseId)).map((s) => guestStudent(publicStudent(s))),
    materials: Object.values(state.materials).filter((m) => ids.has(m.courseId)).map(publicMaterial),
    publicUrl,
    publicUrlSource,
    lanUrls: lanUrls(),
    canConvert,
    usingDefaultPassword: false,
    maxFileMB: MAX_FILE_MB,
  });
});

// ---------------------------------------------------------------------------
// ZIP 다운로드 (학생별 폴더로 정리)
// ---------------------------------------------------------------------------
function studentFolder(s) {
  return safeFsName(`${String(s.seat).padStart(2, '0')}_${s.name}`);
}
function appendStudentFiles(archive, s, prefix) {
  const used = new Set();
  const links = s.files.filter((f) => f.kind === 'link');
  if (links.length) {
    const text = links.map((f) => `${f.name}\r\n${f.url}\r\n`).join('\r\n');
    archive.append('\ufeff' + text, { name: `${prefix}링크.txt` });
    used.add('링크.txt');
  }
  for (const f of s.files) {
    if (f.kind === 'link') continue;
    let name = safeFsName(f.name);
    const base = name.replace(/(\.[^.]*)?$/, '');
    const ext = name.slice(base.length);
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})${ext}`;
    used.add(name.toLowerCase());
    const abs = path.join(UPLOAD_DIR, f.stored);
    if (fs.existsSync(abs)) archive.file(abs, { name: `${prefix}${name}`, date: new Date(f.uploadedAt) });
  }
}
function sendZip(res, zipName, fill) {
  res.attachment(zipName);
  // 이미 압축된 미디어가 대부분이라 빠른 압축 레벨 사용
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', (err) => { console.error(err); res.destroy(err); });
  archive.pipe(res);
  fill(archive);
  archive.finalize();
}
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

app.get('/api/master/courses/:id/zip', requireMaster, (req, res) => {
  const c = getCourse(req, res);
  if (!c) return;
  const courseName = safeFsName(c.name);
  sendZip(res, `${courseName}_과제_${stamp()}.zip`, (archive) => {
    const list = studentsOf(c.id);
    for (const s of list) {
      if (s.files.length) appendStudentFiles(archive, s, `${courseName}/${studentFolder(s)}/`);
    }
    const summary = ['자리,이름,제출 파일 수,파일 목록']
      .concat(list.map((s) => [s.seat, s.name, s.files.length, s.files.map((f) => (f.kind === 'link' ? `${f.name} (${f.url})` : f.name)).join(' | ')]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
      .join('\r\n');
    archive.append('﻿' + summary, { name: `${courseName}/제출현황.csv` });
  });
});

app.get('/api/master/students/:id/zip', requireMaster, (req, res) => {
  const s = state.students[req.params.id];
  if (!s) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  const folder = studentFolder(s);
  sendZip(res, `${folder}_${stamp()}.zip`, (archive) => appendStudentFiles(archive, s, `${folder}/`));
});

// ---------------------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || '서버 오류' });
});

/** 외부 접속 주소(예: Cloudflare 터널)를 실행 중에 변경하고 대시보드에 알림 */
function setPublicUrl(url, source = 'tunnel') {
  publicUrl = url ? String(url).replace(/\/+$/, '') : ENV_PUBLIC_URL;
  publicUrlSource = url ? source : (ENV_PUBLIC_URL ? 'env' : null);
  toMasters('config:update', { publicUrl, publicUrlSource });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✖ ${PORT}번 포트를 이미 사용 중입니다. 과제 제출 보드가 이미 실행 중인지 확인하세요.`);
    console.error('    (다른 포트로 실행하려면 PORT 환경 변수를 지정하세요)\n');
    process.exit(1);
  }
  throw err;
});

// 정상 종료: 재배포·재시작 시 Railway 등이 보내는 SIGTERM 을 받으면
// 저장을 마치고 접속을 정리한 뒤 오류 없이(exit 0) 종료
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ■ ${signal} 수신 — 저장 후 서버를 종료합니다.`);
  try { flushState(); } catch (e) { console.error('상태 저장 실패:', e); }
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

let markReady;
const ready = new Promise((resolve) => { markReady = resolve; });

server.listen(PORT, () => {
  console.log(`\n  ▶ 실시간 과제 제출 보드 실행 중`);
  console.log(`    교사 대시보드 : http://localhost:${PORT}/master`);
  for (const u of lanUrls()) console.log(`    같은 Wi-Fi 접속: ${u}`);
  if (state.usingDefaultPassword) console.log(`    ⚠ 기본 교사 비밀번호(${DEFAULT_PASSWORD}) 사용 중 — 로그인 후 변경하세요.`);
  if (sofficePath) selfTestConvert();
  else console.log('    PDF 변환(LibreOffice): 미설치 — 문서는 브라우저 간이 미리보기로 표시');
  markReady();
});

module.exports = { app, server, ready, setPublicUrl, PORT };
