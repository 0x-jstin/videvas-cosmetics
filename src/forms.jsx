import React, { useState } from 'react';
import { Plus, Trash2, Info, ArrowRight } from 'lucide-react';
import { Field, Select, ProductArt, Badge, Empty } from './components.jsx';
import { useAsyncAction } from './useAsyncAction.js';
import { CATEGORIES, METHODS, EXPENSE_CATEGORIES, moneyInput, currencyDigits, today, stock, available, customerMetrics, refundCashAmount } from './model.js';

function FormFooter({ onClose, submit, disabled, busy, blocked }) { return <footer className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={disabled || busy || blocked}>{busy ? 'Saving…' : submit}<ArrowRight size={16} /></button></footer>; }
function ErrorMessage({ error }) { return error ? <p className="form-error" role="alert">{error}</p> : null; }
export function ProductForm({ product, onSubmit, onClose, currency = 'XOF', savingBlocked = false }) {
  const digits = currencyDigits(currency), step = digits === 0 ? '1' : '0.01';
  const { error, busy, run } = useAsyncAction();
  const submit = e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget));
    if (savingBlocked) return; void run(() => onSubmit({ ...f, price: moneyInput(f.price, currency), cost: moneyInput(f.cost, currency), quantity: Number(f.quantity || 0), reorder: Number(f.reorder) }));
  };
  return <form onSubmit={submit} aria-busy={busy}><fieldset className="form-fields" disabled={busy || savingBlocked}><div className="modal-body"><ErrorMessage error={error} /><div className="form-grid"><Field label="Product name" className="span-2"><input name="name" defaultValue={product?.name} placeholder="e.g. Niacinamide 10% Serum" required maxLength={120} /></Field><Field label="Brand"><input name="brand" defaultValue={product?.brand} placeholder="e.g. The Ordinary" maxLength={80} /></Field><Field label="SKU"><input name="sku" defaultValue={product?.sku} placeholder="e.g. VD-001" required maxLength={40} /></Field><Field label="Category"><Select name="category" defaultValue={product?.category || 'Skincare'}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select></Field><Field label="Supplier"><input name="supplier" defaultValue={product?.supplier} placeholder="Optional" maxLength={100} /></Field><Field label="Selling price"><input name="price" type="number" min={step} step={step} defaultValue={product ? (product.price / 100).toFixed(digits) : ''} placeholder={digits === 0 ? '0' : '0.00'} required /></Field><Field label="Unit cost" hint="Used as the default for future stock purchases."><input name="cost" type="number" min="0" step={step} defaultValue={product ? (product.cost / 100).toFixed(digits) : ''} placeholder={digits === 0 ? '0' : '0.00'} required /></Field>{!product && <><Field label="Opening stock" hint="Stock you already own; no cash entry is created."><input name="quantity" type="number" min="0" step="1" defaultValue="0" required /></Field><Field label="Batch code"><input name="batchCode" placeholder="Optional" maxLength={60} /></Field><Field label="Expiry date" hint="Leave blank for products without an expiry date."><input name="expiry" type="date" /></Field></>}<Field label="Low-stock threshold"><input name="reorder" type="number" min="0" step="1" defaultValue={product?.reorder ?? 5} required /></Field></div></div></fieldset><FormFooter busy={busy} blocked={savingBlocked} onClose={onClose} submit={product ? 'Save changes' : 'Add product'} /></form>;
}
export function SaleForm({ state, products, customers = [], initialCustomerId = '', money, onSubmit, onClose, currency = 'XOF', savingBlocked = false }) {
  const digits = currencyDigits(currency), step = digits === 0 ? '1' : '0.01';
  const sellable = products.filter(p => available(p) > 0);
  const [lines, setLines] = useState([{ productId: '', quantity: 1 }]);
  const [discount, setDiscount] = useState('');
  const [customerId, setCustomerId] = useState(initialCustomerId || '');
  const [paymentAmount, setPaymentAmount] = useState('');
  const { error, busy, run } = useAsyncAction();
  const subtotal = lines.reduce((sum, l) => sum + (products.find(p => p.id === l.productId)?.price || 0) * (Number(l.quantity) || 0), 0);
  const total = subtotal - Math.round((Number(discount) || 0) * 100);
  const balance = customerId ? customerMetrics(state, customerId).balance : 0;
  const received = Math.round((Number(paymentAmount) || 0) * 100);
  const update = (i, patch) => setLines(lines.map((l, index) => index === i ? { ...l, ...patch } : l));
  const submit = e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget));
    if (savingBlocked) return; void run(() => onSubmit({ ...f, customerId, onAccount: Boolean(customerId), ...(customerId ? { paymentAmount: paymentAmount ? moneyInput(paymentAmount, currency) : 0 } : {}), lines: lines.map(l => ({ ...l, quantity: Number(l.quantity) })), discount: discount ? moneyInput(discount, currency) : 0 }));
  };
  return <form onSubmit={submit} aria-busy={busy}><fieldset className="form-fields" disabled={busy || savingBlocked}><div className="modal-body"><ErrorMessage error={error} /><div className="info-note"><Info size={16} /><span>Customer purchases add to their tab. Record any money received now, or collect it later from their profile. Expired batches are excluded.</span></div>{!sellable.length ? <Empty title="Add some stock first" description="You need at least one product with unexpired stock to record a sale." /> : <><div className="sale-items-label"><span>Product</span><span>Quantity</span><span>Total</span></div>{lines.map((l, i) => { const p = products.find(p => p.id === l.productId); return <div className="sale-item" key={i}><div><Select value={l.productId} onChange={e => update(i, { productId: e.target.value })} required aria-label={`Product ${i + 1}`}><option value="">Choose a product</option>{sellable.filter(p => p.id === l.productId || !lines.some(line => line.productId === p.id)).map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</Select>{p && <small>{available(p)} available · {money(p.price)} each</small>}</div><input type="number" min="1" max={p ? available(p) : undefined} step="1" value={l.quantity} onChange={e => update(i, { quantity: e.target.value })} required aria-label={`Quantity ${i + 1}`} /><strong>{money((p?.price || 0) * (Number(l.quantity) || 0))}</strong><button className="icon-button" type="button" onClick={() => setLines(lines.filter((_, index) => index !== i))} disabled={lines.length === 1} aria-label={`Remove product ${i + 1}`}><Trash2 size={16} /></button></div>; })}<button type="button" className="text-button add-line" disabled={lines.length >= sellable.length} onClick={() => setLines([...lines, { productId: '', quantity: 1 }])}><Plus size={16} />Add another product</button><div className="form-grid"><Field label="Customer"><Select name="customerId" value={customerId} onChange={e => { setCustomerId(e.target.value); setPaymentAmount(''); }} aria-label="Sale customer"><option value="">Walk-in customer</option>{customers.filter(c => !c.archived).slice().sort((a, b) => a.name.localeCompare(b.name)).map(c => <option key={c.id} value={c.id}>{c.name}{c.vip ? ' \u00b7 VIP' : ''}{c.phone ? ` (${c.phone})` : ''}</option>)}</Select></Field>{customerId && <Field label="Payment received now" hint="Leave at 0 to add the full purchase to their tab."><input name="paymentAmount" type="number" min="0" max={Math.max(0, (balance + total) / 100)} step={step} value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} placeholder="0" /><button className="text-button" type="button" onClick={() => setPaymentAmount((Math.max(0, total) / 100).toFixed(digits))}>Paid for this purchase</button></Field>}<Field label="Payment method"><Select name="method">{METHODS.map(m => <option key={m}>{m}</option>)}</Select></Field><Field label="Discount amount"><input name="discount" type="number" min="0" step={step} value={discount} onChange={e => setDiscount(e.target.value)} placeholder={digits === 0 ? '0' : '0.00'} /></Field><Field label="Sale date"><input name="date" type="date" defaultValue={today()} max={today()} required /></Field><Field label="Note" className="span-2"><input name="note" placeholder="Optional" maxLength={300} /></Field></div><div className="sale-total"><span>Sale total<small>Paid in full · no tax added</small></span><strong>{money(total)}</strong></div></>}</div></fieldset><FormFooter busy={busy} blocked={savingBlocked} onClose={onClose} submit="Record sale" disabled={!sellable.length} /></form>;
}
export function CustomerPaymentForm({ state, initialCustomerId = '', money, onSubmit, onClose, savingBlocked = false }) {
  const currency = state.settings.currency;
  const digits = currencyDigits(currency), step = digits === 0 ? '1' : '0.01';
  const customers = state.customers.filter(c => customerMetrics(state, c.id).balance > 0).sort((a, b) => a.name.localeCompare(b.name));
  const [customerId, setCustomerId] = useState(initialCustomerId || customers[0]?.id || '');
  const [amount, setAmount] = useState('');
  const balance = customerId ? customerMetrics(state, customerId).balance : 0;
  const { error, busy, run } = useAsyncAction();
  const submit = e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget));
    if (savingBlocked) return;
    void run(() => onSubmit({ ...f, customerId, amount: moneyInput(amount, currency) }));
  };
  return <form onSubmit={submit} aria-busy={busy}><fieldset className="form-fields" disabled={busy || savingBlocked}><div className="modal-body"><ErrorMessage error={error} />
    <div className="info-note"><Info size={16} /><span>This payment reduces the customer's total outstanding balance across all their purchases.</span></div>
    {!customers.length ? <Empty title="All customer tabs are clear" description="Record a customer sale to start a tab." /> : <>
      <div className="form-grid">
        <Field label="Customer" className="span-2"><Select name="customerId" value={customerId} onChange={e => { setCustomerId(e.target.value); setAmount(''); }} required>{customers.map(c => <option key={c.id} value={c.id}>{c.name}{c.vip ? ' · VIP' : ''}{c.archived ? ' · Archived' : ''}</option>)}</Select></Field>
        <Field label="Amount received" hint={`Outstanding: ${money(balance)}`}><input name="amount" type="number" min={step} max={balance / 100} step={step} value={amount} onChange={e => setAmount(e.target.value)} required placeholder="0" /><button className="text-button" type="button" onClick={() => setAmount((balance / 100).toFixed(digits))}>Clear full balance</button></Field>
        <Field label="Payment date"><input name="date" type="date" defaultValue={today()} max={today()} required /></Field>
        <Field label="Payment method"><Select name="method">{METHODS.map(m => <option key={m}>{m}</option>)}</Select></Field>
        <Field label="Note"><input name="note" maxLength={300} placeholder="Optional" /></Field>
      </div>
      <div className="sale-total"><span>Balance after payment</span><strong>{money(balance - Math.round((Number(amount) || 0) * 100))}</strong></div>
    </>}
  </div></fieldset><FormFooter busy={busy} blocked={savingBlocked} disabled={!balance} onClose={onClose} submit="Record payment" /></form>;
}

