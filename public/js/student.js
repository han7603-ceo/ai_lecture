import {
  $, h, api, toast, formatBytes, timeAgo, extOf, kindOf, iconOf, ACCEPT, confirmDialog, promptDialog,
  assignmentState, dueText, fmtDue, submitStatus,
} from './common.js';
import { renderPreview } from './preview.js';

const params = new URLSearchParams(location.search);
let code = (params.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// 기기에 입장 정보를 기억 → 새로고침/재접속 시 자동 복귀
// 공용 PC 모드면 sessionStorage 에만 둠 → 브라우저(탭)를 닫으면 지워져 다음 사람이 이어서 들어갈 수 없음
const makeStore = (pick) => ({
  get(k) { try { return JSON.parse(pick().getItem(k)); } catch { return null; } },
  set(k, v) { try { if (v == null) pick().removeItem(k); else pick().setItem(k, JSON.stringify(v)); } catch { /* 사생활 보호 모드 */ } },
});
const store = makeStore(() => localStorage);
const session = makeStore(() => sessionStorage);
let sharedPc = session.get('lb_shared') === true;
const tokens = store.get('lb_tokens') || {};
const sessionTokens = session.get('lb_tokens') || {};
let token = code ? (sessionTokens[code] || tokens[code]) : (session.get('lb_last_token') || store.get('lb_last_token'));
const personalKey = params.get('k'); // 개인 입장 링크 (/s/<key> → /student?k=<key>)

let me = null; // { siteTitle, course, student, maxFileMB, allowedExt }
let pending = []; // { id, file, url }
let socket = null;
let allowLeave = false;
let uploading = false;
let pickId; // 제출할 과제 id (null = 기타, undefined = 아직 안 고름 → 마감 임박한 과제로 자동 선택)

const authHeaders = () => ({ 'x-student-token': token });
const fileUrl = (f, download) => `/files/${f.id}?t=${encodeURIComponent(token)}${download ? '&download=1' : ''}`;

// ------------------------------------------------------------ 시작
init();
async function init() {
  if (personalKey) {
    // 주소창·방문 기록에 개인 링크가 남지 않도록 바로 지움
    history.replaceState(null, '', '/student');
    try {
      const r = await api('/api/join/key', { method: 'POST', body: { key: personalKey } });
      remember(r.code, r.token, r.sharedPc);
    } catch (e) {
      code = '';
      token = null;
      await showJoin();
      $('#joinErr').textContent = e.message;
      return;
    }
  }
  if (token) {
    try {
      me = await api('/api/student/me', { headers: authHeaders() });
      return enterMain();
    } catch {
      token = null;
    }
  }
  showJoin();
}

// ------------------------------------------------------------ 이름 등록
async function showJoin() {
  $('#joinView').classList.remove('hidden');
  if (!code) {
    $('#codeField').classList.remove('hidden');
    $('#joinCourse').textContent = '과제 제출 입장';
    $('#codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  } else {
    try {
      const info = await api('/api/join/check', { method: 'POST', body: { code } });
      $('#joinSite').textContent = info.siteTitle;
      $('#joinCourse').textContent = info.courseName;
      document.title = `${info.courseName} · ${info.siteTitle}`;
      if (info.sharedPc) lockShared();
      if (!info.open) $('#joinErr').textContent = '현재 입장이 마감된 과목입니다.';
      else if (info.full) $('#joinErr').textContent = '정원이 가득 찼습니다. 선생님께 문의하세요.';
    } catch (e) {
      $('#joinErr').textContent = e.message;
      $('#codeField').classList.remove('hidden');
    }
  }
  $('#nameInput').focus();
  $('#nameForm').addEventListener('submit', (e) => { e.preventDefault(); join(); });
  $('#pinInput').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
}

// 선생님이 공용 PC 모드로 정한 과목: 체크를 켜고 바꿀 수 없게
function lockShared() {
  $('#sharedInput').checked = true;
  $('#sharedInput').disabled = true;
  $('#sharedRow').classList.add('locked');
  $('#sharedHint').textContent = '이 과목은 선생님이 공용 PC 모드로 정했어요. 브라우저를 닫으면 자동으로 나가집니다.';
}
function remember(c, t, shared = sharedPc) {
  token = t;
  code = c || code;
  sharedPc = !!shared;
  if (sharedPc) {
    // 이 PC 에는 남기지 않음 (예전에 저장된 것도 지움)
    if (code) { sessionTokens[code] = token; delete tokens[code]; }
    session.set('lb_tokens', sessionTokens);
    session.set('lb_last_token', token);
    session.set('lb_shared', true);
    store.set('lb_tokens', tokens);
    if (store.get('lb_last_token') === token) store.set('lb_last_token', null);
  } else {
    if (code) tokens[code] = token;
    store.set('lb_tokens', tokens);
    store.set('lb_last_token', token);
  }
}
// 이 기기에 남은 입장 정보 모두 지우기
function forget() {
  for (const t of [tokens, sessionTokens]) for (const k of Object.keys(t)) if (t[k] === token || k === code) delete t[k];
  store.set('lb_tokens', tokens);
  session.set('lb_tokens', sessionTokens);
  if (store.get('lb_last_token') === token) store.set('lb_last_token', null);
  session.set('lb_last_token', null);
  session.set('lb_shared', null);
}

async function join() {
  if (!$('#codeField').classList.contains('hidden')) code = $('#codeInput').value.trim().toUpperCase();
  const name = $('#nameInput').value.trim();
  const pin = $('#pinInput').value.trim();
  $('#joinErr').textContent = '';
  if (!/^\d{4}$/.test(pin)) { $('#joinErr').textContent = 'PIN은 숫자 4자리로 입력해 주세요.'; return $('#pinInput').focus(); }
  $('#joinBtn').disabled = true;
  try {
    const r = await api('/api/join', { method: 'POST', body: { code, name, pin } });
    remember(code, r.token, r.sharedPc || $('#sharedInput').checked);
    me = await api('/api/student/me', { headers: authHeaders() });
    history.replaceState(null, '', `/student?code=${code}`);
    $('#joinView').classList.add('hidden');
    if (!r.reclaimed || sharedPc) linkPref().set('lb_link_hidden', false); // 처음 입장(공용 PC 는 매번)하면 개인 링크 안내를 보여 줌
    enterMain();
    if (r.reclaimed) toast('다시 입장했습니다. 다른 기기에서 열려 있던 화면은 로그아웃됩니다.');
  } catch (e) {
    $('#joinErr').textContent = e.message;
  } finally {
    $('#joinBtn').disabled = false;
  }
}

// ------------------------------------------------------------ 메인 화면
function enterMain() {
  $('#mainView').classList.remove('hidden');
  $('#fileInput').accept = ACCEPT;
  $('#limitInfo').textContent = `파일당 최대 ${me.maxFileMB}MB`;
  renderHeader();
  renderMyLink();
  renderShare();
  renderMaterials();
  renderAssignments();
  renderHeader();
  renderDone();
  bindUpload();
  connectSocket();
  guardLeave();
  // 남은 시간·마감 상태 갱신 (실제 마감 판단은 서버가 함)
  setInterval(() => { renderAssignments(); renderHeader(); }, 30000);
}

function renderHeader() {
  document.body.classList.toggle('shared-pc', sharedPc);
  $('#footResume').textContent = sharedPc
    ? '공용 PC 모드: 브라우저를 닫거나 🚪 나가기를 누르면 이 PC에서 나가집니다.'
    : '같은 기기로 다시 들어오면 자동으로 이어집니다.';
  $('#siteTitle').textContent = me.siteTitle;
  $('#courseName').textContent = me.course.name;
  $('#myName').textContent = me.student.name;
  $('#mySeat').textContent = `${me.student.seat}번`;
  document.title = `${me.course.name} · ${me.siteTitle}`;
  const closed = !me.course.open;
  $('#closedNotice').classList.toggle('hidden', !closed);
  const a = pickedAssignment();
  const st = a && assignmentState(a);
  const note = $('#assignClosedNotice');
  note.classList.toggle('hidden', closed || !a || st === 'open');
  note.classList.toggle('danger', st === 'closed');
  note.classList.toggle('warn', st === 'late');
  if (st === 'closed') note.textContent = `⛔ '${a.title}' 과제는 마감되었습니다. 다른 과제를 고르세요.`;
  if (st === 'late') note.textContent = `⏰ '${a.title}' 과제는 마감이 지났습니다. 지금 내면 '지각'으로 표시됩니다.`;
  const stop = closed || st === 'closed';
  $('#dropzone').classList.toggle('disabled', stop);
  $('#uploadBtn').disabled = stop || uploading;
  $('#linkBtn').disabled = stop;
  $('#linkAdd').disabled = stop;
}

// ------------------------------------------------------------ 링크 제출 (미리보기 단계 없이 바로 제출, 여러 개는 「＋ 추가」로 모아서)
let pendingLinks = []; // { url, title }
const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
function addLink(url, title = '', quiet = false) {
  url = url.trim();
  if (!url) return false;
  if (pendingLinks.some((l) => l.url === url)) { if (!quiet) toast('이미 목록에 있는 링크입니다.'); return false; }
  // 고른 과제에 이미 낸 주소면 넣지 않음 (서버도 한 번 더 확인)
  const norm = (u) => u.replace(/^(?!https?:\/\/)/i, 'https://').replace(/\/+$/, '');
  if (me.student.files.some((f) => f.kind === 'link' && (f.assignmentId || null) === (pickId || null) && norm(f.url) === norm(url))) {
    if (!quiet) toast('이미 제출한 링크입니다.', 'error');
    return false;
  }
  pendingLinks.push({ url, title: title.trim() });
  return true;
}
function renderLinkPending() {
  $('#linkPending').replaceChildren(...pendingLinks.map((l, i) => h('div', { class: 'lp-item' },
    h('span', {}, '🔗'),
    h('span', { class: 'lp-text', title: l.url }, l.title ? h('span', { class: 'lp-title' }, l.title) : null, l.url),
    h('button', { class: 'icon-btn', type: 'button', title: '목록에서 빼기', onclick: () => { pendingLinks.splice(i, 1); renderLinkPending(); } }, '✕'))));
  const n = pendingLinks.length + ($('#linkUrl').value.trim() ? 1 : 0);
  $('#linkBtn').textContent = n > 1 ? `링크 ${n}개 제출` : '링크 제출';
}
// 입력칸의 링크를 목록으로 (여러 줄·여러 주소를 붙여넣었으면 모두)
function takeInput() {
  const text = $('#linkUrl').value.trim();
  if (!text) return 0;
  const found = text.match(URL_IN_TEXT);
  const urls = found && found.length > 1 ? found : [text];
  let n = 0;
  for (const u of urls) if (addLink(u, urls.length === 1 ? $('#linkTitle').value : '', urls.length > 1)) n++;
  $('#linkUrl').value = '';
  $('#linkTitle').value = '';
  return n;
}
$('#linkAdd').addEventListener('click', () => {
  if (!$('#linkUrl').value.trim()) return $('#linkUrl').focus();
  takeInput();
  renderLinkPending();
  $('#linkUrl').focus();
});
$('#linkUrl').addEventListener('input', renderLinkPending);
// 주소 여러 개를 한꺼번에 붙여넣으면 바로 목록으로
$('#linkUrl').addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text') || '';
  const found = text.match(URL_IN_TEXT) || [];
  if (found.length < 2) return;
  e.preventDefault();
  let n = 0;
  for (const u of found) if (addLink(u, '', true)) n++;
  renderLinkPending();
  toast(`링크 ${n}개를 목록에 넣었습니다. 「링크 제출」을 누르면 한 번에 제출됩니다.`, 'ok', 3500);
});
$('#linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!me.course.open) return toast('제출이 마감되었습니다.', 'error');
  if (pickedAssignment() && assignmentState(pickedAssignment()) === 'closed') return toast('마감된 과제입니다. 다른 과제를 고르세요.', 'error');
  takeInput();
  renderLinkPending();
  if (!pendingLinks.length) return $('#linkUrl').focus();
  $('#linkBtn').disabled = true;
  try {
    const r = await api('/api/student/links', { method: 'POST', body: { links: pendingLinks, assignmentId: pickId || null }, headers: authHeaders() });
    const n = r.added ?? pendingLinks.length;
    me.student = r.student;
    pendingLinks = [];
    renderLinkPending();
    renderDone();
    renderAssignments();
    toast(`${pickedAssignment() ? `'${pickedAssignment().title}' 과제에 ` : ''}링크 ${n > 1 ? `${n}개를 ` : '를 '}제출했습니다! ✅${r.skipped ? ` (이미 낸 링크 ${r.skipped}개는 뺐습니다)` : ''}`, 'ok', r.skipped ? 4500 : 2600);
  } catch (err) {
    if (err.status === 409) { pendingLinks = []; renderLinkPending(); } // 전부 이미 낸 링크 → 목록 비움
    toast(err.message, 'error', 4000); // 실패하면 목록은 그대로 두고 고쳐서 다시 제출
  } finally {
    renderHeader();
  }
});

