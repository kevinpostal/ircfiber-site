<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchPastebinById, deletePastebin, updatePastebin, pastebinRawUrl, type PasteEntry, fetchMe } from '../stores/api';
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
  let meId: string | null = $state(null);

  let lineCount = $derived(entry ? (entry.lines ?? entry.body.split('\n').length) : 0);
  let syntaxLabel = $derived(entry?.syntax ?? 'text');
  let dateStr = $derived(entry ? new Date(entry.createdAt).toLocaleString() : '');
  let dateIso = $derived(entry ? new Date(entry.createdAt).toISOString() : '');
  let isOwner = $derived(entry ? meId !== null && entry.userId === meId : false);

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

  onMount(async () => {
    try { const me = await fetchMe(); meId = me.id; } catch {}
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
    if (!isOwner) return;
    if (!entry) return;
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
    if (!isOwner) return;
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
    if (!isOwner) return;
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

<div id="pasteViewerPage" class="mainContainer mainContainerPaste mainContainerFull" onclick={(e)=>{ if(e.target===e.currentTarget) handleClose(); }} role="presentation">
  <div class="mainContent mainContentPaste">
    <div class="pasteContainer">
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
            {#if !editing && isOwner}
              <span class="actions"><button class="link editButton" onclick={startEdit}>edit</button> <span style="color:#3a3d44;">•</span> <button class="link deleteButton" onclick={()=>confirmDelete=true}>delete</button></span>
            {/if}
          </h1>
          {#if editing && isOwner}
            <form class="editForm" onsubmit={saveEdit}>
              <input class="input nameInput" bind:value={editFilename} placeholder="e.g. index.html" />
              <select bind:value={editLang} aria-label="Language">
                {#each LANGUAGES as L}<option value={L}>{L === 'text' ? 'Plain Text' : L}</option>{/each}
              </select>
              <button type="submit" class="action" disabled={saving}>{saving?'Saving…':'Save'}</button>
              <button type="button" class="cancel" onclick={cancelEdit}>Cancel</button>
            </form>
          {/if}
          {#if isOwner && confirmDelete}
            <div class="confirmBar">Are you sure? <button class="link deleteConfirm" onclick={doDelete}>Yup, trash it</button> <span style="color:#3a3d44;">/</span> <button class="link" onclick={()=>confirmDelete=false}>Cancel</button></div>
          {/if}
          {#if editError}<p class="userError editError">{editError}</p>{/if}
          <div class="editor ace_editor ace-twilight ace_dark" style="height: {Math.max(lineCount,1)*16}px">
            {#if editing && isOwner}
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
  #pasteViewerPage { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; background: #141414; overflow: hidden; width: 100vw; height: 100vh; }
  .mainContainerPaste { display: block; background: #141414; width: 100%; height: 100%; max-width: none; margin: 0; padding: 0; overflow: auto; }
  .mainContentPaste { padding: 0; min-width: 0; background: #141414; }
  .pasteContainer { background: #141414; border: none; border-radius: 0; width: 100%; max-width: none; padding: 0; box-shadow: none; display: block; min-height: 100%; }
  .paste { display: block; background: #141414; min-height: 100%; padding: 0; }
  .branding { display: flex; align-items: baseline; gap: 6px; font-size: 12px; color: #8b949e; padding: 10px 16px; background: #0f1115; border-bottom: 1px solid #2a2d33; flex: 0 0 auto; }
  .branding .brand { font-weight: 700; color: #58a6ff; text-decoration: none; font-size: 13px; }
  .branding .brand:hover { text-decoration: underline; }
  .branding .tag { color: #6e7681; }
  .branding .brandHome { margin-left: auto; color: #8b949e; text-decoration: none; border: 1px solid #2a2d33; border-radius: 4px; padding: 2px 6px; background: #161a22; }
  .branding .brandHome:hover { color: #c9d1d9; border-color: #3a3d44; }


  .loadingProgress { color: #8b949e; padding: 12px; }
  .filesHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; padding: 12px 16px; }
  .filesHeader h1 { font-size: 18px; font-weight: 600; color: #c9d1d9; }
  .closeBtn { padding: 6px 12px; border: 1px solid #2a2d33; border-radius: 4px; background: #161a22; color: #c9d1d9; cursor: pointer; }
  .userError { color: #f85149; font-size: 13px; margin-top: 10px; padding: 0 16px; }
  .paste .header { display: block; background: #1e1e1e; border: 1px solid #2a2d33; border-bottom: none; padding: 5px 4px 3px; margin: 0; font-size: 13px; }
  .paste .header .actions { display: inline; margin-left: 12px; font-size: 12px; }
  .header .actions .link { color: #8b949e; padding: 2px 6px; border-radius: 3px; }
  .header .actions .link:hover { color: #c9d1d9; background: #1a1d23; text-decoration: none; }
  .header .actions .editButton { color: #58a6ff; }
  .header .actions .deleteButton { color: #f85149; }
  .confirmBar { background: #1a1d23; border: 1px solid #2a2d33; border-radius: 6px; padding: 8px 12px; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; font-size: 12px; color: #f85149; }
  .editForm { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px; background: #0f1115; border: 1px solid #2a2d33; border-radius: 6px; margin: 0 0 12px; }
  .paste .details { display: inline; font-size: 13px; }
  .paste .details .name { margin-right: 6px; }
  .paste .details .info { margin-right: 6px; }
  .paste .details .date { margin-right: 6px; }
  .paste .header .actions { display: inline; margin-left: 12px; font-size: 12px; }
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
  .editForm .input { padding: 6px 8px; background: #0d1117; border: 1px solid #2a2d33; border-radius: 4px; color: #c9d1d9; font-size: 13px; }
  .editForm select { padding: 6px 8px; background: #0d1117; border: 1px solid #2a2d33; border-radius: 4px; color: #c9d1d9; font-size: 13px; max-width: 160px; }
  .editForm button.action { padding: 6px 12px; border-radius: 4px; border: 1px solid #1f6feb; background: #1f6feb; color: white; cursor: pointer; }
  .editForm button.cancel { padding: 6px 12px; border-radius: 4px; border: 1px solid #2a2d33; background: #161a22; color: #c9d1d9; cursor: pointer; }
  .confirm { font-size: 12px; color: #f85149; margin-left: 8px; }
  .editor { border: 1px solid #2a2d33; border-top: none; overflow: hidden; display: block; background: #141414; }
  .editor :global(.codeEditor) { flex: 1; min-height: 0; }
</style>
