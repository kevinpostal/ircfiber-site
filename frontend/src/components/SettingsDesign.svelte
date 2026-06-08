<script lang="ts">
  import { globalPrefs } from '../stores/preferences.svelte';

  let fontPreview = $derived(globalPrefs.fontSize + 'px');
</script>

<section class="settings-section">
  <h3 class="settings-section-title">
    <i class="fa fa-paint-brush"></i>
    Interface
  </h3>
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Font size</span>
        <span class="settings-label-desc">Chat view message font size</span>
      </div>
      <div class="settings-control">
        <div class="settings-range-wrap">
          <input type="range" class="settings-range" min="10" max="18" step="1" bind:value={globalPrefs.fontSize} />
          <span class="settings-range-value">{globalPrefs.fontSize}px</span>
        </div>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Message layout</span>
        <span class="settings-label-desc">How messages are displayed in the chat area</span>
      </div>
      <div class="settings-control">
        <select class="settings-select" bind:value={globalPrefs.messageLayout}>
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
          <option value="separate">Separate line authors</option>
        </select>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Timestamp format</span>
        <span class="settings-label-desc">How timestamps are displayed next to messages</span>
      </div>
      <div class="settings-control">
        <select class="settings-select" bind:value={globalPrefs.timestampFormat}>
          <option value="relative">Relative (2m ago)</option>
          <option value="12h">12-hour (2:30 PM)</option>
          <option value="24h">24-hour (14:30)</option>
        </select>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Monospace font</span>
        <span class="settings-label-desc">Use a monospace font for chat messages</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.monospaceFont} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</section>

<section class="settings-section">
  <h3 class="settings-section-title">
    <i class="fa fa-columns"></i>
    Sidebar
  </h3>
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Sidebar on the left</span>
        <span class="settings-label-desc">Move the channel list to the left side</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.sidebarLeft} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</section>

<section class="settings-section">
  <h3 class="settings-section-title">
    <i class="fa fa-comments"></i>
    Messages
  </h3>
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Show user icons</span>
        <span class="settings-label-desc">Display avatars next to messages</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.showUserIcons} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Mode indicators</span>
        <span class="settings-label-desc">How operator/voice status is shown</span>
      </div>
      <div class="settings-control">
        <select class="settings-select" bind:value={globalPrefs.modeIndicator}>
          <option value="dots">Colored dots</option>
          <option value="symbols">@ / + symbols</option>
          <option value="hidden">Hidden</option>
        </select>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Enlarge emoji-only messages</span>
        <span class="settings-label-desc">Show messages containing only emoji larger</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.enlargeEmoji} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Colourise mentions</span>
        <span class="settings-label-desc">Apply nick colour to @mentions</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.coloriseMentions} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Format colours</span>
        <span class="settings-label-desc">Render mIRC colour codes in messages</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.formatColors} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</section>

<section class="settings-section">
  <h3 class="settings-section-title">
    <i class="fa fa-palette"></i>
    Theme
  </h3>
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Colour scheme</span>
        <span class="settings-label-desc">Choose your preferred theme</span>
      </div>
      <div class="settings-control">
        <div class="theme-selector">
          <label class="theme-option" class:active={globalPrefs.theme === 'auto'}>
            <input type="radio" name="theme" value="auto" bind:group={globalPrefs.theme} />
            <span class="theme-preview theme-preview--auto"></span>
            <span class="theme-label">Auto</span>
          </label>
          <label class="theme-option" class:active={globalPrefs.theme === 'dark'}>
            <input type="radio" name="theme" value="dark" bind:group={globalPrefs.theme} />
            <span class="theme-preview theme-preview--dark"></span>
            <span class="theme-label">Dark</span>
          </label>
          <label class="theme-option" class:active={globalPrefs.theme === 'midnight'}>
            <input type="radio" name="theme" value="midnight" bind:group={globalPrefs.theme} />
            <span class="theme-preview theme-preview--midnight"></span>
            <span class="theme-label">Midnight</span>
          </label>
        </div>
      </div>
    </div>
  </div>
</section>
