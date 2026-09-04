import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installViewportTracker } from '../lib/viewport';

class FakeVisualViewport extends EventTarget {
  height = 800;
  scale = 1;
  offsetTop = 0;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

describe('installViewportTracker', () => {
  let vv: FakeVisualViewport;
  let uninstall: () => void = () => {};
  const root = document.documentElement;
  const realVV = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const realInner = Object.getOwnPropertyDescriptor(window, 'innerHeight');

  beforeEach(() => {
    vv = new FakeVisualViewport();
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  });
  afterEach(() => {
    uninstall();
    if (realVV) Object.defineProperty(window, 'visualViewport', realVV);
    if (realInner) Object.defineProperty(window, 'innerHeight', realInner);
    vi.restoreAllMocks();
  });

  it('leaves --app-height unset while the keyboard is closed', async () => {
    uninstall = installViewportTracker();
    await nextFrame();
    expect(root.style.getPropertyValue('--app-height')).toBe('');
  });

  it('publishes the visual viewport height and pins scroll when the keyboard opens', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    uninstall = installViewportTracker();
    vv.height = 480;
    vv.offsetTop = 120;
    vv.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(root.style.getPropertyValue('--app-height')).toBe('480px');
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('clears --app-height when the keyboard closes', async () => {
    uninstall = installViewportTracker();
    vv.height = 480;
    vv.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(root.style.getPropertyValue('--app-height')).toBe('480px');
    vv.height = 800;
    vv.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(root.style.getPropertyValue('--app-height')).toBe('');
  });

  it('ignores pinch-zoom (scale > 1)', async () => {
    uninstall = installViewportTracker();
    vv.height = 300;
    vv.scale = 2.5;
    vv.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(root.style.getPropertyValue('--app-height')).toBe('');
  });

  it('ignores small deltas such as URL-bar collapse', async () => {
    uninstall = installViewportTracker();
    vv.height = 760;
    vv.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(root.style.getPropertyValue('--app-height')).toBe('');
  });

  it('uninstall clears the property and stops listening', async () => {
    uninstall = installViewportTracker();
    vv.height = 480;
    vv.dispatchEvent(new Event('resize'));
    await nextFrame();
    uninstall();
    uninstall = () => {};
    expect(root.style.getPropertyValue('--app-height')).toBe('');
    vv.height = 400;
    vv.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(root.style.getPropertyValue('--app-height')).toBe('');
  });
});
