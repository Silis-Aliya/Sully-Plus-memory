import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeRuntime, assembleWakeInput, buildCharacterClaudeMd } from "./src/cc/claudeCodeRuntime.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const hubUrl = String(process.env.MEMORY_HUB_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = String(process.env.MEMORY_HUB_TOKEN || "");
const characterId = String(process.env.CC_RUNNER_CHARACTER_ID || "").trim();
const pollMs = Math.max(1_000, Number(process.env.CC_RUNNER_POLL_MS) || 10_000);
const leaseMs = Math.max(60_000, Number(process.env.CC_RUNNER_LEASE_MS) || 20 * 60_000);
const maxAttempts = Math.max(1, Number(process.env.CC_RUNNER_MAX_ATTEMPTS) || 3);
const command = String(process.env.CC_RUNNER_CLAUDE_COMMAND || "claude");
const commandArgsPrefix = String(process.env.CC_RUNNER_CLAUDE_PREFIX_ARGS || "").split("\n").map((value) => value.trim()).filter(Boolean);
const model = String(process.env.CC_RUNNER_CLAUDE_MODEL || "");
const permissionMode = String(process.env.CC_RUNNER_PERMISSION_MODE || "default");
const extraArgs = String(process.env.CC_RUNNER_CLAUDE_ARGS || "").split("\n").map((value) => value.trim()).filter(Boolean);
const workspaceBase = path.resolve(process.env.CC_RUNNER_WORKSPACE || path.join(root, ".memory-hub", "cc-characters"));
const stateDir = path.resolve(process.env.CC_RUNNER_STATE_DIR || path.join(root, ".memory-hub", "cc-runner"));
const runtimes = new Map();
const once = /^(?:1|true|yes)$/i.test(String(process.env.CC_RUNNER_ONCE || ""));
let stopping = false;

if (!token) throw new Error("MEMORY_HUB_TOKEN is required by the CC runner");

async function hub(route, { method = "GET", body } = {}) {
  const response = await fetch(`${hubUrl}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${payload.code || `HTTP_${response.status}`}: ${payload.error || response.statusText}`);
  return payload;
}

async function ensureMcpConfig() {
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, "memory-hub.mcp.json");
  const config = { mcpServers: { sully_memory_hub: { command: process.execPath, args: [path.join(root, "mcp-server.mjs")] } } };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await chmod(file, 0o600); } catch {}
  return file;
}

function characterDirectoryName(characterId) {
  const normalized = String(characterId || "").normalize("NFKC");
  const readable = normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 64) || "character";
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${readable}-${suffix}`;
}

async function ensureCharacterWorkspace(characterId, context) {
  const characterRoot = path.join(workspaceBase, characterDirectoryName(characterId));
  const workDir = path.join(characterRoot, "workspace");
  const claudeMdPath = path.join(characterRoot, "CLAUDE.md");
  await mkdir(workDir, { recursive: true });
  const stableContext = typeof context?.stableContext === "string" ? context.stableContext.trim() : "";
  let current = "";
  try { current = await readFile(claudeMdPath, "utf8"); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!stableContext && !current) throw new Error(`Hub did not provide stable context for new character workspace ${characterId}`);
  if (stableContext) {
    const next = buildCharacterClaudeMd(stableContext);
    if (current !== next) {
      await writeFile(claudeMdPath, next, { encoding: "utf8", mode: 0o600 });
      try { await chmod(claudeMdPath, 0o600); } catch {}
      current = next;
    }
  }
  return { characterRoot, workDir, claudeMdPath, stableContextHash: String(context?.stableContextHash || createHash("sha256").update(current).digest("hex")), stableContextVersion: Number(context?.stableContextVersion || 0) };
}

async function runtimeFor(id, sessionId, mcpConfig, context) {
  const workspace = await ensureCharacterWorkspace(id, context);
  let entry = runtimes.get(id);
  const stableChanged = entry && (entry.stableContextHash !== workspace.stableContextHash || entry.stableContextVersion !== workspace.stableContextVersion);
  if (entry && (!entry.runtime.isAlive || stableChanged)) {
    entry.runtime.close();
    runtimes.delete(id);
    entry = null;
  }
  if (!entry) {
    const runtime = new ClaudeCodeRuntime({ command, commandArgsPrefix, cwd: workspace.workDir, env: process.env, model, permissionMode, extraArgs, mcpConfig, turnTimeoutMs: Math.max(60_000, leaseMs - 15_000) });
    await runtime.connect(sessionId);
    entry = { runtime, ...workspace };
    runtimes.set(id, entry);
  }
  return entry.runtime;
}

async function failWake(wakeRun, error) {
  const retry = Number(wakeRun.attemptCount || 0) < maxAttempts;
  await hub(`/api/v1/cc/wakes/${encodeURIComponent(wakeRun.wakeRunId)}/fail`, { method: "POST", body: { leaseToken: wakeRun.leaseToken, error: String(error?.stack || error).slice(0, 12000), retry } });
  process.stderr.write(`[cc-runner] wake ${wakeRun.wakeRunId} ${retry ? "requeued" : "failed"}: ${error.message}\n`);
}

async function processWake(wakeRun, context, mcpConfig) {
  try {
    const runtime = await runtimeFor(wakeRun.characterId, context.sessionId || wakeRun.sessionId || "", mcpConfig, context);
    const result = await runtime.turn(assembleWakeInput(context));
    if (!result.text) throw new Error("Claude Code completed without an activity result");
    const commandId = `cc-wake:${wakeRun.wakeRunId}:commit`;
    await hub("/api/v1/runtime/commands", { method: "POST", body: { commandId, idempotencyKey: commandId, protocolVersion: "1.0", type: "runtime.activity.commit", characterId: wakeRun.characterId, payload: { activity: { activityId: `cc-activity:${wakeRun.wakeRunId}`, content: result.text, occurredAt: new Date().toISOString(), visibility: "internal" }, wakeRunId: wakeRun.wakeRunId, leaseToken: wakeRun.leaseToken, sessionId: result.sessionId || context.sessionId || null, deliveryTargets: Array.isArray(context.deliveryTargets) ? context.deliveryTargets : [] } } });
    process.stdout.write(`[cc-runner] completed wake=${wakeRun.wakeRunId} character=${wakeRun.characterId} session=${result.sessionId || "unknown"}\n`);
  } catch (error) {
    const entry = runtimes.get(wakeRun.characterId);
    entry?.runtime.close();
    runtimes.delete(wakeRun.characterId);
    await failWake(wakeRun, error);
  }
}

async function main() {
  const mcpConfig = await ensureMcpConfig();
  process.stdout.write(`[cc-runner] ready hub=${hubUrl} character=${characterId || "*"}\n`);
  while (!stopping) {
    try {
      const claimed = await hub("/api/v1/cc/wakes/claim", { method: "POST", body: { characterId, leaseMs, forceStable: true } });
      if (claimed.wakeRun) await processWake(claimed.wakeRun, claimed.context, mcpConfig);
      if (once) break;
      else await new Promise((resolve) => setTimeout(resolve, pollMs));
    } catch (error) {
      process.stderr.write(`[cc-runner] poll failed: ${error.message}\n`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  for (const entry of runtimes.values()) entry.runtime.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
await main();
