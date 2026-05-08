# Security policy

Thank you for helping keep cambiar.world and its operators safe.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

The preferred reporting channel is **[GitHub's private vulnerability reporting](https://github.com/djsincla/cambiar/security/advisories/new)** — it's a private, structured form that goes directly to the maintainers and lets us coordinate a fix and disclosure timeline with you.

If for some reason you can't use that, open a regular GitHub issue with the title `Security report — please make this private` and *no details*. A maintainer will reach out and continue the conversation in private.

## What to include

A useful report includes:

- A description of the issue and its impact (what can an attacker do?)
- Steps to reproduce, ideally with a proof-of-concept
- Affected version(s) — `git rev-parse HEAD` of the deployment you tested
- Your assessment of severity (low / medium / high / critical)
- Any mitigations or workarounds you've identified

## What to expect

- **Acknowledgement within 72 hours.** We'll confirm we received the report and assign a tracking ID.
- **Initial assessment within 7 days.** We'll either confirm the issue or explain why we don't consider it a vulnerability.
- **A fix and a coordinated disclosure** for confirmed issues. For high or critical severity we aim for a patch release within 14 days; medium within 30 days; low best-effort.
- **Credit in the release notes**, if you'd like — let us know how you want to be named (or stay anonymous).

## Scope

In scope:

- The application code in this repository (`server/`, `web/`, `docs/`).
- The build and deployment surface (`Dockerfile`, `docker-compose.yml`, CI workflow).
- The official Docker image when one is published.

Out of scope:

- Issues that require physical access to the host running the SQLite database.
- Vulnerabilities in third-party dependencies that are already publicly disclosed and being tracked upstream — please file those upstream and reference the existing CVE.
- Self-inflicted misconfigurations (running with `JWT_SECRET=changeme`, exposing the admin password, etc.).
- Denial-of-service against an unmaintained or unpatched deployment.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅        |
| < 1.0   | ❌        |

The 0.x series was pre-stability and is not patched. Upgrade to 1.0 or later.

## Hall of fame

Past security reporters who chose to be credited will be listed here.
