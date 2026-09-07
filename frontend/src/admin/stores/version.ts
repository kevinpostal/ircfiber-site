import { writable } from 'svelte/store';

export interface VersionInfo {
  service: string;
  version: string;
  commit: string;
  short: string;
  describe: string;
  branch: string;
  builtAt: string;
  builtHost: string;
  message?: string;
  commitUrl?: string;
}

export interface EngineVersion {
  serverId: string;
  isHealthy: boolean;
  gitHash: string;
  gitShort: string;
  gitDescribe: string;
  gitBranch: string;
  buildTime: string;
  version: string;
  gitMessage?: string;
  gitCommitUrl?: string;
  lastHeartbeat: number;
}

export interface VersionResponse {
  gateway: VersionInfo;
  engines: EngineVersion[];
  commit: string;
  short: string;
  describe: string;
  branch: string;
  builtAt: string;
  version: string;
  message?: string;
  commitUrl?: string;
  versionScheme?: number;
}

export const version = writable<VersionResponse | null>(null);
export const versionError = writable<string | null>(null);
export const versionLoading = writable(false);

export async function fetchVersion(): Promise<void> {
  versionLoading.set(true);
  versionError.set(null);
  try {
    const res = await fetch('/api/version', { credentials: 'include' });
    if (res.status === 404) {
      // Gateway too old to have /api/version — show a placeholder, not an error
      const dev = {
        version: 'dev', commit: 'dev', short: 'dev', describe: 'dev', branch: 'dev',
        builtAt: 'dev', message: '', commitUrl: '',
      };
      const fallback: VersionResponse = {
        gateway: { service: 'irc-fiber-gateway', builtHost: 'dev', ...dev },
        engines: [],
        ...dev,
      };
      version.set(fallback);
      versionError.set(null);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as VersionResponse;
    version.set(data);
  } catch (e: any) {
    versionError.set(e?.message ?? String(e));
  } finally {
    versionLoading.set(false);
  }
}
