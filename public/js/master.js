import {
  $, $$, h, api, toast, formatBytes, timeAgo, clock, iconOf, kindOf, extOf, ACCEPT, confirmDialog, promptDialog,
  assignmentState, dueText, fmtDue, submitStatus,
} from './common.js';
import { renderPreview, thumbFor } from './preview.js';

const CONVERTIBLE = new Set(['doc', 'docx', 'ppt', 'pptx', 'pps', 'ppsx', 'xls', 'xlsx', 'hwp']);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 무시 */ } },
};

// 참관(게스트) 모드: /master?guest=링크토큰 — 읽기 전용, 로그인 정보는 저장하지 않음
const GUEST = new URLSearchParams(location.search).get('guest');
let token = GUEST || store.get('lb_master');
let S = null; // 서버 상태
const students = new Map(); // id -> student
let courseId = store.get('lb_course');
let filter = 'all';
let hideEmpty = store.get('lb_hide_empty') === '1';
let viewMode = store.get('lb_view') === 'thumb' ? 'thumb' : 'list'; // 좌석 박스: 파일 목록 / 썸네일
let sortMode = store.get('lb_sort') || 'seat'; // seat: 자리순, recent: 최근 제출순, new: 확인 필요 우선
let boxH = 160; // 현재 좌석 박스 높이(px) — 박스 안에 보여줄 파일 줄 수 계산에 사용
let detailSince = 0; // 크게 보기를 연 시점의 '마지막 확인 시각' (그 이후 파일에 NEW 표시)
let query = '';
let socket = null;
let detailId = null;
let detailFileId = null;
let assignFilter = ''; // 과제별 보기: '' 전체 / 과제 id / '_none' 기타
let editingAssign = null; // 편집 중인 과제 id

const H = () => ({ 'x-master-token': token });
const fileUrl = (f, dl) => `/files/${f.id}?t=${encodeURIComponent(token)}${dl ? '&download=1' : ''}`;
const course = () => S?.courses.find((c) => c.id === courseId);
const byRecent = (a, b) => b.uploadedAt - a.uploadedAt;
// 과제: 지금 과목의 과제(만든 순서), 파일의 과제 id (지워진 과제면 null = 기타)
const courseAssignments = () => (S?.assignments || []).filter((a) => a.courseId === courseId).sort((a, b) => a.createdAt - b.createdAt);
const assignById = (id) => (id ? (S?.assignments || []).find((a) => a.id === id) : null);
const aidOf = (f) => (assignById(f.assignmentId) ? f.assignmentId : null);
const filterAssign = () => (assignFilter && assignFilter !== '_none' ? assignById(assignFilter) : null);
// 과제별 보기에서 보이는 파일
const vf = (s) => (!assignFilter ? s.files : s.files.filter((f) => aidOf(f) === (assignFilter === '_none' ? null : assignFilter)));
// 교사가 마지막으로 확인한 뒤에 올라온 파일 = NEW
const newFiles = (s, files = s.files) => files.filter((f) => f.uploadedAt > (s.reviewedAt || 0));
const latestAt = (s) => vf(s).reduce((m, f) => Math.max(m, f.uploadedAt), 0);
const courseStudents = () => [...students.values()].filter((s) => s.courseId === courseId).sort((a, b) => a.seat - b.seat);

// ------------------------------------------------------------ 로그인
init();
async function init() {
  api('/api/public/config').then((c) => { $('#loginSite').textContent = c.siteTitle; }).catch(() => {});
  if (GUEST) {
    try { await loadState(); return showDash(); } catch (e) { return guestExpired(e.message); }
  }
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
  if (GUEST) { location.href = '/'; return; }
  if (!(await confirmDialog('로그아웃할까요?'))) return;
  api('/api/master/logout', { method: 'POST', headers: H() }).catch(() => {});
  store.set('lb_master', null);
  location.reload();
});

function guestExpired(msg) {
  document.body.replaceChildren(h('main', { class: 'center-page' },
    h('div', { class: 'card auth-card' },
      h('div', { class: 'brand-mark' }, '👀'),
      h('h1', {}, '참관 링크를 사용할 수 없습니다'),
      h('p', { class: 'sub' }, msg || '링크가 만료되었거나 취소되었습니다.'),
      h('p', { class: 'muted small' }, '수업 담당 선생님께 새 참관 링크를 요청하세요.'))));
}

async function loadState() {
  S = await api(GUEST ? '/api/guest/state' : '/api/master/state', { headers: H() });
  students.clear();
  for (const s of S.students) students.set(s.id, s);
  if (!course()) courseId = S.courses[0]?.id || null;
}

function showDash() {
  $('#dashView').classList.remove('hidden');
  $('#pwNotice').classList.toggle('hidden', !S.usingDefaultPassword);
  if (GUEST) {
    document.body.classList.add('guest');
    $('#logoutBtn').textContent = '나가기';
    $('#logoutBtn').title = '참관 종료';
    renderGuestBar();
  }
  renderAll();
  connectSocket();
  window.addEventListener('resize', onResize);
  // "n분 전" 표시와 과제 마감 상태 갱신
  setInterval(() => {
    renderAssignSelect();
    renderStats();
    renderGrid();
    if (!$('#assignModal').classList.contains('hidden')) renderAssignList();
  }, 30000);
}

