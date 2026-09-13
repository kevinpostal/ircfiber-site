module ircfiber.api.rest;

import std.uuid : UUID, parseUUID, randomUUID;
import std.conv : to;
import std.datetime : Clock;
import std.algorithm : canFind, countUntil, filter;
import std.array : array;
import vibe.http.router : URLRouter;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.data.json : Json, deserializeJson, parseJson, parseJsonString, serializeToJson;
import vibe.data.bson : Bson;
import vibe.core.log;
import vibe.core.core : runTask;
import ircfiber.api.session : SessionManager;
import ircfiber.models.user : User;
import ircfiber.models.network : NetworkConfig, TLSMode, SASLMechanism, dedupChannels;
import ircfiber.default_network : DEFAULT_FIBER_HOST, DEFAULT_FIBER_PORT, DEFAULT_FIBER_CHANNELS,
    ensureDefaultFiberNetwork;
import ircfiber.models.irc_event : IRCRawEvent;
import ircfiber.storage.buffer : BufferManager;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.db.network : NetworkRepository;
import ircfiber.db.messages : MessageRepository;
import ircfiber.db.preferences : PreferencesRepository, UserPreferences;
import ircfiber.db.uploads : UploadRepository, UploadRecord;
import ircfiber.db.pastebins : PastebinRepository, PasteRecord, countLines;
import ircfiber.db.img2irc_saves : Img2IrcSaveRecord, Img2IrcSaveRepository;
import ircfiber.db.support_issues : SupportIssueRepository, SupportIssueRecord, SupportComment, SupportIssueContext;
import ircfiber.support.events : SupportEvent, pushSupportEvent;
import ircfiber.support.json : supportIssueToJson, isValidKind, sanitizeLine;
import ircfiber.logs.events : LogEvent, pushLogEvent;
import ircfiber.env : envSecret;
import ircfiber.upload.local : LocalUploadResult, LocalUploadException, saveUpload, saveIrcArtOriginal, saveIrcArtThumbnail, uploadDir;
import std.file : remove, readText, exists;
import std.path : buildPath;
import std.string : strip, indexOf, lastIndexOf, toLower;
import ircfiber.auth : requireAuth;
import ircfiber.api.image_proxy : handleImageProxy;
import ircfiber.build_info : buildInfo;
import ircfiber.db.mongo : AppMongoConnection;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.irc.server : ConnectionServer;
import ircfiber.redis.protocol : RedisKeys, ControlMessage, NetworkStateSnapshot, IRCCommand;
import ircfiber.logging : logJsonMap;
import ircfiber.tracing : withSpan, Span;
import ircfiber.egress : DIRECT_EGRESS_ID, EgressView, egressView, matchingSlot,
    normalizeEgressId, isKnownEgressId;
import ircfiber.services.accounts : provisionServicesAccountAsync, servicesSkipKey;
import ircfiber.network_lifecycle : normalizeHost, provisionNetwork, updateOwnedNetwork, deleteOwnedNetwork;
import ircfiber.db.user : UserRepository;
import ircfiber.bnc.wire : networkSlugs;

/**
 * Decentralized REST API
 *
 * Routes commands to the correct connection server based on network
 * assignments stored in the ServerRegistry. Each command is pushed to
 * the server-specific queue rather than the global queue.
 */
final class RESTAPI {
    private {
        BufferManager bufferManager;
        NetworkRepository networkRepo;
        UserRepository userRepo;
        PreferencesRepository prefsRepo;
        UploadRepository uploadRepo;
        PastebinRepository pastebinRepo;
        Img2IrcSaveRepository ircArtRepo;
        SupportIssueRepository supportRepo;
        RedisStorage redis;
        ServerRegistry serverRegistry;  // NEW: decentralized routing
        SessionManager sessionManager;  // T1-W3: gateway contention metrics
    }

    /// Creates a new REST API handler.
    this(BufferManager bm, RedisStorage redis, SessionManager sm = null) {
        this.bufferManager = bm;
        this.redis = redis;
        this.sessionManager = sm;
        this.networkRepo = new NetworkRepository();
        this.userRepo = new UserRepository();
        this.prefsRepo = new PreferencesRepository(redis);
        this.uploadRepo = new UploadRepository();
        this.pastebinRepo = new PastebinRepository();
        this.ircArtRepo = new Img2IrcSaveRepository();
        this.supportRepo = new SupportIssueRepository();
        this.serverRegistry = new ServerRegistry(redis);  // NEW
    }

    /// Registers REST routes on the given router.
    void registerRoutes(URLRouter router) {
        router.get("/api/image-proxy", &handleImageProxy);
        router.get("/api/networks", &getNetworks);
        router.post("/api/networks", &createNetwork);
        router.post("/api/networks/default-fiber", &createDefaultFiberNetwork);
        router.put("/api/networks/:id", &updateNetwork);
        router.patch("/api/networks/:id", &updateNetwork);
        router.delete_("/api/networks/:id", &deleteNetwork);
        router.get("/api/egress", &getEgress);
        router.get("/api/channels/:network/:channel/messages", &getMessages);
        router.post("/api/networks/:network/join", &joinChannel);
        router.post("/api/networks/:network/part", &partChannel);
        router.post("/api/networks/:id/disconnect", &disconnectNetwork);
        router.post("/api/networks/:id/reconnect", &reconnectNetwork);
        router.post("/api/networks/:id/buffers/clear", &clearNetworkBuffer);
        router.get("/api/me/bouncer", &getBouncer);
        router.post("/api/me/bouncer", &generateBouncer);
        router.delete_("/api/me/bouncer", &revokeBouncer);
        router.get("/api/me/bouncer/clients", &getMyBouncerClients);
        router.post("/api/me/bouncer/clients/:sid/disconnect", &disconnectMyBouncerClient);
        router.get("/api/me", &getMe);
        router.post("/api/me/password", &changeMyPassword);
        router.delete_("/api/me", &deleteMe);
        router.get("/api/me/irc-account", &getIrcAccount);
        router.post("/api/me/irc-account/retry", &retryIrcAccount);
        router.get("/api/me/sessions", &getMySessions);
        router.delete_("/api/me/sessions/:ref", &revokeMySession);
        router.post("/api/me/pins", &pinChannel);
        router.delete_("/api/me/pins/:network/:channel", &unpinChannel);
        router.post("/api/me/members-collapsed", &updateMembersCollapsed);
        router.post("/api/me/conversations-collapsed", &updateConversationsCollapsed);
        router.post("/api/me/buffer-prefs", &updateBufferPrefs);
        router.post("/api/me/collapsed", &updateCollapsed);
        router.post("/api/me/inactive-collapsed", &updateInactiveCollapsed);
        router.post("/api/me/network-order", &updateNetworkOrder);
        router.post("/api/me/ignores", &updateIgnores);
        router.post("/api/me/pin-order", &updatePinnedOrder);
        router.post("/api/me/show-member-prefixes", &updateShowMemberPrefixes);
        router.post("/api/me/bnc-playback-lines", &updateBncPlaybackLines);
        router.post("/api/me/notification-prefs", &updateNotificationPrefs);
        router.get("/api/ping", &ping);
        router.get("/health", &healthCheck);
        router.get("/api/health", &healthCheck);
        router.get("/api/version", &versionCheck);
        router.get("/api/git", &versionCheck);
        router.get("/version", &versionCheck);
        // SigNoz Alertmanager webhook → #staff (via the logs outbox).
        // Session-unauthenticated by design: SigNoz is not a website user,
        // so this route must never call requireAuth. The only gate is the
        // IRCFIBER_ALERT_WEBHOOK_TOKEN bearer secret (see signozAlertHook).
        router.post("/api/hooks/signoz", &signozAlertHook);
        // 2026-07-07 redesign: OOB (out-of-band) event fetch for hole
        // filling. The client calls this when it detects a gap in the
        // eid stream from the WS (e.g. WS silently dropped a frame).
        // Returns events with eid > `since`, across all channels of
        // the requested network, so the client can route them by channel.
        router.get("/api/oob", &getOOBEvents);
        // NEW: Decentralized endpoints
        router.get("/api/servers", &getServers);  // List connection servers
        router.get("/api/servers/:id", &getServer);  // Server health/status
        // Handoff / hot-reload admin endpoint
        router.get("/api/admin/handoff/status", &getHandoffStatus);
        // Manual draining recovery: clear a stuck draining flag
        router.post("/api/admin/servers/:id/clear-draining", &clearServerDraining);
        router.post("/api/upload", &uploadFile);
        router.get("/api/uploads", &getUploads);
        router.get("/api/uploads/:id", &getUploadById);
        router.delete_("/api/uploads/:id", &deleteUpload);
        router.post("/api/uploads/:id/edit", &editUpload);
        router.post("/api/uploads/:id/gif", &convertUploadToGif);
        router.get("/api/uploads/gif-jobs/:jobId", &getGifJob);
        router.get("/api/pastebins", &getPastebins);
        router.post("/api/pastebins", &createPastebin);
        router.get("/api/pastebins/:id/raw", &getPastebinRaw);
        router.get("/api/pastebins/:id", &getPastebinById);
        router.put("/api/pastebins/:id", &updatePastebin);
        router.delete_("/api/pastebins/:id", &deletePastebin);
        router.get("/api/img2irc-saves", &getIrcArtSaves);
        router.post("/api/img2irc-saves", &createIrcArtSave);
        router.get("/api/img2irc-saves/:id", &getIrcArtSave);
        router.put("/api/img2irc-saves/:id", &updateIrcArtSave);
        router.delete_("/api/img2irc-saves/:id", &deleteIrcArtSave);
        // Help & Feedback reports (announced in #support by the support bot)
        router.get("/api/support/issues", &getSupportIssues);
        router.post("/api/support/issues", &createSupportIssue);
        router.get("/api/support/issues/:id", &getSupportIssue);
        router.post("/api/support/issues/:id/comments", &addSupportIssueComment);
        // W3-T01a: Bulk archive-names endpoint (cached, 5-min TTL)
        router.get("/api/buffers/archive-names", &getArchiveNames);
    }

    private void getNetworks(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto configs = networkRepo.findByUserId(user.id);
        Json[] arr;
        foreach (ref cfg; configs) {
            auto j = cfg.toJson();
            auto snap = loadSnapshot(cfg.id.toString());
            j["connected"] = Json(snap.connected);
            j["status"] = Json(snap.status);
            j["currentNick"] = Json(snap.currentNick.length ? snap.currentNick : cfg.nick);
            j["isAway"] = Json(snap.isAway);
            if (snap.awayMessage.length) j["awayMessage"] = Json(snap.awayMessage);
            // NEW: Include server assignment
            j["serverId"] = Json(serverRegistry.getServerForNetwork(cfg.id.toString()));
            if (snap.caps.length) {
                auto capsArr = Json.emptyArray;
                foreach (c; snap.caps) capsArr ~= Json(c);
                j["caps"] = capsArr;
            }
            arr ~= j;
        }
        res.writeJsonBody(Json(arr));
    }

    private void createNetwork(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;

        NetworkConfig cfg;
        cfg.id = randomUUID();
        cfg.name = bodyJson["name"].get!string;
        cfg.host = normalizeHost(bodyJson["host"].get!string);
        cfg.port = cast(ushort) bodyJson["port"].get!int;
        cfg.tls = bodyJson["tls"].get!string.to!TLSMode;
        cfg.nick = bodyJson["nick"].get!string;

        if (bodyJson["realName"].type != Json.Type.undefined) {
            cfg.realName = bodyJson["realName"].get!string;
            if (cfg.realName.length == 0) cfg.realName = cfg.nick;
        } else {
            cfg.realName = cfg.nick;
        }

        // Fiber lock: host/port/tls/nick/realName are managed — ignore client-supplied values
        if (cfg.host == DEFAULT_FIBER_HOST) {
            cfg.port = DEFAULT_FIBER_PORT;
            cfg.tls = TLSMode.required;
            cfg.nick = user.username;
            cfg.realName = user.username;
        }

        cfg.autoJoinChannels = dedupChannels(deserializeJson!(string[])(bodyJson["autoJoinChannels"]));
        // Fiber lock: auto-join must include #support and #ircfiber for irc.ircfiber.com
        if (cfg.host == DEFAULT_FIBER_HOST) {
            bool[string] _seen; foreach (c; cfg.autoJoinChannels) _seen[c] = true;
            foreach (ch; DEFAULT_FIBER_CHANNELS) if (ch !in _seen) cfg.autoJoinChannels ~= ch;
        }
        if (bodyJson["partedChannels"].type != Json.Type.undefined)
            cfg.partedChannels = dedupChannels(deserializeJson!(string[])(bodyJson["partedChannels"]));

        // SASL authentication fields
        if (bodyJson["sasl"].type != Json.Type.undefined)
            cfg.sasl = bodyJson["sasl"].get!string.to!SASLMechanism;
        if (bodyJson["saslUsername"].type != Json.Type.undefined)
            cfg.saslUsername = bodyJson["saslUsername"].get!string;
        if (bodyJson["saslPassword"].type != Json.Type.undefined)
            cfg.saslPassword = bodyJson["saslPassword"].get!string;

        // NickServ password, connect commands, and server password
        if (bodyJson["nspass"].type != Json.Type.undefined)
            cfg.nspass = bodyJson["nspass"].get!string;
        if (bodyJson["commands"].type != Json.Type.undefined)
            cfg.commands = bodyJson["commands"].get!string;
        if (bodyJson["serverPass"].type != Json.Type.undefined)
            cfg.serverPass = bodyJson["serverPass"].get!string;
        if (bodyJson["operUsername"].type != Json.Type.undefined)
            cfg.operUsername = bodyJson["operUsername"].get!string;
        if (bodyJson["operPassword"].type != Json.Type.undefined)
            cfg.operPassword = bodyJson["operPassword"].get!string;

        // Auto-join delay (seconds after connect before JOINs are sent).
        // 0 = join immediately after registration (legacy behavior).
        if (bodyJson["autoJoinDelaySeconds"].type != Json.Type.undefined) {
            const v = bodyJson["autoJoinDelaySeconds"].get!int;
            cfg.autoJoinDelaySeconds = v > 0 ? cast(uint) v : 0;
        }

        // Egress pin: "" automatic, "direct" bare host IP, a country code, or
        // `<country>-<city>`. Rejected when this deployment cannot serve it,
        // 409 when it would need an exit and every exit is busy.
        if (bodyJson["egressNodeId"].type == Json.Type.string) {
            const eg = normalizeEgressId(bodyJson["egressNodeId"].get!string);
            if (!validateEgressPin(eg, res)) return;
            cfg.egressNodeId = eg;
        }

        string serverId = provisionNetwork(cfg, user.id, networkRepo, redis, serverRegistry);
        if (serverId.length == 0) {
            res.statusCode = 503;
            res.writeJsonBody(Json(["error": Json("No healthy connection servers available")]));
            return;
        }

        res.writeJsonBody(cfg.toJson());
    }

    /// One-click provisioning of the platform IRC Fiber network.
    ///
    /// Signup already runs `ensureDefaultFiberNetwork`, but that call is
    /// best-effort (a Mongo/Redis hiccup or the admin kill-switch skips it
    /// silently) and accounts predating the feature never got one. This
    /// gives the Welcome page a first-class "Connect to IRC Fiber" action.
    /// Idempotent: an existing irc.ircfiber.com network is returned as-is,
    /// never duplicated.
    private void createDefaultFiberNetwork(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto cfg = ensureDefaultFiberNetwork(user, networkRepo, redis, serverRegistry);
        if (cfg.id == UUID.init) {
            // Only the admin kill-switch (irc:config:fiberEnabled=0) or an
            // uninitialised user reaches here — infrastructure trouble after
            // the insert still returns the config.
            res.statusCode = 503;
            res.writeJsonBody(Json(["error": Json("The IRC Fiber server is not available right now")]));
            return;
        }
        redis.del(RedisKeys.userNetworks(user.id.toString()));
        res.writeJsonBody(cfg.toJson());
    }

    private void updateNetwork(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto id = parseUUID(req.params["id"]);
        auto bodyJson = req.json;
        auto info = networkRepo.findByIdWithUser(id);
        if (info.userId != UUID.init && info.userId != req.context["user"].get!User.id) {
            res.statusCode = 403;
            res.writeJsonBody(Json(["error": Json("Not your network")]));
            return;
        }
        auto cfg = info.config;

        if (bodyJson["name"].type != Json.Type.undefined) cfg.name = bodyJson["name"].get!string;
        if (bodyJson["host"].type != Json.Type.undefined) cfg.host = normalizeHost(bodyJson["host"].get!string);
        if (bodyJson["port"].type != Json.Type.undefined) cfg.port = cast(ushort) bodyJson["port"].get!int;
        if (bodyJson["tls"].type != Json.Type.undefined) cfg.tls = bodyJson["tls"].get!string.to!TLSMode;
        if (bodyJson["nick"].type != Json.Type.undefined) cfg.nick = bodyJson["nick"].get!string;

        if (bodyJson["realName"].type != Json.Type.undefined) {
            cfg.realName = bodyJson["realName"].get!string;
            if (cfg.realName.length == 0) cfg.realName = cfg.nick;
        }

        if (bodyJson["autoJoinChannels"].type != Json.Type.undefined)
            cfg.autoJoinChannels = dedupChannels(deserializeJson!(string[])(bodyJson["autoJoinChannels"]));
        // Fiber lock: re-assert managed fields and ensure auto-join contains required channels
        if (cfg.host == DEFAULT_FIBER_HOST) {
            cfg.port = DEFAULT_FIBER_PORT;
            cfg.tls = TLSMode.required;
            // cfg.nick / realName will be forced to user.username after user lookup below
            bool[string] _seen2; foreach (c; cfg.autoJoinChannels) _seen2[c] = true;
            foreach (ch; DEFAULT_FIBER_CHANNELS) if (ch !in _seen2) cfg.autoJoinChannels ~= ch;
        }
        if (bodyJson["partedChannels"].type != Json.Type.undefined)
            cfg.partedChannels = dedupChannels(deserializeJson!(string[])(bodyJson["partedChannels"]));

        // SASL authentication fields
        if (bodyJson["sasl"].type != Json.Type.undefined)
            cfg.sasl = bodyJson["sasl"].get!string.to!SASLMechanism;
        if (bodyJson["saslUsername"].type != Json.Type.undefined)
            cfg.saslUsername = bodyJson["saslUsername"].get!string;
        if (bodyJson["saslPassword"].type != Json.Type.undefined)
            cfg.saslPassword = bodyJson["saslPassword"].get!string;

        // NickServ password, connect commands, and server password
        if (bodyJson["nspass"].type != Json.Type.undefined)
            cfg.nspass = bodyJson["nspass"].get!string;
        if (bodyJson["commands"].type != Json.Type.undefined)
            cfg.commands = bodyJson["commands"].get!string;
        if (bodyJson["serverPass"].type != Json.Type.undefined)
            cfg.serverPass = bodyJson["serverPass"].get!string;
        if (bodyJson["operUsername"].type != Json.Type.undefined)
            cfg.operUsername = bodyJson["operUsername"].get!string;
        if (bodyJson["operPassword"].type != Json.Type.undefined)
            cfg.operPassword = bodyJson["operPassword"].get!string;

        // Auto-join delay (seconds after connect before JOINs are sent).
        // 0 = join immediately after registration (legacy behavior).
        if (bodyJson["autoJoinDelaySeconds"].type != Json.Type.undefined) {
            const v = bodyJson["autoJoinDelaySeconds"].get!int;
            cfg.autoJoinDelaySeconds = v > 0 ? cast(uint) v : 0;
        }

        // Egress pin change: the live socket is bound to the old exit, so a
        // changed value needs a reconnect (same control path the admin pin
        // uses) rather than the in-place updateConfig below. The engine
        // resolves the pin and retargets an idle slot on that next dial, so
        // exactly one network's socket is affected.
        const priorEgress = cfg.egressNodeId;
        if (bodyJson["egressNodeId"].type == Json.Type.string) {
            const eg = normalizeEgressId(bodyJson["egressNodeId"].get!string);
            if (!validateEgressPin(eg, res)) return;
            cfg.egressNodeId = eg;
        }
        const egressChanged = cfg.egressNodeId != priorEgress;

        auto user = req.context["user"].get!User;
        // Fiber lock: nick/realName track the services account when one has
        // been provisioned (a collision fallback may have renamed it, and the
        // SASL username must equal the nick), else the account username.
        if (cfg.host == DEFAULT_FIBER_HOST) {
            const managedNick = cfg.saslUsername.length ? cfg.saslUsername : user.username;
            cfg.nick = managedNick;
            cfg.realName = managedNick;
            cfg.port = DEFAULT_FIBER_PORT;
            cfg.tls = TLSMode.required;
            cfg.host = DEFAULT_FIBER_HOST;
        }
        auto serverId = updateOwnedNetwork(cfg, user.id, egressChanged, networkRepo, redis, serverRegistry);
        if (serverId.length == 0) {
            res.statusCode = 503;
            res.writeJsonBody(Json(["error": Json("No healthy connection servers available")]));
            return;
        }
        if (egressChanged)
            logInfo("Network %s egress changed '%s' → '%s' by %s — reconnect pushed to %s",
                cfg.id, priorEgress, cfg.egressNodeId, user.username, serverId);

        res.writeJsonBody(cfg.toJson());
    }

