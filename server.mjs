#!/usr/bin/env node
/**
 * WebIridium MCP bridge.
 *
 * Claude Code starts this process and talks MCP to it over stdio. The open
 * WebIridium tab connects to it over a WebSocket on 127.0.0.1, sends the list
 * of tools it offers, and runs each tool call it receives in the page (with
 * the in-app approval dialog for anything that changes the project).
 *
 * Wire protocol (JSON messages over the WebSocket):
 *   tab -> bridge  { type: "hello", token, tools: [{ name, description, inputSchema }] }
 *   bridge -> tab  { type: "welcome" } | { type: "error", message }
 *   bridge -> tab  { type: "call", id, name, arguments }
 *   tab -> bridge  { type: "result", id, result: { success, message, data?, error?, verifiedPostActionState? } }
 *
 * stdout carries MCP only, so all logging goes to stderr.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env.WEBIRIDIUM_BRIDGE_PORT ?? 7323);
const HOST = "127.0.0.1";
const HELLO_TIMEOUT_MS = 5_000;
// Long enough for the user to read and answer the in-app approval dialog
const CALL_TIMEOUT_MS = 10 * 60_000;
const STATUS_TOOL = "webiridium_connection_status";

const DEFAULT_ORIGINS = ["https://sys-bio.github.io"];
const extraOrigins = (process.env.WEBIRIDIUM_BRIDGE_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = new Set([...DEFAULT_ORIGINS, ...extraOrigins]);

const log = (...args) => console.error("[webiridium-mcp]", ...args);

/** Local dev servers (vite) on any port are allowed. */
const isAllowedOrigin = (origin) => {
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
};

/**
 * The pairing code is kept in ~/.webiridium/bridge-token so the user pastes
 * it into WebIridium once, not every time Claude Code restarts the bridge.
 */
const loadPairingCode = () => {
  if (process.env.WEBIRIDIUM_BRIDGE_TOKEN) {
    return process.env.WEBIRIDIUM_BRIDGE_TOKEN.trim();
  }
  const dir = join(homedir(), ".webiridium");
  const file = join(dir, "bridge-token");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return saved;
  } catch {
    // not created yet
  }
  const code = randomBytes(12).toString("base64url");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, code + "\n", { mode: 0o600 });
  } catch (err) {
    log("Could not save pairing code, using a temporary one:", err.message);
  }
  return code;
};

const pairingCode = loadPairingCode();

const codesMatch = (given) => {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(pairingCode);
  return a.length === b.length && timingSafeEqual(a, b);
};

// ---------------------------------------------------------------------------
// Tab connection state
// ---------------------------------------------------------------------------

/** The one paired tab, or null. A newer paired tab replaces the older one. */
let tab = null; // { socket, origin, tools }
let listenError = null;
let nextCallId = 1;
const pending = new Map(); // id -> { resolve, timer }

const failPending = (message) => {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ success: false, message, error: "BRIDGE_DISCONNECTED" });
    pending.delete(id);
  }
};

const mcp = new Server(
  { name: "webiridium", version: "0.1.0" },
  {
    capabilities: { tools: { listChanged: true } },
    instructions:
      "These tools control the WebIridium simulator open in the user's browser. " +
      `If only ${STATUS_TOOL} is listed, call it to see how to connect the tab. ` +
      "Tools that change the project may show an approval dialog in WebIridium; " +
      "a USER_DECLINED_ACTION result means the user said no there.",
  },
);

const notifyToolsChanged = () => {
  mcp.sendToolListChanged().catch(() => {
    // Client may not be connected yet; it lists tools on connect anyway.
  });
};

const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
  maxPayload: 16 * 1024 * 1024,
  verifyClient: ({ origin }, done) => {
    if (isAllowedOrigin(origin)) return done(true);
    log("Rejected connection from origin", origin);
    done(false, 403, "Origin not allowed");
  },
});

wss.on("listening", () => log(`Listening on ws://${HOST}:${PORT}`));
wss.on("error", (err) => {
  listenError = err;
  log("WebSocket server error:", err.message);
});

