<script lang="ts">
  import { onMount } from 'svelte';
  import { ircState } from '../stores/ircStore.svelte';
  import { navigateBackFromFeedback, navigateShortcuts } from '../lib/routing';
  import { isFiberServer } from '../lib/fiberServer';
  import { uploadFile } from '../lib/upload';
  import {
    joinChannel, submitSupportIssue, fetchMySupportIssues, addSupportIssueComment,
    type SupportIssueEntry, type SupportIssueKind, type SupportIssueStatus,
  } from '../stores/api';
  import SettingsSection from './SettingsSection.svelte';

  const KIND_LABELS: Record<SupportIssueKind, string> = {
    bug: 'Bug', feature: 'Feature request', question: 'Question', other: 'Other',
  };
  const STATUS_LABELS: Record<SupportIssueStatus, string> = {
    open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed',
  };
  const MAX_FILES = 3;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const SUPPORT_CHANNEL = '#support';

  // ── report form ──
  let kind = $state<SupportIssueKind>('bug');
  let title = $state('');
  let body = $state('');
  let files = $state<File[]>([]);
  let includeDiagnostics = $state(true);
  let busy = $state(false);
  let error = $state('');
  let success = $state('');

  // ── my reports ──
  let myIssues = $state<SupportIssueEntry[]>([]);
  let issuesLoaded = $state(false);
  let issuesError = $state('');
  let expandedId = $state<string | null>(null);
  let replyText = $state<Record<string, string>>({});
  let replyBusyId = $state<string | null>(null);
  let replyError = $state('');

  const fiberNet = $derived(ircState.networks.find(n => isFiberServer(n)) ?? null);

  function close(): void {
    ircState.showFeedback = false;
    navigateBackFromFeedback();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  async function joinSupport(): Promise<void> {
    if (!fiberNet) return;
    try {
      await joinChannel(fiberNet.networkId, SUPPORT_CHANNEL);
      close();
    } catch (e: unknown) {
      error = (e as Error).message || 'Failed to join #support';
    }
  }

  function openShortcuts(): void {
    ircState.showFeedback = false;
    ircState.showShortcuts = true;
    navigateShortcuts();
  }

  function pickFiles(e: Event): void {
    const input = e.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    input.value = '';
    const next = [...files, ...picked];
    if (next.length > MAX_FILES || next.some(f => f.size > MAX_FILE_BYTES)) {
      error = 'Up to 3 images, 10 MB each';
      return;
    }
    files = next;
    error = '';
  }

  function removeFile(index: number): void {
    files = files.filter((_, i) => i !== index);
  }

  /** Same limits and wording as the server so the message never changes after a round trip. */
  function validate(): string {
    const t = title.trim();
    if (t.length < 3 || t.length > 120) return 'title must be 3–120 characters';
    const b = body.trim();
    if (b.length < 10 || b.length > 5000) return 'description must be 10–5000 characters';
    return '';
  }

  async function submit(): Promise<void> {
    error = '';
    success = '';
    const problem = validate();
    if (problem) {
      error = problem;
      return;
    }
    busy = true;
    try {
      const attachments: string[] = [];
      for (const f of files) {
        const res = await uploadFile(f, {
          filename: f.name, networkId: fiberNet?.networkId ?? '', buffer: 'support',
        }).promise;
        attachments.push(res.url);
      }
      const appVersion = includeDiagnostics
        ? await fetch('/api/version', { credentials: 'include' })
            .then((r) => (r.ok ? r.json() : null))
            .then((v) => (v?.describe as string | undefined) ?? 'unknown')
            .catch(() => 'unknown')
        : '';
      const context = includeDiagnostics ? {
        appVersion,
        userAgent: navigator.userAgent,
        url: location.href,
        networkId: ircState.activeBuffer.networkId ?? '',
        bufferName: ircState.activeBuffer.bufferName ?? '',
        viewport: `${innerWidth}x${innerHeight}`,
      } : undefined;
      const entry = await submitSupportIssue({ kind, title: title.trim(), body: body.trim(), attachments, context });
      success = `Thanks — report #${entry.number} submitted. Replies show up below and in ${SUPPORT_CHANNEL}.`;
      title = '';
      body = '';
      files = [];
      myIssues = [entry, ...myIssues];
      expandedId = entry.id;
    } catch (e: unknown) {
      error = (e as Error).message || 'Failed to submit report';
    } finally {
      busy = false;
    }
  }

  async function loadIssues(): Promise<void> {
    try {
      const r = await fetchMySupportIssues(0, 20);
      myIssues = r.issues;
    } catch (e: unknown) {
      issuesError = (e as Error).message || 'Failed to load your reports';
    } finally {
      issuesLoaded = true;
    }
  }
  onMount(loadIssues);

  function toggleIssue(id: string): void {
    expandedId = expandedId === id ? null : id;
    replyError = '';
  }

  async function reply(issue: SupportIssueEntry): Promise<void> {
    const text = (replyText[issue.id] ?? '').trim();
    if (!text) return;
    replyBusyId = issue.id;
    replyError = '';
    try {
      const updated = await addSupportIssueComment(issue.id, text);
      myIssues = myIssues.map(i => i.id === updated.id ? updated : i);
      replyText[issue.id] = '';
    } catch (e: unknown) {
      replyError = (e as Error).message || 'Failed to send reply';
    } finally {
      replyBusyId = null;
    }
  }

  function relativeDate(ms: number): string {
    const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 7 * 86_400) return `${Math.floor(secs / 86_400)}d ago`;
    return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function attachmentName(url: string): string {
    return url.slice(url.lastIndexOf('/') + 1) || url;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="settings-page" role="region" aria-label="Help and feedback">
  <div class="settings-header">
    <h2 class="feedback-title">Help &amp; Feedback</h2>
    <button class="settings-done" onclick={close}>Done</button>
  </div>
  <div class="settings-scroll">
    {#if success}
      <div class="settings-success">{success}</div>
    {/if}

    <SettingsSection heading="Get help">
      <div class="settings-rows">
        <div class="settings-row">
          <div class="settings-label">
            <span class="settings-label-text">Community support</span>
            <span class="settings-label-desc">Ask in {SUPPORT_CHANNEL} on the IRC Fiber network — our bot posts every report there.</span>
          </div>
          <div class="settings-control">
            {#if fiberNet}
              <button class="settings-btn settings-btn--secondary" onclick={joinSupport}>Join {SUPPORT_CHANNEL}</button>
            {:else}
              <span class="settings-value">Connect to irc.ircfiber.com first</span>
            {/if}
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-label">
            <span class="settings-label-text">Keyboard shortcuts</span>
            <span class="settings-label-desc">Everything you can do without touching the mouse.</span>
          </div>
          <div class="settings-control">
            <button class="settings-btn settings-btn--secondary" onclick={openShortcuts}>Show shortcuts</button>
          </div>
        </div>
      </div>
    </SettingsSection>

    <SettingsSection heading="Report an issue">
      <div class="feedback-form">
        <label class="feedback-field">
          <span class="settings-label-text">Type</span>
          <select class="settings-select" bind:value={kind}>
            {#each Object.entries(KIND_LABELS) as [value, label] (value)}
              <option {value}>{label}</option>
            {/each}
          </select>
        </label>
        <label class="feedback-field">
          <span class="settings-label-text">Summary</span>
          <input type="text" class="settings-input" maxlength="120" placeholder="Short summary" bind:value={title} />
        </label>
        <label class="feedback-field">
          <span class="settings-label-text">Details</span>
          <textarea class="settings-textarea" rows="6" maxlength="5000"
            placeholder="What happened? What did you expect? Steps to reproduce."
            bind:value={body}></textarea>
        </label>
        <div class="feedback-files">
          <label class="settings-btn settings-btn--secondary">
            Add screenshots
            <input type="file" accept="image/*" multiple class="settings-file-input" onchange={pickFiles} disabled={busy} />
          </label>
          {#each files as f, i (f.name + i)}
            <span class="settings-chip">
              {f.name}
              <button class="settings-chip-remove" onclick={() => removeFile(i)} aria-label="Remove {f.name}">&times;</button>
            </span>
          {/each}
        </div>
        <label class="feedback-check">
          <input type="checkbox" bind:checked={includeDiagnostics} />
          Include diagnostics (app version, browser, current channel)
        </label>
        {#if error}
          <div class="settings-error">{error}</div>
        {/if}
        <div>
          <button class="settings-btn" onclick={submit} disabled={busy}>{busy ? 'Sending…' : 'Send report'}</button>
        </div>
      </div>
    </SettingsSection>

    <SettingsSection heading="Your reports">
      {#if issuesError}
        <div class="settings-error">{issuesError}</div>
      {:else if issuesLoaded && myIssues.length === 0}
        <span class="settings-value">You haven't submitted any reports yet.</span>
      {:else}
        <ul class="feedback-issues">
          {#each myIssues as issue (issue.id)}
            <li class="feedback-issue" class:expanded={expandedId === issue.id}>
              <button type="button" class="feedback-issue__head" onclick={() => toggleIssue(issue.id)} aria-expanded={expandedId === issue.id}>
                <span class="feedback-issue__num">#{issue.number}</span>
                <span class="settings-chip">{KIND_LABELS[issue.kind] ?? issue.kind}</span>
                <span class="feedback-issue__title">{issue.title}</span>
                <span class="feedback-status feedback-status--{issue.status}">{STATUS_LABELS[issue.status] ?? issue.status}</span>
                <span class="feedback-issue__date">{relativeDate(issue.createdAt)}</span>
              </button>
              {#if expandedId === issue.id}
                <div class="feedback-issue__body">
                  <p class="feedback-issue__text">{issue.body}</p>
                  {#if issue.attachments.length > 0}
                    <div class="feedback-issue__attachments">
                      {#each issue.attachments as url (url)}
                        <a href={url} target="_blank" rel="noopener">{attachmentName(url)}</a>
                      {/each}
                    </div>
                  {/if}
                  {#if issue.comments.length > 0}
                    <ul class="feedback-comments">
                      {#each issue.comments as c (c.id)}
                        <li class="feedback-comment" class:feedback-comment--admin={c.fromAdmin}>
                          <span class="feedback-comment__meta">
                            <strong>{c.authorName}</strong>{#if c.fromAdmin} (admin){/if} · {relativeDate(c.createdAt)}
                          </span>
                          <span class="feedback-comment__text">{c.body}</span>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                  <div class="feedback-reply">
                    <textarea class="settings-textarea" rows="2" maxlength="5000"
                      placeholder={issue.status === 'resolved' || issue.status === 'closed' ? 'Still a problem? Replying reopens this report.' : 'Add a reply'}
                      bind:value={replyText[issue.id]}></textarea>
                    <button class="settings-btn settings-btn--small" onclick={() => reply(issue)}
                      disabled={replyBusyId === issue.id || !(replyText[issue.id] ?? '').trim()}>
                      {replyBusyId === issue.id ? 'Sending…' : 'Reply'}
                    </button>
                  </div>
                  {#if replyError && expandedId === issue.id}
                    <div class="settings-error">{replyError}</div>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </SettingsSection>
  </div>
</div>

<style>
  .feedback-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: #e6e6e6;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .feedback-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 640px;
    padding-bottom: 8px;
  }
  .feedback-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .feedback-files {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .feedback-check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #8b949e;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .feedback-issues {
    list-style: none;
    margin: 0;
    padding: 0;
    max-width: 760px;
  }
  .feedback-issue {
    border: 1px solid #2c2f35;
    border-radius: 4px;
    margin-bottom: 6px;
    background: #0d1117;
  }
  .feedback-issue__head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    color: #d1d5db;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .feedback-issue__head:hover { background: #161b22; }
  .feedback-issue__num { color: #8b949e; flex-shrink: 0; }
  .feedback-issue__title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .feedback-issue__date { color: #6e7681; font-size: 11px; flex-shrink: 0; }
  .feedback-issue__body {
    padding: 0 10px 10px 10px;
    border-top: 1px solid #2c2f35;
    font-size: 12px;
    color: #d1d5db;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .feedback-issue__text {
    white-space: pre-wrap;
    word-break: break-word;
    margin: 10px 0;
  }
  .feedback-issue__attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
  }
  .feedback-issue__attachments a { color: #58a6ff; font-size: 11px; }
  .feedback-comments {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .feedback-comment {
    padding: 6px 8px;
    border-left: 2px solid #2c2f35;
    background: #161b22;
    border-radius: 0 4px 4px 0;
  }
  .feedback-comment--admin { border-left-color: #58a6ff; }
  .feedback-comment__meta {
    display: block;
    font-size: 11px;
    color: #8b949e;
    margin-bottom: 2px;
  }
  .feedback-comment__text { white-space: pre-wrap; word-break: break-word; }
  .feedback-reply {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .feedback-status {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    color: #0d1117;
    flex-shrink: 0;
  }
  .feedback-status--open { background: #58a6ff; }
  .feedback-status--in_progress { background: #d29922; }
  .feedback-status--resolved { background: #3fb950; }
  .feedback-status--closed { background: #8b949e; }
</style>
