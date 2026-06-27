<script lang="ts">
  // W0-T01: Feature flags for Wave 1 protocol changes.
  // Each toggle gates a specific Wave 1 task; see label/desc for the
  // canonical task ID. Defaults are all false; admins opt in per-user
  // for testing before Wave 1 is rolled out broadly.
  import { globalPrefs } from '../stores/preferences.svelte';
</script>

<section class="settings-section">
  <h3 class="settings-section-title">
    <i class="fa fa-flag"></i>
    Feature flags (advanced)
  </h3>
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Sync prefs across devices (prefVersion resolution)</span>
        <span class="settings-label-desc">
          Last-write-wins conflict resolution for cross-device preference
          sync. ON by default in Wave 2; disable to revert to last-sync-wins.
        </span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Sync prefs across devices (prefVersion resolution)"
            aria-checked={globalPrefs.featureFlags.usePrefVersion}
            bind:checked={globalPrefs.featureFlags.usePrefVersion}
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Heartbeat (W1-T03)</span>
        <span class="settings-label-desc">
          Send and respond to heartbeat_echo messages on the WebSocket.
          Detects half-open connections faster than TCP keepalive.
        </span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Heartbeat (W1-T03)"
            aria-checked={globalPrefs.featureFlags.heartbeat.enabled}
            bind:checked={globalPrefs.featureFlags.heartbeat.enabled}
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Edit-message wire (W1-T04)</span>
        <span class="settings-label-desc">
          Use the new editMessage protocol for in-place message edits
          instead of the legacy delete-and-resend pattern.
        </span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Edit-message wire (W1-T04)"
            aria-checked={globalPrefs.featureFlags.editMessage.enabled}
            bind:checked={globalPrefs.featureFlags.editMessage.enabled}
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">buffersToDelete wire (W1-T06)</span>
        <span class="settings-label-desc">
          Honor the server's buffersToDelete hint when pruning stale
          buffers on sync. Affects buffer reconciliation only.
        </span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="buffersToDelete wire (W1-T06)"
            aria-checked={globalPrefs.featureFlags.buffersToDelete.enabled}
            bind:checked={globalPrefs.featureFlags.buffersToDelete.enabled}
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="settings-row">
      <div class="settings-label">
        <span class="settings-label-text">Idle events (W1-T08)</span>
        <span class="settings-label-desc">
          Publish temp_unavailable on tab visibility changes and send
          idle/active markers when the window regains focus.
        </span>
      </div>
      <div class="settings-control">
        <label class="toggle-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Idle events (W1-T08)"
            aria-checked={globalPrefs.featureFlags.idleEvents.enabled}
            bind:checked={globalPrefs.featureFlags.idleEvents.enabled}
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</section>