module ircfiber.web.admin;

import std.string : strip;
import std.uuid : parseUUID;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse, render, staticTemplate;
import vibe.http.router : URLRouter;
import vibe.core.log : logInfo, logWarn;

import ircfiber.auth : authenticateRequest, requireAuth, requireAdmin, isAdmin;
import ircfiber.db.user : UserRepository;
import ircfiber.irc.engine_janitor : EngineJanitor;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.api : apiMe, apiDashboard,
    apiServers, apiServerHost, apiReassignServer, apiReassignAssignment,
    apiRemoveAssignment, apiEngineConfig, apiHostDisconnect, apiHostReconnect,
    apiHostDeleteNetwork, apiAssignmentDelete, apiRouting,
    apiFiberConfig, apiFiberConfigSet,
    apiMullvadStatus, apiMullvadRestart, apiMullvadTest, apiMullvadIrcTest, apiMullvadTestAll, apiMullvadSlotExit,
    apiMullvadServerEgressSet, apiMullvadServerEgressClear, apiNetworkEgressSet,
    apiUsersList, apiUsersBulkDelete, apiUserCreate, apiUserDetail, apiUserUpdate, apiUserDelete, apiRolesList,
    apiResetPassword,
    apiSessions, apiSessionsClear, apiSessionsClearUser, apiSessionsClearOne,
    apiUploadsList, apiUploadDelete;

import ircfiber.web.admin.helpers : captureSessionMeta, touchSessionAccess;
import ircfiber.web.admin.auth : adminLoginPage, adminLoginPost, adminLogout,
    adminImpersonate, adminStopImpersonating;

import ircfiber.web.admin.janitor : apiJanitorStatus, apiJanitorEvents,
    apiJanitorReap, apiJanitorCycle;

import ircfiber.web.admin.mongo : apiMongoStatus, apiMongoCollections,
    apiMongoCollectionDetail, apiMongoQuery;
import ircfiber.web.admin.redis : apiRedisInfo, apiRedisSummary, apiRedisKeys,
    apiRedisKeyDetail, apiRedisSlowlog, apiRedisPubsub, apiRedisClients;
import ircfiber.web.admin.replication : apiReplicationStatus;
import ircfiber.web.admin.bnc : apiBncOverview, apiBncKick, apiBncRevoke,
    apiBncSeenClear, apiBncSeenForget;
import ircfiber.web.admin.ircd : apiIrcdStatus, apiIrcdChannels, apiIrcdChannel,
    apiIrcdBans, apiIrcdBanAdd, apiIrcdBanDelete, apiIrcdRehash, apiIrcdConfig;
import ircfiber.web.admin.nickserv : apiNsAccounts, apiNsAccount, apiNsSuspend,
    apiNsUnsuspend, apiNsDrop, apiNsResetPassword, apiNsLogout, apiNsLink, apiNsUnlink,
    apiNsUnprovisioned, apiNsCreate;
import ircfiber.web.admin.support : apiSupportIssuesList, apiSupportIssueDetail,
    apiSupportIssueUpdate, apiSupportIssueComment, apiSupportIssueDelete,
    apiSupportBotStatus, apiSupportBotReconnect, apiSupportBotRejoin, apiSupportBotAnnounce;
import ircfiber.web.admin.backups : apiBackupsOverview, apiBackupsRun, apiBackupsSuspend, apiBackupsLogs;
import ircfiber.web.admin.emails : apiEmailsOverview, apiEmailsTest,
    apiEmailsPendingResend, apiEmailsPendingRevoke, apiEmailsCooldownClear,
    apiEmailsIpLimitClear;
import ircfiber.web.admin.logs : apiLogsQueryRange;
import ircfiber.web.admin.motd : apiMotdList, apiMotdCreate, apiMotdUpdate,
    apiMotdDelete, apiMotdRotate;
/// Admin controller — orchestrates the admin submodules.
/// All routes are gated by `adminWrap` (requireAuth + requireAdmin + touch).
/// Diet templates are kept as a no-JS fallback until each page is ported
/// to the Svelte SPA in `frontend/src/admin/`.
final class AdminController {
    private RedisStorage redis;
    private ServerRegistry serverRegistry;
    private EngineJanitor janitor;

