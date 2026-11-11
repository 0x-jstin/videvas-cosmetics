import React, { useRef, useState } from 'react';
import { Check, Cloud, Download, LogOut, RotateCcw, ShieldCheck, Sprout, Trash2, Upload } from 'lucide-react';
import { Field, Select } from './components.jsx';
import { validateState } from './model.js';
import { activateDemo, hasWorkspaceRecords } from './workspace.js';
import { useAsyncAction } from './useAsyncAction.js';

export function ConfirmAction({ description, action, onConfirm, onClose, danger, requireText, blocked = false }) {
  const [text, setText] = useState('');
  const { error, busy, run } = useAsyncAction();
  const submit = event => {
    event.preventDefault();
    if (blocked) return;
    void run(async () => {
      if (requireText && text !== requireText) throw new Error(`Type ${requireText} to confirm.`);
      await onConfirm();
    });
  };
  return <form onSubmit={submit} aria-busy={busy}><fieldset className="form-fields" disabled={busy || blocked}>
    <div className="modal-body"><div className={`confirmation-icon ${danger ? 'danger' : ''}`}>{danger ? <Trash2 size={25} /> : <RotateCcw size={25} />}</div><p className="confirmation-copy">{description}</p>
      {requireText && <Field label={`Type ${requireText} to confirm`}><input value={text} onChange={event => setText(event.target.value)} autoComplete="off" /></Field>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div></fieldset>
    <div className="modal-footer"><button className="button secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className={`button ${danger ? 'danger' : 'primary'}`} disabled={busy || blocked || (requireText && text !== requireText)}>{busy ? 'Saving…' : action}</button></div>
  </form>;
}

function Heading({ title, subtitle }) {
  return <div className="card-heading"><div><h2>{title}</h2><p>{subtitle}</p></div></div>;
}
const CURRENCIES = { XOF: 'West African CFA Franc', USD: 'US Dollar', GHS: 'Ghanaian Cedi', NGN: 'Nigerian Naira', GMD: 'Gambian Dalasi', GBP: 'British Pound', EUR: 'Euro', KES: 'Kenyan Shilling', ZAR: 'South African Rand', CAD: 'Canadian Dollar', AUD: 'Australian Dollar', INR: 'Indian Rupee' };

export function SettingsPage({ state, commit, backup, onReset, blocked, legacy, onImport, email, onSignOut, signOutBlocked }) {
  const { error, setError, busy, run } = useAsyncAction();
  const [pendingRestore, setPendingRestore] = useState(null);
  const [restoreText, setRestoreText] = useState('');
  const fileRef = useRef(null);
  const disabled = busy || blocked;
  const save = event => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if (disabled) return;
    void run(() => commit(current => {
      const currency = fields.currency ?? current.settings.currency;
      if (current.transactions.length && currency !== current.settings.currency) throw new Error('Start a fresh workspace before changing currency. Existing amounts cannot be converted automatically.');
      return validateState({ ...current, settings: { storeName: fields.storeName.trim(), currency } });
    }, 'Shop settings saved'));
  };
  const readBackup = async event => {
    const input = event.target, file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      if (file.size > 20_000_000) throw new Error('Choose a backup smaller than 20 MB.');
      const parsed = validateState(JSON.parse(await file.text()));
      setPendingRestore(parsed.demo ? { ...parsed, demoExplicit: true } : parsed);
      setRestoreText(''); setError('');
    } catch (error) { setError(`Backup could not be read: ${error.message}`); }
  };
  const restore = () => void run(async () => {
    if (restoreText !== 'RESTORE' || !pendingRestore || blocked) throw new Error('Type RESTORE to confirm the replacement.');
    await commit(() => pendingRestore, 'Backup restored', 'replace');
    setPendingRestore(null);
  });

  return <div className="settings-layout">
    <section className="card"><Heading title="Your shop" subtitle="The details that make this space yours." />
      <form onSubmit={save} className="settings-form" aria-busy={busy}><fieldset disabled={disabled} className="form-fields">
        <Field label="Shop name"><input name="storeName" defaultValue={state.settings.storeName} required maxLength={80} /></Field>
        <Field label="Currency" hint={state.transactions.length ? 'Currency is locked while transactions exist. Start fresh to change it.' : 'All prices and amounts use this currency; values are not converted.'}>
          <Select name="currency" defaultValue={state.settings.currency} disabled={state.transactions.length > 0}>{Object.entries(CURRENCIES).map(([currency, label]) => <option key={currency} value={currency}>{currency} — {label}</option>)}</Select>
        </Field>
        <div className="settings-submit"><button className="button primary">{busy ? 'Saving…' : 'Save settings'}<Check size={16} /></button></div>
      </fieldset></form>
    </section>
    <section className="card storage-card"><Heading title="A home for your data" subtitle="Your shop, ready wherever you are." />
      <div className="storage-illustration"><Cloud size={36} strokeWidth={1.2} /><span><strong>Saved in your private account</strong><small className="account-email">{email}</small></span></div>
      <p>Products, customers, sales, and ledger entries are saved together. Sign in with this account on another device to open the same shop. Other accounts have their own private workspaces.</p>
      <div className="storage-info"><ShieldCheck size={16} />Keep downloading backups for a separate copy of your records.</div>
      <div className="account-actions"><button className="button secondary" disabled={signOutBlocked} onClick={onSignOut}><LogOut size={16} />Sign out</button></div>
    </section>
    {(legacy.state || legacy.error) && <section className="card legacy-card"><h2>Bring your browser records with you</h2>
      <p>{legacy.error || (hasWorkspaceRecords(legacy.state) ? `This browser has ${legacy.state.products.length} products, ${legacy.state.customers.length} customers, and ${legacy.state.transactions.length} transactions from the earlier version. Import them into this account when its workspace is empty. Your original browser copy will be kept.` : 'The earlier browser workspace has no shop records to import.')}</p>
      <button className="button secondary" disabled={disabled || !legacy.state || !hasWorkspaceRecords(legacy.state) || hasWorkspaceRecords(state)} onClick={onImport}><Upload size={16} />Import browser records</button>
    </section>}
    <section className="card backup-card"><Heading title="Keep a copy. Keep your peace of mind." subtitle="A JSON backup includes customers, products, batches, sales, expenses, and stock history." />
      <div className="backup-actions"><button className="button secondary" onClick={backup}><Download size={17} />Download backup</button><button className="button secondary" disabled={disabled} onClick={() => fileRef.current.click()}><Upload size={17} />Restore backup</button><input ref={fileRef} className="visually-hidden" type="file" accept=".json,application/json" onChange={readBackup} aria-label="Choose a Videvas backup" /></div>
      {pendingRestore && <div className="restore-confirm"><h3>Ready to restore {pendingRestore.settings.storeName}</h3><p>{pendingRestore.customers.length} customers · {pendingRestore.products.length} products · {pendingRestore.transactions.length} transactions. This replaces the current workspace in your account on all devices. Download a current backup first if you need to keep it.</p>
        <Field label="Type RESTORE to replace this workspace"><input value={restoreText} onChange={event => setRestoreText(event.target.value)} disabled={disabled} /></Field>
        <div><button className="button primary" disabled={disabled || restoreText !== 'RESTORE'} onClick={restore}>{busy ? 'Saving…' : 'Restore workspace'}</button><button className="button secondary" disabled={busy} onClick={() => setPendingRestore(null)}>Cancel</button></div>
      </div>}
    </section>
    <section className="card demo-settings-card"><div><h2>Explore with sample data</h2><p>{state.demo ? 'Demo data is loaded. Use Start fresh below when you are ready for your own records.' : hasWorkspaceRecords(state) ? 'Start fresh before loading sample data into this workspace.' : 'Try sample products, customers, sales, and expenses whenever you like.'}</p></div>
      <button className="button secondary" disabled={state.demo || hasWorkspaceRecords(state) || disabled} onClick={() => void run(() => commit(activateDemo, 'Demo data loaded', 'import'))}><Sprout size={16} />{state.demo ? 'Demo data loaded' : 'Load demo data'}</button>
    </section>
    <section className="card reset-card"><div><h2>{state.demo ? 'Ready to make it yours?' : 'Start a fresh workspace'}</h2><p>{state.demo ? 'Clear the sample products and entries, then add your own shelf.' : 'Replace the inventory and ledger in your account with a blank workspace.'}</p></div><button className="button secondary" disabled={disabled} onClick={onReset}><RotateCcw size={16} />Start fresh</button></section>
    {error && <p className="form-error settings-error" role="alert">{error}</p>}
  </div>;
}
