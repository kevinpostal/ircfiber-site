<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchPastebinById, deletePastebin, updatePastebin, pastebinRawUrl, type PasteEntry, fetchMe } from '../stores/api';
  import CodeEditor from './CodeEditor.svelte';
  import { getPastebinIdFromUrl, navigateBackFromPastebin } from '../lib/routing';

  function relTime(iso: string): string {
    const d = new Date(iso).getTime();
    const now = Date.now();
    const s = Math.floor((now - d)/1000);
    if (s < 60) return 'less than a minute ago';
    if (s < 3600) return Math.floor(s/60) + ' minutes ago';
    if (s < 86400) return Math.floor(s/3600) + ' hours ago';
    const days = Math.floor(s/86400);
    if (days === 1) return 'a day ago';
    if (days < 7) return days + ' days ago';
    if (days < 30) return Math.floor(days/7) + ' weeks ago';
    return new Date(iso).toLocaleDateString();
  }
  const SYNTAX_LABEL: Record<string,string> = { text:'Plain Text', html:'HTML', javascript:'JavaScript', typescript:'Typescript', c_cpp:'C and C++', csharp:'C#', golang:'Go', python:'Python', ruby:'Ruby', rust:'Rust', java:'Java', json:'JSON', css:'CSS', xml:'XML', yaml:'YAML', sh:'SH', sql:'SQL' };
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
  let copied = $state(false);
  let lineCount = $derived(entry ? (entry.lines ?? entry.body.split('\n').length) : 0);
  let syntaxLabel = $derived(entry ? (SYNTAX_LABEL[entry.syntax] ?? entry.syntax) : 'text');
  let dateIso = $derived(entry ? new Date(entry.createdAt).toISOString() : '');
  let dateRel  = $derived(entry ? relTime(typeof entry.createdAt === 'string' ? entry.createdAt : new Date(entry.createdAt as any).toISOString()) : '');
  let dateTitle = $derived(entry ? new Date(entry.createdAt as any).toLocaleString() : '');
  let isOwner = $derived(entry ? meId !== null && (entry as any).userId === meId : false);
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

  async function copyCode() {
    const text = editing ? editContent : entry?.body ?? '';
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(()=> copied = false, 1500);
    } catch {}
  }
</script>

<svelte:window onkeydown={(e)=>{ if(e.key==='Escape') { if(editing) cancelEdit(); else handleClose(); } }} />