wss.on("connection", (socket, req) => {
  const origin = req.headers.origin;
  let paired = false;
  const helloTimer = setTimeout(() => {
    if (!paired) socket.close(4001, "No hello received");
  }, HELLO_TIMEOUT_MS);

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!paired) {
      if (msg?.type !== "hello") return;
      clearTimeout(helloTimer);
      if (!codesMatch(msg.token)) {
        socket.send(
          JSON.stringify({ type: "error", message: "Wrong pairing code" }),
        );
        socket.close(4003, "Wrong pairing code");
        return;
      }
      paired = true;
      if (tab && tab.socket !== socket) {
        tab.socket.close(4000, "Replaced by another WebIridium tab");
      }
      tab = {
        socket,
        origin,
        tools: Array.isArray(msg.tools) ? msg.tools : [],
      };
      socket.send(JSON.stringify({ type: "welcome" }));
      log(`Tab paired from ${origin} with ${tab.tools.length} tools`);
      notifyToolsChanged();
      return;
    }

    if (msg?.type === "tools" && tab?.socket === socket) {
      tab.tools = Array.isArray(msg.tools) ? msg.tools : [];
      notifyToolsChanged();
    } else if (msg?.type === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg.result);
    }
  });

  socket.on("close", () => {
    clearTimeout(helloTimer);
    if (tab?.socket === socket) {
      tab = null;
      failPending("The WebIridium tab disconnected before answering.");
      log("Tab disconnected");
      notifyToolsChanged();
    }
  });
});

const callTab = (name, args) =>
  new Promise((resolve) => {
    if (!tab) {
      resolve({
        success: false,
        message: `WebIridium is not connected. Call ${STATUS_TOOL} for setup steps.`,
        error: "BRIDGE_DISCONNECTED",
      });
      return;
    }
    const id = nextCallId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({
        success: false,
        message: "WebIridium did not answer in time.",
        error: "BRIDGE_TIMEOUT",
      });
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    tab.socket.send(
      JSON.stringify({ type: "call", id, name, arguments: args ?? {} }),
    );
  });

// ---------------------------------------------------------------------------
// MCP handlers
// ---------------------------------------------------------------------------

const statusTool = {
  name: STATUS_TOOL,
  description:
    "Reports whether a WebIridium browser tab is connected to this bridge, and if not, " +
    "the pairing code and steps the user needs to connect it.",
  inputSchema: { type: "object", properties: {} },
};

const statusText = () => {
  if (listenError) {
    return (
      `The bridge could not listen on ${HOST}:${PORT} (${listenError.message}). ` +
      "Another Claude Code session may already be running it. Close that session, " +
      "or set WEBIRIDIUM_BRIDGE_PORT to a different port in this MCP server's config " +
      "and use the same port in WebIridium."
    );
  }
  if (tab) {
    return `Connected to WebIridium at ${tab.origin}. Tools available: ${tab.tools
      .map((t) => t.name)
      .join(", ")}.`;
  }
  return [
    "No WebIridium tab is connected. Ask the user to:",
    "1. Open WebIridium (https://sys-bio.github.io/WebIridium/ or their local dev server).",
    "2. Open the Chat panel, then Settings, and find 'Connect to Claude Code'.",
    `3. Paste this pairing code: ${pairingCode}`,
    `4. Leave the port as ${PORT} and click Connect.`,
    "The WebIridium tools will appear once the tab connects.",
  ].join("\n");
};

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    statusTool,
    ...(tab?.tools ?? []).filter((t) => t?.name && t.name !== STATUS_TOOL),
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === STATUS_TOOL) {
    return { content: [{ type: "text", text: statusText() }] };
  }

  const result = await callTab(name, args);
  const parts = [result?.message ?? "(no message)"];
  if (result?.data !== undefined) {
    parts.push("Data:\n" + JSON.stringify(result.data, null, 2));
  }
  if (result?.verifiedPostActionState) {
    parts.push(
      "Application state after this action:\n" + result.verifiedPostActionState,
    );
  }
  // A declined action is the user's answer, not a tool failure
  const declined = result?.error === "USER_DECLINED_ACTION";
  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    isError: !result?.success && !declined,
  };
});

await mcp.connect(new StdioServerTransport());
log("MCP server ready on stdio");

const shutdown = () => {
  failPending("The bridge is shutting down.");
  wss.close();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
