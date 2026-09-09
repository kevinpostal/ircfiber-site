module ircfiber.web;

import std.file : readText, exists, isFile, read;
import std.path : buildPath;
import std.uuid : randomUUID;
import std.string : strip;
import std.typecons : Nullable;
import std.algorithm : startsWith, canFind, endsWith;
import std.string : indexOf;
import std.string : toLower;
import std.regex : regex, replaceAll;
import std.datetime : Clock;
import core.time : MonoTime;
import std.conv : to;
import std.process : environment;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse, render;
import vibe.http.router : URLRouter;
import vibe.core.log;
import vibe.data.json : Json, parseJsonString;

import ircfiber.auth : verifyPassword, hashPassword, requireAuth;
import ircfiber.redis.protocol : RedisKeys, NetworkStateSnapshot;
import ircfiber.storage.buffer : sanitizeUtf8;
import ircfiber.db.user : UserRepository;
import ircfiber.db.network : NetworkRepository;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.default_network : ensureDefaultFiberNetwork;
import ircfiber.services.accounts : isValidIrcNick, persistProvisionedAccount, provisionServicesAccountAsync;
import ircfiber.services.anope : NickRegistration, anopeCheckAuthentication, anopeNickRegistration, loadAnopeSettings;
import ircfiber.models.user : User;
import ircfiber.mail : MailSettings, MailException, loadMailSettings, sendMail,
    emailWellFormed;
import ircfiber.signup : PendingSignup, PendingSignupStore, emailVerificationRequired,
    newSignupToken, pendingKey, verificationEmail, verificationLink, campaignUnsubKey;
import ircfiber.mail_events : MailEvent, MailEventLog;
import ircfiber.web.common : getClientIp, persistSessionCookie;
import ircfiber.web.assets : siteAssets;
import ircfiber.web.unban : unbanGet, unbanPost;

    // Captures client IP, User-Agent, createdAt, and lastAccess on
    // the active session. Mirrors the helper in AdminController so
    // non-admin sessions also show full provenance on the admin
    // Sessions page. Timestamps are stored as `long` (unboxed JSON
    // number) because Vibe's JSON-storage variant can't store
    // reference types like Json directly.
    private void captureSessionMeta(HTTPServerRequest req) {
        if (!req.session) return;
        import std.datetime : Clock;
        auto ms = Clock.currTime.toUnixTime() * 1000L;
        if (!req.session.isKeySet("createdAt")) {
            req.session.set("createdAt", ms);
        }
        req.session.set("lastAccess", ms);
        req.session.set("clientIp",   getClientIp(req));
        req.session.set("userAgent",  req.headers.get("User-Agent", ""));
    }

import ircfiber.storage.redis : RedisStorage;
import ircfiber.storage.session : limitUserSessions;

/// Web controller for pages and static assets.
final class WebController {
    private RedisStorage redis;
    private ServerRegistry serverRegistry;

    /// Creates a new web controller.
    this(RedisStorage redis) {
        this.redis = redis;
        this.serverRegistry = new ServerRegistry(redis);
    }

    /// Live connection state for a network, from the engine's Redis
    /// snapshot (server-aware key first, then legacy). Returns false when
    /// no snapshot exists (e.g. never connected or engine down).
    private bool isNetworkConnected(string networkId) {
        auto serverId = serverRegistry.getServerForNetwork(networkId);
        if (serverId.length > 0) {
            auto fields = redis.hgetAll(RedisKeys.state(serverId, networkId));
            if ("data" in fields) {
                try {
                    return NetworkStateSnapshot.fromJson(parseJsonString(fields["data"])).connected;
                } catch (Exception e) { logWarn("Failed to parse snapshot for %s", networkId); }
            }
        }
        auto fields = redis.hgetAll(RedisKeys.state_legacy(networkId));
        if ("data" in fields) {
            try {
                return NetworkStateSnapshot.fromJson(parseJsonString(fields["data"])).connected;
            } catch (Exception e) { logWarn("Failed to parse legacy snapshot for %s", networkId); }
        }
        return false;
    }

    /// Registers web routes on the given router.
    void registerRoutes(URLRouter router) {
        router.get("/", &index);
        router.get("/irc/*", &index);
        router.get("/login", &loginPage);
        router.post("/login", &loginPost);
        router.get("/register", &registerPage);
        router.post("/register", &registerPost);
        router.get("/invite", &inviteGet);
        router.post("/invite", &invitePost);
        router.get("/verify", &verifyGet);
        router.post("/verify", &verifyPost);
        // Bulk-campaign List-Unsubscribe (public, NOT admin-gated: the
        // recipient clicks from their inbox with only the token).
        router.get("/unsubscribe", &unsubscribeGet);
        router.post("/unsubscribe", &unsubscribePost);
        // Public self-service ban appeal. Registered here, before every
        // static and catch-all route, because the ban reason itself is the
        // only channel a Z-lined visitor has (see web.unban).
        router.get("/unban", &unbanGetRoute);
        router.post("/unban", &unbanPostRoute);
        router.get("/unban/:token", &unbanGetRoute);
        router.post("/unban/:token", &unbanPostRoute);
        router.get("/logout", &logout);
        router.get("/public/landing.html", &serveLanding);
        router.get("/app-screenshot.png", &serveAppScreenshot);
        // Root-level icons + web app manifest referenced from index.html
        // (<link rel=icon>, apple-touch-icon, <link rel=manifest>). They
        // live in public/ (the Vite publicDir) but nothing served them.
        foreach (name; rootAssetNames)
            router.get("/" ~ name, &serveRootAsset);
        router.get("/fonts/*", &serveFonts);
        router.get("/style.css", &serveStyle);
        router.get("/public/dist/*", &serveDist);
        // Vite 5+ outputs the Svelte bundle under public/dist/assets/
        // and the generated index.html references it as `/assets/*`
        // (root-relative). Serve the same files at that path so the
        // HTML's <script src="/assets/index-*.js"> resolves without
        // going through a rewrite. The handler is the same serveDist
        // but rooted at the assets/ subdirectory.
        router.get("/assets/*", &serveAssets);
        // User-uploaded images are saved to /app/uploads/ and served
        // at /uploads/<uuid>.<ext>. Only common image MIME types are
        // returned; attempting to serve non-image files is refused.
        router.get("/uploads/*", &serveUpload);
        router.get("/api/events", &serveEvents);
    }

