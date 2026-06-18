<script lang="ts">
  import { tick } from 'svelte';
  import { sendMessage } from '../stores/wsConnection.svelte';
  import { splitIntoMessages } from '../lib/messageSplitter';
  import { getPastebinDisablePrompt, setPastebinDisablePrompt } from '../stores/preferences.svelte';

  interface Props {
    open?: boolean;
    text?: string;
    networkId?: string;
    target?: string;
    onclose?: () => void;
    onsent?: () => void;
  }
  let { open = false, text = '', networkId = '', target = '', onclose: oncloseCb, onsent: onsentCb }: Props = $props();

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
  let askChecked = $state(!getPastebinDisablePrompt());
  let posting = $state(false);
  let error = $state<string | null>(null);

  // Reset state every time the dialog opens with new text
  $effect(() => {
    if (open) {
      editor = text;
      lang = 'text';
      name = '';
      message = '';
      askChecked = !getPastebinDisablePrompt();
      error = null;
      posting = false;
      tick().then(() => editorEl?.focus());
    }
  });

  // svelte-ignore non_reactive_update — bind:this target, not user state
  let editorEl: HTMLTextAreaElement | undefined;

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

  // "Post snippet" — upload to a pastebin service, send the URL.
  // Uses ix.io (no auth, no rate limits for moderate use).  Falls back to
  // showing an error if the upload fails.
  async function postSnippet(e: Event) {
    e.preventDefault();
    if (posting) return;
    posting = true;
    error = null;
    try {
      const fd = new FormData();
      // ix.io simple API: text=<snippet>. Default is permanent storage.
      fd.append('text', editor);
      const resp = await fetch('https://ix.io', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const url = (await resp.text()).trim();
      const finalText = message ? `${message} ${url}` : url;
      oncloseCb?.();
      sendMessage(networkId, target, finalText);
      onsentCb?.();
    } catch (e) {
      error = (e as Error).message || 'Failed to post snippet';
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
        <div class="paste">
          <div
            class="editor ace_editor ace_hidpi ace_tm"
            class:ace_dark={lang !== 'text'}
            style="height: 192px;"
          >
            <textarea
              bind:this={editorEl}
              bind:value={editor}
              class="ace_text-input"
              wrap="off"
              autocorrect="off"
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
    /* IRCCloud uses display: block; flexbox would steal viewport space */
    position: fixed;
    top: 12%;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, 92vw);
    max-height: 80vh;
    overflow: auto;
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
    margin: 8px 0 4px;
    border: 1px solid #1e1e1e;
    border-radius: 3px;
    overflow: hidden;
  }
  .paste .editor {
    background: #141414;
    color: #f8f8f8;
  }
  .paste .editor.ace_tm {
    background: #1e1e1e;
    color: #e6e6e6;
  }
  .paste textarea.ace_text-input {
    display: block;
    width: 100%;
    height: 192px;
    box-sizing: border-box;
    background: transparent;
    color: inherit;
    border: 0;
    outline: 0;
    padding: 8px 10px;
    margin: 0;
    font-family: 'Hack', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 13px;
    line-height: 16px;
    resize: vertical;
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
