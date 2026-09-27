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
const CONVERTIBLE_EXT = new Set(['doc', 'docx', 'ppt', 'pptx', 'pps', 'ppsx', 'xls', 'xlsx', 'hwp', 'hwpx']);

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
    return s;
  } catch {
    return {
      siteTitle: '실시간 과제 제출 보드',
      passwordHash: null,
      courses: {},
      students: {},
    };
  }
}
const state = loadState();
// 환경변수 MASTER_PASSWORD 가 있으면 항상 우선
if (process.env.MASTER_PASSWORD) {
  state.passwordHash = hashPassword(process.env.MASTER_PASSWORD);
  delete state.usingDefaultPassword;
} else if (!state.passwordHash) {
  state.passwordHash = hashPassword(DEFAULT_PASSWORD);
  state.usingDefaultPassword = true;
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
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
    id: f.id, name: f.name, ext: f.ext, size: f.size, mime: f.mime,
    uploadedAt: f.uploadedAt,
  };
}
function publicStudent(s) {
  return {
    id: s.id, courseId: s.courseId, name: s.name, seat: s.seat,
    joinedAt: s.joinedAt, lastSeen: s.lastSeen,
    online: (online.get(s.id) || 0) > 0,
    files: s.files.map(publicFile),
  };
}
function publicCourse(c) {
  return {
    id: c.id, name: c.name, code: c.code, maxStudents: c.maxStudents,
    open: c.open !== false, createdAt: c.createdAt,
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

const toMasters = (event, payload) => io.to('master').emit(event, payload);
const toCourse = (courseId, event, payload) => io.to(`course:${courseId}`).emit(event, payload);
const toStudent = (studentId, event, payload) => io.to(`student:${studentId}`).emit(event, payload);
const pushStudent = (s) => toMasters('student:update', publicStudent(s));

io.use((socket, next) => {
  const { role, token } = socket.handshake.auth || {};
  if (role === 'master' && masterTokens.has(token)) {
    socket.data.role = 'master';
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

app.post('/api/join', (req, res) => {
  const c = findCourseByCode(req.body.code);
  if (!c) return res.status(404).json({ error: '입장 코드가 올바르지 않습니다.' });
  if (c.open === false) return res.status(403).json({ error: '현재 입장이 마감된 과목입니다.' });
  const name = cleanText(req.body.name, 30);
  if (!name) return res.status(400).json({ error: '이름을 입력해 주세요.' });

  const list = studentsOf(c.id);
  const same = list.find((s) => s.name === name);
  if (same) {
    if (!req.body.reclaim) {
      return res.status(409).json({ error: '이미 같은 이름으로 등록된 학생이 있습니다.', canReclaim: !online.get(same.id) });
    }
    if (online.get(same.id)) {
      return res.status(409).json({ error: '같은 이름의 학생이 현재 접속 중입니다. 다른 이름을 사용해 주세요.', canReclaim: false });
    }
    // 본인 재입장: 새 토큰 발급 (이전 기기 세션은 무효화)
    same.token = newToken();
    saveState();
    return res.json({ token: same.token, studentId: same.id });
  }
  if (list.length >= c.maxStudents) return res.status(403).json({ error: `정원(${c.maxStudents}명)이 가득 찼습니다.` });

  const usedSeats = new Set(list.map((s) => s.seat));
  let seat = 1;
  while (usedSeats.has(seat)) seat++;
  const s = {
    id: newId(), courseId: c.id, name, seat, token: newToken(),
    joinedAt: Date.now(), lastSeen: Date.now(), files: [],
  };
  state.students[s.id] = s;
  saveState();
  pushStudent(s);
  res.json({ token: s.token, studentId: s.id });
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
  });
});

async function removeFileRecord(s, fileId) {
  const idx = s.files.findIndex((f) => f.id === fileId);
  if (idx < 0) return false;
  const [f] = s.files.splice(idx, 1);
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
  const isMaster = masterTokens.has(t);
  if (!isMaster && owner.token !== t) return null;
  return { owner, file: owner.files.find((f) => f.id === fileId) };
}

app.get('/files/:fileId', (req, res) => {
  const a = resolveFileAccess(req);
  if (!a) return res.status(404).send('파일을 찾을 수 없습니다.');
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
    publicUrl,
    publicUrlSource,
    lanUrls: lanUrls(),
    canConvert,
    usingDefaultPassword: !!state.usingDefaultPassword,
    maxFileMB: MAX_FILE_MB,
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
  saveState();
  res.json({ ok: true });
});

app.delete('/api/master/courses/:id', requireMaster, async (req, res) => {
  const c = getCourse(req, res);
  if (!c) return;
  for (const s of studentsOf(c.id)) await removeStudent(s);
  await fsp.rm(path.join(UPLOAD_DIR, c.id), { recursive: true, force: true });
  delete state.courses[c.id];
  saveState();
  toMasters('course:remove', { id: c.id });
  res.json({ ok: true });
});

app.delete('/api/master/students/:id', requireMaster, async (req, res) => {
  const s = state.students[req.params.id];
  if (!s) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  await removeStudent(s);
  saveState();
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
// ZIP 다운로드 (학생별 폴더로 정리)
// ---------------------------------------------------------------------------
function studentFolder(s) {
  return safeFsName(`${String(s.seat).padStart(2, '0')}_${s.name}`);
}
function appendStudentFiles(archive, s, prefix) {
  const used = new Set();
  for (const f of s.files) {
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
      .concat(list.map((s) => [s.seat, s.name, s.files.length, s.files.map((f) => f.name).join(' | ')]
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
