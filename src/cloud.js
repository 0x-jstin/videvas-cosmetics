import { validateState } from './model.js';

export class CloudError extends Error {
  constructor(message, code = 'CLOUD_ERROR', uncertain = false) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

// Authentication is captured for each request. A response or account switch
// can never cause one account's shop document to be written using another's JWT.
export function createCloudTransport(client, { url, key, fetcher = globalThis.fetch, timeoutMs = 15000 }) {
  async function request(name, ownerId, args = {}, options = {}) {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) throw new CloudError('Your session expired. Sign in again to continue.', 'AUTH_REQUIRED');
    if (data.session.user.id !== ownerId) throw new CloudError('The signed-in account changed. Open its workspace before saving.', 'AUTH_CHANGED');
    const token = data.session.access_token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${url}${options.path || `/rest/v1/rpc/${name}`}`, {
        method: options.method || 'POST', signal: controller.signal, credentials: 'omit', cache: 'no-store',
        headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      let body;
      try { body = await response.json(); }
      catch { throw new CloudError('The server response could not be confirmed. Please check the save again.', 'NETWORK', true); }
      if (!response.ok) {
        if (body.code === 'PGRST202' || body.code === '42P01') {
          throw new CloudError('The database setup is not finished. Run the Videvas setup SQL in Supabase, then try again.', 'SETUP_REQUIRED');
        }
        if (response.status === 401 || response.status === 403) {
          throw new CloudError('Your session could not be verified. Sign out and sign in again.', 'AUTH_REQUIRED');
        }
        throw new CloudError(body.message || 'The workspace could not be saved.', body.code || 'CLOUD_ERROR', response.status >= 500 || response.status === 429);
      }
      return body;
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError('The connection was interrupted. The save may have reached your account. Check the previous save before posting again.', 'NETWORK', true);
    } finally { clearTimeout(timer); }
  }
  return {
    load: ownerId => request('videvas_load_workspace', ownerId),
    save: (ownerId, operation) => request('videvas_save_workspace', ownerId, {
      p_state: operation.state, p_expected_revision: operation.expectedRevision,
      p_request_id: operation.requestId, p_mode: operation.mode,
    }),
    async updatePassword(ownerId, password) {
      let user;
      try { user = await request('', ownerId, { password }, { path: '/auth/v1/user', method: 'PUT' }); }
      catch (error) {
        if (error.uncertain) throw new CloudError('The connection was interrupted. Try saving your new password again.', 'NETWORK');
        throw error;
      }
      user = user.user || user;
      if (user.id !== ownerId) throw new CloudError('The password response could not be verified. Request a new reset link.', 'INVALID_RESPONSE');
    },
    watch(ownerId, onChange) {
      const channel = client.channel(`videvas:${ownerId}:${crypto.randomUUID()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'videvas_workspace_changes', filter: `owner_id=eq.${ownerId}` }, event => onChange(event.new.revision))
        .subscribe(status => { if (status === 'SUBSCRIBED') onChange(); });
      return () => { void client.removeChannel(channel).catch(() => {}); };
    },
  };
}

function checkWorkspace(document, ownerId) {
  if (!document || document.owner_id !== ownerId || !Number.isSafeInteger(document.revision) || document.revision < 0 || typeof document.updated_at !== 'string') {
    throw new CloudError('The account’s workspace response could not be verified. Try syncing again.', 'INVALID_RESPONSE', true);
  }
  let state;
  try { state = validateState(document.state); }
  catch { throw new CloudError('The saved records could not be validated. Try syncing again before continuing.', 'INVALID_RESPONSE', true); }
  return { state, revision: document.revision, updatedAt: document.updated_at };
}

const blank = () => ({ ownerId: null, state: null, revision: null, updatedAt: null, phase: 'signed-out', status: 'saved', error: '', pending: false, writing: false, needsRefresh: false });