export function ReturnForm({ state, sale, money, onSubmit, onClose, savingBlocked = false }) {
  const { error, busy, run } = useAsyncAction();
  if (!sale) return null;
  const cash = refundCashAmount(state, sale);
  const submit = e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget));
    if (!savingBlocked) void run(() => onSubmit(f));
  };
  return <form onSubmit={submit} aria-busy={busy}><fieldset className="form-fields" disabled={busy || savingBlocked}><div className="modal-body"><ErrorMessage error={error} />
    <p className="muted">Return every item from {sale.reference} to its original stock batch.</p>
    <div className="tab-balance-summary"><span>Sale reversed<strong>{money(sale.amount)}</strong></span>{sale.onAccount && <span>Outstanding balance cleared<strong>{money(sale.amount - cash)}</strong></span>}<span>Cash to refund<strong>{money(cash)}</strong></span></div>
    {sale.onAccount && cash > 0 && <Field label="Refund payment method"><Select name="method">{METHODS.map(m => <option key={m}>{m}</option>)}</Select></Field>}
    <label className="checkbox-field"><input type="checkbox" required />I confirm all goods were returned{cash > 0 ? ' and the cash refund above was paid.' : '.'}</label>
  </div></fieldset><FormFooter busy={busy} blocked={savingBlocked} onClose={onClose} submit="Record return & refund" /></form>;
}

