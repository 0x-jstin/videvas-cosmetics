import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudError, createCloudTransport, createWorkspaceStore } from '../src/cloud.js';
import { emptyState, recordEntry, today } from '../src/model.js';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const entry = (state, description) => recordEntry(state, { type: 'income', description, amount: 10000, method: 'Cash', date: today() });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const document = (owner, state = emptyState(), revision = 0) => ({ owner_id: owner, state: structuredClone(state), revision, updated_at: new Date().toISOString() });

function server() {
  const shops = new Map(), receipts = new Map(), calls = [];
  let dropReply = false;
  const get = owner => structuredClone(shops.get(owner) || document(owner));
  const transport = {
    async load(owner) { return get(owner); },
    async save(owner, request) {
      calls.push(structuredClone(request));
      const receiptKey = `${owner}:${request.requestId}`;
      const fingerprint = JSON.stringify([request.state, request.expectedRevision, request.mode]);
      const prior = receipts.get(receiptKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CloudError('Request reused.', 'PT409');
        return { ...get(owner), request_revision: prior.revision };
      }
      const shop = get(owner);
      if (shop.revision !== request.expectedRevision) throw new CloudError('Shop changed on another device.', 'PT409');
      const saved = document(owner, request.state, shop.revision + 1);
      shops.set(owner, saved);
      receipts.set(receiptKey, { fingerprint, revision: saved.revision });
      if (dropReply) { dropReply = false; throw new CloudError('Response lost.', 'NETWORK', true); }
      return { ...structuredClone(saved), request_revision: saved.revision };
    },
  };
  return { transport, calls, get, dropNextReply() { dropReply = true; } };
}

test('a lost acknowledgement never adds optimistic records and reuses the original operation after reconnecting', async () => {
  const backend = server(), first = createWorkspaceStore(backend.transport), second = createWorkspaceStore(backend.transport);
  await first.setOwner(alice); await second.setOwner(alice);
  backend.dropNextReply();
  await assert.rejects(first.save(state => entry(state, 'First contribution')), { code: 'SAVE_PENDING' });
  assert.equal(first.getSnapshot().state.transactions.length, 0);
  assert.equal(first.getSnapshot().pending, true);
  await assert.rejects(first.save(state => entry(state, 'Duplicate')), { code: 'SAVE_PENDING' });
  await second.refresh();
  await second.save(state => entry(state, 'Another device'));
  await first.retryPending();
  assert.equal(first.getSnapshot().revision, 2);
  assert.equal(first.getSnapshot().pending, false);
  assert.equal(first.getSnapshot().state.transactions.length, 2);
  assert.equal(backend.calls[0].requestId, backend.calls[2].requestId);
  assert.deepEqual(backend.calls[0].state, backend.calls[2].state);
  assert.equal(backend.get(alice).state.transactions.length, 2);
});

test('a stale financial draft is rejected and the confirmed workspace is refreshed without silently reposting', async () => {
  const backend = server(), first = createWorkspaceStore(backend.transport), second = createWorkspaceStore(backend.transport);
  await first.setOwner(alice); await second.setOwner(alice);
  await second.save(state => entry(state, 'Other device'));
  await assert.rejects(first.save(state => entry(state, 'My stale draft')), { code: 'PT409' });
  assert.equal(first.getSnapshot().pending, false);
  assert.equal(first.getSnapshot().revision, 1);
  assert.deepEqual(first.getSnapshot().state.transactions.map(t => t.description), ['Other device']);
  assert.equal(backend.calls.length, 2);
  await first.save(state => entry(state, 'Reviewed draft'));
  assert.equal(backend.get(alice).state.transactions.length, 2);
});

test('known offline writes and invalid financial snapshots never reach the server', async () => {
  const backend = server(); let online = true;
  const store = createWorkspaceStore(backend.transport, { isOnline: () => online });
  await store.setOwner(alice);
  online = false; store.setOnline(false);
  await assert.rejects(store.save(state => entry(state, 'Offline')), { code: 'OFFLINE' });
  assert.equal(store.getSnapshot().pending, false);
  assert.equal(backend.calls.length, 0);
  online = true; await store.refresh();
  await assert.rejects(store.save(state => ({ ...state, transactions: [{ id: 'bad', amount: -1 }] })), /Invalid transaction/);
  assert.equal(backend.calls.length, 0);
  assert.equal(store.getSnapshot().state.transactions.length, 0);
});

test('late loads and saves from a previous account cannot expose records or clear a new account’s pending save', async () => {
  const oldLoad = deferred(); let loadCount = 0;
  const backend = server();
  const store = createWorkspaceStore({ ...backend.transport, load: owner => ++loadCount === 1 ? oldLoad.promise : backend.transport.load(owner) });
  const opening = store.setOwner(alice);
  await store.setOwner(bob);
  oldLoad.resolve(document(alice, entry(emptyState(), 'Private Alice record'), 1)); await opening;
  assert.equal(store.getSnapshot().ownerId, bob);
  assert.equal(store.getSnapshot().state.transactions.length, 0);

  const delayedAlice = deferred(), delayedBob = deferred();
  const savingStore = createWorkspaceStore({ ...backend.transport, save: owner => owner === alice ? delayedAlice.promise : delayedBob.promise });
  await savingStore.setOwner(alice);
  const aliceSave = savingStore.save(state => entry(state, 'Alice'));
  const aliceRejected = assert.rejects(aliceSave, { code: 'AUTH_CHANGED' });
  await savingStore.setOwner(bob);
  const bobSave = savingStore.save(state => entry(state, 'Bob'));
  const bobRejected = assert.rejects(bobSave, { code: 'SAVE_PENDING' });
  delayedBob.reject(new CloudError('Network interrupted.', 'NETWORK', true)); await bobRejected;
  delayedAlice.resolve({ ...document(alice, entry(emptyState(), 'Alice'), 1), request_revision: 1 }); await aliceRejected;
  assert.equal(savingStore.getSnapshot().ownerId, bob);
  assert.equal(savingStore.getSnapshot().state.transactions.length, 0);
  assert.equal(savingStore.getSnapshot().pending, true);
});

