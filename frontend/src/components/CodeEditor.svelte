<script lang="ts">
  import hljs from 'highlight.js/lib/common';
  import 'highlight.js/styles/atom-one-dark.css';

  interface Props {
    value: string;
    language?: string;
    oninput?: (v: string) => void;
    readonly?: boolean;
    showGutter?: boolean;
    twilight?: boolean;
  }
  let { value = $bindable(''), language = 'text', oninput, readonly = false, showGutter = true, twilight = false }: Props = $props();

  const HLJS_MAP: Record<string, string> = {
    text: 'plaintext',
    c_cpp: 'cpp',
    csharp: 'csharp',
    golang: 'go',
    graphqlschema: 'graphql',
    java: 'java',
    javascript: 'javascript',
    json: 'json',
    json5: 'json',
    kotlin: 'kotlin',
    less: 'less',
    lua: 'lua',
    makefile: 'makefile',
    markdown: 'markdown',
    python: 'python',
    ruby: 'ruby',
    rust: 'rust',
    scss: 'scss',
    sh: 'bash',
    shell: 'bash',
    sql: 'sql',
    swift: 'swift',
    typescript: 'typescript',
    tsx: 'tsx',
    jsx: 'javascript',
    xml: 'xml',
    yaml: 'yaml',
    dockerfile: 'dockerfile',
    ini: 'ini',
    nginx: 'nginx',
    protobuf: 'protobuf',
    powershell: 'powershell',
    r: 'r',
    toml: 'toml',
    twig: 'twig',
    verilog: 'verilog',
    vhdl: 'vhdl',
    zig: 'zig',
    css: 'css',
    perl: 'perl',
    php: 'php',
    dart: 'dart',
  };

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  let highlightedHtml = $derived.by(() => {
    if (!value) return '';
    if (language === 'text') return escapeHtml(value);
    const raw = HLJS_MAP[language ?? 'text'] ?? (language ?? 'text');
    const useLang = hljs.getLanguage(raw) ? raw : 'plaintext';
    try {
      return hljs.highlight(value, { language: useLang }).value;
    } catch {
      try {
        return hljs.highlightAuto(value).value;
      } catch {
        return escapeHtml(value);
      }
    }
  });

  let gutterText = $derived.by(() => {
    const n = Math.max(value.split('\n').length, 1);
    const nums: string[] = [];
    for (let i = 1; i <= n; i++) nums.push(String(i));
    return nums.join('\n');
  });

  // svelte-ignore non_reactive_update — bind:this targets, not user state
  let editorEl: HTMLTextAreaElement | undefined;
  let hlEl: HTMLPreElement | undefined;
  let gutterEl: HTMLPreElement | undefined;

  function syncScroll(): void {
    if (!editorEl) return;
    const top = editorEl.scrollTop;
    const left = editorEl.scrollLeft;
    if (hlEl) {
      hlEl.scrollTop = top;
      hlEl.scrollLeft = left;
    }
    if (gutterEl) gutterEl.scrollTop = top;
  }

  function onEditorInput(): void {
    syncScroll();
    oninput?.(value);
  }
