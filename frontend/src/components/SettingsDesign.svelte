<script lang="ts">
  import { globalPrefs } from '../stores/preferences.svelte';
  import SettingsSection from './SettingsSection.svelte';

  let fontPreview = $derived(globalPrefs.fontSize + 'px');

  // ── Custom CSS ──
  let customCSS = $state(globalPrefs.customCSS || '');
  let cssError = $state<string | null>(null);
  let cssApplied = $state(false);

  function validateCSS(css: string): string | null {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      // CSSStyleSheet silently drops invalid syntax instead of throwing.
      // If input is non-empty but no rules were produced, it's invalid.
      if (css.trim().length > 0 && sheet.cssRules.length === 0) {
        return 'Invalid CSS syntax (no valid rules found)';
      }
      return null; // valid
    } catch (e) {
      return (e as Error).message;
    }
  }

  $effect(() => {
    if (customCSS.length === 0) {
      cssError = null;
      cssApplied = false;
      globalPrefs.customCSS = '';
      return;
    }
    const error = validateCSS(customCSS);
    cssError = error;
    cssApplied = error === null;
    if (error === null) {
      globalPrefs.customCSS = customCSS;
    }
  });

  function resetCSS(): void {
    customCSS = '';
    globalPrefs.customCSS = '';
  }
</script>

<SettingsSection heading="Interface">
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
</SettingsSection>

<SettingsSection heading="Sidebar">
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
</SettingsSection>

<SettingsSection heading="Messages">
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
</SettingsSection>

<SettingsSection heading="Theme">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Colour theme</span>
        <span class="settings-label-desc">Choose your preferred theme</span>
      </div>
      <div class="settings-control">
        <select id="theme-select" class="settings-select" bind:value={globalPrefs.theme}>
          <option value="dark">Dark</option>
          <option value="midnight">Midnight</option>
          <option value="dusk">Dusk</option>
          <option value="tropic">Tropic</option>
          <option value="emerald">Emerald</option>
          <option value="sand">Sand</option>
          <option value="orchid">Orchid</option>
        </select>
      </div>
    </div>
  </div>
</SettingsSection>

<SettingsSection heading="Custom CSS">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Custom styles</span>
        <span class="settings-label-desc">Override the appearance with your own CSS</span>
      </div>
      <div class="settings-control">
        <div class="settings-css-area">
          <label for="custom-css">Custom CSS</label>
          <textarea
            id="custom-css"
            class="settings-textarea custom-css-input"
            rows="10"
            bind:value={customCSS}
            placeholder={`/* e.g. */ .row.messageRow .content { color: #fff; }`}
          ></textarea>
          <p class="custom-css-status" class:error={cssError !== null} class:success={cssApplied}>
            {cssError !== null ? cssError : `Applied. Reload to undo.`}
          </p>
          {#if cssError === null && customCSS.length > 0}
            <div class="settings-css-actions">
              <button class="settings-btn settings-btn--secondary" onclick={resetCSS}>Reset to default</button>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
</SettingsSection>
