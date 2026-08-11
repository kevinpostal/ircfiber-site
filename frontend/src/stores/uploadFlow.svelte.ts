import { uploadFile, validateFile, flattenFileList, joinMessageLink, type UploadHandle, type UploadResponse } from '../lib/upload';
import { isTextFile, detectSyntaxFromFilename, MAX_TEXT_FILE_BYTES } from '../lib/textFiles';
import { uploadState, trackUpload, setProgress, finishUpload, failUpload, removeUpload, type ActiveUpload } from './uploadStore.svelte';
import { openFromFile } from './pastebinStore.svelte';
import { sendMessage } from './wsConnection.svelte.ts';
import { ircState } from './ircStore.svelte';
import { generateLabel } from '../lib/utils';
import type { IRCMessage } from '../types';
export interface UploadFlowDeps {
  uploader: typeof uploadFile;
  send: (networkId: string, target: string, text: string, label?: string) => void;
  getInputText: () => string;
  setInputText: (text: string) => void;
  clearInput: () => void;
  notifyError: (msg: string) => void;
}

let deps: UploadFlowDeps = {
  uploader: uploadFile,
  send: sendMessage,
  getInputText: () => '',
  setInputText: () => {},
  clearInput: () => {},
  notifyError: (msg) => console.error('[upload]', msg),
};

export function setDeps(overrides: Partial<UploadFlowDeps>): void {
  deps = { ...deps, ...overrides };
}

interface PendingUpload extends ActiveUpload { handle: UploadHandle; }
const handles = new Map<number, UploadHandle>();

export async function startUploads(
  files: File[] | Blob[],
  opts: { networkId: string; buffer: string; immediate?: boolean },
): Promise<void> {
  // IRCCloud parity: a single text file (text/* or known code extension)
  // under MAX_TEXT_FILE_BYTES opens the snippet/pastebin dialog with syntax
  // auto-detected from the filename — it does NOT go through /api/upload.
  // Mirrors common.js o1Zz doUpload: `s.isText(l.type)` => FileReader.readAsText
  // => pasteConfirm flow. Size guard matches n.MAX_LENGTH_BYTES 15,728,640.
  const maybeCandidate = files[0] as File | undefined;
  const isSingleFile = files.length === 1 && !!maybeCandidate && typeof maybeCandidate.name === 'string' && typeof maybeCandidate.size === 'number';
  if (isSingleFile) {
    const maybeText = maybeCandidate as File;
    if (isTextFile(maybeText)) {
      if (maybeText.size === 0) {
        deps.notifyError(`${maybeText.name}: Empty file`);
        return;
      }
      if (maybeText.size > MAX_TEXT_FILE_BYTES) {
        deps.notifyError(`${maybeText.name}: File too large (max ${Math.round(MAX_TEXT_FILE_BYTES / 1e6)} MB)`);
        return;
      }
      try {
        const text = await maybeText.text();
        if (text.length === 0) {
          deps.notifyError(`${maybeText.name}: Empty file`);
          return;
        }
        const lang = detectSyntaxFromFilename(maybeText.name);
        openFromFile({
          text,
          filename: maybeText.name,
          language: lang,
          networkId: opts.networkId,
          target: opts.buffer,
        });
        return;
      } catch (e) {
        deps.notifyError(`${maybeText.name}: Could not read file`);
        return;
      }
    }
  }


  const { accepted, truncated } = flattenFileList(
    (files as (File | Blob)[]).map(f => (f instanceof File ? f : new File([f], 'pasted-image.png', { type: f.type || 'image/png' })))
  );
  const valid: File[] = [];
  for (const f of accepted) {
    const err = validateFile(f);
    if (err) deps.notifyError(`${f.name}: ${err}`);
    else valid.push(f);
  }
  if (valid.length === 0) return;

  const uploads = valid.map((f) => {
    const u = trackUpload(f.name, f.size, f);
    const handle = deps.uploader(f, {
      filename: f.name,
      networkId: opts.networkId,
      buffer: opts.buffer,
      onProgress: (pct) => setProgress(u.id, pct),
    });
    handles.set(u.id, handle);
    handle.promise
      .then((r: UploadResponse) => finishUpload(u.id, r))
      .catch((e: Error) => failUpload(u.id, e.message));
    return u;
  });

  if (opts.immediate) {
    void finalizeAndSend(uploads, '', opts);
  } else {
    uploadState.dialog = {
      mode: uploads.length === 1 ? 'single' : 'batch',
      uploads,
      message: deps.getInputText(),
      truncated,
    };
  }
}

export function confirmDialog(data: { filename?: string; message: string }): void {
  const dialog = uploadState.dialog;
  if (!dialog) return;
  uploadState.dialog = null;

  if (data.filename && dialog.uploads.length === 1) dialog.uploads[0].filename = data.filename;

  void (async () => {
    const results = await Promise.allSettled(dialog.uploads.map(u => handles.get(u.id)!.promise));
    const urls: string[] = [];
    for (const r of results) if (r.status === 'fulfilled') urls.push(r.value.url);

    // Clean up handles
    for (const u of dialog.uploads) {
      handles.delete(u.id);
      setTimeout(() => removeUpload(u.id), 1500);
    }

    if (urls.length === 0) {
      const firstErr = dialog.uploads.find(u => u.error)?.error ?? 'upload failed';
      deps.notifyError(firstErr);
      return;
    }

    const text = joinMessageLink(data.message, urls.join(' '));
    deps.setInputText(text);
  })();
}

export function cancelDialog(): void {
  const dialog = uploadState.dialog;
  if (!dialog) return;
  uploadState.dialog = null;
  for (const u of dialog.uploads) {
    handles.get(u.id)?.abort();
    handles.delete(u.id);
    removeUpload(u.id);
  }
}

async function finalizeAndSend(
  uploads: ActiveUpload[],
  message: string,
  opts: { networkId: string; buffer: string },
): Promise<void> {
  const label = generateLabel();
  const names = uploads.map(u => u.filename).join(', ');
  const key = `${opts.networkId}:${opts.buffer}`;
  const optimistic: IRCMessage = {
    timestamp: new Date().toISOString(), t: Date.now(),
    nick: '', text: `Uploading ${names}…`, command: 'PRIVMSG', label,
  };
  if (opts.networkId && opts.buffer) {
    ircState.optimisticMessages.set(label, optimistic);
    const list = ircState.messages[key] ?? [];
    list.push(optimistic);
    ircState.messages[key] = list;
  }

  const results = await Promise.allSettled(uploads.map(u => handles.get(u.id)!.promise));
  const urls: string[] = [];
  for (const r of results) if (r.status === 'fulfilled') urls.push(r.value.url);

  for (const u of uploads) { handles.delete(u.id); setTimeout(() => removeUpload(u.id), 1500); }

  if (urls.length === 0) {
    ircState.optimisticMessages.delete(label);
    ircState.messages[key] = (ircState.messages[key] ?? []).filter(m => m.label !== label);
    const firstErr = uploads.find(u => u.error)?.error ?? 'upload failed';
    deps.notifyError(firstErr);
    return;
  }

  const text = joinMessageLink(message, urls.join(' '));
  optimistic.text = text;
  deps.send(opts.networkId, opts.buffer, text, label);
}