function connectSocket() {
  socket = io({ auth: { role: GUEST ? 'guest' : 'master', token } });
  socket.on('connect_error', async () => {
    // 서버 재시작 등으로 로그인 토큰이 사라진 경우 / 참관 링크가 만료·취소된 경우
    try { await api(GUEST ? '/api/guest/state' : '/api/master/state', { headers: H() }); } catch (e) {
      if (e.status !== 401) return;
      if (GUEST) { socket.close(); return guestExpired(e.message); }
      store.set('lb_master', null); location.reload();
    }
  });
  socket.on('disconnect', (reason) => { if (GUEST && reason === 'io server disconnect') guestExpired(); });
  socket.on('connect', async () => {
    await loadState();
    renderAll();
    if (screen && !screen.ended) openScreen(screen.studentId); // 다시 연결되면 화면 보기도 다시 연결
  });
  socket.on('student:update', (s) => {
    const prev = students.get(s.id);
    students.set(s.id, s);
    // 요청한 학생이 공유를 시작했거나, 보던 학생이 공유를 다시 시작하면 바로 열기
    if (s.sharing && ((!prev?.sharing && screenRequested.delete(s.id)) || (screen?.studentId === s.id && screen.ended))) openScreen(s.id);
    if (s.courseId !== courseId) return;
    if (!prev) toast(`${s.seat}번 ${s.name} 학생이 입장했습니다.`);
    else if (s.files.length > prev.files.length) toast(`📥 ${s.seat}번 ${s.name} — 새 파일 ${s.files.length - prev.files.length}개 제출`, 'ok');
    const flash = !prev || s.files.length !== prev.files.length;
    if (detailId === s.id) {
      // 크게 보기로 보고 있는 학생의 새 파일은 바로 '확인함' 처리 (목록에는 NEW 로 표시)
      if (prev && s.files.length > prev.files.length) markReviewed(s);
      renderDetail();
    }
    if (sortMode === 'seat') updateSeat(s, flash); else renderGrid();
    renderStats();
    if (!$('#materialsModal').classList.contains('hidden')) renderMaterials();
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
  socket.on('material:update', (m) => {
    const i = S.materials.findIndex((x) => x.id === m.id);
    if (i >= 0) S.materials[i] = m; else S.materials.push(m);
    renderMaterials();
  });
  socket.on('inbox:new', (m) => {
    if (S.inbox.some((x) => x.id === m.id)) return;
    S.inbox.unshift(m);
    const who = inboxStudents(m)[0];
    toast(`📬 인증 메일 도착${who ? ` — ${who.label}` : ''}${m.code ? ` · ${m.code}` : ''}`, 'ok', 5000);
    renderInbox();
  });
  if (!GUEST) bindScreenSocket();
  socket.on('analysis:update', (a) => {
    S.analyses ||= [];
    const i = S.analyses.findIndex((x) => x.id === a.id);
    if (i >= 0) S.analyses[i] = a; else S.analyses.push(a);
    if (!$('#anModal').classList.contains('hidden')) renderAnalysis(a.id);
  });
  socket.on('message:update', (m) => {
    S.messages ||= [];
    const i = S.messages.findIndex((x) => x.id === m.id);
    const isNew = i < 0;
    if (i >= 0) S.messages[i] = m; else S.messages.push(m);
    if (isNew && m.from === 'student') {
      const st = students.get(m.studentId);
      const viewing = !$('#msgModal').classList.contains('hidden') && mgTarget === m.studentId;
      if (viewing) markThreadRead(m.studentId);
      else if (st?.courseId === courseId) toast(`💬 ${st.seat}번 ${st.name}: ${m.text.slice(0, 40)}`, 'ok', 6000);
    }
    renderMsgCount();
    if (!$('#msgModal').classList.contains('hidden')) renderMessages();
  });
  socket.on('message:remove', ({ id }) => {
    S.messages = (S.messages || []).filter((x) => x.id !== id);
    renderMsgCount();
    if (!$('#msgModal').classList.contains('hidden')) renderMessages();
  });
  socket.on('analysis:remove', ({ id }) => {
    S.analyses = (S.analyses || []).filter((x) => x.id !== id);
    if (!$('#anModal').classList.contains('hidden')) renderAnalysis();
  });
  socket.on('guests:update', (list) => { S.guests = list; renderGuests(); });
  socket.on('inbox:remove', ({ ids }) => { S.inbox = S.inbox.filter((m) => !ids.includes(m.id)); renderInbox(); });
  socket.on('inbox:imap', (st) => { S.inboxImap = st; renderInbox(); });
  socket.on('inbox:config', ({ inboxKey }) => { if (inboxKey) S.inboxKey = inboxKey; renderInbox(); });
  socket.on('mailboxes:update', (list) => { S.mailboxes = list; renderInbox(); });
  socket.on('mailboxes:all', ({ codeAllToken }) => { S.codeAllToken = codeAllToken; });
  socket.on('material:remove', ({ id }) => {
    S.materials = S.materials.filter((m) => m.id !== id);
    renderMaterials();
  });
  socket.on('assignment:update', (a) => {
    const i = S.assignments.findIndex((x) => x.id === a.id);
    if (i >= 0) S.assignments[i] = a; else S.assignments.push(a);
    if (a.courseId === courseId) renderAssignmentsAll();
  });
  socket.on('assignment:remove', ({ id, courseId: cid }) => {
    S.assignments = S.assignments.filter((a) => a.id !== id);
    if (assignFilter === id) assignFilter = '';
    if (editingAssign === id) resetAssignForm();
    if (cid === courseId) renderAssignmentsAll();
  });
  socket.on('course:remove', ({ id }) => {
    S.courses = S.courses.filter((c) => c.id !== id);
    S.assignments = S.assignments.filter((a) => a.courseId !== id);
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
  if (!GUEST) renderMsgCount();
  renderSiteTitle();
  renderCourseSelect();
  renderCourseBar();
  renderGrid();
  renderInbox();
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
$('#courseSelect').addEventListener('change', (e) => { courseId = e.target.value; query = ''; $('#search').value = ''; assignFilter = ''; renderAll(); });

function renderCourseBar() {
  const c = course();
  $('#courseBar').classList.toggle('hidden', !c);
  $('#noCourse').classList.toggle('hidden', !!c);
  $('#joinInfoBtn').disabled = !c;
  $('#zipAllBtn').disabled = !c;
  $('#pptBtn').disabled = !c;
  $('#analyzeBtn').disabled = !c;
  $('#msgBtnT').disabled = !c;
  if (!c) return;
  $('#courseName').textContent = c.name;
  $('#courseCode').textContent = c.code;
  $('#closedBadge').classList.toggle('hidden', c.open);
  $('#liveBadge').classList.toggle('hidden', !c.open);
  $('#liveBadge').textContent = c.sessionStartedAt ? `● 수업 중 · ${clock(c.sessionStartedAt)} 시작` : '● 입장·제출 열림';
  $('#startBtn').classList.toggle('hidden', c.open);
  $('#endBtn').classList.toggle('hidden', !c.open);
  renderAssignSelect();
  renderStats();
}

function applyCourse(updated) {
  const i = S.courses.findIndex((x) => x.id === updated.id);
  if (i >= 0) S.courses[i] = updated; else S.courses.push(updated);
  renderCourseSelect();
  renderCourseBar();
}

// 수업 시작: 새 입장 코드 + 입장·제출 열기 + 입장 안내(QR) 바로 띄우기
$('#startBtn').addEventListener('click', async () => {
  const c = course();
  if (!(await confirmDialog(`'${c.name}' 수업을 시작할까요?\n\n• 새 입장 코드와 QR 이 만들어집니다 (지난 코드는 사용 불가)\n• 학생 입장과 과제 제출이 열립니다\n• 이미 입장한 학생과 제출물은 그대로 유지됩니다`, { ok: '▶ 수업 시작' }))) return;
  try {
    const r = await api(`/api/master/courses/${c.id}/start`, { method: 'POST', headers: H() });
    applyCourse(r.course);
    openJoin();
    toast(`수업을 시작했습니다. 새 입장 코드: ${r.course.code}`, 'ok', 4000);
  } catch (e) { toast(e.message, 'error'); }
});

// 수업 종료: 입장·제출 마감
$('#endBtn').addEventListener('click', async () => {
  const c = course();
  if (!(await confirmDialog(`'${c.name}' 수업을 종료할까요?\n\n• 새 입장과 과제 제출이 막힙니다\n• 제출된 파일은 그대로 남아 있어 계속 보고 받을 수 있습니다`, { ok: '⏹ 수업 종료', danger: true }))) return;
  try {
    const r = await api(`/api/master/courses/${c.id}/end`, { method: 'POST', headers: H() });
    applyCourse(r.course);
    toast('수업을 종료했습니다. 필요하면 🗜️ 전체 ZIP 으로 제출물을 받아 두세요.', 'ok', 4000);
  } catch (e) { toast(e.message, 'error'); }
});
function renderStats() {
  const c = course();
  if (!c) return;
  const list = courseStudents();
  const on = list.filter((s) => s.online).length;
  const done = list.filter((s) => vf(s).length).length;
  const files = list.reduce((n, s) => n + vf(s).length, 0);
  const unchecked = list.filter((s) => newFiles(s, vf(s)).length).length;
  const stat = (label, val, cls = '') => h('div', { class: `stat ${cls}` }, label, h('b', {}, val));
  const a = filterAssign();
  if (a) {
    // 과제 하나를 볼 때: 제출 / 지각 / 미제출 + 마감
    const late = list.filter((s) => submitStatus(vf(s)) === '지각').length;
    return $('#stats').replaceChildren(
      stat('등록', list.length),
      stat('접속중', on, 'ok'),
      stat('제출', done - late, 'ok'),
      stat('지각', late, late ? 'warn' : ''),
      stat('미제출', list.length - done, 'warn'),
      stat('확인 필요', unchecked, unchecked ? 'new' : ''),
      h('div', { class: 'stat' }, '마감', h('b', { class: 'assign-due' }, dueText(a))),
    );
  }
  $('#stats').replaceChildren(
    stat('정원', c.maxStudents),
    stat('등록', list.length),
    stat('접속중', on, 'ok'),
    stat('제출 완료', done, 'ok'),
    stat('미제출', list.length - done, 'warn'),
    stat('전체 파일', files),
    stat('확인 필요', unchecked, unchecked ? 'new' : ''),
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
function bindSeg(sel, key, get, set) {
  const seg = $(sel);
  $$('button', seg).forEach((b) => b.classList.toggle('active', b.dataset.v === get()));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.v);
    store.set(key, b.dataset.v);
    $$('button', seg).forEach((x) => x.classList.toggle('active', x === b));
    renderGrid();
  });
}
bindSeg('#viewSeg', 'lb_view', () => viewMode, (v) => { viewMode = v; });
$('#sortSelect').value = sortMode;
$('#sortSelect').addEventListener('change', (e) => { sortMode = e.target.value; store.set('lb_sort', sortMode); renderGrid(); });

function matches(s) {
  if (filter === 'online' && !s.online) return false;
  if (filter === 'done' && !vf(s).length) return false;
  if (filter === 'none' && vf(s).length) return false;
  if (!query) return true;
  return s.name.toLowerCase().includes(query) || String(s.seat) === query
    || vf(s).some((f) => f.name.toLowerCase().includes(query));
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
  const filtering = filter !== 'all' || !!query;
  const list = courseStudents().filter((s) => !filtering || matches(s));
  let entries;
  if (sortMode === 'seat') {
    // 자리 배치 그대로 (빈 자리 포함)
    const bySeat = new Map(list.map((s) => [s.seat, s]));
    entries = [];
    for (let seat = 1; seat <= c.maxStudents; seat++) {
      const s = bySeat.get(seat);
      if (s) entries.push(s);
      else if (!filtering && !hideEmpty) entries.push(seat);
    }
  } else {
    // 최근 제출순 / 확인 필요 우선 (빈 자리 제외)
    entries = [...list].sort((a, b) => (sortMode === 'new' ? newFiles(b, vf(b)).length - newFiles(a, vf(a)).length : 0)
      || latestAt(b) - latestAt(a) || a.seat - b.seat);
  }
  layoutGrid(entries.length);
  for (const e of entries) grid.append(typeof e === 'number' ? emptySeat(e) : seatBox(e));
  $('#noMatch').classList.toggle('hidden', entries.length > 0 || !filtering);
}

function emptySeat(seat) {
  return h('div', { class: 'seat empty', 'data-seat': seat },
    h('div', { class: 'seat-top' }, h('span', { class: 'seat-no' }, seat)),
    h('div', { class: 'seat-body' }, '빈 자리'));
}

function fileIcon(f, size) {
  const k = kindOf(f.ext);
  if (k === 'image' && f.ext !== 'heic') return h('img', { class: 'sf-thumb', src: fileUrl(f), alt: '', loading: 'lazy', width: size, height: size });
  return h('span', { class: 'sf-ico' }, iconOf(f.ext));
}

function seatBox(s) {
  const files = [...vf(s)].reverse().sort(byRecent);
  const latest = files[0];
  const fresh = new Set(newFiles(s, files).map((f) => f.id));
  const lateOnly = !!filterAssign() && submitStatus(files) === '지각';
  const cls = ['seat', s.online ? 'online' : 'offline', files.length ? 'done' : '', fresh.size ? 'has-new' : '', `view-${viewMode}`].join(' ');

  let body;
  if (!files.length) {
    body = h('div', { class: 'seat-body' }, h('div', { class: 'seat-waiting' }, s.online ? '작업 중…' : '미접속'));
  } else if (viewMode === 'thumb') {
    // 썸네일 보기: 가장 최근 이미지/영상
    const visual = files.find((f) => ['image', 'video'].includes(kindOf(f.ext)) && f.ext !== 'heic') || latest;
    body = h('div', { class: 'seat-body' }, thumbFor(visual, fileUrl(visual)), h('span', { class: 'seat-count' }, `${files.length}개`));
  } else {
    // 목록 보기: 최신 파일이 위로, 박스 높이에 맞춰 줄 수 조절
    const ROW = 24;
    const capacity = Math.max(1, Math.floor((boxH - 64) / ROW));
    const shown = files.length > capacity ? files.slice(0, capacity - 1) : files;
    body = h('div', { class: 'seat-files' },
      shown.map((f) => h('div', { class: `sf-row ${fresh.has(f.id) ? 'is-new' : ''}`, title: `${f.name} · ${timeAgo(f.uploadedAt)}` },
        fileIcon(f, 18),
        h('span', { class: 'sf-name' }, highlight(f.name)),
        fresh.has(f.id) ? h('span', { class: 'new-tag' }, 'NEW') : null)),
      files.length > shown.length ? h('div', { class: 'sf-more' }, `외 ${files.length - shown.length}개`) : null);
  }

  return h('div', { class: cls, 'data-seat': s.seat, 'data-id': s.id, onclick: () => openDetail(s.id), title: `${s.name} — 클릭하여 크게 보기` },
    h('div', { class: 'seat-top' },
      h('span', { class: 'seat-no' }, s.seat),
      h('span', { class: `dot ${s.online ? 'on' : ''}` }),
      h('span', { class: 'seat-name' }, highlight(s.name)),
      s.sharing ? h('span', { class: 'share-badge', title: '화면 공유 중 — 눌러서 크게 보기에서 확인' }, '🖥️') : null,
      fresh.size ? h('span', { class: 'new-badge' }, `NEW ${fresh.size}`) : null),
    body,
    h('div', { class: 'seat-foot' },
      lateOnly ? h('span', { class: 'st-late' }, `⏰ 지각 ${files.length}개`)
        : files.length ? h('span', { class: 'st-done' }, `✔ 제출 ${files.length}개`) : h('span', { class: 'st-none' }, '미제출'),
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
function layoutGrid(n = $('#seatGrid').children.length) {
  const grid = $('#seatGrid');
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
      const bh = Math.min(w * 0.9, (Havail - gap * (rows - 1)) / rows, 300);
      if (bh >= MIN_BOX_H && (!best || bh > best.boxH)) best = { cols, boxH: bh };
      fallback = { cols, boxH: Math.min(w * 0.9, 220) }; // 가장 많은 열 수
    }
    best ||= fallback || { cols: 1, boxH: 180 };
  }
  boxH = Math.floor(Math.max(best.boxH, MIN_BOX_H));
  grid.style.setProperty('--cols', best.cols);
  grid.style.setProperty('--box-h', `${boxH}px`);
}
// 창 크기가 바뀌면 박스 크기와 함께 목록 줄 수도 다시 계산
let resizeTimer;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderGrid, 150);
}

// ------------------------------------------------------------ 학생 크게 보기
function openDetail(id) {
  const s = students.get(id);
  detailId = id;
  detailFileId = null;
  detailSince = s?.reviewedAt || 0;
  $('#detailModal').classList.remove('hidden');
  renderDetail();
  if (s && newFiles(s).length) markReviewed(s);
}
// 교사가 확인함 → 좌석 박스의 NEW 표시 해제 (다른 교사 화면에도 반영)
function markReviewed(s) {
  if (GUEST) return; // 참관자는 확인 처리하지 않음
  api(`/api/master/students/${s.id}/reviewed`, { method: 'POST', headers: H() }).catch(() => {});
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
  if (e.key === 'Escape') {
    if (!$('#matPvModal').classList.contains('hidden')) return closeMatPreview();
    if (screen) return closeScreen();
    closeDetail(); closeModal('#joinModal'); closeModal('#settingsModal'); closeModal('#materialsModal'); closeModal('#inboxModal'); closeModal('#assignModal'); closeModal('#anModal'); closeModal('#msgModal');
  }
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
  $('#dPin').textContent = s.pinLocked ? '🔒 PIN 잠김 (15분)' : s.hasPin ? 'PIN 설정됨' : 'PIN 없음';
  $('#dPin').classList.toggle('locked', !!s.pinLocked);
  $('#dScreen').textContent = s.sharing ? '🖥️ 화면 보기 · 공유 중' : '🖥️ 화면 요청';
  $('#dZip').href = `/api/master/students/${s.id}/zip?t=${encodeURIComponent(token)}`;
  $('#dZip').classList.toggle('hidden', !s.files.length);

  const files = [...s.files].reverse().sort(byRecent);
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
      onclick: () => { detailFileId = f.id; renderDetail(); showFile(s, f, true); },
    },
    h('div', { class: 'dthumb' }, thumb),
    h('div', { class: 'dinfo' },
      h('div', { class: 'dname', title: f.name }, f.uploadedAt > detailSince ? h('span', { class: 'new-tag' }, 'NEW') : null, f.name),
      h('div', { class: 'dsub' }, assignById(f.assignmentId) ? h('span', { class: 'atag' }, assignById(f.assignmentId).title) : null,
        f.late ? h('span', { class: 'atag late' }, '지각') : null,
        `${f.kind === 'link' ? hostOf(f.url) : formatBytes(f.size)} · ${clock(f.uploadedAt)}`)),
    f.kind === 'link'
      ? h('a', { class: 'icon-btn', href: f.url, target: '_blank', rel: 'noopener', title: '링크 열기', onclick: (e) => e.stopPropagation() }, '↗️')
      : h('a', { class: 'icon-btn', href: fileUrl(f, true), title: '다운로드', onclick: (e) => e.stopPropagation() }, '⬇️'),
    h('button', { class: 'icon-btn master-only', title: '파일 삭제', onclick: (e) => { e.stopPropagation(); deleteFile(s, f); } }, '🗑️')));
  }
  updateDualBtn();
}

