import {
  $, $$, h, api, toast, formatBytes, timeAgo, clock, iconOf, kindOf, confirmDialog, promptDialog,
} from './common.js';
import { renderPreview, thumbFor } from './preview.js';

const CONVERTIBLE = new Set(['doc', 'docx', 'ppt', 'pptx', 'pps', 'ppsx', 'xls', 'xlsx', 'hwp', 'hwpx']);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 무시 */ } },
};

let token = store.get('lb_master');
let S = null; // 서버 상태
const students = new Map(); // id -> student
let courseId = store.get('lb_course');
let filter = 'all';
let hideEmpty = store.get('lb_hide_empty') === '1';
let query = '';
let socket = null;
let detailId = null;
let detailFileId = null;

const H = () => ({ 'x-master-token': token });
const fileUrl = (f, dl) => `/files/${f.id}?t=${encodeURIComponent(token)}${dl ? '&download=1' : ''}`;
const course = () => S?.courses.find((c) => c.id === courseId);
const courseStudents = () => [...students.values()].filter((s) => s.courseId === courseId).sort((a, b) => a.seat - b.seat);

// ------------------------------------------------------------ 로그인
init();
async function init() {
  api('/api/public/config').then((c) => { $('#loginSite').textContent = c.siteTitle; }).catch(() => {});
  if (token) {
    try { await loadState(); return showDash(); } catch { token = null; store.set('lb_master', null); }
  }
  $('#loginView').classList.remove('hidden');
  $('#pw').focus();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/master/login', { method: 'POST', body: { password: $('#pw').value } });
    token = r.token;
    store.set('lb_master', token);
    await loadState();
    $('#loginView').classList.add('hidden');
    showDash();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => {
  if (!(await confirmDialog('로그아웃할까요?'))) return;
  api('/api/master/logout', { method: 'POST', headers: H() }).catch(() => {});
  store.set('lb_master', null);
  location.reload();
});

async function loadState() {
  S = await api('/api/master/state', { headers: H() });
  students.clear();
  for (const s of S.students) students.set(s.id, s);
  if (!course()) courseId = S.courses[0]?.id || null;
}

function showDash() {
  $('#dashView').classList.remove('hidden');
  $('#pwNotice').classList.toggle('hidden', !S.usingDefaultPassword);
  renderAll();
  connectSocket();
  window.addEventListener('resize', layoutGrid);
  setInterval(() => renderGrid(), 30000); // "n분 전" 표시 갱신
}

function connectSocket() {
  socket = io({ auth: { role: 'master', token } });
  socket.on('connect_error', async () => {
    // 서버 재시작 등으로 로그인 토큰이 사라진 경우
    try { await api('/api/master/state', { headers: H() }); } catch (e) { if (e.status === 401) { store.set('lb_master', null); location.reload(); } }
  });
  socket.on('connect', async () => { await loadState(); renderAll(); });
  socket.on('student:update', (s) => {
    const prev = students.get(s.id);
    students.set(s.id, s);
    if (s.courseId !== courseId) return;
    if (!prev) toast(`${s.seat}번 ${s.name} 학생이 입장했습니다.`);
    else if (s.files.length > prev.files.length) toast(`📥 ${s.seat}번 ${s.name} — 새 파일 ${s.files.length - prev.files.length}개 제출`, 'ok');
    const flash = !prev || s.files.length !== prev.files.length;
    updateSeat(s, flash);
    renderStats();
    if (detailId === s.id) renderDetail();
  });
  socket.on('student:remove', ({ id, courseId: cid }) => {
    students.delete(id);
    if (cid === courseId) { renderGrid(); renderStats(); }
    if (detailId === id) closeDetail();
  });
  socket.on('course:update', (c) => {
    const i = S.courses.findIndex((x) => x.id === c.id);
    if (i >= 0) S.courses[i] = c; else S.courses.push(c);
    renderCourseSelect();
    if (c.id === courseId) { renderCourseBar(); renderGrid(); }
  });
  socket.on('course:remove', ({ id }) => {
    S.courses = S.courses.filter((c) => c.id !== id);
    if (courseId === id) courseId = S.courses[0]?.id || null;
    renderAll();
  });
  socket.on('config:update', ({ publicUrl, publicUrlSource }) => {
    S.publicUrl = publicUrl;
    S.publicUrlSource = publicUrlSource;
    if (publicUrlSource === 'tunnel') toast('🌐 외부 접속 주소가 준비되었습니다. QR 코드에 자동 반영됩니다.', 'ok', 4000);
    if (!$('#joinModal').classList.contains('hidden')) openJoin();
  });
  socket.on('site:update', ({ siteTitle }) => { S.siteTitle = siteTitle; renderSiteTitle(); });
}

