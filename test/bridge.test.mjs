// End-to-end tests: MCP clients over stdio <-> one or more bridge processes
// <-> a fake WebIridium tab over WebSocket. Run with `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const CODE = "test-pairing-code";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 7000 + Math.floor(Math.random() * 800);
const running = new Set();

after(() => {
  for (const b of running) b.kill();
});

/** Starts one bridge process with an MCP client attached to its stdio. */
const startBridge = async (port, env = {}) => {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      WEBIRIDIUM_BRIDGE_PORT: String(port),
      WEBIRIDIUM_BRIDGE_TOKEN: CODE,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  let buf = "";
  let nextId = 1;
  const waiting = new Map();
  const notifications = [];
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id && waiting.has(msg.id)) waiting.get(msg.id)(msg);
      else if (msg.method) notifications.push(msg.method);
    }
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const bridge = {
    proc,
    rpc,
    notifications,
    stderr: () => stderr,
    toolNames: async () =>
      (await rpc("tools/list")).result.tools.map((t) => t.name),
    status: async () =>
      (
        await rpc("tools/call", {
          name: "webiridium_connection_status",
          arguments: {},
        })
      ).result.content[0].text,
    call: async (name, args = {}) =>
      (await rpc("tools/call", { name, arguments: args })).result,
    kill: () => {
      running.delete(bridge);
      proc.kill();
    },
  };
  running.add(bridge);
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  // Wait until it is either listening or relaying
  await waitFor(() => /Listening|as a peer/.test(stderr), "bridge to start");
  return bridge;
};

const waitFor = async (check, what, timeoutMs = 5000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const schema = { type: "object", properties: {} };
const TAB_TOOLS = [
  { name: "get_application_state", description: "s", inputSchema: schema },
  { name: "update_antimony_model", description: "e", inputSchema: schema },
];

/** A fake WebIridium tab that answers calls. */
const connectTab = (
  port,
  { origin = "https://sys-bio.github.io", token = CODE } = {},
) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    ws.on("error", reject);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "hello", token, tools: TAB_TOOLS })),
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") resolve(ws);
      if (msg.type !== "call") return;
      const result =
        msg.name === "update_antimony_model"
          ? {
              success: false,
              message: "Declined",
              error: "USER_DECLINED_ACTION",
            }
          : { success: true, message: "ok", data: { got: msg.arguments } };
      ws.send(JSON.stringify({ type: "result", id: msg.id, result }));
    });
    ws.on("close", (code) => reject(new Error(`closed ${code}`)));
  });

test("only the status tool is listed before a tab connects", async () => {
  const b = await startBridge(nextPort++);
  assert.deepEqual(await b.toolNames(), ["webiridium_connection_status"]);
  assert.match(await b.status(), /No WebIridium tab is connected/);
  b.kill();
});

test("rejects other websites and explains it in the status", async () => {
  const port = nextPort++;
  const b = await startBridge(port);
  const err = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: "https://evil.example",
    });
    ws.on("error", resolve);
    ws.on("open", () => resolve(null));
  });
  assert.match(err?.message ?? "", /403/);
  assert.match(await b.status(), /https:\/\/evil\.example .*turned away/s);
  b.kill();
});

test("rejects a wrong pairing code and explains it in the status", async () => {
  const port = nextPort++;
  const b = await startBridge(port);
  await assert.rejects(
    connectTab(port, { origin: "http://localhost:5173", token: "nope" }),
    /closed 4003/,
  );
  assert.match(await b.status(), /wrong pairing\s+code/);
  b.kill();
});

test("forwards calls to a paired tab and returns results", async () => {
  const port = nextPort++;
  const b = await startBridge(port);
  const tab = await connectTab(port);
  await waitFor(
    () => b.notifications.includes("notifications/tools/list_changed"),
    "list_changed",
  );
  assert.deepEqual(await b.toolNames(), [
    "webiridium_connection_status",
    "get_application_state",
    "update_antimony_model",
  ]);

  const ok = await b.call("get_application_state", { a: 1 });
  assert.equal(ok.isError, false);
  assert.match(ok.content[0].text, /"a": 1/);

  // A declined change is the user's answer, not a tool error
  const declined = await b.call("update_antimony_model");
  assert.equal(declined.isError, false);
  assert.match(declined.content[0].text, /Declined/);

  tab.close();
  await waitFor(
    async () => (await b.toolNames()).length === 1,
    "tools to go away",
  );
  b.kill();
});

test("a second copy relays through the first one", async () => {
  const port = nextPort++;
  const hub = await startBridge(port);
  const peer = await startBridge(port);
  assert.match(peer.stderr(), /as a peer/);

  const tab = await connectTab(port);
  await waitFor(
    async () => (await peer.toolNames()).length === 3,
    "peer to see the tab's tools",
  );
  const res = await peer.call("get_application_state", { from: "peer" });
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /"from": "peer"/);
  assert.match(await peer.status(), /Connected to WebIridium/);

  tab.close();
  hub.kill();
  peer.kill();
});

test("when the first copy exits, the next one takes over", async () => {
  const port = nextPort++;
  const hub = await startBridge(port);
  const peer = await startBridge(port);
  const tab = await connectTab(port);
  await waitFor(
    async () => (await peer.toolNames()).length === 3,
    "peer tools",
  );

  hub.kill();
  await waitFor(() => /Listening/.test(peer.stderr()), "peer to take over");
  // The tab's connection went with the old hub; it reconnects to the new one
  await new Promise((r) =>
    tab.readyState === WebSocket.CLOSED ? r() : tab.on("close", r),
  );
  await connectTab(port);
  await waitFor(
    async () => (await peer.toolNames()).length === 3,
    "tools back",
  );
  const res = await peer.call("get_application_state");
  assert.equal(res.isError, false);
  peer.kill();
});

test("a copy with a different pairing code says so", async () => {
  const port = nextPort++;
  const hub = await startBridge(port);
  const other = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      WEBIRIDIUM_BRIDGE_PORT: String(port),
      WEBIRIDIUM_BRIDGE_TOKEN: "something-else",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  other.stdout.on("data", (d) => (out += d));
  const send = (msg) => other.stdin.write(JSON.stringify(msg) + "\n");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  });
  await sleep(800);
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "webiridium_connection_status", arguments: {} },
  });
  await waitFor(() => out.includes('"id":2'), "status reply");
  assert.match(out, /different pairing/);
  other.kill();
  hub.kill();
});
