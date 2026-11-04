# Contributing

Thanks for trying Budd.

**Issues are welcome:** bugs, steps in the docs that didn't work for you,
and ideas. Open one with a template on the Issues tab. A setup guide that
went wrong is a bug too: say which step, and what you saw.

**Pull requests aren't accepted yet.** Budd is before 1.0, and its design
still changes from week to week, so for now changes come from its maintainer.
If you've found the fix for something, describe it in the issue.

**Security problems** go privately, never in an issue: see
[SECURITY.md](SECURITY.md).

## Working on the code

For trying a change on your own copy:

```sh
npm ci
npm run check     # types, lint, formatting and the tests
npm run smoke     # the Docker deployment, end to end (needs Docker)
```

[ARCHITECTURE.md](ARCHITECTURE.md) explains the code and the rules it keeps,
and [docs/adr/](docs/adr/) the decisions behind it.
