<script lang="ts">
  import { ircState, type SettingsTab } from '../stores/ircStore.svelte';
  import { navigateSettings, navigateShortcuts } from '../lib/routing';

  interface Props {
    onAddNetwork: () => void;
  }
  let { onAddNetwork }: Props = $props();

  let open = $state(false);
  /// The popup and its trigger — a click in either is "inside".
  let menuEl: HTMLDivElement | undefined = $state();
  let buttonEl: HTMLDivElement | undefined = $state();

  function toggle(): void {
    open = !open;
  }

  /// Dismiss on a click anywhere off the menu, and on Escape — the same
  /// contract the context menus use (`ChannelContextMenu.clickOutside`).
  /// Listeners exist only while the menu is open, so a closed menu costs
  /// nothing on every document click.
  ///
  /// The trigger is excluded on purpose: its own `onclick` toggles, so
  /// letting this handler also fire would close and immediately reopen.
  $effect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (menuEl?.contains(target) || buttonEl?.contains(target)) return;
      open = false;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') open = false;
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  });

  async function handleSignOut(): Promise<void> {
    // Call the server-side logout endpoint to destroy the session
    // (including any admin impersonation state). Then navigate to
    // the login page. A hard reload ensures the session cookie is
    // gone and the server renders a fresh login page.
    try { await fetch('/logout', { method: 'GET' }); } catch {}
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
  <div class="accountMenu" id="accountMenu" bind:this={menuEl}>
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
  </div>
{/if}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div bind:this={buttonEl} class="accountMenu__button {open ? '' : 'accountMenu__button--closed'}" role="button" tabindex="0" aria-expanded={open} aria-haspopup="true" aria-controls="accountMenu" onclick={toggle} onkeydown={(e) => { if (e.key === 'Enter') toggle(); }}>
  <i class="accountMenu__caret fa fa-{open ? 'caret-down' : 'cog'}"></i>
  <span class="accountMenu__title">Account Settings</span>
</div>
