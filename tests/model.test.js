import test from 'node:test';
import assert from 'node:assert/strict';
import { addProduct, adjustStock, available, createDemo, csv, dayOffset, editProduct, emptyState, metrics, moneyInput, receiveStock, recordEntry, recordSale, refundSale, stock, today, validateState } from '../src/model.js';

const item = (overrides = {}) => ({ name: 'Glow Serum', brand: 'Videvas', sku: 'VD-001', category: 'Skincare', price: 1200, cost: 500, quantity: 10, reorder: 3, expiry: dayOffset(90), ...overrides });
const setup = overrides => addProduct(emptyState({ currency: 'USD' }), item(overrides));
const sale = (s, quantity = 1, extra = {}) => recordSale(s, { lines: [{ productId: s.products[0].id, quantity }], method: 'Cash', discount: 0, ...extra });

test('money parsing preserves cents and rejects invalid amounts', () => {
  assert.equal(moneyInput('10.09'), 1009);
  assert.equal(moneyInput('0.1'), 10);
  assert.equal(moneyInput('0'), 0);
  for (const input of ['-1', 'NaN', '1.999', '1e3', '', '10000001']) assert.throws(() => moneyInput(input));
});
test('a sale commits stock, journal, costs, and cash together without changing its input', () => {
  const initial = setup(); const next = sale(initial, 3, { discount: 100 });
  assert.equal(stock(initial.products[0]), 10);
  assert.equal(stock(next.products[0]), 7);
  assert.equal(next.transactions[0].amount, 3500);
  assert.equal(next.transactions[0].cost, 1500);
  assert.equal(metrics(next).grossProfit, 2000);
  assert.equal(metrics(next).cashFlow, 3500);
  assert.equal(next.movements.at(-1).quantity, -3);
  validateState(next);
});
test('sale consumes the earliest-expiring batch and uses its actual cost', () => {
  let state = setup({ quantity: 4, expiry: dayOffset(90) });
  state = receiveStock(state, { productId: state.products[0].id, quantity: 2, cost: 700, method: 'Card', expiry: dayOffset(20) });
  const next = sale(state, 3);
  assert.deepEqual(next.products[0].batches.map(b => b.quantity), [3, 0]);
  assert.equal(next.transactions.at(-1).cost, 1900);
  assert.equal(metrics(next).purchases, 1400);
  validateState(next);
});
test('overselling and invalid discounts never mutate stock or ledger', () => {
  const state = setup(); const snapshot = JSON.stringify(state);
  assert.throws(() => sale(state, 11), /Not enough/);
  assert.throws(() => sale(state, 1, { discount: 1200 }), /Discount/);
  assert.throws(() => sale(state, -1), /whole numbers/);
  assert.equal(JSON.stringify(state), snapshot);
});
test('expired stock is excluded, while expiry on the current date remains available', () => {
  const expired = setup({ expiry: dayOffset(-1) });
  assert.equal(available(expired.products[0]), 0);
  assert.equal(stock(expired.products[0]), 10);
  assert.throws(() => sale(expired), /unexpired/);
  assert.equal(available(setup({ expiry: today() }).products[0]), 10);
});
test('stock purchases affect cash but do not count as operating expenses or COGS', () => {
  let state = setup({ quantity: 0 });
  state = receiveStock(state, { productId: state.products[0].id, quantity: 5, cost: 700, method: 'Bank transfer', expiry: dayOffset(50) });
  assert.equal(stock(state.products[0]), 5);
  assert.equal(metrics(state).cashFlow, -3500);
  assert.equal(metrics(state).operatingProfit, 0);
  assert.equal(metrics(state).inventoryValue, 3500);
  assert.equal(metrics(state).expenses, 0);
  validateState(state);
});
test('full refunds reverse cash and COGS and restore original batches even after price edits', () => {
  const initial = setup(); let state = sale(initial, 3, { discount: 100 });
  const saleId = state.transactions.at(-1).id;
  state = editProduct(state, state.products[0].id, { ...state.products[0], price: 2000, cost: 900 });
  state = refundSale(state, saleId);
  assert.equal(stock(state.products[0]), 10);
  assert.equal(metrics(state).revenue, 0);
  assert.equal(metrics(state).cogs, 0);
  assert.equal(metrics(state).cashFlow, 0);
  assert.equal(state.transactions.at(-1).amount, 3500);
  assert.throws(() => refundSale(state, saleId), /already/);
  validateState(state);
});
test('multi-product discounts allocate exactly to cents for reports', () => {
  let state = setup({ price: 101 });
  state = addProduct(state, item({ sku: 'VD-002', price: 103 }));
  state = recordSale(state, { lines: state.products.map(p => ({ productId: p.id, quantity: 1 })), discount: 3, method: 'Cash' });
  const transaction = state.transactions.at(-1);
  assert.equal(transaction.amount, 201);
  assert.equal(transaction.lines.reduce((s, l) => s + l.netAmount, 0), 201);
  validateState(state);
});
test('XOF uses whole francs, and discounted product totals reconcile without fractional francs', () => {
  assert.equal(moneyInput('7500', 'XOF'), 750000);
  assert.throws(() => moneyInput('7500.50', 'XOF'), /whole-franc/);
  let state = addProduct(emptyState(), item({ price: 750000, cost: 400000 }));
  state = addProduct(state, item({ sku: 'VD-002', price: 690000, cost: 350000 }));
  state = recordSale(state, { lines: state.products.map(p => ({ productId: p.id, quantity: 1 })), discount: 100, method: 'Cash' });
  const t = state.transactions.at(-1);
  assert.equal(t.amount, 1439900);
  assert.equal(t.lines.reduce((s, l) => s + l.netAmount, 0), t.amount);
  assert.ok(t.lines.every(l => l.netAmount % 100 === 0));
  assert.throws(() => recordEntry(state, { type: 'income', amount: 101, description: 'Capital', method: 'Cash', date: today() }), /whole numbers/);
  validateState(state);
});
test('large discounts retain exact allocation without floating-point rounding', () => {
  let state = setup({ price: 500000001 });
  state = addProduct(state, item({ sku: 'VD-002', price: 499999999 }));
  state = recordSale(state, { lines: state.products.map(p => ({ productId: p.id, quantity: 1 })), discount: 1, method: 'Cash' });
  assert.deepEqual(state.transactions.at(-1).lines.map(l => l.netAmount), [500000000, 499999999]);
  validateState(state);
});
test('cash expenses and capital income stay separate from product sales', () => {
  let state = setup();
  state = recordEntry(state, { type: 'expense', amount: 400, category: 'Supplies', description: 'Bags', method: 'Cash', date: today() });
  state = recordEntry(state, { type: 'income', amount: 10000, description: 'Owner capital', method: 'Bank transfer', date: today() });
  assert.equal(metrics(state).cashFlow, 9600);
  assert.equal(metrics(state).operatingProfit, -400);
  assert.equal(metrics(state).revenue, 0);
  assert.throws(() => recordEntry(state, { type: 'expense', amount: 1, category: 'Rent', description: 'Rent', method: 'Cash', date: dayOffset(1) }), /today or earlier/);
  validateState(state);
});
test('stock adjustments require a reason, prevent negative quantities, and retain history', () => {
  const state = setup(), product = state.products[0];
  const input = { productId: product.id, batchId: product.batches[0].id, quantity: -2, reason: 'Damaged' };
  const next = adjustStock(state, input);
  assert.equal(stock(next.products[0]), 8);
  assert.equal(next.transactions.length, 0);
  assert.throws(() => adjustStock(state, { ...input, quantity: -11 }), /more units/);
  assert.throws(() => adjustStock(state, { ...input, reason: '' }), /reason/);
  validateState(next);
});
test('backup validation detects inconsistent balances, duplicate SKUs, and altered sale amounts', () => {
  const state = sale(setup(), 2);
  const changedStock = structuredClone(state); changedStock.products[0].batches[0].quantity += 1;
  assert.throws(() => validateState(changedStock), /movement history/);
  const changedSale = structuredClone(state); changedSale.transactions[0].amount += 1;
  assert.throws(() => validateState(changedSale), /totals/);
  const duplicates = structuredClone(state); duplicates.products.push({ ...structuredClone(state.products[0]), id: 'another' });
  assert.throws(() => validateState(duplicates), /Duplicate product SKU/);
  const missingMovement = structuredClone(state); missingMovement.movements.pop();
  assert.throws(() => validateState(missingMovement), /movement history/);
  validateState(JSON.parse(JSON.stringify(state)));
});
test('demo records have consistent stock, and CSV escapes formulas and punctuation', () => {
  const state = createDemo(); validateState(state);
  assert.equal(state.demo, true);
  assert.equal(state.products.length, 12);
  assert.equal(csv([['=SUM(A1)', 'a,"b"', 'line\nbreak']]), '"\'=SUM(A1)","a,""b""","line\nbreak"');
});
