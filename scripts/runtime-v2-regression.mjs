import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentHash } from "../authorityStore.mjs";
import { RuntimeV2Migrator } from "../src/storage/runtimeV2Migrator.mjs";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "sully-hub-v2-"));
const databaseFile = path.join(tempDir, "authority.sqlite");

const domains = {
  memories: [
    { id: "memory-1", charId: "char-1", room: "study", content: "一起修好收音机", importance: 8, mood: "warm", tags: ["收音机"], createdAt: 1785900000000, occurredAt: "1785900000000", embedded: true },
    { id: "memory-2", charId: "char-1", room: "living_room", content: "约好下次再检查", importance: 5, mood: "calm", tags: ["约定"], createdAt: 1785900100000 },
  ],
  vectors: [
    { memoryId: "memory-1", charId: "char-1", model: "fixture", dimensions: 3, vector: [0.1, 0.2, 0.3], updatedAt: 1785900200000 },
    { memoryId: "memory-2", charId: "char-1", model: "fixture", dimensions: 3, embedding: [0.4, 0.5, 0.6], updatedAt: 1785900200000 },
  ],
  links: [{ id: "link-1", charId: "char-1", sourceId: "memory-1", targetId: "memory-2", type: "temporal", strength: 0.4 }],
  eventBoxes: [{ id: "box-1", charId: "char-1", name: "收音机", tags: ["维修"], summaryNodeId: "memory-1", liveMemoryIds: ["memory-2"], archivedMemoryIds: [], createdAt: 1785900000000, updatedAt: 1785900200000 }],
  roomPlates: [{ id: "char-1:study", charId: "char-1", room: "study", version: 2, updatedAt: 1785900200000, entries: [{ id: "plate-entry-1", text: "会修收音机", tag: "技能", sourceCount: 2, updatedAt: 1785900200000 }] }],
  anticipations: [{ id: "ant-1", charId: "char-1", content: "想再听一次", status: "active", createdAt: 1785900200000 }],
  digestReports: [{ id: "digest-1", charId: "char-1", trigger: "fixture", createdAt: 1785900200000, examined: [], outcomes: [], plateSubmissions: [], plateUpdated: ["study"] }],
};

try {
  const db = new DatabaseSync(databaseFile);
  db.exec(`
    CREATE TABLE runtime_domains(domain_key TEXT PRIMARY KEY,version INTEGER NOT NULL,data_json TEXT NOT NULL,content_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE runtime_messages(char_id TEXT NOT NULL,message_id TEXT NOT NULL,sequence_no INTEGER NOT NULL,data_json TEXT NOT NULL,content_hash TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(char_id,message_id));
  `);
  const insertDomain = db.prepare("INSERT INTO runtime_domains(domain_key,version,data_json,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)");
  for (const [name, items] of Object.entries(domains)) insertDomain.run(`hub:${name}`, 1, JSON.stringify(items), contentHash(items), new Date().toISOString(), new Date().toISOString());
  const message = { id: 1, charId: "char-1", sourceId: "local-1", role: "user", type: "text", content: "今晚检查收音机", timestamp: 1785900300000, surface: "chat", visibility: "user", conversationId: "direct:me:char-1", origin: "user", metadata: { fixture: true } };
  db.prepare("INSERT INTO runtime_messages(char_id,message_id,sequence_no,data_json,content_hash,updated_at) VALUES(?,?,?,?,?,?)")
    .run("char-1", "local-1", 1, JSON.stringify(message), contentHash(message), new Date().toISOString());
  const sourceHashesBefore = Object.fromEntries(db.prepare("SELECT domain_key,content_hash FROM runtime_domains ORDER BY domain_key").all().map((row) => [row.domain_key, row.content_hash]));
  db.close();

  const migrator = new RuntimeV2Migrator(databaseFile, { batchSize: 1 });
  const before = migrator.validate();
  assert.equal(before.schemaInstalled, false);
  assert.equal(before.sourceCounts.memories, 2);
  assert.equal(before.targetCounts.memories, 0);

  const first = migrator.apply();
  assert.deepEqual(first.migrated, { messages: 1, messageSequences: 0, messageRawParity: 0, vectorShapes: 0, memories: 2, vectors: 2, links: 1, eventBoxes: 1, roomPlates: 1, anticipations: 1, digestReports: 1, characterRuntime: 0, sourceOrder: 9 });
  assert.equal(first.validation.ok, true);
  assert.deepEqual(first.validation.countDifferences, {});
  assert.deepEqual(first.validation.integrity, { vectorsWithoutMemory: 0, linksWithoutSource: 0, linksWithoutTarget: 0, eventMembersWithoutMemory: 0, invalidVectorBytes: 0 });
  assert.deepEqual(first.validation.missingReferences, { vectors: [], linkSources: [], linkTargets: [], eventBoxMembers: [] });

  const check = new DatabaseSync(databaseFile, { readOnly: true });
  assert.equal(Number(check.prepare("SELECT length(vector_blob) AS bytes FROM v2_memory_vectors WHERE memory_id='memory-1'").get().bytes), 12);
  assert.equal(check.prepare("SELECT occurred_at FROM v2_memory_nodes WHERE memory_id='memory-1'").get().occurred_at, new Date(1785900000000).toISOString());
  assert.equal(Number(check.prepare("SELECT COUNT(*) AS count FROM v2_event_box_members").get().count), 2);
  assert.equal(Number(check.prepare("SELECT COUNT(*) AS count FROM v2_room_plate_entries").get().count), 1);
  const sourceHashesAfter = Object.fromEntries(check.prepare("SELECT domain_key,content_hash FROM runtime_domains ORDER BY domain_key").all().map((row) => [row.domain_key, row.content_hash]));
  assert.deepEqual(sourceHashesAfter, sourceHashesBefore, "V2 migration must not rewrite legacy runtime domains");
  check.close();

  const second = migrator.apply();
  assert.deepEqual(second.migrated, { messages: 0, messageSequences: 0, messageRawParity: 0, vectorShapes: 0, memories: 0, vectors: 0, links: 0, eventBoxes: 0, roomPlates: 0, anticipations: 0, digestReports: 0, characterRuntime: 0, sourceOrder: 0 });
  assert.equal(second.validation.ok, true);
  console.log(JSON.stringify({ ok: true, databaseFile, migrated: first.migrated, validation: second.validation.integrity }));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
