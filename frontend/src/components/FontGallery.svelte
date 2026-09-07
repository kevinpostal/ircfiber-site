<script lang="ts">
  /**
   * Font gallery — every FIGlet or TheDraw font rendered with the same word so
   * fonts can be compared instead of guessed from a name. Samples render only
   * when a card scrolls near the viewport (a FIGlet sample pulls that font's
   * chunk over the wire) and are cached in fontCatalog.
   */
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import {
    filterFonts,
    listArtFonts,
    renderFontSample,
    sortFonts,
    type ArtFontKind,
    type FontEntry,
    type FontSort,
  } from '../lib/fontCatalog';

  interface Props {
    kind: ArtFontKind;
    /** Word the cards render; the compose text's first word by default. */
    initialSample: string;
    /** Currently picked font name of `kind`, or null. */
    selected: string | null;
    onKind: (kind: ArtFontKind) => void;
    onSelect: (entry: FontEntry) => void;
  }
  let { kind, initialSample, selected, onKind, onSelect }: Props = $props();

  const FALLBACK = 'Fiber';
  const MAX_ACTIVE = 3;

  let entries = $state<FontEntry[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let filter = $state('');
  let sort = $state<FontSort>('rows');
  let sampleInput = $state(initialSample.trim() || FALLBACK);
  let sample = $state(initialSample.trim() || FALLBACK);
  let scrollEl = $state<HTMLElement | null>(null);

  const shown = $derived(sortFonts(filterFonts(entries, filter), sort));

  /** Rendered HTML per font *and* sample, so a new sample can't show stale art. */
  let art = $state<Record<string, string>>({});
  const pending = new Set<string>();
  const targets = new Map<HTMLElement, FontEntry>();
  let queue: FontEntry[] = [];
  let active = 0;
  let observer: IntersectionObserver | null = null;

  const artKey = (e: FontEntry, text: string): string => `${e.kind}\u0000${e.name}\u0000${text}`;
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  $effect(() => {
    const want = kind;
    loading = true;
    loadError = null;
    listArtFonts(want)
      .then((list) => {
        if (kind !== want) return;
        entries = list;
      })
      .catch((e: unknown) => {
        if (kind === want) loadError = message(e);
      })
      .finally(() => {
        if (kind === want) loading = false;
      });
  });

  // Typing in the sample box re-renders the whole gallery — wait for a pause.
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
      renderFontSample(entry, text)
        .then((lines) => {
          art[key] = lines.length
            ? lines.map((l) => `<div class="csp-artline">${parseIrcFormatting(l)}</div>`).join('')
            : '<div class="csp-artline csp-artnote">no glyphs for this text</div>';
        })
        .catch((e: unknown) => {
          art[key] = `<div class="csp-artline csp-artnote">${parseIrcFormatting(message(e))}</div>`;
        })
        .finally(() => {
          active--;
          pending.delete(key);
          pump();
        });
    }
  }
</script>

<div class="csp-gal">
  <div class="csp-bar">
    <div class="cs-seg" role="radiogroup" aria-label="Font family">
      <button type="button" role="radio" aria-checked={kind === 'figlet'} class:selected={kind === 'figlet'}
              onclick={() => onKind('figlet')}>FIGlet</button>
      <button type="button" role="radio" aria-checked={kind === 'tdf'} class:selected={kind === 'tdf'}
              onclick={() => onKind('tdf')}>TheDraw</button>
    </div>
    <label class="csp-field">
      <span class="cs-label">Sample</span>
      <input type="text" class="cs-input csp-sample" bind:value={sampleInput} spellcheck="false"
             onkeydown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
    </label>
    <label class="csp-field">
      <span class="cs-label">Filter</span>
      <input type="search" class="cs-input" bind:value={filter} placeholder="name or file"
             onkeydown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
    </label>
    <div class="csp-field">
      <span class="cs-label">Sort</span>
      <div class="cs-seg" role="radiogroup" aria-label="Sort fonts">
        <button type="button" role="radio" aria-checked={sort === 'rows'} class:selected={sort === 'rows'}
                onclick={() => { sort = 'rows'; }}>Rows</button>
        <button type="button" role="radio" aria-checked={sort === 'name'} class:selected={sort === 'name'}
                onclick={() => { sort = 'name'; }}>Name</button>
      </div>
    </div>
    <div class="csp-count">
      {#if loading}Loading…{:else}{shown.length.toLocaleString()} of {entries.length.toLocaleString()}{/if}
    </div>
  </div>

  {#if loadError}
    <div class="cs-note warn">{loadError}</div>
  {/if}

  <div class="csp-cards" bind:this={scrollEl}>
    {#key kind + '\u0000' + sample}
      {#each shown as e (e.name)}
        <article class="csp-card" class:selected={e.name === selected} use:card={e}
                 role="button" tabindex="0" aria-pressed={e.name === selected}
                 title="Use {e.name}"
                 onclick={() => onSelect(e)}
                 onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(e); } }}>
          <div class="csp-card-head">
            <span class="csp-card-name">{e.name}</span>
            {#if e.note}<span class="csp-card-note">{e.note}</span>{/if}
            <span class="csp-card-rows">{e.rows || '?'} rows</span>
          </div>
          <div class="csp-card-art">
            {#if art[artKey(e, sample)] !== undefined}
              {@html art[artKey(e, sample)]}
            {:else}
              <div class="csp-artline csp-artnote">rendering…</div>
            {/if}
          </div>
        </article>
      {/each}
    {/key}
    {#if !loading && shown.length === 0 && !loadError}
      <div class="cs-note">No font matches “{filter}”.</div>
    {/if}
  </div>
</div>
