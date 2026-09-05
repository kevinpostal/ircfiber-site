/**
 * Mullvad.svelte — the operator's control surface for the SOCKS egress slots.
 *
 * Coverage, all of it driven by the user-visible gaps this page had:
 *  1. A slot carrying live connections is still swappable — every slot on a
 *     busy deployment is in use, so a disabled Swap meant the exits could
 *     never be changed at all. The confirm has to say what it costs and the
 *     POST has to carry `force`.
 *  2. An idle slot swaps without `force`.
 *  3. The Mullvad verdict from am.i.mullvad.net is surfaced per slot and
 *     counted in the header — that is the "is the licence working" signal.
 *  4. "Test IRC" posts to the irc-test endpoint with the chosen host and
 *     reports the server that answered.
 *  5. The add-exit dialog is a runbook naming both inventories, not a button
 *     that pretends to provision a container.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import Mullvad from './Mullvad.svelte';
import * as ui from '/src/admin/stores/ui';
import { api } from '/src/admin/lib/api-client';

const mockedGet = api.get as unknown as Mock;
const mockedPost = api.post as unknown as Mock;

vi.mock('/src/admin/lib/api-client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class extends Error {
    readonly status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
}));

vi.mock('/src/admin/stores/ui', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  pollingEnabled: { subscribe: (run: (v: boolean) => void) => { run(true); return () => {}; }, set: vi.fn(), update: vi.fn() },
}));

vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn((fetcher: () => unknown) => { void fetcher(); return () => {}; }),
}));

const slot = (over: Record<string, unknown> = {}) => ({
  id: 'de', label: 'de', host: 'tailscale-mullvad-de', port: 1055,
  socksUrl: 'socks5://tailscale-mullvad-de:1055', ip: '10.0.0.5',
  container: 'tailscale-mullvad-de', containerState: 'running', containerStatus: 'Up 2 hours',
  tailscaleExitNode: '', ipinfo: { ip: '151.241.171.69', city: 'Berlin', region: '', country: 'Germany', loc: '', org: '', postal: '', timezone: '', hostname: '' },
  healthy: true, error: '', lastTestedAt: new Date().toISOString(),
  mullvadExit: true, mullvadHostname: 'de-ber-wg-003', organization: 'Mullvad VPN AB',
  locationId: 'de-ber', city: 'Berlin', country: 'Germany', state: 'ready',
  activeConns: 2, heldUntilMs: 0, controllable: true,
  ...over,
});

const fixture = (over: Record<string, unknown> = {}) => ({
  pool: [slot(), slot({ id: 'ch', label: 'ch', container: 'tailscale-mullvad-ch', locationId: 'ch-zrh', city: 'Zurich', country: 'Switzerland', activeConns: 0, mullvadExit: false, organization: 'PebbleHost Ltd', mullvadHostname: '' })],
  count: 2,
  poolRaw: 'socks5://de@tailscale-mullvad-de:1055,socks5://ch@tailscale-mullvad-ch:1055',
  poolCount: 2, desiredCount: 2,
  usage: {}, associations: [], liveConnections: {}, liveConnectionsTotal: 0,
  servers: [], serverEgress: [],
  locations: [
    { id: 'se-sto', country: 'Sweden', countryCode: 'se', city: 'Stockholm', relays: 3 },
    { id: 'de-ber', country: 'Germany', countryCode: 'de', city: 'Berlin', relays: 4 },
  ],
  ...over,
});

async function mount(data = fixture()) {
  mockedGet.mockResolvedValue(data);
  render(Mullvad);
  await expect.element(page.getByText('Proxy Pool')).toBeInTheDocument();
}

/** Pick a city in the slot's row and press Swap. */
async function pickAndSwap(rowText: string, city: string) {
  const rows = [...document.querySelectorAll('tbody tr')];
  const row = rows.find((r) => r.textContent?.includes(rowText) && r.querySelector('select'));
  if (!row) throw new Error(`no swap row for ${rowText}`);
  const sel = row.querySelector('select') as HTMLSelectElement;
  const opt = [...sel.options].find((o) => o.textContent?.trim().startsWith(city));
  if (!opt) throw new Error(`no option ${city}`);
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  // Let Svelte's binding react before reading the button's disabled state.
  await new Promise((r) => setTimeout(r, 40));
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Swap') as HTMLButtonElement;
  expect(btn, 'Swap button present').toBeTruthy();
  expect(btn.disabled, 'Swap is clickable even when the slot is in use').toBe(false);
  btn.click();
  await new Promise((r) => setTimeout(r, 60));
}

