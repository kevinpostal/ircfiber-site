import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SettingsAdvanced from './SettingsAdvanced.svelte';
import { globalPrefs, DEFAULT_PREFS } from '../stores/preferences.svelte';

beforeEach(() => {
	// Reset to defaults so toggles from a prior test don't leak state
	Object.assign(globalPrefs, DEFAULT_PREFS);
});

describe('SettingsAdvanced (W0-T01)', () => {
	it('renders a "Feature flags (advanced)" section', async () => {
		render(SettingsAdvanced);
		const heading = page.getByText('Feature flags (advanced)');
		await expect.element(heading).toBeInTheDocument();
	});

	it('renders all 5 toggles, each defaulting to off', async () => {
		render(SettingsAdvanced);

		// Five labeled toggles, one per Wave 1 task
		await expect.element(page.getByText(/Sync prefs across devices \(prefVersion resolution\)/)).toBeInTheDocument();
		await expect.element(page.getByText(/Heartbeat \(W1-T03\)/)).toBeInTheDocument();
		await expect.element(page.getByText(/Edit-message wire \(W1-T04\)/)).toBeInTheDocument();
		await expect.element(page.getByText(/buffersToDelete wire \(W1-T06\)/)).toBeInTheDocument();
		await expect.element(page.getByText(/Idle events \(W1-T08\)/)).toBeInTheDocument();

		// All 5 switches start unchecked (default OFF)
		const switches = page.getByRole('switch').all();
		expect(switches.length).toBe(5);
	});

	it('aria-checked reflects the globalPrefs.featureFlags state', async () => {
		globalPrefs.featureFlags.heartbeat.enabled = true;
		render(SettingsAdvanced);

		// All switches expose aria-checked for assistive tech (WCAG AA)
		const heartbeatSwitch = page.getByRole('switch', { name: /Heartbeat/ });
		await expect.element(heartbeatSwitch).toHaveAttribute('aria-checked', 'true');

		const prefVersionSwitch = page.getByRole('switch', { name: /prefVersion/ });
		await expect.element(prefVersionSwitch).toHaveAttribute('aria-checked', 'true');
	});

	it('toggling a switch updates globalPrefs.featureFlags (round-trip)', async () => {
		render(SettingsAdvanced);
		const heartbeatSwitch = page.getByRole('switch', { name: /Heartbeat/ });

		// Default off
		expect(globalPrefs.featureFlags.heartbeat.enabled).toBe(false);

		// Click the switch
		await heartbeatSwitch.click();

		// globalPrefs is updated via bind:checked
		expect(globalPrefs.featureFlags.heartbeat.enabled).toBe(true);
	});
});