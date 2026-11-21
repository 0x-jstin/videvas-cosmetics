import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { addCustomer, addProduct, createDemo, customerMetrics, deleteTransaction, emptyState, metrics, receiveStock, recordCustomerPayment, recordEntry, recordSale, refundSale, today, validateState } from '../src/model.js';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users values ('${alice}'), ('${bob}');
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/001_cloud_workspaces.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/002_customer_tabs.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261121102723_delete_shop_records.sql', import.meta.url), 'utf8'));
});
after(async () => { await db?.close(); });

async function asUser(owner, callback, role = 'authenticated') {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner || '']);
  await db.exec(`set role ${role}`);
  try { return await callback(); }
  finally { await db.exec('reset role'); }
}
const load = () => db.query('select public.videvas_load_workspace() as workspace').then(r => r.rows[0].workspace);
const save = (state, revision, requestId = crypto.randomUUID(), mode = 'save') => db.query(
  'select public.videvas_save_workspace($1::jsonb, $2::bigint, $3::uuid, $4::text) as workspace',
  [JSON.stringify(state), revision, requestId, mode],
).then(r => r.rows[0].workspace);
const entry = (state, description = 'Owner contribution') => recordEntry(state, {
  type: 'income', description, amount: 10000, method: 'Cash', date: today(),
});

test('a new account starts empty and cannot see or write another account’s records', async () => {
  await asUser(alice, async () => {
    assert.deepEqual((await load()).state, emptyState());
    const result = await save(createDemo(), 0);
    assert.equal(result.revision, 1);
    assert.equal(result.state.products.length, 12);
    assert.equal((await db.query('select * from public.videvas_products')).rows.length, 12);
    await assert.rejects(db.exec('update public.videvas_workspaces set revision = 99'), /permission denied/);
    await assert.rejects(db.exec('delete from public.videvas_workspace_changes'), /permission denied/);
    await assert.rejects(db.exec('select * from public.videvas_operations'), /permission denied/);
  });
  await asUser(bob, async () => {
    const own = await load();
    assert.equal(own.owner_id, bob);
    assert.deepEqual(own.state, emptyState());
    assert.deepEqual((await db.query('select owner_id from public.videvas_workspaces')).rows, [{ owner_id: bob }]);
    assert.equal((await db.query('select * from public.videvas_products')).rows.length, 0);
    assert.equal((await db.query('select * from public.videvas_transactions')).rows.length, 0);
    assert.deepEqual((await db.query('select owner_id from public.videvas_workspace_changes')).rows, [{ owner_id: bob }]);
  });
});

test('anonymous callers and sessions without a user cannot open or save a shop', async () => {
  await asUser(null, async () => {
    await assert.rejects(load(), /permission denied/);
    await assert.rejects(save(emptyState(), 0), /permission denied/);
    await assert.rejects(db.exec('select * from public.videvas_workspaces'), /permission denied/);
  }, 'anon');
  await asUser(null, async () => {
    await assert.rejects(load(), /Sign in/);
    await assert.rejects(save(emptyState(), 0), /Sign in/);
    assert.equal((await db.query('select * from public.videvas_workspaces')).rows.length, 0);
  });
});

test('stale writes are rejected; retries are idempotent even after another device writes', async () => {
  await asUser(bob, async () => {
    const requestId = crypto.randomUUID();
    const first = entry(emptyState());
    const result = await save(first, 0, requestId);
    assert.equal(result.revision, 1);
    await assert.rejects(save(entry(emptyState(), 'Stale contribution'), 0), { code: 'PT409' });
    const second = entry(first, 'Another device');
    assert.equal((await save(second, 1)).revision, 2);
    const retry = await save(first, 0, requestId);
    assert.equal(retry.revision, 2);
    assert.equal(retry.request_revision, 1);
    assert.deepEqual(retry.state, second);
    await assert.rejects(save(second, 0, requestId), /different entry/);
    assert.equal((await load()).revision, 2);
  });
});

