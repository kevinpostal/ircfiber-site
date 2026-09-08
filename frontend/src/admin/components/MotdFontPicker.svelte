<script lang="ts">
  /**
   * MotdFontPicker — every FIGlet or TheDraw font rendered with the same word,
   * so a MOTD banner is chosen by looking at it instead of guessing a name.
   * Toolbar + card grid only (no modal chrome): the raw editor mounts it in a
   * card and the builder mounts it inside a banner block.
   *
   * Samples render only when a card scrolls near the grid (a FIGlet sample
   * pulls that font's chunk over the wire, the TheDraw pack is a single 6.4 MB
   * asset) and are cached in fontCatalog. Everything renders at the MOTD's
   * 80-column budget, so a card shows exactly what gets inserted.
   */
  import { IRC_COLORS, parseIrcFormatting, stripIrcFormatting } from '../../lib/ircFormatting';
  import { colorize } from '../lib/motdRecipe';
  import {
    filterFonts,
    listArtFonts,
    renderFontSample,
    sortFonts,
    type ArtFontKind,
    type FontEntry,
    type FontSort,
  } from '../../lib/fontCatalog';

  interface Props {
    /** 'insert' renders the banner for the raw editor and shows the colour
     *  select; 'pick' only reports the chosen font (builder banner block). */
    action: 'insert' | 'pick';
    /** Family shown first. */
    kind: ArtFontKind;
    /** Word the cards render. */
    sample: string;
    /** Highlighted card: the font already applied, or null. */
    selected: { kind: ArtFontKind; name: string } | null;
    /** Chosen font. `lines` is the rendered banner in 'insert' mode, [] in 'pick'. */
    onPick: (entry: FontEntry, lines: string[]) => void;
  }
  let { action, kind, sample: initialSample, selected, onPick }: Props = $props();

  /** MOTD lines are budgeted at 80 columns; render (and warn) against that. */
  const WIDTH = 80;
  const FALLBACK = 'IRC Fiber';
  const MAX_ACTIVE = 3;

  let family = $state<ArtFontKind>(kind);
  let entries = $state<FontEntry[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let filter = $state('');
  let sort = $state<FontSort>('rows');
  let sampleInput = $state(initialSample.trim() || FALLBACK);
  let sample = $state(initialSample.trim() || FALLBACK);
  let color = $state<number | null>(null);
  let pickError = $state<string | null>(null);
  let scrollEl = $state<HTMLElement | null>(null);

  const shown = $derived(sortFonts(filterFonts(entries, filter), sort));

  /** Rendered HTML per font *and* sample, so a new sample can't show stale art. */
  let art = $state<Record<string, string>>({});
  /** Widest sample line in columns, keyed like `art`. */
  let cols = $state<Record<string, number>>({});
  const pending = new Set<string>();
  const targets = new Map<HTMLElement, FontEntry>();
  let queue: FontEntry[] = [];
  let active = 0;
  let observer: IntersectionObserver | null = null;

  const artKey = (e: FontEntry, text: string): string => `${e.kind}\u0000${e.name}\u0000${text}`;
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const widest = (lines: string[]): number =>
    lines.reduce((max, l) => Math.max(max, [...stripIrcFormatting(l)].length), 0);

  /** Loads a family's catalogue; late answers for a switched-away family are dropped. */
  function loadFamily(want: ArtFontKind): void {
    loading = true;
    loadError = null;
    listArtFonts(want)
      .then((list) => {
        if (family !== want) return;
        entries = list;
      })
      .catch((e: unknown) => {
        if (family !== want) return;
        entries = [];
        loadError = message(e);
      })
      .finally(() => {
        if (family === want) loading = false;
      });
  }

  $effect(() => { loadFamily(family); });

  // Typing in the sample box re-renders every card — wait for a pause.
  $effect(() => {
    const next = sampleInput.trim() || FALLBACK;
    const timer = setTimeout(() => { sample = next; }, 250);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const root = scrollEl;
    if (!root) return;
    const obs = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (!r.isIntersecting) continue;
          const entry = targets.get(r.target as HTMLElement);
          if (entry) enqueue(entry);
        }
      },
      { root, rootMargin: '600px 0px' },
    );
    observer = obs;
    for (const node of targets.keys()) obs.observe(node);
    return () => {
      obs.disconnect();
      if (observer === obs) observer = null;
    };
  });

  function card(node: HTMLElement, entry: FontEntry) {
    targets.set(node, entry);
    observer?.observe(node);
    // No observer yet (first paint of the grid) — render this card anyway, the
    // effect above only re-observes nodes, it does not re-enqueue them.
    if (!observer) enqueue(entry);
    return {
      update(next: FontEntry) { targets.set(node, next); },
      destroy() {
        observer?.unobserve(node);
        targets.delete(node);
      },
    };
  }

  function enqueue(entry: FontEntry): void {
    const key = artKey(entry, sample);
    if (art[key] !== undefined || pending.has(key)) return;
    pending.add(key);
    queue.push(entry);
    pump();
  }

  function pump(): void {
    while (active < MAX_ACTIVE && queue.length > 0) {
      const entry = queue.shift();
      if (!entry) return;
      const text = sample;
      const key = artKey(entry, text);
      active++;
      renderFontSample(entry, text, { width: WIDTH })
        .then((lines) => {
          cols[key] = widest(lines);
          art[key] = lines.length
            ? lines.map((l) => `<div class="fp-line">${parseIrcFormatting(l)}</div>`).join('')
            : '<div class="fp-line fp-note">no glyphs for this text</div>';
        })
        .catch((e: unknown) => {
          art[key] = `<div class="fp-line fp-note">${parseIrcFormatting(message(e))}</div>`;
        })
        .finally(() => {
          active--;
          pending.delete(key);
          pump();
        });
    }
  }

  async function choose(entry: FontEntry): Promise<void> {
    pickError = null;
    if (action === 'pick') {
      onPick(entry, []);
      return;
    }
    try {
      const lines = await renderFontSample(entry, sample, { width: WIDTH });
      // TheDraw art carries its own colours; only FIGlet takes the picked one.
      const out = entry.kind === 'figlet' && color !== null ? lines.map((l) => colorize(l, color)) : lines;
      onPick(entry, out);
    } catch (e: unknown) {
      pickError = message(e);
    }
  }
