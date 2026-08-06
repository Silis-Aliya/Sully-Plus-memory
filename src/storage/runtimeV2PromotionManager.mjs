import { createHash, randomUUID } from "node:crypto";
import { AuthorityError } from "../../authorityStore.mjs";
import { RuntimeV2Parity } from "./runtimeV2Parity.mjs";

const nowIso = () => new Date().toISOString();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function parityHash(report) {
  return hash({ messages: report.messages, domains: report.domains, summary: report.summary });
}

function present(row) {
  if (!row) return null;
  return {
    promotionId: row.promotion_id,
    status: row.status,
    actorId: row.actor_id,
    parityHash: row.parity_hash,
    parity: JSON.parse(row.parity_json || "{}"),
    shadowMarker: row.shadow_marker,
    baselineNativeMutationSeq: Number(row.baseline_native_mutation_seq || 0),
    preparedAt: row.prepared_at,
    expiresAt: row.expires_at,
    committedAt: row.committed_at,
    rolledBackAt: row.rolled_back_at,
    rollbackReason: row.rollback_reason,
  };
}

export class RuntimeV2PromotionManager {
  constructor(authorityStore, { ttlMs = 15 * 60 * 1000, now = () => new Date() } = {}) {
    this.store = authorityStore;
    this.runtime = authorityStore.runtimeV2;
    this.ttlMs = Math.max(60_000, Number(ttlMs) || 15 * 60 * 1000);
    this.now = now;
  }

  shadowMarker() {
    const domains = this.store.db.prepare("SELECT domain_key,source_version,source_hash,item_count,status,updated_at FROM v2_shadow_domains ORDER BY domain_key").all();
    return hash(domains);
  }

  latest() {
    return present(this.store.db.prepare("SELECT * FROM v2_runtime_promotions ORDER BY prepared_at DESC LIMIT 1").get());
  }

  status() {
    return { authorityMode: this.runtime.authorityMode(), nativeMutationSeq: this.runtime.nativeMutationSequence(), latestPromotion: this.latest() };
  }

  runParity() {
    const report = new RuntimeV2Parity(this.store.file).run();
    const health = this.store.runtimeV2Health();
    const processingCommands = Number(this.store.db.prepare("SELECT COUNT(*) count FROM commands WHERE status='processing'").get().count);
    return { report, parityHash: parityHash(report), shadowMarker: this.shadowMarker(), health, processingCommands };
  }

  prepare({ actorId = "operator" } = {}) {
    if (this.runtime.authorityMode() !== "shadow") throw new AuthorityError("V2_ALREADY_AUTHORITATIVE", "V2 authority is already promoted", 409, this.status());
    const check = this.runParity();
    if (!check.report.summary.ok || !check.health.ok || check.processingCommands > 0) {
      throw new AuthorityError("V2_PROMOTION_PREFLIGHT_FAILED", "V2 promotion preflight failed", 409, { parity: check.report.summary, health: check.health, processingCommands: check.processingCommands });
    }
    const preparedAt = this.now();
    const expiresAt = new Date(preparedAt.getTime() + this.ttlMs);
    const promotionId = randomUUID();
    const baseline = this.runtime.nativeMutationSequence();
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE v2_runtime_promotions SET status='superseded' WHERE status='prepared'").run();
      this.store.db.prepare(`INSERT INTO v2_runtime_promotions(promotion_id,status,actor_id,parity_hash,parity_json,shadow_marker,baseline_native_mutation_seq,prepared_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(promotionId, "prepared", actorId, check.parityHash, JSON.stringify(check.report), check.shadowMarker, baseline, preparedAt.toISOString(), expiresAt.toISOString());
    });
    return present(this.store.db.prepare("SELECT * FROM v2_runtime_promotions WHERE promotion_id=?").get(promotionId));
  }

  commit(promotionId, parityHashConfirmation, { actorId = "operator" } = {}) {
    const prepared = this.store.db.prepare("SELECT * FROM v2_runtime_promotions WHERE promotion_id=?").get(promotionId);
    if (!prepared || prepared.status !== "prepared") throw new AuthorityError("V2_PROMOTION_NOT_PREPARED", "A current prepared promotion is required", 409);
    if (prepared.actor_id !== actorId) throw new AuthorityError("V2_PROMOTION_ACTOR_MISMATCH", "Promotion must be committed by the actor that prepared it", 403);
    if (prepared.parity_hash !== parityHashConfirmation) throw new AuthorityError("V2_PROMOTION_HASH_MISMATCH", "Parity hash confirmation does not match", 409);
    if (Date.parse(prepared.expires_at) <= this.now().getTime()) throw new AuthorityError("V2_PROMOTION_EXPIRED", "Prepared promotion has expired", 409);
    const check = this.runParity();
    if (!check.report.summary.ok || !check.health.ok || check.processingCommands > 0 || check.parityHash !== prepared.parity_hash || check.shadowMarker !== prepared.shadow_marker) {
      throw new AuthorityError("V2_PROMOTION_STATE_CHANGED", "Runtime changed after promotion preparation; prepare again", 409, { parity: check.report.summary, health: check.health, processingCommands: check.processingCommands, parityHash: check.parityHash, shadowMarker: check.shadowMarker });
    }
    const committedAt = nowIso();
    this.store.transaction(() => {
      const current = this.store.db.prepare("SELECT status FROM v2_runtime_promotions WHERE promotion_id=?").get(promotionId);
      if (current?.status !== "prepared" || this.shadowMarker() !== prepared.shadow_marker || this.runtime.nativeMutationSequence() !== Number(prepared.baseline_native_mutation_seq)) {
        throw new AuthorityError("V2_PROMOTION_STATE_CHANGED", "Runtime changed while committing promotion", 409);
      }
      this.runtime.setAuthorityMode("v2");
      this.runtime.setControl("active_promotion_id", promotionId);
      this.store.db.prepare("UPDATE v2_runtime_promotions SET status='committed',committed_at=? WHERE promotion_id=?").run(committedAt, promotionId);
    });
    return this.status();
  }

  rollback({ actorId = "operator", reason = "operator rollback" } = {}) {
    if (this.runtime.authorityMode() !== "v2") throw new AuthorityError("V2_NOT_AUTHORITATIVE", "V2 authority is not active", 409);
    const promotionId = this.runtime.control("active_promotion_id", "");
    const promotion = this.store.db.prepare("SELECT * FROM v2_runtime_promotions WHERE promotion_id=? AND status='committed'").get(promotionId);
    if (!promotion) throw new AuthorityError("V2_PROMOTION_RECORD_MISSING", "Active promotion record is missing", 409);
    const currentSeq = this.runtime.nativeMutationSequence();
    if (currentSeq !== Number(promotion.baseline_native_mutation_seq)) {
      throw new AuthorityError("V2_ROLLBACK_REQUIRES_RECONCILIATION", "V2 has native mutations; reconcile them into legacy before rollback", 409, { baselineNativeMutationSeq: Number(promotion.baseline_native_mutation_seq), currentNativeMutationSeq: currentSeq });
    }
    const rolledBackAt = nowIso();
    this.store.transaction(() => {
      this.runtime.setAuthorityMode("shadow");
      this.runtime.setControl("active_promotion_id", null);
      this.store.db.prepare("UPDATE v2_runtime_promotions SET status='rolled_back',rolled_back_at=?,rollback_reason=? WHERE promotion_id=?")
        .run(rolledBackAt, `${actorId}: ${reason}`, promotionId);
    });
    return this.status();
  }
}
