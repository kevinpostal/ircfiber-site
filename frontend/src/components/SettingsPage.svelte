<script lang="ts">
  import { ircState, type SettingsTab } from '../stores/ircStore.svelte';
  import { navigateSettings, navigateBackFromSettings } from '../lib/routing';
  import SettingsDesign from './SettingsDesign.svelte';
  import SettingsAccount from './SettingsAccount.svelte';
  import SettingsNotifications from './SettingsNotifications.svelte';
  import SettingsChat from './SettingsChat.svelte';

  let tab = $state<SettingsTab>(ircState.settingsTab);

  function switchTab(newTab: SettingsTab): void {
    tab = newTab;
    ircState.settingsTab = newTab;
    navigateSettings(newTab);
  }

  function close(): void {
    ircState.showSettings = false;
    navigateBackFromSettings();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="settings-page">
  <div class="settings-header">
    <div class="settings-tabs" role="tablist">
      <button
        role="tab"
        aria-selected={tab === 'design'}
        class="settings-tab"
        class:active={tab === 'design'}
        onclick={() => switchTab('design')}
      >Design</button>
      <button
        role="tab"
        aria-selected={tab === 'account'}
        class="settings-tab"
        class:active={tab === 'account'}
        onclick={() => switchTab('account')}
      >Account</button>
      <button
        role="tab"
        aria-selected={tab === 'notifications'}
        class="settings-tab"
        class:active={tab === 'notifications'}
        onclick={() => switchTab('notifications')}
      >Notifications</button>
      <button
        role="tab"
        aria-selected={tab === 'chat'}
        class="settings-tab"
        class:active={tab === 'chat'}
        onclick={() => switchTab('chat')}
      >Chat &amp; embeds</button>
    </div>
    <button class="settings-done" onclick={close}>Done</button>
  </div>
  <div class="settings-scroll">
    {#if tab === 'design'}
      <SettingsDesign />
    {:else if tab === 'account'}
      <SettingsAccount />
    {:else if tab === 'notifications'}
      <SettingsNotifications />
    {:else if tab === 'chat'}
      <SettingsChat />
    {/if}
  </div>
</div>
