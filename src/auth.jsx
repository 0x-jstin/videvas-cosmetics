import React, { useState } from 'react';
import { ArrowRight, Leaf, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { Field } from './components.jsx';
import { useAsyncAction } from './useAsyncAction.js';

export function AuthFrame({ children }) {
  return <div className="auth-shell">
    <section className="auth-story">
      <a className="brand" href="/" aria-label="Videvas home"><span className="brand-symbol"><Leaf size={27} strokeWidth={1.3} /></span><div>videvas<span>BEAUTY & BUSINESS</span></div></a>
      <div className="auth-story-copy"><div className="eyebrow">A LITTLE CLARITY, EVERY DAY</div><h1>Good things<br />are growing.</h1><p>Your shelf, your sales, and the people who keep coming back. Give your beauty business a place to bloom.</p><div className="auth-promise"><ShieldCheck size={18} /><span>Private to your account.<br />Ready on your other devices.</span></div></div>
      <div className="auth-botanical" aria-hidden="true"><Leaf size={185} strokeWidth={0.45} /><span /><span /></div>
      <p className="auth-story-footer">A little organization. A lot of room to grow.</p>
    </section>
    <main className="auth-main">{children}<p className="auth-footnote"><Leaf size={13} />A little clarity. A beautiful business.</p></main>
  </div>;
}

export function AccountForm({ client }) {
  const [mode, setMode] = useState('login');
  const [message, setMessage] = useState('');
  const { error, setError, busy, run } = useAsyncAction();
  const changeMode = next => { setMode(next); setMessage(''); setError(''); };
  const submit = event => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    void run(async () => {
      const email = fields.email.trim();
      if (mode === 'reset') {
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/?recovery=1` });
        if (error) throw error;
        setMessage('If this email has an account, a password reset link is on its way. Check your inbox.');
      } else if (mode === 'signup') {
        if (fields.password !== fields.confirmPassword) throw new Error('Your passwords do not match.');
        const { data, error } = await client.auth.signUp({ email, password: fields.password, options: { emailRedirectTo: `${window.location.origin}/` } });
        if (error) throw error;
        if (!data.session) setMessage('Check your email to confirm your account, then sign in here.');
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password: fields.password });
        if (error) throw error;
      }
    });
  };
  const title = { login: 'Welcome back.', signup: 'A fresh start for your shop.', reset: 'Let’s get you back in.' }[mode];
  return <AuthFrame><section className="auth-card">
    <span className="auth-icon">{mode === 'reset' ? <Mail size={23} strokeWidth={1.4} /> : <LockKeyhole size={23} strokeWidth={1.4} />}</span>
    <div className="eyebrow">YOUR PRIVATE WORKSPACE</div><h2>{title}</h2>
    <p className="auth-intro">{mode === 'login' ? 'Sign in to open your shop and pick up where you left off.' : mode === 'signup' ? 'Create an account for your shop. Use this same login on your other devices.' : 'Enter your email and we’ll send a link to reset your password.'}</p>
    <form onSubmit={submit} key={mode} className="auth-form" aria-busy={busy}>
      <fieldset disabled={busy} className="form-fields">
        <Field label="Email address"><input name="email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} /></Field>
        {mode !== 'reset' && <Field label="Password"><input name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={mode === 'signup' ? 8 : undefined} maxLength={128} placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'} /></Field>}
        {mode === 'signup' && <Field label="Confirm password"><input name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} /></Field>}
      </fieldset>
      {mode === 'login' && <button type="button" className="text-button auth-forgot" disabled={busy} onClick={() => changeMode('reset')}>Forgot password?</button>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="auth-message" role="status">{message}</p>}
      <button type="submit" className="button primary auth-submit" disabled={busy}>{busy ? 'Please wait…' : { login: 'Sign in', signup: 'Create account', reset: 'Send reset link' }[mode]}<ArrowRight size={17} /></button>
    </form>
    <div className="auth-switch">{mode === 'login' ? <>New to Videvas? <button className="text-button" disabled={busy} onClick={() => changeMode('signup')}>Create an account</button></> : <button className="text-button" disabled={busy} onClick={() => changeMode('login')}>Back to sign in</button>}</div>
  </section></AuthFrame>;
}

export function RecoveryForm({ updatePassword, onComplete, onSignOut, accountId }) {
  const { error, busy, run } = useAsyncAction();
  const submit = event => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    void run(async () => {
      if (fields.password !== fields.confirmPassword) throw new Error('Your passwords do not match.');
      await updatePassword(accountId, fields.password);
      onComplete(accountId);
    });
  };
  return <AuthFrame><section className="auth-card"><span className="auth-icon"><LockKeyhole size={23} /></span><div className="eyebrow">A FRESH PASSWORD</div><h2>Make yourself at home.</h2><p className="auth-intro">Choose a new password to get back to your shop.</p>
    <form className="auth-form" onSubmit={submit} aria-busy={busy}><fieldset className="form-fields" disabled={busy}>
      <Field label="New password"><input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} /></Field>
      <Field label="Confirm new password"><input name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} /></Field>
    </fieldset>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary auth-submit" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}<ArrowRight size={16} /></button></form>
    <div className="auth-switch"><button className="text-button" disabled={busy} onClick={onSignOut}>Back to sign in</button></div>
  </section></AuthFrame>;
}

export function WorkspaceLoading({ error, onRetry, onSignOut, heading = 'Opening your shop…' }) {
  const { busy, run } = useAsyncAction();
  return <AuthFrame><section className="auth-card auth-loading"><span className="auth-icon"><Leaf size={28} strokeWidth={1.2} /></span><h2>{error ? 'Your workspace needs attention.' : heading}</h2><p className="auth-intro" role={error ? 'alert' : 'status'}>{error || 'A moment for everything to fall into place.'}</p>{error && onRetry && <button className="button primary" disabled={busy} onClick={() => void run(onRetry)}>{busy ? 'Checking…' : 'Try again'}</button>}{onSignOut && <button className="text-button" onClick={onSignOut}>Sign out</button>}</section></AuthFrame>;
}
