import { useCallback, useEffect, useRef, useState } from 'react';

export function useAsyncAction() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = useCallback(async action => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError('');
    try { return await action(); }
    catch (failure) { if (mounted.current) setError(failure.message || 'This action could not be completed. Please try again.'); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }, []);
  return { error, setError, busy, run };
}
