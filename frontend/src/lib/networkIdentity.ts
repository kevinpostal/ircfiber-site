import { updateNetwork } from '../stores/api';
import { sendRaw } from '../stores/wsConnection.svelte';

/** The three identity fields a user can edit per network. */
export interface IdentityPatch {
  networkId: string;
  nick: string;
  ident: string;
  realName: string;
}

/** Prior values, so the caller learns whether a reconnect is needed. */
export interface IdentityPrior {
  nick: string;
  ident: string;
  realName: string;
}

interface IdentityDeps {
  onUpdateNetwork?: typeof updateNetwork;
  onSendRaw?: typeof sendRaw;
}

/**
 * Persists nick/ident/realname. A changed nick is also sent as a live `NICK`
 * (the same wire path as `/nick` and NetworkForm); ident and realname only
 * apply on the next (re)connect, so the caller decides whether to offer
 * Reconnect — `needsReconnect` says when that is worth showing.
 */
export async function saveNetworkIdentity(
  patch: IdentityPatch,
  prior: IdentityPrior,
  deps: IdentityDeps = {},
): Promise<{ needsReconnect: boolean }> {
  const save = deps.onUpdateNetwork ?? updateNetwork;
  const raw = deps.onSendRaw ?? sendRaw;
  await save(patch.networkId, {
    nick: patch.nick,
    ident: patch.ident,
    realName: patch.realName,
  });
  if (patch.nick !== prior.nick && patch.nick.length > 0) {
    raw(patch.networkId, `NICK ${patch.nick}`);
  }
  return { needsReconnect: prior.ident !== patch.ident || prior.realName !== patch.realName };
}