    /// Creates the admin controller bound to the given Redis storage.
    this(RedisStorage redis) {
        this.redis = redis;
        this.serverRegistry = new ServerRegistry(redis);
    }

    /// Lazy accessor for the shared EngineJanitor. Created on first admin
    /// request so the gateway's own janitor task (constructed in app.d)
    /// and `/api/admin/janitor/cycle` route share the same instance —
    /// no risk of two janitors racing on the same Redis state.
    private EngineJanitor getJanitor() {
        if (janitor is null) janitor = new EngineJanitor(redis);
        return janitor;
    }

    /// Registers every admin route on the given router. Mixes diet-template
    /// routes (under /admin/*) with the new JSON API (under /api/admin/*).
    void registerRoutes(URLRouter router) {
        // ── Public (no auth) ──────────────────────────────────────
        router.get("/admin/login",  &adminLoginPage);
        router.post("/admin/login", &adminLoginPostRoute);
        router.get("/admin/logout", &adminLogout);

        // ── SPA shell - serves admin.html; /admin and /admin/ both
        //    must route here. The wildcard /admin/* below handles
        //    deeper paths.
        router.get("/admin",  &adminWrap!adminSpaShell);
        router.get("/admin/", &adminWrap!adminSpaShell);

        // ── Impersonation (must still serve from /admin/* for cookie
        //    scope) ───────────────────────────────────────────────
        router.get("/admin/users/:id/impersonate", &adminWrap!adminImpersonate);
        router.get("/admin/stop-impersonating", &adminStopImpersonating);

        // ── SPA shell — serves admin.html for any /admin/* that
        //    isn't matched above. This must be registered LAST so
        //    the specific routes above take precedence. ───────────
        router.get("/admin/*", &adminWrap!adminSpaShell);

        // ── JSON API for the Svelte SPA ──────────────────────────
        router.get("/api/admin/me", &adminWrap!apiMeRoute);
        router.get("/api/admin/dashboard", &adminWrap!apiDashboardRoute);

        router.get("/api/admin/servers", &adminWrap!apiServersRoute);
        router.get("/api/admin/servers/host/:host", &adminWrap!apiServerHostRoute);
        router.post("/api/admin/servers/:id/reassign", &adminWrap!apiReassignServerRoute);
        router.post("/api/admin/servers/assignments/delete-network/:networkId", &adminWrap!apiAssignmentDeleteRoute);
        router.delete_("/api/admin/servers/assignments/:networkId", &adminWrap!apiAssignmentDeleteRoute);
        router.post("/api/admin/servers/assignments/delete", &adminWrap!apiAssignmentDeleteRoute);
        router.post("/api/admin/servers/:id/config", &adminWrap!apiEngineConfigRoute);
        router.post("/api/admin/servers/host/:host/disconnect/:networkId", &adminWrap!apiHostDisconnectRoute);
        router.post("/api/admin/servers/host/:host/reconnect/:networkId", &adminWrap!apiHostReconnectRoute);
        router.post("/api/admin/servers/host/:host/delete-network/:networkId", &adminWrap!apiHostDeleteNetworkRoute);
        router.get("/api/admin/config/fiber", &adminWrap!apiFiberConfigRoute);
        router.post("/api/admin/config/fiber", &adminWrap!apiFiberConfigSetRoute);
        router.get("/api/admin/mullvad/status", &adminWrap!apiMullvadStatusRoute);
        router.post("/api/admin/mullvad/:label/restart", &adminWrap!apiMullvadRestartRoute);
        router.post("/api/admin/mullvad/:label/exit", &adminWrap!apiMullvadSlotExitRoute);
        router.post("/api/admin/mullvad/:label/test", &adminWrap!apiMullvadTestRoute);
        router.post("/api/admin/mullvad/:label/irc-test", &adminWrap!apiMullvadIrcTestRoute);
        router.post("/api/admin/mullvad/test-all", &adminWrap!apiMullvadTestAllRoute);
        router.post("/api/admin/mullvad/server/:serverId/egress", &adminWrap!apiMullvadServerEgressSetRoute);
        router.delete_("/api/admin/mullvad/server/:serverId/egress", &adminWrap!apiMullvadServerEgressClearRoute);
        router.post("/api/admin/networks/:id/egress", &adminWrap!apiNetworkEgressSetRoute);

        router.post("/api/admin/users", &adminWrap!apiUserCreateRoute);
        router.post("/api/admin/users/bulk-delete", &adminWrap!apiUsersBulkDeleteRoute);
        router.get("/api/admin/users", &adminWrap!apiUsersListRoute);
        router.get("/api/admin/users/:id", &adminWrap!apiUserDetailRoute);
        router.post("/api/admin/users/:id", &adminWrap!apiUserUpdateRoute);
        router.post("/api/admin/users/:id/delete", &adminWrap!apiUserDeleteRoute);
        router.post("/api/admin/users/:id/reset-password", &adminWrap!apiResetPasswordRoute);
        router.get("/api/admin/roles", &adminWrap!apiRolesListRoute);

        router.get("/api/admin/sessions", &adminWrap!apiSessionsRoute);
        router.post("/api/admin/sessions/clear", &adminWrap!apiSessionsClearRoute);
        router.post("/api/admin/sessions/clear/:uid", &adminWrap!apiSessionsClearUserRoute);
        router.post("/api/admin/sessions/clear-one/:sid", &adminWrap!apiSessionsClearOneRoute);

        router.get("/api/admin/uploads", &adminWrap!apiUploadsListRoute);
        router.post("/api/admin/uploads/:id/delete", &adminWrap!apiUploadDeleteRoute);

        // Support issues (Help & Feedback reports)
        router.get("/api/admin/support/issues", &adminWrap!apiSupportIssuesListRoute);
        router.get("/api/admin/support/issues/:id", &adminWrap!apiSupportIssueDetailRoute);
        router.post("/api/admin/support/issues/:id", &adminWrap!apiSupportIssueUpdateRoute);
        router.post("/api/admin/support/issues/:id/comments", &adminWrap!apiSupportIssueCommentRoute);
        router.post("/api/admin/support/issues/:id/delete", &adminWrap!apiSupportIssueDeleteRoute);
        // #support services bot (heartbeat + control; shown on the IRCD page)
        router.get("/api/admin/support/bot", &adminWrap!apiSupportBotStatusRoute);
        router.post("/api/admin/support/bot/reconnect", &adminWrap!apiSupportBotReconnectRoute);
        router.post("/api/admin/support/bot/rejoin", &adminWrap!apiSupportBotRejoinRoute);
        router.post("/api/admin/support/bot/announce", &adminWrap!apiSupportBotAnnounceRoute);

        // MOTD templates (served per connect by the engine, rotated into the ircd)
        router.get("/api/admin/motd", &adminWrap!apiMotdListRoute);
        router.post("/api/admin/motd", &adminWrap!apiMotdCreateRoute);
        router.post("/api/admin/motd/rotate", &adminWrap!apiMotdRotateRoute);
        router.post("/api/admin/motd/:id", &adminWrap!apiMotdUpdateRoute);
        router.post("/api/admin/motd/:id/delete", &adminWrap!apiMotdDeleteRoute);

        // Bouncer: attached clients + accounts with a bouncer password
        router.get("/api/admin/bnc", &adminWrap!apiBncOverviewRoute);
        router.post("/api/admin/bnc/clients/:sid/kick", &adminWrap!apiBncKickRoute);
        router.post("/api/admin/bnc/networks/:id/revoke", &adminWrap!apiBncRevokeRoute);
        router.post("/api/admin/bnc/networks/:id/seen/clear", &adminWrap!apiBncSeenClearRoute);
        router.post("/api/admin/bnc/networks/:id/seen/:clientId/forget", &adminWrap!apiBncSeenForgetRoute);

        // Mongo monitor
        router.get("/api/admin/mongo/status", &adminWrap!apiMongoStatusRoute);
        router.get("/api/admin/mongo/collections", &adminWrap!apiMongoCollectionsRoute);
        router.get("/api/admin/mongo/collections/:name", &adminWrap!apiMongoCollectionDetailRoute);
        router.post("/api/admin/mongo/query", &adminWrap!apiMongoQueryRoute);

        // Redis monitor
        router.get("/api/admin/redis/info", &adminWrap!apiRedisInfoRoute);
        router.get("/api/admin/redis/summary", &adminWrap!apiRedisSummaryRoute);
        router.get("/api/admin/redis/keys", &adminWrap!apiRedisKeysRoute);
        router.get("/api/admin/redis/keys/:key", &adminWrap!apiRedisKeyDetailRoute);
        router.get("/api/admin/redis/slowlog", &adminWrap!apiRedisSlowlogRoute);
        router.get("/api/admin/redis/pubsub", &adminWrap!apiRedisPubsubRoute);
        router.get("/api/admin/redis/clients", &adminWrap!apiRedisClientsRoute);

        // Replication monitor (Mongo rs0 + Redis global keys / shake)
        router.get("/api/admin/replication", &adminWrap!apiReplicationStatusRoute);

        // Backups (k8s CronJob state + published run history; see web.admin.backups)
        router.get("/api/admin/backups", &adminWrap!apiBackupsOverviewRoute);
        router.get("/api/admin/backups/:name/logs", &adminWrap!apiBackupsLogsRoute);
        router.post("/api/admin/backups/:name/run", &adminWrap!apiBackupsRunRoute);
        router.post("/api/admin/backups/:name/suspend", &adminWrap!apiBackupsSuspendRoute);

        // Emails (signup verification: provider state, send log, pending queue)
        router.get("/api/admin/emails", &adminWrap!apiEmailsOverviewRoute);
        router.post("/api/admin/emails/test", &adminWrap!apiEmailsTestRoute);
        router.post("/api/admin/emails/pending/:id/resend", &adminWrap!apiEmailsPendingResendRoute);
        router.post("/api/admin/emails/pending/:id/revoke", &adminWrap!apiEmailsPendingRevokeRoute);
        router.post("/api/admin/emails/cooldown/clear", &adminWrap!apiEmailsCooldownClearRoute);
        router.post("/api/admin/emails/ip-limit/clear", &adminWrap!apiEmailsIpLimitClearRoute);

        // Engine janitor control plane
        router.get("/api/admin/janitor/status", &adminWrap!apiJanitorStatusRoute);
        router.get("/api/admin/janitor/events", &adminWrap!apiJanitorEventsRoute);
        router.post("/api/admin/janitor/reap/:serverId", &adminWrap!apiJanitorReapRoute);
        router.post("/api/admin/janitor/cycle", &adminWrap!apiJanitorCycleRoute);

        // IRCd (InspIRCd) management: overview, bans, rehash, config viewer
        router.get("/api/admin/ircd/status", &adminWrap!apiIrcdStatusRoute);
        router.get("/api/admin/ircd/channels", &adminWrap!apiIrcdChannelsRoute);
        router.get("/api/admin/ircd/channel", &adminWrap!apiIrcdChannelRoute);
        router.get("/api/admin/ircd/bans", &adminWrap!apiIrcdBansRoute);
        router.post("/api/admin/ircd/bans", &adminWrap!apiIrcdBanAddRoute);
        router.post("/api/admin/ircd/bans/delete", &adminWrap!apiIrcdBanDeleteRoute);
        router.post("/api/admin/ircd/rehash", &adminWrap!apiIrcdRehashRoute);
        router.get("/api/admin/ircd/config", &adminWrap!apiIrcdConfigRoute);

        // NickServ (Anope) account management, on the same IRCD page
        router.get("/api/admin/ircd/nickserv/accounts", &adminWrap!apiNsAccountsRoute);
        router.get("/api/admin/ircd/nickserv/account", &adminWrap!apiNsAccountRoute);
        router.post("/api/admin/ircd/nickserv/suspend", &adminWrap!apiNsSuspendRoute);
        router.post("/api/admin/ircd/nickserv/unsuspend", &adminWrap!apiNsUnsuspendRoute);
        router.post("/api/admin/ircd/nickserv/drop", &adminWrap!apiNsDropRoute);
        router.post("/api/admin/ircd/nickserv/password", &adminWrap!apiNsResetPasswordRoute);
        router.post("/api/admin/ircd/nickserv/logout", &adminWrap!apiNsLogoutRoute);
        router.post("/api/admin/ircd/nickserv/link", &adminWrap!apiNsLinkRoute);
        router.post("/api/admin/ircd/nickserv/unlink", &adminWrap!apiNsUnlinkRoute);
        router.get("/api/admin/ircd/nickserv/unprovisioned", &adminWrap!apiNsUnprovisionedRoute);
        router.post("/api/admin/ircd/nickserv/create", &adminWrap!apiNsCreateRoute);

        // Logs (SigNoz) — gateway-side proxy so the browser needs no
        // SigNoz route or key of its own (see web.admin.logs).
        // Only query_range is proxied: the installed SigNoz (v0.138)
        // no longer serves /api/v1/services or /api/v1/user, and the
        // response is reshaped to the legacy list envelope the UI parses.
        router.post("/api/admin/logs/query_range", &adminWrap!apiLogsQueryRange);
    }

private:
    // Wrapper — auth, admin role, session touch, then handler
    // ────────────────────────────────────────────────────────────
    template adminWrap(alias handler) {
        void adminWrap(scope HTTPServerRequest req, scope HTTPServerResponse res) {
            requireAuth(req, res);
            if (res.headerWritten) return;
            requireAdmin(req, res);
            if (res.headerWritten) return;
            touchSessionAccess(req);
            handler(req, res);
        }
    }

