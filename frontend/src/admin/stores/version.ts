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
  deployedFrontend?: string;
  deployedEngine?: string;
  deployed?: string;
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
      // Gateway too old — fallback to frontend build info, don't show error
      const { BUILD_INFO } = await import('../../lib/buildInfo');
      const fallback: VersionResponse = {
        gateway: {
          service: 'irc-fiber-gateway',
          version: BUILD_INFO.version,
          commit: BUILD_INFO.commit,
          short: BUILD_INFO.short,
          describe: BUILD_INFO.describe,
          branch: BUILD_INFO.branch,
          builtAt: BUILD_INFO.builtAt,
          builtHost: BUILD_INFO.builtHost,
          message: (BUILD_INFO as any).message ?? BUILD_INFO.describe,
          commitUrl: (BUILD_INFO as any).commitUrl ?? '',
        },
        engines: [],
        commit: BUILD_INFO.commit,
        short: BUILD_INFO.short,
        describe: BUILD_INFO.describe,
        branch: BUILD_INFO.branch,
        builtAt: BUILD_INFO.builtAt,
        version: BUILD_INFO.version,
        message: (BUILD_INFO as any).message ?? BUILD_INFO.describe,
        commitUrl: (BUILD_INFO as any).commitUrl ?? '',
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
