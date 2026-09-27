#!/usr/bin/env node
'use strict';
/**
 * 교사 PC 실행기
 *   node scripts/launch.js            같은 Wi-Fi 에서 사용 (내부 IP 로 접속)
 *   node scripts/launch.js --tunnel   외부 접속 주소 생성 (Cloudflare 무료 Quick Tunnel)
 *   --no-open                         브라우저 자동 실행 안 함
 *
 * 서버를 켜고, 필요하면 cloudflared 를 자동으로 내려받아 터널을 연 뒤
 * 생성된 https 주소를 대시보드 QR 코드에 자동 반영합니다.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const args = new Set(process.argv.slice(2));
const useTunnel = args.has('--tunnel');
const openBrowser = !args.has('--no-open') && !process.env.NO_OPEN;

const line = (s = '') => console.log(s);
const box = (lines) => {
  const width = Math.max(...lines.map((l) => [...l].length)) + 4;
  line(`\n  ${'━'.repeat(width)}`);
  for (const l of lines) line(`    ${l}`);
  line(`  ${'━'.repeat(width)}\n`);
};

function openUrl(url) {
  if (!openBrowser) return;
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
  } catch { /* 브라우저를 못 열어도 주소는 콘솔에 표시됨 */ }
}

// ------------------------------------------------------------ cloudflared 준비
function assetName() {
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch] || 'amd64';
  if (process.platform === 'win32') return `cloudflared-windows-${arch === 'arm64' ? 'amd64' : arch}.exe`;
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  return `cloudflared-linux-${arch}`;
}
const localBin = path.join(BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

function findCloudflared() {
  if (process.env.CLOUDFLARED_PATH && fs.existsSync(process.env.CLOUDFLARED_PATH)) return process.env.CLOUDFLARED_PATH;
  if (fs.existsSync(localBin)) return localBin;
  const names = process.platform === 'win32' ? ['cloudflared.exe'] : ['cloudflared'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

async function downloadCloudflared() {
  const name = assetName();
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`;
  line(`  ⬇  외부 접속 프로그램(cloudflared)을 내려받는 중… (처음 한 번만)`);
  line(`     ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`다운로드 실패 (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (name.endsWith('.tgz')) {
    const tgz = path.join(BIN_DIR, name);
    fs.writeFileSync(tgz, buf);
    execFileSync('tar', ['-xzf', tgz, '-C', BIN_DIR]);
    fs.rmSync(tgz, { force: true });
  } else {
    fs.writeFileSync(localBin, buf);
  }
  if (process.platform !== 'win32') fs.chmodSync(localBin, 0o755);
  line('  ✔  다운로드 완료\n');
  return localBin;
}

// ------------------------------------------------------------ 터널 실행
function startTunnel(bin, port, onUrl, onExit) {
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let found = false;
  let lastLine = '';
  const scan = (chunk) => {
    const text = chunk.toString();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length) lastLine = lines[lines.length - 1];
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
    if (m && !found) {
      found = true;
      onUrl(m[0]);
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('exit', (code) => onExit(lastLine || `종료 코드 ${code}`, found));
  child.on('error', (err) => onExit(err.message, found));
  return child;
}

// ------------------------------------------------------------ 메인
(async () => {
  process.chdir(ROOT);
  const srv = require(path.join(ROOT, 'server.js'));
  await srv.ready;
  const port = srv.PORT;
  const dashboard = `http://localhost:${port}/master`;

  if (!useTunnel) {
    box([
      '✅ 준비 완료 — 같은 Wi-Fi 모드',
      `교사 대시보드: ${dashboard}`,
      '학생은 대시보드의 [📱 입장 안내 (QR)] 화면을 찍어 입장합니다.',
      '※ 학생 기기가 교사 PC 와 같은 Wi-Fi 에 연결되어 있어야 합니다.',
      '※ 이 창을 닫으면 서버가 꺼집니다. 수업 중 PC 절전 모드를 꺼 두세요.',
    ]);
    openUrl(dashboard);
    return;
  }

  let bin = findCloudflared();
  if (!bin) {
    try {
      bin = await downloadCloudflared();
    } catch (e) {
      box([
        '⚠ 외부 접속 프로그램을 내려받지 못했습니다.',
        `   (${e.message})`,
        '같은 Wi-Fi 모드로 계속 실행합니다.',
        `교사 대시보드: ${dashboard}`,
      ]);
      openUrl(dashboard);
      return;
    }
  }

  line('  🌐 외부 접속 주소를 만드는 중… (보통 5~15초)');
  let child;
  let restarts = 0;
  let opened = false;
  let shuttingDown = false;
  const timer = setTimeout(() => {
    line('  ⏳ 주소 생성이 늦어지고 있습니다. 인터넷 연결 또는 학교 방화벽을 확인하세요.');
    if (!opened) { opened = true; openUrl(dashboard); }
  }, 45000);

  const run = () => {
    child = startTunnel(bin, port, (url) => {
      clearTimeout(timer);
      srv.setPublicUrl(url, 'tunnel');
      box([
        '✅ 준비 완료 — 외부 접속 모드',
        `학생 접속 주소: ${url}`,
        `교사 대시보드: ${dashboard}`,
        'QR 코드에는 위 학생 접속 주소가 자동으로 들어갑니다.',
        '※ 이 주소는 실행할 때마다 바뀝니다. 수업마다 QR 을 새로 띄워 주세요.',
        '※ 이 창을 닫으면 서버가 꺼집니다. 수업 중 PC 절전 모드를 꺼 두세요.',
      ]);
      if (!opened) { opened = true; openUrl(dashboard); }
    }, (reason, hadUrl) => {
      srv.setPublicUrl(null);
      if (shuttingDown) return;
      if (restarts < 3) {
        restarts++;
        line(`  ⚠ 외부 접속 연결 실패: ${reason}`);
        line(`     다시 시도합니다… (${restarts}/3)`);
        if (hadUrl) line('     ※ 새 주소가 만들어지면 학생들에게 QR 을 다시 보여 주세요.');
        setTimeout(run, 3000);
      } else {
        clearTimeout(timer);
        line('  ✖ 외부 접속 주소를 만들지 못했습니다. 학교/기관 방화벽이 막고 있을 수 있습니다.');
        line(`     같은 Wi-Fi 에서는 계속 사용할 수 있습니다: ${dashboard}`);
        if (!opened) { opened = true; openUrl(dashboard); }
      }
    });
  };
  run();

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    line('\n  서버를 종료합니다…');
    try { child?.kill(); } catch { /* 이미 종료 */ }
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => { try { child?.kill(); } catch { /* 무시 */ } });
})().catch((e) => {
  console.error('\n  ✖ 실행 중 오류:', e.message);
  process.exit(1);
});
