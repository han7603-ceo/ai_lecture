import {
  $, $$, h, api, toast, formatBytes, timeAgo, clock, iconOf, kindOf, extOf, ACCEPT, confirmDialog, promptDialog,
} from './common.js';
import { renderPreview, thumbFor } from './preview.js';

const CONVERTIBLE = new Set(['doc', 'docx', 'ppt', 'pptx', 'pps', 'ppsx', 'xls', 'xlsx', 'hwp']);
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
let viewMode = store.get('lb_view') === 'thumb' ? 'thumb' : 'list'; // 좌석 박스: 파일 목록 / 썸네일
let sortMode = store.get('lb_sort') || 'seat'; // seat: 자리순, recent: 최근 제출순, new: 확인 필요 우선
let boxH = 160; // 현재 좌석 박스 높이(px) — 박스 안에 보여줄 파일 줄 수 계산에 사용
let detailSince = 0; // 크게 보기를 연 시점의 '마지막 확인 시각' (그 이후 파일에 NEW 표시)
let query = '';
let socket = null;
let detailId = null;
let detailFileId = null;

const H = () => ({ 'x-master-token': token });
const fileUrl = (f, dl) => `/files/${f.id}?t=${encodeURIComponent(token)}${dl ? '&download=1' : ''}`;
const course = () => S?.courses.find((c) => c.id === courseId);
const byRecent = (a, b) => b.uploadedAt - a.uploadedAt;
// 교사가 마지막으로 확인한 뒤에 올라온 파일 = NEW
const newFiles = (s) => s.files.filter((f) => f.uploadedAt > (s.reviewedAt || 0));
const latestAt = (s) => s.files.reduce((m, f) => Math.max(m, f.uploadedAt), 0);
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
  window.addEventListener('resize', onResize);
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
  socket.on('material:remove', ({ id }) => {
    S.materials = S.materials.filter((m) => m.id !== id);
    renderMaterials();
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
  $('#liveBadge').classList.toggle('hidden', !c.open);
  $('#liveBadge').textContent = c.sessionStartedAt ? `● 수업 중 · ${clock(c.sessionStartedAt)} 시작` : '● 입장·제출 열림';
  $('#startBtn').classList.toggle('hidden', c.open);
  $('#endBtn').classList.toggle('hidden', !c.open);
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
  const done = list.filter((s) => s.files.length).length;
  const files = list.reduce((n, s) => n + s.files.length, 0);
  const unchecked = list.filter((s) => newFiles(s).length).length;
  const stat = (label, val, cls = '') => h('div', { class: `stat ${cls}` }, label, h('b', {}, val));
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
    entries = [...list].sort((a, b) => (sortMode === 'new' ? newFiles(b).length - newFiles(a).length : 0)
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
  const files = [...s.files].reverse().sort(byRecent);
  const latest = files[0];
  const fresh = new Set(newFiles(s).map((f) => f.id));
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
      fresh.size ? h('span', { class: 'new-badge' }, `NEW ${fresh.size}`) : null),
    body,
    h('div', { class: 'seat-foot' },
      files.length ? h('span', { class: 'st-done' }, `✔ 제출 ${files.length}개`) : h('span', { class: 'st-none' }, '미제출'),
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
    closeDetail(); closeModal('#joinModal'); closeModal('#settingsModal'); closeModal('#materialsModal');
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
      h('div', { class: 'dsub' }, `${formatBytes(f.size)} · ${clock(f.uploadedAt)}`)),
    h('a', { class: 'icon-btn', href: fileUrl(f, true), title: '다운로드', onclick: (e) => e.stopPropagation() }, '⬇️'),
    h('button', { class: 'icon-btn', title: '파일 삭제', onclick: (e) => { e.stopPropagation(); deleteFile(s, f); } }, '🗑️')));
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
for (const id of ['#joinModal', '#settingsModal', '#materialsModal', '#matPvModal']) {
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
  const mats = S.materials.filter((m) => m.courseId === courseId).sort((a, b) => b.createdAt - a.createdAt);
  $('#matSentCount').textContent = mats.length;
  $('#matSentEmpty').classList.toggle('hidden', mats.length > 0);
  $('#matSentList').replaceChildren(...mats.map((m) => {
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
  }));
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
