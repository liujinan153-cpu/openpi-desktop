# Security Policy

## Supported versions

Security fixes are provided for the latest public release. Older releases should be upgraded through **Settings → Check for updates**.

## Reporting a vulnerability

Please do **not** publish exploitable details in a public issue. Use GitHub's private vulnerability reporting for this repository when available, or contact the repository owner through GitHub and request a private channel.

Include:

- OpenPi Desktop version and Windows version
- Impact and affected feature
- Minimal reproduction steps
- Whether untrusted web content, a skill, MCP server, hook, or model output is involved
- Logs with API keys, tokens, personal paths, and conversation content removed

We will acknowledge a usable report as soon as practical, validate it, and coordinate disclosure after a fix is available.

## Trust model

OpenPi Desktop is a high-privilege local agent. Depending on the selected approval mode it can read/write workspace files, execute commands, control a sandbox browser, and operate the desktop. Users should:

- keep **readonly** or **auto-edit** mode for untrusted tasks;
- inspect confirmation prompts before allowing commands or computer input;
- install skills and MCP servers only from trusted sources;
- treat hooks and MCP server commands as executable code;
- avoid opening untrusted projects with `full-auto` mode;
- never paste credentials into a chat unless intentionally sending them to the selected model provider.

## Local data

Sessions and configuration are stored under `~/.pi/agent/`. API keys in Pi-compatible `auth.json` are local plaintext protected by OS file permissions; prefer environment-variable references where supported. Diagnostic reports and bug reports must be reviewed for secrets before sharing.

## Update integrity

Public updates are downloaded from this repository's GitHub Releases and verified by `electron-updater` using the SHA-512 value in `latest.yml`. Signed releases additionally use the platform's code-signature checks. Never install an update whose publisher or hash warning cannot be explained.