$('#meChip').addEventListener('click', async () => {
  const name = await promptDialog('이름 변경', me.student.name);
  if (name == null || !name.trim() || name.trim() === me.student.name) return;
  try {
    const r = await api('/api/student/name', { method: 'PATCH', body: { name }, headers: authHeaders() });
    me.student = r.student;
    renderHeader();
    toast('이름을 변경했습니다.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
});

function connectSocket() {
  socket = io({ auth: { role: 'student', token } });
  let connectedOnce = false;
  socket.on('connect', async () => {
    $('#connDot').classList.add('on');
    if (shareStream) socket.emit('screen:state', { sharing: true }); // 끊겼다 이어져도 공유 상태 유지
    // 다시 연결되면 끊긴 동안 바뀐 과제·자료를 새로 받음
    if (connectedOnce) {
      try { me = await api('/api/student/me', { headers: authHeaders() }); renderHeader(); renderMaterials(); renderAssignments(); renderHeader(); renderDone(); } catch { /* connect_error 에서 처리 */ }
    }
    connectedOnce = true;
  });
  socket.on('disconnect', () => $('#connDot').classList.remove('on'));
  socket.on('connect_error', async () => {
    $('#connDot').classList.remove('on');
    // 교사가 학생을 삭제했거나 과목이 초기화된 경우
    try { await api('/api/student/me', { headers: authHeaders() }); } catch (e) { if (e.status === 401 || e.status === 410) kicked(); }
  });
  socket.on('course:update', (c) => {
    me.course = c;
    if (c.sharedPc && !sharedPc) { remember(code, token, true); renderMyLink(); } // 선생님이 공용 PC 모드를 켬
    renderHeader();
  });
  socket.on('site:update', ({ siteTitle }) => { me.siteTitle = siteTitle; renderHeader(); });
  socket.on('student:update', (s) => { me.student = s; renderHeader(); renderDone(); renderAssignments(); toast('선생님이 제출 파일을 정리했습니다.'); });
  socket.on('assignment:update', (a) => {
    const i = me.assignments.findIndex((x) => x.id === a.id);
    if (i >= 0) me.assignments[i] = a;
    else {
      me.assignments.push(a);
      toast(`📝 새 과제: ${a.title}`, 'ok', 4000);
    }
    renderAssignments(); renderHeader(); renderDone();
  });
  socket.on('assignment:remove', ({ id }) => {
    me.assignments = me.assignments.filter((a) => a.id !== id);
    if (pickId === id) pickId = undefined;
    renderAssignments(); renderHeader(); renderDone();
  });
  socket.on('kicked', kicked);
  bindScreen();
  socket.on('material:new', (m) => {
    const i = me.materials.findIndex((x) => x.id === m.id);
    if (i >= 0) me.materials[i] = m;
    else {
      me.materials.unshift(m);
      toast(`📥 선생님이 자료를 보냈습니다: ${m.name}`, 'ok', 4000);
    }
    renderMaterials();
  });
  socket.on('material:remove', ({ id }) => {
    me.materials = me.materials.filter((m) => m.id !== id);
    renderMaterials();
  });
}

function kicked() {
  if (typeof shareStream !== 'undefined' && shareStream) stopShare();
  socket?.disconnect();
  forget();
  allowLeave = true;
  alert('선생님이 입장 정보를 초기화했습니다. 다시 입장해 주세요.');
  location.href = code ? `/student?code=${code}` : '/';
}

// ------------------------------------------------------------ 뒤로가기/이탈 방지
function guardLeave() {
  // 1) 뒤로가기: 가짜 히스토리를 하나 쌓아 두고, popstate 시 확인창 표시
  history.pushState({ guard: true }, '', location.href);
  window.addEventListener('popstate', async () => {
    if (allowLeave) return;
    history.pushState({ guard: true }, '', location.href);
    const msg = pending.length
      ? `아직 업로드하지 않은 파일이 ${pending.length}개 있습니다.\n정말 페이지를 나갈까요?`
      : '과제 제출 페이지를 나갈까요?\n(제출한 파일은 그대로 유지됩니다)';
    if (await confirmDialog(msg, { ok: '나가기', cancel: '계속 있기', danger: true })) {
      allowLeave = true;
      history.go(-2);
    }
  });
  // 2) 새로고침/탭 닫기: 브라우저 기본 경고창
  window.addEventListener('beforeunload', (e) => {
    if (allowLeave) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// ------------------------------------------------------------ 업로드 대기열 (미리보기)
function bindUpload() {
  const add = (list) => addFiles([...list]);
  for (const id of ['#fileInput', '#photoInput', '#videoInput', '#audioInput']) {
    $(id).addEventListener('change', (e) => { add(e.target.files); e.target.value = ''; });
  }
  const dz = $('#dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); add(e.dataTransfer.files); });
  $('#clearPending').addEventListener('click', () => { pending.forEach((p) => URL.revokeObjectURL(p.url)); pending = []; renderPending(); });
  $('#uploadBtn').addEventListener('click', doUpload);
}

function addFiles(files) {
  if (!me.course.open) return toast('제출이 마감되었습니다.', 'error');
  const allowed = new Set(me.allowedExt);
  for (const file of files) {
    let name = file.name;
    // 카메라 촬영 파일 등 확장자가 없으면 MIME 으로 보정
    if (!extOf(name)) {
      const e = { 'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav' }[file.type];
      if (e) name = `${name || 'capture'}.${e}`;
    }
    const ext = extOf(name);
    if (!allowed.has(ext)) { toast(`지원하지 않는 형식: ${file.name}`, 'error'); continue; }
    if (file.size > me.maxFileMB * 1024 * 1024) { toast(`${me.maxFileMB}MB 초과: ${file.name}`, 'error'); continue; }
    const f = name === file.name ? file : new File([file], name, { type: file.type });
    pending.push({ id: crypto.randomUUID?.() || String(Math.random()), file: f, ext, url: URL.createObjectURL(f) });
  }
  renderPending();
  if (pending.length) $('#pendingWrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function mediaThumb(ext, url) {
  const k = kindOf(ext);
  if (k === 'image' && ext !== 'heic') return h('img', { src: url, alt: '' });
  if (k === 'video') return h('video', { src: `${url}#t=0.5`, muted: true, playsinline: true, preload: 'metadata' });
  return h('span', { class: 'ficon' }, iconOf(ext));
}

function renderPending() {
  const list = $('#pendingList');
  list.innerHTML = '';
  $('#pendingWrap').classList.toggle('hidden', !pending.length);
  $('#pendingCount').textContent = pending.length;
  $('#uploadBtn').textContent = `최종 업로드 (${pending.length}개)`;
  for (const p of pending) {
    list.append(h('div', { class: 'fcard', onclick: () => openPreview({ name: p.file.name, ext: p.ext, url: p.url, blob: p.file, size: p.file.size }) },
      h('div', { class: 'fthumb' }, mediaThumb(p.ext, p.url)),
      h('span', { class: 'badge warn fbad' }, '대기'),
      h('button', {
        class: 'fremove', title: '빼기',
        onclick: (e) => { e.stopPropagation(); URL.revokeObjectURL(p.url); pending = pending.filter((x) => x !== p); renderPending(); },
      }, '✕'),
      h('div', { class: 'fmeta' },
        h('div', { class: 'fname', title: p.file.name }, p.file.name),
        h('div', { class: 'fsize' }, formatBytes(p.file.size)))));
  }
}

function doUpload() {
  if (!pending.length || uploading) return;
  uploading = true;
  const batch = [...pending];
  const form = new FormData();
  for (const p of batch) form.append('files', p.file, p.file.name);
  const xhr = new XMLHttpRequest();
  const target = pickedAssignment();
  xhr.open('POST', `/api/student/upload${target ? `?a=${encodeURIComponent(target.id)}` : ''}`);
  xhr.setRequestHeader('x-student-token', token);
  $('#progress').classList.remove('hidden');
  $('#uploadBtn').disabled = true;
  $('#clearPending').disabled = true;
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    $('#progressBar').style.width = `${pct}%`;
    $('#progressText').textContent = pct < 100 ? `업로드 중… ${pct}%` : '저장 중…';
  };
  const done = () => {
    uploading = false;
    $('#progress').classList.add('hidden');
    $('#progressBar').style.width = '0';
    $('#clearPending').disabled = false;
    renderHeader();
  };
  xhr.onload = () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* 무시 */ }
    done();
    if (xhr.status >= 200 && xhr.status < 300) {
      batch.forEach((p) => URL.revokeObjectURL(p.url));
      pending = pending.filter((p) => !batch.includes(p));
      me.student = data.student;
      renderPending();
      renderDone();
      renderAssignments();
      toast(`${target ? `'${target.title}' 과제에 ` : ''}${batch.length}개 파일을 제출했습니다! ✅`, 'ok');
    } else {
      toast(data.error || '업로드에 실패했습니다.', 'error', 4000);
    }
  };
  xhr.onerror = () => { done(); toast('네트워크 오류로 업로드하지 못했습니다. 다시 시도하세요.', 'error', 4000); };
  xhr.send(form);
}

// ------------------------------------------------------------ 제출 완료 목록
function renderDone() {
  const files = [...me.student.files].sort((a, b) => b.uploadedAt - a.uploadedAt);
  const list = $('#doneList');
  list.innerHTML = '';
  $('#doneCount').textContent = files.length;
  $('#doneEmpty').classList.toggle('hidden', files.length > 0);
  for (const f of files) {
    if (f.kind === 'link') { list.append(doneLinkItem(f)); continue; }
    const open = () => openPreview({ name: f.name, ext: f.ext, url: fileUrl(f), size: f.size, download: fileUrl(f, true) });
    list.append(h('div', { class: 'done-item' },
      h('div', { class: 'dthumb', onclick: open }, mediaThumb(f.ext, fileUrl(f))),
      h('div', { class: 'dinfo', onclick: open },
        h('div', { class: 'dname', title: f.name }, f.name),
        h('div', { class: 'dsub' }, fileTags(f), `${formatBytes(f.size)} · ${timeAgo(f.uploadedAt)} 제출`)),
      h('div', { class: 'dact' },
        h('a', { class: 'icon-btn', href: fileUrl(f, true), title: '다운로드' }, '⬇️'),
        deleteBtn(f))));
  }
}

function doneLinkItem(f) {
  let host = f.url;
  try { host = new URL(f.url).hostname.replace(/^www\./, ''); } catch { /* 그대로 */ }
  const a = (cls, ...kids) => h('a', { class: cls, href: f.url, target: '_blank', rel: 'noopener' }, ...kids);
  return h('div', { class: 'done-item link-item' },
    a('dthumb', '🔗'),
    a('dinfo',
      h('div', { class: 'dname', title: f.url }, f.name),
      h('div', { class: 'dsub' }, fileTags(f), `${host} · ${timeAgo(f.uploadedAt)} 제출`)),
    h('div', { class: 'dact' },
      a('icon-btn', '↗️'),
      deleteBtn(f)));
}
// 제출물에 붙는 과제 이름·지각 표시
function fileTags(f) {
  const a = assignById(f.assignmentId);
  return [a ? h('span', { class: 'atag' }, a.title) : null, f.late ? h('span', { class: 'atag late' }, '지각') : null];
}
// 마감된 과제의 제출물은 지울 수 없음
function deleteBtn(f) {
  const a = assignById(f.assignmentId);
  if (a && assignmentState(a) === 'closed') return h('span', { class: 'icon-btn locked', title: '마감된 과제라 지울 수 없습니다' }, '🔒');
  return h('button', { class: 'icon-btn', title: '삭제', onclick: () => removeFile(f) }, '🗑️');
}

// ------------------------------------------------------------ 과제
const assignById = (id) => (id ? (me.assignments || []).find((a) => a.id === id) : null);
const pickedAssignment = () => assignById(pickId);
const myFilesFor = (id) => me.student.files.filter((f) => (assignById(f.assignmentId) ? f.assignmentId : null) === id);
// 열린 과제 → 지각 가능 → 마감, 같은 상태끼리는 마감 임박 순
function sortedAssignments() {
  const rank = { open: 0, late: 1, closed: 2 };
  return [...(me.assignments || [])].sort((a, b) => rank[assignmentState(a)] - rank[assignmentState(b)]
    || (a.dueAt || Infinity) - (b.dueAt || Infinity) || a.createdAt - b.createdAt);
}
function renderAssignments() {
  const list = sortedAssignments();
  $('#assignSection').classList.toggle('hidden', !list.length);
  renderPick(list);
  const box = $('#assignList');
  box.innerHTML = '';
  let todo = 0;
  for (const a of list) {
    const st = assignmentState(a);
    const files = myFilesFor(a.id);
    const my = submitStatus(files);
    if (my === '미제출' && st !== 'closed') todo++;
    const soon = st === 'open' && a.dueAt && a.dueAt - Date.now() < 24 * 3600e3;
    const canSubmit = st !== 'closed' && me.course.open;
    box.append(h('div', { class: `assign-card st-${st} ${pickId === a.id ? 'picked' : ''}` },
      h('div', { class: 'ac-main' },
        h('div', { class: 'ac-title' }, h('b', {}, a.title),
          h('span', { class: `ac-my my-${my}` }, my === '미제출' ? '미제출' : `${my === '지각' ? '⏰ 지각' : '✔ 제출'} ${files.length}개`)),
        a.desc ? h('div', { class: 'ac-desc' }, a.desc) : null,
        h('div', { class: `ac-due ${soon ? 'soon' : ''}` }, `🕒 ${dueText(a)}`)),
      canSubmit ? h('button', { class: `btn sm ${files.length ? '' : 'primary'}`, onclick: () => choose(a.id) }, files.length ? '더 내기' : '제출하기') : null));
  }
  $('#assignTodo').textContent = `안 낸 과제 ${todo}`;
  $('#assignTodo').classList.toggle('hidden', !todo);
}
function renderPick(list) {
  $('#assignPickWrap').classList.toggle('hidden', !list.length);
  if (!list.length) { pickId = null; return; }
  if (pickId === undefined || (pickId && !assignById(pickId))) pickId = list.find((a) => assignmentState(a) !== 'closed')?.id ?? null;
  const sel = $('#assignPick');
  sel.innerHTML = '';
  for (const a of list) {
    const st = assignmentState(a);
    const tail = st === 'closed' ? ' (마감)' : st === 'late' ? ' (지각 제출)' : a.dueAt ? ` · ${fmtDue(a.dueAt)}까지` : '';
    sel.append(h('option', { value: a.id, selected: a.id === pickId }, `📝 ${a.title}${tail}`));
  }
  sel.append(h('option', { value: '', selected: !pickId }, '기타 (특정 과제 아님)'));
}
function choose(id) {
  pickId = id;
  renderAssignments();
  renderHeader();
  $('#uploadSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#assignPick').addEventListener('change', (e) => { pickId = e.target.value || null; renderAssignments(); renderHeader(); });

async function removeFile(f) {
  if (!(await confirmDialog(`'${f.name}' ${f.kind === 'link' ? '링크를' : '파일을'} 삭제할까요?\n선생님 화면에서도 사라집니다.`, { ok: '삭제', danger: true }))) return;
  try {
    const r = await api(`/api/student/files/${f.id}`, { method: 'DELETE', headers: authHeaders() });
    me.student = r.student;
    renderDone();
    renderAssignments();
    toast('삭제했습니다.');
  } catch (e) { toast(e.message, 'error'); }
}

// ------------------------------------------------------------ 미리보기 모달
function openPreview(src) {
  $('#pvTitle').textContent = src.name;
  const dl = $('#pvDownload');
  dl.classList.toggle('hidden', !src.download);
  if (src.download) dl.href = src.download;
  $('#pvModal').classList.remove('hidden');
  renderPreview($('#pvBox'), src);
}
function closePreview() {
  $('#pvModal').classList.add('hidden');
  const box = $('#pvBox');
  box._token = null;
  box.querySelectorAll('video, audio').forEach((m) => m.pause());
  box.innerHTML = '';
}
$('#pvClose').addEventListener('click', closePreview);
$('#pvModal').addEventListener('click', (e) => { if (e.target.id === 'pvModal') closePreview(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePreview(); });

// ------------------------------------------------------------ 선생님 자료
const CONVERTIBLE = new Set(['doc', 'docx', 'ppt', 'pptx', 'pps', 'ppsx', 'xls', 'xlsx', 'hwp']);
const matUrl = (m, opt = '') => `/materials/${m.id}?t=${encodeURIComponent(token)}${opt}`;
function renderMaterials() {
  me.materials ||= [];
  const list = [...me.materials].sort((a, b) => b.createdAt - a.createdAt);
  $('#matSection').classList.toggle('hidden', !list.length);
  const newN = list.filter((m) => !m.seenAt).length;
  $('#matNewCount').classList.toggle('hidden', !newN);
  $('#matNewCount').textContent = `NEW ${newN}`;
  $('#matList').replaceChildren(...list.map((m) => (m.kind === 'link' ? linkItem(m) : fileItem(m))));
}
// 링크: 서버를 거쳐(확인 기록) 새 탭으로 이동
function linkItem(m) {
  const href = matUrl(m);
  let host = m.url;
  try { host = new URL(m.url).hostname.replace(/^www\./, ''); } catch { /* 그대로 */ }
  const a = (cls, ...kids) => h('a', { class: cls, href, target: '_blank', rel: 'noopener' }, ...kids);
  return h('div', { class: `done-item link-item ${m.seenAt ? '' : 'is-new'}` },
    a('dthumb', '🔗'),
    a('dinfo',
      h('div', { class: 'dname', title: m.url }, m.seenAt ? null : h('span', { class: 'new-pill' }, 'NEW'), m.name),
      m.note ? h('div', { class: 'dnote' }, m.note) : null,
      h('div', { class: 'dsub' }, `${host} · ${timeAgo(m.createdAt)}`)),
    h('div', { class: 'dact' }, a('btn sm primary', '열기 ↗')));
}
function fileItem(m) {
  const open = () => openPreview({
    name: m.name, ext: m.ext, size: m.size, url: matUrl(m), download: matUrl(m, '&download=1'),
    pdfUrl: me.canConvert && CONVERTIBLE.has(m.ext) ? `/materials/${m.id}/pdf?t=${encodeURIComponent(token)}` : null,
  });
  // 썸네일은 확인(열람)으로 치지 않도록 nt=1
  const thumb = kindOf(m.ext) === 'image' && m.ext !== 'heic' ? h('img', { src: matUrl(m, '&nt=1'), alt: '' }) : h('span', { class: 'ficon' }, iconOf(m.ext));
  return h('div', { class: `done-item ${m.seenAt ? '' : 'is-new'}` },
    h('div', { class: 'dthumb', onclick: open }, thumb),
    h('div', { class: 'dinfo', onclick: open },
      h('div', { class: 'dname', title: m.name }, m.seenAt ? null : h('span', { class: 'new-pill' }, 'NEW'), m.name),
      m.note ? h('div', { class: 'dnote' }, m.note) : null,
      h('div', { class: 'dsub' }, `${formatBytes(m.size)} · ${timeAgo(m.createdAt)}`)),
    h('div', { class: 'dact' },
      h('a', { class: 'icon-btn', href: matUrl(m, '&download=1'), title: '다운로드' }, '⬇️')));
}


// ------------------------------------------------------------ 내 전용 입장 링크
const myLink = () => `${location.origin}/s/${me.student.key}`;
// 링크 안내 숨김 여부: 공용 PC 에서는 이번 접속에서만 기억
const linkPref = () => (sharedPc ? session : store);
function renderMyLink() {
  $('#myLinkCard').classList.toggle('hidden', !me.student.key || linkPref().get('lb_link_hidden') === true);
  $('#myLinkHint').textContent = sharedPc
    ? '공용 PC에는 저장하지 말고, 📱 QR을 휴대폰으로 찍어 저장해 두세요. 다음부터 입장 코드 없이 바로 들어옵니다.'
    : '즐겨찾기·홈 화면에 추가하면 입장 코드 없이 언제든 바로 들어옵니다. 다른 사람에게 보여 주지 마세요.';
}
$('#myLinkCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(myLink()); toast('내 전용 링크를 복사했습니다. 즐겨찾기나 메모에 저장해 두세요.', 'ok', 4000); } catch { await promptDialog('아래 링크를 길게 눌러 복사하세요.', myLink(), { ok: '닫기' }); }
});
$('#myLinkHide').addEventListener('click', () => { linkPref().set('lb_link_hidden', true); renderMyLink(); });
$('#myLinkShow').addEventListener('click', (e) => { e.preventDefault(); linkPref().set('lb_link_hidden', false); renderMyLink(); $('#myLinkCard').scrollIntoView({ behavior: 'smooth' }); });

// ------------------------------------------------------------ 화면 공유 (학생이 직접 시작, 고른 화면만, 언제든 중지)
// 영상은 WebRTC 로 선생님 PC 에 바로 가고, 직접 연결이 안 되면 1초마다 화면 사진을 서버를 거쳐 보냄
const canShare = !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
let shareStream = null;
let shareVideo = null;
let imageCapture = null;
const peers = new Map(); // 선생님 소켓 id -> RTCPeerConnection
const frameTickers = new Map(); // 선생님 소켓 id -> Worker (사진 모드)

function renderShare() {
  $('#shareBtn').classList.toggle('hidden', !canShare || !!shareStream);
  $('#shareBar').classList.toggle('hidden', !shareStream);
  $('#shareText').textContent = peers.size + frameTickers.size
    ? '선생님이 지금 내 화면을 보고 있습니다'
    : '화면 공유 중 · 선생님이 열면 보입니다';
}
async function startShare() {
  if (shareStream) return;
  if (!canShare) return toast('이 기기에서는 화면 공유를 할 수 없습니다. PC의 크롬·엣지에서 해 주세요.', 'error', 4000);
  try {
    shareStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
  } catch (e) {
    shareStream = null;
    if (e.name !== 'NotAllowedError') toast('화면 공유를 시작하지 못했습니다.', 'error');
    socket?.emit('screen:decline');
    return renderShare();
  }
  const track = shareStream.getVideoTracks()[0];
  if ('contentHint' in track) track.contentHint = 'detail'; // 글씨가 잘 보이도록 해상도 우선
  track.addEventListener('ended', stopShare); // 브라우저의 '공유 중지' 버튼
  imageCapture = window.ImageCapture ? new ImageCapture(track) : null;
  shareVideo = document.createElement('video');
  shareVideo.muted = true;
  shareVideo.playsInline = true;
  shareVideo.srcObject = shareStream;
  shareVideo.play().catch(() => {});
  socket.emit('screen:state', { sharing: true });
  renderShare();
  toast('화면 공유를 시작했습니다. 언제든 「공유 중지」로 끌 수 있습니다.', 'ok', 4000);
}
function closeViewer(viewer) {
  peers.get(viewer)?.close();
  peers.delete(viewer);
  frameTickers.get(viewer)?.terminate();
  frameTickers.delete(viewer);
}
function stopShare() {
  if (!shareStream) return;
  for (const v of [...peers.keys(), ...frameTickers.keys()]) closeViewer(v);
  shareStream.getTracks().forEach((t) => t.stop());
  shareStream = null;
  shareVideo = null;
  imageCapture = null;
  socket?.emit('screen:state', { sharing: false });
  renderShare();
  toast('화면 공유를 멈췄습니다.');
}
$('#shareBtn').addEventListener('click', startShare);
$('#shareStop').addEventListener('click', stopShare);

// 다른 창을 보고 있어도(백그라운드) 멈추지 않도록 워커 타이머 사용
function ticker(ms, fn) {
  const w = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: 'text/javascript' })));
  w.onmessage = fn;
  return w;
}
async function grabFrame() {
  if (imageCapture) {
    try { return await imageCapture.grabFrame(); } catch { /* 비디오로 대신 */ }
  }
  return shareVideo?.videoWidth ? shareVideo : null;
}
function startFrames(viewer) {
  const canvas = document.createElement('canvas');
  let busy = false;
  frameTickers.set(viewer, ticker(1000, async () => {
    if (busy || !shareStream) return;
    busy = true;
    try {
      const src = await grabFrame();
      if (!src) return;
      const w = src.videoWidth || src.width;
      const ht = src.videoHeight || src.height;
      const scale = Math.min(1, 1280 / w);
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(ht * scale);
      canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
      src.close?.();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.6));
      if (blob && frameTickers.has(viewer)) socket.emit('screen:frame', { viewer, buf: await blob.arrayBuffer() });
    } finally { busy = false; }
  }));
}