</script>
<div class="codeEditor" class:readonly class:twilight>
  {#if showGutter}<pre bind:this={gutterEl} class="gutter" aria-hidden="true">{gutterText}</pre>{/if}
  <div class="editorWrap" class:readonly>
    <pre bind:this={hlEl} class="hlLayer" class:readonly aria-hidden="true"><code>{@html highlightedHtml}</code></pre>
    {#if !readonly}
    <textarea
      bind:this={editorEl}
      bind:value
      oninput={onEditorInput}
      onscroll={syncScroll}
      class="editLayer"
      wrap="off"
      autocapitalize="off"
      spellcheck="false"
      aria-label="Code editor"
    ></textarea>
    {/if}
  </div>
</div>

<style>
  .codeEditor {
    display: flex;
    align-items: stretch;
    flex: 1 1 auto;
    min-height: 0;
    background: #282c34;
    overflow: hidden;
  }
  .gutter,
  .hlLayer,
  .editLayer {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 12px;
    line-height: 20px;
  }
  .gutter {
    flex: 0 0 auto;
    width: var(--gutter-width, 41px);
    min-width: var(--gutter-width, 41px);
    margin: 0;
    padding-left: var(--padding-left, 0);
    padding-right: var(--padding-right, 6px);
    padding-top: 0;
    padding-bottom: 0;
    text-align: right;
    color: var(--line-number-color, #5c6370);
    background: #21252b;
    border-right: 1px solid var(--border-color, #2c313a);
    user-select: none;
    overflow: hidden;
    white-space: pre;
  }
  .editorWrap {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    padding: 6px;
  }
  .hlLayer {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 0 4px;
    background: transparent;
    color: #abb2bf;
    overflow: hidden;
    scrollbar-gutter: stable;
    pointer-events: none;
    white-space: pre;
    word-wrap: normal;
  }
  .hlLayer code {
    background: transparent;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 12px !important;
    line-height: 20px !important;
    white-space: inherit;
    letter-spacing: normal;
    word-spacing: normal;
    tab-size: 4;
  }
  .editLayer {
    position: absolute;
    inset: 0;
    display: block;
    box-sizing: border-box;
    padding: 0 4px !important;
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 12px !important;
    line-height: 20px !important;
    background: transparent !important;
    color: transparent !important;
    caret-color: #e6e6e6;
    border: 0;
    outline: 0;
    resize: none;
    min-height: 0;
    max-height: none;
    overflow-y: scroll;
    overflow-x: auto;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: #4d5867 #1e1e1e;
    white-space: pre;
    word-wrap: normal;
    letter-spacing: normal;
    word-spacing: normal;
    tab-size: 4;
  }
  .editLayer::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }
  .editLayer::-webkit-scrollbar-track {
    background: #1e1e1e;
  }
  .editLayer::-webkit-scrollbar-thumb {
    background: #4d5867;
    border-radius: 5px;
    border: 2px solid #1e1e1e;
  }
  .editLayer::-webkit-scrollbar-thumb:hover {
    background: #5a6b7d;
  }
  .editLayer::selection {
    background: rgba(88, 166, 255, 0.3);
    color: #e6e6e6;
  }
  .editLayer::-moz-selection {
    background: rgba(88, 166, 255, 0.3);
  }
  /* readonly: no textarea, hlLayer flows naturally; outer .editor height drives page scroll */
  .codeEditor.readonly { overflow: visible; height: auto; min-height: 0; flex: none; display: flex; align-items: flex-start; }
  .codeEditor.readonly .gutter { overflow: visible; height: auto; padding: 6px 6px 6px 0; }
  .codeEditor.readonly .editorWrap { overflow: visible; height: auto; flex: 1 1 auto; display: block; padding: 0; }
  .codeEditor.readonly .hlLayer {
    position: relative;
    inset: auto;
    pointer-events: auto;
    user-select: text;
    overflow: visible;
    padding: 6px 4px;
  }
  .codeEditor.twilight { background: #141414; }
  .codeEditor.twilight .gutter { background: #232323; color: var(--line-number-color, #E2E2E2); border-right-color: var(--border-color, #232323); }
  .codeEditor.twilight .hlLayer { color: #ffffff; }
  .codeEditor.twilight :global(.hljs) { background: #141414; color: #ffffff; }
  .codeEditor.twilight :global(.hljs-meta),
  .codeEditor.twilight :global(.hljs-selector-tag) { color: #CDA869; }
  .codeEditor.twilight :global(.hljs-string) { color: #8F9D6A; }
  .codeEditor.twilight :global(.hljs-regexp) { color: #E9C062; }
  .codeEditor.twilight :global(.hljs-comment) { color: #5F5A60; font-style: italic; }
  .codeEditor.twilight :global(.hljs-variable),
  .codeEditor.twilight :global(.hljs-template-variable) { color: #7587A6; }
  .codeEditor.twilight :global(.hljs-tag),
  .codeEditor.twilight :global(.hljs-name) { color: #AC885B; }
  .codeEditor.twilight :global(.hljs-attr) { color: #7587A6; }
  .codeEditor.twilight :global(.hljs-attribute) { color: #9B859D; }
  .codeEditor.twilight :global(.hljs-title),
  .codeEditor.twilight :global(.hljs-title\.function),
  .codeEditor.twilight :global(.hljs-title\.class) { color: #AC885B; }
  .codeEditor.twilight :global(.hljs-built_in) { color: #9B859D; }
  .codeEditor.twilight :global(.hljs-number),
  .codeEditor.twilight :global(.hljs-literal),
  .codeEditor.twilight :global(.hljs-constant) { color: #CF6A4C; }
  .codeEditor.twilight :global(.hljs-type) { color: #9B859D; }
  .codeEditor.twilight :global(.hljs-selector-class),
  .codeEditor.twilight :global(.hljs-selector-id),
  .codeEditor.twilight :global(.hljs-storage) { color: #F9EE98; }
  .codeEditor.twilight :global(.hljs-support),
  .codeEditor.twilight :global(.hljs-support\.function) { color: #DAD085; }
  .codeEditor.twilight :global(.hljs-support\.constant) { color: #CF6A4C; }
</style>
