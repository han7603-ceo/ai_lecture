// 학생용 인증 코드 확인 페이지: /code/<토큰> — 등록된 계정 주소로 온 코드만 표시 (과목·입장과 무관)
import { $, h, api, toast, timeAgo } from './common.js';

const token = location.pathname.split('/').pop();
let data = null;
let freshId = null;

// 개인 링크는 최신 코드 1개, 통합 링크는 계정마다 최신 1개 + 이전 코드 몇 개 (메일 받은 시각 기준)
const ALL_PER_ADDRESS = 3;
const newest = (a, b) => (b.date || b.at) - (a.date || a.at);
function latest() {
  const sorted = [...data.inbox].sort(newest);
  if (!data.all) return sorted.slice(0, 1).map((m) => ({ ...m, older: [] }));
  const groups = new Map();
  for (const m of sorted) {
    if (!groups.has(m.address)) groups.set(m.address, { ...m, older: [] });
    else if (groups.get(m.address).older.length < ALL_PER_ADDRESS - 1) groups.get(m.address).older.push(m);
  }
  return [...groups.values()];
}
const olderRow = (m) => h('div', { class: 'code-old' },
  m.code ? h('button', { class: 'code-old-num', title: '눌러서 복사', onclick: () => copy(m.code) }, m.code) : h('span', { class: 'muted' }, m.links.length ? '로그인 링크' : '코드 없음'),
  h('span', { class: 'muted small' }, `${timeAgo(m.date || m.at)}`));
function render() {
  const list = latest();
  $('#cEmpty').classList.toggle('hidden', list.length > 0);
  $('#cHint').textContent = list.length ? (data.all
    ? `계정마다 최근 ${ALL_PER_ADDRESS}개까지 표시합니다. 맨 위 큰 숫자가 가장 최근 코드입니다. 코드는 ${data.ttlMin}분 뒤 사라집니다.`
    : `가장 최근에 온 코드만 표시합니다. 코드는 ${data.ttlMin}분 뒤 사라집니다.`) : '';
  $('#cList').replaceChildren(...list.map((m) => h('div', { class: `card code-card ${m.id === freshId ? 'fresh' : ''}` },
    data.all ? h('div', { class: 'code-who' }, m.address) : null,
    m.code ? h('button', { class: 'code-big', title: '눌러서 복사', onclick: () => copy(m.code) }, m.code)
      : h('div', { class: 'code-sub' }, m.links.length ? '🔑 코드 대신 로그인 링크로 온 메일입니다 (보통 10분 안에 사용)' : '코드가 없는 메일입니다.'),
    h('div', { class: 'code-sub' }, `${timeAgo(m.date || m.at)} 도착${m.code ? ' · 누르면 복사' : ''}`),
    h('div', { class: 'code-sub', title: m.subject }, m.subject || ''),
    m.links.length ? h('div', { class: 'code-links' }, m.links.map((u) => h('a', { class: `btn ${m.code ? 'sm' : 'primary'}`, href: u, target: '_blank', rel: 'noopener noreferrer' }, m.code ? '🔗 인증 링크 열기' : '🔑 로그인 링크 열기'))) : null,
    !m.code && m.links.length ? h('div', { class: 'code-sub code-tip' }, '로그인을 시작한 PC(같은 브라우저)에서 누르면 바로 로그인됩니다. 휴대폰에서 눌렀다면 화면에 나온 코드를 PC에 입력하세요. 한 번 누르면 다시 쓸 수 없습니다.') : null,
    m.older.length ? h('div', { class: 'code-olds' }, h('div', { class: 'muted small' }, '이전 코드'), m.older.map(olderRow)) : null)));
}
async function copy(code) {
  try { await navigator.clipboard.writeText(code); toast('코드를 복사했습니다.', 'ok'); } catch { toast(`코드: ${code}`, 'info', 6000); }
}
function fail(msg) {
  document.querySelector('main').replaceChildren(h('div', { class: 'card code-error' },
    h('div', { class: 'code-empty-icon' }, '🔒'), h('p', {}, h('b', {}, msg))));
}

