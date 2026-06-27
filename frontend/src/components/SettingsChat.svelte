<script lang="ts">
  import { globalPrefs } from '../stores/preferences.svelte';
  import SettingsSection from './SettingsSection.svelte';

  let customCSSText = $state(globalPrefs.customCSS || '');
  let cssSaved = $state(true);

  function saveCustomCSS(): void {
    globalPrefs.customCSS = customCSSText;
    cssSaved = true;
  }

  function onCSSInput(): void {
    cssSaved = false;
  }
</script>

<SettingsSection heading="Inline media">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Inline images</span>
        <span class="settings-label-desc">Show linked images inline in the chat</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.inlineImages} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Inline videos &amp; GIFs</span>
        <span class="settings-label-desc">Embed videos and animated GIFs from links</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.inlineVideos} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Inline tweets</span>
        <span class="settings-label-desc">Embed tweets from Twitter/X links</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.inlineTweets} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Inline pastes &amp; snippets</span>
        <span class="settings-label-desc">Show pastebin and code snippet links inline</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.inlinePastes} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Inline Reddit</span>
        <span class="settings-label-desc">Embed Reddit post previews from links</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.inlineReddit} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Inline social media</span>
        <span class="settings-label-desc">Embed Instagram and other social media links</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.inlineSocial} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</SettingsSection>

<SettingsSection heading="Typing">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Share typing status</span>
        <span class="settings-label-desc">Show when you're typing a message (on supported networks)</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.typingIndicator} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</SettingsSection>

<SettingsSection heading="Privacy">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Remove trackers from sent URLs</span>
        <span class="settings-label-desc">Strip tracking parameters from URLs you send in chat</span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={globalPrefs.removeTrackers} />
          <span class="toggle-slider"></span>
        </label>
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
          <textarea
            class="settings-textarea"
            rows="6"
            placeholder="/* Add your custom CSS here */"
            bind:value={customCSSText}
            oninput={onCSSInput}
          ></textarea>
          <div class="settings-css-actions">
            <button class="settings-btn" onclick={saveCustomCSS} disabled={cssSaved}>
              {cssSaved ? 'Saved' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</SettingsSection>
