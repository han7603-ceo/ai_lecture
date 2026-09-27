// 파일 미리보기 렌더러
// 이미지/영상/음향은 브라우저 기본 기능, PDF 는 pdf.js,
// docx 는 docx-preview, xlsx/pptx/hwpx 는 JSZip 으로 직접 해석해 표시합니다.
import { h, kindOf, iconOf, formatBytes } from './common.js';

let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ||= import('/vendor/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
    return m;
  });
  return pdfjsPromise;
}

async function getBuffer(src) {
  if (src.blob) return src.blob.arrayBuffer();
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`파일을 불러오지 못했습니다 (${res.status})`);
  return res.arrayBuffer();
}

const loading = (msg = '미리보기를 불러오는 중…') => h('div', { class: 'pv-loading' }, h('span', { class: 'spinner' }), msg);

function unsupported(src, msg) {
  return h('div', { class: 'pv-empty' },
    h('div', { class: 'pv-empty-icon' }, iconOf(src.ext)),
    h('div', { class: 'pv-empty-name' }, src.name),
    src.size ? h('div', { class: 'muted' }, formatBytes(src.size)) : null,
    h('p', { class: 'muted' }, msg || '이 형식은 미리보기를 지원하지 않습니다. 다운로드해서 확인하세요.'));
}

/**
 * @param {HTMLElement} box 미리보기를 그릴 영역
 * @param {{name:string, ext:string, url:string, blob?:Blob, size?:number, pdfUrl?:string}} src
 */
export async function renderPreview(box, src) {
  box.innerHTML = '';
  box.className = 'preview';
  const token = Symbol('render');
  box._token = token;
  const alive = () => box._token === token;
  const kind = kindOf(src.ext);

  try {
    switch (kind) {
      case 'image':
        if (src.ext === 'heic') {
          box.append(unsupported(src, 'HEIC 이미지는 일부 브라우저(사파리)에서만 표시됩니다.'));
          box.prepend(h('img', { src: src.url, alt: src.name, class: 'pv-img', onerror: (e) => e.target.remove() }));
        } else {
          box.append(h('img', { src: src.url, alt: src.name, class: 'pv-img' }));
        }
        return;
      case 'video':
        box.append(h('video', { src: src.url, controls: true, playsinline: true, preload: 'metadata', class: 'pv-video' }));
        return;
      case 'audio':
        box.append(h('div', { class: 'pv-audio' },
          h('div', { class: 'pv-audio-icon' }, '🎵'),
          h('div', { class: 'pv-empty-name' }, src.name),
          h('audio', { src: src.url, controls: true, preload: 'metadata' })));
        return;
      case 'pdf':
        return await renderPdf(box, src.url, src.blob, alive);
      case 'text':
        return await renderText(box, src, alive);
    }

    if (src.ext === 'csv') return await renderCsv(box, src, alive);

    // 오피스/한글 문서
    const clientRender = {
      docx: renderDocx, xlsx: renderXlsx, pptx: renderPptx, ppsx: renderPptx, hwpx: renderHwpx,
    }[src.ext];

    if (clientRender) {
      const simple = async (note) => {
        if (!alive()) return;
        if (note) box.append(h('div', { class: 'pv-toolbar' }, h('span', { class: 'muted' }, note)));
        const area = h('div');
        box.append(area);
        await clientRender(area, src, alive);
      };
      // 서버에서 PDF 로 변환할 수 있으면 원본 레이아웃(슬라이드·페이지 모양 그대로)을 우선 표시
      if (src.pdfUrl && src.ext !== 'hwpx') {
        return await renderPdf(box, src.pdfUrl, null, alive, '원본 레이아웃으로 불러오는 중… (처음 여는 문서는 최대 1분)',
          () => simple('⚠ 원본 레이아웃 변환에 실패해 간이 미리보기로 표시합니다.'));
      }
      return await simple(src.ext === 'hwpx' ? null : '간이 미리보기입니다. (원본 모양은 다운로드해서 확인하세요)');
    }

    if (src.pdfUrl) {
      return await renderPdf(box, src.pdfUrl, null, alive, '문서를 PDF 로 변환하는 중… (최대 1분)');
    }
    box.append(unsupported(src, ['doc', 'ppt', 'pps', 'xls', 'hwp'].includes(src.ext)
      ? '구형 문서 형식은 업로드 후 서버에서 변환해 미리볼 수 있습니다 (서버에 LibreOffice 필요). 지금은 다운로드해서 확인하세요.'
      : null));
  } catch (e) {
    if (!alive()) return;
    console.error(e);
    box.innerHTML = '';
    box.append(unsupported(src, `미리보기를 만들 수 없습니다: ${e.message}`));
  }
}