export function EntryForm({ type = 'expense', money, onSubmit, onClose, currency = 'XOF', savingBlocked = false }) {
  const digits = currencyDigits(currency), step = digits === 0 ? '1' : '0.01';
  const { error, busy, run } = useAsyncAction();
  const submit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); if (savingBlocked) return; void run(() => onSubmit({ ...f, type, amount: moneyInput(f.amount, currency) })); };
  return <form onSubmit={submit} aria-busy={busy}><fieldset className="form-fields" disabled={busy || savingBlocked}><div className="modal-body"><ErrorMessage error={error} />{type === 'income' && <div className="info-note"><Info size={16} /><span>For capital contributions or other cash received. Use Record payment to collect customer balances, and Record sale for product sales.</span></div>}<div className="form-grid"><Field label="Description" className="span-2"><input name="description" placeholder={type === 'expense' ? 'e.g. Monthly shop rent' : 'e.g. Owner capital contribution'} required maxLength={160} /></Field><Field label="Amount"><input name="amount" type="number" min={step} step={step} placeholder={digits === 0 ? '0' : '0.00'} required /></Field><Field label="Date"><input name="date" type="date" defaultValue={today()} max={today()} required /></Field>{type === 'expense' && <Field label="Category"><Select name="category">{EXPENSE_CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select></Field>}<Field label="Payment method"><Select name="method">{METHODS.map(m => <option key={m}>{m}</option>)}</Select></Field><Field label={type === 'expense' ? 'Paid to' : 'Received from'} className={type === 'income' ? '' : 'span-2'}><input name="party" placeholder="Optional" maxLength={100} /></Field><Field label="Note" className="span-2"><textarea name="note" placeholder="Optional" rows="2" maxLength={300} /></Field></div></div></fieldset><FormFooter busy={busy} blocked={savingBlocked} onClose={onClose} submit={type === 'expense' ? 'Save expense' : 'Save income'} /></form>;
}
export function StockForm({ products, initialProduct, onSubmit, onClose, money, currency = 'XOF', savingBlocked = false }) {
  const digits = currencyDigits(currency), step = digits === 0 ? '1' : '0.01';
  const [productId, setProductId] = useState(initialProduct?.id || products[0]?.id || '');
  const [quantity, setQuantity] = useState('');
  const product = products.find(p => p.id === productId);
  const [cost, setCost] = useState(product ? (product.cost / 100).toFixed(digits) : '');
  const { error, busy, run } = useAsyncAction();
  const changeProduct = value => { setProductId(value); setCost(((products.find(p => p.id === value)?.cost || 0) / 100).toFixed(digits)); };
  const submit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); if (savingBlocked) return; void run(() => onSubmit({ ...f, productId, quantity: Number(quantity), cost: moneyInput(cost, currency) })); };
  return <form onSubmit={submit} aria-busy={busy}><fieldset className="form-fields" disabled={busy || savingBlocked}><div className="modal-body"><ErrorMessage error={error} /><div className="info-note"><Info size={16} /><span>This records a paid stock purchase and adds it to your cash ledger.</span></div><div className="form-grid"><Field label="Product" className="span-2"><Select value={productId} onChange={e => changeProduct(e.target.value)} required>{!products.length && <option value="">Add a product first</option>}{products.map(p => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</Select></Field><Field label="Units received"><input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} min="1" step="1" required /></Field><Field label="Unit cost"><input type="number" value={cost} onChange={e => setCost(e.target.value)} min={step} step={step} required /></Field><Field label="Batch code"><input name="batchCode" placeholder="e.g. LOT-2026-01" maxLength={60} /></Field><Field label="Expiry date"><input name="expiry" type="date" min={today()} /></Field><Field label="Payment method"><Select name="method">{METHODS.map(m => <option key={m}>{m}</option>)}</Select></Field><Field label="Note"><input name="note" placeholder="Optional" maxLength={200} /></Field></div><div className="sale-total"><span>Purchase total</span><strong>{money(Math.round((Number(cost) || 0) * 100) * (Number(quantity) || 0))}</strong></div></div></fieldset><FormFooter busy={busy} blocked={savingBlocked} onClose={onClose} submit="Receive stock" disabled={!product} /></form>;
}
export function AdjustForm({ product, onSubmit, onClose, savingBlocked = false }) {
  const { error, busy, run } = useAsyncAction();
  const submit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); if (savingBlocked) return; void run(() => onSubmit({ ...f, productId: product.id, quantity: Number(f.quantity) })); };
  return <form onSubmit={submit} aria-busy={busy}><fieldset className="form-fields" disabled={busy || savingBlocked}><div className="modal-body"><ErrorMessage error={error} /><div className="info-note"><Info size={16} /><span>For counts, damaged goods, or expired stock. This changes stock only; it does not record a cash payment.</span></div><Field label="Batch"><Select name="batchId" required>{product.batches.map(b => <option value={b.id} key={b.id}>{b.code} · {b.quantity} units{b.expiry ? ` · expires ${b.expiry}` : ''}</option>)}</Select></Field><Field label="Quantity change" hint="Use -2 to remove 2 units, or 2 to add 2 units."><input name="quantity" type="number" step="1" required /></Field><Field label="Reason"><textarea name="reason" placeholder="e.g. 2 damaged bottles removed after stock count" required maxLength={300} rows="3" /></Field></div></fieldset><FormFooter busy={busy} blocked={savingBlocked} onClose={onClose} submit="Save adjustment" disabled={!product.batches.length} /></form>;
}
export function ProductDetail({ product, movements, money, dateLabel, onEdit, onReceive, onAdjust }) {
  return <div className="modal-body"><div className="product-detail-top"><ProductArt product={product} large /><div><span className="eyebrow">{product.brand || product.category}</span><h3>{product.name}</h3><p>{product.sku} · {product.supplier || 'No supplier added'}</p><Badge>{product.category}</Badge></div></div><div className="detail-metrics"><div><small>On hand</small><strong>{stock(product)} <em>units</em></strong></div><div><small>Available to sell</small><strong>{available(product)} <em>units</em></strong></div><div><small>Selling price</small><strong>{money(product.price)}</strong></div></div><div className="detail-actions"><button className="button primary" onClick={onReceive}>Receive stock</button><button className="button secondary" onClick={onAdjust} disabled={!product.batches.length}>Adjust stock</button><button className="button secondary" onClick={onEdit}>Edit product</button></div><h4 className="section-label">Stock batches</h4>{product.batches.length ? <div className="table-scroll"><table className="compact-table"><thead><tr><th>Batch</th><th>Units</th><th>Unit cost</th><th>Expiry</th></tr></thead><tbody>{product.batches.map(b => <tr key={b.id}><td>{b.code}</td><td>{b.quantity}</td><td>{money(b.cost)}</td><td className={b.expiry && b.expiry < today() ? 'text-red' : ''}>{b.expiry ? dateLabel(b.expiry) : 'No expiry'}</td></tr>)}</tbody></table></div> : <p className="muted">Receive your first batch to get started.</p>}<h4 className="section-label">Recent stock movements</h4>{movements.length ? <div className="movement-list">{movements.slice().reverse().slice(0, 12).map(m => <div key={m.id}><span><strong>{m.type}</strong><small>{m.reason} · {dateLabel(m.date)}</small></span><b className={m.quantity > 0 ? 'text-green' : ''}>{m.quantity > 0 ? '+' : ''}{m.quantity}</b></div>)}</div> : <p className="muted">No stock movements yet.</p>}</div>;
}