// fromClick: 교사가 파일을 직접 누름 → 듀얼 모니터면 보조 모니터 창을 (없으면 새로) 연다
function showFile(s, f, fromClick = false) {
  const box = $('#dpBox');
  const seq = ++showSeq;
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
  if (f.kind === 'link') return showLink(s, f, fromClick);
  $('#dpDownload').href = fileUrl(f, true);
  $('#dpOpen').href = fileUrl(f);
  const src = {
    name: f.name, ext: f.ext, size: f.size, url: fileUrl(f),
    pdfUrl: S.canConvert && CONVERTIBLE.has(f.ext) ? `/files/${f.id}/pdf?t=${encodeURIComponent(token)}` : null,
  };
  if (useViewer() && (fromClick || viewerOpen())) {
    const payload = { student: `${s.seat}번 ${s.name}`, name: f.name, download: fileUrl(f, true), src };
    box._token = null;
    box.querySelectorAll('video, audio').forEach((m) => m.pause());
    box.className = 'preview';
    box.replaceChildren(h('div', { class: 'pv-empty' },
      h('div', { class: 'pv-empty-icon' }, '🖥️'),
      h('p', { class: 'muted' }, '다른 모니터의 창에 표시하고 있습니다.'),
      h('button', { class: 'btn sm', onclick: () => renderPreview(box, src) }, '여기서 보기')));
    // 창을 열지 못하면(권한 거부·팝업 차단) 이 창에 그대로 표시
    showInViewer(payload).then((ok) => { if (!ok && seq === showSeq) renderPreview(box, src); });
    return;
  }
  renderPreview(box, src);
}

// 링크 제출: 미리보기 대신 카드 표시. 직접 누르면 열기 (듀얼 모니터면 다른 모니터에)
function showLink(s, f, fromClick) {
  const box = $('#dpBox');
  box._token = null;
  box.querySelectorAll('video, audio').forEach((m) => m.pause());
  box.className = 'preview';
  $('#dpDownload').classList.add('hidden');
  $('#dpOpen').href = f.url;
  let host = f.url;
  try { host = new URL(f.url).hostname.replace(/^www\./, ''); } catch { /* 그대로 */ }
  box.replaceChildren(h('div', { class: 'pv-empty link-card' },
    h('div', { class: 'pv-empty-icon' }, '🔗'),
    h('div', { class: 'pv-empty-name' }, f.name),
    h('a', { class: 'link-url', href: f.url, target: '_blank', rel: 'noopener' }, f.url),
    h('p', { class: 'muted' }, `${host} · ${clock(f.uploadedAt)} 제출`),
    h('button', { class: 'btn primary', onclick: () => openLink(f.url, true) }, '링크 열기 ↗')));
  if (viewerOpen()) showInViewer({ student: `${s.seat}번 ${s.name}`, name: f.name, link: f.url });
  if (fromClick) openLink(f.url, false);
}
// 듀얼 모니터면 다른 모니터에 새 창으로, 아니면 새 탭으로 연다.
// 외부 사이트가 대시보드를 조작하지 못하도록 opener 를 끊는다 (빈 창을 먼저 열고 opener=null 후 이동).
// 끊은 창은 브라우저 규칙상 대시보드가 다시 이동·닫기할 수 없으므로 링크마다 새 창이 열린다.
async function openLink(url, explicit) {
  if (useViewer()) {
    try {
      const features = await otherScreenFeatures();
      if (features) {
        const linkWin = window.open('about:blank', '_blank', features);
        if (linkWin) {
          linkWin.opener = null;
          linkWin.location.replace(url);
          return;
        }
      }
    } catch { /* 권한 없음 → 새 탭 */ }
  } else if (!explicit) {
    return; // 모니터 1대: 목록에서 고르면 카드만 보여 주고, '링크 열기'를 눌러야 연다
  }
  window.open(url, '_blank', 'noopener');
}

// ------------------------------------------------------------ 듀얼 모니터: 제출 파일을 다른 모니터 창에
// Window Management API (크롬·엣지 100+, https 또는 localhost): 모니터가 2대 이상일 때만 사용하고,
// 모니터가 하나이거나 지원하지 않는 브라우저면 지금처럼 이 창 안에 표시한다.
let showSeq = 0;
let dualOn = store.get('lb_dual') !== '0';
let viewerWin = null;
let viewerPayload = null;
let screenDetails = null;
let dualWarned = false;
const dualCapable = () => window.screen.isExtended === true && typeof window.getScreenDetails === 'function';
const useViewer = () => dualOn && dualCapable();
const viewerOpen = () => !!viewerWin && !viewerWin.closed;

