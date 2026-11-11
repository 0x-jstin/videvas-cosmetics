import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
let configError = '';
try {
  if (!url || !key || key.startsWith('sb_secret_')) throw new Error();
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
  if (!key.startsWith('sb_publishable_')) {
    const claims = JSON.parse(atob(key.split('.')[1]));
    if (claims.role !== 'anon') throw new Error();
  }
} catch { configError = 'The cloud connection is not configured. Add the Supabase project URL and public publishable key, then rebuild the site.'; }

export { configError };
export const supabaseConfig = { url: url?.replace(/\/$/, ''), key };
export const supabase = configError ? null : createClient(supabaseConfig.url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
});
