# Linking irc.gangnet.org to IRC Fiber

IRC Fiber runs InspIRCd 4, which does not speak TS6. The link is made by a
small translating server on our side, **`link.ircfiber.com` (SID `0TS`)**,
that dials your ergo as an ordinary TS6 server and mirrors users, channels
and messages both ways. From your side it looks like a normal TS6 link to a
server that has a few servers behind it.

**We dial you.** Nothing on your side ever connects out to us, and you do
not need to open anything new: we connect to your existing TLS listener.

---

## 1. What we need from you

| Item | Example | Notes |
|---|---|---|
| Server name | `irc.gangnet.org` | Must be the `server.name` in your `ircd.yaml`, and must contain a dot. |
| SID | `1GN` | **Must start with a digit** and match `^[0-9][0-9A-Z]{2}$` (InspIRCd rejects any other SID). Not `0TS`, `1FB`, `2FB`, or `00A`–`00Z` (ours). |
| Host we dial | `irc.gangnet.org` or an IP | Where your TLS listener is. |
| TLS port | `6697` | Your normal client TLS port is fine; a dedicated one is fine too. |

Passwords: there are two, one per direction. We will send you both over a
private channel (not IRC). The table in section 2 shows exactly where each
one goes. Do not reuse either for anything else.

Please also confirm you are running `waveplate/ergo` branch `ts6-linking`
at commit `cc472a96` or later:

```sh
git -C /path/to/ergo merge-base --is-ancestor cc472a96 HEAD && echo ok
```

## 2. Your `ircd.yaml`

Add or merge the following. Everything not shown stays as you have it.

```yaml
server:
    name: irc.gangnet.org
    sid: "1GN"                     # any SID starting with a digit; tell us which

    # Longest line ergo will accept over the link and from clients. IRC Fiber
    # allows 8192; anything longer than your value is truncated by ergo,
    # never rejected. Already in ergo (default 512); 4096 is a good value.
    max-line-len: 4096

    # Lets nicks carry IRC formatting (colour/bold bytes) and Unicode
    # glyphs. IRC Fiber accepts the same, so a user with such a nick shows
    # up identically on both networks.
    allowed-characters:
        irc-formatting: true
        printable-glyphs: true

    links:
        ircfiber:
            name: link.ircfiber.com
            sid: "0TS"
            # Only used if YOU dial; we dial you, so these are inert.
            hostname: irc.ircfiber.com
            port: 6697
            tls: true
            # What ergo puts in the PASS it sends us.
            send-password: "PASSWORD-A"
            # What ergo expects in the PASS we send.
            receive-password: "PASSWORD-B"
            # Leave off: we are the connecting side.
            auto-connect: false

logging:
    -
        method: stderr
        type: "server s2s"
        level: debug           # during bring-up; back to info afterwards
```

Password mapping, so nobody has to think about it twice:

| You (`ircd.yaml`) | Us |
|---|---|
| `send-password: PASSWORD-A` | our *receive* password |
| `receive-password: PASSWORD-B` | our *send* password |

> **Do not skip the `links.ircfiber` entry.** With no matching entry, ergo
> accepts an inbound link from SID `0TS` *without checking any password*.
> We will not bring the link up in production against a server configured
> that way.

Then restart ergo (a restart is the safe way to load a new `links` entry).

## 3. Firewall

Allow inbound TCP from IRC Fiber to your TLS port:

```
15.204.93.54    (IPv4; the link is dialled from this address)
```

Your TLS certificate does not need to be issued by anyone in particular —
our side authenticates the link by the passwords, not the certificate — so
a self-signed cert is fine.

Check the listener is reachable from outside before telling us to go:

```sh
openssl s_client -connect irc.gangnet.org:6697 -servername irc.gangnet.org </dev/null | head
```

## 4. Bring-up

1. Apply section 2, restart ergo, and send us: server name, SID, host, port.
2. We enable the link on our side. Our server dials within about 30 s and
   retries every 30 s until it succeeds, so a wrong password shows up in your
   log as a repeating attempt rather than a single failure.
3. Your log (`s2s`, level info) shows, in this order:

   ```
   Registered server in graph : link.ircfiber.com : 0TS : hops: 1
   Bursting network state to link : link.ircfiber.com : 0TS
   Finished initial burst to : link.ircfiber.com
   Registered server in graph : irc.ircfiber.com : 1FB : hops: 2
   Registered server in graph : services.ircfiber.com : 00A : hops: 3
   Burst completed and acknowledged by link : link.ircfiber.com : 0TS
   ```

