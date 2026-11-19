'use strict';

/*
 * main.js — tiny launcher for a WebSocket-based proxy service.
 *
 * What it does:
 *   1. On first run (or with `--setup`) downloads the upstream core
 *      binary from the official XTLS release page and unpacks it.
 *   2. Renders a runtime config from environment variables:
 *        UUID    — client id (required)
 *        WSPATH  — websocket path (required, must start with "/")
 *        PORT    — listen port (default 3000)
 *   3. Starts the core process and restarts it if it ever exits.
 *
 * Private address ranges and the BitTorrent protocol are routed to a
 * blackhole outbound so the service cannot be used to reach LAN hosts
 * or to seed torrents.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const HERE = __dirname;
const CORE_VERSION = 'v25.10.15';
const CORE_ZIP_URL =
  'https://github.com/XTLS/Xray-core/releases/download/' +
  CORE_VERSION +
  '/Xray-linux-64.zip';
const CORE_BIN = path.join(HERE, 'core-bin');
const CORE_ZIP = path.join(HERE, '.core-download.zip');
const RUNTIME_CONF = path.join(HERE, '.runtime.json');

/* ---------------- download helper (follows redirects) ---------------- */

function fetchToFile(url, dest, hops) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('too many redirects'));
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchToFile(res.headers.location, dest, hops + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('download failed: HTTP ' + res.statusCode));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

async function ensureCore() {
  if (fs.existsSync(CORE_BIN)) return;
  console.log('[launcher] downloading core ' + CORE_VERSION + ' ...');
  await fetchToFile(CORE_ZIP_URL, CORE_ZIP, 0);
  try {
    execFileSync('unzip', ['-o', '-q', CORE_ZIP, 'xray', '-d', HERE]);
  } catch (_) {
    execFileSync('python3', ['-m', 'zipfile', '-e', CORE_ZIP, HERE]);
  }
  fs.renameSync(path.join(HERE, 'xray'), CORE_BIN);
  fs.chmodSync(CORE_BIN, 0o755);
  fs.unlinkSync(CORE_ZIP);
  console.log('[launcher] core ready');
}

/* ---------------- config rendering ---------------- */

const PRIVATE_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
];

function renderConfig() {
  const uuid = process.env.UUID;
  const wsPath = process.env.WSPATH;
  const port = parseInt(process.env.PORT || '3000', 10);
  if (!uuid) throw new Error('env UUID is missing');
  if (!wsPath || wsPath[0] !== '/') throw new Error('env WSPATH must start with /');
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        listen: '0.0.0.0',
        port: port,
        protocol: 'vless',
        settings: {
          clients: [{ id: uuid }],
          decryption: 'none',
        },
        streamSettings: {
          network: 'ws',
          security: 'none',
          wsSettings: { path: wsPath },
        },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      },
    ],
    outbounds: [
      { tag: 'out-direct', protocol: 'freedom' },
      { tag: 'out-drop', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', ip: PRIVATE_RANGES, outboundTag: 'out-drop' },
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'out-drop' },
      ],
    },
  };
}

/* ---------------- supervision ---------------- */

function run() {
  const cfg = renderConfig();
  fs.writeFileSync(RUNTIME_CONF, JSON.stringify(cfg));
  console.log('[launcher] starting core on port ' + cfg.inbounds[0].port);

  let child = null;
  let stopping = false;

  function start() {
    child = spawn(CORE_BIN, ['run', '-config', RUNTIME_CONF], { stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      if (stopping) return;
      console.log('[launcher] core exited (' + (signal || code) + '), restarting in 2s');
      setTimeout(start, 2000);
    });
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopping = true;
      if (child) child.kill(sig);
      process.exit(0);
    });
  }

  start();
}

(async () => {
  try {
    await ensureCore();
    if (process.argv.includes('--setup')) return; // build step: fetch only
    run();
  } catch (err) {
    console.error('[launcher] fatal:', err.message);
    process.exit(1);
  }
})();
