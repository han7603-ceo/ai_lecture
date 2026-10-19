// 제출물 내보내기: 링크 모음 엑셀(.xlsx) / 발표용 PPT(.pptx)
// - 엑셀: 링크 1개 = 1줄, 주소는 눌러서 열리는 하이퍼링크 + 학생 × 과제 제출 현황
// - PPT: 학생마다 1장 (링크·QR·사이트가 주는 미리보기 그림·이미지 제출물), 마지막 장에 미제출 학생
'use strict';
const fsp = require('node:fs/promises');
const dns = require('node:dns').promises;
const net = require('node:net');
const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');
const QRCode = require('qrcode');

const FONT = 'Malgun Gothic';

// ------------------------------------------------------------ 엑셀
/**
 * @param {object} o
 * @param {Array} o.links  [{ seat, name, assignment, title, url, at, late }]
 * @param {Array} o.status [{ seat, name, cells: ['제출'|'지각'|'미제출', ...] }]
 * @param {string[]} o.assignmentTitles 제출 현황 열 이름
 */
async function buildLinksWorkbook({ links, status, assignmentTitles, timeZone, analyses = [] }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '실시간 과제 제출 보드';
  const fmt = (t) => (t ? new Date(t).toLocaleString('ko-KR', { timeZone }) : '');

  const ws = wb.addWorksheet('링크 모음', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: '자리', key: 'seat', width: 6 },
    { header: '이름', key: 'name', width: 12 },
    { header: '과제', key: 'assignment', width: 18 },
    { header: '제목', key: 'title', width: 30 },
    { header: '주소 (눌러서 열기)', key: 'url', width: 60 },
    { header: '제출 시각', key: 'at', width: 22 },
    { header: '지각', key: 'late', width: 6 },
  ];
  for (const l of links) {
    const row = ws.addRow({ seat: l.seat, name: l.name, assignment: l.assignment, title: l.title, url: l.url, at: fmt(l.at), late: l.late ? '지각' : '' });
    const cell = row.getCell('url');
    cell.value = { text: l.url, hyperlink: l.url };
    cell.font = { color: { argb: 'FF1F5EFF' }, underline: true };
  }
  if (!links.length) ws.addRow({ name: '제출된 링크가 없습니다.' });
  styleHeader(ws);
  ws.autoFilter = { from: 'A1', to: 'G1' };

  if (assignmentTitles.length) {
    const st = wb.addWorksheet('제출 현황', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
    st.columns = [{ header: '자리', width: 6 }, { header: '이름', width: 12 }, ...assignmentTitles.map((t) => ({ header: t, width: Math.min(30, Math.max(10, t.length * 2 + 2)) }))];
    for (const r of status) {
      const row = st.addRow([r.seat, r.name, ...r.cells]);
      r.cells.forEach((v, i) => {
        const c = row.getCell(i + 3);
        c.alignment = { horizontal: 'center' };
        if (v === '미제출') c.font = { color: { argb: 'FFD92D20' } };
        if (v === '지각') c.font = { color: { argb: 'FFB54708' } };
      });
    }
    styleHeader(st);
  }
  if (analyses.length) {
    const an = wb.addWorksheet('AI 분석', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
    an.columns = [
      { header: '자리', key: 'seat', width: 6 }, { header: '이름', key: 'name', width: 12 }, { header: '주소', key: 'url', width: 36 },
      { header: '총평', key: 'summary', width: 40 }, { header: '잘된 점', key: 'strengths', width: 50 }, { header: '아쉬운 점', key: 'improvements', width: 50 },
      { header: '제안', key: 'suggestions', width: 40 }, { header: '평가 기준', key: 'criteria', width: 36 }, { header: '보안', key: 'security', width: 36 },
      { header: '교사 메모', key: 'note', width: 30 },
    ];
    for (const r of analyses) {
      const row = an.addRow(r);
      row.alignment = { vertical: 'top', wrapText: true };
      row.getCell('url').value = { text: r.url, hyperlink: r.url };
    }
    styleHeader(an);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function styleHeader(ws) {
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6ECFF' } };
}

// ------------------------------------------------------------ 이미지 (PNG/JPEG/GIF 만, 크기는 직접 읽음)
function imageInfo(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.toString('ascii', 0, 3) === 'GIF') return { type: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0~SOF15 (DHT·JPG·DAC 제외) 에 크기가 있음
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'jpeg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}
const dataUri = (buf, type) => `image/${type};base64,${buf.toString('base64')}`;

// ------------------------------------------------------------ 링크 미리보기 그림 (og:image)
// 학생이 낸 주소를 서버가 직접 읽으므로, 내부망(사설 IP)·이상한 포트로는 가지 않음
// 시험용: ALLOW_PRIVATE_FETCH=1 이면 내부 주소도 허용 (테스트 서버가 localhost 라서)
const allowPrivate = () => process.env.ALLOW_PRIVATE_FETCH === '1';
function privateIp(ip) {
  if (allowPrivate()) return false;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}
// 결과: { ok, status, headers, url, type, buf } / 막히거나 연결 실패면 null
async function safeFetch(url, { maxBytes, timeoutMs = 6000, accept = '*/*' }) {
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || (u.port && !['80', '443'].includes(u.port) && !allowPrivate())) return null;
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => privateIp(a.address))) return null;
    const res = await fetch(u.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ClassBoard/1.0; +link preview)', accept, 'accept-language': 'ko,en;q=0.8' },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, u).href; continue; }
    if (!res.ok || !res.body) return { ok: false, status: res.status, headers: res.headers, url: u.href, type: res.headers.get('content-type') || '', buf: Buffer.alloc(0) };
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > maxBytes) { if (accept.startsWith('image')) return null; break; } // 그림은 너무 크면 포기, HTML 은 앞부분만
      chunks.push(c);
    }
    return { ok: true, status: res.status, headers: res.headers, url: u.href, type: res.headers.get('content-type') || '', buf: Buffer.concat(chunks) };
  }
  return null;
}
async function linkPreview(url) {
  try {
    const page = await safeFetch(url, { maxBytes: 600 * 1024, accept: 'text/html,application/xhtml+xml' });
    if (!page?.ok) return null;
    let img = null;
    if (/^image\//.test(page.type)) img = page; // 주소 자체가 그림
    else {
      const html = page.buf.toString('utf8');
      const meta = (prop) => {
        const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
        const tag = html.match(re)?.[0];
        return tag?.match(/content=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, '&');
      };
      const src = meta('og:image') || meta('og:image:url') || meta('twitter:image');
      if (!src) return null;
      img = await safeFetch(new URL(src, page.url).href, { maxBytes: 4 * 1024 * 1024, accept: 'image/png,image/jpeg,image/gif' });
    }
    const info = img?.ok && imageInfo(img.buf);
    return info && info.w > 0 && info.h > 0 ? { ...info, data: dataUri(img.buf, info.type) } : null;
  } catch {
    return null;
  }
}
// 동시에 4개씩만
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k]); }
  }));
  return out;
}

