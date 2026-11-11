import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { validateState } from '../src/model.js';

// Browser tests use the real SDK and migration with an isolated PostgreSQL
// database. Only Auth/email delivery and the Realtime wire are simulated.
export class MockSupabase {
  users = new Map(); tokens = new Map(); refreshTokens = new Map(); codes = new Map();
  events = new Set(); saveCalls = []; queue = Promise.resolve();
  beforeNextSave = null; dropReply = false; holds = [];

  static async create() {
    const backend = new MockSupabase();
    backend.db = new PGlite();
    await backend.db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
    `);
    await backend.db.exec(await readFile(new URL('../supabase/migrations/001_cloud_workspaces.sql', import.meta.url), 'utf8'));
    return backend;
  }
  serial(callback) {
    const result = this.queue.then(callback);
    this.queue = result.catch(() => {});
    return result;
  }
  asUser(ownerId, callback) {
    return this.serial(async () => {
      await this.db.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
      await this.db.exec('set role authenticated');
      try { return await callback(); }
      finally { await this.db.exec('reset role'); }
    });
  }
  async addUser(email, password, confirmed = true) {
    const user = { id: randomUUID(), email: email.toLowerCase(), password, confirmed, created_at: new Date().toISOString() };
    this.users.set(user.email, user);
    await this.serial(() => this.db.query('insert into auth.users(id) values ($1::uuid)', [user.id]));
    return user;
  }
  publicUser(user) {
    return { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: user.created_at, updated_at: new Date().toISOString(), identities: [], ...(user.confirmed ? { email_confirmed_at: user.created_at } : {}) };
  }
  session(user) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const access_token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, exp, iat: exp - 3600, session_id: randomUUID() })}.dGVzdA`;
    const refresh_token = randomUUID();
    this.tokens.set(access_token, user); this.refreshTokens.set(refresh_token, user);
    return { access_token, refresh_token, expires_in: 3600, expires_at: exp, token_type: 'bearer', user: this.publicUser(user) };
  }
  async workspace(ownerId) {
    return this.asUser(ownerId, () => this.db.query('select public.videvas_load_workspace() as value').then(result => result.rows[0].value));
  }
  async saveAs(ownerId, transform, mode = 'save') {
    const prior = await this.workspace(ownerId);
    const result = await this.commit(ownerId, { p_state: validateState(transform(structuredClone(prior.state))), p_expected_revision: prior.revision, p_request_id: randomUUID(), p_mode: mode });
    this.broadcast(result);
    return result;
  }
  commit(ownerId, args) {
    return this.asUser(ownerId, () => this.db.query('select public.videvas_save_workspace($1::jsonb,$2::bigint,$3::uuid,$4::text) as value',
      [JSON.stringify(args.p_state), args.p_expected_revision, args.p_request_id, args.p_mode || 'save']).then(result => result.rows[0].value));
  }
  broadcast(document) {
    const message = `data: ${JSON.stringify({ owner_id: document.owner_id, revision: document.revision, updated_at: document.updated_at })}\n\n`;
    for (const response of this.events) response.write(message);
  }
  holdNextSave() {
    let release, started;
    const wait = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { started = resolve; });
    this.beforeNextSave = async () => { started(); await wait; };
    this.holds.push(release);
    return { release, arrived };
  }
  dropNextReply() { this.dropReply = true; }
  recoveryLink() {
    if (!this.lastRecovery) throw new Error('No password recovery was requested.');
    const code = randomUUID(), { user, challenge, redirectTo } = this.lastRecovery;
    this.codes.set(code, { user, challenge });
    const link = new URL(redirectTo); link.searchParams.set('code', code);
    return link.href;
  }
  async handle(request, response, location) {
    const path = location.pathname.replace(/^\/__mock/, '');
    if (path === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.write(': connected\n\n');
      this.events.add(response); request.on('close', () => this.events.delete(response));
      return;
    }
    const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    const fail = (message, status = 400, code = 'invalid_request') => json({ code, error_code: code, msg: message, message }, status);
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const user = this.tokens.get(token);
    let text = '';
    for await (const part of request) text += part.toString();
    const args = text ? JSON.parse(text) : {};
    if (path === '/auth/v1/signup') {
      const email = args.email.toLowerCase();
      if (this.users.has(email)) return fail('User already registered.', 422, 'user_already_exists');
      const registered = await this.addUser(email, args.password, false);
      this.lastSignup = registered;
      return json(this.publicUser(registered));
    }
    if (path === '/auth/v1/token') {
      const grant = location.searchParams.get('grant_type');
      if (grant === 'password') {
        const signedIn = this.users.get(args.email.toLowerCase());
        if (!signedIn || signedIn.password !== args.password) return fail('Invalid login credentials', 400, 'invalid_credentials');
        if (!signedIn.confirmed) return fail('Email not confirmed', 400, 'email_not_confirmed');
        return json(this.session(signedIn));
      }
      if (grant === 'refresh_token') {
        const refreshed = this.refreshTokens.get(args.refresh_token);
        if (!refreshed) return fail('Refresh token not found.', 400, 'refresh_token_not_found');
        return json(this.session(refreshed));
      }
      if (grant === 'pkce') {
        const code = this.codes.get(args.auth_code);
        const challenge = createHash('sha256').update(args.code_verifier || '').digest('base64url');
        if (!code || challenge !== code.challenge) return fail('Reset link is invalid or expired.', 400, 'bad_code_verifier');
        this.codes.delete(args.auth_code);
        return json(this.session(code.user));
      }
    }
    if (path === '/auth/v1/recover') {
      const account = this.users.get(args.email.toLowerCase());
      if (account) this.lastRecovery = { user: account, challenge: args.code_challenge, redirectTo: location.searchParams.get('redirect_to') };
      return json({});
    }
    if (path === '/auth/v1/logout') {
      this.tokens.delete(token);
      return json({});
    }
    if (path === '/auth/v1/user') {
      if (!user) return fail('Session is not valid.', 401, 'bad_jwt');
      if (request.method === 'PUT') user.password = args.password;
      return json(this.publicUser(user));
    }
    if (path.startsWith('/rest/v1/rpc/')) {
      if (!user) return fail('Sign in to open your shop.', 401, '42501');
      try {
        if (path.endsWith('/videvas_load_workspace')) return json(await this.workspace(user.id));
        if (path.endsWith('/videvas_save_workspace')) {
          this.saveCalls.push({ ownerId: user.id, ...structuredClone(args) });
          const before = this.beforeNextSave; this.beforeNextSave = null;
          if (before) await before();
          const result = await this.commit(user.id, args);
          this.broadcast(result);
          // Chrome can transparently retry a POST after a socket closes.
          // Drop the acknowledgement at the fetch boundary instead, after
          // the SQL commit, to exercise an explicitly uncertain response.
          if (this.dropReply) {
            this.dropReply = false;
            response.writeHead(200, { 'Content-Type': 'application/json', 'X-Videvas-Test-Drop': '1' });
            response.end(JSON.stringify(result)); return;
          }
          return json(result);
        }
      } catch (error) { return fail(error.message, error.code === 'PT409' ? 409 : 400, error.code); }
    }
    return fail(`Unexpected test API request: ${path}`, 404);
  }
  async close() { this.holds.forEach(release => release()); for (const event of this.events) event.end(); await this.queue; await this.db.close(); }
}