async function otherScreenFeatures() {
  screenDetails ||= await window.getScreenDetails(); // 처음 한 번 브라우저가 '창 관리' 권한을 묻는다
  const { screens, currentScreen } = screenDetails;
  const other = screens.find((x) => x !== currentScreen);
  if (!other) return null;
  return `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
}
async function showInViewer(payload) {
  viewerPayload = payload;
  if (viewerOpen()) {
    viewerWin.postMessage({ type: 'show', payload }, location.origin);
    return true;
  }
  let features;
  try {
    features = await otherScreenFeatures();
  } catch {
    screenDetails = null;
    if (!dualWarned) toast('다른 모니터에 띄우려면 주소창 왼쪽 아이콘 → "창 관리"를 허용해 주세요. 지금은 이 창에 표시합니다.', 'error', 6000);
    dualWarned = true;
    return false;
  }
  if (!features) return false;
  viewerWin = window.open('/viewer', 'lb-viewer', features);
  if (!viewerWin) {
    toast('팝업이 차단되었습니다. 파일을 한 번 더 누르거나, 주소창에서 이 사이트의 팝업을 허용해 주세요.', 'error', 6000);
    return false;
  }
  return true; // 창이 준비되면 'viewer-ready' 를 보내오고, 그때 파일을 전달
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== viewerWin) return;
  if (e.data?.type === 'viewer-ready' && viewerPayload) viewerWin.postMessage({ type: 'show', payload: viewerPayload }, location.origin);
});

function updateDualBtn() {
  const b = $('#dpDual');
  b.classList.toggle('hidden', !dualCapable() || !detailFileId);
  b.classList.toggle('primary', dualOn);
  b.textContent = dualOn ? '🖥️ 다른 모니터: 켜짐' : '🖥️ 다른 모니터: 꺼짐';
}
$('#dpDual').addEventListener('click', () => {
  dualOn = !dualOn;
  store.set('lb_dual', dualOn ? null : '0');
  updateDualBtn();
  const s = students.get(detailId);
  const f = s?.files.find((x) => x.id === detailFileId);
  if (s && f) showFile(s, f, dualOn);
});
window.screen.addEventListener?.('change', updateDualBtn);

async function deleteFile(s, f) {
  if (!(await confirmDialog(`${s.name} 학생의 '${f.name}' 파일을 삭제할까요?`, { ok: '삭제', danger: true }))) return;
  try {
    await api(`/api/master/students/${s.id}/files/${f.id}`, { method: 'DELETE', headers: H() });
    toast('삭제했습니다.');
  } catch (e) { toast(e.message, 'error'); }
}

// 학생 개인 입장 링크 · PIN
const studentLink = (s) => `${baseUrl()}/s/${s.key}`;
$('#dLinkCopy').addEventListener('click', () => {
  const s = students.get(detailId);
  if (s?.key) copyText(studentLink(s), `${s.name} 학생의 개인 링크를 복사했습니다. 본인에게만 전달하세요.`);
});
$('#dLinkQr').addEventListener('click', () => {
  const s = students.get(detailId);
  if (s?.key) showQrPage(`${s.seat}번 ${s.name}`, '개인 입장 링크 · 본인만 사용', studentLink(s));
});
$('#dPinReset').addEventListener('click', async () => {
  const s = students.get(detailId);
  if (!s || !(await confirmDialog(`${s.seat}번 ${s.name} 학생의 PIN 을 초기화할까요?\n학생이 다음에 이름으로 입장할 때 새 PIN 을 정합니다.`, { ok: '초기화' }))) return;
  try { await api(`/api/master/students/${s.id}/reset-pin`, { method: 'POST', headers: H() }); toast('PIN 을 초기화했습니다.'); } catch (e) { toast(e.message, 'error'); }
});
$('#dLinkRegen').addEventListener('click', async () => {
  const s = students.get(detailId);
  if (!s || !(await confirmDialog(`${s.seat}번 ${s.name} 학생의 개인 링크를 새로 만들까요?\n예전 링크·QR 은 바로 막히고, 그 링크로 열려 있던 기기도 로그아웃됩니다.`, { ok: '새로 만들기', danger: true }))) return;
  try {
    const r = await api(`/api/master/students/${s.id}/regen-key`, { method: 'POST', headers: H() });
    s.key = r.key;
    copyText(studentLink(s), '새 개인 링크를 만들어 복사했습니다.');
  } catch (e) { toast(e.message, 'error'); }
});

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
for (const id of ['#joinModal', '#settingsModal', '#materialsModal', '#matPvModal', '#inboxModal', '#assignModal', '#anModal', '#msgModal']) {
  $(id).addEventListener('click', (e) => { if (e.target.id === id.slice(1) || e.target.closest('[data-close]')) closeModal(id); });
}

// ------------------------------------------------------------ 학생 화면 보기 (학생이 공유를 수락해야 보임)
let screen = null; // { studentId, pc, timer, mode: 'rtc' | 'frames', imgUrl, ended }
const screenRequested = new Set(); // 공유를 요청한 학생 → 공유가 시작되면 자동으로 열기

$('#dScreen').addEventListener('click', () => {
  const s = students.get(detailId);
  if (!s) return;
  if (s.sharing) return openScreen(s.id);
  if (!s.online) return toast('학생이 접속 중이 아닙니다.', 'error');
  socket.emit('screen:request', { studentId: s.id });
  screenRequested.add(s.id);
  toast(`${s.name} 학생 화면에 공유 요청을 보냈습니다. 학생이 수락하면 바로 열립니다.`, 'ok', 4000);
});
function setScreenWait(text) {
  $('#scWait').textContent = text || '';
  $('#scWait').classList.toggle('hidden', !text);
}
function openScreen(studentId) {
  closeScreen(true, false);
  const s = students.get(studentId);
  if (!s) return;
  $('#scSeat').textContent = `${s.seat}번`;
  $('#scName').textContent = s.name;
  $('#scStatus').textContent = '연결 중…';
  $('#scVideo').srcObject = null;
  $('#scVideo').classList.remove('hidden');
  $('#scImg').classList.add('hidden');
  $('#scImg').removeAttribute('src');
  setScreenWait('학생 화면을 기다리는 중…');
  $('#screenModal').classList.remove('hidden');
  const pc = new RTCPeerConnection({ iceServers: S.iceServers });
  screen = { studentId, pc, mode: 'rtc' };
  pc.ontrack = (e) => { $('#scVideo').srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('screen:signal', { studentId, data: { candidate: e.candidate.toJSON() } }); };
  pc.onconnectionstatechange = () => {
    if (screen?.pc !== pc) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(screen.timer);
      $('#scStatus').textContent = '실시간';
      setScreenWait('');
    }
    if (pc.connectionState === 'failed') useFrames();
  };
  // 학교 방화벽 등으로 직접 연결이 안 되면 사진 모드로
  screen.timer = setTimeout(() => { if (screen?.pc === pc && pc.connectionState !== 'connected') useFrames(); }, 8000);
  socket.emit('screen:watch', { studentId });
}
function useFrames() {
  if (!screen || screen.mode === 'frames' || screen.ended) return;
  clearTimeout(screen.timer);
  screen.pc?.close();
  screen.pc = null;
  screen.mode = 'frames';
  $('#scStatus').textContent = '사진 모드 · 1초마다 갱신 (직접 연결이 막힌 네트워크)';
  $('#scVideo').classList.add('hidden');
  $('#scImg').classList.remove('hidden');
  socket.emit('screen:fallback', { studentId: screen.studentId });
}
function closeScreen(notify = true, hide = true) {
  if (screen) {
    clearTimeout(screen.timer);
    screen.pc?.close();
    if (screen.imgUrl) URL.revokeObjectURL(screen.imgUrl);
    if (notify && !screen.ended) socket.emit('screen:unwatch', { studentId: screen.studentId });
    screen = null;
  }
  $('#scVideo').srcObject = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (hide) $('#screenModal').classList.add('hidden');
}
$('#scClose').addEventListener('click', () => closeScreen());
$('#screenModal').addEventListener('click', (e) => { if (e.target.id === 'screenModal') closeScreen(); });
$('#scFull').addEventListener('click', () => $('#scBox').requestFullscreen?.().catch(() => {}));
function bindScreenSocket() {
  socket.on('screen:signal', async ({ studentId, data }) => {
    const pc = screen?.studentId === studentId ? screen.pc : null;
    if (!pc) return;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          socket.emit('screen:signal', { studentId, data: { sdp: pc.localDescription.toJSON() } });
        }
      } else if (data.candidate) await pc.addIceCandidate(data.candidate);
    } catch { /* 늦게 온 연결 후보 등은 무시 */ }
  });
  socket.on('screen:frame', ({ studentId, buf }) => {
    if (screen?.studentId !== studentId || screen.mode !== 'frames') return;
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    $('#scImg').src = url;
    if (screen.imgUrl) URL.revokeObjectURL(screen.imgUrl);
    screen.imgUrl = url;
    setScreenWait('');
  });
  socket.on('screen:stopped', ({ studentId }) => {
    if (screen?.studentId !== studentId) return;
    clearTimeout(screen.timer);
    screen.pc?.close();
    screen.pc = null;
    screen.ended = true;
    $('#scVideo').srcObject = null;
    $('#scImg').removeAttribute('src');
    $('#scStatus').textContent = '공유 종료';
    setScreenWait('학생이 화면 공유를 멈췄습니다.\n학생이 다시 공유하면 자동으로 이어집니다.');
  });
  socket.on('screen:declined', ({ studentId }) => {
    if (!screenRequested.delete(studentId)) return;
    toast(`${students.get(studentId)?.name || '학생'} 학생이 화면 공유를 하지 않았습니다.`, 'error', 4000);
  });
}

// ------------------------------------------------------------ 과제
function renderAssignmentsAll() {
  renderAssignSelect();
  renderStats();
  renderGrid();
  if (detailId) renderDetail();
  if (!$('#assignModal').classList.contains('hidden')) renderAssignList();
}
// 과제별 보기 선택: 과목에 과제가 있을 때만 표시
function renderAssignSelect() {
  const list = courseAssignments();
  const sel = $('#assignSelect');
  sel.classList.toggle('hidden', !list.length);
  if (assignFilter && assignFilter !== '_none' && !assignById(assignFilter)) assignFilter = '';
  if (!list.length) assignFilter = '';
  sel.replaceChildren(
    h('option', { value: '', selected: !assignFilter }, '📝 모든 제출물'),
    ...list.map((a) => {
      const st = assignmentState(a);
      return h('option', { value: a.id, selected: assignFilter === a.id }, `📝 ${a.title}${st === 'closed' ? ' (마감)' : st === 'late' ? ' (마감 지남)' : ''}`);
    }),
    h('option', { value: '_none', selected: assignFilter === '_none' }, '기타 (과제 선택 안 함)'),
  );
  $('#zipAllBtn').textContent = filterAssign() ? '🗜️ 이 과제 ZIP' : '🗜️ 전체 ZIP';
  $('#pptBtn').textContent = filterAssign() ? '📊 이 과제 PPT' : '📊 PPT';
}
$('#assignSelect').addEventListener('change', (e) => { assignFilter = e.target.value; renderAssignmentsAll(); });

function downloadAssignZip(a) {
  const n = courseStudents().filter((s) => s.files.some((f) => aidOf(f) === a.id)).length;
  if (!n) return toast(`'${a.title}' 과제를 낸 학생이 아직 없습니다.`);
  location.href = `/api/master/assignments/${a.id}/zip?t=${encodeURIComponent(token)}`;
  toast('압축 파일을 만드는 중입니다… 다운로드가 곧 시작됩니다.');
}

// datetime-local 값 <-> 시각(ms). 입력값은 교사 컴퓨터의 현지 시각으로 해석
const toLocalInput = (t) => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);

function openAssignments() {
  const c = course();
  if (!c) return;
  $('#amCourse').textContent = c.name;
  resetAssignForm();
  renderAssignList();
  $('#assignModal').classList.remove('hidden');
  setTimeout(() => $('#amTitle').focus(), 50);
}
$('#assignBtn').addEventListener('click', openAssignments);

function resetAssignForm() {
  editingAssign = null;
  $('#amForm').reset();
  $('#amFormTitle').textContent = '새 과제';
  $('#amSave').textContent = '＋ 과제 만들기';
  $('#amCancel').classList.add('hidden');
  if (!$('#assignModal').classList.contains('hidden')) renderAssignList();
}
function editAssignment(a) {
  editingAssign = a.id;
  $('#amTitle').value = a.title;
  $('#amDesc').value = a.desc;
  $('#amDue').value = toLocalInput(a.dueAt);
  $('#amLate').checked = a.allowLate;
  $('#amCriteria').value = a.criteria || '';
  $('#amFormTitle').textContent = `과제 편집 — ${a.title}`;
  $('#amSave').textContent = '💾 저장';
  $('#amCancel').classList.remove('hidden');
  renderAssignList();
  $('#amForm').scrollIntoView({ behavior: 'smooth' });
  $('#amTitle').focus();
}
$('#amCancel').addEventListener('click', resetAssignForm);
$('#amForm').addEventListener('click', (e) => {
  const b = e.target.closest('[data-due]');
  if (!b) return;
  const now = new Date();
  let t = null;
  if (b.dataset.due === '1h') t = new Date(now.getTime() + 3600e3);
  if (b.dataset.due === 'today') t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
  if (b.dataset.due === 'week') t = new Date(now.getTime() + 7 * 86400e3);
  if (t) t.setSeconds(0, 0);
  $('#amDue').value = t ? toLocalInput(t.getTime()) : '';
});
$('#amForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#amTitle').value.trim();
  if (!title) { toast('과제 이름을 입력해 주세요.', 'error'); return $('#amTitle').focus(); }
  const dueAt = fromLocalInput($('#amDue').value);
  const body = { title, desc: $('#amDesc').value, dueAt, allowLate: $('#amLate').checked, criteria: $('#amCriteria').value };
  const editing = editingAssign && assignById(editingAssign);
  // 마감을 미래로 다시 잡으면 '마감하기'로 닫아 둔 과제도 다시 연다
  if (editing && editing.closed && dueAt && dueAt > Date.now()) body.closed = false;
  if (!editing && dueAt && dueAt <= Date.now() && !(await confirmDialog('마감 시각이 이미 지났습니다. 이대로 만들까요?\n학생은 이 과제에 낼 수 없습니다.', { ok: '그래도 만들기' }))) return;
  try {
    const r = editing
      ? await api(`/api/master/assignments/${editing.id}`, { method: 'PATCH', body, headers: H() })
      : await api(`/api/master/courses/${courseId}/assignments`, { method: 'POST', body, headers: H() });
    const i = S.assignments.findIndex((x) => x.id === r.assignment.id);
    if (i >= 0) S.assignments[i] = r.assignment; else S.assignments.push(r.assignment);
    toast(editing ? '과제를 저장했습니다.' : `'${title}' 과제를 만들었습니다. 학생 화면에 바로 보입니다.`, 'ok', 3500);
    resetAssignForm();
    renderAssignmentsAll();
  } catch (err) { toast(err.message, 'error'); }
});

async function patchAssignment(a, body, msg) {
  try {
    const r = await api(`/api/master/assignments/${a.id}`, { method: 'PATCH', body, headers: H() });
    const i = S.assignments.findIndex((x) => x.id === a.id);
    if (i >= 0) S.assignments[i] = r.assignment;
    renderAssignmentsAll();
    if (msg) toast(msg, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}
async function closeAssignment(a) {
  if (!(await confirmDialog(`'${a.title}' 과제를 지금 마감할까요?\n학생은 더 낼 수 없고, 낸 파일도 지울 수 없게 됩니다.`, { ok: '지금 마감', danger: true }))) return;
  patchAssignment(a, { closed: true }, '마감했습니다.');
}
function reopenAssignment(a) {
  // 마감 시각이 지나서 닫힌 경우에는 마감 시각을 바꿔야 다시 열림
  if (a.dueAt && a.dueAt <= Date.now() && !a.allowLate) {
    toast('마감 시각이 지났습니다. 새 마감 시각을 정하거나 비우고 저장하세요.', 'info', 4000);
    return editAssignment(a);
  }
  patchAssignment(a, { closed: false }, '다시 열었습니다.');
}
async function deleteAssignment(a) {
  if (!(await confirmDialog(`'${a.title}' 과제를 삭제할까요?\n학생이 낸 파일은 지워지지 않고 '기타' 제출로 남습니다.`, { ok: '과제 삭제', danger: true }))) return;
  try {
    await api(`/api/master/assignments/${a.id}`, { method: 'DELETE', headers: H() });
    S.assignments = S.assignments.filter((x) => x.id !== a.id);
    if (assignFilter === a.id) assignFilter = '';
    if (editingAssign === a.id) resetAssignForm();
    renderAssignmentsAll();
    toast('삭제했습니다.');
  } catch (e) { toast(e.message, 'error'); }
}

function renderAssignList() {
  const box = $('#amList');
  const list = courseAssignments();
  const studentsNow = courseStudents();
  box.replaceChildren();
  if (!list.length) {
    box.append(h('p', { class: 'muted am-empty' }, '아직 과제가 없습니다. 과제를 만들면 학생이 과제를 골라 제출하고, 마감이 지나면 제출이 막힙니다.'));
    return;
  }
  for (const a of list) {
    const st = assignmentState(a);
    const statuses = studentsNow.map((s) => submitStatus(s.files.filter((f) => aidOf(f) === a.id)));
    const done = statuses.filter((x) => x !== '미제출').length;
    const late = statuses.filter((x) => x === '지각').length;
    box.append(h('div', { class: `am-item ${editingAssign === a.id ? 'editing' : ''}` },
      h('div', { class: 'am-main' },
        h('div', { class: 'am-title' }, a.title,
          h('span', { class: `am-st ${st}` }, st === 'open' ? '받는 중' : st === 'late' ? '지각 받는 중' : '마감')),
        h('div', { class: 'am-sub' }, `🕒 ${dueText(a)}${a.allowLate ? ' · 지각 허용' : ''}`),
        a.desc ? h('div', { class: 'am-sub' }, a.desc) : null),
      h('span', { class: 'am-count' }, `제출 ${done}/${studentsNow.length}`, late ? h('span', { class: 'st-late' }, ` (지각 ${late})`) : null),
      h('div', { class: 'am-acts' },
        h('button', { class: 'btn sm', title: '대시보드를 이 과제 제출 현황으로', onclick: () => { assignFilter = a.id; closeModal('#assignModal'); renderAssignmentsAll(); } }, '👀 보기'),
        h('button', { class: 'btn sm', onclick: () => editAssignment(a) }, '✏️ 편집'),
        st === 'closed' ? h('button', { class: 'btn sm', onclick: () => reopenAssignment(a) }, '🔓 다시 열기')
          : h('button', { class: 'btn sm', onclick: () => closeAssignment(a) }, '⏹ 지금 마감'),
        h('button', { class: 'btn sm', title: '이 과제에 낸 링크를 AI 로 분석', onclick: () => { closeModal('#assignModal'); openAnalysis(a.id); } }, '🔍 분석'),
        h('button', { class: 'btn sm', onclick: () => downloadAssignZip(a) }, '🗜️ ZIP'),
        h('button', { class: 'btn sm', title: '이 과제에 낸 파일·링크만 지우기 (과제는 남음)', onclick: () => clearFiles(`/api/master/assignments/${a.id}/clear-submissions`, `'${a.title}' 과제`,
          courseStudents().reduce((n, s) => n + s.files.filter((f) => aidOf(f) === a.id).length, 0)) }, '🧹 제출물 비우기'),
        h('button', { class: 'icon-btn', title: '과제 삭제', onclick: () => deleteAssignment(a) }, '🗑️'))));
  }
}

// ------------------------------------------------------------ 과제 링크 AI 분석
let anAssignId = null;
const editingAn = new Set(); // 교사가 고치는 중인 카드는 실시간 갱신으로 덮어쓰지 않음
const analysisOf = (fileId) => (S.analyses || []).find((x) => x.fileId === fileId);
const fmtUsd = (n) => (n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? '$0.01 미만' : '$0');
function anTargets() {
  return courseStudents().flatMap((s) => s.files.filter((f) => f.kind === 'link' && aidOf(f) === anAssignId).map((f) => ({ s, f, a: analysisOf(f.id) })));
}
function openAnalysis(assignmentId) {
  const list = courseAssignments();
  if (!list.length) return toast('먼저 📝 과제 관리에서 과제를 만들어 주세요. 학생이 과제를 골라 낸 링크를 분석합니다.', 'info', 4000);
  anAssignId = assignmentId || filterAssign()?.id || anAssignId;
  if (!list.some((a) => a.id === anAssignId)) anAssignId = list[list.length - 1].id;
  $('#anAssign').replaceChildren(...list.map((a) => h('option', { value: a.id, selected: a.id === anAssignId }, `📝 ${a.title}`)));
  $('#anModal').classList.remove('hidden');
  renderAnalysis();
}
$('#analyzeBtn').addEventListener('click', () => openAnalysis());
$('#anAssign').addEventListener('change', (e) => { anAssignId = e.target.value; editingAn.clear(); renderAnalysis(); });
async function runAnalysis(force) {
  const targets = anTargets();
  if (!targets.length) return toast('이 과제에 제출된 링크가 없습니다.');
  const n = force ? targets.length : targets.filter((t) => !t.a || t.a.status === 'error').length;
  if (!n) return toast('이미 모두 분석했습니다. 다시 하려면 「↻ 모두 다시 분석」을 누르세요.');
  const info = S.analysisInfo || {};
  const cost = info.apiKey ? `\n예상 비용: 링크 1개에 약 $0.1~0.3 (총 약 ${fmtUsd(n * 0.1)}~${fmtUsd(n * 0.3)})` : '\nAPI 키가 없어 자동 점검·화면 캡처만 합니다.';
  if (!(await confirmDialog(`링크 ${n}개를 분석할까요?${cost}\n\n한 번에 2개씩 처리하며, 1개에 30초~1분쯤 걸립니다. 창을 닫아도 계속 진행됩니다.`, { ok: '분석 시작' }))) return;
  try {
    const r = await api(`/api/master/assignments/${anAssignId}/analyze`, { method: 'POST', body: { force }, headers: H() });
    S.analysisInfo = { apiKey: r.apiKey, capture: r.capture, model: r.model };
    toast(`링크 ${r.queued}개를 분석 대기열에 넣었습니다.`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}
$('#anRun').addEventListener('click', () => runAnalysis(false));
$('#anRerun').addEventListener('click', () => runAnalysis(true));

function renderAnalysis(onlyId) {
  const targets = anTargets();
  const info = S.analysisInfo || {};
  const warn = [];
  if (!info.apiKey) warn.push('⚠️ Anthropic API 키(ANTHROPIC_API_KEY)가 설정되지 않아 <b>AI 피드백 없이</b> 자동 점검·화면 캡처만 합니다. Railway Variables 에 키를 넣으면 피드백까지 만들어집니다.');
  if (!info.capture) warn.push('⚠️ 서버에 크롬이 없어 <b>화면 캡처 없이</b> 코드만 분석합니다.');
  $('#anWarn').innerHTML = warn.join('<br>');
  $('#anWarn').classList.toggle('hidden', !warn.length);
  const done = targets.filter((t) => t.a?.status === 'done').length;
  const busy = targets.filter((t) => ['queued', 'running'].includes(t.a?.status)).length;
  const cost = targets.reduce((n, t) => n + (t.a?.usage?.cost || 0), 0);
  $('#anStatus').textContent = targets.length
    ? `링크 ${targets.length}개 · 완료 ${done}${busy ? ` · 진행 중 ${busy}` : ''}${cost ? ` · 사용 비용 약 ${fmtUsd(cost)}` : ''}${info.model ? ` · ${info.model}` : ''}`
    : '이 과제에 제출된 링크가 없습니다.';
  if (onlyId) {
    const t = targets.find((x) => x.a?.id === onlyId);
    const old = t && $(`#anList [data-file="${t.f.id}"]`);
    if (old && !editingAn.has(t.f.id)) return old.replaceWith(anCard(t));
    if (old) return;
  }
  $('#anList').replaceChildren(...(targets.length ? targets.map(anCard) : [h('p', { class: 'muted center' }, '학생이 이 과제를 골라 링크를 내면 여기서 분석할 수 있습니다.')]));
}

