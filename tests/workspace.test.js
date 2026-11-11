import test from 'node:test';
import assert from 'node:assert/strict';
import { addCustomer, createDemo, emptyState, validateState } from '../src/model.js';
import { activateDemo, hasWorkspaceRecords, prepareWorkspace } from '../src/workspace.js';

test('new workspaces start empty, with CFA settings and no automatic demo data', () => {
  const result = prepareWorkspace(null);
  assert.equal(result.state.demo, false);
  assert.equal(result.state.settings.currency, 'XOF');
  assert.equal(hasWorkspaceRecords(result.state), false);
  assert.equal(result.needsWrite, true);
});
test('old automatically seeded demo data clears once, preserving shop settings', () => {
  const oldDemo = createDemo(); delete oldDemo.demoExplicit;
  oldDemo.settings.storeName = 'My Beauty Shop';
  const result = prepareWorkspace(JSON.stringify(oldDemo));
  assert.equal(result.state.demo, false);
  assert.equal(hasWorkspaceRecords(result.state), false);
  assert.deepEqual(result.state.settings, oldDemo.settings);
  assert.equal(result.needsWrite, true);
  const persisted = prepareWorkspace(JSON.stringify(result.state));
  assert.equal(persisted.needsWrite, false);
});
test('demo data loaded explicitly survives reload and includes linked customers', () => {
  const empty = emptyState({ storeName: 'My Beauty Shop' });
  const demo = activateDemo(empty);
  assert.equal(demo.demo, true);
  assert.equal(demo.demoExplicit, true);
  assert.equal(demo.settings.storeName, empty.settings.storeName);
  assert.equal(demo.products.length, 12);
  assert.equal(demo.customers.length, 6);
  validateState(demo);
  assert.deepEqual(prepareWorkspace(JSON.stringify(demo)).state, demo);
  assert.equal(hasWorkspaceRecords(empty), false);
});
test('saved shop records survive startup and cannot be overwritten by the demo loader', () => {
  const state = addCustomer(emptyState(), { name: 'Actual customer' });
  const raw = JSON.stringify(state);
  assert.deepEqual(prepareWorkspace(raw).state, state);
  assert.equal(prepareWorkspace(raw).needsWrite, false);
  assert.throws(() => activateDemo(state), /empty workspace/);
  assert.equal(JSON.stringify(state), raw);
});
