import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import ServerFeaturesPanel from './ServerFeaturesPanel.svelte';

beforeEach(() => {
  localStorage.clear();
});

describe('ServerFeaturesPanel — whole-panel collapse', () => {
  it('starts collapsed by default (no localStorage entry)', () => {
    render(ServerFeaturesPanel, {
      props: { isupport: { NETWORK: 'irc.example', CHANTYPES: '#' } },
    });

    const toggle = document.querySelector('[data-testid="server-features-panel-toggle"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The categories section is hidden when collapsed — header stays visible.
    expect(document.querySelector('[data-testid="server-features-panel-categories"]')).toBeNull();
  });

  it('respects a previously-persisted collapsed state from localStorage', () => {
    localStorage.setItem('ircfiber:serverFeaturesCollapsed', JSON.stringify(true));

    render(ServerFeaturesPanel, {
      props: { isupport: { NETWORK: 'irc.example', CHANTYPES: '#' } },
    });

    const toggle = document.querySelector('[data-testid="server-features-panel-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Categories section is hidden when collapsed.
    expect(document.querySelector('[data-testid="server-features-panel-categories"]')).toBeNull();
  });

  it('clicking the header toggle collapses and expands the panel body', async () => {
    render(ServerFeaturesPanel, {
      props: { isupport: { NETWORK: 'irc.example', CHANTYPES: '#' } },
    });

    const toggle = document.querySelector('[data-testid="server-features-panel-toggle"]') as HTMLButtonElement;

    // Start collapsed (new default)
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-testid="server-features-panel-categories"]')).toBeNull();

    // Click to expand
    toggle.click();
    await tick();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-testid="server-features-panel-categories"]')).toBeTruthy();

    // Click to collapse again
    toggle.click();
    await tick();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-testid="server-features-panel-categories"]')).toBeNull();
  });

  it('persists the collapsed state to localStorage after toggle', async () => {
    render(ServerFeaturesPanel, {
      props: { isupport: { NETWORK: 'irc.example', CHANTYPES: '#' } },
    });

    const toggle = document.querySelector('[data-testid="server-features-panel-toggle"]') as HTMLButtonElement;

    // Start collapsed (true in storage after mount)
    expect(localStorage.getItem('ircfiber:serverFeaturesCollapsed')).toBe('true');
    toggle.click();
    await tick();
    expect(localStorage.getItem('ircfiber:serverFeaturesCollapsed')).toBe('false');

    toggle.click();
    await tick();
    expect(localStorage.getItem('ircfiber:serverFeaturesCollapsed')).toBe('true');
  });

  it('toggle carries the panel-level aria-controls + label', () => {
    render(ServerFeaturesPanel, {
      props: { isupport: { NETWORK: 'irc.example', CHANTYPES: '#' } },
    });

    const toggle = document.querySelector('[data-testid="server-features-panel-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-controls')).toBe('server-features-panel-body');
    expect(toggle.getAttribute('aria-label')).toBe('Expand Server features');
  });

  it('applies a collapsed class on the section element', async () => {
    render(ServerFeaturesPanel, {
      props: { isupport: { NETWORK: 'irc.example', CHANTYPES: '#' } },
    });

    const section = document.querySelector('[data-testid="server-features-panel"]') as HTMLElement;
    expect(section.className).toContain('server-features-panel--collapsed');

    (document.querySelector('[data-testid="server-features-panel-toggle"]') as HTMLButtonElement).click();
    await tick();
    expect(section.className).not.toContain('server-features-panel--collapsed');
  });

  it('still shows stats + eyebrow when collapsed (so the user sees counts)', async () => {
    localStorage.setItem('ircfiber:serverFeaturesCollapsed', JSON.stringify(true));

    render(ServerFeaturesPanel, {
      props: { isupport: { NETWORK: 'irc.example', CHANTYPES: '#', NICKLEN: '30' } },
    });

    // Stats row stays visible in the header — the toggle is the whole header.
    // (Total includes NETWORK= + CHANTYPES + NICKLEN = 3.)
    expect(document.querySelector('[data-testid="sfp-stat-total"]')!.textContent).toContain('3');
    expect(document.querySelector('[data-testid="server-features-panel-toggle"]')).toBeTruthy();
    // But the per-category rows are not rendered.
    expect(document.querySelector('[data-testid="server-features-panel-cat"]')).toBeNull();
  });

  it('collapse works alongside the dense embed mode', async () => {
    render(ServerFeaturesPanel, {
      props: {
        isupport: { NETWORK: 'irc.example', CHANTYPES: '#' },
        dense: true,
      },
    });

    const section = document.querySelector('[data-testid="server-features-panel"]') as HTMLElement;
    expect(section.className).toContain('server-features-panel--dense');
    // Dense embed now starts with the whole panel collapsed (collapsed by default on connect).
    expect(section.className).toContain('server-features-panel--collapsed');

    // Each category starts collapsed in dense mode (existing behaviour).
    expect(document.querySelector('[data-testid="server-features-panel-rows"]')).toBeNull();

    // The panel-level toggle still works independently — click to expand.
    const toggle = document.querySelector('[data-testid="server-features-panel-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await tick();
    expect(section.className).not.toContain('server-features-panel--collapsed');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});