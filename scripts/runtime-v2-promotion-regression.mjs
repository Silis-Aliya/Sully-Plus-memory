import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthorityError, AuthorityStore } from "../authorityStore.mjs";
import { RuntimeV2NativeCommandExecutor } from "../src/storage/runtimeV2NativeCommandExecutor.mjs";
import { RuntimeV2PromotionManager } from "../src/storage/runtimeV2PromotionManager.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-promotion-"));
let store;
try {
  store = new AuthorityStore(path.join(tempDir, "authority.sqlite"));
  store.transaction(() => {
    store.putRuntimeDomain("hub:memories", [{ id: "memory-1", charId: "char-1", room: "study", content: "one", createdAt: 1785900000000 }]);
    store.replaceRuntimeMessages([{ id: 1, charId: "char-1", role: "user", content: "hello", timestamp: 1785900001000, surface: "chat", visibility: "user" }]);
  });
  const manager = new RuntimeV2PromotionManager(store);
  assert.equal(manager.status().authorityMode, "shadow");

  const stale = manager.prepare({ actorId: "operator-1" });
  assert.throws(() => manager.commit(stale.promotionId, "wrong", { actorId: "operator-1" }), (error) => error instanceof AuthorityError && error.code === "V2_PROMOTION_HASH_MISMATCH");
  store.putRuntimeDomain("hub:memories", [{ id: "memory-1", charId: "char-1", room: "study", content: "one", createdAt: 1785900000000 }, { id: "memory-2", charId: "char-1", room: "study", content: "two", createdAt: 1785900002000 }]);
  assert.throws(() => manager.commit(stale.promotionId, stale.parityHash, { actorId: "operator-1" }), (error) => error instanceof AuthorityError && error.code === "V2_PROMOTION_STATE_CHANGED");

  const clean = manager.prepare({ actorId: "operator-1" });
  const promoted = manager.commit(clean.promotionId, clean.parityHash, { actorId: "operator-1" });
  assert.equal(promoted.authorityMode, "v2");
  const rolledBack = manager.rollback({ actorId: "operator-1", reason: "clean rollback test" });
  assert.equal(rolledBack.authorityMode, "shadow");

  const finalPrepare = manager.prepare({ actorId: "operator-1" });
  manager.commit(finalPrepare.promotionId, finalPrepare.parityHash, { actorId: "operator-1" });
  const executor = new RuntimeV2NativeCommandExecutor(store);
  const result = executor.execute({ commandId: "promotion-native-command-1", type: "runtime.message.commit", actorId: "operator-1", characterId: "char-1", worldId: null, issuedAt: "2026-08-05T18:00:00.000Z", protocolVersion: "1.0", payload: { message: { messageId: "promotion-native-message-1", role: "assistant", content: "native", surface: "activity", visibility: "internal", occurredAt: "2026-08-05T18:00:00.000Z" } } });
  assert.equal(result.result.nativeMutationSeq, 1);
  assert.throws(() => manager.rollback({ actorId: "operator-1" }), (error) => error instanceof AuthorityError && error.code === "V2_ROLLBACK_REQUIRES_RECONCILIATION");
  assert.equal(manager.status().authorityMode, "v2");

  console.log(JSON.stringify({ ok: true, staleGuard: true, cleanRollback: true, nativeMutationSeq: manager.status().nativeMutationSeq, rollbackBlocked: true }));
} finally {
  try { store?.close(); } catch {}
  await fs.rm(tempDir, { recursive: true, force: true });
}
