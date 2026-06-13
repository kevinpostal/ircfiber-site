<script lang="ts">
  import { ircState, type SettingsTab } from '../stores/ircStore.svelte';
  import { navigateSettings, navigateShortcuts } from '../lib/routing';

  interface Props {
    onAddNetwork: () => void;
  }
  let { onAddNetwork }: Props = $props();

  let open = $state(false);

  function toggle(): void {
    open = !open;
  }

  function handleSignOut(): void {
    localStorage.removeItem('token');
    window.location.href = '/login';
  }

  function openSettings(tab: SettingsTab): void {
    ircState.showSettings = true;
    ircState.settingsTab = tab;
    navigateSettings(tab);
    open = false;
  }

  function openShortcuts(): void {
    ircState.showShortcuts = true;
    navigateShortcuts();
    open = false;
  }
</script>

{#if open}
  <div class="accountMenu" id="accountMenu">
    <div class="accountMenu__info">
      <div class="accountMenu__name">{ircState.me?.username || 'User'}</div>
      <div class="accountMenu__email">{ircState.me?.email || ''}</div>
    </div>

    <div class="accountMenu__items">
      <ul class="accountMenu__items-list">
        <li><button onclick={() => openSettings('design')}>Settings</button></li>
        <li><button onclick={openShortcuts}>Shortcuts</button></li>
        <li><a href="/?/feedback">Help &amp; Feedback</a></li>
      </ul>
    </div>

    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <button class="accountMenu__signout-button link" onclick={handleSignOut}>Sign out</button>

    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="accountMenu__button" role="button" tabindex="0" onclick={toggle} onkeydown={(e) => { if (e.key === 'Enter') toggle(); }}>
      <i class="accountMenu__caret fa fa-caret-down"></i>
      <span class="accountMenu__title">Account settings &amp; info</span>
    </div>
  </div>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="accountMenu__button--closed accountMenu__button" role="button" tabindex="0" onclick={toggle} onkeydown={(e) => { if (e.key === 'Enter') toggle(); }}>
    <i class="accountMenu__caret fa fa-cog"></i>
    <span class="accountMenu__title">Account settings &amp; info</span>
  </div>
{/if}