    private void deleteNetwork(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto id = parseUUID(req.params["id"]);
        auto user = req.context["user"].get!User;
        const info = networkRepo.findByIdWithUser(id);
        if (info.userId != UUID.init && info.userId != user.id) {
            res.statusCode = 403;
            res.writeJsonBody(Json(["error": Json("Not your network")]));
            return;
        }

        // Refuse to delete platform-provisioned networks. Admins can
        // still remove them via the admin tools which bypass this API.
        if (info.config.id != UUID.init && info.config.systemManaged) {
            res.statusCode = 403;
            res.writeJsonBody(Json([
                "error": Json("This network is provisioned by IRC Fiber and cannot be removed"),
                "systemManaged": Json(true)
            ]));
            return;
        }

        // One teardown, shared with account deletion and the bouncer's
        // DELNETWORK: engine socket, runtime state, document, caches,
        // replay cursors, attached bouncer clients. This route used to
        // leave the assignment and a `connected: true` snapshot behind,
        // which let a deleted network keep answering at
        // `/irc/<name>/channel/%23chan` (reported 2026-09-06).
        deleteOwnedNetwork(id, info.userId, networkRepo, redis, serverRegistry);
        res.writeJsonBody(Json(["status": Json("deleted")]));
    }

    // ── Bouncer (Settings → Bouncer) ─────────────────────────────────

    /// Public bouncer endpoint description plus the account's password,
    /// the networks it reaches and the caller's playback setting.
    private Json bouncerJson(User user) {
        import std.process : environment;
        import ircfiber.db.preferences : BNC_PLAYBACK_MAX;
        int playback = 0;
        try playback = prefsRepo.load(user.id).bncPlaybackLines; catch (Exception) {}
        const host = environment.get("IRCFIBER_BNC_PUBLIC_HOST", "");
        int port = 7000;
        try port = environment.get("IRCFIBER_BNC_PUBLIC_PORT", "7000").to!int;
        catch (Exception) {}
        const tlsFlag = environment.get("IRCFIBER_BNC_PUBLIC_TLS", "1") == "1";
        const token = userRepo.getBncToken(user.id);
        auto nets = Json.emptyArray;
        auto configs = networkRepo.findByUserId(user.id);
        string[] names;
        foreach (ref cfg; configs) names ~= cfg.name;
        const slugs = networkSlugs(names);
        foreach (i, ref cfg; configs) {
            nets ~= Json([
                "id": Json(cfg.id.toString()),
                "name": Json(cfg.name),
                "slug": Json(slugs[i]),
                "host": Json(cfg.host),
                "port": Json(cfg.port),
                "connected": Json(loadSnapshot(cfg.id.toString()).connected)
            ]);
        }
        return Json([
            "enabled": Json(host.length > 0),
            "host": Json(host),
            "port": Json(port),
            "tls": Json(tlsFlag),
            "username": Json(user.username),
            "password": token.length ? Json(token) : Json(null),
            "networks": nets,
            "playbackLines": Json(playback),
            "playbackMax": Json(BNC_PLAYBACK_MAX)
        ]);
    }

