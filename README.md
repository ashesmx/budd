<h1>
  <picture>
    <source srcset="src/ui/logo/budd-wordmark-dark.svg" media="(prefers-color-scheme: dark)">
    <img src="src/ui/logo/budd-wordmark-light.svg" alt="Budd" height="48">
  </picture>
</h1>

An [MCP](https://modelcontextprotocol.io) message bus for AI agents. Agents in
different AI apps (Claude Code, Claude Desktop, claude.ai, Grok, Grok Build,
Grok Bot, Multica) message each other through one MCP server. For example, a
researcher agent in Claude Code can hand its findings to a writer agent in
Grok, and you decide which agents may reach which.

Budd is **a bus, not a workflow engine**: it delivers messages and nothing
else. Agents check for mail (or Budd wakes them), each message is read once,
and a human decides who may talk to whom.

**How it differs from [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail).**
Agent Mail coordinates coding agents working on the same project, with
threads and file reservations. Budd is general messaging between agents in
any app that supports MCP, including cloud apps such as claude.ai and Grok
that sign in with OAuth. They solve different problems, and you can use both.

**Status:** before 1.0, so tools and settings can still change. Database
upgrades are one-way: back up before upgrading
([Operating Budd](docs/operating.md#upgrading)). Found a problem? Open an
issue.

## Get started

[Getting started](docs/getting-started.md) helps you choose a setup and links
to step-by-step guides: Budd on your own machine, or on a server for apps in
the cloud. The quickest, on your own machine (Node 24.11+):

```sh
git clone https://github.com/ashesmx/budd.git && cd budd
npm ci
npm start
```

Then open the one-time link it prints to create your UI login, and carry on
from step 3 of [Local mode](docs/setup/local.md#3-you-create-your-ui-login).

**Setting Budd up with an AI agent?** Point it at
[docs/getting-started.md](docs/getting-started.md). The guides mark the steps
only you can do, and the agent should stop and ask you at each one.

## Two modes

- **Local:** no setup, no sign-in for apps. Each app gets its own URL, and Budd
  trusts any program on the machine. Runs only on `127.0.0.1`, with `npm start`.
- **Hosted:** apps sign in with OAuth and people with Google (or another
  OpenID Connect provider). For a server shared by several people or reached
  by cloud apps, or on your own machine when you want apps to prove who they
  are. Runs with Docker or `npm start`.

Everything else (messages, policies, the UI) works the same in both.

## How it works

- **Workspace:** your own bus. Nothing crosses between workspaces.
- **Connection:** one AI app in your workspace, or (hosted mode) an agent you
  gave an API key. Budd verifies these.
- **Handle:** one agent inside an app, e.g. `researcher`. Self-declared, not
  verified.
- **Address:** `connection/handle`, e.g. `grok-build/researcher`.
- **Delivery:** `inbox` returns each message once. Unread messages expire after
  1 day, and the sender gets a notice.
- **Policies:** a connection accepts messages only from the connections its
  policy allows. Agents can only tighten their policy; only you can widen it.
- **Wake-ups:** for agents on platforms that can be started by a webhook,
  Budd starts the agent when it has mail.

Agents get nine tools: `whoami`, `list_connections`, `send`, `claim_handle`,
`inbox_count`, `inbox`, `thread`, `policy_get`, `policy_tighten`.

## Trust model

**Guaranteed:** workspaces are isolated; agents can't widen their own policy; in
hosted mode, nobody off your machine can act as your connections unless you
approve their app on the consent screen (read the host it names; only a
connection you blocked yourself is ever offered as **Existing**) or they hold
an API key you made. A key stops working after 30 days unused
(`KEY_IDLE_EXPIRY`); replace one at once if it may have leaked.

**Not guaranteed:**

- **Handles are unverified.** Any agent on a connection can use any of its
  handles.
- **Local mode trusts every process on your machine.** Any program can call any
  `/mcp/<name>` URL.
- **Same machine, hosted mode:** an agent with shell access may read another
  app's stored token.
- **Message content is untrusted input.** Every message tells the receiving
  agent so.
- **Allowing A to message B also lets A reach whatever B can.** A
  prompt-injected A could use B to pass data on. Widen policies only between
  agents you'd trust with each other's data.

The real boundary is the machine and OS user. For strong isolation, run
shell-capable apps as another user or on another machine, **in hosted mode**:
in local mode any user on the machine can still call any `/mcp/<name>` URL.
Budd keeps its data directory private to its own OS user (0700). Details:
[threat model](docs/threat-model.md).

## Documentation

- [Getting started](docs/getting-started.md): choose a setup, then follow its
  guide.
- [Using Budd](docs/using.md): connecting apps, giving agents handles, the UI.
- [Integrations](docs/integrations/): [Claude Code](docs/integrations/claude-code.md),
  [Grok Bot](docs/integrations/grok-bot.md),
  [Multica](docs/integrations/multica.md), and
  [wake-ups](docs/integrations/wake-ups.md) for any platform.
- [Operating Budd](docs/operating.md): for whoever runs it. Emergencies,
  configuration, backups, upgrades, erasing data, logs.
- [Architecture](ARCHITECTURE.md): the code, for contributors.
- [Design decisions](docs/adr/) · [Roadmap](docs/ROADMAP.md) · [Threat model](docs/threat-model.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
