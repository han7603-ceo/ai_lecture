// 인증 메일 연결 (IMAP 방식): 서버가 Gmail 메일함을 주기적으로 '읽기 전용'으로 검색해
// 조건(Gmail 검색어)에 맞는 새 메일만 가져온다. 읽음 표시·라벨 등은 바꾸지 않는다.
//   INBOX_IMAP_USER      메일 주소 (예: ad.bodacompany@gmail.com)
//   INBOX_IMAP_PASSWORD  Google 앱 비밀번호 16자리 (2단계 인증 필요)
//   INBOX_IMAP_QUERY     Gmail 검색어 (기본: from:(openai.com OR anthropic.com) newer_than:1d)
//   INBOX_IMAP_HOST      기본 imap.gmail.com (INBOX_IMAP_PORT 기본 993, INBOX_IMAP_SECURE=0 이면 TLS 끔 — 시험용)
//   INBOX_IMAP_FROM      Gmail 이 아닌 서버에서 쓸 보낸사람 조건 (쉼표로 구분, 기본 openai.com,anthropic.com, 최근 1일)
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// OpenAI 는 6자리 코드, Claude(Anthropic) 는 '로그인' 버튼 링크로 옴
const DEFAULT_QUERY = 'from:(openai.com OR anthropic.com) newer_than:1d';
// HTML 본문의 버튼 링크와 글자 (텍스트 본문에는 버튼 주소가 빠지는 메일이 있음)
function anchorsOf(html) {
  if (typeof html !== 'string') return [];
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["'](https:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = m[1].replace(/&amp;/g, '&');
    const label = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    out.push({ url, label });
    if (out.length >= 30) break;
  }
  return out;
}

const POLL_MS = 30 * 1000;
const RETRY_MS = 5 * 60 * 1000; // 로그인 실패 시 계정 잠김을 피하려고 길게 쉼

function startImapInbox({ maxAgeMs, onMessage, onStatus }) {
  const user = process.env.INBOX_IMAP_USER;
  const pass = (process.env.INBOX_IMAP_PASSWORD || '').replace(/\s+/g, ''); // "abcd efgh …" 형태도 허용
  const status = {
    configured: !!(user && pass), user: user || '', query: process.env.INBOX_IMAP_QUERY || DEFAULT_QUERY,
    ok: false, lastCheck: null, error: null,
  };
  const emit = () => onStatus({ ...status });
  if (!status.configured) { emit(); return status; }

  const seen = new Set(); // 이미 처리한 메일 (Gmail 메시지 id)
  let timer = null;

  let client = null; // 연결은 유지하고 끊겼을 때만 다시 로그인
  async function getClient() {
    if (client?.usable) return client;
    client?.close();
    client = new ImapFlow({
      host: process.env.INBOX_IMAP_HOST || 'imap.gmail.com',
      port: Number(process.env.INBOX_IMAP_PORT) || 993,
      secure: process.env.INBOX_IMAP_SECURE !== '0',
      auth: { user, pass }, logger: false, socketTimeout: 5 * 60000,
    });
    client.on('error', () => {}); // 끊김은 다음 확인 때 다시 연결
    await client.connect();
    return client;
  }

  async function check() {
    let next = POLL_MS;
    try {
      const client = await getClient();
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        // Gmail 은 Gmail 검색어 그대로, 다른 메일 서버는 보낸사람 + 최근 1일 조건으로 검색
        const query = client.capabilities.has('X-GM-EXT-1') ? { gmraw: status.query }
          : { or: (process.env.INBOX_IMAP_FROM || 'openai.com,anthropic.com').split(',').map((f) => ({ from: f.trim() })).filter((x) => x.from), since: new Date(Date.now() - 86400000) };
        const uids = (await client.search(query, { uid: true })) || [];
        const recent = uids.slice(-30); // 최근 것만
        if (recent.length) {
          // fetch 반복 중에는 다른 명령을 보내면 멈추므로 목록을 먼저 다 받고 본문은 그 뒤에 가져옴
          const list = [];
          for await (const msg of client.fetch(recent, { uid: true, envelope: true, internalDate: true, emailId: true }, { uid: true })) list.push(msg);
          for (const msg of list) {
            const id = `imap-${msg.emailId || msg.uid}`;
            if (seen.has(id)) continue;
            if (seen.size > 5000) seen.clear();
            seen.add(id);
            const date = new Date(msg.internalDate || msg.envelope?.date || Date.now()).getTime();
            if (Date.now() - date > maxAgeMs) continue; // 오래된 메일은 건너뜀 (서버 시작 직후 폭주 방지)
            const full = await client.fetchOne(String(msg.uid), { source: { maxLength: 512 * 1024 } }, { uid: true });
            if (!full?.source) continue;
            const mail = await simpleParser(full.source);
            const addrs = (h) => (h ? (Array.isArray(h) ? h : [h]).flatMap((x) => x.value || []).map((v) => v.address).filter(Boolean) : []);
            const delivered = [].concat(mail.headers.get('delivered-to') || []).map(String);
            onMessage({
              id, date,
              from: mail.from?.text || '',
              to: [...addrs(mail.to), ...addrs(mail.cc), ...delivered].join(', '),
              subject: mail.subject || '',
              text: (mail.text || '').slice(0, 8000),
              anchors: anchorsOf(mail.html),
            });
          }
        }
      } finally {
        lock.release();
      }
      status.ok = true;
      status.error = null;
    } catch (e) {
      status.ok = false;
      const auth = e.authenticationFailed || /auth|credential|login/i.test(String(e.responseText || e.message));
      status.error = auth
        ? '로그인 실패: 메일 주소와 앱 비밀번호를 확인하세요. (2단계 인증을 켠 뒤 만든 16자리 앱 비밀번호여야 합니다)'
        : `메일함 확인 실패: ${e.responseText || e.message}`;
      if (auth) next = RETRY_MS;
      client?.close();
      client = null;
    } finally {
      status.lastCheck = Date.now();
      emit();
      timer = setTimeout(check, next);
      timer.unref?.();
    }
  }
  check();
  return status;
}

module.exports = { startImapInbox };
