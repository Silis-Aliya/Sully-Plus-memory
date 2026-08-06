import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthorityError, AuthorityStore } from "../authorityStore.mjs";
import { RuntimeV2NativeCommandExecutor } from "../src/storage/runtimeV2NativeCommandExecutor.mjs";
import { RuntimeV2ReadRepository } from "../src/storage/runtimeV2ReadRepository.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-native-command-"));
let store;
const command = (commandId, type, payload, extra = {}) => ({ commandId, type, actorId: "test-client", characterId: "char-1", issuedAt: "2026-08-05T00:00:00.000Z", protocolVersion: "1.0", payload, ...extra });
try {
  store = new AuthorityStore(path.join(tempDir, "authority.sqlite"));
  const executor = new RuntimeV2NativeCommandExecutor(store);
  assert.equal(store.runtimeV2.authorityMode(), "shadow");
  assert.equal(store.runtimeV2.setAuthorityMode("v2"), "v2");
  assert.equal(store.runtimeV2.authorityMode(), "v2");
  assert.throws(() => store.runtimeV2.setAuthorityMode("invalid"), (error) => error.code === "VALIDATION_FAILED");

  const messageCommand = command("command-message-1", "runtime.message.commit", { message: { messageId: "message-1", role: "user", content: "hello", surface: "chat", visibility: "user", occurredAt: "2026-08-05T00:00:01.000Z" }, deliveryTargets: ["phone-1"] });
  const message = executor.execute(messageCommand);
  assert.equal(message.command.status, "completed");
  assert.equal(message.result.message.messageId, "message-1");
  assert.equal(message.result.deliveries.length, 1);
  assert.equal(store.listCommandEvents(messageCommand.commandId).length, 2);
  assert.equal(executor.execute(messageCommand).idempotentReplay, true);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_messages").get().count), 1);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM runtime_messages").get().count), 0, "native command must not rewrite the legacy message table");
  const nativeReadable = new RuntimeV2ReadRepository(store.db).listMessages({ charId: "char-1" });
  assert.equal(nativeReadable[0].charId, "char-1");
  assert.equal(nativeReadable[0].sourceId, "message-1");
  assert.equal(Number.isFinite(nativeReadable[0].id), true);
  assert.throws(() => executor.execute({ ...messageCommand, payload: { message: { ...messageCommand.payload.message, content: "different" } } }), (error) => error instanceof AuthorityError && error.code === "IDEMPOTENCY_CONFLICT");

  const created = executor.execute(command("command-memory-1", "memory.node.put", { memory: { memoryId: "memory-1", room: "study", content: "first" } }, { expectedVersion: 0 }));
  assert.equal(created.result.memory.version, 1);
  const updated = executor.execute(command("command-memory-2", "memory.node.put", { memory: { memoryId: "memory-1", room: "study", content: "second" } }, { expectedVersion: 1 }));
  assert.equal(updated.result.memory.version, 2);
  const deleted = executor.execute(command("command-memory-3", "memory.node.delete", { memoryId: "memory-1" }, { expectedVersion: 2 }));
  assert.equal(deleted.result.memory.version, 3);
  assert.ok(deleted.result.memory.deletedAt);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM runtime_domains WHERE domain_key='hub:memories'").get().count), 0, "native command must not rewrite the legacy memory JSON");

  executor.execute(command("command-memory-4", "memory.node.put", { memory: { memoryId: "memory-2", room: "study", content: "second node" } }, { expectedVersion: 0 }));
  executor.execute(command("command-memory-5", "memory.node.put", { memory: { memoryId: "memory-3", room: "study", content: "third node" } }, { expectedVersion: 0 }));
  const vector1 = executor.execute(command("command-vector-1", "memory.vector.put", { vectorRecord: { memoryId: "memory-2", model: "test", vector: [0.25, 0.5] } }, { expectedVersion: 0 }));
  assert.equal(vector1.result.vector.version, 1);
  const vector2 = executor.execute(command("command-vector-2", "memory.vector.put", { vectorRecord: { memoryId: "memory-2", model: "test", vector: [0.5, 0.75] } }, { expectedVersion: 1 }));
  assert.equal(vector2.result.vector.version, 2);
  assert.equal(executor.execute(command("command-vector-3", "memory.vector.delete", { memoryId: "memory-2" }, { expectedVersion: 2 })).result.vector.version, 3);

  const link1 = executor.execute(command("command-link-1", "memory.link.put", { link: { linkId: "link-1", sourceMemoryId: "memory-2", targetMemoryId: "memory-3", linkType: "related", strength: 0.5 } }, { expectedVersion: 0 }));
  assert.equal(link1.result.link.version, 1);
  const link2 = executor.execute(command("command-link-2", "memory.link.put", { link: { linkId: "link-1", sourceMemoryId: "memory-2", targetMemoryId: "memory-3", linkType: "related", strength: 0.8 } }, { expectedVersion: 1 }));
  assert.equal(link2.result.link.version, 2);
  assert.equal(executor.execute(command("command-link-3", "memory.link.delete", { linkId: "link-1" }, { expectedVersion: 2 })).result.link.version, 3);

  const box1 = executor.execute(command("command-box-1", "memory.event_box.put", { eventBox: { eventBoxId: "box-1", name: "Box", liveMemoryIds: ["memory-2", "memory-3"], archivedMemoryIds: [] } }, { expectedVersion: 0 }));
  assert.equal(box1.result.eventBox.members.length, 2);
  const box2 = executor.execute(command("command-box-2", "memory.event_box.put", { eventBox: { eventBoxId: "box-1", name: "Box", liveMemoryIds: ["memory-3"], archivedMemoryIds: ["memory-2"] } }, { expectedVersion: 1 }));
  assert.equal(box2.result.eventBox.version, 2);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_event_box_members WHERE event_box_id='box-1' AND deleted_at IS NOT NULL").get().count), 1);
  assert.equal(executor.execute(command("command-box-3", "memory.event_box.delete", { eventBoxId: "box-1" }, { expectedVersion: 2 })).result.eventBox.version, 3);

  const plate1 = executor.execute(command("command-plate-1", "memory.room_plate.put", { roomPlate: { roomPlateId: "plate-1", room: "study", entries: [{ entryId: "entry-1", text: "one" }, { entryId: "entry-2", text: "two" }] } }, { expectedVersion: 0 }));
  assert.equal(plate1.result.roomPlate.entries.length, 2);
  const plate2 = executor.execute(command("command-plate-2", "memory.room_plate.put", { roomPlate: { roomPlateId: "plate-1", room: "study", entries: [{ entryId: "entry-2", text: "two updated" }] } }, { expectedVersion: 1 }));
  assert.equal(plate2.result.roomPlate.version, 2);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_room_plate_entries WHERE entry_id='entry-1' AND deleted_at IS NOT NULL").get().count), 1);
  assert.equal(executor.execute(command("command-plate-3", "memory.room_plate.delete", { roomPlateId: "plate-1" }, { expectedVersion: 2 })).result.roomPlate.version, 3);

  const anticipation1 = executor.execute(command("command-anticipation-1", "runtime.anticipation.put", { anticipation: { anticipationId: "anticipation-1", content: "waiting", status: "active" } }, { expectedVersion: 0 }));
  assert.equal(anticipation1.result.anticipation.version, 1);
  const anticipation2 = executor.execute(command("command-anticipation-2", "runtime.anticipation.put", { anticipation: { anticipationId: "anticipation-1", content: "waiting", status: "resolved", resolvedAt: "2026-08-05T01:00:00.000Z" } }, { expectedVersion: 1 }));
  assert.equal(anticipation2.result.anticipation.status, "resolved");
  assert.equal(executor.execute(command("command-anticipation-3", "runtime.anticipation.delete", { anticipationId: "anticipation-1" }, { expectedVersion: 2 })).result.anticipation.version, 3);

  const digest = executor.execute(command("command-digest-1", "memory.digest.put", { digestReport: { digestReportId: "digest-1", trigger: "threshold", examined: ["memory-2"], outcomes: ["kept"] } }, { expectedVersion: 0 }));
  assert.equal(digest.result.digestReport.version, 1);
  assert.equal(executor.execute(command("command-digest-2", "memory.digest.delete", { digestReportId: "digest-1" }, { expectedVersion: 1 })).result.digestReport.version, 2);

  const scheduled = executor.execute(command("command-schedule-1", "schedule.job.put", { job: { jobId: "job-1", jobType: "autonomy.wake", dueAt: "2026-08-06T00:00:00.000Z", payload: { reason: "test" } } }));
  assert.equal(scheduled.result.job.status, "pending");
  const cancelled = executor.execute(command("command-schedule-2", "schedule.job.cancel", { jobId: "job-1" }));
  assert.equal(cancelled.result.job.status, "cancelled");
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM runtime_domains WHERE domain_key IN ('hub:vectors','hub:links','hub:eventBoxes','hub:roomPlates','hub:anticipations','hub:digestReports')").get().count), 0, "native domain commands must not rewrite legacy JSON domains");

  const state1 = executor.execute(command("command-state-1", "character.state.patch", { patch: { mood: "calm", nested: { keep: 1, remove: 2 } } }, { expectedVersion: 0 }));
  assert.equal(state1.result.state.version, 1);
  const state2 = executor.execute(command("command-state-2", "character.state.patch", { patch: { nested: { keep: 3 } }, unset: ["nested.remove"] }, { expectedVersion: 1 }));
  assert.deepEqual(state2.result.state.state, { mood: "calm", nested: { keep: 3 } });
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_runtime_state_events").get().count), 2);

  assert.throws(() => executor.execute(command("command-state-conflict", "character.state.patch", { patch: { mood: "wrong" } }, { expectedVersion: 0 })), (error) => error instanceof AuthorityError && error.code === "VERSION_CONFLICT");
  assert.equal(store.getCommand("command-state-conflict").status, "failed");
  assert.deepEqual(store.runtimeV2.getCharacterState("char-1").state, { mood: "calm", nested: { keep: 3 } });

  console.log(JSON.stringify({ ok: true, commands: Number(store.db.prepare("SELECT COUNT(*) count FROM commands").get().count), events: Number(store.db.prepare("SELECT COUNT(*) count FROM events").get().count), outbox: Number(store.db.prepare("SELECT COUNT(*) count FROM outbox_deliveries").get().count) }));
} finally {
  try { store?.close(); } catch {}
  await fs.rm(tempDir, { recursive: true, force: true });
}
