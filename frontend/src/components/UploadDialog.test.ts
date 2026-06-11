import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import UploadDialog from './UploadDialog.svelte';
import { uploadState, trackUpload } from '../stores/uploadStore.svelte';

beforeEach(() => { uploadState.active = []; uploadState.dialog = null; });

describe('UploadDialog', () => {
  it('single mode shows filename input prefilled and message prefilled', async () => {
    const u = trackUpload('cat.png', 1234);
    uploadState.dialog = { mode: 'single', uploads: [u], message: 'hello' };
    render(UploadDialog, { onConfirm: vi.fn(), onCancel: vi.fn() });
    await expect.element(page.getByLabelText('Choose a file name')).toHaveValue('cat.png');
    await expect.element(page.getByLabelText('Add a message optional')).toHaveValue('hello');
  });

  it('confirm passes edited values', async () => {
    const onConfirm = vi.fn();
    const u = trackUpload('cat.png', 1234);
    uploadState.dialog = { mode: 'single', uploads: [u], message: '' };
    render(UploadDialog, { onConfirm, onCancel: vi.fn() });
    await userEvent.fill(page.getByLabelText('Add a message optional'), 'look at this');
    await userEvent.click(page.getByRole('button', { name: 'Upload' }));
    expect(onConfirm).toHaveBeenCalledWith({ filename: 'cat.png', message: 'look at this' });
  });

  it('cancel button triggers onCancel', async () => {
    const onCancel = vi.fn();
    const u = trackUpload('cat.png', 1234);
    uploadState.dialog = { mode: 'single', uploads: [u], message: '' };
    render(UploadDialog, { onConfirm: vi.fn(), onCancel });
    await userEvent.click(page.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
