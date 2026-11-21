import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { emptyState } from '../src/model.js';

const raw = await readFile('.env.local', 'utf8');
const get = name => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1].trim().replace(/^['"]|['"]$/g, '');
const url = get('VITE_SUPABASE_URL'), key = get('VITE_SUPABASE_PUBLISHABLE_KEY');
assert.equal(url, 'https://tmixrlodofdycichecyj.supabase.co');
assert.ok(key?.startsWith('sb_publishable_'));
const headers = { apikey: key, 'Content-Type': 'application/json' };
const settings = await fetch(`${url}/auth/v1/settings`, { headers, signal: AbortSignal.timeout(15000) });
assert.equal(settings.status, 200, 'Public key must be accepted by the intended project');
const configuration = await settings.json();
assert.equal(configuration.external?.email, true, 'Email authentication must be enabled');
assert.notEqual(configuration.disable_signup, true, 'Account creation must be enabled');
const rpc = await fetch(`${url}/rest/v1/rpc/videvas_load_workspace`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(15000) });
const result = await rpc.json();
assert.equal(result.code, '42501', 'The installed workspace RPC must reject anonymous callers');
assert.ok(rpc.status === 401 || rpc.status === 403);
const deletion = await fetch(`${url}/rest/v1/rpc/videvas_save_workspace`, {
  method: 'POST', headers, body: JSON.stringify({ p_state: emptyState(), p_expected_revision: 0, p_request_id: crypto.randomUUID(), p_mode: 'delete' }), signal: AbortSignal.timeout(15000),
});
const deletionResult = await deletion.json();
assert.equal(deletionResult.code, '42501', 'The save RPC must reject anonymous deletion requests');
assert.ok(deletion.status === 401 || deletion.status === 403);
const tables = await fetch(`${url}/rest/v1/videvas_workspaces?select=owner_id`, { headers, signal: AbortSignal.timeout(15000) });
assert.ok(tables.status === 401 || tables.status === 403, 'Private shop documents must reject anonymous reads');
console.log('Correct Supabase project: public key accepted, email auth enabled, workspace RPCs installed, anonymous reads and deletion requests denied.');