test('only one save can run at a time, and malformed acknowledgements remain recoverable', async () => {
  const gate = deferred(), backend = server();
  const store = createWorkspaceStore({ ...backend.transport, save: () => gate.promise });
  await store.setOwner(alice);
  const first = store.save(state => entry(state, 'First'));
  const rejected = assert.rejects(first, { code: 'SAVE_PENDING' });
  await assert.rejects(store.save(state => entry(state, 'Second')), { code: 'SAVE_PENDING' });
  assert.equal(store.getSnapshot().writing, true);
  gate.resolve({ ...document(bob, entry(emptyState(), 'Wrong account'), 1), request_revision: 1 }); await rejected;
  assert.equal(store.getSnapshot().state.transactions.length, 0);
  assert.equal(store.getSnapshot().pending, true);
  assert.equal(store.getSnapshot().writing, false);
});

test('Realtime refreshes are deferred during unresolved saves and old subscriptions cannot refresh a new account', async () => {
  const backend = server(), watchers = new Map();
  const store = createWorkspaceStore({ ...backend.transport, watch(owner, callback) { watchers.set(owner, callback); return () => {}; } });
  await store.setOwner(alice);
  const other = createWorkspaceStore(backend.transport); await other.setOwner(alice);
  await other.save(state => entry(state, 'Remote record'));
  watchers.get(alice)(1); await store.refresh();
  assert.equal(store.getSnapshot().revision, 1);
  backend.dropNextReply();
  await assert.rejects(store.save(state => entry(state, 'Response lost')), { code: 'SAVE_PENDING' });
  watchers.get(alice)(2); await store.refresh();
  assert.equal(store.getSnapshot().revision, 1, 'An unresolved save is not replaced with a refresh');
  await store.retryPending(); await store.refresh();
  assert.equal(store.getSnapshot().revision, 2);
  await store.setOwner(bob);
  watchers.get(alice)(99);
  assert.equal(store.getSnapshot().ownerId, bob);
  assert.equal(store.getSnapshot().revision, 0);
});

test('RPC transport pins the account token before the network request and blocks an account changed before token acquisition', async () => {
  let session = { user: { id: alice }, access_token: 'alice-jwt' }, requests = 0;
  const client = { auth: { async getSession() { return { data: { session: structuredClone(session) } }; } } };
  const transport = createCloudTransport(client, {
    url: 'https://example.supabase.co', key: 'public-key',
    async fetcher(url, options) {
      session = { user: { id: bob }, access_token: 'bob-jwt' }; requests++;
      assert.equal(options.headers.Authorization, 'Bearer alice-jwt');
      assert.equal(options.headers.apikey, 'public-key');
      assert.equal(options.credentials, 'omit');
      return new Response(JSON.stringify(document(alice)), { status: 200 });
    },
  });
  assert.equal((await transport.load(alice)).owner_id, alice);
  await assert.rejects(transport.load(alice), { code: 'AUTH_CHANGED' });
  assert.equal(requests, 1);
});

test('password recovery also pins the intended account when another tab changes its session', async () => {
  let session = { user: { id: alice }, access_token: 'alice-jwt' }, requests = 0;
  const client = { auth: { async getSession() { return { data: { session: structuredClone(session) } }; } } };
  const transport = createCloudTransport(client, {
    url: 'https://example.supabase.co', key: 'public-key',
    async fetcher(url, options) {
      session = { user: { id: bob }, access_token: 'bob-jwt' }; requests++;
      assert.equal(url, 'https://example.supabase.co/auth/v1/user');
      assert.equal(options.method, 'PUT');
      assert.equal(options.headers.Authorization, 'Bearer alice-jwt');
      assert.deepEqual(JSON.parse(options.body), { password: 'Updated-password-123' });
      return new Response(JSON.stringify({ id: alice }), { status: 200 });
    },
  });
  await transport.updatePassword(alice, 'Updated-password-123');
  await assert.rejects(transport.updatePassword(alice, 'Changed-again-456'), { code: 'AUTH_CHANGED' });
  assert.equal(requests, 1);
});

test('HTTP conflicts are definitive while network interruptions and timeouts require the same-request retry', async () => {
  const client = { auth: { async getSession() { return { data: { session: { user: { id: alice }, access_token: 'alice-jwt' } } }; } } };
  const options = { url: 'https://example.supabase.co', key: 'public-key' };
  const conflict = createCloudTransport(client, { ...options, fetcher: async () => new Response(JSON.stringify({ code: 'PT409', message: 'Stale revision' }), { status: 409 }) });
  await assert.rejects(conflict.load(alice), { code: 'PT409', uncertain: false });
  const timeout = createCloudTransport(client, { ...options, timeoutMs: 10, fetcher: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')))) });
  await assert.rejects(timeout.load(alice), { code: 'NETWORK', uncertain: true });
});
