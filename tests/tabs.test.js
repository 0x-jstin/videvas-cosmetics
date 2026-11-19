import test from 'node:test';
import assert from 'node:assert/strict';
import { addCustomer, addProduct, customerMetrics, dayOffset, editCustomer, emptyState, metrics, recordCustomerPayment, recordSale, refundSale, setCustomerArchived, stock, today, validateState } from '../src/model.js';

const setup = (currency = 'XOF') => addProduct(addCustomer(emptyState({ currency }), { name: 'Awa', vip: true }), { name: 'Serum', sku: 'S1', category: 'Skincare', price: 750000, cost: 300000, quantity: 20, reorder: 2 });
const sale = (s, extra = {}) => recordSale(s, { customerId: s.customers[0].id, onAccount: true, lines: [{ productId: s.products[0].id, quantity: 1 }], ...extra });
const pay = (s, amount, extra = {}) => recordCustomerPayment(s, { customerId: s.customers[0].id, amount, method: 'Mobile money', date: today(), ...extra });
const summary = s => customerMetrics(s, s.customers[0].id);

test('multiple purchases share one tab and partial payments only reduce debt and increase cash', () => {
  let s = sale(sale(setup(), { discount: 50000 }));
  assert.equal(summary(s).balance, 1450000);
  assert.equal(metrics(s).incoming, 0);
  assert.equal(metrics(s).revenue, 1450000);
  s = pay(s, 600000);
  assert.equal(summary(s).balance, 850000);
  assert.equal(metrics(s).incoming, 600000);
  assert.equal(metrics(s).grossProfit, 850000);
  assert.equal(stock(s.products[0]), 18);
  assert.equal(s.transactions.at(-1).saleId, undefined);
  s = pay(s, 850000);
  assert.equal(summary(s).balance, 0);
  assert.equal(summary(s).paid, 1450000);
  assert.equal(metrics(s).revenue, 1450000);
  assert.equal(summary(s).history.length, 4);
  validateState(JSON.parse(JSON.stringify(s)));
});

test('payment at checkout creates a customer receipt atomically and can clear an earlier tab', () => {
  const initial = sale(setup());
  const s = sale(initial, { method: 'Cash', paymentAmount: 1500000 });
  assert.equal(summary(s).balance, 0);
  assert.equal(s.transactions.at(-1).type, 'payment');
  assert.equal(s.transactions.at(-1).amount, 1500000);
  assert.equal(s.transactions.at(-1).saleId, undefined);
  assert.equal(stock(initial.products[0]), 19);
  assert.equal(metrics(s).incoming, 1500000);
  assert.throws(() => sale(initial, { method: 'Cash', paymentAmount: 1500100 }), /outstanding balance/);
  assert.throws(() => sale(initial, { method: 'Cheque', paymentAmount: 100 }), /payment method/);
  assert.equal(initial.transactions.length, 1);
  validateState(s);
});

test('invalid, excessive, and unowned payments leave the customer tab untouched', () => {
  const s = sale(setup()), before = JSON.stringify(s);
  for (const amount of [0, -100, 1.5, 101, 750100, NaN]) assert.throws(() => pay(s, amount));
  assert.throws(() => pay(s, 100, { customerId: 'missing' }), /existing customer/);
  assert.throws(() => pay(s, 100, { date: dayOffset(1) }), /today or earlier/);
  assert.throws(() => pay(s, 100, { method: 'Cheque' }), /payment method/);
  assert.throws(() => recordSale(setup(), { onAccount: true, lines: [{ productId: s.products[0].id, quantity: 1 }] }), /Choose a customer/);
  assert.equal(JSON.stringify(s), before);
});

test('fully unpaid returns clear debt and restore stock without posting cash out', () => {
  let s = sale(setup());
  s = refundSale(s, s.transactions[0].id);
  assert.equal(summary(s).balance, 0);
  assert.equal(metrics(s).revenue, 0);
  assert.equal(metrics(s).cashFlow, 0);
  assert.equal(stock(s.products[0]), 20);
  assert.equal(s.transactions[1].cashAmount, 0);
  assert.throws(() => refundSale(s, s.transactions[0].id), /already/);
  validateState(s);
});

