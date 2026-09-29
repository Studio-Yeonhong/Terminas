# Contributing to Terminas

Thanks for your interest in improving Terminas. Bug reports, fixes, translations and documentation are all welcome.

**Security issues:** please do not open a public issue. Follow [SECURITY.md](SECURITY.md) instead.

## Getting set up

You need Node.js 24 or newer. Building the desktop app needs Windows.

```bash
npm install
cp .env.example .env     # set SHELL_DEV_LOGIN=1, SHELL_BOOTSTRAP_ADMINS=<your email>, TEST_SSHD_PASSWORD
npm run dev              # API :5381 + web UI :5380 + fake SSH server 127.0.0.1:2222
```

[docs/development.md](docs/development.md) explains the repository layout, the desktop app in development, and everything below in more detail.

## Before you open a pull request

- `npm run check` passes (type-checks server and web).
- `npm run build` passes.
- `node web/scripts/i18n-check.mjs` reports no Korean text outside the translation functions and no broken placeholders.
- If you touched security-sensitive code, the matching `security-review/verify-*.mjs` scripts pass, and you added checks for the new behavior.
- Keep pull requests focused, and describe what changed and why.

## Translations

- The Korean source text is the translation key: `t('호스트')`, `t('{count}개 선택됨', { count })`. New UI text is written in Korean and wrapped in `t()`, `tr()` or `tk()`.
- Put values in `{placeholders}` rather than concatenating them into the text.
- Server and desktop main-process messages are listed in `web/src/i18n-external.ts`; update it when you change them.
- Translations live in `web/src/locales/<en|ja|zh|es|de>.json`. Improvements to English, Japanese, Chinese, Spanish and German are very welcome. `node web/scripts/i18n-check.mjs --write-keys` lists every key that needs translating.

## Coding style

- Match the surrounding code: formatting, naming and structure.
- Comments in Korean are common in this codebase and are fine. English comments are fine too.
- Server code runs TypeScript directly in Node, so use erasable syntax only (no `enum`, `namespace` or constructor parameter properties) and `.ts` import extensions.
- Prefer small, clear changes over large refactors.

## Security-sensitive areas

Changes to these need tests (a new or extended `security-review/verify-*.mjs` check, run against an isolated temporary server):

- sign-in, sessions, invite codes, two-factor authentication, open sign-up,
- team and vault permissions, and the per-person limits,
- the admin console (`server/src/console/`) and its password CLI (`server/scripts/console-password.ts`),
- end-to-end encryption and key sharing (`web/src/e2ee.ts`, `web/src/vault.ts`),
- the web relay (`server/src/relay.ts`),
- the desktop app's IPC bridge, Electron settings, HTTP tool and update verification.

Also keep the privacy rules in [docs/security-model.md](docs/security-model.md) intact — for example, the server must never send HTTP requests on a user's behalf.

## No secrets in commits

Never commit `.env` files, databases, `totp.key`, update signing keys, passwords, tokens or real server addresses. Use obviously fake example values (such as `example.com` or `192.168.0.10`) in code, tests and docs.

## License

Terminas is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`, see [LICENSE](LICENSE) and the [README](README.md#license)).

Contributions are accepted under the same license (inbound = outbound): by opening a pull request, you agree that your contribution is licensed under `AGPL-3.0-only`. Only submit code and other material that you wrote yourself or otherwise have the right to submit under that license.