    // Login route — passes redis to adminLoginPost for session culling
    void adminLoginPostRoute(HTTPServerRequest req, HTTPServerResponse res) {
        adminLoginPost(req, res, redis);
    }

    // Diet-template handlers — bind `redis` + `serverRegistry` to the
    // existing free functions in `admin/*.d`.
    // (Diet template routes removed in Phase 3 — all pages now use the
    //  Svelte SPA. The handler functions in users.d / servers.d / sessions.d
    //  / uploads.d are kept as they export shared types and helpers used by
    //  api.d / mongo.d / redis.d; their diet-rendering functions are now
    //  dead code pending future cleanup.)

    // JSON API handlers — bind storage objects to free functions
    void apiMeRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMe(req, res); }
    void apiBncOverviewRoute(HTTPServerRequest req, HTTPServerResponse res) { apiBncOverview(req, res, redis); }
    void apiBncKickRoute(HTTPServerRequest req, HTTPServerResponse res) { apiBncKick(req, res, redis); }
    void apiBncRevokeRoute(HTTPServerRequest req, HTTPServerResponse res) { apiBncRevoke(req, res, redis); }
    void apiBncSeenClearRoute(HTTPServerRequest req, HTTPServerResponse res) { apiBncSeenClear(req, res, redis); }
    void apiBncSeenForgetRoute(HTTPServerRequest req, HTTPServerResponse res) { apiBncSeenForget(req, res, redis); }
    void apiIrcdStatusRoute(HTTPServerRequest req, HTTPServerResponse res) { apiIrcdStatus(req, res); }
    void apiIrcdChannelsRoute(HTTPServerRequest req, HTTPServerResponse res) { apiIrcdChannels(req, res); }
    void apiIrcdChannelRoute(HTTPServerRequest req, HTTPServerResponse res) { apiIrcdChannel(req, res); }
    void apiIrcdBansRoute(HTTPServerRequest req, HTTPServerResponse res) { apiIrcdBans(req, res); }
    void apiIrcdBanAddRoute(HTTPServerRequest req, HTTPServerResponse res) { apiIrcdBanAdd(req, res); }
    void apiIrcdBanDeleteRoute(HTTPServerRequest req, HTTPServerResponse res) { apiIrcdBanDelete(req, res); }
    void apiIrcdRehashRoute(HTTPServerRequest req, HTTPServerResponse res) { apiIrcdRehash(req, res); }
    void apiIrcdConfigRoute(HTTPServerRequest req, HTTPServerResponse res) { apiIrcdConfig(req, res); }
    void apiMotdListRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMotdList(req, res, redis); }
    void apiMotdCreateRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMotdCreate(req, res, redis); }
    void apiMotdUpdateRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMotdUpdate(req, res, redis); }
    void apiMotdDeleteRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMotdDelete(req, res, redis); }
    void apiMotdRotateRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMotdRotate(req, res, redis); }
    // Needs redis: the inventory response also reports provisioning health
    // (outcome counters, orphan pending credentials, unprovisioned users).
    void apiNsAccountsRoute(HTTPServerRequest req, HTTPServerResponse res) { apiNsAccounts(req, res, redis); }
    void apiNsAccountRoute(HTTPServerRequest req, HTTPServerResponse res) { apiNsAccount(req, res); }
    void apiNsSuspendRoute(HTTPServerRequest req, HTTPServerResponse res) { apiNsSuspend(req, res); }
    void apiNsUnsuspendRoute(HTTPServerRequest req, HTTPServerResponse res) { apiNsUnsuspend(req, res); }
    void apiNsLogoutRoute(HTTPServerRequest req, HTTPServerResponse res) { apiNsLogout(req, res); }
    // Drop and password reset also rewrite the owning user's SASL credential,
    // so they need the same storage objects the provisioner uses.
    void apiNsDropRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiNsDrop(req, res, redis, serverRegistry);
    }
    void apiNsResetPasswordRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiNsResetPassword(req, res, redis, serverRegistry);
    }
    // Linking writes the user's SASL credential and reconnects their session.
    void apiNsLinkRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiNsLink(req, res, redis, serverRegistry);
    }
    void apiNsUnlinkRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiNsUnlink(req, res, redis, serverRegistry);
    }
    // The unprovisioned list reads the skip markers; creating an account runs
    // the provisioner, which writes the credential and reconnects the engine.
    void apiNsUnprovisionedRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiNsUnprovisioned(req, res, redis);
    }
    void apiNsCreateRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiNsCreate(req, res, redis, serverRegistry);
    }
    void apiDashboardRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiDashboard(req, res, redis, serverRegistry);
    }
    void apiServersRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiServers(req, res, redis, serverRegistry);
    }
    void apiServerHostRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiServerHost(req, res, redis, serverRegistry);
    }
    void apiReassignServerRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiReassignServer(req, res, serverRegistry);
    }
    void apiReassignAssignmentRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiReassignAssignment(req, res, serverRegistry);
    }
    void apiRemoveAssignmentRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiRemoveAssignment(req, res, redis, serverRegistry);
    }
    void apiAssignmentDeleteRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiAssignmentDelete(req, res, redis, serverRegistry);
    }
    void apiEngineConfigRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiEngineConfig(req, res, serverRegistry);
    }
    void apiHostDisconnectRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiHostDisconnect(req, res, redis, serverRegistry);
    }
    void apiHostReconnectRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiHostReconnect(req, res, redis, serverRegistry);
    }
    void apiHostDeleteNetworkRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiHostDeleteNetwork(req, res, redis, serverRegistry);
    }
    void apiRoutingRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiRouting(req, res, serverRegistry);
    }
    void apiFiberConfigRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiFiberConfig(req, res, redis);
    }
    void apiFiberConfigSetRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiFiberConfigSet(req, res, redis, serverRegistry);
    }
    void apiMullvadStatusRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMullvadStatus(req, res, redis, serverRegistry); }
    void apiMullvadRestartRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMullvadRestart(req, res, redis, serverRegistry); }
    void apiMullvadSlotExitRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMullvadSlotExit(req, res, redis, serverRegistry); }
    void apiMullvadTestRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMullvadTest(req, res); }
    void apiMullvadIrcTestRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMullvadIrcTest(req, res); }
    void apiMullvadTestAllRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMullvadTestAll(req, res); }
    void apiMullvadServerEgressSetRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMullvadServerEgressSet(req, res, redis, serverRegistry); }
    void apiMullvadServerEgressClearRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMullvadServerEgressClear(req, res, redis, serverRegistry); }
    void apiNetworkEgressSetRoute(HTTPServerRequest req, HTTPServerResponse res) { apiNetworkEgressSet(req, res, redis, serverRegistry); }
    void apiUsersListRoute(HTTPServerRequest req, HTTPServerResponse res) { apiUsersList(req, res); }
    void apiUserCreateRoute(HTTPServerRequest req, HTTPServerResponse res) { apiUserCreate(req, res); }
    void apiUsersBulkDeleteRoute(HTTPServerRequest req, HTTPServerResponse res) { apiUsersBulkDelete(req, res, redis, serverRegistry); }
    void apiUserDetailRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiUserDetail(req, res, redis);
    }
    void apiUserUpdateRoute(HTTPServerRequest req, HTTPServerResponse res) { apiUserUpdate(req, res); }
    void apiRolesListRoute(HTTPServerRequest req, HTTPServerResponse res) { apiRolesList(req, res); }
    void apiUserDeleteRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiUserDelete(req, res, redis, serverRegistry);
    }
    void apiResetPasswordRoute(HTTPServerRequest req, HTTPServerResponse res) { apiResetPassword(req, res); }
    void apiSessionsRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSessions(req, res, redis); }
    void apiSessionsClearRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSessionsClear(req, res, redis); }
    void apiSessionsClearUserRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiSessionsClearUser(req, res, redis);
    }
    void apiSessionsClearOneRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiSessionsClearOne(req, res, redis);
    }
    void apiUploadsListRoute(HTTPServerRequest req, HTTPServerResponse res) { apiUploadsList(req, res); }
    void apiUploadDeleteRoute(HTTPServerRequest req, HTTPServerResponse res) { apiUploadDelete(req, res); }

    // Support issues
    void apiSupportIssuesListRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSupportIssuesList(req, res); }
    void apiSupportIssueDetailRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSupportIssueDetail(req, res); }
    void apiSupportIssueUpdateRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSupportIssueUpdate(req, res, redis); }
    void apiSupportIssueCommentRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSupportIssueComment(req, res, redis); }
    void apiSupportIssueDeleteRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSupportIssueDelete(req, res); }
    void apiSupportBotStatusRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSupportBotStatus(req, res, redis); }
    void apiSupportBotReconnectRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSupportBotReconnect(req, res, redis); }
    void apiSupportBotRejoinRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSupportBotRejoin(req, res, redis); }
    void apiSupportBotAnnounceRoute(HTTPServerRequest req, HTTPServerResponse res) { apiSupportBotAnnounce(req, res, redis); }

    // Mongo
    void apiMongoStatusRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMongoStatus(req, res); }
    void apiMongoCollectionsRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMongoCollections(req, res); }
    void apiMongoCollectionDetailRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiMongoCollectionDetail(req, res);
    }
    void apiMongoQueryRoute(HTTPServerRequest req, HTTPServerResponse res) { apiMongoQuery(req, res); }

    // Redis
    void apiRedisInfoRoute(HTTPServerRequest req, HTTPServerResponse res) { apiRedisInfo(req, res, redis); }
    void apiRedisSummaryRoute(HTTPServerRequest req, HTTPServerResponse res) { apiRedisSummary(req, res, redis); }
    void apiRedisKeysRoute(HTTPServerRequest req, HTTPServerResponse res) { apiRedisKeys(req, res, redis); }
    void apiRedisKeyDetailRoute(HTTPServerRequest req, HTTPServerResponse res) { apiRedisKeyDetail(req, res, redis); }
    void apiRedisSlowlogRoute(HTTPServerRequest req, HTTPServerResponse res) { apiRedisSlowlog(req, res, redis); }
    void apiRedisPubsubRoute(HTTPServerRequest req, HTTPServerResponse res) { apiRedisPubsub(req, res, redis); }
    void apiRedisClientsRoute(HTTPServerRequest req, HTTPServerResponse res) { apiRedisClients(req, res, redis); }

    // Replication (Mongo rs0 + Redis global keys)
    void apiReplicationStatusRoute(HTTPServerRequest req, HTTPServerResponse res) { apiReplicationStatus(req, res, redis); }

    // Backups (overview needs redis for the published run history)
    void apiBackupsOverviewRoute(HTTPServerRequest req, HTTPServerResponse res) { apiBackupsOverview(req, res, redis); }
    void apiBackupsRunRoute(HTTPServerRequest req, HTTPServerResponse res) { apiBackupsRun(req, res); }
    void apiBackupsSuspendRoute(HTTPServerRequest req, HTTPServerResponse res) { apiBackupsSuspend(req, res); }
    void apiBackupsLogsRoute(HTTPServerRequest req, HTTPServerResponse res) { apiBackupsLogs(req, res); }

    // Emails (signup verification delivery; all need redis)
    void apiEmailsOverviewRoute(HTTPServerRequest req, HTTPServerResponse res) { apiEmailsOverview(req, res, redis); }
    void apiEmailsTestRoute(HTTPServerRequest req, HTTPServerResponse res) { apiEmailsTest(req, res, redis); }
    void apiEmailsPendingResendRoute(HTTPServerRequest req, HTTPServerResponse res) { apiEmailsPendingResend(req, res, redis); }
    void apiEmailsPendingRevokeRoute(HTTPServerRequest req, HTTPServerResponse res) { apiEmailsPendingRevoke(req, res, redis); }
    void apiEmailsCooldownClearRoute(HTTPServerRequest req, HTTPServerResponse res) { apiEmailsCooldownClear(req, res, redis); }
    void apiEmailsIpLimitClearRoute(HTTPServerRequest req, HTTPServerResponse res) { apiEmailsIpLimitClear(req, res, redis); }

    // Janitor
    void apiJanitorStatusRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiJanitorStatus(req, res, getJanitor());
    }
    void apiJanitorEventsRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiJanitorEvents(req, res, getJanitor());
    }
    void apiJanitorReapRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiJanitorReap(req, res, getJanitor());
    }
    void apiJanitorCycleRoute(HTTPServerRequest req, HTTPServerResponse res) {
        apiJanitorCycle(req, res, getJanitor());
    }

    /// Serves the built Svelte admin SPA shell (`public/dist/admin.html`)
    /// for any authenticated admin request that didn't match a specific
    /// route above. The SPA handles client-side routing from there.
    void adminSpaShell(HTTPServerRequest, HTTPServerResponse res) {
        import std.file : read, exists, isFile;
        import std.path : buildPath;
        try {
            auto path = buildPath("public", "dist", "admin.html");
            if (!exists(path) || !isFile(path)) {
                res.statusCode = 503;
                res.headers["Content-Type"] = "text/html; charset=utf-8";
                res.writeBody(
                    "<!doctype html><meta charset=utf-8><title>Admin not built</title>" ~
                    "<body style=\"background:#0a0e14;color:#c8d2dd;font-family:system-ui;padding:48px\">" ~
                    "<h1>Admin SPA not built yet</h1>" ~
                    "<p>Run <code>cd frontend &amp;&amp; npm run build</code> to generate " ~
                    "<code>public/dist/admin.html</code>.</p>" ~
                    "<p>The diet-template admin pages are still available at:</p>" ~
                    "<ul><li><a href=\"/admin/servers\" style=\"color:#67e8f9\">/admin/servers</a></li>" ~
                    "<li><a href=\"/admin/sessions\" style=\"color:#67e8f9\">/admin/sessions</a></li>" ~
                    "<li><a href=\"/admin/users\" style=\"color:#67e8f9\">/admin/users</a></li>" ~
                    "<li><a href=\"/admin/uploads\" style=\"color:#67e8f9\">/admin/uploads</a></li></ul>" ~
                    "</body>");
                return;
            }
            res.headers["Content-Type"] = "text/html; charset=utf-8";
            res.headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
            res.writeBody(cast(const(ubyte)[]) read(path), "text/html; charset=utf-8");
        } catch (Exception e) {
            logWarn("adminSpaShell failed: %s", e.msg);
            res.statusCode = 500;
            res.writeBody("Failed to serve admin shell");
        }
    }
}
