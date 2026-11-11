import React, { useEffect, useState } from 'react';
import { Users, UserRoundCheck, ShoppingBag, UserRoundPlus, Search, Plus, ArrowUpRight, ChevronLeft, ChevronRight, Phone, Mail, MapPin, NotebookPen, Archive, RotateCcw } from 'lucide-react';
import { Badge, Empty, Field, Select } from './components.jsx';
import { useAsyncAction } from './useAsyncAction.js';
import { customerMetrics, today } from './model.js';

export function CustomerAvatar({ customer, large = false }) {
  const initials = customer.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
  const tone = [...customer.name].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 4;
  return <span className={`customer-avatar tone-${tone} ${large ? 'large' : ''}`} aria-hidden="true">{initials}</span>;
}

export function CustomerForm({ customer, onSubmit, onClose, savingBlocked = false }) {
  const { error, busy, run } = useAsyncAction();
  const submit = e => {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    if (savingBlocked) return;
    void run(() => onSubmit(fields));
  };
  return <form onSubmit={submit} aria-busy={busy}><fieldset className="form-fields" disabled={busy || savingBlocked}>
    <div className="modal-body">
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-grid">
        <Field label="Full name" className="span-2"><input name="name" defaultValue={customer?.name || ''} placeholder="Your customer's name" required maxLength={100} /></Field>
        <Field label="Phone number"><input name="phone" type="tel" defaultValue={customer?.phone || ''} placeholder="Include the country code" maxLength={40} /></Field>
        <Field label="Email address"><input name="email" type="email" defaultValue={customer?.email || ''} placeholder="Optional" maxLength={254} /></Field>
        <Field label="Address" className="span-2"><textarea name="address" defaultValue={customer?.address || ''} placeholder="Optional" maxLength={300} rows={2} /></Field>
        <Field label="Notes & preferences" className="span-2" hint="Keep useful details such as favorite products or fragrance preferences."><textarea name="notes" defaultValue={customer?.notes || ''} placeholder="A few little details to remember…" maxLength={1000} rows={3} /></Field>
      </div>
    </div>
    </fieldset><footer className="modal-footer"><button className="button secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" type="submit" disabled={busy || savingBlocked}>{busy ? 'Saving…' : customer ? 'Save changes' : 'Add customer'}<ArrowUpRight size={16} /></button></footer>
  </form>;
}

export function CustomersPage({ state, money, search, onSearch, onAdd, onCustomer, dateLabel, StatCard }) {
  const [status, setStatus] = useState('Active');
  const [sort, setSort] = useState('Name');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [search, status, sort]);
  const entries = state.customers.map(customer => ({ customer, summary: customerMetrics(state, customer.id) }));
  const active = entries.filter(e => !e.customer.archived).length;
  const returning = entries.filter(e => e.summary.sales >= 2).length;
  const revenue = entries.reduce((sum, e) => sum + e.summary.netSpent, 0);
  const newThisMonth = entries.filter(e => e.customer.createdAt >= `${today().slice(0, 7)}-01`).length;
  const query = search.toLowerCase().trim();
  const filtered = entries.filter(({ customer: c }) => (status === 'All' || (status === 'Archived' ? c.archived : !c.archived)) && `${c.name} ${c.phone} ${c.email} ${c.address} ${c.notes}`.toLowerCase().includes(query));
  filtered.sort((a, b) => sort === 'Net spend' ? b.summary.netSpent - a.summary.netSpent || a.customer.name.localeCompare(b.customer.name) : sort === 'Last purchase' ? b.summary.lastPurchase.localeCompare(a.summary.lastPurchase) || a.customer.name.localeCompare(b.customer.name) : a.customer.name.localeCompare(b.customer.name));
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const current = Math.min(page, pages);
  return <>
    <div className="stats-grid">
      <StatCard label="Customer profiles" value={entries.length} icon={Users} note={`${active} active · ${entries.length - active} archived`} tone="green" />
      <StatCard label="Returning customers" value={returning} icon={UserRoundCheck} note="Two or more recorded purchases" />
      <StatCard label="Customer sales" value={money(revenue)} icon={ShoppingBag} note="All-time linked sales, less refunds" />
      <StatCard label="New this month" value={newThisMonth} icon={UserRoundPlus} note="A few new faces in your shop" />
    </div>
    <div className="customer-welcome"><div className="customer-welcome-art" aria-hidden="true"><span>♡</span><Users size={30} strokeWidth={1.2} /></div><div><h2>A familiar face, every visit.</h2><p>Keep the little details that make your customers feel remembered.</p></div><span className="customer-welcome-label">GOOD PEOPLE. BEAUTIFUL CONNECTIONS.</span></div>
    <section className="card customers-card">
      <div className="table-toolbar">
        <div className="tabs" role="group" aria-label="Customer status">{['Active', 'Archived', 'All'].map(value => <button className={status === value ? 'active' : ''} key={value} onClick={() => setStatus(value)}>{value === 'All' ? 'All customers' : value}{value === 'Active' && <span>{active}</span>}</button>)}</div>
        <div className="table-tools"><div className="table-search"><Search size={16} /><input value={search} onChange={e => onSearch(e.target.value)} placeholder="Search name, phone, email…" aria-label="Search customers" /></div><Select value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort customers"><option value="Name">Name A–Z</option><option value="Net spend">Highest spend</option><option value="Last purchase">Latest purchase</option></Select></div>
      </div>
      {!filtered.length ? <Empty title={state.customers.length ? 'No customers in this view' : 'Your next familiar face'} description={state.customers.length ? 'Try a different search or customer status.' : 'Add your first customer, then link their sales to build a purchase history.'} action={!state.customers.length && <button className="button primary" onClick={onAdd}><Plus size={16} />Add customer</button>} /> : <>
        <div className="table-scroll"><table className="customer-table"><thead><tr><th>Customer</th><th>Contact details</th><th>Purchases</th><th>Net spend</th><th>Last purchase</th><th>Status</th><th><span className="visually-hidden">Details</span></th></tr></thead><tbody>{filtered.slice((current - 1) * 8, current * 8).map(({ customer: c, summary }) => <tr key={c.id}>
          <td><button className="customer-cell" onClick={() => onCustomer(c)}><CustomerAvatar customer={c} /><span><strong>{c.name}</strong><small>Added {dateLabel(c.createdAt)}</small></span></button></td>
          <td><span className="customer-contact">{c.phone || (c.email ? 'Email contact' : 'No contact details')}<small>{c.email || (c.phone ? 'No email added' : 'Edit profile to add details')}</small></span></td>
          <td><strong className="stock-number">{summary.sales}</strong></td>
          <td className="amount">{money(summary.netSpent)}</td>
          <td className="customer-last-visit">{summary.lastPurchase ? dateLabel(summary.lastPurchase) : 'No purchases yet'}</td>
          <td><Badge tone={c.archived ? 'neutral' : 'green'}>{c.archived ? 'Archived' : 'Active'}</Badge></td>
          <td><button className="icon-button" onClick={() => onCustomer(c)} aria-label={`View customer ${c.name}`}><ArrowUpRight size={17} /></button></td>
        </tr>)}</tbody></table></div>
        <div className="pagination"><span>{(current - 1) * 8 + 1}–{Math.min(current * 8, filtered.length)} of {filtered.length} customers</span><div><button className="icon-button" onClick={() => setPage(current - 1)} disabled={current === 1} aria-label="Previous customer page"><ChevronLeft size={17} /></button><span>{current} <small>/ {pages}</small></span><button className="icon-button" onClick={() => setPage(current + 1)} disabled={current === pages} aria-label="Next customer page"><ChevronRight size={17} /></button></div></div>
      </>}
    </section>
    <p className="page-footnote"><UserRoundCheck size={14} />Customer totals cover all recorded purchases and refunds. Walk-in sales are kept in Sales.</p>
  </>;
}

