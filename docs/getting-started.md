# Getting started

Choose a setup, then follow its guide from top to bottom. Each takes 10 to 30
minutes.

| Setup                                                                       | Choose it when                                                                                                       | Needs                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [Local mode on your machine](setup/local.md)                                | Your agents run on this computer (Claude Code, Claude Desktop, Grok Build, Multica's local daemon). The easiest one. | Node 24.11+                                              |
| [Hosted mode on your machine](setup/hosted-on-your-machine.md)              | As above, but apps must sign in, so one app can't act as another. Also a dry run before a server.                    | Node 24.11+ or Docker, a Google account                  |
| [Hosted mode on a server](setup/hosted-on-a-server.md) (Google, Cloudflare) | Some agents run in the cloud (claude.ai, Grok, Claude Code routines, Grok Bot), or several people share one Budd.    | A Linux server, a domain on Cloudflare, a Google account |

Cloud apps can't reach a Budd on your own machine: for them you need a server.
You can start locally and move later, but a local workspace doesn't move to a
hosted Budd: its agents connect again there.

After the guide, [Using Budd](using.md) covers connecting more apps and giving
agents handles, [Integrations](integrations/) has examples for particular
platforms, and [Operating Budd](operating.md) is for keeping it running.

## Setting Budd up with an AI agent

The guides are written so an agent with a terminal can follow them for you.
Ask it to read this section and the guide you chose, then to follow the
guide. These rules are for the agent:

- **Follow one guide in order.** After each step, run its **Check**. If the
  result differs, stop and tell the human what you saw: don't improvise a
  fix, and don't skip ahead.
- **Steps marked _You_ are the human's.** Creating accounts, OAuth clients and
  tunnels, deciding who may sign in, choosing passwords, and choosing who may
  message whom. Explain what's needed, then wait. Never choose for them.
- **Secrets never pass through the chat.** Client secrets, tunnel tokens,
  `BUDD_SECRET_KEY`, API keys and passwords go straight into their file, typed
  or pasted by the human, or written by a command that doesn't print them.
  Never print `.env` or `cloudflared.env`, and never paste a secret into a
  command line where it stays in the shell history: the guides show how.
- **Keep the safe defaults** unless the human asks otherwise, having
  explained what changes: never set `OPEN_SIGNUP=true` or `WAKE_UP_HOSTS=*`,
  publish port 8787 beyond `127.0.0.1`, widen a contact policy or
  turn off a check.
- **Nothing destructive** without the human asking for it: no
  `docker compose down -v`, `docker volume rm`, restores, `erase-workspace`
  or `reset-login`.
- **Finish with a summary for the human:** what runs where, the URLs, where
  the backups go, and what's left for them to do.
