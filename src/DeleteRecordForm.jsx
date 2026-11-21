import React, { useMemo } from 'react';
import { ConfirmAction } from './SettingsPage.jsx';
import { RECORD_LABELS, customerMetrics, deleteTransaction, metrics, stock } from './model.js';
import './deletion.css';

const EFFECTS = {
  sale: 'Sold units return to their original stock batches. Sales and profit totals are updated.',
  payment: 'Cash received decreases and the payment amount is added back to the customer’s outstanding balance.',
  purchase: 'The received stock and its cash payment are removed together.',
  refund: 'Returned units are removed from stock. Sales totals, customer balances, and cash refunded are updated.',
  expense: 'The expense is removed from cash paid and operating expenses.',
  income: 'The entry is removed from cash received.',
};

export function DeleteRecordForm({ state, transaction, money, onConfirm, onClose, savingBlocked = false }) {
  const preview = useMemo(() => {
    if (!transaction) return { error: 'This entry is no longer in your workspace.' };
    try { return { next: deleteTransaction(state, transaction.id) }; }
    catch (error) { return { error: error.message }; }
  }, [state, transaction]);
  const label = RECORD_LABELS[transaction?.type] || 'record';
  const cashChange = preview.next ? metrics(preview.next).cashFlow - metrics(state).cashFlow : 0;
  const stockChange = preview.next ? preview.next.products.reduce((sum, p) => sum + stock(p), 0) - state.products.reduce((sum, p) => sum + stock(p), 0) : 0;
  return <ConfirmAction danger action={`Delete ${label}`} onConfirm={onConfirm} onClose={onClose}
    blocked={savingBlocked || Boolean(preview.error)}
    description={transaction ? `Permanently delete ${transaction.reference} from your account on all devices?` : 'This record has already been removed.'}>
    {transaction && <dl className="detail-list delete-record-summary">
      <div><dt>Record</dt><dd>{transaction.description}</dd></div>
      <div><dt>Amount</dt><dd>{money(transaction.amount)}</dd></div>
      {preview.next && <>
        <div><dt>Net cash flow change</dt><dd>{cashChange > 0 ? '+' : cashChange < 0 ? '−' : ''}{money(Math.abs(cashChange))}</dd></div>
        {stockChange !== 0 && <div><dt>Stock change</dt><dd>{stockChange > 0 ? '+' : ''}{stockChange} units</dd></div>}
        {transaction.customerId && <div><dt>Customer balance after deletion</dt><dd>{money(customerMetrics(preview.next, transaction.customerId).balance)}</dd></div>}
      </>}
    </dl>}
    {preview.error ? <p className="form-error" role="alert">{preview.error}</p> : <p className="muted delete-record-effect">{EFFECTS[transaction.type]}</p>}
  </ConfirmAction>;
}
