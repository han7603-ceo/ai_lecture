import {
  $, h, api, toast, formatBytes, timeAgo, extOf, kindOf, iconOf, ACCEPT, confirmDialog, promptDialog,
} from './common.js';
import { renderPreview } from './preview.js';

const params = new URLSearchParams(location.search);
let code = (params.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// 기기에 입장 정보를 기억 → 새로고침/재접속 시 자동 복귀
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 사생활 보호 모드 */ } },
};
const tokens = store.get('lb_tokens') || {};
let token = code ? tokens[code] : store.get('lb_last_token');

let me = null; // { siteTitle, course, student, maxFileMB, allowedExt }
let pending = []; // { id, file, url }
let socket = null;
let allowLeave = false;
let uploading = false;

const authHeaders = () => ({ 'x-student-token': token });
const fileUrl = (f, download) => `/files/${f.id}?t=${encodeURIComponent(token)}${download ? '&download=1' : ''}`;

// ------------------------------------------------------------ 시작
init();
async function init() {
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
      if (!info.open) $('#joinErr').textContent = '현재 입장이 마감된 과목입니다.';
      else if (info.full) $('#joinErr').textContent = '정원이 가득 찼습니다. 선생님께 문의하세요.';
    } catch (e) {
      $('#joinErr').textContent = e.message;
      $('#codeField').classList.remove('hidden');
    }
  }
  $('#nameInput').focus();
  $('#nameForm').addEventListener('submit', (e) => { e.preventDefault(); join(false); });
}

async function join(reclaim) {
  if (!$('#codeField').classList.contains('hidden')) code = $('#codeInput').value.trim().toUpperCase();
  const name = $('#nameInput').value.trim();
  $('#joinErr').textContent = '';
  $('#joinBtn').disabled = true;
  try {
    const r = await api('/api/join', { method: 'POST', body: { code, name, reclaim } });
    token = r.token;
    tokens[code] = token;
    store.set('lb_tokens', tokens);
    store.set('lb_last_token', token);
    me = await api('/api/student/me', { headers: authHeaders() });
    history.replaceState(null, '', `/student?code=${code}`);
    $('#joinView').classList.add('hidden');
    enterMain();
  } catch (e) {
    if (e.status === 409 && e.data?.canReclaim) {
      const ok = await confirmDialog(`'${name}' 이름이 이미 등록되어 있습니다.\n본인이 맞다면 이전에 제출한 과제를 이어서 관리할 수 있습니다.`, { ok: '본인입니다 (재입장)', cancel: '다른 이름 사용' });
      if (ok) return join(true);
    }
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
  renderMaterials();
  renderDone();
  bindUpload();
  connectSocket();
  guardLeave();
}

function renderHeader() {
  $('#siteTitle').textContent = me.siteTitle;
  $('#courseName').textContent = me.course.name;
  $('#myName').textContent = me.student.name;
  $('#mySeat').textContent = `${me.student.seat}번`;
  document.title = `${me.course.name} · ${me.siteTitle}`;
  const closed = !me.course.open;
  $('#closedNotice').classList.toggle('hidden', !closed);
  $('#dropzone').classList.toggle('disabled', closed);
  $('#uploadBtn').disabled = closed || uploading;
  $('#linkBtn').disabled = closed;
}

// ------------------------------------------------------------ 링크 제출 (미리보기 단계 없이 바로 제출)
$('#linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!me.course.open) return toast('제출이 마감되었습니다.', 'error');
  const url = $('#linkUrl').value.trim();
  if (!url) return $('#linkUrl').focus();
  $('#linkBtn').disabled = true;
  try {
    const r = await api('/api/student/links', { method: 'POST', body: { url, title: $('#linkTitle').value }, headers: authHeaders() });
    me.student = r.student;
    $('#linkUrl').value = '';
    $('#linkTitle').value = '';
    renderDone();
    toast('링크를 제출했습니다! ✅', 'ok');
  } catch (err) {
    toast(err.message, 'error', 4000);
  } finally {
    $('#linkBtn').disabled = !me.course.open;
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
  socket.on('connect', () => $('#connDot').classList.add('on'));
  socket.on('disconnect', () => $('#connDot').classList.remove('on'));
  socket.on('connect_error', async () => {
    $('#connDot').classList.remove('on');
    // 교사가 학생을 삭제했거나 과목이 초기화된 경우
    try { await api('/api/student/me', { headers: authHeaders() }); } catch (e) { if (e.status === 401 || e.status === 410) kicked(); }
  });
  socket.on('course:update', (c) => { me.course = c; renderHeader(); });
  socket.on('site:update', ({ siteTitle }) => { me.siteTitle = siteTitle; renderHeader(); });
  socket.on('student:update', (s) => { me.student = s; renderHeader(); renderDone(); toast('선생님이 제출 파일을 정리했습니다.'); });
  socket.on('kicked', kicked);
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
  socket?.disconnect();
  delete tokens[code];
  store.set('lb_tokens', tokens);
  store.set('lb_last_token', null);
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
  xhr.open('POST', '/api/student/upload');
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
      toast(`${batch.length}개 파일을 제출했습니다! ✅`, 'ok');
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
        h('div', { class: 'dsub' }, `${formatBytes(f.size)} · ${timeAgo(f.uploadedAt)} 제출`)),
      h('div', { class: 'dact' },
        h('a', { class: 'icon-btn', href: fileUrl(f, true), title: '다운로드' }, '⬇️'),
        h('button', { class: 'icon-btn', title: '삭제', onclick: () => removeFile(f) }, '🗑️'))));
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
      h('div', { class: 'dsub' }, `${host} · ${timeAgo(f.uploadedAt)} 제출`)),
    h('div', { class: 'dact' },
      a('icon-btn', '↗️'),
      h('button', { class: 'icon-btn', title: '삭제', onclick: () => removeFile(f) }, '🗑️')));
}

async function removeFile(f) {
  if (!(await confirmDialog(`'${f.name}' ${f.kind === 'link' ? '링크를' : '파일을'} 삭제할까요?\n선생님 화면에서도 사라집니다.`, { ok: '삭제', danger: true }))) return;
  try {
    const r = await api(`/api/student/files/${f.id}`, { method: 'DELETE', headers: authHeaders() });
    me.student = r.student;
    renderDone();
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
