<script lang="ts">
  /**
   * StringListEditor — a free-text list of short values as removable chips
   * plus an add field.
   *
   * Built for the FiberEye rule card's two lists (ignored connect classes,
   * exempt addresses). FilterHorizontal is a dual-list chooser over a fixed
   * option set, which is the wrong shape for values an admin types.
   *
   * `validate` runs on add and blocks it with an inline message; the server
   * stays authoritative, this is only instant feedback.
   */
  interface Props {
    label: string;
    entries: string[];
    placeholder?: string;
    helpText?: string;
    validate?: (value: string) => string | null;
    disabled?: boolean;
    /** Called after the list actually changed, for the owner's dirty flag. */
    onchange?: () => void;
    /** Test/label hook for the add input. */
    inputId?: string;
  }
  let {
    label,
    entries = $bindable(),
    placeholder = '',
    helpText = '',
    validate = () => null,
    disabled = false,
    onchange = () => {},
    inputId = undefined,
  }: Props = $props();

  let draft = $state('');
  let error = $state<string | null>(null);

  function add() {
    const value = draft.trim();
    if (!value) return;
    const problem = validate(value);
    if (problem) { error = problem; return; }
    // Adding what is already there is a no-op, not an error: the admin's
    // intent ("this must be in the list") is already satisfied.
    if (!entries.includes(value)) {
      entries = [...entries, value];
      onchange();
    }
    draft = '';
    error = null;
  }

  function remove(value: string) {
    entries = entries.filter((e) => e !== value);
    onchange();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    add();
  }
</script>

<div>
  <div class="flex items-baseline justify-between gap-3">
    <span class="text-xs font-semibold text-heading">{label}</span>
    <span class="text-[10px] text-muted">{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
  </div>
  {#if helpText}
    <p class="mt-0.5 text-[11px] text-muted">{helpText}</p>
  {/if}

  <div class="mt-2 flex flex-wrap gap-1.5">
    {#each entries as entry (entry)}
      <span class="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-text">
        {entry}
        <button
          type="button"
          class="text-muted hover:text-danger disabled:opacity-50"
          aria-label={`Remove ${entry}`}
          {disabled}
          onclick={() => remove(entry)}
        >×</button>
      </span>
    {/each}
    {#if entries.length === 0}
      <span class="text-xs text-muted">None.</span>
    {/if}
  </div>

  <div class="mt-2 flex gap-2">
    <input
      type="text"
      id={inputId}
      bind:value={draft}
      onkeydown={onKeydown}
      {placeholder}
      {disabled}
      aria-label={`Add to ${label}`}
      class="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-text disabled:opacity-50"
    />
    <button
      type="button"
      class="rounded-md border border-border bg-surface-2 px-3 py-1 text-xs font-medium text-text hover:bg-border disabled:opacity-50"
      disabled={disabled || draft.trim().length === 0}
      onclick={add}
    >Add</button>
  </div>
  {#if error}
    <p class="mt-1 text-[11px] text-danger">{error}</p>
  {/if}
</div>
