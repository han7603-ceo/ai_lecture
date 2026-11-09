'use strict';
// Google OTP 계산: RFC 6238 부록 B 시험 값(SHA-1)과 키 입력 형식
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { base32Decode, totp, loadGoogleOtp } = require('../totp');

// ASCII '12345678901234567890' 의 Base32
const KEY = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');

test('RFC 6238 시험 값과 같은 코드 (8자리 값의 뒤 6자리)', () => {
  assert.equal(KEY.toString(), '12345678901234567890');
  const cases = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [t, want] of cases) {
    assert.equal(totp(KEY, t * 1000, { digits: 8 }), want, `T=${t}`);
    assert.equal(totp(KEY, t * 1000), want.slice(-6), `T=${t} 6자리`);
  }
});

test('Google 화면처럼 소문자·띄어쓰기로 붙여 넣은 키도 같은 키', () => {
  assert.deepEqual(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), KEY);
  assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ===='), KEY);
  assert.equal(base32Decode('abc1 !!'), null, '허용 안 되는 글자');
  assert.equal(base32Decode('abcd'), null, '너무 짧은 키');
  assert.equal(base32Decode(''), null);
});

test('환경 변수 읽기: 없음 / 잘못된 키 / 정상', () => {
  assert.equal(loadGoogleOtp({}).configured, false);
  const bad = loadGoogleOtp({ GOOGLE_TOTP_SECRET: 'not a key 1!' });
  assert.equal(bad.configured, false);
  assert.match(bad.error, /형식/);
  const ok = loadGoogleOtp({ GOOGLE_TOTP_SECRET: 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq', GOOGLE_TOTP_ACCOUNT: ' Flow@Example.com ' });
  assert.equal(ok.configured, true);
  assert.equal(ok.account, 'flow@example.com');
  assert.deepEqual(ok.now(59 * 1000), { code: '287082', period: 30, remaining: 1 });
  assert.deepEqual(ok.now(60 * 1000), { code: totp(KEY, 60 * 1000), period: 30, remaining: 30 });
  assert.equal(ok.now(75.5 * 1000).remaining, 15);
});
