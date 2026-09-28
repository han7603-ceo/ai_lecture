// 듀얼 모니터용 보기 창: 교사 대시보드(opener)가 보낸 파일을 크게 표시
import { $ } from './common.js';
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
  renderPreview(box, p.src);
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
