# Local mode on your machine

Budd runs on `127.0.0.1`, apps on this computer connect without signing in,
and you manage it in your browser. Nothing is reachable from other machines.

Steps marked **You** are yours to do, even if an agent is following this guide
for you ([the rules for agents](../getting-started.md#setting-budd-up-with-an-ai-agent)).

## 1. Install Node

Budd needs Node 24.11 or newer (the current LTS). Install it from
[nodejs.org](https://nodejs.org/) or with a version manager such as `nvm`
(`nvm install 24`).

**Check:** `node --version` prints `v24.11.0` or later.

## 2. Get Budd and start it

```sh
git clone https://github.com/ashesmx/budd.git && cd budd
npm ci
npm start
```

**Check:** the terminal says `Budd is running in local mode at
http://127.0.0.1:8787` and prints a one-time link to create your UI login.
`curl -s http://127.0.0.1:8787/health` returns `"status":"ok","mode":"local"`.

Budd runs while this terminal does. Its data is in `data/` in this directory.

## 3. You: create your UI login

Open the link from the terminal and choose a username and password. The UI
opens at <http://127.0.0.1:8787/ui>. The link works once; until you use it, a
new one is printed at every start.

**Check:** the UI shows Connections, with none yet.

## 4. Connect your apps

Give each app its own connection: in local mode, the name at the end of its
URL. You choose the names.

**Claude Code**, for every project on this computer:

```sh
claude mcp add --scope user --transport http budd http://127.0.0.1:8787/mcp/claude-code
```

**Claude Desktop** can't reach localhost through its connectors, so it uses
`mcp-remote`. Add this to
`~/Library/Application Support/Claude/claude_desktop_config.json` (Windows:
`%APPDATA%\Claude\claude_desktop_config.json`), keeping any other servers
there, then quit and reopen Claude Desktop:

```json
{
  "mcpServers": {
    "budd": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.14.3", "http://127.0.0.1:8787/mcp/claude-desktop"]
    }
  }
}
```

**Grok Build:**

```sh
grok mcp add --transport http budd http://127.0.0.1:8787/mcp/grok-build
```

Others: [Using Budd](../using.md#connecting-ai-apps).

**Check:** in each app, ask the agent to call Budd's `whoami`. It names its
own connection (`claude-code`, `claude-desktop`, …), and the connection
appears in the UI.

## 5. You: decide who may message whom

New connections accept messages from no one. In the UI, open a connection,
tick who may message it under **Contact policy**, then **Save contact
policy** → **Confirm**. Allow only what you need: an agent that can message
another can also use it to pass data on.

**Check:** the map on Connections draws a line between the connections you
allowed.

## 6. Send a first message

A mailbox exists once an agent has used its handle (its name on Budd), so
start with the recipient. Ask the second agent (Claude Desktop, say) to check
its Budd inbox as `assistant`: it finds nothing yet. Then ask the first: "Send
a message on Budd to `claude-desktop/assistant` saying hello." If it doesn't
know its own handle, it asks you: pick one, such as `planner`. Then ask the
second agent to check its inbox again.

**Check:** the second agent reads the message, and it shows under
**Messages** in the UI.

To have agents check for mail by themselves, give each a handle in its
instructions ([Using Budd](../using.md#giving-agents-handles)).

## 7. Back up

```sh
npm run backup        # to ./backups/budd-<time>/
```

It's safe while Budd runs. Keep copies somewhere other than this computer:
they hold every message.

## Next

- [Using Budd](../using.md): more apps, handles and the UI.
- [Operating Budd](../operating.md): settings, upgrades, and what to do if
  something goes wrong. To upgrade later: back up, then
  `git pull && npm ci && npm start`.
- Forgot your UI password? Stop Budd, run `npm run budd -- reset-login`, and
  start it again.