const AN_STATUS = { queued: ['대기', ''], running: ['분석 중…', 'warn'], done: ['완료', 'ok'], error: ['실패', 'danger'] };
function factChips(fx) {
  const chips = [];
  const chip = (cls, text, title) => chips.push(h('span', { class: `an-chip ${cls}`, title: title || '' }, text));
  if (!fx.ok) chip('bad', fx.status ? `접속 오류 ${fx.status}` : '접속 실패');
  else chip('good', `접속 OK${fx.loadMs ? ` · ${(fx.loadMs / 1000).toFixed(1)}초` : ''}`);
  if (!fx.https) chip('bad', 'HTTPS 아님');
  if (fx.deploy) chip('good', `배포: ${fx.deploy}`);
  if (fx.supabase?.used) chip('good', 'Supabase 사용');
  if (fx.aiApis?.length) chip('info', `AI API: ${fx.aiApis.join(', ')}`, '브라우저 코드에서 AI API 를 직접 부르면 키가 노출될 수 있습니다');
  for (const k of fx.leakedKeys || []) chip('bad', `🔑 키 노출: ${k.kind}`, k.masked);
  if (fx.ok) chip(fx.viewport && fx.mobileOverflow !== true ? 'good' : 'warn', fx.viewport ? (fx.mobileOverflow ? '모바일: 가로 넘침' : '모바일 대응') : '모바일 설정 없음');
  if (fx.canvas) chip('info', '캔버스(게임)');
  if (fx.consoleErrors?.length) chip('warn', `JS 오류 ${fx.consoleErrors.length}`, fx.consoleErrors.join('\n'));
  if (fx.imgNoAlt) chip('warn', `대체 텍스트 없는 그림 ${fx.imgNoAlt}`);
  return chips;
}
const shotUrl = (a, kind) => `/api/master/analyses/${a.id}/shot/${kind}?t=${encodeURIComponent(token)}&v=${a.shots[kind]}`;
function anCard({ s, f, a }) {
  const st = a ? AN_STATUS[a.status] : ['미분석', ''];
  const fb = a?.feedback;
  const card = h('div', { class: `an-card ${a?.status || ''}`, 'data-file': f.id });
  const listEdit = (key, label) => h('label', { class: 'an-field' }, h('span', {}, label),
    h('textarea', { class: 'input', rows: Math.max(2, (fb[key] || []).length + 1), 'data-key': key, oninput: () => editingAn.add(f.id) }, (fb[key] || []).join('\n')));
  card.append(
    h('div', { class: 'an-head' },
      h('span', { class: 'seat-no' }, s.seat), h('strong', {}, s.name),
      h('a', { class: 'an-url', href: f.url, target: '_blank', rel: 'noopener noreferrer', title: f.url }, f.name),
      f.late ? h('span', { class: 'atag late' }, '지각') : null,
      h('span', { class: `badge ${st[1]}` }, st[0]),
      a?.usage?.cost ? h('span', { class: 'muted small' }, fmtUsd(a.usage.cost)) : null,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn sm', disabled: ['queued', 'running'].includes(a?.status), onclick: async () => {
        try { await api(`/api/master/files/${f.id}/analyze`, { method: 'POST', headers: H() }); editingAn.delete(f.id); } catch (e) { toast(e.message, 'error'); }
      } }, a ? '↻ 다시' : '🔍 분석')));
  if (!a) return card;
  if (a.error) card.append(h('p', { class: 'an-error' }, `❗ ${a.error}`));
  if (a.facts) {
    card.append(h('div', { class: 'an-chips' }, factChips(a.facts)));
    const shots = ['desktop', 'mobile'].filter((k) => a.shots?.[k]);
    if (shots.length) {
      card.append(h('div', { class: 'an-shots' }, shots.map((k) => h('a', { href: shotUrl(a, k), target: '_blank', rel: 'noopener', title: '크게 보기' },
        h('img', { class: `an-shot ${k}`, src: shotUrl(a, k), alt: k === 'mobile' ? '모바일 화면' : 'PC 화면', loading: 'lazy' })))));
    }
    if (a.facts.notes?.length) card.append(h('p', { class: 'muted small' }, a.facts.notes.join(' · ')));
  }
  if (a.skipped) card.append(h('p', { class: 'muted small' }, a.skipped));
  if (fb) {
    if (fb.security_notes?.length) card.append(h('div', { class: 'an-security' }, h('b', {}, '🔒 보안'), h('ul', {}, fb.security_notes.map((x) => h('li', {}, x)))));
    if (fb.criteria?.length) {
      card.append(h('table', { class: 'an-criteria' }, h('tbody', {}, fb.criteria.map((c) => h('tr', {},
        h('td', {}, c.criterion), h('td', { class: `an-st st-${['충족', '부분 충족', '미충족', '확인 불가'].indexOf(c.status)}` }, c.status), h('td', { class: 'muted small' }, c.note))))));
    }
    const summary = h('textarea', { class: 'input', rows: 2, 'data-key': 'summary', oninput: () => editingAn.add(f.id) }, fb.summary || '');
    const note = h('textarea', { class: 'input', rows: 1, placeholder: '교사 메모 (선택)', oninput: () => editingAn.add(f.id) }, a.note || '');
    const grid = h('div', { class: 'an-grid' }, listEdit('strengths', '👍 잘된 점'), listEdit('improvements', '🤔 아쉬운 점'), listEdit('suggestions', '💡 제안'));
    card.append(
      h('label', { class: 'an-field' }, h('span', {}, `📝 총평${a.edited ? ' (교사 수정)' : ''}`), summary),
      grid,
      h('label', { class: 'an-field' }, h('span', {}, '🗒️ 메모'), note),
      h('div', { class: 'an-actions' },
        h('span', { class: 'muted small' }, a.sentAt ? h('span', { class: 'an-sent' }, `📨 학생에게 보냄 · ${timeAgo(a.sentAt)}`) : '한 줄에 하나씩 · AI 초안이니 확인 후 사용하세요'),
        h('button', { class: 'btn sm', title: '저장한 피드백을 학생에게 메시지로 (보내기 전에 고칠 수 있음)', onclick: () => {
          const asg = assignById(a.assignmentId);
          closeModal('#anModal');
          openMessages(s.id, feedbackText(asg?.title, a.feedback), a.id);
        } }, a.sentAt ? '📨 다시 보내기' : '📨 학생에게 보내기'),
        h('button', { class: 'btn sm primary', onclick: async () => {
          const lines = (k) => grid.querySelector(`[data-key="${k}"]`).value.split('\n').map((x) => x.trim()).filter(Boolean);
          try {
            const r = await api(`/api/master/analyses/${a.id}`, { method: 'PATCH', headers: H(), body: {
              feedback: { summary: summary.value, strengths: lines('strengths'), improvements: lines('improvements'), suggestions: lines('suggestions') }, note: note.value,
            } });
            editingAn.delete(f.id);
            const i = S.analyses.findIndex((x) => x.id === a.id);
            if (i >= 0) S.analyses[i] = r.analysis;
            renderAnalysis(a.id);
            toast('저장했습니다.', 'ok');
          } catch (e) { toast(e.message, 'error'); }
        } }, '💾 저장')));
  }
  return card;
}

