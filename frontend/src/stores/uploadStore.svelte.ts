import type { UploadResponse } from '../lib/upload';

export type UploadStatus = 'uploading' | 'finalizing' | 'done' | 'error' | 'cancelled';

export interface ActiveUpload {
  id: number;
  filename: string;
  size: number;
  progress: number;
  status: UploadStatus;
  error?: string;
  result?: UploadResponse;
  abort?: () => void;
  file?: File | Blob;
  previewUrl?: string;
}

export interface DialogState {
  mode: 'single' | 'batch';
  uploads: ActiveUpload[];
  message: string;
  truncated?: boolean;
}

let nextId = 1;

export const uploadState = $state({
  active: [] as ActiveUpload[],
  dialog: null as DialogState | null,
  panelOpen: false,
  pastebinPanelOpen: false,
});

export function trackUpload(filename: string, size: number, file?: File | Blob): ActiveUpload {
  const u: ActiveUpload = {
    id: nextId++, filename, size, progress: 0, status: 'uploading', file,
    previewUrl: file ? URL.createObjectURL(file) : undefined,
  };
  uploadState.active.push(u);
  return uploadState.active[uploadState.active.length - 1];
}

function find(id: number): ActiveUpload | undefined {
  return uploadState.active.find(u => u.id === id);
}

export function setProgress(id: number, pct: number): void {
  const u = find(id);
  if (!u) return;
  u.progress = pct;
  if (pct >= 100 && u.status === 'uploading') u.status = 'finalizing';
}

export function finishUpload(id: number, result: UploadResponse): void {
  const u = find(id);
  if (u) { u.status = 'done'; u.progress = 100; u.result = result; }
}

export function failUpload(id: number, error: string): void {
  const u = find(id);
  if (u) { u.status = error === 'cancelled' ? 'cancelled' : 'error'; u.error = error; }
}

export function removeUpload(id: number): void {
  uploadState.active = uploadState.active.filter(u => u.id !== id);
}

export function aggregateProgress(): number {
  if (uploadState.active.length === 0) return 0;
  const total = uploadState.active.length * 100;
  const done = uploadState.active.reduce((s, u) => s + u.progress, 0);
  return Math.round((done / total) * 100);
}

export type RingState = 'idle' | 'active' | 'finalizing' | 'success' | 'error';

export function ringState(): RingState {
  const a = uploadState.active;
  if (a.length === 0) return 'idle';
  if (a.some(u => u.status === 'error')) return 'error';
  if (a.some(u => u.status === 'uploading')) return 'active';
  if (a.some(u => u.status === 'finalizing')) return 'finalizing';
  return 'success';
}