<div id="pasteViewerPage" class="mainContainer mainContainerPaste mainContainerFull irccloud pastebin theme-midnight" onclick={(e)=>{ if(e.target===e.currentTarget) handleClose(); }} role="presentation">
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
              {#if !editing}<span class="name">{entry.name || 'Untitled'}</span>{/if}
              <span class="info"><span class="syntax">{syntaxLabel}</span> • <span class="lines">{lineCount} lines</span></span>
              <span class="date" title={dateTitle}>{dateRel}</span>
              <span class="modes"><a href={pastebinRawUrl(entry.id)} target="_blank" rel="noreferrer">raw</a> | <button class="link linesButton" onclick={()=>gutterHidden=!gutterHidden}>line numbers</button></span>
            </span>
            {#if editing && isOwner}
              <form class="editForm" onsubmit={saveEdit}>
                <label class="fieldLabel" for="pasteFilename">Filename</label>
                <input id="pasteFilename" class="input nameInput" bind:value={editFilename} placeholder="e.g. index.html" name="name" />
                <select bind:value={editLang} aria-label="Language" name="aceMode">
                  {#each LANGUAGES as L}<option value={L}>{SYNTAX_LABEL[L] ?? L}</option>{/each}
                </select>
                <button type="submit" class="action" disabled={saving}>{saving?'Saving…':'Save'}</button>
                <button type="button" class="cancel" onclick={cancelEdit}>Cancel</button>
              </form>
            {/if}
            {#if isOwner && confirmDelete && !editing}
              <span class="confirm"><span class="explanation">Are you sure?</span><button type="button" class="delete" onclick={doDelete}><span>Yup, trash it</span></button><button type="button" class="cancel" onclick={()=>confirmDelete=false}><span>Cancel</span></button></span>
            {/if}
            {#if !editing && isOwner}
              <span class="actions"><button class="link editButton" onclick={startEdit}>edit</button> • <button class="link deleteButton" onclick={()=>confirmDelete=true}>delete</button></span>
            {/if}
            {#if editError}<p class="userError editError" style="display:block;">{editError}</p>{/if}
          </h1>
          <div class="editor ace_editor ace_hidpi ace-twilight ace_dark" style="position: relative; height: {Math.max(lineCount,1)*16 + 28}px; --line-number-color: rgba(255, 255, 255, 0.3); --border-color: rgba(255, 255, 255, 0.1); --padding-left: 2em; --padding-right: 1em; --copy-background: rgba(255, 255, 255, 0.1); --copy-color: #fff; --copy-border-radius: 8px; --copy-size: 2.5em;">
            <div class="editorToolbar">
              <button class="copyButton" onclick={copyCode} aria-label="Copy code" title={copied ? 'Copied!' : 'Copy'}>
                {#if copied}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
                {:else}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"/></svg>
                {/if}
              </button>
            </div>
            <span class="langtag">{syntaxLabel}</span>
            {#if editing && isOwner}
              <CodeEditor bind:value={editContent} language={editLang} showGutter={!gutterHidden} twilight />
            {:else}
              <CodeEditor value={entry.body + '\n '} language={entry.syntax} readonly showGutter={!gutterHidden} twilight />
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
<style>
  #pasteViewerPage { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; background: #141414; overflow: auto; width: 100vw; height: 100vh; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
  .mainContainerPaste { display: block; background: #141414; width: 100%; min-height: 100%; max-width: none; margin: 0; padding: .7em; overflow: visible; box-sizing: border-box; }
  .mainContentPaste { padding: 0; min-width: 0; background: #141414; border: 1px solid #2a2d33; border-radius: 4px; }
  .filesHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; padding: 12px 16px; }
  .filesHeader h1 { font-size: 18px; font-weight: 600; color: #c9d1d9; }
  .closeBtn { padding: 6px 12px; border: 1px solid #2a2d33; border-radius: 4px; background: #161a22; color: #c9d1d9; cursor: pointer; }
  .userError { color: #f85149; font-size: 13px; margin-top: 10px; padding: 0 16px; }
  /* header: details left, edit/delete right */
  .paste .header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; background: #2a2a2a; border-bottom: 1px solid #333; padding: 4px 8px; margin: 0; font-size: 12px; color: #999; line-height: 18px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
  .paste .header .details { display: inline; font-size: 12px; flex: 1 1 auto; min-width: 0; }
  .paste .header .details .name { color: #e6e6e6; font-weight: 700; margin-right: 8px; font-size: 12px; }
  .paste .header .details .date { color: #f2f2f2; text-decoration: none; margin-right: 8px; font-size: 11px; }
  .paste .header .details .modes { color: #666; font-size: 11px; }
  .paste .header .details .modes a { color: #58a6ff; text-decoration: none; }
  .paste .header .details .modes a:hover { color: #58a6ff; text-decoration: underline; }
  .paste .header .details .modes button.link { color: #999; text-decoration: none; font-size: 11px; background: none; border: none; padding: 0; margin: 0; cursor: pointer; font: inherit; line-height: inherit; appearance: none; -webkit-appearance: none; }
  .paste .header .details .modes button.linesButton { color: #f2f2f2; }
  .paste .header .details .modes button.linesButton:hover { color: #fff; text-decoration: underline; }
  .paste .header .actions { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; flex: 0 0 auto; font-size: 11px; color: #999; }
  .paste .header .actions .link { color: #999; background: none; border: none; cursor: pointer; padding: 0; font-size: 11px; }
  .paste .header .actions .link:hover { color: #F8F8F8; text-decoration: underline; }
  .paste .header .actions .deleteButton { color: #CF6A4C; }
  .paste .header .confirm { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 11px; color: #CF6A4C; }
  .paste .header .confirm .explanation { margin-right: 6px; }
  .paste .header .confirm button.delete { color: #CF6A4C; background: none; border: none; cursor: pointer; text-decoration: underline; }
  .paste .header .confirm button.cancel { color: #999; background: none; border: none; cursor: pointer; margin-left: 6px; }
  .paste .header .editForm { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 0; margin: 0 0 0 8px; flex: 0 1 auto; }
  .paste .header .editForm .fieldLabel { font-size: 11px; color: #999; white-space: nowrap; margin-right: -2px; }
  .paste .header .editForm .input { padding: 2px 6px; background: #1a1a1a; border: 1px solid #333; border-radius: 3px; color: #F8F8F8; font-size: 12px; min-width: 100px; max-width: 160px; flex: 1 1 120px; }
  .paste .header .editForm select { padding: 4px 6px; background: #0d1117; border: 1px solid #2a2d33; border-radius: 3px; color: #c9d1d9; font-size: 12px; max-width: 160px; }
  .paste .header .editForm button.action { padding: 4px 10px; border-radius: 3px; border: 1px solid #1f6feb; background: #1f6feb; color: white; cursor: pointer; font-size: 12px; }
  .paste .header .editForm button.cancel { padding: 4px 10px; border-radius: 3px; border: 1px solid #2a2d33; background: #161a22; color: #c9d1d9; cursor: pointer; font-size: 12px; }
  .paste .header .userError { color: #f85149; font-size: 12px; margin: 4px 0 0; padding: 0; }
  .editor { position: relative; border: none; overflow: visible; display: block; background: #141414; margin-top: 1px; }
  .editor :global(.codeEditor) { display: flex; height: auto; min-height: 0; }
  .editorToolbar { position: absolute; top: 8px; right: 8px; z-index: 5; display: flex; align-items: center; }
  .copyButton { width: var(--copy-size, 2.5em); height: var(--copy-size, 2.5em); display: inline-flex; align-items: center; justify-content: center; padding: 0; font-size: 12px; line-height: 1; color: var(--copy-color, #fff); background: var(--copy-background, rgba(255,255,255,0.1)); border: 1px solid transparent; border-radius: var(--copy-border-radius, 8px); cursor: pointer; }
  .copyButton:hover { background: rgba(255,255,255,0.16); }
  .copyButton:active { transform: scale(0.96); }
  .copyButton svg { width: 14px; height: 14px; }
  .langtag { position: absolute; bottom: 8px; right: 8px; z-index: 5; padding: 0 2px; font-size: 11px; line-height: 1; font-family: inherit; color: rgba(255,255,255,0.35); background: transparent; border: none; text-transform: lowercase; pointer-events: none; letter-spacing: 0.02em; }
</style>