// ------------------------------------------------------------ PPT
const W = 13.333; // 16:9 와이드
const C = { ink: '1F2433', muted: '6B7385', primary: '3460F5', soft: 'EEF2FF', late: 'B54708', line: 'DFE3EC' };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
// 상자(w×h) 안에 비율을 지켜 가운데 배치
function fit(info, x, y, w, h) {
  const r = Math.min(w / info.w, h / info.h);
  const iw = info.w * r;
  const ih = info.h * r;
  return { x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih };
}

/**
 * @param {object} o
 * @param {string} o.title 과목명
 * @param {string} o.scope 범위 (예: '과제: 포스터 시안' / '모든 제출물')
 * @param {Array} o.students [{ seat, name, items: [{ kind:'link'|'file', title, url?, abs?, ext, assignment, late }] }]
 * @param {Array} o.missing  [{ seat, name }]
 */
async function buildPptx({ title, scope, students, missing, uploadDir }) {
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.title = `${title} — ${scope}`;
  pres.theme = { headFontFace: FONT, bodyFontFace: FONT };

  // 미리보기 그림 미리 모으기 (링크는 og:image, 이미지 파일은 원본)
  const links = [...new Set(students.flatMap((s) => s.items.filter((it) => it.kind === 'link').map((it) => it.url)))];
  const previews = new Map((await mapLimit(links, 4, async (u) => [u, await linkPreview(u)])));
  const submittedCount = students.length;

  // 표지
  const cover = pres.addSlide();
  cover.background = { color: 'F5F7FC' };
  cover.addText(title, { x: 0.8, y: 2.2, w: W - 1.6, h: 1.2, fontSize: 40, bold: true, color: C.ink, fontFace: FONT });
  cover.addText(scope, { x: 0.8, y: 3.4, w: W - 1.6, h: 0.6, fontSize: 22, color: C.primary, fontFace: FONT });
  cover.addText(`제출 ${submittedCount}명 · 미제출 ${missing.length}명 · ${new Date().toLocaleDateString('ko-KR')}`,
    { x: 0.8, y: 4.1, w: W - 1.6, h: 0.5, fontSize: 16, color: C.muted, fontFace: FONT });

  for (const s of students) {
    const slide = pres.addSlide();
    slide.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.95, fill: { color: C.soft }, line: { color: C.soft } });
    slide.addText([
      { text: `${String(s.seat).padStart(2, '0')}  `, options: { color: C.primary, bold: true } },
      { text: s.name, options: { color: C.ink, bold: true } },
      s.items.some((it) => it.late) ? { text: '   ⏰ 지각 포함', options: { color: C.late, fontSize: 14 } } : null,
    ].filter(Boolean), { x: 0.5, y: 0.15, w: W - 1, h: 0.65, fontSize: 24, fontFace: FONT });

    // 오른쪽: 그림 타일 최대 4개 (이미지 제출물 → 링크 미리보기 → 링크 QR 순)
    const tiles = [];
    for (const it of s.items) {
      if (tiles.length >= 4) break;
      if (it.kind === 'file' && ['png', 'jpg', 'jpeg', 'gif'].includes(it.ext) && it.abs) {
        const buf = await fsp.readFile(it.abs).catch(() => null);
        const info = buf && buf.length <= 8 * 1024 * 1024 && imageInfo(buf);
        if (info) tiles.push({ img: { ...info, data: dataUri(buf, info.type) }, caption: it.title, late: it.late });
      }
    }
    for (const it of s.items) {
      if (tiles.length >= 4) break;
      if (it.kind !== 'link') continue;
      const pv = previews.get(it.url);
      if (pv) tiles.push({ img: pv, caption: it.title, url: it.url, late: it.late });
      else {
        const png = await QRCode.toBuffer(it.url, { width: 360, margin: 1 });
        tiles.push({ img: { type: 'png', w: 360, h: 360, data: dataUri(png, 'png') }, caption: `${it.title} (QR)`, url: it.url, late: it.late });
      }
    }
    const listW = tiles.length ? 5.6 : W - 1;

    // 왼쪽: 제출 목록 (링크는 눌러서 열림)
    const lines = [];
    for (const it of s.items.slice(0, 14)) {
      const tag = [it.assignment ? `[${it.assignment}] ` : '', it.late ? '[지각] ' : ''].join('');
      if (it.kind === 'link') {
        lines.push({ text: `🔗 ${tag}${it.title}`, options: { hyperlink: { url: it.url, tooltip: it.url }, color: C.primary, bold: true, breakLine: true } });
        lines.push({ text: `     ${host(it.url)}`, options: { color: C.muted, fontSize: 11, breakLine: true } });
      } else {
        lines.push({ text: `📎 ${tag}${it.title}`, options: { color: C.ink, breakLine: true } });
      }
    }
    if (s.items.length > 14) lines.push({ text: `… 외 ${s.items.length - 14}개 (ZIP 참고)`, options: { color: C.muted, fontSize: 12 } });
    slide.addText(lines, { x: 0.5, y: 1.2, w: listW, h: 5.9, fontSize: 15, fontFace: FONT, valign: 'top', paraSpaceAfter: 4 });

    // 그림 타일 배치: 1개면 크게, 2개 이상이면 2×2
    const area = { x: 6.4, y: 1.2, w: W - 6.4 - 0.5, h: 5.9 };
    const cols = tiles.length === 1 ? 1 : 2;
    const rows = tiles.length <= 2 ? 1 : 2;
    const tw = (area.w - (cols - 1) * 0.25) / cols;
    const th = (area.h - (rows - 1) * 0.25) / rows;
    tiles.forEach((t, k) => {
      const tx = area.x + (k % cols) * (tw + 0.25);
      const ty = area.y + Math.floor(k / cols) * (th + 0.25);
      slide.addShape(pres.ShapeType.rect, { x: tx, y: ty, w: tw, h: th, fill: { color: 'FFFFFF' }, line: { color: C.line } });
      const box = fit(t.img, tx + 0.1, ty + 0.1, tw - 0.2, th - 0.55);
      slide.addImage({ data: t.img.data, ...box, hyperlink: t.url ? { url: t.url } : undefined });
      slide.addText(`${t.late ? '⏰ ' : ''}${t.caption}`, { x: tx + 0.1, y: ty + th - 0.45, w: tw - 0.2, h: 0.4, fontSize: 11, color: C.muted, fontFace: FONT, fit: 'shrink' });
    });
  }

  if (missing.length) {
    const slide = pres.addSlide();
    slide.addText(`미제출 ${missing.length}명`, { x: 0.5, y: 0.3, w: W - 1, h: 0.8, fontSize: 28, bold: true, color: C.ink, fontFace: FONT });
    slide.addText(missing.map((m) => `${String(m.seat).padStart(2, '0')}  ${m.name}`).join('\n'),
      { x: 0.5, y: 1.3, w: W - 1, h: 5.8, fontSize: missing.length > 20 ? 12 : missing.length > 12 ? 14 : 18, color: C.muted, fontFace: FONT, valign: 'top' });
  }
  return pres.write({ outputType: 'nodebuffer' });
}

module.exports = { buildLinksWorkbook, buildPptx, imageInfo, privateIp, safeFetch };
