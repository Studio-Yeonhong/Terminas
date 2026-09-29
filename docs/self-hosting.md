# Self-hosting Terminas

This guide covers running your own Terminas server: installation with Docker or plain Node.js, every setting, sign-in methods, open sign-up, teams and invitations, the admin console, limits, two-factor authentication, backups, upgrades and connecting desktop apps.

[한국어](self-hosting.ko.md)

## Contents

- [What you are running](#what-you-are-running)
- [Requirements](#requirements)
- [Install with Docker](#install-with-docker)
- [Reverse proxy](#reverse-proxy)
- [Install without Docker](#install-without-docker)
- [Configuration reference](#configuration-reference)
- [Choosing sign-in methods](#choosing-sign-in-methods)
- [Open sign-up](#open-sign-up)
- [The first server admin](#the-first-server-admin)
- [Teams and invitations](#teams-and-invitations)
- [Admin console](#admin-console)
- [Limits](#limits)
- [Two-factor authentication](#two-factor-authentication)
- [Resetting a sign-in password](#resetting-a-sign-in-password)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [Connecting desktop apps](#connecting-desktop-apps)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

## What you are running

The Terminas server is a single Node.js process. It:

- serves the web UI (`web/dist`) and the API (`/api/...`),
- keeps sign-in, teams, permissions and **encrypted** vault data in a SQLite database (`shell.db`),
- relays web SSH sessions over WebSocket (`/api/relay`),
- optionally serves desktop-app update files from `<data>/updates` at `/updates/` (only needed if you build and publish your own desktop app),
- opens a separate **admin console** for people, teams and the server log on its own port (`127.0.0.1:5282`), reachable only from the server machine (see [Admin console](#admin-console)).

The server never sees vault contents in plain text. See [security-model.md](security-model.md) for what it can and cannot know.

## Requirements

- **Docker** with Compose, **or** **Node.js 24 or newer** (the server uses the built-in `node:sqlite` module and runs TypeScript directly).
- **A domain with HTTPS.** Browsers only allow the Web Crypto API that the web UI depends on over HTTPS (or on `localhost`), and sign-in details should never travel in plain text.
- **A reverse proxy** that terminates TLS and passes **WebSocket upgrades** for `/api/relay` (Caddy, nginx, Traefik, a tunnel service, ...).
- Network reach: the Terminas server must be able to reach the SSH servers your team opens **from the web UI**. Desktop apps connect from each user's PC instead.

## Install with Docker

```bash
git clone https://github.com/Studio-Yeonhong/Terminas.git terminas
cd terminas
cp .env.example .env
```

Edit `.env`:

```dotenv
SHELL_PUBLIC_URL=https://terminas.example.com

# Pick at least one sign-in method (see "Choosing sign-in methods"):
# Google
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SHELL_BOOTSTRAP_ADMINS=you@example.com
# and/or ID + password
SHELL_PASSWORD_LOGIN=1
SHELL_ADMIN_ID=admin
SHELL_ADMIN_PASSWORD=a-long-one-time-password
```

Start it:

```bash
docker compose up -d
docker compose logs -f terminas
```

What `docker-compose.yml` and the `Dockerfile` set up:

| Item | Value |
|---|---|
| Image | Built locally from this repository (`docker compose up -d` builds it the first time). It contains the server and the built web UI; the desktop app is built separately. |
| Port | The server listens on **5280** inside the container. Compose publishes it only on **`127.0.0.1:5280`**, so only a reverse proxy on the same machine can reach it. |
| Admin console port | The [admin console](#admin-console) listens on **5282** inside the container. Compose publishes it only on **`127.0.0.1:5282`** of the host, so it opens only on the server machine (or through an SSH tunnel). Never publish it anywhere else. |
| Data | Named volume `terminas-data` mounted at **`/data`** (database, `totp.key`, `updates/`). |
| Fixed settings | Compose sets `SHELL_HOST=0.0.0.0`, `SHELL_PORT=5280`, `SHELL_DATA_DIR=/data`, `SHELL_TRUST_PROXY=1`, `SHELL_CONSOLE_HOST=0.0.0.0` and `SHELL_CONSOLE_PORT=5282`, overriding `.env`. The image sets `NODE_ENV=production`. |
| User | Runs as the unprivileged `node` user. |
| Health check | `GET /api/auth/config` every 30 seconds. |

Then set up the [reverse proxy](#reverse-proxy), open `https://terminas.example.com` and continue with [The first server admin](#the-first-server-admin). Set a password for the [admin console](#admin-console) as well.

## Reverse proxy

The proxy must:

- terminate HTTPS for the domain in `SHELL_PUBLIC_URL`,
- forward everything to `127.0.0.1:5280` with the original `Host` header,
- pass **WebSocket upgrades** (used by `/api/relay` for web SSH),
- set `X-Forwarded-For` (the server trusts it because `SHELL_TRUST_PROXY=1`).

Proxy only the public port (5280). **Never route the admin console port (5282) through the proxy**; the console is meant to be reached only from the server machine (see [Admin console](#admin-console)).

The server pings each relay WebSocket every 30 seconds, so the usual idle timeouts (60 seconds or more) are fine.

**Caddy** (handles certificates and WebSockets automatically):

```caddyfile
terminas.example.com {
    reverse_proxy 127.0.0.1:5280
}
```

**nginx**:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name terminas.example.com;

    ssl_certificate     /etc/letsencrypt/live/terminas.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/terminas.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5280;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 300s;
    }
}
```

Check it from outside:

```bash
curl -fsS https://terminas.example.com/api/auth/config
# {"google":true,"devLogin":false,"password":true,"openSignup":false,
#  "links":{"terms":"","privacy":"","source":"https://github.com/Studio-Yeonhong/Terminas"},"api":1,"minAppApi":1}
```

## Install without Docker

```bash
git clone https://github.com/Studio-Yeonhong/Terminas.git /opt/terminas
cd /opt/terminas
npm ci            # installs all workspaces, including Electron for the desktop app
npm run build     # builds the web UI into web/dist
cp .env.example .env
```

`npm ci` also downloads Electron, which a server does not need. The `Dockerfile` shows how to install only the `server` and `web` workspaces if you want to skip it.

Edit `.env` as in the Docker section, and also set where the server listens (the defaults are for local development):

```dotenv
SHELL_PUBLIC_URL=https://terminas.example.com
SHELL_HOST=127.0.0.1
SHELL_PORT=5280
SHELL_TRUST_PROXY=1
SHELL_DATA_DIR=data
# Leave empty to log to stdout instead
SHELL_LOG_FILE=data/logs/terminas.log
```

The [admin console](#admin-console) opens on `127.0.0.1:5282` by default (`SHELL_CONSOLE_HOST`, `SHELL_CONSOLE_PORT`). Leave it on `127.0.0.1`.

Always run the server with **`NODE_ENV=production`**. It makes the server refuse to start with the development sign-in turned on. The relay's block list (no web SSH into the server's own loopback or interface addresses) is on whenever `SHELL_PUBLIC_URL` is not a localhost address; it is lifted only for local development (localhost address and no `NODE_ENV=production`).

Run it once in the foreground to check it starts:

```bash
NODE_ENV=production npm start
```

`npm start` runs `node --env-file-if-exists=../.env src/index.ts` in `server/`. Relative paths in `SHELL_DATA_DIR` and `SHELL_LOG_FILE` are resolved against the **repository root**, not the working directory.

A systemd unit (`/etc/systemd/system/terminas.service`):

```ini
[Unit]
Description=Terminas server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=terminas
WorkingDirectory=/opt/terminas/server
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --env-file=/opt/terminas/.env src/index.ts
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Adjust the path to `node` (`which node`) if it is not `/usr/bin/node`.

```bash
sudo useradd --system --home /opt/terminas terminas
sudo mkdir -p /opt/terminas/data
sudo chown -R terminas:terminas /opt/terminas/data
sudo chown terminas:terminas /opt/terminas/.env
sudo chmod 600 /opt/terminas/.env
sudo systemctl daemon-reload
sudo systemctl enable --now terminas
journalctl -u terminas -f
```

## Configuration reference

All settings are environment variables, normally kept in `.env` (see `.env.example`). With Docker, Compose reads `.env` through `env_file`.

### Address

| Variable | Default | Meaning |
|---|---|---|
| `SHELL_PUBLIC_URL` | `http://localhost:5380` | The address people open in the browser — `https://...` in production. Session cookies are marked `Secure` when it is https, API requests and relay WebSockets must come from this origin, the Google redirect URI is `<SHELL_PUBLIC_URL>/api/auth/google/callback`, and HSTS is sent when it is https. It must match what users type exactly (scheme, host and port). |
| `SHELL_HOST` | `127.0.0.1` | Interface to listen on. Docker: fixed to `0.0.0.0` inside the container. |
| `SHELL_PORT` | `5381` | Port to listen on. Docker: fixed to `5280`. |
| `SHELL_TRUST_PROXY` | `0` | `1` only when a reverse proxy or tunnel sits in front, so the client IP is taken from `X-Forwarded-For`. Docker: fixed to `1` (the port is published only on `127.0.0.1`). |

### Sign-in: Google

| Variable | Default | Meaning |
|---|---|---|
| `GOOGLE_CLIENT_ID` | empty | OAuth client ID of type "Web application". Leave both Google values empty to turn Google sign-in off. |
| `GOOGLE_CLIENT_SECRET` | empty | OAuth client secret. |
| `SHELL_BOOTSTRAP_ADMINS` | empty | Comma-separated emails that may sign in with Google **without an invite** and become **server admins** (they can create teams). |

### Sign-in: ID and password

| Variable | Default | Meaning |
|---|---|---|
| `SHELL_PASSWORD_LOGIN` | `0` | `1` shows ID/password sign-in. Team invites then produce one-time invite codes so invited people can set their own password. |
| `SHELL_ADMIN_ID` | empty | First server admin, created at start if that account has no password yet. An email address, or 3–64 characters of `a-z 0-9 . _ -`. Requires `SHELL_PASSWORD_LOGIN=1`. |
| `SHELL_ADMIN_PASSWORD` | empty | That admin's password (10+ characters). Used only while the account has no password; **remove it from `.env` after the first start**. |

### Sign-up and public links

| Variable | Default | Meaning |
|---|---|---|
| `SHELL_OPEN_SIGNUP` | `0` | `1` lets anyone sign up with Google (verified email) without an invite; people without a team can still use their personal vault, and anyone can create teams. `0` keeps the server invite-only. There is no self sign-up with ID/password. See [Open sign-up](#open-sign-up). |
| `SHELL_TERMS_URL` | empty | Your terms of service. When set, shown as a link on the sign-in screen and in **Settings → Account**. |
| `SHELL_PRIVACY_URL` | empty | Your privacy policy, shown the same way. |
| `SHELL_SOURCE_URL` | `https://github.com/Studio-Yeonhong/Terminas` | Target of the **Source code (AGPL-3.0)** link on the sign-in screen and in **Settings → Account**. Terminas is licensed under AGPL-3.0: if you run a modified server, set this to where its users can get your modified source. |

`SHELL_TERMS_URL`, `SHELL_PRIVACY_URL`, `SHELL_SOURCE_URL` and `SHELL_APP_DOWNLOAD_URL` must be `http://` or `https://` URLs, or the server refuses to start. An empty value (for example `SHELL_SOURCE_URL=`) means "use the default"; the source link cannot be turned off, because AGPL-3.0 requires it.

### Admin console settings

| Variable | Default | Meaning |
|---|---|---|
| `SHELL_CONSOLE_PORT` | `5282` | Port of the [admin console](#admin-console), a separate listener for managing people, teams and the server log. `0` turns the console off. A value that is not a whole number from 0 to 65535 stops the server from starting. Docker: fixed to `5282` inside the container (to turn it off there, set it to `0` in `docker-compose.yml` and remove the `127.0.0.1:5282:5282` port line). |
| `SHELL_CONSOLE_HOST` | `127.0.0.1` | Interface the console listens on. Keep it on `127.0.0.1` (or `::1`); the server logs a warning otherwise. Docker: fixed to `0.0.0.0` inside the container, and Compose publishes the port only on the host's `127.0.0.1`. |

The console password is not an environment variable. It is stored in the database and set with `npm run console:password -w server` (see [Admin console](#admin-console)).

### Data

| Variable | Default | Meaning |
|---|---|---|
| `SHELL_DATA_DIR` | `data` | Holds `shell.db` (plus its `-wal`/`-shm` files), `totp.key` and `updates/`. Back up the whole folder. Docker: fixed to `/data`. |
| `SHELL_LOG_FILE` | empty | Empty logs to the console. With a file path, logs go there and per-request logging is turned off (who did what is in the in-app **Logs**). |
| `SHELL_TOTP_KEY` | unset | Optional 32-byte base64 key that seals two-factor (TOTP) secrets. Without it, `<data>/totp.key` is created on first use. Generate one with `openssl rand -base64 32`. |

### Desktop app downloads

| Variable | Default | Meaning |
|---|---|---|
| `SHELL_APP_DOWNLOAD_URL` | `https://github.com/Studio-Yeonhong/Terminas/releases/latest` | Where the **Get the Windows app** link on the web sign-in page and in Settings points when this server has no installer in `<data>/updates`. The default (also used when the value is empty) is the official releases page. |

### Development only

| Variable | Default | Meaning |
|---|---|---|
| `SHELL_DEV_LOGIN` | `0` | Sign in with just an email. The server refuses to start with `1` unless `SHELL_PUBLIC_URL` is localhost and `NODE_ENV` is not `production`. Keep it `0`. |
| `TEST_SSHD_PORT`, `TEST_SSHD_USER`, `TEST_SSHD_PASSWORD`, `TEST_SSHD_OTP` | `2222`, `demo`, empty, empty | The fake SSH server used during development (`npm run dev:sshd`). |
| `TEST_VAULT_PASSWORD` | empty | Encryption password used by automated UI tests. |

### Other variables

| Variable | Meaning |
|---|---|
| `NODE_ENV` | Set to `production` on real servers (the Docker image does this). |
| `SHELL_UPDATES_DIR` | Folder served at `/updates/` for desktop-app update files. Default `<SHELL_DATA_DIR>/updates`. |
| `LOG_LEVEL` | Log level (`info` by default). |
| `SHELL_EXIT_WITH_PARENT` | `1` stops the server when its parent process exits — useful when a wrapper process launches it. |

The server checks some combinations at start and refuses to run if they are wrong (see [Troubleshooting](#troubleshooting)).

## Choosing sign-in methods

| Setup | Good for | You configure |
|---|---|---|
| Google only | Teams that already use Google accounts (Workspace or personal Gmail) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SHELL_BOOTSTRAP_ADMINS` |
| ID/password only | Servers without any external identity provider, air-gapped or private networks | `SHELL_PASSWORD_LOGIN=1`, `SHELL_ADMIN_ID`, `SHELL_ADMIN_PASSWORD` |
| Both | Mixed teams | All of the above |

If neither is configured, the sign-in screen says that no sign-in method has been set up.

With both enabled, an account whose ID is an email address can use either method. By default only invited people (and server admins) can sign in at all; see [Open sign-up](#open-sign-up) to let anyone sign up with Google.

### Google sign-in setup

1. Open the [Google Cloud console](https://console.cloud.google.com) and choose a project.
2. **APIs & Services → OAuth consent screen**: user type **External** (so personal Gmail accounts can join too), then enter the app name and a support email. Terminas asks only for the `openid`, `email` and `profile` scopes, so no Google verification review is needed.
   While the publishing status is **Testing**, only the test users listed there can sign in (you can use that as an extra gate). To accept anyone you invite — or anyone at all with [open sign-up](#open-sign-up) — publish the app (**In production**).
3. **Credentials → Create credentials → OAuth client ID → Web application.**
   Authorized redirect URI: `https://terminas.example.com/api/auth/google/callback` (your `SHELL_PUBLIC_URL` + `/api/auth/google/callback`). For local testing you can add `http://localhost:5380/api/auth/google/callback`.
4. Put the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and restart.

Nothing extra is needed for the desktop app. It opens the same Google sign-in in the system browser; the server then hands a one-time code to the app on a temporary `127.0.0.1` port, and the app exchanges it for a session token. The exchange is bound with PKCE, so an intercepted code is useless.

Google sign-in accepts only Google-verified email addresses.

### ID/password sign-in

Set `SHELL_PASSWORD_LOGIN=1`. Then:

- Passwords are stored only as **scrypt** hashes.
- Sign-in passwords must be 10–200 characters. Leading and trailing spaces count as part of the password.
- After **10 failed attempts for one ID** or **50 from one IP address within 15 minutes**, further attempts are blocked until the window ends.
- A wrong password and an unknown ID get the same error ("Incorrect user ID or password") and take the same time, so IDs cannot be discovered.
- Two-factor authentication still applies after a password sign-in.
- A sign-in password **must differ from the user's encryption password**. The server sees the sign-in password, so if the two were the same the server could open that person's vaults. The UI refuses a match wherever it can check.

Users can set or change a sign-in password in **Settings → Account → Sign-in password**:

- Setting one for the first time (for example, someone who so far signed in with Google) requires a sign-in within the last 10 minutes. Sign out and back in first if needed.
- Changing one requires the current sign-in password.
- Either way, the person's other sessions are signed out.

## Open sign-up

By default a Terminas server is **invite-only**: only invited people and server admins can sign in. With `SHELL_OPEN_SIGNUP=1` it can be run as a public service:

- **Anyone can sign in with Google** without an invite. As always, only Google-verified email addresses are accepted, and pending invites for that email are accepted at sign-in.
- **People without a team can still use Terminas** with their personal vault. Leaving or losing their last team does not lock them out.
- **Anyone can create teams.** Server admins have no limit; everyone else can own at most 20 teams (see [Limits](#limits)).
- The sign-in screen says that anyone can sign up with a Google account.

There is **no self sign-up with ID and password.** The server cannot verify an email address typed into a form, and a self-registered address could capture team invites meant for someone else. On servers with ID/password sign-in, people still join through [invite codes](#inviting-people); `SHELL_OPEN_SIGNUP=1` there only means that existing accounts can sign in without a team and create teams.

Open sign-up does not change encryption. Every new account creates its own keys, and nobody can read a team vault until a member shares the vault key with them (see [security-model.md](security-model.md#open-sign-up)).

Before opening a server to the public:

- **Publish the Google OAuth consent screen** (**In production**, see [Google sign-in setup](#google-sign-in-setup)). While it is in **Testing**, only the listed test users can sign in.
- **Publish terms of service and a privacy policy** and set `SHELL_TERMS_URL` and `SHELL_PRIVACY_URL`. They appear as links on the sign-in screen and in **Settings → Account**.
- **Think about what the relay can reach.** Every signed-in user can open web SSH connections to any address the server can reach that answers with an SSH greeting (see [Security notes](#security-notes)).
- If you changed the server code, set `SHELL_SOURCE_URL` to your modified source ([License](../README.md#license)).

## The first server admin

A **server admin** can create teams without limits and can sign in without belonging to a team. That is all the role does: it gives no admin screen in the web UI or the desktop app. Managing people and teams happens in the separate [admin console](#admin-console) on the server machine, which has its own password. Being a server admin does **not** give access to any vault content.

**Google:** list your email in `SHELL_BOOTSTRAP_ADMINS`, restart, and choose **Continue with Google**.

**ID/password:** set `SHELL_ADMIN_ID` and `SHELL_ADMIN_PASSWORD` and start the server. The log confirms that the admin's password was set. Then **remove `SHELL_ADMIN_PASSWORD` from `.env`** — it is used only while the account has no password, so it is never applied again, but it should not stay on disk. Alternatively, create the admin from the command line:

```bash
npm run user:password -w server -- admin --create-admin
# Docker:
docker compose exec terminas node server/scripts/user-password.ts admin --create-admin
```

After the first sign-in:

1. Create your **encryption password** (different from any sign-in password) and store the **recovery key** you are shown. It is shown only once.
2. Open **Settings → Create team**. The team gets a default vault called "Team".
3. Invite people (next section).
4. On the server, set the [admin console](#admin-console) password so you can manage people and teams later.

## Teams and invitations

### Roles

| Role | Can do |
|---|---|
| Owner | Everything in the team: edit all team vaults, invite admins and members, change roles, delete the team. The creator becomes the owner. |
| Admin | Edit all team vaults, invite members, manage vault permissions. |
| Member | Only what each vault grants: `edit` or `view`. New members get **view** on the default "Team" vault. |

Everyone also has a **Personal** vault that only they can open. The server enforces who may write, even though it cannot read what is written.

### Inviting people

Open **Settings → (team) → Invite**, enter the email and role, and click **Invite**. Only owners can invite admins.

- **The person already has an account on this server:** they are added to the team immediately.
- **Google sign-in:** the invite is stored and accepted automatically the first time that person signs in with Google using that email.
- **ID/password sign-in:** you are shown a **one-time invite code** (`XXXX-XXXX-XXXX`) together with its expiry. Give it to the person through a channel you trust.
  - The code is valid for **7 days** and is shown **only once**. The server stores only its hash.
  - Lost or expired? Use **Generate new invite code** next to the pending invite. The old code stops working.
  - You can cancel a pending invite at any time.

The invited person then opens the sign-in screen, chooses **Got an invite code? Sign up**, enters the invited email, the code, an optional name and a sign-in password (10+ characters). They are signed in and join the team. On a server with both methods, they can instead just sign in with Google using the invited email.

### Sharing vault keys

Being in a team is not enough to read its vaults. After a new member sets up their encryption password, team owners and admins see **"Team members waiting for vault keys"** when they open the app or web UI. Check the person's email and **key fingerprint** (ideally compare the fingerprint with them by voice or in person), then confirm. Your client seals the vault key to their public key. If a member's key differs from the one your device saw before, it is marked as changed and not selected by default.

### Removing people and deleting teams

- Removing someone from a team, or taking away their vault permission, deletes their copy of the vault keys on the server. They may already have seen the secrets, so **change the server passwords and keys they could access**.
- Only the team owner can delete a team, by typing its exact name. The team's vaults, items, vault keys, memberships and invites are deleted; the logs remain.
- People who no longer belong to any team cannot sign in, except server admins and everyone on an [open sign-up](#open-sign-up) server.

## Admin console

People, teams and the server log are managed in the **admin console**: a small, separate web page that the server process opens on its own port, `http://127.0.0.1:5282/admin` by default. It is not part of the web UI or the desktop app, and the public server (port 5280, behind your reverse proxy) has no admin API at all. The console answers only on the server machine.

The console has its own password, set from the server's command line. It is independent of people's accounts and of Google sign-in: [server admins](#the-first-server-admin) do not get into the console with their Terminas account, and the console password does not sign anyone in to Terminas.

**Admins never see vault contents here** — only account metadata, timestamps and counts.

### Setting the console password

Run this on the server, in the repository folder (it reads the same `.env` as the server):

```bash
npm run console:password -w server              # set or change the password (asked twice, not shown)
npm run console:password -w server -- --otp     # also require a TOTP code
npm run console:password -w server -- --no-otp  # stop requiring a TOTP code
npm run console:password -w server -- --off     # remove the password: nobody can sign in to the console
# Docker:
docker compose exec terminas node server/scripts/console-password.ts [--otp|--no-otp|--off]
```

- The password must be 10–200 characters, like sign-in passwords. It is stored in the database only as a scrypt hash.
- `--otp` needs a password first. It shows a key (and an `otpauth://` address) to add to an authenticator app (Google Authenticator, 1Password, Authy and so on), then asks for the app's current code to confirm. Running it again replaces the key. The secret is sealed with the same server key as everyone's two-factor secrets (`SHELL_TOTP_KEY` or `<data>/totp.key`).
- Changing the password or the OTP setting signs out every open console session. The server does not need a restart.
- Until a password is set, nobody can sign in, and the console only shows how to set one.

### Opening the console

On the server machine itself (or over remote desktop), open `http://127.0.0.1:5282/admin`. From another computer, forward the port over SSH and open the same address there:

```bash
ssh -L 5282:127.0.0.1:5282 user@server
# then open http://127.0.0.1:5282/admin on this computer
```

Sign in with the console password (and the TOTP code, if turned on).

- A console session lasts 8 hours and is kept only in memory, so restarting the server signs you out.
- After 5 failed sign-ins within 15 minutes, further attempts are blocked until the window ends, even with the right password.
- The page is shown in Korean or English, following the browser's language.

**Never publish the console port to the internet or route it through the public reverse proxy.** With Docker, `docker-compose.yml` publishes it only on the host's `127.0.0.1:5282`. Without Docker, keep `SHELL_CONSOLE_HOST=127.0.0.1`. `SHELL_CONSOLE_PORT=0` turns the console off entirely (see [Admin console settings](#admin-console-settings)). The console also refuses requests addressed to any name other than `127.0.0.1`, `localhost` or `[::1]`; see [security-model.md](security-model.md#admin-console) for all of its protections.

### Overview

Numbers for people, new sign-ups in the last 7 days, people who signed in within 7 and 30 days, disabled accounts, teams, vaults, vault items and active sessions, plus badges showing the server's mode (open sign-up or invite-only, Google, ID/password).

### Users

Newest first, 100 at a time. Search by email or name, and filter by all, server admins, disabled, or not yet set up encryption. Each row shows the sign-up date, last sign-in, number of teams and badges (server admin, disabled, two-factor, encryption not set up, Google, password), with these actions:

| Action | What it does |
|---|---|
| Disable / enable | A disabled account cannot sign in. Disabling also signs the person out everywhere and closes their open web SSH connections. |
| Make / remove server admin | Makes the person a [server admin](#the-first-server-admin) (teams without limits, sign-in without a team), or takes it away. |
| Sign out everywhere | Ends all of the person's sessions and closes their open web SSH connections. |
| Reset two-factor authentication | Turns two-factor authentication off for someone who lost both their authenticator app and their recovery codes (the same as [`mfa:reset`](#two-factor-authentication)). |
| Delete account | You must type the person's email to confirm. Refused while they are the only owner of a team that has other members — transfer ownership or delete that team first. Teams where they are the only member, their personal vault, sessions and vault keys are deleted, and they leave their other teams. Log entries stay. This cannot be undone. |

Emails listed in `SHELL_BOOTSTRAP_ADMINS` become server admins again at their next Google sign-in, so remove an email from that list before removing it here.

### Teams

The newest 500 teams with their owners, member count, vault count and creation date.

### Server log

Events outside vaults: sign-ins and rejected sign-ins, console sign-ins and failed console sign-ins, admin actions, team creation and deletion, two-factor changes and similar. Hover over an entry's **Who** column to see its IP address. Events inside vaults stay in the in-app **Logs**.

Every action in the console is recorded there (`admin_user_disable`, `admin_user_enable`, `admin_grant`, `admin_revoke`, `admin_signout`, `mfa_reset`, `admin_user_delete`) with `detail.by` set to `console` and no acting user, because the console is not tied to anyone's account. Console sign-ins appear as `console_login` and `console_login_failed`, and changes made with `console:password` as `console_password`.

### Console API

The page uses these endpoints. They exist only on the console port; the public server has no admin API (`/api/admin/*` answers 404). Every request must be addressed to `127.0.0.1`, `localhost` or `[::1]` (other `Host` values get 421). Requests that change something also need the header `x-console: 1` and, if they carry an `Origin`, a loopback one. Everything except `state` and `login` needs a console session.

| Endpoint | Purpose |
|---|---|
| `GET /admin/api/state` | Whether a password and OTP are set, and whether this browser is signed in |
| `POST /admin/api/login` | Body `{"password": "...", "code": "123456"}` (`code` only with OTP); sets the session cookie |
| `POST /admin/api/logout` | Ends this console session |
| `GET /admin/api/stats` | Overview numbers and server mode |
| `GET /admin/api/users` | People; query `q` (email or name), `filter` (`all`, `admins`, `disabled`, `nokeys`), `offset` |
| `GET /admin/api/users/:id` | One person's teams (shown before deleting) |
| `POST /admin/api/users/:id/disable` | Body `{"disabled": true}` or `false` |
| `POST /admin/api/users/:id/admin` | Body `{"admin": true}` or `false` |
| `POST /admin/api/users/:id/signout` | Sign out everywhere |
| `POST /admin/api/users/:id/mfa-reset` | Reset two-factor authentication |
| `DELETE /admin/api/users/:id` | Body `{"confirm": "<email>"}` |
| `GET /admin/api/teams` | Teams |
| `GET /admin/api/audit` | Server log, 200 entries at a time; query `before` (entry ID) for older ones |

## Limits

These limits apply on every server. They mostly keep an open sign-up server from being abused.

| Limit | Value |
|---|---|
| Teams one person can own | 20 (no limit for server admins) |
| Vaults per team | 50 |
| Items per vault | 5,000 |
| Open web SSH connections per person | 20 at a time |
| New web SSH connections per person | 120 per 10 minutes |

The web SSH counters are kept in memory and reset when the server restarts.

## Two-factor authentication

- Each person turns it on in **Settings → Security & encryption → Two-factor authentication** with an authenticator app (Google Authenticator, 1Password, Authy and so on). Ten one-time **recovery codes** are shown once.
- It applies after both Google and ID/password sign-in. Until the code is entered, every API call and the web relay are refused. Five wrong codes end that sign-in attempt.
- The server has to know each person's TOTP secret to check codes. Secrets are sealed with `SHELL_TOTP_KEY`, or with `<data>/totp.key` if that is not set, so a leaked database alone is not enough. **Back up this key together with the database** — if it is lost, everyone who uses two-factor authentication has to be reset.

If someone loses both their authenticator app and their recovery codes, whoever runs the server can turn two-factor authentication off for them — in the [admin console](#admin-console), or from the command line (either way it is recorded in the logs as `mfa_reset`):

```bash
npm run mfa:reset -w server -- user@example.com
# Docker:
docker compose exec terminas node server/scripts/mfa-reset.ts user@example.com
```

Use the person's ID if their account ID is not an email.

## Resetting a sign-in password

Whoever runs the server can set a new sign-in password for any account from the command line:

```bash
npm run user:password -w server -- <id>
npm run user:password -w server -- <id> --create-admin    # create a new server admin if the ID does not exist
# Docker:
docker compose exec terminas node server/scripts/user-password.ts <id>
```

- The password is asked twice and not shown. Without a terminal, the first two lines of standard input are used.
- All of that account's sessions are signed out.
- This changes only the **sign-in** password. Nobody can reset an **encryption** password on the server's side, because the server cannot open vaults. A person who forgot their encryption password unlocks with their recovery key and picks a new one. If they lost both, they can start over from the lock screen within 10 minutes of signing in: their personal vault is emptied and team admins share team vault keys with them again.

## Backups

Back up the **whole data directory**:

| File | Why |
|---|---|
| `shell.db`, `shell.db-wal`, `shell.db-shm` | Accounts, teams, permissions, encrypted vaults, logs and the admin console password. The database runs in WAL mode, so copy all three together. |
| `totp.key` | Seals two-factor secrets, including the admin console's OTP (unless you use `SHELL_TOTP_KEY`). |
| `updates/` | Only if you publish your own desktop builds. |

Also keep a copy of `.env` (Google client secret, `SHELL_TOTP_KEY` if set) in a safe place.

The simplest consistent backup is to stop the server briefly and copy the folder.

**Docker** (named volumes are prefixed with the Compose project name — check with `docker volume ls`):

```bash
docker compose stop terminas
docker run --rm -v terminas_terminas-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/terminas-data-$(date +%F).tgz -C /data .
docker compose start terminas
```

**Without Docker:**

```bash
sudo systemctl stop terminas
sudo tar czf terminas-data-$(date +%F).tgz -C /opt/terminas data
sudo systemctl start terminas
```

To restore, stop the server, replace the data directory with the backup and start it again.

A stolen backup does not reveal vault contents, but it does show emails, names, team and vault names, memberships, roles and log entries.

## Upgrading

Back up first. Database migrations run automatically at start, and there are no downgrade migrations.

**Docker:**

```bash
git pull
docker compose up -d --build
```

**Without Docker:**

```bash
git pull
npm ci
npm run build
sudo systemctl restart terminas
```

The server registers the web UI's files when it starts, so **after rebuilding the web UI you must restart the server** — otherwise the new files return 404 until you do.

Desktop apps carry their own copy of the UI. When a server and an app are too far apart, the app shows **"The server and app versions don't match"** and says which side to update (see [Connecting desktop apps](#connecting-desktop-apps)). Keeping the server up to date avoids this.

## Connecting desktop apps

Users of the official Windows app can connect it to your server:

1. On first start the app asks which server to use. Later, click **Change** next to the server name on the sign-in screen — or use **Help → Change server address…**, or **Settings → Account → Connected server → Change server**.
2. Choose **Self-hosted server** and enter your domain or IP address, for example `terminas.example.com` or `192.168.0.10:5280`.
3. The app checks that a Terminas server answers at that address before saving it.

Address rules:

- Without a scheme, the app adds `https://`.
- A private or VPN address — `localhost`, `127.x`, `10.x`, `172.16–31.x`, `192.168.x`, `100.64–127.x` (Tailscale and similar), IPv6 `fc00::/7`, `fe80::/10`, `::1` — gets `http://` instead, and the app warns that the connection is unencrypted and should only be used inside your own network or VPN.
- Internet addresses must use `https`.

Plain http on a private network works only for the desktop app. Browsers will not run the web UI over plain http except on `localhost`, and with Docker you would also have to publish the port on that interface. HTTPS is strongly recommended everywhere.

Other things to know:

- **Updates always come from the official update feed**, never from your server: the app checks [GitHub Releases](https://github.com/Studio-Yeonhong/Terminas/releases) first and falls back to the official server's `/updates`. Either way, an update installs only with the official Ed25519 signature. Choosing a self-hosted server does not change how the app updates. Organizations that ship their own builds must use their own signing key and update feeds (see [development.md](development.md#releasing-your-own-desktop-builds)).
- **App/server compatibility.** The server reports its API level (`api`) and the lowest app level it accepts (`minAppApi`) in `GET /api/auth/config`. If the server is older than the app needs, the app asks users to have the server updated; if the app is too old, it asks users to update the app.
- **Web download link.** The web sign-in page and Settings show **Get the Windows app**. If your server has no installer in `<data>/updates`, the link goes to `SHELL_APP_DOWNLOAD_URL` (by default the official releases page).
- The app keeps a separate sign-in per server address.

## Security notes

**What whoever runs the server (or anyone with the database) can and cannot see** — the [admin console](#admin-console) shows only part of the left column:

| Can see | Cannot see |
|---|---|
| Emails, names, avatars, last sign-in times | Host addresses, usernames, passwords, SSH keys, snippets, forwarding rules, saved HTTP requests |
| Team names, vault names, memberships, roles, vault permissions | Known-host fingerprints and host OS information (stored inside encrypted items) |
| Which kinds of items exist in a vault, and when they changed | Target names in the logs (encrypted with the vault key) |
| Log actions, times and IP addresses; session IP and browser user agent | Terminal contents and file transfers (SSH-encrypted end to end) |
| For **web** SSH only: the destination host and port while a relay is open (not stored) | Vault keys, account keys, encryption passwords, recovery keys |
| Sign-in passwords at sign-in time (stored only as scrypt hashes), TOTP secrets (sealed with the server key) | |

Recommendations:

- **Keep `SHELL_DEV_LOGIN=0`.** It lets anyone sign in with just an email. The server refuses to start with it unless it is on localhost outside production.
- **Set `SHELL_TRUST_PROXY=1` only behind a proxy.** Without a proxy, clients could fake `X-Forwarded-For` to dodge per-IP limits and forge the IPs in the logs. Docker Compose sets it to `1` because the port is published only on `127.0.0.1`; if you publish the port elsewhere, change that.
- **Run with `NODE_ENV=production`** (the Docker image does). It enables the relay's block list for the server's own loopback, link-local and interface addresses.
- **Mind what the relay can reach.** Signed-in users can open web SSH sessions to any address the server can reach that answers with an SSH greeting — including private networks around the server. Place the server, or restrict its outgoing traffic, accordingly. This matters most with [open sign-up](#open-sign-up), where anyone with a Google account can sign in.
- **Keep invite-only unless you mean to run a public service.** `SHELL_OPEN_SIGNUP` is `0` by default. If you turn it on, publish terms of service and a privacy policy and keep an eye on the [admin console](#admin-console).
- **Keep the admin console on the server machine.** Never publish its port (5282) or route it through the reverse proxy; reach it through an SSH tunnel or remote desktop. Use a long console password and turn on its OTP (`console:password -- --otp`).
- **Protect `.env` and the data directory** (`chmod 600 .env`). Remove `SHELL_ADMIN_PASSWORD` after the first start.
- **Prefer the desktop app for sensitive work.** The web UI's code comes from your server; if the server were compromised, modified web code could capture passwords typed in the browser. The desktop app carries its own UI and is not exposed to this.
- **Verify key fingerprints** before sharing vault keys with new members.

## Troubleshooting

Server log and command-line messages are currently in Korean.

| Symptom | Cause and fix |
|---|---|
| Server exits with `SHELL_DEV_LOGIN=1 is only allowed with a localhost SHELL_PUBLIC_URL outside production` | Set `SHELL_DEV_LOGIN=0`. |
| Server exits with `SHELL_ADMIN_ID needs SHELL_PASSWORD_LOGIN=1` | Turn on ID/password sign-in, or remove `SHELL_ADMIN_ID`. |
| Server exits with `SHELL_ADMIN_ID must be an email address or 3-64 characters...` | Use an email or 3–64 characters of `a-z 0-9 . _ -`. |
| Server exits with `SHELL_ADMIN_PASSWORD must be at least 10 characters` | Use a longer password. |
| Server exits with `SHELL_CONSOLE_PORT must be 0-65535` | Use a port number, or `0` to turn the admin console off. |
| Server exits with `SHELL_TERMS_URL must be an http(s) URL` (or the same for `SHELL_PRIVACY_URL`, `SHELL_SOURCE_URL`, `SHELL_APP_DOWNLOAD_URL`) | Use a full `https://...` (or `http://...`) address without spaces, or remove the variable. |
| Log warns that the `SHELL_ADMIN_ID` account has no password | Set `SHELL_ADMIN_PASSWORD` for one start, or run `user:password`. |
| Sign-in screen: "No sign-in method has been set up yet" | Configure Google and/or `SHELL_PASSWORD_LOGIN=1`, then restart. |
| Google: `redirect_uri_mismatch` | The authorized redirect URI must be exactly `<SHELL_PUBLIC_URL>/api/auth/google/callback`. |
| Google: only some people can sign in | The OAuth consent screen is still in **Testing**; add them as test users or publish it. |
| "This account hasn't been invited" | Invite that email first, or add it to `SHELL_BOOTSTRAP_ADMINS` for a server admin. To let anyone sign up with Google, set `SHELL_OPEN_SIGNUP=1`. |
| "You're not in any team." | Everyone except server admins must belong to at least one team, unless `SHELL_OPEN_SIGNUP=1`. |
| Creating a team or vault, or adding an item, fails with a limit message | See [Limits](#limits): 20 owned teams per person (server admins excepted), 50 vaults per team, 5,000 items per vault. |
| Web SSH: "Too many simultaneous connections." | The person already has 20 web SSH connections open, or opened 120 in the last 10 minutes. Close some, or wait. |
| Actions in the web UI fail with 403 "Origin not allowed" (`bad_origin`) | `SHELL_PUBLIC_URL` does not match the address in the browser (scheme, host and port must match). |
| Web SSH fails immediately; the browser shows WebSocket errors | The proxy does not pass WebSocket upgrades for `/api/relay`. |
| "Not an SSH server (no greeting received)." | The target did not send an SSH greeting within 10 seconds. Check the host and port. |
| "Can't connect to that address." | The relay blocks the server's own loopback and interface addresses. Use the desktop app for that host. |
| Web SSH fails during key exchange | The browser SSH client does not offer curve25519. The SSH server must allow ECDH (`ecdh-sha2-nistp256/384/521`) or Diffie-Hellman key exchange; OpenSSH's defaults do. |
| After an upgrade the web UI is blank or assets return 404 | Restart the server after rebuilding the web UI. |
| "Too many failed attempts, so sign-in is temporarily blocked." | Wait 15 minutes. The counters are kept in memory and also reset when the server restarts. |
| Two-factor codes stopped working for everyone after a move (the admin console's OTP too) | `totp.key` (or `SHELL_TOTP_KEY`) was not carried over. Restore it, or run `mfa:reset` for each affected person and `console:password -- --otp` (or `--no-otp`) for the console. |
| The admin console does not open (connection refused or timed out) | The console listens only on `SHELL_CONSOLE_HOST` (default `127.0.0.1`): open `http://127.0.0.1:5282/admin` on the server machine itself, or through an SSH tunnel (`ssh -L 5282:127.0.0.1:5282 user@server`). Check that `SHELL_CONSOLE_PORT` is not `0` and, with Docker, that `docker-compose.yml` still publishes `127.0.0.1:5282:5282`. |
| Log says the admin console could not be opened | Another program is using the port. Stop it or pick another `SHELL_CONSOLE_PORT`. The public server keeps running without the console. |
| Admin console: "This console only answers on 127.0.0.1 / localhost." | You reached it under another name (a domain, a LAN address or a proxy). Open `http://127.0.0.1:5282/admin` — from another computer, through an SSH tunnel. |
| Admin console shows only a command to set a password (the log warns that the console has no password) | No console password is set yet. Run `npm run console:password -w server` (Docker: `docker compose exec terminas node server/scripts/console-password.ts`). |
| Admin console sign-in is blocked after wrong passwords | 5 failures within 15 minutes block it. Wait 15 minutes (the counter is kept in memory and also resets when the server restarts). Forgot the password or lost the authenticator app: run `console:password` again on the server (`--no-otp` turns the OTP off). |
| Desktop app: "No Terminas server was found at that address" | Check the address, HTTPS and the proxy; `https://<domain>/api/auth/config` must answer. |
| Desktop app: "Internet addresses must use https" | Use https, or a private/VPN IP if you really want http. |
| Desktop app: "The server and app versions don't match" | Update the server (or the app, as the message says). |
