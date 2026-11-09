// Google 2단계 인증용 OTP(Google OTP 앱과 같은 6자리 코드)를 서버에서 계산 — RFC 6238 (TOTP, SHA-1, 30초, 6자리)
//   GOOGLE_TOTP_SECRET   Google 계정에서 'OTP 앱'을 추가할 때 'QR 코드를 스캔할 수 없나요?'로 나오는 키 (공백 있어도 됨)
//   GOOGLE_TOTP_ACCOUNT  그 Google 계정 주소 (선택). 넣으면 그 주소로 등록한 코드 확인 링크와 통합 링크에만 OTP 를 보여 줌
// 비밀 키는 서버 밖으로 보내지 않고, 화면에는 현재 6자리 코드만 보낸다.
const crypto = require('crypto');

const PERIOD = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// 'abcd efgh …' 처럼 띄어 쓴 소문자 키도 받음. 올바르지 않으면 null
function base32Decode(input) {
  const s = String(input ?? '').replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase();
  if (!s || /[^A-Z2-7]/.test(s)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of s) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return out.length >= 10 ? Buffer.from(out) : null; // 80비트보다 짧은 키는 잘못 붙여 넣은 것으로 봄
}

function totp(key, timeMs = Date.now(), { period = PERIOD, digits = DIGITS } = {}) {
  const counter = Math.floor(timeMs / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, '0');
}

// 환경 변수로 Google OTP 설정을 읽음. 설정이 없으면 configured:false, 키가 잘못되면 error
function loadGoogleOtp(env = process.env) {
  const raw = env.GOOGLE_TOTP_SECRET;
  const account = String(env.GOOGLE_TOTP_ACCOUNT ?? '').trim().toLowerCase();
  if (!raw || !raw.trim()) return { configured: false, account, error: null, now: () => null };
  const key = base32Decode(raw);
  if (!key) return { configured: false, account, error: 'GOOGLE_TOTP_SECRET 키 형식이 올바르지 않습니다 (영문 a~z 와 숫자 2~7).', now: () => null };
  return {
    configured: true, account, error: null,
    now(timeMs = Date.now()) {
      const sec = timeMs / 1000;
      return { code: totp(key, timeMs), period: PERIOD, remaining: Math.max(1, Math.ceil(PERIOD - (sec % PERIOD))) };
    },
  };
}

module.exports = { base32Decode, totp, loadGoogleOtp };
