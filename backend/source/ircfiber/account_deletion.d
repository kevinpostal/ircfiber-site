/**
 * Erasing a user account, in one place.
 *
 * A website account owns state in four systems — Mongo (the user document,
 * their networks, their uploads), Redis (per-network engine state, the
 * assignment hash, buffers, preferences, sessions), the local upload
 * directory, and Anope (the NickServ account the provisioner registered in
 * the user's name). Deleting the Mongo document alone leaves the engine
 * connecting a network whose owner no longer exists, an assignment nothing
 * will ever reap, and a registered nick holding the user's email address.
 *
 * This module is the single implementation of that purge. It exists because
 * there were two copies of it (`apiUserDelete` and `apiUsersBulkDelete`) and
 * a third caller was needed for `DELETE /api/me` — the "Delete my account"
 * button, which had no route at all and answered 404 for every user. Three
 * copies of a destructive sequence is how self-deletion ends up cleaning
 * less than the admin path.
 */
module ircfiber.account_deletion;

import std.datetime : Clock;
import std.file : remove;
import std.path : buildPath;
import std.string : indexOf, strip;
import std.uuid : UUID;

import vibe.core.log;
import vibe.data.json : Json;

import ircfiber.api.session : WS_SESSION_KEY_PREFIX;
import ircfiber.storage.session : RedisSessionStore;
import ircfiber.db.network : NetworkRepository;
import ircfiber.db.uploads : UploadRepository;
import ircfiber.db.user : UserRepository;
import ircfiber.default_network : DEFAULT_FIBER_HOST;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.models.network : NetworkConfig;
import ircfiber.models.user : User;
import ircfiber.redis.protocol : ControlMessage, RedisKeys;
import ircfiber.services.anope : anopeAccessDenied, anopeOperCommand, isSafeServicesArg,
    loadAnopeSettings;
import ircfiber.storage.buffer : BufferManager;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.upload.local : uploadDir;

/**
 * Deletes `user` and every trace of them.
 *
 * Order matters: each network is disconnected before its document goes, so
 * the engine is told to drop the socket rather than discovering later that
 * the config vanished. The user document is deleted LAST — if anything in
 * between throws, the account still exists and the operation can be retried,
 * which is far better than a headless pile of orphaned networks.
 *
 * Every step that only removes derived state (buffers, sessions, prefs,
 * upload files, the services account) is best-effort: none of them may block
 * the deletion the user asked for. The Mongo writes are not swallowed — a
 * failure there is a real failure and the caller must report it.
 */
void purgeUserAccount(User user, RedisStorage redis, ServerRegistry serverRegistry) {
    const id = user.id;
    const userId = id.toString();
    auto db = redis.getDb();
    auto netRepo = new NetworkRepository();
    auto bufferManager = new BufferManager(redis);

    foreach (net; netRepo.findByUserId(id)) {
        dropServicesAccount(net);
        purgeNetworkRuntimeState(net.id, redis, serverRegistry);
        netRepo.deleteById(net.id);
    }

    try db.del("prefs:" ~ userId);
    catch (Exception e) logWarn("purge %s: deleting prefs failed: %s", user.username, e.msg);
    purgeUploads(userId, user.username);
    destroySessions(redis, userId);
    purgeWsSessions(redis, userId);
    new UserRepository().deleteById(id);
    logWarn("Account purged: %s (id=%s)", user.username, userId);
}

/**
 * Disconnects a network and erases every trace of it OUTSIDE Mongo: the
 * engine is told to drop the socket, its scrollback and dedup sets go, and
 * so do the assignment, the state snapshot, the retry marker, the lease and
 * the persisted nick.
 *
 * Shared by account deletion and `DELETE /api/networks/:id`, because the
 * single-network path used to leave all of it behind. Observed on prod: a
 * network deleted at 19:10 still had its `irc:assignments` entry, a state
 * snapshot claiming `connected: true`, and full `#channel` scrollback half
 * an hour later — so the admin dashboard counted a network nothing could
 * look up, and the frontend could still open and render the dead room.
 *
 * The Mongo document is NOT deleted here: the two callers delete it at
 * different points (account purge does it last, per-network delete has
 * already validated ownership), and mixing the two would hide which
 * failure left what behind.
 */
void purgeNetworkRuntimeState(UUID networkId, RedisStorage redis,
                              ServerRegistry serverRegistry) {
    const netId = networkId.toString();
    auto db = redis.getDb();
    auto bufferManager = new BufferManager(redis);

    string serverId;
    try serverId = serverRegistry.getServerForNetwork(netId);
    catch (Exception e) logWarn("purge: server lookup for %s failed: %s", netId, e.msg);

    auto msg = ControlMessage("removeNetwork", netId);
    msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
    try {
        if (serverId.length > 0) redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
        else redis.lpush(RedisKeys.control_legacy(), msg.toJson().toString());
    } catch (Exception e) {
        logWarn("purge: could not tell the engine to drop %s: %s", netId, e.msg);
    }

    try {
        if (serverId.length > 0) bufferManager.clearNetworkBuffers(serverId, netId);
        else bufferManager.clearNetworkBuffers(netId);
    } catch (Exception e) {
        logWarn("purge: clearing buffers for %s failed: %s", netId, e.msg);
    }

    try {
        if (serverId.length > 0) db.del(RedisKeys.state(serverId, netId));
        db.del(RedisKeys.state_legacy(netId));
        // The assignment outlives the network otherwise, and the janitor
        // then keeps reporting a network nothing can look up.
        db.hdel(RedisKeys.networkAssignments(), netId);
        db.del(RedisKeys.networkFail(netId));
        // The lease is what stops another engine from adopting the id, and
        // the persisted nick is what a re-created network would inherit.
        db.del(RedisKeys.lease(netId));
        db.del(RedisKeys.networkNick(netId));
    } catch (Exception e) {
        logWarn("purge: Redis cleanup for %s failed: %s", netId, e.msg);
    }
}

