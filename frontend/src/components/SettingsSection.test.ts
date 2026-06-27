import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SettingsSection from './SettingsSection.svelte';

describe('SettingsSection', () => {
	it('renders heading when provided', async () => {
		render(SettingsSection, {
			heading: 'Interface',
			children: () => '',
		});
		const heading = page.getByText('Interface');
		await expect.element(heading).toBeInTheDocument();
	});

	it('does not render heading element when heading is empty', async () => {
		render(SettingsSection, {
			heading: '',
			children: () => '',
		});
		const h3 = page.getByRole('heading').all();
		expect(h3.length).toBe(0);
	});

	it('renders a <section> element with aria-label when heading present', async () => {
		render(SettingsSection, {
			heading: 'Test Section',
			children: () => '',
		});
		const section = page.getByRole('region', { name: 'Test Section' });
		await expect.element(section).toBeInTheDocument();
	});

	it('renders <section> without aria-label when heading empty', async () => {
		const { container } = render(SettingsSection, {
			heading: '',
			children: () => '',
		});
		const section = container.querySelector('section');
		expect(section).toBeTruthy();
		expect(section?.getAttribute('aria-label')).toBeFalsy();
	});

	it('renders body div inside section', async () => {
		const { container } = render(SettingsSection, {
			heading: 'Test',
			children: () => '',
		});
		const section = container.querySelector('section');
		const body = section?.querySelector('.settings-section__body');
		expect(body).toBeTruthy();
	});
});
