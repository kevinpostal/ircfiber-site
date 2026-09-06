/**
 * Shared shapes and display labels for the admin Support pages
 * (list `#/support` and triage `#/support/:id`). Mirrors the JSON emitted by
 * `ircfiber.support.json.supportIssueToJson` with `includeInternal=true`.
 */
export type SupportStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type SupportKind = 'bug' | 'feature' | 'question' | 'other';
export type SupportPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface SupportRow {
  id: string;
  number: number;
  kind: SupportKind;
  title: string;
  body: string;
  status: SupportStatus;
  priority: SupportPriority;
  reporterUsername: string;
  userId: string;
  assigneeId: string;
  assigneeUsername: string;
  attachments: string[];
  commentCount: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number;
}

export interface SupportComment {
  id: string;
  authorName: string;
  fromAdmin: boolean;
  internal: boolean;
  body: string;
  createdAt: number;
}

export interface SupportContext {
  appVersion: string;
  userAgent: string;
  url: string;
  networkId: string;
  bufferName: string;
  viewport: string;
}

export interface SupportDetail extends SupportRow {
  comments: SupportComment[];
  context: SupportContext;
  reporterEmail: string;
}

export const STATUSES: SupportStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
export const PRIORITIES: SupportPriority[] = ['low', 'normal', 'high', 'urgent'];

export const STATUS_LABELS: Record<SupportStatus, string> = {
  open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed',
};
export const STATUS_TONES: Record<SupportStatus, 'primary' | 'warn' | 'success' | 'muted'> = {
  open: 'primary', in_progress: 'warn', resolved: 'success', closed: 'muted',
};
export const KIND_LABELS: Record<SupportKind, string> = {
  bug: 'Bug', feature: 'Feature', question: 'Question', other: 'Other',
};
export const CONTEXT_LABELS: Record<keyof SupportContext, string> = {
  appVersion: 'App version', userAgent: 'Browser', url: 'URL',
  networkId: 'Network', bufferName: 'Buffer', viewport: 'Viewport',
};