    /// POST /api/me/bnc-playback-lines {value:int} — lines per buffer the
    /// bouncer replays on attach for clients without CHATHISTORY (0 = none).
    private void updateBncPlaybackLines(HTTPServerRequest req, HTTPServerResponse res) {
        import ircfiber.db.preferences : clampBncPlaybackLines;
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;
        auto v = "value" in bodyJson;
        if (v is null || v.type != Json.Type.int_) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("value must be an integer")]));
            return;
        }
        const value = clampBncPlaybackLines(cast(int) v.get!long);
        auto prefs = prefsRepo.load(user.id);
        prefs.bncPlaybackLines = value;
        auto newVersion = prefsRepo.save(user.id, prefs);
        broadcastPrefUpdate(user.id.toString(), "bncPlaybackLines", Json(value), newVersion);
        res.writeJsonBody(Json(["value": Json(value)]));
    }

    /// Drops every attached bouncer client of the user and their replay
    /// cursors (the password they authenticated with is gone).
    private void dropBouncerClients(User user) {
        import ircfiber.bnc.control : publishBncRevoked;
        foreach (ref cfg; networkRepo.findByUserId(user.id))
            redis.del(RedisKeys.bncSeen(cfg.id.toString()));
        publishBncRevoked(redis, user.id.toString(), "");
    }

    /// 48 lowercase hex chars from the kernel CSPRNG.
    private static string generateBncToken() {
        import std.stdio : File;
        import std.digest : toHexString, LetterCase;
        auto buf = new ubyte[24];
        auto got = File("/dev/urandom", "rb").rawRead(buf);
        if (got.length != buf.length) throw new Exception("short read from /dev/urandom");
        return toHexString!(LetterCase.lower)(buf).idup;
    }

    /// GET /api/me/bouncer
    private void getBouncer(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        res.writeJsonBody(bouncerJson(req.context["user"].get!User));
    }

    /// POST /api/me/bouncer — (re)generate. Clients attached with the
    /// previous password are disconnected.
    private void generateBouncer(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        string token;
        try token = generateBncToken();
        catch (Exception e) {
            logError("bnc token generation failed: %s", e.msg);
            res.statusCode = 500;
            res.writeJsonBody(Json(["error": Json("token generation failed")]));
            return;
        }
        userRepo.setBncToken(user.id, token);
        dropBouncerClients(user);
        res.writeJsonBody(bouncerJson(user));
    }

    /// DELETE /api/me/bouncer
    private void revokeBouncer(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        userRepo.setBncToken(user.id, "");
        dropBouncerClients(user);
        res.statusCode = 204;
        res.writeVoidBody();
    }

    /**
     * GET /api/me/bouncer/clients — the caller's own attached bouncer
     * clients ("Active sessions" in Settings → Bouncer).
     *
     * Same presence records the admin bouncer page reads
     * (`irc:bnc:clients` + `irc:bnc:client:<sid>`, refreshed by the bnc
     * process every 15 s with a 60 s TTL), filtered to the caller's user
     * id. Never exposes other users' rows; the `sid` is included so the
     * owner can disconnect that session via the endpoint below.
     */
    private void getMyBouncerClients(HTTPServerRequest req, HTTPServerResponse res) {
        import std.algorithm : sort;
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        const uid = user.id.toString();
        auto arr = Json.emptyArray;
        if (redis !is null) {
            try {
                string[] sids;
                foreach (sid; redis.getDb().smembers(RedisKeys.bncClients())) sids ~= sid;
                struct Row { Json j; long attachedAt; }
                Row[] rows;
                foreach (sid; sids) {
                    Json j;
                    try j = redis.getJson(RedisKeys.bncClient(sid));
                    catch (Exception) continue;
                    if (j.type != Json.Type.object) continue;
                    if (j["userId"].type != Json.Type.string) continue;
                    if (j["userId"].get!string != uid) continue;
                    static string str(Json x, string k) {
                        return x[k].type == Json.Type.string ? x[k].get!string : "";
                    }
                    static long num(Json x, string k) {
                        if (x[k].type == Json.Type.int_) return x[k].get!long;
                        if (x[k].type == Json.Type.float_) return cast(long) x[k].get!double;
                        return 0;
                    }
                    auto o = Json.emptyObject;
                    o["sid"] = str(j, "sid");
                    o["networkId"] = str(j, "networkId");
                    o["networkName"] = str(j, "networkName");
                    o["clientId"] = str(j, "clientId");
                    o["nick"] = str(j, "nick");
                    o["peer"] = str(j, "peer");
                    o["tls"] = j["tls"].type == Json.Type.bool_ && j["tls"].get!bool;
                    o["caps"] = str(j, "caps");
                    o["attachedAt"] = num(j, "attachedAt");
                    o["lastRecvMs"] = num(j, "lastRecvMs");
                    o["lastSendMs"] = num(j, "lastSendMs");
                    o["linesIn"] = num(j, "linesIn");
                    o["linesOut"] = num(j, "linesOut");
                    o["cursor"] = num(j, "cursor");
                    if (!o["sid"].get!string.length) continue;
                    rows ~= Row(o, o["attachedAt"].get!long);
                }
                sort!((a, b) => a.attachedAt > b.attachedAt)(rows);
                foreach (ref r; rows) arr ~= r.j;
            } catch (Exception e) {
                logWarn("getMyBouncerClients: presence read failed for %s: %s", user.username, e.msg);
            }
        }
        auto out_ = Json.emptyObject;
        out_["clients"] = arr;
        out_["now"] = Clock.currTime.toUnixTime!long * 1000L;
        res.writeJsonBody(out_);
    }

    /**
     * POST /api/me/bouncer/clients/:sid/disconnect — drop one of the
     * caller's own attached clients ("Disconnect" in Settings → Bouncer).
     *
     * The presence record's `userId` must equal the caller, so a guessed
     * sid cannot reach someone else's session (unknown/other-owner sids
     * answer 404). Crosses to the bnc process via `publishBncKick`, the
     * same path as the admin kick; the client can reconnect immediately
     * with the same password.
     */
    private void disconnectMyBouncerClient(HTTPServerRequest req, HTTPServerResponse res) {
        import ircfiber.bnc.control : publishBncKick;
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        const uid = user.id.toString();
        const sid = req.params.get("sid", "");
        if (!sid.length) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("sid required")]));
            return;
        }
        if (redis is null) {
            res.statusCode = 503;
            res.writeJsonBody(Json(["error": Json("The bouncer store is unavailable")]));
            return;
        }
        Json j;
        try j = redis.getJson(RedisKeys.bncClient(sid));
        catch (Exception) {}
        if (j.type != Json.Type.object || j["userId"].type != Json.Type.string
                || j["userId"].get!string != uid) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("No attached client with that session id")]));
            return;
        }
        publishBncKick(redis, uid, sid, "Disconnected by user");
        logInfo("user %s disconnected bnc client sid=%s", user.username, sid);
        res.writeJsonBody(Json(["disconnected": Json(true), "sid": Json(sid)]));
    }

    private void disconnectNetwork(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto id = parseUUID(req.params["id"]);
        auto user = req.context["user"].get!User;

        // Disable manual disconnect for the platform-provisioned Fiber server.
        // The Fiber server must stay connected; admin toggle controls it.
        {
            auto cfgCheck = networkRepo.findById(id);
            if (cfgCheck.id != UUID.init && cfgCheck.host == "irc.ircfiber.com" && cfgCheck.systemManaged) {
                res.statusCode = 403;
                res.writeJsonBody(Json([
                    "error": Json("The IRC Fiber server cannot be disconnected"),
                    "systemManaged": Json(true)
                ]));
                return;
            }
        }

        // Optional QUIT reason in the JSON body. Empty by default — IRCCloud
        // uses an empty quit message so the server response reads "(Quit: )".
        string quitReason = "";
        try {
            auto body = req.json;
            if (body.type == Json.Type.object && body["reason"].type == Json.Type.string) {
                quitReason = body["reason"].get!string;
            }
        } catch (Exception) {
            // No body / not JSON — that's fine, default to empty reason.
        }

        // Route to the engine that owns this network, if one is alive.
        auto serverId = serverRegistry.getServerForNetwork(id.toString());
        const bool engineHealthy = serverId.length > 0 && serverRegistry.isServerHealthy(serverId);

        // Mark the network as disabled in MongoDB so the engine's bootstrap
        // loop skips it on restart (matching admin disconnect behavior).
        // Without this, any engine restart (deploy, handoff, crash) reloads
        // the network from MongoDB and auto-reconnects it, undoing the user's
        // explicit disconnect.  The reconnect REST API clears this flag.
        networkRepo.setDisabled(id, true);
        // Always update the Redis state snapshot immediately so the
        // frontend's next sync sees disconnected — otherwise the stale
        // 'connecting' snapshot survives until the engine processes the
        // control message, which can take seconds (Redis BLPOP latency +
        // backoff sleep), during which the frontend re-overwrites the
        // local disconnected state back to 'connecting'.
        //
        // Only publish a synthetic DISCONNECT event when there is NO live
        // engine to handle it. When an engine IS alive, it will emit its
        // own "You disconnected" event through the normal connection loop
        // exit path. Publishing both creates a duplicate in the frontend's
        // _server buffer — two identical "You disconnected" timeline items
        // with different eids that the eid-based dedup can't catch.
        if (engineHealthy) {
            updateDisconnectSnapshot(id, serverId);
        } else {
            markNetworkDisconnected(id, user.id, serverId);
        }

        // Always send the control message — even if the engine's heartbeat
        // is temporarily stale (e.g. draining handoff or transient lag), the
        // consumer loop still processes the queue asynchronously and will
        // pick up the disconnect.  Without this, the snapshot says
        // disconnected but the engine overwrites it back to connected=true
        // on the next heartbeat cycle.
        if (serverId.length > 0) {
            auto msg = ControlMessage("disconnectNetwork", id.toString());
            msg.reason = quitReason;
            msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
            redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
        }
        // The engine drops the client without an event on the user channel;
        // bouncer-networks clients still need to see the state flip.
        {
            import ircfiber.bnc.control : publishBncNetworkState;
            publishBncNetworkState(redis, user.id.toString(), id.toString(), "disconnected");
        }

        res.writeJsonBody(Json(["status": Json("disconnected")]));
    }

    /**
     * POST /api/networks/:id/buffers/clear
     *
     * Body: { "buffer": "<buffer name>" } (e.g. "_server" or "#channel").
     *
     * Hard-deletes the scrollback list and its paired dedup SET for that
     * buffer on the engine that owns the network. Powers the user-facing
     * "Clear backlog" context-menu action — the frontend's localStorage
     * `clearedAt` flag only hides old messages client-side (and is
     * reversible via "Load more backlog…"); this endpoint actually
     * scrubs the Redis scrollback.
     *
     * If the network isn't currently assigned to a server (cold / not
     * yet bootstrapped) the legacy non-namespaced key is scrubbed
     * instead. Idempotent: missing keys are a no-op.
     */
    private void clearNetworkBuffer(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto id = parseUUID(req.params["id"]);
        const cfg = networkRepo.findById(id);
        if (cfg.name.length == 0) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("Network not found")]));
            return;
        }

        // Owner check — must match the calling user. A compromised
        // cookie should not be able to wipe another user's scrollback
        // via id guessing, so the destructive endpoint is gated on the
        // owning userId looked up separately (NetworkConfig itself
        // doesn't carry userId).
        auto user = req.context["user"].get!User;
        const ownerInfo = networkRepo.findByIdWithUser(id);
        if (ownerInfo.userId != UUID.init && ownerInfo.userId != user.id) {
            res.statusCode = 403;
            res.writeJsonBody(Json(["error": Json("Not your network")]));
            return;
        }

        // Extract the buffer name from the JSON body ({"buffer":"_server"}).
        // Missing / malformed body → 400.
        string buffer = "";
        try {
            auto body = req.json;
            if (body.type == Json.Type.object && "buffer" in body
                && body["buffer"].type == Json.Type.string) {
                buffer = body["buffer"].get!string;
            }
        } catch (Exception) {
            // No body — fall through to 400 below.
        }
        if (buffer.length == 0) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("Missing `buffer` field")]));
            return;
        }

        // Look up the assigned engine so we scrub the right key namespace.
        // If none is assigned (cold network / single-server legacy mode)
        // the legacy overload handles it.
        auto serverId = serverRegistry.getServerForNetwork(id.toString());
        try {
            if (serverId.length > 0) {
                bufferManager.clearBuffer(serverId, id.toString(), buffer);
            } else {
                bufferManager.clearBuffer(id.toString(), buffer);
            }
        } catch (Exception e) {
            logError("clearNetworkBuffer: DEL failed for %s/%s: %s",
                id.toString(), buffer, e.msg);
            res.statusCode = 500;
            res.writeJsonBody(Json(["error": Json("Internal error clearing buffer")]));
            return;
        }

        // Also purge the MongoDB permanent store so the two-tier fallback
        // in getMessages doesn't re-surface deleted messages on page refresh.
        // If MongoDB delete fails, return 500 so the frontend keeps its
        // `clearedAt` filter active and the user has to retry. Previously
        // this was a silent swallow, which caused the bug where refreshing
        // and clicking "Load More Backlog..." re-surfaced old messages
        // from MongoDB even though Redis was cleared.
        if (serverId.length > 0) {
            try {
                auto mongoRepo = new MessageRepository();
                mongoRepo.deleteByChannel(serverId, id.toString(), buffer);
            } catch (Exception e) {
                logError("clearNetworkBuffer: MongoDB purge failed for %s/%s: %s — " ~
                    "returning 500 so frontend keeps clearedAt active",
                    id.toString(), buffer, e.msg);
                res.statusCode = 500;
                res.writeJsonBody(Json(["error": Json("MongoDB purge failed — buffer not fully cleared")]));
                return;
            }
        }
        // Legacy (single-server): serverId is empty so there is no
        // namespaced MongoDB data to delete — the old Redis-only
        // scrollback path never wrote to Mongo.

        logInfo("User %s cleared buffer %s on network %s (server=%s)",
            user.username, buffer, id.toString(),
            serverId.length ? serverId : "<legacy>");

        res.writeJsonBody(Json([
            "status": Json("cleared"),
            "buffer": Json(buffer),
            "serverId": Json(serverId)
        ]));
    }

    /// Mark a network as disconnected when no live engine can do it for us.
    /// Publishes a synthetic "You disconnected" event to the frontend.
    private void markNetworkDisconnected(UUID networkId, UUID userId, string assignedServerId) {
        auto cfg = networkRepo.findById(networkId);
        if (cfg.name.length == 0) return;
        auto nick = updateDisconnectSnapshot(networkId, assignedServerId, cfg);

        // Push a DISCONNECT event onto the user's pub/sub channel so any open
        // WebSocket immediately flips the UI from Disconnect -> Connect.
        auto evt = IRCRawEvent(cfg.name, "DISCONNECT");
        evt.networkId = networkId.toString();
        evt.channel = "_server";
        evt.nick = nick;
        evt.text = "You disconnected";

        auto json = evt.toCompactJson();
        json["y"] = "irc_event";
        if (assignedServerId.length > 0) json["serverId"] = assignedServerId;
        redis.publish(RedisKeys.events(userId.toString()), json.toString());

        logInfo("Disconnected network %s without engine (assigned=%s, nick=%s)",
            networkId.toString(), assignedServerId.length ? assignedServerId : "<none>", nick);
    }

    /// Update the Redis state snapshots to mark the network as disconnected.
    /// Does NOT publish a DISCONNECT event — use when a live engine will
    /// emit its own disconnect event through the normal connection loop.
    /// Returns the most recent currentNick seen in any snapshot.
    private string updateDisconnectSnapshot(UUID networkId, string assignedServerId,
        NetworkConfig cfg = NetworkConfig.init) {
        if (cfg.name.length == 0) {
            cfg = networkRepo.findById(networkId);
            if (cfg.name.length == 0) return "";
        }

        string[] candidateKeys;
        if (assignedServerId.length > 0)
            candidateKeys ~= RedisKeys.state(assignedServerId, networkId.toString());
        candidateKeys ~= RedisKeys.state_legacy(networkId.toString());

        string currentNick = cfg.nick;
        long mostRecentSnapshot = 0;

        foreach (key; candidateKeys) {
            const fields = redis.hgetAll(key);
            auto data = "data" in fields;
            if (data is null) continue;
            try {
                auto snap = NetworkStateSnapshot.fromJson(parseJsonString(*data));
                if (snap.currentNick.length > 0 && snap.updatedAt >= mostRecentSnapshot) {
                    currentNick = snap.currentNick;
                    mostRecentSnapshot = snap.updatedAt;
                }
                snap.connected = false;
                snap.status = "disconnected";
                snap.updatedAt = Clock.currTime.toUnixTime!long * 1000;
                redis.hset(key, "data", snap.toJson().toString());
            } catch (Exception e) {
                logWarn("Failed to update disconnect snapshot at %s: %s", key, e.msg);
            }
        }

        return currentNick;
    }

    private void reconnectNetwork(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto id = parseUUID(req.params["id"]);
        auto user = req.context["user"].get!User;
        auto cfg = networkRepo.findById(id);

        if (cfg.name.length == 0) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("Network not found")]));
            return;
        }

        // Clear any admin-disabled flag so this network will load on
        // future engine restarts. This lets a user re-enable a network
        // an admin had disconnected.
        if (cfg.disabled) {
            networkRepo.setDisabled(id, false);
            cfg.disabled = false;
            logInfo("Cleared disabled flag on network %s via user reconnect", id.toString());
        }

        // Route to assigned server (or reassign if server is unhealthy)
        auto serverId = serverRegistry.getServerForNetwork(id.toString());
        if (serverId.length == 0 || !serverRegistry.isServerHealthy(serverId)) {
            serverId = serverRegistry.reassignNetwork(id.toString());
            if (serverId.length == 0) {
                logError("Failed to reassign network %s — no healthy connection servers", id.toString());
                res.statusCode = 503;
                res.writeJsonBody(Json(["error": Json("No healthy servers available for reconnect")]));
                return;
            }
        }

        auto msg = ControlMessage("reconnectNetwork", id.toString(), user.id.toString(), cfg.toJson());
        msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
        redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());

        res.writeJsonBody(Json(["status": Json("reconnecting")]));
    }

    /// Validates an egress pin against the live slot/catalog view, writing the
    /// error response itself. Returns false when the request is finished.
    ///
    /// A pin that no slot currently serves needs a free slot to retarget:
    ///   - nothing retargetable here → 400, the location is not available;
    ///   - every slot busy → 409 naming the exits in use, so the user can
    ///     pick a location that is already running instead of silently
    ///     landing somewhere else.
    private bool validateEgressPin(string eg, HTTPServerResponse res) {
        // Bodies here exceed the ~120-byte chunked-JSON truncation limit of
        // vibe.d 0.10.3, so every one is written with Content-Length.
        void fail(int status, Json body_) {
            auto payload = body_.toString();
            res.statusCode = status;
            res.headers["Content-Type"] = "application/json; charset=utf-8";
            res.writeBody(cast(const(ubyte)[]) payload);
        }
        auto view = egressView(redis, serverRegistry);
        if (!isKnownEgressId(eg, view)) {
            fail(400, Json(["error": Json("Unknown egress: " ~ eg)]));
            return false;
        }
        if (eg.length == 0 || eg == DIRECT_EGRESS_ID) return true;
        if (matchingSlot(eg, view) !is null) return true;
        if (!view.controllable) {
            fail(400, Json(["error":
                Json("Location \"" ~ eg ~ "\" is not available on this server.")]));
            return false;
        }
        if (view.freeSlots == 0) {
            auto busy = Json.emptyArray;
            foreach (s; view.slots) {
                if (!s.controllable || s.activeConns == 0) continue;
                auto b = Json.emptyObject;
                b["label"] = Json(s.label);
                b["city"] = Json(s.city);
                b["country"] = Json(s.country);
                b["activeConns"] = Json(cast(long) s.activeConns);
                busy ~= b;
            }
            auto err = Json.emptyObject;
            err["error"] = Json("All " ~ view.slotCount.to!string ~ " exits are in use. "
                ~ "Pick a location that is already running, or free an exit first.");
            err["busy"] = busy;
            fail(409, err);
            return false;
        }
        return true;
    }

    /// GET /api/egress — routes a network can be pinned to, for the
    /// "Connect via" picker: the direct host IP, every exit slot with its
    /// current location and live connection count, and the full catalog of
    /// Mullvad cities an idle slot can be retargeted to. Slot identity comes
    /// from the engine; `exitIp`/`healthy` from a background SOCKS probe, so
    /// rows with `exitIp == ""` are simply not probed yet.
    private void getEgress(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto view = egressView(redis, serverRegistry);
        auto slots = Json.emptyArray;
        foreach (s; view.slots) {
            auto j = Json.emptyObject;
            j["serverId"] = Json(s.serverId);
            j["label"] = Json(s.label);
            j["host"] = Json(s.host);
            j["port"] = Json(cast(long) s.port);
            j["locationId"] = Json(s.locationId);
            j["hostname"] = Json(s.hostname);
            j["country"] = Json(s.country);
            j["countryCode"] = Json(s.countryCode);
            j["city"] = Json(s.city);
            j["controllable"] = Json(s.controllable);
            j["state"] = Json(s.state);
            j["activeConns"] = Json(cast(long) s.activeConns);
            j["heldUntilMs"] = Json(s.heldUntilMs);
            j["exitIp"] = Json(s.exitIp);
            j["healthy"] = Json(s.healthy);
            j["checkedAtMs"] = Json(s.checkedAtMs);
            j["error"] = Json(s.error);
            slots ~= j;
        }
        auto locations = Json.emptyArray;
        foreach (l; view.locations) {
            auto j = Json.emptyObject;
            j["id"] = Json(l.id);
            j["country"] = Json(l.country);
            j["countryCode"] = Json(l.countryCode);
            j["city"] = Json(l.city);
            j["relays"] = Json(cast(long) l.relays);
            locations ~= j;
        }
        auto out_ = Json.emptyObject;
        out_["direct"] = Json(DIRECT_EGRESS_ID);
        out_["controllable"] = Json(view.controllable);
        out_["slotCount"] = Json(cast(long) view.slotCount);
        out_["freeSlots"] = Json(cast(long) view.freeSlots);
        out_["slots"] = slots;
        out_["locations"] = locations;
        // vibe.d 0.10.3 truncates chunked JSON bodies at ~120 bytes
        // (JsonStringSerializer). Serialise once and write with
        // Content-Length — the catalog payload is far past that limit.
        auto payload = out_.toString();
        res.headers["Content-Type"] = "application/json; charset=utf-8";
        res.writeBody(cast(const(ubyte)[]) payload);
    }

    private void getMessages(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto networkId = parseUUID(req.params["network"]);
        auto channel = req.params["channel"];
        auto count = req.query.get("count", "50").to!long;
        long before = 0;
        long after = 0;
        if (auto b = "before" in req.query) {
            try { before = (*b).to!long; } catch (Exception e) {}
        }
        if (auto a = "after" in req.query) {
            try { after = (*a).to!long; } catch (Exception e) {}
        }

        string beforeMsgid = "";
        string afterMsgid = "";
        if (auto bm = "before_msgid" in req.query) {
            beforeMsgid = *bm;
        }
        if (auto am = "after_msgid" in req.query) {
            afterMsgid = *am;
        }

        // IRCCloud-style "beforeid" cursor: the eid of the oldest rendered
        // message. For infinite scrollback, this is always an eid (long),
        // never a string. Legacy msgid cursors are still accepted via
        // before_msgid for backward compatibility.
        long beforeEid = 0;
        if (auto bid = "beforeid" in req.query) {
            try { beforeEid = (*bid).to!long; } catch (Exception e) {}
        }

        // If beforeid didn't parse as a number, try as msgid string
        // (legacy path for messages without eid)
        if (beforeEid == 0 && ("beforeid" in req.query)) {
            beforeMsgid = req.query["beforeid"];
        }

        // Force a CHATHISTORY fetch on this call. Set by the frontend
        // after a /join or /reconnect so the first message load always
        // sees the upstream backfill. The gateway pushes a "chathistory"
        // command to the engine which issues LATEST/BEFORE on the wire.
        const bool triggerFetch = ("fetch" in req.query) && req.query["fetch"] == "1";
        // The frontend may also pass a ref msgid for explicit
        // pagination against the upstream, falling back to whatever's
        // already in the local buffer when not provided.
        string fetchCommand = "LATEST";
        string fetchRef = "";
        if (auto fc = "fetch_command" in req.query) {
            import std.uni : toUpper;
            fetchCommand = toUpper(*fc);
        }
        if (auto fr = "fetch_ref" in req.query) fetchRef = *fr;

        const cfg = networkRepo.findById(networkId);
        if (cfg.name.length == 0) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("Network not found")]));
            return;
        }

        // Get serverId for namespaced buffer lookup
        auto serverId = serverRegistry.getServerForNetwork(networkId.toString());

        // Fire the CHATHISTORY request to the engine before reading the
        // buffer. The engine handles it asynchronously — the BATCH
        // responses land in the same buffer we're about to read, so the
        // first read may see the freshly backfilled messages. If the
        // engine is slow or the cap isn't negotiated, we just return
        // whatever is in the local scrollback.
        if (triggerFetch && serverId.length > 0 && serverRegistry.isServerHealthy(serverId)) {
            try {
                // Build the chathistory command payload. The colon
                // delimiter lets us pack channel, command, ref msgid,
                // and limit into a single text field without extending
                // the protocol struct. See consumer.d's chathistory case.
                string payload = channel ~ ":" ~ fetchCommand ~ ":" ~ fetchRef ~ ":" ~ count.to!string;
                auto chCmd = IRCCommand("chathistory", "", payload);
                chCmd.timestampMs = Clock.currTime.toUnixTime!long * 1000;
                redis.lpush(RedisKeys.cmd(serverId, networkId.toString()), chCmd.toJson().toString());
            } catch (Exception e) {
                logWarn("Failed to enqueue chathistory command: %s", e.msg);
            }
        }

        // ── Two-tier lookup: Redis hot cache → MongoDB cold store ─────
        // IRCCloud keeps a small in-memory buffer and fetches older
        // history from the server. We do the same: Redis for the
        // recent cache, MongoDB for anything older. This is what makes
        // infinite scrollback possible.
        Json[] messages;
        if (serverId.length > 0) {
            // Decentralized: use server-namespaced buffer
            messages = bufferManager.getRecent(serverId, networkId.toString(),
                channel, count, before, after, beforeMsgid, afterMsgid);
        } else {
            // Legacy: non-namespaced buffer
            messages = bufferManager.getRecent(networkId.toString(),
                channel, count, before, after, beforeMsgid, afterMsgid);
        }

        // Fall through to MongoDB if Redis returned fewer than `count`
        // messages. This covers two cases:
        //   1. Cursor-based (beforeMsgid/before): Redis cache exhausted
        //   2. First load (no cursor): Redis is empty (e.g. engine
        //      never ran, or cold start), so read from the permanent
        //      store directly. This makes the scrollback work even
        //      when the engine isn't running.
        if (messages.length < count) {
            try {
                auto mongoRepo = new MessageRepository();
                Json[] older;
                if (beforeEid > 0) {
                    older = mongoRepo.getBeforeEid(serverId, networkId.toString(),
                        channel, beforeEid, before, cast(int)(count - messages.length));
                } else if (beforeMsgid.length > 0) {
                    older = mongoRepo.getBeforeMsgid(serverId, networkId.toString(),
                        channel, beforeMsgid, before, cast(int)(count - messages.length));
                } else if (before > 0) {
                    older = mongoRepo.getBeforeTimestamp(serverId,
                        networkId.toString(), channel, before,
                        cast(int)(count - messages.length));
                } else if (messages.length > 0) {
                    // Redis has SOME messages but fewer than `count`. The
                    // engine writes each event to BOTH Redis and MongoDB, so
                    // an unfiltered "newest N from Mongo" call would return
                    // every Redis message again — the user's #zod would show
                    // their own messages duplicated twice on refresh.
                    //
                    // Use the OLDEST Redis message's timestamp as the cursor
                    // so MongoDB returns strictly older messages only. The
                    // `$lt` filter handles the rare edge case where MongoDB
                    // has a message with the exact same timestamp.
                    long oldestTs = 0;
                    if (auto t = "t" in messages[0])
                        if (t.type == Json.Type.int_) oldestTs = t.get!long;
                    if (oldestTs > 0) {
                        older = mongoRepo.getBeforeTimestamp(serverId,
                            networkId.toString(), channel, oldestTs,
                            cast(int)(count - messages.length));
                    } else {
                        // Redis messages lack timestamps (legacy). Fall back to
                        // an unfiltered newest-N — then dedup against Redis by
                        // msgid so we don't return the same message twice.
                        older = mongoRepo.getBeforeTimestamp(serverId,
                            networkId.toString(), channel, 0, cast(int)count);
                    }
                } else {
                    // Cold start: Redis is empty, fetch newest N from Mongo.
                    older = mongoRepo.getBeforeTimestamp(serverId, networkId.toString(), channel, 0, cast(int)count);
                }
                if (older.length > 0) {
                    // Defensive dedup: even with the cursor above, MongoDB
                    // could contain messages with the same msgid that the
                    // Redis cursor missed (e.g. a write happened mid-fetch).
                    // Drop any MongoDB message whose msgid is already in
                    // Redis's set so the frontend never renders duplicates.
                    auto dedupedOlder = RESTAPI.dedupMessages(messages, older);
                    if (dedupedOlder.length > 0) {
                        // Prepend older messages (newest at end of `older`)
                        messages = dedupedOlder ~ messages;
                    }
                }
            } catch (Exception e) {
                logWarn("MongoDB fall-through failed: %s", e.msg);
            }
        }

        // Wildcard fallback for decentralized history
        if (messages.length < count) {
            try {
                auto mongoRepoAny = new MessageRepository();
                Json[] olderAny;
                // MUST respect the pagination cursor — previously this
                // always fetched with beforeTs=0, which returned the whole
                // channel on EVERY "load more" call. That made the frontend
                // believe more history existed forever (the cursor never
                // advanced), so a fully-loaded buffer like #welcome kept
                // showing a lying "Load more backlog…" button that refetched
                // the same messages.
                if (beforeEid > 0) {
                    olderAny = mongoRepoAny.getBeforeEid("",
                        networkId.toString(), channel, beforeEid, before,
                        cast(int)(count - messages.length));
                } else if (beforeMsgid.length > 0) {
                    olderAny = mongoRepoAny.getBeforeMsgid("",
                        networkId.toString(), channel, beforeMsgid, before,
                        cast(int)(count - messages.length));
                } else if (before > 0) {
                    olderAny = mongoRepoAny.getBeforeTimestamp("",
                        networkId.toString(), channel, before,
                        cast(int)(count - messages.length));
                }
                if (olderAny.length > 0) {
                    auto dedupedAny = RESTAPI.dedupMessages(messages, olderAny);
                    if (dedupedAny.length > 0) messages = dedupedAny ~ messages;
                }
            } catch (Exception e) {
                logWarn("MongoDB wildcard fall-through failed: %s", e.msg);
            }
        }

        // Surface total backlog size so the frontend can show "X total
        // messages" and decide when the user has reached the very
        // beginning. This is IRCCloud's `backlog_size` field.
        long backlogSize = 0;
        try {
            auto mongoRepo = new MessageRepository();
            backlogSize = mongoRepo.count(serverId, networkId.toString(), channel);
        } catch (Exception e) {
            logDebug("MongoDB count failed: %s", e.msg);
        }

        res.headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
        // Wrap the response in an envelope so we can include metadata
        // alongside the messages. The frontend reads `messages` for the
        // list and `backlog_size` / `earliest_msgid` for pagination.
        //
        // Strip scrollback noise (WHO 315 / NAMES 353 / TAGMSG / …) that
        // the chat UI cannot render. The Redis reader already skips it;
        // this second pass covers the MongoDB fall-through so a
        // noise-heavy channel's window fills with the real conversation
        // instead of a wall of invisible "End of WHO list" rows that
        // push PRIVMSGs out of view. The _server log is exempt — its
        // timeline renders numerics/MOTD.
        if (channel != "_server") {
            Json[] clean;
            clean.reserve(messages.length);
            foreach (m; messages) {
                string cmd = "";
                if ("c" in m) {
                    try { cmd = m["c"].get!string; } catch (Exception) {}
                } else if ("command" in m) {
                    try { cmd = m["command"].get!string; } catch (Exception) {}
                }
                if (!BufferManager.isScrollbackNoiseCommand(cmd))
                    clean ~= m;
            }
            messages = clean;
        }
        Json[] msgsArr;
        foreach (m; messages) msgsArr ~= m;

        // Find the OLDEST message's identifiers in the returned set —
        // this becomes the cursor for the next "load more" request.
        // msgsArr is ordered OLDEST-FIRST (oldest at index 0, newest
        // at the end). The cursor for the NEXT page is the OLDEST
        // message in this page, so the next request returns messages
        // even older than this page's boundary.
        // eid is the primary cursor (IRCCloud-style); msgid and ts
        // are fallbacks for legacy messages without eid.
        string earliestMsgid = "";
        long earliestTs = 0;
        long earliestEid = 0;
        if (msgsArr.length > 0) {
            const first = msgsArr[0];
            if (auto e = "eid" in first) {
                if (e.type == Json.Type.int_) earliestEid = e.get!long;
            }
            if (auto m = "m" in first) {
                if (m.type == Json.Type.string) earliestMsgid = m.get!string;
            }
            if (auto t = "t" in first) {
                if (t.type == Json.Type.int_) {
                    earliestTs = t.get!long;
                }
            }
        }

        Json envelope = Json([
            "messages": Json(msgsArr),
            "backlog_size": Json(backlogSize),
            "earliest_msgid": Json(earliestMsgid),
            "earliest_ts": Json(earliestTs),
            "earliest_eid": Json(earliestEid),
            "cache_size": Json(cast(long)msgsArr.length)
        ]);
        res.writeJsonBody(envelope);
    }

    private void joinChannel(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto nid = parseUUID(req.params["network"]);
        auto bodyJson = req.json;
        auto chan = bodyJson["channel"].get!string;
        const user = req.context["user"].get!User;
        auto c = IRCCommand("join", chan, "");
        c.timestampMs = Clock.currTime.toUnixTime!long * 1000;
        
        withSpan("http.join_channel", ["http.route": "/api/networks/:network/join", "channel": chan, "network": nid.toString()], (ref Span s) {
            s.attr("user.id", user.id.toString());
            // NEW: Route to assigned server
            auto serverId = serverRegistry.getServerForNetwork(nid.toString());
            if (serverId.length > 0) {
                redis.lpush(RedisKeys.cmd(serverId, nid.toString()), c.toJson().toString());
            } else {
                redis.lpush(RedisKeys.cmd_legacy(nid.toString()), c.toJson().toString());
            }
            logJsonMap("info", "api", "POST /api/networks/:network/join", [
                "channel": chan,
                "network": nid.toString(),
                "user": user.id.toString(),
                "serverId": serverId
            ]);
            s.setStatusOk();
        });
        
        res.writeJsonBody(Json(["status": Json("ok")]));
    }

    /**
     * GET /api/oob?network=<id>&since=<eid>&count=<n>
     *
     * Out-of-band event fetch. The frontend calls this when it
     * detects a hole in the live eid stream (e.g. the WS silently
     * dropped a frame, or the page was hidden while events flowed).
     * Returns up to `count` events with eid > `since` across all
     * channels of the network, oldest first.
     *
     * This is the recovery path that makes the WS "best-effort
     * delivery" — the MongoDB scrollback is the source of truth, and
     * /api/oob lets the client fetch from it without a full
     * reconnect/replay.
     */
    private void getOOBEvents(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        const user = req.context["user"].get!User;

        // network: required (the network the client was on when it
        // detected the gap — we fetch across all its channels)
        auto networkIdStr = req.query.get("network", "");
        if (networkIdStr.length == 0) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("missing 'network' query param")]));
            return;
        }
        auto networkId = parseUUID(networkIdStr);

        // since: required (the highest eid the client has)
        long since = 0;
        if (auto s = "since" in req.query) {
            try { since = (*s).to!long; }
            catch (Exception e) {
                res.statusCode = 400;
                res.writeJsonBody(Json(["error": Json("invalid 'since' param")]));
                return;
            }
        }

        // count: default 100, cap at 1000
        int count = 100;
        if (auto c = "count" in req.query) {
            try {
                count = cast(int)(*c).to!long;
                if (count <= 0) count = 100;
                if (count > 1000) count = 1000;
            } catch (Exception) {}
        }

        // Look up the network config to validate ownership + get the
        // assigned serverId. (Required for the namespaced Mongo query.)
        const found = networkRepo.findByIdWithUser(networkId);
        if (found.config.name.length == 0) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("network not found")]));
            return;
        }
        if (found.userId != user.id) {
            res.statusCode = 403;
            res.writeJsonBody(Json(["error": Json("not your network")]));
            return;
        }

        auto serverId = serverRegistry.getServerForNetwork(networkIdStr);
        if (serverId.length == 0) {
            // Network isn't currently assigned to any engine — try the
            // legacy namespacing. The legacy lookup uses networkId as
            // serverId; messages written before the server-aware
            // refactor are stored there.
            serverId = networkIdStr;
        }

        try {
            auto mongoRepo = new MessageRepository();
            auto events = mongoRepo.getAfterEidForNetwork(
                serverId, networkIdStr, since, count);
            res.headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
            res.writeJsonBody(Json([
                "events": Json(events),
                "count": Json(cast(int)events.length),
                "since": Json(since)
            ]));
        } catch (Exception e) {
            logError("getOOBEvents: %s", e.msg);
            res.statusCode = 500;
            res.writeJsonBody(Json(["error": Json("OOB fetch failed"), "detail": Json(e.msg)]));
        }
    }

    private void partChannel(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto nid = parseUUID(req.params["network"]);
        auto bodyJson = req.json;
        auto c = IRCCommand("part", bodyJson["channel"].get!string, "");
        c.timestampMs = Clock.currTime.toUnixTime!long * 1000;

        // NEW: Route to assigned server
        auto serverId = serverRegistry.getServerForNetwork(nid.toString());
        if (serverId.length > 0) {
            redis.lpush(RedisKeys.cmd(serverId, nid.toString()), c.toJson().toString());
        } else {
            redis.lpush(RedisKeys.cmd_legacy(nid.toString()), c.toJson().toString());
        }
        
        res.writeJsonBody(Json(["status": Json("ok")]));
    }
    private void getMe(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto prefs = prefsRepo.load(user.id);
        auto mc = Json.emptyObject;
        foreach (k, v; prefs.membersCollapsed)
            mc[k] = Json(v);
        auto col = Json.emptyObject;
        foreach (k, v; prefs.collapsed)
            col[k] = Json(v);
        auto ic = Json.emptyObject;
        foreach (k, v; prefs.inactiveCollapsed)
            ic[k] = Json(v);
        auto bp = Json.emptyObject;
        foreach (k, v; prefs.bufferPrefs)
            bp[k] = v;
        res.writeJsonBody(Json([
            "id": Json(user.id.toString()),
            "username": Json(user.username),
            "email": Json(user.email),
            "pinnedChannels": serializeToJson(prefs.pinnedChannels),
            "archivedChannels": serializeToJson(prefs.archivedChannels),
            "membersCollapsed": mc,
            "collapsed": col,
            "inactiveCollapsed": ic,
            "networkOrder": serializeToJson(prefs.networkOrder),
            "ignores": serializeToJson(prefs.ignores),
            "bufferPrefs": bp,
            "showMemberPrefixes": Json(prefs.showMemberPrefixes),
            "bncPlaybackLines": Json(prefs.bncPlaybackLines),
            "desktopNotifications": Json(prefs.desktopNotifications),
            "notificationSound": Json(prefs.notificationSound),
            "autoDismissNotifs": Json(prefs.autoDismissNotifs),
            "muteAll": Json(prefs.muteAll),
            // Monotonic counter incremented by every prefsRepo.save().
            // Lets the frontend decide whether to trust this stat_user
            // payload or skip the merge in favour of its locally-tracked
            // state. See docs/PREF_VERSION.md.
            "prefVersion": Json(prefs.prefVersion)
        ]));
    }

    /**
     * GET /api/me/sessions — the caller's own login sessions, each with the
     * live WebSocket clients it opened nested underneath (Settings →
     * Sessions, modelled on IRCCloud's login-sessions table).
     *
     * Reads the same `session:<id>` Redis hashes as the admin sessions page
     * but filtered to `sessionUserId == caller`; the admin route
     * (`/api/admin/sessions`) deliberately does not filter, so it cannot be
     * reused here.
     *
     * Session ids never leave the server — the id IS the cookie value, so
     * rows are keyed by the opaque `ref` from `ircfiber.web.sessions_view`.
     * `?client=<ws session id>` is the caller's own WebSocket session id,
     * handed to it in the `header` frame, and marks the "Current" client.
     */
    private void getMySessions(HTTPServerRequest req, HTTPServerResponse res) {
        import ircfiber.storage.session : RedisSessionStore;
        import ircfiber.web.admin.helpers : stripJsonStr, parseLongField;
        import ircfiber.web.sessions_view : LoginSessionRow, LoginClientRow,
            loginSessionsJson;

        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        const uid = user.id.toString();
        const currentSid = req.session ? req.session.id : "";
        const currentClient = req.query.get("client", "");

        LoginSessionRow[] rows;
        // Only reached with a live `redis` — `ownedSessions` is empty without one.
        auto store = new RedisSessionStore(redis);
        foreach (sid, fields; ownedSessions(user)) {
            LoginSessionRow row;
            row.sessionId = sid;
            if (auto p = "clientIp" in fields) row.clientIp = stripJsonStr(*p);
            if (auto p = "userAgent" in fields) row.userAgent = stripJsonStr(*p);
            if (auto p = "createdAt" in fields) row.createdAtMs = parseLongField(*p);
            if (auto p = "lastAccess" in fields) row.lastAccessMs = parseLongField(*p);
            row.ttlSeconds = store.sessionTtl(sid);
            row.current = currentSid.length > 0 && sid == currentSid;
            rows ~= row;
        }

        LoginClientRow[] clients;
        if (sessionManager !is null) {
            foreach (ref c; sessionManager.clientsForUser(user.id)) {
                LoginClientRow lc;
                lc.wsSessionId = c.id.toString();
                lc.webSessionId = c.webSessionId;
                lc.connectedAtMs = c.connectedAt.toUnixTime!long * 1000L;
                lc.clientIp = c.clientIp;
                lc.userAgent = c.userAgent;
                lc.current = currentClient.length > 0 && lc.wsSessionId == currentClient;
                clients ~= lc;
            }
        }

        res.writeJsonBody(loginSessionsJson(rows, clients,
            Clock.currTime.toUnixTime!long * 1000L));
    }

    /// The login sessions `user` owns, keyed by session id, with the raw
    /// (still JSON-quoted) hash fields. One `KEYS session:*` + HGETALL per
    /// key, the same scan the admin sessions page runs; both the listing and
    /// the revoke path go through here so neither can forget the ownership
    /// filter.
    private string[string][string] ownedSessions(User user) {
        import ircfiber.storage.session : RedisSessionStore;
        import ircfiber.web.admin.helpers : stripJsonStr;

        string[string][string] owned;
        if (redis is null) return owned;
        const uid = user.id.toString();
        try {
            auto store = new RedisSessionStore(redis);
            foreach (sid; store.listAllSessionIds()) {
                // Not `const`: `getSessionFields` documents that the caller
                // owns the returned AA, and on the release toolchain
                // `const(string[string]).dup` yields `const(string)[string]`,
                // which will not convert back to `string[string]`.
                auto fields = store.getSessionFields(sid);
                if (fields is null) continue;
                auto uidPtr = "sessionUserId" in fields;
                if (!uidPtr || stripJsonStr(*uidPtr) != uid) continue;
                owned[sid] = fields;
            }
        } catch (Exception e) {
            logWarn("ownedSessions: session read failed for %s: %s", user.username, e.msg);
        }
        return owned;
    }

    /**
     * DELETE /api/me/sessions/:ref — sign one of the caller's other browsers
     * out ("Revoke" in Settings → Sessions).
     *
     * `:ref` is the opaque handle from the listing; it is resolved against
     * the caller's own session ids only (`sessionIdForRef`), so a guessed or
     * borrowed ref cannot reach someone else's login and no real session id
     * has to travel to the browser.
     *
     * The current session is refused (409) — "sign out" is the button for
     * that, and killing your own cookie mid-request would leave the page
     * half-authenticated. Live sockets of the revoked login are cut, because
     * a WebSocket authenticates once at the handshake and would otherwise
     * outlive the login it was opened with.
     */
    private void revokeMySession(HTTPServerRequest req, HTTPServerResponse res) {
        import ircfiber.storage.session : RedisSessionStore;
        import ircfiber.web.sessions_view : sessionIdForRef;

        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;

        const ref_ = req.params.get("ref", "");
        if (redis is null) {
            res.statusCode = 503;
            res.writeJsonBody(Json(["error": Json("The session store is unavailable")]));
            return;
        }

        auto owned = ownedSessions(user);
        const target = sessionIdForRef(owned.keys, ref_);
        if (target.length == 0) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("That session no longer exists")]));
            return;
        }
        if (req.session && target == req.session.id) {
            res.statusCode = 409;
            res.writeJsonBody(Json([
                "error": Json("This is the browser you are using — sign out to end it")
            ]));
            return;
        }

        size_t clients;
        try {
            (new RedisSessionStore(redis)).destroy(target);
            if (sessionManager !is null)
                clients = sessionManager.dropClientsForWebSession(target);
        } catch (Exception e) {
            logWarn("revokeMySession: %s failed to revoke a session: %s", user.username, e.msg);
            res.statusCode = 500;
            res.writeJsonBody(Json(["error": Json("Could not revoke that session")]));
            return;
        }
        logInfo("user %s revoked login session %s (%s live client(s) dropped)",
            user.username, ref_, clients);
        res.writeJsonBody(Json([
            "revoked": Json(true),
            "clientsDropped": Json(cast(long) clients)
        ]));
    }

    /**
     * DELETE /api/me — the owner erases their own account ("Delete my
     * account" in Settings → Danger zone).
     *
     * The button was calling this route since it shipped; the route did not
     * exist, so every attempt answered 404 and the SPA showed "Delete
     * account failed". It runs exactly the purge the admin path runs
     * (`ircfiber.account_deletion`) — networks disconnected and deleted,
     * engine state and assignments dropped, buffers, prefs, sessions and
     * uploaded files removed, and the NickServ account we registered for
     * them dropped — so self-deletion can never leave state behind that an
     * admin deletion would have cleaned.
     *
     * The sole remaining admin is refused: a self-delete there locks
     * everybody out of /admin with no way back in. Same guard the admin
     * bulk-delete applies.
     */
    private void deleteMe(HTTPServerRequest req, HTTPServerResponse res) {
        import std.algorithm : canFind;
        import ircfiber.account_deletion : purgeUserAccount;
        import ircfiber.db.user : UserRepository;

        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;

        if (user.roles.canFind("admin")) {
            auto userRepo = new UserRepository();
            int admins;
            try {
                foreach (u; userRepo.findAll(userRepo.count() + 50, 0))
                    if (u.roles.canFind("admin")) admins++;
            } catch (Exception e) {
                logWarn("deleteMe: counting admins failed: %s", e.msg);
                res.statusCode = 502;
                res.writeJsonBody(Json(["error": Json("Could not verify administrator count")]));
                return;
            }
            if (admins <= 1) {
                res.statusCode = 409;
                res.writeJsonBody(Json(["error":
                    Json("You are the only administrator. Grant admin to another account first, "
                         ~ "or delete this one from the admin panel.")]));
                return;
            }
        }

        logWarn("User %s (%s) requested deletion of their own account",
                user.username, user.id.toString());
        try purgeUserAccount(user, redis, serverRegistry);
        catch (Exception e) {
            // The account still exists, so say so instead of logging the user
            // out of something that was not deleted.
            logError("deleteMe: purging %s failed: %s", user.username, e.msg);
            res.statusCode = 500;
            res.writeJsonBody(Json(["error":
                Json("Deleting your account failed: " ~ e.msg)]));
            return;
        }

        // `purgeUserAccount` already destroyed every session this user held,
        // including the one that made this request.
        res.writeJsonBody(Json([
            "deleted": Json(true),
            "username": Json(user.username)
        ]));
    }
    /**
     * POST /api/me/password — the owner changes their own password
     * ("Change password" in Settings → Account).
     *
     * The Account panel was calling this route since it shipped; the route
     * did not exist, so every attempt answered 404. Verifies the current
     * password, then stores a fresh `ircfiber.auth` hash via the existing
     * `userRepo` — same 8-char minimum the register/reset/invite-accept
     * paths enforce, same `{error: string}` body shape as `deleteMe`.
     */
    private void changeMyPassword(HTTPServerRequest req, HTTPServerResponse res) {
        import ircfiber.auth : hashPassword, verifyPassword;
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        string oldPassword, newPassword;
        try {
            auto bodyJson = req.json;
            oldPassword = bodyJson["oldPassword"].opt!string("");
            newPassword = bodyJson["newPassword"].opt!string("");
        } catch (Exception) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("Invalid request.")]));
            return;
        }
        if (!oldPassword.length || !newPassword.length) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("Please fill in all fields.")]));
            return;
        }
        if (newPassword.length < 8) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("Password must be at least 8 characters.")]));
            return;
        }
        if (!verifyPassword(oldPassword, user.passwordHash)) {
            res.statusCode = 401;
            res.writeJsonBody(Json(["error": Json("Current password is incorrect.")]));
            return;
        }
        user.passwordHash = hashPassword(newPassword);
        try userRepo.update(user);
        catch (Exception e) {
            logWarn("changeMyPassword: saving new hash for %s failed: %s", user.username, e.msg);
            res.statusCode = 500;
            res.writeJsonBody(Json(["error": Json("Could not save the new password.")]));
            return;
        }
        res.writeJsonBody(Json(["changed": Json(true)]));
    }

    /// GET /api/me/irc-account — the NickServ account this website account
    /// owns on irc.ircfiber.com plus the password the gateway generated for
    /// it (`ircfiber.services.accounts`), so the user can manage the account
    /// or sign in with a third-party client. Read-only: the credential is
    /// only ever minted by the provisioner.
    ///
    /// `status`: ready | pending (in flight, will retry) | unavailable
    /// (provisioning gave up; `reason` says why, retry via the POST below) |
    /// none (no IRC Fiber network).
    private void getIrcAccount(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        NetworkConfig fiber;
        bool found = false;
        foreach (ref cfg; networkRepo.findByUserId(user.id)) {
            if (cfg.host == DEFAULT_FIBER_HOST) {
                fiber = cfg;
                found = true;
                break;
            }
        }
        // The response carries a live credential: never let a shared cache,
        // proxy or the browser's back/forward cache retain it.
        res.headers["Cache-Control"] = "no-store, max-age=0";
        res.headers["Pragma"] = "no-cache";


        string status = "none";
        if (found)
            status = (fiber.sasl == SASLMechanism.plain
                      && fiber.saslUsername.length
                      && fiber.saslPassword.length) ? "ready" : "pending";

        // A skip key means the provisioner stopped trying for 24h, so
        // "pending" would be a lie — surface the reason instead.
        string reason;
        if (status == "pending") {
            try {
                reason = redis.getDb().get(servicesSkipKey(user.id.toString()));
                if (reason.length) status = "unavailable";
            } catch (Exception e) {
                logWarn("irc-account: reading skip key for %s failed: %s", user.username, e.msg);
            }
        }

        const ready = status == "ready";
        res.writeJsonBody(Json([
            "status": Json(status),
            "reason": Json(reason),
            "account": Json(ready ? fiber.saslUsername : ""),
            "password": Json(ready ? fiber.saslPassword : ""),
            "host": Json(DEFAULT_FIBER_HOST),
            "port": Json(cast(int) DEFAULT_FIBER_PORT),
            "network": Json(found && fiber.name.length ? fiber.name : "IRC Fiber")
        ]));
    }

    /// POST /api/me/irc-account/retry — clear the 24h give-up marker and run
    /// provisioning again. Self-service for the case where the nick that
    /// blocked registration has since been released. Rate-limited to one
    /// attempt per minute per user.
    private void retryIrcAccount(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        const userId = user.id.toString();
        auto db = redis.getDb();
        const throttleKey = "irc:services:retry:" ~ userId;
        // The read-back must compare a value only this request could have
        // written: SET NX with a constant looks identical whether we won or
        // lost the race, which silently disables the throttle.
        const token = randomUUID().toString();
        try {
            db.request!string("SET", throttleKey, token, "NX", "EX", "60");
            if (db.get(throttleKey) != token) {
                res.statusCode = 429;
                res.writeJsonBody(Json(["error": Json("Please wait a minute before retrying.")]));
                return;
            }
        } catch (Exception e) {
            logWarn("irc-account: retry throttle for %s failed: %s", user.username, e.msg);
        }

        try db.del(servicesSkipKey(userId));
        catch (Exception e) {
            logWarn("irc-account: clearing skip key for %s failed: %s", user.username, e.msg);
            res.statusCode = 503;
            res.writeJsonBody(Json(["error": Json("Could not start a retry. Try again shortly.")]));
            return;
        }
        provisionServicesAccountAsync(user, redis);
        logInfo("irc-account: user %s requested a NickServ provisioning retry", user.username);
        res.statusCode = 202;
        res.writeJsonBody(Json(["status": Json("retrying")]));
    }

    private void pinChannel(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;
        const network = bodyJson["network"].get!string;
        const channel = bodyJson["channel"].get!string;
        const pinId = network ~ ":" ~ channel;

        auto prefs = prefsRepo.load(user.id);
        long newVersion = 0;
        if (!prefs.pinnedChannels.canFind(pinId)) {
            prefs.pinnedChannels ~= pinId;
            newVersion = prefsRepo.save(user.id, prefs);
        } else {
            // No mutation this request — surface the current prefVersion
            // so other tabs see a consistent counter in the broadcast.
            newVersion = prefs.prefVersion;
        }
        // Broadcast pref update to all connected WebSocket clients for this user
        broadcastPrefUpdate(user.id.toString(), "pinned", serializeToJson(prefs.pinnedChannels), newVersion);
        res.statusCode = 204;
        res.writeVoidBody();
    }

    private void unpinChannel(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        const network = req.params["network"];
        const channel = req.params["channel"];
        const pinId = network ~ ":" ~ channel;

        auto prefs = prefsRepo.load(user.id);
        prefs.pinnedChannels = prefs.pinnedChannels.filter!(p => p != pinId).array;
        auto newVersion = prefsRepo.save(user.id, prefs);

        // Broadcast pref update to all connected WebSocket clients for this user
        broadcastPrefUpdate(user.id.toString(), "pinned", serializeToJson(prefs.pinnedChannels), newVersion);
        res.statusCode = 204;
        res.writeVoidBody();
    }

    private void archiveChannel(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;
        const network = bodyJson["network"].get!string;
        const channel = bodyJson["channel"].get!string;
        const archiveId = network ~ ":" ~ channel;

        auto prefs = prefsRepo.load(user.id);
        long newVersion = 0;
        if (!prefs.archivedChannels.canFind(archiveId)) {
            prefs.archivedChannels ~= archiveId;
            newVersion = prefsRepo.save(user.id, prefs);
        } else {
            newVersion = prefs.prefVersion;
        }
        // Broadcast pref update to all connected WebSocket clients for this user
        broadcastPrefUpdate(user.id.toString(), "archived", serializeToJson(prefs.archivedChannels), newVersion);
        // Invalidate archive-names cache so subsequent fetches see the change
        redis.del(RedisKeys.archiveNames(user.id.toString()));
        res.statusCode = 204;
        res.writeVoidBody();
    }

    private void unarchiveChannel(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        const network = req.params["network"];
        const channel = req.params["channel"];
        const archiveId = network ~ ":" ~ channel;

        auto prefs = prefsRepo.load(user.id);
        prefs.archivedChannels = prefs.archivedChannels.filter!(a => a != archiveId).array;
        auto newVersion = prefsRepo.save(user.id, prefs);

        // Broadcast pref update to all connected WebSocket clients for this user
        broadcastPrefUpdate(user.id.toString(), "archived", serializeToJson(prefs.archivedChannels), newVersion);
        // Invalidate archive-names cache so subsequent fetches see the change
        redis.del(RedisKeys.archiveNames(user.id.toString()));
        res.statusCode = 204;
        res.writeVoidBody();
    }

    private void updateMembersCollapsed(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;
        const network = bodyJson["network"].get!string;
        const channel = bodyJson["channel"].get!string;
        const collapsed = bodyJson["collapsed"].get!bool;
        const key = network ~ ":" ~ channel;

        auto prefs = prefsRepo.load(user.id);
        if (collapsed) {
            prefs.membersCollapsed[key] = true;
        } else {
            prefs.membersCollapsed.remove(key);
        }
        auto newVersion = prefsRepo.save(user.id, prefs);

        // Broadcast to all connected sessions for this user
        auto json = Json.emptyObject;
        json["type"] = Json("pref_update");
        json["key"] = Json("membersCollapsed");
        json["prefVersion"] = Json(newVersion);
        auto mc = Json.emptyObject;
        foreach (k, v; prefs.membersCollapsed)
            mc[k] = Json(v);
        json["value"] = mc;
        redis.publish(RedisKeys.events(user.id.toString()), json.toString());

        res.statusCode = 204;
        res.writeVoidBody();
    }

    /// Conversations-header collapse persistence. Same pattern as
    /// membersCollapsed — keyed by networkId so collapses survive
    /// reconnection cycles deterministically. Broadcast via pref_update
    /// to all connected sessions in real time.
    private void updateConversationsCollapsed(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;
        const network = bodyJson["network"].get!string;
        const collapsed = bodyJson["collapsed"].get!bool;

        auto prefs = prefsRepo.load(user.id);
        if (collapsed) {
            prefs.conversationsCollapsed[network] = true;
        } else {
            prefs.conversationsCollapsed.remove(network);
        }
        auto newVersion = prefsRepo.save(user.id, prefs);

        // Broadcast to all connected sessions for this user
        auto json = Json.emptyObject;
        json["type"] = Json("pref_update");
        json["key"] = Json("conversationsCollapsed");
        json["prefVersion"] = Json(newVersion);
        auto cc = Json.emptyObject;
        foreach (k, v; prefs.conversationsCollapsed)
            cc[k] = Json(v);
        json["value"] = cc;
        redis.publish(RedisKeys.events(user.id.toString()), json.toString());

        res.statusCode = 204;
        res.writeVoidBody();
    }

    private void updateBufferPrefs(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;
        const network = bodyJson["network"].get!string;
        const channel = bodyJson["channel"].get!string;
        const key = network ~ ":" ~ channel;
        auto prefs = prefsRepo.load(user.id);

        // Merge the incoming prefs object into the buffer's existing prefs
        Json bufferPref;
        if (key in prefs.bufferPrefs) {
            bufferPref = prefs.bufferPrefs[key];
        } else {
            bufferPref = Json.emptyObject;
        }

        if (auto bp = "prefs" in bodyJson) {
            if (bp.type == Json.Type.object) {
                foreach (string k, v; *bp)
                    bufferPref[k] = v;
            }
        }

        // Remove key if prefs object is empty
        if (bufferPref.type == Json.Type.object) {
            string[] keys;
            foreach (string k, _; bufferPref) keys ~= k;
            if (keys.length == 0) {
                prefs.bufferPrefs.remove(key);
            } else {
                prefs.bufferPrefs[key] = bufferPref;
            }
        } else {
            prefs.bufferPrefs[key] = bufferPref;
        }

        auto newVersion = prefsRepo.save(user.id, prefs);

        // Broadcast full bufferPrefs map to all connected sessions
        auto json = Json.emptyObject;
        json["type"] = Json("pref_update");
        json["key"] = Json("bufferPrefs");
        json["prefVersion"] = Json(newVersion);
        auto bpMap = Json.emptyObject;
        foreach (k, v; prefs.bufferPrefs)
            bpMap[k] = v;
        json["value"] = bpMap;
        redis.publish(RedisKeys.events(user.id.toString()), json.toString());

        res.statusCode = 204;
        res.writeVoidBody();
    }

    private void updateCollapsed(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;
        const network = bodyJson["network"].get!string;
        const collapsed = bodyJson["collapsed"].get!bool;

        auto prefs = prefsRepo.load(user.id);
        if (collapsed) {
            prefs.collapsed[network] = true;
        } else {
            prefs.collapsed.remove(network);
        }
        auto newVersion = prefsRepo.save(user.id, prefs);

        auto col = Json.emptyObject;
        foreach (k, v; prefs.collapsed)
            col[k] = Json(v);
        broadcastPrefUpdate(user.id.toString(), "collapsed", col, newVersion);

        res.statusCode = 204;
        res.writeVoidBody();
    }

    private void updateInactiveCollapsed(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;
        const network = bodyJson["network"].get!string;
        const collapsed = bodyJson["collapsed"].get!bool;

        auto prefs = prefsRepo.load(user.id);
        if (collapsed) {
            prefs.inactiveCollapsed[network] = true;
        } else {
            prefs.inactiveCollapsed.remove(network);
        }
        auto newVersion = prefsRepo.save(user.id, prefs);

        auto ic = Json.emptyObject;
        foreach (k, v; prefs.inactiveCollapsed)
            ic[k] = Json(v);
        broadcastPrefUpdate(user.id.toString(), "inactiveCollapsed", ic, newVersion);

        res.statusCode = 204;
        res.writeVoidBody();
    }

    /// Updates `showMemberPrefixes` pref (whether to show @/+/% in member list).
    private void updateShowMemberPrefixes(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;
        bool value = true;
        bool found = false;
        if (auto v = "showMemberPrefixes" in bodyJson) {
            if (v.type == Json.Type.bool_) { value = v.get!bool; found = true; }
            else { res.statusCode = 400; res.writeJsonBody(Json(["error": Json("showMemberPrefixes must be bool")])); return; }
        } else if (auto v = "value" in bodyJson) {
            if (v.type == Json.Type.bool_) { value = v.get!bool; found = true; }
            else { res.statusCode = 400; res.writeJsonBody(Json(["error": Json("value must be bool")])); return; }
        }
        if (!found) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("showMemberPrefixes required")]));
            return;
        }

        auto prefs = prefsRepo.load(user.id);
        prefs.showMemberPrefixes = value;
        auto newVersion = prefsRepo.save(user.id, prefs);

        broadcastPrefUpdate(user.id.toString(), "showMemberPrefixes", Json(value), newVersion);

        res.statusCode = 204;
        res.writeVoidBody();
    }

    private void updateNotificationPrefs(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto bodyJson = req.json;
        if (bodyJson.type != Json.Type.object) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("body must be object")]));
            return;
        }
        // Validate BEFORE taking the per-user lock so a bad body cannot
        // hold up a concurrent legitimate write.
        foreach (k; ["desktopNotifications", "notificationSound",
                     "autoDismissNotifs", "muteAll"]) {
            if (auto v = k in bodyJson) {
                if (v.type != Json.Type.bool_) {
                    res.statusCode = 400;
                    res.writeJsonBody(Json(["error": Json(k ~ " must be boolean")]));
                    return;
                }
            }
        }

        // Serialized read-modify-write. Two toggles of the same switch can
        // land within a millisecond of each other (the permission-denied
        // auto-revert always does), and an unserialized load/save pair
        // loses the newer value AND gives it the lower prefVersion, so the
        // client's highest-version-wins rule then keeps the stale one.
        bool any = false;
        UserPreferences after;
        auto newVersion = prefsRepo.mutate(user.id, (ref UserPreferences prefs) {
            if (auto v = "desktopNotifications" in bodyJson) { prefs.desktopNotifications = v.get!bool; any = true; }
            if (auto v = "notificationSound" in bodyJson) { prefs.notificationSound = v.get!bool; any = true; }
            if (auto v = "autoDismissNotifs" in bodyJson) { prefs.autoDismissNotifs = v.get!bool; any = true; }
            if (auto v = "muteAll" in bodyJson) { prefs.muteAll = v.get!bool; any = true; }
            after = prefs;
            return any;
        });
        if (!any) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("no notification pref provided")]));
            return;
        }
        auto val = Json.emptyObject;
        val["desktopNotifications"] = Json(after.desktopNotifications);
        val["notificationSound"] = Json(after.notificationSound);
        val["autoDismissNotifs"] = Json(after.autoDismissNotifs);
        val["muteAll"] = Json(after.muteAll);
        broadcastPrefUpdate(user.id.toString(), "notificationPrefs", val, newVersion);
        // Also broadcast granular keys for forward-compat fallback (plan Step 2 fallback branch)
        broadcastPrefUpdate(user.id.toString(), "desktopNotifications", Json(after.desktopNotifications), newVersion);
        broadcastPrefUpdate(user.id.toString(), "muteAll", Json(after.muteAll), newVersion);
        res.writeJsonBody(Json(["prefVersion": Json(newVersion)]));
    }

    /// Replaces the user's sidebar network order with `order` (array of
    /// networkIds, top-to-bottom). Mirrors IRCCloud's `reorder-connections`
    /// stream message body — the full ordered list is sent on every change
    /// rather than a (from, to) delta, which is simpler and matches the
    /// jQuery UI Sortable's `update` callback semantics.
    private void updateNetworkOrder(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;


        auto user = req.context["user"].get!User;
        const bodyJson = req.json;

        string[] order;
        if (auto o = "order" in bodyJson) {
            if (o.type == Json.Type.array) {
                foreach (entry; *o) {
                    if (entry.type == Json.Type.string) {
                        const id = entry.get!string;
                        if (id.length > 0 && !order.canFind(id))
                            order ~= id;
                    }
                }
            }
        }

        auto prefs = prefsRepo.load(user.id);
        prefs.networkOrder = order;
        auto newVersion = prefsRepo.save(user.id, prefs);

        broadcastPrefUpdate(user.id.toString(), "networkOrder", serializeToJson(prefs.networkOrder), newVersion);

        res.statusCode = 204;
        res.writeVoidBody();
    }

    /// Replaces the user's ignore-mask list (IRCCloud `set-ignores`
    /// equivalent). Full-list replace like network-order: the frontend
    /// funnels every add/remove through one POST. Caps are new policy —
    /// 256 chars per mask, 1000 masks — bounding the Redis prefs blob.
    private void updateIgnores(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        const bodyJson = req.json;

        string[] masks;
        if (auto o = "ignores" in bodyJson) {
            if (o.type == Json.Type.array) {
                foreach (entry; *o) {
                    if (entry.type == Json.Type.string) {
                        const m = entry.get!string;
                        if (m.length > 0 && m.length <= 256 && !masks.canFind(m))
                            masks ~= m;
                    }
                }
            }
        }
        if (masks.length > 1000) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("too many ignore masks")]));
            return;
        }

        auto prefs = prefsRepo.load(user.id);
        prefs.ignores = masks;
        auto newVersion = prefsRepo.save(user.id, prefs);

        broadcastPrefUpdate(user.id.toString(), "ignores", serializeToJson(prefs.ignores), newVersion);

        res.statusCode = 204;
        res.writeVoidBody();
    }

    /// Replaces the order of the user's pinned channels. `prefs.pinnedChannels`
    /// has always been an ordered array (pin appends, unpin filters), so the
    /// order IS the pin list — no second field, no migration, and the existing
    /// `pinned` broadcast already carries it to every other tab and device.
    ///
    /// The payload is treated as a reordering, never as a membership change:
    /// ids that are not currently pinned are dropped, and pinned ids the
    /// client omitted are appended in their existing order. That way a tab
    /// working from a stale list cannot unpin a channel by leaving it out of
    /// a drag it never saw.
    private void updatePinnedOrder(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        const bodyJson = req.json;

        auto prefs = prefsRepo.load(user.id);

        string[] requested;
        if (auto o = "order" in bodyJson) {
            if (o.type == Json.Type.array) {
                foreach (entry; *o) {
                    if (entry.type != Json.Type.string) continue;
                    const id = entry.get!string;
                    if (id.length == 0 || requested.canFind(id)) continue;
                    if (!prefs.pinnedChannels.canFind(id)) continue;
                    requested ~= id;
                }
            }
        }
        foreach (id; prefs.pinnedChannels) {
            if (!requested.canFind(id)) requested ~= id;
        }

        prefs.pinnedChannels = requested;
        auto newVersion = prefsRepo.save(user.id, prefs);

        broadcastPrefUpdate(user.id.toString(), "pinned", serializeToJson(prefs.pinnedChannels), newVersion);

        res.statusCode = 204;
        res.writeVoidBody();
    }

    /// Broadcasts a `pref_update` event so every connected tab/device for
    /// this user can sync its local state in real time. The `prefVersion`
    /// argument is the monotonic counter returned by the most recent
    /// `prefsRepo.save()`; the receiving frontend uses it for
    /// last-write-wins against its own copy. See docs/PREF_VERSION.md.
    private void broadcastPrefUpdate(string userId, string prefKey, Json value, long prefVersion) {
        try {
            auto json = Json.emptyObject;
            json["type"] = Json("pref_update");
            json["key"] = Json(prefKey);
            json["value"] = value;
            json["prefVersion"] = Json(prefVersion);
            redis.publish(RedisKeys.events(userId), json.toString());
        } catch (Exception e) {
            logWarn("Failed to broadcast pref update: %s", e.msg);
        }
    }

    /// W3-T01a: Returns archived buffer names for ALL user networks grouped
    /// by networkId. Cached in Redis with 5-minute TTL.
    private void getArchiveNames(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto user = req.context["user"].get!User;
        auto cacheKey = RedisKeys.archiveNames(user.id.toString());

        // Check Redis cache first
        auto cached = redis.getJson(cacheKey);
        if (cached.type != Json.Type.null_ && cached.type != Json.Type.undefined) {
            res.writeJsonBody(cached);
            return;
        }

        // Load user preferences and group archived channels by networkId
        auto prefs = prefsRepo.load(user.id);
        string[][string] grouped;
        foreach (const archiveId; prefs.archivedChannels) {
            auto colonIdx = archiveId.indexOf(":");
            if (colonIdx < 0) continue;
            auto networkId = archiveId[0 .. colonIdx];
            auto channelName = archiveId[colonIdx + 1 .. $];
            grouped[networkId] ~= channelName;
        }

        // Build JSON response
        auto archives = Json.emptyObject;
        foreach (nid, chans; grouped) {
            auto arr = Json.emptyArray;
            foreach (c; chans) arr ~= Json("" ~ c);
            archives[nid] = arr;
        }
        auto response = Json(["archives": archives]);

        // Cache in Redis with 5-minute TTL
        redis.setJson(cacheKey, response, 300);

        res.writeJsonBody(response);
    }

    // NEW: Get all connection servers (admin/health endpoint)
    private void getServers(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto servers = serverRegistry.getAllServers();
        Json[] arr;
        foreach (s; servers) {
            arr ~= s.toJson();
        }
        res.writeJsonBody(Json([
            "servers": Json(arr),
            "healthyCount": Json(serverRegistry.getHealthyServers().length)
        ]));
    }

    // NEW: Get single server details
    private void getServer(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto serverId = req.params["id"];
        auto server = serverRegistry.getServer(serverId);
        
        if (server.serverId.length == 0) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("Server not found")]));
            return;
        }
        
        auto j = server.toJson();
        j["isHealthy"] = Json(serverRegistry.isServerHealthy(serverId));
        j["networkCount"] = Json(server.assignedNetworks.length);
        res.writeJsonBody(j);
    }

    /// Admin: handoff / hot-reload status. Reads metrics stored in
    /// Redis by the engine after each successful handoff.
    /// Returns the last handoff result + per-server draining state.
    private void getHandoffStatus(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        try {
            auto db = redis.getDb();
            auto fieldInfo = db.hget("ircfiber:handoff:last", "info");
            auto fieldSid = db.hget("ircfiber:handoff:last", "serverId");
            auto fieldTs  = db.hget("ircfiber:handoff:last", "timestamp");

            Json lastHandoff;
            if (fieldInfo.length > 0) {
                try {
                    lastHandoff = parseJsonString(cast(string) fieldInfo);
                } catch (Exception) {
                    lastHandoff = Json.emptyObject;
                }
            } else {
                lastHandoff = Json.emptyObject;
            }

            // Gather draining state from all registered servers
            auto servers = serverRegistry.getAllServers();
            Json[] drainingList;
            foreach (s; servers) {
                try {
                    auto data = db.hget(RedisKeys.server(s.serverId), "data");
                    if (data.length > 0) {
                        auto j = parseJsonString(cast(string) data);
                        if (j.type == Json.Type.object) {
                            bool draining = false;
                            if ("draining" in j) {
                                const dv = j["draining"];
                                draining = dv.get!bool;
                            }
                            if (draining)
                                drainingList ~= Json(["serverId": Json(s.serverId), "draining": Json(true)]);
                        }
                    }
                } catch (Exception) {}
            }

            auto output = Json.emptyObject;
            output["lastHandoff"] = lastHandoff;
            output["lastHandoffServerId"] = Json(fieldSid.length > 0 ? cast(string) fieldSid : "");
            output["lastHandoffTimestamp"] = Json(fieldTs.length > 0 ? cast(string) fieldTs : "");
            output["drainingServers"] = Json(drainingList);
            res.writeJsonBody(output);
        } catch (Exception e) {
            res.statusCode = 500;
            res.writeJsonBody(Json(["error": Json("Failed to read handoff status: " ~ e.msg)]));
        }
    }

    /// Admin: manually clear a stuck draining flag for a specific server.
    /// This is the emergency recovery button for the admin dashboard.
    /// POST /api/admin/servers/:id/clear-draining
    private void clearServerDraining(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;

        auto serverId = req.params["id"];
        const server = serverRegistry.getServer(serverId);

        if (server.serverId.length == 0) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("Server not found")]));
            return;
        }

        try {
            serverRegistry.clearDraining(serverId);
            logInfo("Admin: manually cleared draining for server %s", serverId);
            res.writeJsonBody(Json([
                "status": Json("ok"),
                "serverId": Json(serverId),
                "message": Json("Draining state cleared")
            ]));
        } catch (Exception e) {
            res.statusCode = 500;
            res.writeJsonBody(Json(["error": Json("Failed to clear draining: " ~ e.msg)]));
        }
    }

    /// Max accepted upload size: 50MB (IRCCloud parity: universal binary support, capped at 50MB).
    enum MAX_UPLOAD_BYTES = 50L * 1024 * 1024;

    /// Returns null if acceptable, else a user-presentable rejection reason.
    /// Universal file support: any MIME/binary is accepted; only size is enforced.
    /// (Previously restricted to images + text only.)
    package static string validateUpload(string mime, long size, string filename = "") @safe {
        if (size <= 0) return "Empty file";
        if (size > MAX_UPLOAD_BYTES) return "File too large (max 50 MB)";
        return null;
    }

    /// True when an upload record is a convertible video (browser MIME or extension).
    package static bool isVideoUpload(string mime, string filename) @safe {
        import std.string : startsWith, toLower;
        import std.algorithm.searching : endsWith;
        if (mime.startsWith("video/")) return true;
        auto lower = filename.toLower;
        foreach (ext; [".mp4", ".m4v", ".webm", ".mov", ".avi", ".mkv", ".mpg", ".mpeg", ".flv", ".wmv", ".3gp"])
            if (lower.endsWith(ext)) return true;
        return false;
    }

    /// True when an upload is a WebP image. Animated WebP renders to an
    /// animated GIF via ffmpeg's libwebp demuxer; a still WebP yields a
    /// single-frame GIF.
    package static bool isWebpUpload(string mime, string filename) @safe {
        import std.string : toLower;
        import std.algorithm.searching : endsWith;
        if (mime.toLower == "image/webp") return true;
        return filename.toLower.endsWith(".webp");
    }

    /// True when an upload can be converted to an animated GIF (video or WebP).
    package static bool isGifConvertible(string mime, string filename) @safe {
        return isVideoUpload(mime, filename) || isWebpUpload(mime, filename);
    }

    @safe unittest {
        assert(isGifConvertible("video/mp4", "clip.mp4"));
        assert(isGifConvertible("image/webp", "sticker.webp"));
        assert(isGifConvertible("application/octet-stream", "anim.WEBP"));
        assert(!isGifConvertible("image/png", "cat.png"));
        assert(!isGifConvertible("image/jpeg", "photo.jpg"));
    }

    /// Dedup `older` against `existing` by msgid (preferred) and eid
    /// (fallback). The engine writes every event to BOTH Redis and
    /// MongoDB, so when Redis returns fewer than the requested count
    /// and the REST handler falls through to a MongoDB `getBeforeTimestamp`
    /// call, MongoDB will return the same messages we already have.
    /// Without this filter the frontend renders each one twice.
    /// Public so `source/dedup_test.d` can exercise it without booting
    /// Redis/MongoDB (which the full `unittest` build is currently
    /// broken on macOS — see dub.sdl `unittest` config).
    public static Json[] dedupMessages(Json[] existing, Json[] older) @safe {
        bool[string] seenMsgids;
        bool[string] seenEids;
        foreach (m; existing) {
            if (auto mid = "m" in m)
                if (mid.type == Json.Type.string) seenMsgids[mid.get!string] = true;
            if (auto e = "eid" in m)
                if (e.type == Json.Type.int_) {
                    auto eidStr = e.get!long.to!string;
                    seenEids[eidStr] = true;
                }
        }
        Json[] deduped;
        foreach (m; older) {
            bool dup = false;
            if (auto mid = "m" in m)
                if (mid.type == Json.Type.string && (mid.get!string) in seenMsgids) dup = true;
            if (!dup)
                if (auto e = "eid" in m)
                    if (e.type == Json.Type.int_) {
                        if ((e.get!long.to!string) in seenEids) dup = true;
                    }
            if (!dup) deduped ~= m;
        }
        return deduped;
    }

    private void uploadFile(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;

        auto pf = "file" in req.files;
        if (pf is null) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("missing file field")]));
            return;
        }
        import vibe.core.file : readFile;
        auto data = cast(const(ubyte)[])readFile(pf.tempPath);
        auto mime = pf.headers.get("Content-Type", "");
        auto filename = req.form.get("filename", pf.filename.name);

        if (auto err = validateUpload(mime, cast(long)data.length, filename)) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json(err)]));
            return;
        }

        // Construct base URL from the incoming Host header (set by Caddy).
        // Scheme: honor X-Forwarded-Proto (Caddy sets it to https in prod);
        // default to http so local dev against the plain-HTTP gateway
        // produces links that actually resolve (a hardcoded https:// made
        // every posted upload URL dead on 127.0.0.1:8090).
        auto host = req.headers["Host"];
        if (host.length == 0) host = "localhost:8090";
        string proto = req.headers.get("X-Forwarded-Proto", "http");
        auto baseUrl = proto ~ "://" ~ host;

        LocalUploadResult uploaded;
        try {
            uploaded = saveUpload(filename, mime, data, baseUrl);
        } catch (LocalUploadException e) {
            logWarn("local upload failed: %s", e.msg);
            res.statusCode = 502;
            res.writeJsonBody(Json(["error": Json(e.msg)]));
            return;
        }

        UploadRecord rec;
        rec.id = randomUUID().toString();
        rec.userId = user.id.toString();
        rec.networkId = req.form.get("networkId", "");
        rec.buffer = req.form.get("buffer", "");
        rec.filename = filename;
        rec.originalFilename = pf.filename.name;
        rec.mimeType = mime;
        rec.size = cast(long)data.length;
    rec.pageUrl = uploaded.url;
    rec.directUrl = uploaded.url;
        rec.createdAt = Clock.currTime.toUnixTime!long * 1000;
        try { uploadRepo.insert(rec); }
        catch (Exception e) { logError("Failed to record upload: %s", e.msg); }

        res.writeJsonBody(Json([
            "id": Json(rec.id), "url": Json(rec.directUrl), "pageUrl": Json(rec.pageUrl),
            "name": Json(rec.filename), "size": Json(rec.size),
        ]));
    }

    private void getUploads(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        int limit = 25;
        if (auto p = "limit" in req.query) limit = (*p).to!int;
        UploadRecord[] records;
        if (auto p = "offset" in req.query) {
            records = uploadRepo.pageByUser(user.id.toString(), (*p).to!int, limit);
        } else {
            long before = long.max;
            if (auto p = "before" in req.query) before = (*p).to!long;
            records = uploadRepo.listByUser(user.id.toString(), before, limit);
        }
        const long total = uploadRepo.countByUser(user.id.toString());
        auto arr = Json.emptyArray;
        foreach (r; records) {
            arr ~= Json([
                "id": Json(r.id), "url": Json(r.directUrl), "name": Json(r.filename),
                "mimeType": Json(r.mimeType), "size": Json(r.size),
                "createdAt": Json(r.createdAt), "buffer": Json(r.buffer),
                "networkId": Json(r.networkId),
            ]);
        }
        res.writeJsonBody(Json(["uploads": arr, "total": Json(total)]));
    }

    private void getUploadById(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto id = req.params["id"];
        auto rec = uploadRepo.getById(user.id.toString(), id);
        if (rec is UploadRecord.init || rec.id.length == 0) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("not found")]));
            return;
        }
        res.writeJsonBody(Json([
            "id": Json(rec.id), "url": Json(rec.directUrl), "name": Json(rec.filename),
            "mimeType": Json(rec.mimeType), "size": Json(rec.size),
            "createdAt": Json(rec.createdAt), "buffer": Json(rec.buffer),
            "networkId": Json(rec.networkId),
        ]));
    }

    private void deleteUpload(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto id = req.params["id"];
        auto userId = user.id.toString();

        // 1. Fetch the record first so we know the URL/file path
        const rec = uploadRepo.getById(userId, id);
        if (rec is UploadRecord.init) {
            // If we found nothing (or it's not theirs), maybe another request
            // already deleted it — double-check with the old soft-delete
            // semantics for idempotency.
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("not found")]));
            return;
        }

        // 2. Remove the local file from disk.
        //    Local upload URLs are always "<baseUrl>/uploads/<uuid.ext>".
        //    We extract the filename and look it up under the upload directory.
        auto url = rec.directUrl.strip;
        auto uploadDir_ = uploadDir();
        auto uploadPrefix = "/uploads/";
        auto prefixPos = url.indexOf(uploadPrefix);
        if (prefixPos != -1) {
            auto filename = url[prefixPos + uploadPrefix.length .. $];
            if (filename.length > 0) {
                auto filePath = buildPath(uploadDir_, filename);
                try {
                    remove(filePath);
                    logInfo("Deleted local file for upload %s: %s", id, filePath);
                } catch (Exception e) {
                    // File may already be gone (concurrent delete, prior cleanup, etc.)
                    logWarn("Could not remove local file for upload %s at %s: %s",
                        id, filePath, e.msg);
                }
            }
        } else {
            // Non-local URL (legacy / external upload). We still remove the DB
            // record below but can't delete the remote file.
            logInfo("Upload %s has remote URL %s — skipping file deletion", id, url);
        }

        // 3. Hard-delete the MongoDB document
        if (uploadRepo.hardDelete(userId, id)) {
            logInfo("Hard-deleted upload document %s for user %s", id, userId);
            res.statusCode = 204;
            res.writeVoidBody();
        } else {
            // The document was found by getById but disappeared by hardDelete.
            // Concurrent delete — rare but possible. Return 204 (idempotent).
            logWarn("Upload %s vanished between getById and hardDelete (concurrent delete?)", id);
            res.statusCode = 204;
            res.writeVoidBody();
        }
    }

    private void editUpload(HTTPServerRequest req, HTTPServerResponse res) {
        import std.file : write;
        import std.path : buildPath;
        import ircfiber.upload.local : uploadDir;
        import ircfiber.db.uploads : UploadRepository;
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto id = req.params["id"];
        auto json = req.json;
        string newContent;
        string newFilename;
        try { newContent = json["content"].get!string; newFilename = json["filename"].get!string; } catch (Exception) { res.statusCode = 400; res.writeJsonBody(Json(["error": Json("invalid json")])); return; }
        if (newFilename.length == 0) { res.statusCode = 400; res.writeJsonBody(Json(["error": Json("filename required")])); return; }
        if (newContent.length > 15_728_640) { res.statusCode = 413; return; }
        auto repo = new UploadRepository();
        auto rec = repo.getById(user.id.toString(), id);
        if (rec.id.length == 0) { res.statusCode = 404; return; }
        auto url = rec.directUrl;
        auto prefix = "/uploads/";
        auto pos = url.indexOf(prefix);
        if (pos == -1) { res.statusCode = 500; return; }
        auto filename = url[pos + prefix.length .. $];
        auto qIdx = filename.indexOf("?");
        if (qIdx >= 0) filename = filename[0..qIdx];
        if (filename.length == 0 || filename.canFind("..") || filename.canFind("/")) { res.statusCode = 400; return; }
        auto filePath = buildPath(uploadDir(), filename);
        try { write(filePath, newContent); } catch (Exception e) { res.statusCode = 500; res.writeJsonBody(Json(["error": Json(e.msg)])); return; }
        bool ok = repo.updateContent(user.id.toString(), id, newContent, newFilename, newContent.length);
        if (!ok) { res.statusCode = 500; return; }
        res.writeJsonBody(Json(["status": Json("ok"), "id": Json(id)]));
    }

    /// Hard cap on the converted GIF's duration, in seconds. Also the
    /// denominator for progress: ffmpeg reports `out_time_us` against the
    /// output timeline, which `-t` truncates.
    private enum int GIF_MAX_SECONDS = 30;
    /// How long a finished/failed job stays readable by the poller.
    private enum long GIF_JOB_TTL_SECONDS = 300;

    private static string gifJobKey(string jobId) {
        return "gif:job:" ~ jobId;
    }

    /// Publishes a job snapshot. Redis (not process memory) so a poll that
    /// lands on the other side of a blue/green gateway swap still resolves,
    /// and so the record expires on its own.
    private void putGifJob(string jobId, Json job) {
        try redis.setJson(gifJobKey(jobId), job, GIF_JOB_TTL_SECONDS);
        catch (Exception e) logWarn("gif job publish failed: %s", e.msg);
    }

    /// Duration of the source in ms via ffprobe, clamped to GIF_MAX_SECONDS.
    /// Returns 0 when ffprobe is unavailable or the value is unparseable —
    /// the client then renders an indeterminate progress bar instead of a
    /// wrong percentage.
    private long probeDurationMs(string srcPath) {
        import vibe.core.process : execute;
        import std.string : strip;
        try {
            auto r = execute(["ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", srcPath]);
            if (r.status != 0) return 0;
            auto secs = r.output.strip.to!double;
            if (secs <= 0) return 0;
            if (secs > GIF_MAX_SECONDS) secs = GIF_MAX_SECONDS;
            return cast(long)(secs * 1000);
        } catch (Exception) {
            return 0;
        }
    }

    /// Convert an uploaded video (or WebP) to an animated GIF via ffmpeg.
    ///
    /// Returns `202 {jobId}` immediately and does the work in a background
    /// task, publishing live ffmpeg progress under `gif:job:<jobId>`; the
    /// client polls `GET /api/uploads/gif-jobs/:jobId`. Conversion of a 30 s
    /// clip takes tens of seconds, so the previous blocking request left the
    /// UI on a static "converting…" label with no way to tell progress from
    /// a hang.
    private void convertUploadToGif(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;

        auto rec = uploadRepo.getById(user.id.toString(), req.params["id"]);
        if (rec is UploadRecord.init || rec.id.length == 0) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("not found")]));
            return;
        }

        if (!isGifConvertible(rec.mimeType, rec.filename)) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("Not a convertible file (video or WebP)")]));
            return;
        }

        // Resolve local source path from the direct URL (same as deleteUpload).
        auto url = rec.directUrl.strip;
        auto uploadPrefix = "/uploads/";
        auto prefixPos = url.indexOf(uploadPrefix);
        if (prefixPos == -1) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("Remote uploads cannot be converted")]));
            return;
        }
        auto srcName = url[prefixPos + uploadPrefix.length .. $];
        auto srcPath = buildPath(uploadDir(), srcName);
        if (srcName.length == 0 || !exists(srcPath)) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("file missing on disk")]));
            return;
        }

        auto host = req.headers["Host"];
        if (host.length == 0) host = "localhost:8090";
        string proto = req.headers.get("X-Forwarded-Proto", "http");
        auto baseUrl = proto ~ "://" ~ host;

        const jobId = randomUUID().toString();
        const userId = user.id.toString();
        const startedAt = Clock.currTime.toUnixTime!long * 1000;

        // The very first poll can land before ffmpeg has emitted anything, so
        // this placeholder MUST carry the full field set the poll contract
        // promises — a missing `frame` renders as "frame undefined" in the
        // client's indeterminate label.
        putGifJob(jobId, Json([
            "state":      Json("running"),
            "userId":     Json(userId),
            "uploadId":   Json(rec.id),
            "filename":   Json(rec.filename),
            "percent":    Json(0),
            "frame":      Json(0L),
            "fps":        Json(0.0),
            "speed":      Json(0.0),
            "durationMs": Json(0L),
            "outTimeMs":  Json(0L),
            "elapsedMs":  Json(0L),
            "etaMs":      Json(0L),
            "startedAt":  Json(startedAt),
        ]));

        // Everything the task needs is copied out of `req` first: the
        // request object is dead the moment we return.
        auto recCopy = rec;
        // runTask requires a nothrow delegate, so every failure has to be
        // funnelled into the job record instead of propagating.
        runTask(() nothrow {
            try {
                runGifConversion(jobId, userId, recCopy, srcPath, baseUrl, startedAt);
            } catch (Exception e) {
                try {
                    logWarn("gif conversion task failed: %s", e.msg);
                    putGifJob(jobId, Json([
                        "state":  Json("error"),
                        "userId": Json(userId),
                        "error":  Json(e.msg),
                    ]));
                } catch (Exception) {}
            }
        });

        res.statusCode = 202;
        res.writeJsonBody(Json([
            "jobId": Json(jobId),
            "state": Json("running"),
        ]));
    }

    /// Poll endpoint for `convertUploadToGif`. 404 once the job's TTL has
    /// expired, so a client that slept through the whole conversion is told
    /// to reload rather than shown a stale bar.
    private void getGifJob(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;

        Json job;
        try job = redis.getJson(gifJobKey(req.params["jobId"]));
        catch (Exception e) {
            logWarn("gif job read failed: %s", e.msg);
            res.statusCode = 502;
            res.writeJsonBody(Json(["error": Json("job lookup failed")]));
            return;
        }
        if (job.type != Json.Type.object) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("unknown or expired job")]));
            return;
        }
        // A job id is a UUID, but ownership is still checked: the poller
        // must not be able to read another user's filenames or result URL.
        if (job["userId"].opt!string != user.id.toString()) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("unknown or expired job")]));
            return;
        }
        res.writeJsonBody(job);
    }

    /// The actual ffmpeg run. Publishes progress as it goes and the finished
    /// upload record (same shape the endpoint used to return synchronously)
    /// under `result` when done.
    private void runGifConversion(string jobId, string userId, UploadRecord rec,
                                  string srcPath, string baseUrl, long startedAt) {
        import vibe.core.process : pipeProcess, Redirect;
        import vibe.stream.operations : readLine;
        import core.time : seconds;
        import std.file : tempDir;
        import std.path : stripExtension;
        import std.array : replace;
        import std.string : indexOf, strip;
        import std.algorithm : endsWith;

        const durationMs = probeDurationMs(srcPath);

        void publish(string state, int percent, long frame, double fps, double speed,
                     long outTimeMs, string error, Json result) {
            const now = Clock.currTime.toUnixTime!long * 1000;
            const elapsed = now - startedAt;
            // ETA from observed throughput, not from `speed` (which is
            // relative to realtime and jumps around at the start).
            long etaMs = 0;
            if (percent > 0 && percent < 100 && elapsed > 0)
                etaMs = cast(long)(elapsed * (100.0 - percent) / percent);
            auto job = Json.emptyObject;
            job["state"]      = Json(state);
            job["userId"]     = Json(userId);
            job["uploadId"]   = Json(rec.id);
            job["filename"]   = Json(rec.filename);
            job["percent"]    = Json(percent);
            job["frame"]      = Json(frame);
            job["fps"]        = Json(fps);
            job["speed"]      = Json(speed);
            job["durationMs"] = Json(durationMs);
            job["outTimeMs"]  = Json(outTimeMs);
            job["elapsedMs"]  = Json(elapsed);
            job["etaMs"]      = Json(etaMs);
            job["startedAt"]  = Json(startedAt);
            if (error.length > 0) job["error"] = Json(error);
            if (result.type == Json.Type.object) job["result"] = result;
            putGifJob(jobId, job);
        }

        auto tmpPath = buildPath(tempDir, randomUUID().toString().replace("-", "") ~ ".gif");
        // Cap at 30s, 12fps, max width 480, palette-optimized. ffmpeg's own
        // filtergraph parser handles the argument; argv exec, no shell.
        // `-progress pipe:1 -nostats` turns stdout into a machine-readable
        // key=value progress stream (frame/fps/out_time_us/speed/progress).
        // `-stats_period 0.2` overrides ffmpeg's 0.5 s default so a short
        // conversion still emits several blocks and the bar actually moves.
        auto args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-nostats", "-progress", "pipe:1", "-stats_period", "0.2",
            "-i", srcPath,
            "-t", GIF_MAX_SECONDS.to!string,
            "-vf", "fps=12,scale=w='min(480,iw)':h=-2:flags=lanczos," ~
                   "split[s0][s1];[s0]palettegen=stats_mode=diff[p];" ~
                   "[s1][p]paletteuse=dither=bayer:bayer_scale=5",
            "-loop", "0", tmpPath];

        typeof(pipeProcess(args, Redirect.stdout)) pipes;
        try {
            pipes = pipeProcess(args, Redirect.stdout);
        } catch (Exception e) {
            logWarn("ffmpeg spawn failed: %s", e.msg);
            publish("error", 0, 0, 0, 0, 0,
                "GIF conversion unavailable (ffmpeg not installed)", Json.undefined);
            return;
        }

        long frame, outTimeMs;
        double fps = 0, speed = 0;
        int percent = 0;
        long lastPublishMs = 0;
        try {
            while (!pipes.stdout.empty) {
                // vibe's readLine defaults to a CRLF separator and THROWS if
                // the stream ends without one. ffmpeg's `-progress` stream is
                // LF-separated, so without the explicit separator the whole
                // stream comes back as one unparseable blob at EOF and every
                // progress field stays zero.
                auto line = cast(string) pipes.stdout.readLine(4096, "\n");
                const eq = line.indexOf('=');
                if (eq <= 0) continue;
                const key = line[0 .. eq].strip;
                const val = line[eq + 1 .. $].strip;
                switch (key) {
                    case "frame":
                        try frame = val.to!long; catch (Exception) {}
                        break;
                    case "fps":
                        try fps = val.to!double; catch (Exception) {}
                        break;
                    case "speed":
                        // e.g. "1.42x", or "N/A" before the first frame.
                        try speed = val.endsWith("x") ? val[0 .. $ - 1].to!double : val.to!double;
                        catch (Exception) {}
                        break;
                    case "out_time_us":
                    case "out_time_ms":   // ffmpeg reports microseconds here too
                        try outTimeMs = val.to!long / 1000; catch (Exception) {}
                        break;
                    case "progress":
                        // Every ffmpeg progress block is terminated by a
                        // `progress=continue|end` line. Publishing only here
                        // means a snapshot never mixes this block's frame
                        // count with the previous block's timestamp.
                        if (val == "end") outTimeMs = durationMs > 0 ? durationMs : outTimeMs;
                        if (durationMs > 0) {
                            auto p = cast(int)(outTimeMs * 100 / durationMs);
                            percent = p < 0 ? 0 : (p > 99 ? 99 : p);
                        }
                        const nowMs = Clock.currTime.toUnixTime!long * 1000;
                        if (val != "end" && nowMs - lastPublishMs >= 150) {
                            lastPublishMs = nowMs;
                            publish("running", percent, frame, fps, speed, outTimeMs, "", Json.undefined);
                        }
                        break;
                    default:
                        break;
                }
            }
        } catch (Exception e) {
            // A read failure is not fatal on its own — the exit status below
            // decides. Progress simply stops updating.
            logWarn("ffmpeg progress read ended: %s", e.msg);
        }

        auto code = pipes.process.wait(120.seconds);
        if (code.isNull) {
            pipes.process.forceKill();
            pipes.process.wait();
            try { if (exists(tmpPath)) remove(tmpPath); } catch (Exception) {}
            publish("error", percent, frame, fps, speed, outTimeMs,
                "GIF conversion timed out", Json.undefined);
            return;
        }
        if (code.get != 0) {
            try { if (exists(tmpPath)) remove(tmpPath); } catch (Exception) {}
            publish("error", percent, frame, fps, speed, outTimeMs,
                "ffmpeg failed (exit " ~ code.get.to!string ~ ")", Json.undefined);
            return;
        }

        const(ubyte)[] data;
        {
            import std.file : read;
            data = cast(const(ubyte)[]) read(tmpPath);
        }
        try { remove(tmpPath); } catch (Exception) {}
        if (data.length == 0) {
            publish("error", percent, frame, fps, speed, outTimeMs,
                "ffmpeg produced empty output", Json.undefined);
            return;
        }
        if (data.length > MAX_UPLOAD_BYTES) {
            publish("error", percent, frame, fps, speed, outTimeMs,
                "Converted GIF exceeds 50 MB", Json.undefined);
            return;
        }

        auto gifName = stripExtension(rec.filename) ~ ".gif";
        LocalUploadResult uploaded;
        try {
            uploaded = saveUpload(gifName, "image/gif", data, baseUrl);
        } catch (LocalUploadException e) {
            logWarn("gif upload save failed: %s", e.msg);
            publish("error", percent, frame, fps, speed, outTimeMs, e.msg, Json.undefined);
            return;
        }

        UploadRecord rec2;
        rec2.id = randomUUID().toString();
        rec2.userId = rec.userId;
        rec2.networkId = rec.networkId;
        rec2.buffer = rec.buffer;
        rec2.filename = gifName;
        rec2.originalFilename = rec.filename;
        rec2.mimeType = "image/gif";
        rec2.size = cast(long)data.length;
        rec2.pageUrl = uploaded.url;
        rec2.directUrl = uploaded.url;
        rec2.createdAt = Clock.currTime.toUnixTime!long * 1000;
        try { uploadRepo.insert(rec2); }
        catch (Exception e) { logError("Failed to record gif upload: %s", e.msg); }

        publish("done", 100, frame, fps, speed, outTimeMs, "", Json([
            "id": Json(rec2.id), "url": Json(rec2.directUrl), "pageUrl": Json(rec2.pageUrl),
            "name": Json(rec2.filename), "mimeType": Json(rec2.mimeType), "size": Json(rec2.size),
            "createdAt": Json(rec2.createdAt), "buffer": Json(rec2.buffer), "networkId": Json(rec2.networkId),
        ]));
    }

    private Json pasteToJson(const ref PasteRecord r) {
        return Json([
            "id": Json(r.id), "name": Json(r.name), "syntax": Json(r.syntax),
            "lines": Json(r.lines), "body": Json(r.content),
            "createdAt": Json(r.createdAt), "buffer": Json(r.buffer),
            "networkId": Json(r.networkId), "userId": Json(r.userId),
        ]);
    }

    private void getPastebins(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        int limit = 25;
        if (auto p = "limit" in req.query) limit = (*p).to!int;
        int offset = 0;
        if (auto p = "offset" in req.query) offset = (*p).to!int;
        auto records = pastebinRepo.pageByUser(user.id.toString(), offset, limit);
        const long total = pastebinRepo.countByUser(user.id.toString());
        auto arr = Json.emptyArray;
        foreach (r; records) arr ~= pasteToJson(r);
        res.writeJsonBody(Json(["pastebins": arr, "total": Json(total)]));
    }

    private void createPastebin(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto j = req.json;
        PasteRecord rec;
        rec.id = randomUUID().toString();
        rec.userId = user.id.toString();
        if ("networkId" in j) rec.networkId = j["networkId"].get!string;
        if ("buffer" in j) rec.buffer = j["buffer"].get!string;
        if ("name" in j) rec.name = j["name"].get!string;
        rec.syntax = ("syntax" in j) ? j["syntax"].get!string : "text";
        rec.content = ("body" in j) ? j["body"].get!string : "";
        if (rec.content.length == 0) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("empty body")]));
            return;
        }
        rec.lines = countLines(rec.content);
        rec.createdAt = Clock.currTime.toUnixTime!long * 1000;
        pastebinRepo.insert(rec);
        res.writeJsonBody(pasteToJson(rec));
    }

    private void updatePastebin(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto existing = pastebinRepo.getById(user.id.toString(), req.params["id"]);
        if (existing.id.length == 0) {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("not found")]));
            return;
        }
        auto j = req.json;
        string name = ("name" in j) ? j["name"].get!string : existing.name;
        string syntax = ("syntax" in j) ? j["syntax"].get!string : existing.syntax;
        if ("body" in j || "content" in j) {
            string body_ = ("body" in j) ? j["body"].get!string : j["content"].get!string;
            pastebinRepo.updateFull(user.id.toString(), existing.id, name, syntax, body_);
            existing.name = name;
            existing.syntax = syntax;
            existing.content = body_;
            import ircfiber.db.pastebins : countLines;
            existing.lines = countLines(body_);
        } else {
            pastebinRepo.updateMeta(user.id.toString(), existing.id, name, syntax);
            existing.name = name;
            existing.syntax = syntax;
        }
        res.writeJsonBody(pasteToJson(existing));
    }


    private void deletePastebin(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        if (pastebinRepo.softDelete(user.id.toString(), req.params["id"])) {
            res.statusCode = 204;
            res.writeVoidBody();
        } else {
            res.statusCode = 404;
            res.writeJsonBody(Json(["error": Json("not found")]));
        }
    }

    // ── Help & Feedback (support issues) ───────────────────────────────

    private enum SUPPORT_MAX_PER_HOUR = 10;
    private enum SUPPORT_MAX_ATTACHMENTS = 3;
    private enum SUPPORT_CONTEXT_FIELD_MAX = 512;
    /// Max SigNoz alerts queued to #staff per webhook call: a storm must
    /// not flood the channel. The rest are dropped with a log line.
    private enum SIGNOZ_HOOK_MAX_ALERTS = 10;

    private static void supportError(HTTPServerResponse res, int code, string msg) {
        res.statusCode = code;
        res.writeJsonBody(Json(["error": Json(msg)]));
    }

    private static string jsonStr(Json j, string key) {
        auto v = j[key];
        return v.type == Json.Type.string ? v.get!string : "";
    }

    private static string clip(string s, size_t max) {
        if (s.length <= max) return s;
        // Back up to a UTF-8 sequence start so we never emit a torn char.
        size_t cut = max;
        while (cut > 0 && (s[cut] & 0xC0) == 0x80) cut--;
        return s[0 .. cut];
    }

    private void getSupportIssues(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        int limit = 20;
        if (auto p = "limit" in req.query) { try limit = (*p).to!int; catch (Exception) {} }
        if (limit < 1) limit = 1;
        if (limit > 50) limit = 50;
        int offset = 0;
        if (auto p = "offset" in req.query) { try offset = (*p).to!int; catch (Exception) {} }
        if (offset < 0) offset = 0;
        const uid = user.id.toString();
        auto records = supportRepo.pageByUser(uid, offset, limit);
        const long total = supportRepo.countByUser(uid);
        auto arr = Json.emptyArray;
        foreach (ref r; records) arr ~= supportIssueToJson(r, false, false);
        res.writeJsonBody(Json(["issues": arr, "total": Json(total)]));
    }

    private void createSupportIssue(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto j = req.json;
        if (j.type != Json.Type.object) { supportError(res, 400, "invalid body"); return; }

        const kind = jsonStr(j, "kind");
        if (!isValidKind(kind)) { supportError(res, 400, "invalid kind"); return; }
        const title = sanitizeLine(jsonStr(j, "title"));
        if (title.length < 3 || title.length > 120) {
            supportError(res, 400, "title must be 3–120 characters");
            return;
        }
        const body_ = jsonStr(j, "body").strip();
        if (body_.length < 10 || body_.length > 5000) {
            supportError(res, 400, "description must be 10–5000 characters");
            return;
        }
        string[] attachments;
        auto att = j["attachments"];
        if (att.type == Json.Type.array) {
            if (att.length > SUPPORT_MAX_ATTACHMENTS) { supportError(res, 400, "invalid attachment"); return; }
            foreach (a; att) {
                if (a.type != Json.Type.string) { supportError(res, 400, "invalid attachment"); return; }
                const url = a.get!string;
                if (url.length == 0 || url.length > 512 || !url.canFind("/uploads/")) {
                    supportError(res, 400, "invalid attachment");
                    return;
                }
                attachments ~= url;
            }
        } else if (att.type != Json.Type.undefined && att.type != Json.Type.null_) {
            supportError(res, 400, "invalid attachment");
            return;
        }
        SupportIssueContext ctx;
        auto cj = j["context"];
        if (cj.type == Json.Type.object) {
            ctx.appVersion = clip(sanitizeLine(jsonStr(cj, "appVersion")), SUPPORT_CONTEXT_FIELD_MAX);
            ctx.userAgent = clip(sanitizeLine(jsonStr(cj, "userAgent")), SUPPORT_CONTEXT_FIELD_MAX);
            ctx.url = clip(sanitizeLine(jsonStr(cj, "url")), SUPPORT_CONTEXT_FIELD_MAX);
            ctx.networkId = clip(sanitizeLine(jsonStr(cj, "networkId")), SUPPORT_CONTEXT_FIELD_MAX);
            ctx.bufferName = clip(sanitizeLine(jsonStr(cj, "bufferName")), SUPPORT_CONTEXT_FIELD_MAX);
            ctx.viewport = clip(sanitizeLine(jsonStr(cj, "viewport")), SUPPORT_CONTEXT_FIELD_MAX);
        }

        const now = Clock.currTime.toUnixTime!long * 1000;
        const uid = user.id.toString();
        if (supportRepo.countByUserSince(uid, now - 3_600_000) >= SUPPORT_MAX_PER_HOUR) {
            supportError(res, 429, "Too many reports in the last hour — please try again later");
            return;
        }

        SupportIssueRecord rec;
        rec.id = randomUUID().toString();
        rec.number = supportRepo.nextNumber();
        rec.userId = uid;
        rec.reporterUsername = user.username;
        rec.kind = kind;
        rec.title = title;
        rec.body_ = body_;
        rec.status = "open";
        rec.priority = "normal";
        rec.attachments = attachments;
        rec.context = ctx;
        rec.createdAt = now;
        rec.updatedAt = now;
        supportRepo.insert(rec);
        logInfo("Support issue #%d (%s) filed by %s", rec.number, rec.kind, user.username);

        SupportEvent ev;
        ev.type = "issue_created";
        ev.issueId = rec.id;
        ev.number = rec.number;
        ev.kind = rec.kind;
        ev.title = rec.title;
        ev.status = rec.status;
        ev.priority = rec.priority;
        ev.reporter = user.username;
        ev.ts = now;
        pushSupportEvent(redis, ev);

        res.statusCode = 201;
        res.writeJsonBody(supportIssueToJson(rec, false, false));
    }

    private void getSupportIssue(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto rec = supportRepo.getByIdForUser(user.id.toString(), req.params["id"]);
        if (rec.id.length == 0) { supportError(res, 404, "not found"); return; }
        res.writeJsonBody(supportIssueToJson(rec, false, false));
    }

    private void addSupportIssueComment(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto j = req.json;
        const text = j.type == Json.Type.object ? jsonStr(j, "body").strip() : "";
        if (text.length < 1 || text.length > 5000) {
            supportError(res, 400, "comment must be 1–5000 characters");
            return;
        }
        const uid = user.id.toString();
        auto rec = supportRepo.getByIdForUser(uid, req.params["id"]);
        if (rec.id.length == 0) { supportError(res, 404, "not found"); return; }

        const now = Clock.currTime.toUnixTime!long * 1000;
        SupportComment c;
        c.id = randomUUID().toString();
        c.authorId = uid;
        c.authorName = user.username;
        c.fromAdmin = false;
        c.internal = false;
        c.body_ = text;
        c.createdAt = now;
        // A follow-up on a finished issue reopens it.
        const newStatus = (rec.status == "resolved" || rec.status == "closed") ? "open" : "";
        if (!supportRepo.appendComment(rec.id, c, now, newStatus, 0)) {
            supportError(res, 404, "not found");
            return;
        }

        SupportEvent ev;
        ev.type = "comment_added";
        ev.issueId = rec.id;
        ev.number = rec.number;
        ev.kind = rec.kind;
        ev.title = rec.title;
        ev.status = newStatus.length ? newStatus : rec.status;
        ev.priority = rec.priority;
        ev.actor = user.username;
        ev.reporter = rec.reporterUsername;
        ev.actorIsAdmin = false;
        ev.reopened = newStatus.length > 0;
        ev.ts = now;
        pushSupportEvent(redis, ev);

        res.writeJsonBody(supportIssueToJson(supportRepo.getById(rec.id), false, false));
    }
    private void getPastebinById(HTTPServerRequest req, HTTPServerResponse res) {
        // Public viewer (branded) — no auth required, allow sharing via link.
        auto rec = pastebinRepo.getByIdPublic(req.params["id"]);
        if (rec.id.length == 0) { res.statusCode = 404; res.writeJsonBody(Json(["error": Json("not found")])); return; }
        res.writeJsonBody(pasteToJson(rec));
    }


    private void getPastebinRaw(HTTPServerRequest req, HTTPServerResponse res) {
        auto rec = pastebinRepo.getByIdPublic(req.params["id"]);
        if (rec.id.length == 0) {
            res.statusCode = 404;
            res.writeBody("not found", "text/plain; charset=utf-8");
            return;
        }
        res.writeBody(rec.content, "text/plain; charset=utf-8");
    }
    private Json ircArtToJson(const ref Img2IrcSaveRecord r) {
        return Json([
            "id": Json(r.id), "name": Json(r.name),
            "originalFilename": Json(r.originalFilename),
            "originalMime": Json(r.originalMime),
            "originalSize": Json(r.originalSize),
            "originalUrl": Json(r.originalUrl),
            "thumbnailUrl": Json(r.thumbnailUrl),
            "art": Json(r.art),
            "params": r.params.type != Json.Type.undefined ? r.params : Json.emptyObject,
            "createdAt": Json(r.createdAt),
            "updatedAt": Json(r.updatedAt),
            "buffer": Json(r.buffer),
            "networkId": Json(r.networkId),
        ]);
    }

    private void getIrcArtSaves(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        int limit = 25;
        if (auto p = "limit" in req.query) { try { limit = (*p).to!int; } catch (Exception) {} }
        if (limit > 50) limit = 50;
        if (limit < 1) limit = 25;
        int offset = 0;
        if (auto p = "offset" in req.query) { try { offset = (*p).to!int; } catch (Exception) {} }
        if (offset < 0) offset = 0;
        auto records = ircArtRepo.pageByUser(user.id.toString(), offset, limit);
        const long total = ircArtRepo.countByUser(user.id.toString());
        auto arr = Json.emptyArray;
        foreach (r; records) arr ~= ircArtToJson(r);
        res.writeJsonBody(Json(["ircArtSaves": arr, "total": Json(total)]));
    }

    private void createIrcArtSave(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        string name, art, networkId, buffer;
        Json params = Json.emptyObject;
        string originalUrl, thumbnailUrl;
        long originalSize = 0;
        string originalFilename, originalMime;
        bool isMultipart = false;
        auto ct = req.headers.get("Content-Type", "");
        if (ct.indexOf("multipart/") >= 0) isMultipart = true;
        if (isMultipart) {
            name = req.form.get("name", "");
            art = req.form.get("art", "");
            auto pStr = req.form.get("params", "");
            if (pStr.length > 0) { try { params = parseJsonString(pStr); } catch (Exception) { params = Json.emptyObject; } }
            networkId = req.form.get("networkId", "");
            buffer = req.form.get("buffer", "");
            auto host = req.headers.get("Host", "localhost:8090");
            if (host.length == 0 || host[0] == ':' || host == "127.0.0.1:5173" || host == "localhost:5173") host = "127.0.0.1:8090";
            string proto = req.headers.get("X-Forwarded-Proto", "http");
            if (proto.length == 0) proto = "http";
            auto baseUrl = proto ~ "://" ~ host;
            if (auto pf = "original" in req.files) {
                import vibe.core.file : readFile;
                auto data = cast(const(ubyte)[])readFile(pf.tempPath);
                if (originalSize > MAX_UPLOAD_BYTES) { res.statusCode = 413; res.writeJsonBody(Json(["error": Json("File too large (max 50 MB)")])); return; }
                originalFilename = pf.filename.name.length ? pf.filename.name : req.form.get("originalFilename", "image.png");
                originalMime = pf.headers.get("Content-Type", "image/png");
                try { auto up = saveIrcArtOriginal(originalFilename, originalMime, data, baseUrl); originalUrl = up.url; } catch (LocalUploadException e) { res.statusCode = 502; res.writeJsonBody(Json(["error": Json(e.msg)])); return; }
            } else {
                originalFilename = req.form.get("originalFilename", "");
                originalMime = req.form.get("originalMime", "");
                originalUrl = req.form.get("originalUrl", "");
                try { originalSize = req.form.get("originalSize", "0").to!long; } catch (Exception) {}
            }
            if (auto tf = "thumbnail" in req.files) {
                import vibe.core.file : readFile;
                auto tdata = cast(const(ubyte)[])readFile(tf.tempPath);
                try { auto tup = saveIrcArtThumbnail(tdata, baseUrl); thumbnailUrl = tup.url; } catch (LocalUploadException e) { logWarn("thumbnail save failed: %s", e.msg); }
            } else { thumbnailUrl = req.form.get("thumbnailUrl", ""); }
        } else {
            auto j = req.json;
            if (j.type == Json.Type.object) {
                if ("name" in j) name = j["name"].get!string;
                if ("art" in j) art = j["art"].get!string;
                if ("params" in j) params = j["params"];
                if ("networkId" in j) networkId = j["networkId"].get!string;
                if ("buffer" in j) buffer = j["buffer"].get!string;
                if ("originalUrl" in j) originalUrl = j["originalUrl"].get!string;
                if ("thumbnailUrl" in j) thumbnailUrl = j["thumbnailUrl"].get!string;
                if ("originalFilename" in j) originalFilename = j["originalFilename"].get!string;
                if ("originalMime" in j) originalMime = j["originalMime"].get!string;
                if ("originalSize" in j) try { originalSize = j["originalSize"].get!long; } catch (Exception) {}
            }
        }
        if (art.length == 0) { res.statusCode = 400; res.writeJsonBody(Json(["error": Json("art required")])); return; }
        if (art.length > 200_000) { res.statusCode = 413; res.writeJsonBody(Json(["error": Json("Art too large")])); return; }
        if (params.toString().length > 10 * 1024) { res.statusCode = 413; res.writeJsonBody(Json(["error": Json("params too large")])); return; }
        if (name.length == 0) { import std.path : baseName, stripExtension; if (originalFilename.length > 0) name = stripExtension(baseName(originalFilename)); else name = "IRC Art"; }
        Img2IrcSaveRecord rec;
        rec.id = randomUUID().toString(); rec.userId = user.id.toString(); rec.networkId = networkId; rec.buffer = buffer; rec.name = name; rec.originalFilename = originalFilename; rec.originalMime = originalMime; rec.originalSize = originalSize; rec.originalUrl = originalUrl; rec.thumbnailUrl = thumbnailUrl; rec.art = art; rec.params = params; rec.createdAt = Clock.currTime.toUnixTime!long * 1000; rec.updatedAt = rec.createdAt; rec.deleted = false;
        try { ircArtRepo.insert(rec); } catch (Exception e) { logError("Failed to insert ircArt save: %s", e.msg); res.statusCode = 500; res.writeJsonBody(Json(["error": Json("insert failed: "~e.msg)])); return; }
        res.statusCode = 201; res.writeJsonBody(ircArtToJson(rec));
    }

    private void getIrcArtSave(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto rec = ircArtRepo.getById(user.id.toString(), req.params["id"]);
        if (rec.id.length == 0) { res.statusCode = 404; res.writeJsonBody(Json(["error": Json("not found")])); return; }
        res.writeJsonBody(ircArtToJson(rec));
    }

    private void updateIrcArtSave(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        auto id = req.params["id"];
        auto existing = ircArtRepo.getById(user.id.toString(), id);
        if (existing.id.length == 0) { res.statusCode = 404; res.writeJsonBody(Json(["error": Json("not found")])); return; }
        string name = existing.name; string art = existing.art; Json params = existing.params; string originalUrl = existing.originalUrl; string thumbnailUrl = existing.thumbnailUrl;
        bool isMultipart = false; auto ct = req.headers.get("Content-Type", ""); if (ct.indexOf("multipart/") >= 0) isMultipart = true;
        if (isMultipart) {
            if ("name" in req.form) name = req.form["name"];
            if ("art" in req.form) art = req.form["art"];
            auto pStr = req.form.get("params", ""); if (pStr.length > 0) { try { params = parseJsonString(pStr); } catch (Exception) {} }
            auto host = req.headers.get("Host", "localhost:8090"); if (host.length == 0 || host[0] == ':' || host == "127.0.0.1:5173" || host == "localhost:5173") host = "127.0.0.1:8090"; string proto = req.headers.get("X-Forwarded-Proto", "http"); if (proto.length == 0) proto = "http"; auto baseUrl = proto ~ "://" ~ host;
            if (auto pf = "original" in req.files) { import vibe.core.file : readFile; auto data = cast(const(ubyte)[])readFile(pf.tempPath); auto fn = pf.filename.name.length ? pf.filename.name : existing.originalFilename; auto mime = pf.headers.get("Content-Type", existing.originalMime); try { auto up = saveIrcArtOriginal(fn, mime, data, baseUrl); originalUrl = up.url; } catch (Exception e) { logWarn("original save on update failed: %s", e.msg); } }
            if (auto tf = "thumbnail" in req.files) { import vibe.core.file : readFile; auto tdata = cast(const(ubyte)[])readFile(tf.tempPath); try { auto tup = saveIrcArtThumbnail(tdata, baseUrl); thumbnailUrl = tup.url; } catch (Exception e) { logWarn("thumb save on update failed: %s", e.msg); } }
        } else {
            auto j = req.json; if (j.type == Json.Type.object) { if ("name" in j) name = j["name"].get!string; if ("art" in j) art = j["art"].get!string; if ("params" in j) params = j["params"]; }
        }
        if (art.length == 0) { res.statusCode = 400; res.writeJsonBody(Json(["error": Json("art required")])); return; }
        if (art.length > 200_000) { res.statusCode = 413; res.writeJsonBody(Json(["error": Json("Art too large")])); return; }
        long now = Clock.currTime.toUnixTime!long * 1000; bool ok; if (originalUrl != existing.originalUrl || thumbnailUrl != existing.thumbnailUrl) ok = ircArtRepo.updateWithFiles(user.id.toString(), id, name, art, params, originalUrl, thumbnailUrl, now); else ok = ircArtRepo.update(user.id.toString(), id, name, art, params, now);
        if (!ok) { res.statusCode = 500; res.writeJsonBody(Json(["error": Json("update failed")])); return; }
        auto updated = ircArtRepo.getById(user.id.toString(), id); res.writeJsonBody(ircArtToJson(updated));
    }

    private void deleteIrcArtSave(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User; auto id = req.params["id"]; auto rec = ircArtRepo.getById(user.id.toString(), id);
        if (rec.id.length == 0) { res.statusCode = 404; res.writeJsonBody(Json(["error": Json("not found")])); return; }
        foreach (url; [rec.originalUrl, rec.thumbnailUrl]) { if (url.length == 0) continue; auto prefix = "/uploads/"; auto pos = url.indexOf(prefix); if (pos == -1) continue; auto fname = url[pos + prefix.length .. $]; auto qIdx = fname.indexOf("?"); if (qIdx >= 0) fname = fname[0..qIdx]; if (fname.length == 0 || fname.canFind("..")) continue; auto fpath = buildPath(uploadDir(), fname); try { remove(fpath); } catch (Exception e) { logWarn("deleteIrcArtSave remove %s: %s", fpath, e.msg); } }
        if (ircArtRepo.hardDelete(user.id.toString(), id)) { res.statusCode = 204; res.writeVoidBody(); } else { res.statusCode = 404; res.writeJsonBody(Json(["error": Json("not found")])); }
    }

    /// HEAD /api/ping — lightweight connectivity check.  Unauthenticated
    /// so the frontend OnlineChecker can probe before login.
    /// Vibe.d automatically strips the body for HEAD requests on GET routes.
    private void ping(HTTPServerRequest, HTTPServerResponse res) {
        res.writeJsonBody(Json(["ping": Json("pong")]));
    }

    /// POST /api/hooks/signoz — SigNoz (Alertmanager-shape) webhook.
    ///
    /// Deliberately session-unauthenticated: SigNoz is not a website user,
    /// so this handler must never call requireAuth. The only gate is the
    /// shared bearer secret `IRCFIBER_ALERT_WEBHOOK_TOKEN` (file-backed in
    /// prod via `IRCFIBER_ALERT_WEBHOOK_TOKEN_FILE`, resolved with
    /// `ircfiber.env.envSecret` like every other secret). Each alert is
    /// queued as a `notice` LogEvent, which FiberEye announces in #staff.
    /// Never throws on a malformed body: unparseable JSON answers 400, a
    /// missing `alerts` array answers 200 with `queued: 0`.
    private void signozAlertHook(HTTPServerRequest req, HTTPServerResponse res) {
        const token = envSecret("IRCFIBER_ALERT_WEBHOOK_TOKEN", "");
        if (token.length == 0) {
            logWarn("signoz webhook: IRCFIBER_ALERT_WEBHOOK_TOKEN is not set; dropping delivery (503)");
            res.statusCode = 503;
            res.writeJsonBody(Json(["error": Json("alert webhook is not configured")]));
            return;
        }
        string presented = "";
        const auth = req.headers.get("Authorization", "");
        enum bearerPrefix = "Bearer ";
        if (auth.length > bearerPrefix.length && auth[0 .. bearerPrefix.length] == bearerPrefix)
            presented = auth[bearerPrefix.length .. $];
        if (presented.length != token.length || presented != token) {
            res.statusCode = 401;
            res.writeJsonBody(Json(["error": Json("unauthorized")]));
            return;
        }
        Json body_;
        try {
            body_ = req.json;
        } catch (Exception) {
            res.statusCode = 400;
            res.writeJsonBody(Json(["error": Json("invalid body")]));
            return;
        }
        if (body_.type != Json.Type.object) {
            res.writeJsonBody(Json(["ok": Json(true), "queued": Json(0)]));
            return;
        }
        const topStatus = signozStr(body_, "status");
        Json alerts = Json.undefined;
        try {
            alerts = body_["alerts"];
        } catch (Exception) {
            alerts = Json.undefined;
        }
        if (alerts.type != Json.Type.array) {
            res.writeJsonBody(Json(["ok": Json(true), "queued": Json(0)]));
            return;
        }
        const now = Clock.currTime.toUnixTime!long * 1000;
        long queued = 0;
        long dropped = 0;
        foreach (a; alerts) {
            if (a.type != Json.Type.object) continue;
            if (queued >= SIGNOZ_HOOK_MAX_ALERTS) { dropped++; continue; }
            LogEvent ev;
            ev.type = "notice";
            ev.ts = now;
            ev.actor = "signoz";
            ev.text = signozAlertLine(a, topStatus);
            pushLogEvent(redis, ev);
            queued++;
        }
        if (dropped > 0)
            logWarn("signoz webhook: dropped %d alerts over the %d-event cap", dropped, SIGNOZ_HOOK_MAX_ALERTS);
        res.writeJsonBody(Json(["ok": Json(true), "queued": Json(queued)]));
    }

    /// Never-throwing single-level string lookup for the SigNoz payload:
    /// "" unless `j` is an object holding a string at `key`.
    private static string signozStr(Json j, string key) {
        try {
            if (j.type != Json.Type.object) return "";
            auto v = j[key];
            return v.type == Json.Type.string ? v.get!string : "";
        } catch (Exception) {
            return "";
        }
    }

    /// Never-throwing single-level object lookup for the SigNoz payload:
    /// `Json.undefined` unless `j` is an object holding an object at `key`.
    private static Json signozSection(Json j, string key) {
        try {
            if (j.type != Json.Type.object) return Json.undefined;
            auto v = j[key];
            return v.type == Json.Type.object ? v : Json.undefined;
        } catch (Exception) {
            return Json.undefined;
        }
    }

    /// One IRC-safe line for a single SigNoz alert:
    /// `[FIRING critical] <alertname> — <summary>` (`RESOLVED` on resolve),
    /// falling back to the first 200 chars of `description`, then to the
    /// alertname alone. Newlines are flattened (sanitizeLine) and the whole
    /// line is capped at 400 chars.
    private static string signozAlertLine(Json a, string topStatus) {
        const labels = signozSection(a, "labels");
        const annotations = signozSection(a, "annotations");
        auto status = signozStr(a, "status");
        if (status.length == 0) status = topStatus;
        const resolved = status.toLower() == "resolved";
        auto name = signozStr(labels, "alertname");
        if (name.length == 0) name = "unknown";
        auto severity = signozStr(labels, "severity");
        if (severity.length == 0) severity = "unknown";
        const summary = sanitizeLine(signozStr(annotations, "summary"));
        const desc = sanitizeLine(signozStr(annotations, "description"));
        string line = "[" ~ (resolved ? "RESOLVED" : "FIRING") ~ " " ~ severity ~ "] " ~ name;
        string detail = summary;
        if (detail.length == 0 && desc.length > 0) detail = clip(desc, 200);
        if (detail.length > 0) line ~= " — " ~ detail;
        return clip(line, 400);
    }

    private void versionCheck(HTTPServerRequest req, HTTPServerResponse res) {
        // Gateway's own build info (from the IRCFIBER_BUILD_* env the image sets)
        auto bi = buildInfo();
        auto gateway = Json.emptyObject;
        gateway["service"] = Json("irc-fiber-gateway");
        gateway["version"] = Json(bi.version_);
        gateway["commit"] = Json(bi.commit);
        gateway["short"] = Json(bi.shortHash);
        gateway["describe"] = Json(bi.describe);
        gateway["branch"] = Json(bi.branch);
        gateway["builtAt"] = Json(bi.builtAt);
        gateway["builtHost"] = Json(bi.builtHost);
        gateway["message"] = Json(bi.message);
        gateway["commitUrl"] = Json(bi.commitUrl);
        Json[] enginesJson;
        try {
            auto servers = serverRegistry.getAllServers();
            foreach (s; servers) {
                auto o = Json.emptyObject;
                o["serverId"] = Json(s.serverId);
                o["isHealthy"] = Json(s.isHealthy);
                o["gitHash"] = Json(s.gitHash);
                o["gitShort"] = Json(s.gitShort);
                o["gitDescribe"] = Json(s.gitDescribe);
                o["gitBranch"] = Json(s.gitBranch);
                o["buildTime"] = Json(s.buildTime);
                o["version"] = Json(s.version_);
                o["gitMessage"] = Json(s.gitMessage);
                o["gitCommitUrl"] = Json(s.gitCommitUrl);
                o["lastHeartbeat"] = Json(s.lastHeartbeat);
                enginesJson ~= o;
            }
        } catch (Exception) {}
        auto result = Json.emptyObject;
        result["gateway"] = gateway;
        result["engines"] = Json(enginesJson);
        result["commit"] = Json(bi.commit);
        result["short"] = Json(bi.shortHash);
        result["describe"] = Json(bi.describe);
        result["branch"] = Json(bi.branch);
        result["builtAt"] = Json(bi.builtAt);
        result["version"] = Json(bi.version_);
        result["message"] = Json(bi.message);
        result["commitUrl"] = Json(bi.commitUrl);
        result["versionScheme"] = Json(2);
        res.writeJsonBody(result);
    }

    private void healthCheck(HTTPServerRequest, HTTPServerResponse res) {
        auto services = Json.emptyObject;
        bool allOk = true;

        // Check MongoDB
        try {
            auto db = AppMongoConnection.getDb();
            const _ = db["networks"].findOne(Bson.emptyObject);
            services["mongo"] = Json(["ok": Json(true)]);
        } catch (Exception e) {
            services["mongo"] = Json(["ok": Json(false), "error": Json(e.msg)]);
            allOk = false;
        }

        // Check Redis
        try {
            redis.getDb().exists("health_check_test");
            services["redis"] = Json(["ok": Json(true)]);
        } catch (Exception e) {
            services["redis"] = Json(["ok": Json(false), "error": Json(e.msg)]);
            allOk = false;
        }

        // NEW: Check connection servers
        auto healthyServers = serverRegistry.getHealthyServers();
        services["connectionServers"] = Json([
            "ok": Json(healthyServers.length > 0),
            "total": Json(serverRegistry.getAllServers().length),
            "healthy": Json(healthyServers.length)
        ]);
        if (healthyServers.length == 0) allOk = false;

        // T1-W3: gateway contention metrics — session queue depth / drops
        if (sessionManager !is null) {
            try {
                auto stats = sessionManager.broadcastStats();
                services["sessions"] = Json([
                    "ok": Json(true),
                    "total": Json(stats.total),
                    "maxDepth": Json(stats.maxDepth),
                    "lastEnqueuedEid": Json(stats.lastEnqueuedEid),
                    "lastDeliveredEid": Json(stats.lastDeliveredEid),
                    "backpressured": Json(stats.backpressured),
                    "ghosts": Json(stats.ghosts)
                ]);
            } catch (Exception e) {
                services["sessions"] = Json(["ok": Json(false), "error": Json(e.msg)]);
            }
        }

        res.writeJsonBody(Json([
            "status": Json(allOk ? "healthy" : "degraded"),
            "service": Json("irc-fiber-gateway"),
            "services": services
        ]));
    }

    private NetworkStateSnapshot loadSnapshot(string networkId) {
        // NEW: Try server-aware key first, then legacy
        auto serverId = serverRegistry.getServerForNetwork(networkId);
        
        if (serverId.length > 0) {
            auto fields = redis.hgetAll(RedisKeys.state(serverId, networkId));
            if ("data" in fields) {
                try { return NetworkStateSnapshot.fromJson(parseJson(fields["data"])); }
                catch (Exception e) {}
            }
        }
        
        // Legacy fallback
        auto fields = redis.hgetAll(RedisKeys.state_legacy(networkId));
        if ("data" in fields) {
            try { return NetworkStateSnapshot.fromJson(parseJson(fields["data"])); }
            catch (Exception e) {}
        }
        return NetworkStateSnapshot.init;
    }
}

