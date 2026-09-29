# Security policy

Terminas stores access to other people's servers, so we take security reports seriously. Thank you for helping keep its users safe.

## Reporting a vulnerability

**Please report vulnerabilities privately. Do not open a public issue, pull request or discussion.**

Use GitHub's private vulnerability reporting: open this repository's **Security** tab and choose **Report a vulnerability**. This creates a private security advisory that only you and the maintainers can see.

Helpful details:

- the affected component and version (desktop app version, server commit or release),
- steps to reproduce, ideally a minimal proof of concept,
- the impact you expect (what an attacker gains, and what they need first),
- any logs, screenshots or suggested fixes.

We will acknowledge your report, keep you informed while we investigate and fix it, and credit you in the advisory if you wish.

Please test only against your own installation — a local development setup (see [docs/development.md](docs/development.md)) is enough for most issues. Do not test against the official server or servers you do not own, do not access other people's data, and do not run denial-of-service tests.

## Scope

In scope:

- **Server** (`server/`): authentication (Google, ID/password, invite codes, sessions, two-factor authentication), authorization of teams and vaults, the admin command-line scripts, the Docker setup's defaults.
- **Web UI** (`web/`): end-to-end encryption (`web/src/e2ee.ts`), key sharing, the in-browser SSH and SFTP implementation.
- **Web relay** (`/api/relay`): anything that lets it reach non-SSH services, the server itself, or another user's session.
- **Desktop app** (`desktop/`): the bridge between the UI and native functions, direct SSH/SFTP/port forwarding, the HTTP request tool, stored tokens and remembered unlocks, Electron hardening.
- **Update signing**: the signing tools (`desktop/scripts/update-key.mjs`) and the app's update verification (`desktop/src/update-verify.js`).

Especially interesting: any way for the server, its operator or a database copy to read vault contents; any way to make installed apps accept an update that was not signed with a trusted key.

Out of scope:

- The known limitations listed in [docs/security-model.md](docs/security-model.md#known-limitations-and-residual-risks), unless you find a way around a protection described there.
- Problems that require an already compromised user device or Windows account.
- Insecure configurations the documentation warns against (for example exposing the server without HTTPS).
- Vulnerabilities in third-party services, or in dependencies without a way to exploit them through Terminas (please report those upstream).

## Supported versions

Security fixes go into the **latest release** of the desktop app and the **latest version of the server** on the default branch. The desktop app updates itself; self-hosted servers should be upgraded promptly (see [docs/self-hosting.md](docs/self-hosting.md#upgrading)).

## Learn more

How Terminas protects data, and what it does not protect against: [docs/security-model.md](docs/security-model.md).