export function CustomerDetail({ customer, state, money, dateLabel, onEdit, onSale, onArchive, onTransaction, TransactionTable }) {
  const summary = customerMetrics(state, customer.id);
  const history = summary.history.slice().sort((a, b) => b.date.localeCompare(a.date) || b.reference.localeCompare(a.reference, 'en', { numeric: true }));
  const [historyPage, setHistoryPage] = useState(1);
  const pages = Math.max(1, Math.ceil(history.length / 6));
  const current = Math.min(historyPage, pages);
  return <div className="modal-body customer-detail">
    <div className="customer-detail-hero"><CustomerAvatar customer={customer} large /><div><span className="eyebrow">A FACE TO REMEMBER</span><h3>{customer.name}</h3><p>Customer since {dateLabel(customer.createdAt, true)}</p><Badge tone={customer.archived ? 'neutral' : 'green'}>{customer.archived ? 'Archived' : 'Active customer'}</Badge></div></div>
    <div className="detail-metrics"><div><small>Purchases</small><strong>{summary.sales}</strong></div><div><small>Net spend</small><strong>{money(summary.netSpent)}</strong></div><div><small>Last purchase</small><strong className="last-purchase">{summary.lastPurchase ? dateLabel(summary.lastPurchase) : '—'}</strong></div></div>
    <div className="detail-actions"><button className="button primary" onClick={onSale} disabled={customer.archived}><ShoppingBag size={15} />Record sale</button><button className="button secondary" onClick={onEdit}>Edit customer</button><button className="button secondary" onClick={onArchive}>{customer.archived ? <RotateCcw size={15} /> : <Archive size={15} />}{customer.archived ? 'Restore customer' : 'Archive customer'}</button></div>
    <div className="customer-details-grid"><div><span><Phone size={14} />Phone number</span>{customer.phone ? <a href={`tel:${customer.phone.replace(/[^+\d]/g, '')}`}>{customer.phone}</a> : <p>No phone number added</p>}</div><div><span><Mail size={14} />Email address</span>{customer.email ? <a href={`mailto:${customer.email}`}>{customer.email}</a> : <p>No email address added</p>}</div>{customer.address && <div className="span-2"><span><MapPin size={14} />Address</span><p>{customer.address}</p></div>}</div>
    {customer.notes && <div className="customer-notes"><h4><NotebookPen size={15} />Little details to remember</h4><p>{customer.notes}</p></div>}
    <div className="customer-history-heading"><h4 className="section-label">Purchase history</h4><span>{history.length} {history.length === 1 ? 'entry' : 'entries'}</span></div>
    {history.length ? <><TransactionTable transactions={history.slice((current - 1) * 6, current * 6)} money={money} onClick={onTransaction} compact /><div className="pagination"><span>{(current - 1) * 6 + 1}–{Math.min(current * 6, history.length)} of {history.length} entries</span><div><button className="icon-button" onClick={() => setHistoryPage(current - 1)} disabled={current === 1} aria-label="Previous history page"><ChevronLeft size={16} /></button><span>{current} <small>/ {pages}</small></span><button className="icon-button" onClick={() => setHistoryPage(current + 1)} disabled={current === pages} aria-label="Next history page"><ChevronRight size={16} /></button></div></div><p className="customer-history-note">Net spend includes discounts and deducts refunds. Original sale details stay in your records.</p></> : <Empty title="Their story starts with a sale" description="Select this customer when recording a sale to build their history." />}
  </div>;
}