@("validateUpload accepts any mime under 50MB (universal)")
unittest {
    assert(RESTAPI.validateUpload("image/png", 1024) is null);
    assert(RESTAPI.validateUpload("image/jpeg", 32 * 1024 * 1024) is null);
    assert(RESTAPI.validateUpload("text/plain", 1024) is null);
    assert(RESTAPI.validateUpload("text/x-python", 1024, "script.py") is null);
    assert(RESTAPI.validateUpload("application/json", 1024) is null);
    assert(RESTAPI.validateUpload("", 1024, "notes.txt") is null);
    assert(RESTAPI.validateUpload("application/pdf", 10) is null);
    assert(RESTAPI.validateUpload("video/mp4", 10) is null);
    assert(RESTAPI.validateUpload("application/zip", 10, "archive.zip") is null);
    assert(RESTAPI.validateUpload("application/octet-stream", 10, "blob.bin") is null);
    assert(RESTAPI.validateUpload("", 10) is null);
}

@("validateUpload rejects empty and oversize files (50MB cap)")
unittest {
    assert(RESTAPI.validateUpload("image/png", 0) !is null);
    assert(RESTAPI.validateUpload("application/pdf", 51 * 1024 * 1024) !is null);
    assert(RESTAPI.validateUpload("image/png", 51 * 1024 * 1024) !is null);
}

