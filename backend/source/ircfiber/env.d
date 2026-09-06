/**
 * Secret-bearing environment lookups.
 *
 * Every container env var is visible in cleartext to anyone who can run
 * `docker inspect ircfiber-gateway`, and it is echoed by Ansible, by
 * `docker compose config` and by any bug report that pastes an inspect.
 * On 2026-09-06 that meant the Mongo application password, the IRCd oper
 * password, the SigNoz API key and the support bot's NickServ password were
 * all one command away for anyone with docker socket access.
 *
 * So secrets are deployed as *files* (root-owned, mode 0400, bind-mounted
 * read-only under /etc/ircfiber/gateway/secrets) and the env only carries
 * the path: `IRCFIBER_MONGO_URL_FILE=/etc/ircfiber/gateway/secrets/mongo_url`.
 * An inspect then leaks a path, not a credential.
 *
 * The file deliberately WINS over an inline `NAME=<value>`: the inline value
 * is the legacy/dev-convenience form, and a half-migrated host that still
 * has both must use the one the deploy intends. Precedence the other way
 * round would make a leftover env var silently shadow the rotated secret.
 */
module ircfiber.env;

import std.process : environment;
import std.string : strip, stripRight;
import vibe.core.log : logWarn;

/// Reads a secret from `<name>_FILE` when that is set and readable,
/// otherwise from `name` itself, otherwise `fallback`.
///
/// Trailing whitespace is stripped because `ansible.builtin.copy` with
/// `content:` appends a newline; leading whitespace is kept, since only the
/// tail is an artifact of how the file is written and a secret is allowed to
/// contain anything else.
///
/// Never throws and never logs the value: an unset, unreadable or empty
/// file falls back to the inline env var with a warning naming the path
/// only. Callers therefore keep their existing "not configured" behaviour
/// when a secret is missing instead of taking the process down.
string envSecret(string name, string fallback = "") {
    string inline;
    try
        inline = environment.get(name, fallback);
    catch (Exception)
        inline = fallback;

    string path;
    try
        path = environment.get(name ~ "_FILE", "").strip();
    catch (Exception)
        path = "";
    if (path.length == 0)
        return inline;

    try {
        import std.file : read;
        auto value = (cast(string) read(path)).stripRight();
        if (value.length == 0) {
            warnSecretFile(name, path, "is empty");
            return inline;
        }
        return value;
    } catch (Exception e) {
        warnSecretFile(name, path, e.msg);
        return inline;
    }
}

/// Logging is split out so a failing logger can never propagate out of
/// `envSecret` (vibe's log sinks touch files and sockets).
private void warnSecretFile(string name, string path, string reason) {
    try
        logWarn("%s_FILE (%s) %s; falling back to the inline %s env var",
            name, path, reason, name);
    catch (Exception) {
    }
}