/// Drops the NickServ account the provisioner registered for this user.
///
/// Only for the platform network: that account exists because we created it,
/// under the user's email, and nobody else holds its password. Leaving it
/// behind keeps their nick claimed forever and keeps their address in
/// `anope.db` after they asked to be deleted. A network the user added
/// themselves is never touched — the credential there is theirs, not ours.
///
/// Best-effort by design: an unreachable Anope must not stop the deletion.
private void dropServicesAccount(NetworkConfig cfg) {
    if (cfg.host != DEFAULT_FIBER_HOST) return;
    const account = cfg.saslUsername.strip();
    if (account.length == 0 || !isSafeServicesArg(account)) return;

    auto s = loadAnopeSettings();
    if (!s.configured || !s.hasOper) {
        logWarn("purge: cannot drop NickServ account %s — Anope RPC or oper account not configured",
                account);
        return;
    }
    auto r = anopeOperCommand(s, "DROP " ~ account);
    if (!r.transportOk) {
        logWarn("purge: dropping NickServ account %s failed: %s", account, r.transportError);
        return;
    }
    if (anopeAccessDenied(r)) {
        logWarn("purge: Anope refused to drop %s — the services oper account has no privileges",
                account);
        return;
    }
    logInfo("purge: dropped NickServ account %s", account);
}

/// Kills every login the user still holds, so a deleted account cannot keep
/// browsing on an already-issued cookie.
private void destroySessions(RedisStorage redis, string userId) {
    // vibe.d JSON-encodes every session value, so the stored user id arrives
    // wrapped in literal quotes. Local rather than shared: the admin copy of
    // this helper is `package`-scoped to ircfiber.web.admin.
    static string unquote(string raw) @safe pure nothrow @nogc {
        return raw.length >= 2 && raw[0] == '"' && raw[$ - 1] == '"' ? raw[1 .. $ - 1] : raw;
    }

    try {
        auto store = new RedisSessionStore(redis);
        foreach (sid; store.listAllSessionIds()) {
            const fields = store.getSessionFields(sid);
            if (fields is null) continue;
            auto uidPtr = "sessionUserId" in fields;
            if (uidPtr is null) continue;
            if (unquote(*uidPtr) == userId) store.destroy(sid);
        }
    } catch (Exception e) {
        logWarn("purge %s: clearing sessions failed: %s", userId, e.msg);
    }
}

/// Removes the persisted WebSocket-session blobs this user owns.
///
/// They are keyed by session id, not by user, so they have to be read to be
/// matched. Skipping them is not harmless: each blob carries the user's
/// username and email and has a 90-day TTL, so "delete my account" would
/// leave their details in Redis for three months.
private void purgeWsSessions(RedisStorage redis, string userId) {
    try {
        auto db = redis.getDb();
        foreach (k; db.keys(WS_SESSION_KEY_PREFIX ~ "*")) {
            const key = () @trusted { return cast(string) k.idup; }();
            if (key.length == 0) continue;
            try {
                auto j = redis.getJson(key);
                if (j.type != Json.Type.object) continue;
                if (j["userId"].opt!string("") != userId) continue;
                redis.del(key);
            } catch (Exception e) {
                logWarn("purge %s: reading %s failed: %s", userId, key, e.msg);
            }
        }
    } catch (Exception e) {
        logWarn("purge %s: clearing WebSocket sessions failed: %s", userId, e.msg);
    }
}

/// Removes the upload records AND the files on disk. A soft delete would
/// leave the bytes publicly served from `/uploads/<name>` forever.
private void purgeUploads(string userId, string username) {
    try {
        auto uploadRepo = new UploadRepository();
        foreach (upload; uploadRepo.listAllByUser(userId)) {
            auto url = upload.directUrl.strip;
            const prefixPos = url.indexOf("/uploads/");
            if (prefixPos != -1) {
                auto filename = url[prefixPos + "/uploads/".length .. $];
                if (filename.length > 0) {
                    try remove(buildPath(uploadDir(), filename));
                    catch (Exception) {}
                }
            }
            try uploadRepo.hardDelete(userId, upload.id);
            catch (Exception e) logWarn("purge %s: deleting upload %s failed: %s",
                                        username, upload.id, e.msg);
        }
    } catch (Exception e) {
        logWarn("purge %s: listing uploads failed: %s", username, e.msg);
    }
}
