import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCustomer, addProduct, adjustStock, customerMetrics, deleteTransaction, emptyState, metrics, receiveStock, recordCustomerPayment, recordEntry, recordSale, refundSale, stock, today, validateState } from '../src/model.js';

function fixture(quantity = 5) {
  return addProduct(addCustomer(emptyState(), { name: 'Awa' }), {
    name: 'Serum', sku: 'SER-1', category: 'Skincare', price: 200000, cost: 100000, quantity, reorder: 1,
  });
}
const sale = (state, quantity = 1, tab = false, paymentAmount = 0) => recordSale(state, {
  lines: [{ productId: state.products[0].id, quantity }], method: 'Cash',
  ...(tab ? { customerId: state.customers[0].id, onAccount: true, paymentAmount } : {}),
});
const restock = (state, quantity = 3) => receiveStock(state, {
  productId: state.products[0].id, quantity, cost: 120000, batchCode: 'RESTOCK', method: 'Mobile money',
});
const payment = (state, amount = 50000) => recordCustomerPayment(state, {
  customerId: state.customers[0].id, amount, method: 'Cash', date: today(),
});

test('deleting a sale restores each original batch and reverses revenue, cost and cash without mutating the input', () => {
  const before = restock(fixture(2), 4);
  const posted = sale(before, 4);
  const original = structuredClone(posted);
  assert.equal(posted.transactions.at(-1).lines[0].allocations.length, 2);
  const deleted = deleteTransaction(posted, posted.transactions.at(-1).id);
  assert.deepEqual(deleted, before);
  assert.deepEqual(metrics(deleted), metrics(before));
  assert.deepEqual(posted, original);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(deleted))), deleted);
});

test('deleting a customer payment reopens the balance and removes cash received without changing sales', () => {
  const before = sale(fixture(), 1, true);
  const posted = payment(before);
  const deleted = deleteTransaction(posted, posted.transactions.at(-1).id);
  assert.deepEqual(deleted, before);
  assert.equal(customerMetrics(deleted, deleted.customers[0].id).balance, 200000);
  assert.equal(metrics(deleted).revenue, metrics(posted).revenue);
  assert.equal(metrics(deleted).cashFlow, metrics(posted).cashFlow - 50000);
});

test('a paid tab sale can be deleted after its dependent payment is removed', () => {
  const before = fixture();
  const posted = sale(before, 1, true, 200000);
  assert.throws(() => deleteTransaction(posted, posted.transactions[0].id), /dependent entries first/);
  const unpaid = deleteTransaction(posted, posted.transactions[1].id);
  assert.deepEqual(deleteTransaction(unpaid, posted.transactions[0].id), before);
});

test('an unused restock removes its received batch, movement and cash payment while preserving other restocks', () => {
  const first = restock(fixture());
  const target = first.transactions[0];
  const second = restock(first, 2);
  const deleted = deleteTransaction(second, target.id);
  assert.equal(stock(deleted.products[0]), 7);
  assert.equal(deleted.products[0].batches.length, 2);
  assert.equal(deleted.transactions.length, 1);
  assert.deepEqual(deleted.transactions[0], second.transactions[1]);
  assert.equal(deleted.movements.some(m => m.transactionId === target.id), false);
  assert.equal(metrics(deleted).cashFlow, metrics(second).cashFlow + target.amount);
  assert.deepEqual(deleted.customers, second.customers);
  assert.deepEqual(deleted.settings, second.settings);
  validateState(deleted);
});

test('a consumed restock is blocked until the sale is deleted, including a stock adjustment that removed units', () => {
  const received = restock(fixture(0), 3);
  const posted = sale(received, 1);
  const target = received.transactions[0];
  assert.throws(() => deleteTransaction(posted, target.id), /stock has been sold or removed/);
  const unsold = deleteTransaction(posted, posted.transactions[1].id);
  const deleted = deleteTransaction(unsold, target.id);
  assert.equal(stock(deleted.products[0]), 0);
  assert.equal(deleted.products[0].batches.length, 0);
  assert.equal(deleted.transactions.length, 0);
  assert.equal(deleted.movements.length, 0);
  const adjusted = adjustStock(received, { productId: received.products[0].id, batchId: received.products[0].batches[0].id, quantity: -1, reason: 'Damaged' });
  assert.throws(() => deleteTransaction(adjusted, target.id), /stock has been sold or removed/);
});