// ---------------------------------------------------------------- PDF
async function renderPdf(box, url, blob, alive, msg, onFail) {
  const ld = loading(msg);
  box.append(ld);
  let pdfjs;
  try {
    pdfjs = await loadPdfJs();
  } catch {
    // pdf.js 를 쓸 수 없는 구형 브라우저 → 브라우저 내장 뷰어로 대체
    ld.remove();
    if (!alive()) return;
    const href = blob ? URL.createObjectURL(blob) : url;
    box.append(h('iframe', { src: href, class: 'pv-frame', title: 'PDF' }),
      h('a', { href, target: '_blank', class: 'btn sm', rel: 'noopener' }, '새 창에서 열기'));
    return;
  }
  let doc;
  try {
    const data = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    doc = await pdfjs.getDocument(data ? { data } : { url }).promise;
  } catch (e) {
    ld.remove();
    if (!alive()) return;
    if (onFail) return onFail(e);
    box.append(h('div', { class: 'pv-empty' },
      h('div', { class: 'pv-empty-icon' }, '⚠️'),
      h('p', { class: 'muted' }, e?.status === 500 || e?.status === 415
        ? '문서를 PDF 로 변환하지 못했습니다. 다운로드해서 확인하세요.'
        : `PDF 를 열 수 없습니다: ${e?.message || e}`)));
    return;
  }
  ld.remove();
  if (!alive()) return;
  const pages = h('div', { class: 'pv-pdf' });
  const info = h('div', { class: 'pv-toolbar' }, h('span', { class: 'muted' }, `총 ${doc.numPages}쪽`));
  box.append(info, pages);
  const LIMIT = 30;
  let next = 1;
  const renderMore = async () => {
    const end = Math.min(doc.numPages, next + LIMIT - 1);
    for (; next <= end; next++) {
      if (!alive()) return;
      const page = await doc.getPage(next);
      const width = Math.max(280, (pages.clientWidth || box.clientWidth || 800) - 8);
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = h('canvas', { class: 'pv-page' });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
      pages.append(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise;
    }
    if (next <= doc.numPages && alive()) {
      const more = h('button', { class: 'btn', onclick: () => { more.remove(); renderMore(); } }, `다음 페이지 더 보기 (${next}~)`);
      pages.append(more);
    }
  };
  await renderMore();
}

// ---------------------------------------------------------------- 텍스트/CSV
async function readText(src) {
  const buf = await getBuffer(src);
  let text = new TextDecoder('utf-8').decode(buf);
  // 한글 윈도우(EUC-KR/CP949) 파일 대응
  if (text.includes('�')) {
    try { text = new TextDecoder('euc-kr').decode(buf); } catch { /* 미지원 */ }
  }
  return text.replace(/^﻿/, '');
}
async function renderText(box, src, alive) {
  const text = await readText(src);
  if (!alive()) return;
  box.append(h('pre', { class: 'pv-text' }, text.slice(0, 200000)));
}
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function renderCsv(box, src, alive) {
  const rows = parseCsv(await readText(src));
  if (!alive()) return;
  box.append(tableFrom(rows));
}

function colName(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
function tableFrom(rows, maxRows = 300, maxCols = 40) {
  const cols = Math.min(maxCols, rows.reduce((m, r) => Math.max(m, r.length), 0));
  const wrap = h('div', { class: 'pv-table-wrap' });
  const table = h('table', { class: 'pv-table' });
  const head = h('tr', {}, h('th', {}, ''));
  for (let c = 0; c < cols; c++) head.append(h('th', {}, colName(c)));
  table.append(h('thead', {}, head));
  const body = h('tbody');
  rows.slice(0, maxRows).forEach((r, i) => {
    const tr = h('tr', {}, h('th', {}, i + 1));
    for (let c = 0; c < cols; c++) tr.append(h('td', {}, r[c] ?? ''));
    body.append(tr);
  });
  table.append(body);
  wrap.append(table);
  if (rows.length > maxRows) wrap.append(h('p', { class: 'muted' }, `… 외 ${rows.length - maxRows}행 (전체는 다운로드해서 확인)`));
  return wrap;
}

// ---------------------------------------------------------------- ZIP 기반 문서 공통
const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
async function openZip(src) {
  if (!window.JSZip) throw new Error('JSZip 로드 실패');
  return window.JSZip.loadAsync(await getBuffer(src));
}
const zipText = async (zip, p) => (zip.file(p) ? zip.file(p).async('string') : null);
async function zipImageUrl(zip, p) {
  const f = zip.file(p);
  if (!f) return null;
  const ext = p.split('.').pop().toLowerCase();
  const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' }[ext];
  if (!type) return null;
  return URL.createObjectURL(new Blob([await f.async('arraybuffer')], { type }));
}
function resolvePath(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
async function readRels(zip, relsPath, baseDir) {
  const txt = await zipText(zip, relsPath);
  const map = {};
  if (!txt) return map;
  for (const r of xml(txt).getElementsByTagName('Relationship')) {
    map[r.getAttribute('Id')] = { type: r.getAttribute('Type') || '', target: resolvePath(baseDir, r.getAttribute('Target') || '') };
  }
  return map;
}
const byNum = (a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] || 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] || 0);

// ---------------------------------------------------------------- DOCX
async function renderDocx(box, src, alive) {
  if (!window.docx?.renderAsync) throw new Error('docx 미리보기 모듈 로드 실패');
  const ld = loading();
  box.append(ld);
  const buf = await getBuffer(src);
  const target = h('div', { class: 'pv-docx' });
  await window.docx.renderAsync(buf, target, null, {
    inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true, experimental: true,
  });
  ld.remove();
  if (!alive()) return;
  box.append(target);
  // 좁은 화면에서는 페이지를 화면 폭에 맞게 축소
  requestAnimationFrame(() => {
    const page = target.querySelector('section.docx');
    if (!page) return;
    const scale = Math.min(1, (box.clientWidth - 8) / (page.offsetWidth + 40));
    if (scale < 1) target.style.zoom = scale;
  });
}

// ---------------------------------------------------------------- XLSX
async function renderXlsx(box, src, alive) {
  const zip = await openZip(src);
  const shared = [];
  const ssTxt = await zipText(zip, 'xl/sharedStrings.xml');
  if (ssTxt) {
    for (const si of xml(ssTxt).getElementsByTagName('si')) {
      shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
    }
  }
  const wb = xml(await zipText(zip, 'xl/workbook.xml') || '<x/>');
  const rels = await readRels(zip, 'xl/_rels/workbook.xml.rels', 'xl');
  const sheets = [...wb.getElementsByTagName('sheet')].map((s) => ({
    name: s.getAttribute('name'),
    path: rels[s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')]?.target,
  })).filter((s) => s.path && zip.file(s.path));
  if (!sheets.length) throw new Error('시트를 찾을 수 없습니다');

  const colIndex = (ref) => {
    const letters = /^[A-Z]+/.exec(ref)?.[0] || 'A';
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const readSheet = async (p) => {
    const doc = xml(await zipText(zip, p));
    const rows = [];
    for (const row of doc.getElementsByTagName('row')) {
      const r = Number(row.getAttribute('r') || rows.length + 1) - 1;
      if (r > 1000) break;
      const cells = rows[r] = [];
      for (const c of row.getElementsByTagName('c')) {
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
        let val = v;
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        cells[colIndex(c.getAttribute('r') || '')] = val;
      }
    }
    for (let i = 0; i < rows.length; i++) rows[i] ||= [];
    return rows;
  };

  const tabs = h('div', { class: 'pv-tabs' });
  const area = h('div');
  const show = async (i) => {
    [...tabs.children].forEach((b, j) => b.classList.toggle('active', i === j));
    area.innerHTML = '';
    area.append(tableFrom(await readSheet(sheets[i].path)));
  };
  sheets.forEach((s, i) => tabs.append(h('button', { class: 'pv-tab', onclick: () => show(i) }, s.name)));
  if (!alive()) return;
  box.append(tabs, area);
  await show(0);
}

// ---------------------------------------------------------------- PPTX
async function renderPptx(box, src, alive) {
  const zip = await openZip(src);
  const thumb = await zipImageUrl(zip, 'docProps/thumbnail.jpeg');
  const slidePaths = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort(byNum);
  const wrap = h('div', { class: 'pv-slides' });
  if (thumb) wrap.append(h('figure', { class: 'pv-cover' }, h('img', { src: thumb, alt: '표지' }), h('figcaption', {}, '표지 미리보기')));
  for (const [i, p] of slidePaths.entries()) {
    const doc = xml(await zipText(zip, p));
    const paras = [...doc.getElementsByTagName('a:p')]
      .map((para) => [...para.getElementsByTagName('a:t')].map((t) => t.textContent).join(''))
      .filter((t) => t.trim());
    const rels = await readRels(zip, p.replace('slides/', 'slides/_rels/') + '.rels', 'ppt/slides');
    const imgs = [];
    for (const r of Object.values(rels)) {
      if (r.type.endsWith('/image')) {
        const u = await zipImageUrl(zip, r.target);
        if (u) imgs.push(u);
      }
    }
    wrap.append(h('div', { class: 'pv-slide' },
      h('div', { class: 'pv-slide-no' }, `슬라이드 ${i + 1}`),
      paras.length ? h('div', { class: 'pv-slide-text' }, paras.map((t, j) => h(j === 0 ? 'strong' : 'p', {}, t))) : null,
      imgs.length ? h('div', { class: 'pv-slide-imgs' }, imgs.map((u) => h('img', { src: u, alt: '' }))) : null,
      !paras.length && !imgs.length ? h('p', { class: 'muted' }, '(텍스트 없음)') : null));
  }
  if (!alive()) return;
  box.append(h('div', { class: 'pv-toolbar' }, h('span', { class: 'muted' }, `슬라이드 ${slidePaths.length}장 · 텍스트/이미지 요약 보기`)), wrap);
}

// ---------------------------------------------------------------- HWPX (OWPML)
async function renderHwpx(box, src, alive) {
  const zip = await openZip(src);
  const prvImg = await zipImageUrl(zip, 'Preview/PrvImage.png');
  const text = await zipText(zip, 'Preview/PrvText.txt');
  const sections = Object.keys(zip.files).filter((p) => /^Contents\/section\d+\.xml$/.test(p)).sort(byNum);
  // 본문 전체 텍스트 (문단 단위)
  const paras = [];
  for (const p of sections) {
    const doc = xml(await zipText(zip, p));
    // 각 글자(hp:t)를 가장 가까운 문단(hp:p)에 묶음 → 표 안 문단도 중복 없이 수집
    const byPara = new Map();
    for (const t of doc.getElementsByTagName('hp:t')) {
      let para = t.parentNode;
      while (para && para.tagName !== 'hp:p') para = para.parentNode;
      byPara.set(para, (byPara.get(para) || '') + t.textContent);
    }
    for (const t of byPara.values()) if (t.trim()) paras.push(t);
  }
  if (!paras.length && text) paras.push(...text.split(/\r?\n/));
  const images = [];
  for (const p of Object.keys(zip.files).filter((x) => x.startsWith('BinData/'))) {
    const u = await zipImageUrl(zip, p);
    if (u) images.push(u);
  }
  if (!alive()) return;
  const wrap = h('div', { class: 'pv-hwpx' });
  if (prvImg) wrap.append(h('figure', { class: 'pv-cover' }, h('img', { src: prvImg, alt: '첫 페이지' }), h('figcaption', {}, '첫 페이지 미리보기')));
  if (paras.length) wrap.append(h('div', { class: 'pv-doc-text' }, paras.slice(0, 2000).map((t) => h('p', {}, t))));
  if (images.length) wrap.append(h('div', { class: 'pv-slide-imgs' }, images.map((u) => h('img', { src: u, alt: '' }))));
  if (!prvImg && !paras.length && !images.length) wrap.append(unsupported(src, '내용을 읽을 수 없습니다.'));
  box.append(wrap);
}

// ---------------------------------------------------------------- 썸네일 (대시보드 박스용)
export function thumbFor(file, url) {
  const k = kindOf(file.ext);
  if (k === 'image' && file.ext !== 'heic') return h('img', { src: url, alt: '', loading: 'lazy', class: 'thumb-media' });
  if (k === 'video') return h('video', { src: `${url}#t=0.5`, muted: true, preload: 'metadata', playsinline: true, class: 'thumb-media' });
  return h('div', { class: 'thumb-icon' }, h('span', {}, iconOf(file.ext)), h('small', {}, file.ext.toUpperCase()));
}
