// End-to-end test: an MCP client over stdio <-> the bridge <-> a fake
// WebIridium tab over WebSocket. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 7000 + Math.floor(Math.random() * 900);
const CODE = "test-pairing-code";
const URL_ = `ws://127.0.0.1:${PORT}`;

let proc;
let nextId = 1;
const waiting = new Map();
const notifications = [];

const rpc = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toolNames = async () =>
  (await rpc("tools/list")).result.tools.map((t) => t.name);

before(async () => {
  proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      WEBIRIDIUM_BRIDGE_PORT: String(PORT),
      WEBIRIDIUM_BRIDGE_TOKEN: CODE,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
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
  // Wait for the WebSocket server to listen
  await new Promise((resolve) => {
    proc.stderr.on("data", (d) => {
      if (String(d).includes("Listening")) resolve();
    });
  });
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
});

after(() => {
  proc.stdin.end();
  proc.kill();
});

test("only the status tool is listed before a tab connects", async () => {
  assert.deepEqual(await toolNames(), ["webiridium_connection_status"]);
  const res = await rpc("tools/call", {
    name: "webiridium_connection_status",
    arguments: {},
  });
  assert.match(res.result.content[0].text, /No WebIridium tab is connected/);
});

test("rejects pages from other origins", async () => {
  const err = await new Promise((resolve) => {
    const ws = new WebSocket(URL_, { origin: "https://evil.example" });
    ws.on("error", resolve);
    ws.on("open", () => resolve(null));
  });
  assert.ok(err, "connection should fail");
  assert.match(err.message, /403/);
});

test("rejects a wrong pairing code", async () => {
  const code = await new Promise((resolve) => {
    const ws = new WebSocket(URL_, { origin: "http://localhost:5173" });
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "hello", token: "nope", tools: [] })),
    );
    ws.on("close", resolve);
  });
  assert.equal(code, 4003);
});

test("forwards calls to a paired tab and returns results", async () => {
  const tab = new WebSocket(URL_, { origin: "https://sys-bio.github.io" });
  await new Promise((r) => tab.on("open", r));
  tab.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "call") return;
    const result =
      msg.name === "update_antimony_model"
        ? { success: false, message: "Declined", error: "USER_DECLINED_ACTION" }
        : { success: true, message: "ok", data: { got: msg.arguments } };
    tab.send(JSON.stringify({ type: "result", id: msg.id, result }));
  });
  const schema = { type: "object", properties: {} };
  tab.send(
    JSON.stringify({
      type: "hello",
      token: CODE,
      tools: [
        {
          name: "get_application_state",
          description: "s",
          inputSchema: schema,
        },
        {
          name: "update_antimony_model",
          description: "e",
          inputSchema: schema,
        },
      ],
    }),
  );
  await sleep(200);

  assert.ok(notifications.includes("notifications/tools/list_changed"));
  assert.deepEqual(await toolNames(), [
    "webiridium_connection_status",
    "get_application_state",
    "update_antimony_model",
  ]);

  const ok = await rpc("tools/call", {
    name: "get_application_state",
    arguments: { a: 1 },
  });
  assert.equal(ok.result.isError, false);
  assert.match(ok.result.content[0].text, /"a": 1/);

  // A declined change is the user's answer, not a tool error
  const declined = await rpc("tools/call", {
    name: "update_antimony_model",
    arguments: {},
  });
  assert.equal(declined.result.isError, false);
  assert.match(declined.result.content[0].text, /Declined/);

  tab.close();
  await sleep(200);
  assert.deepEqual(await toolNames(), ["webiridium_connection_status"]);
});
