import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const site = 'https://videvas-cosmetics-site.vercel.app';
const raw = await readFile('.env.local', 'utf8');
const publicKey = raw.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '');
assert.ok(publicKey?.startsWith('sb_publishable_'));
await mkdir('data/browser', { recursive: true });
const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe',
  `--user-data-dir=${resolve('data/browser/production-profile')}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
let buffer = '', sequence = 0, sessionId, chromeLog = '';
const pending = new Map(), networkErrors = [], pageErrors = [];
chrome.stderr.on('data', data => { chromeLog = (chromeLog + data.toString()).slice(-3000); });
chrome.stdio[4].on('data', data => {
  buffer += data.toString();
  let index;
  while ((index = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    if (message.method === 'Network.loadingFailed') networkErrors.push(message.params.errorText);
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.text);
    if (!message.id) continue;
    const task = pending.get(message.id); pending.delete(message.id);
    if (!task) continue;
    clearTimeout(task.timer);
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
  }
});
function send(method, params = {}, browser = false) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser verification timed out: ${method}\n${chromeLog}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(!browser && sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await send('Browser.getVersion', {}, true);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, true);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, true));
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${site}/?release=${Date.now()}` });
  let loaded = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate("document.querySelector('.auth-card h2')?.textContent==='Welcome back.'")) { loaded = true; break; }
    await sleep(100);
  }
  if (!loaded) {
    const failure = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile('data/browser/production-check-failure.png', Buffer.from(failure.data, 'base64'));
    console.log(await evaluate("({url:location.href,title:document.title,headings:[...document.querySelectorAll('h1,h2')].map(node=>node.textContent),text:document.body.innerText.slice(0,1400)})"));
    console.log({ networkErrors, pageErrors });
  }
  assert.ok(loaded, 'Production must show the new sign-in screen');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  const sourceMatches = await evaluate(`(async () => {
    const scripts = [...document.querySelectorAll('script[type=module][src]')];
    const sources = await Promise.all(scripts.map(script => fetch(script.src).then(response => response.text())));
    return sources.some(source => source.includes(${JSON.stringify(publicKey)}) && source.includes('https://tmixrlodofdycichecyj.supabase.co'));
  })()`);
  assert.ok(sourceMatches, 'The live build must contain the intended Supabase project and public key');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('data/browser/production-sign-in-desktop.png', Buffer.from(screenshot.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile sign-in must fit');
  const mobile = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('data/browser/production-sign-in-mobile.png', Buffer.from(mobile.data, 'base64'));
  const preflight = await evaluate(`(async () => {
    const base = 'https://tmixrlodofdycichecyj.supabase.co';
    const headers = { apikey: ${JSON.stringify(publicKey)}, 'Content-Type': 'application/json' };
    const settings = await fetch(base + '/auth/v1/settings', { headers, signal: AbortSignal.timeout(15000) });
    const auth = await settings.json();
    const rpc = await fetch(base + '/rest/v1/rpc/videvas_load_workspace', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(15000) });
    const rpcError = await rpc.json();
    const records = await fetch(base + '/rest/v1/videvas_workspaces?select=owner_id', { headers, signal: AbortSignal.timeout(15000) });
    return { settings: settings.status, email: auth.external?.email, signupDisabled: auth.disable_signup, rpc: rpc.status, rpcCode: rpcError.code, anonymousRecords: records.status };
  })()`);
  assert.equal(preflight.settings, 200, 'Supabase must accept the public key');
  assert.equal(preflight.email, true, 'Email sign-in must be enabled');
  assert.notEqual(preflight.signupDisabled, true);
  assert.equal(preflight.rpcCode, '42501', 'Installed RPC must reject anonymous callers');
  assert.ok([401, 403].includes(preflight.rpc));
  assert.ok([401, 403].includes(preflight.anonymousRecords));
  console.log('Production verified: new desktop/mobile sign-in screen, intended public key and project, working email auth settings, installed RPC, anonymous shop access denied.');
} finally { chrome.kill(); for (const task of pending.values()) clearTimeout(task.timer); }
