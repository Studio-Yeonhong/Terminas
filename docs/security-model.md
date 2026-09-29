# Terminas security model

This document describes how Terminas protects vault contents, how sign-in works, what the server can and cannot learn, how the web relay and the desktop app are hardened, how the admin console is kept off the public server, how app updates are verified, and which risks remain.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Contents

- [Goals](#goals)
- [Key hierarchy](#key-hierarchy)
- [Accounts: encryption password and recovery key](#accounts-encryption-password-and-recovery-key)
- [Vaults and vault keys](#vaults-and-vault-keys)
- [Vault items and logs](#vault-items-and-logs)
- [Unlocking, auto-lock and remembered unlock](#unlocking-auto-lock-and-remembered-unlock)
- [Sign-in and sessions](#sign-in-and-sessions)
- [Sign-in password vs encryption password](#sign-in-password-vs-encryption-password)
- [Open sign-up](#open-sign-up)
- [What the server knows](#what-the-server-knows)
- [Admin console](#admin-console)
- [Web SSH and the relay](#web-ssh-and-the-relay)
- [Desktop app hardening](#desktop-app-hardening)
- [Signed updates](#signed-updates)
- [HTTP request tool](#http-request-tool)
- [Offline mode (desktop app)](#offline-mode-desktop-app)
- [Server-side measures](#server-side-measures)
- [Known limitations and residual risks](#known-limitations-and-residual-risks)
- [Verification scripts](#verification-scripts)

## Goals

- The server, its operator and anyone who copies its database must not be able to read vault contents: host addresses, usernames, passwords, SSH keys, snippets, forwarding rules, known hosts, saved HTTP requests.
- The server should not be able to tamper with vault contents unnoticed (for example by moving ciphertext between items or vaults).
- The server still enforces who may sign in, who belongs to which team, and who may write to which vault.
- A stolen session alone must not be enough for destructive account operations.

## Key hierarchy

```
encryption password ──argon2id──▶ KEK ────┐
recovery key (160 bits) ──HKDF───▶ RKEK ──┴─▶ account key (32 bytes) ──▶ account X25519 private key
vault key (32 bytes) ── sealed to each member's X25519 public key ──▶ stored per member on the server
vault items ── AES-256-GCM with the vault key, AAD = item:<vault>:<item>:<kind>
```

All of this happens in the browser or desktop app (`web/src/e2ee.ts`). Only ciphertext and public keys reach the server.

## Accounts: encryption password and recovery key

- Each person creates an **encryption password** after their first sign-in. It is separate from how they sign in and is never sent to the server.
- The password is stretched with **argon2id** (64 MiB of memory, 3 iterations, parallelism 1, 16-byte random salt) into a **key-encryption key (KEK)**.
- A random 32-byte **account key** is wrapped with the KEK using AES-256-GCM. The wrapped key and the argon2id parameters form the person's *key bundle*, stored on the server.
- Each account has an **X25519 key pair**. The public key is stored in plain form (others need it to share vaults); the private key is stored encrypted with the account key.
- At setup the person is shown a **recovery key** once: 160 random bits, displayed as 8 groups of 4 characters. It is turned into a second wrapping key with HKDF-SHA-256 and wraps the same account key. With it, a forgotten encryption password can be replaced.
- The server accepts a changed key bundle (new password, new recovery key) only together with a proof value derived from the account key, so only someone who has unlocked the account can replace it.
- Both the client and the server accept argon2id parameters only within fixed bounds (19–256 MiB of memory, 1–10 iterations, parallelism 1–4), so a server cannot make a device hang with extreme values and no bundle can be stored with parameters below the floor.
- **Starting over.** If someone loses both the encryption password and the recovery key, they can create new keys. Their personal vault's contents are deleted and team admins share team vault keys with them again. This is allowed **only within 10 minutes of signing in** (so someone who only stole a session cannot do it), and afterwards all of that person's other sessions and their open web relays are closed.

## Vaults and vault keys

- Every team vault and every personal vault has its own random 32-byte **vault key**, created by a client. The server can neither create nor open vault keys.
- For each person allowed to see a vault, a client **seals the vault key to that person's X25519 public key**: an ephemeral X25519 key agreement, HKDF-SHA-256, then AES-256-GCM, with the vault and recipient bound into the associated data. These sealed copies are stored on the server.
- **Sharing with a new member.** After a new team member sets up encryption, owners and admins see that members are waiting for vault keys. The admin checks the person's email and **public key fingerprint** (ideally by comparing it with them out of band) and confirms; the admin's client then seals the key. If a member's key differs from the one this device saw before, it is shown as changed and is not selected by default.
- **Vault key pinning.** Each device remembers a fingerprint of every vault key it has opened. If the server later hands out a different key for the same vault, the client refuses to open the vault and warns.
- **Removal.** When someone leaves a team or loses access to a vault, the server deletes their sealed copies. Anything they already decrypted cannot be taken back, so credentials they could see should be changed. (Re-encrypting a vault under a new key is not implemented yet.)

## Vault items and logs

- Hosts, groups, SSH keys, identities (saved username/password sets), snippets, forwarding rules, known hosts, per-person host credentials, saved HTTP requests and HTTP environments are each encrypted as one blob with **AES-256-GCM** under the vault key.
- The associated data binds each ciphertext to its **vault, item ID and item kind**. If the server moves a ciphertext to another item or vault, decryption fails.
- The server sees only each item's kind, vault and timestamps (and who created or last changed it).
- **Host keys (known hosts)** are verified on first connection and stored encrypted in the vault. A changed host key blocks the connection. Writing a trusted fingerprint into a team vault needs edit permission; a view-only member's trust decision goes into their own personal vault and applies only to them, so they cannot plant a fake fingerprint for the whole team.
- **Logs.** Connect and disconnect events are reported by the clients (the server is not part of desktop connections). The target name in each log entry (for example a host alias) is encrypted with the vault key; the server sees the action, time, user and IP address.

## Unlocking, auto-lock and remembered unlock

- Unlocking derives the KEK in the client, unwraps the account key and opens the vault keys in memory.
- **Auto-lock** clears vault keys from memory after a period without input and closes open connections. It is set per device; the default is 15 minutes on the web and off in the desktop app.
- The **web UI never remembers an unlock**; reloading the page asks again.
- The **desktop app can remember the unlock on this PC**: the account key is protected with the operating system's protected storage (DPAPI on Windows) and kept in the app's settings file. Anyone who can sign in to that Windows account can then open the vaults; the setting says so.

## Sign-in and sessions

Sign-in proves identity; it never unlocks vaults.

- **Google (OpenID Connect).** Authorization code flow with PKCE, a `nonce`, and a `state` value bound to the browser with a cookie. The ID token is verified against Google's keys, and only Google-verified email addresses are accepted.
- **Desktop Google sign-in.** The app opens the system browser. After sign-in, the server redirects a one-time code to the app on a temporary `127.0.0.1` port; the app exchanges it for a session token. The code is bound to the app with PKCE and expires after 2 minutes.
- **ID and password** (`SHELL_PASSWORD_LOGIN=1`). Passwords are hashed with **scrypt** (N=2^15, r=8, p=1, 16-byte salt). Unknown IDs are checked against a dummy hash so they take the same time and return the same error as wrong passwords. After 10 failures per ID or 50 per IP address within 15 minutes, attempts are blocked for the rest of the window. Only after a correct password does the server say whether an account is disabled or has no team.
- **Invite codes** for password servers are 12 characters from an unambiguous alphabet (`XXXX-XXXX-XXXX`), valid for 7 days, shown once and stored only as a SHA-256 hash. Regenerating one invalidates the previous code. Failed attempts count toward the same limits.
- **Two-factor authentication (TOTP, RFC 6238).** Optional per person. A session that has not yet passed the code is "half signed in": every API call and the relay are refused. Five wrong codes delete that session; a code cannot be reused; each of the ten recovery codes works once. Turning 2FA on requires other sessions to enter a code again and closes their web relays. TOTP secrets are sealed with a server key (`SHELL_TOTP_KEY` or `<data>/totp.key`) using AES-256-GCM, so a leaked database file alone does not expose them.
- **Sessions** last 7 days. Only a SHA-256 hash of the session token is stored.
  - Web: an `HttpOnly`, `SameSite=Lax` cookie, `Secure` when the server runs on HTTPS. State-changing API requests must come from the configured origin and carry a custom header, which blocks cross-site request forgery.
  - Desktop app: a bearer token kept encrypted with OS protected storage. API calls are made by the app's main process, so the UI never holds the token.
- Signing out, changing a sign-in password, or starting over with new keys ends the relevant sessions and **closes their open web relays immediately**.

## Sign-in password vs encryption password

On servers with ID/password sign-in, the server receives the **sign-in password** every time someone signs in. If a person used the same value as their **encryption password**, the server — or whoever controls it — could derive their KEK and open their vaults. So the two must differ:

- When someone sets a sign-in password in Settings, the client first tries to unlock their key bundle with it and refuses if that works.
- After a password sign-in, the client keeps a salted hash of the sign-in password in memory (never the password itself; it disappears on reload or sign-out) and refuses an encryption password that matches it during setup, recovery or a password change.
- Server-side tools such as `user:password` change only the sign-in password. There is no server-side way to reset an encryption password.

## Open sign-up

By default only invited people and server admins can sign in. With `SHELL_OPEN_SIGNUP=1`, anyone with a Google-verified email address can create an account without an invite, keep using their personal vault without a team, and create teams. This changes who can sign in, not how vaults are protected:

- **Every new account creates its own keys** — encryption password, account key and X25519 key pair — on its own device, exactly as described above. The server hands out no keys.
- **Signing up opens only the person's own personal vault.** Nobody can read a team vault without being added to the team and then receiving the vault key, which only a member who already holds it can seal to the newcomer's public key.
- **No self sign-up with ID and password.** The server cannot verify an email address typed into a form, and a self-registered address would receive team invites meant for the real owner of that address. On password servers people still join with one-time invite codes; Google sign-in accepts only verified addresses.
- **Anyone who can sign in can use the web relay,** so the relay's limits (see [Web SSH and the relay](#web-ssh-and-the-relay)) and what the server can reach on its network matter more on such servers. Per-person limits on teams, vaults and items (see [Server-side measures](#server-side-measures)) keep a single account from filling the database.

## What the server knows

| The server knows | The server cannot know |
|---|---|
| Emails, names, avatars, sign-in and last-seen times | Encryption passwords, recovery keys, account keys, private keys, vault keys |
| Team names, vault names, memberships, roles, vault permissions | Host addresses, usernames, passwords, SSH keys, snippets, forwarding rules |
| Public keys and their fingerprints | Known-host fingerprints and host OS details |
| Item kinds, counts and timestamps per vault | Saved HTTP requests and environments |
| Log actions, times, IP addresses; session IPs and user agents | Log target names (encrypted with the vault key) |
| Sign-in passwords at the moment of sign-in (stored only as scrypt hashes) | Terminal contents and file transfers (SSH-encrypted end to end) |
| TOTP secrets (sealed with the server key) | |
| For web SSH: the destination host and port while a relay is open (not stored) | |
| For the HTTP tool: status code, duration and failure category of each sent request | The URL, headers and bodies of HTTP requests and responses |

Whoever can sign in to the **[admin console](#admin-console)** sees part of the left column: account metadata (email, name, avatar, sign-in methods, whether two-factor authentication and encryption keys are set up, sign-up and last sign-in times, number of active sessions), team names with their owners and member and vault counts, totals of teams, vaults, items and sessions, and the server log of events outside vaults with IP addresses. The console API has no endpoint that returns vault items, vault keys, key bundles or vault log entries. From the console, accounts can be disabled, signed out or deleted and two-factor authentication can be reset — each recorded in the audit log — but none of this lets anyone read anything encrypted.

The **server admin** role that people can hold (`users.is_admin`: the emails in `SHELL_BOOTSTRAP_ADMINS`, the `SHELL_ADMIN_ID` account, or people promoted in the console) only lets them create teams without limits and sign in without belonging to a team. It gives no admin screen and no admin API in the web UI, the desktop app or the public server.

## Admin console

Managing people and teams is done in a separate **admin console** (`server/src/console/`), not in the clients:

- **No admin code in the clients and no admin API on the public server.** The web UI and the desktop app contain no admin screens, and the public API has no `/api/admin/*` endpoints. A stolen session, a taken-over Google account of a server admin, or a script injected into the web UI therefore cannot reach account management. Using the console requires reaching the server machine itself and knowing the console password.
- **Its own listener, on the server machine only.** The server process opens the console as a second HTTP listener on its own port, `127.0.0.1:5282` by default (`SHELL_CONSOLE_PORT`, `SHELL_CONSOLE_HOST`; `0` turns it off). The Docker setup publishes it only on the host's `127.0.0.1`. It is not meant to go through the public reverse proxy; operators reach it on the machine, over remote desktop, or through an SSH tunnel (`ssh -L 5282:127.0.0.1:5282 user@server`). It speaks plain HTTP, relying on loopback or the SSH tunnel for transport security.
- **Host check against DNS rebinding.** The console answers only requests whose `Host` is `127.0.0.1`, `localhost` or `[::1]` (with any port); anything else gets 421. A web page that points its own domain name at `127.0.0.1` therefore cannot talk to the console from a browser on the server machine.
- **Cross-site request protection.** Requests that change state must carry the custom header `x-console: 1` and, if the browser sends an `Origin`, a loopback one. The session cookie is `HttpOnly`, `SameSite=Strict` and limited to `Path=/admin`.
- **Its own credential, set only on the server.** The console password is independent of people's accounts and of Google sign-in. It is set with a command-line tool on the server (`npm run console:password -w server`) and stored in the database's `meta` table only as a scrypt hash, like sign-in passwords (10–200 characters). A TOTP code can be required as well (`--otp`); its secret is sealed with the same server key as users' TOTP secrets, and a code cannot be reused. Until a password is set, nobody can sign in; `--off` removes it again.
- **Sessions.** Console sessions last 8 hours and are kept in memory only (the server stores a SHA-256 hash of the token), so a restart ends them. Changing the password or the OTP setting ends every open console session.
- **Throttling.** After 5 failed sign-ins from one IP address within 15 minutes, further attempts — even with the right password — are refused until the window ends.
- **Strict page.** The console is a plain HTML/JavaScript page served with `Content-Security-Policy: default-src 'self'; script-src 'self'; ... frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and `no-store`. It inserts names and emails as text, never as HTML.
- **Audited.** Console sign-ins (`console_login`), failed sign-ins (`console_login_failed`), password and OTP changes (`console_password`) and every account action are recorded in the audit log. Account actions carry `detail.by = "console"` and no acting user, because the console is not tied to anyone's account.

## Web SSH and the relay

In the web UI, the **browser itself speaks SSH** (built on `@microsoft/dev-tunnels-ssh` with WebCrypto, plus Ed25519, OpenSSH private-key parsing and an SFTP client implemented in `web/src/ssh/`). The server's relay (`server/src/relay.ts`, `/api/relay`) only moves bytes between a WebSocket and a TCP connection. Those bytes are already SSH-encrypted, so the server cannot read passwords, keys or terminal contents.

The relay is deliberately narrow:

- **Signed-in users only, from the configured origin only.** The WebSocket's `Origin` must match `SHELL_PUBLIC_URL`, and the session must have completed two-factor authentication.
- **No bytes forwarded before an SSH greeting.** Nothing the browser sends is passed on until the target has sent a line starting with `SSH-`. If no greeting arrives within 10 seconds, or the target sends something that is not an SSH identification line, the connection is closed. This keeps the relay from being used to talk to databases, web servers or other non-SSH services.
- **Block list for the server itself** (always, except local development on a localhost address). Destinations are checked by resolved IP address with `net.BlockList`, not by string matching: `0.0.0.0/8`, loopback `127.0.0.0/8`, link-local `169.254.0.0/16` (including cloud metadata endpoints), multicast and reserved `224.0.0.0/3`, the IPv6 unspecified/loopback/IPv4-compatible range `::/96`, NAT64-wrapped loopback, `fe80::/10`, `ff00::/8`, IPv4-mapped IPv6 forms of all of these, and **every address of the server's own network interfaces**.
- **Limits.** At most 20 concurrent relays per person, and at most 120 new relays per person within 10 minutes, so that one account cannot use the server to sweep networks for SSH servers. Buffers are bounded before the connection opens, with back-pressure afterwards.
- **Session binding.** Each relay belongs to the session that opened it. Signing out closes it immediately, and starting over with new keys or changing the sign-in password closes the relays of the person's other sessions. While a relay is open, its session and the person's right to sign in (not disabled, and still in a team unless they are a server admin or the server has open sign-up) are re-checked every 30 seconds.
- **No destination logging.** The relay knows where it connects only while the connection is open and does not record it. A ping every 30 seconds keeps proxies from dropping idle connections.

Note that private networks around the server are **not** blocked: web users can reach any SSH server the Terminas server can reach.

## Desktop app hardening

- **Bundled UI.** The desktop app ships the web UI inside `app.asar` and loads it from `app://terminas`. It never loads UI code from the Terminas server, so a compromised server cannot swap in code that captures passwords. UI changes reach app users only through a new app version.
- **Narrow bridge.** The app's native functions are exposed only to pages from `app://terminas`, checked both in the preload script and in the main process. The UI's Content Security Policy allows only its own scripts (plus WebAssembly). Other links open in the system browser. Only clipboard, notification and fullscreen permissions are granted.
- **Electron fuses** (set at build time in `desktop/package.json`): `RunAsNode`, the `NODE_OPTIONS` variable and `--inspect` arguments are disabled; embedded `app.asar` integrity validation, loading the app only from `app.asar`, and cookie encryption are enabled.
- **Blocked switches.** The installed app exits immediately if started with `--remote-debugging-port`, `--remote-debugging-pipe`, `--remote-debugging-address`, `--ignore-certificate-errors`, `--ignore-certificate-errors-spki-list`, `--disable-web-security` or `--load-extension`.
- **Bundled ConPTY** for the local terminal, so the terminal library never needs a `RunAsNode` helper process.
- **No obfuscation.** The app contains no secrets, and any decryption key for obfuscated code would have to ship inside the app anyway. Integrity is protected by the measures above instead.
- **Small things.** Deleting local files moves them to the recycle bin. Reloading or closing a window closes the SSH connections that window opened. Terminal sessions disable Nagle's algorithm so single keystrokes are sent at once.
- **Stored secrets.** The sign-in token and the optional remembered unlock are encrypted with DPAPI.

## Signed updates

Without a Windows code-signing certificate, `electron-updater` verifies nothing about a downloaded installer. Terminas therefore adds its own signature check (`desktop/src/update-verify.js`), so that whoever controls the update server or the update folder still cannot make installed apps run a fake installer.

- **Signing key.** An Ed25519 key pair created with `npm run update-key:init`. The private key is encrypted with a passphrase of at least 12 characters (scrypt N=2^17, r=8, p=1 plus AES-256-GCM) and kept outside the repository and outside the server. Only public keys go into `desktop/update-keys.json`, which is built into the app.
- **What is signed.** The string `terminas-update-v1`, the app ID, the version and the installer's SHA-512, written into `latest.yml` as `terminasSigKey` and `terminasSig`.
- **What the app checks.** It computes the SHA-512 of the downloaded file itself, requires a known key ID and a valid signature, and accepts only versions **newer than the one installed** (no downgrade to an older signed build). Otherwise it refuses to install and reports that the update signature is invalid.
- **Cache clearing.** `electron-updater` can reuse a previously downloaded installer without calling the verifier, so the app empties that cache at startup and before each check.
- **Signing safety net.** The signing script refuses to sign a build whose app does not contain the signing key's public key, because such a release would be unable to accept the next update.
- **Official feeds only.** The official app always takes updates from the official update feeds in `desktop/app-config.json`, no matter which server the user connects to: GitHub Releases (`updateUrl`, https://github.com/Studio-Yeonhong/Terminas/releases/latest/download) first, and the official server's `/updates` (`updateFallbackUrl`) if that fails. The signature check is the same for both, so neither feed can deliver an installer without the official signature. Forks that ship their own builds must use their own key, feeds and app ID (see [development.md](development.md#releasing-your-own-desktop-builds)).
- **Beta channel.** Users who opt in (Settings, after a stability warning) read a separate beta feed (a fixed GitHub pre-release, then `/updates/beta` on the official server). Beta installers carry the same signature and pass the same check; the version order follows semver, so no channel can downgrade an installed app.

## HTTP request tool

The desktop app includes a Postman-style HTTP client. Its privacy rule is strict:

- **Requests go straight from the user's PC.** They are sent by the app's main process (`desktop/src/http.js`, Node's `http`/`https`). The Terminas server has no code that sends HTTP on anyone's behalf, and none will be added. The web UI does not offer the tool, and the relay cannot carry HTTP because it forwards nothing before an SSH greeting.
- **Saved requests and environments** are vault items, encrypted with the vault key like everything else and shared with the vault's members. In a view-only vault, requests can be sent but not saved.
- **Each sent request is logged**, with the target recorded as `METHOD URL` **without the query string or fragment** (they may contain tokens) and encrypted with the vault key. The server can read only the status code, the duration and a failure category (`timeout`, `dns`, `refused`, `reset`, `tls`, `cancelled`, `error`). Headers, bodies and responses are never stored.
- Redirects are followed up to 10 times, and `Authorization` and `Cookie` headers are dropped when a redirect leaves the original site. Response bodies are capped at 20 MB. Certificate verification can be turned off per request.
- Besides what the user sets, the app adds `User-Agent: Terminas/<version>`, `Accept: */*` and `Accept-Encoding: gzip, deflate, br` (a header with the same name set by the user wins). The headers tab lists everything the app adds, with auth values masked.
- **The history of sent requests stays in memory.** It can hold tokens and bodies, so it is never written to disk or the server and disappears when the app is locked, reloaded or closed.
- **Copy as code** (curl, PowerShell, JavaScript fetch, Python) fills in environment variables, including hidden ones, so the copied text can contain secrets.

## Offline mode (desktop app)

When the Terminas server cannot be reached, the desktop app keeps working from a copy on the PC. The web UI has no offline mode.

- **What is stored.** The answer of `/api/me` (profile, teams, the sealed vault keys and the password-locked key bundle) and, per vault, the items exactly as the server stores them — ciphertext. Nothing decrypted is written to disk. Each file is wrapped once more with the operating system's protected storage (DPAPI on Windows) in the app's settings folder (`offline/`, one folder per server). Opening the copy still needs the encryption password, or a remembered unlock.
- **Personal vault.** Readable and editable offline. Changes go into the copy, marked as pending, and are uploaded when the server is reachable again. If the same item was changed elsewhere in the meantime, the server's version stays and the offline edit is saved as a new item named "… (conflict copy)". An item deleted offline that was changed elsewhere is kept; an item changed offline that was deleted elsewhere is restored.
- **Team vaults.** Read-only offline, and only for 7 days counted from the last successful sync (a fixed period, the same for every team). Copies are deleted when those 7 days run out, when the vault disappears from the member's list (removed from the team or the vault), when the server rejects the session (401/403), and on sign-out. If the PC's clock is set more than 10 minutes behind the latest time the app has seen, team copies are not used.
- **Personal sync off.** Per device, the personal vault can be kept on that PC only: nothing is uploaded or downloaded, and connections from it are not reported to the server's log. Turning sync off can also empty the server copy (`DELETE /api/vaults/:id/items`, personal vaults only, logged as `vault_clear`). Turning it back on merges with the server as above. Signing out deletes the local copy, so the app warns first.
- **Logs.** Connection events that happen offline are queued (at most 2,000) and uploaded later together with the time they happened (`offlineAt`, accepted only within the last 30 days). The log view marks them.
- **No copy yet.** If the server is unreachable and the PC has no copy, the app can open a temporary mode with the local terminal and the HTTP tool. Anything created there stays in memory and is gone when the app closes.

## Server-side measures

- Strict security headers: HSTS (`max-age=31536000`) on HTTPS, a Content Security Policy for the web UI, `X-Frame-Options: DENY`, `nosniff`, `same-origin` referrer policy, `no-store` for API responses.
- SQLite runs with `secure_delete` on, so deleted or updated rows are overwritten with zeros. After schema migrations the database is vacuumed so old values do not linger in free pages or the WAL.
- Request bodies are limited in size; vault items must be well-formed ciphertext and are size-capped.
- Per-person limits against abuse, on every server: at most 20 owned teams (server admins excepted), 50 vaults per team and 5,000 items per vault.
- The server refuses to start with the development email sign-in enabled outside localhost, or with a terms, privacy, source or app download link that is not an http(s) URL.
- Every sensitive action (sign-in, invitations, role changes, key setup and reset, 2FA changes, admin resets, admin console sign-ins and failures, and every account action in the admin console) is recorded in the audit log.

## Known limitations and residual risks

- **Web code comes from the server.** When you unlock in the web UI, the code running at that moment was served by the Terminas server. Someone who controls the server could serve modified code and capture the encryption password typed there. The desktop app is not affected because its UI is bundled; use it for sensitive work. Auto-lock limits how long an unlocked web session stays open.
- **The relay sees destinations.** For web connections, the server knows which host and port are being contacted while the connection is open (it does not store this). Contents, passwords and keys remain SSH-encrypted.
- **Public keys come from the server.** A malicious server could present a fake public key for a team member. This is caught only if admins verify fingerprints when sharing vault keys — compare them out of band. Clients warn when a member's key changes.
- **Metadata is visible.** Emails, names, team and vault names, memberships, item counts and timestamps, log actions and IP addresses are not encrypted.
- **Departed members.** Removing someone deletes their sealed vault keys on the server, but cannot undo what they already decrypted, and vault keys are not rotated yet. Change the credentials they had access to.
- **The server holds sign-in secrets.** It receives sign-in passwords at sign-in and keeps TOTP secrets (sealed with its own key). A compromised server can therefore impersonate users at sign-in — but it still cannot open vaults, as long as sign-in and encryption passwords differ.
- **Update signing key.** Updates are only as safe as the signing key and its passphrase. If both were stolen — for example from a compromised machine at the moment of signing — a forged update could be signed. Keep the key file offline and back it up; losing both the key file and the passphrase means installed apps can no longer receive updates.
- **The first installer is not covered by the update signature,** and installers are not Windows code-signed yet. Download the app only from the official release page (https://github.com/Studio-Yeonhong/Terminas/releases).
- **Per-user installation.** The app is installed in the user's profile, so malware running as that user could modify it. A Windows code-signing certificate would make such changes visible; it is not in place yet.
- **Remembered unlock** on a PC means anyone who can use that Windows account can open the vaults.
- **Offline copies outlive revocation until the app reconnects.** A member removed from a team can keep reading that team's vaults on a PC that stays offline until 7 days after its last sync. Anyone who can use the Windows account can read the copy files, which hold only ciphertext; opening them still needs the encryption password, unless unlock is remembered.
- **The admin console trusts the server machine.** Anyone who can open connections on the server machine — local users and processes, or an SSH login that allows port forwarding — can reach the console port; only the console password (and its OTP, if turned on) stands in the way. Such access usually allows reading the database directly as well, so treat shell access to the server as administrative access.
- **Rate limits live in memory.** Sign-in throttling (including the admin console's), console sessions and the relay's connection limits are per server process and reset on restart. Terminas is designed to run as a single server process.

## Verification scripts

The `security-review/` folder contains scripts that exercise these protections against isolated, temporary servers. They never touch real databases, credentials or SSH servers. See [development.md](development.md#checks) for what each covers and how to run them.
