import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthorityStore } from "../authorityStore.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-shadow-"));
let store;
try {
  store = new AuthorityStore(path.join(tempDir, "authority.sqlite"));
  const memory1 = { id: "memory-1", charId: "char-1", room: "study", content: "first", createdAt: 1785900000000 };
  const memory2 = { id: "memory-2", charId: "char-1", room: "study", content: "second", createdAt: 1785900001000 };
  store.transaction(() => {
    store.putRuntimeDomain("hub:memories", [memory1, memory2]);
    store.putRuntimeDomain("hub:links", [{ id: "link-1", charId: "char-1", sourceId: "memory-1", targetId: "memory-2", type: "related", strength: 0.5 }]);
    store.putRuntimeDomain("hub:characterRuntime", { "char-1": { mood: "calm", updatedAt: 1785900002000 } });
    store.replaceRuntimeMessages([
      { id: 1, sourceId: "source-1", charId: "char-1", role: "user", content: "hello", timestamp: 1785900003000, surface: "chat", visibility: "user" },
      { id: 2, sourceId: "source-2", charId: "char-1", role: "assistant", content: "hi", timestamp: 1785900004000, surface: "chat", visibility: "user" },
    ]);
  });

  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_memory_nodes WHERE deleted_at IS NULL").get().count), 2);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_memory_links WHERE deleted_at IS NULL").get().count), 1);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_character_runtime_state WHERE deleted_at IS NULL").get().count), 1);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_messages WHERE deleted_at IS NULL").get().count), 2);

  const currentMessages = [
    { id: 1, sourceId: "source-1", charId: "char-1", role: "user", content: "hello-updated", timestamp: 1785900003000, surface: "chat", visibility: "user" },
    { id: 3, sourceId: "source-3", charId: "char-1", role: "assistant", content: "new", timestamp: 1785900005000, surface: "chat", visibility: "user" },
  ];
  store.transaction(() => {
    store.putRuntimeDomain("hub:memories", [{ ...memory1, content: "first-updated" }]);
    store.replaceRuntimeMessages(currentMessages);
  });
  assert.equal(store.db.prepare("SELECT content FROM v2_memory_nodes WHERE memory_id='memory-1'").get().content, "first-updated");
  assert.ok(store.db.prepare("SELECT deleted_at FROM v2_memory_nodes WHERE memory_id='memory-2'").get().deleted_at);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_messages WHERE deleted_at IS NOT NULL").get().count), 1);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_messages WHERE deleted_at IS NULL").get().count), 2);

  store.db.prepare("DELETE FROM v2_messages WHERE source_message_id='3'").run();
  store.db.prepare("UPDATE v2_shadow_domains SET status='failed' WHERE domain_key='message:all'").run();
  store.transaction(() => store.replaceRuntimeMessages(currentMessages));
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) count FROM v2_messages WHERE deleted_at IS NULL").get().count), 2, "failed message baseline must be rebuilt from the full legacy set");

  const statusBefore = JSON.stringify(store.runtimeV2Status().domains);
  store.transaction(() => store.putRuntimeDomain("hub:memories", [{ ...memory1, content: "first-updated" }]));
  assert.equal(JSON.stringify(store.runtimeV2Status().domains), statusBefore, "identical writes must skip the shadow path");

  const original = store.runtimeV2.replaceDomain.bind(store.runtimeV2);
  store.runtimeV2.replaceDomain = () => { throw new Error("forced shadow failure"); };
  store.transaction(() => store.putRuntimeDomain("hub:anticipations", [{ id: "a-1", charId: "char-1", content: "tomorrow", createdAt: 1785900006000 }]));
  store.runtimeV2.replaceDomain = original;
  assert.equal(store.getRuntimeDomain("hub:anticipations").data.length, 1, "legacy authority write must survive shadow failure");
  assert.equal(store.runtimeV2Status().openFailures.length, 1);
  store.transaction(() => store.putRuntimeDomain("hub:anticipations", store.getRuntimeDomain("hub:anticipations").data));
  assert.equal(store.runtimeV2Status().openFailures.length, 0, "successful retry must resolve the shadow failure");

  console.log(JSON.stringify({ ok: true, activeMessages: 2, tombstonedMessages: 1, activeMemories: 1, tombstonedMemories: 1, shadowFailures: 0 }));
} finally {
  try { store?.close(); } catch {}
  await fs.rm(tempDir, { recursive: true, force: true });
}
