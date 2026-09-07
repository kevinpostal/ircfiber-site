<script lang="ts">
  /**
   * MotdBuilder — block editor for a MOTD recipe. Owns the block list UI
   * and the preview render; the parent owns persistence. Every recipe edit
   * re-renders with the same seed (stable preview while typing); "Reroll"
   * changes the seed so `random` fonts get re-picked.
   */
  import {
    type Recipe, type Block, type BannerBlock, RULE_CHARS, TDF_FONT_NAMES, FIGLET_FONT_NAMES,
    renderRecipe,
  } from '../lib/motdRecipe';
  import { MIRC_PALETTE } from '../lib/mirc';

  interface Props {
    recipe: Recipe;
    /** Fired with the rendered body (and fonts used) after every render. */
    onRendered: (body: string, fonts: string[]) => void;
  }
  let { recipe = $bindable(), onRendered }: Props = $props();

  let seed = $state(Date.now() & 0xffff);
  let rendering = $state(false);
  let renderError = $state<string | null>(null);
  let poolOpen = $state<number | null>(null);

  /** Small deterministic PRNG so the preview only changes on Reroll. */
  function mulberry32(a: number): () => number {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let renderGen = 0;
  function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => void doRender(), 150);
  }
  async function doRender() {
    const gen = ++renderGen;
    rendering = true;
    renderError = null;
    try {
      const r = await renderRecipe($state.snapshot(recipe), mulberry32(seed));
      if (gen === renderGen) onRendered(r.body, r.fonts);
    } catch (e) {
      if (gen === renderGen) renderError = (e as Error).message;
    } finally {
      if (gen === renderGen) rendering = false;
    }
  }
  // Any change to the recipe tree or the seed re-renders.
  $effect(() => { JSON.stringify(recipe); seed; scheduleRender(); });

  export function reroll() { seed = (seed * 7919 + 17) & 0xffffff; }

  function add(kind: Block['kind']) {
    const b: Block =
      kind === 'banner' ? { kind, engine: 'tdf', text: 'IRC Fiber', font: 'random', pool: [], align: 'center', color: null }
      : kind === 'text' ? { kind, text: 'New line', align: 'left', color: null }
      : kind === 'rule' ? { kind, char: '─', color: 14 }
      : kind === 'kv' ? { kind, rows: [{ k: 'Label', v: 'value' }], fill: '.', color: null }
      : { kind: 'spacer', lines: 1 };
    recipe.blocks.push(b);
  }
  function remove(i: number) { recipe.blocks.splice(i, 1); }
  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= recipe.blocks.length) return;
    const [b] = recipe.blocks.splice(i, 1);
    recipe.blocks.splice(j, 0, b);
  }
  function fontsFor(b: BannerBlock): string[] { return b.engine === 'tdf' ? TDF_FONT_NAMES : FIGLET_FONT_NAMES; }
  function togglePool(b: BannerBlock, f: string) {
    const i = b.pool.indexOf(f);
    if (i === -1) b.pool.push(f); else b.pool.splice(i, 1);
  }
  const COLORS = MIRC_PALETTE.map((hex, i) => ({ i, hex }));
</script>

