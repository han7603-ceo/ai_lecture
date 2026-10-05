// 듀얼 모니터용 보기 창: 교사 대시보드(opener)가 보낸 파일을 크게 표시
import { $, h } from './common.js';
import { renderPreview } from './preview.js';

const box = $('#vBox');

function show(p) {
  document.title = `${p.student} · ${p.name}`;
  $('#vStudent').textContent = p.student;
  $('#vName').textContent = p.name;
  $('#vName').title = p.name;
  $('#vDownload').href = p.download;
  $('#vDownload').classList.remove('hidden');
  box.querySelectorAll('video, audio').forEach((m) => m.pause());
  $('.v-body').scrollTop = 0;
  if (p.link) return showLink(p);
  renderPreview(box, p.src);
}

// 링크는 이 창에 띄우지 않고(외부 사이트), 대시보드가 다른 모니터에 따로 연 창 아래에 안내 카드만 표시
function showLink(p) {
  $('#vDownload').classList.add('hidden');
  box._token = null;
  box.className = 'preview';
  box.replaceChildren(h('div', { class: 'pv-empty link-card' },
    h('div', { class: 'pv-empty-icon' }, '🔗'),
    h('div', { class: 'pv-empty-name' }, p.name),
    h('a', { class: 'link-url', href: p.link, target: '_blank', rel: 'noopener' }, p.link)));
}

// 같은 사이트의 교사 대시보드가 보낸 메시지만 받음
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== window.opener) return;
  if (e.data?.type === 'show') show(e.data.payload);
});
window.opener?.postMessage({ type: 'viewer-ready' }, location.origin);

$('#vFull').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