// ------------------------------------------------------------ 메시지 (공지 · 학생별 대화 · 학생 문의)
let mgTarget = 'notice'; // 'notice' 또는 학생 id
let mgAnalysisId = null; // AI 분석 피드백을 보내는 중이면 그 분석 id
const courseMessages = () => (S.messages || []).filter((m) => m.courseId === courseId);
const unreadQuestions = (sid) => courseMessages().filter((m) => m.from === 'student' && !m.readAt && (!sid || m.studentId === sid));
const mgTime = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function renderMsgCount() {
  const n = unreadQuestions().length;
  $('#msgCountT').textContent = n;
  $('#msgCountT').classList.toggle('hidden', !n);
}
function feedbackText(title, fb) {
  if (!fb) return '';
  const list = (label, items) => (items?.length ? `\n${label}\n${items.map((x) => `- ${x}`).join('\n')}\n` : '');
  return [`📝 ${title ? `[${title}] ` : ''}과제 피드백`, '', fb.summary || '', list('👍 잘된 점', fb.strengths), list('🤔 아쉬운 점', fb.improvements),
    list('💡 이렇게 해 보세요', fb.suggestions), list('🔒 보안', fb.security_notes)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function openMessages(target = null, prefill = '', analysisId = null) {
  if (!course()) return;
  if (target) mgTarget = target;
  if (mgTarget !== 'notice' && students.get(mgTarget)?.courseId !== courseId) mgTarget = 'notice';
  mgAnalysisId = analysisId;
  $('#mgCourse').textContent = course().name;
  $('#msgModal').classList.remove('hidden');
  $('#mgInput').value = prefill;
  renderMessages();
  if (mgTarget !== 'notice') markThreadRead(mgTarget);
  setTimeout(() => $('#mgInput').focus(), 50);
}
$('#msgBtnT').addEventListener('click', () => openMessages());
function markThreadRead(sid) {
  if (!unreadQuestions(sid).length) return;
  for (const m of unreadQuestions(sid)) m.readAt = Date.now();
  renderMsgCount();
  api(`/api/master/students/${sid}/messages/read`, { method: 'POST', headers: H() }).catch(() => {});
}
function renderMessages() {
  const list = courseMessages();
  const lastOf = (sid) => list.filter((m) => m.studentId === sid).at(-1);
  const studentsNow = courseStudents().sort((a, b) => unreadQuestions(b.id).length - unreadQuestions(a.id).length
    || (lastOf(b.id)?.at || 0) - (lastOf(a.id)?.at || 0) || a.seat - b.seat);
  const notices = list.filter((m) => !m.studentId);
  const item = (key, icon, name, prev, unread) => h('button', { type: 'button', class: `mg-item ${mgTarget === key ? 'active' : ''}`, onclick: () => {
    mgTarget = key; mgAnalysisId = null; renderMessages(); if (key !== 'notice') markThreadRead(key); $('#mgInput').focus();
  } }, icon, h('span', { class: 'mg-name' }, name), unread ? h('span', { class: 'badge danger' }, unread) : h('span'), h('span', { class: 'mg-prev' }, prev || ''));
  $('#mgSide').replaceChildren(
    item('notice', '📢', '전체 공지', notices.at(-1)?.text, 0),
    ...studentsNow.map((st) => item(st.id, h('span', { class: 'seat-no' }, st.seat), st.name, lastOf(st.id)?.text, unreadQuestions(st.id).length)));

  const total = courseStudents().length;
  const del = (m) => h('button', { type: 'button', class: 'mg-del', onclick: async () => {
    if (!(await confirmDialog('이 메시지를 지울까요?\n학생 화면에서도 사라집니다.', { ok: '삭제', danger: true }))) return;
    try { await api(`/api/master/messages/${m.id}`, { method: 'DELETE', headers: H() }); } catch (e) { toast(e.message, 'error'); }
  } }, '삭제');
  let thread;
  if (mgTarget === 'notice') {
    $('#mgHead').textContent = `📢 전체 공지 — 이 과목 학생 ${total}명 모두에게 보입니다 (나중에 입장한 학생 포함)`;
    thread = notices.map((m) => h('div', { class: 'mg-msg notice' }, m.text, h('div', { class: 'mg-meta' }, mgTime(m.at), `읽음 ${Math.min(m.reads || 0, total)}/${total}`, del(m))));
    $('#mgInput').placeholder = '전체 학생에게 보낼 공지 (예: 오늘 과제는 18시까지 링크로 제출하세요)';
    $('#mgSend').textContent = '📢 공지 보내기';
  } else {
    const st = students.get(mgTarget);
    $('#mgHead').textContent = `${st.seat}번 ${st.name} ${st.online ? '· 🟢 접속 중' : `· 마지막 접속 ${timeAgo(st.lastSeen)}`}`;
    thread = list.filter((m) => m.studentId === st.id).map((m) => {
      const fromT = m.from === 'teacher';
      return h('div', { class: `mg-msg ${fromT ? `teacher ${m.kind}` : `student ${m.readAt ? '' : 'unread'}`}` }, m.text,
        h('div', { class: 'mg-meta' }, mgTime(m.at), fromT ? (m.readAt ? '읽음' : '안 읽음') : '', fromT ? del(m) : null));
    });
    $('#mgInput').placeholder = mgAnalysisId ? 'AI 피드백 초안입니다. 고친 뒤 보내세요.' : `${st.name} 학생에게 보낼 메시지`;
    $('#mgSend').textContent = mgAnalysisId ? '📨 피드백 보내기' : '보내기';
  }
  $('#mgHint').textContent = 'Ctrl+Enter 로 보내기 · 학생 화면에 알림 창으로 뜹니다';
  const box = $('#mgThread');
  box.replaceChildren(...(thread.length ? thread : [h('p', { class: 'muted center' }, mgTarget === 'notice' ? '보낸 공지가 없습니다.' : '아직 주고받은 메시지가 없습니다.')]));
  box.scrollTop = box.scrollHeight;
}
$('#mgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#mgInput').value.trim();
  if (!text) return $('#mgInput').focus();
  const body = mgTarget === 'notice' ? { text } : { text, studentIds: [mgTarget], analysisId: mgAnalysisId || undefined };
  $('#mgSend').disabled = true;
  try {
    const r = await api(`/api/master/courses/${courseId}/messages`, { method: 'POST', body, headers: H() });
    for (const m of r.messages) if (!S.messages.some((x) => x.id === m.id)) S.messages.push(m);
    $('#mgInput').value = '';
    if (mgAnalysisId) toast('피드백을 학생에게 보냈습니다.', 'ok');
    mgAnalysisId = null;
    renderMessages();
  } catch (err) { toast(err.message, 'error'); } finally { $('#mgSend').disabled = false; }
});
$('#mgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#mgForm').requestSubmit(); });

// ------------------------------------------------------------ PPT (과제별 보기면 그 과제만)
$('#pptBtn').addEventListener('click', () => {
  const c = course();
  if (!c) return;
  const n = courseStudents().filter((s) => vf(s).length).length;
  if (!n) return toast('아직 제출한 학생이 없습니다.');
  location.href = `/api/master/courses/${c.id}/pptx?t=${encodeURIComponent(token)}${assignFilter ? `&a=${encodeURIComponent(assignFilter)}` : ''}`;
  toast(`PPT 를 만드는 중입니다… 링크 미리보기를 모으느라 ${n > 10 ? '1분 정도' : '몇 초'} 걸릴 수 있습니다.`, 'info', 5000);
});

// ------------------------------------------------------------ ZIP
$('#zipAllBtn').addEventListener('click', () => {
  const c = course();
  if (!c) return;
  const a = filterAssign();
  if (a) return downloadAssignZip(a);
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
    $('#sShared').checked = !!c.sharedPc;
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
  renderGuests();
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
      body: { name: $('#sName').value, maxStudents: Number($('#sMax').value), open: $('#sOpen').checked, sharedPc: $('#sShared').checked },
    });
    toast('과목 설정을 저장했습니다.', 'ok');
  } catch (e) { toast(e.message, 'error', 4000); }
});
$('#sRegen').addEventListener('click', async () => {
  if (!(await confirmDialog('입장 코드를 새로 만들까요?\n이전 코드와 QR 로는 더 이상 새로 입장할 수 없습니다. (이미 입장한 학생은 유지)'))) return;
  try { await api(`/api/master/courses/${courseId}/regen-code`, { method: 'POST', headers: H() }); toast('새 입장 코드를 만들었습니다.', 'ok'); } catch (e) { toast(e.message, 'error'); }
});
// 제출물 비우기 (전체 또는 과제 하나): 학생 등록은 유지
async function clearFiles(url, what, count) {
  if (!count) return toast(`${what}에 지울 제출물이 없습니다.`);
  if (!(await confirmDialog(`${what}의 제출물 ${count}개를 모두 지울까요?\n\n• 학생 등록·PIN·전용 링크·과제 목록은 그대로 남습니다\n• 지운 파일은 되돌릴 수 없으니 먼저 🗜️ ZIP 으로 받아 두세요`, { ok: '제출물 비우기', danger: true }))) return false;
  try {
    const r = await api(url, { method: 'POST', headers: H() });
    toast(`제출물 ${r.removed}개를 지웠습니다.`, 'ok');
    return true;
  } catch (e) { toast(e.message, 'error'); return false; }
}
$('#sClearFiles').addEventListener('click', async () => {
  const c = course();
  const count = courseStudents().reduce((n, s) => n + s.files.length, 0);
  if (await clearFiles(`/api/master/courses/${c.id}/clear-submissions`, `'${c.name}' 과목 전체`, count)) closeModal('#settingsModal');
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

// ------------------------------------------------------------ 자료 보내기 (교사 → 학생)
const matUrl = (m, dl) => `/materials/${m.id}?t=${encodeURIComponent(token)}${dl ? '&download=1' : ''}`;
let matFiles = []; // 보낼 파일
let matLinks = []; // 보낼 링크 { url, title }
let matTarget = 'all';
const matSelected = new Set();

function openMaterials(preselectId) {
  if (!course()) return;
  S.materials ||= [];
  if (preselectId) {
    matTarget = 'some';
    matSelected.clear();
    matSelected.add(preselectId);
  }
  $$('#matTargetSeg button').forEach((b) => b.classList.toggle('active', b.dataset.v === matTarget));
  renderMatPick();
  renderMatPending();
  renderMaterials();
  $('#materialsModal').classList.remove('hidden');
}
$('#materialsBtn').addEventListener('click', () => openMaterials());
$('#dMsg').addEventListener('click', () => { const id = detailId; closeDetail(); openMessages(id); });
$('#dSendMat').addEventListener('click', () => { const id = detailId; closeDetail(); openMaterials(id); });

// 파일 선택
$('#matInput').addEventListener('change', (e) => { addMatFiles(e.target.files); e.target.value = ''; });
$('#matDrop').addEventListener('dragover', (e) => { e.preventDefault(); $('#matDrop').classList.add('over'); });
$('#matDrop').addEventListener('dragleave', () => $('#matDrop').classList.remove('over'));
$('#matDrop').addEventListener('drop', (e) => { e.preventDefault(); $('#matDrop').classList.remove('over'); addMatFiles(e.dataTransfer.files); });
$('#matInput').accept = ACCEPT;
function addMatFiles(list) {
  const allowed = new Set(ACCEPT.split(',').map((x) => x.slice(1)));
  for (const f of list) {
    if (!allowed.has(extOf(f.name))) { toast(`지원하지 않는 형식: ${f.name}`, 'error'); continue; }
    if (f.size > S.maxFileMB * 1024 * 1024) { toast(`${S.maxFileMB}MB 초과: ${f.name}`, 'error'); continue; }
    matFiles.push(f);
  }
  renderMatPending();
}
// 링크 추가 (서버에서 한 번 더 검사)
function normalizeUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return ['http:', 'https:'].includes(u.protocol) && (u.hostname.includes('.') || u.hostname === 'localhost') ? u.href : null;
  } catch { return null; }
}
function addMatLink() {
  const url = normalizeUrl($('#matUrl').value);
  if (!url) { toast('올바른 인터넷 주소를 입력해 주세요. (예: https://www.youtube.com/…)', 'error'); return $('#matUrl').focus(); }
  matLinks.push({ url, title: $('#matUrlTitle').value.trim() });
  $('#matUrl').value = '';
  $('#matUrlTitle').value = '';
  renderMatPending();
  $('#matUrl').focus();
}
$('#matUrlAdd').addEventListener('click', addMatLink);
for (const id of ['#matUrl', '#matUrlTitle']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addMatLink(); } });
}
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

function renderMatPending() {
  $('#matPending').replaceChildren(
    ...matFiles.map((f) => h('div', { class: 'mp-row' },
      h('span', {}, iconOf(extOf(f.name))),
      h('span', { class: 'mp-name', title: f.name }, f.name),
      h('span', { class: 'muted small' }, formatBytes(f.size)),
      h('button', { class: 'icon-btn', title: '빼기', onclick: () => { matFiles = matFiles.filter((x) => x !== f); renderMatPending(); } }, '✕'))),
    ...matLinks.map((l) => h('div', { class: 'mp-row' },
      h('span', {}, '🔗'),
      h('span', { class: 'mp-name', title: l.url }, l.title || l.url),
      h('span', { class: 'muted small' }, hostOf(l.url)),
      h('button', { class: 'icon-btn', title: '빼기', onclick: () => { matLinks = matLinks.filter((x) => x !== l); renderMatPending(); } }, '✕'))));
  const n = matFiles.length + matLinks.length;
  $('#matSendBtn').textContent = n ? `보내기 (${n}개)` : '보내기';
}

// 받는 학생
$('#matTargetSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  matTarget = b.dataset.v;
  $$('#matTargetSeg button').forEach((x) => x.classList.toggle('active', x === b));
  renderMatPick();
});
function renderMatPick() {
  const some = matTarget === 'some';
  $('#matPick').classList.toggle('hidden', !some);
  $('#matAllHint').classList.toggle('hidden', some);
  const list = courseStudents();
  for (const id of [...matSelected]) if (!list.some((s) => s.id === id)) matSelected.delete(id);
  $('#matPickList').replaceChildren(...(list.length ? list.map((s) => {
    const cb = h('input', { type: 'checkbox', checked: matSelected.has(s.id) });
    const label = h('label', { class: matSelected.has(s.id) ? 'on' : '' }, cb,
      h('span', { class: `dot ${s.online ? 'on' : ''}` }), `${s.seat}. ${s.name}`);
    cb.addEventListener('change', () => {
      if (cb.checked) matSelected.add(s.id); else matSelected.delete(s.id);
      label.classList.toggle('on', cb.checked);
      $('#matPickCount').textContent = `${matSelected.size}명 선택`;
    });
    return label;
  }) : [h('p', { class: 'muted small' }, '아직 입장한 학생이 없습니다.')]));
  $('#matPickCount').textContent = `${matSelected.size}명 선택`;
}
$('#matPickAll').addEventListener('click', () => { courseStudents().forEach((s) => matSelected.add(s.id)); renderMatPick(); });
$('#matPickNone').addEventListener('click', () => { matSelected.clear(); renderMatPick(); });