// Regression: refresh on a low-volume channel like /irc/SuperNets/channel/zod
// surfaced each Redis message twice because the engine writes every event to
// BOTH Redis and MongoDB, so when Redis returned 9/16 messages and the REST
// handler fell through to MongoDB's "newest N", MongoDB returned those same
// 9/16 again. The frontend's setMessages then rendered each one twice.
// Fix: RESTAPI.dedupMessages drops MongoDB-side messages whose msgid/eid is
// already in the Redis set.
@("dedupMessages drops MongoDB entries whose msgid matches Redis")
unittest {
    auto existing = [
        Json(["m": Json("msg-a"), "eid": Json(100)]),
        Json(["m": Json("msg-b"), "eid": Json(101)]),
    ];
    auto older = [
        Json(["m": Json("msg-a"), "eid": Json(100)]),  // dup
        Json(["m": Json("msg-c"), "eid": Json(102)]),  // new
        Json(["m": Json("msg-b"), "eid": Json(101)]),  // dup
    ];
    const deduped = RESTAPI.dedupMessages(existing, older);
    assert(deduped.length == 1);
    assert(deduped[0]["m"].get!string == "msg-c");
}

@("dedupMessages falls back to eid match when msgid is absent")
unittest {
    // Legacy MongoDB entries may lack msgid (only eid). Make sure eid dedup
    // catches them too — otherwise a 200-row page would still dup those.
    auto existing = [
        Json(["eid": Json(42), "x": Json("hello")]),
    ];
    auto older = [
        Json(["eid": Json(42), "x": Json("hello")]),  // dup by eid
        Json(["eid": Json(43), "x": Json("world")]),  // new
    ];
    const deduped = RESTAPI.dedupMessages(existing, older);
    assert(deduped.length == 1);
    assert(deduped[0]["eid"].get!long == 43);
}

@("dedupMessages returns the input unchanged when no overlap")
unittest {
    auto existing = [
        Json(["m": Json("a"), "eid": Json(1)]),
    ];
    auto older = [
        Json(["m": Json("b"), "eid": Json(2)]),
        Json(["m": Json("c"), "eid": Json(3)]),
    ];
    const deduped = RESTAPI.dedupMessages(existing, older);
    assert(deduped.length == 2);
}