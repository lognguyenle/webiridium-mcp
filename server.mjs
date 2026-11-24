#!/usr/bin/env node
/**
 * WebIridium MCP bridge.
 *
 * Claude Code starts this process and talks MCP to it over stdio. The open
 * WebIridium tab connects to it over a WebSocket on 127.0.0.1, sends the list
 * of tools it offers, and runs each tool call it receives in the page (with
 * the in-app approval dialog for anything that changes the project).
 *
 * Several copies can run at once (one per Claude Code session): the first
 * one listens and the rest relay through it. See "Hub / peer roles" below.
 *
 * Wire protocol (JSON messages over the WebSocket):
 *   tab -> hub     { type: "hello", token, tools: [{ name, description, inputSchema }] }
 *   hub -> tab     { type: "welcome" } | { type: "error", message }
 *   hub -> tab     { type: "call", id, name, arguments }
 *   tab -> hub     { type: "result", id, result: { success, message, data?, error?, verifiedPostActionState? } }
 *   peer -> hub    { type: "peer-hello", token } then { type: "call", id, name, arguments }
 *   hub -> peer    { type: "welcome" } | { type: "state", tab, lastRejection } | { type: "result", id, result }
 *
 * stdout carries MCP only, so all logging goes to stderr.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;
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
// Hub / peer roles
//
// Every Claude Code session (and every `claude mcp list` health check) starts
// its own copy of this server, but only one process can listen on the port.
// That process is the hub: the tab connects to it. Every other copy connects
// to the hub as a peer and sends its tool calls through it. When the hub
// exits, the peers race to take over the port, and the tab reconnects to the
// new hub by itself. So any number of sessions can use the same tab, and no
// copy is ever left without a connection.
// ---------------------------------------------------------------------------

/** "starting" | "hub" | "peer" */
let role = "starting";
/** Hub: the one paired tab, or null. A newer paired tab replaces the older one. */
let tab = null; // { socket, origin, tools }
/** Hub: connected peer sockets. */
const peers = new Set();
/** Peer: the hub socket, and the tab state the hub last reported. */
let hubSocket = null;
let remoteTab = null; // { origin, tools } | null
/** Why the last connection attempt was turned away, for the status tool. */
let lastRejection = null; // { reason, origin, at }
/** Peer: the hub refused this process (pairing codes differ). */
let peerRejected = null;
let wss = null;
let stopping = false;

let nextCallId = 1;
const pending = new Map(); // id -> { resolve, timer }

const failPending = (message) => {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ success: false, message, error: "BRIDGE_DISCONNECTED" });
    pending.delete(id);
  }
};

const settle = (msg) => {
  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.id);
  p.resolve(msg.result);
};

const mcp = new Server(
  { name: "webiridium", version: VERSION },
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

/** The tab as this process sees it, whichever role it has. */
const currentTab = () => {
  if (role === "hub") {
    return tab ? { origin: tab.origin, tools: tab.tools } : null;
  }
  if (role === "peer") return remoteTab;
  return null;
};

const send = (socket, msg) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
};

const parse = (raw) => {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
};

const notConnected = () => ({
  success: false,
  message: `WebIridium is not connected. Call ${STATUS_TOOL} for setup steps.`,
  error: "BRIDGE_DISCONNECTED",
});

/** Sends a call over `socket` and resolves with the result message. */
const sendCall = (socket, name, args, timeoutMs) =>
  new Promise((resolve) => {
    const id = nextCallId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({
        success: false,
        message: "WebIridium did not answer in time.",
        error: "BRIDGE_TIMEOUT",
      });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    send(socket, { type: "call", id, name, arguments: args ?? {} });
  });

// ----- Hub -----------------------------------------------------------------

const hubState = () => ({
  type: "state",
  tab: tab ? { origin: tab.origin, tools: tab.tools } : null,
  lastRejection,
});

const broadcastState = () => {
  for (const peer of peers) send(peer, hubState());
  notifyToolsChanged();
};

const reject = (reason, origin) => {
  lastRejection = {
    reason,
    origin: origin ?? null,
    at: new Date().toISOString(),
  };
  log(`Rejected connection (${reason})`, origin ?? "");
  for (const peer of peers) send(peer, hubState());
};

