# Developing Terminas

How the repository is organized, how to run everything locally, which checks to run, the translation rules, the app/server compatibility levels, and how to release your own desktop builds.

## Contents

- [Requirements](#requirements)
- [Repository layout](#repository-layout)
- [Local development](#local-development)
- [Checks](#checks)
- [Internationalization](#internationalization)
- [App/server compatibility levels](#appserver-compatibility-levels)
- [Releasing your own desktop builds](#releasing-your-own-desktop-builds)
- [Code notes](#code-notes)

## Requirements

- Node.js 24 or newer, npm.
- Server and web UI development works on any OS. Building the desktop app, and the verification scripts that launch it, need Windows.

## Repository layout

npm workspaces: `server`, `web`, `desktop`.

| Path | What it is |
|---|---|
| `server/` | The Terminas server: Fastify, SQLite through `node:sqlite`, TypeScript run directly by Node. |
| `server/src/` | `index.ts` (startup, headers, static files), `auth.ts` (Google, ID/password, invite sign-up, sessions, 2FA check, compatibility levels), `relay.ts` (web SSH relay), `db.ts` (schema and migrations), `password.ts`, `totp.ts`, `access.ts` (teams and vault permissions, who may sign in and create teams), `config.ts` (settings), `routes/` (account, teams, items, 2FA). |
| `server/src/console/` | The admin console, a separate listener on its own port (default `127.0.0.1:5282`): `index.ts` (Fastify listener, `Host` check, `x-console` header and origin check, session cookie, security headers), `auth.ts` (console password as a scrypt hash in the `meta` table, optional TOTP, in-memory 8-hour sessions dropped when the password or OTP changes, 5 failures per 15 minutes), `routes.ts` (`/admin/api/*`), and the plain HTML/JS page (`page.html`, `console.js`, `console.css`; Korean or English by browser language). |
| `server/scripts/` | Admin CLIs: `user-password.ts` (`npm run user:password -w server`), `mfa-reset.ts` (`npm run mfa:reset -w server`), `console-password.ts` (`npm run console:password -w server`, the admin console password and OTP). |
| `server/dev/` | A fake SSH + SFTP server for local development. |
| `web/` | The React + Vite UI, used by both the web and the desktop app. |
| `web/src/e2ee.ts` | All end-to-end encryption (argon2id, X25519, AES-GCM). |
| `web/src/ssh/` | The in-browser SSH engine (on `@microsoft/dev-tunnels-ssh`, pinned to 3.12.42 because `engine.ts` patches library bugs at runtime), SFTP client, file transfer. |
| `web/src/components/` | Screens. `web/src/locales/` holds the translations. |
| `web/scripts/i18n-check.mjs` | Translation checker. |
| `desktop/` | The Electron app. |
| `desktop/src/` | `main.js` (window, IPC, server picker, sign-in, updates), `ssh.js` (direct SSH, SFTP, port forwarding), `http.js` (HTTP tool), `update-verify.js` (update signature check), `i18n-main.js` (main-process text), `setup.html` (server picker page). |
| `desktop/app-config.json` | Built-in server address (`serverUrl`) and update feeds (`updateUrl` and `betaUpdateUrl`, both GitHub Releases; optional `updateFallbackUrl` and `betaFallbackUrl` for your own builds). |
| `desktop/update-keys.json` | Public keys that update installers must be signed with. |
| `desktop/scripts/` | `release.mjs`, `update-key.mjs` (signing), `publish.mjs`, `icon.mjs`. |
| `security-review/` | Verification scripts for security-sensitive behavior (see [Checks](#checks)). |
| `scripts/dev.mjs` | Starts the API, Vite and the fake SSH server together. |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | Server deployment (see [self-hosting.md](self-hosting.md)). |

## Local development

```bash
npm install
cp .env.example .env
```

In `.env`, set at least:

```dotenv
SHELL_DEV_LOGIN=1
SHELL_BOOTSTRAP_ADMINS=you@example.com
TEST_SSHD_PASSWORD=some-test-password
TEST_SSHD_OTP=123456
```

```bash
npm run dev
```

This starts:

| Process | Address |
|---|---|
| API server (restarts on changes) | `http://127.0.0.1:5381` |
| Vite dev server (proxies `/api` and `/updates` to the API) | `http://localhost:5380` |
| Fake SSH server with SFTP and port forwarding | `127.0.0.1:2222` |
| Admin console (part of the API process) | `http://127.0.0.1:5282/admin` |

Then:

1. Open http://localhost:5380 and use **Dev sign-in** with the email in `SHELL_BOOTSTRAP_ADMINS`.
2. Create an encryption password.
3. Open **Settings → Create team**.
4. Add a host `127.0.0.1`, port `2222`, user `demo` (or `TEST_SSHD_USER`) with `TEST_SSHD_PASSWORD`.

The fake SSH server (`server/dev/test-sshd.ts`) does not open a real shell. It also supports:

- Public-key sign-in: put public keys, one per line, into `data/dev-authorized_keys`.
- Keyboard-interactive 2FA: user `otp`, with the password plus `TEST_SSHD_OTP`.
- A changed host key: `npm run dev:sshd -- --new-hostkey`, to test the mismatch warning.
- OS detection: `TEST_SSHD_OS=ubuntu|debian|rocky|alpine|windows` imitates that OS.
- SFTP shows `data/dev-sftp-root` as `/`.

In local development (a localhost `SHELL_PUBLIC_URL` without `NODE_ENV=production`) the relay's block list is off, so the web UI can reach the fake server on `127.0.0.1`.

To try ID/password sign-in locally, set `SHELL_PASSWORD_LOGIN=1` with `SHELL_ADMIN_ID` and `SHELL_ADMIN_PASSWORD`.

To try the admin console, set its password with `npm run console:password -w server` and open http://127.0.0.1:5282/admin. The web UI and the desktop app have no admin screens. `SHELL_CONSOLE_PORT=0` turns the console off, for example when port 5282 is already in use.

### Desktop app in development

```bash
# bash
TERMINAS_PROFILE=dev STUDIO_SHELL_URL=http://localhost:5380 npm run dev:desktop
```

```powershell
# PowerShell
$env:TERMINAS_PROFILE='dev'; $env:STUDIO_SHELL_URL='http://localhost:5380'; npm run dev:desktop
```

- `TERMINAS_PROFILE` keeps a separate settings folder, so a development app can run next to an installed one (the single-instance lock is per folder).
- `STUDIO_SHELL_URL` overrides the server address.
- By default the app shows the Vite UI from `:5380`. With `TERMINAS_UI=dist`, it loads `web/dist` from `app://terminas` exactly like the installed app does (run `npm run build` first); useful for checking the CSP and WebAssembly loading.
- Dev sign-in also works in the app while `SHELL_DEV_LOGIN=1` and the server is on localhost.

## Checks

Run before every pull request:

```bash
npm run check                    # type-checks server and web
npm run build                    # builds the web UI
node web/scripts/i18n-check.mjs  # translation check (see below)
```

Changes to security-sensitive areas should also run the matching scripts in `security-review/`. Each one starts isolated, temporary servers, databases and keys, never touches real data, prints `PASS`/`FAIL` per check and exits non-zero on failure. Run them from the repository root.

| Script | What it covers |
|---|---|
| `node security-review/verify-fixes.mjs` | Fixes from the September 2026 security review: relays close on sign-out and when a session ends; starting over with new keys only within 10 minutes of sign-in; argon2id parameter bounds on server and client; the relay block list (loopback, IPv4-mapped and -compatible IPv6, link-local, the server's own addresses) while normal addresses stay allowed; SFTP path handling in web and app (names with path separators, deleting folders, server-to-server copy). |
| `node security-review/verify-password-login.mjs` | ID/password sign-in: startup validation, the env admin, scrypt-only storage (no plain text in the DB, logs or audit), identical answers for unknown IDs and wrong passwords, HttpOnly cookie, invite codes (format, 7-day expiry, hash only, single use, regeneration), throttling, setting and changing passwords, 2FA after password sign-in, the `user:password` CLI, and everything turned off when the feature is off. |
| `node security-review/verify-otp-teams.mjs` | Two-factor authentication (turning on and off, sealed secrets, half-signed-in sessions blocked from the API and relay, lockout after five wrong codes, no code reuse, recovery codes, `mfa:reset`) and team deletion (owner only, name confirmation, cascading deletes, logs kept, members left without a team signed out). |
| `node security-review/verify-open-signup-admin.mjs` | Open sign-up and the admin console (23 checks): startup refusal of a non-http(s) terms URL; `/api/auth/config` flags and links (source link defaulting to the official repository); signing up without an invite, a personal vault without a team, creating teams; the 20 owned teams and 50 vaults per team limits; no admin API on the public server, even for a server admin; the console page's strict CSP and `X-Frame-Options`; the `Host` check against DNS rebinding; no access before a password is set and no data without a console session; `console:password` rules (both entries must match); sign-in rejection (wrong password, missing `x-console` header, foreign `Origin`) and cookie flags (`HttpOnly`, `SameSite=Strict`, `Path=/admin`); overview numbers; user list and search (`%` matched literally, no password hashes or TOTP secrets in the output); disabling (signs the person out, sign-in refused) and enabling; granting and revoking server admin; signing out everywhere; resetting 2FA; delete rules (email confirmation, refused while the only owner of a team with other members, solo teams and sessions deleted); console sign-ins and admin actions in the server log with `by: console`; turning on OTP ends open console sessions and requires a code; `--off` locks everyone out; 5 failures in 15 minutes block even the right password; and `SHELL_CONSOLE_PORT=0` turning the console off, with an invite-only server rejecting uninvited people. |
| `node security-review/verify-http-tool.mjs` | The desktop HTTP tool against local test servers: redirects, dropping `Authorization`/`Cookie` across sites, gzip, the 20 MB cap, self-signed certificates, header injection refusal, cancellation, failure categories. Also the UI's request building (`web/src/http-tools.ts`): query params ↔ URL, form table, API key, default headers, code export, cookies. |
| `node security-review/verify-compat.mjs` | Mixed versions and update channels: 426 for apps below the server's minimum (while `/api/auth/config`, app download info and the web UI stay open), legacy apps accepted by default, vault item format levels (newer items are read-only, unknown fields survive edits), beta/stable publish targets and semver order, and in the app window the connected-server label and the beta opt-in with its warning. Opens a window. |
| `node security-review/verify-http-ui.mjs` | The HTTP tool in the real app window (dev Electron driven over the DevTools protocol) against a local test server: request tabs, params table, auto headers, what the server actually receives, cookies, history, API key, form body, saving, closing unsaved tabs. Builds the UI into a temporary folder; opens a window. |
| `node security-review/verify-offline.mjs` | Offline mode with the real vault layer (`web/src/vault.ts`, `offline.ts`) on a fake desktop bridge and two simulated devices: offline edits survive a restart, uploads on reconnect, conflict copies, kept deletes, restored items, the offline log queue, personal sync off/on (with and without emptying the server copy), team copies expiring 7 days after the last sync (on disk and in memory), clock rollback, the team period not being a server setting, dropping team copies on removal or 401, temporary mode. |
| `node security-review/verify-offline-ui.mjs` | The same in the real app window (dev Electron with the built UI, driven over the DevTools protocol): offline start from the copy, adding a host offline, read-only team vault, upload after reconnect, settings pages, temporary mode. Builds the UI into a temporary folder (never `web/dist`, which the running server serves); opens windows. |
| `node security-review/verify-server-hardening.mjs` | Server fixes from the second security review (September 29, 2026): CSRF also for percent-encoded paths and empty bearer tokens; sign-in limits hold against a burst of simultaneous attempts; invitations must be accepted, ID/password accounts need the invite code, admin emails cannot be created with invite codes; the key-change proof stored only as a hash (old plain values converted at startup); demoted admins lose extra vault grants; team-management logs and last-sign-in times only for team managers; turning on 2FA only within 10 minutes of sign-in; the 16 MB vault limit; client log floods dropped; re-sealing one's own vault key. |
| `node security-review/verify-e2ee-hardening.mjs` | Vault-key origin and rollback with the real vault layer and a server that tampers with its database: new and shared vault keys sealed with the sender's key; keys of unknown origin not opened silently on a new device, re-sealed after confirmation; swapped keys, a personal vault key sealed by someone else, and a sharer whose public key changed are refused; a fresh account refuses a pre-filled personal vault key; older item versions and resurrected deleted items hidden (and accepted on request); personal credentials not sent to a shared host whose address changed. |
| `node security-review/verify-public-review.mjs` | Findings of the pre-release review (OS-01 to OS-07): the admin console refuses percent-encoded paths without a session (read and write) while its public routes stay open; a burst of console sign-ins checks the password at most 5 times; request logs drop query strings; password sign-in re-reads the account after hashing; SFTP file reads stop at the real number of bytes received (web and app); the web SFTP client closes on an oversized packet length; app folder downloads refuse existing junctions and use random, exclusively created temporary files. |
| `node security-review/verify-update-signing.mjs` | `update-key:init` and `release:sign` in a real pseudo-terminal with a throwaway key and a fake build. Restores `desktop/update-keys.json` when done. |
| `RESULT_FILE=<file> node_modules/electron/dist/electron.exe security-review/verify-updater-electron.mjs` | The real `electron-updater` inside Electron with the app's signature check: valid update, swapped installer, unsigned, unknown key, inflated version, cache clearing. Nothing is installed. |
| `node security-review/verify-app-hardening.mjs` | Launches the built app (`desktop/release/win-unpacked`, so build first) with a throwaway profile: blocked debug and certificate switches, `--inspect`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, and tampering with `app.asar` or adding an `app` folder. Windows appear briefly. |
| `node security-review/reproduce.mjs` | The reproduction script from that security review. |

## Internationalization

The UI supports Korean, English, Japanese, Simplified Chinese, Spanish and German. **The Korean source text is the translation key.**

- `t('호스트')` returns the translation from `web/src/locales/<en|ja|zh|es|de>.json`, or the Korean text if there is none (with a console warning in development).
- Values go into placeholders: `t('{count}개 선택됨', { count })`. Never build keys by concatenating numbers or names into the text — the key would change and the translation would silently disappear.
- Sentences with bold text or elements: `tr('<b>{name}</b> 을 지울까요?', { name })`. Keep a sentence in one piece so other languages can reorder it.
- Module-level constants: mark with `tk('…')` and call `t()` when rendering. Never call `t()` at module top level; it would not follow language changes.
- `.tsx` files import from `./i18n`; `.ts` files import from `./i18n-core` (plain TypeScript without JSX or Vite features, because the security scripts load files such as `e2ee.ts` and `ssh/*.ts` directly in Node).
- Messages created by the server or the desktop main process arrive in Korean and are translated by the UI with `errorMessage()`/`tMsg()`. Their keys are listed in `web/src/i18n-external.ts` (values go into `{placeholders}`). When you change or add a server or main-process message, update that list.
- Text the desktop main process draws itself (menus, the server picker, the sign-in finished page, local shell names) lives in `desktop/src/i18n-main.js`.
- The rules are also written at the top of `web/src/i18n-core.ts`.

`node web/scripts/i18n-check.mjs` reports Korean text outside the translation functions (file:line), and for each language missing keys, unused keys, and translations whose `{placeholders}` or `<tags>` differ from the source. `--write-keys` writes every key to `web/src/locales/_keys.json` as a list to translate. Add `// i18n-ignore` to a line that should stay Korean on purpose (a regular expression, for example).

## App/server compatibility levels

The desktop app carries its own copy of the UI, so it can meet older or newer self-hosted servers. Two pairs of numbers keep them in step:

| Constant | File | Meaning |
|---|---|---|
| `API_LEVEL` | `server/src/auth.ts` | The API level this server provides. |
| `MIN_APP_LEVEL` | `server/src/auth.ts` | The lowest app level this server still accepts. |
| `APP_API` | `web/src/compat.ts` | The level of this UI/app. |
| `NEEDS_SERVER_API` | `web/src/compat.ts` | The lowest server API level this UI needs. |

The server reports `api` and `minAppApi` in `GET /api/auth/config`. The desktop app checks them at start and whenever it reconnects: if `api < NEEDS_SERVER_API`, it asks the user to have the server updated; if `minAppApi > APP_API`, it asks the user to update the app. The web UI is always served by its own server, so it does not check.

The server enforces the same rule itself. Since 0.3.1 the app sends its level in `x-terminas-api` with every API call; the server answers **426** (`app_old`, "please update the app") to Bearer-authenticated (desktop) requests below `MIN_APP_LEVEL`. Requests without the header come from apps up to 0.3.0 and count as level 1. `GET /api/auth/config` and `GET /api/app/latest` always answer, and cookie (web) requests are never refused. An app that receives 426 in the middle of a session keeps working from its offline copy and shows an "update the app" banner; its pending changes are uploaded after the update. `SHELL_MIN_APP_API` can raise the minimum without a new server build (tests, or to block a broken app release in an emergency); it never lowers it.

When to bump:

- **The server gains an API that the UI will use:** raise `API_LEVEL`. When the UI starts depending on it, raise `NEEDS_SERVER_API` to the same value — or let the UI treat a missing API or response field as the old behaviour, so older self-hosted servers keep working.
- **The server drops support for older apps:** raise `APP_API` in the new app and release it, give people time to update (the app updates itself within hours), then raise `MIN_APP_LEVEL` on the server to that value.
- Additive changes that older apps and servers simply ignore need no bump. Server changes must be additive by default: never rename or remove an endpoint or a response field that a released app uses without the `MIN_APP_LEVEL` step above.

### Vault item format level

Vault items are encrypted, so the server cannot convert them; every app version interprets them itself. When an app writes something older apps do not understand (for example a new auth type in a saved HTTP request), older apps would show a default in its place and could lose it when saving. Two rules prevent that (since 0.3.1, `web/src/vault.ts`):

- **`_v` inside the item** is the lowest item format (`ITEM_FORMAT`) that can edit it without loss; it is written only when an item uses something newer (2 = API key auth, XML body or switched-off query parameters in an HTTP request). An app whose `ITEM_FORMAT` is lower shows such an item but refuses to edit or delete it, asking the user to update.
- **Unknown fields are kept.** When an app edits an item, fields it does not know stay as they were.

Raise `ITEM_FORMAT` and extend `formatNeeded()` whenever a new value would be lost by older apps. Apps up to 0.3.0 predate these rules.

### Beta channel

Versions with a pre-release tag (`0.4.0-beta.1`) are beta versions. The desktop app offers **Settings → Account → Desktop app → Get beta versions** (with a stability warning). Beta users read a separate feed: `betaUpdateUrl` in `desktop/app-config.json` (the fixed GitHub release tagged `beta`). Stable users never see beta files, because GitHub's `releases/latest` skips pre-releases. An app installed from a beta version starts on the beta channel until the person chooses otherwise.

- `npm run release:sign` only signs the build. With `--to <folder>` or `TERMINAS_UPDATES_DIR` it also copies the files into a server's `/updates` folder (a beta version only into `<updates>/beta`, a stable version into `<updates>` and, when it is newer than the beta there, into `<updates>/beta` too) — for self-hosted feeds; the official app is published on GitHub only.
- `internal/github-publish.mjs release` marks beta versions as pre-releases and keeps the `beta` release's files at the newest beta or newer stable version.
- The signature check is the same for both channels. Version order follows semver (`0.4.0-beta.1 < 0.4.0-beta.2 < 0.4.0`), and the app never installs an older version, so leaving the beta keeps the current beta until the next stable release is newer.
- Builds use `"detectUpdateChannel": false`, so beta builds also produce `latest.yml`; the channel is decided by where the files are published.

## Releasing your own desktop builds

The official app takes updates only from GitHub Releases and installs only installers signed with the official key:

1. Stable channel: `updateUrl` — `https://github.com/Studio-Yeonhong/Terminas/releases/latest/download`.
2. Beta channel: `betaUpdateUrl` — `https://github.com/Studio-Yeonhong/Terminas/releases/download/beta`.

A build may list further feeds in `updateFallbackUrl` / `betaFallbackUrl`; they are checked in order after the first one, and errors from a feed that is followed by another one are only written to the app's `updater.log`. A feed without a release yet (HTTP 404) counts as "no new version". Installers must carry a valid signature whichever feed they come from.

If you ship your own builds (a fork, or an internal build pointing at your server), set up your own identity first:

1. `desktop/app-config.json`: set `serverUrl` to your server (or leave it empty, and the app asks for a server address on first run), and set `updateUrl` and `betaUpdateUrl` (and any fallback feeds) to your own update feeds. Otherwise your build keeps asking the official feeds, which it cannot install from once your own key replaces the official one.
2. Use your own app ID: `build.appId` in `desktop/package.json`, `APP_ID` in `desktop/src/update-verify.js` and `setAppUserModelId` in `desktop/src/main.js`. Also change the `publish` URL in `desktop/package.json`.
3. Create your signing key once, from a terminal in the repository:

   ```bash
   npm run update-key:init
   ```

   It asks twice for a passphrase (12+ characters), creates an Ed25519 key, stores it encrypted at `~/.terminas/update-signing-key.json` (or `TERMINAS_UPDATE_KEY`, or `--key <file>`), and adds the public key to `desktop/update-keys.json`. **Remove the keys you do not control from `desktop/update-keys.json`** and commit the file.
   - Keep a copy of the key file offline (it is useless without the passphrase), and keep the passphrase in a password manager.
   - If you lose both the key file and the passphrase, installed apps can no longer receive updates and everyone has to reinstall.

For each release:

1. Bump `version` in `desktop/package.json`. An app does not treat the same version as an update.
2. Build:

   ```bash
   npm run release:desktop
   ```

   This builds the web UI, the icon and the Windows installer (electron-builder, NSIS, x64). Run from an interactive terminal, it continues straight into signing. Run non-interactively (for example from CI or an automation), it stops after the build.
3. Sign and publish, in a terminal:

   ```bash
   npm run release:sign -- --to <update folder>
   ```

   It shows the version, file, SHA-512 and key ID, asks for the passphrase, writes the signature into `latest.yml`, and copies the installer, its blockmap and `latest.yml` into the update folder (`latest.yml` last, keeping at most one older installer). `TERMINAS_UPDATES_DIR` can replace `--to`. Without either, the build is signed but not copied anywhere. The script refuses to sign if the new app does not contain your public key.

Where to publish: any static HTTPS location that serves those files at your `updateUrl` (and `updateFallbackUrl`). For a GitHub Releases feed (`https://github.com/<owner>/<repo>/releases/latest/download`), attach the installer, its blockmap and the signed `latest.yml` to the release; GitHub serves the latest release's files under that address. A Terminas server serves `<data>/updates` (or `SHELL_UPDATES_DIR`) at `/updates/`, and its web UI then offers that installer under **Get the Windows app**. Optionally, with `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (and `R2_PREFIX`, default `terminas/`) set, the files are also uploaded to a Cloudflare R2 bucket; this path has not been tested against a real bucket yet.

Other notes:

- `npm run dist:desktop` builds the installer without signing or publishing.
- The UI is inside the app, so UI changes reach desktop users only with a new app version. If the same machine serves the web UI, restart the server after rebuilding.
- Installed apps check for updates 15 seconds after start and then every 4 hours, download in the background, and install on restart or quit.
- **Windows code signing is optional.** Without a certificate, SmartScreen warns on first run. With an OV/EV certificate, pass it to electron-builder with `CSC_LINK` and `CSC_KEY_PASSWORD`. Update authenticity is checked by the Ed25519 signature either way.

## Code notes

- The server runs TypeScript through Node's built-in type stripping (`erasableSyntaxOnly`): use only erasable syntax (no `enum`, `namespace` or constructor parameter properties) and import local files with the `.ts` extension.
- Match the style of the surrounding code. Comments are often in Korean; that is fine.
- Server responses carry Korean messages that the UI translates, so keep `web/src/i18n-external.ts` in sync.
- Keep secrets out of commits: `.env`, data folders and update signing keys are git-ignored.
