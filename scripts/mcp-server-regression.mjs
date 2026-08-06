import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requests = [];
const port = 18918;
const httpServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, token: req.headers["x-memory-hub-token"], body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url, body, context: { stableContext: "full" }, messages: [], events: [], snapshot: { state: {} } }));
  });
});
await new Promise((resolve) => httpServer.listen(port, "127.0.0.1", resolve));

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "mcp-server.mjs")], env: { ...process.env, MEMORY_HUB_URL: `http://127.0.0.1:${port}`, MEMORY_HUB_TOKEN: "mcp-test-token" }, stderr: "pipe" });
const client = new Client({ name: "memory-hub-mcp-regression", version: "0.1.0" });
try {
  await client.connect(transport, { versionNegotiation: { mode: "auto" } });
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["sully_cancel_wake", "sully_commit_activity", "sully_commit_message", "sully_get_character_context", "sully_get_recent_messages", "sully_get_runtime_state", "sully_list_events", "sully_recall", "sully_schedule_wake"].sort());
  await client.callTool({ name: "sully_get_character_context", arguments: { characterId: "char-1", claimNextWake: true } });
  await client.callTool({ name: "sully_get_recent_messages", arguments: { characterId: "char-1" } });
  await client.callTool({ name: "sully_recall", arguments: { characterId: "char-1", query: "radio" } });
  await client.callTool({ name: "sully_get_runtime_state", arguments: { characterId: "char-1" } });
  await client.callTool({ name: "sully_commit_activity", arguments: { characterId: "char-1", activityId: "activity-1", content: "worked", statePatch: { location: "desk" } } });
  await client.callTool({ name: "sully_commit_message", arguments: { characterId: "char-1", messageId: "message-1", content: "hello" } });
  await client.callTool({ name: "sully_schedule_wake", arguments: { characterId: "char-1", jobId: "job-1", dueAt: "2026-08-06T00:00:00.000Z", reason: "test" } });
  await client.callTool({ name: "sully_cancel_wake", arguments: { characterId: "char-1", jobId: "job-1" } });
  await client.callTool({ name: "sully_list_events", arguments: { characterId: "char-1" } });
  assert.equal(requests.length, 9);
  assert.equal(requests.every((item) => item.token === "mcp-test-token"), true);
  assert.equal(requests.some((item) => item.url === "/api/v1/cc/wakes/claim"), true);
  assert.equal(requests.some((item) => item.body?.type === "runtime.activity.commit"), true);
  assert.equal(requests.some((item) => item.body?.type === "schedule.job.put"), true);
  console.log(JSON.stringify({ ok: true, tools: names.length, httpCalls: requests.length }));
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => httpServer.close(resolve));
}