const tabCall = (name, args) =>
  tab
    ? sendCall(tab.socket, name, args, CALL_TIMEOUT_MS)
    : Promise.resolve(notConnected());

const handleConnection = (socket, req) => {
  // Browsers always send Origin, so a connection without one is a local
  // process: another copy of this server. Pages can never pose as a peer.
  const origin = req.headers.origin;
  const isPeer = !origin;
  let paired = false;
  const helloTimer = setTimeout(() => {
    if (!paired) socket.close(4001, "No hello received");
  }, HELLO_TIMEOUT_MS);

  socket.on("message", (raw) => {
    const msg = parse(raw);
    if (!msg) return;

    if (!paired) {
      if (msg.type !== (isPeer ? "peer-hello" : "hello")) return;
      clearTimeout(helloTimer);
      if (!codesMatch(msg.token)) {
        if (isPeer) {
          send(socket, {
            type: "error",
            message: "the running copy has a different pairing code",
          });
        } else {
          reject("wrong pairing code", origin);
          send(socket, { type: "error", message: "Wrong pairing code" });
        }
        socket.close(4003, "Wrong pairing code");
        return;
      }
      paired = true;
      if (isPeer) {
        peers.add(socket);
        send(socket, { type: "welcome" });
        send(socket, hubState());
        return;
      }
      if (tab && tab.socket !== socket) {
        tab.socket.close(4000, "Replaced by another WebIridium tab");
      }
      tab = {
        socket,
        origin,
        tools: Array.isArray(msg.tools) ? msg.tools : [],
      };
      lastRejection = null;
      send(socket, { type: "welcome" });
      log(`Tab paired from ${origin} with ${tab.tools.length} tools`);
      broadcastState();
      return;
    }

    if (isPeer) {
      if (msg.type === "call") {
        tabCall(String(msg.name), msg.arguments).then((result) =>
          send(socket, { type: "result", id: msg.id, result }),
        );
      }
      return;
    }

    if (msg.type === "tools" && tab?.socket === socket) {
      tab.tools = Array.isArray(msg.tools) ? msg.tools : [];
      broadcastState();
    } else if (msg.type === "result") {
      settle(msg);
    }
  });

  socket.on("close", () => {
    clearTimeout(helloTimer);
    peers.delete(socket);
    if (tab?.socket === socket) {
      tab = null;
      failPending("The WebIridium tab disconnected before answering.");
      log("Tab disconnected");
      broadcastState();
    }
  });
};

// ----- Peer ----------------------------------------------------------------

const connectAsPeer = () => {
  const socket = new WebSocket(`ws://${HOST}:${PORT}`);
  hubSocket = socket;
  let welcomed = false;

  socket.on("open", () =>
    send(socket, { type: "peer-hello", token: pairingCode }),
  );
  socket.on("message", (raw) => {
    const msg = parse(raw);
    if (!msg) return;
    if (msg.type === "welcome") {
      welcomed = true;
      role = "peer";
      peerRejected = null;
      log("Connected to the running webiridium-mcp as a peer");
    } else if (msg.type === "error") {
      peerRejected = String(msg.message);
    } else if (msg.type === "state") {
      remoteTab = msg.tab ?? null;
      lastRejection = msg.lastRejection ?? null;
      notifyToolsChanged();
    } else if (msg.type === "result") {
      settle(msg);
    }
  });
  // An error is always followed by "close", which retries
  socket.on("error", () => {});
  socket.on("close", () => {
    if (hubSocket !== socket) return;
    hubSocket = null;
    const hadTab = Boolean(remoteTab);
    remoteTab = null;
    role = "starting";
    failPending(
      "The connection to WebIridium was handed to another Claude Code session before it answered, so it may or may not have run. Check with get_application_state, then try again.",
    );
    if (hadTab) notifyToolsChanged();
    if (stopping) return;
    if (welcomed) log("The running copy went away; taking over");
    // A rejected peer would be rejected again, so retry slowly in case the
    // other copy exits. Otherwise race the other peers to become the hub.
    setTimeout(start, peerRejected ? 5_000 : 50 + Math.random() * 300);
  });
};

