import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthorityError, AuthorityStore } from "../authorityStore.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-authority-"));
let store;
try {
  store = new AuthorityStore(path.join(tempDir, "authority.sqlite"));

  const char = store.transaction(() => store.putEntity("character", "char-1", { characterId: "char-1", name: "Sully" }, { actorId: "test" }));
  assert.equal(char.version, 1);
  assert.equal(store.getEntity("character", "char-1").data.name, "Sully");

  const updated = store.transaction(() => store.patchEntity("character", "char-1", { worldview: "London" }, { expectedVersion: 1, actorId: "test" }));
  assert.equal(updated.version, 2);
  assert.equal(updated.data.worldview, "London");
  assert.equal(store.fieldVersions("character", "char-1").worldview.version, 1);
  assert.equal(store.fieldVersions("character", "char-1").name.version, 1);
  assert.throws(
    () => store.transaction(() => store.patchEntity("character", "char-1", { name: "old" }, { expectedVersion: 1 })),
    (error) => error instanceof AuthorityError && error.code === "VERSION_CONFLICT",
  );

  store.transaction(() => store.putEntity("worldbook", "wb-1", { worldbookId: "wb-1", title: "City", content: "Rain" }, { actorId: "test" }));
  const mount = store.transaction(() => store.mountWorldbook("char-1", "wb-1", { actorId: "test" }));
  assert.equal(mount.version, 1);
  assert.equal(store.listMounts("char-1").length, 1);

  const fixture = {
    timestamp: Date.now(),
    version: 2,
    characters: [{
      id: "char-2",
      name: "Nova",
      systemPrompt: "Stay Nova",
      memories: [{ id: "legacy-1", date: "2026-08-01", summary: "Met" }],
      refinedMemories: { "2026-08": "A month" },
      impression: { summary: "Trust" },
      activeMsg2Config: { enabled: true },
      mountedWorldbooks: [{ id: "wb-embedded", title: "Embedded", content: "Rule" }],
    }],
    userProfile: { name: "User", bio: "Bio" },
    worldbooks: [],
    worlds: [{ id: "world-1", name: "Home" }],
    messages: [
      { id: 1, charId: "char-2", role: "user", content: "Hi" },
      { id: 2, charId: "missing-char", role: "user", content: "Orphan" },
    ],
    memoryNodes: [{ id: "mem-1", charId: "char-2", content: "Memory" }],
    memoryVectors: [{ memoryId: "mem-1", charId: "char-2", vector: [0.1, 0.2] }],
    scheduledMessages: [{ id: "schedule-1", charId: "char-2", content: "Later" }],
    theme: { name: "unsupported UI field" },
  };
  const preview = store.analyzeMigration(fixture);
  assert.equal(preview.sourceCounts.characters, 1);
  assert.equal(preview.sourceCounts.legacyFragments, 1);
  assert.equal(preview.unsupportedFields.includes("theme"), true);
  assert.equal(preview.missingReferences.some((item) => item.targetId === "missing-char"), true);

  const report = store.importSullyBackup(fixture, { actorId: "test" });
  assert.equal(report.status, "completed");
  assert.equal(report.importedCounts.characters, 1);
  assert.equal(report.importedCounts.message, 2);
  assert.equal(report.importedCounts.memory_node, 1);
  assert.equal(report.importedCounts.legacy_fragment, 1);
  assert.equal(report.importedCounts.impression, 1);
  assert.equal(report.importedCounts.active_behavior_config, 1);
  assert.equal(store.getEntity("worldbook", "wb-embedded").data.title, "Embedded");
  assert.equal(store.listMounts("char-2").length, 1);
  assert.equal(store.listMigrations().length, 1);
  assert.equal(store.listAudit({ type: "migration" }).length, 1);
  const repeated = store.importSullyBackup(fixture, { actorId: "test" });
  assert.equal(repeated.skippedCounts.charactersUnchanged, 1);
  assert.equal(repeated.skippedCounts.messageUnchanged, 2);
  assert.equal(store.getEntity("character", "char-2").version, 1);

  const tombstone = store.transaction(() => store.deleteEntity("world", "world-1", { expectedVersion: 1, actorId: "test" }));
  assert.equal(Boolean(tombstone.deletedAt), true);
  assert.equal(store.getEntity("world", "world-1"), null);
  assert.equal(store.getEntity("world", "world-1", { includeDeleted: true }).version, 2);

  const predictedRecall = store.recordRecallState(["mem-a", "mem-b"], "char-2", 1785760440000, { persist: false });
  assert.equal(predictedRecall.persisted, false);
  assert.equal(predictedRecall.changes.filter((item) => item.type === "memory_access").length, 2);
  assert.equal(predictedRecall.changes.filter((item) => item.type === "coactivation").length, 1);
  assert.deepEqual(store.recallRuntimeStats(), { accessedMemories: 0, coactivations: 0 });
  const firstRecall = store.recordRecallState(["mem-a", "mem-b"], "char-2", 1785760440000);
  assert.equal(firstRecall.changes.find((item) => item.type === "coactivation").after.strength, 0.05);
  const secondRecall = store.recordRecallState(["mem-a", "mem-b"], "char-2", 1785760500000);
  assert.equal(secondRecall.changes.find((item) => item.type === "coactivation").after.strength, 0.1);
  assert.deepEqual(store.recallRuntimeStats(), { accessedMemories: 2, coactivations: 1 });

  const commandInput = { commandId: "command-test-0001", type: "chat.turn.submit", actorId: "client-test", characterId: "char-2", worldId: null, issuedAt: "2026-08-04T04:00:00.000Z", protocolVersion: "1.0", payload: { text: "hello" } };
  const commandCreated = store.transaction(() => store.createCommand(commandInput));
  assert.equal(commandCreated.created, true);
  assert.equal(store.transaction(() => store.createCommand(commandInput)).created, false);
  assert.throws(() => store.transaction(() => store.createCommand({ ...commandInput, payload: { text: "changed" } })), (error) => error instanceof AuthorityError && error.code === "IDEMPOTENCY_CONFLICT");
  const commandEvent = store.appendEvent({ commandId: commandInput.commandId, type: "command.accepted", characterId: "char-2", protocolVersion: "1.0", payload: {} });
  assert.equal(commandEvent.eventId, 1);
  const snapshot = store.putSnapshot("char-2", { lastEventId: commandEvent.eventId, protocolVersion: "1.0", character: { id: "char-2" }, user: null, world: null, state: {}, recentMessages: [] });
  assert.equal(snapshot.snapshotVersion, 1);
  assert.equal(store.listEvents({ after: 0 }).length, 1);
  assert.equal(Number(store.advanceClientCursor("client-test", 1).last_event_id), 1);

  console.log(JSON.stringify({ ok: true, entities: store.stats().entities, migrationId: report.migrationId }));
} finally {
  store?.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}