    private void index(HTTPServerRequest req, HTTPServerResponse res) {
        auto path = req.requestPath.toString();

        // Save the intended IRC path BEFORE the auth check so that
        // unauthenticated visitors who then log in get redirected back
        // to the correct route, not dumped at the root (/).
        // Without this, a bookmark or direct URL like /irc/IRC%20Fiber
        // silently drops the route after login because the cookie is
        // only set for authenticated requests (which never runs).
        if (path.startsWith("/irc/")) {
            res.setCookie("lastVisited", path, "/");
        }

        // If not authenticated, serve the static marketing landing page.
        // Logged-in users get the SPA, which detects auth state via /api/me.
        const sid = req.session ? req.session.get("sessionUserId", "") : "";
        if (sid.length == 0) {
            // Public share routes render the SPA without login so links
            // can be shared (e.g. /?/pastebin=<id>). The SPA boots
            // unauthenticated, skips the LoginPage overlay for these
            // routes (see App.svelte), and the viewer fetches the
            // public /api/pastebins/:id endpoint.
            if (path == "/" && req.queryString.startsWith("/pastebin=")) {
                auto assets = siteAssets();
                res.render!("index.dt", assets)();
                return;
            }
            serveLanding(req, res);
            return;
        }
        // Handle bare /irc and /irc/ — redirect to first visible network, not Fiber when down
        if ((path == "/irc" || path == "/irc/") && sid.length != 0) {
            try {
                import std.uuid : parseUUID;
                import std.uri : encodeComponent;
                auto uid = parseUUID(sid);
                auto repo = new NetworkRepository();
                auto nets = repo.findByUserId(uid);
                foreach (net; nets) {
                    bool isFiber = net.host == "irc.ircfiber.com" && net.systemManaged;
                    bool isDown = isFiber && !isNetworkConnected(net.id.toString());
                    if (isDown) continue;
                    if (net.host.length == 0) continue;
                    auto encodedName = encodeComponent(net.name);
                    res.redirect("/irc/" ~ encodedName);
                    return;
                }
                // Fallback: if all are down or no visible, don't redirect to Fiber
                foreach (net; nets) {
                    bool isFiber = net.host == "irc.ircfiber.com" && net.systemManaged;
                    if (!isFiber) {
                        auto encodedName = encodeComponent(net.name);
                        res.redirect("/irc/" ~ encodedName);
                        return;
                    }
                }
            } catch (Exception e) {
                logWarn("Failed to handle bare /irc redirect: %s", e.msg);
            }
        }
        // If visiting root and we have a last visited location, redirect there.
        // Skip the redirect for client-side routes (e.g. /?/shortcuts, /?/settings)
        // so the SPA router can handle them on initial page load.
        else if (path == "/" && !req.queryString.startsWith("/")) {
            if (auto last = "lastVisited" in req.cookies) {
                // vibe URL-DECODES cookie values, so a stored channel route
                // "/irc/Net/channel/%23chan" reads back as ".../#chan". Echoing
                // that into Location made the browser treat "#chan" as a
                // FRAGMENT — the user landed on ".../channel/" and the SPA
                // fell back to the first network: "it doesn't remember the
                // channel I was on". Re-encode every segment before
                // redirecting, and only ever redirect inside /irc/ (a cookie
                // is attacker-influenced input; this is not an open redirect).
                import std.algorithm : map;
                import std.array : join, split;
                import std.uri : encodeComponent;
                string target = (*last).idup;
                if (target.startsWith("/irc/")) {
                    auto encoded = target.split("/").map!(s => encodeComponent(s)).join("/");
                    res.redirect(encoded);
                    return;
                }
            }
        }

        auto assets = siteAssets();
        res.render!("index.dt", assets)();
    }

    private void loginPage(HTTPServerRequest, HTTPServerResponse res) {
        string authError;
        res.render!("login.dt", authError)();
    }

    private void loginPost(HTTPServerRequest req, HTTPServerResponse res) {
        string authError;
        try {
            auto repo = new UserRepository();
            auto username = req.form.get("username", "").strip();
            auto password = req.form.get("password", "").strip();

            if (username.length == 0 || password.length == 0) {
                authError = "Please enter both your username and password.";
                res.statusCode = 400;
                res.render!("login.dt", authError)();
                return;
            }

            auto user = repo.findByUsername(username);
            if (user.username.length > 0 && verifyPassword(password, user.passwordHash)) {
                // Record login IP and timestamp on the user record
                auto ip = getClientIp(req);
                user.lastLoginIp = ip;
                user.lastLoginAt = Clock.currTime;
                if (!user.loginIps.canFind(ip)) {
                    user.loginIps ~= ip;
                }
                repo.update(user);

                // Lazy migration: ensure the default IRC Fiber network exists
                // for every logging-in user. Idempotent — skips if they
                // already have one. Failures here don't block login.
                try {
                    ensureDefaultFiberNetwork(user, new NetworkRepository(), redis, new ServerRegistry(redis));
                } catch (Exception e) {
                    logWarn("Failed to ensure default network for %s on login: %s", user.username, e.msg);
                }

                // Backfill: claim this account's nick with NickServ if it
                // isn't claimed yet. No-op once the Fiber network carries a
                // SASL credential. Fire-and-forget — never blocks login.
                try {
                    provisionServicesAccountAsync(user, redis);
                } catch (Exception e) {
                    logWarn("Failed to schedule NickServ registration for %s: %s", user.username, e.msg);
                }

                if (!req.session) req.session = res.startSession();
                persistSessionCookie(res, req.session.id);
                req.session.set("sessionUserId", user.id.toString());
                captureSessionMeta(req);
                res.redirect("/");
            } else if (tryNickservLogin(repo, username, password, req, res)) {
                // Fallback authenticated, upgraded the hash and started the
                // session inside the helper. Nothing left to do.
            } else {
                authError = "Incorrect username or password. Please try again.";
                res.statusCode = 401;
                res.render!("login.dt", authError)();
            }
        } catch (Exception e) {
            logError("Login failed with exception: %s", e.msg);
            logError("Login stack trace: %s", e.toString());
            authError = "An unexpected error occurred. Please try again.";
            res.statusCode = 500;
            try res.render!("login.dt", authError)();
            catch (Exception) {
                res.writeBody("An unexpected error occurred.", "text/plain; charset=utf-8");
            }
        }
    }

