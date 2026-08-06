import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaFile = path.join(here, "migrations", "002_incremental_runtime.sql");
const supportedDomains = new Set(["memories", "vectors", "links", "eventBoxes", "roomPlates", "anticipations", "digestReports", "characterRuntime"]);
const nowIso = () => new Date().toISOString();
const clean = (value, fallback = "") => value === undefined || value === null ? fallback : String(value).trim();
const list = (value) => Array.isArray(value) ? value : [];
const boolInt = (value) => value ? 1 : 0;

function iso(value, fallback = nowIso()) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = typeof value === "number" || /^\d{10,}$/.test(String(value)) ? Number(value) : NaN;
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function messageId(charId, sourceId) {
  return `legacy:${encodeURIComponent(charId)}:${encodeURIComponent(sourceId)}`;
}

function vectorBuffer(values) {
  const floats = Float32Array.from(values.map((value) => Number(value) || 0));
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function domainObjectId(domain, item, index) {
  if (domain === "memories") return clean(item.id, `legacy-memory:${index}`);
  if (domain === "vectors") return clean(item.memoryId);
  if (domain === "links") return clean(item.id, `legacy-link:${index}`);
  if (domain === "eventBoxes") return clean(item.id, `legacy-event-box:${index}`);
  if (domain === "roomPlates") return clean(item.id, `${clean(item.charId, "unbound")}:${clean(item.room, "unknown")}`);
  if (domain === "anticipations") return clean(item.id, `legacy-anticipation:${index}`);
  if (domain === "digestReports") return clean(item.id, `legacy-digest:${index}`);
  if (domain === "characterRuntime") return clean(item.characterId || item.charId || item.id, `unbound:${index}`);
  return "";
}

export class RuntimeV2Repository {
  constructor(db, { contentHash }) {
    this.db = db;
    this.contentHash = contentHash;
    this.ensureSchema();
  }

  ensureSchema() {
    this.db.exec(readFileSync(schemaFile, "utf8"));
    const additions = [
      ["v2_messages", "source_sequence_no", "INTEGER"],
      ["v2_memory_vectors", "source_vector_field", "TEXT NOT NULL DEFAULT 'vector'"],
      ["v2_memory_vectors", "source_had_dimensions", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_memory_nodes", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_memory_vectors", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_memory_links", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_event_boxes", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_room_plates", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_anticipations", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_digest_reports", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_memory_vectors", "deleted_at", "TEXT"],
      ["v2_memory_links", "deleted_at", "TEXT"],
      ["v2_event_box_members", "deleted_at", "TEXT"],
      ["v2_room_plate_entries", "deleted_at", "TEXT"],
      ["v2_digest_reports", "deleted_at", "TEXT"],
      ["v2_character_runtime_state", "deleted_at", "TEXT"],
      ["v2_runtime_promotions", "shadow_marker", "TEXT NOT NULL DEFAULT ''"],
      ["v2_cc_wake_runs", "attempt_count", "INTEGER NOT NULL DEFAULT 0"],
      ["v2_cc_wake_runs", "lease_token", "TEXT"],
      ["v2_cc_wake_runs", "lease_expires_at", "TEXT"],
      ["v2_cc_wake_runs", "context_json", "TEXT"],
      ["v2_cc_wake_runs", "context_hash", "TEXT"],
      ["v2_cc_wake_runs", "context_from_event_id", "INTEGER NOT NULL DEFAULT 0"],
      ["v2_cc_wake_runs", "context_to_event_id", "INTEGER NOT NULL DEFAULT 0"],
      ["v2_cc_wake_runs", "updated_at", "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [table, column, type] of additions) {
      const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
      if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_v2_messages_source_sequence ON v2_messages(source_sequence_no)");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_cc_wake_runs_job ON v2_cc_wake_runs(job_id) WHERE job_id IS NOT NULL");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_v2_cc_wake_runs_claim ON v2_cc_wake_runs(status,lease_expires_at,started_at)");
    this.db.prepare("INSERT OR IGNORE INTO v2_runtime_control(control_key,value_json,updated_at) VALUES('authority_mode','\"shadow\"',?)").run(nowIso());
    this.db.prepare("INSERT OR IGNORE INTO v2_runtime_control(control_key,value_json,updated_at) VALUES('native_mutation_seq','0',?)").run(nowIso());
  }

  control(key, fallback = null) {
    const row = this.db.prepare("SELECT value_json FROM v2_runtime_control WHERE control_key=?").get(key);
    try { return row ? JSON.parse(row.value_json) : fallback; } catch { return fallback; }
  }

  setControl(key, value) {
    this.db.prepare(`INSERT INTO v2_runtime_control(control_key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(control_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), nowIso());
    return value;
  }

  authorityMode() {
    return this.control("authority_mode", "shadow");
  }

  setAuthorityMode(mode) {
    if (!new Set(["shadow", "v2"]).has(mode)) throw Object.assign(new Error("authority mode must be shadow or v2"), { code: "VALIDATION_FAILED", status: 400 });
    this.setControl("authority_mode", mode);
    return this.authorityMode();
  }

  nativeMutationSequence() {
    return Number(this.control("native_mutation_seq", 0)) || 0;
  }

  bumpNativeMutationSequence() {
    const next = this.nativeMutationSequence() + 1;
    this.setControl("native_mutation_seq", next);
    return next;
  }

  state(domainKey) {
    return this.db.prepare("SELECT * FROM v2_shadow_domains WHERE domain_key=?").get(domainKey) || null;
  }

  isCurrent(domainKey, sourceHash) {
    const state = this.state(domainKey);
    return Boolean(state && state.status === "current" && state.source_hash === sourceHash);
  }

  markCurrent(domainKey, sourceHash, sourceVersion, itemCount) {
    this.db.prepare(`INSERT INTO v2_shadow_domains(domain_key,source_version,source_hash,item_count,status,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(domain_key) DO UPDATE SET source_version=excluded.source_version,source_hash=excluded.source_hash,item_count=excluded.item_count,status='current',updated_at=excluded.updated_at`)
      .run(domainKey, Number(sourceVersion || 0), sourceHash, Number(itemCount || 0), "current", nowIso());
    this.db.prepare("UPDATE v2_shadow_write_failures SET resolved_at=? WHERE domain_key=? AND resolved_at IS NULL").run(nowIso(), domainKey);
  }

  recordFailure(domainKey, operation, sourceHash, error) {
    this.db.prepare("INSERT INTO v2_shadow_write_failures(domain_key,operation,source_hash,error_text,created_at) VALUES(?,?,?,?,?)")
      .run(domainKey, operation, sourceHash || null, String(error?.stack || error).slice(0, 12000), nowIso());
    this.db.prepare(`INSERT INTO v2_shadow_domains(domain_key,source_version,source_hash,item_count,status,updated_at)
      VALUES(?,0,?,0,'failed',?) ON CONFLICT(domain_key) DO UPDATE SET source_hash=excluded.source_hash,status='failed',updated_at=excluded.updated_at`)
      .run(domainKey, sourceHash || "", nowIso());
  }

  status() {
    return {
      domains: this.db.prepare("SELECT domain_key,source_version,source_hash,item_count,status,updated_at FROM v2_shadow_domains ORDER BY domain_key").all(),
      openFailures: this.db.prepare("SELECT failure_id,domain_key,operation,source_hash,error_text,created_at FROM v2_shadow_write_failures WHERE resolved_at IS NULL ORDER BY failure_id").all(),
    };
  }

  health() {
    const openFailures = Number(this.db.prepare("SELECT COUNT(*) count FROM v2_shadow_write_failures WHERE resolved_at IS NULL").get().count);
    const failedDomains = Number(this.db.prepare("SELECT COUNT(*) count FROM v2_shadow_domains WHERE status<>'current'").get().count);
    return { ok: openFailures === 0 && failedDomains === 0, openFailures, failedDomains };
  }

  getMessage(messageId) {
    const row = this.db.prepare("SELECT * FROM v2_messages WHERE message_id=?").get(messageId);
    if (!row) return null;
    return { messageId: row.message_id, messageSeq: Number(row.message_seq), characterId: row.character_id, conversationId: row.conversation_id, turnId: row.turn_id, role: row.role, messageType: row.message_type, content: row.content, surface: row.surface, visibility: row.visibility, origin: row.origin, sourceClientId: row.source_client_id, sourceMessageId: row.source_message_id, metadata: JSON.parse(row.metadata_json || "{}"), occurredAt: row.occurred_at, createdAt: row.created_at, deletedAt: row.deleted_at };
  }

  commitMessage(message) {
    const id = clean(message.messageId || message.id);
    if (!id || !clean(message.characterId)) throw Object.assign(new Error("messageId and characterId are required"), { code: "VALIDATION_FAILED", status: 400 });
    const raw = JSON.stringify(message), hash = this.contentHash(message), current = this.db.prepare("SELECT content_hash FROM v2_messages WHERE message_id=?").get(id);
    if (current) {
      if (current.content_hash !== hash) throw Object.assign(new Error("messageId already exists with different content"), { code: "IDEMPOTENCY_CONFLICT", status: 409, details: { messageId: id } });
      return { created: false, message: this.getMessage(id) };
    }
    const occurredAt = iso(message.occurredAt ?? message.timestamp ?? message.createdAt), createdAt = iso(message.createdAt, occurredAt);
    this.db.prepare(`INSERT INTO v2_messages(message_id,source_sequence_no,character_id,conversation_id,turn_id,role,message_type,content,surface,visibility,origin,source_client_id,source_message_id,metadata_json,raw_json,content_hash,occurred_at,created_at,deleted_at)
      VALUES(?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(id, clean(message.characterId), clean(message.conversationId, `direct:me:${clean(message.characterId)}`), clean(message.turnId) || null, clean(message.role, "user"), clean(message.messageType || message.type, "text"), clean(message.content ?? message.text), clean(message.surface, "chat"), clean(message.visibility, message.surface === "chat" ? "user" : "internal"), clean(message.origin, "native"), clean(message.sourceClientId) || null, clean(message.sourceMessageId) || null, JSON.stringify(message.metadata || {}), raw, hash, occurredAt, createdAt);
    return { created: true, message: this.getMessage(id) };
  }

  getMemoryNode(memoryId) {
    const row = this.db.prepare("SELECT * FROM v2_memory_nodes WHERE memory_id=?").get(memoryId);
    if (!row) return null;
    return { memoryId: row.memory_id, version: Number(row.row_version), characterId: row.character_id, room: row.room, content: row.content, title: row.title, importance: Number(row.importance), mood: row.mood, tags: JSON.parse(row.tags_json || "[]"), eventBoxId: row.event_box_id, archived: Boolean(row.archived), isBoxSummary: Boolean(row.is_box_summary), embedded: Boolean(row.embedded), occurredAt: row.occurred_at, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
  }

  putMemoryNode(memory, { expectedVersion } = {}) {
    const id = clean(memory.memoryId || memory.id), characterId = clean(memory.characterId || memory.charId);
    if (!id || !characterId || !clean(memory.content)) throw Object.assign(new Error("memoryId, characterId and content are required"), { code: "VALIDATION_FAILED", status: 400 });
    const current = this.db.prepare("SELECT row_version,content_hash,created_at,deleted_at FROM v2_memory_nodes WHERE memory_id=?").get(id);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current?.row_version || 0)) throw Object.assign(new Error("MemoryNode version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: Number(current?.row_version || 0) } });
    const normalized = { ...memory, id, charId: characterId }, hash = this.contentHash(normalized);
    if (current && !current.deleted_at && current.content_hash === hash) return { created: false, changed: false, memory: this.getMemoryNode(id) };
    const now = nowIso(), version = Number(current?.row_version || 0) + 1, createdAt = current?.created_at || iso(memory.createdAt ?? memory.occurredAt, now);
    this.db.prepare(`INSERT INTO v2_memory_nodes(memory_id,row_version,character_id,room,content,title,importance,mood,tags_json,event_box_id,archived,is_box_summary,embedded,occurred_at,created_at,updated_at,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(memory_id) DO UPDATE SET row_version=excluded.row_version,character_id=excluded.character_id,room=excluded.room,content=excluded.content,title=excluded.title,importance=excluded.importance,mood=excluded.mood,tags_json=excluded.tags_json,event_box_id=excluded.event_box_id,archived=excluded.archived,is_box_summary=excluded.is_box_summary,embedded=excluded.embedded,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`)
      .run(id, version, characterId, clean(memory.room, "living_room"), clean(memory.content), clean(memory.title), Number(memory.importance || 0), clean(memory.mood), JSON.stringify(list(memory.tags)), clean(memory.eventBoxId) || null, boolInt(memory.archived), boolInt(memory.isBoxSummary), boolInt(memory.embedded), memory.occurredAt == null ? null : iso(memory.occurredAt), createdAt, now, JSON.stringify(normalized), hash);
    return { created: !current, changed: true, memory: this.getMemoryNode(id) };
  }

  deleteMemoryNode(memoryId, { expectedVersion } = {}) {
    const current = this.getMemoryNode(memoryId);
    if (!current || current.deletedAt) throw Object.assign(new Error("MemoryNode was not found"), { code: "NOT_FOUND", status: 404 });
    if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) throw Object.assign(new Error("MemoryNode version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: current.version } });
    const now = nowIso();
    this.db.prepare("UPDATE v2_memory_nodes SET row_version=row_version+1,updated_at=?,deleted_at=? WHERE memory_id=?").run(now, now, memoryId);
    return this.getMemoryNode(memoryId);
  }

  getMemoryVector(memoryId) {
    const row = this.db.prepare("SELECT * FROM v2_memory_vectors WHERE memory_id=?").get(memoryId);
    if (!row) return null;
    const values = Array.from(new Float32Array(row.vector_blob.buffer, row.vector_blob.byteOffset, Number(row.dimensions)));
    return { memoryId: row.memory_id, version: Number(row.row_version), characterId: row.character_id, model: row.model, dimensions: Number(row.dimensions), vector: values, vectorHash: row.vector_hash, metadata: JSON.parse(row.raw_metadata_json || "{}"), updatedAt: row.updated_at, deletedAt: row.deleted_at };
  }

  putMemoryVector(vector, { expectedVersion } = {}) {
    const memoryId = clean(vector.memoryId), values = list(vector.vector).length ? vector.vector : vector.embedding;
    if (!memoryId || !list(values).length) throw Object.assign(new Error("memoryId and vector values are required"), { code: "VALIDATION_FAILED", status: 400 });
    if (vector.dimensions !== undefined && Number(vector.dimensions) !== values.length) throw Object.assign(new Error("vector dimensions must match value count"), { code: "VALIDATION_FAILED", status: 400, details: { dimensions: Number(vector.dimensions), values: values.length } });
    const current = this.db.prepare("SELECT row_version,vector_hash,raw_metadata_json,deleted_at FROM v2_memory_vectors WHERE memory_id=?").get(memoryId);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current?.row_version || 0)) throw Object.assign(new Error("Memory vector version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: Number(current?.row_version || 0) } });
    const field = list(vector.vector).length ? "vector" : "embedding", metadata = { ...vector, memoryId, charId: clean(vector.characterId || vector.charId) || undefined };
    delete metadata.vector; delete metadata.embedding;
    const vectorHash = sha256(vectorBuffer(values)), metadataJson = JSON.stringify(metadata);
    if (current && !current.deleted_at && current.vector_hash === vectorHash && this.contentHash(JSON.parse(current.raw_metadata_json || "{}")) === this.contentHash(metadata)) return { created: false, changed: false, vector: this.getMemoryVector(memoryId) };
    const version = Number(current?.row_version || 0) + 1, updatedAt = nowIso();
    this.db.prepare(`INSERT INTO v2_memory_vectors(memory_id,row_version,character_id,model,dimensions,vector_blob,vector_hash,source_vector_field,source_had_dimensions,updated_at,raw_metadata_json,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(memory_id) DO UPDATE SET row_version=excluded.row_version,character_id=excluded.character_id,model=excluded.model,dimensions=excluded.dimensions,vector_blob=excluded.vector_blob,vector_hash=excluded.vector_hash,source_vector_field=excluded.source_vector_field,source_had_dimensions=excluded.source_had_dimensions,updated_at=excluded.updated_at,raw_metadata_json=excluded.raw_metadata_json,deleted_at=NULL`)
      .run(memoryId, version, clean(vector.characterId || vector.charId) || null, clean(vector.model), Number(vector.dimensions || values.length), vectorBuffer(values), vectorHash, field, Object.hasOwn(vector, "dimensions") ? 1 : 0, updatedAt, metadataJson);
    return { created: !current, changed: true, vector: this.getMemoryVector(memoryId) };
  }

  deleteMemoryVector(memoryId, { expectedVersion } = {}) {
    const current = this.getMemoryVector(memoryId);
    if (!current || current.deletedAt) throw Object.assign(new Error("Memory vector was not found"), { code: "NOT_FOUND", status: 404 });
    if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) throw Object.assign(new Error("Memory vector version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: current.version } });
    const now = nowIso();
    this.db.prepare("UPDATE v2_memory_vectors SET row_version=row_version+1,updated_at=?,deleted_at=? WHERE memory_id=?").run(now, now, memoryId);
    return this.getMemoryVector(memoryId);
  }

  getMemoryLink(linkId) {
    const row = this.db.prepare("SELECT * FROM v2_memory_links WHERE link_id=?").get(linkId);
    return row ? { linkId: row.link_id, version: Number(row.row_version), characterId: row.character_id, sourceMemoryId: row.source_memory_id, targetMemoryId: row.target_memory_id, linkType: row.link_type, strength: Number(row.strength), activationCount: Number(row.activation_count), lastActivatedAt: row.last_activated_at, updatedAt: JSON.parse(row.raw_json || "{}").updatedAt || null, deletedAt: row.deleted_at } : null;
  }

  putMemoryLink(link, { expectedVersion } = {}) {
    const id = clean(link.linkId || link.id), characterId = clean(link.characterId || link.charId), sourceId = clean(link.sourceMemoryId || link.sourceId), targetId = clean(link.targetMemoryId || link.targetId);
    if (!id || !sourceId || !targetId) throw Object.assign(new Error("linkId, sourceMemoryId and targetMemoryId are required"), { code: "VALIDATION_FAILED", status: 400 });
    const current = this.db.prepare("SELECT row_version,content_hash,deleted_at FROM v2_memory_links WHERE link_id=?").get(id);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current?.row_version || 0)) throw Object.assign(new Error("Memory link version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: Number(current?.row_version || 0) } });
    const normalized = { ...link, id, charId: characterId || undefined, sourceId, targetId, type: clean(link.linkType || link.type, "related") }, contentHash = this.contentHash(normalized);
    if (current && !current.deleted_at && current.content_hash === contentHash) return { created: false, changed: false, link: this.getMemoryLink(id) };
    const version = Number(current?.row_version || 0) + 1;
    this.db.prepare(`INSERT INTO v2_memory_links(link_id,row_version,character_id,source_memory_id,target_memory_id,link_type,strength,activation_count,last_activated_at,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(link_id) DO UPDATE SET row_version=excluded.row_version,character_id=excluded.character_id,source_memory_id=excluded.source_memory_id,target_memory_id=excluded.target_memory_id,link_type=excluded.link_type,strength=excluded.strength,activation_count=excluded.activation_count,last_activated_at=excluded.last_activated_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`)
      .run(id, version, characterId || null, sourceId, targetId, normalized.type, Number(link.strength || 0), Number(link.activationCount || 0), link.lastActivatedAt ? iso(link.lastActivatedAt) : null, JSON.stringify(normalized), contentHash);
    return { created: !current, changed: true, link: this.getMemoryLink(id) };
  }

  deleteMemoryLink(linkId, { expectedVersion } = {}) {
    const current = this.getMemoryLink(linkId);
    if (!current || current.deletedAt) throw Object.assign(new Error("Memory link was not found"), { code: "NOT_FOUND", status: 404 });
    if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) throw Object.assign(new Error("Memory link version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: current.version } });
    const now = nowIso();
    this.db.prepare("UPDATE v2_memory_links SET row_version=row_version+1,deleted_at=? WHERE link_id=?").run(now, linkId);
    return this.getMemoryLink(linkId);
  }

  getEventBox(eventBoxId) {
    const row = this.db.prepare("SELECT * FROM v2_event_boxes WHERE event_box_id=?").get(eventBoxId);
    if (!row) return null;
    const members = this.db.prepare("SELECT memory_id,member_state,ordinal FROM v2_event_box_members WHERE event_box_id=? AND deleted_at IS NULL ORDER BY member_state,ordinal").all(eventBoxId);
    return { eventBoxId: row.event_box_id, version: Number(row.row_version), characterId: row.character_id, name: row.name, tags: JSON.parse(row.tags_json || "[]"), summaryMemoryId: row.summary_memory_id, predecessorBoxId: row.predecessor_box_id, compressionCount: Number(row.compression_count), sealed: Boolean(row.sealed), members: members.map((item) => ({ memoryId: item.memory_id, state: item.member_state, ordinal: Number(item.ordinal) })), createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
  }

  putEventBox(box, { expectedVersion } = {}) {
    const id = clean(box.eventBoxId || box.id), characterId = clean(box.characterId || box.charId);
    if (!id || !characterId) throw Object.assign(new Error("eventBoxId and characterId are required"), { code: "VALIDATION_FAILED", status: 400 });
    const current = this.db.prepare("SELECT row_version,content_hash,created_at,deleted_at FROM v2_event_boxes WHERE event_box_id=?").get(id);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current?.row_version || 0)) throw Object.assign(new Error("EventBox version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: Number(current?.row_version || 0) } });
    const liveMemoryIds = list(box.liveMemoryIds), archivedMemoryIds = list(box.archivedMemoryIds), summaryNodeId = clean(box.summaryMemoryId || box.summaryNodeId);
    const normalized = { ...box, id, charId: characterId, liveMemoryIds, archivedMemoryIds, summaryNodeId: summaryNodeId || undefined }, contentHash = this.contentHash(normalized);
    if (current && !current.deleted_at && current.content_hash === contentHash) return { created: false, changed: false, eventBox: this.getEventBox(id) };
    const version = Number(current?.row_version || 0) + 1, updatedAt = nowIso(), createdAt = current?.created_at || iso(box.createdAt, updatedAt);
    this.db.prepare(`INSERT INTO v2_event_boxes(event_box_id,row_version,character_id,name,tags_json,summary_memory_id,predecessor_box_id,compression_count,sealed,created_at,updated_at,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(event_box_id) DO UPDATE SET row_version=excluded.row_version,character_id=excluded.character_id,name=excluded.name,tags_json=excluded.tags_json,summary_memory_id=excluded.summary_memory_id,predecessor_box_id=excluded.predecessor_box_id,compression_count=excluded.compression_count,sealed=excluded.sealed,updated_at=excluded.updated_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`)
      .run(id, version, characterId, clean(box.name), JSON.stringify(list(box.tags)), summaryNodeId || null, clean(box.predecessorBoxId) || null, Number(box.compressionCount || 0), boolInt(box.sealed), createdAt, updatedAt, JSON.stringify(normalized), contentHash);
    const desired = new Map();
    liveMemoryIds.forEach((memoryId, ordinal) => desired.set(`${clean(memoryId)}\0live`, [clean(memoryId), "live", ordinal]));
    archivedMemoryIds.forEach((memoryId, ordinal) => desired.set(`${clean(memoryId)}\0archived`, [clean(memoryId), "archived", ordinal]));
    if (summaryNodeId) desired.set(`${summaryNodeId}\0summary`, [summaryNodeId, "summary", 0]);
    const existing = this.db.prepare("SELECT memory_id,member_state FROM v2_event_box_members WHERE event_box_id=? AND deleted_at IS NULL").all(id);
    for (const member of existing) if (!desired.has(`${member.memory_id}\0${member.member_state}`)) this.db.prepare("UPDATE v2_event_box_members SET deleted_at=? WHERE event_box_id=? AND memory_id=? AND member_state=?").run(updatedAt, id, member.memory_id, member.member_state);
    const memberUpsert = this.db.prepare(`INSERT INTO v2_event_box_members(event_box_id,memory_id,member_state,ordinal,deleted_at) VALUES(?,?,?,?,NULL)
      ON CONFLICT(event_box_id,memory_id,member_state) DO UPDATE SET ordinal=excluded.ordinal,deleted_at=NULL`);
    for (const [memoryId, state, ordinal] of desired.values()) if (memoryId) memberUpsert.run(id, memoryId, state, ordinal);
    return { created: !current, changed: true, eventBox: this.getEventBox(id) };
  }

  deleteEventBox(eventBoxId, { expectedVersion } = {}) {
    const current = this.getEventBox(eventBoxId);
    if (!current || current.deletedAt) throw Object.assign(new Error("EventBox was not found"), { code: "NOT_FOUND", status: 404 });
    if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) throw Object.assign(new Error("EventBox version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: current.version } });
    const now = nowIso();
    this.db.prepare("UPDATE v2_event_boxes SET row_version=row_version+1,updated_at=?,deleted_at=? WHERE event_box_id=?").run(now, now, eventBoxId);
    this.db.prepare("UPDATE v2_event_box_members SET deleted_at=? WHERE event_box_id=? AND deleted_at IS NULL").run(now, eventBoxId);
    return this.getEventBox(eventBoxId);
  }

  getRoomPlate(roomPlateId) {
    const row = this.db.prepare("SELECT * FROM v2_room_plates WHERE room_plate_id=?").get(roomPlateId);
    if (!row) return null;
    const entries = this.db.prepare("SELECT entry_id,text,tag,first_learned_at,updated_at,source_count,ordinal FROM v2_room_plate_entries WHERE room_plate_id=? AND deleted_at IS NULL ORDER BY ordinal,entry_id").all(roomPlateId);
    return { roomPlateId: row.room_plate_id, version: Number(row.row_version), sourceVersion: Number(row.version), characterId: row.character_id, room: row.room, entries: entries.map((item) => ({ entryId: item.entry_id, text: item.text, tag: item.tag, firstLearnedAt: item.first_learned_at, updatedAt: item.updated_at, sourceCount: Number(item.source_count), ordinal: Number(item.ordinal) })), updatedAt: row.updated_at, deletedAt: row.deleted_at };
  }

  putRoomPlate(plate, { expectedVersion } = {}) {
    const characterId = clean(plate.characterId || plate.charId), room = clean(plate.room), id = clean(plate.roomPlateId || plate.id, `${characterId}:${room}`);
    if (!id || !characterId || !room) throw Object.assign(new Error("roomPlateId, characterId and room are required"), { code: "VALIDATION_FAILED", status: 400 });
    const current = this.db.prepare("SELECT row_version,content_hash,deleted_at FROM v2_room_plates WHERE room_plate_id=?").get(id);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current?.row_version || 0)) throw Object.assign(new Error("RoomPlate version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: Number(current?.row_version || 0) } });
    const entries = list(plate.entries).map((entry, ordinal) => ({ ...entry, id: clean(entry.entryId || entry.id, `${id}:entry:${ordinal}`) }));
    const normalized = { ...plate, id, charId: characterId, room, entries }, contentHash = this.contentHash(normalized);
    if (current && !current.deleted_at && current.content_hash === contentHash) return { created: false, changed: false, roomPlate: this.getRoomPlate(id) };
    const rowVersion = Number(current?.row_version || 0) + 1, updatedAt = nowIso();
    this.db.prepare(`INSERT INTO v2_room_plates(room_plate_id,row_version,character_id,room,version,updated_at,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(room_plate_id) DO UPDATE SET row_version=excluded.row_version,character_id=excluded.character_id,room=excluded.room,version=excluded.version,updated_at=excluded.updated_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`)
      .run(id, rowVersion, characterId, room, Number(plate.sourceVersion || plate.version || rowVersion), updatedAt, JSON.stringify(normalized), contentHash);
    const desiredIds = new Set(entries.map((entry) => entry.id));
    const existing = this.db.prepare("SELECT entry_id FROM v2_room_plate_entries WHERE room_plate_id=? AND deleted_at IS NULL").all(id);
    for (const entry of existing) if (!desiredIds.has(entry.entry_id)) this.db.prepare("UPDATE v2_room_plate_entries SET deleted_at=? WHERE entry_id=?").run(updatedAt, entry.entry_id);
    const entryUpsert = this.db.prepare(`INSERT INTO v2_room_plate_entries(entry_id,room_plate_id,character_id,room,text,tag,first_learned_at,updated_at,source_count,ordinal,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(entry_id) DO UPDATE SET room_plate_id=excluded.room_plate_id,character_id=excluded.character_id,room=excluded.room,text=excluded.text,tag=excluded.tag,first_learned_at=excluded.first_learned_at,updated_at=excluded.updated_at,source_count=excluded.source_count,ordinal=excluded.ordinal,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`);
    entries.forEach((entry, ordinal) => entryUpsert.run(entry.id, id, characterId, room, clean(entry.text), clean(entry.tag), entry.firstLearnedAt ? iso(entry.firstLearnedAt) : null, iso(entry.updatedAt, updatedAt), Number(entry.sourceCount || 1), ordinal, JSON.stringify(entry), this.contentHash(entry)));
    return { created: !current, changed: true, roomPlate: this.getRoomPlate(id) };
  }

  deleteRoomPlate(roomPlateId, { expectedVersion } = {}) {
    const current = this.getRoomPlate(roomPlateId);
    if (!current || current.deletedAt) throw Object.assign(new Error("RoomPlate was not found"), { code: "NOT_FOUND", status: 404 });
    if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) throw Object.assign(new Error("RoomPlate version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: current.version } });
    const now = nowIso();
    this.db.prepare("UPDATE v2_room_plates SET row_version=row_version+1,updated_at=?,deleted_at=? WHERE room_plate_id=?").run(now, now, roomPlateId);
    this.db.prepare("UPDATE v2_room_plate_entries SET deleted_at=? WHERE room_plate_id=? AND deleted_at IS NULL").run(now, roomPlateId);
    return this.getRoomPlate(roomPlateId);
  }

  getAnticipation(anticipationId) {
    const row = this.db.prepare("SELECT * FROM v2_anticipations WHERE anticipation_id=?").get(anticipationId);
    return row ? { anticipationId: row.anticipation_id, version: Number(row.row_version), characterId: row.character_id, content: row.content, status: row.status, createdAt: row.created_at, anchoredAt: row.anchored_at, resolvedAt: row.resolved_at, deletedAt: row.deleted_at } : null;
  }

  putAnticipation(item, { expectedVersion } = {}) {
    const id = clean(item.anticipationId || item.id), characterId = clean(item.characterId || item.charId);
    if (!id || !characterId || !clean(item.content)) throw Object.assign(new Error("anticipationId, characterId and content are required"), { code: "VALIDATION_FAILED", status: 400 });
    const current = this.db.prepare("SELECT row_version,content_hash,created_at,deleted_at FROM v2_anticipations WHERE anticipation_id=?").get(id);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current?.row_version || 0)) throw Object.assign(new Error("Anticipation version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: Number(current?.row_version || 0) } });
    const normalized = { ...item, id, charId: characterId }, contentHash = this.contentHash(normalized);
    if (current && !current.deleted_at && current.content_hash === contentHash) return { created: false, changed: false, anticipation: this.getAnticipation(id) };
    const version = Number(current?.row_version || 0) + 1, createdAt = current?.created_at || iso(item.createdAt), anchoredAt = item.anchoredAt ? iso(item.anchoredAt) : null, resolvedAt = item.resolvedAt ? iso(item.resolvedAt) : null;
    this.db.prepare(`INSERT INTO v2_anticipations(anticipation_id,row_version,character_id,content,status,created_at,anchored_at,resolved_at,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(anticipation_id) DO UPDATE SET row_version=excluded.row_version,character_id=excluded.character_id,content=excluded.content,status=excluded.status,anchored_at=excluded.anchored_at,resolved_at=excluded.resolved_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`)
      .run(id, version, characterId, clean(item.content), clean(item.status, "active"), createdAt, anchoredAt, resolvedAt, JSON.stringify(normalized), contentHash);
    return { created: !current, changed: true, anticipation: this.getAnticipation(id) };
  }

  deleteAnticipation(anticipationId, { expectedVersion } = {}) {
    const current = this.getAnticipation(anticipationId);
    if (!current || current.deletedAt) throw Object.assign(new Error("Anticipation was not found"), { code: "NOT_FOUND", status: 404 });
    if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) throw Object.assign(new Error("Anticipation version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: current.version } });
    const now = nowIso();
    this.db.prepare("UPDATE v2_anticipations SET row_version=row_version+1,deleted_at=? WHERE anticipation_id=?").run(now, anticipationId);
    return this.getAnticipation(anticipationId);
  }

  getDigestReport(digestReportId) {
    const row = this.db.prepare("SELECT * FROM v2_digest_reports WHERE digest_report_id=?").get(digestReportId);
    return row ? { digestReportId: row.digest_report_id, version: Number(row.row_version), characterId: row.character_id, trigger: row.trigger_type, createdAt: row.created_at, examined: JSON.parse(row.examined_json || "[]"), outcomes: JSON.parse(row.outcomes_json || "[]"), plateSubmissions: JSON.parse(row.plate_submissions_json || "[]"), plateUpdated: JSON.parse(row.plate_updated_json || "[]"), deletedAt: row.deleted_at } : null;
  }

  putDigestReport(report, { expectedVersion } = {}) {
    const id = clean(report.digestReportId || report.id), characterId = clean(report.characterId || report.charId);
    if (!id || !characterId) throw Object.assign(new Error("digestReportId and characterId are required"), { code: "VALIDATION_FAILED", status: 400 });
    const current = this.db.prepare("SELECT row_version,content_hash,created_at,deleted_at FROM v2_digest_reports WHERE digest_report_id=?").get(id);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current?.row_version || 0)) throw Object.assign(new Error("Digest report version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: Number(current?.row_version || 0) } });
    const normalized = { ...report, id, charId: characterId }, contentHash = this.contentHash(normalized);
    if (current && !current.deleted_at && current.content_hash === contentHash) return { created: false, changed: false, digestReport: this.getDigestReport(id) };
    const version = Number(current?.row_version || 0) + 1, createdAt = current?.created_at || iso(report.createdAt);
    this.db.prepare(`INSERT INTO v2_digest_reports(digest_report_id,row_version,character_id,trigger_type,created_at,examined_json,outcomes_json,plate_submissions_json,plate_updated_json,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(digest_report_id) DO UPDATE SET row_version=excluded.row_version,character_id=excluded.character_id,trigger_type=excluded.trigger_type,examined_json=excluded.examined_json,outcomes_json=excluded.outcomes_json,plate_submissions_json=excluded.plate_submissions_json,plate_updated_json=excluded.plate_updated_json,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`)
      .run(id, version, characterId, clean(report.trigger || report.triggerType), createdAt, JSON.stringify(list(report.examined)), JSON.stringify(list(report.outcomes)), JSON.stringify(list(report.plateSubmissions)), JSON.stringify(list(report.plateUpdated)), JSON.stringify(normalized), contentHash);
    return { created: !current, changed: true, digestReport: this.getDigestReport(id) };
  }

  deleteDigestReport(digestReportId, { expectedVersion } = {}) {
    const current = this.getDigestReport(digestReportId);
    if (!current || current.deletedAt) throw Object.assign(new Error("Digest report was not found"), { code: "NOT_FOUND", status: 404 });
    if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) throw Object.assign(new Error("Digest report version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: current.version } });
    const now = nowIso();
    this.db.prepare("UPDATE v2_digest_reports SET row_version=row_version+1,deleted_at=? WHERE digest_report_id=?").run(now, digestReportId);
    return this.getDigestReport(digestReportId);
  }

  getCharacterState(characterId) {
    const row = this.db.prepare("SELECT * FROM v2_character_runtime_state WHERE character_id=?").get(characterId);
    return row ? { characterId: row.character_id, version: Number(row.version), state: JSON.parse(row.state_json || "{}"), hash: row.content_hash, updatedAt: row.updated_at, deletedAt: row.deleted_at } : null;
  }

  putCharacterState(characterId, state, { expectedVersion } = {}) {
    const id = clean(characterId), current = this.getCharacterState(id);
    if (!id || !state || typeof state !== "object" || Array.isArray(state)) throw Object.assign(new Error("characterId and object state are required"), { code: "VALIDATION_FAILED", status: 400 });
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current?.version || 0)) throw Object.assign(new Error("Character state version conflict"), { code: "VERSION_CONFLICT", status: 409, details: { currentVersion: Number(current?.version || 0) } });
    const hash = this.contentHash(state);
    if (current && !current.deletedAt && current.hash === hash) return { changed: false, state: current };
    const version = Number(current?.version || 0) + 1, now = nowIso();
    this.db.prepare(`INSERT INTO v2_character_runtime_state(character_id,version,state_json,content_hash,updated_at,deleted_at) VALUES(?,?,?,?,?,NULL)
      ON CONFLICT(character_id) DO UPDATE SET version=excluded.version,state_json=excluded.state_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at,deleted_at=NULL`).run(id, version, JSON.stringify(state), hash, now);
    return { changed: true, state: this.getCharacterState(id) };
  }

  appendStateEvent(characterId, stateVersion, patch, commandId, occurredAt = nowIso()) {
    const result = this.db.prepare("INSERT INTO v2_runtime_state_events(character_id,state_version,patch_json,command_id,occurred_at) VALUES(?,?,?,?,?)")
      .run(characterId, Number(stateVersion), JSON.stringify(patch || {}), commandId || null, occurredAt);
    return Number(result.lastInsertRowid);
  }

  getCcSession(characterId) {
    const row = this.db.prepare("SELECT * FROM v2_cc_sessions WHERE character_id=?").get(characterId);
    return row ? { characterId: row.character_id, runtimeType: row.runtime_type, sessionId: row.session_id, lastSeenMessageSeq: Number(row.last_seen_message_seq), lastSeenEventId: Number(row.last_seen_event_id), stableContextVersion: Number(row.stable_context_version), stableContextHash: row.stable_context_hash, lastWakeAt: row.last_wake_at, lastCompactedAt: row.last_compacted_at, status: row.status, updatedAt: row.updated_at } : null;
  }

  putCcSession(characterId, patch = {}) {
    const current = this.getCcSession(characterId), now = nowIso();
    const next = { runtimeType: clean(patch.runtimeType || current?.runtimeType, "claude-code"), sessionId: (patch.sessionId === undefined ? current?.sessionId : clean(patch.sessionId) || null) ?? null, lastSeenMessageSeq: Number(patch.lastSeenMessageSeq ?? current?.lastSeenMessageSeq ?? 0), lastSeenEventId: Number(patch.lastSeenEventId ?? current?.lastSeenEventId ?? 0), stableContextVersion: Number(patch.stableContextVersion ?? current?.stableContextVersion ?? 0), stableContextHash: (patch.stableContextHash === undefined ? current?.stableContextHash : clean(patch.stableContextHash) || null) ?? null, lastWakeAt: (patch.lastWakeAt === undefined ? current?.lastWakeAt : patch.lastWakeAt) ?? null, lastCompactedAt: (patch.lastCompactedAt === undefined ? current?.lastCompactedAt : patch.lastCompactedAt) ?? null, status: clean(patch.status || current?.status, "idle") };
    this.db.prepare(`INSERT INTO v2_cc_sessions(character_id,runtime_type,session_id,last_seen_message_seq,last_seen_event_id,stable_context_version,stable_context_hash,last_wake_at,last_compacted_at,status,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET runtime_type=excluded.runtime_type,session_id=excluded.session_id,last_seen_message_seq=excluded.last_seen_message_seq,last_seen_event_id=excluded.last_seen_event_id,stable_context_version=excluded.stable_context_version,stable_context_hash=excluded.stable_context_hash,last_wake_at=excluded.last_wake_at,last_compacted_at=excluded.last_compacted_at,status=excluded.status,updated_at=excluded.updated_at`)
      .run(characterId, next.runtimeType, next.sessionId, next.lastSeenMessageSeq, next.lastSeenEventId, next.stableContextVersion, next.stableContextHash, next.lastWakeAt, next.lastCompactedAt, next.status, now);
    return this.getCcSession(characterId);
  }

  getCcWakeRun(wakeRunId) {
    const row = this.db.prepare("SELECT * FROM v2_cc_wake_runs WHERE wake_run_id=?").get(wakeRunId);
    return row ? { wakeRunId: row.wake_run_id, characterId: row.character_id, jobId: row.job_id, sessionId: row.session_id, wakeReason: row.wake_reason, contextFromMessageSeq: Number(row.context_from_message_seq), contextToMessageSeq: Number(row.context_to_message_seq), contextFromEventId: Number(row.context_from_event_id), contextToEventId: Number(row.context_to_event_id), status: row.status, attemptCount: Number(row.attempt_count), leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at, context: row.context_json ? JSON.parse(row.context_json) : null, contextHash: row.context_hash, startedAt: row.started_at, updatedAt: row.updated_at, completedAt: row.completed_at, resultEventId: row.result_event_id == null ? null : Number(row.result_event_id), error: row.error_text } : null;
  }

  createCcWakeRun({ wakeRunId = randomUUID(), characterId, jobId = null, sessionId = null, wakeReason = "autonomy.wake" } = {}) {
    const existing = jobId ? this.db.prepare("SELECT wake_run_id FROM v2_cc_wake_runs WHERE job_id=?").get(jobId) : null;
    if (existing) return { created: false, wakeRun: this.getCcWakeRun(existing.wake_run_id) };
    const now = nowIso();
    this.db.prepare(`INSERT INTO v2_cc_wake_runs(wake_run_id,character_id,job_id,session_id,wake_reason,status,attempt_count,started_at,updated_at)
      VALUES(?,?,?,?,?,'queued',0,?,?)`).run(wakeRunId, characterId, jobId, sessionId, wakeReason, now, now);
    return { created: true, wakeRun: this.getCcWakeRun(wakeRunId) };
  }

  claimCcWakeRun({ characterId = "", leaseMs = 10 * 60 * 1000 } = {}) {
    const now = nowIso(), where = characterId ? "AND character_id=?" : "", args = characterId ? [characterId] : [];
    const row = this.db.prepare(`SELECT wake_run_id FROM v2_cc_wake_runs WHERE (status='queued' OR (status='running' AND lease_expires_at<=?)) ${where} ORDER BY started_at LIMIT 1`).get(now, ...args);
    if (!row) return null;
    const token = randomUUID(), expires = new Date(Date.now() + Math.max(60_000, Number(leaseMs) || 600_000)).toISOString();
    const changed = Number(this.db.prepare("UPDATE v2_cc_wake_runs SET status='running',attempt_count=attempt_count+1,lease_token=?,lease_expires_at=?,updated_at=? WHERE wake_run_id=? AND (status='queued' OR (status='running' AND lease_expires_at<=?))").run(token, expires, now, row.wake_run_id, now).changes || 0);
    return changed ? this.getCcWakeRun(row.wake_run_id) : null;
  }

  attachCcWakeContext(wakeRunId, leaseToken, context, { fromMessageSeq = 0, toMessageSeq = 0, fromEventId = 0, toEventId = 0, sessionId = null } = {}) {
    const hash = this.contentHash(context), now = nowIso();
    const changed = Number(this.db.prepare("UPDATE v2_cc_wake_runs SET context_from_message_seq=?,context_to_message_seq=?,context_from_event_id=?,context_to_event_id=?,session_id=?,context_json=?,context_hash=?,updated_at=? WHERE wake_run_id=? AND status='running' AND lease_token=?").run(Number(fromMessageSeq), Number(toMessageSeq), Number(fromEventId), Number(toEventId), sessionId, JSON.stringify(context), hash, now, wakeRunId, leaseToken).changes || 0);
    if (!changed) throw Object.assign(new Error("Wake lease is no longer valid"), { code: "WAKE_LEASE_CONFLICT", status: 409 });
    return this.getCcWakeRun(wakeRunId);
  }

  retryCcWakeRun(wakeRunId, leaseToken, error = "CC wake will be retried") {
    const now = nowIso();
    const changed = Number(this.db.prepare("UPDATE v2_cc_wake_runs SET status='queued',error_text=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE wake_run_id=? AND status='running' AND lease_token=?")
      .run(String(error).slice(0, 12000), now, wakeRunId, leaseToken).changes || 0);
    if (!changed) throw new Error(`CC wake ${wakeRunId} is not owned by this lease`);
    return this.getCcWakeRun(wakeRunId);
  }

  completeCcWakeRun(wakeRunId, leaseToken, { resultEventId = null, error = null } = {}) {
    const now = nowIso(), status = error ? "failed" : "completed";
    const changed = Number(this.db.prepare("UPDATE v2_cc_wake_runs SET status=?,completed_at=?,updated_at=?,result_event_id=?,error_text=?,lease_token=NULL,lease_expires_at=NULL WHERE wake_run_id=? AND status='running' AND lease_token=?").run(status, now, now, resultEventId, error ? String(error).slice(0, 12000) : null, wakeRunId, leaseToken).changes || 0);
    if (!changed) throw Object.assign(new Error("Wake lease is no longer valid"), { code: "WAKE_LEASE_CONFLICT", status: 409 });
    return this.getCcWakeRun(wakeRunId);
  }

  syncRows({ items, table, idColumn, hashColumn = "content_hash", itemId, itemHash = (item) => this.contentHash(item), upsert, tombstone }) {
    const existing = new Map(this.db.prepare(`SELECT ${idColumn} AS id,${hashColumn} AS hash,deleted_at FROM ${table}`).all().map((row) => [row.id, row]));
    const incoming = new Set();
    let changed = 0;
    items.forEach((item, index) => {
      const id = itemId(item, index);
      if (!id) return;
      incoming.add(id);
      const hash = itemHash(item, index);
      const before = existing.get(id);
      if (!before || before.hash !== hash || before.deleted_at) {
        upsert(item, index, id, hash);
        changed += 1;
      }
    });
    for (const [id, before] of existing) {
      if (!incoming.has(id) && !before.deleted_at) {
        tombstone(id, nowIso());
        changed += 1;
      }
    }
    return changed;
  }

  replaceMessages({ allMessages = [], changedMessages = [], removedMessages = [], sourceHash, sourceVersion = 0 }) {
    const domainKey = "message:all";
    if (this.isCurrent(domainKey, sourceHash)) return { skipped: true, changedRows: 0 };
    const baseline = this.state(domainKey);
    const hasTrustedBaseline = baseline?.status === "current";
    const candidates = hasTrustedBaseline ? changedMessages : allMessages.map((item, index) => ({ item, sequenceNo: index + 1 }));
    const upsert = this.db.prepare(`INSERT INTO v2_messages(message_id,source_sequence_no,character_id,conversation_id,turn_id,role,message_type,content,surface,visibility,origin,source_client_id,source_message_id,metadata_json,raw_json,content_hash,occurred_at,created_at,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(message_id) DO UPDATE SET source_sequence_no=excluded.source_sequence_no,character_id=excluded.character_id,conversation_id=excluded.conversation_id,turn_id=excluded.turn_id,role=excluded.role,message_type=excluded.message_type,content=excluded.content,surface=excluded.surface,visibility=excluded.visibility,origin=excluded.origin,metadata_json=excluded.metadata_json,raw_json=excluded.raw_json,content_hash=excluded.content_hash,occurred_at=excluded.occurred_at,deleted_at=NULL`);
    let changedRows = 0;
    for (const change of candidates) {
      const item = change.item || change;
      const charId = clean(change.charId || item.charId || item.characterId, "unbound");
      const sourceId = clean(change.messageId || item.id || item.messageId || item.sourceId, `seq:${change.sequenceNo || 0}`);
      const occurredAt = iso(item.timestamp ?? item.createdAt);
      const raw = JSON.stringify(item);
      const result = upsert.run(messageId(charId, sourceId), Number(change.sequenceNo || 0) || null, charId, clean(item.conversationId, `direct:me:${charId}`), clean(item.turnId) || null, clean(item.role, "user"), clean(item.type, "text"), clean(item.content ?? item.text), clean(item.surface, "chat"), clean(item.visibility, item.surface === "chat" ? "user" : "internal"), clean(item.origin, "legacy"), "legacy-runtime", sourceId, JSON.stringify(item.metadata || {}), raw, change.hash || this.contentHash(item), occurredAt, iso(item.createdAt, occurredAt));
      changedRows += Number(result.changes || 0);
    }
    const tombstone = this.db.prepare("UPDATE v2_messages SET deleted_at=? WHERE message_id=? AND deleted_at IS NULL");
    if (!hasTrustedBaseline) {
      const active = new Set(allMessages.map((item, index) => {
        const charId = clean(item.charId || item.characterId, "unbound");
        const sourceId = clean(item.id || item.messageId || item.sourceId, `seq:${index + 1}`);
        return messageId(charId, sourceId);
      }));
      for (const row of this.db.prepare("SELECT message_id FROM v2_messages WHERE deleted_at IS NULL").all()) if (!active.has(row.message_id)) changedRows += Number(tombstone.run(nowIso(), row.message_id).changes || 0);
    } else {
      for (const removed of removedMessages) changedRows += Number(tombstone.run(nowIso(), messageId(removed.charId, removed.messageId)).changes || 0);
    }
    this.markCurrent(domainKey, sourceHash, sourceVersion, allMessages.length);
    return { skipped: false, changedRows };
  }

  replaceDomain(domainKey, data, { sourceHash, sourceVersion = 0 } = {}) {
    if (!domainKey.startsWith("hub:")) return { skipped: true, reason: "not_hub_domain" };
    const domain = domainKey.slice(4);
    if (!supportedDomains.has(domain)) return { skipped: true, reason: "unsupported_domain" };
    if (this.isCurrent(domainKey, sourceHash)) return { skipped: true, changedRows: 0 };
    const items = domain === "characterRuntime"
      ? (Array.isArray(data) ? data : Object.entries(data || {}).map(([characterId, state]) => ({ characterId, ...(state || {}) })))
      : list(data);
    const changedRows = this[`replace_${domain}`](items);
    this.syncSourceOrder(domainKey, domain, items);
    this.markCurrent(domainKey, sourceHash, sourceVersion, items.length);
    return { skipped: false, changedRows };
  }

  syncSourceOrder(domainKey, domain, items) {
    const at = nowIso();
    this.db.prepare("UPDATE v2_source_order SET deleted_at=? WHERE domain_key=? AND deleted_at IS NULL").run(at, domainKey);
    const upsert = this.db.prepare(`INSERT INTO v2_source_order(domain_key,object_id,ordinal,updated_at,deleted_at) VALUES(?,?,?,?,NULL)
      ON CONFLICT(domain_key,object_id) DO UPDATE SET ordinal=excluded.ordinal,updated_at=excluded.updated_at,deleted_at=NULL`);
    items.forEach((item, index) => {
      const id = domainObjectId(domain, item, index);
      if (id) upsert.run(domainKey, id, index, at);
    });
  }

  replace_memories(items) {
    const upsert = this.db.prepare(`INSERT INTO v2_memory_nodes(memory_id,character_id,room,content,title,importance,mood,tags_json,event_box_id,archived,is_box_summary,embedded,occurred_at,created_at,updated_at,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(memory_id) DO UPDATE SET character_id=excluded.character_id,room=excluded.room,content=excluded.content,title=excluded.title,importance=excluded.importance,mood=excluded.mood,tags_json=excluded.tags_json,event_box_id=excluded.event_box_id,archived=excluded.archived,is_box_summary=excluded.is_box_summary,embedded=excluded.embedded,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`);
    return this.syncRows({ items, table: "v2_memory_nodes", idColumn: "memory_id", itemId: (item, i) => clean(item.id, `legacy-memory:${i}`), upsert: (item, _i, id, hash) => { const created = iso(item.createdAt ?? item.occurredAt); upsert.run(id, clean(item.charId, "unbound"), clean(item.room, "living_room"), clean(item.content), clean(item.title), Number(item.importance || 0), clean(item.mood), JSON.stringify(list(item.tags)), clean(item.eventBoxId) || null, boolInt(item.archived), boolInt(item.isBoxSummary), boolInt(item.embedded), item.occurredAt == null ? null : iso(item.occurredAt), created, iso(item.updatedAt, created), JSON.stringify(item), hash); }, tombstone: (id, at) => this.db.prepare("UPDATE v2_memory_nodes SET deleted_at=? WHERE memory_id=?").run(at, id) });
  }

  replace_vectors(items) {
    const upsert = this.db.prepare(`INSERT INTO v2_memory_vectors(memory_id,character_id,model,dimensions,vector_blob,vector_hash,source_vector_field,source_had_dimensions,updated_at,raw_metadata_json,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(memory_id) DO UPDATE SET character_id=excluded.character_id,model=excluded.model,dimensions=excluded.dimensions,vector_blob=excluded.vector_blob,vector_hash=excluded.vector_hash,source_vector_field=excluded.source_vector_field,source_had_dimensions=excluded.source_had_dimensions,updated_at=excluded.updated_at,raw_metadata_json=excluded.raw_metadata_json,deleted_at=NULL`);
    return this.syncRows({ items: items.filter((item) => clean(item.memoryId) && (list(item.vector).length || list(item.embedding).length)), table: "v2_memory_vectors", idColumn: "memory_id", hashColumn: "vector_hash", itemId: (item) => clean(item.memoryId), itemHash: (item) => sha256(vectorBuffer(list(item.vector).length ? item.vector : item.embedding)), upsert: (item, _i, id, hash) => { const field = list(item.vector).length ? "vector" : "embedding"; const values = item[field]; const metadata = { ...item }; delete metadata.vector; delete metadata.embedding; upsert.run(id, clean(item.charId) || null, clean(item.model), values.length, vectorBuffer(values), hash, field, Object.hasOwn(item, "dimensions") ? 1 : 0, iso(item.updatedAt), JSON.stringify(metadata)); }, tombstone: (id, at) => this.db.prepare("UPDATE v2_memory_vectors SET deleted_at=? WHERE memory_id=?").run(at, id) });
  }

  replace_links(items) {
    const upsert = this.db.prepare(`INSERT INTO v2_memory_links(link_id,character_id,source_memory_id,target_memory_id,link_type,strength,activation_count,last_activated_at,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(link_id) DO UPDATE SET character_id=excluded.character_id,source_memory_id=excluded.source_memory_id,target_memory_id=excluded.target_memory_id,link_type=excluded.link_type,strength=excluded.strength,activation_count=excluded.activation_count,last_activated_at=excluded.last_activated_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`);
    return this.syncRows({ items, table: "v2_memory_links", idColumn: "link_id", itemId: (item, i) => clean(item.id, `legacy-link:${i}`), upsert: (item, i, id, hash) => upsert.run(id, clean(item.charId) || null, clean(item.sourceId, `missing:${i}:source`), clean(item.targetId, `missing:${i}:target`), clean(item.type, "related"), Number(item.strength || 0), Number(item.activationCount || 0), item.lastActivatedAt ? iso(item.lastActivatedAt) : null, JSON.stringify(item), hash), tombstone: (id, at) => this.db.prepare("UPDATE v2_memory_links SET deleted_at=? WHERE link_id=?").run(at, id) });
  }

  replace_eventBoxes(items) {
    const upsert = this.db.prepare(`INSERT INTO v2_event_boxes(event_box_id,character_id,name,tags_json,summary_memory_id,predecessor_box_id,compression_count,sealed,created_at,updated_at,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(event_box_id) DO UPDATE SET character_id=excluded.character_id,name=excluded.name,tags_json=excluded.tags_json,summary_memory_id=excluded.summary_memory_id,predecessor_box_id=excluded.predecessor_box_id,compression_count=excluded.compression_count,sealed=excluded.sealed,updated_at=excluded.updated_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`);
    const member = this.db.prepare(`INSERT INTO v2_event_box_members(event_box_id,memory_id,member_state,ordinal,deleted_at) VALUES(?,?,?,?,NULL)
      ON CONFLICT(event_box_id,memory_id,member_state) DO UPDATE SET ordinal=excluded.ordinal,deleted_at=NULL`);
    return this.syncRows({ items, table: "v2_event_boxes", idColumn: "event_box_id", itemId: (item, i) => clean(item.id, `legacy-event-box:${i}`), upsert: (item, _i, id, hash) => { const created = iso(item.createdAt); upsert.run(id, clean(item.charId, "unbound"), clean(item.name), JSON.stringify(list(item.tags)), clean(item.summaryNodeId) || null, clean(item.predecessorBoxId) || null, Number(item.compressionCount || 0), boolInt(item.sealed), created, iso(item.updatedAt, created), JSON.stringify(item), hash); const at = nowIso(); this.db.prepare("UPDATE v2_event_box_members SET deleted_at=? WHERE event_box_id=? AND deleted_at IS NULL").run(at, id); list(item.liveMemoryIds).forEach((memoryId, ordinal) => member.run(id, clean(memoryId), "live", ordinal)); list(item.archivedMemoryIds).forEach((memoryId, ordinal) => member.run(id, clean(memoryId), "archived", ordinal)); if (clean(item.summaryNodeId)) member.run(id, clean(item.summaryNodeId), "summary", 0); }, tombstone: (id, at) => { this.db.prepare("UPDATE v2_event_boxes SET deleted_at=? WHERE event_box_id=?").run(at, id); this.db.prepare("UPDATE v2_event_box_members SET deleted_at=? WHERE event_box_id=? AND deleted_at IS NULL").run(at, id); } });
  }

  replace_roomPlates(items) {
    const upsert = this.db.prepare(`INSERT INTO v2_room_plates(room_plate_id,character_id,room,version,updated_at,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(room_plate_id) DO UPDATE SET character_id=excluded.character_id,room=excluded.room,version=excluded.version,updated_at=excluded.updated_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`);
    const entry = this.db.prepare(`INSERT INTO v2_room_plate_entries(entry_id,room_plate_id,character_id,room,text,tag,first_learned_at,updated_at,source_count,ordinal,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(entry_id) DO UPDATE SET room_plate_id=excluded.room_plate_id,character_id=excluded.character_id,room=excluded.room,text=excluded.text,tag=excluded.tag,first_learned_at=excluded.first_learned_at,updated_at=excluded.updated_at,source_count=excluded.source_count,ordinal=excluded.ordinal,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`);
    return this.syncRows({ items, table: "v2_room_plates", idColumn: "room_plate_id", itemId: (item) => clean(item.id, `${clean(item.charId, "unbound")}:${clean(item.room, "unknown")}`), upsert: (item, _i, id, hash) => { const charId = clean(item.charId, "unbound"), room = clean(item.room, "unknown"), updated = iso(item.updatedAt); upsert.run(id, charId, room, Number(item.version || 1), updated, JSON.stringify(item), hash); const at = nowIso(); this.db.prepare("UPDATE v2_room_plate_entries SET deleted_at=? WHERE room_plate_id=? AND deleted_at IS NULL").run(at, id); list(item.entries).forEach((value, ordinal) => { const raw = JSON.stringify(value); entry.run(clean(value.id, `${id}:entry:${ordinal}`), id, charId, room, clean(value.text), clean(value.tag), value.firstLearnedAt ? iso(value.firstLearnedAt) : null, iso(value.updatedAt, updated), Number(value.sourceCount || 1), ordinal, raw, this.contentHash(value)); }); }, tombstone: (id, at) => { this.db.prepare("UPDATE v2_room_plates SET deleted_at=? WHERE room_plate_id=?").run(at, id); this.db.prepare("UPDATE v2_room_plate_entries SET deleted_at=? WHERE room_plate_id=? AND deleted_at IS NULL").run(at, id); } });
  }

  replace_anticipations(items) {
    const upsert = this.db.prepare(`INSERT INTO v2_anticipations(anticipation_id,character_id,content,status,created_at,anchored_at,resolved_at,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(anticipation_id) DO UPDATE SET character_id=excluded.character_id,content=excluded.content,status=excluded.status,anchored_at=excluded.anchored_at,resolved_at=excluded.resolved_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`);
    return this.syncRows({ items, table: "v2_anticipations", idColumn: "anticipation_id", itemId: (item, i) => clean(item.id, `legacy-anticipation:${i}`), upsert: (item, _i, id, hash) => upsert.run(id, clean(item.charId, "unbound"), clean(item.content), clean(item.status, "active"), iso(item.createdAt), item.anchoredAt ? iso(item.anchoredAt) : null, item.resolvedAt ? iso(item.resolvedAt) : null, JSON.stringify(item), hash), tombstone: (id, at) => this.db.prepare("UPDATE v2_anticipations SET deleted_at=? WHERE anticipation_id=?").run(at, id) });
  }

  replace_digestReports(items) {
    const upsert = this.db.prepare(`INSERT INTO v2_digest_reports(digest_report_id,character_id,trigger_type,created_at,examined_json,outcomes_json,plate_submissions_json,plate_updated_json,raw_json,content_hash,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(digest_report_id) DO UPDATE SET character_id=excluded.character_id,trigger_type=excluded.trigger_type,examined_json=excluded.examined_json,outcomes_json=excluded.outcomes_json,plate_submissions_json=excluded.plate_submissions_json,plate_updated_json=excluded.plate_updated_json,raw_json=excluded.raw_json,content_hash=excluded.content_hash,deleted_at=NULL`);
    return this.syncRows({ items, table: "v2_digest_reports", idColumn: "digest_report_id", itemId: (item, i) => clean(item.id, `legacy-digest:${i}`), upsert: (item, _i, id, hash) => upsert.run(id, clean(item.charId, "unbound"), clean(item.trigger), iso(item.createdAt), JSON.stringify(list(item.examined)), JSON.stringify(list(item.outcomes)), JSON.stringify(list(item.plateSubmissions)), JSON.stringify(list(item.plateUpdated)), JSON.stringify(item), hash), tombstone: (id, at) => this.db.prepare("UPDATE v2_digest_reports SET deleted_at=? WHERE digest_report_id=?").run(at, id) });
  }

  replace_characterRuntime(items) {
    const upsert = this.db.prepare(`INSERT INTO v2_character_runtime_state(character_id,version,state_json,content_hash,updated_at,deleted_at)
      VALUES(?,?,?,?,?,NULL) ON CONFLICT(character_id) DO UPDATE SET version=excluded.version,state_json=excluded.state_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at,deleted_at=NULL`);
    return this.syncRows({ items, table: "v2_character_runtime_state", idColumn: "character_id", itemId: (item, i) => clean(item.characterId || item.charId || item.id, `unbound:${i}`), upsert: (item, _i, id, hash) => upsert.run(id, Number(item.version || 1), JSON.stringify(item), hash, iso(item.updatedAt)), tombstone: (id, at) => this.db.prepare("UPDATE v2_character_runtime_state SET deleted_at=? WHERE character_id=?").run(at, id) });
  }
}