// 보내기 (업로드 진행률 표시)
$('#matSendBtn').addEventListener('click', () => {
  const c = course();
  // 입력만 하고 '추가'를 안 누른 주소도 함께 보냄
  if ($('#matUrl').value.trim()) {
    const before = matLinks.length;
    addMatLink();
    if (matLinks.length === before) return;
  }
  if (!matFiles.length && !matLinks.length) return toast('보낼 파일이나 링크를 추가해 주세요.', 'error');
  if (matTarget === 'some' && !matSelected.size) return toast('받을 학생을 선택해 주세요.', 'error');
  const form = new FormData();
  for (const f of matFiles) form.append('files', f, f.name);
  if (matLinks.length) form.append('links', JSON.stringify(matLinks));
  form.append('note', $('#matNote').value);
  form.append('target', matTarget === 'all' ? 'all' : JSON.stringify([...matSelected]));
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/master/courses/${c.id}/materials`);
  xhr.setRequestHeader('x-master-token', token);
  $('#matSendBtn').disabled = true;
  $('#matProgress').classList.remove('hidden');
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    $('#matProgressBar').style.width = `${pct}%`;
    $('#matProgressText').textContent = pct < 100 ? `보내는 중… ${pct}%` : '저장 중…';
  };
  const done = () => { $('#matSendBtn').disabled = false; $('#matProgress').classList.add('hidden'); $('#matProgressBar').style.width = '0'; };
  xhr.onload = () => {
    done();
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* 무시 */ }
    if (xhr.status >= 200 && xhr.status < 300) {
      const who = matTarget === 'all' ? '전체 학생' : `${matSelected.size}명`;
      toast(`${who}에게 자료 ${matFiles.length + matLinks.length}개를 보냈습니다. 📤`, 'ok');
      matFiles = [];
      matLinks = [];
      $('#matNote').value = '';
      renderMatPending();
    } else {
      toast(data.error || '보내지 못했습니다.', 'error', 4000);
    }
  };
  xhr.onerror = () => { done(); toast('네트워크 오류로 보내지 못했습니다.', 'error'); };
  xhr.send(form);
});

// 보낸 자료 목록 (학생별 확인 여부)
function recipientsOf(m) {
  const list = courseStudents();
  return m.target === 'all' ? list : list.filter((s) => m.target.includes(s.id));
}
function renderMaterials() {
  if (!S?.materials || !course()) return;
  const all = S.materials.filter((m) => m.courseId === courseId).sort((a, b) => b.createdAt - a.createdAt);
  const mats = all.filter((m) => !m.archived);
  const old = all.filter((m) => m.archived);
  $('#matSentCount').textContent = mats.length;
  $('#matSentEmpty').classList.toggle('hidden', mats.length > 0);
  $('#matSentList').replaceChildren(...mats.map(materialItem),
    old.length ? h('details', { class: 'mat-archive' },
      h('summary', {}, `🗂️ 지난 수업 자료 ${old.length}개 (학생 화면에서 내려감)`),
      old.map((m) => h('div', { class: 'mat-item archived' },
        h('div', { class: 'mat-item-top' },
          h('div', { class: 'mat-ico' }, m.kind === 'link' ? '🔗' : iconOf(m.ext)),
          h('div', { class: 'mat-info' },
            h('div', { class: 'mat-name', title: m.name }, m.name),
            h('div', { class: 'mat-sub' }, `${m.kind === 'link' ? hostOf(m.url) : formatBytes(m.size)} · ${timeAgo(m.createdAt)} 보냄`)),
          h('button', { class: 'btn sm', onclick: () => restoreMaterial(m) }, '다시 보내기'),
          h('button', { class: 'icon-btn', title: '완전히 삭제', onclick: () => recallMaterial(m) }, '🗑️'))))) : null);
}
async function restoreMaterial(m) {
  try { await api(`/api/master/materials/${m.id}/restore`, { method: 'POST', headers: H() }); toast(`'${m.name}' 을(를) 다시 보냈습니다.`, 'ok'); } catch (e) { toast(e.message, 'error'); }
}
function materialItem(m) {
  {
    const rec = recipientsOf(m);
    const seenN = rec.filter((s) => m.seen[s.id]).length;
    const targetLabel = m.target === 'all' ? '전체 학생' : `${rec.length}명 (${rec.slice(0, 3).map((s) => s.name).join(', ')}${rec.length > 3 ? ' 외' : ''})`;
    const isLink = m.kind === 'link';
    const isImg = !isLink && kindOf(m.ext) === 'image' && m.ext !== 'heic';
    // 링크는 교사가 눌러도 학생 '확인'으로 치지 않도록 원래 주소로 바로 연다
    const open = () => (isLink ? window.open(m.url, '_blank', 'noopener') : openMatPreview(m));
    return h('div', { class: 'mat-item' },
      h('div', { class: 'mat-item-top' },
        h('div', { class: 'mat-ico', onclick: open }, isLink ? '🔗' : isImg ? h('img', { src: matUrl(m), alt: '', loading: 'lazy' }) : iconOf(m.ext)),
        h('div', { class: 'mat-info', onclick: open },
          h('div', { class: 'mat-name', title: isLink ? m.url : m.name }, m.name),
          h('div', { class: 'mat-sub' }, `${isLink ? hostOf(m.url) : formatBytes(m.size)} · ${timeAgo(m.createdAt)} · 받는 사람: ${targetLabel}`)),
        h('span', { class: `badge ${rec.length && seenN === rec.length ? 'ok' : 'primary'}`, title: '자료를 열어 본 학생 수' }, `확인 ${seenN}/${rec.length}`),
        isLink
          ? h('a', { class: 'icon-btn', href: m.url, target: '_blank', rel: 'noopener', title: '링크 열기' }, '↗️')
          : h('a', { class: 'icon-btn', href: matUrl(m, true), title: '다운로드' }, '⬇️'),
        h('button', { class: 'icon-btn', title: '회수(삭제)', onclick: () => recallMaterial(m) }, '🗑️')),
      m.note ? h('p', { class: 'mat-note' }, m.note) : null,
      rec.length ? h('details', { class: 'mat-seen' },
        h('summary', {}, '학생별 확인 여부'),
        h('div', { class: 'mat-seen-list' }, rec.map((s) => h('span', {
          class: m.seen[s.id] ? 'yes' : '', title: m.seen[s.id] ? `${clock(m.seen[s.id])} 확인` : '아직 안 봄',
        }, `${m.seen[s.id] ? '✓' : '·'} ${s.seat}. ${s.name}`)))) : null);
  }
}
async function recallMaterial(m) {
  if (!(await confirmDialog(`'${m.name}' 자료를 회수할까요?\n학생 화면에서도 사라집니다.`, { ok: '회수', danger: true }))) return;
  try { await api(`/api/master/materials/${m.id}`, { method: 'DELETE', headers: H() }); toast('회수했습니다.'); } catch (e) { toast(e.message, 'error'); }
}

// 자료 미리보기 (교사가 열어도 학생 '확인'으로 치지 않음)
function openMatPreview(m) {
  $('#matPvTitle').textContent = m.name;
  $('#matPvDownload').href = matUrl(m, true);
  $('#matPvModal').classList.remove('hidden');
  renderPreview($('#matPvBox'), {
    name: m.name, ext: m.ext, size: m.size, url: matUrl(m),
    pdfUrl: S.canConvert && CONVERTIBLE.has(m.ext) ? `/materials/${m.id}/pdf?t=${encodeURIComponent(token)}` : null,
  });
}
function closeMatPreview() {
  const box = $('#matPvBox');
  box._token = null;
  box.querySelectorAll('video, audio').forEach((x) => x.pause());
  box.innerHTML = '';
  closeModal('#matPvModal');
}
$('#matPvModal').addEventListener('click', (e) => { if (e.target.id === 'matPvModal' || e.target.closest('[data-close]')) closeMatPreview(); });

// ------------------------------------------------------------ 인증 메일 (Gmail Apps Script → 이 사이트)
const inboxStudents = (m) => (S.mailboxes || []).filter((b) => m.to.includes(b.address));
const liveInbox = () => (S.inbox || []).filter((m) => Date.now() - m.at < S.inboxTtlMin * 60000);

function appsScriptCode() {
  return `// 과제 보드 연결 — 이 Gmail 로 온 메일 중 QUERY 에 맞는 것만 과제 보드로 보냅니다.
const SITE = '${location.origin}';
const KEY = '${S.inboxKey}';
const QUERY = 'from:(openai.com OR anthropic.com) newer_than:1d'; // 가져올 메일 조건 (Gmail 검색어): OpenAI 코드 메일 + Claude 로그인 링크 메일

// 처음 한 번 실행: 1분마다 자동 확인하도록 등록
function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendToBoard').timeBased().everyMinutes(1).create();
  PropertiesService.getScriptProperties().setProperty('since', String(Date.now() - 10 * 60 * 1000));
  sendToBoard();
}

function sendToBoard() {
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('since') || Date.now() - 10 * 60 * 1000);
  let newest = since;
  let failed = false;
  GmailApp.search(QUERY, 0, 30).forEach((thread) => {
    thread.getMessages().forEach((m) => {
      const t = m.getDate().getTime();
      if (t <= since) return;
      const res = UrlFetchApp.fetch(SITE + '/api/inbox', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-inbox-key': KEY },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          id: m.getId(), date: t, from: m.getFrom(), subject: m.getSubject(),
          to: [m.getTo(), m.getCc(), m.getHeader('Delivered-To')].join(', '),
          text: m.getPlainBody().slice(0, 8000),
          anchors: anchors(m.getBody()),
        }),
      });
      if (res.getResponseCode() === 200) newest = Math.max(newest, t); else failed = true;
    });
  });
  if (!failed) props.setProperty('since', String(newest)); // 실패하면 다음 번에 다시 보냄 (중복은 사이트에서 무시)
}