// Google OTP (2단계 인증 6자리): 서버가 30초마다 바뀌는 코드를 계산해 줌. 바뀔 때만 다시 받아 옴
let otp = null; // { code, period, remaining, account, at }
let otpTimer = null;
function otpLeft() { return otp ? Math.max(0, otp.remaining - Math.floor((Date.now() - otp.at) / 1000)) : 0; }
function renderOtp() {
  const box = $('#cOtp');
  if (!data?.otp) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const left = otpLeft();
  box.replaceChildren(h('div', { class: 'card code-card otp-card' },
    h('div', { class: 'code-who' }, '🔐 Google 2단계 인증 코드'),
    otp?.account && otp.account !== data.address ? h('div', { class: 'code-sub' }, otp.account) : null,
    otp && left > 0 ? h('button', { class: 'code-big otp-big', title: '눌러서 복사', onclick: () => copy(otp.code) }, otp.code)
      : h('div', { class: 'code-sub' }, otp?.error || '새 코드를 불러오는 중…'),
    otp && left > 0 ? h('div', { class: 'otp-bar' }, h('span', { id: 'otpBar' })) : null,
    otp && left > 0 ? h('div', { class: 'code-sub', id: 'otpLeft' }) : null,
    h('div', { class: 'code-sub code-tip' }, 'Google 로그인 중 2단계 화면이 나오면 「다른 방법 시도」 → 「Google OTP 앱에서 인증 코드 받기」를 고르고 이 숫자를 입력하세요. 시간이 거의 다 됐으면 새 코드를 기다렸다 입력하세요.')));
  tickOtp();
}
// 1초마다 남은 시간만 고침 (버튼을 다시 만들지 않아 누르는 중에 끊기지 않음)
function tickOtp() {
  if (!$('#otpLeft')) return; // 코드가 화면에 있을 때만 (다 된 코드는 renderOtp 가 '불러오는 중'으로 바꿈)
  const left = otpLeft();
  if (left <= 0) return renderOtp();
  $('#otpLeft').textContent = `${left}초 뒤 새 코드로 바뀝니다 · 누르면 복사`;
  $('#otpBar').style.width = `${(left / otp.period) * 100}%`;
}
async function refreshOtp() {
  clearTimeout(otpTimer);
  if (!data?.otp) return renderOtp();
  try {
    const r = await api(`/api/code/${encodeURIComponent(token)}/otp`);
    otp = { ...r, at: Date.now() };
    otpTimer = setTimeout(refreshOtp, r.remaining * 1000 + 300);
  } catch (e) {
    otp = { error: e.message, at: Date.now(), remaining: 0, period: 30 };
    otpTimer = setTimeout(refreshOtp, 10000);
  }
  renderOtp();
}

async function load() {
  try { data = await api(`/api/code/${encodeURIComponent(token)}`); } catch (e) { return fail(e.message); }
  document.title = `인증 코드 · ${data.siteTitle}`;
  $('#cSite').textContent = data.siteTitle;
  $('#cLabel').textContent = data.all ? '전체 계정 인증 코드' : '인증 코드';
  $('#cAddr').textContent = data.address;
  render();
  refreshOtp();
}

await load();
if (data) {
  const socket = io({ auth: { role: 'code', token } });
  socket.on('connect', () => { $('#cDot').classList.add('on'); load(); });
  socket.on('disconnect', (reason) => {
    $('#cDot').classList.remove('on');
    if (reason === 'io server disconnect') fail('링크가 다시 만들어졌거나 삭제되었습니다. 선생님께 새 링크를 받아 주세요.');
  });
  socket.on('inbox:new', (m) => {
    if (data.inbox.some((x) => x.id === m.id)) return;
    data.inbox.unshift(m);
    freshId = m.id;
    navigator.vibrate?.(200);
    toast(m.code ? `🔑 새 코드: ${m.code}` : '🔑 새 인증 메일', 'ok', 6000);
    render();
  });
  socket.on('inbox:remove', ({ ids }) => { data.inbox = data.inbox.filter((m) => !ids.includes(m.id)); render(); });
  setInterval(render, 30000);
  setInterval(tickOtp, 1000);
  // 휴대폰 화면이 꺼졌다 켜지면 타이머가 밀리므로 바로 새 코드를 받음
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data?.otp) refreshOtp(); });
}
