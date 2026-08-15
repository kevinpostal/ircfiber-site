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
    font-family: 'Hack', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 13px;
    line-height: 1.4;
  }
  .gutter {
    flex: 0 0 auto;
    min-width: 3.2em;
    margin: 0;
    padding: 12px 8px 12px 12px;
    text-align: right;
    color: #5c6370;
    background: #21252b;
    border-right: 1px solid #2c313a;
    user-select: none;
    overflow: hidden;
    white-space: pre;
  }
  .editorWrap {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  .hlLayer {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 12px 14px;
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
    font-family: 'Hack', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 13px !important;
    line-height: 1.4 !important;
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
    padding: 12px 14px !important;
    margin: 0;
    font-family: 'Hack', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 13px !important;
    line-height: 1.4 !important;
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
  /* readonly: hide textarea overlay, make hlLayer selectable + scrollable */
  .codeEditor.readonly .hlLayer {
    position: relative;
    pointer-events: auto;
    user-select: text;
    overflow: auto;
  }
  .codeEditor.readonly .editorWrap { overflow: auto; }
  .codeEditor.readonly .hlLayer::-webkit-scrollbar { width: 10px; height: 10px; }
  .codeEditor.readonly .hlLayer::-webkit-scrollbar-track { background: #1e1e1e; }
  .codeEditor.readonly .hlLayer::-webkit-scrollbar-thumb { background: #4d5867; border-radius: 5px; border: 2px solid #1e1e1e; }
  /* twilight theme — matches SnippetsPanel / IRCCloud ace-twilight */
  .codeEditor.twilight { background: #141414; }
  .codeEditor.twilight .gutter { background: #232323; color: #E2E2E2; border-right-color: #1a1a1a; }
  .codeEditor.twilight .hlLayer { color: #F8F8F8; }
  .codeEditor.twilight :global(.hljs) { background: #141414; color: #F8F8F8; }
  .codeEditor.twilight :global(.hljs-keyword),
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
  .codeEditor.twilight :global(.hljs-title) { color: #AC885B; }
  .codeEditor.twilight :global(.hljs-built_in) { color: #9B859D; }
  .codeEditor.twilight :global(.hljs-number),
  .codeEditor.twilight :global(.hljs-literal) { color: #CF6A4C; }
  .codeEditor.twilight :global(.hljs-type) { color: #9B859D; }
  .codeEditor.twilight :global(.hljs-selector-class),
  .codeEditor.twilight :global(.hljs-selector-id) { color: #F9EE98; }
</style>
