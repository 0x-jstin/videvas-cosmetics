import React, { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { supabase, supabaseConfig, configError } from './supabase.js';
import { createCloudTransport, createWorkspaceStore } from './cloud.js';
import { AccountForm, RecoveryForm, WorkspaceLoading } from './auth.jsx';

const Shop = lazy(() => import('./App.jsx'));

export default function CloudApp() {
  const [transport] = useState(() => supabase ? createCloudTransport(supabase, supabaseConfig) : {});
  const [store] = useState(() => createWorkspaceStore(transport));
  const cloud = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const sessionRef = useRef(session); sessionRef.current = session;

  useEffect(() => {
    if (!supabase) return;
    let mounted = true, authVersion = 0;
    const apply = (event, nextSession) => {
      if (!mounted) return;
      const ownerId = nextSession?.user.id ?? null;
      if (store.getSnapshot().ownerId !== ownerId || event === 'PASSWORD_RECOVERY') store.setOwner(null);
      sessionRef.current = nextSession;
      setSession(nextSession); setAuthLoading(false); setAuthError('');
      const recoveryLink = new URL(window.location.href).searchParams.get('recovery') === '1';
      if (event === 'PASSWORD_RECOVERY' || (nextSession && recoveryLink)) setRecovery(true);
      else if (!nextSession) setRecovery(false);
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      authVersion++;
      apply(event, nextSession);
    });
    const captured = authVersion;
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted || captured !== authVersion) return;
      if (error) { setAuthError(error.message); setAuthLoading(false); }
      else apply('INITIAL_SESSION', data.session);
    }).catch(error => { if (mounted && captured === authVersion) { setAuthError(error.message); setAuthLoading(false); } });
    return () => { mounted = false; subscription.unsubscribe(); store.setOwner(null); };
  }, [store]);

  const ownerId = session?.user.id;
  useEffect(() => {
    if (!ownerId || recovery || signingOut) { store.setOwner(null); return; }
    // Auth callbacks only clear state; loading runs outside the SDK's auth lock.
    void store.setOwner(ownerId);
    const refresh = () => { if (document.visibilityState === 'visible') void store.refresh().catch(() => {}); };
    const online = () => store.setOnline(true), offline = () => store.setOnline(false);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    const timer = setInterval(refresh, 45000);
    return () => {
      clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', online); window.removeEventListener('offline', offline);
      store.setOwner(null);
    };
  }, [ownerId, recovery, signingOut, store]);

  async function signOut() {
    if (store.getSnapshot().pending || store.getSnapshot().writing || signingOut) return;
    const departingId = sessionRef.current?.user.id;
    setSigningOut(true); store.setOwner(null);
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
      if (!sessionRef.current || sessionRef.current.user.id === departingId) {
        sessionRef.current = null; setSession(null); setRecovery(false);
      }
      const location = new URL(window.location.href);
      if (location.searchParams.has('recovery')) window.history.replaceState({}, '', '/');
    } catch (error) { setAuthError(`Could not sign out: ${error.message}`); }
    finally { setSigningOut(false); }
  }

  if (configError) return <WorkspaceLoading error={configError} />;
  if (authLoading || signingOut) return <WorkspaceLoading heading={signingOut ? 'Signing out…' : 'Opening your shop…'} />;
  if (authError) return <WorkspaceLoading error={authError} onRetry={() => window.location.reload()} onSignOut={session ? signOut : undefined} />;
  if (!session) return <AccountForm client={supabase} />;
  if (recovery) return <RecoveryForm updatePassword={transport.updatePassword} accountId={ownerId} onSignOut={signOut} onComplete={completedId => {
    if (sessionRef.current?.user.id !== completedId) return;
    window.history.replaceState({}, '', '/'); setRecovery(false);
  }} />;
  if (cloud.ownerId !== ownerId || !cloud.state) return <WorkspaceLoading error={cloud.error} onRetry={() => store.refresh()} onSignOut={signOut} />;
  return <Suspense fallback={<WorkspaceLoading />}><Shop key={ownerId} cloud={cloud} store={store} email={session.user.email} onSignOut={signOut} /></Suspense>;
}
