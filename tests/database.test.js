import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createDemo, emptyState, recordEntry, today } from '../src/model.js';

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
  assert.deepEqual(await asUser(alice, load), prior);
});