// ------------------------------------------------------------ 렌더링
function renderAll() {
  store.set('lb_course', courseId);
  renderSiteTitle();
  renderCourseSelect();
  renderCourseBar();
  renderGrid();
}
function renderSiteTitle() {
  $('#siteTitle').textContent = S.siteTitle;
  document.title = `교사 대시보드 · ${S.siteTitle}`;
}
function renderCourseSelect() {
  const sel = $('#courseSelect');
  sel.innerHTML = '';
  for (const c of S.courses) sel.append(h('option', { value: c.id, selected: c.id === courseId }, c.name));
  sel.classList.toggle('hidden', !S.courses.length);
}
$('#courseSelect').addEventListener('change', (e) => { courseId = e.target.value; query = ''; $('#search').value = ''; renderAll(); });

function renderCourseBar() {
  const c = course();
  $('#courseBar').classList.toggle('hidden', !c);
  $('#noCourse').classList.toggle('hidden', !!c);
  $('#joinInfoBtn').disabled = !c;
  $('#zipAllBtn').disabled = !c;
  if (!c) return;
  $('#courseName').textContent = c.name;
  $('#courseCode').textContent = c.code;
  $('#closedBadge').classList.toggle('hidden', c.open);
  renderStats();
}
function renderStats() {
  const c = course();
  if (!c) return;
  const list = courseStudents();
  const on = list.filter((s) => s.online).length;
  const done = list.filter((s) => s.files.length).length;
  const files = list.reduce((n, s) => n + s.files.length, 0);
  const stat = (label, val, cls = '') => h('div', { class: `stat ${cls}` }, label, h('b', {}, val));
  $('#stats').replaceChildren(
    stat('정원', c.maxStudents),
    stat('등록', list.length),
    stat('접속중', on, 'ok'),
    stat('제출 완료', done, 'ok'),
    stat('미제출', list.length - done, 'warn'),
    stat('전체 파일', files),
  );
}

// 필터/검색
$('#search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderGrid(); });
$('#filterSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.f;
  $$('#filterSeg button').forEach((x) => x.classList.toggle('active', x === b));
  renderGrid();
});
$('#hideEmpty').checked = hideEmpty;
$('#hideEmpty').addEventListener('change', (e) => {
  hideEmpty = e.target.checked;
  store.set('lb_hide_empty', hideEmpty ? '1' : null);
  renderGrid();
});
function matches(s) {
  if (filter === 'online' && !s.online) return false;
  if (filter === 'done' && !s.files.length) return false;
  if (filter === 'none' && s.files.length) return false;
  if (!query) return true;
  return s.name.toLowerCase().includes(query) || String(s.seat) === query
    || s.files.some((f) => f.name.toLowerCase().includes(query));
}
function highlight(text) {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return text;
  return [text.slice(0, i), h('mark', {}, text.slice(i, i + query.length)), text.slice(i + query.length)];
}

// 좌석 그리드: 정원에 맞춰 자리 생성, 등록 학생은 자기 자리에 표시
function renderGrid() {
  const c = course();
  const grid = $('#seatGrid');
  grid.innerHTML = '';
  if (!c) return;
  const bySeat = new Map(courseStudents().map((s) => [s.seat, s]));
  const filtering = filter !== 'all' || !!query;
  let shown = 0;
  for (let seat = 1; seat <= c.maxStudents; seat++) {
    const s = bySeat.get(seat);
    if (!s && (filtering || hideEmpty)) continue;
    if (s && filtering && !matches(s)) continue;
    grid.append(s ? seatBox(s) : emptySeat(seat));
    shown++;
  }
  $('#noMatch').classList.toggle('hidden', shown > 0 || !filtering);
  layoutGrid();
}

function emptySeat(seat) {
  return h('div', { class: 'seat empty', 'data-seat': seat },
    h('div', { class: 'seat-top' }, h('span', { class: 'seat-no' }, seat)),
    h('div', { class: 'seat-body' }, '빈 자리'));
}

