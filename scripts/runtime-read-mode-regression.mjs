import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthorityStore } from "../authorityStore.mjs";
import { RuntimeReadModeController } from "../src/storage/runtimeReadModeController.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-read-mode-"));
const databaseFile = path.join(tempDir, "authority.sqlite");
let store;
const waitFor = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for parity worker");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

try {
  store = new AuthorityStore(databaseFile);
  const memories = [{ id: "memory-1", charId: "char-1", room: "study", content: "one", createdAt: 1785900000000 }];
  store.transaction(() => {
    store.putRuntimeDomain("hub:memories", memories);
    store.replaceRuntimeMessages([{ id: 1, charId: "char-1", role: "user", content: "hello", timestamp: 1785900001000, surface: "chat", visibility: "user" }]);
  });

  const legacy = new RuntimeReadModeController({ mode: "legacy", databaseFile });
  assert.equal(legacy.initialize().effectiveMode, "legacy");
  assert.equal(legacy.usesV2Reads(), false);

  const invalid = new RuntimeReadModeController({ mode: "unexpected", databaseFile });
  assert.equal(invalid.initialize().effectiveMode, "legacy");
  assert.ok(invalid.status().configError);

  const compare = new RuntimeReadModeController({ mode: "compare", databaseFile, intervalMs: 60000 });
  compare.start();
  await waitFor(() => Boolean(compare.status().lastParity) || Boolean(compare.status().lastError));
  assert.equal(compare.status().lastError, null);
  assert.equal(compare.status().lastParity.summary.ok, true);
  assert.equal(compare.usesV2Reads(), false, "compare mode must keep production reads on legacy");
  assert.equal(Object.hasOwn(compare.publicStatus(), "differences"), false);
  assert.equal(Object.hasOwn(compare.publicStatus(), "lastError"), false);
  compare.stop();

  const v2 = new RuntimeReadModeController({ mode: "v2", databaseFile });
  assert.equal(v2.initialize().effectiveMode, "v2");
  assert.equal(v2.usesV2Reads(), true);
  v2.degrade("forced runtime shadow failure");
  assert.equal(v2.usesV2Reads(), false);
  assert.match(v2.status().lastError, /forced runtime shadow failure/);

  store.db.prepare("UPDATE v2_memory_nodes SET raw_json=?,content_hash='corrupt' WHERE memory_id='memory-1'").run(JSON.stringify({ ...memories[0], content: "corrupt" }));
  const guarded = new RuntimeReadModeController({ mode: "v2", databaseFile });
  assert.equal(guarded.initialize().effectiveMode, "legacy");
  assert.match(guarded.status().lastError, /parity failed/i);

  let authorityHealthy = true;
  const authoritative = new RuntimeReadModeController({ mode: "v2", databaseFile, authorityMode: () => "v2", authorityHealth: () => ({ ok: authorityHealthy }) });
  assert.equal(authoritative.initialize().effectiveMode, "v2", "promoted V2 authority must not be rejected because legacy has diverged");
  assert.equal(authoritative.status().startupValidation, "v2-authority-health");
  assert.equal(authoritative.status().productionSource, "v2-authority");
  authorityHealthy = false;
  assert.equal(authoritative.initialize().effectiveMode, "blocked");
  assert.match(authoritative.status().lastError, /authority health failed/i);

  const persistedAuthorityWins = new RuntimeReadModeController({ mode: "legacy", databaseFile, authorityMode: () => "v2", authorityHealth: () => ({ ok: true }) });
  assert.equal(persistedAuthorityWins.initialize().effectiveMode, "v2", "persisted authority must not be hidden by a missing legacy environment switch");
  assert.equal(persistedAuthorityWins.status().productionSource, "v2-authority");

  console.log(JSON.stringify({ ok: true, legacy: legacy.status().effectiveMode, compare: compare.status().effectiveMode, v2: v2.status().effectiveMode, guardedFallback: guarded.status().effectiveMode }));
} finally {
  try { store?.close(); } catch {}
  await fs.rm(tempDir, { recursive: true, force: true });
}
