<script lang="ts">
  import { untrack } from 'svelte';
  import Dialog from './Dialog.svelte';
  import { globalPrefs } from '../stores/preferences.svelte';
  import { DEFAULT_COMPOSE_STYLE, type ComposeStyle, type ColorMode, type FontMode, type UnicodeStyle } from '../lib/composeStyle';
  import { colorHex, IRC_COLORS, parseIrcFormatting } from '../lib/ircFormatting';
  import { utf8Length } from '../lib/messageSplitter';
  import type { TdfFontMeta } from '../lib/tdf';

  interface Props {
    sampleText: string;
    onClose: () => void;
  }
  let { sampleText, onClose }: Props = $props();

  const PREVIEW_BUDGET = 400;
  const SAMPLE = 'The quick brown fox jumps over the lazy dog';
  const CODES = Array.from({ length: 99 }, (_, i) => i);
  const UNICODE_STYLES: UnicodeStyle[] = ['fullwidth', 'bold', 'italic', 'boldItalic', 'script', 'fraktur', 'doubleStruck', 'monospace', 'circled', 'smallCaps', 'upsideDown'];

  let draft = $state<ComposeStyle>(structuredClone($state.snapshot(globalPrefs.composeStyle)));

  // ── Preview ──
  let previewHtml = $state('');
  let previewLines = $state(0);
  let previewLongest = $state(0);
  let previewOver = $state(0);
  let previewError = $state<string | null>(null);
  let previewBusy = $state(false);

  $effect(() => {
    const snap = $state.snapshot(draft);
    const src = sampleText.trim() || SAMPLE;
    const timer = setTimeout(() => {
      untrack(() => { previewBusy = true; });
      void import('../lib/composePipeline')
        .then(({ renderComposeLines }) => renderComposeLines(src, snap, PREVIEW_BUDGET))
        .then((r) => {
          untrack(() => {
            previewHtml = r.lines.map((l) => `<div class="ircArtLine">${parseIrcFormatting(l)}</div>`).join('');
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
  const fontIsArt = $derived(draft.font.kind === 'figlet' || draft.font.kind === 'tdf');
  const colorLocked = $derived(draft.font.kind === 'tdf');

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
  let figletNames = $state<string[] | null>(null);
  let tdfFonts = $state<TdfFontMeta[] | null>(null);
  let tdfError = $state<string | null>(null);
  let unicodeSamples = $state<Record<string, string> | null>(null);
  let fontFilter = $state('');

  const filteredFiglet = $derived.by(() => {
    const q = fontFilter.trim().toLowerCase();
    const all = figletNames ?? [];
    return q ? all.filter((n) => n.toLowerCase().includes(q)) : all;
  });
  const filteredTdf = $derived.by(() => {
    const q = fontFilter.trim().toLowerCase();
    const all = tdfFonts ?? [];
    return q ? all.filter((f) => f.name.toLowerCase().includes(q) || f.file.toLowerCase().includes(q)) : all;
  });

  async function setFontKind(kind: FontMode['kind']): Promise<void> {
    fontFilter = '';
    switch (kind) {
      case 'none':
        draft.font = { kind: 'none' };
        break;
      case 'figlet': {
        if (!figletNames) figletNames = (await import('../lib/figlet')).FIGLET_FONT_NAMES;
        const font = draft.font.kind === 'figlet' ? draft.font.font : figletNames.includes('ANSI Regular') ? 'ANSI Regular' : figletNames[0];
        draft.font = { kind: 'figlet', font };
        break;
      }
      case 'tdf': {
        if (!tdfFonts) {
          try {
            tdfFonts = await (await import('../lib/tdf')).listTdfFonts();
            tdfError = null;
          } catch (e: unknown) {
            tdfError = e instanceof Error ? e.message : String(e);
            return;
          }
        }
        const font = draft.font.kind === 'tdf' ? draft.font.font : tdfFonts[0]?.name ?? '';
        draft.font = { kind: 'tdf', font };
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

  // Restore the font list when the dialog opens with a font already picked.
  if (draft.font.kind !== 'none') void setFontKind(draft.font.kind);

  function apply(): void {
    globalPrefs.composeStyle = structuredClone($state.snapshot(draft));
    onClose();
  }

  function reset(): void {
    draft = structuredClone(DEFAULT_COMPOSE_STYLE);
  }

  function swatchTitle(code: number): string {
    return code < 16 ? `${code} ${IRC_COLORS[code].name}` : String(code);
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

{#snippet bgGrid(mode: Exclude<ColorMode, { kind: 'none' }>, disabled: boolean)}
  <div class="cs-sub">Background</div>
  {@render swatches(mode.bg, (c) => { mode.bg = c < 0 ? null : c; }, disabled, true)}
{/snippet}

<Dialog open={true} {onClose} label="Text style" centered class="overlay-panel compose-style-panel">
  <div class="cs-body">
    <div class="cs-section cs-preview-section">
      <div class="cs-label">Preview</div>
      <div>
        <div class="cs-preview" aria-live="polite">{@html previewHtml}</div>
        <div class="cs-status">
          {#if previewError}
            <span class="warn">{previewError}</span>
          {:else}
            {previewLines} {previewLines === 1 ? 'line' : 'lines'} · longest {previewLongest} bytes
            {#if previewOver > 0}<span class="warn"> · {previewOver} over {PREVIEW_BUDGET} B, will wrap</span>{/if}
            {#if previewBusy}<span class="muted"> · rendering…</span>{/if}
          {/if}
        </div>
      </div>
    </div>

    <div class="cs-section">
      <div class="cs-label">Style</div>
      <div class="cs-chips">
        <button type="button" class="cs-chip" aria-pressed={draft.bold} onclick={() => { draft.bold = !draft.bold; }}><b>Bold</b></button>
        <button type="button" class="cs-chip" aria-pressed={draft.italic} onclick={() => { draft.italic = !draft.italic; }}><i>Italic</i></button>
        <button type="button" class="cs-chip" aria-pressed={draft.underline} onclick={() => { draft.underline = !draft.underline; }}><u>Underline</u></button>
        <button type="button" class="cs-chip" aria-pressed={draft.strikethrough} onclick={() => { draft.strikethrough = !draft.strikethrough; }}><s>Strike</s></button>
        <button type="button" class="cs-chip" aria-pressed={draft.monospace} onclick={() => { draft.monospace = !draft.monospace; }}><code>Mono</code></button>
        <button type="button" class="cs-chip cs-chip-reverse" aria-pressed={draft.reverse} onclick={() => { draft.reverse = !draft.reverse; }}>Reverse</button>
      </div>
    </div>

    <div class="cs-section">
      <div class="cs-label">Case</div>
      <div class="cs-row">
        {@render seg([
          { value: 'none', label: 'Off' }, { value: 'upper', label: 'UPPER' }, { value: 'lower', label: 'lower' }, { value: 'mocking', label: 'mOcKiNg' },
        ], draft.caseMode, (v) => { draft.caseMode = v; })}
        <span class="cs-inline-label">Zalgo</span>
        {@render seg([
          { value: 0, label: 'Off' }, { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' },
        ].map((o) => ({ ...o, title: fontIsArt ? 'Not with FIGlet or TheDraw fonts' : undefined })), draft.zalgo, (v) => { draft.zalgo = v; }, fontIsArt)}
      </div>
    </div>

    <div class="cs-section">
      <div class="cs-label">Colour</div>
      <div>
        {@render seg([
          { value: 'none', label: 'Off' }, { value: 'solid', label: 'Solid' }, { value: 'rainbow', label: 'Rainbow' },
          { value: 'gradient', label: 'Gradient' }, { value: 'wordCycle', label: 'Words' },
        ], draft.color.kind, setColorKind, colorLocked)}
        {#if colorLocked}
          <div class="cs-note">TheDraw fonts carry their own colours</div>
        {:else if draft.color.kind === 'solid'}
          <div class="cs-sub">Text</div>
          {@render swatches(draft.color.fg, (c) => { if (draft.color.kind === 'solid') draft.color.fg = c; })}
          {@render bgGrid(draft.color, false)}
        {:else if draft.color.kind === 'rainbow'}
          <div class="cs-sub">Palette</div>
          {@render seg([{ value: 'classic', label: 'Classic' }, { value: 'smooth', label: 'Smooth' }], draft.color.palette,
            (v) => { if (draft.color.kind === 'rainbow') draft.color.palette = v; })}
          {@render bgGrid(draft.color, false)}
        {:else if draft.color.kind === 'gradient'}
          <div class="cs-sub">From</div>
          {@render swatches(draft.color.from, (c) => { if (draft.color.kind === 'gradient') draft.color.from = c; })}
          <div class="cs-sub">To</div>
          {@render swatches(draft.color.to, (c) => { if (draft.color.kind === 'gradient') draft.color.to = c; })}
          {@render bgGrid(draft.color, false)}
        {:else if draft.color.kind === 'wordCycle'}
          <div class="cs-sub">Word colours ({draft.color.colors.length}/8, click to add or remove)</div>
          {@render swatches(draft.color.colors, toggleWordColor)}
          {@render bgGrid(draft.color, false)}
        {/if}
      </div>
    </div>

    <div class="cs-section">
      <div class="cs-label">Font</div>
      <div>
        {@render seg([
          { value: 'none', label: 'None' }, { value: 'figlet', label: 'FIGlet' }, { value: 'tdf', label: 'TheDraw' }, { value: 'unicode', label: 'Unicode' },
        ], draft.font.kind, (v) => { void setFontKind(v); })}
        {#if draft.font.kind === 'figlet'}
          {#if figletNames}
            <input type="search" class="cs-filter" placeholder="Filter {figletNames.length} fonts" bind:value={fontFilter}
                   onkeydown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
            <ul class="cs-list" role="listbox" aria-label="FIGlet fonts">
              {#each filteredFiglet as name (name)}
                <li role="option" aria-selected={draft.font.kind === 'figlet' && draft.font.font === name}
                    class:selected={draft.font.kind === 'figlet' && draft.font.font === name}>
                  <button type="button" onclick={() => { draft.font = { kind: 'figlet', font: name }; }}>{name}</button>
                </li>
              {/each}
            </ul>
          {:else}
            <div class="cs-note">Loading fonts…</div>
          {/if}
        {:else if draft.font.kind === 'tdf'}
          {#if tdfError}
            <div class="cs-note warn">{tdfError}</div>
          {:else if tdfFonts}
            <input type="search" class="cs-filter" placeholder="Filter {tdfFonts.length.toLocaleString()} fonts" bind:value={fontFilter}
                   onkeydown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
            <ul class="cs-list" role="listbox" aria-label="TheDraw fonts">
              {#each filteredTdf as f (f.name)}
                <li role="option" aria-selected={draft.font.kind === 'tdf' && draft.font.font === f.name}
                    class:selected={draft.font.kind === 'tdf' && draft.font.font === f.name}>
                  <button type="button" onclick={() => { draft.font = { kind: 'tdf', font: f.name }; }}>
                    {f.name}<span class="cs-list-meta">{f.file} · {f.height} rows</span>
                  </button>
                </li>
              {/each}
            </ul>
          {:else}
            <div class="cs-note">Loading 1,071 fonts…</div>
          {/if}
        {:else if draft.font.kind === 'unicode'}
          <div class="cs-chips">
            {#each UNICODE_STYLES as s (s)}
              <button type="button" class="cs-chip" aria-pressed={draft.font.kind === 'unicode' && draft.font.style === s}
                      title={s} onclick={() => { draft.font = { kind: 'unicode', style: s }; }}>{unicodeSamples?.[s] ?? s}</button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <div class="cs-footer">
      <button type="button" class="cs-reset" onclick={reset}>Reset</button>
      <button type="button" class="cs-apply" onclick={apply}>Apply</button>
    </div>
  </div>
</Dialog>
