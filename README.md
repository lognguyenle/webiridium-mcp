# webiridium-mcp

A local MCP server that lets Claude Code use the tools of a WebIridium tab open
in your browser: read the model and results, change simulation settings, run
simulations, edit the Antimony model, and move sliders.

WebIridium is a static site, so the model only exists in your browser tab. This
bridge runs on your computer. Claude Code talks to it over stdio, and the tab
connects to it over a WebSocket on `127.0.0.1`.

```
Claude Code ──stdio (MCP)──▶ webiridium-mcp ◀──ws://127.0.0.1:7323── WebIridium tab
```

## Setup

You need [Node.js](https://nodejs.org) 18 or newer and
[Claude Code](https://claude.com/claude-code).

1. Add the server to Claude Code. `npx` downloads it the first time it runs:

   ```
   claude mcp add webiridium --scope user -- npx -y webiridium-mcp
   ```

2. In Claude Code, ask it to connect to WebIridium. It calls
   `webiridium_connection_status`, which gives you a pairing code.
3. In WebIridium, open **Chat → Settings → Connect to Claude Code**, paste the
   code and click **Connect**.

The WebIridium tools appear in Claude Code once the tab connects. The tab
reconnects by itself after a reload or a Claude Code restart.

## Safety

- The bridge listens on `127.0.0.1` only.
- It only accepts connections from `https://sys-bio.github.io` and local dev
  servers (`localhost` / `127.0.0.1` on any port). Add more with
  `WEBIRIDIUM_BRIDGE_ORIGINS` (comma-separated).
- A tab must send the pairing code before it can receive calls. The code is
  saved in `~/.webiridium/bridge-token`. Delete that file to get a new one.
- Changes to the project still show WebIridium's approval dialog, unless
  "Ask for user confirmation" is turned off in chat settings.
- Only one tab is connected at a time. A newly paired tab replaces the old one.

## Options

| Variable                    | Default                     | Meaning                                   |
| --------------------------- | --------------------------- | ----------------------------------------- |
| `WEBIRIDIUM_BRIDGE_PORT`    | `7323`                      | WebSocket port (set the same port in-app) |
| `WEBIRIDIUM_BRIDGE_TOKEN`   | saved random code           | Use a fixed pairing code instead          |
| `WEBIRIDIUM_BRIDGE_ORIGINS` | `https://sys-bio.github.io` | Extra page origins allowed to connect     |

## Protocol

JSON messages over the WebSocket:

| Direction    | Message                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| tab → bridge | `{ type: "hello", token, tools: [{ name, description, inputSchema }] }` |
| bridge → tab | `{ type: "welcome" }` or `{ type: "error", message }`                   |
| bridge → tab | `{ type: "call", id, name, arguments }`                                 |
| tab → bridge | `{ type: "result", id, result }` (a `ToolExecutionResult`)              |

## Development

```
npm install
npm test
```

To try a local copy with Claude Code:

```
claude mcp add webiridium-dev -- node /path/to/webiridium-mcp/server.mjs
```

See [RELEASING.md](./RELEASING.md) for publishing to npm.

## License

MIT
