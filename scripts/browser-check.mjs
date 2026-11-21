import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import assert from 'node:assert/strict';
import { addCustomer, addProduct, createDemo, deleteTransaction, emptyState, receiveStock, recordSale, stock, validateState, metrics, customerMetrics, today, dayOffset, recordEntry } from '../src/model.js';

import { MockSupabase, mockBrowserScript } from './mock-supabase.mjs';

// Real SDK, real SQL, isolated auth and browser profiles. No real shop is touched.
const backend = await MockSupabase.create();
const owner = await backend.addUser('owner@example.test', 'Test-password-123');
const otherOwner = await backend.addUser('other@example.test', 'Other-password-123');
const root = resolve('dist');
await mkdir('data/browser', { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const location = new URL(req.url, 'http://localhost');
    if (location.pathname.startsWith('/__mock/')) { await backend.handle(req, res, location); return; }
    if (location.pathname === '/__blank') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body></body></html>'); return; }
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (path !== root && !path.startsWith(root + '\\') && !path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    const file = path === root ? join(root, 'index.html') : path;
    const data = await readFile(file);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(5175, '127.0.0.1', resolve));
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const child = spawn(chromePath, ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${resolve('data/browser/pipe-profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let buffer = '', sessionId;
const pending = new Map(), errors = [];
let seq = 0;
child.once('error', error => { console.error('Chrome launch failed:', error.message); });
let chromeLog = '';
child.stderr.on('data', data => { chromeLog = (chromeLog + data.toString()).slice(-5000); });
child.stdio[4].on('data', data => {
  buffer += data.toString();
  let index;
  while ((index = buffer.indexOf('\0')) !== -1) {
    const msg = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (p) { clearTimeout(p.timer); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ' ' + JSON.stringify(msg.params.exceptionDetails.exception));
  }
});
const send = (method, params = {}, browser = false) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome timed out: ${method}\n${chromeLog}`)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  child.stdio[3].write(JSON.stringify({ id, method, params, ...(!browser && sessionId ? { sessionId } : {}) }) + '\0');
});
try {
  await send('Browser.getVersion', {}, true);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, true);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, true));
  console.log('Chrome connected.');
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const waitFor = async expression => { for (let i = 0; i < 300; i++) { if (await evaluate(`Boolean(${expression})`)) return; await sleep(50); } throw new Error(`Timed out: ${expression}`); };
  const click = async (text, scope = 'document') => { await evaluate(`(() => { const b=[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim()===${JSON.stringify(text)} || b.querySelector('span')?.textContent.trim()===${JSON.stringify(text)}); if(!b) throw new Error('Missing button: '+${JSON.stringify(text)}); b.click(); })()`); await sleep(100); };
  const fill = async (selector, value) => {
    await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Missing field: '+${JSON.stringify(selector)}); const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  };
  const submit = async () => { await evaluate("document.querySelector('[role=dialog] form').requestSubmit()"); await sleep(150); };
  const state = () => backend.workspace(owner.id).then(document => document.state);
  const recordEntryForBrowser = (state, description) => recordEntry(state, { type: 'income', description, amount: 10000, method: 'Cash', date: today() });
  async function deletionScenarios() {
    const original = await state();
    const makeFixture = () => {
      let current = addProduct(addCustomer(emptyState({ storeName: 'Delete feature test' }), { name: 'Deletion buyer' }), {
        name: 'Deletion serum', sku: 'DELETE-1', category: 'Skincare', price: 200000, cost: 100000, quantity: 2, reorder: 1,
      });
      current = receiveStock(current, { productId: current.products[0].id, quantity: 4, cost: 120000, method: 'Cash', batchCode: 'DELETE-RESTOCK' });
      current = recordSale(current, { lines: [{ productId: current.products[0].id, quantity: 3 }], method: 'Cash' });
      return recordSale(current, { customerId: current.customers[0].id, onAccount: true, paymentAmount: 50000, lines: [{ productId: current.products[0].id, quantity: 1 }], method: 'Cash' });
    };
    const seed = async () => {
      const fixture = makeFixture();
      await backend.saveAs(owner.id, () => fixture, 'replace');
      await send('Page.reload');
      await waitFor("document.querySelector('.stat-value')");
      await waitFor("document.querySelector('.workspace-card strong')?.textContent==='Delete feature test'");
      await waitFor("!document.querySelector('.cloud-notice')");
      return fixture;
    };
    const openDelete = async reference => {
      await waitFor(`document.querySelector('[aria-label="Delete ${reference}"]')`);
      await evaluate(`document.querySelector('[aria-label="Delete ${reference}"]').click()`);
      await waitFor("document.querySelector('[role=dialog] h2')?.textContent.startsWith('Delete ')");
      await sleep(200);
    };
    try {
      const fixture = await seed();
      const [restock, walkIn, tabSale, payment] = fixture.transactions;
      await click('Sales', "document.querySelector('nav')");
      await openDelete(walkIn.reference);
      assert.ok((await evaluate("document.querySelector('.delete-record-summary').textContent")).includes('+3 units'));
      const beforeCancel = backend.saveCalls.length;
      await screenshot('delete-sale-desktop');
      await click('Cancel', "document.querySelector('[role=dialog]')");
      assert.equal(backend.saveCalls.length, beforeCancel);
      assert.deepEqual(await state(), fixture, 'Cancel keeps every stock and financial record');

      // Deleting twice while the first save is held sends only one operation.
      await openDelete(walkIn.reference);
      const hold = backend.holdNextSave(), beforeDelete = backend.saveCalls.length;
      await evaluate("(() => { const form=document.querySelector('[role=dialog] form'); form.requestSubmit(); form.requestSubmit(); })()");
      await hold.arrived;
      assert.equal(backend.saveCalls.length, beforeDelete + 1);
      assert.equal(backend.saveCalls.at(-1).p_mode, 'delete');
      assert.equal(await evaluate("document.querySelector('[role=dialog] button[type=submit]').disabled"), true);
      hold.release(); await waitFor("!document.querySelector('[role=dialog]')");
      assert.equal((await state()).transactions.some(t => t.id === walkIn.id), false);
      assert.equal(stock((await state()).products[0]), 5);

      // Both stock dependencies and tab dependencies are visible before saving.
      await click('Cash ledger', "document.querySelector('nav')"); await click('Purchases', "document.querySelector('.table-toolbar .tabs')");
      await openDelete(restock.reference);
      assert.match(await evaluate("document.querySelector('[role=dialog] .form-error').textContent"), /stock has been sold or removed/);
      assert.equal(await evaluate("document.querySelector('[role=dialog] button[type=submit]').disabled"), true);
      const blockedCalls = backend.saveCalls.length;
      await submit(); assert.equal(backend.saveCalls.length, blockedCalls);
      await click('Cancel', "document.querySelector('[role=dialog]')");
      await click('Sales', "document.querySelector('nav')"); await openDelete(tabSale.reference);
      assert.match(await evaluate("document.querySelector('[role=dialog] .form-error').textContent"), /dependent entries first/);
      await screenshot('delete-sale-dependent-payment');
      await click('Cancel', "document.querySelector('[role=dialog]')");

      await click('Cash ledger', "document.querySelector('nav')"); await click('Payments', "document.querySelector('.table-toolbar .tabs')");
      await evaluate(`document.querySelector('[aria-label="View ${payment.reference}"]').click()`);
      await click('Delete payment', "document.querySelector('[role=dialog]')");
      await screenshot('delete-payment-desktop');
      assert.ok((await evaluate("document.querySelector('.delete-record-summary').textContent")).includes('2,000 CFA'));
      await submit(); await waitFor("!document.querySelector('[role=dialog]')");
      assert.equal(customerMetrics(await state(), fixture.customers[0].id).balance, 200000);
      assert.equal((await state()).transactions.some(t => t.id === payment.id), false);
      await click('Customers', "document.querySelector('nav')");
      await evaluate("document.querySelector('.customer-cell').click()");
      await waitFor("document.querySelector('[data-customer-balance=\"200000\"]')");
      await evaluate("document.querySelector('.customer-tab-table .transaction-cell').click()");
      await click('Delete sale', "document.querySelector('[role=dialog]')");
      await submit(); await waitFor("!document.querySelector('[role=dialog]')");
      assert.equal(customerMetrics(await state(), fixture.customers[0].id).balance, 0);
      assert.equal(stock((await state()).products[0]), 6);

      // A restock can also be opened from its product's received-stock history.
      await click('Inventory', "document.querySelector('nav')");
      await evaluate("document.querySelector('.inventory-table .product-cell').click()");
      await click('View restock', "document.querySelector('[role=dialog]')");
      await click('Delete restock', "document.querySelector('[role=dialog]')");
      await screenshot('delete-restock-desktop');
      assert.ok((await evaluate("document.querySelector('.delete-record-summary').textContent")).includes('-4 units'));
      await submit(); await waitFor("!document.querySelector('[role=dialog]')");
      let current = await state();
      assert.equal(current.transactions.length, 0);
      assert.equal(current.products[0].batches.length, 1);
      assert.equal(stock(current.products[0]), 2);
      assert.equal(current.movements.length, 1);
      await send('Page.reload'); await waitFor("document.querySelector('.stat-value')");
      assert.equal((await state()).transactions.length, 0, 'Deletions persist after reload');

      const lost = await seed();
      await click('Sales', "document.querySelector('nav')"); await openDelete(lost.transactions[1].reference);
      const beforeLost = backend.saveCalls.length;
      backend.dropNextReply(); await submit();
      await waitFor("document.querySelector('[role=dialog] .cloud-notice')?.textContent.includes('Check previous save')");
      assert.equal((await state()).transactions.some(t => t.id === lost.transactions[1].id), false);
      await backend.saveAs(owner.id, s => recordEntryForBrowser(s, 'After lost deletion response'));
      await click('Check previous save', "document.querySelector('[role=dialog]')");
      await waitFor("!document.querySelector('[role=dialog]')");
      assert.equal(backend.saveCalls.at(-1).p_request_id, backend.saveCalls[beforeLost].p_request_id);
      assert.equal(backend.saveCalls.at(-1).p_mode, 'delete');
      assert.equal(stock((await state()).products[0]), 5, 'A retry restores stock exactly once');
      assert.equal((await state()).transactions.filter(t => t.description === 'After lost deletion response').length, 1);

      const conflicting = await seed();
      await openDelete(conflicting.transactions[1].reference);
      backend.beforeNextSave = async () => backend.saveAs(owner.id, s => recordEntryForBrowser(s, 'Before stale deletion'));
      await submit();
      await waitFor("document.querySelector('[role=dialog] .form-error')?.textContent.includes('changed on another device')");
      assert.equal((await state()).transactions.some(t => t.id === conflicting.transactions[1].id), true);
      assert.equal(stock((await state()).products[0]), 2);
      await submit(); await waitFor("!document.querySelector('[role=dialog]')");
      assert.equal((await state()).transactions.some(t => t.description === 'Before stale deletion'), true);
      assert.equal(stock((await state()).products[0]), 5);

      const remoteDeleted = await seed();
      await openDelete(remoteDeleted.transactions[1].reference);
      await backend.saveAs(owner.id, s => deleteTransaction(s, remoteDeleted.transactions[1].id), 'delete');
      await waitFor("document.querySelector('[role=dialog] .form-error')?.textContent.includes('no longer in your workspace')");
      assert.equal(await evaluate("document.querySelector('[role=dialog] button[type=submit]').disabled"), true);
      await click('Cancel', "document.querySelector('[role=dialog]')");

      const mobile = await seed();
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await evaluate(`(() => { const entry=[...document.querySelectorAll('main .transaction-cell')].find(button => button.textContent.includes(${JSON.stringify(mobile.transactions[1].reference)})); if (!entry) throw new Error('Missing mobile sale'); entry.click(); })()`);
      await click('Delete sale', "document.querySelector('[role=dialog]')");
      await sleep(200);
      await screenshot('delete-sale-mobile');
      assert.equal(await evaluate("document.querySelector('.modal').scrollWidth <= document.querySelector('.modal').clientWidth"), true, 'Mobile delete confirmation fits');
      const beforeOffline = backend.saveCalls.length;
      await send('Network.enable');
      await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await waitFor('navigator.onLine===false');
      assert.equal(await evaluate("document.querySelector('[role=dialog] button[type=submit]').disabled"), true);
      await submit(); assert.equal(backend.saveCalls.length, beforeOffline);
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await waitFor("!document.querySelector('.cloud-notice')");
      await submit(); await waitFor("!document.querySelector('[role=dialog]')");
      assert.equal(stock((await state()).products[0]), 5);
      validateState(await state());
    } finally {
      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
      await backend.saveAs(owner.id, () => original, 'replace');
      await waitFor(`document.querySelector('.workspace-card strong')?.textContent===${JSON.stringify(original.settings.storeName)}`);
    }
    console.log('Deletion checks passed: sale/payment/restock, cancel, dependency guards, stock and cash rollback, customer history, retries, stale saves, offline and mobile.');
  }
  async function cloudScenarios() {
    const primarySession = sessionId;
    const targetIds = new Map();
    const openPage = async (shared = false) => {
      const context = shared ? {} : await send('Target.createBrowserContext', {}, true);
      const { targetId } = await send('Target.createTarget', { url: 'about:blank', ...context }, true);
      const attached = await send('Target.attachToTarget', { targetId, flatten: true }, true);
      targetIds.set(attached.sessionId, targetId);
      sessionId = attached.sessionId;
      await send('Runtime.enable'); await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', { source: mockBrowserScript() });
      await send('Page.navigate', { url: 'http://127.0.0.1:5175/' });
      return attached.sessionId;
    };
    const loginHere = async (email = owner.email, password = owner.password) => {
      await waitFor("document.querySelector('.auth-form')");
      await fill('.auth-form [name=email]', email); await fill('.auth-form [name=password]', password);
      await evaluate("document.querySelector('.auth-form').requestSubmit()");
      await waitFor("document.querySelector('.stat-value')"); await waitFor("!document.querySelector('.cloud-notice')");
    };
    const otherDevice = await openPage();
    await loginHere();
    await waitFor("document.querySelector('.workspace-card strong')?.textContent==='Videvas Beauty'");
    const transactionCount = (await state()).transactions.length;
    await backend.saveAs(owner.id, current => recordEntryForBrowser(current, 'Realtime contribution'));
    await waitFor("document.querySelector('.transaction-table')?.textContent.includes('Realtime contribution')");
    sessionId = primarySession;
    await click('Overview', "document.querySelector('nav')");
    await waitFor("document.querySelector('.transaction-table')?.textContent.includes('Realtime contribution')");
    assert.equal((await state()).transactions.length, transactionCount + 1, 'Another device sees the same confirmed shop');
    const syncedEntry = (await state()).transactions.find(t => t.description === 'Realtime contribution');
    await backend.saveAs(owner.id, current => deleteTransaction(current, syncedEntry.id), 'delete');
    await waitFor("!document.querySelector('.transaction-table')?.textContent.includes('Realtime contribution')");
    sessionId = otherDevice;
    await waitFor("!document.querySelector('.transaction-table')?.textContent.includes('Realtime contribution')");
    assert.equal((await state()).transactions.length, transactionCount, 'Deletion syncs to both signed-in devices');
    sessionId = primarySession;
    await evaluate('window.__videvasTestPauseRealtime = true');
    await backend.saveAs(owner.id, current => recordEntryForBrowser(current, 'Focus contribution'));
    await sleep(100);
    assert.equal(await evaluate("document.querySelector('.transaction-table')?.textContent.includes('Focus contribution')"), false);
    await evaluate("window.dispatchEvent(new Event('focus'))");
    await waitFor("document.querySelector('.transaction-table')?.textContent.includes('Focus contribution')");
    await evaluate('window.__videvasTestPauseRealtime = false');

    // One request, even if the user submits twice before a slow response.
    await click('Cash ledger', "document.querySelector('nav')"); await click('Log expense');
    await fill('[role=dialog] [name=description]', 'Slow connection expense');
    await fill('[role=dialog] [name=amount]', '100');
    const hold = backend.holdNextSave(), priorCalls = backend.saveCalls.length;
    await evaluate("(() => { const form=document.querySelector('[role=dialog] form'); form.requestSubmit(); form.requestSubmit(); })()");
    await hold.arrived;
    assert.equal(await evaluate("document.querySelector('[role=dialog] button[type=submit]').disabled"), true);
    assert.equal(backend.saveCalls.length, priorCalls + 1);
    hold.release(); await waitFor("!document.querySelector('[role=dialog]')");
    assert.equal((await state()).transactions.filter(transaction => transaction.description === 'Slow connection expense').length, 1);

    // The server committed a save, but the response was lost. Retry its ID,
    // including after a second device has written another confirmed entry.
    await waitFor("!document.querySelector('.cloud-notice')");
    await click('Log expense'); await fill('[role=dialog] [name=description]', 'Lost response expense');
    await fill('[role=dialog] [name=amount]', '200');
    const beforeLost = backend.saveCalls.length;
    backend.dropNextReply(); await submit();
    await waitFor("document.querySelector('[role=dialog] .cloud-notice')?.textContent.includes('Check previous save')");
    assert.equal(await evaluate("document.querySelector('[role=dialog] button[type=submit]').disabled"), true);
    assert.equal((await state()).transactions.filter(transaction => transaction.description === 'Lost response expense').length, 1);
    assert.equal(await evaluate("document.querySelector('main .transaction-table')?.textContent.includes('Lost response expense')"), false, 'Unconfirmed data is not shown as a successful post');
    await backend.saveAs(owner.id, current => recordEntryForBrowser(current, 'After lost response'));
    await click('Check previous save', "document.querySelector('[role=dialog]')");
    await waitFor("!document.querySelector('[role=dialog]')");
    assert.equal(backend.saveCalls.at(-1).p_request_id, backend.saveCalls[beforeLost].p_request_id);
    assert.equal((await state()).transactions.filter(transaction => transaction.description === 'Lost response expense').length, 1);
    await waitFor("document.querySelector('main .transaction-table')?.textContent.includes('After lost response')");

    // Going offline keeps a draft and blocks posting until a fresh sync.
    await waitFor("!document.querySelector('.cloud-notice')"); await click('Log expense');
    await fill('[role=dialog] [name=description]', 'Offline draft'); await fill('[role=dialog] [name=amount]', '300');
    const beforeOffline = backend.saveCalls.length;
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor("navigator.onLine===false");
    assert.equal(await evaluate("document.querySelector('[role=dialog] button[type=submit]').disabled"), true);
    assert.equal(backend.saveCalls.length, beforeOffline);
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor("!document.querySelector('.cloud-notice')");
    assert.equal(await evaluate("document.querySelector('[role=dialog] [name=description]').value"), 'Offline draft');
    await submit(); await waitFor("!document.querySelector('[role=dialog]')");

    // Another tab signs out and changes accounts while a response is pending.
    // The in-flight JWT remains Alice's, and Bob never receives her snapshot.
    const sharedTab = await openPage(true);
    await waitFor("document.querySelector('.stat-value')");
    sessionId = primarySession;
    await click('Log expense'); await fill('[role=dialog] [name=description]', 'Prior account response');
    await fill('[role=dialog] [name=amount]', '400');
    const accountHold = backend.holdNextSave();
    await evaluate("document.querySelector('[role=dialog] form').requestSubmit()"); await accountHold.arrived;
    sessionId = sharedTab;
    await click('Sign out', "document.querySelector('.sidebar-bottom')");
    await loginHere(otherOwner.email, otherOwner.password);
    sessionId = primarySession;
    await waitFor("document.querySelector('.storage-status')?.textContent.includes('other@example.test')");
    assert.equal(await evaluate("Boolean(document.querySelector('[role=dialog]'))"), false, 'Account changes close private drafts immediately');
    accountHold.release(); await sleep(250);
    assert.equal((await backend.workspace(otherOwner.id)).state.transactions.length, 0);
    assert.equal(await evaluate("document.querySelector('.workspace-card strong').textContent"), 'Videvas');
    assert.equal(await evaluate("document.body.textContent.includes('Prior account response')"), false);
    assert.equal((await state()).transactions.filter(transaction => transaction.description === 'Prior account response').length, 1);

    await click('Sign out', "document.querySelector('.sidebar-bottom')");
    await waitFor("document.querySelector('.auth-form')");
    assert.equal(await evaluate("Boolean(document.querySelector('.app-shell'))"), false);
    // Real PKCE code exchange with simulated email delivery.
    await click('Forgot password?'); await fill('.auth-form [name=email]', owner.email);
    await evaluate("document.querySelector('.auth-form').requestSubmit()"); await waitFor("document.querySelector('.auth-message')");
    const oldPassword = owner.password;
    await send('Page.navigate', { url: backend.recoveryLink() });
    await waitFor("document.querySelector('.auth-card h2')?.textContent==='Make yourself at home.'");
    await fill('.auth-form [name=password]', 'Changed-password-456'); await fill('.auth-form [name=confirmPassword]', 'Mismatch-password-456');
    await evaluate("document.querySelector('.auth-form').requestSubmit()"); await waitFor("document.querySelector('.form-error')");
    assert.equal(owner.password, oldPassword, 'A mismatched password cannot update the account');
    await fill('.auth-form [name=confirmPassword]', 'Changed-password-456');
    await evaluate("document.querySelector('.auth-form').requestSubmit()"); await waitFor("document.querySelector('.stat-value')");
    assert.equal(owner.password, 'Changed-password-456');
    assert.equal(await evaluate("location.search"), '', 'Recovery URL is cleared after success');
    await waitFor("!document.querySelector('.cloud-notice')");
    await send('Target.closeTarget', { targetId: targetIds.get(sharedTab) }, true);
    await send('Target.closeTarget', { targetId: targetIds.get(otherDevice) }, true);
  }

  const screenshot = async name => { const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); await writeFile(`data/browser/${name}.png`, Buffer.from(result.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: mockBrowserScript() });
  await mkdir('data/browser/downloads', { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: resolve('data/browser/downloads') }, true);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:5175/__blank' });
  await waitFor("location.pathname==='/__blank'");
  await evaluate('localStorage.clear(); sessionStorage.clear()');
  await send('Page.navigate', { url: 'http://127.0.0.1:5175/' });
  await waitFor("document.querySelector('.auth-card h2')?.textContent==='Welcome back.'");
  await screenshot('sign-in-desktop');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Desktop sign-in fits');
  const login = async (email = owner.email, password = owner.password) => {
    await fill('.auth-form [name=email]', email); await fill('.auth-form [name=password]', password);
    await evaluate("document.querySelector('.auth-form').requestSubmit()");
    await waitFor("document.querySelector('.stat-value')");
    await waitFor("!document.querySelector('.cloud-notice')");
  };
  await click('Create an account');
  await fill('.auth-form [name=email]', 'new-shop@example.test');
  await fill('.auth-form [name=password]', 'Signup-password-123');
  await fill('.auth-form [name=confirmPassword]', 'Signup-password-123');
  await evaluate("document.querySelector('.auth-form').requestSubmit()");
  await waitFor("document.querySelector('.auth-message')");
  assert.equal(await evaluate("Boolean(document.querySelector('.app-shell'))"), false, 'Confirmation is required before opening a shop');
  backend.lastSignup.confirmed = true;
  await click('Back to sign in'); await login('new-shop@example.test', 'Signup-password-123');
  assert.equal((await backend.workspace(backend.lastSignup.id)).state.products.length, 0);
  await click('Sign out', "document.querySelector('.sidebar-bottom')");
  await waitFor("document.querySelector('.auth-form')");
  await fill('.auth-form [name=email]', owner.email); await fill('.auth-form [name=password]', 'Wrong-password-123');
  await evaluate("document.querySelector('.auth-form').requestSubmit()"); await waitFor("document.querySelector('.form-error')");
  assert.match(await evaluate("document.querySelector('.form-error').textContent"), /Invalid login/);
  await login();
  await screenshot('overview-desktop');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Desktop has horizontal overflow');
  assert.ok((await evaluate("document.querySelector('.stat-value').textContent")).includes('CFA'));
  const initial = await state();
  assert.equal(initial.demo, false);
  assert.ok([initial.products, initial.customers, initial.transactions, initial.movements].every(list => list.length === 0));
  assert.equal(await evaluate("localStorage.getItem('videvas-workspace-v1')"), null, 'Shop records are never written back to browser storage');
  assert.equal(await evaluate("Boolean(document.querySelector('.demo-strip'))"), false);
  await click('Inventory', "document.querySelector('nav')"); await screenshot('inventory-empty-desktop');
  assert.equal(await evaluate("document.querySelectorAll('.inventory-table tbody tr').length"), 0);
  await click('Customers', "document.querySelector('nav')"); await screenshot('customers-empty-desktop');
  assert.equal(await evaluate("document.querySelectorAll('.customer-table tbody tr').length"), 0);
  // Earlier browser records are never imported automatically.
  const oldDemo = createDemo(); delete oldDemo.demoExplicit; oldDemo.settings.storeName = 'My Demo Shop';
  const oldDemoRaw = JSON.stringify(oldDemo);
  await evaluate(`localStorage.setItem('videvas-workspace-v1', ${JSON.stringify(oldDemoRaw)})`);
  await send('Page.reload'); await waitFor("document.querySelector('.stat-value')");
  assert.equal((await state()).products.length, 0);
  assert.equal((await state()).settings.storeName, 'Videvas');
  assert.equal(await evaluate("localStorage.getItem('videvas-workspace-v1')"), oldDemoRaw, 'Original browser copy is preserved');
  await click('Settings', "document.querySelector('.sidebar-bottom')"); await click('Load demo data');
  assert.equal((await state()).demoExplicit, true);
  assert.equal((await state()).products.length, 12);
  await send('Page.reload'); await waitFor("document.querySelector('.stat-value')");
  assert.equal((await state()).customers.length, 6, 'Demo loaded deliberately persists on reload');
  await click('Inventory', "document.querySelector('nav')");
  await screenshot('inventory-desktop');
  await fill('.table-search input', 'Niacinamide');
  assert.equal(await evaluate("document.querySelectorAll('.inventory-table tbody tr').length"), 1);
  await click('Customers', "document.querySelector('nav')");
  await screenshot('customers-desktop');
  assert.equal(await evaluate("document.querySelectorAll('.customer-table tbody tr').length"), 6);
  await fill('[aria-label="Search customers"]', 'fatou');
  assert.equal(await evaluate("document.querySelectorAll('.customer-table tbody tr').length"), 1);
  await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100); await screenshot('customer-profile-desktop');
  await evaluate("document.querySelector('[aria-label=\"Close dialog\"]').click()");
  await click('Settings', "document.querySelector('.sidebar-bottom')"); await click('Start fresh');
  await fill('[role=dialog] input', 'START FRESH'); await submit();
  assert.equal((await state()).products.length, 0);
  await fill('[name=storeName]', 'Videvas Beauty'); await fill('[name=currency]', 'XOF');
  await evaluate("document.querySelector('.settings-form').requestSubmit()"); await sleep(150);
  assert.equal((await state()).settings.currency, 'XOF');
  await click('Inventory', "document.querySelector('nav')"); await click('Add product', "document.querySelector('.heading-actions')");
  for (const [key, value] of Object.entries({ name: 'Test Glow Serum', brand: 'Videvas', sku: 'TEST-001', price: '7500', cost: '4000', quantity: '10', reorder: '3', expiry: dayOffset(30) })) await fill(`[role=dialog] [name=${key}]`, value);
  await fill('[role=dialog] [name=price]', '7500.5');
  assert.equal(await evaluate("document.querySelector('[role=dialog] [name=price]').checkValidity()"), false, 'XOF rejects fractional francs');
  await fill('[role=dialog] [name=price]', '7500');
  await submit(); assert.equal((await state()).products.length, 1);
  await click('Settings', "document.querySelector('.sidebar-bottom')");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Load demo data').disabled"), true, 'Demo cannot replace shop records');
  await click('Inventory', "document.querySelector('nav')");
  await click('Receive stock', "document.querySelector('.inventory-summary')");
  await fill('[role=dialog] input[type=number]', '5');
  await fill('[role=dialog] .field:nth-child(3) input', '4500');
  await fill('[role=dialog] [name=expiry]', dayOffset(90));
  await submit(); assert.equal((await state()).transactions[0].amount, 2250000);
  await click('Customers', "document.querySelector('nav')"); await click('Add customer', "document.querySelector('.heading-actions')");
  for (const [key, value] of Object.entries({ name: 'Test Customer', phone: '+221 77 123 45 67', email: 'test.customer@example.com', address: 'Shop pickup', notes: 'Prefers fragrance-free products' })) await fill(`[role=dialog] [name=${key}]`, value);
  await evaluate("document.querySelector('[name=vip]').click()");
  await submit(); assert.equal((await state()).customers.length, 1);
  assert.equal((await state()).customers[0].vip, true);
  await click('VIP', "document.querySelector('.customers-card .tabs')");
  assert.equal(await evaluate("document.querySelectorAll('.customer-table tbody tr').length"), 1);
  const customerId = (await state()).customers[0].id;
  await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100);
  await click('Record sale', "document.querySelector('[role=dialog]')");
  assert.equal(await evaluate("document.querySelector('[name=customerId]').value"), customerId, 'Profile sales preselect the customer');
  await fill('[aria-label="Product 1"]', (await state()).products[0].id);
  await fill('[aria-label="Quantity 1"]', '3');
  await fill('[role=dialog] [name=discount]', '500');
  await fill('[role=dialog] [name=paymentAmount]', '22000');
  await submit();
  let saved = await state(); validateState(saved);
  assert.equal(saved.products[0].batches[0].quantity, 7); assert.equal(saved.transactions.at(-1).amount, 2200000); assert.equal(metrics(saved).grossProfit, 1000000);
  assert.equal(customerMetrics(saved, customerId).netSpent, 2200000);
  assert.equal(saved.transactions.at(-1).customerId, customerId);
  await click('Cash ledger', "document.querySelector('nav')"); await click('Log expense');
  await fill('[role=dialog] [name=description]', 'Shopping bags'); await fill('[role=dialog] [name=amount]', '1000'); await fill('[role=dialog] [name=category]', 'Supplies');
  await submit(); saved = await state(); assert.equal(metrics(saved).operatingProfit, 900000); assert.equal(metrics(saved).cashFlow, -150000);
  await send('Page.reload'); await waitFor("document.querySelector('h1')?.textContent==='Business, in bloom.'");
  saved = await state(); assert.equal(saved.transactions.length, 4); validateState(saved);
  assert.equal(customerMetrics(saved, customerId).balance, 0);
  assert.equal(saved.customers[0].notes, 'Prefers fragrance-free products');
  await click('Customers', "document.querySelector('nav')"); await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100);
  assert.equal(await evaluate("document.querySelectorAll('.customer-detail .transaction-table tbody tr').length"), 2);
  await click('Edit customer'); await fill('[role=dialog] [name=name]', 'Updated Customer'); await submit();
  saved = await state(); assert.equal(saved.customers[0].name, 'Updated Customer');
  assert.equal(saved.transactions.find(t => t.type === 'sale').party, 'Test Customer', 'Historical receipt name is preserved');
  await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100); await click('Archive customer');
  await click('Archive customer', "document.querySelector('.modal-footer')");
  assert.equal((await state()).customers[0].archived, true);
  assert.equal(await evaluate("document.querySelectorAll('.customer-table tbody tr').length"), 0);
  await click('Archived', "document.querySelector('.tabs')"); await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100);
  assert.equal(await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='Record sale').disabled"), true);
  await click('Restore customer'); await click('Restore customer', "document.querySelector('.modal-footer')");
  assert.equal((await state()).customers[0].archived, false);
  await click('Sales', "document.querySelector('nav')"); await evaluate("document.querySelector('.transaction-cell').click()"); await sleep(150);
  await click('Return & refund'); await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').click()"); await click('Record return & refund');
  saved = await state(); validateState(saved); assert.equal(saved.products[0].batches[0].quantity, 10); assert.equal(metrics(saved).revenue, 0);
  assert.equal(customerMetrics(saved, customerId).netSpent, 0);
  assert.equal(customerMetrics(saved, customerId).history.length, 3);
  await click('Customers', "document.querySelector('nav')"); await click('Export'); await sleep(350);
  const customerCSV = await readFile(`data/browser/downloads/videvas-customers-${today()}.csv`, 'utf8');
  assert.ok(customerCSV.includes('Updated Customer') && customerCSV.includes('test.customer@example.com') && customerCSV.includes('"XOF"'));
  await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100);
  assert.equal(await evaluate("document.querySelectorAll('.customer-detail .transaction-table tbody tr').length"), 3);
  await evaluate("document.querySelector('.customer-detail .transaction-cell').click()"); await sleep(100); await click('View customer profile');
  assert.ok(await evaluate("document.querySelector('.customer-detail-hero h3').textContent==='Updated Customer'"));
  await evaluate("document.querySelector('[aria-label=\"Close dialog\"]').click()");
  await click('Reports', "document.querySelector('nav')"); assert.equal(await evaluate("document.querySelectorAll('.profit-breakdown>div').length"), 5);
  await click('Settings', "document.querySelector('.sidebar-bottom')");
  await click('Download backup'); await sleep(350);
  const backupFiles = await Promise.all((await readdir('data/browser/downloads')).filter(name => name.startsWith(`videvas-backup-${today()}`) && name.endsWith('.json')).map(async name => ({ name, modified: (await stat(`data/browser/downloads/${name}`)).mtimeMs })));
  const downloaded = backupFiles.sort((a, b) => b.modified - a.modified)[0]?.name;
  assert.ok(downloaded, 'Backup download was saved');
  const backupState = validateState(JSON.parse(await readFile(`data/browser/downloads/${downloaded}`, 'utf8')));
  assert.equal(backupState.customers[0].id, customerId, 'Downloaded backup includes the customer profile');
  assert.equal(backupState.customers[0].notes, 'Prefers fragrance-free products');
  assert.equal(backupState.customers[0].vip, true);
  assert.equal(backupState.transactions.filter(t => t.type === 'payment').length, 1);
  await writeFile('data/browser/restore-test.json', JSON.stringify(saved));
  await fill('[name=storeName]', 'Temporary name'); await evaluate("document.querySelector('.settings-form').requestSubmit()"); await sleep(100);
  await send('DOM.enable');
  const documentNode = await send('DOM.getDocument');
  const fileInput = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [resolve('data/browser/restore-test.json')] });
  await waitFor("document.querySelector('.restore-confirm')");
  await fill('.restore-confirm input', 'RESTORE'); await click('Restore workspace');
  assert.equal((await state()).settings.storeName, 'Videvas Beauty');
  assert.equal((await state()).customers[0].id, customerId, 'Backup restore retains customer identity');
  await click('Inventory', "document.querySelector('nav')"); await click('Export'); await sleep(350);
  const inventoryCSV = await readFile(`data/browser/downloads/videvas-inventory-${today()}.csv`, 'utf8');
  assert.ok(inventoryCSV.includes('"7500"') && inventoryCSV.includes('"XOF"'), 'CSV uses whole CFA amounts');
  // Conflicting financial drafts stay visible, while only confirmed records refresh.
  await click('Sales', "document.querySelector('nav')"); await click('Record sale');
  await fill('[aria-label="Product 1"]', saved.products[0].id);
  await fill('[name=note]', 'Keep this sale draft');
  const transactionsBeforeConflict = (await state()).transactions.length;
  backend.beforeNextSave = () => backend.saveAs(owner.id, current => ({ ...current, settings: { ...current.settings, storeName: 'Other device' } }));
  await submit(); await waitFor("document.querySelector('[role=dialog] .form-error')");
  assert.match(await evaluate("document.querySelector('[role=dialog] .form-error').textContent"), /another device/i);
  assert.equal(await evaluate("document.querySelector('[name=note]').value"), 'Keep this sale draft');
  assert.equal((await state()).transactions.length, transactionsBeforeConflict, 'A conflicted sale is not rebased or posted');
  await evaluate(`document.querySelector('[aria-label="Close dialog"]').click()`);

  // Several purchases share one tab. Collection retries never duplicate a payment.
  await click('Customers', "document.querySelector('nav')");
  for (let visit = 0; visit < 2; visit++) {
    await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100);
    await click('Record sale', "document.querySelector('[role=dialog]')");
    await fill('[aria-label="Product 1"]', saved.products[0].id);
    await submit(); await waitFor("!document.querySelector('[role=dialog]')");
  }
  assert.equal(customerMetrics(await state(), customerId).balance, 1500000);
  await click('Outstanding', "document.querySelector('.customers-card .tabs')");
  assert.equal(await evaluate("document.querySelectorAll('.customer-table tbody tr').length"), 1);
  await screenshot('customer-tabs-desktop');
  await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100);
  await screenshot('customer-tab-profile-desktop');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.customer-tab-table th:nth-child(4)')).display"), 'table-cell');
  assert.equal(await evaluate("document.querySelector('.customer-balance').dataset.customerBalance"), '1500000');
  await click('Record payment', "document.querySelector('[role=dialog]')");
  assert.equal(await evaluate("document.querySelector('[name=customerId]').value"), customerId);
  await fill('[name=amount]', '15001');
  assert.equal(await evaluate("document.querySelector('[name=amount]').checkValidity()"), false);
  await fill('[name=amount]', '6000');
  await screenshot('customer-payment-desktop');
  backend.dropNextReply(); await submit();
  await waitFor("document.querySelector('[role=dialog] .cloud-notice')?.textContent.includes('Check previous save')");
  await click('Check previous save', "document.querySelector('[role=dialog]')");
  await waitFor("!document.querySelector('[role=dialog]')");
  let tabState = await state(); validateState(tabState);
  assert.equal(customerMetrics(tabState, customerId).balance, 900000);
  assert.equal(tabState.transactions.filter(t => t.type === 'payment').length, 2);
  assert.equal(tabState.transactions.at(-1).saleId, undefined);
  // A return clears debt across the whole tab and does not pay cash while debt remains.
  await click('Sales', "document.querySelector('nav')");
  await evaluate("document.querySelector('.transaction-cell').click()"); await sleep(100);
  await click('Return & refund');
  assert.ok(await evaluate("document.querySelector('.tab-balance-summary').textContent.includes('Cash to refund0 CFA')"));
  await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').click()"); await submit();
  await waitFor("!document.querySelector('[role=dialog]')");
  tabState = await state();
  assert.equal(customerMetrics(tabState, customerId).balance, 150000);
  assert.equal(tabState.transactions.at(-1).cashAmount, 0);
  await click('Customers', "document.querySelector('nav')");
  await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100);
  await click('Record payment', "document.querySelector('[role=dialog]')"); await click('Clear full balance');
  assert.equal(await evaluate("document.querySelector('[name=amount]').value"), '1500');
  await submit(); await waitFor("!document.querySelector('[role=dialog]')");
  tabState = await state(); validateState(tabState);
  assert.equal(customerMetrics(tabState, customerId).balance, 0);
  await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100); await click('Edit customer');
  await evaluate("document.querySelector('[name=vip]').click()"); await submit();
  assert.equal((await state()).customers[0].vip, false);
  await click('VIP', "document.querySelector('.customers-card .tabs')");
  assert.equal(await evaluate("document.querySelectorAll('.customer-table tbody tr').length"), 0);

  // An older backup migrates named customers only after explicit import.
  await click('Settings', "document.querySelector('.sidebar-bottom')"); await click('Start fresh');
  await fill('[role=dialog] input', 'START FRESH'); await submit();
  const legacy = structuredClone(saved); delete legacy.customers;
  legacy.transactions = legacy.transactions.filter(t => t.type !== 'payment');
  legacy.transactions.forEach(t => { delete t.customerId; delete t.onAccount; delete t.cashAmount; if (['sale','refund'].includes(t.type)) t.method = 'Cash'; });
  const legacyRaw = JSON.stringify(legacy);
  await evaluate(`localStorage.setItem('videvas-workspace-v1', ${JSON.stringify(legacyRaw)})`);
  await send('Page.reload'); await waitFor("document.querySelector('.stat-value')");
  assert.equal((await state()).products.length, 0, 'A browser snapshot cannot silently overwrite cloud records');
  await click('Settings', "document.querySelector('.sidebar-bottom')"); await click('Import browser records');
  await fill('[role=dialog] input', 'IMPORT'); await submit();
  const migrated = await state(); validateState(migrated);
  assert.equal(migrated.customers.length, 1);
  assert.equal(customerMetrics(migrated, migrated.customers[0].id).history.length, 2);
  assert.deepEqual(migrated.products, saved.products); assert.deepEqual(metrics(migrated), metrics(saved));
  assert.equal(await evaluate("localStorage.getItem('videvas-workspace-v1')"), legacyRaw);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.trim()==='Import browser records').disabled"), true);

  await deletionScenarios();
  await cloudScenarios();
  await click('Settings', "document.querySelector('.sidebar-bottom')"); await click('Start fresh');
  await fill('[role=dialog] input', 'START FRESH'); await submit();
  await evaluate("localStorage.removeItem('videvas-workspace-v1')");
  await send('Page.reload'); await waitFor("document.querySelector('.stat-value')");
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(150); await screenshot('overview-mobile');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile has horizontal overflow');
  assert.equal(await evaluate("[...document.querySelectorAll('.stat-card')].every(el => el.scrollWidth<=el.clientWidth)"), true, 'Mobile CFA metrics stay inside their cards');
  await evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()"); await sleep(100);
  await click('Inventory', "document.querySelector('nav')"); await screenshot('inventory-mobile');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile inventory has horizontal overflow');
  await evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()"); await sleep(100);
  await click('Customers', "document.querySelector('nav')"); await screenshot('customers-mobile');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile customers have horizontal overflow');
  assert.equal(await evaluate("document.querySelectorAll('.customer-table tbody tr').length"), 0, 'Mobile customers start empty');
  await evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()"); await sleep(100);
  await click('Settings', "document.querySelector('.sidebar-bottom')"); await click('Load demo data');
  await evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()"); await sleep(100);
  await click('Customers', "document.querySelector('nav')");
  await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100); await screenshot('customer-profile-mobile');
  assert.equal(await evaluate("document.querySelector('.modal').scrollWidth <= document.querySelector('.modal').clientWidth"), true, 'Mobile profile has horizontal overflow');
  await click('Record sale', "document.querySelector('[role=dialog]')");
  await fill('[aria-label="Product 1"]', (await state()).products[0].id); await submit();
  await waitFor("!document.querySelector('[role=dialog]')");
  await evaluate("document.querySelector('.customer-cell').click()"); await sleep(100);
  await screenshot('customer-tab-profile-mobile');
  assert.equal(await evaluate("document.querySelector('.modal').scrollWidth <= document.querySelector('.modal').clientWidth"), true, 'Mobile tab profile fits');
  await click('Record payment', "document.querySelector('[role=dialog]')"); await screenshot('customer-payment-mobile');
  assert.equal(await evaluate("document.querySelector('.modal').scrollWidth <= document.querySelector('.modal').clientWidth"), true, 'Mobile payment form fits');
  await click('Clear full balance'); await submit(); await waitFor("!document.querySelector('[role=dialog]')");
  assert.equal(customerMetrics(await state(), (await state()).customers[0].id).balance, 0);
  await evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()"); await sleep(100);
  await click('Settings', "document.querySelector('.sidebar-bottom')"); await click('Start fresh');
  await fill('[role=dialog] input', 'START FRESH'); await submit();
  const fresh = await state();
  assert.equal(fresh.demo, false);
  assert.ok([fresh.products, fresh.customers, fresh.transactions, fresh.movements].every(list => list.length === 0));
  await send('Page.reload'); await waitFor("document.querySelector('.stat-value')");
  assert.equal((await state()).products.length, 0, 'Clearing a deliberate demo remains empty after reload');
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: sign-in/signup/email confirmation/password recovery, private accounts, Realtime and focus sync, conflicts, offline drafts, lost acknowledgements, duplicate-submit protection, legacy imports, desktop/mobile, customer tabs, partial and full payments, VIP flags, stock, sales, refunds, ledger, backups, exports.');
  console.log('Screenshots saved in data/browser/.');
} catch (error) {
  try {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile('data/browser/failure.png', Buffer.from(result.data, 'base64'));
    const body = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    console.error('Browser page:', body.result.value);
    console.error('Browser errors:', errors);
  } catch {}
  throw error;
} finally { child.kill(); server.closeAllConnections(); await new Promise(r => server.close(r)); await backend.close(); }
