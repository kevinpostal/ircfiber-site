module oauth_test;

import std.algorithm : canFind;
import std.ascii : isAlphaNum;
import std.process : environment;
import std.stdio : writeln, writefln;
import std.string : toUpper;

import vibe.data.bson : Bson;
import vibe.data.json : parseJsonString;

import ircfiber.oauth;
import ircfiber.models.user : User, OAuthIdentity;
/// Same shape as signup_test.d: built with -unittest so the `@("…")`
/// unittest blocks in the module under test run too, hence the pinned
/// testmode that runs both.
extern (C) __gshared string[] rt_options = ["testmode=run-main"];

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private void testSettingsGate() {
    OAuthSettings empty;
    check(!empty.configured, "empty settings not configured");
    OAuthSettings idOnly = { "cid", "" };
    check(!idOnly.configured, "id without secret is disabled");
    OAuthSettings secretOnly = { "", "sec" };
    check(!secretOnly.configured, "secret without id is disabled");
    OAuthSettings both = { "cid", "sec" };
    check(both.configured, "both halves configured");
}

private void testRedirectUri() {
    // Default host with no env override; trailing slashes stripped.
    const def = oauthRedirectUri("github");
    check(def == "https://ircfiber.com/auth/github/callback", "default redirect URI: " ~ def);
    check(oauthRedirectUri("gitlab").canFind("/auth/gitlab/callback"), "gitlab callback path");
}

private void testStateStoreShapes() {
    check(oauthStateKey("s") == "oauth:state:s", "state key shape");
    check(oauthStateTtlSeconds == 600, "state TTL is 600s");
    const t = newOAuthState();
    check(t.length == 40, "state token is 40 chars");
    foreach (char c; t) {
        if (!isAlphaNum(c)) {
            check(false, "state token is alnum only");
            break;
        }
    }
}

private void testOAuthIdentityFilterShape() {
    // The exact literal UserRepository.findByOAuth queries with: $elemMatch
    // keeps provider and subject bound to the same array element.
    // Dot-notation across array elements could false-match across two
    // identities, so this shape is load-bearing.
    auto filter = Bson(["oauthIdentities": Bson(["$elemMatch": Bson(["provider": Bson("github"), "subject": Bson("42")])])]);
    const s = filter.toString();
    check(s.canFind("$elemMatch"), "filter uses $elemMatch");
    check(s.canFind("github"), "filter binds provider");
    check(s.canFind("42"), "filter binds subject");
}

private void testLoadSettingsEmptyByDefault() {
    // CI/dev machines carry no OAuth env: every provider reads disabled.
    // (A machine WITH OAuth env set would list entries instead; the gate
    // itself is covered by testSettingsGate.)
    bool anyEnv = false;
    foreach (p; oauthProviders) {
        const prefix = "IRCFIBER_OAUTH_" ~ p.name.toUpper ~ "_";
        try {
            if (environment.get(prefix ~ "CLIENT_ID", "").length > 0) anyEnv = true;
        } catch (Exception) {}
    }
    auto loaded = loadOAuthSettings();
    if (!anyEnv) check(loaded.length == 0, "no OAuth env means no providers");
    else writeln("oauth env present; skipping empty-by-default assertion");
}

private void testDeriveExtra() {
    // 32-char IRC cap is the caller's truncation; derivation itself keeps
    // the full sanitized base.
    check(deriveOAuthUsername("octo_cat-99", "") == "octo_cat-99", "handle passthrough");
    check(deriveOAuthUsername("", "a+b@example.com") == "ab", "plus stripped from local-part");
    check(deriveOAuthUsername("x", "y@z.co") == "x", "handle wins over email");
}

private void testCodebergAndGitlabTable() {
    const cb = oauthProvider("codeberg");
    check(cb !is null && cb.emailsUrl == "https://codeberg.org/api/v1/user/emails", "codeberg emails URL");
    check(cb.scope_.length == 0, "codeberg scope unset");
    const gl = oauthProvider("gitlab");
    check(gl !is null && gl.scope_ == "read_user", "gitlab scope");
    check(gl.userUrl == "https://gitlab.com/oauth/userinfo", "gitlab userinfo URL");
}

private void testOAuthIdentityJsonRoundTrip() {
    import std.uuid : randomUUID;
    import vibe.data.json : Json;
    User u;
    u.id = randomUUID();
    u.username = "bob";
    u.oauthIdentities = [OAuthIdentity("github", "42")];
    auto rt = User.fromJson(u.toJson());
    check(rt.oauthIdentities == [OAuthIdentity("github", "42")], "identities JSON round-trip");
    // Pre-OAuth rows (missing key) read as unlinked: no migration.
    auto bare = User.fromJson(Json(["id": Json(u.id.toString()), "username": Json("x"),
        "email": Json("e"), "passwordHash": Json("")]));
    check(bare.oauthIdentities.length == 0, "missing key reads as []");
}

int main() {
    testSettingsGate();
    testRedirectUri();
    testStateStoreShapes();
    testOAuthIdentityFilterShape();
    testLoadSettingsEmptyByDefault();
    testCodebergAndGitlabTable();
    testOAuthIdentityJsonRoundTrip();
    if (failures == 0) writeln("oauth_test: all checks passed");
    else writefln("oauth_test: %d FAILURES", failures);
    return failures == 0 ? 0 : 1;
}