{#snippet colorPick(value: number | null, set: (v: number | null) => void, label = 'Colour')}
  <label class="flex items-center gap-1.5 text-xs text-muted">
    <span>{label}</span>
    <select
      value={value === null ? '' : String(value)}
      onchange={(e) => set((e.currentTarget as HTMLSelectElement).value === '' ? null : Number((e.currentTarget as HTMLSelectElement).value))}
      class="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs"
    >
      <option value="">none</option>
      {#each COLORS as c (c.i)}
        <option value={String(c.i)}>{c.i} {c.hex}</option>
      {/each}
    </select>
    {#if value !== null}
      <span class="inline-block h-3 w-3 rounded-sm border border-border" style="background:{MIRC_PALETTE[value]}"></span>
    {/if}
  </label>
{/snippet}

<div class="space-y-3">
  <div class="flex flex-wrap items-center gap-3 text-xs">
    <label class="flex items-center gap-1.5 text-muted">
      <span>Width</span>
      <input type="number" min="40" max="120" bind:value={recipe.width} class="w-16 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs" />
    </label>
    <label class="flex items-center gap-1.5 text-muted">
      <span>Frame</span>
      <select bind:value={recipe.frame} class="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs">
        <option value="none">none</option>
        <option value="single">single ┌─┐</option>
        <option value="double">double ╔═╗</option>
        <option value="heavy">heavy ┏━┓</option>
        <option value="hash">hash ###</option>
      </select>
    </label>
    {#if recipe.frame !== 'none'}
      {@render colorPick(recipe.frameColor, (v) => { recipe.frameColor = v; }, 'Frame colour')}
    {/if}
    <span class="ml-auto flex items-center gap-2">
      {#if renderError}<span class="text-danger">{renderError}</span>{/if}
      {#if rendering}<span class="text-muted">rendering…</span>{/if}
      <button type="button" onclick={reroll} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40" title="Re-pick every random font">
        Reroll fonts
      </button>
    </span>
  </div>

  <ol class="space-y-2">
    {#each recipe.blocks as b, i (i)}
      <li class="rounded-md border border-border bg-surface-1 p-2.5">
        <div class="mb-2 flex items-center gap-2 text-xs">
          <span class="rounded bg-border px-1.5 py-0.5 font-mono uppercase tracking-wider text-muted">{b.kind}</span>
          <span class="ml-auto flex gap-1">
            <button type="button" onclick={() => move(i, -1)} disabled={i === 0} class="rounded border border-border px-1.5 disabled:opacity-30" title="Move up">↑</button>
            <button type="button" onclick={() => move(i, 1)} disabled={i === recipe.blocks.length - 1} class="rounded border border-border px-1.5 disabled:opacity-30" title="Move down">↓</button>
            <button type="button" onclick={() => remove(i)} class="rounded border border-danger/40 px-1.5 text-danger" title="Remove">×</button>
          </span>
        </div>

        {#if b.kind === 'banner'}
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <input type="text" bind:value={b.text} class="w-40 rounded border border-border bg-surface-2 px-2 py-1 text-sm" />
            <select bind:value={b.engine} onchange={() => { b.font = 'random'; b.pool = []; }} class="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs">
              <option value="tdf">TheDraw (colour)</option>
              <option value="figlet">FIGlet</option>
            </select>
            <select bind:value={b.font} class="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs">
              <option value="random">random{b.pool.length ? ` (${b.pool.length} in pool)` : ' (all)'}</option>
              {#each fontsFor(b) as f (f)}<option value={f}>{f}</option>{/each}
            </select>
            {#if b.font === 'random'}
              <button type="button" onclick={() => { poolOpen = poolOpen === i ? null : i; }} class="rounded border border-border px-2 py-0.5 text-xs">
                {poolOpen === i ? 'close pool' : 'edit pool'}
              </button>
            {/if}
            <select bind:value={b.align} class="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs">
              <option value="left">left</option>
              <option value="center">center</option>
            </select>
            {#if b.engine === 'figlet'}
              {@render colorPick(b.color, (v) => { b.color = v; })}
            {/if}
          </div>
          {#if b.font === 'random' && poolOpen === i}
            <div class="mt-2 flex max-h-40 flex-wrap gap-1 overflow-y-auto rounded border border-border/60 p-2">
              {#each fontsFor(b) as f (f)}
                <button type="button" onclick={() => togglePool(b, f)}
                  class="rounded px-1.5 py-0.5 font-mono text-[11px] {b.pool.includes(f) ? 'bg-primary/20 text-primary' : 'bg-surface-2 text-muted'}">{f}</button>
              {/each}
              <span class="w-full pt-1 text-[11px] text-muted">Empty pool = every font. Selected fonts are picked from on each reroll / variant.</span>
            </div>
          {/if}
        {:else if b.kind === 'text'}
          <div class="flex flex-wrap items-start gap-2 text-xs">
            <textarea bind:value={b.text} rows="2" spellcheck="false" class="min-w-64 flex-1 rounded border border-border bg-surface-2 px-2 py-1 font-mono text-[12px]"></textarea>
            <div class="flex flex-col gap-1.5">
              <select bind:value={b.align} class="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs">
                <option value="left">left</option>
                <option value="center">center</option>
              </select>
              {@render colorPick(b.color, (v) => { b.color = v; })}
            </div>
          </div>
        {:else if b.kind === 'rule'}
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <select bind:value={b.char} class="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
              {#each RULE_CHARS as c (c)}<option value={c}>{c.repeat(8)}</option>{/each}
            </select>
            {@render colorPick(b.color, (v) => { b.color = v; })}
          </div>
        {:else if b.kind === 'kv'}
          <div class="space-y-1 text-xs">
            {#each b.rows as row, ri (ri)}
              <div class="flex items-center gap-1.5">
                <input type="text" bind:value={row.k} class="w-44 rounded border border-border bg-surface-2 px-2 py-0.5 font-mono text-[12px]" />
                <input type="text" bind:value={row.v} class="flex-1 rounded border border-border bg-surface-2 px-2 py-0.5 font-mono text-[12px]" />
                <button type="button" onclick={() => b.rows.splice(ri, 1)} class="rounded border border-border px-1.5 text-danger">×</button>
              </div>
            {/each}
            <div class="flex items-center gap-2">
              <button type="button" onclick={() => b.rows.push({ k: '', v: '' })} class="rounded border border-border px-2 py-0.5">+ row</button>
              <label class="flex items-center gap-1 text-muted">fill <input type="text" bind:value={b.fill} maxlength="1" class="w-8 rounded border border-border bg-surface-2 px-1 text-center font-mono" /></label>
              {@render colorPick(b.color, (v) => { b.color = v; })}
            </div>
          </div>
        {:else if b.kind === 'spacer'}
          <label class="flex items-center gap-1.5 text-xs text-muted">
            blank lines <input type="number" min="1" max="10" bind:value={b.lines} class="w-14 rounded border border-border bg-surface-2 px-1.5 py-0.5" />
          </label>
        {/if}
      </li>
    {/each}
  </ol>

  <div class="flex flex-wrap items-center gap-1.5 text-xs">
    <span class="text-muted">Add:</span>
    {#each ['banner', 'text', 'rule', 'kv', 'spacer'] as k (k)}
      <button type="button" onclick={() => add(k as Block['kind'])} class="rounded-md border border-border bg-surface-2 px-2 py-0.5 hover:border-primary/40">{k}</button>
    {/each}
  </div>
</div>