</script>

<div class="space-y-2">
  <div class="flex flex-wrap items-center gap-2 text-xs">
    <div class="flex overflow-hidden rounded border border-border" role="radiogroup" aria-label="Font family">
      {#each [{ k: 'figlet' as const, label: 'FIGlet' }, { k: 'tdf' as const, label: 'TheDraw' }] as f (f.k)}
        <button
          type="button"
          role="radio"
          aria-checked={family === f.k}
          onclick={() => { family = f.k; }}
          class="px-2 py-1 {family === f.k ? 'bg-primary/20 text-primary' : 'bg-surface-2 text-muted hover:text-heading'}"
        >{f.label}</button>
      {/each}
    </div>

    <label class="flex items-center gap-1.5 text-muted">
      Sample
      <input
        type="text"
        bind:value={sampleInput}
        spellcheck="false"
        onkeydown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
        class="w-32 rounded border border-border bg-surface-2 px-2 py-1 text-xs"
      />
    </label>

    <label class="flex items-center gap-1.5 text-muted">
      Filter
      <input
        type="search"
        bind:value={filter}
        placeholder="name or file"
        onkeydown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
        class="w-36 rounded border border-border bg-surface-2 px-2 py-1 text-xs"
      />
    </label>

    <div class="flex items-center gap-1.5 text-muted">
      Sort
      <div class="flex overflow-hidden rounded border border-border" role="radiogroup" aria-label="Sort fonts">
        {#each [{ s: 'rows' as const, label: 'Rows' }, { s: 'name' as const, label: 'Name' }] as o (o.s)}
          <button
            type="button"
            role="radio"
            aria-checked={sort === o.s}
            onclick={() => { sort = o.s; }}
            class="px-2 py-1 {sort === o.s ? 'bg-primary/20 text-primary' : 'bg-surface-2 text-muted hover:text-heading'}"
          >{o.label}</button>
        {/each}
      </div>
    </div>

    {#if action === 'insert' && family === 'figlet'}
      <label class="flex items-center gap-1.5 text-muted">
        Colour
        <select
          value={color === null ? '' : String(color)}
          onchange={(e) => { const v = e.currentTarget.value; color = v === '' ? null : Number(v); }}
          class="rounded border border-border bg-surface-2 px-2 py-1 text-xs"
        >
          <option value="">none</option>
          {#each IRC_COLORS as c (c.code)}<option value={String(c.code)}>{c.code} {c.name}</option>{/each}
        </select>
      </label>
    {/if}

    <span class="ml-auto text-muted">
      {#if loading}Loading…{:else}{shown.length.toLocaleString()} of {entries.length.toLocaleString()}{/if}
    </span>
  </div>

  {#if loadError}
    <p class="flex items-center gap-2 text-xs text-danger">
      <span>{loadError}</span>
      <button
        type="button"
        onclick={() => { loadFamily(family); }}
        class="rounded border border-border bg-surface-2 px-2 py-0.5 text-xs text-heading"
      >Retry</button>
    </p>
  {/if}

  {#if pickError}
    <p class="text-xs text-danger">{pickError}</p>
  {/if}

  <div
    bind:this={scrollEl}
    class="grid max-h-[26rem] gap-2 overflow-y-auto sm:grid-cols-2"
  >
    {#key family + '\u0000' + sample}
      {#each shown as e (e.name)}
        {@const key = artKey(e, sample)}
        <div
          use:card={e}
          role="button"
          tabindex="0"
          aria-pressed={selected?.kind === e.kind && selected?.name === e.name}
          aria-label="Use {e.name}"
          title="Use {e.name}"
          onclick={() => void choose(e)}
          onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); void choose(e); } }}
          class="cursor-pointer rounded border bg-surface p-2 text-left hover:border-primary/40 {selected?.kind === e.kind && selected?.name === e.name ? 'border-primary ring-1 ring-primary/40' : 'border-border'}"
        >
          <div class="mb-1 flex items-baseline gap-2 text-[11px]">
            <span class="truncate font-medium text-heading">{e.name}</span>
            {#if e.note}<span class="truncate text-muted">{e.note}</span>{/if}
            <span class="ml-auto shrink-0 text-muted">{e.rows || '?'} rows</span>
            {#if cols[key] !== undefined}
              <span
                class="shrink-0 {cols[key] > WIDTH ? 'text-warn' : 'text-muted'}"
                title={cols[key] > WIDTH ? `Wider than ${WIDTH} columns — wraps in most clients` : ''}
              >{cols[key]} cols</span>
            {/if}
          </div>
          <pre class="motd-preview overflow-x-auto rounded bg-black px-2 py-1 font-mono text-[10px] leading-[1.15] text-[#d2d2d2]">{#if art[key] !== undefined}{@html art[key]}{:else}<span class="fp-note">rendering…</span>{/if}</pre>
        </div>
      {/each}
    {/key}
    {#if !loading && !loadError && shown.length === 0}
      <p class="text-xs text-muted">No font matches “{filter}”.</p>
    {/if}
  </div>
</div>

<style>
  /* Art lines must not collapse or wrap: one glyph row per line. */
  pre :global(.fp-line) {
    white-space: pre;
    min-height: 1.15em;
  }
  pre :global(.fp-note) {
    color: var(--color-muted, #7f7f7f);
    font-style: italic;
  }
</style>
