// Loads the real index.js in headless Chrome with a fake camera, then drives
// the lifecycle that broke on phones: start -> tab hidden -> tab visible.
// Chrome's fake device keeps stable deviceIds, so we additionally monkeypatch
// getUserMedia to rotate them the way mobile browsers do.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PROFILE = `/tmp/cssadapt-itest-${process.pid}`;
await rm(PROFILE, { recursive: true, force: true });

const ROOT = process.cwd();
const CHROME = `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-142.0.7444.59/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  // Resolve the filename first: extname('/') is '', so deriving the type from
  // the raw URL served index.html as text/plain and Chrome rendered it as a
  // <pre> with no DOM to drive.
  const file = path === '/' ? 'index.html' : path;
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'text/plain' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

const chrome = spawn(CHROME, [
  // No --auto-accept-camera-and-microphone-capture: it kills this Chrome build
  // at startup (no devtools, empty log), and --use-fake-ui-for-media-stream
  // already auto-accepts the permission prompt.
  '--headless=new', '--remote-debugging-port=9223', '--no-sandbox',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--user-data-dir=${PROFILE}`,
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { chrome.kill(); server.close(); };
process.on('exit', cleanup);

// wait for devtools
let wsUrl;
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch('http://localhost:9223/json/version');
    wsUrl = (await r.json()).webSocketDebuggerUrl; break;
  } catch { await new Promise((r) => setTimeout(r, 250)); }
}
if (!wsUrl) { console.error('chrome did not start'); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const evalIn = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (r.result?.exceptionDetails) {
    return { error: r.result.exceptionDetails.exception?.description || 'exception' };
  }
  return r.result?.result?.value;
};

await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);

// Rotate deviceIds on every track.stop(), mimicking mobile behaviour.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    (() => {
      let gen = 0;
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        const want = c?.video?.deviceId?.exact;
        if (want && !want.endsWith('-' + gen)) {
          const e = new Error('Requested device not found'); e.name = 'OverconstrainedError'; throw e;
        }
        const s = await real(c);
        s.getVideoTracks().forEach((t) => {
          const g = gen;
          const rs = t.getSettings.bind(t);
          t.getSettings = () => ({ ...rs(), deviceId: 'cam-' + g });
          const stop = t.stop.bind(t);
          t.stop = () => { gen += 1; stop(); };
        });
        return s;
      };
    })();
  `,
}, sessionId);

await send('Page.navigate', { url: origin }, sessionId);
await new Promise((r) => setTimeout(r, 2500));

const errors = await evalIn(`
  (() => { window.__errs = [];
    addEventListener('error', e => window.__errs.push(String(e.message)));
    document.addEventListener('cssadapt:error', e => window.__errs.push('cssadapt:error ' + (e.detail?.message || e.detail)));
    return 'hooked'; })()
`);

// Start the camera via the real button.
await evalIn(`document.querySelector('#toggle').click(); 'clicked'`);
await new Promise((r) => setTimeout(r, 2000));

const afterStart = await evalIn(`({
  running: !!window.cssadapt?.running,
  facing: window.cssadapt?.facingMode,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  status: document.querySelector('#status')?.textContent,
})`);

// Simulate tab hide + return, which is what killed it on phones.
for (let cycle = 1; cycle <= 3; cycle += 1) {
  await evalIn(`
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); 'hidden'`);
  await new Promise((r) => setTimeout(r, 400));
  await evalIn(`
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); 'visible'`);
  await new Promise((r) => setTimeout(r, 1200));
}

const afterResume = await evalIn(`({
  running: !!window.cssadapt?.running,
  facing: window.cssadapt?.facingMode,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  status: document.querySelector('#status')?.textContent,
  errs: window.__errs,
})`);

console.log('after start :', JSON.stringify(afterStart));
console.log('after 3 hide/resume cycles:', JSON.stringify(afterResume));

const ok = afterStart?.running === true
  && afterResume?.running === true
  && !(afterResume?.errs || []).some((e) => /Overconstrained/i.test(e));
console.log(ok ? '\nPASS: survives hide/resume with rotating deviceIds'
               : '\nFAIL');
cleanup();
process.exit(ok ? 0 : 1);
