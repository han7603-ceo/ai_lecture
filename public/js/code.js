// 학생용 인증 코드 확인 페이지: /code/<토큰> — 등록된 계정 주소로 온 코드만 표시 (과목·입장과 무관)
import { $, h, api, toast, timeAgo } from './common.js';

const token = location.pathname.split('/').pop();
let data = null;
let freshId = null;

function render() {
  const list = data.inbox;
  $('#cEmpty').classList.toggle('hidden', list.length > 0);
  $('#cHint').textContent = list.length ? `코드는 ${data.ttlMin}분 동안 표시되고 사라집니다. 가장 위가 최신입니다.` : '';
  $('#cList').replaceChildren(...list.map((m, i) => h('div', { class: `card code-card ${m.id === freshId ? 'fresh' : ''}` },
    m.code ? h('button', { class: 'code-big', title: '눌러서 복사', onclick: () => copy(m.code) }, m.code)
      : h('div', { class: 'code-sub' }, '코드가 없는 메일입니다 — 아래 링크를 확인하세요.'),
    h('div', { class: 'code-sub' }, `${i === 0 ? '최신 · ' : ''}${timeAgo(m.at)} 도착${m.code ? ' · 누르면 복사' : ''}`),
    h('div', { class: 'code-sub', title: m.subject }, m.subject || ''),
    m.links.length ? h('div', { class: 'code-links' }, m.links.map((u) => h('a', { class: 'btn sm', href: u, target: '_blank', rel: 'noopener noreferrer' }, '🔗 인증 링크 열기'))) : null)));
}
async function copy(code) {
  try { await navigator.clipboard.writeText(code); toast('코드를 복사했습니다.', 'ok'); } catch { toast(`코드: ${code}`, 'info', 6000); }
}
function fail(msg) {
  document.querySelector('main').replaceChildren(h('div', { class: 'card code-error' },
    h('div', { class: 'code-empty-icon' }, '🔒'), h('p', {}, h('b', {}, msg))));
}

async function load() {
  try { data = await api(`/api/code/${encodeURIComponent(token)}`); } catch (e) { return fail(e.message); }
  document.title = `${data.label} 인증 코드 · ${data.siteTitle}`;
  $('#cSite').textContent = data.siteTitle;
  $('#cLabel').textContent = `${data.label} 인증 코드`;
  $('#cAddr').textContent = data.address;
  render();
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
}