test('normal saves preserve posted history and reject invalid snapshots atomically', async () => {
  await asUser(alice, async () => {
    const current = await load();
    const altered = structuredClone(current.state);
    altered.transactions[0].description = 'Tampered receipt';
    await assert.rejects(save(altered, current.revision), /cannot be changed/);
    const removed = structuredClone(current.state);
    removed.movements.pop();
    await assert.rejects(save(removed, current.revision), /cannot be changed/);
    const currencyChanged = structuredClone(current.state);
    currencyChanged.settings.currency = 'USD';
    await assert.rejects(save(currencyChanged, current.revision), /changing currency/);
    const invalid = structuredClone(current.state);
    invalid.products[0].price = -1;
    await assert.rejects(save(invalid, current.revision, crypto.randomUUID(), 'replace'), /invalid amounts/);
    assert.equal((await load()).revision, current.revision);
  });
});

test('imports only populate an empty workspace; explicit replacement permits reset and restore', async () => {
  await asUser(alice, async () => {
    let current = await load();
    await assert.rejects(save(createDemo(), current.revision, crypto.randomUUID(), 'import'), /empty cloud workspace/);
    current = await save(emptyState(current.state.settings), current.revision, crypto.randomUUID(), 'replace');
    assert.deepEqual(current.state, emptyState());
    current = await save(createDemo(), current.revision, crypto.randomUUID(), 'import');
    assert.equal(current.state.products.length, 12);
    assert.equal(current.state.customers.length, 6);
    assert.equal((await db.query('select * from public.videvas_stock_movements')).rows.length, current.state.movements.length);
    assert.equal((await db.query('select revision from public.videvas_workspace_changes')).rows[0].revision, current.revision);
  });
});