function seatBox(s) {
  const files = [...s.files].sort((a, b) => b.uploadedAt - a.uploadedAt);
  const latest = files[0];
  // 썸네일은 가장 최근 이미지/영상 우선
  const visual = files.find((f) => ['image', 'video'].includes(kindOf(f.ext)) && f.ext !== 'heic') || latest;
  const cls = ['seat', s.online ? 'online' : 'offline', files.length ? 'done' : ''].join(' ');
  return h('div', { class: cls, 'data-seat': s.seat, 'data-id': s.id, onclick: () => openDetail(s.id), title: `${s.name} — 클릭하여 크게 보기` },
    h('div', { class: 'seat-top' },
      h('span', { class: 'seat-no' }, s.seat),
      h('span', { class: `dot ${s.online ? 'on' : ''}` }),
      h('span', { class: 'seat-name' }, highlight(s.name))),
    h('div', { class: 'seat-body' },
      visual ? thumbFor(visual, fileUrl(visual)) : h('div', { class: 'seat-waiting' }, s.online ? '작업 중…' : '미접속'),
      files.length ? h('span', { class: 'seat-count' }, `${files.length}개`) : null),
    h('div', { class: 'seat-foot' },
      files.length ? h('span', { class: 'st-done' }, '✔ 제출') : h('span', { class: 'st-none' }, '미제출'),
      h('span', {}, latest ? timeAgo(latest.uploadedAt) : s.online ? '접속중' : `접속 ${timeAgo(s.lastSeen)}`)));
}

function updateSeat(s, flash) {
  const old = $(`#seatGrid [data-seat="${s.seat}"]`);
  const filtering = filter !== 'all' || !!query;
  if (!old || (filtering && !matches(s))) return renderGrid();
  const box = seatBox(s);
  old.replaceWith(box);
  if (flash) box.classList.add('flash');
}

// 정원/화면 크기에 맞춰 열 수와 박스 높이를 자동 계산
// 한 화면에 모두 들어오는 배치 중 가장 큰 박스를 고르고, 너무 작아지면 최소 크기를 유지한 채 스크롤
const MIN_BOX_H = 140;
function layoutGrid() {
  const grid = $('#seatGrid');
  const n = grid.children.length;
  if (!n) return;
  const gap = 10;
  const W = grid.clientWidth;
  const top = grid.getBoundingClientRect().top + window.scrollY;
  const Havail = Math.max(300, window.innerHeight - top - 24);
  let best;
  if (W < 560) {
    best = { cols: W < 360 ? 1 : 2, boxH: 170 };
  } else {
    let fallback = null;
    for (let cols = 1; cols <= Math.min(n, 12); cols++) {
      const w = (W - gap * (cols - 1)) / cols;
      if (w < 140) break;
      const rows = Math.ceil(n / cols);
      const boxH = Math.min(w * 0.9, (Havail - gap * (rows - 1)) / rows, 300);
      if (boxH >= MIN_BOX_H && (!best || boxH > best.boxH)) best = { cols, boxH };
      fallback = { cols, boxH: Math.min(w * 0.9, 220) }; // 가장 많은 열 수
    }
    best ||= fallback || { cols: 1, boxH: 180 };
  }
  grid.style.setProperty('--cols', best.cols);
  grid.style.setProperty('--box-h', `${Math.floor(Math.max(best.boxH, MIN_BOX_H))}px`);
}

// ------------------------------------------------------------ 학생 크게 보기
function openDetail(id) {
  detailId = id;
  detailFileId = null;
  $('#detailModal').classList.remove('hidden');
  renderDetail();
}
function closeDetail() {
  detailId = null;
  $('#detailModal').classList.add('hidden');
  const box = $('#dpBox');
  box._token = null;
  box.querySelectorAll('video, audio').forEach((m) => m.pause());
  box.innerHTML = '';
}
function stepDetail(dir) {
  const list = courseStudents().filter(matches);
  const i = list.findIndex((s) => s.id === detailId);
  const next = list[(i + dir + list.length) % list.length];
  if (next && next.id !== detailId) openDetail(next.id);
}
$('#dClose').addEventListener('click', closeDetail);
$('#dPrev').addEventListener('click', () => stepDetail(-1));
$('#dNext').addEventListener('click', () => stepDetail(1));
$('#detailModal').addEventListener('click', (e) => { if (e.target.id === 'detailModal') closeDetail(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDetail(); closeModal('#joinModal'); closeModal('#settingsModal'); }
  if (detailId && !e.target.closest('input, textarea, select')) {
    if (e.key === 'ArrowLeft') stepDetail(-1);
    if (e.key === 'ArrowRight') stepDetail(1);
  }
});

