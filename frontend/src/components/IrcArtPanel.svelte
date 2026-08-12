<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchIrcArtSavesOffset, deleteIrcArtSave, type IrcArtSaveEntry } from '../stores/api';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { ircState, setBufferInputText, getBufferInputText } from '../stores/ircStore.svelte';
  import { sendMessage } from '../stores/wsConnection.svelte';
  import { generateLabel } from '../lib/utils';
  import Img2IrcDialog from './Img2IrcDialog.svelte';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();

  let entries = $state<IrcArtSaveEntry[]>([]);
  let loading = $state(true);
  let error = $state<string|null>(null);
  let total = $state(0);
  let page = $state(1);
  const PAGE_SIZE = 2;
  let totalPages = $derived(Math.max(1, Math.ceil(total / PAGE_SIZE)));
  let copiedId = $state<string|null>(null);
  let expandedId = $state<string|null>(null);
  let editingEntry = $state<IrcArtSaveEntry|null>(null);
  let editingFile = $state<File|null>(null);
  let editingFileName = $state('');

  function getVisiblePages(current: number, total: number): (number | '...')[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages: (number | '...')[] = [];
    if (current <= 4) {
      for (let i = 1; i <= 3; i++) pages.push(i);
      pages.push('...');
      pages.push(total - 2, total - 1, total);
    } else if (current >= total - 3) {
      pages.push(1, 2, 3, '...');
      for (let i = total - 2; i <= total; i++) pages.push(i);
    } else {
      pages.push(1, 2, 3, '...', current - 1, current, current + 1, '...', total - 2, total - 1, total);
    }
    return pages;
  }

  async function loadPage(p: number): Promise<void> {
    loading = true; error = null;
    try {
      const offset = (p - 1) * PAGE_SIZE;
      const result = await fetchIrcArtSavesOffset(offset, PAGE_SIZE);
      entries = result.entries;
      total = result.total;
      page = p;
    } catch {
      error = 'Failed to load IRC Art. Please try again.';
    } finally { loading = false; }
  }
  onMount(() => { loadPage(1); });
  function goToPage(p: number): void { if (p<1||p>totalPages||p===page) return; loadPage(p); }

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'numeric', minute:'numeric', second:'numeric', hour12:true });
  }

  function paramSummary(e: IrcArtSaveEntry): string {
    const p = e.params as any;
    if (!p) return '';
    const parts: string[] = [];
    if (p.width) parts.push(`${p.width} cols`);
    if (p.midgardMode) parts.push(String(p.midgardMode));
    if (p.pixelMode) parts.push(String(p.pixelMode));
    if (p.ditherMode && p.ditherMode!=='none') parts.push(String(p.ditherMode));
    return parts.join(' · ');
  }

  function copyArt(art: string, id: string): void {
    const doCopy=()=>{ copiedId=id; setTimeout(()=>{ if(copiedId===id) copiedId=null; }, 1500); };
    navigator.clipboard.writeText(art).then(doCopy).catch(()=>{
      const ta=document.createElement('textarea'); ta.value=art; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); doCopy();
    });
  }

  function insertArt(art: string): void {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!networkId || !bufferName) { copyArt(art, 'insert'); return; }
    const current = getBufferInputText(networkId, bufferName) || '';
    const newText = current ? `${current}\n${art}` : art;
    setBufferInputText(networkId, bufferName, newText);
    const ta=document.querySelector('#compose-input') as HTMLTextAreaElement|null;
    if (ta) { ta.value=newText; ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus(); }
    onClose();
  }

  async function sendArt(art: string): Promise<void> {
    const nid=ircState.activeBuffer.networkId, target=ircState.activeBuffer.bufferName;
    if (!nid||!target) return;
    const lines=art.split('\n');
    const BURST=5, BD=35, SD=110;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(!line.replace(/[\x03\x04\x0f0-9,a-fA-F ]/g,'').trim() && line.trim()==='') continue;
      sendMessage(nid, target, line, generateLabel());
      if(i<lines.length-1) await new Promise(r=>setTimeout(r, i<BURST?BD:SD));
    }
  }

  async function createDummyPng(): Promise<File> {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
    const bin = atob(b64);
    const arr = Uint8Array.from(bin, c=>c.charCodeAt(0));
    return new File([arr], 'dummy.png', { type: 'image/png' });
  }

  async function handleEdit(entry: IrcArtSaveEntry): Promise<void> {
    if (entry.originalUrl) {
      try {
        const path = (()=>{ 
          try{ 
            const u = new URL(entry.originalUrl); 
            return u.pathname + u.search; 
          } catch{ 
            const m = entry.originalUrl.match(/\/uploads\/.*$/); 
            return m ? m[0] : entry.originalUrl; 
          } 
        })();
        // handle http://:8090/... case (missing host)
        const fetchPath = path.startsWith('http://:') || path.startsWith('https://:') ? path.replace(/^https?:\/:\//, '/') : path;
        const r = await fetch(fetchPath);
        if (r.ok) {
          const blob = await r.blob();
          const isImageBlob = blob.size > 0 && (blob.type.startsWith('image/') || (entry.originalMime && entry.originalMime.startsWith('image/')) || blob.size > 100);
          if (isImageBlob) {
            editingFile = new File([blob], entry.originalFilename || 'image.png', { type: entry.originalMime || blob.type || 'image/png' });
            editingFileName = entry.originalFilename || 'image.png';
          } else {
            editingFile = await createDummyPng();
            editingFileName = entry.originalFilename || 'image.png';
          }
        } else {
          editingFile = await createDummyPng();
          editingFileName = entry.originalFilename || 'image.png';
        }
      } catch {
        editingFile = await createDummyPng();
        editingFileName = entry.originalFilename || 'image.png';
      }
    } else {
      editingFile = await createDummyPng();
      editingFileName = entry.originalFilename || 'image.png';
    }
    editingEntry = entry;
  }

  async function handleDelete(entry: IrcArtSaveEntry): Promise<void> {
    if (!confirm(`Delete "${entry.name}"?`)) return;
    try {
      await deleteIrcArtSave(entry.id);
      entries = entries.filter(e=>e.id!==entry.id);
      total=Math.max(0,total-1);
    } catch(e){ console.error('delete failed', e); }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key==='Escape') {
      if (editingEntry) { editingEntry=null; editingFile=null; }
      else if (expandedId) expandedId=null;
      else onClose();
    }
  }

  function onEditClose(): void {
    editingEntry=null; editingFile=null;
    loadPage(page);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div id="filesContainer">
  <div id="filesOverlayContents">
    <div class="filesHeader">
      <h1 tabindex="0">IRC Art <i class="spin {loading ? 'visible' : ''}"></i></h1>
      <button type="button" class="closeBtn" onclick={onClose}>Close</button>
    </div>

    <p class="loadingProgress userInfo" style="display: {loading && entries.length===0 ? 'block' : 'none'};">Loading…</p>
    {#if error}<p class="loadingError userError">{error}</p>{/if}

    {#if editingEntry && editingFile}
      <Img2IrcDialog
        file={editingFile}
        filename={editingFileName}
        onClose={onEditClose}
        onBack={onEditClose}
        initialParams={editingEntry.params}
        initialName={editingEntry.name}
        editId={editingEntry.id}
        initialArt={editingEntry.art}
        thumbnailUrl={editingEntry.thumbnailUrl}
        onSaved={onEditClose}
      />
    {:else if entries.length>0}
      {@const visiblePages = getVisiblePages(page, totalPages)}
      <ul class="pagination">
        <li><button class="pageBtn" disabled={page===1} onclick={()=>goToPage(page-1)}>‹ Prev</button></li>
        {#each visiblePages as p}
          {#if p==='...'}<li><span class="ellipsis">…</span></li>
          {:else}<li><button class="pageBtn" class:active={p===page} onclick={()=>goToPage(p as number)}>{p}</button></li>{/if}
        {/each}
        <li><button class="pageBtn" disabled={page===totalPages} onclick={()=>goToPage(page+1)}>Next ›</button></li>
      </ul>

      <div id="filesList">
        {#each entries as entry (entry.id)}
          <div class="fileEntry">
            <div class="fileRow">
              {#if entry.thumbnailUrl}
                <img class="thumb" src={(() => { try { return new URL(entry.thumbnailUrl).pathname; } catch { return entry.thumbnailUrl; } })()} alt="" width="96" height="96" loading="lazy" onerror={(e)=>{ (e.target as HTMLImageElement).style.display='none'; }} />
              {:else}
                <div class="thumb placeholder">🖼</div>
              {/if}
              <div class="fileMeta">
                <div class="fileName">{entry.name}</div>
                <div class="fileInfo">{entry.originalFilename || 'no original'} · {formatDate(entry.createdAt)}</div>
                {#if paramSummary(entry)}<div class="paramChips">{paramSummary(entry)}</div>{/if}
                <div class="artPreviewWrap" onclick={()=> expandedId = expandedId===entry.id ? null : entry.id} role="button" tabindex="0" onkeydown={(e)=>{ if(e.key==='Enter') expandedId=expandedId===entry.id?null:entry.id; }}>
                  {#if expandedId===entry.id}
                    <div class="artPreview full">{@html entry.art.split('\n').map(l=>`<div class="ircArtLine">${parseIrcFormatting(l)}</div>`).join('')}</div>
                  {:else}
                    <div class="artPreview">{@html entry.art.split('\n').map(l=>`<div class="ircArtLine">${parseIrcFormatting(l)}</div>`).join('')}</div>
                  {/if}
                </div>
              </div>
            </div>
            <div class="fileActions">
              <button class="actionBtn" onclick={()=>copyArt(entry.art, entry.id)}>{copiedId===entry.id ? 'Copied!' : 'Copy'}</button>
              <button class="actionBtn" onclick={()=>insertArt(entry.art)}>Insert</button>
              <button class="actionBtn primary" onclick={()=>sendArt(entry.art)} disabled={!ircState.activeBuffer.bufferName}>Send</button>
              <button class="actionBtn" onclick={()=>handleEdit(entry)}>Edit</button>
              <button class="actionBtn danger" onclick={()=>handleDelete(entry)}>Delete</button>
            </div>
          </div>
        {/each}
      </div>

      <ul class="pagination bottom">
        <li><button class="pageBtn" disabled={page===1} onclick={()=>goToPage(page-1)}>‹ Prev</button></li>
        {#each visiblePages as p}
          {#if p==='...'}<li><span class="ellipsis">…</span></li>
          {:else}<li><button class="pageBtn" class:active={p===page} onclick={()=>goToPage(p as number)}>{p}</button></li>{/if}
        {/each}
        <li><button class="pageBtn" disabled={page===totalPages} onclick={()=>goToPage(page+1)}>Next ›</button></li>
      </ul>
    {:else if !loading && !error}
      <p class="emptyMsg">No IRC Art yet. Convert an image to save.</p>
    {/if}
  </div>
</div>

<style>
  #filesContainer{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:9000;padding:16px;backdrop-filter:blur(2px)}
  #filesOverlayContents{background:#0f1115;border:1px solid #1f242d;border-radius:12px;width:min(900px,98vw);max-height:92vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.7);padding:0}
  .filesHeader{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #1e232b;position:sticky;top:0;background:#0f1115;z-index:2}
  .filesHeader h1{margin:0;font-size:14px;font-weight:700;color:#e6edf3}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid #232a36;border-top-color:#58a6ff;border-radius:50%;animation:spin .6s linear infinite;opacity:0}
  .spin.visible{opacity:1}
  @keyframes spin{to{transform:rotate(360deg)}}
  .closeBtn{background:#1a1f29;color:#c9d1d9;border:1px solid #232a36;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer}
  .loadingProgress{padding:12px 16px;color:#7d8590;font-size:12px}
  .loadingError{padding:10px 16px;color:#f85149;font-size:12px}
  .emptyMsg{padding:32px 16px;text-align:center;color:#7d8590;font-size:13px}
  .pagination{display:flex;gap:4px;list-style:none;padding:10px 16px;margin:0;flex-wrap:wrap;align-items:center}
  .pagination.bottom{border-top:1px solid #1e232b}
  .pageBtn{background:#1a1f29;color:#c9d1d9;border:1px solid #232a36;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
  .pageBtn:disabled{opacity:.4;cursor:default}
  .pageBtn.active{background:#58a6ff;color:#fff;border-color:#58a6ff}
  .ellipsis{color:#4d555f;padding:0 4px}
  #filesList{padding:8px 16px;display:flex;flex-direction:column;gap:10px}
  .fileEntry{background:#0d0f13;border:1px solid #1e232b;border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
  .fileRow{display:flex;gap:12px;align-items:flex-start}
  .thumb{width:96px;height:96px;object-fit:cover;border-radius:6px;border:1px solid #1e232b;background:#010409;flex-shrink:0}
  .thumb.placeholder{display:flex;align-items:center;justify-content:center;font-size:20px;color:#4d555f}
  .fileMeta{flex:1;min-width:0}
  .fileName{font-size:13px;font-weight:600;color:#e6edf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .fileInfo{font-size:11px;color:#7d8590;margin-top:2px}
  .paramChips{font-size:10px;color:#8b949e;background:#1a1f29;border:1px solid #232a36;border-radius:999px;display:inline-block;padding:2px 8px;margin-top:6px}
  .artPreviewWrap{margin-top:8px;cursor:pointer}
  .artPreview{background:#000;border:1px solid #1e232b;border-radius:6px;padding:10px 12px;overflow:auto;font:13px/1.25 "Hack",monospace;max-height:340px}
  .artPreview.full{max-height:none}
  .more{font-size:10px;color:#58a6ff;margin-top:4px}
  .fileActions{display:flex;gap:6px;flex-wrap:wrap}
  .actionBtn{background:#1a1f29;color:#c9d1d9;border:1px solid #232a36;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer}
  .actionBtn:hover{background:#232a36}
  .actionBtn.primary{background:#238636;color:#fff;border-color:#2ea043}
  .actionBtn.danger{color:#f85149}
  .actionBtn.danger:hover{background:#3d1214}
  :global(.ircArtLine){white-space:pre;min-height:1em}
</style>
