<script lang="ts">
  import { ircState, type SettingsTab } from '../stores/ircStore.svelte';
  import { highlightWords } from '../stores/preferences.svelte';
  import { onMount } from 'svelte';
  import { changePassword, deleteAccount, uploadAvatar, removeAvatar, fetchIrcAccount, retryIrcAccount, type IrcAccountInfo } from '../stores/api';
  import SettingsSection from './SettingsSection.svelte';

  // Supplied by SettingsPage so the row below can switch to the Sessions tab
  // (and its `?/settings=sessions` URL). Defaults to a no-op because the
  // component is also mounted bare in tests.
  let { onNavigate = (_tab: SettingsTab) => {} }:
    { onNavigate?: (tab: SettingsTab) => void } = $props();

  let highlightInput = $state('');
  let showDeleteConfirm = $state(false);
  let passwordBusy = $state(false);
  let deleteBusy = $state(false);
  let passwordError = $state('');
  let deleteError = $state('');
  let successMsg = $state('');
  let avatarBusy = $state(false);

  let oldPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');

  let ircAccount = $state<IrcAccountInfo | null>(null);
  let ircAccountError = $state('');
  let revealNickserv = $state(false);
  let ircRetryBusy = $state(false);

  function addHighlightWord(): void {
    const word = highlightInput.trim();
    if (!word) return;
    if (!highlightWords.includes(word)) {
      highlightWords.push(word);
    }
    highlightInput = '';
  }

  function removeHighlightWord(word: string): void {
    const idx = highlightWords.indexOf(word);
    if (idx >= 0) highlightWords.splice(idx, 1);
  }

  function handleHighlightKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      addHighlightWord();
    }
    if (e.key === ',' || e.key === ' ') {
      e.preventDefault();
      addHighlightWord();
    }
  }

  async function handleChangePassword(): Promise<void> {
    if (!oldPassword || !newPassword) {
      passwordError = 'Please fill in all fields';
      return;
    }
    if (newPassword !== confirmPassword) {
      passwordError = 'New passwords do not match';
      return;
    }
    if (newPassword.length < 6) {
      passwordError = 'Password must be at least 6 characters';
      return;
    }
    passwordBusy = true;
    passwordError = '';
    try {
      await changePassword(oldPassword, newPassword);
      successMsg = 'Password changed successfully';
      oldPassword = '';
      newPassword = '';
      confirmPassword = '';
    } catch (e: unknown) {
      passwordError = (e as Error).message || 'Failed to change password';
    } finally {
      passwordBusy = false;
    }
  }

  async function handleDeleteAccount(): Promise<void> {
    deleteBusy = true;
    deleteError = '';
    try {
      await deleteAccount();
      localStorage.removeItem('token');
      window.location.href = '/login';
    } catch (e: unknown) {
      deleteError = (e as Error).message || 'Failed to delete account';
    } finally {
      deleteBusy = false;
    }
  }

  async function handleAvatarUpload(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    if (!input.files || !input.files[0]) return;
    avatarBusy = true;
    try {
      const result = await uploadAvatar(input.files[0]);
      successMsg = 'Avatar updated';
    } catch (e: unknown) {
      passwordError = (e as Error).message || 'Failed to upload avatar';
    } finally {
      avatarBusy = false;
      input.value = '';
    }
  }

  async function handleRemoveAvatar(): Promise<void> {
    avatarBusy = true;
    try {
      await removeAvatar();
      successMsg = 'Avatar removed';
    } catch (e: unknown) {
      passwordError = (e as Error).message || 'Failed to remove avatar';
    } finally {
      avatarBusy = false;
    }
  }

  async function loadIrcAccount(): Promise<void> {
    try {
      ircAccount = await fetchIrcAccount();
    } catch (e: unknown) {
      ircAccountError = (e as Error).message || 'Failed to load your IRC account';
    }
  }

  function copyNickservPassword(): void {
    const value = ircAccount?.password;
    if (!value) return;
    const done = (): void => { successMsg = 'NickServ password copied'; };
    navigator.clipboard.writeText(value).then(done).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    });
  }

  async function retryNickservRegistration(): Promise<void> {
    ircRetryBusy = true;
    ircAccountError = '';
    try {
      await retryIrcAccount();
      // Provisioning runs in the background; poll until it settles or the
      // engine-connect wait (12s) plus a margin has elapsed.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        await loadIrcAccount();
        if (ircAccount?.status === 'ready') break;
      }
      if (ircAccount?.status === 'ready') successMsg = 'Your nick is now registered with NickServ';
    } catch (e: unknown) {
      ircAccountError = (e as Error).message || 'Could not start a retry';
    } finally {
      ircRetryBusy = false;
    }
  }

  onMount(() => { void loadIrcAccount(); });
