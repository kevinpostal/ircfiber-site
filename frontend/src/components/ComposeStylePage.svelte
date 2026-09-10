<script lang="ts">
  /**
   * Compose text styling editor (the gear in the input row). It is a
   * window inside `.messages-area`: ChatArea mounts it as an absolutely
   * positioned overlay over the message list, so the sidebar, buffer
   * header (topic), member list and input box all stay on screen.
   *
   * Edits a draft copy of globalPrefs.composeStyle; Apply commits, Cancel and
   * Escape discard. Heavy work (effects, fonts, the 1 000-font TheDraw pack) is
   * behind dynamic imports so opening the page is the first time any of it loads.
   */
  import { untrack } from 'svelte';
  import FontGallery from './FontGallery.svelte';
  import { ircState } from '../stores/ircStore.svelte';
  import { navigateBackFromComposeStyle } from '../lib/routing';
  import { globalPrefs } from '../stores/preferences.svelte';
  import {
    clampArtWrapWidth,
    DEFAULT_COMPOSE_STYLE,
    isComposeStyleActive,
    type ArtWrapMode,
    type ColorMode,
    type ComposeStyle,
    type FontMode,
    type UnicodeStyle,
  } from '../lib/composeStyle';
  import { colorHex, COLOR_NAMES, IRC_COLORS, parseIrcFormatting } from '../lib/ircFormatting';
  import { utf8Length } from '../lib/messageSplitter';
  import {
    filterFonts,
    fontMode,
    listArtFonts,
    sortFonts,
    type ArtFontKind,
    type FontEntry,
    type FontSort,
  } from '../lib/fontCatalog';

  type Tab = 'text' | 'colour' | 'font' | 'gallery';

  /// Whatever was in the input when the gear was clicked, so the preview
  /// starts from the user's own words.
  const sampleText = ircState.composeStyleSample;

  function close(): void {
    ircState.showComposeStyle = false;
    navigateBackFromComposeStyle();
  }

  const PREVIEW_BUDGET = 400;
  const SAMPLE = 'The quick brown fox jumps over the lazy dog';
  const CODES = Array.from({ length: 99 }, (_, i) => i);
  const UNICODE_STYLES: UnicodeStyle[] = ['fullwidth', 'bold', 'italic', 'boldItalic', 'script', 'fraktur', 'doubleStruck', 'monospace', 'circled', 'smallCaps', 'upsideDown'];
  const CASE_LABEL: Record<ComposeStyle['caseMode'], string> = { none: '', upper: 'UPPER', lower: 'lower', mocking: 'mOcKiNg' };

  /// Styling off? Start from whatever the gear last switched off, so turning
  /// it back on is one Apply rather than rebuilding the whole style.
  const seed = isComposeStyleActive(globalPrefs.composeStyle)
    ? globalPrefs.composeStyle
    : globalPrefs.composeStyleLast;
  let draft = $state<ComposeStyle>(structuredClone($state.snapshot(seed)));
  let tab = $state<Tab>('text');
  let previewText = $state(sampleText.trim() || SAMPLE);

  const fontIsArt = $derived(draft.font.kind === 'figlet' || draft.font.kind === 'tdf');
  const colorLocked = $derived(draft.font.kind === 'tdf');
  const draftActive = $derived(isComposeStyleActive(draft));

  const summary = $derived.by(() => {
    const bits: string[] = [];
    if (draft.bold) bits.push('Bold');
    if (draft.italic) bits.push('Italic');
    if (draft.underline) bits.push('Underline');
    if (draft.strikethrough) bits.push('Strike');
    if (draft.monospace) bits.push('Mono');
    if (draft.reverse) bits.push('Reverse');
    if (draft.caseMode !== 'none') bits.push(CASE_LABEL[draft.caseMode]);
    if (draft.zalgo > 0) bits.push(`Zalgo ${draft.zalgo}`);
    const c = draft.color;
    if (c.kind === 'solid') bits.push(`Colour ${colorName(c.fg)}`);
    else if (c.kind === 'rainbow') bits.push(`Rainbow ${c.palette}`);
    else if (c.kind === 'gradient') bits.push(`Gradient ${colorName(c.from)} → ${colorName(c.to)}`);
    else if (c.kind === 'wordCycle') bits.push(`${c.colors.length} word colours`);
    const f = draft.font;
    if (f.kind === 'figlet') bits.push(`FIGlet ${f.font}`);
    else if (f.kind === 'tdf') bits.push(`TheDraw ${f.font}`);
    else if (f.kind === 'unicode') bits.push(`Unicode ${f.style}`);
    if ((f.kind === 'figlet' || f.kind === 'tdf') && draft.artWrap?.mode === 'word')
      bits.push(`Wrap ${clampArtWrapWidth(draft.artWrap.width)}`);
    return bits.length ? bits.join(' · ') : 'No styling — messages send exactly as typed';
  });

  function colorName(code: number): string {
    return code < 16 ? IRC_COLORS[code].name : String(code);
  }

  function swatchTitle(code: number): string {
    return code < 16 ? `${code} ${COLOR_NAMES[code]}` : String(code);
  }

  // ── Live preview ──
  let previewHtml = $state('');
  let previewLines = $state(0);
  let previewLongest = $state(0);
  let previewOver = $state(0);
  let previewError = $state<string | null>(null);
  let previewBusy = $state(false);

  $effect(() => {
    const snap = $state.snapshot(draft);
    const src = previewText.trim() || SAMPLE;
    const timer = setTimeout(() => {
      untrack(() => { previewBusy = true; });
      void import('../lib/composePipeline')
        .then(({ renderComposeLines }) => renderComposeLines(src, snap, PREVIEW_BUDGET))
        .then((r) => {
          untrack(() => {
            previewHtml = r.lines.map((l) => `<div class="csp-artline">${parseIrcFormatting(l)}</div>`).join('');
            previewLines = r.lines.length;
            previewLongest = r.lines.reduce((m, l) => Math.max(m, utf8Length(l)), 0);
            previewOver = r.overBudget.length;
            previewError = null;
          });
        })
        .catch((e: unknown) => {
          untrack(() => { previewError = e instanceof Error ? e.message : String(e); });
        })
        .finally(() => { untrack(() => { previewBusy = false; }); });
    }, 120);
    return () => clearTimeout(timer);
  });

  // ── Colour ──
  function setColorKind(kind: ColorMode['kind']): void {
    const bg = draft.color.kind === 'none' ? null : draft.color.bg;
    switch (kind) {
      case 'none': draft.color = { kind: 'none' }; break;
      case 'solid': draft.color = { kind: 'solid', fg: 4, bg }; break;
      case 'rainbow': draft.color = { kind: 'rainbow', palette: 'classic', bg }; break;
      case 'gradient': draft.color = { kind: 'gradient', from: 52, to: 60, bg }; break;
      case 'wordCycle': draft.color = { kind: 'wordCycle', colors: [4, 12], bg }; break;
    }
  }

  function toggleWordColor(code: number): void {
    if (draft.color.kind !== 'wordCycle') return;
    const i = draft.color.colors.indexOf(code);
    if (i >= 0) {
      if (draft.color.colors.length > 1) draft.color.colors.splice(i, 1);
    } else if (draft.color.colors.length < 8) {
      draft.color.colors.push(code);
    }
  }

  // ── Fonts ──
  let fontEntries = $state<FontEntry[]>([]);
  let fontLoading = $state(false);
  let fontError = $state<string | null>(null);
  let fontFilter = $state('');
  let fontSort = $state<FontSort>('rows');
  let unicodeSamples = $state<Record<string, string> | null>(null);
  let galleryKind = $state<ArtFontKind>(draft.font.kind === 'tdf' ? 'tdf' : 'figlet');

  const fontList = $derived(sortFonts(filterFonts(fontEntries, fontFilter), fontSort));
  const selectedFontName = $derived(fontIsArt && draft.font.kind !== 'none' && 'font' in draft.font ? draft.font.font : null);
  const galleryWord = $derived((previewText.trim().split(/\s+/)[0] ?? '').slice(0, 14) || 'Fiber');
  const gallerySelected = $derived(
    (draft.font.kind === 'figlet' || draft.font.kind === 'tdf') && draft.font.kind === galleryKind ? draft.font.font : null,
  );

  // The font list follows whichever art family the draft uses.
  $effect(() => {
    const kind = draft.font.kind;
    if (kind !== 'figlet' && kind !== 'tdf') {
      fontEntries = [];
      return;
    }
    fontLoading = true;
    fontError = null;
    listArtFonts(kind)
      .then((list) => { if (draft.font.kind === kind) fontEntries = list; })
      .catch((e: unknown) => { if (draft.font.kind === kind) fontError = e instanceof Error ? e.message : String(e); })
      .finally(() => { if (draft.font.kind === kind) fontLoading = false; });
  });

  async function setFontKind(kind: FontMode['kind']): Promise<void> {
    fontFilter = '';
    switch (kind) {
      case 'none':
        draft.font = { kind: 'none' };
        break;
      case 'figlet':
      case 'tdf': {
        galleryKind = kind;
        if (draft.font.kind === kind) break;
        const list = await listArtFonts(kind);
        const preferred = kind === 'figlet' ? list.find((f) => f.name === 'ANSI Regular') : undefined;
        const pick = preferred ?? list[0];
        if (pick) draft.font = fontMode(pick);
        break;
      }
      case 'unicode': {
        if (!unicodeSamples) {
          const { applyUnicodeStyle } = await import('../lib/textEffects');
          unicodeSamples = Object.fromEntries(UNICODE_STYLES.map((s) => [s, applyUnicodeStyle('Sample', s)]));
        }
        draft.font = { kind: 'unicode', style: draft.font.kind === 'unicode' ? draft.font.style : 'bold' };
        break;
      }
    }
  }

  if (draft.font.kind === 'unicode') void setFontKind('unicode');

  function pickGalleryFont(entry: FontEntry): void {
    galleryKind = entry.kind;
    draft.font = fontMode(entry);
  }

  function apply(): void {
    globalPrefs.composeStyle = structuredClone($state.snapshot(draft));
    close();
  }

  function reset(): void {
    draft = structuredClone(DEFAULT_COMPOSE_STYLE);
  }

  /// Cmd/Ctrl+Enter applies. Escape is handled here as well as in App's
  /// global chain so it works while focus is inside one of the panels.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      apply();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