function renderDetail() {
  const s = students.get(detailId);
  if (!s) return closeDetail();
  $('#dSeat').textContent = `${s.seat}번`;
  $('#dSeat').className = 'seat-no';
  $('#dDot').className = `dot ${s.online ? 'on' : ''}`;
  $('#dName').textContent = s.name;
  $('#dSub').textContent = `${s.online ? '접속중' : `마지막 접속 ${timeAgo(s.lastSeen)}`} · 입장 ${clock(s.joinedAt)} · 파일 ${s.files.length}개`;
  $('#dZip').href = `/api/master/students/${s.id}/zip?t=${encodeURIComponent(token)}`;
  $('#dZip').classList.toggle('hidden', !s.files.length);

  const files = [...s.files].sort((a, b) => b.uploadedAt - a.uploadedAt);
  const list = $('#dFiles');
  list.innerHTML = '';
  if (!files.length) list.append(h('p', { class: 'muted center' }, '아직 제출한 파일이 없습니다.'));
  if (!files.some((f) => f.id === detailFileId)) {
    detailFileId = files[0]?.id || null;
    showFile(s, files[0]);
  }
  for (const f of files) {
    const k = kindOf(f.ext);
    const thumb = k === 'image' && f.ext !== 'heic' ? h('img', { src: fileUrl(f), alt: '', loading: 'lazy' })
      : k === 'video' ? h('video', { src: `${fileUrl(f)}#t=0.5`, muted: true, preload: 'metadata' })
        : iconOf(f.ext);
    list.append(h('div', {
      class: `dfile ${f.id === detailFileId ? 'active' : ''}`,
      onclick: () => { detailFileId = f.id; renderDetail(); showFile(s, f); },
    },
    h('div', { class: 'dthumb' }, thumb),
    h('div', { class: 'dinfo' },
      h('div', { class: 'dname', title: f.name }, f.name),
      h('div', { class: 'dsub' }, `${formatBytes(f.size)} · ${clock(f.uploadedAt)}`)),
    h('a', { class: 'icon-btn', href: fileUrl(f, true), title: '다운로드', onclick: (e) => e.stopPropagation() }, '⬇️'),
    h('button', { class: 'icon-btn', title: '파일 삭제', onclick: (e) => { e.stopPropagation(); deleteFile(s, f); } }, '🗑️')));
  }
}

function showFile(s, f) {
  const box = $('#dpBox');
  $('#dpDownload').classList.toggle('hidden', !f);
  $('#dpOpen').classList.toggle('hidden', !f);
  if (!f) {
    $('#dpName').textContent = '';
    box._token = null;
    box.innerHTML = '';
    box.append(h('div', { class: 'pv-empty' }, h('div', { class: 'pv-empty-icon' }, '📭'), h('p', { class: 'muted' }, '제출된 파일이 여기에 표시됩니다.')));
    return;
  }
  $('#dpName').textContent = f.name;
  $('#dpDownload').href = fileUrl(f, true);
  $('#dpOpen').href = fileUrl(f);
  renderPreview(box, {
    name: f.name, ext: f.ext, size: f.size, url: fileUrl(f),
    pdfUrl: S.canConvert && CONVERTIBLE.has(f.ext) ? `/files/${f.id}/pdf?t=${encodeURIComponent(token)}` : null,
  });
}

async function deleteFile(s, f) {
  if (!(await confirmDialog(`${s.name} 학생의 '${f.name}' 파일을 삭제할까요?`, { ok: '삭제', danger: true }))) return;
  try {
    await api(`/api/master/students/${s.id}/files/${f.id}`, { method: 'DELETE', headers: H() });
    toast('삭제했습니다.');
  } catch (e) { toast(e.message, 'error'); }
}

$('#dKick').addEventListener('click', async () => {
  const s = students.get(detailId);
  if (!s) return;
  if (!(await confirmDialog(`${s.seat}번 ${s.name} 학생을 삭제할까요?\n제출한 파일도 모두 삭제되고, 학생은 다시 입장해야 합니다.`, { ok: '학생 삭제', danger: true }))) return;
  try {
    await api(`/api/master/students/${s.id}`, { method: 'DELETE', headers: H() });
    closeDetail();
    toast('삭제했습니다.');
  } catch (e) { toast(e.message, 'error'); }
});

