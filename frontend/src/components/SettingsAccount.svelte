<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';
  import { highlightWords } from '../stores/preferences.svelte';
  import { changePassword, deleteAccount, uploadAvatar, removeAvatar } from '../stores/api';
  import SettingsSection from './SettingsSection.svelte';

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