    /// NickServ-password fallback for `loginPost`: only when the local hash
    /// check already failed. Verifies via Anope (`checkAuthentication`, the
    /// SASL PLAIN path), upgrades the local hash to the presented password,
    /// captures it as the Fiber network SASL credential, then logs in.
    /// Returns true when it authenticated and already redirected.
    private bool tryNickservLogin(UserRepository repo, string username, string password,
            HTTPServerRequest req, HTTPServerResponse res) {
        import ircfiber.default_network : DEFAULT_FIBER_HOST;
        if (!username.length || !password.length) return false;
        bool determined = false;
        bool ok = false;
        try {
            ok = anopeCheckAuthentication(loadAnopeSettings(), username, password, determined);
        } catch (Exception e) {
            logWarn("login: NickServ fallback for %s failed: %s", username, e.msg);
            return false;
        }
        if (!determined) {
            logWarn("login: Anope unreachable during NickServ fallback — local result stands");
            return false;
        }
        if (!ok) return false;
        User user;
        try user = repo.findByUsernameCI(username);
        catch (Exception e) {
            logWarn("login: NickServ fallback lookup for %s failed: %s", username, e.msg);
            return false;
        }
        if (!user.username.length) return false;
        // Hash upgrade: the presented NickServ password becomes the local
        // site password, so the next login verifies locally.
        user.passwordHash = hashPassword(password);
        auto ip = getClientIp(req);
        user.lastLoginIp = ip;
        user.lastLoginAt = Clock.currTime;
        if (!user.loginIps.canFind(ip)) user.loginIps ~= ip;
        try repo.update(user);
        catch (Exception e) {
            logWarn("login: NickServ hash upgrade for %s failed: %s", user.username, e.msg);
            return false;
        }
        auto netRepo = new NetworkRepository();
        auto registry = new ServerRegistry(redis);
        try ensureDefaultFiberNetwork(user, netRepo, redis, registry);
        catch (Exception e) logWarn("Failed to ensure default network for %s on login: %s", user.username, e.msg);
        // Capture as the Fiber network SASL credential so the engine
        // identifies as the user's NickServ account from the next connect.
        try {
            foreach (ref cfg; netRepo.findByUserId(user.id)) {
                if (cfg.host != DEFAULT_FIBER_HOST) continue;
                persistProvisionedAccount(user, cfg, user.username, password, netRepo, redis, registry);
                break;
            }
        } catch (Exception e) {
            logWarn("login: NickServ SASL capture for %s failed: %s", user.username, e.msg);
        }
        try provisionServicesAccountAsync(user, redis);
        catch (Exception e) logWarn("Failed to schedule NickServ registration for %s: %s", user.username, e.msg);
        if (!req.session) req.session = res.startSession();
        persistSessionCookie(res, req.session.id);
        req.session.set("sessionUserId", user.id.toString());
        captureSessionMeta(req);
        res.redirect("/");
        return true;
    }

    private void registerPage(HTTPServerRequest, HTTPServerResponse res) {
        string authError;
        res.render!("register.dt", authError)();
    }

    /**
     * Whether `username` is already claimed as an IRC nick on our own
     * network. The website username IS the user's IRC nick and NickServ
     * account name, so a name somebody else already owns can never become
     * theirs — better to say so at signup than to silently rename them.
     *
     * Fails OPEN by design: when Anope is unreachable, disabled, or answers
     * something unrecognised, the signup proceeds and
     * `ircfiber.services.accounts` falls back to a derived nick. Signup must
     * never depend on services being up. Set IRCFIBER_SIGNUP_NICK_CHECK=0 to
     * turn the check off entirely.
     */
    private bool ircNickIsClaimed(string username, out string why) {
        why = "";
        const flag = environment.get("IRCFIBER_SIGNUP_NICK_CHECK", "1");
        if (flag == "0" || flag == "false") return false;

        auto s = loadAnopeSettings();
        if (!s.configured) return false;
        // A signup must not sit on a services round trip.
        if (s.timeoutSeconds > 4) s.timeoutSeconds = 4;

        final switch (anopeNickRegistration(s, username)) {
            case NickRegistration.registered:
                why = "The nickname \"" ~ username ~ "\" is already registered on IRC Fiber's "
                    ~ "IRC network. Your username is also your IRC nickname, so please choose "
                    ~ "another — or sign in with the account that owns it.";
                return true;
            case NickRegistration.servicesReserved:
                why = "The nickname \"" ~ username ~ "\" is reserved by the IRC network's "
                    ~ "services. Please choose another username.";
                return true;
            case NickRegistration.free:
                return false;
            case NickRegistration.unknown:
                logWarn("register: could not verify IRC availability of %s — allowing signup",
                        username);
                return false;
        }
    }

    /// The SPA overlay sends `Accept: application/json`; the diet form does not.
    private static bool wantsJson(HTTPServerRequest req) {
        return req.headers.get("Accept", "").canFind("application/json");
    }

    private void registerFail(HTTPServerRequest req, HTTPServerResponse res, int status, string msg) {
        res.statusCode = status;
        if (wantsJson(req)) { res.writeJsonBody(Json(["error": Json(msg)])); return; }
        string authError = msg;
        res.render!("register.dt", authError)();
    }

    private void registerPost(HTTPServerRequest req, HTTPServerResponse res) {
        auto repo = new UserRepository();
        auto username = req.form.get("username", "").strip();
        auto email = req.form.get("email", "").strip();
        auto password = req.form.get("password", "").strip();

        // Landing page sign-up sends email + password only.
        if (username.length == 0 && email.length > 0) {
            auto at = email.indexOf("@");
            username = at > 0 ? email[0..at].idup : email;
            // Strip non-alphanumeric to keep usernames IRC-friendly.
            username = replaceAll(username, regex(r"[^a-zA-Z0-9_\-]"), "");
            // An IRC nick must start with a letter, so drop leading digits,
            // hyphens and underscores the email local part may have begun with.
            size_t nickStart = 0;
            while (nickStart < username.length) {
                const c = username[nickStart];
                if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) break;
                nickStart++;
            }
            username = username[nickStart .. $];
            if (username.length == 0) username = "user";
        }

        if (username.length == 0 || email.length == 0 || password.length == 0) {
            registerFail(req, res, 400, "Username, email and password are all required.");
            return;
        }

        if (!emailWellFormed(email)) {
            registerFail(req, res, 400, "That doesn't look like a valid email address.");
            return;
        }

        // The username is also the IRC nick and the NickServ account name
        // (ircfiber.services.accounts) — all three are the same string, so
        // reject anything the ircd would refuse.
        if (!isValidIrcNick(username)) {
            registerFail(req, res, 400, "Usernames must be a valid IRC nickname: letters, digits, - _ [ ] \\ ` ^ { | }, "
                ~ "starting with a letter, at most 32 characters.");
            return;
        }

        if (password.length < 8) {
            registerFail(req, res, 400, "Password must be at least 8 characters.");
            return;
        }

        // Case-insensitive: the username is also the IRC nick, and IRC nicks
        // are case-insensitive, so `Alice` and `alice` are one identity.
        if (repo.findByUsernameCI(username).username.length > 0) {
            registerFail(req, res, 409, "That username is already taken. Please choose another.");
            return;
        }

        string claimedWhy;
        if (ircNickIsClaimed(username, claimedWhy)) {
            registerFail(req, res, 409, claimedWhy);
            return;
        }

