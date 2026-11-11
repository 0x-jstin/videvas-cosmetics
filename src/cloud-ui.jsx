import React from 'react';
import { AlertTriangle, Cloud, RotateCcw, WifiOff } from 'lucide-react';
import { useAsyncAction } from './useAsyncAction.js';

export function saveIsBlocked(cloud) {
  return cloud.writing || cloud.pending || cloud.status === 'syncing' || cloud.status === 'offline' || cloud.needsRefresh;
}

export function ConnectionNotice({ cloud, onRetry }) {
  const { busy, run, error } = useAsyncAction();
  if (!cloud.error && !['saving', 'pending', 'offline', 'syncing'].includes(cloud.status)) return null;
  const saving = cloud.writing, checking = cloud.status === 'syncing';
  const Icon = cloud.status === 'offline' ? WifiOff : saving || checking ? Cloud : AlertTriangle;
  const message = saving ? 'Saving to your account…' : checking ? 'Checking your latest records…' : cloud.error;
  return <div className={`cloud-notice ${saving || checking ? 'quiet' : ''}`} role={saving || checking ? 'status' : 'alert'}>
    <Icon size={18} /><span>{error || message}</span>
    {!saving && !checking && <button type="button" className="text-button" disabled={busy || cloud.status === 'offline'} onClick={() => void run(onRetry)}><RotateCcw size={14} />{busy ? 'Checking…' : cloud.pending ? 'Check previous save' : 'Sync now'}</button>}
  </div>;
}

export function storageLabel(cloud) {
  if (cloud.writing) return 'Saving to your account';
  if (cloud.pending) return 'Save needs confirmation';
  if (cloud.status === 'offline') return 'Offline';
  if (cloud.status === 'syncing') return 'Checking latest records';
  if (cloud.error) return 'Sync needs attention';
  return 'Saved to your account';
}