4. Verify from a client on your server:

   ```
   /LINKS                       → link.ircfiber.com, irc.ircfiber.com, services.ircfiber.com (and more, see below)
   /JOIN #ircfiber              → IRC Fiber's main channel; say hello
   /WHOIS <someone in #ircfiber> → shows irc.ircfiber.com as their server
   /MSG NickServ HELP           → this is YOUR NickServ (ergo's), not ours; see section 6
   ```

If something is wrong, the message in your log tells you which step:

| Your log says | Cause |
|---|---|
| `invalid link password for SID 0TS` | PASSWORD-A/B are swapped, or one is mistyped. |
| `invalid SID format` | Your `server.sid` does not match `^[0-9][0-9A-Z]{2}$`. |
| nothing at all | Firewall, or the port/host you gave us is not the listener. Check with the `openssl` command above. |
| link comes up then drops with `Received ERROR from peer` | Read the text after `ERROR`; it names the reason (SID clash, name mismatch, etc.). |

## 5. What you will see on your network

Servers behind `link.ircfiber.com`:

- `irc.ircfiber.com` (`1FB`) — the hub, where all of our users are.
- `services.ircfiber.com` (`00A`) — our Anope: NickServ, ChanServ, BotServ,
  HostServ, MemoServ, OperServ, Global, BridgeServ, FIBERSERV.
- `k8s.ircfiber.com` (`2FB`) — a second InspIRCd, only when it is up.
- `<number>.discord.bridge` (`00B`, `00C`, …) — one virtual server per
  bridged Discord guild. The users on them are Discord members mirrored
  onto IRC (`#dmz` etc.); they are ordinary users.

Our users' hostnames are cloaked (`….hidden`); web-client users come
through with their real address behind that cloak.

**Every channel is linked** — there is no channel allowlist. A user on
either side who joins `#foo` is in the same `#foo` as everyone on the other
side.

## 6. Things that behave differently across the link

Because our end is a translator rather than a native TS6 server:

- **Services are per-network.** `/msg NickServ` from your users reaches
  *your* ergo NickServ. Our services still act on your users when a rule
  applies to them: a user of yours who takes a nick that is registered and
  protected on IRC Fiber gets our NickServ's warning and is renamed to
  `Guest####` after a minute. They cannot identify to our NickServ from
  your network, so the answer is simply a different nick.
- **Do not register on your ChanServ a channel that is registered on ours
  (`#ircfiber`, `#welcome`, `#support`, `#staff`, `#dmz`), and we will do
  the same for yours.** Two ChanServs enforcing different mode locks on one
  channel fight forever. If you want a shared channel with services on it,
  tell us and we agree on which side owns it.
- **Accounts do not cross.** Your users appear on our side as not logged
  in (and ours on yours), so account-based access (`+R`, extbans, ChanServ
  access lists keyed on accounts) never matches a user from the other
  network. Host-mask bans work as usual.
- **Modes that cross:** channel `i m n p s t k l b e I` and status `q a o
  h v`. Anything else is applied locally and not sent. User mode `+i`
  crosses; `+o` is shown but grants nothing on the other side.
- **Nick collisions** follow TS6: the older nick wins, an exact tie kills
  both.
- **Channel timestamps:** if the same channel exists on both sides before
  the link, our side keeps its own TS and its own modes regardless; ergo
  adopts ours when it is older. Your members are joined either way.
- **Not relayed:** `WALLOPS`, `OPERWALL`, `KNOCK`, `SASL`, `CERTFP`,
  account logins (`ENCAP SU`/`LOGIN`), server notices. `KILL` crosses in
  both directions; a kill by one of your opers of one of our users lands.
- **Nick rules:** on our side a nick may not start with a digit, `#`, `$`,
  `:`, `~`, `&`, `@`, `%` or `+`, and may not contain a space, `!`, `*`,
  `,`, `.`, `?` or `@`. A user of yours whose nick breaks these is killed
  with `Nickname is not valid on the linked network` the moment they
  connect or change to it. Formatting bytes and UTF-8 are fine. Max nick
  length 32.

## 7. Taking the link down

Either of us can do it in isolation:

- **You:** remove the `links.ircfiber` entry and restart, or block
  `15.204.93.54`. Our side will retry every 30 s and log it until we turn
  the link off; that is harmless.
- **Us:** one deploy removes our link server; you see `SQUIT
  link.ircfiber.com` and everything behind it leaves cleanly.

## 8. Contact during bring-up

Keep `logging` at `debug` for `s2s` until we have confirmed both
directions. If you can, be in `#ircfiber` on our web client
(<https://ircfiber.com>) while we bring it up so we can check the same
channel from both sides.