function bindScreen() {
  socket.on('screen:request', async () => {
    if (shareStream) return;
    if (!canShare) {
      socket.emit('screen:decline');
      return toast('선생님이 화면 보기를 요청했지만, 이 기기에서는 화면 공유를 할 수 없습니다.', 'error', 5000);
    }
    const ok = await confirmDialog('선생님이 내 화면을 보고 싶어 합니다.\n\n「공유 시작」을 누르고 보여 줄 화면(전체 화면·창·탭)을 고르세요.\n고른 화면만 보이고, 언제든 「공유 중지」로 끌 수 있습니다.', { ok: '공유 시작', cancel: '거절' });
    if (ok) startShare(); else socket.emit('screen:decline');
  });
  socket.on('screen:watch', async ({ viewer }) => {
    if (!shareStream) return;
    closeViewer(viewer);
    const pc = new RTCPeerConnection({ iceServers: me.iceServers });
    peers.set(viewer, pc);
    shareStream.getTracks().forEach((t) => pc.addTrack(t, shareStream));
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('screen:signal', { viewer, data: { candidate: e.candidate.toJSON() } }); };
    await pc.setLocalDescription(await pc.createOffer());
    socket.emit('screen:signal', { viewer, data: { sdp: pc.localDescription.toJSON() } });
    renderShare();
  });
  socket.on('screen:signal', async ({ viewer, data }) => {
    const pc = peers.get(viewer);
    if (!pc) return;
    try {
      if (data.sdp) await pc.setRemoteDescription(data.sdp);
      else if (data.candidate) await pc.addIceCandidate(data.candidate);
    } catch { /* 늦게 온 연결 후보 등은 무시 */ }
  });
  socket.on('screen:fallback', ({ viewer }) => {
    if (!shareStream) return;
    closeViewer(viewer);
    startFrames(viewer);
    renderShare();
  });
  socket.on('screen:unwatch', ({ viewer }) => { closeViewer(viewer); renderShare(); });
  socket.on('screen:replaced', () => {
    if (!shareStream) return;
    stopShare();
    toast('다른 기기에서 화면 공유를 시작해 이 기기의 공유를 멈췄습니다.');
  });
}