</script>

{#if successMsg}
  <div class="settings-success">{successMsg}</div>
{/if}

<SettingsSection heading="Account">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Username</span>
      </div>
      <div class="settings-control">
        <span class="settings-value">{ircState.me?.username || '…'}</span>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Email</span>
        <span class="settings-label-desc">Your email address is used for sign-in and notifications</span>
      </div>
      <div class="settings-control">
        <span class="settings-value">{ircState.me?.email || '…'}</span>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Login sessions</span>
        <span class="settings-label-desc">See every browser signed in to this account, its login IP and the tabs it has connected</span>
      </div>
      <div class="settings-control">
        <button class="settings-btn settings-btn--secondary settings-btn--small"
                onclick={() => onNavigate('sessions')}>Review sessions</button>
      </div>
    </div>
  </div>
</SettingsSection>

<SettingsSection heading="Password">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Change password</span>
      </div>
      <div class="settings-control">
        <div class="settings-password-form">
          <input type="password" class="settings-input" placeholder="Current password" bind:value={oldPassword} />
          <input type="password" class="settings-input" placeholder="New password" bind:value={newPassword} />
          <input type="password" class="settings-input" placeholder="Confirm new password" bind:value={confirmPassword} />
          {#if passwordError}
            <div class="settings-error">{passwordError}</div>
          {/if}
          <button class="settings-btn" onclick={handleChangePassword} disabled={passwordBusy}>
            {passwordBusy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </div>
    </div>
  </div>
</SettingsSection>

<SettingsSection heading="IRC account">
  <div class="settings-rows">
    {#if ircAccountError}
      <div class="settings-error">{ircAccountError}</div>
    {:else if !ircAccount}
      <div class="settings-row">
        <div class="settings-control">
          <span class="settings-value">Loading…</span>
        </div>
      </div>
    {:else if ircAccount.status === 'ready'}
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">Account</span>
          <span class="settings-label-desc">Registered with NickServ on {ircAccount.network}</span>
        </div>
        <div class="settings-control">
          <span class="settings-value">{ircAccount.account}</span>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">NickServ password</span>
        </div>
        <div class="settings-control">
          <div class="irc-account-cred">
            <input
              class="settings-input"
              type={revealNickserv ? 'text' : 'password'}
              readonly
              value={ircAccount.password}
              aria-label="NickServ password"
              onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
            />
            <button class="settings-btn settings-btn--secondary" onclick={() => (revealNickserv = !revealNickserv)}>
              {revealNickserv ? 'Hide' : 'Show'}
            </button>
            <button class="settings-btn settings-btn--secondary" onclick={copyNickservPassword}>Copy</button>
          </div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">Server</span>
        </div>
        <div class="settings-control">
          <span class="settings-value">{ircAccount.host}:{ircAccount.port} (TLS)</span>
        </div>
      </div>
      <div class="settings-row">
        <span class="settings-value">
          Your nick on IRC Fiber is registered with NickServ and IRC Fiber signs you in
          automatically. Use these credentials for SASL PLAIN from another client, or
          <code>/msg NickServ HELP</code>.
        </span>
      </div>
    {:else if ircAccount.status === 'unavailable'}
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">Not registered</span>
          <span class="settings-label-desc">{ircAccount.reason || 'NickServ registration did not complete.'}</span>
        </div>
        <div class="settings-control">
          <button class="settings-btn settings-btn--secondary" onclick={retryNickservRegistration} disabled={ircRetryBusy}>
            {ircRetryBusy ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </div>
      <div class="settings-row">
        <span class="settings-value">
          You are still connected to IRC Fiber, but your nick is not registered, so
          nobody is holding it for you. Retry once the name is free, or set your own
          NickServ account under the network's SASL settings.
        </span>
      </div>
    {:else if ircAccount.status === 'pending'}
      <div class="settings-row">
        <span class="settings-value">Registering your nick with NickServ… this finishes in the background; reload in a moment.</span>
      </div>
    {:else}
      <div class="settings-row">
        <span class="settings-value">You are not connected to the IRC Fiber server.</span>
      </div>
    {/if}
  </div>
</SettingsSection>

<SettingsSection heading="Profile picture">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Public avatar</span>
        <span class="settings-label-desc">Upload a photo to show next to your messages</span>
      </div>
      <div class="settings-control">
        <div class="settings-avatar-area">
          <div class="settings-avatar">
            <span class="settings-avatar-placeholder">{(ircState.me?.username || 'U')[0].toUpperCase()}</span>
          </div>
          <div class="settings-avatar-actions">
            <label class="settings-btn settings-btn--secondary">
              Upload photo
              <input type="file" accept="image/*" class="settings-file-input" onchange={handleAvatarUpload} disabled={avatarBusy} />
            </label>
            <button class="settings-btn settings-btn--danger" onclick={handleRemoveAvatar} disabled={avatarBusy}>Remove</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</SettingsSection>

<SettingsSection heading="Highlight words">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Highlight words</span>
        <span class="settings-label-desc">Words that trigger a highlight when mentioned in chat</span>
      </div>
      <div class="settings-control">
        <div class="settings-highlight-area">
          {#if highlightWords.length > 0}
            <div class="settings-highlight-chips">
              {#each highlightWords as word}
                <span class="settings-chip">
                  {word}
                  <button class="settings-chip-remove" onclick={() => removeHighlightWord(word)} aria-label="Remove {word}">&times;</button>
                </span>
              {/each}
            </div>
          {:else}
            <div class="settings-empty">No highlight words set. Your nickname is highlighted automatically.</div>
          {/if}
          <div class="settings-highlight-input-row">
            <input
              type="text"
              class="settings-input"
              placeholder="Add a highlight word…"
              bind:value={highlightInput}
              onkeydown={handleHighlightKeydown}
            />
            <button class="settings-btn settings-btn--small" onclick={addHighlightWord} disabled={!highlightInput.trim()}>Add</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</SettingsSection>

<section class="settings-section settings-section--danger">
  <h3 class="settings-section-title">
    <i class="fa fa-exclamation-triangle"></i>
    Danger zone
  </h3>
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Delete account</span>
        <span class="settings-label-desc">Permanently delete your account and all data</span>
      </div>
      <div class="settings-control">
        {#if showDeleteConfirm}
          <div class="settings-delete-confirm">
            <p class="settings-warning">Are you absolutely sure? This cannot be undone. All your data, networks, and settings will be permanently lost.</p>
            {#if deleteError}
              <div class="settings-error">{deleteError}</div>
            {/if}
            <div class="settings-delete-actions">
              <button class="settings-btn settings-btn--danger" onclick={handleDeleteAccount} disabled={deleteBusy}>
                {deleteBusy ? 'Deleting…' : 'Yes, delete my account'}
              </button>
              <button class="settings-btn" onclick={() => showDeleteConfirm = false}>Cancel</button>
            </div>
          </div>
        {:else}
          <button class="settings-btn settings-btn--danger" onclick={() => showDeleteConfirm = true}>Delete account</button>
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  /* input + Show + Copy on one line. The only flex row rule in
     _settings.scss is `.settings-highlight-input-row`, which is specific to
     the highlight-words editor. */
  .irc-account-cred {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .irc-account-cred .settings-input {
    flex: 1;
    min-width: 160px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
</style>