// 메일 본문의 버튼 링크 (Claude 로그인 메일처럼 코드 대신 '로그인' 버튼만 오는 경우)
function anchors(html) {
  const out = [];
  const re = /<a\\b[^>]*?href\\s*=\\s*["'](https:[^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/gi;
  let x;
  while ((x = re.exec(html)) && out.length < 30) {
    out.push({ url: x[1].replace(/&amp;/g, '&'), label: x[2].replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 40) });
  }
  return out;
}
`;
}

function renderInbox() {
  if (!S) return;
  const list = liveInbox();
  $('#inboxCount').textContent = list.length;
  $('#inboxCount').classList.toggle('hidden', !list.length);
  if ($('#inboxModal').classList.contains('hidden')) return;
  renderMailboxes();
  const im = S.inboxImap || {};
  $('#inboxStatus').className = `inbox-status ${im.configured ? (im.ok ? 'ok' : (im.error ? 'err' : '')) : ''}`;
  $('#inboxStatus').textContent = !im.configured
    ? '연결 방식: Apps Script (또는 아직 연결 전) — 서버가 메일함을 직접 확인하려면 아래 연결 설정의 방법 1을 하세요.'
    : im.ok ? `✅ 연결됨 — ${im.user} 메일함을 30초마다 확인 중 (조건: ${im.query}) · 마지막 확인 ${clock(im.lastCheck)}`
      : im.error ? `⚠️ ${im.user}: ${im.error}` : `⏳ ${im.user} 연결 중…`;
  $('#inboxTtl').textContent = ` · ${S.inboxTtlMin}분 뒤 자동 삭제`;
  $('#inboxTtl2').textContent = `${S.inboxTtlMin}분`;
  $('#inboxKey').textContent = S.inboxKey;
  if ($('#inboxCode').value !== appsScriptCode()) $('#inboxCode').value = appsScriptCode();
  $('#inboxEmpty').classList.toggle('hidden', list.length > 0);
  $('#inboxList').replaceChildren(...list.map((m) => {
    const who = inboxStudents(m);
    return h('div', { class: 'inbox-item' },
      h('div', { class: 'inbox-top' },
        m.code ? h('button', { class: 'inbox-code-chip', title: '눌러서 복사', onclick: () => copyText(m.code, '코드를 복사했습니다.') }, m.code) : null,
        h('div', { class: 'inbox-info' },
          h('div', { class: 'inbox-who' }, who.length ? who.map((b) => b.label).join(', ') : h('span', { class: 'muted' }, '등록 안 된 주소'),
            h('span', { class: 'muted small' }, ` · ${m.to.join(', ') || '받는 주소 없음'}`)),
          h('div', { class: 'inbox-subject', title: m.subject }, m.subject || '(제목 없음)'),
          h('div', { class: 'muted small' }, `${clock(m.date)} 수신 · ${m.from}`)),
        h('button', { class: 'icon-btn', title: '지우기', onclick: () => api(`/api/master/inbox/${encodeURIComponent(m.id)}`, { method: 'DELETE', headers: H() }).catch((e) => toast(e.message, 'error')) }, '🗑️')),
      m.links.length ? h('div', { class: 'inbox-links' }, m.links.map((u) => h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', title: '주의: 선생님이 누르면 이 로그인 링크가 사용되어 학생은 쓸 수 없게 됩니다' }, m.code ? '🔗 인증 링크' : '🔑 로그인 링크 (학생이 눌러야 함)'))) : null,
      h('details', { class: 'inbox-text' }, h('summary', {}, '본문 보기'), h('pre', {}, m.text)));
  }));
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg, 'ok'); } catch { toast('복사하지 못했습니다. 직접 선택해 복사해 주세요.', 'error'); }
}
$('#inboxBtn').addEventListener('click', () => {
  $('#inboxModal').classList.remove('hidden');
  $('#inboxSetup').open = !liveInbox().length && !S.inboxImap?.ok;
  renderInbox();
});
$('#inboxCopy').addEventListener('click', () => copyText($('#inboxCode').value, '코드를 복사했습니다. Apps Script 에 붙여넣으세요.'));
$('#inboxRegen').addEventListener('click', async () => {
  if (!(await confirmDialog('연결 키를 새로 만들까요?\n예전 키를 쓰는 Apps Script 는 더 이상 메일을 보내지 못하므로, 새 코드로 다시 붙여넣어야 합니다.', { ok: '재발급', danger: true }))) return;
  try { const r = await api('/api/master/inbox/regen-key', { method: 'POST', headers: H() }); S.inboxKey = r.inboxKey; renderInbox(); toast('재발급했습니다. 코드를 다시 복사해 붙여넣으세요.'); } catch (e) { toast(e.message, 'error'); }
});
setInterval(renderInbox, 60000); // 만료된 메일 숨김

// ------------------------------------------------------------ 참관(게스트) 링크
function renderGuestBar() {
  const g = S.guest;
  const scope = g.courseId ? (S.courses[0]?.name || '') : '모든 과목';
  $('#guestBar').textContent = `👀 참관 모드 · ${g.label} · ${scope} · 읽기 전용 · ${new Date(g.expiresAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}까지`;
  $('#guestBar').classList.remove('hidden');
}
const guestLink = (g) => `${baseUrl()}/master?guest=${g.token}`; // QR 과 같은 접속 주소
function renderGuests() {
  if (GUEST || !S.guests) return;
  const c = course();
  $('#gScope').replaceChildren(
    ...(c ? [h('option', { value: c.id }, `현재 과목만 (${c.name})`)] : []),
    h('option', { value: '' }, '모든 과목'));
  const list = [...S.guests].sort((a, b) => b.createdAt - a.createdAt);
  $('#gList').replaceChildren(...(list.length ? list.map((g) => {
    const cname = g.courseId ? (S.courses.find((x) => x.id === g.courseId)?.name || '삭제된 과목') : '모든 과목';
    const until = new Date(g.expiresAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return h('div', { class: 'guest-item' },
      h('div', { class: 'guest-info' },
        h('div', { class: 'guest-name' }, g.label),
        h('div', { class: 'muted small' }, `${cname} · ${until}까지`)),
      h('button', { class: 'btn sm primary', onclick: () => copyText(guestLink(g), '참관 링크를 복사했습니다. 메신저로 보내 주세요.') }, '링크 복사'),
      h('button', { class: 'btn sm ghost', onclick: () => cancelGuest(g) }, '취소'));
  }) : [h('p', { class: 'muted small' }, '만든 참관 링크가 없습니다.')]));
}
async function cancelGuest(g) {
  if (!(await confirmDialog(`'${g.label}' 참관 링크를 취소할까요?\n지금 보고 있는 화면도 바로 닫힙니다.`, { ok: '취소하기', danger: true }))) return;
  try { await api(`/api/master/guests/${g.id}`, { method: 'DELETE', headers: H() }); toast('취소했습니다.'); } catch (e) { toast(e.message, 'error'); }
}
$('#gCreate').addEventListener('click', async () => {
  try {
    const r = await api('/api/master/guests', {
      method: 'POST', headers: H(),
      body: { label: $('#gLabel').value, courseId: $('#gScope').value || null, hours: Number($('#gHours').value) },
    });
    $('#gLabel').value = '';
    if (!S.guests.some((x) => x.id === r.guest.id)) S.guests.push(r.guest);
    renderGuests();
    copyText(guestLink(r.guest), '참관 링크를 만들고 복사했습니다. 메신저로 보내 주세요.');
  } catch (e) { toast(e.message, 'error'); }
});

// ------------------------------------------------------------ 학생별 코드 확인 링크 (/code/<토큰>)
const codeLink = (b) => `${baseUrl()}/code/${b.token}`;
function renderMailboxes() {
  const list = [...(S.mailboxes || [])].sort((a, b) => a.address.localeCompare(b.address, 'en', { numeric: true }));
  $('#mboxCount').textContent = list.length;
  if (!$('#mboxBase').value) $('#mboxBase').value = S.inboxImap?.user || '';
  $('#mboxList').replaceChildren(...(list.length ? list.map((b) => {
    const live = liveInbox().filter((m) => m.to.includes(b.address));
    return h('div', { class: 'mbox-item' },
      h('div', { class: 'mbox-info' },
        h('div', { class: 'mbox-name' }, b.label, live[0]?.code ? h('span', { class: 'mbox-code' }, live[0].code) : null),
        h('div', { class: 'muted small' }, b.address)),
      h('button', { class: 'btn sm primary', onclick: () => copyText(codeLink(b), `${b.label} 링크를 복사했습니다.`) }, '링크 복사'),
      h('button', { class: 'btn sm', onclick: () => showQr(b) }, 'QR'),
      h('button', { class: 'icon-btn', title: '이름 바꾸기', onclick: () => renameMailbox(b) }, '✏️'),
      h('button', { class: 'icon-btn', title: '링크 다시 만들기 (예전 링크 무효)', onclick: () => regenMailbox(b) }, '🔄'),
      h('button', { class: 'icon-btn', title: '삭제', onclick: () => deleteMailbox(b) }, '🗑️'));
  }) : [h('p', { class: 'muted small' }, '등록한 계정이 없습니다.')]));
}
$('#mboxFill').addEventListener('click', () => {
  const base = $('#mboxBase').value.trim();
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(base);
  if (!m) return toast('기본 주소를 입력해 주세요. (예: ad.bodacompany@gmail.com)', 'error');
  const from = Math.max(1, Number($('#mboxFrom').value) || 1);
  const to = Math.min(from + 199, Math.max(from, Number($('#mboxTo').value) || from));
  const pad = String(to).length < 2 ? 2 : String(to).length;
  const prefix = $('#mboxPrefix').value.trim();
  const lines = [];
  for (let i = from; i <= to; i++) lines.push(`${m[1]}+${prefix}${String(i).padStart(pad, '0')}@${m[2]} ${i}번`);
  $('#mboxText').value = lines.join('\n');
});
$('#mboxAdd').addEventListener('click', async () => {
  try {
    const r = await api('/api/master/mailboxes', { method: 'POST', body: { text: $('#mboxText').value }, headers: H() });
    S.mailboxes = r.mailboxes;
    $('#mboxText').value = '';
    renderMailboxes();
    toast(`${r.added}개 등록했습니다.${r.bad.length ? ` (주소 형식 오류 ${r.bad.length}개: ${r.bad.slice(0, 3).join(', ')})` : ''}`, r.bad.length ? 'error' : 'ok', 5000);
  } catch (e) { toast(e.message, 'error'); }
});
async function renameMailbox(b) {
  const v = await promptDialog(`${b.address} 이름`, b.label);
  if (v == null || !v.trim()) return;
  try { await api(`/api/master/mailboxes/${b.id}`, { method: 'PATCH', body: { label: v }, headers: H() }); } catch (e) { toast(e.message, 'error'); }
}
async function regenMailbox(b) {
  if (!(await confirmDialog(`${b.label} 링크를 다시 만들까요?\n예전 링크·QR 은 바로 쓸 수 없게 되므로 학생에게 새 링크를 다시 줘야 합니다.`, { ok: '다시 만들기', danger: true }))) return;
  try { await api(`/api/master/mailboxes/${b.id}`, { method: 'PATCH', body: { regen: true }, headers: H() }); toast('새 링크를 만들었습니다.'); } catch (e) { toast(e.message, 'error'); }
}
async function deleteMailbox(b) {
  if (!(await confirmDialog(`${b.label} (${b.address}) 를 삭제할까요?\n이 계정의 코드 확인 링크도 쓸 수 없게 됩니다.`, { ok: '삭제', danger: true }))) return;
  try { await api(`/api/master/mailboxes/${b.id}`, { method: 'DELETE', headers: H() }); } catch (e) { toast(e.message, 'error'); }
}
const allCodeLink = () => `${baseUrl()}/code/${S.codeAllToken}`;
$('#mboxAllCopy').addEventListener('click', () => copyText(allCodeLink(), '통합 링크를 복사했습니다. 모든 계정의 코드가 보이니 학생에게는 주지 마세요.'));
$('#mboxAllQr').addEventListener('click', () => showQr({ label: '전체 계정', address: `${(S.mailboxes || []).length}개 계정`, token: S.codeAllToken }));
$('#mboxAllRegen').addEventListener('click', async () => {
  if (!(await confirmDialog('통합 링크를 다시 만들까요?\n예전 통합 링크·QR 은 바로 쓸 수 없게 됩니다.', { ok: '다시 만들기', danger: true }))) return;
  try { const r = await api('/api/master/mailboxes/all-link/regen', { method: 'POST', headers: H() }); S.codeAllToken = r.codeAllToken; toast('새 통합 링크를 만들었습니다.'); } catch (e) { toast(e.message, 'error'); }
});
function showQr(b) { showQrPage(`🔑 ${b.label}`, b.address, codeLink(b)); }
function showQrPage(title, sub, url) {
  const w = window.open('', '_blank', 'width=420,height=560');
  if (!w) return toast('팝업이 차단되었습니다.', 'error');
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${escHtml(title)}</title><body style="font-family:sans-serif;text-align:center;padding:24px">
    <h2 style="margin:0 0 4px">${escHtml(title)}</h2><div style="color:#666;font-size:13px">${escHtml(sub)}</div>
    <img src="/api/qr?text=${encodeURIComponent(url)}" style="width:300px;height:300px;margin:12px 0"><div style="font-size:12px;word-break:break-all;color:#666">${escHtml(url)}</div></body>`);
}
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
$('#mboxPrint').addEventListener('click', () => {
  const list = [...(S.mailboxes || [])].sort((a, b) => a.address.localeCompare(b.address, 'en', { numeric: true }));
  if (!list.length) return toast('등록한 계정이 없습니다.', 'error');
  const w = window.open('', '_blank');
  if (!w) return toast('팝업이 차단되었습니다.', 'error');
  w.document.write(`<!doctype html><meta charset="utf-8"><title>코드 확인 QR 카드</title>
  <style>body{font-family:sans-serif;margin:16px}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .c{border:1px dashed #999;border-radius:10px;padding:10px;text-align:center;break-inside:avoid}
  .c img{width:150px;height:150px}.n{font-weight:800;font-size:16px}.a{font-size:11px;color:#555;word-break:break-all}
  .t{font-size:11px;color:#777;margin-top:4px}@media print{button{display:none}}</style>
  <button onclick="print()">🖨️ 인쇄</button><h3>${escHtml(S.siteTitle)} · 인증 코드 확인 QR</h3><div class="g">${list.map((b) => `
    <div class="c"><div class="n">🔑 ${escHtml(b.label)}</div><img src="/api/qr?text=${encodeURIComponent(codeLink(b))}"><div class="a">${escHtml(b.address)}</div>
    <div class="t">휴대폰으로 찍어 즐겨찾기 · 다른 사람에게 보여 주지 마세요</div></div>`).join('')}</div>`);
});