// ------------------------------------------------------------ 나가기 (이 기기에서 입장 정보 지우기)
$('#leaveBtn').addEventListener('click', async () => {
  const msg = sharedPc
    ? '이 PC에서 나갈까요?\n다음 사람이 내 자리로 들어올 수 없도록 입장 정보를 지웁니다.\n제출한 과제는 그대로 남아 있습니다.'
    : '이 기기에서 나갈까요?\n다시 들어오려면 내 전용 링크나 입장 코드·이름·PIN이 필요합니다.\n제출한 과제는 그대로 남아 있습니다.';
  if (!(await confirmDialog(msg, { ok: '🚪 나가기' }))) return;
  if (shareStream) stopShare();
  socket?.disconnect();
  forget();
  allowLeave = true;
  location.href = me?.course?.open && code ? `/student?code=${code}` : '/';
});

// ------------------------------------------------------------ 내 전용 링크 QR (휴대폰으로 찍어 저장)
$('#myLinkQr').addEventListener('click', () => {
  const url = myLink();
  const close = () => bg.remove();
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } },
    h('div', { class: 'modal qr-modal' },
      h('h3', { style: 'margin:0' }, '📱 휴대폰으로 찍어 저장하세요'),
      h('p', { class: 'muted small', style: 'margin:6px 0 0' }, '카메라로 찍고 열린 페이지를 즐겨찾기·홈 화면에 추가하면, 다음부터 이 링크로 바로 들어옵니다.'),
      h('img', { src: `/api/qr?text=${encodeURIComponent(url)}`, alt: '내 전용 링크 QR' }),
      h('div', { class: 'qr-url' }, '다른 사람이 찍지 않게 화면을 가려 주세요'),
      h('button', { class: 'btn primary block', style: 'margin-top:12px', onclick: close }, '닫기')));
  document.body.append(bg);
});