        registerPostVerified(req, res, username, email, password);
    }

    /// Inserts `u`, provisions the Fiber network + NickServ (both fire-and-forget,
    /// as today), starts the session and 302s to the welcome route.
    /// Returns false without writing a response when the username is taken
    /// (E11000) — the caller decides how to say so.
    private bool createAccountAndLogin(HTTPServerRequest req, HTTPServerResponse res, User u) {
        auto repo = new UserRepository();
        try {
            repo.create(u);
        } catch (Exception e) {
            // Backstop for the race the check above cannot see: two
            // simultaneous signups for case-variants of one name both pass
            // `findByUsernameCI`, and the loser's insert hits the
            // `username_ci_unique` index (E11000). That is a taken username,
            // not a server error.
            if (e.msg.canFind("duplicate key")) {
                return false;
            }
            throw e;
        }

        // Announce the signup in #staff (oper-only, so the full e-mail and
        // IP may be shown). Best-effort: `pushLogEvent` never throws.
        {
            import ircfiber.logs.events : LogEvent, pushLogEvent;
            LogEvent le;
            le.type = "signup";
            le.ts = Clock.currTime.toUnixTime!long * 1000;
            le.username = u.username;
            le.email = u.email;
            le.ip = u.signupIp;
            pushLogEvent(redis, le);
        }

        // Provision the default IRC Fiber network (irc.ircfiber.com:6697).
        // Idempotent — existing-user migration runs the same helper on login.
        // We swallow exceptions here so a Mongo/Redis hiccup doesn't lose
        // the user record; the lazy login hook will catch up next session.
        try {
            ensureDefaultFiberNetwork(u, new NetworkRepository(), redis, new ServerRegistry(redis));
        } catch (Exception e) {
            logWarn("Failed to provision default network for new user %s: %s", u.username, e.msg);
        }

        // Claim the username with NickServ and store the generated password
        // as the Fiber network's SASL credential. Fire-and-forget: the user
        // record must survive an Anope/Redis hiccup.
        try {
            provisionServicesAccountAsync(u, redis);
        } catch (Exception e) {
            logWarn("Failed to schedule NickServ registration for %s: %s", u.username, e.msg);
        }

        if (!req.session) req.session = res.startSession();
        persistSessionCookie(res, req.session.id);
        req.session.set("sessionUserId", u.id.toString());
        captureSessionMeta(req);
        // Land on the post-signup welcome page (sidebar + Fiber channel chips +
        // add-another-network form). The SPA reads the ?/add-network=welcome route.
        res.redirect("/?/add-network=welcome");
        return true;
    }

    // Public ban appeal — the handlers live in web.unban because they
    // need the FiberEye store and the ircd oper session, neither of which
    // belongs in the page controller.
    private void unbanGetRoute(HTTPServerRequest req, HTTPServerResponse res) {
        unbanGet(req, res, redis);
    }

    private void unbanPostRoute(HTTPServerRequest req, HTTPServerResponse res) {
        unbanPost(req, res, redis);
    }

    private void renderVerify(HTTPServerResponse res, int status, string stage,
            string email, string token, string message) {
        res.statusCode = status;
        res.render!("verify.dt", stage, email, token, message)();
    }

    private void verifyGet(HTTPServerRequest req, HTTPServerResponse res) {
        const token = req.query.get("token", "").strip();
        auto store = new PendingSignupStore(redis);
        if (token.length == 0 || !store.exists(token)) {
            renderVerify(res, 410, "error", "", "",
                "This confirmation link has expired or was already used. "
                ~ "Please create your account again to get a new one.");
            return;
        }
        renderVerify(res, 200, "confirm", "", token, "");
    }

    private void verifyPost(HTTPServerRequest req, HTTPServerResponse res) {
        const token = req.form.get("token", "").strip();
        auto store = new PendingSignupStore(redis);
        auto pending = token.length ? store.take(token) : Nullable!PendingSignup.init;
        if (pending.isNull) {
            renderVerify(res, 410, "error", "", "",
                "This confirmation link has expired or was already used. "
                ~ "Please create your account again to get a new one.");
            return;
        }
        auto p = pending.get;
        User u;
        u.id = randomUUID();
        u.username = p.username;
        u.email = p.email;
        u.passwordHash = p.passwordHash;
        u.signupIp = p.signupIp;
        u.createdAt = Clock.currTime;
        if (!createAccountAndLogin(req, res, u)) {
            renderVerify(res, 409, "error", "", "",
                "The username \"" ~ p.username
                ~ "\" was taken while this link was waiting. "
                ~ "Please create your account again with a different username.");
            return;
        }
        logInfo("register: %s verified %s and was created", u.username, u.email);
    }

    /// GET /unsubscribe?token= — peeks (never consumes) the campaign token
    /// and renders the confirm page. Unknown/expired token → friendly page,
    /// never a 500.
    private void unsubscribeGet(HTTPServerRequest req, HTTPServerResponse res) {
        const token = req.query.get("token", "").strip();
        string email;
        if (token.length > 0) {
            try email = redis.getDb().get(campaignUnsubKey(token));
            catch (Exception e) logWarn("unsubscribe: token lookup failed: %s", e.msg);
        }
        if (token.length == 0 || email.length == 0) {
            renderVerify(res, 410, "unsub_error", "", "",
                "This unsubscribe link has expired or was already used. "
                ~ "If campaign mail still reaches you, use the link in the newest message.");
            return;
        }
        renderVerify(res, 200, "unsub_confirm", email, token, "");
    }

    /// POST /unsubscribe — consumes the token (single use), flips
    /// `emailUnsubscribed` on the matching user row, renders done. The DB
    /// write runs before the token delete so a Mongo hiccup leaves the
    /// token retryable instead of silently keeping the subscription.
    private void unsubscribePost(HTTPServerRequest req, HTTPServerResponse res) {
        const token = req.form.get("token", "").strip();
        string email;
        if (token.length > 0) {
            try email = redis.getDb().get(campaignUnsubKey(token));
            catch (Exception e) logWarn("unsubscribe: token lookup failed: %s", e.msg);
        }
        if (token.length == 0 || email.length == 0) {
            renderVerify(res, 410, "unsub_error", "", "",
                "This unsubscribe link has expired or was already used. "
                ~ "If campaign mail still reaches you, use the link in the newest message.");
            return;
        }
        try {
            new UserRepository().setEmailUnsubscribed(email);
            redis.getDb().del(campaignUnsubKey(token));
        } catch (Exception e) {
            logWarn("unsubscribe: opting out %s failed: %s", email, e.msg);
            renderVerify(res, 503, "unsub_error", "", "",
                "Unsubscribing failed for a moment. Please try again shortly.");
            return;
        }
        logInfo("unsubscribe: %s opted out of campaign mail", email);
        renderVerify(res, 200, "unsub_done", email, "", "");
    }

    private void inviteGet(HTTPServerRequest req, HTTPServerResponse res) {
        import ircfiber.invites : InviteStore;
        const token = req.query.get("token", "").strip();
        auto store = new InviteStore(redis);
        if (!token.length || !store.exists(token)) {
            renderVerify(res, 410, "error", "", "",
                "This invitation link has expired or was already used. "
                ~ "Ask an operator for a new one.");
            return;
        }
        string nick = "";
        try {
            auto peeked = store.peek(token);
            if (!peeked.isNull) nick = peeked.get.nick;
        } catch (Exception) {}
        string authError;
        res.render!("invite.dt", nick, token, authError)();
    }

    private void invitePost(HTTPServerRequest req, HTTPServerResponse res) {
        import ircfiber.invites : InviteStore;
        const token = req.form.get("token", "").strip();
        auto store = new InviteStore(redis);
        // Read WITHOUT consuming for validation; username locked to the record.
        string nick = "";
        if (token.length) {
            try {
                auto peeked = store.peek(token);
                if (!peeked.isNull) nick = peeked.get.nick;
            } catch (Exception) {}
        }
        if (!token.length || !nick.length) {
            renderVerify(res, 410, "error", "", "",
                "This invitation link has expired or was already used. "
                ~ "Ask an operator for a new one.");
            return;
        }
        auto email = req.form.get("email", "").strip();
        auto password = req.form.get("password", "").strip();
        void fail(string msg) {
            string authError = msg;
            res.statusCode = 400;
            res.render!("invite.dt", nick, token, authError)();
        }
        if (!email.length || !emailWellFormed(email)) {
            fail("That doesn't look like a valid email address.");
            return;
        }
        if (password.length < 8) {
            fail("Password must be at least 8 characters.");
            return;
        }
        // Consume now; a raced double-submit sees the expired page.
        auto taken = store.take(token);
        if (taken.isNull) {
            renderVerify(res, 410, "error", "", "",
                "This invitation link has expired or was already used. "
                ~ "Ask an operator for a new one.");
            return;
        }
        const username = taken.get.nick;
        auto repo = new UserRepository();
        if (repo.findByUsernameCI(username).username.length > 0) {
            renderVerify(res, 409, "error", "", "",
                "The username \"" ~ username ~ "\" was taken while this link was waiting. "
                ~ "Ask an operator for a new invite.");
            return;
        }
        // Deliberately no ircNickIsClaimed: the nick is unregistered by
        // construction, and the check fails open anyway. Email verification
        // is bypassed: trust root is the oper request + PM delivery, and the
        // invitee supplies a real email here.
        User u;
        u.id = randomUUID();
        u.username = username;
        u.email = email;
        u.passwordHash = hashPassword(password);
        u.signupIp = getClientIp(req);
        u.createdAt = Clock.currTime;
        if (!createAccountAndLogin(req, res, u)) {
            renderVerify(res, 409, "error", "", "",
                "The username \"" ~ username ~ "\" was taken while this link was waiting. "
                ~ "Ask an operator for a new invite.");
            return;
        }
        logInfo("invite: %s redeemed invite for %s", username, email);
    }

    private void registerPostVerified(HTTPServerRequest req, HTTPServerResponse res,
            string username, string email, string password) {
        auto mail = loadMailSettings();
        if (!emailVerificationRequired(mail)) {
            User u;
            u.id = randomUUID();
            u.username = username;
            u.email = email;
            u.passwordHash = hashPassword(password);
            u.signupIp = getClientIp(req);
            u.createdAt = Clock.currTime;
            if (!createAccountAndLogin(req, res, u))
                registerFail(req, res, 409, "That username is already taken. Please choose another.");
            return;
        }
        if (!mail.configured) {
            logError("register: email verification required but no mail provider is configured");
            registerFail(req, res, 503, "Signups are temporarily unavailable. Please try again later.");
            return;
        }
        auto store = new PendingSignupStore(redis);
        const ip = getClientIp(req);
        if (store.ipLimitHit(ip)) {
            registerFail(req, res, 429, "Too many signups from your network. Please try again later.");
            return;
        }
        const emailLower = email.toLower();
        if (store.emailCooldownHit(emailLower)) {
            registerFail(req, res, 429, "We already sent a confirmation link to that address. "
                ~ "Check your inbox (and spam), then try again in a minute.");
            return;
        }
        PendingSignup p = { username, email, hashPassword(password), ip, Clock.currTime.toUnixTime() };
        const token = newSignupToken();
        try store.put(token, p);
        catch (Exception e) {
            logError("register: storing pending signup for %s failed: %s", username, e.msg);
            registerFail(req, res, 503, "Signups are temporarily unavailable. Please try again later.");
            return;
        }
        const link = verificationLink(environment.get("IRCFIBER_PUBLIC_URL", "https://ircfiber.com"), token);
        MailEvent ev;
        ev.atMs = Clock.currTime.toUnixTime() * 1000L;
        ev.kind = "signup_verification";
        ev.toEmail = email;
        ev.username = username;
        ev.provider = mail.provider;
        ev.sourceIp = ip;
        const sendStarted = MonoTime.currTime;
        try {
            sendMail(mail, verificationEmail(username, email, link));
            ev.status = "sent";
            ev.durationMs = (MonoTime.currTime - sendStarted).total!"msecs";
            new MailEventLog(redis).record(ev);
        } catch (Exception e) {
            ev.status = "failed";
            ev.error = e.msg;
            ev.durationMs = (MonoTime.currTime - sendStarted).total!"msecs";
            new MailEventLog(redis).record(ev);
            logError("register: sending verification email to %s failed: %s", email, e.msg);
            redis.del(pendingKey(token));   // a link nobody received must not stay live
            registerFail(req, res, 503, "We couldn't send the confirmation email. Please try again in a few minutes.");
            return;
        }
        logInfo("register: verification email sent for %s (%s) from %s", username, email, ip);
        if (wantsJson(req)) {
            res.statusCode = 202;
            res.writeJsonBody(Json(["status": Json("verification_sent"), "email": Json(email)]));
            return;
        }
        renderVerify(res, 200, "sent", email, "", "");
    }

    private void logout(HTTPServerRequest req, HTTPServerResponse res) {
        req.session.destroy();
        res.redirect("/login");
    }

    private void serveLanding(HTTPServerRequest, HTTPServerResponse res) {
        try {
            res.headers["Cache-Control"] = "public, max-age=3600";
            res.writeBody(readText("public/landing.html"), "text/html; charset=utf-8");
        } catch (Exception e) {
            logWarn("Failed to serve landing page: %s", e.msg);
            res.statusCode = 500;
        }
    }

    private void serveAppScreenshot(HTTPServerRequest, HTTPServerResponse res) {
        try {
            res.headers["Cache-Control"] = "public, max-age=86400";
            res.writeBody(cast(const(ubyte)[])read("public/app-screenshot.png"), "image/png");
        } catch (Exception e) {
            logWarn("Failed to serve app screenshot: %s", e.msg);
            res.statusCode = 500;
        }
    }

    /// Files in public/ served at the site root. Allowlist, not a directory
    /// walk: everything else in public/ stays private.
    private static immutable string[] rootAssetNames = [
        "favicon.ico", "favicon.svg",
        "favicon-16x16.png", "favicon-32x32.png",
        "favicon-192x192.png", "favicon-512x512.png",
        "apple-touch-icon.png",
        "manifest.webmanifest",
    ];

    private void serveRootAsset(HTTPServerRequest req, HTTPServerResponse res) {
        auto name = req.requestPath.toString()[1 .. $];
        if (!rootAssetNames.canFind(name)) { res.statusCode = 404; return; }
        string mime = "application/octet-stream";
        if (endsWith(name, ".png")) mime = "image/png";
        else if (endsWith(name, ".svg")) mime = "image/svg+xml";
        else if (endsWith(name, ".ico")) mime = "image/x-icon";
        else if (endsWith(name, ".webmanifest")) mime = "application/manifest+json";
        try {
            res.headers["Cache-Control"] = "public, max-age=86400";
            res.writeBody(cast(const(ubyte)[])read(buildPath("public", name)), mime);
        } catch (Exception e) {
            logWarn("Failed to serve %s: %s", name, e.msg);
            res.statusCode = 404;
        }
    }

    private void serveGlyphs(HTTPServerRequest, HTTPServerResponse res) {
        try {
            res.headers["Cache-Control"] = "public, max-age=86400";
            res.writeBody(cast(const(ubyte)[])read("public/glyphs.json"), "application/json");
        } catch (Exception e) {
            logWarn("Failed to serve glyphs.json: %s", e.msg);
            res.statusCode = 404;
        }
    }

    private void serveFonts(HTTPServerRequest req, HTTPServerResponse res) {
        try {
            auto pathStr = req.requestPath.toString();
            auto rel = pathStr[("/fonts/".length)..$];
            if (rel.canFind("..")) { res.statusCode = 400; return; }
            auto fsPath = buildPath("public/fonts", rel);
            if (!exists(fsPath) || !isFile(fsPath)) { res.statusCode = 404; return; }
            string mime = "application/octet-stream";
            if (endsWith(rel, ".woff2")) mime = "font/woff2";
            else if (endsWith(rel, ".woff")) mime = "font/woff";
            else if (endsWith(rel, ".ttf")) mime = "font/ttf";
            else if (endsWith(rel, ".otf")) mime = "font/otf";
            res.headers["Cache-Control"] = "public, max-age=86400";
            res.writeBody(cast(const(ubyte)[])read(fsPath), mime);
        } catch (Exception e) {
            logWarn("Failed to serve font: %s", e.msg);
            res.statusCode = 500;
        }
    }

    private void serveStyle(HTTPServerRequest, HTTPServerResponse res) {
        try {
            res.headers["Cache-Control"] = "public, max-age=3600";
            res.writeBody(readText("public/style.css"), "text/css");
        } catch (Exception e) {
            logWarn("Failed to serve style.css: %s", e.msg);
            res.statusCode = 404;
        }
    }

    private void serveHyperFrames(HTTPServerRequest, HTTPServerResponse res) {
        try {
            res.headers["Cache-Control"] = "public, max-age=86400";
            res.writeBody(readText("public/hyperframes-launch.html"), "text/html; charset=utf-8");
        } catch (Exception e) {
            logWarn("Failed to serve HyperFrames source: %s", e.msg);
            res.statusCode = 500;
        }
    }

    private void serveDist(HTTPServerRequest req, HTTPServerResponse res) {
        try {
            auto pathStr = req.requestPath.toString();
            auto rel = pathStr[("/public/dist/".length)..$];
            auto qIdx = rel.indexOf('?');
            if (qIdx >= 0) rel = rel[0..qIdx];
            if (rel.length == 0 || rel.canFind("..")) {
                res.statusCode = 400;
                return;
            }

            // ETag / 304 — cheap revalidation for non-immutable assets
            auto etag = "\"" ~ rel ~ "\"";
            if (auto inm = req.headers.get("If-None-Match", "")) {
                if (inm == etag || inm == "W/" ~ etag) {
                    res.statusCode = 304;
                    return;
                }
            }

            auto fsPath = buildPath("public/dist", rel);
            if (!exists(fsPath) || !isFile(fsPath)) {
                res.statusCode = 404;
                return;
            }

            // Serve precompressed .br / .gz when client supports it
            auto acceptEnc = req.headers.get("Accept-Encoding", "");
            bool wantsBr = acceptEnc.canFind("br");
            bool wantsGz = acceptEnc.canFind("gzip");
            string encPath;
            string contentEnc;
            if (wantsBr && exists(fsPath ~ ".br")) {
                encPath = fsPath ~ ".br";
                contentEnc = "br";
            } else if (wantsGz && exists(fsPath ~ ".gz")) {
                encPath = fsPath ~ ".gz";
                contentEnc = "gzip";
            }
            string servePath = encPath.length ? encPath : fsPath;

            string mime = "application/octet-stream";
            if (endsWith(rel, ".js"))       mime = "application/javascript";
            else if (endsWith(rel, ".css")) mime = "text/css";
            else if (endsWith(rel, ".html")) mime = "text/html";
            else if (endsWith(rel, ".json")) mime = "application/json";
            else if (endsWith(rel, ".svg"))  mime = "image/svg+xml";
            else if (endsWith(rel, ".png"))  mime = "image/png";
            else if (endsWith(rel, ".wasm")) mime = "application/wasm";
            else if (endsWith(rel, ".woff2")) mime = "font/woff2";
            else if (endsWith(rel, ".woff")) mime = "font/woff";

            // Hashed assets under public/dist/assets/* are content-addressed
            bool isImmutable = rel.startsWith("assets/") && rel.canFind("-");
            // An HTML shell is an INDEX of content-hashed bundles, so caching
            // it caches the bundle names: with max-age=3600 a browser kept
            // loading the previous deploy's admin-<hash>.js for up to an hour
            // after a swap, which reads as "my change did not deploy". The
            // shell must always be revalidated; only the hashed assets it
            // points at may be cached forever.
            const isShell = endsWith(rel, ".html");
            if (isImmutable) {
                res.headers["Cache-Control"] = "public, max-age=31536000, immutable";
                // strip Pragma/Expires so caches honor immutable
            } else if (isShell) {
                res.headers["Cache-Control"] = "no-store, must-revalidate";
            } else {
                res.headers["Cache-Control"] = "public, max-age=3600";
            }
            res.headers["ETag"] = etag;
            res.headers["Vary"] = "Accept-Encoding";
            writePrecompressed(res, fsPath, servePath, mime, contentEnc);
        } catch (Exception e) {
            logWarn("Failed to serve dist asset: %s", e.msg);
            res.statusCode = 500;
        }
    }

    // Same logic as serveDist but rooted at public/dist/assets/. The
    // Svelte bundle lives there under Vite 5+ (output: `assets/index-*.js`)
    // and the generated index.html references it as `/assets/index-*.js`.
    private void serveAssets(HTTPServerRequest req, HTTPServerResponse res) {
        try {
            auto pathStr = req.requestPath.toString();
            auto rel = pathStr[("/assets/".length)..$];
            auto qIdx = rel.indexOf('?');
            if (qIdx >= 0) rel = rel[0..qIdx];
            if (rel.length == 0 || rel.canFind("..")) {
                res.statusCode = 400;
                return;
            }

            auto etag = "\"assets/" ~ rel ~ "\"";
            if (auto inm = req.headers.get("If-None-Match", "")) {
                if (inm == etag || inm == "W/" ~ etag) {
                    res.statusCode = 304;
                    return;
                }
            }

            auto fsPath = buildPath("public/dist/assets", rel);
            if (!exists(fsPath) || !isFile(fsPath)) {
                res.statusCode = 404;
                return;
            }

            auto acceptEnc = req.headers.get("Accept-Encoding", "");
            bool wantsBr = acceptEnc.canFind("br");
            bool wantsGz = acceptEnc.canFind("gzip");
            string encPath;
            string contentEnc;
            if (wantsBr && exists(fsPath ~ ".br")) {
                encPath = fsPath ~ ".br";
                contentEnc = "br";
            } else if (wantsGz && exists(fsPath ~ ".gz")) {
                encPath = fsPath ~ ".gz";
                contentEnc = "gzip";
            }
            string servePath = encPath.length ? encPath : fsPath;

            string mime = "application/octet-stream";
            if (endsWith(rel, ".js"))       mime = "application/javascript";
            else if (endsWith(rel, ".css")) mime = "text/css";
            else if (endsWith(rel, ".html")) mime = "text/html";
            else if (endsWith(rel, ".json")) mime = "application/json";
            else if (endsWith(rel, ".svg"))  mime = "image/svg+xml";
            else if (endsWith(rel, ".png"))  mime = "image/png";
            else if (endsWith(rel, ".wasm")) mime = "application/wasm";
            else if (endsWith(rel, ".woff2")) mime = "font/woff2";
            else if (endsWith(rel, ".woff")) mime = "font/woff";

            bool isImmutable = rel.canFind("-");
            // Same rule as serveDist: an HTML shell indexes hashed bundles, so
            // it must be revalidated or a deploy stays invisible for an hour.
            const isShell = endsWith(rel, ".html");
            if (isImmutable && !isShell) {
                res.headers["Cache-Control"] = "public, max-age=31536000, immutable";
            } else if (isShell) {
                res.headers["Cache-Control"] = "no-store, must-revalidate";
            } else {
                res.headers["Cache-Control"] = "public, max-age=3600";
            }
            res.headers["ETag"] = etag;
            res.headers["Vary"] = "Accept-Encoding";
            writePrecompressed(res, fsPath, servePath, mime, contentEnc);
        } catch (Exception e) {
            logWarn("Failed to serve /assets/ asset: %s", e.msg);
            res.statusCode = 500;
        }
    }

    /// Writes an asset body, honouring a pre-compressed variant.
    ///
    /// `res.writeBody` goes through vibe's `bodyWriter`, which inspects
    /// `Content-Encoding`: for `gzip` it wraps the writer in a gzip stream,
    /// so handing it the pre-gzipped file gzipped it a *second* time
    /// (verified on prod: 112424 bytes served for a 112385-byte .gz — any
    /// gzip-only client got undecodable JS). For gzip we therefore feed the
    /// uncompressed bytes and let vibe compress once. `br` is passed
    /// through verbatim (vibe has no brotli codec; it logs "Unsupported
    /// Content-Encoding" and writes the bytes unchanged). `writeRawBody`
    /// would avoid both, but vibe-http 1.5.1's template does not compile
    /// under current LDC scope checks.
    private static void writePrecompressed(HTTPServerResponse res, string plainPath, string servePath, string mime, string contentEnc) {
        if (contentEnc == "gzip") {
            res.headers["Content-Encoding"] = "gzip";
            res.writeBody(cast(const(ubyte)[]) read(plainPath), mime);
            return;
        }
        if (contentEnc.length) res.headers["Content-Encoding"] = contentEnc;
        res.writeBody(cast(const(ubyte)[]) read(servePath), mime);
    }

    /// GET /api/events — XHR fallback for event streaming.
    /// Returns events since the given ?since=<eid> (or empty array).
    /// Reads from the user's Redis event stream (irc:stream:<userId>),
    /// the same store used by the WebSocket's replayMissedEvents().
    private void serveEvents(HTTPServerRequest req, HTTPServerResponse res) {
        requireAuth(req, res);
        if (res.headerWritten) return;
        auto user = req.context["user"].get!User;
        long sinceEid = 0;
        if (auto p = "since" in req.query) {
            if ((*p).length > 0) {
                try {
                    sinceEid = to!long(*p);
                } catch (Exception) {}
            }
        }
        auto streamKey = RedisKeys.userStream(user.id.toString());
        Json[] result;
        try {
            auto db = redis.getDb();
            auto raw = db.lrange!(ubyte[])(streamKey, 0, -1);
            foreach (entry; raw) {
                string s;
                try { s = () @trusted { return cast(string)entry.idup; } (); }
                catch (Exception) { continue; }
                s = sanitizeUtf8(s);
                if (s.length == 0) continue;
                try {
                    auto json = parseJsonString(s);
                    if (auto e = "eid" in json) {
                        if (e.type == Json.Type.int_ && e.get!long > sinceEid) {
                            result ~= json;
                        }
                    }
                } catch (Exception) {}
            }
        } catch (Exception e) {
            logWarn("serveEvents: failed to read stream for user %s: %s", user.id, e.msg);
        }
        import std.algorithm : reverse;
        reverse(result);
        res.writeJsonBody(Json(result));
    }

    /// Serves uploaded files from /app/uploads/.
    /// Only allows common image MIME types to prevent misuse.
    private void serveUpload(HTTPServerRequest req, HTTPServerResponse res) {
        import ircfiber.upload.local : uploadDir;
        import std.path : baseName;
        try {
            auto pathStr = req.requestPath.toString();
            // Strip the "/uploads/" prefix
            auto rel = pathStr[("/uploads/".length)..$];
            auto qIdx = rel.indexOf('?');
            if (qIdx >= 0) rel = rel[0..qIdx];
            if (rel.length == 0 || rel.canFind("..")) {
                res.statusCode = 400;
                return;
            }

            auto fsPath = buildPath(uploadDir(), rel);
            if (!exists(fsPath) || !isFile(fsPath)) {
                res.statusCode = 404;
                return;
            }

            // Modes for viewer tabs — req.query is string[string] (see rest.d:1811)
            bool isRaw = ("raw" in req.query) !is null;
            bool isDownload = ("download" in req.query) !is null;
            bool isHtml = endsWith(rel, ".html") || endsWith(rel, ".htm") || endsWith(rel, ".xhtml");

            // Serve known image/text/code types plus universal binary types (50MB any-format).
            // Unknown extensions fall through to application/octet-stream (downloadable binary) instead of 403.
            string mime = "application/octet-stream";
            if (endsWith(rel, ".png"))       mime = "image/png";
            else if (endsWith(rel, ".jpg")
                  || endsWith(rel, ".jpeg")) mime = "image/jpeg";
            else if (endsWith(rel, ".gif"))  mime = "image/gif";
            else if (endsWith(rel, ".webp")) mime = "image/webp";
            else if (endsWith(rel, ".svg"))  mime = "image/svg+xml";
            else if (endsWith(rel, ".avif")) mime = "image/avif";
            else if (endsWith(rel, ".bmp")) mime = "image/bmp";
            else if (endsWith(rel, ".ico")) mime = "image/x-icon";
            else if (endsWith(rel, ".tiff") || endsWith(rel, ".tif")) mime = "image/tiff";
            else if (endsWith(rel, ".txt") || endsWith(rel, ".text") || endsWith(rel, ".log")) mime = "text/plain";
            else if (endsWith(rel, ".md") || endsWith(rel, ".markdown")) mime = "text/markdown";
            else if (endsWith(rel, ".py")) mime = "text/x-python";
            else if (endsWith(rel, ".js") || endsWith(rel, ".mjs") || endsWith(rel, ".jsx")) mime = "text/javascript";
            else if (endsWith(rel, ".ts") || endsWith(rel, ".tsx")) mime = "text/typescript";
            else if (endsWith(rel, ".json") || endsWith(rel, ".json5")) mime = "application/json";
            else if (endsWith(rel, ".yml") || endsWith(rel, ".yaml")) mime = "text/yaml";
            else if (endsWith(rel, ".html") || endsWith(rel, ".htm") || endsWith(rel, ".xhtml"))
                mime = "text/html; charset=utf-8";
            else if (endsWith(rel, ".xml"))
                mime = "text/xml";
            else if (endsWith(rel, ".css") || endsWith(rel, ".scss") || endsWith(rel, ".less")) mime = "text/css";
            else if (endsWith(rel, ".sh") || endsWith(rel, ".bash")) mime = "text/x-sh";
            else if (endsWith(rel, ".sql")) mime = "text/x-sql";
            else if (endsWith(rel, ".toml")) mime = "text/x-toml";
            else if (endsWith(rel, ".ini") || endsWith(rel, ".conf") || endsWith(rel, ".cfg")) mime = "text/plain";
            else if (endsWith(rel, ".csv")) mime = "text/csv";
            else if (endsWith(rel, ".pdf")) mime = "application/pdf";
            else if (endsWith(rel, ".zip")) mime = "application/zip";
            else if (endsWith(rel, ".tar")) mime = "application/x-tar";
            else if (endsWith(rel, ".gz") || endsWith(rel, ".tgz")) mime = "application/gzip";
            else if (endsWith(rel, ".bz2")) mime = "application/x-bzip2";
            else if (endsWith(rel, ".xz")) mime = "application/x-xz";
            else if (endsWith(rel, ".7z")) mime = "application/x-7z-compressed";
            else if (endsWith(rel, ".rar")) mime = "application/vnd.rar";
            else if (endsWith(rel, ".mp4") || endsWith(rel, ".m4v")) mime = "video/mp4";
            else if (endsWith(rel, ".webm")) mime = "video/webm";
            else if (endsWith(rel, ".mov")) mime = "video/quicktime";
            else if (endsWith(rel, ".avi")) mime = "video/x-msvideo";
            else if (endsWith(rel, ".mkv")) mime = "video/x-matroska";
            else if (endsWith(rel, ".mp3")) mime = "audio/mpeg";
            else if (endsWith(rel, ".wav")) mime = "audio/wav";
            else if (endsWith(rel, ".ogg") || endsWith(rel, ".oga")) mime = "audio/ogg";
            else if (endsWith(rel, ".flac")) mime = "audio/flac";
            else if (endsWith(rel, ".aac")) mime = "audio/aac";
            else if (endsWith(rel, ".woff")) mime = "font/woff";
            else if (endsWith(rel, ".woff2")) mime = "font/woff2";
            else if (endsWith(rel, ".ttf")) mime = "font/ttf";
            else if (endsWith(rel, ".otf")) mime = "font/otf";
            else if (endsWith(rel, ".exe") || endsWith(rel, ".dll") || endsWith(rel, ".so") || endsWith(rel, ".dylib") || endsWith(rel, ".bin")) mime = "application/octet-stream";
            else {
                // Universal fallback: serve as binary download (IRCCloud parity — any file type)
                mime = "application/octet-stream";
            }

            if (isDownload) {
                res.headers["Content-Disposition"] = "attachment; filename=\"" ~ baseName(rel) ~ "\"";
                res.headers["Cache-Control"] = "public, max-age=86400";
            } else if (isRaw) {
                mime = "text/plain; charset=utf-8";
                res.headers["Content-Disposition"] = "inline";
                res.headers["Cache-Control"] = "public, max-age=86400";
            } else if (isHtml) {
                res.headers["Content-Security-Policy"] = "sandbox allow-scripts";
                res.headers["X-Frame-Options"] = "SAMEORIGIN";
                res.headers["Cache-Control"] = "public, max-age=60";
            } else {
                res.headers["Cache-Control"] = "public, max-age=86400";
            }
            res.writeBody(cast(const(ubyte)[])read(fsPath), mime);
        } catch (Exception e) {
            logWarn("Failed to serve upload: %s", e.msg);
            res.statusCode = 500;
        }
    }
}
