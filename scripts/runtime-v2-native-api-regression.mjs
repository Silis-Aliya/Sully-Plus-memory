import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-native-api-"));
const port = 18917;
const baseUrl = `http://127.0.0.1:${port}`;
const token = "native-api-regression-token";
let child;

async function call(pathname, options = {}, expected = 200, authenticated = true) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: { "Content-Type": "application/json", ...(authenticated ? { "X-Memory-Hub-Token": token } : {}), ...(options.headers || {}) },
  });
  const body = await response.json();
  assert.equal(response.status, expected, `${pathname}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForHub() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(baseUrl + "/api/health", { headers: { "X-Memory-Hub-Token": token } })).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Memory Hub did not start");
}

const command = {
  commandId: "native-api-command-0001",
  type: "runtime.message.commit",
  actorId: "phone-test",
  characterId: "char-native-api",
  worldId: null,
  issuedAt: "2026-08-05T18:00:00.000Z",
  protocolVersion: "1.0",
  payload: { message: { messageId: "native-api-message-0001", role: "user", content: "hello", surface: "chat", visibility: "user", occurredAt: "2026-08-05T18:00:00.000Z" }, deliveryTargets: ["phone-test"] },
};

try {
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, MEMORY_HUB_PORT: String(port), MEMORY_HUB_HOST: "127.0.0.1", MEMORY_HUB_DATA_DIR: tempDir, MEMORY_HUB_TOKEN: token, MEMORY_HUB_ACTION_RUNTIME_ENABLED: "false", MEMORY_HUB_RUNTIME_READ_MODE: "v2", MEMORY_HUB_RUNTIME_NATIVE_WRITES_ENABLED: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childError = "";
  child.stderr.on("data", (chunk) => { childError += chunk.toString("utf8"); });
  await waitForHub();

  await call("/api/v1/characters", { method: "POST", body: JSON.stringify({ data: { characterId: "char-native-api", name: "Native API Character" }, actorId: "api-operator" }) }, 201);

  const unauthorized = await call("/api/v1/runtime/commands", { method: "POST", body: JSON.stringify(command) }, 401, false);
  assert.equal(unauthorized.error, "Unauthorized");
  const gated = await call("/api/v1/runtime/commands", { method: "POST", body: JSON.stringify(command) }, 409);
  assert.equal(gated.code, "V2_AUTHORITY_NOT_PROMOTED");

  const prepared = await call("/api/runtime/v2/promotion/prepare", { method: "POST", body: JSON.stringify({ actorId: "api-operator" }) }, 201);
  assert.equal(prepared.promotion.status, "prepared");
  const promoted = await call("/api/runtime/v2/promotion/commit", { method: "POST", body: JSON.stringify({ actorId: "api-operator", promotionId: prepared.promotion.promotionId, parityHash: prepared.promotion.parityHash }) });
  assert.equal(promoted.authorityMode, "v2");

  const committed = await call("/api/v1/runtime/commands", { method: "POST", body: JSON.stringify(command) }, 201);
  assert.equal(committed.result.message.messageId, "native-api-message-0001");
  assert.equal(committed.result.deliveries.length, 1);
  const directVisible = await call("/api/runtime/messages?charId=char-native-api&surface=chat");
  assert.equal(directVisible.messages.some((item) => item.content === "hello"), true);
  const replay = await call("/v1/runtime/commands", { method: "POST", body: JSON.stringify(command) });
  assert.equal(replay.idempotentReplay, true);
  const eventBoxCommand = { ...command, commandId: "native-api-command-box-1", type: "memory.event_box.put", payload: { eventBox: { eventBoxId: "native-api-box-1", name: "API box", liveMemoryIds: [], archivedMemoryIds: [] } } };
  const eventBox = await call("/api/v1/runtime/commands", { method: "POST", body: JSON.stringify(eventBoxCommand) }, 201);
  assert.equal(eventBox.result.eventBox.eventBoxId, "native-api-box-1");
  const scheduleCommand = { ...command, commandId: "native-api-command-schedule-1", type: "schedule.job.put", payload: { job: { jobId: "native-api-job-1", jobType: "message.notify", dueAt: "2026-08-04T00:00:00.000Z", payload: { message: { content: "scheduled native message", role: "assistant" }, statePatch: { activity: { current: "check-in" } }, deliveryTargets: ["phone-test"] } } } };
  const scheduled = await call("/api/v1/runtime/commands", { method: "POST", body: JSON.stringify(scheduleCommand) }, 201);
  assert.equal(scheduled.result.job.status, "pending");
  const tick = await call("/api/v1/runtime/tick", { method: "POST", body: JSON.stringify({ limit: 10 }) });
  assert.equal(tick.claimed, 1);
  assert.equal(tick.results[0].status, "completed");
  assert.equal(tick.results[0].message.content, "scheduled native message");
  assert.equal(tick.results[0].deliveries.length, 1);
  const visibleMessages = await call("/api/runtime/messages?charId=char-native-api&surface=chat");
  assert.equal(visibleMessages.messages.some((item) => item.content === "scheduled native message"), true);
  const authorityStats = await call("/api/v1/authority/stats");
  assert.equal(authorityStats.runtime.messages, 0, "promoted scheduler must not write the legacy runtime_messages table");
  const wakeScheduleCommand = { ...command, commandId: "native-api-command-wake-1", type: "schedule.job.put", payload: { job: { jobId: "native-api-wake-job-1", jobType: "autonomy.wake", dueAt: "2026-08-04T01:00:00.000Z", payload: { reason: "free activity", deliveryTargets: ["cc:char-native-api"] } } } };
  await call("/api/v1/runtime/commands", { method: "POST", body: JSON.stringify(wakeScheduleCommand) }, 201);
  const wakeTick = await call("/api/v1/runtime/tick", { method: "POST", body: JSON.stringify({ limit: 10 }) });
  assert.equal(wakeTick.results[0].status, "wake-queued", JSON.stringify(wakeTick.results[0]));
  assert.equal(Number.isInteger(wakeTick.results[0].triggeredEventId), true);
  const claimedWake = await call("/api/v1/cc/wakes/claim", { method: "POST", body: JSON.stringify({ characterId: "char-native-api", sessionId: "cc-session-1", forceStable: true }) });
  assert.equal(claimedWake.wakeRun.status, "running");
  assert.equal(typeof claimedWake.context.stableContext, "string");
  assert.equal(Array.isArray(claimedWake.context.delta.messages), true);
  assert.equal(claimedWake.context.wake.jobType, "autonomy.wake");
  assert.deepEqual(claimedWake.context.deliveryTargets, ["cc:char-native-api"]);
  const wakeEvents = await call("/v1/events?after=0&characterId=char-native-api&limit=1000");
  const wakeEventTypes = wakeEvents.events.filter((event) => event.payload?.jobId === "native-api-wake-job-1").map((event) => event.type);
  assert.deepEqual(wakeEventTypes.slice(-2), ["schedule.triggered", "brain.wake.requested"]);
  const concurrentMessage = { ...command, commandId: "native-api-command-concurrent-1", type: "runtime.message.commit", payload: { message: { messageId: "native-api-concurrent-message-1", role: "user", content: "arrived while CC was working", surface: "chat", visibility: "user", occurredAt: "2026-08-05T18:30:00.000Z" } } };
  await call("/api/v1/runtime/commands", { method: "POST", body: JSON.stringify(concurrentMessage) }, 201);
  const activityCommand = { ...command, commandId: "native-api-command-activity-1", type: "runtime.activity.commit", payload: { activity: { activityId: "native-api-activity-1", content: "walked through the virtual studio" }, statePatch: { location: "virtual-studio" }, wakeRunId: claimedWake.wakeRun.wakeRunId, leaseToken: claimedWake.wakeRun.leaseToken, sessionId: "cc-session-1", deliveryTargets: ["phone-test"] } };
  const activity = await call("/api/v1/runtime/commands", { method: "POST", body: JSON.stringify(activityCommand) }, 201);
  assert.equal(activity.result.activity.content, "walked through the virtual studio");
  assert.equal(activity.result.state.state.location, "virtual-studio");
  assert.equal(activity.result.state.state.activity.name, "walked through the virtual studio");
  assert.equal(activity.result.state.state.lastActivity.summary, "walked through the virtual studio");
  const activityMessages = await call("/api/runtime/messages?charId=char-native-api&surface=activity&visibility=internal");
  assert.equal(activityMessages.messages.some((item) => item.content === "walked through the virtual studio"), true);
  const secondWakeSchedule = { ...command, commandId: "native-api-command-wake-2", type: "schedule.job.put", payload: { job: { jobId: "native-api-wake-job-2", jobType: "autonomy.wake", dueAt: "2026-08-04T02:00:00.000Z", payload: { reason: "cursor test" } } } };
  await call("/api/v1/runtime/commands", { method: "POST", body: JSON.stringify(secondWakeSchedule) }, 201);
  await call("/api/v1/runtime/tick", { method: "POST", body: JSON.stringify({ limit: 10 }) });
  const secondWake = await call("/api/v1/cc/wakes/claim", { method: "POST", body: JSON.stringify({ characterId: "char-native-api", sessionId: "cc-session-1" }) });
  assert.equal(secondWake.context.delta.messages.some((item) => item.content === "arrived while CC was working"), true, "messages arriving during a wake must remain in the next delta");
  const requeued = await call(`/api/v1/cc/wakes/${secondWake.wakeRun.wakeRunId}/fail`, { method: "POST", body: JSON.stringify({ leaseToken: secondWake.wakeRun.leaseToken, error: "simulated runner restart", retry: true }) });
  assert.equal(requeued.wakeRun.status, "queued");
  const reclaimed = await call("/api/v1/cc/wakes/claim", { method: "POST", body: JSON.stringify({ characterId: "char-native-api", sessionId: "cc-session-1" }) });
  assert.deepEqual(reclaimed.context, secondWake.context, "a retried wake must preserve its exact stable/delta context boundary");
  assert.equal(reclaimed.wakeRun.attemptCount, 2);
  const retryActivity = { ...command, commandId: "native-api-command-activity-retry-1", type: "runtime.activity.commit", payload: { activity: { activityId: "native-api-activity-retry-1", content: "resumed the interrupted activity" }, wakeRunId: reclaimed.wakeRun.wakeRunId, leaseToken: reclaimed.wakeRun.leaseToken, sessionId: "cc-session-1" } };
  const retryActivityResult = await call("/api/v1/runtime/commands", { method: "POST", body: JSON.stringify(retryActivity) }, 201);
  assert.equal(retryActivityResult.result.state.state.activity.name, "resumed the interrupted activity");
  const status = await call("/api/runtime/v2/read-status");
  assert.equal(status.authorityMode, "v2");
  assert.equal(status.effectiveMode, "v2");
  const rollback = await call("/api/runtime/v2/promotion/rollback", { method: "POST", body: JSON.stringify({ actorId: "api-operator", reason: "must be blocked after native write" }) }, 409);
  assert.equal(rollback.code, "V2_ROLLBACK_REQUIRES_RECONCILIATION");
  console.log(JSON.stringify({ ok: true, authorityGate: gated.code, messageId: committed.result.message.messageId, outbox: committed.result.deliveries.length }));
  if (childError) process.stderr.write(childError);
} finally {
  if (child && !child.killed) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