export function mockBrowserScript() {
  return `(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const address = typeof input === 'string' ? input : input.url || String(input);
      if (address.startsWith('https://tmixrlodofdycichecyj.supabase.co/')) {
        const url = new URL(address);
        return originalFetch('/__mock' + url.pathname + url.search, options).then(response => {
          if (response.headers.get('X-Videvas-Test-Drop') === '1') throw new TypeError('Simulated lost acknowledgement');
          return response;
        });
      }
      return originalFetch(input, options);
    };
    const OriginalWebSocket = window.WebSocket;
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(address, protocols) {
        super();
        if (!String(address).includes('tmixrlodofdycichecyj.supabase.co')) return new OriginalWebSocket(address, protocols);
        this.url = String(address); this.readyState = 0; this.bufferedAmount = 0; this.protocol = ''; this.extensions = ''; this.binaryType = 'arraybuffer';
        this.channels = new Map();
        this.events = new EventSource('/__mock/events');
        this.events.onmessage = event => {
          if (window.__videvasTestPauseRealtime) return;
          const record = JSON.parse(event.data);
          for (const [topic, channel] of this.channels) {
            const bindings = channel.bindings.filter(binding => binding.filter === 'owner_id=eq.' + record.owner_id && channel.owner === record.owner_id);
            if (!bindings.length) continue;
            this.message({ topic, event: 'postgres_changes', payload: { ids: bindings.map(binding => binding.id), data: { schema: 'public', table: 'videvas_workspace_changes', commit_timestamp: record.updated_at, type: 'UPDATE', record, old_record: {}, columns: [{ name: 'owner_id', type: 'uuid' }, { name: 'revision', type: 'int8' }, { name: 'updated_at', type: 'timestamptz' }], errors: [] } }, ref: null, join_ref: channel.joinRef }, channel.array);
          }
        };
        setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; this.emit('open', new Event('open')); }, 5);
      }
      emit(name, event) { this.dispatchEvent(event); this['on' + name]?.(event); }
      message(message, array) {
        const data = JSON.stringify(array ? [message.join_ref || null, message.ref || null, message.topic, message.event, message.payload] : message);
        this.emit('message', new MessageEvent('message', { data }));
      }
      send(raw) {
        const decoded = JSON.parse(raw), array = Array.isArray(decoded);
        const message = array ? { join_ref: decoded[0], ref: decoded[1], topic: decoded[2], event: decoded[3], payload: decoded[4] } : decoded;
        let response = {};
        if (message.event === 'phx_join') {
          const bindings = (message.payload.config?.postgres_changes || []).map((binding, index) => ({ ...binding, id: index + 1 }));
          let owner;
          try { owner = JSON.parse(atob(message.payload.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch {}
          this.channels.set(message.topic, { bindings, owner, array, joinRef: message.ref });
          response = { postgres_changes: bindings };
        }
        if (message.event === 'phx_leave') this.channels.delete(message.topic);
        if (message.event !== 'access_token') setTimeout(() => this.message({ ...message, event: 'phx_reply', payload: { status: 'ok', response } }, array), 5);
      }
      close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.events.close(); this.channels.clear(); this.emit('close', new CloseEvent('close', { code, reason, wasClean: true })); }
    }
    window.WebSocket = MockWebSocket;
  })();`;
}
