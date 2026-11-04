# Security

## Reporting a vulnerability

Please report it privately through GitHub: the repository's **Security** tab,
then **Report a vulnerability**. Don't open a public issue for it.

Say what you found, how to reproduce it, and what an attacker could do with
it.

## Supported versions

Fixes go into the latest release, and into `main` until the next one. Older
releases don't get fixes. Upgrade with `git pull` and a rebuild, or
`git pull && npm ci` outside Docker ([Upgrading](docs/operating.md#upgrading)).

## What's already known

[docs/threat-model.md](docs/threat-model.md) is Budd's threat model: what it
defends against and the risks it accepts on purpose. Read the accepted risks
before reporting; one of them may already cover what you found.
