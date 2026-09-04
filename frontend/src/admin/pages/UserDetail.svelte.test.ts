/**
 * UserDetail.svelte — roles are edited with the Django-style
 * filter_horizontal chooser, not a free-text field.
 *
 * Coverage:
 *  1. Roles from GET /api/admin/roles populate Available; the user's roles sit in Chosen.
 *  2. Choosing a role and saving POSTs the roles array (no string splitting).
 *  3. Editing your own account locks `admin` so you cannot strip it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';

import UserDetail from './UserDetail.svelte';
import { api } from '/src/admin/lib/api-client';
import { adminUser } from '/src/admin/stores/auth';

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
}));

vi.mock('/src/admin/lib/router', () => ({ navigate: vi.fn() }));

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>;

const userFixture = (roles: string[]) => ({
  id: 'u1',
  username: 'alice',
  email: 'alice@example.com',
  roles,
  signupIp: '127.0.0.1',
  lastLoginIp: '127.0.0.1',
  loginIps: ['127.0.0.1'],
  createdAt: 1_700_000_000,
  uploadCount: 0,
  networks: [],
  uploads: [],
});

const rolesFixture = () => ({
  roles: [
    { name: 'admin', description: 'Full access', builtin: true, users: 1 },
    { name: 'user', description: 'Default role', builtin: true, users: 2 },
    { name: 'mod', description: 'Custom role', builtin: false, users: 1 },
  ],
});

function values(sel: string): string[] {
  return [...document.querySelectorAll<HTMLOptionElement>(`${sel} option`)].map((o) => o.value);
}

describe('UserDetail.svelte — roles chooser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminUser.set({ id: 'me', username: 'root', email: 'r@x', roles: ['admin', 'user'], isAdmin: true });
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/users/u1') return Promise.resolve(userFixture(['user']));
      if (path === '/api/admin/roles') return Promise.resolve(rolesFixture());
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockResolvedValue({});
  });

  it('renders Available / Chosen roles from the catalogue and the user', async () => {
    render(UserDetail, { props: { userId: 'u1' } });
    await expect.element(page.getByText('Chosen roles')).toBeInTheDocument();
    await vi.waitFor(() => expect(values('#editRoles-available')).toEqual(['admin', 'mod']));
    expect(values('#editRoles-chosen')).toEqual(['user']);
    expect(document.querySelector('input#editRoles')).toBeNull();
  });

  it('choosing a role and saving posts the roles array', async () => {
    render(UserDetail, { props: { userId: 'u1' } });
    await vi.waitFor(() => expect(values('#editRoles-available')).toEqual(['admin', 'mod']));
    document.querySelector<HTMLOptionElement>('#editRoles-available option[value="admin"]')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    flushSync();
    expect(values('#editRoles-chosen')).toEqual(['user', 'admin']);
    await userEvent.click(page.getByRole('button', { name: 'Save Changes' }));
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/users/u1', {
      email: 'alice@example.com',
      roles: ['user', 'admin'],
    }));
  });

  it('locks admin when editing your own account', async () => {
    adminUser.set({ id: 'u1', username: 'alice', email: 'alice@example.com', roles: ['admin', 'user'], isAdmin: true });
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/users/u1') return Promise.resolve(userFixture(['admin', 'user']));
      if (path === '/api/admin/roles') return Promise.resolve(rolesFixture());
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(UserDetail, { props: { userId: 'u1' } });
    await vi.waitFor(() => expect(values('#editRoles-chosen')).toEqual(['admin', 'user']));
    const adminOpt = document.querySelector<HTMLOptionElement>('#editRoles-chosen option[value="admin"]')!;
    expect(adminOpt.disabled).toBe(true);
    await userEvent.click(page.getByRole('button', { name: 'Remove all' }));
    flushSync();
    expect(values('#editRoles-chosen')).toEqual(['admin']);
    await expect.element(page.getByText('You cannot remove admin from your own account.')).toBeInTheDocument();
  });
});
