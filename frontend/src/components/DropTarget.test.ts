import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import DropTarget from './DropTarget.svelte';
import { ircState } from '../stores/ircStore.svelte';

function fileDragEvent(type: string): DragEvent {
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
  return new DragEvent(type, { bubbles: true, dataTransfer: dt, cancelable: true });
}

describe('DropTarget', () => {
  beforeEach(() => {
    ircState.activeBuffer.networkId = 'n';
    ircState.activeBuffer.bufferName = '#chan';
  });

  it('shows the overlay on dragover with files and hides after the fade timeout', async () => {
    vi.useFakeTimers();
    const screen = render(DropTarget, { onFilesDropped: vi.fn() });
    window.dispatchEvent(fileDragEvent('dragover'));
    await vi.waitFor(() => expect(document.querySelector('#dropTargetContainer.visible')).not.toBeNull());
    vi.advanceTimersByTime(1100);
    await vi.waitFor(() => expect(document.querySelector('#dropTargetContainer.visible')).toBeNull());
    vi.useRealTimers();
  });

  it('calls onFilesDropped with the dropped files', async () => {
    const onFilesDropped = vi.fn();
    render(DropTarget, { onFilesDropped });
    window.dispatchEvent(fileDragEvent('dragover'));
    window.dispatchEvent(fileDragEvent('drop'));
    await vi.waitFor(() => expect(onFilesDropped).toHaveBeenCalledTimes(1));
    expect(onFilesDropped.mock.calls[0][0].accepted[0].name).toBe('a.png');
  });
});
