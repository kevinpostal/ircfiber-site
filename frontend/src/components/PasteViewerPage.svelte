<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchPastebinById, deletePastebin, updatePastebin, pastebinRawUrl, type PasteEntry } from '../stores/api';
  import CodeEditor from './CodeEditor.svelte';
  import { getPastebinIdFromUrl, navigateBackFromPastebin } from '../lib/routing';

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

  interface Props {
    id?: string;
    onClose?: () => void;
  }
  let { id: propId, onClose }: Props = $props();

  let id = $derived(propId ?? getPastebinIdFromUrl() ?? '');
  let entry = $state<PasteEntry | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let editing = $state(false);
  let editContent = $state('');
  let editFilename = $state('');
  let editLang = $state('text');
  let saving = $state(false);
  let editError = $state<string | null>(null);
  let gutterHidden = $state(false);
  let confirmDelete = $state(false);

  let lineCount = $derived(entry ? (entry.lines ?? entry.body.split('\n').length) : 0);
  let syntaxLabel = $derived(entry?.syntax ?? 'text');
  let dateStr = $derived(entry ? new Date(entry.createdAt).toLocaleString() : '');
  let dateIso = $derived(entry ? new Date(entry.createdAt).toISOString() : '');

  async function load() {
    if (!id) { loading = false; error = 'Missing id'; return; }
    loading = true;
    error = null;
    try {
      const rec = await fetchPastebinById(id);
      entry = rec;
      editFilename = rec.name;
      editLang = rec.syntax;
      editContent = rec.body;
    } catch (e: any) {
      error = e?.message ?? 'Failed to load';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  $effect(() => {
    void id;
    void load();
  });

  function handleClose() {
    if (onClose) onClose();
    else navigateBackFromPastebin();
  }

  function startEdit() {
    if (!entry) return;
    editFilename = entry.name;
    editLang = entry.syntax;
    editContent = entry.body;
    editError = null;
    editing = true;
    confirmDelete = false;
  }
  function cancelEdit() {
    editing = false;
    editError = null;
  }

  async function saveEdit(e: SubmitEvent) {
    e.preventDefault();
    if (!entry) return;
    saving = true;
    editError = null;
    try {
      const updated = await updatePastebin(entry.id, { name: editFilename.trim(), syntax: editLang, body: editContent });
      entry = updated;
      editing = false;
    } catch (err: any) {
      editError = err?.message ?? 'Save failed';
    } finally {
      saving = false;
    }
  }

  async function doDelete() {
    if (!entry) return;
    try {
      await deletePastebin(entry.id);
      handleClose();
    } catch (err: any) {
      editError = err?.message ?? 'Delete failed';
    }
  }
</script>

<svelte:window onkeydown={(e)=>{ if(e.key==='Escape') { if(editing) cancelEdit(); else handleClose(); } }} />

<div id="pasteViewerPage" class="mainContainerPaste" onclick={(e)=>{ if(e.target===e.currentTarget) handleClose(); }} role="presentation">
  <div class="mainContentPaste">
    <div class="pasteContainer">
      <!-- tiny branding for public view -->
      <div class="branding"><a href="/" class="brand">IRC Fiber</a><span class="tag"> — snippet</span><a href="/" class="brandHome">home</a></div>
      {#if loading}
        <p class="loadingProgress">Loading…</p>
      {:else if error || !entry}
        <div class="filesHeader"><h1>Not found</h1><button class="closeBtn" onclick={handleClose}>Back</button></div>
        <p class="userError">{error ?? 'Not found.'} <button onclick={handleClose}>Back</button></p>
      {:else}
        <div class="paste">
          <h1 class="header">
            <span class="details">
              <span class="name">{entry.name || 'Untitled'}</span>
              <span class="info"><span class="syntax">{syntaxLabel}</span> • <span class="lines">{lineCount} lines</span></span>
              <a href={pastebinRawUrl(entry.id)} target="_blank" rel="noreferrer" class="date" title={dateIso}>{dateStr}</a>
              <span class="modes"><a href={pastebinRawUrl(entry.id)} target="_blank" rel="noreferrer">raw</a> | <button class="link linesButton" onclick={()=>gutterHidden=!gutterHidden}>line numbers</button></span>
            </span>
            {#if editing}
              <form class="editForm" onsubmit={saveEdit}>
                <input class="input nameInput" bind:value={editFilename} placeholder="e.g. index.html" />
                <select bind:value={editLang} aria-label="Language">
                  {#each LANGUAGES as L}<option value={L}>{L === 'text' ? 'Plain Text' : L}</option>{/each}
                </select>
                <button type="submit" class="action" disabled={saving}>{saving?'Saving…':'Save'}</button>
                <button type="button" class="cancel" onclick={cancelEdit}>Cancel</button>
              </form>
              {#if editError}<p class="userError editError">{editError}</p>{/if}
              {#if confirmDelete}
                <span class="confirm">Are you sure? <button class="link deleteConfirm" onclick={doDelete}>Yup, trash it</button> / <button class="link" onclick={()=>confirmDelete=false}>Cancel</button></span>
              {/if}
            {:else}
              <span class="actions"><button class="link editButton" onclick={startEdit}>edit</button> • <button class="link deleteButton" onclick={()=>confirmDelete=true}>delete</button></span>
              {#if confirmDelete}
                <span class="confirm">Are you sure? <button class="link deleteConfirm" onclick={doDelete}>Yup, trash it</button> / <button class="link" onclick={()=>confirmDelete=false}>Cancel</button></span>
              {/if}
              {#if editError}<p class="userError editError">{editError}</p>{/if}
            {/if}
          </h1>
          <div class="editor ace_editor ace-twilight ace_dark">
            {#if editing}
              <CodeEditor bind:value={editContent} language={editLang} showGutter={!gutterHidden} twilight />
            {:else}
              <CodeEditor value={entry.body} language={entry.syntax} readonly showGutter={!gutterHidden} twilight />
            {/if}
          </div>
          {#if editError && !editing}<p class="userError editError">{editError}</p>{/if}
        </div>
      {/if}
    </div>
  </div>
</div>
<style>
  #pasteViewerPage { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; background: #141414; }
  #pasteViewerPage .mainContentPaste { flex: 1; overflow: hidden; display: flex; flex-direction: column; padding: 0; min-height: 0; }
  .pasteContainer { background: #141414; border: none; border-radius: 0; width: 100%; max-width: none; height: 100%; padding: 0; box-shadow: none; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
  .branding { display: flex; align-items: baseline; gap: 6px; font-size: 12px; color: #8b949e; padding: 10px 16px; background: #0f1115; border-bottom: 1px solid #2a2d33; flex: 0 0 auto; }
  .branding .brand { font-weight: 700; color: #58a6ff; text-decoration: none; font-size: 13px; }
  .branding .brand:hover { text-decoration: underline; }
  .branding .tag { color: #6e7681; }
  .branding .brandHome { margin-left: auto; color: #8b949e; text-decoration: none; border: 1px solid #2a2d33; border-radius: 4px; padding: 2px 6px; background: #161a22; }
  .branding .brandHome:hover { color: #c9d1d9; border-color: #3a3d44; }
  .paste { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; padding: 0 16px 16px; }
  .loadingProgress { color: #8b949e; padding: 12px; }
  .filesHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; padding: 12px 16px; }
  .filesHeader h1 { font-size: 18px; font-weight: 600; color: #c9d1d9; }
  .closeBtn { padding: 6px 12px; border: 1px solid #2a2d33; border-radius: 4px; background: #161a22; color: #c9d1d9; cursor: pointer; }
  .userError { color: #f85149; font-size: 13px; margin-top: 10px; padding: 0 16px; }
  .paste .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid #2a2d33; padding: 10px 0; margin-bottom: 12px; font-size: 14px; flex: 0 0 auto; }
  .paste .details { display: flex; flex-direction: column; gap: 4px; }
  .paste .name { font-weight: 700; font-size: 16px; color: #c9d1d9; }
  .paste .info { font-size: 12px; color: #8b949e; }
  .paste .date { font-size: 12px; color: #58a6ff; text-decoration: none; }
  .paste .date:hover { text-decoration: underline; }
  .paste .modes { font-size: 12px; color: #8b949e; }
  .paste .modes a { color: #58a6ff; text-decoration: none; }
  .paste .modes a:hover { text-decoration: underline; }
  .paste .actions { font-size: 12px; color: #8b949e; }
  .link { background: none; border: none; color: #58a6ff; cursor: pointer; padding: 0; font-size: inherit; }
  .link:hover { text-decoration: underline; }
  .editForm { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-left: auto; }
  .editForm .input { padding: 6px 8px; background: #0d1117; border: 1px solid #2a2d33; border-radius: 4px; color: #c9d1d9; font-size: 13px; }
  .editForm select { padding: 6px 8px; background: #0d1117; border: 1px solid #2a2d33; border-radius: 4px; color: #c9d1d9; font-size: 13px; max-width: 160px; }
  .editForm button.action { padding: 6px 12px; border-radius: 4px; border: 1px solid #1f6feb; background: #1f6feb; color: white; cursor: pointer; }
  .editForm button.cancel { padding: 6px 12px; border-radius: 4px; border: 1px solid #2a2d33; background: #161a22; color: #c9d1d9; cursor: pointer; }
  .confirm { font-size: 12px; color: #f85149; margin-left: 8px; }
  .editor { border: 1px solid #2a2d33; border-radius: 4px; overflow: hidden; display: flex; flex: 1 1 auto; min-height: 0; }
  .editor :global(.codeEditor) { flex: 1; min-height: 0; }
</style>