test('partial and fully settled returns refund only cash beyond the remaining debt', () => {
  for (const amount of [200000, 750000]) {
    let s = pay(sale(setup()), amount);
    assert.throws(() => refundSale(s, s.transactions[0].id), /payment method/);
    s = refundSale(s, s.transactions[0].id, { method: 'Cash' });
    assert.equal(s.transactions.at(-1).cashAmount, amount);
    assert.equal(summary(s).balance, 0);
    assert.equal(summary(s).cashRefunded, amount);
    assert.equal(metrics(s).cashFlow, 0);
    assert.equal(metrics(s).revenue, 0);
    validateState(s);
  }
});

test('returns offset the shared tab across purchases without allocating prior payments to a sale', () => {
  let s = pay(sale(sale(setup())), 400000);
  s = refundSale(s, s.transactions[0].id);
  assert.equal(summary(s).balance, 350000);
  assert.equal(s.transactions.at(-1).cashAmount, 0);
  assert.equal(metrics(s).incoming, 400000);
  s = refundSale(s, s.transactions[1].id, { method: 'Bank transfer' });
  assert.equal(s.transactions.at(-1).cashAmount, 400000);
  assert.equal(summary(s).balance, 0);
  validateState(s);
});

test('VIP changes and archiving preserve debt and allow collections on archived profiles', () => {
  let s = sale(setup());
  const customer = s.customers[0];
  s = editCustomer(s, customer.id, { name: 'Awa Sow' });
  assert.equal(s.customers[0].vip, true);
  s = editCustomer(s, customer.id, { name: 'Awa Sow', vip: false });
  assert.equal(s.customers[0].vip, false);
  s = setCustomerArchived(s, customer.id, true);
  s = pay(s, 100000);
  assert.equal(summary(s).balance, 650000);
  assert.equal(s.transactions.at(-1).party, 'Awa Sow');
  assert.equal(s.transactions[0].party, 'Awa');
  assert.throws(() => sale(s), /archived/);
  assert.throws(() => editCustomer(s, customer.id, { name: 'Awa', vip: 'yes' }), /VIP/);
  validateState(s);
});

test('old paid receipts and missing VIP fields retain their settled balance', () => {
  let s = setup();
  delete s.customers[0].vip;
  s = recordSale(s, { customerId: s.customers[0].id, lines: [{ productId: s.products[0].id, quantity: 1 }], method: 'Cash' });
  assert.equal(summary(s).balance, 0);
  assert.equal(summary(s).paid, 750000);
  assert.equal(validateState(s), s);
  const oldId = s.transactions[0].id;
  s = sale(s);
  s = refundSale(s, oldId);
  assert.equal(summary(s).balance, 750000);
  assert.equal(metrics(s).cashFlow, 0);
  validateState(s);
});

test('backup validation rejects fabricated collections, refund cash, and customer flags', () => {
  const s = pay(sale(setup()), 200000);
  const invalid = change => { const copy = structuredClone(s); change(copy); assert.throws(() => validateState(copy)); };
  invalid(c => { c.transactions[1].amount = 750100; });
  invalid(c => { c.transactions[1].customerId = 'missing'; });
  invalid(c => { c.transactions[1].saleId = c.transactions[0].id; });
  invalid(c => { c.transactions[0].onAccount = 'true'; });
  invalid(c => { c.customers[0].vip = 'yes'; });
  invalid(c => { c.transactions.reverse(); });
  const returned = refundSale(s, s.transactions[0].id, { method: 'Cash' });
  returned.transactions.at(-1).cashAmount = 300000;
  assert.throws(() => validateState(returned), /refund does not match/);
});

test('decimal currency payments and period reports preserve cents without double counting sales', () => {
  let s = sale(setup('USD'));
  s = pay(s, 12345);
  assert.equal(summary(s).balance, 737655);
  const paymentPeriod = metrics(s, [s.transactions.at(-1)]);
  assert.equal(paymentPeriod.incoming, 12345);
  assert.equal(paymentPeriod.revenue, 0);
  assert.equal(paymentPeriod.grossProfit, 0);
  assert.equal(paymentPeriod.outstanding, 737655);
  validateState(s);
});
