<script lang="ts">
  import CodeEditor from './CodeEditor.svelte';
  import { sendMessage } from '../stores/wsConnection.svelte';
  import { splitIntoMessages } from '../lib/messageSplitter';
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

  let editor = $state(text);
  let lang = $state<string>('text');
  let name = $state('');
  let message = $state('');
  let posting = $state(false);
  let error = $state<string | null>(null);

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
      error = null;
      posting = false;
    }
  });

  function onKeyDown(e: KeyboardEvent) {
    // Shift+Enter now inserts a new line (default textarea behavior) — the
    // previous Shift+Enter = send-as-text shortcut is removed per user
    // request. Use the buttons or plain Enter (with form submit) to act.
    // We intentionally do NOT prevent default for Shift+Enter so the
    // textarea can insert a newline.
    if (e.key === 'Enter' && !e.shiftKey && e.ctrlKey) {
      // Ctrl+Enter = send as messages (alternative to the button)
      e.preventDefault();
      sendAsText();
    }
  }

  function close() {
    oncloseCb?.();
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

  // "Post snippet" — create a pastebin via POST /api/pastebins and share the
  // viewer URL (/?/pastebin=<id>) in the channel. Falls back to error.
  async function postSnippet(e: Event) {
    e.preventDefault();
    if (posting) return;
    posting = true;
    error = null;
    try {
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
      const { createPastebin } = await import('../stores/api');
      const rec = await createPastebin({ name: filename, body: editor, syntax: lang, networkId, buffer: target });
      const viewerPath = `/?/pastebin=${encodeURIComponent(rec.id)}`;
      const url = `${window.location.origin}${viewerPath}`;
      const rawUrl = `${window.location.origin}/api/pastebins/${encodeURIComponent(rec.id)}/raw`;
      // Prefer viewer URL; raw is available via the header's raw link.
      const finalText = message ? `${message} ${url}` : url;
      oncloseCb?.();
      sendMessage(networkId, target, finalText);
      onsentCb?.();
    } catch (e) {
      error = (e as Error).message || 'Failed to create snippet';
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
      <div class="pastebinHeader">
        <h1 id="pastebinTitle" tabindex="0">Text snippet</h1>
        <span class="pastebinSelect">
          <label for="aceMode">Syntax</label>
          <select id="aceMode" name="aceMode" bind:value={lang} aria-label="Language">
            {#each LANGUAGES as L}
              <option value={L}>{L === 'text' ? 'Plain Text' : L}</option>
            {/each}
          </select>
        </span>
      </div>

      <div class="pastebinWrapper">
        <CodeEditor bind:value={editor} language={lang} />
      </div>

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
        Shortcuts: <strong>Return</strong> to post snippet · <strong>Shift</strong> <strong>Return</strong> for new line · <strong>Ctrl</strong> <strong>Return</strong> to send as messages.
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
    /* Match the userPopup design language */
    background: #131418;
    color: #e6e6e6;
    border: 1px solid #2c2f35;
    border-radius: 10px;
    padding: 0 0 20px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
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
  .pastebinHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 20px 12px;
    background: linear-gradient(135deg, #1a1d25 0%, #131418 100%);
    border-bottom: 1px solid #2c2f35;
    position: relative;
  }
  .pastebinHeader::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, #58a6ff, #8b5cf6);
  }
  .pastebin h1 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    color: #e6edf3;
    outline: none;
    flex: 1 1 auto;
    min-width: 0;
  }
  .pastebinSelect {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }
  .pastebinSelect label {
    color: #8b949e;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pastebinSelect select {
    background: #0d1117;
    color: #e6e6e6;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
    font-family: inherit;
    max-width: 180px;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .pastebinSelect select:focus {
    border-color: #58a6ff;
    box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.15);
    outline: none;
  }
  .pastebinWrapper {
    flex: 1 1 auto;
    min-height: 160px;
    margin: 12px 20px 8px;
    border: 1px solid #2c2f35;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
  }
  .explanation {
    color: #8b949e;
    font-size: 12px;
    margin: 6px 20px;
  }
  .pastebin .form {
    margin: 10px 0;
    padding: 0 20px;
  }
  .pastebin .form label {
    color: #e6edf3;
    font-size: 12px;
    font-weight: 600;
  }
  .pastebin .form .input {
    width: 100%;
    background: #0d1117;
    color: #e6e6e6;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    margin-top: 4px;
    box-sizing: border-box;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .pastebin .form .input:focus {
    border-color: #58a6ff;
    box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.15);
    outline: none;
  }
  .pasteError {
    color: #ff7b72;
    background: rgba(255, 123, 114, 0.1);
    padding: 6px 10px;
    border-radius: 6px;
    margin: 8px 20px;
  }
  .pastebin .buttons {
    display: flex;
    gap: 8px;
    margin: 14px 0 4px;
    padding: 0 20px;
  }
  .pastebin .buttons button {
    background: #1c2128;
    color: #e6e6e6;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 7px 16px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    flex: 0 0 auto;
    transition: background 0.12s, border-color 0.12s, transform 0.1s;
  }
  .pastebin .buttons button:hover:not(:disabled) {
    background: #252a33;
    border-color: #3b4148;
  }
  .pastebin .buttons button:active:not(:disabled) {
    transform: scale(0.97);
  }
  .pastebin .buttons button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .pastebin .buttons button.confirm {
    background: #1f6feb;
    color: #fff;
    border: none;
  }
  .pastebin .buttons button.confirm:hover:not(:disabled) {
    background: #388bfd;
  }
  .pastebin .buttons button.sendAsText {
    background: #1c2128;
    color: #79b8ff;
    border: 1px solid #2a4761;
  }
  .pastebin .buttons button.sendAsText:hover:not(:disabled) {
    background: #1f2a36;
    color: #79b8ff;
    border-color: #388bfd;
  }
  .pasteConfirm__help {
    color: #6e7681;
    font-size: 11px;
    margin: 8px 0 0;
    padding: 0 20px;
  }
</style>