test('the migration is safe to apply again without losing existing shops', async () => {
  const prior = await asUser(alice, load);
  await db.exec(await readFile(new URL('../supabase/migrations/001_cloud_workspaces.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/002_customer_tabs.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261121102723_delete_shop_records.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await asUser(alice, load), prior);
});

test('cloud tabs save atomically, preserve payment receipts, and reject fabricated balances', async () => {
  await asUser(bob, async () => {
    let current = await load();
    let s = addProduct(addCustomer(emptyState(), { name: 'VIP buyer', vip: true }), { name: 'Serum', sku: 'S1', category: 'Skincare', price: 100000, cost: 30000, quantity: 10, reorder: 1 });
    current = await save(s, current.revision, crypto.randomUUID(), 'replace');
    const customerId = s.customers[0].id;
    s = recordSale(s, { customerId, onAccount: true, lines: [{ productId: s.products[0].id, quantity: 2 }], paymentAmount: 50000, method: 'Cash' });
    const requestId = crypto.randomUUID();
    current = await save(s, current.revision, requestId);
    assert.equal(customerMetrics(current.state, customerId).balance, 150000);
    assert.deepEqual((await save(s, current.revision - 1, requestId)).state, s);
    const corruptions = [
      copy => { copy.transactions.at(-1).amount = 250000; },
      copy => { copy.transactions.at(-1).saleId = copy.transactions[0].id; },
      copy => { copy.transactions.at(-1).customerId = 'missing'; },
      copy => { copy.customers[0].vip = 'yes'; },
      copy => { copy.transactions[0].onAccount = 'true'; },
      copy => { copy.transactions.at(-1).amount = 50101; },
    ];
    for (const corrupt of corruptions) {
      const copy = structuredClone(s); corrupt(copy);
      await assert.rejects(save(copy, current.revision, crypto.randomUUID(), 'replace'));
      assert.equal((await load()).revision, current.revision);
    }
    const overpayment = structuredClone(s);
    overpayment.transactions.push({ ...s.transactions.at(-1), id: crypto.randomUUID(), amount: 150100 });
    await assert.rejects(save(overpayment, current.revision), /outstanding balance/);
    s = recordCustomerPayment(s, { customerId, amount: 150000, method: 'Mobile money', date: today() });
    current = await save(s, current.revision);
    const altered = structuredClone(s); altered.transactions[1].note = 'Changed';
    await assert.rejects(save(altered, current.revision), /cannot be changed/);
    s = refundSale(s, s.transactions[0].id, { method: 'Cash' });
    const badReturn = structuredClone(s); badReturn.transactions.at(-1).cashAmount = 100000;
    await assert.rejects(save(badReturn, current.revision), /refund does not match/);
    current = await save(s, current.revision);
    assert.equal(customerMetrics(current.state, customerId).balance, 0);
    assert.equal(current.state.transactions.at(-1).cashAmount, 200000);
    await assert.rejects(save(s, current.revision - 1), { code: 'PT409' });
  });
});

function deletionFixture() {
  return addProduct(addCustomer(emptyState(), { name: 'Deletion test buyer' }), {
    name: 'Serum', sku: 'DEL-1', category: 'Skincare', price: 200000, cost: 100000, quantity: 2, reorder: 1,
  });
}
const deletionRestock = state => receiveStock(state, { productId: state.products[0].id, quantity: 4, cost: 120000, method: 'Cash' });
const deletionSale = (state, onAccount = false) => recordSale(state, {
  lines: [{ productId: state.products[0].id, quantity: 4 }], method: 'Cash',
  ...(onAccount ? { customerId: state.customers[0].id, onAccount: true, paymentAmount: 200000 } : {}),
});

test('SQL deletion matches the financial model for sales, payments, restocks, refunds, and cash entries', async () => {
  const received = deletionRestock(deletionFixture());
  const sold = deletionSale(received);
  const tab = deletionSale(received, true);
  const returned = refundSale(sold, sold.transactions.at(-1).id);
  const scenarios = [
    [sold, sold.transactions.at(-1).id],
    [tab, tab.transactions.at(-1).id],
    [received, received.transactions[0].id],
    [returned, returned.transactions.at(-1).id],
    [recordEntry(received, { type: 'expense', description: 'Rent', amount: 10000, category: 'Rent', method: 'Cash', date: today() }), null],
    [entry(received), null],
    [returned, received.transactions[0].id],
  ];
  for (const [state, target] of scenarios) {
    const transactionId = target || state.transactions.at(-1).id;
    const expected = deleteTransaction(state, transactionId);
    const computed = (await db.query('select public.videvas_state_after_delete($1::jsonb, $2::text) as state', [JSON.stringify(state), transactionId])).rows[0].state;
    assert.deepEqual(computed, expected);
    await asUser(alice, async () => {
      let current = await load();
      current = await save(state, current.revision, crypto.randomUUID(), 'replace');
      const result = await save(expected, current.revision, crypto.randomUUID(), 'delete');
      assert.deepEqual(result.state, expected);
      assert.deepEqual(metrics(result.state), metrics(expected));
      validateState(result.state);
      assert.equal(result.revision, current.revision + 1);
      assert.equal((await db.query('select * from public.videvas_transactions')).rows.length, expected.transactions.length);
      assert.equal((await db.query('select * from public.videvas_stock_movements')).rows.length, expected.movements.length);
      assert.equal((await db.query('select revision from public.videvas_workspace_changes')).rows[0].revision, result.revision);
    });
  }
});

test('delete mode rejects edits to other records, extra removals, additions, and incorrect stock rollback', async () => {
  await asUser(alice, async () => {
    let current = await load();
    const posted = entry(deletionSale(deletionRestock(deletionFixture())));
    current = await save(posted, current.revision, crypto.randomUUID(), 'replace');
    current = await load();
    const deleted = deleteTransaction(posted, posted.transactions[1].id);
    await assert.rejects(save(deleted, current.revision), /cannot be changed/);
    await assert.rejects(save(posted, current.revision, crypto.randomUUID(), 'delete'), /one existing record/);
    const mutations = [
      copy => { copy.products[0].price += 100; },
      copy => { copy.products[0].batches[0].quantity += 1; },
      copy => { copy.products[0].batches.pop(); },
      copy => { copy.customers[0].name = 'Changed customer'; },
      copy => { copy.settings.storeName = 'Changed shop'; },
      copy => { copy.settings.currency = 'USD'; },
      copy => { copy.transactions.at(-1).description = 'Changed entry'; },
      copy => { copy.transactions.reverse(); },
      copy => { copy.transactions.push(entry(emptyState()).transactions[0]); },
      copy => { copy.transactions.pop(); },
      copy => { copy.movements.pop(); },
      copy => { copy.movements = structuredClone(posted.movements); },
    ];
    for (const mutate of mutations) {
      const corrupt = structuredClone(deleted); mutate(corrupt);
      await assert.rejects(save(corrupt, current.revision, crypto.randomUUID(), 'delete'), /Deletion must only|one existing record|invalid/);
      assert.deepEqual(await load(), current, 'A rejected deletion cannot partially change the shop');
    }
    current = await save(deleted, current.revision, crypto.randomUUID(), 'delete');
    assert.deepEqual(current.state, deleted);
  });
});

test('SQL refuses deletion of consumed stock, a returned sale, and entries used by later payments or refunds', async () => {
  const received = deletionRestock(deletionFixture());
  const sold = deletionSale(received);
  const returned = refundSale(sold, sold.transactions.at(-1).id);
  const tab = deletionSale(received, true);
  const tabReturn = refundSale(tab, tab.transactions[1].id, { method: 'Cash' });
  const scenarios = [
    [sold, received.transactions[0].id, /stock has been sold or removed/],
    [returned, sold.transactions.at(-1).id, /refund first/],
    [tab, tab.transactions[1].id, /dependent entries first/],
    [tabReturn, tab.transactions[2].id, /dependent entries first/],
  ];
  for (const [state, target, reason] of scenarios) {
    await assert.rejects(db.query('select public.videvas_state_after_delete($1::jsonb, $2::text)', [JSON.stringify(state), target]), reason);
  }
});

test('deletion retries remain idempotent after another device saves and stale deletion requests cannot overwrite it', async () => {
  await asUser(alice, async () => {
    let current = await load();
    const posted = deletionSale(deletionRestock(deletionFixture()));
    current = await save(posted, current.revision, crypto.randomUUID(), 'replace');
    const revision = current.revision, requestId = crypto.randomUUID();
    const deleted = deleteTransaction(posted, posted.transactions.at(-1).id);
    const committed = await save(deleted, revision, requestId, 'delete');
    const newer = entry(deleted, 'Another device after deletion');
    current = await save(newer, committed.revision);
    current = await load();
    const retry = await save(deleted, revision, requestId, 'delete');
    assert.equal(retry.request_revision, committed.revision);
    assert.equal(retry.revision, current.revision);
    assert.deepEqual(retry.state, newer);
    await assert.rejects(save(deleted, revision, crypto.randomUUID(), 'delete'), { code: 'PT409' });
    await assert.rejects(save(deleted, revision, requestId, 'replace'), /different entry/);
    assert.deepEqual(await load(), current);
  });
});

test('the deletion helper is private and one owner cannot delete another owner’s records', async () => {
  const before = await asUser(alice, load);
  const foreign = deleteTransaction(before.state, before.state.transactions.at(-1).id);
  await asUser(bob, async () => {
    const own = await load();
    await assert.rejects(save(foreign, own.revision, crypto.randomUUID(), 'delete'), /one existing record|Deletion must only|outstanding balance|Invalid/);
    assert.deepEqual(await load(), own);
    await assert.rejects(db.query('select public.videvas_state_after_delete($1::jsonb, $2::text)', [JSON.stringify(before.state), before.state.transactions.at(-1).id]), /permission denied/);
    await assert.rejects(db.exec('delete from public.videvas_workspaces'), /permission denied/);
  });
  await asUser(null, async () => {
    await assert.rejects(save(foreign, 0, crypto.randomUUID(), 'delete'), /permission denied/);
    await assert.rejects(db.query('select public.videvas_state_after_delete($1::jsonb, $2::text)', [JSON.stringify(before.state), before.state.transactions.at(-1).id]), /permission denied/);
  }, 'anon');
  assert.deepEqual(await asUser(alice, load), before);
});