// Only confirmed cloud snapshots enter the UI. There are no optimistic ledger
// entries or automatic local-storage writes. The same request ID is retained
// whenever a response is uncertain, so reconnecting cannot duplicate a payment.
export function createWorkspaceStore(transport, { isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
  let snapshot = blank(), generation = 0, operation = null, sending = false;
  let loading = null, unwatch = null, refreshRequested = false;
  const listeners = new Set();
  const publish = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
  const current = (ownerId, captured) => generation === captured && snapshot.ownerId === ownerId;
  const changed = () => new CloudError('The signed-in account changed. Your previous account’s records have been closed.', 'AUTH_CHANGED');
  const adopt = (document, ownerId) => {
    const confirmed = checkWorkspace(document, ownerId);
    if (snapshot.revision !== null && confirmed.revision < snapshot.revision) throw new CloudError('An older workspace response was received. Sync again.', 'INVALID_RESPONSE', true);
    publish({ ...confirmed, phase: 'ready', status: isOnline() ? 'saved' : 'offline', error: '', needsRefresh: false });
  };

  async function refresh() {
    if (!snapshot.ownerId) return;
    if (operation || sending) { refreshRequested = true; return; }
    if (loading) return loading;
    if (!isOnline()) {
      publish({ status: 'offline', error: 'You’re offline. Reconnect to sync and save.' });
      return;
    }
    const ownerId = snapshot.ownerId, captured = generation;
    publish({ status: 'syncing', error: '' });
    const task = (async () => {
      try {
        const document = await transport.load(ownerId);
        if (!current(ownerId, captured)) return;
        adopt(document, ownerId);
        if (!unwatch && transport.watch) unwatch = transport.watch(ownerId, revision => {
          if (current(ownerId, captured) && (revision === undefined || revision > snapshot.revision)) void refresh().catch(() => {});
        });
      } catch (error) {
        if (!current(ownerId, captured)) return;
        publish({ phase: snapshot.state ? 'ready' : 'error', status: 'error', error: error.message || 'Could not sync your records. Try again.', needsRefresh: true });
        throw error;
      } finally { if (current(ownerId, captured)) loading = null; }
    })();
    loading = task;
    return task;
  }

  function setOwner(ownerId) {
    if (ownerId === snapshot.ownerId) return loading;
    generation++;
    unwatch?.(); unwatch = null;
    operation = null; sending = false; loading = null; refreshRequested = false;
    snapshot = blank();
    publish({ ownerId, phase: ownerId ? 'loading' : 'signed-out' });
    if (ownerId) return refresh().catch(() => {});
  }

  async function sendOperation(pending) {
    const { ownerId, captured } = pending;
    sending = true;
    publish({ status: 'saving', writing: true, error: '' });
    try {
      const document = await transport.save(ownerId, pending);
      if (!current(ownerId, captured)) throw changed();
      if (document.request_revision !== pending.expectedRevision + 1 || document.revision < document.request_revision) {
        throw new CloudError('The save response could not be verified. Check the previous save again.', 'INVALID_RESPONSE', true);
      }
      adopt(document, ownerId);
      operation = null;
      publish({ pending: false });
      return document;
    } catch (error) {
      if (!current(ownerId, captured)) throw changed();
      if (error.uncertain || !(error instanceof CloudError)) {
        publish({ status: 'pending', pending: true, error: 'This save is not confirmed yet. Check the previous save before recording anything else.' });
        throw new CloudError(snapshot.error, 'SAVE_PENDING', true);
      }
      operation = null;
      publish({ pending: false });
      if (error.code === 'PT409') {
        try {
          const latest = await transport.load(ownerId);
          if (!current(ownerId, captured)) throw changed();
          adopt(latest, ownerId);
          publish({ error: 'Another device changed your shop. The latest records are shown. Review your draft before saving again.', status: 'error' });
        } catch (refreshError) {
          if (!current(ownerId, captured)) throw changed();
          publish({ status: 'error', error: 'Another device changed your shop. Sync the latest records before saving again.', needsRefresh: true });
        }
      } else publish({ status: 'error', error: error.message, needsRefresh: ['AUTH_REQUIRED', 'AUTH_CHANGED', 'SETUP_REQUIRED'].includes(error.code) });
      throw error;
    } finally {
      if (current(ownerId, captured)) {
        sending = false;
        publish({ writing: false });
        if (refreshRequested && !operation) { refreshRequested = false; void refresh().catch(() => {}); }
      }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setOwner, refresh,
    async save(transform, mode = 'save') {
      if (!snapshot.state || snapshot.phase !== 'ready') throw new CloudError('Wait for your workspace to load before saving.', 'NOT_READY');
      if (operation || sending) throw new CloudError('Check the previous save before recording another entry.', 'SAVE_PENDING');
      if (loading) throw new CloudError('Your records are syncing. Please wait a moment before saving.', 'SYNCING');
      if (snapshot.needsRefresh) throw new CloudError('Sync the latest records before saving again.', 'NEEDS_REFRESH');
      if (!isOnline()) throw new CloudError('You’re offline. Reconnect before saving. This entry has not been posted.', 'OFFLINE');
      if (!['save', 'import', 'replace'].includes(mode)) throw new CloudError('Choose a valid save operation.', 'INVALID_MODE');
      const next = validateState(transform(structuredClone(snapshot.state)));
      if (new TextEncoder().encode(JSON.stringify(next)).length > 20_000_000) throw new CloudError('Your workspace is larger than 20 MB. Export a backup before continuing.', 'TOO_LARGE');
      operation = { ownerId: snapshot.ownerId, captured: generation, requestId: crypto.randomUUID(), state: structuredClone(next), expectedRevision: snapshot.revision, mode };
      return sendOperation(operation);
    },
    async retryPending() {
      if (!operation) return refresh();
      if (sending) throw new CloudError('The previous save is already being checked.', 'SAVING');
      if (!isOnline()) throw new CloudError('Reconnect before checking the previous save.', 'OFFLINE');
      return sendOperation(operation);
    },
    setOnline(online) {
      if (!online) publish({ status: operation ? 'pending' : 'offline', error: operation ? 'This save needs confirmation when you reconnect.' : 'You’re offline. Reconnect to sync and save.' });
      else if (!operation) void refresh().catch(() => {});
    },
  };
}
