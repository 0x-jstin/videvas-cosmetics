export const STORAGE_KEY = 'videvas-workspace-v1';
export const CATEGORIES = ['Skincare', 'Cosmetics', 'Bodycare'];
export const METHODS = ['Cash', 'Card', 'Bank transfer', 'Mobile money'];
export const EXPENSE_CATEGORIES = ['Rent', 'Utilities', 'Marketing', 'Transport', 'Supplies', 'Other'];
export const id = () => crypto.randomUUID();
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export function dayOffset(days, from = today()) {
  const d = new Date(`${from}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function integer(value, min = 0) { return Number.isSafeInteger(value) && value >= min && value <= 1_000_000_000; }
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
export const currencyDigits = currency => new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
export function moneyInput(value, currency = 'USD') {
  const text = String(value).trim();
  const digits = currencyDigits(currency);
  requireValue((digits === 0 ? /^\d+$/ : /^\d+(\.\d{1,2})?$/).test(text), digits === 0 ? 'Enter a whole-franc amount without decimal places.' : 'Enter a positive amount with up to two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  requireValue(integer(cents), 'Amount is too large.');
  return cents;
}
function currencyAmount(amount, state) { requireValue(currencyDigits(state.settings.currency) !== 0 || amount % 100 === 0, 'Amounts in this currency must be whole numbers.'); }
export const stock = p => p.batches.reduce((sum, b) => sum + b.quantity, 0);
export const available = (p, date = today()) => p.batches.filter(b => !b.expiry || b.expiry >= date).reduce((sum, b) => sum + b.quantity, 0);
export const stockValue = p => p.batches.reduce((sum, b) => sum + b.quantity * b.cost, 0);
export const expiryStatus = p => {
  const active = p.batches.filter(b => b.quantity > 0 && b.expiry);
  if (active.some(b => b.expiry < today())) return 'Expired';
  if (active.some(b => b.expiry <= dayOffset(60))) return 'Expiring soon';
  return '';
};
export const productStatus = p => available(p) === 0 ? 'Out of stock' : available(p) <= p.reorder ? 'Low stock' : 'In stock';
export function emptyState(settings = {}) {
  return { version: 1, demo: false, settings: { storeName: 'Videvas', currency: 'XOF', ...settings }, products: [], customers: [], transactions: [], movements: [] };
}
const phoneKey = value => value.replace(/\D/g, '');
function customerFields(input) {
  const fields = {};
  for (const [key, limit] of Object.entries({ name: 100, phone: 40, email: 254, address: 300, notes: 1000 })) {
    const value = input[key] ?? '';
    requireValue(typeof value === 'string' && value.trim().length <= limit, `Check the customer ${key}.`);
    fields[key] = value.trim();
  }
  requireValue(fields.name, 'Customer name is required.');
  requireValue(!fields.phone || (/^\+?[\d\s().-]+$/.test(fields.phone) && phoneKey(fields.phone).length >= 7 && phoneKey(fields.phone).length <= 15), 'Enter a valid phone number with 7 to 15 digits.');
  requireValue(!fields.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email), 'Enter a valid email address.');
  fields.email = fields.email.toLowerCase();
  return fields;
}
function uniqueContact(fields, customers, existingId) {
  requireValue(!customers.some(c => c.id !== existingId && fields.email && c.email.toLowerCase() === fields.email), 'A customer with this email already exists.');
  requireValue(!customers.some(c => c.id !== existingId && fields.phone && phoneKey(c.phone) === phoneKey(fields.phone)), 'A customer with this phone number already exists.');
}
export function addCustomer(state, input) {
  const fields = customerFields(input);
  uniqueContact(fields, state.customers);
  const next = structuredClone(state);
  next.customers.push({ id: id(), ...fields, archived: false, createdAt: today(), updatedAt: today() });
  return next;
}
export function editCustomer(state, customerId, input) {
  const fields = customerFields(input);
  uniqueContact(fields, state.customers, customerId);
  const next = structuredClone(state);
  const customer = next.customers.find(c => c.id === customerId);
  requireValue(customer, 'Customer was not found.');
  Object.assign(customer, fields, { updatedAt: today() });
  return next;
}
export function setCustomerArchived(state, customerId, archived) {
  requireValue(typeof archived === 'boolean', 'Choose a valid customer status.');
  const next = structuredClone(state);
  const customer = next.customers.find(c => c.id === customerId);
  requireValue(customer, 'Customer was not found.');
  customer.archived = archived;
  customer.updatedAt = today();
  return next;
}
export function customerMetrics(state, customerId) {
  const history = state.transactions.filter(t => t.customerId === customerId && ['sale', 'refund'].includes(t.type));
  const sales = history.filter(t => t.type === 'sale');
  const paid = sales.reduce((sum, t) => sum + t.amount, 0);
  const refunded = history.filter(t => t.type === 'refund').reduce((sum, t) => sum + t.amount, 0);
  const lastPurchase = sales.reduce((date, t) => t.date > date ? t.date : date, '');
  return { sales: sales.length, paid, refunded, netSpent: paid - refunded, lastPurchase, history };
}
// Existing workspaces and older backups stored customer names directly on sales.
// Bring those named customers forward while leaving the original entries intact.
export function migrateCustomers(state) {
  if (Object.hasOwn(state, 'customers')) return state;
  requireValue(!state.transactions.some(t => t.customerId), 'Customer profiles are missing from this backup.');
  const next = structuredClone(state);
  next.customers = [];
  const names = new Map();
  for (const sale of next.transactions.filter(t => t.type === 'sale')) {
    const name = typeof sale.party === 'string' ? sale.party.trim() : '';
    if (!name || name.toLowerCase() === 'walk-in customer') continue;
    const key = name.normalize('NFKC').toLowerCase();
    let customer = names.get(key);
    if (!customer) {
      customer = { id: id(), name, phone: '', email: '', address: '', notes: '', archived: false, createdAt: sale.date, updatedAt: today() };
      names.set(key, customer); next.customers.push(customer);
    }
    if (sale.date < customer.createdAt) customer.createdAt = sale.date;
    sale.customerId = customer.id;
  }
  for (const refund of next.transactions.filter(t => t.type === 'refund')) {
    const sale = next.transactions.find(t => t.id === refund.saleId && t.type === 'sale');
    if (sale?.customerId) refund.customerId = sale.customerId;
  }
  return next;
}
function validateProduct(p, state, existingId) {
  requireValue(p.name?.trim(), 'Product name is required.');
  requireValue(p.sku?.trim(), 'SKU is required.');
  requireValue(!state.products.some(x => x.id !== existingId && x.sku.toLowerCase() === p.sku.trim().toLowerCase()), 'This SKU is already in use.');
  requireValue(CATEGORIES.includes(p.category), 'Choose a product category.');
  requireValue(integer(p.price, 1) && integer(p.cost), 'Check the product price and cost.');
  currencyAmount(p.price, state); currencyAmount(p.cost, state);
  requireValue(integer(p.reorder), 'Reorder level must be a whole number of zero or more.');
}
export function addProduct(state, input) {
  validateProduct(input, state);
  requireValue(integer(input.quantity), 'Opening stock must be a whole number of zero or more.');
  requireValue(integer(input.quantity * input.cost), 'Opening stock value is too large.');
  requireValue(!input.expiry || validDate(input.expiry), 'Enter a valid expiry date.');
  const next = structuredClone(state);
  const product = { id: id(), name: input.name.trim(), brand: input.brand?.trim() || '', sku: input.sku.trim(), category: input.category, price: input.price, cost: input.cost, reorder: input.reorder, supplier: input.supplier?.trim() || '', style: input.style || 'bottle', tone: input.tone || 'sage', batches: [], createdAt: today() };
  if (input.quantity) {
    const batch = { id: id(), code: input.batchCode?.trim() || 'Opening', quantity: input.quantity, cost: input.cost, expiry: input.expiry || '', received: today() };
    product.batches.push(batch);
    next.movements.push({ id: id(), productId: product.id, batchId: batch.id, date: today(), quantity: input.quantity, type: 'Opening stock', reason: 'Stock on hand when product was added' });
  }
  next.products.push(product);
  return next;
}
export function editProduct(state, productId, input) {
  validateProduct(input, state, productId);
  const next = structuredClone(state);
  const product = next.products.find(p => p.id === productId);
  requireValue(product, 'Product was not found.');
  for (const key of ['name', 'brand', 'sku', 'category', 'price', 'cost', 'reorder', 'supplier']) product[key] = typeof input[key] === 'string' ? input[key].trim() : input[key];
  return next;
}
export function receiveStock(state, input) {
  requireValue(integer(input.quantity, 1), 'Quantity must be a positive whole number.');
  requireValue(integer(input.cost, 1), 'Unit cost must be greater than zero.');
  currencyAmount(input.cost, state);
  requireValue(integer(input.quantity * input.cost, 1), 'Purchase total is too large.');
  requireValue(!input.expiry || (validDate(input.expiry) && input.expiry >= today()), 'New stock cannot have an expiry date in the past.');
  requireValue(METHODS.includes(input.method), 'Choose a payment method.');
  const next = structuredClone(state);
  const product = next.products.find(p => p.id === input.productId);
  requireValue(product, 'Choose a product.');
  const batch = { id: id(), code: input.batchCode?.trim() || `B-${today().replaceAll('-', '')}`, quantity: input.quantity, cost: input.cost, expiry: input.expiry || '', received: today() };
  product.batches.push(batch);
  product.cost = input.cost;
  const transaction = { id: id(), reference: reference(next, 'PUR'), type: 'purchase', date: today(), amount: input.quantity * input.cost, method: input.method, category: 'Stock purchase', description: `${product.name} · ${input.quantity} units`, party: product.supplier || '', lines: [{ productId: product.id, name: product.name, quantity: input.quantity, cost: input.cost, batchId: batch.id }] };
  next.transactions.push(transaction);
  next.movements.push({ id: id(), productId: product.id, batchId: batch.id, transactionId: transaction.id, date: today(), quantity: input.quantity, type: 'Received', reason: input.note?.trim() || 'Stock purchase' });
  return next;
}
export function adjustStock(state, input) {
  requireValue(Number.isSafeInteger(input.quantity) && input.quantity !== 0 && Math.abs(input.quantity) <= 1_000_000, 'Enter a non-zero whole number. Use a minus sign to remove units.');
  requireValue(input.reason?.trim(), 'Add a reason for this adjustment.');
  const next = structuredClone(state);
  const product = next.products.find(p => p.id === input.productId);
  const batch = product?.batches.find(b => b.id === input.batchId);
  requireValue(batch, 'Choose a batch to adjust.');
  requireValue(batch.quantity + input.quantity >= 0, 'You cannot remove more units than this batch holds.');
  requireValue(integer(batch.quantity + input.quantity), 'Resulting quantity is too large.');
  batch.quantity += input.quantity;
  next.movements.push({ id: id(), productId: product.id, batchId: batch.id, date: today(), quantity: input.quantity, type: 'Adjustment', reason: input.reason.trim() });
  return next;
}
function reference(state, prefix) { return `${prefix}-${String(state.transactions.length + 1).padStart(4, '0')}`; }
export function recordSale(state, input, date = today()) {
  requireValue(validDate(date) && date <= today(), 'Sale date must be today or earlier.');
  requireValue(input.lines?.length, 'Add at least one product to the sale.');
  requireValue(METHODS.includes(input.method), 'Choose a payment method.');
  const customer = input.customerId ? state.customers.find(c => c.id === input.customerId) : null;
  requireValue(!input.customerId || customer, 'Choose an existing customer.');
  requireValue(!customer?.archived, 'This customer is archived. Restore their profile before recording a new sale.');
  const next = structuredClone(state);
  const unique = new Set();
  const lines = input.lines.map(line => {
    requireValue(!unique.has(line.productId), 'Each product may only appear once in a sale.');
    unique.add(line.productId);
    const product = next.products.find(p => p.id === line.productId);
    requireValue(product, 'A selected product no longer exists.');
    requireValue(integer(line.quantity, 1), 'Sale quantities must be positive whole numbers.');
    // Expired stock is unavailable even when recording an earlier sale.
    requireValue(available(product) >= line.quantity, `Not enough unexpired stock for ${product.name}.`);
    let remaining = line.quantity;
    const allocations = [];
    const batches = product.batches.filter(b => !b.expiry || b.expiry >= today()).sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999') || a.received.localeCompare(b.received));
    for (const batch of batches) {
      const quantity = Math.min(remaining, batch.quantity);
      if (quantity) { batch.quantity -= quantity; remaining -= quantity; allocations.push({ batchId: batch.id, quantity, cost: batch.cost }); }
      if (!remaining) break;
    }
    return { productId: product.id, name: product.name, sku: product.sku, category: product.category, quantity: line.quantity, price: product.price, cost: allocations.reduce((sum, a) => sum + a.quantity * a.cost, 0), allocations };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.price, 0);
  const discount = input.discount || 0;
  requireValue(integer(subtotal, 1), 'Sale total is too large.');
  requireValue(integer(discount) && discount < subtotal, 'Discount must be less than the subtotal.');
  currencyAmount(discount, state);
  // Allocate discounts in integer cents so product reports reconcile with the ledger.
  const amount = subtotal - discount;
  const unit = currencyDigits(state.settings.currency) === 0 ? 100 : 1;
  const shares = lines.map((line, index) => {
    const numerator = BigInt(line.quantity) * BigInt(line.price) * BigInt(amount / unit);
    const denominator = BigInt(subtotal);
    return { index, floor: Number(numerator / denominator), fraction: numerator % denominator };
  });
  let remainder = amount / unit - shares.reduce((sum, s) => sum + s.floor, 0);
  shares.sort((a, b) => a.fraction === b.fraction ? a.index - b.index : a.fraction > b.fraction ? -1 : 1).forEach(s => { lines[s.index].netAmount = (s.floor + (remainder-- > 0 ? 1 : 0)) * unit; });
  const cost = lines.reduce((sum, line) => sum + line.cost, 0);
  requireValue(integer(cost), 'Total product cost is too large.');
  const transaction = { id: id(), reference: reference(next, 'SAL'), type: 'sale', date, amount, subtotal, discount, cost, method: input.method, category: 'Product sale', description: lines.length === 1 ? lines[0].name : `${lines.length} products`, party: customer?.name || input.customer?.trim() || 'Walk-in customer', note: input.note?.trim() || '', lines, ...(customer ? { customerId: customer.id } : {}) };
  next.transactions.push(transaction);
  lines.forEach(line => line.allocations.forEach(a => next.movements.push({ id: id(), productId: line.productId, batchId: a.batchId, transactionId: transaction.id, date, quantity: -a.quantity, type: 'Sale', reason: transaction.reference })));
  return next;
}
export function refundSale(state, saleId) {
  const next = structuredClone(state);
  const sale = next.transactions.find(t => t.id === saleId && t.type === 'sale');
  requireValue(sale, 'Sale was not found.');
  requireValue(!next.transactions.some(t => t.saleId === saleId), 'This sale has already been refunded.');
  const transaction = { id: id(), reference: reference(next, 'REF'), type: 'refund', date: today(), amount: sale.amount, cost: sale.cost, saleId, method: sale.method, category: 'Sale refund', description: `Refund of ${sale.reference}`, party: sale.party, lines: sale.lines, ...(sale.customerId ? { customerId: sale.customerId } : {}) };
  for (const line of sale.lines) {
    const product = next.products.find(p => p.id === line.productId);
    for (const allocation of line.allocations) {
      const batch = product?.batches.find(b => b.id === allocation.batchId);
      requireValue(batch, 'The original stock batch is missing.');
      requireValue(integer(batch.quantity + allocation.quantity), 'Resulting batch quantity is too large.');
      batch.quantity += allocation.quantity;
      next.movements.push({ id: id(), productId: product.id, batchId: batch.id, transactionId: transaction.id, date: today(), quantity: allocation.quantity, type: 'Refund', reason: transaction.reference });
    }
  }
  next.transactions.push(transaction);
  return next;
}
export function recordEntry(state, input) {
  requireValue(['expense', 'income'].includes(input.type), 'Choose income or expense.');
  requireValue(integer(input.amount, 1), 'Amount must be greater than zero.');
  currencyAmount(input.amount, state);
  requireValue(input.description?.trim(), 'Description is required.');
  requireValue(validDate(input.date) && input.date <= today(), 'Transaction date must be today or earlier.');
  requireValue(METHODS.includes(input.method), 'Choose a payment method.');
  if (input.type === 'expense') requireValue(EXPENSE_CATEGORIES.includes(input.category), 'Choose an expense category.');
  const next = structuredClone(state);
  next.transactions.push({ id: id(), reference: reference(next, input.type === 'expense' ? 'EXP' : 'INC'), type: input.type, date: input.date, amount: input.amount, method: input.method, category: input.type === 'income' ? 'Other income' : input.category, description: input.description.trim(), party: input.party?.trim() || '', note: input.note?.trim() || '' });
  return next;
}
export function metrics(state, transactions = state.transactions) {
  const sum = (type, key = 'amount') => transactions.filter(t => t.type === type).reduce((s, t) => s + (t[key] || 0), 0);
  const revenue = sum('sale') - sum('refund');
  const cogs = sum('sale', 'cost') - sum('refund', 'cost');
  const expenses = sum('expense');
  const incoming = sum('sale') + sum('income');
  const outgoing = sum('expense') + sum('purchase') + sum('refund');
  return { revenue, cogs, grossProfit: revenue - cogs, expenses, purchases: sum('purchase'), incoming, outgoing, cashFlow: incoming - outgoing, operatingProfit: revenue - cogs - expenses, units: state.products.reduce((s, p) => s + stock(p), 0), inventoryValue: state.products.reduce((s, p) => s + stockValue(p), 0) };
}
export function createDemo() {
  let state = emptyState();
  ['Amelia James', 'Sofia Mensah', 'Fatou Diallo', 'Mariam Traoré', 'Awa Sow', 'Grace Anderson'].forEach((name, index) => {
    state = addCustomer(state, { name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, notes: index === 2 ? 'Prefers fragrance-free skincare.' : '' });
  });
  state.customers.forEach((c, i) => { c.createdAt = dayOffset(-60 + i * 3); });
  const items = [
    ['Niacinamide 10% Serum', 'The Ordinary', 'Skincare', 1250, 680, 78, 10, 'dropper', 'sand'],
    ['Soft Matte Lipstick', 'Maybelline', 'Cosmetics', 1150, 550, 55, 10, 'lipstick', 'rose'],
    ['Shea Body Butter', 'Tree Hut', 'Bodycare', 1800, 950, 42, 8, 'jar', 'cream'],
    ['Hydrating Facial Cleanser', 'CeraVe', 'Skincare', 1650, 880, 65, 10, 'pump', 'sage'],
    ['Daily Dew Moisturizer', 'Simple', 'Skincare', 1400, 720, 8, 8, 'tube', 'sage'],
    ['Invisible SPF 50', 'La Roche-Posay', 'Skincare', 2400, 1350, 6, 8, 'tube', 'peach'],
    ['Rosewater Toner', 'Garnier', 'Skincare', 1000, 450, 26, 6, 'bottle', 'rose'],
    ['Hydrating Lip Gloss', 'NYX', 'Cosmetics', 900, 390, 45, 8, 'lipstick', 'rose'],
    ['Gentle Body Wash', 'Dove', 'Bodycare', 1100, 540, 32, 8, 'bottle', 'cream'],
    ['Velvet Finish Foundation', 'Maybelline', 'Cosmetics', 1700, 890, 30, 6, 'pump', 'sand'],
    ['Vitamin C Glow Serum', 'Garnier', 'Skincare', 1600, 790, 19, 6, 'dropper', 'peach'],
    ['Coconut Body Oil', 'Palmer’s', 'Bodycare', 1300, 650, 10, 6, 'bottle', 'sand'],
  ];
  items.forEach(([name, brand, category, price, cost, quantity, reorder, style, tone], i) => {
    state = addProduct(state, { name, brand, category, price: price * 600, cost: cost * 600, quantity, reorder, style, tone, sku: `VD-${String(i + 1).padStart(3, '0')}`, supplier: i % 2 ? 'Bloom Wholesale' : 'Beauty Supply Co.', batchCode: `LOT-${101 + i}`, expiry: dayOffset(i === 10 ? 35 : i === 11 ? -5 : 250 + i * 20) });
  });
  state.products.forEach(p => { p.createdAt = dayOffset(-60); p.batches.forEach(b => { b.received = dayOffset(-60); }); });
  state.movements.forEach(m => { m.date = dayOffset(-60); });
  for (let i = 34; i >= 0; i--) {
    const product = state.products[(i * 7 + 2) % 11];
    if (available(product) >= 2) state = recordSale(state, { lines: [{ productId: product.id, quantity: i % 4 === 0 ? 2 : 1 }], method: METHODS[i % 4], customerId: i % 3 === 0 ? '' : state.customers[(i * 5) % 6].id, discount: 0 }, dayOffset(-i));
    if (i % 5 === 0) state = recordSale(state, { lines: [{ productId: state.products[0].id, quantity: 2 }, { productId: state.products[1].id, quantity: 1 }], method: 'Card', customerId: state.customers[Math.floor(i / 5) % 6].id, discount: 90000 }, dayOffset(-i));
  }
  state = recordEntry(state, { type: 'expense', amount: 10800000, description: 'Monthly shop rent', category: 'Rent', method: 'Bank transfer', date: dayOffset(-12), party: 'Shop landlord' });
  state = recordEntry(state, { type: 'expense', amount: 2100000, description: 'Packaging & shopping bags', category: 'Supplies', method: 'Cash', date: dayOffset(-4) });
  state = recordEntry(state, { type: 'expense', amount: 1200000, description: 'Social media promotion', category: 'Marketing', method: 'Card', date: dayOffset(-2) });
  state.demo = true;
  state.demoExplicit = true;
  return state;
}
export function validateState(state) {
  requireValue(state && state.version === 1 && typeof state.demo === 'boolean' && state.settings && Array.isArray(state.products) && Array.isArray(state.transactions) && Array.isArray(state.movements), 'This is not a valid Videvas backup.');
  requireValue(state.demoExplicit === undefined || (typeof state.demoExplicit === 'boolean' && (!state.demoExplicit || state.demo)), 'Invalid demo workspace flag.');
  state = migrateCustomers(state);
  requireValue(Array.isArray(state.customers), 'Invalid customer list in backup.');
  requireValue(typeof state.settings.storeName === 'string' && state.settings.storeName.trim() && state.settings.storeName.length <= 80, 'Invalid shop name.');
  requireValue(typeof state.settings.currency === 'string' && /^[A-Z]{3}$/.test(state.settings.currency), 'Invalid currency.');
  requireValue([0, 2].includes(currencyDigits(state.settings.currency)), 'This workspace supports currencies with zero or two decimal places.');
  const productIds = new Set(), batchIds = new Set(), transactionIds = new Set(), skus = new Set(), customerIds = new Set();
  for (const customer of state.customers) {
    requireValue(typeof customer.id === 'string' && customer.id && !customerIds.has(customer.id) && typeof customer.archived === 'boolean' && validDate(customer.createdAt) && customer.createdAt <= today() && validDate(customer.updatedAt) && customer.updatedAt <= today(), 'Invalid or duplicate customer in backup.');
    for (const key of ['name', 'phone', 'email', 'address', 'notes']) requireValue(typeof customer[key] === 'string', 'Invalid customer details in backup.');
    const fields = customerFields(customer);
    uniqueContact(fields, state.customers, customer.id);
    customerIds.add(customer.id);
  }
  for (const p of state.products) {
    requireValue(typeof p.id === 'string' && !productIds.has(p.id) && Array.isArray(p.batches), 'Invalid or duplicate product.');
    validateProduct(p, { products: [], settings: state.settings });
    requireValue(typeof p.brand === 'string' && typeof p.supplier === 'string', 'Invalid product details.');
    requireValue(!skus.has(p.sku.toLowerCase()), 'Duplicate product SKU in backup.');
    skus.add(p.sku.toLowerCase()); productIds.add(p.id);
    for (const b of p.batches) {
      requireValue(typeof b.id === 'string' && !batchIds.has(b.id) && typeof b.code === 'string' && integer(b.quantity) && integer(b.cost) && validDate(b.received) && (!b.expiry || validDate(b.expiry)), 'Invalid stock batch in backup.');
      currencyAmount(b.cost, state);
      batchIds.add(b.id);
    }
  }
  for (const t of state.transactions) {
    requireValue(typeof t.id === 'string' && !transactionIds.has(t.id) && ['sale', 'refund', 'expense', 'income', 'purchase'].includes(t.type) && integer(t.amount, 1) && validDate(t.date) && METHODS.includes(t.method) && typeof t.description === 'string' && typeof t.reference === 'string' && typeof t.party === 'string' && typeof t.category === 'string', 'Invalid transaction in backup.');
    transactionIds.add(t.id);
    if (t.customerId !== undefined) requireValue(typeof t.customerId === 'string' && customerIds.has(t.customerId) && ['sale', 'refund'].includes(t.type), 'Transaction customer profile is missing or invalid.');
    currencyAmount(t.amount, state);
    if (['sale', 'refund', 'purchase'].includes(t.type)) {
      requireValue(Array.isArray(t.lines) && t.lines.length > 0, 'Transaction lines are missing.');
      for (const l of t.lines) {
        const p = state.products.find(p => p.id === l.productId);
        requireValue(p && typeof l.name === 'string' && integer(l.quantity, 1) && integer(l.cost), 'Invalid transaction line.');
        currencyAmount(l.cost, state);
        if (t.type !== 'purchase') {
          requireValue(integer(l.price, 1) && integer(l.netAmount) && Array.isArray(l.allocations) && l.allocations.length > 0, 'Invalid sale line.');
          currencyAmount(l.price, state); currencyAmount(l.netAmount, state);
          requireValue(l.allocations.every(a => p.batches.some(b => b.id === a.batchId) && integer(a.quantity, 1) && integer(a.cost)), 'Invalid batch allocation.');
          requireValue(l.allocations.reduce((s, a) => s + a.quantity, 0) === l.quantity && l.allocations.reduce((s, a) => s + a.quantity * a.cost, 0) === l.cost, 'Sale batch totals do not match.');
        } else requireValue(p.batches.some(b => b.id === l.batchId), 'Purchase batch is missing.');
      }
      if (t.type !== 'purchase') requireValue(integer(t.cost) && t.cost === t.lines.reduce((s, l) => s + l.cost, 0), 'Transaction cost does not match its lines.');
      if (t.type === 'sale') requireValue(integer(t.discount) && integer(t.subtotal, 1) && t.subtotal === t.lines.reduce((s, l) => s + l.quantity * l.price, 0) && t.subtotal - t.discount === t.amount, 'Sale totals do not match.');
      if (t.type !== 'purchase') requireValue(t.amount === t.lines.reduce((s, l) => s + l.netAmount, 0), 'Sale line revenues do not match.');
      if (t.type === 'purchase') requireValue(t.amount === t.lines.reduce((s, l) => s + l.quantity * l.cost, 0), 'Purchase total does not match.');
    }
  }
  const refunds = new Set();
  for (const t of state.transactions.filter(t => t.type === 'refund')) {
    const original = state.transactions.find(s => s.id === t.saleId && s.type === 'sale');
    requireValue(original && !refunds.has(t.saleId) && original.amount === t.amount && original.cost === t.cost && original.customerId === t.customerId && JSON.stringify(original.lines) === JSON.stringify(t.lines), 'Invalid sale refund.');
    refunds.add(t.saleId);
  }
  const balances = new Map();
  const movementIds = new Set();
  for (const m of state.movements) {
    requireValue(typeof m.id === 'string' && !movementIds.has(m.id) && productIds.has(m.productId) && state.products.find(p => p.id === m.productId).batches.some(b => b.id === m.batchId) && validDate(m.date) && Number.isSafeInteger(m.quantity) && m.quantity !== 0 && typeof m.type === 'string' && typeof m.reason === 'string' && (!m.transactionId || transactionIds.has(m.transactionId)), 'Invalid stock movement.');
    movementIds.add(m.id);
    balances.set(m.batchId, (balances.get(m.batchId) || 0) + m.quantity);
  }
  for (const p of state.products) for (const b of p.batches) requireValue((balances.get(b.id) || 0) === b.quantity, 'Stock quantities do not match movement history.');
  return state;
}
export function csv(rows) {
  return rows.map(row => row.map(value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
}
