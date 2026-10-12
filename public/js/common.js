// 공용 유틸리티

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export async function api(url, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) {
    const err = new Error(data?.error || `요청 실패 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function toast(msg, type = 'info', ms = 2600) {
  let wrap = $('#toasts');
  if (!wrap) {
    wrap = h('div', { id: 'toasts' });
    document.body.append(wrap);
  }
  const t = h('div', { class: `toast ${type}` }, msg);
  wrap.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return '방금';
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(ts).toLocaleDateString('ko-KR');
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

const KIND = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'],
  video: ['mp4', 'mov', 'webm', 'm4v'],
  audio: ['wav', 'wave', 'mp3', 'm4a', 'ogg', 'aac'],
  pdf: ['pdf'],
  word: ['doc', 'docx'],
  slide: ['ppt', 'pptx', 'pps', 'ppsx'],
  sheet: ['xls', 'xlsx', 'csv'],
  hwp: ['hwp', 'hwpx'],
  text: ['txt'],
  zip: ['zip'],
  link: ['link'], // 링크 제출
};
export function extOf(name) {
  const m = /\.([^.]+)$/.exec(String(name));
  return m ? m[1].toLowerCase() : '';
}
export function kindOf(ext) {
  for (const [k, list] of Object.entries(KIND)) if (list.includes(ext)) return k;
  return 'file';
}
const ICON = {
  image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', word: '📘', slide: '📙',
  sheet: '📗', hwp: '📄', text: '📝', zip: '🗜️', link: '🔗', file: '📎',
};
export const iconOf = (ext) => ICON[kindOf(ext)];

export const ACCEPT = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic',
  '.mp4', '.mov', '.webm', '.m4v',
  '.wav', '.mp3', '.m4a', '.ogg', '.aac',
  '.pdf', '.hwp', '.hwpx', '.doc', '.docx', '.ppt', '.pptx', '.pps', '.ppsx', '.xls', '.xlsx', '.csv', '.txt', '.zip',
].join(',');

export function confirmDialog(message, { ok = '확인', cancel = '취소', danger = false } = {}) {
  return new Promise((resolve) => {
    const close = (v) => { bg.remove(); resolve(v); };
    const bg = h('div', { class: 'dialog-bg', onclick: (e) => { if (e.target === bg) close(false); } },
      h('div', { class: 'dialog' },
        h('p', { class: 'dialog-msg' }, message),
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn ghost', onclick: () => close(false) }, cancel),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, ok))));
    document.body.append(bg);
    bg.querySelector('.btn:last-child').focus();
  });
}

export function promptDialog(message, value = '', { ok = '저장', type = 'text', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', type, value, placeholder });
    const close = (v) => { bg.remove(); resolve(v); };
    const bg = h('div', { class: 'dialog-bg', onclick: (e) => { if (e.target === bg) close(null); } },
      h('form', { class: 'dialog', onsubmit: (e) => { e.preventDefault(); close(input.value); } },
        h('p', { class: 'dialog-msg' }, message),
        input,
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn ghost', type: 'button', onclick: () => close(null) }, '취소'),
          h('button', { class: 'btn primary', type: 'submit' }, ok))));
    document.body.append(bg);
    input.focus();
    input.select();
  });
}

// ------------------------------------------------------------ 과제 마감
// open: 제출 가능 / late: 마감 지남(지각으로 받음) / closed: 마감
export function assignmentState(a, now = Date.now()) {
  if (a.closed) return 'closed';
  if (a.dueAt && now > a.dueAt) return a.allowLate ? 'late' : 'closed';
  return 'open';
}
export function fmtDue(t) {
  return new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
// '마감까지 2일 3시간' 같은 남은 시간
export function remainText(t, now = Date.now()) {
  const m = Math.max(0, Math.floor((t - now) / 60000));
  if (m < 1) return '1분 미만';
  const d = Math.floor(m / 1440);
  const hr = Math.floor((m % 1440) / 60);
  const mi = m % 60;
  if (d) return `${d}일${hr ? ` ${hr}시간` : ''}`;
  if (hr) return `${hr}시간${mi ? ` ${mi}분` : ''}`;
  return `${mi}분`;
}
export function dueText(a, now = Date.now()) {
  const st = assignmentState(a, now);
  if (a.closed) return '마감됨';
  if (!a.dueAt) return '마감 없음';
  if (st === 'open') return `${fmtDue(a.dueAt)} 마감 · ${remainText(a.dueAt, now)} 남음`;
  return st === 'late' ? `${fmtDue(a.dueAt)} 마감 지남 · 지각 제출 가능` : `${fmtDue(a.dueAt)} 마감됨`;
}
// 이 학생의 과제 제출 상태: '제출' / '지각' / '미제출'
export function submitStatus(files) {
  if (!files.length) return '미제출';
  return files.every((f) => f.late) ? '지각' : '제출';
}