{#snippet seg(options: { value: string | number; label: string; title?: string }[], current: string | number, pick: (v: any) => void, disabled = false)}
  <div class="cs-seg" role="radiogroup" aria-disabled={disabled}>
    {#each options as o (o.value)}
      <button type="button" role="radio" aria-checked={o.value === current} class:selected={o.value === current}
              title={o.title} {disabled} onclick={() => pick(o.value)}>{o.label}</button>
    {/each}
  </div>
{/snippet}

{#snippet swatches(selected: number | number[] | null, pick: (code: number) => void, disabled = false, allowNone = false)}
  <div class="cs-swatches" class:disabled class:with-none={allowNone}>
    {#if allowNone}
      <button type="button" class="cs-swatch none" class:selected={selected === null} title="None" {disabled}
              aria-label="No background" onclick={() => pick(-1)}>×</button>
    {/if}
    {#each CODES as code (code)}
      {@const sel = Array.isArray(selected) ? selected.includes(code) : selected === code}
      <button type="button" class="cs-swatch" class:selected={sel} class:ring={code >= 16 && (code - 16) % 12 === 0}
              style:background-color={colorHex(code)} title={swatchTitle(code)} aria-label={swatchTitle(code)} aria-pressed={sel}
              {disabled} onclick={() => pick(code)}>
        {#if Array.isArray(selected) && sel}<span class="cs-swatch-order">{selected.indexOf(code) + 1}</span>{/if}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet bgGrid(mode: Exclude<ColorMode, { kind: 'none' }>)}
  <div class="cs-sub">Background</div>
  {@render swatches(mode.bg, (c) => { mode.bg = c < 0 ? null : c; }, false, true)}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="compose-style-page csp" role="presentation" onkeydown={onKeydown}>
  <header class="csp-head">
    <div class="csp-headline">
      <h2>Text style</h2>
      <p class="csp-summary" class:active={draftActive}>{summary}</p>
    </div>
    <div class="csp-actions">
      <button type="button" class="csp-btn" onclick={reset} disabled={!draftActive}>Reset</button>
      <button type="button" class="csp-btn" onclick={close}>Cancel</button>
      <button type="button" class="csp-btn primary" onclick={apply} title="Apply (⌘/Ctrl + Enter)">Apply</button>
    </div>
  </header>

  <nav class="csp-tabs" role="tablist" aria-label="Style sections">
    <button type="button" role="tab" aria-selected={tab === 'text'} class:active={tab === 'text'} onclick={() => { tab = 'text'; }}>Text</button>
    <button type="button" role="tab" aria-selected={tab === 'colour'} class:active={tab === 'colour'} onclick={() => { tab = 'colour'; }}>Colour</button>
    <button type="button" role="tab" aria-selected={tab === 'font'} class:active={tab === 'font'} onclick={() => { tab = 'font'; }}>Font</button>
    <button type="button" role="tab" aria-selected={tab === 'gallery'} class:active={tab === 'gallery'} onclick={() => { tab = 'gallery'; }}>Gallery</button>
  </nav>

  <div class="csp-main">
    <section class="csp-panel" role="tabpanel" aria-label={tab}>
      {#if tab === 'text'}
        <div class="cs-group">
          <div class="cs-label">Attributes</div>
          <div class="cs-chips">
            <button type="button" class="cs-chip" aria-pressed={draft.bold} onclick={() => { draft.bold = !draft.bold; }}><b>Bold</b></button>
            <button type="button" class="cs-chip" aria-pressed={draft.italic} onclick={() => { draft.italic = !draft.italic; }}><i>Italic</i></button>
            <button type="button" class="cs-chip" aria-pressed={draft.underline} onclick={() => { draft.underline = !draft.underline; }}><u>Underline</u></button>
            <button type="button" class="cs-chip" aria-pressed={draft.strikethrough} onclick={() => { draft.strikethrough = !draft.strikethrough; }}><s>Strike</s></button>
            <button type="button" class="cs-chip" aria-pressed={draft.monospace} onclick={() => { draft.monospace = !draft.monospace; }}><code>Mono</code></button>
            <button type="button" class="cs-chip cs-chip-reverse" aria-pressed={draft.reverse} onclick={() => { draft.reverse = !draft.reverse; }}>Reverse</button>
          </div>
        </div>

        <div class="cs-group">
          <div class="cs-label">Case</div>
          {@render seg([
            { value: 'none', label: 'Off' }, { value: 'upper', label: 'UPPER' }, { value: 'lower', label: 'lower' }, { value: 'mocking', label: 'mOcKiNg' },
          ], draft.caseMode, (v) => { draft.caseMode = v; })}
        </div>

        <div class="cs-group">
          <div class="cs-label">Zalgo</div>
          <div>
            {@render seg([
              { value: 0, label: 'Off' }, { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' },
            ].map((o) => ({ ...o, title: fontIsArt ? 'Not with FIGlet or TheDraw fonts' : undefined })), draft.zalgo, (v) => { draft.zalgo = v; }, fontIsArt)}
            {#if fontIsArt}<div class="cs-note">Art fonts draw their own glyphs — combining marks would break the rows.</div>{/if}
          </div>
        </div>
      {:else if tab === 'colour'}
        <div class="cs-group">
          <div class="cs-label">Mode</div>
          {@render seg([
            { value: 'none', label: 'Off' }, { value: 'solid', label: 'Solid' }, { value: 'rainbow', label: 'Rainbow' },
            { value: 'gradient', label: 'Gradient' }, { value: 'wordCycle', label: 'Words' },
          ], draft.color.kind, setColorKind, colorLocked)}
        </div>
        {#if colorLocked}
          <div class="cs-note">TheDraw fonts carry their own colours.</div>
        {:else if draft.color.kind === 'solid'}
          <div class="cs-group">
            <div class="cs-label">Text</div>
            <div>
              {@render swatches(draft.color.fg, (c) => { if (draft.color.kind === 'solid') draft.color.fg = c; })}
              {@render bgGrid(draft.color)}
            </div>
          </div>
        {:else if draft.color.kind === 'rainbow'}
          <div class="cs-group">
            <div class="cs-label">Palette</div>
            <div>
              {@render seg([{ value: 'classic', label: 'Classic 7' }, { value: 'smooth', label: 'Smooth 12' }], draft.color.palette,
                (v) => { if (draft.color.kind === 'rainbow') draft.color.palette = v; })}
              {@render bgGrid(draft.color)}
            </div>
          </div>
        {:else if draft.color.kind === 'gradient'}
          <div class="cs-group">
            <div class="cs-label">Ramp</div>
            <div>
              <div class="cs-sub">From</div>
              {@render swatches(draft.color.from, (c) => { if (draft.color.kind === 'gradient') draft.color.from = c; })}
              <div class="cs-sub">To</div>
              {@render swatches(draft.color.to, (c) => { if (draft.color.kind === 'gradient') draft.color.to = c; })}
              {@render bgGrid(draft.color)}
            </div>
          </div>
        {:else if draft.color.kind === 'wordCycle'}
          <div class="cs-group">
            <div class="cs-label">Words</div>
            <div>
              <div class="cs-sub">Cycle ({draft.color.colors.length}/8 — click to add or remove)</div>
              {@render swatches(draft.color.colors, toggleWordColor)}
              {@render bgGrid(draft.color)}
            </div>
          </div>
        {/if}
      {:else if tab === 'font'}
        <div class="cs-group">
          <div class="cs-label">Family</div>
          {@render seg([
            { value: 'none', label: 'None' }, { value: 'figlet', label: 'FIGlet' }, { value: 'tdf', label: 'TheDraw' }, { value: 'unicode', label: 'Unicode' },
          ], draft.font.kind, (v) => { void setFontKind(v); })}
        </div>

        {#if draft.font.kind === 'none'}
          <div class="cs-note">Messages send in the reader's own font.</div>
        {:else if draft.font.kind === 'unicode'}
          <div class="cs-group">
            <div class="cs-label">Style</div>
            <div class="cs-chips">
              {#each UNICODE_STYLES as s (s)}
                <button type="button" class="cs-chip" aria-pressed={draft.font.kind === 'unicode' && draft.font.style === s}
                        title={s} onclick={() => { draft.font = { kind: 'unicode', style: s }; }}>{unicodeSamples?.[s] ?? s}</button>
              {/each}
            </div>
          </div>
        {:else}
          <div class="cs-group">
            <div class="cs-label">Pick</div>
            <div>
              <div class="csp-bar">
                <input type="search" class="cs-input" placeholder="Filter by name{draft.font.kind === 'tdf' ? ' or file' : ''}" bind:value={fontFilter}
                       onkeydown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
                {@render seg([{ value: 'rows', label: 'Rows' }, { value: 'name', label: 'Name' }], fontSort, (v) => { fontSort = v; })}
                <div class="csp-count">
                  {#if fontLoading}Loading…{:else}{fontList.length.toLocaleString()} of {fontEntries.length.toLocaleString()}{/if}
                </div>
                <button type="button" class="csp-btn small" onclick={() => { tab = 'gallery'; }}>Preview all →</button>
              </div>
              {#if fontError}
                <div class="cs-note warn">{fontError}</div>
              {/if}
              <ul class="cs-list" role="listbox" aria-label="Fonts">
                {#each fontList as f (f.name)}
                  <li role="option" aria-selected={f.name === selectedFontName} class:selected={f.name === selectedFontName}>
                    <button type="button" onclick={() => { draft.font = fontMode(f); }}>
                      <span class="cs-list-name">{f.name}</span>
                      {#if f.note}<span class="cs-list-meta">{f.note}</span>{/if}
                      <span class="cs-list-rows">{f.rows || '?'} rows</span>
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          </div>
          <div class="cs-group">
            <div class="cs-label">Width</div>
            <div>
              {@render seg([
                { value: 'off', label: 'Off', title: 'Send every art row whole — wide rows scroll' },
                { value: 'word', label: 'Wrap words', title: 'Fold long banners between words at the column limit' },
              ], draft.artWrap?.mode ?? 'off', (v) => { draft.artWrap = { mode: v as ArtWrapMode, width: draft.artWrap?.width ?? 80 }; })}
              {#if (draft.artWrap?.mode ?? 'off') === 'word'}
                <div class="csp-bar">
                  <input type="number" class="cs-input" aria-label="Wrap at column" min="20" max="400" step="1"
                         value={draft.artWrap?.width ?? 80}
                         oninput={(e) => { draft.artWrap = { mode: 'word', width: clampArtWrapWidth(Number(e.currentTarget.value)) }; }} />
                  <span class="cs-list-meta">columns (20–400)</span>
                </div>
                <div class="cs-note">Long banners fold between words — no glyph is ever cut mid-character. Off sends rows whole.</div>
              {/if}
            </div>
          </div>
        {/if}
      {:else}
        <FontGallery kind={galleryKind} initialSample={galleryWord} selected={gallerySelected}
                     onKind={(k) => { galleryKind = k; }} onSelect={pickGalleryFont} />
      {/if}
    </section>

    <aside class="csp-side">
      <div class="cs-label">Preview</div>
      <div class="csp-preview" aria-live="polite">{@html previewHtml}</div>
      <div class="csp-status">
        {#if previewError}
          <span class="warn">{previewError}</span>
        {:else}
          {previewLines} {previewLines === 1 ? 'line' : 'lines'} · longest {previewLongest} B
          {#if previewOver > 0}<span class="warn"> · {previewOver} over {PREVIEW_BUDGET} B, engine will wrap</span>{/if}
          {#if previewBusy}<span class="muted"> · rendering…</span>{/if}
        {/if}
      </div>
      <label class="csp-field wide">
        <span class="cs-label">Preview text</span>
        <input type="text" class="cs-input" bind:value={previewText} spellcheck="false"
               onkeydown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
      </label>
    </aside>
  </div>
</div>
