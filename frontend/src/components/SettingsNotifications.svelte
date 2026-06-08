<script lang="ts">
  import { globalPrefs, highlightWords } from '../stores/preferences.svelte';
</script>

<section class="settings-section">
  <h3 class="settings-section-title">
    <i class="fa fa-bell"></i>
    Alerts
  </h3>
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Desktop notifications</span>
        <span class="settings-label-desc">Show popup notifications when you receive highlights or private messages</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.desktopNotifications} />
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
          <input type="checkbox" bind:checked={globalPrefs.notificationSound} />
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
          <input type="checkbox" bind:checked={globalPrefs.autoDismissNotifs} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</section>

<section class="settings-section">
  <h3 class="settings-section-title">
    <i class="fa fa-volume-mute"></i>
    Muting
  </h3>
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Mute all notifications</span>
        <span class="settings-label-desc">Disable all badges and alerts for mentions and highlights</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.muteAll} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</section>

<section class="settings-section">
  <h3 class="settings-section-title">
    <i class="fa fa-at"></i>
    Highlights
  </h3>
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
</section>

<section class="settings-section">
  <h3 class="settings-section-title">
    <i class="fa fa-mobile"></i>
    Mobile
  </h3>
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
</section>