const confirmDialog = () => document.querySelector('[role="dialog"]');
async function confirmIt(label: string) {
  const btn = [...(confirmDialog()?.querySelectorAll('button') ?? [])]
    .find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
  expect(btn, `confirm button "${label}"`).toBeTruthy();
  btn.click();
  await new Promise((r) => setTimeout(r, 120));
}

describe('Mullvad.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPost.mockResolvedValue({});
    document.body.innerHTML = '';
  });

  it('swaps a slot that is carrying connections, with force and a warning', async () => {
    await mount();

    await pickAndSwap('Berlin', 'Stockholm');

    // The confirm must state the cost rather than just asking.
    const dlg = confirmDialog();
    expect(dlg?.textContent).toContain('2 live IRC connections');
    expect(dlg?.textContent).toContain('Stockholm');

    await confirmIt('Move and reconnect');

    expect(mockedPost).toHaveBeenCalledWith('/api/admin/mullvad/de/exit', { locationId: 'se-sto', force: true });
    expect(ui.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('2 connections reconnecting'));
  });

  it('swaps an idle slot without forcing', async () => {
    await mount();

    await pickAndSwap('Zurich', 'Stockholm');
    expect(confirmDialog()?.textContent).toContain('no IRC connection is touched');
    await confirmIt('Move exit');

    expect(mockedPost).toHaveBeenCalledWith('/api/admin/mullvad/ch/exit', { locationId: 'se-sto', force: false });
  });

  it('shows the Mullvad verdict per slot and counts it in the header', async () => {
    await mount();

    // de is a verified Mullvad exit, ch is exiting on the host's own uplink.
    const body = document.body.innerText;
    expect(body).toContain('de-ber-wg-003');
    expect(body).toContain('not Mullvad');
    expect(body).toContain('PebbleHost Ltd');
    // Header stat: 1 of 2 verified.
    expect(body).toContain('1/2');
  });

  it('drives a real IRC registration through a slot and reports the server', async () => {
    await mount();
    mockedPost.mockResolvedValue({
      label: 'de', host: 'irc.ircfiber.com', port: 6667, nick: 'fbprobe1234',
      socksOk: true, registered: true, serverName: 'irc.ircfiber.com', welcome: ':irc 001 …',
      ms: 412, error: '',
    });

    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test IRC') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await new Promise((r) => setTimeout(r, 120));

    // The default target is a third-party network on purpose: our own ircd
    // hairpins and can never be reached through an exit.
    expect(mockedPost).toHaveBeenCalledWith('/api/admin/mullvad/de/irc-test', { host: 'irc.libera.chat', port: 6667 });
    expect(ui.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('IRC OK via irc.ircfiber.com'));
    expect(document.body.innerText).toContain('IRC ok');
  });

  it('surfaces an IRC probe failure instead of claiming success', async () => {
    await mount();
    mockedPost.mockResolvedValue({
      label: 'de', host: 'irc.supernets.org', port: 6667, nick: 'fbprobe4321',
      socksOk: true, registered: false, serverName: '', welcome: '',
      ms: 900, error: 'server refused registration: :srv 465 * :You are banned',
    });

    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test IRC') as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 120));

    expect(ui.toastError).toHaveBeenCalledWith(expect.stringContaining('You are banned'));
    expect(document.body.innerText).toContain('IRC failed');
  });

  it('explains how to add a slot instead of pretending to provision one', async () => {
    await mount();

    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add exit…') as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 80));

    const text = document.body.innerText;
    expect(text).toContain('mullvad_sidecars');
    expect(text).toContain('deploy-engine.yml');
    // Both inventories must be named — they drift otherwise.
    expect(text).toContain('host_vars/vps-efb4b52d.yml');
    expect(text).toContain('group_vars/all/vars.yml');
    // And the licence constraint, which is what actually caps slot count.
    expect(text).toContain('device');
    // No POST fired: this dialog only tells the operator what to run.
    expect(mockedPost).not.toHaveBeenCalled();
  });
});