// ------------------------------------------------------------ 이름 변경 / 과목 추가
$('#siteTitleBtn').addEventListener('click', async () => {
  const v = await promptDialog('홈페이지 이름 변경', S.siteTitle);
  if (v == null || !v.trim()) return;
  try { await api('/api/master/site', { method: 'PATCH', body: { siteTitle: v }, headers: H() }); toast('변경했습니다.', 'ok'); } catch (e) { toast(e.message, 'error'); }
});
$('#courseNameBtn').addEventListener('click', async () => {
  const c = course();
  const v = await promptDialog('과목명 변경', c.name);
  if (v == null || !v.trim()) return;
  try { await api(`/api/master/courses/${c.id}`, { method: 'PATCH', body: { name: v }, headers: H() }); toast('변경했습니다.', 'ok'); } catch (e) { toast(e.message, 'error'); }
});
async function addCourse() {
  const name = await promptDialog('새 과목 이름', '', { ok: '다음', placeholder: '예) 영상제작 실습 1반' });
  if (name == null || !name.trim()) return;
  const max = await promptDialog('정원 (1~50명)', '30', { ok: '과목 만들기', type: 'number' });
  if (max == null) return;
  try {
    const r = await api('/api/master/courses', { method: 'POST', body: { name, maxStudents: Number(max) }, headers: H() });
    if (!S.courses.some((c) => c.id === r.course.id)) S.courses.push(r.course);
    courseId = r.course.id;
    renderAll();
    toast('과목을 만들었습니다. 입장 안내(QR)를 띄워 보세요.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}
$('#addCourseBtn').addEventListener('click', addCourse);
$('#firstCourseBtn').addEventListener('click', addCourse);

// ------------------------------------------------------------ 입장 안내(QR)
function baseUrl() {
  // 실행 파일이 만든 외부 접속(터널) 주소는 매번 바뀌므로 저장된 주소보다 우선
  if (S.publicUrlSource === 'tunnel' && S.publicUrl) return S.publicUrl;
  const saved = store.get('lb_base');
  if (saved) return saved;
  if (S.publicUrl) return S.publicUrl;
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  if (local && S.lanUrls.length) return S.lanUrls[0];
  return location.origin;
}
function openJoin() {
  const c = course();
  if (!c) return;
  const base = baseUrl();
  const url = `${base}/j/${c.code}`;
  $('#jSite').textContent = S.siteTitle;
  $('#jCourse').textContent = c.name;
  $('#jQr').src = `/api/qr?text=${encodeURIComponent(url)}`;
  $('#jUrl').textContent = base.replace(/^https?:\/\//, '');
  $('#jCode').textContent = c.code;
  $('#jHint').textContent = c.open ? '' : '⛔ 현재 제출 마감 상태입니다. 설정에서 입장을 허용하세요.';
  $('#joinModal').classList.remove('hidden');
}
$('#joinInfoBtn').addEventListener('click', openJoin);
$('#codeChip').addEventListener('click', openJoin);
$('#joinClose').addEventListener('click', () => closeModal('#joinModal'));
function closeModal(sel) { $(sel).classList.add('hidden'); }
for (const id of ['#joinModal', '#settingsModal']) {
  $(id).addEventListener('click', (e) => { if (e.target.id === id.slice(1) || e.target.closest('[data-close]')) closeModal(id); });
}

// ------------------------------------------------------------ ZIP
$('#zipAllBtn').addEventListener('click', () => {
  const c = course();
  if (!c) return;
  const count = courseStudents().reduce((n, s) => n + s.files.length, 0);
  if (!count) return toast('아직 제출된 파일이 없습니다.');
  location.href = `/api/master/courses/${c.id}/zip?t=${encodeURIComponent(token)}`;
  toast('압축 파일을 만드는 중입니다… 다운로드가 곧 시작됩니다.');
});

// ------------------------------------------------------------ 설정
function openSettings() {
  const c = course();
  $('#sCourseSec').classList.toggle('hidden', !c);
  if (c) {
    $('#sName').value = c.name;
    $('#sMax').value = c.maxStudents;
    $('#sMaxVal').textContent = c.maxStudents;
    $('#sOpen').checked = c.open;
  }
  $('#sSite').value = S.siteTitle;
  const sel = $('#sBase');
  sel.innerHTML = '';
  const opts = new Set([S.publicUrl, ...S.lanUrls, location.origin].filter(Boolean));
  const cur = baseUrl();
  opts.add(cur);
  for (const o of opts) sel.append(h('option', { value: o, selected: o === cur }, o));
  sel.append(h('option', { value: '__custom' }, '직접 입력…'));
  $('#sInfo').textContent = `파일당 최대 ${S.maxFileMB}MB · 문서 PDF 변환: ${S.canConvert ? '사용 가능 (LibreOffice)' : '미설치 — 브라우저 간이 미리보기 사용'}`;
  $('#settingsModal').classList.remove('hidden');
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#sMax').addEventListener('input', (e) => { $('#sMaxVal').textContent = e.target.value; });
$('#sBase').addEventListener('change', async (e) => {
  if (e.target.value !== '__custom') return;
  const v = await promptDialog('학생이 접속할 주소 (예: https://my-class.example.com)', baseUrl());
  if (v && /^https?:\/\//.test(v.trim())) {
    const url = v.trim().replace(/\/+$/, '');
    e.target.prepend(h('option', { value: url }, url));
    e.target.value = url;
  } else {
    e.target.value = baseUrl();
  }
});
$('#sSave').addEventListener('click', async () => {
  const c = course();
  try {
    await api(`/api/master/courses/${c.id}`, {
      method: 'PATCH', headers: H(),
      body: { name: $('#sName').value, maxStudents: Number($('#sMax').value), open: $('#sOpen').checked },
    });
    toast('과목 설정을 저장했습니다.', 'ok');
  } catch (e) { toast(e.message, 'error', 4000); }
});
$('#sRegen').addEventListener('click', async () => {
  if (!(await confirmDialog('입장 코드를 새로 만들까요?\n이전 코드와 QR 로는 더 이상 새로 입장할 수 없습니다. (이미 입장한 학생은 유지)'))) return;
  try { await api(`/api/master/courses/${courseId}/regen-code`, { method: 'POST', headers: H() }); toast('새 입장 코드를 만들었습니다.', 'ok'); } catch (e) { toast(e.message, 'error'); }
});
$('#sClear').addEventListener('click', async () => {
  const c = course();
  if (!(await confirmDialog(`'${c.name}' 과목을 초기화할까요?\n등록된 학생과 제출 파일이 모두 삭제됩니다.\n(먼저 전체 ZIP 으로 백업하세요)`, { ok: '초기화', danger: true }))) return;
  try { await api(`/api/master/courses/${c.id}/clear`, { method: 'POST', headers: H() }); closeModal('#settingsModal'); toast('초기화했습니다.'); } catch (e) { toast(e.message, 'error'); }
});
$('#sDelete').addEventListener('click', async () => {
  const c = course();
  if (!(await confirmDialog(`'${c.name}' 과목을 삭제할까요?\n학생과 제출 파일이 모두 삭제되며 되돌릴 수 없습니다.`, { ok: '과목 삭제', danger: true }))) return;
  try { await api(`/api/master/courses/${c.id}`, { method: 'DELETE', headers: H() }); closeModal('#settingsModal'); toast('삭제했습니다.'); } catch (e) { toast(e.message, 'error'); }
});
$('#sSiteSave').addEventListener('click', async () => {
  const base = $('#sBase').value;
  const def = S.publicUrl || (['localhost', '127.0.0.1'].includes(location.hostname) && S.lanUrls[0]) || location.origin;
  store.set('lb_base', base && base !== def && base !== '__custom' ? base : null);
  try {
    if ($('#sSite').value.trim() !== S.siteTitle) await api('/api/master/site', { method: 'PATCH', body: { siteTitle: $('#sSite').value }, headers: H() });
    toast('홈페이지 설정을 저장했습니다.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
});
async function changePassword() {
  const pw = await promptDialog('새 교사 비밀번호 (4자 이상)', '', { type: 'password', ok: '변경' });
  if (!pw) return;
  const pw2 = await promptDialog('새 비밀번호 확인', '', { type: 'password', ok: '확인' });
  if (pw !== pw2) return toast('비밀번호가 일치하지 않습니다.', 'error');
  try {
    await api('/api/master/password', { method: 'POST', body: { password: pw }, headers: H() });
    S.usingDefaultPassword = false;
    $('#pwNotice').classList.add('hidden');
    toast('비밀번호를 변경했습니다.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}
$('#sPw').addEventListener('click', changePassword);
$('#pwNoticeBtn').addEventListener('click', changePassword);
