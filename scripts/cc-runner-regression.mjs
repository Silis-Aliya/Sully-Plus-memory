import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateDir = await mkdtemp(path.join(os.tmpdir(), "sully-cc-runner-"));
const requests = [];
let claimed = false;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : {};
  requests.push({ url: req.url, token: req.headers.authorization, body: json });
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/v1/cc/wakes/claim") {
    if (claimed) return res.end(JSON.stringify({ ok: true, wakeRun: null, context: null }));
    claimed = true;
    return res.end(JSON.stringify({ ok: true, wakeRun: { wakeRunId: "wake-runner-1", characterId: "char-runner", leaseToken: "lease-runner-1", attemptCount: 1 }, context: { characterId: "char-runner", sessionId: null, wakeReason: "autonomy.wake", stableContext: "EXACT_STABLE", deliveryTargets: ["phone-runner"], delta: { messages: [] } } }));
  }
  if (req.url === "/api/v1/runtime/commands") return res.end(JSON.stringify({ ok: true }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const child = spawn(process.execPath, [path.join(root, "cc-runner.mjs")], { cwd: root, env: { ...process.env, MEMORY_HUB_URL: `http://127.0.0.1:${port}`, MEMORY_HUB_TOKEN: "runner-token", CC_RUNNER_ONCE: "true", CC_RUNNER_STATE_DIR: stateDir, CC_RUNNER_CLAUDE_COMMAND: process.execPath, CC_RUNNER_CLAUDE_PREFIX_ARGS: path.join(root, "scripts", "fixtures", "fake-claude-stream.mjs") }, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const code = await new Promise((resolve) => child.once("close", resolve));
server.close();
await rm(stateDir, { recursive: true, force: true });
assert.equal(code, 0, stderr);
assert.equal(requests.every((item) => item.token === "Bearer runner-token"), true);
const commit = requests.find((item) => item.url === "/api/v1/runtime/commands")?.body;
assert.equal(commit.commandId, "cc-wake:wake-runner-1:commit");
assert.equal(commit.payload.activity.content, "verbatim:stable");
assert.equal(commit.payload.activity.visibility, "internal");
assert.equal(commit.payload.sessionId, "11111111-2222-4333-8444-555555555555");
assert.equal(commit.payload.wakeRunId, "wake-runner-1");
assert.deepEqual(commit.payload.deliveryTargets, ["phone-runner"]);
console.log(JSON.stringify({ ok: true, claims: 1, commits: 1, stdout: stdout.trim() }));
