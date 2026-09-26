import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import KlipyInline from './KlipyInline.svelte';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

afterEach(() => { vi.restoreAllMocks(); });

describe('KlipyInline', () => {
  it('renders the resolved rendition with attribution', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/embed/klipy?slug=johnny-depp-mad')) {
        return new Response(JSON.stringify({
          slug: 'johnny-depp-mad', title: 'Johnny Depp Mad', page: 'https://klipy.com/gifs/johnny-depp-mad',
          webp: { url: PNG, width: 300, height: 200 }, gif: null, mp4: null, poster: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    });
    render(KlipyInline, { props: { slug: 'johnny-depp-mad' } });
    const img = page.getByAltText('Johnny Depp Mad');
    await expect.element(img).toBeInTheDocument();
    const el = img.element() as HTMLImageElement;
    expect(el.getAttribute('src')).toBe(PNG);
    expect(el.closest('a')?.getAttribute('href')).toBe('https://klipy.com/gifs/johnny-depp-mad');
    // Once the pixel decodes the attribution badge and close control appear.
    await expect.element(page.getByText('via KLIPY')).toBeInTheDocument();
  });

  it('renders nothing when the gateway has no KLIPY key (503)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"klipy embeds are not configured"}', { status: 503 }));
    const { container } = render(KlipyInline, { props: { slug: 'anything' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('.klipyWrap')).toBeNull();
  });
});
