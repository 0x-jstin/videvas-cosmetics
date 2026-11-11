import { createDemo, emptyState, validateState } from './model.js';

export function prepareWorkspace(raw) {
  if (raw === null) return { state: emptyState(), needsWrite: true };
  const saved = validateState(JSON.parse(raw));
  // Clear the automatically seeded workspace once. Demo data loaded deliberately
  // through Settings remains available after a reload.
  const state = saved.demo && !saved.demoExplicit ? emptyState(saved.settings) : saved;
  return { state, needsWrite: JSON.stringify(state) !== raw };
}

export function hasWorkspaceRecords(state) {
  return [state.products, state.customers, state.transactions, state.movements].some(records => records.length > 0);
}

export function activateDemo(state) {
  if (hasWorkspaceRecords(state)) throw new Error('Start with an empty workspace before loading demo data.');
  const demo = createDemo();
  demo.settings = { ...state.settings };
  return demo;
}
