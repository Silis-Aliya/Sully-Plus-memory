import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthorityStore } from "../authorityStore.mjs";
import { RuntimeV2Parity } from "../src/storage/runtimeV2Parity.mjs";
import { RuntimeV2ReadRepository } from "../src/storage/runtimeV2ReadRepository.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-parity-"));
const databaseFile = path.join(tempDir, "authority.sqlite");
let store;
try {
  store = new AuthorityStore(databaseFile);
  const memories = [
    { id: "memory-1", charId: "char-1", room: "study", content: "one", createdAt: 1785900000000 },
    { id: "memory-2", charId: "char-1", room: "study", content: "two", createdAt: 1785900001000 },
  ];
  const vectors = [
    { memoryId: "memory-1", charId: "char-1", dimensions: 3, vector: [0.1, 0.2, 0.3] },
    { memoryId: "memory-2", charId: "char-1", embedding: [0.4, 0.5, 0.6] },
  ];
  const messages = [
    { id: 1, charId: "char-1", role: "user", content: "hello", timestamp: 1785900002000, surface: "chat", visibility: "user" },
    { id: 2, charId: "char-1", role: "assistant", content: "hi", timestamp: 1785900003000, surface: "chat", visibility: "user" },
  ];
  store.transaction(() => {
    store.putRuntimeDomain("hub:memories", memories);
    store.putRuntimeDomain("hub:vectors", vectors);
    store.putRuntimeDomain("hub:links", [{ id: "link-1", sourceId: "memory-1", targetId: "memory-2", type: "related" }]);
    store.putRuntimeDomain("hub:eventBoxes", []);
    store.putRuntimeDomain("hub:roomPlates", []);
    store.putRuntimeDomain("hub:anticipations", []);
    store.putRuntimeDomain("hub:digestReports", []);
    store.putRuntimeDomain("hub:characterRuntime", { "char-1": { mood: "calm" } });
    store.replaceRuntimeMessages(messages);
  });

  const first = new RuntimeV2Parity(databaseFile).run();
  assert.equal(first.summary.ok, true);
  assert.deepEqual(new RuntimeV2ReadRepository(store.db).listMessages().map((item) => item.id), [1, 2]);
  assert.deepEqual(new RuntimeV2ReadRepository(store.db).getDomain("memories").map((item) => item.id), ["memory-1", "memory-2"]);
  const readVectors = new RuntimeV2ReadRepository(store.db).getDomain("vectors");
  const readVector = readVectors[0];
  assert.equal(readVector.dimensions, 3);
  assert.ok(Math.abs(readVector.vector[0] - 0.1) < 1e-6);
  assert.equal(Object.hasOwn(readVectors[1], "dimensions"), false);
  assert.ok(Math.abs(readVectors[1].embedding[0] - 0.4) < 1e-6);

  store.db.prepare("UPDATE v2_source_order SET ordinal=99 WHERE domain_key='hub:memories' AND object_id='memory-1'").run();
  assert.equal(new RuntimeV2Parity(databaseFile).run().domains.memories.orderMismatches, 1);
  store.db.prepare("UPDATE v2_shadow_domains SET status='failed' WHERE domain_key='hub:memories'").run();
  store.transaction(() => store.putRuntimeDomain("hub:memories", memories));
  assert.equal(new RuntimeV2Parity(databaseFile).run().domains.memories.orderMismatches, 0);

  store.db.prepare("UPDATE v2_memory_nodes SET raw_json=?,content_hash='corrupt' WHERE memory_id='memory-1'").run(JSON.stringify({ ...memories[0], content: "corrupt" }));
  const corrupt = new RuntimeV2Parity(databaseFile).run();
  assert.equal(corrupt.domains.memories.fieldMismatches, 1);
  assert.ok(corrupt.domains.memories.samples[0].paths.includes("$.content"));

  store.db.prepare("UPDATE v2_shadow_domains SET status='failed' WHERE domain_key='hub:memories'").run();
  store.transaction(() => store.putRuntimeDomain("hub:memories", memories));
  const repaired = new RuntimeV2Parity(databaseFile).run();
  assert.equal(repaired.summary.ok, true);

  console.log(JSON.stringify({ ok: true, sourceObjects: repaired.summary.sourceObjects, targetObjects: repaired.summary.targetObjects }));
} finally {
  try { store?.close(); } catch {}
  await fs.rm(tempDir, { recursive: true, force: true });
}
