/**
 * Per-user MOTD data for the ircd's motdpool module: `motd.d/profiles`,
 * one TAB-separated record per address (geo + FiberEye rollup) plus the
 * reserved `default` record, read by the ircd on every MOTD.
 */
module ircfiber.web.admin.motd_profiles;

import std.path : buildPath;

import ircfiber.web.admin.ircd : loadIrcdSettings;

/// Records in the last successful profiles write (0 until one happens).
private __gshared long motdProfiles = 0;

/// Path of the ircd profiles file inside the gateway container (sibling of
/// the pool, same rw-mounted `motd.d/`).
package string motdProfilesPath() {
    return buildPath(loadIrcdSettings().confDir, "motd.d", "profiles");
}

package long motdProfileCount() { return motdProfiles; }
