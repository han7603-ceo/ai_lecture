// 팀 게시판 (교사·학생 화면 공용): 팀 정보·공모전 D-day, 게시판(글·댓글·파일), 할 일, 팀 과제 제출물
import { h, api, toast, formatBytes, iconOf, extOf, timeAgo, confirmDialog, fmtDue } from './common.js';

const toLocalInput = (t) => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);
function dDay(t) {
  const days = Math.ceil((new Date(t).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  return days > 0 ? `D-${days}` : days === 0 ? 'D-DAY' : `마감 ${-days}일 지남`;
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   base: () => string,            // 글·할 일 만들기 API ('/api/master/teams/ID' 또는 '/api/student/team')
 *   headers: () => object,
 *   token: () => string,
 *   teacher?: boolean,
 *   maxFiles: number, allowedExt: () => string[], maxFileMB: () => number,
 *   openAtt: (src) => void,        // 글 첨부 열기 {name, ext, size, url, download, pdfUrl?}
 *   openSubmission: (file) => void, // 팀 과제 제출물 열기
 *   canConvert?: () => boolean,
 *   extraTabs?: { key: string, label: string, el: HTMLElement }[],
 *   onBundle?: (bundle) => void,
 * }} opts
 */
export function createTeamBoard(root, opts) {
  let bundle = null;
  let tab = 'board';
  let files = [];
  const CONVERTIBLE = new Set(['doc', 'docx', 'ppt', 'pptx', 'pps', 'ppsx', 'xls', 'xlsx', 'hwp']);

  const head = h('div', { class: 'tb-head' });
  const tabsEl = h('div', { class: 'tb-tabs', role: 'tablist' });
  // 게시판
  const input = h('textarea', { class: 'input', rows: 3, maxlength: 3000, placeholder: '팀원에게 공유할 아이디어·자료·진행 상황 (화면 캡처는 Ctrl+V 로 붙여넣기)' });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
  const chips = h('div', { class: 'tb-chips' });
  const sendBtn = h('button', { class: 'btn primary', type: 'submit' }, '올리기');
  const composer = h('form', { class: 'tb-compose', autocomplete: 'off' }, input,
    h('div', { class: 'tb-compose-row' }, h('label', { class: 'btn sm', title: `파일 첨부 (최대 ${opts.maxFiles}개)` }, '📎 파일', fileInput), chips, h('span', { class: 'spacer' }), sendBtn));
  const postList = h('div', { class: 'tb-posts' });
  // 할 일
  const taskTitle = h('input', { class: 'input', maxlength: 100, placeholder: '할 일 (예: 기획서 1쪽 쓰기)' });
  const taskWho = h('select', { class: 'input' });
  const taskDue = h('input', { class: 'input', type: 'datetime-local', title: '기한 (선택)' });
  const taskForm = h('form', { class: 'tb-task-form', autocomplete: 'off' }, taskTitle, taskWho, taskDue, h('button', { class: 'btn primary', type: 'submit' }, '＋ 추가'));
  const taskProgress = h('div', { class: 'tb-progress' });
  const taskList = h('div', { class: 'tb-tasks' });
  const subList = h('div', { class: 'tb-subs' });
  const panes = {
    board: h('div', { class: 'tb-pane' }, composer, postList),
    tasks: h('div', { class: 'tb-pane' }, taskForm, taskProgress, taskList),
    subs: h('div', { class: 'tb-pane' }, subList),
  };
  const TABS = [['board', '📋 게시판'], ['tasks', '✅ 할 일'], ['subs', '📦 팀 제출'], ...(opts.extraTabs || []).map((x) => [x.key, x.label])];
  for (const x of opts.extraTabs || []) panes[x.key] = h('div', { class: 'tb-pane' }, x.el);
  root.replaceChildren(head, tabsEl, ...Object.values(panes));

  const call = async (url, init) => {
    const r = await api(url, { ...init, headers: opts.headers() });
    render(r);
    return r;
  };
  const tokenQ = () => `t=${encodeURIComponent(opts.token())}`;

  // --- 첨부 (보내기 전)
  function renderChips() {
    chips.replaceChildren(...files.map((f, i) => h('span', { class: 'tb-chip' }, iconOf(extOf(f.name)), h('span', { class: 'tb-chip-name', title: f.name }, f.name),
      h('span', { class: 'muted' }, formatBytes(f.size)), h('button', { type: 'button', title: '빼기', onclick: () => { files.splice(i, 1); renderChips(); } }, '✕'))));
  }
  function addFiles(list) {
    const allowed = new Set(opts.allowedExt());
    for (const f of list) {
      if (!allowed.has(extOf(f.name))) { toast(`올릴 수 없는 파일 형식입니다: ${f.name}`, 'error'); continue; }
      if (f.size > opts.maxFileMB() * 1024 * 1024) { toast(`${opts.maxFileMB()}MB 초과: ${f.name}`, 'error'); continue; }
      if (files.length >= opts.maxFiles) { toast(`파일은 한 번에 ${opts.maxFiles}개까지 올릴 수 있습니다.`, 'error'); break; }
      files.push(f);
    }
    renderChips();
  }
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  input.addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    addFiles(imgs.map((f, i) => new File([f], `화면캡처_${stamp}${imgs.length > 1 ? `_${i + 1}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) composer.requestSubmit(); });
  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text && !files.length) return input.focus();
    let body = { text };
    if (files.length) {
      body = new FormData();
      body.append('text', text);
      for (const f of files) body.append('files', f, f.name);
    }
    sendBtn.disabled = true;
    try {
      await call(`${opts.base()}/posts`, { method: 'POST', body });
      input.value = '';
      files = [];
      renderChips();
    } catch (err) { toast(err.message, 'error', 4000); } finally { sendBtn.disabled = false; }
  });

  // --- 할 일
  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = taskTitle.value.trim();
    if (!title) return taskTitle.focus();
    try {
      await call(`${opts.base()}/tasks`, { method: 'POST', body: { title, assigneeId: taskWho.value || null, dueAt: fromLocalInput(taskDue.value) } });
      taskTitle.value = '';
      taskDue.value = '';
      taskTitle.focus();
    } catch (err) { toast(err.message, 'error'); }
  });

  function setTab(key) {
    tab = key;
    for (const [k, el] of Object.entries(panes)) el.classList.toggle('hidden', k !== key);
    for (const b of tabsEl.children) b.classList.toggle('active', b.dataset.tab === key);
  }

  const who = (a) => (a.type === 'teacher' ? h('span', { class: 'tb-teacher' }, '👩‍🏫 선생님') : h('b', {}, a.seat ? `${a.seat}번 ${a.name}` : a.name));
  const attSrc = (p, a) => ({
    name: a.name, ext: a.ext, size: a.size, url: `/teamfiles/${p.id}/${a.id}?${tokenQ()}`, download: `/teamfiles/${p.id}/${a.id}?${tokenQ()}&download=1`,
    pdfUrl: opts.canConvert?.() && CONVERTIBLE.has(a.ext) ? `/teamfiles/${p.id}/${a.id}/pdf?${tokenQ()}` : null,
  });

  function render(next) {
    if (next) bundle = next;
    if (!bundle) return;
    opts.onBundle?.(bundle);
    const { team, posts, tasks, submissions } = bundle;

    // 머리: 팀 이름·팀원·공모전
    const c = team.contest;
    head.replaceChildren(...[
      h('div', { class: 'tb-title' }, h('b', {}, `👥 ${team.name}`),
        h('span', { class: 'tb-members' }, ...(team.members.length ? team.members.map((m) => h('span', { class: `tb-member ${m.online ? 'on' : ''}`, title: m.online ? '접속 중' : '' }, `${m.seat}번 ${m.name}`)) : [h('span', { class: 'muted small' }, '아직 팀원이 없습니다')]))),
      c ? h('div', { class: 'tb-contest' }, '🏆 ',
        c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.name) : h('b', {}, c.name),
        c.dueAt ? h('span', { class: `tb-dday ${c.dueAt - Date.now() < 3 * 86400000 ? 'soon' : ''}` }, dDay(c.dueAt)) : null,
        c.dueAt ? h('span', { class: 'muted small' }, `${fmtDue(c.dueAt)} 마감`) : null) : null].filter(Boolean));

    const openTasks = tasks.filter((x) => !x.done).length;
    tabsEl.replaceChildren(...TABS.map(([k, label]) => h('button', { type: 'button', class: 'tb-tab', 'data-tab': k, onclick: () => setTab(k) },
      label, k === 'tasks' && openTasks ? h('span', { class: 'badge' }, openTasks) : null,
      k === 'board' && posts.length ? h('span', { class: 'muted small' }, ` ${posts.length}`) : null)));
    setTab(tab);

    // 게시판: 다시 그려도 쓰던 댓글은 유지
    const drafts = new Map([...postList.querySelectorAll('[data-comment]')].map((el) => [el.dataset.comment, el.value]));
    const focused = document.activeElement?.dataset?.comment;
    postList.replaceChildren(...(posts.length ? posts.map((p) => {
      const cInput = h('input', { class: 'input', maxlength: 1000, placeholder: '댓글 달기', 'data-comment': p.id });
      cInput.value = drafts.get(p.id) || '';
      const cForm = h('form', { class: 'tb-cform', autocomplete: 'off' }, cInput, h('button', { class: 'btn sm', type: 'submit' }, '등록'));
      cForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = cInput.value.trim();
        if (!text) return cInput.focus();
        try { cInput.value = ''; await call(`/api/team/posts/${p.id}/comments`, { method: 'POST', body: { text } }); } catch (err) { cInput.value = text; toast(err.message, 'error'); }
      });
      return h('article', { class: `tb-post ${p.author.type === 'teacher' ? 'by-teacher' : ''}` },
        h('div', { class: 'tb-post-head' }, who(p.author), h('span', { class: 'muted small' }, timeAgo(p.at)), h('span', { class: 'spacer' }),
          p.mine || opts.teacher ? h('button', { class: 'tb-del', type: 'button', onclick: async () => {
            if (!(await confirmDialog('이 글을 지울까요? 첨부 파일과 댓글도 함께 지워집니다.', { ok: '삭제', danger: true }))) return;
            try { await call(`/api/team/posts/${p.id}`, { method: 'DELETE' }); } catch (err) { toast(err.message, 'error'); }
          } }, '삭제') : null),
        p.text ? h('div', { class: 'tb-text' }, p.text) : null,
        p.attachments.length ? h('div', { class: 'tb-atts' }, ...p.attachments.map((a) => h('button', { type: 'button', class: 'tb-att', onclick: () => opts.openAtt(attSrc(p, a)) },
          h('span', {}, iconOf(a.ext)), h('span', { class: 'tb-chip-name' }, a.name), h('span', { class: 'muted small' }, formatBytes(a.size))))) : null,
        h('div', { class: 'tb-comments' }, ...p.comments.map((cm) => h('div', { class: 'tb-comment' }, who(cm.author), ' ', cm.text,
          h('span', { class: 'muted small' }, ` · ${timeAgo(cm.at)}`),
          cm.mine || opts.teacher ? h('button', { class: 'tb-del', type: 'button', onclick: async () => {
            try { await call(`/api/team/posts/${p.id}/comments/${cm.id}`, { method: 'DELETE' }); } catch (err) { toast(err.message, 'error'); }
          } }, '삭제') : null)), cForm));
    }) : [h('p', { class: 'muted center tb-empty' }, '아직 글이 없습니다. 아이디어나 자료를 먼저 올려 보세요!')]));
    if (focused) postList.querySelector(`[data-comment="${focused}"]`)?.focus();

    // 할 일
    const keep = taskWho.value;
    taskWho.replaceChildren(h('option', { value: '' }, '담당자 (선택)'), ...team.members.map((m) => h('option', { value: m.id }, m.name)));
    taskWho.value = team.members.some((m) => m.id === keep) ? keep : '';
    const doneN = tasks.length - openTasks;
    taskProgress.replaceChildren(...(tasks.length ? [h('div', { class: 'tb-bar' }, h('span', { style: `width:${Math.round((doneN / tasks.length) * 100)}%` })), h('span', { class: 'muted small' }, `완료 ${doneN}/${tasks.length}`)] : []));
    taskList.replaceChildren(...(tasks.length ? tasks.map((x) => {
      const overdue = !x.done && x.dueAt && x.dueAt < Date.now();
      const sel = h('select', { class: 'input sm', title: '담당자', onchange: (e) => call(`/api/team/tasks/${x.id}`, { method: 'PATCH', body: { assigneeId: e.target.value || null } }).catch((err) => toast(err.message, 'error')) },
        h('option', { value: '' }, '담당자 없음'), ...team.members.map((m) => h('option', { value: m.id, selected: m.id === x.assigneeId }, m.name)));
      return h('div', { class: `tb-task ${x.done ? 'done' : ''} ${overdue ? 'overdue' : ''}` },
        h('input', { type: 'checkbox', checked: x.done, title: '완료', onchange: (e) => call(`/api/team/tasks/${x.id}`, { method: 'PATCH', body: { done: e.target.checked } }).catch((err) => toast(err.message, 'error')) }),
        h('span', { class: 'tb-task-title' }, x.title),
        h('span', { class: 'tb-task-meta' }, sel, x.dueAt ? h('span', { class: 'tb-task-due' }, `${overdue ? '⚠️ ' : '🕒 '}${fmtDue(x.dueAt)}`) : null),
        h('button', { class: 'tb-del', type: 'button', title: '지우기', onclick: () => call(`/api/team/tasks/${x.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error')) }, '✕'));
    }) : [h('p', { class: 'muted center tb-empty' }, '할 일을 나눠 적고 담당자를 정해 보세요. 끝나면 체크!')]));

    // 팀 제출
    subList.replaceChildren(...(submissions.length ? submissions.map((s) => h('div', { class: 'tb-sub' },
      h('div', { class: 'tb-sub-head' }, h('b', {}, `📝 ${s.title}`),
        h('span', { class: `tb-sub-st ${s.files.length ? 'ok' : ''}` }, s.files.length ? `✔ 팀 제출 ${s.files.length}개` : '미제출'),
        h('span', { class: 'muted small' }, s.state === 'closed' ? '마감' : s.dueAt ? `${fmtDue(s.dueAt)}까지` : '마감 없음')),
      s.files.length ? h('div', { class: 'tb-sub-files' }, ...s.files.map((f) => h('button', { type: 'button', class: 'tb-att', onclick: () => opts.openSubmission(f) },
        h('span', {}, f.kind === 'link' ? '🔗' : iconOf(f.ext)), h('span', { class: 'tb-chip-name' }, f.name),
        h('span', { class: 'muted small' }, `${f.by.name} · ${timeAgo(f.uploadedAt)}${f.late ? ' · 지각' : ''}`))))
        : h('p', { class: 'muted small', style: 'margin:6px 0 0' }, '아직 팀에서 낸 것이 없습니다. 팀원 중 한 명이 「과제 올리기」에서 이 과제를 골라 내면 됩니다.')))
      : [h('p', { class: 'muted center tb-empty' }, opts.teacher ? '팀 과제가 없습니다. 📝 과제 관리에서 과제를 만들 때 「팀 과제」를 켜세요.' : '아직 팀 과제가 없습니다.')]));
  }

  return { render, setTab, get bundle() { return bundle; } };
}