const callTab = (name, args) => {
  if (role === "hub") return tabCall(name, args);
  if (role === "peer" && hubSocket && remoteTab) {
    // The hub applies its own timeout; this one only guards a silent hub
    return sendCall(hubSocket, name, args, CALL_TIMEOUT_MS + 5_000);
  }
  return Promise.resolve(notConnected());
};

// ----- Start ---------------------------------------------------------------

/** Try to become the hub; if the port is taken, join the hub as a peer. */
function start() {
  if (stopping) return;
  const server = new WebSocketServer({
    host: HOST,
    port: PORT,
    maxPayload: 16 * 1024 * 1024,
    verifyClient: ({ origin }, done) => {
      if (!origin || isAllowedOrigin(origin)) return done(true);
      reject("website not allowed", origin);
      done(false, 403, "Origin not allowed");
    },
  });
  server.on("listening", () => {
    wss = server;
    role = "hub";
    peerRejected = null;
    log(`Listening on ws://${HOST}:${PORT}`);
  });
  server.on("connection", handleConnection);
  server.on("error", (err) => {
    if (wss === server) {
      log("WebSocket server error:", err.message);
      return;
    }
    server.close();
    if (err.code === "EADDRINUSE") {
      connectAsPeer();
    } else {
      log(`Could not listen on ${HOST}:${PORT}:`, err.message);
      setTimeout(start, 5_000);
    }
  });
}

// ---------------------------------------------------------------------------
// MCP handlers
// ---------------------------------------------------------------------------

const statusTool = {
  name: STATUS_TOOL,
  description:
    "Reports whether a WebIridium browser tab is connected, and if not, why, plus the " +
    "pairing code and steps the user needs to connect it.",
  inputSchema: { type: "object", properties: {} },
};

const describeRejection = () => {
  if (!lastRejection) return null;
  const { reason, origin, at } = lastRejection;
  if (reason === "website not allowed") {
    return (
      `A page at ${origin} tried to connect at ${at} and was turned away: only ` +
      "https://sys-bio.github.io and localhost / 127.0.0.1 pages are allowed. If that " +
      "was WebIridium opened through a network address, open it at localhost instead, " +
      "or add the origin to WEBIRIDIUM_BRIDGE_ORIGINS in this server's config."
    );
  }
  return (
    `A WebIridium tab at ${origin} tried to connect at ${at} with the wrong pairing ` +
    `code. In WebIridium, click Disconnect, paste the code ${pairingCode} and click Connect.`
  );
};

const statusText = () => {
  const lines = [];
  const current = currentTab();
  if (current) {
    lines.push(
      `Connected to WebIridium at ${current.origin}. Tools available: ${current.tools
        .map((t) => t.name)
        .join(", ")}.`,
    );
  } else if (peerRejected) {
    lines.push(
      "Another copy of webiridium-mcp is already running with a different pairing " +
        "code. Make sure every Claude Code config for webiridium uses the same " +
        "WEBIRIDIUM_BRIDGE_TOKEN, or none.",
    );
  } else if (role === "starting") {
    lines.push("The connector is reconnecting; try again in a second.");
  } else {
    lines.push(
      "No WebIridium tab is connected. Ask the user to:",
      "1. Open WebIridium (https://sys-bio.github.io/WebIridium/ or a local dev server at localhost).",
      "2. Open the Chat panel, then Settings, and find 'Connect to Claude Code'.",
      `3. Paste this pairing code: ${pairingCode}`,
      `4. Leave the port as ${PORT} and click Connect.`,
      "The tab connects within a few seconds, and the WebIridium tools then appear.",
    );
  }
  const rejection = describeRejection();
  if (rejection && !current) lines.push("", rejection);
  const how =
    role === "hub" ? "listening" : "relaying through the running copy";
  lines.push("", `(webiridium-mcp ${VERSION}, ${how} on ${HOST}:${PORT})`);
  return lines.join("\n");
};

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    statusTool,
    ...(currentTab()?.tools ?? []).filter(
      (t) => t?.name && t.name !== STATUS_TOOL,
    ),
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
start();

const shutdown = () => {
  stopping = true;
  failPending("The bridge is shutting down.");
  hubSocket?.close();
  wss?.close();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