test('a restock batch stays when a sale and its return still reference it', () => {
  const received = restock(fixture(0), 2);
  const posted = sale(received, 1);
  const returned = refundSale(posted, posted.transactions[1].id);
  const deleted = deleteTransaction(returned, received.transactions[0].id);
  assert.equal(stock(deleted.products[0]), 0);
  assert.equal(deleted.products[0].batches.length, 1);
  assert.deepEqual(deleted.transactions, returned.transactions.slice(1));
  validateState(deleted);
});

test('a returned sale is blocked until its refund is deleted and returned units are available', () => {
  const before = fixture(2);
  const posted = sale(before, 2);
  const returned = refundSale(posted, posted.transactions[0].id);
  assert.throws(() => deleteTransaction(returned, posted.transactions[0].id), /refund first/);
  const resold = sale(returned, 1);
  assert.throws(() => deleteTransaction(resold, returned.transactions[1].id), /stock has been sold or removed/);
  const undoneResale = deleteTransaction(resold, resold.transactions[2].id);
  const undoneRefund = deleteTransaction(undoneResale, returned.transactions[1].id);
  assert.deepEqual(undoneRefund, posted);
  assert.deepEqual(deleteTransaction(undoneRefund, posted.transactions[0].id), before);
});

test('payments used to calculate a cash refund cannot be deleted until the refund is removed', () => {
  const posted = payment(sale(fixture(), 1, true), 100000);
  const returned = refundSale(posted, posted.transactions[0].id, { method: 'Cash' });
  assert.equal(returned.transactions[2].cashAmount, 100000);
  assert.throws(() => deleteTransaction(returned, posted.transactions[1].id), /dependent entries first/);
  const undoneRefund = deleteTransaction(returned, returned.transactions[2].id);
  const undonePayment = deleteTransaction(undoneRefund, posted.transactions[1].id);
  assert.equal(customerMetrics(undonePayment, posted.customers[0].id).balance, 200000);
});

test('deletion checks balances in posting order even if a later sale would cover the final balance', () => {
  const first = sale(fixture(), 1, true);
  const paid = payment(first, 200000);
  const later = sale(paid, 2, true);
  assert.throws(() => deleteTransaction(later, first.transactions[0].id), /dependent entries first/);
  const deleted = deleteTransaction(later, later.transactions[2].id);
  assert.equal(customerMetrics(deleted, deleted.customers[0].id).balance, 0);
});

test('deleting an earlier record cannot duplicate another existing receipt reference', () => {
  let state = restock(fixture());
  state = sale(state);
  state = sale(state);
  const deleted = deleteTransaction(state, state.transactions[1].id);
  const next = sale(deleted);
  assert.equal(next.transactions.at(-1).reference, 'SAL-0004');
  assert.equal(new Set(next.transactions.map(t => t.reference)).size, next.transactions.length);
});

test('other cash entry deletions reverse their totals and a missing record is rejected', () => {
  const before = fixture();
  const expense = recordEntry(before, { type: 'expense', description: 'Rent', category: 'Rent', amount: 10000, method: 'Cash', date: today() });
  assert.deepEqual(deleteTransaction(expense, expense.transactions[0].id), before);
  const income = recordEntry(before, { type: 'income', description: 'Capital', amount: 10000, method: 'Cash', date: today() });
  assert.deepEqual(deleteTransaction(income, income.transactions[0].id), before);
  assert.throws(() => deleteTransaction(before, 'missing'), /no longer exists/);
});
