export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_UPLOAD_BATCH = 10;
const FILE_BLACKLIST = new Set(['.DS_Store']);

export interface FileLike { name: string; type: string; size: number; }

export function isUploadableImage(mime: string): boolean {
  return /^image\//i.test(mime);
}

export function validateFile(file: FileLike): string | null {
  if (!isUploadableImage(file.type)) return 'Only images are supported';
  if (file.size > MAX_UPLOAD_BYTES) return 'File too large (max 200 MB)';
  if (file.size <= 0) return 'Empty file';
  return null;
}

export function dataURIToBlob(uri: string): Blob | null {
  const m = uri.match(/^data:([^;]+);base64,([a-z0-9+/]+=*)$/i);
  if (!m) return null;
  let bytes: string;
  try { bytes = atob(m[2]); } catch { return null; }
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type: m[1] });
  return blob.size > 0 ? blob : null;
}

export function joinMessageLink(message: string, url: string): string {
  const msg = message.trimEnd();
  return msg ? `${msg} ${url}` : url;
}

export function flattenFileList(files: File[] | FileLike[]): { accepted: File[]; truncated: boolean } {
  const ok = (files as File[]).filter(f => !FILE_BLACKLIST.has(f.name) && f.size > 0);
  return { accepted: ok.slice(0, MAX_UPLOAD_BATCH), truncated: ok.length > MAX_UPLOAD_BATCH };
}

export async function collectDroppedFiles(dt: DataTransfer): Promise<{ accepted: File[]; truncated: boolean }> {
  const entries = Array.from(dt.items ?? [])
    .map(i => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) return flattenFileList(Array.from(dt.files ?? []));

  const out: File[] = [];
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (out.length > MAX_UPLOAD_BATCH) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length > 0 && out.length <= MAX_UPLOAD_BATCH);
    }
  }
  for (const e of entries) await walk(e);
  return flattenFileList(out);
}

export interface UploadResponse {
  id: string; url: string; pageUrl: string; name: string; size: number;
}

export interface UploadHandle {
  promise: Promise<UploadResponse>;
  abort: () => void;
}

export function uploadFile(
  file: File | Blob,
  opts: { filename: string; networkId: string; buffer: string; onProgress?: (pct: number) => void },
  xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest(),
): UploadHandle {
  const xhr = xhrFactory();
  const promise = new Promise<UploadResponse>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, opts.filename);
    form.append('filename', opts.filename);
    form.append('networkId', opts.networkId);
    form.append('buffer', opts.buffer);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && opts.onProgress) opts.onProgress(Math.round((e.loaded * 100) / e.total));
    });
    xhr.addEventListener('load', () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadResponse);
        else reject(new Error(body.error ?? `Upload failed (${xhr.status})`));
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed (network error)')));
    xhr.addEventListener('abort', () => reject(new Error('cancelled')));
    xhr.open('POST', '/api/upload');
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export function sizeToString(size: number): string {
  if (size > 1_000_000) return (size / 1_000_000).toFixed(1) + ' MB';
  if (size > 1_000) return Math.round(size / 1_000) + ' KB';
  return size + ' B';
}
