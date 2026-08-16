<script lang="ts">
  import { globalPrefs, highlightWords, setGlobalNotifPref } from '../stores/preferences.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { isSupported, shouldRequest, requestPermission, resetNotificationState } from '../lib/notifications';

  let permissionHint = $state('');
  let notSupportedHint = $state('');

  // Show hint if notifications are not supported in this browser
  $effect(() => {
    if (!isSupported()) {
      notSupportedHint = 'Notifications not supported in this browser';
    } else {
      notSupportedHint = '';
    }
  });

  function onDesktopToggle(): void {
    setGlobalNotifPref('desktopNotifications', globalPrefs.desktopNotifications);
    if (globalPrefs.desktopNotifications) {
      permissionHint = '';
      if (shouldRequest()) {
        requestPermission().then((granted) => {
          if (!granted) {
            globalPrefs.desktopNotifications = false;
            setGlobalNotifPref('desktopNotifications', false);
            permissionHint = 'Permission denied — enable in browser settings';
          }
        });
      } else if (!isSupported()) {
        notSupportedHint = 'Notifications not supported in this browser';
      } else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        globalPrefs.desktopNotifications = false;
        setGlobalNotifPref('desktopNotifications', false);
        permissionHint = 'Permission denied — enable in browser settings';
      }
    } else {
      resetNotificationState();
      permissionHint = '';
    }
  }

  function onSoundToggle(): void {
    setGlobalNotifPref('notificationSound', globalPrefs.notificationSound);
  }
  function onAutoDismissToggle(): void {
    setGlobalNotifPref('autoDismissNotifs', globalPrefs.autoDismissNotifs);
  }
  function onMuteAllToggle(): void {
    setGlobalNotifPref('muteAll', globalPrefs.muteAll);
  }
</script>

<SettingsSection heading="Alerts">
  <div class="settings-rows">
    <div class="settings-row" class:muted-overwrite={globalPrefs.muteAll} style:opacity={globalPrefs.muteAll ? '0.6' : undefined} aria-disabled={globalPrefs.muteAll}>
      <div class="settings-label">
        <span class="settings-label-text">Desktop notifications</span>
        <span class="settings-label-desc">Show popup notifications when you receive highlights or private messages</span>
        {#if globalPrefs.muteAll}
          <span class="settings-label-desc" style="color: var(--fiber-amber, #f59e0b);">Muted — unmute in Muting to re-enable</span>
        {/if}
        {#if permissionHint}
          <span class="settings-label-desc" style="color: var(--fiber-amber, #f59e0b);">{permissionHint}</span>
        {/if}
        {#if notSupportedHint && !globalPrefs.muteAll}
          <span class="settings-label-desc" style="color: var(--fiber-amber, #f59e0b);">{notSupportedHint}</span>
        {/if}
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.desktopNotifications} onchange={onDesktopToggle} disabled={globalPrefs.muteAll} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Notification sound</span>
        <span class="settings-label-desc">Play a sound for new highlights and private messages received in the background</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.notificationSound} onchange={onSoundToggle} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Auto-dismiss notifications</span>
        <span class="settings-label-desc">Automatically dismiss desktop notifications after a few seconds</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.autoDismissNotifs} onchange={onAutoDismissToggle} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</SettingsSection>

<SettingsSection heading="Muting">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Mute all notifications</span>
        <span class="settings-label-desc">Disable all badges and alerts for mentions and highlights</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.muteAll} onchange={onMuteAllToggle} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</SettingsSection>

<SettingsSection heading="Highlights">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Highlight words</span>
        <span class="settings-label-desc">You'll be alerted when these words are mentioned</span>
      </div>
      <div class="settings-control">
        {#if highlightWords.length > 0}
          <div class="settings-highlight-chips">
            {#each highlightWords as word}
              <span class="settings-chip">{word}</span>
            {/each}
          </div>
        {:else}
          <div class="settings-empty">No custom highlight words set. Your nickname is highlighted by default.</div>
        {/if}
      </div>
    </div>
  </div>
</SettingsSection>

<SettingsSection heading="Mobile">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Push notifications</span>
        <span class="settings-label-desc">Push notifications are managed through the mobile apps</span>
      </div>
      <div class="settings-control">
        <span class="settings-value">Configure in the IRCCloud mobile app</span>
      </div>
    </div>
  </div>
</SettingsSection>
