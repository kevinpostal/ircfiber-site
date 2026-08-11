<script lang="ts">
  import hljs from 'highlight.js/lib/common';
  import 'highlight.js/styles/atom-one-dark.css';
  import { sendMessage } from '../stores/wsConnection.svelte';
  import { splitIntoMessages } from '../lib/messageSplitter';
  import { getPastebinDisablePrompt, setPastebinDisablePrompt } from '../stores/preferences.svelte';

  interface Props {
    open?: boolean;
    text?: string;
    networkId?: string;
    target?: string;
    initialFilename?: string;
    initialLanguage?: string;
    onclose?: () => void;
    onsent?: () => void;
  }
  let { open = false, text = '', networkId = '', target = '', initialFilename = '', initialLanguage = '', onclose: oncloseCb, onsent: onsentCb }: Props = $props();

  // Language selector — mirrors IRCCloud's <select> list verbatim (text default
  // + ~200 code modes).  We display the value, the backend only needs 'text'
  // (we don't actually post to a pastebin service in this build).
  const LANGUAGES = [
    'text','abap','abc','actionscript','ada','alda','apache_conf','apex','aql',
    'asciidoc','asl','assembly_arm32','assembly_x86','astro','autohotkey',
    'batchfile','bibtex','c_cpp','c9search','cirru','clojure','cobol','coffee',
    'coldfusion','crystal','csharp','csound_document','csound_orchestra',
    'csound_score','css','curly','cuttlefish','d','dart','diff','django',
    'dockerfile','dot','drools','edifact','eiffel','ejs','elixir','elm','erlang',
    'flix','forth','fortran','fsharp','fsl','ftl','gcode','gherkin','gitignore',
    'glsl','gobstones','golang','graphqlschema','groovy','haml','handlebars',
    'haskell','haskell_cabal','haxe','hjson','html','html_elixir','html_ruby',
    'ini','io','ion','jack','jade','java','javascript','jexl','json','json5',
    'jsoniq','jsp','jssm','jsx','julia','kotlin','latex','latte','less','liquid',
    'lisp','livescript','log','logiql','logtalk','lsl','lua','luapage','lucene',
    'makefile','markdown','mask','matlab','maze','mediawiki','mel','mips',
    'mixal','mushcode','mysql','nasal','nginx','nim','nix','nsis','nunjucks',
    'objectivec','ocaml','odin','partiql','pascal','perl','pgsql','php',
    'php_laravel_blade','pig','plsql','powershell','praat','prisma','prolog',
    'properties','protobuf','prql','puppet','python','qml','r','raku','razor',
    'rdoc','red','rhtml','robot','rst','ruby','rust','sac','sass','scad',
    'scala','scheme','scrypt','scss','sh','sjs','slim','smarty','smithy',
    'snippets','soy-template','space','sparql','sql','sqlserver','stylus',
    'svg','swift','tcl','terraform','tex','textile','toml','tsx','turtle','twig',
    'typescript','vala','vbscript','velocity','verilog','vhdl','visualforce',
    'vue','wollok','xml','xquery','yaml','zeek','zig',
  ] as const;

  // highlight.js language ids differ from ace ids for a few modes.
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

  let editor = $state(text);
  let lang = $state<string>('text');
  let name = $state('');
  let message = $state('');
  let askChecked = $state(!getPastebinDisablePrompt());
  let posting = $state(false);
  let error = $state<string | null>(null);

  // Live syntax highlight for the visible layer of the overlay editor.
  let highlightedHtml = $derived.by(() => {
    if (!editor) return '';
    if (lang === 'text') return escapeHtml(editor);
    const raw = HLJS_MAP[lang] ?? lang;
    const useLang = hljs.getLanguage(raw) ? raw : 'plaintext';
    try {
      return hljs.highlight(editor, { language: useLang }).value;
    } catch {
      try { return hljs.highlightAuto(editor).value; } catch { return escapeHtml(editor); }
    }
  });

  // Line-number gutter — derived so it tracks edits without making the
  // reset effect depend on `editor` (that dependency caused the reset
  // effect to re-fire after every keystroke and clobber the edit).
  let gutterText = $derived.by(() => {
    const n = Math.max(editor.split('\n').length, 1);
    const nums: string[] = [];
    for (let i = 1; i <= n; i++) nums.push(String(i));
    return nums.join('\n');
  });

  // Reset state every time the dialog opens with new text. Guarded by a
  // last-seen sentinel so an unrelated re-render can never clobber an
  // in-progress edit (and it never reads `editor`, so typing can't
  // re-trigger it).
  let lastAppliedText = '';
  $effect(() => {
    if (open && text !== lastAppliedText) {
      lastAppliedText = text;
      editor = text;
      // IRCCloud parity: when the dialog is opened from a text-file upload,
      // the language is auto-detected from the filename extension (ace/ext/modelist
      // getModeForPath). Multi-line paste keeps the old 'text' default.
      lang = initialLanguage && (LANGUAGES as readonly string[]).includes(initialLanguage) ? initialLanguage : 'text';
      name = initialFilename;
      message = '';
      askChecked = !getPastebinDisablePrompt();
      error = null;
      posting = false;
    }
  });

  // svelte-ignore non_reactive_update — bind:this targets, not user state
  let editorEl: HTMLTextAreaElement | undefined;
  let hlEl: HTMLPreElement | undefined;
  let gutterEl: HTMLPreElement | undefined;

  // Keep the highlighted layer + gutter scrolled in lockstep with the textarea.
  function syncScroll(): void {
    if (!editorEl) return;
    const top = editorEl.scrollTop;
    const left = editorEl.scrollLeft;
    if (hlEl) { hlEl.scrollTop = top; hlEl.scrollLeft = left; }
    if (gutterEl) gutterEl.scrollTop = top;
  }

  function onEditorInput(): void {
    syncScroll();
  }

  function onKeyDown(e: KeyboardEvent) {
    // Shift+Enter = send as messages
    if (e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      sendAsText();
    }
  }

  function close() {
    oncloseCb?.();
  }

  function onAskChange(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    askChecked = checked;
    setPastebinDisablePrompt(!checked);
  }

  // "Send as messages" — strict line-by-line.  Each newline-separated line
  // becomes its own PRIVMSG.  We deliberately do NOT greedy-pack because
  // multi-line content is almost always art where every line is
  // structurally significant (e.g. a metadata strip on the last line that
  // must render on its own row, not get space-joined onto the line above).
  function sendAsText() {
    const messages = splitIntoMessages(editor, 400, false);
    if (messages.length === 0) { close(); return; }
    oncloseCb?.();
    let i = 0;
    const sendNext = () => {
      if (i >= messages.length) {
        onsentCb?.();
        return;
      }
      const m = messages[i++];
      sendMessage(networkId, target, m);
      // Pace at ~30ms to avoid the WS batcher swallowing individual echoes
      setTimeout(sendNext, 30);
    };
    sendNext();
  }

  // "Post snippet" — host the text file like an image (via /api/upload),
  // preserving the selected language for inline highlighting. Falls back to
  // showing an error if the upload fails. Mirrors image upload flow.
  async function postSnippet(e: Event) {
    e.preventDefault();
    if (posting) return;
    posting = true;
    error = null;
    try {
      // Use the current filename or default to snippet.<ext> based on lang
      const extForLang: Record<string, string> = {
        python: 'py', javascript: 'js', typescript: 'ts', bash: 'sh', json: 'json',
        yaml: 'yaml', markdown: 'md', sql: 'sql', xml: 'xml', css: 'css', scss: 'scss',
        java: 'java', cpp: 'cpp', csharp: 'cs', go: 'go', rust: 'rs', ruby: 'rb',
        php: 'php', swift: 'swift', kotlin: 'kt', dart: 'dart', ini: 'ini',
        dockerfile: 'Dockerfile', makefile: 'Makefile', nginx: 'conf', lua: 'lua',
        perl: 'pl', powershell: 'ps1', r: 'r', graphql: 'graphql', protobuf: 'proto',
        twig: 'twig', verilog: 'v', vhdl: 'vhd', zig: 'zig', toml: 'toml',
        html: 'html', sh: 'sh',
      };
      const ext = extForLang[lang] ?? (lang === 'text' ? 'txt' : lang);
      const filename = (name?.trim() || initialFilename?.trim() || `snippet.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = new Blob([editor], { type: 'text/plain' });
      const file = new File([blob], filename, { type: 'text/plain' });
      // Use the same upload path as images — POST /api/upload
      const { uploadFile } = await import('../lib/upload');
      const handle = uploadFile(file, { filename, networkId, buffer: target });
      const result = await handle.promise;
      const url = result.url;
      const finalText = message ? `${message} ${url}` : url;
      oncloseCb?.();
      sendMessage(networkId, target, finalText);
      onsentCb?.();
    } catch (e) {
      error = (e as Error).message || 'Failed to upload snippet';
      posting = false;
    }
  }
</script>

{#if open}
  <div
    id="pastebinContainer"
    class="accountContainer pastebin"
    role="dialog"
    aria-modal="true"
    aria-labelledby="pastebinTitle"
  >
    <form id="pastebinForm" onsubmit={postSnippet} onkeydown={onKeyDown}>
      <span class="pastebinSelect">
        <select name="aceMode" bind:value={lang} aria-label="Language">
          {#each LANGUAGES as L}
            <option value={L}>{L === 'text' ? 'Plain Text' : L}</option>
          {/each}
        </select>
      </span>

      <h1 id="pastebinTitle" tabindex="0">Text snippet</h1>

      <div class="pastebinWrapper">
        <!-- Editable, live-highlighted preview: a transparent textarea sits
             over a highlighted <pre> with a synced line-number gutter.
             Edit the code directly; colors and numbers update live. -->
        <div class="codeEditor">
          <pre bind:this={gutterEl} class="gutter" aria-hidden="true">{gutterText}</pre>
          <div class="editorWrap">
            <pre bind:this={hlEl} class="hlLayer" aria-hidden="true"><code>{@html highlightedHtml}</code></pre>
            <textarea
              bind:this={editorEl}
              bind:value={editor}
              oninput={onEditorInput}
              onscroll={syncScroll}
              class="editLayer"
              wrap="off"
              autocapitalize="off"
              spellcheck="false"
              aria-label="Snippet contents"
            ></textarea>
          </div>
        </div>
      </div>

      <p class="pasteConfirm__public explanation">
        Text snippets are visible to anyone with the URL but are not publicly listed or indexed.
      </p>

      <p class="form">
        <label for="pastePreviewName">Choose a file name <span class="explanation">optional</span></label>
        <br>
        <input
          name="name"
          class="input"
          id="pastePreviewName"
          bind:value={name}
          placeholder="snippet.txt"
        />
      </p>

      <p class="form">
        <label for="pastePreviewMessage">Add a message <span class="explanation">optional</span></label>
        <br>
        <input
          name="message"
          class="input"
          id="pastePreviewMessage"
          bind:value={message}
        />
      </p>

      <p class="pasteConfirmExtra" id="pasteConfirmAskContainer">
        <input
          type="checkbox"
          id="pasteConfirmAsk"
          tabindex="-1"
          checked={askChecked}
          onchange={onAskChange}
        />
        <label for="pasteConfirmAsk">Offer to post a snippet when sending multi-line messages</label>
        <br>
        <span class="explanation">You can revert this in Settings</span>
      </p>

      {#if error}
        <p class="pasteError" role="alert">{error}</p>
      {/if}

      <p class="buttons">
        <button type="submit" class="action confirm" disabled={posting}>
          <span>{posting ? 'Posting…' : 'Post snippet'}</span>
        </button>
        <button type="button" class="sendAsText" onclick={sendAsText} disabled={posting}>
          <span>Send as messages</span>
        </button>
        <button type="button" class="close mainClose" onclick={close} disabled={posting}>
          <span>Cancel</span>
        </button>
      </p>

      <p class="pasteConfirm__help">
        Shortcuts: <strong>Return</strong> to post snippet / <strong>Shift</strong> <strong>Return</strong> to send as messages.
      </p>
    </form>
  </div>
{/if}

<style>
  .pastebin {
    /* IRCCloud parity: bounded dialog that always fits the window.
       IRCCloud .accountContainer: top:50px, width:550px, max-height:80%,
       margin-left:-275px, overflow:auto — content scrolls internally.
       We widen slightly for code and let the editor flex to fill. */
    position: fixed;
    top: 50px;
    left: 50%;
    transform: translateX(-50%);
    width: min(680px, 94vw);
    max-height: calc(100vh - 100px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 1000;
    background: #2a2a2a;
    color: #e6e6e6;
    border: 1px solid #4a4a4a;
    border-radius: 6px;
    padding: 16px 20px 20px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    box-sizing: border-box;
  }
  .pastebin form {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
  }
  .pastebin h1 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 8px;
    color: #fff;
    outline: none;
  }
  .pastebinSelect select {
    background: #1e1e1e;
    color: #e6e6e6;
    border: 1px solid #4a4a4a;
    border-radius: 3px;
    padding: 3px 6px;
    font-size: 12px;
    margin-bottom: 8px;
  }
  .pastebinWrapper {
    flex: 1 1 auto;
    min-height: 160px;
    margin: 8px 0 4px;
    border: 1px solid #1e1e1e;
    border-radius: 3px;
    overflow: hidden;
    display: flex;
  }
  .codeEditor {
    display: flex;
    align-items: stretch;
    flex: 1 1 auto;
    min-height: 0;
    background: #282c34;
    overflow: hidden;
  }
  /* All three layers share EXACT metrics so the overlay aligns pixel-perfect.
     Scoped under .pastebin so the compose-input rule
     `.bufferinputcell textarea { max-height:200px; padding:2px 0 2px 8px }`
     (which also matches this textarea as a DOM descendant) cannot clamp it. */
  .pastebin .gutter,
  .pastebin .hlLayer,
  .pastebin .editLayer {
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
    /* The highlight layer scrolls in lockstep with the textarea via
       syncScroll(); showing its own scrollbars creates the "double
       scrollbar" ghost. Hide them (overflow:hidden still honors
       programmatic scrollTop/scrollLeft). scrollbar-gutter:stable
       reserves the SAME gutter as the textarea so text never shifts. */
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
  .pastebin .editLayer {
    position: absolute;
    /* inset only (no width/height %): the textarea fills the wrapper
       exactly so its scrollbar track spans the whole editor. */
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
    /* Defeat the compose-input rule's max-height:200px clamp. */
    min-height: 0;
    max-height: none;
    /* Vertical scrollbar always visible (no appear/disappear shift) and
       its gutter reserved permanently, so the highlight layer — which
       reserves the same gutter — never drifts out of alignment.
       Horizontal scrollbar removed: long lines clip rather than flash a
       second scrollbar that would overlap the highlighted layer. */
    overflow-y: scroll;
    overflow-x: hidden;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: #4d5867 #1e1e1e;
    white-space: pre;
    word-wrap: normal;
    letter-spacing: normal;
    word-spacing: normal;
    tab-size: 4;
  }
  .pastebin .editLayer::-webkit-scrollbar {
    width: 10px;
  }
  .pastebin .editLayer::-webkit-scrollbar-track {
    background: #1e1e1e;
  }
  .pastebin .editLayer::-webkit-scrollbar-thumb {
    background: #4d5867;
    border-radius: 5px;
    border: 2px solid #1e1e1e;
  }
  .pastebin .editLayer::-webkit-scrollbar-thumb:hover {
    background: #5a6b7d;
  }
  .pastebin .editLayer::selection {
    background: rgba(88, 166, 255, 0.3);
    color: #e6e6e6;
  }
  .pastebin .editLayer::-moz-selection {
    background: rgba(88, 166, 255, 0.3);
  }
  .pasteConfirm__public,
  .explanation {
    color: #8b949e;
    font-size: 12px;
    margin: 6px 0;
  }
  .pastebin .form {
    margin: 10px 0;
  }
  .pastebin .form label {
    color: #e6e6e6;
    font-size: 12px;
    font-weight: 600;
  }
  .pastebin .form .input {
    width: 100%;
    background: #1e1e1e;
    color: #e6e6e6;
    border: 1px solid #4a4a4a;
    border-radius: 3px;
    padding: 5px 8px;
    font-size: 13px;
    margin-top: 4px;
    box-sizing: border-box;
  }
  .pastebin .form .input:focus {
    border-color: #58a6ff;
    outline: none;
  }
  .pasteConfirmExtra {
    color: #e6e6e6;
    font-size: 12px;
    margin: 10px 0;
  }
  .pasteConfirmExtra label {
    margin-left: 4px;
    cursor: pointer;
  }
  .pasteError {
    color: #ff7b72;
    background: rgba(255, 123, 114, 0.1);
    padding: 6px 10px;
    border-radius: 3px;
    margin: 8px 0;
  }
  .pastebin .buttons {
    display: flex;
    gap: 8px;
    margin: 14px 0 4px;
  }
  .pastebin .buttons button {
    background: #2a2a2a;
    color: #e6e6e6;
    border: 1px solid #4a4a4a;
    border-radius: 3px;
    padding: 6px 14px;
    font-size: 13px;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .pastebin .buttons button:hover:not(:disabled) {
    background: #3a3a3a;
    border-color: #5a5a5a;
  }
  .pastebin .buttons button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .pastebin .buttons button.confirm {
    background: #238636;
    color: #fff;
    border-color: #2ea043;
  }
  .pastebin .buttons button.confirm:hover:not(:disabled) {
    background: #2ea043;
  }
  .pastebin .buttons button.sendAsText {
    background: #1f6feb;
    color: #fff;
    border-color: #388bfd;
  }
  .pastebin .buttons button.sendAsText:hover:not(:disabled) {
    background: #388bfd;
  }
  .pasteConfirm__help {
    color: #6e7681;
    font-size: 11px;
    margin: 8px 0 0;
  }
</style>
