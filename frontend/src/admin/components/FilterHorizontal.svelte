<script lang="ts">
  /**
   * FilterHorizontal — Django admin `filter_horizontal` (SelectFilter2)
   * widget: two panes, "Available <label>" on the left and "Chosen <label>"
   * on the right, each with a filter box, plus Choose / Remove arrows and
   * "Choose all" / "Remove all" links. Double-click moves a single option.
   *
   * `selected` is bindable and preserves the order options were chosen in.
   */
  interface Option {
    value: string;
    label?: string;
    /** Secondary line shown under the label (Django help_text analogue). */
    hint?: string;
  }
  interface Props {
    id: string;
    label: string;
    options: Option[];
    selected: string[];
    disabled?: boolean;
    /** Values that cannot be removed once chosen (rendered but inert). */
    locked?: string[];
    helpText?: string;
  }
  let { id, label, options, selected = $bindable(), disabled = false, locked = [], helpText }: Props = $props();

  let availableFilter = $state('');
  let chosenFilter = $state('');
  let availableSel = $state<string[]>([]);
  let chosenSel = $state<string[]>([]);

  const byValue = $derived(Object.fromEntries(options.map((o) => [o.value, o])) as Record<string, Option>);
  function matches(o: Option, q: string): boolean {
    if (!q) return true;
    return (o.label ?? o.value).toLowerCase().includes(q) || o.value.toLowerCase().includes(q);
  }
  const available = $derived.by(() => {
    const q = availableFilter.trim().toLowerCase();
    return options.filter((o) => !selected.includes(o.value) && matches(o, q));
  });
  const chosen = $derived.by(() => {
    const q = chosenFilter.trim().toLowerCase();
    return selected
      .map((v) => byValue[v] ?? { value: v, label: v })
      .filter((o) => matches(o, q));
  });

  function choose(values: string[]): void {
    if (disabled) return;
    const add = values.filter((v) => !selected.includes(v));
    if (add.length) selected = [...selected, ...add];
    availableSel = [];
  }
  function remove(values: string[]): void {
    if (disabled) return;
    const drop = values.filter((v) => !locked.includes(v));
    if (drop.length) selected = selected.filter((v) => !drop.includes(v));
    chosenSel = [];
  }
  function chooseAll(): void { choose(available.map((o) => o.value)); }
  function removeAll(): void { remove(chosen.map((o) => o.value)); }

  function readSelection(e: Event): string[] {
    return [...(e.currentTarget as HTMLSelectElement).selectedOptions].map((o) => o.value);
  }
</script>

<div class="fh" class:fh--disabled={disabled}>
  <div class="fh__pane">
    <label for="{id}-available" class="fh__title">Available {label}</label>
    <div class="fh__filter">
      <input id="{id}-available-filter" type="search" placeholder="Filter" bind:value={availableFilter} aria-label="Filter available {label}" {disabled} />
    </div>
    <select id="{id}-available" multiple size="8" class="fh__select"
      onchange={(e) => (availableSel = readSelection(e))}
      ondblclick={(e) => { const v = (e.target as HTMLOptionElement).value; if (v) choose([v]); }}
      {disabled}>
      {#each available as o (o.value)}
        <option value={o.value} title={o.hint ?? ''}>{o.label ?? o.value}{o.hint ? ` — ${o.hint}` : ''}</option>
      {/each}
    </select>
    <button type="button" class="fh__link" onclick={chooseAll} disabled={disabled || available.length === 0}>Choose all</button>
  </div>

  <div class="fh__chooser">
    <button type="button" class="fh__arrow" title="Choose" aria-label="Choose selected {label}" onclick={() => choose(availableSel)} disabled={disabled || availableSel.length === 0}>›</button>
    <button type="button" class="fh__arrow" title="Remove" aria-label="Remove selected {label}" onclick={() => remove(chosenSel)} disabled={disabled || chosenSel.length === 0}>‹</button>
  </div>

  <div class="fh__pane">
    <label for="{id}-chosen" class="fh__title">Chosen {label}</label>
    <div class="fh__filter">
      <input id="{id}-chosen-filter" type="search" placeholder="Filter" bind:value={chosenFilter} aria-label="Filter chosen {label}" {disabled} />
    </div>
    <select id="{id}-chosen" multiple size="8" class="fh__select"
      onchange={(e) => (chosenSel = readSelection(e))}
      ondblclick={(e) => { const v = (e.target as HTMLOptionElement).value; if (v) remove([v]); }}
      {disabled}>
      {#each chosen as o (o.value)}
        <option value={o.value} title={o.hint ?? ''} disabled={locked.includes(o.value)}>{o.label ?? o.value}{locked.includes(o.value) ? ' (locked)' : ''}</option>
      {/each}
    </select>
    <button type="button" class="fh__link" onclick={removeAll} disabled={disabled || chosen.every((o) => locked.includes(o.value))}>Remove all</button>
  </div>
</div>
{#if helpText}
  <p class="fh__help">{helpText}</p>
{/if}

<style>
  .fh { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 0.5rem; align-items: stretch; }
  .fh--disabled { opacity: 0.6; }
  .fh__pane { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 0.375rem; overflow: hidden; background: var(--surface); }
  .fh__title { padding: 0.375rem 0.625rem; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); background: var(--surface-2); border-bottom: 1px solid var(--border); }
  .fh__filter { padding: 0.375rem 0.5rem; border-bottom: 1px solid var(--border); }
  .fh__filter input { width: 100%; box-sizing: border-box; padding: 0.25rem 0.5rem; font-size: 0.75rem; border-radius: 0.25rem; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  .fh__filter input:focus { outline: none; border-color: var(--primary); }
  .fh__select { flex: 1 1 auto; width: 100%; min-height: 10rem; border: 0; padding: 0.25rem; font-size: 0.8125rem; font-family: inherit; background: transparent; color: var(--text); outline: none; }
  .fh__select option { padding: 0.25rem 0.375rem; border-radius: 0.25rem; }
  .fh__select option:checked { background: var(--primary); color: var(--primary-fg); }
  .fh__select option:disabled { color: var(--muted); }
  .fh__link { padding: 0.375rem; font-size: 0.6875rem; text-align: center; color: var(--primary); background: var(--surface-2); border: 0; border-top: 1px solid var(--border); cursor: pointer; }
  .fh__link:hover:not(:disabled) { text-decoration: underline; }
  .fh__link:disabled { color: var(--muted); cursor: default; }
  .fh__chooser { display: flex; flex-direction: column; justify-content: center; gap: 0.5rem; }
  .fh__arrow { width: 1.75rem; height: 1.75rem; font-size: 1.125rem; line-height: 1; border-radius: 9999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  .fh__arrow:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
  .fh__arrow:disabled { opacity: 0.4; cursor: default; }
  .fh__help { margin: 0.375rem 0 0; font-size: 0.75rem; color: var(--muted); }
</style>
