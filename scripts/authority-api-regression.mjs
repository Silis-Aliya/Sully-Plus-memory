import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = path.join(root, ".authority-api-regression");
const port = 18909;
const baseUrl = `http://127.0.0.1:${port}`;
let child;

async function call(pathname, options = {}, expected = 200) {
  const response = await fetch(baseUrl + pathname, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const body = await response.json();
  assert.equal(response.status, expected, `${pathname}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForHub() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(baseUrl + "/api/health")).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Memory Hub did not start");
}

try {
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, MEMORY_HUB_PORT: String(port), MEMORY_HUB_HOST: "127.0.0.1", MEMORY_HUB_DATA_DIR: tempDir, MEMORY_HUB_TOKEN: "", MEMORY_HUB_ACTION_RUNTIME_ENABLED: "false", MEMORY_HUB_RUNTIME_READ_MODE: "legacy", MEMORY_HUB_RUNTIME_NATIVE_WRITES_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childError = "";
  child.stderr.on("data", (chunk) => { childError += chunk.toString("utf8"); });
  await waitForHub();

  const contracts = await call("/api/contracts");
  assert.equal(contracts.contract.schemas.length, 9);
  assert.equal(contracts.runtime.persistence.includes("sqlite"), true);

  const contextFixture = JSON.parse(await fs.readFile(path.join(root, "fixtures", "context-parity-p0.json"), "utf8"));
  const contextPreview = await call("/api/v1/context/preview", { method: "POST", body: JSON.stringify({ fixture: contextFixture }) });
  assert.deepEqual(contextPreview.activatedWorldbooks.map((item) => item.id), ["wb-before", "wb-after", "wb-author-top", "wb-author-bottom", "wb-depth", "wb-example-before", "wb-example-after"]);
  assert.equal(contextPreview.finalMessages[0].role, "system");
  assert.equal(contextPreview.finalMessages.at(-1).role, "system");
  assert.equal(contextPreview.stableSystemPrompt.includes("记忆宫殿召回"), false);
  assert.equal(contextPreview.volatileContext.includes("记忆宫殿召回"), true);
  const recalledPreview = await call("/api/v1/context/preview", {
    method: "POST",
    body: JSON.stringify({
      fixture: { ...contextFixture, recallResult: undefined },
      recallQuery: "灯塔 收音机",
      memoryState: {
        characters: [contextFixture.character],
        memories: [
          { id: "memory-radio", charId: "char-golden", room: "study", content: "上周一起修好了灯塔收音机。", importance: 9, createdAt: "2026-08-01T00:00:00.000Z" },
          { id: "memory-archived", charId: "char-golden", room: "study", content: "灯塔 收音机 的过期压缩片段。", importance: 10, archived: true, createdAt: "2026-08-02T00:00:00.000Z" },
          { id: "memory-unrelated", charId: "char-golden", room: "living_room", content: "买了苹果。", importance: 2, createdAt: "2026-08-01T00:00:00.000Z" }
        ],
        vectors: [], links: [],
        roomPlates: [{ id: "char-golden:user_room", charId: "char-golden", room: "user_room", entries: [{ id: "plate-1", text: "小雨会在暴雨前检查窗户。" }] }],
        eventBoxes: [], anticipations: [], impressions: [], feels: []
      }
    }),
  });
  assert.equal(recalledPreview.recallResult.candidates[0].id, "memory-radio");
  assert.equal(recalledPreview.recallResult.candidates.some((item) => item.id === "memory-archived"), false);
  assert.equal(recalledPreview.volatileContext.includes("上周一起修好了灯塔收音机"), true);
  assert.equal(recalledPreview.volatileContext.includes("[书房 · 工作学习、技能成长]"), true);
  assert.equal(recalledPreview.stableSystemPrompt.includes("### 底色认知 (Resident Knowledge)"), true);
  assert.equal(recalledPreview.stableSystemPrompt.includes("它们是你认知的底色，不是话题"), true);
  assert.equal(recalledPreview.stableSystemPrompt.includes("**关于小雨**\n- 小雨会在暴雨前检查窗户。"), true);
  assert.equal(recalledPreview.stateChanges.length, 1);
  assert.equal(recalledPreview.stateChanges[0].type, "memory_access");
  assert.equal(recalledPreview.stateChanges[0].memoryId, "memory-radio");

  const createdCharacter = await call("/api/v1/characters", {
    method: "POST",
    body: JSON.stringify({ data: { characterId: "char-api", name: "API Character", description: "test" }, actorId: "test" }),
  }, 201);
  assert.equal(createdCharacter.item.version, 1);

  const patchedCharacter = await call("/api/v1/characters/char-api", {
    method: "PATCH",
    body: JSON.stringify({ data: { worldview: "API World" }, expectedVersion: 1, actorId: "test" }),
  });
  assert.equal(patchedCharacter.item.version, 2);
  assert.equal(patchedCharacter.item.worldview, "API World");
  assert.equal(patchedCharacter.item._fieldVersions.worldview.version, 1);

  const conflict = await call("/api/v1/characters/char-api", {
    method: "PATCH",
    body: JSON.stringify({ data: { name: "stale" }, expectedVersion: 1 }),
  }, 409);
  assert.equal(conflict.code, "VERSION_CONFLICT");

  await call("/api/v1/worldbooks", {
    method: "POST",
    body: JSON.stringify({ data: { worldbookId: "wb-api", title: "Book", content: "Rule" } }),
  }, 201);
  await call("/api/v1/characters/char-api/worldbooks/wb-api", { method: "POST", body: "{}" });
  const mounts = await call("/api/v1/characters/char-api/worldbooks");
  assert.equal(mounts.items.length, 1);

  const backup = {
    characters: [{ id: "char-migrated", name: "Migrated", scheduleFeatureEnabled: true, scheduleStyle: "lifestyle", memories: [{ id: "legacy-api", summary: "old" }] }],
    userProfile: { name: "User" },
    worldbooks: [],
    worlds: [{ id: "world-api", name: "World" }],
    messages: [{ id: 1, charId: "char-migrated", role: "user", content: "hello" }],
    memoryNodes: [{ id: "memory-api", charId: "char-migrated", content: "memory" }],
    dailySchedules: [{
      id: "char-migrated_2026-08-05",
      charId: "char-migrated",
      date: "2026-08-05",
      generatedAt: Date.parse("2026-08-05T07:00:00.000Z"),
      slots: [
        { startTime: "08:00", activity: "painting", location: "studio", innerThought: "The unfinished colors are still on my mind." },
        { startTime: "12:00", activity: "lunch", location: "kitchen" },
      ],
    }],
  };
  const preview = await call("/api/v1/migrations/sully/preview", { method: "POST", body: JSON.stringify({ backup }) });
  assert.equal(preview.report.sourceCounts.characters, 1);
  const imported = await call("/api/v1/migrations/sully/import", { method: "POST", body: JSON.stringify({ backup, actorId: "test" }) }, 201);
  assert.equal(imported.report.importedCounts.message, 1);
  assert.equal(imported.report.importedCounts.memory_node, 1);

  const commandPayload = { commandId: "api-command-0001", type: "chat.turn.submit", actorId: "api-client", characterId: "char-migrated", worldId: null, issuedAt: "2026-08-04T04:00:00.000Z", protocolVersion: "1.0", payload: { text: "hello" } };
  const acceptedCommand = await call("/v1/commands", { method: "POST", body: JSON.stringify(commandPayload) }, 202);
  assert.equal(acceptedCommand.command.status, "accepted");
  assert.equal(acceptedCommand.events[0].type, "command.accepted");
  const replayedCommand = await call("/api/v1/commands", { method: "POST", body: JSON.stringify(commandPayload) });
  assert.equal(replayedCommand.idempotentReplay, true);
  const eventPage = await call("/v1/events?after=0&clientId=api-client&characterId=char-migrated");
  assert.equal(eventPage.events.some((item) => item.commandId === "api-command-0001"), true);
  assert.equal(eventPage.cursor.lastEventId, eventPage.lastEventId);
  const snapshotResponse = await call("/v1/characters/char-migrated/snapshot");
  assert.equal(snapshotResponse.snapshot.characterId, "char-migrated");
  assert.equal(snapshotResponse.snapshot.snapshotVersion, 1);

  const scheduled = await call("/v1/scheduled-jobs", {
    method: "POST",
    body: JSON.stringify({ jobId: "job-api-0001", characterId: "char-migrated", jobType: "character.action", dueAt: "2020-01-01T00:00:00.000Z", payload: { statePatch: { mood: "calm", activity: { name: "writing" } }, message: { content: "A scheduled hello" } } }),
  }, 201);
  assert.equal(scheduled.job.status, "pending");
  const tick = await call("/v1/runtime/tick", { method: "POST", body: JSON.stringify({ limit: 10 }) });
  assert.equal(tick.claimed, 1);
  assert.equal(tick.results[0].status, "completed");
  const completedJob = await call("/v1/scheduled-jobs/job-api-0001");
  assert.equal(completedJob.job.status, "completed");
  const actionSnapshot = await call("/v1/characters/char-migrated/snapshot");
  assert.equal(actionSnapshot.snapshot.snapshotVersion, 2);
  assert.equal(actionSnapshot.snapshot.state.mood, "calm");
  assert.equal(actionSnapshot.snapshot.state.activity.name, "writing");
  assert.equal(actionSnapshot.snapshot.recentMessages.at(-1).content, "A scheduled hello");

  await call("/api/runtime/messages", {
    method: "POST",
    body: JSON.stringify({
      charId: "char-migrated",
      autoProcess: false,
      digestMode: "none",
      messages: [{ sourceId: "activity-api-0001", role: "system", type: "activity", content: "Character paints alone in the studio", timestamp: 1785900000000, surface: "activity", visibility: "internal", origin: "character-runtime" }],
    }),
  });
  const isolatedChatMessages = await call("/api/runtime/messages?charId=char-migrated&surface=chat&visibility=user&limit=100");
  const isolatedActivityMessages = await call("/api/runtime/messages?charId=char-migrated&surface=activity&visibility=internal&limit=100");
  assert.equal(isolatedChatMessages.messages.some((item) => item.sourceId === "activity-api-0001"), false);
  assert.equal(isolatedActivityMessages.messages.some((item) => item.sourceId === "activity-api-0001"), true);
  assert.equal(isolatedActivityMessages.messages[0].conversationId, null);
  assert.equal(isolatedChatMessages.surfaceCounts.activity, 1);
  const isolatedContext = await call("/api/v1/context/assemble", { method: "POST", body: JSON.stringify({ characterId: "char-migrated", now: "2026-08-05T10:30:00.000Z" }) });
  assert.equal(isolatedContext.finalMessages.filter((item) => item.role !== "system").some((item) => String(item.content || "").includes("Character paints alone in the studio")), false);
  assert.equal(isolatedContext.volatileContext.includes("Character paints alone in the studio"), true);
  assert.equal(isolatedContext.runtimeState.scheduleInjection.includes("当前时段：08:00 你正在Character paints alone in the studio（studio）"), true);
  assert.equal(isolatedContext.runtimeState.scheduleInjection.includes("之后安排：12:00 lunch"), true);
  assert.equal(isolatedContext.runtimeState.scheduleInjection.includes("（不是台词，不用说出口——让它影响你的语气和情绪就好。）"), true);
  assert.equal(isolatedContext.volatileContext.includes(isolatedContext.runtimeState.scheduleInjection), true);
  const isolatedSnapshot = await call("/v1/characters/char-migrated/snapshot");
  assert.equal(isolatedSnapshot.snapshot.recentMessages.some((item) => item.sourceId === "activity-api-0001"), false);
  const scheduleEvents = await call("/v1/events?after=0&characterId=char-migrated&surface=schedule&visibility=internal&limit=100");
  const chatEvents = await call("/v1/events?after=0&characterId=char-migrated&surface=chat&visibility=user&limit=100");
  assert.equal(scheduleEvents.events.some((item) => item.type === "schedule.triggered"), true);
  assert.equal(scheduleEvents.events.some((item) => item.type.startsWith("message.")), false);
  assert.equal(chatEvents.events.some((item) => item.type === "message.proactive.created"), true);
  assert.equal(chatEvents.events.some((item) => item.type.startsWith("schedule.")), false);

  const outbox = await call("/v1/outbox?clientId=delivery-client&after=0&limit=100");
  assert.equal(outbox.deliveries.some((item) => item.event.type === "schedule.triggered"), true);
  assert.equal(outbox.deliveries.some((item) => item.event.type === "message.proactive.created"), true);
  const ackTarget = outbox.deliveries[0];
  const acked = await call(`/v1/outbox/${encodeURIComponent(ackTarget.deliveryId)}/ack`, { method: "POST", body: JSON.stringify({ clientId: "delivery-client" }) });
  assert.equal(acked.delivery.status, "delivered");
  const retryTarget = outbox.deliveries[1];
  const retried = await call(`/v1/outbox/${encodeURIComponent(retryTarget.deliveryId)}/retry`, { method: "POST", body: JSON.stringify({ clientId: "delivery-client", error: "temporary network failure" }) });
  assert.equal(retried.delivery.status, "retry");

  await call("/v1/scheduled-jobs", { method: "POST", body: JSON.stringify({ jobId: "job-api-cancel", characterId: "char-migrated", jobType: "state.patch", dueAt: "2030-01-01T00:00:00.000Z", payload: { patch: { mood: "future" } } }) }, 201);
  const cancelled = await call("/v1/scheduled-jobs/job-api-cancel", { method: "DELETE" });
  assert.equal(cancelled.job.status, "cancelled");

  const stats = await call("/api/v1/authority/stats");
  assert.equal(stats.entities.character.count, 2);
  assert.equal(stats.runtime.messages, 3);
  assert.equal(stats.archives.message || 0, 0);
  const persistedRecall = await call("/api/recall", { method: "POST", body: JSON.stringify({ charId: "char-migrated", query: "memory", now: 1785760440000 }) });
  assert.equal(persistedRecall.statePersisted, true);
  assert.equal(persistedRecall.stateChanges.some((item) => item.type === "memory_access" && item.memoryId === "memory-api"), true);
  const statsAfterRecall = await call("/api/v1/authority/stats");
  assert.equal(statsAfterRecall.recallState.accessedMemories, 1);
  const audit = await call("/api/v1/audit?limit=100");
  assert.equal(audit.items.some((item) => item.action === "migration"), true);

  const deleted = await call("/api/v1/characters/char-api", { method: "DELETE", body: JSON.stringify({ expectedVersion: 2, actorId: "test" }) });
  assert.equal(Boolean(deleted.tombstone.deletedAt), true);

  console.log(JSON.stringify({ ok: true, migrations: stats.migrations, audits: audit.items.length }));
  if (childError) process.stderr.write(childError);
} finally {
  if (child && !child.killed) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}
