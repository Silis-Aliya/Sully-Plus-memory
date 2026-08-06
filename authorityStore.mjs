import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RuntimeV2Repository } from "./src/storage/runtimeV2Repository.mjs";

const ENTITY_ID_FIELDS = {
  character: ["characterId", "id"],
  userProfile: ["userId", "id"],
  worldbook: ["worldbookId", "id"],
  world: ["worldId", "id"],
};

const MIGRATION_ARRAY_DOMAINS = {
  messages: "message",
  scheduledMessages: "scheduled_message",
  dailySchedules: "daily_schedule",
  worldEpisodes: "world_episode",
  storyTheaters: "story_theater",
  storyTheaterPresets: "story_theater_preset",
  storyTheaterMasks: "story_theater_mask",
  groups: "group",
  characterGroups: "character_group",
  memoryNodes: "memory_node",
  memoryVectors: "memory_vector",
  memoryLinks: "memory_link",
  topicBoxes: "topic_box",
  anticipations: "anticipation",
  eventBoxes: "event_box",
  roomPlates: "room_plate",
  digestReports: "digest_report",
  memoryBatches: "memory_batch",
};

const MIGRATION_SINGLETON_DOMAINS = {
  lifeSimState: "life_sim_state",
  vrMusicRoom: "vr_music_room_state",
  vrGuestbook: "vr_guestbook_state",
  realtimeConfig: "realtime_config",
};

const SUPPORTED_TOP_LEVEL = new Set([
  "timestamp", "version", "type", "formatVersion", "migrationFormat", "mode", "createdAt",
  "characters", "userProfile", "worldbooks", "worlds",
  ...Object.keys(MIGRATION_ARRAY_DOMAINS),
  ...Object.keys(MIGRATION_SINGLETON_DOMAINS),
  "memoryPalaceHighWaterMarks", "memoryPalaceFlags", "memoryPalaceConfig",
]);

export class AuthorityError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function contentHash(value) {
  const hash = createHash("sha256");
  const visit = (item) => {
    if (item === undefined) { hash.update("undefined"); return; }
    if (item === null) { hash.update("null"); return; }
    if (Array.isArray(item)) {
      hash.update("[");
      item.forEach((entry, index) => { if (index) hash.update(","); visit(entry); });
      hash.update("]");
      return;
    }
    if (typeof item === "object") {
      hash.update("{");
      Object.keys(item).sort().forEach((key, index) => {
        if (index) hash.update(",");
        hash.update(JSON.stringify(key));
        hash.update(":");
        visit(item[key]);
      });
      hash.update("}");
      return;
    }
    hash.update(JSON.stringify(item) ?? "null");
  };
  visit(value);
  return hash.digest("hex");
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeId(value) {
  return String(value ?? "").trim();
}

function entityId(type, data) {
  for (const field of ENTITY_ID_FIELDS[type] || ["id"]) {
    const value = normalizeId(data?.[field]);
    if (value) return value;
  }
  return "";
}

function recordFromRow(row) {
  if (!row) return null;
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    version: Number(row.version),
    data: parseJson(row.data_json, {}),
    hash: row.content_hash,
    sourceAuthority: row.source_authority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function objectId(domain, item, index) {
  const candidates = [item?.id, item?.memoryId, item?.messageId, item?.taskUuid, item?.key];
  const found = candidates.map(normalizeId).find(Boolean);
  return found || `${domain}:${index}`;
}

function charReference(item) {
  return normalizeId(item?.charId || item?.characterId || item?.roleId || "");
}

function migrationSkeleton(source) {
  const sourceCounts = {};
  for (const key of ["characters", "worldbooks", "worlds", ...Object.keys(MIGRATION_ARRAY_DOMAINS)]) {
    sourceCounts[key] = Array.isArray(source?.[key]) ? source[key].length : 0;
  }
  sourceCounts.userProfile = source?.userProfile && typeof source.userProfile === "object" ? 1 : 0;
  for (const key of Object.keys(MIGRATION_SINGLETON_DOMAINS)) sourceCounts[key] = source?.[key] && typeof source[key] === "object" ? 1 : 0;
  sourceCounts.legacyFragments = (source?.characters || []).reduce((sum, item) => sum + (Array.isArray(item?.memories) ? item.memories.length : 0), 0);
  sourceCounts.legacyRefinedMonths = (source?.characters || []).reduce((sum, item) => sum + Object.keys(item?.refinedMemories || {}).length, 0);
  sourceCounts.impressions = (source?.characters || []).filter((item) => item?.impression).length;
  sourceCounts.activeBehaviorConfigs = (source?.characters || []).filter((item) => item?.activeMsg2Config || item?.proactiveConfig).length;
  sourceCounts.mounts = (source?.characters || []).reduce((sum, item) => sum + (Array.isArray(item?.mountedWorldbooks) ? item.mountedWorldbooks.length : 0), 0);
  return {
    sourceCounts,
    importedCounts: {},
    skippedCounts: {},
    missingReferences: [],
    unsupportedFields: Object.keys(source || {}).filter((key) => !SUPPORTED_TOP_LEVEL.has(key)).sort(),
    hashDifferences: [],
    warnings: [],
  };
}

export class AuthorityStore {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authority_entities (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_authority TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (entity_type, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_authority_entities_updated ON authority_entities(entity_type, updated_at DESC);
      CREATE TABLE IF NOT EXISTS authority_field_versions (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        PRIMARY KEY (entity_type, entity_id, field_name)
      );
      CREATE TABLE IF NOT EXISTS worldbook_mounts (
        character_id TEXT NOT NULL,
        worldbook_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (character_id, worldbook_id)
      );
      CREATE TABLE IF NOT EXISTS authority_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        from_version INTEGER,
        to_version INTEGER,
        before_hash TEXT,
        after_hash TEXT,
        command_id TEXT,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_authority_audit_entity ON authority_audit(entity_type, entity_id, audit_id DESC);
      CREATE TABLE IF NOT EXISTS migration_objects (
        domain TEXT NOT NULL,
        object_id TEXT NOT NULL,
        char_id TEXT,
        data_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_migration_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (domain, object_id)
      );
      CREATE INDEX IF NOT EXISTS idx_migration_objects_char ON migration_objects(domain, char_id);
      CREATE TABLE IF NOT EXISTS migration_reports (
        migration_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        report_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_state_documents (
        document_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_domains (
        domain_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_messages (
        char_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (char_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_messages_sequence ON runtime_messages(sequence_no);
      CREATE INDEX IF NOT EXISTS idx_runtime_messages_character ON runtime_messages(char_id, sequence_no);
      CREATE TABLE IF NOT EXISTS runtime_memory_access (
        memory_id TEXT PRIMARY KEY,
        char_id TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        access_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_memory_access_character ON runtime_memory_access(char_id, last_accessed_at);
      CREATE TABLE IF NOT EXISTS runtime_coactivations (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        strength REAL NOT NULL,
        activation_count INTEGER NOT NULL,
        last_activated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id)
      );
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        character_id TEXT,
        world_id TEXT,
        expected_version INTEGER,
        issued_at TEXT NOT NULL,
        protocol_version TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_commands_character_created ON commands(character_id, created_at);
      CREATE TABLE IF NOT EXISTS events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT,
        type TEXT NOT NULL,
        character_id TEXT,
        world_id TEXT,
        entity_version INTEGER,
        occurred_at TEXT NOT NULL,
        protocol_version TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_character_sequence ON events(character_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_events_command ON events(command_id, event_id);
      CREATE TABLE IF NOT EXISTS character_snapshots (
        character_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL,
        last_event_id INTEGER NOT NULL,
        protocol_version TEXT NOT NULL,
        character_json TEXT,
        user_json TEXT,
        world_json TEXT,
        state_json TEXT NOT NULL,
        recent_messages_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS client_cursors (
        client_id TEXT PRIMARY KEY,
        last_event_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        command_id TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        PRIMARY KEY (scope, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        job_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        command_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_character ON scheduled_jobs(character_id, due_at);
      CREATE TABLE IF NOT EXISTS outbox_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event_id INTEGER NOT NULL,
        target_client_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE(event_id, target_client_id)
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_deliveries(status, next_attempt_at, event_id);
    `);
    this.runtimeV2 = new RuntimeV2Repository(this.db, { contentHash });
  }

  shadowRuntimeV2(domainKey, operation, sourceHash, writer) {
    try {
      return writer();
    } catch (error) {
      try { this.runtimeV2.recordFailure(domainKey, operation, sourceHash, error); } catch {}
      return { ok: false, shadowFailed: true, error: String(error?.message || error) };
    }
  }

  runtimeV2Status() {
    return this.runtimeV2.status();
  }

  runtimeV2Health() {
    return this.runtimeV2.health();
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getEntity(type, id, { includeDeleted = false } = {}) {
    const row = this.db.prepare("SELECT * FROM authority_entities WHERE entity_type=? AND entity_id=?").get(type, id);
    if (!row || (!includeDeleted && row.deleted_at)) return null;
    return recordFromRow(row);
  }

  listEntities(type, { includeDeleted = false, limit = 500, offset = 0 } = {}) {
    const sql = `SELECT * FROM authority_entities WHERE entity_type=? ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(type, Math.max(1, Math.min(5000, Number(limit) || 500)), Math.max(0, Number(offset) || 0)).map(recordFromRow);
  }

  putEntity(type, id, data, options = {}) {
    const now = new Date().toISOString();
    const current = this.getEntity(type, id, { includeDeleted: true });
    const expectedVersion = options.expectedVersion;
    if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== Number(current?.version || 0)) {
      throw new AuthorityError("VERSION_CONFLICT", `Expected version ${expectedVersion}, current version is ${current?.version || 0}`, 409, { currentVersion: current?.version || 0 });
    }
    const version = Number(current?.version || 0) + 1;
    const nextData = { ...data };
    const hash = contentHash(nextData);
    if (current && !current.deletedAt && current.hash === hash) return current;
    const changedFields = [...new Set([...Object.keys(current?.data || {}), ...Object.keys(nextData)])]
      .filter((field) => contentHash(current?.data?.[field]) !== contentHash(nextData[field]));
    this.db.prepare(`
      INSERT INTO authority_entities(entity_type, entity_id, version, data_json, content_hash, source_authority, created_at, updated_at, deleted_at)
      VALUES(?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET
        version=excluded.version, data_json=excluded.data_json, content_hash=excluded.content_hash,
        source_authority=excluded.source_authority, updated_at=excluded.updated_at, deleted_at=NULL
    `).run(type, id, version, JSON.stringify(nextData), hash, options.sourceAuthority || "hub", current?.createdAt || now, now);
    const fieldVersion = this.db.prepare(`INSERT INTO authority_field_versions(entity_type,entity_id,field_name,version,updated_at,actor_id) VALUES(?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id,field_name) DO UPDATE SET version=authority_field_versions.version+1,updated_at=excluded.updated_at,actor_id=excluded.actor_id`);
    for (const field of changedFields) fieldVersion.run(type, id, field, 1, now, options.actorId || "system");
    this.audit(options.actorId || "system", current ? "update" : "create", type, id, current?.version || null, version, current?.hash || null, hash, options.commandId, { ...(options.details || {}), changedFields });
    return this.getEntity(type, id, { includeDeleted: true });
  }

  patchEntity(type, id, patch, options = {}) {
    const current = this.getEntity(type, id);
    if (!current) throw new AuthorityError("NOT_FOUND", `${type} ${id} was not found`, 404);
    const next = { ...current.data, ...(patch || {}) };
    for (const key of options.unset || []) delete next[key];
    return this.putEntity(type, id, next, options);
  }

  deleteEntity(type, id, options = {}) {
    const current = this.getEntity(type, id, { includeDeleted: true });
    if (!current) throw new AuthorityError("NOT_FOUND", `${type} ${id} was not found`, 404);
    if (options.expectedVersion !== undefined && Number(options.expectedVersion) !== current.version) {
      throw new AuthorityError("VERSION_CONFLICT", `Expected version ${options.expectedVersion}, current version is ${current.version}`, 409, { currentVersion: current.version });
    }
    if (current.deletedAt) return current;
    const now = new Date().toISOString();
    const version = current.version + 1;
    this.db.prepare("UPDATE authority_entities SET version=?, updated_at=?, deleted_at=? WHERE entity_type=? AND entity_id=?").run(version, now, now, type, id);
    this.db.prepare(`INSERT INTO authority_field_versions(entity_type,entity_id,field_name,version,updated_at,actor_id) VALUES(?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id,field_name) DO UPDATE SET version=authority_field_versions.version+1,updated_at=excluded.updated_at,actor_id=excluded.actor_id`)
      .run(type, id, "_deleted", 1, now, options.actorId || "system");
    this.audit(options.actorId || "system", "delete", type, id, current.version, version, current.hash, current.hash, options.commandId, { tombstone: true });
    return this.getEntity(type, id, { includeDeleted: true });
  }

  audit(actorId, action, type, id, fromVersion, toVersion, beforeHash, afterHash, commandId = null, details = null) {
    this.db.prepare(`INSERT INTO authority_audit(occurred_at,actor_id,action,entity_type,entity_id,from_version,to_version,before_hash,after_hash,command_id,details_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(new Date().toISOString(), actorId, action, type, id, fromVersion, toVersion, beforeHash, afterHash, commandId || null, details ? JSON.stringify(details) : null);
  }

  listAudit({ type = "", id = "", limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (type) { where.push("entity_type=?"); args.push(type); }
    if (id) { where.push("entity_id=?"); args.push(id); }
    const sql = `SELECT * FROM authority_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY audit_id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.max(1, Math.min(1000, Number(limit) || 200))).map((row) => ({
      auditId: Number(row.audit_id), occurredAt: row.occurred_at, actorId: row.actor_id, action: row.action,
      entityType: row.entity_type, entityId: row.entity_id, fromVersion: row.from_version, toVersion: row.to_version,
      beforeHash: row.before_hash, afterHash: row.after_hash, commandId: row.command_id, details: parseJson(row.details_json),
    }));
  }

  fieldVersions(type, id) {
    return Object.fromEntries(this.db.prepare("SELECT field_name,version,updated_at,actor_id FROM authority_field_versions WHERE entity_type=? AND entity_id=? ORDER BY field_name").all(type, id).map((row) => [row.field_name, { version: Number(row.version), updatedAt: row.updated_at, actorId: row.actor_id }]));
  }

  getStateDocument(key, fallback = null) {
    const row = this.db.prepare("SELECT * FROM hub_state_documents WHERE document_key=?").get(key);
    if (!row) return fallback;
    return {
      key: row.document_key,
      version: Number(row.version),
      data: parseJson(row.data_json, fallback),
      hash: row.content_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  putStateDocument(key, data, options = {}) {
    const current = this.getStateDocument(key);
    if (options.expectedVersion !== undefined && Number(options.expectedVersion) !== Number(current?.version || 0)) {
      throw new AuthorityError("VERSION_CONFLICT", `Expected state version ${options.expectedVersion}, current version is ${current?.version || 0}`, 409, { currentVersion: current?.version || 0 });
    }
    const hash = contentHash(data);
    if (current?.hash === hash) return current;
    const now = new Date().toISOString();
    const version = Number(current?.version || 0) + 1;
    this.db.prepare(`
      INSERT INTO hub_state_documents(document_key,version,data_json,content_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(document_key) DO UPDATE SET
        version=excluded.version,data_json=excluded.data_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at
    `).run(key, version, JSON.stringify(data), hash, current?.createdAt || now, now);
    this.audit(options.actorId || "runtime", current ? "state_update" : "state_create", "state_document", key, current?.version || null, version, current?.hash || null, hash, options.commandId || null, options.details || null);
    return this.getStateDocument(key);
  }

  deleteStateDocument(key, options = {}) {
    const current = this.getStateDocument(key);
    if (!current) return false;
    this.db.prepare("DELETE FROM hub_state_documents WHERE document_key=?").run(key);
    this.audit(options.actorId || "runtime", "state_delete", "state_document", key, current.version, null, current.hash, null, options.commandId || null);
    return true;
  }

  getRuntimeDomain(key, fallback = null) {
    const row = this.db.prepare("SELECT * FROM runtime_domains WHERE domain_key=?").get(key);
    if (!row) return fallback;
    return { key: row.domain_key, version: Number(row.version), data: parseJson(row.data_json, fallback), hash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  putRuntimeDomain(key, data) {
    const current = this.getRuntimeDomain(key);
    const hash = contentHash(data);
    if (current?.hash === hash) {
      this.shadowRuntimeV2(key, "replace_domain", hash, () => this.runtimeV2.replaceDomain(key, data, { sourceHash: hash, sourceVersion: current.version }));
      return current;
    }
    const now = new Date().toISOString();
    const version = Number(current?.version || 0) + 1;
    this.db.prepare(`INSERT INTO runtime_domains(domain_key,version,data_json,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(domain_key) DO UPDATE SET version=excluded.version,data_json=excluded.data_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at`)
      .run(key, version, JSON.stringify(data), hash, current?.createdAt || now, now);
    this.shadowRuntimeV2(key, "replace_domain", hash, () => this.runtimeV2.replaceDomain(key, data, { sourceHash: hash, sourceVersion: version }));
    return this.getRuntimeDomain(key);
  }

  listRuntimeDomains() {
    return Object.fromEntries(this.db.prepare("SELECT domain_key,version,data_json,content_hash,created_at,updated_at FROM runtime_domains ORDER BY domain_key").all()
      .map((row) => [row.domain_key, { key: row.domain_key, version: Number(row.version), data: parseJson(row.data_json), hash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }]));
  }

  listRuntimeDomainKeys() {
    return this.db.prepare("SELECT domain_key FROM runtime_domains ORDER BY domain_key").all().map((row) => row.domain_key);
  }

  deleteRuntimeDomain(key) {
    const current = this.getRuntimeDomain(key);
    const changed = Number(this.db.prepare("DELETE FROM runtime_domains WHERE domain_key=?").run(key).changes || 0) > 0;
    if (changed) this.shadowRuntimeV2(key, "delete_domain", current?.hash || "", () => this.runtimeV2.replaceDomain(key, key === "hub:characterRuntime" ? {} : [], { sourceHash: `deleted:${current?.hash || ""}`, sourceVersion: Number(current?.version || 0) + 1 }));
    return changed;
  }

  replaceRuntimeMessages(messages = []) {
    const incomingHash = contentHash(messages);
    const currentMessageMeta = this.getRuntimeDomain("_runtime_messages_hash");
    const currentHash = currentMessageMeta?.data?.hash || "";
    if (currentHash === incomingHash) {
      this.shadowRuntimeV2("message:all", "replace_messages", incomingHash, () => this.runtimeV2.replaceMessages({ allMessages: messages, sourceHash: incomingHash, sourceVersion: currentMessageMeta?.version || 0 }));
      return { changed: false, count: Number(this.db.prepare("SELECT COUNT(*) AS count FROM runtime_messages").get().count), hash: incomingHash };
    }
    const existing = new Map(this.db.prepare("SELECT char_id,message_id,sequence_no,content_hash FROM runtime_messages").all()
      .map((row) => [`${row.char_id}\u0000${row.message_id}`, row]));
    const upsert = this.db.prepare(`INSERT INTO runtime_messages(char_id,message_id,sequence_no,data_json,content_hash,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(char_id,message_id) DO UPDATE SET sequence_no=excluded.sequence_no,data_json=excluded.data_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at`);
    const remove = this.db.prepare("DELETE FROM runtime_messages WHERE char_id=? AND message_id=?");
    const now = new Date().toISOString();
    const incomingKeys = new Set();
    const changedMessages = [];
    const removedMessages = [];
    let changed = 0;
    (messages || []).forEach((item, index) => {
      const charId = normalizeId(item?.charId || item?.characterId || "") || "unbound";
      const messageId = normalizeId(item?.id || item?.messageId || item?.sourceId || "") || `seq:${index + 1}`;
      const key = `${charId}\u0000${messageId}`;
      incomingKeys.add(key);
      const hash = contentHash(item);
      const before = existing.get(key);
      if (!before || before.content_hash !== hash || Number(before.sequence_no) !== index + 1) {
        upsert.run(charId, messageId, index + 1, JSON.stringify(item), hash, now);
        changedMessages.push({ item, charId, messageId, sequenceNo: index + 1, hash });
        changed += 1;
      }
    });
    for (const [key, row] of existing) if (!incomingKeys.has(key)) { remove.run(row.char_id, row.message_id); removedMessages.push({ charId: row.char_id, messageId: row.message_id }); changed += 1; }
    const messageMeta = this.putRuntimeDomain("_runtime_messages_hash", { hash: incomingHash, count: messages.length });
    this.shadowRuntimeV2("message:all", "replace_messages", incomingHash, () => this.runtimeV2.replaceMessages({ allMessages: messages, changedMessages, removedMessages, sourceHash: incomingHash, sourceVersion: messageMeta?.version || 0 }));
    return { changed: changed > 0, changedRows: changed, count: messages.length, hash: incomingHash };
  }

  listRuntimeMessages({ charId = "", afterSequence = 0, limit = 1000000 } = {}) {
    const bounded = Math.max(1, Math.min(1000000, Number(limit) || 1000000));
    const rows = charId
      ? this.db.prepare("SELECT data_json FROM runtime_messages WHERE char_id=? AND sequence_no>? ORDER BY sequence_no LIMIT ?").all(charId, Number(afterSequence) || 0, bounded)
      : this.db.prepare("SELECT data_json FROM runtime_messages WHERE sequence_no>? ORDER BY sequence_no LIMIT ?").all(Number(afterSequence) || 0, bounded);
    return rows.map((row) => parseJson(row.data_json, {}));
  }

  recordRecallState(memoryIds = [], charId = "", at = Date.now(), { persist = true } = {}) {
    const ids = [...new Set((memoryIds || []).map(normalizeId).filter(Boolean))];
    const timestamp = new Date(Number.isFinite(Number(at)) ? Number(at) : Date.now()).toISOString();
    const changes = [];
    const apply = () => {
      for (const memoryId of ids) {
        const current = this.db.prepare("SELECT access_count,last_accessed_at FROM runtime_memory_access WHERE memory_id=?").get(memoryId);
        const before = Number(current?.access_count || 0);
        const after = before + 1;
        changes.push({ type: "memory_access", memoryId, charId, before: { accessCount: before, lastAccessedAt: current?.last_accessed_at || null }, after: { accessCount: after, lastAccessedAt: timestamp } });
        if (persist) this.db.prepare(`INSERT INTO runtime_memory_access(memory_id,char_id,last_accessed_at,access_count) VALUES(?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET char_id=excluded.char_id,last_accessed_at=excluded.last_accessed_at,access_count=excluded.access_count`).run(memoryId, charId || "unbound", timestamp, after);
      }
      for (let i = 0; i < Math.min(ids.length, 5); i += 1) {
        for (let j = i + 1; j < Math.min(ids.length, 5); j += 1) {
          const [sourceId, targetId] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
          const current = this.db.prepare("SELECT strength,activation_count,last_activated_at FROM runtime_coactivations WHERE source_id=? AND target_id=?").get(sourceId, targetId);
          const beforeStrength = Number(current?.strength || 0);
          const afterStrength = Math.min(1, beforeStrength + 0.05);
          const beforeCount = Number(current?.activation_count || 0);
          changes.push({ type: "coactivation", sourceId, targetId, before: { strength: beforeStrength, activationCount: beforeCount, lastActivatedAt: current?.last_activated_at || null }, after: { strength: afterStrength, activationCount: beforeCount + 1, lastActivatedAt: timestamp } });
          if (persist) this.db.prepare(`INSERT INTO runtime_coactivations(source_id,target_id,strength,activation_count,last_activated_at) VALUES(?,?,?,?,?) ON CONFLICT(source_id,target_id) DO UPDATE SET strength=excluded.strength,activation_count=excluded.activation_count,last_activated_at=excluded.last_activated_at`).run(sourceId, targetId, afterStrength, beforeCount + 1, timestamp);
        }
      }
    };
    if (persist) this.transaction(apply); else apply();
    return { persisted: persist, recalledAt: timestamp, memoryIds: ids, changes };
  }

  recallRuntimeStats() {
    return {
      accessedMemories: Number(this.db.prepare("SELECT COUNT(*) AS count FROM runtime_memory_access").get().count),
      coactivations: Number(this.db.prepare("SELECT COUNT(*) AS count FROM runtime_coactivations").get().count),
    };
  }

  getCommand(commandId) {
    const row = this.db.prepare("SELECT * FROM commands WHERE command_id=?").get(commandId);
    return row ? {
      commandId: row.command_id, type: row.type, actorId: row.actor_id, characterId: row.character_id, worldId: row.world_id,
      expectedVersion: row.expected_version, issuedAt: row.issued_at, protocolVersion: row.protocol_version, payload: parseJson(row.payload_json, {}),
      hash: row.command_hash, status: row.status, result: parseJson(row.result_json, null), error: parseJson(row.error_json, null), createdAt: row.created_at, completedAt: row.completed_at,
    } : null;
  }

  createCommand(command) {
    const existing = this.getCommand(command.commandId);
    const hash = contentHash(command);
    if (existing) {
      if (existing.hash !== hash) throw new AuthorityError("IDEMPOTENCY_CONFLICT", "commandId already exists with different content", 409, { commandId: command.commandId });
      return { created: false, command: existing };
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO commands(command_id,type,actor_id,character_id,world_id,expected_version,issued_at,protocol_version,payload_json,command_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(command.commandId, command.type, command.actorId, command.characterId || null, command.worldId || null, command.expectedVersion ?? null, command.issuedAt, command.protocolVersion, JSON.stringify(command.payload || {}), hash, "accepted", now);
    this.db.prepare(`INSERT INTO idempotency_keys(scope,idempotency_key,command_id,created_at) VALUES(?,?,?,?)`).run("command", command.commandId, command.commandId, now);
    return { created: true, command: this.getCommand(command.commandId) };
  }

  finishCommand(commandId, { status = "completed", result = null, error = null } = {}) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE commands SET status=?,result_json=?,error_json=?,completed_at=? WHERE command_id=?")
      .run(status, result == null ? null : JSON.stringify(result), error == null ? null : JSON.stringify(error), now, commandId);
    this.db.prepare("UPDATE idempotency_keys SET response_json=? WHERE scope='command' AND idempotency_key=?")
      .run(JSON.stringify({ status, result, error }), commandId);
    return this.getCommand(commandId);
  }

  startCommand(commandId) {
    const changed = Number(this.db.prepare("UPDATE commands SET status='processing' WHERE command_id=? AND status='accepted'").run(commandId).changes || 0);
    return { started: changed === 1, command: this.getCommand(commandId) };
  }

  appendEvent(event) {
    const info = this.db.prepare(`INSERT INTO events(command_id,type,character_id,world_id,entity_version,occurred_at,protocol_version,payload_json) VALUES(?,?,?,?,?,?,?,?)`)
      .run(event.commandId || null, event.type, event.characterId || null, event.worldId || null, event.entityVersion ?? null, event.occurredAt || new Date().toISOString(), event.protocolVersion, JSON.stringify(event.payload || {}));
    return this.getEvent(Number(info.lastInsertRowid));
  }

  listCommandEvents(commandId, { limit = 1000 } = {}) {
    return this.db.prepare("SELECT event_id FROM events WHERE command_id=? ORDER BY event_id LIMIT ?").all(commandId, Math.max(1, Math.min(5000, Number(limit) || 1000)))
      .map((row) => this.getEvent(row.event_id));
  }

  enqueueOutboxForEvent(eventId, targetClientIds = []) {
    const targets = [...new Set((targetClientIds || []).map(normalizeId).filter(Boolean))];
    const now = new Date().toISOString();
    const insert = this.db.prepare("INSERT OR IGNORE INTO outbox_deliveries(delivery_id,event_id,target_client_id,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    for (const clientId of targets) insert.run(`${clientId}:${Number(eventId)}`, Number(eventId), clientId, "pending", 0, now, now, now);
    return targets.map((clientId) => this.getOutboxDelivery(`${clientId}:${Number(eventId)}`));
  }

  getEvent(eventId) {
    const row = this.db.prepare("SELECT * FROM events WHERE event_id=?").get(Number(eventId));
    return row ? { eventId: Number(row.event_id), commandId: row.command_id, type: row.type, characterId: row.character_id, worldId: row.world_id, entityVersion: row.entity_version, occurredAt: row.occurred_at, protocolVersion: row.protocol_version, payload: parseJson(row.payload_json, {}) } : null;
  }

  listEvents({ after = 0, limit = 200, characterId = "" } = {}) {
    const bounded = Math.max(1, Math.min(1000, Number(limit) || 200));
    const rows = characterId
      ? this.db.prepare("SELECT event_id FROM events WHERE event_id>? AND character_id=? ORDER BY event_id LIMIT ?").all(Number(after) || 0, characterId, bounded)
      : this.db.prepare("SELECT event_id FROM events WHERE event_id>? ORDER BY event_id LIMIT ?").all(Number(after) || 0, bounded);
    return rows.map((row) => this.getEvent(row.event_id));
  }

  getSnapshot(characterId) {
    const row = this.db.prepare("SELECT * FROM character_snapshots WHERE character_id=?").get(characterId);
    return row ? {
      snapshotId: row.snapshot_id, characterId: row.character_id, snapshotVersion: Number(row.snapshot_version), lastEventId: Number(row.last_event_id), createdAt: row.created_at,
      protocolVersion: row.protocol_version, character: parseJson(row.character_json, null), user: parseJson(row.user_json, null), world: parseJson(row.world_json, null), state: parseJson(row.state_json, {}), recentMessages: parseJson(row.recent_messages_json, []),
    } : null;
  }

  putSnapshot(characterId, snapshot, { expectedVersion } = {}) {
    const current = this.getSnapshot(characterId);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current?.snapshotVersion || 0)) throw new AuthorityError("VERSION_CONFLICT", "Character snapshot version conflict", 409, { currentVersion: current?.snapshotVersion || 0 });
    const now = new Date().toISOString();
    const version = Number(current?.snapshotVersion || 0) + 1;
    const snapshotId = `${characterId}:${version}:${randomUUID()}`;
    this.db.prepare(`INSERT INTO character_snapshots(character_id,snapshot_id,snapshot_version,last_event_id,protocol_version,character_json,user_json,world_json,state_json,recent_messages_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,snapshot_version=excluded.snapshot_version,last_event_id=excluded.last_event_id,protocol_version=excluded.protocol_version,character_json=excluded.character_json,user_json=excluded.user_json,world_json=excluded.world_json,state_json=excluded.state_json,recent_messages_json=excluded.recent_messages_json,updated_at=excluded.updated_at`)
      .run(characterId, snapshotId, version, Number(snapshot.lastEventId || 0), snapshot.protocolVersion, snapshot.character == null ? null : JSON.stringify(snapshot.character), snapshot.user == null ? null : JSON.stringify(snapshot.user), snapshot.world == null ? null : JSON.stringify(snapshot.world), JSON.stringify(snapshot.state || {}), JSON.stringify(snapshot.recentMessages || []), current?.createdAt || now, now);
    return this.getSnapshot(characterId);
  }

  advanceClientCursor(clientId, eventId) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO client_cursors(client_id,last_event_id,updated_at) VALUES(?,?,?) ON CONFLICT(client_id) DO UPDATE SET last_event_id=MAX(client_cursors.last_event_id,excluded.last_event_id),updated_at=excluded.updated_at`).run(clientId, Number(eventId) || 0, now);
    return this.db.prepare("SELECT client_id,last_event_id,updated_at FROM client_cursors WHERE client_id=?").get(clientId);
  }

  createScheduledJob(job) {
    const jobId = normalizeId(job?.jobId) || randomUUID();
    const characterId = normalizeId(job?.characterId);
    const jobType = normalizeId(job?.jobType || job?.type);
    const dueAt = new Date(job?.dueAt || Date.now()).toISOString();
    if (!characterId || !jobType) throw new AuthorityError("VALIDATION_FAILED", "characterId and jobType are required", 400);
    const existing = this.getScheduledJob(jobId);
    const normalized = { jobId, characterId, jobType, dueAt, payload: job?.payload || {}, commandId: normalizeId(job?.commandId) || null };
    if (existing) {
      if (contentHash({ characterId: existing.characterId, jobType: existing.jobType, dueAt: existing.dueAt, payload: existing.payload, commandId: existing.commandId }) !== contentHash({ characterId, jobType, dueAt, payload: normalized.payload, commandId: normalized.commandId })) {
        throw new AuthorityError("IDEMPOTENCY_CONFLICT", "jobId already exists with different content", 409, { jobId });
      }
      return { created: false, job: existing };
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO scheduled_jobs(job_id,character_id,job_type,due_at,status,payload_json,command_id,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(jobId, characterId, jobType, dueAt, "pending", JSON.stringify(normalized.payload), normalized.commandId, 0, now, now);
    return { created: true, job: this.getScheduledJob(jobId) };
  }

  getScheduledJob(jobId) {
    const row = this.db.prepare("SELECT * FROM scheduled_jobs WHERE job_id=?").get(jobId);
    return row ? {
      jobId: row.job_id, characterId: row.character_id, jobType: row.job_type, dueAt: row.due_at, status: row.status,
      payload: parseJson(row.payload_json, {}), commandId: row.command_id, attemptCount: Number(row.attempt_count || 0),
      lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at, claimedAt: row.claimed_at, completedAt: row.completed_at,
    } : null;
  }

  listScheduledJobs({ characterId = "", status = "", limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (characterId) { where.push("character_id=?"); args.push(characterId); }
    if (status) { where.push("status=?"); args.push(status); }
    const sql = `SELECT job_id FROM scheduled_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY due_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.max(1, Math.min(1000, Number(limit) || 200))).map((row) => this.getScheduledJob(row.job_id));
  }

  claimDueJobs({ now = new Date().toISOString(), limit = 20 } = {}) {
    const ids = this.db.prepare("SELECT job_id FROM scheduled_jobs WHERE status IN ('pending','retry') AND due_at<=? ORDER BY due_at LIMIT ?")
      .all(new Date(now).toISOString(), Math.max(1, Math.min(100, Number(limit) || 20)));
    const claimed = [];
    const claimedAt = new Date().toISOString();
    for (const { job_id: jobId } of ids) {
      const changed = Number(this.db.prepare("UPDATE scheduled_jobs SET status='running',attempt_count=attempt_count+1,claimed_at=?,updated_at=? WHERE job_id=? AND status IN ('pending','retry')").run(claimedAt, claimedAt, jobId).changes || 0);
      if (changed) claimed.push(this.getScheduledJob(jobId));
    }
    return claimed;
  }

  completeScheduledJob(jobId) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE scheduled_jobs SET status='completed',completed_at=?,updated_at=?,last_error=NULL WHERE job_id=?").run(now, now, jobId);
    return this.getScheduledJob(jobId);
  }

  deferScheduledJob(jobId, dueAt, reason = "character-busy") {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE scheduled_jobs SET status='pending',due_at=?,claimed_at=NULL,updated_at=?,last_error=? WHERE job_id=?")
      .run(new Date(dueAt).toISOString(), now, reason, jobId);
    return this.getScheduledJob(jobId);
  }

  failScheduledJob(jobId, error, { retryAt = null, maxAttempts = 5 } = {}) {
    const current = this.getScheduledJob(jobId);
    if (!current) throw new AuthorityError("NOT_FOUND", `scheduled job ${jobId} was not found`, 404);
    const now = new Date().toISOString();
    const willRetry = current.attemptCount < Number(maxAttempts || 5);
    const next = retryAt || new Date(Date.now() + Math.min(3600000, 1000 * (2 ** Math.max(1, current.attemptCount)))).toISOString();
    this.db.prepare("UPDATE scheduled_jobs SET status=?,due_at=?,claimed_at=NULL,updated_at=?,completed_at=?,last_error=? WHERE job_id=?")
      .run(willRetry ? "retry" : "failed", willRetry ? new Date(next).toISOString() : current.dueAt, now, willRetry ? null : now, String(error || "unknown error").slice(0, 4000), jobId);
    return this.getScheduledJob(jobId);
  }

  cancelScheduledJob(jobId) {
    const now = new Date().toISOString();
    const changed = Number(this.db.prepare("UPDATE scheduled_jobs SET status='cancelled',completed_at=?,updated_at=? WHERE job_id=? AND status NOT IN ('completed','cancelled','failed')").run(now, now, jobId).changes || 0);
    if (!changed && !this.getScheduledJob(jobId)) throw new AuthorityError("NOT_FOUND", `scheduled job ${jobId} was not found`, 404);
    return this.getScheduledJob(jobId);
  }

  ensureOutboxDeliveries(clientId, { after = 0, limit = 1000 } = {}) {
    const target = normalizeId(clientId);
    if (!target) throw new AuthorityError("VALIDATION_FAILED", "clientId is required", 400);
    const events = this.db.prepare("SELECT event_id FROM events WHERE event_id>? ORDER BY event_id LIMIT ?").all(Number(after) || 0, Math.max(1, Math.min(5000, Number(limit) || 1000)));
    const now = new Date().toISOString();
    const insert = this.db.prepare("INSERT OR IGNORE INTO outbox_deliveries(delivery_id,event_id,target_client_id,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    for (const event of events) insert.run(`${target}:${event.event_id}`, Number(event.event_id), target, "pending", 0, now, now, now);
    return events.length;
  }

  claimOutboxDeliveries(clientId, { after = 0, limit = 100, now = new Date().toISOString() } = {}) {
    this.ensureOutboxDeliveries(clientId, { after, limit: Math.max(1000, Number(limit) * 10) });
    const target = normalizeId(clientId);
    const due = new Date(now).toISOString();
    const rows = this.db.prepare("SELECT delivery_id FROM outbox_deliveries WHERE target_client_id=? AND status IN ('pending','retry','sending') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY event_id LIMIT ?")
      .all(target, due, Math.max(1, Math.min(1000, Number(limit) || 100)));
    const claimedAt = new Date().toISOString();
    const result = [];
    for (const row of rows) {
      this.db.prepare("UPDATE outbox_deliveries SET status='sending',attempt_count=attempt_count+1,updated_at=?,next_attempt_at=? WHERE delivery_id=?")
        .run(claimedAt, new Date(Date.now() + 30000).toISOString(), row.delivery_id);
      const delivery = this.getOutboxDelivery(row.delivery_id);
      result.push({ ...delivery, event: this.getEvent(delivery.eventId) });
    }
    return result;
  }

  getOutboxDelivery(deliveryId) {
    const row = this.db.prepare("SELECT * FROM outbox_deliveries WHERE delivery_id=?").get(deliveryId);
    return row ? {
      deliveryId: row.delivery_id, eventId: Number(row.event_id), targetClientId: row.target_client_id, status: row.status,
      attemptCount: Number(row.attempt_count || 0), nextAttemptAt: row.next_attempt_at, lastError: row.last_error,
      createdAt: row.created_at, updatedAt: row.updated_at, deliveredAt: row.delivered_at,
    } : null;
  }

  acknowledgeOutboxDelivery(clientId, deliveryId) {
    const delivery = this.getOutboxDelivery(deliveryId);
    if (!delivery || delivery.targetClientId !== normalizeId(clientId)) throw new AuthorityError("NOT_FOUND", "outbox delivery was not found", 404);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE outbox_deliveries SET status='delivered',delivered_at=?,updated_at=?,next_attempt_at=NULL,last_error=NULL WHERE delivery_id=?").run(now, now, deliveryId);
    this.advanceClientCursor(clientId, delivery.eventId);
    return this.getOutboxDelivery(deliveryId);
  }

  retryOutboxDelivery(clientId, deliveryId, error = "delivery failed") {
    const delivery = this.getOutboxDelivery(deliveryId);
    if (!delivery || delivery.targetClientId !== normalizeId(clientId)) throw new AuthorityError("NOT_FOUND", "outbox delivery was not found", 404);
    const now = new Date().toISOString();
    const nextAttemptAt = new Date(Date.now() + Math.min(300000, 1000 * (2 ** Math.max(1, delivery.attemptCount)))).toISOString();
    this.db.prepare("UPDATE outbox_deliveries SET status='retry',next_attempt_at=?,updated_at=?,last_error=? WHERE delivery_id=?")
      .run(nextAttemptAt, now, String(error || "delivery failed").slice(0, 4000), deliveryId);
    return this.getOutboxDelivery(deliveryId);
  }

  migrationObjectsByDomain() {
    const result = {};
    for (const row of this.db.prepare("SELECT domain,data_json FROM migration_objects ORDER BY domain,object_id").iterate()) {
      if (!result[row.domain]) result[row.domain] = [];
      result[row.domain].push(parseJson(row.data_json, {}));
    }
    return result;
  }

  finalizeRuntimePromotion(options = {}) {
    const counts = {
      migrationObjects: Number(this.db.prepare("SELECT COUNT(*) AS count FROM migration_objects").get().count),
      stateDocuments: Number(this.db.prepare("SELECT COUNT(*) AS count FROM hub_state_documents").get().count),
    };
    this.db.prepare("DELETE FROM migration_objects").run();
    this.db.prepare("DELETE FROM hub_state_documents").run();
    this.audit(options.actorId || "runtime-promotion", "promote", "runtime", "canonical", null, 1, null, null, null, counts);
    return counts;
  }

  clearMigrationObjects(options = {}) {
    const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM migration_objects").get().count);
    this.db.prepare("DELETE FROM migration_objects").run();
    if (count) this.audit(options.actorId || "runtime-promotion", "promote", "runtime", "migration-domains", null, 1, null, null, null, { migrationObjects: count });
    return count;
  }

  mountWorldbook(characterId, worldbookId, options = {}) {
    const character = this.getEntity("character", characterId);
    const worldbook = this.getEntity("worldbook", worldbookId);
    if (!character || !worldbook) throw new AuthorityError("NOT_FOUND", "Character or worldbook was not found", 404, { characterId, worldbookId });
    const current = this.db.prepare("SELECT * FROM worldbook_mounts WHERE character_id=? AND worldbook_id=?").get(characterId, worldbookId);
    const expected = options.expectedVersion;
    if (expected !== undefined && expected !== null && Number(expected) !== Number(current?.version || 0)) throw new AuthorityError("VERSION_CONFLICT", "Worldbook mount version conflict", 409, { currentVersion: current?.version || 0 });
    if (current && !current.deleted_at) return { characterId, worldbookId, version: Number(current.version), createdAt: current.created_at, updatedAt: current.updated_at, deletedAt: null };
    const now = new Date().toISOString();
    const version = Number(current?.version || 0) + 1;
    this.db.prepare(`INSERT INTO worldbook_mounts(character_id,worldbook_id,version,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT(character_id,worldbook_id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at,deleted_at=NULL`)
      .run(characterId, worldbookId, version, current?.created_at || now, now);
    this.audit(options.actorId || "system", "mount", "worldbook_mount", `${characterId}:${worldbookId}`, current?.version || null, version, null, null, options.commandId);
    return { characterId, worldbookId, version, createdAt: current?.created_at || now, updatedAt: now, deletedAt: null };
  }

  unmountWorldbook(characterId, worldbookId, options = {}) {
    const current = this.db.prepare("SELECT * FROM worldbook_mounts WHERE character_id=? AND worldbook_id=?").get(characterId, worldbookId);
    if (!current || current.deleted_at) throw new AuthorityError("NOT_FOUND", "Worldbook mount was not found", 404);
    if (options.expectedVersion !== undefined && Number(options.expectedVersion) !== Number(current.version)) throw new AuthorityError("VERSION_CONFLICT", "Worldbook mount version conflict", 409, { currentVersion: Number(current.version) });
    const now = new Date().toISOString();
    const version = Number(current.version) + 1;
    this.db.prepare("UPDATE worldbook_mounts SET version=?,updated_at=?,deleted_at=? WHERE character_id=? AND worldbook_id=?").run(version, now, now, characterId, worldbookId);
    this.audit(options.actorId || "system", "unmount", "worldbook_mount", `${characterId}:${worldbookId}`, Number(current.version), version, null, null, options.commandId, { tombstone: true });
    return { characterId, worldbookId, version, createdAt: current.created_at, updatedAt: now, deletedAt: now };
  }

  listMounts(characterId, { includeDeleted = false } = {}) {
    const sql = `SELECT * FROM worldbook_mounts WHERE character_id=? ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY updated_at DESC`;
    return this.db.prepare(sql).all(characterId).map((row) => ({ characterId: row.character_id, worldbookId: row.worldbook_id, version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at }));
  }

  analyzeMigration(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new AuthorityError("VALIDATION_FAILED", "Migration payload must be a SullyOS FullBackupData object", 400);
    const report = migrationSkeleton(source);
    const characters = new Set((source.characters || []).map((item) => entityId("character", item)).filter(Boolean));
    const worldbooks = new Set((source.worldbooks || []).map((item) => entityId("worldbook", item)).filter(Boolean));
    for (const character of source.characters || []) {
      const charId = entityId("character", character);
      if (!charId) report.skippedCounts.characters = (report.skippedCounts.characters || 0) + 1;
      for (const mounted of character?.mountedWorldbooks || []) {
        const wbId = entityId("worldbook", mounted);
        if (!wbId) report.missingReferences.push({ domain: "worldbook_mount", sourceId: charId || null, targetId: null, reason: "mounted worldbook has no stable id" });
        else if (!worldbooks.has(wbId)) report.warnings.push({ domain: "worldbook_mount", sourceId: charId, targetId: wbId, reason: "mounted copy will be promoted to an authoritative worldbook" });
      }
    }
    for (const [field, domain] of Object.entries(MIGRATION_ARRAY_DOMAINS)) {
      (source[field] || []).forEach((item, index) => {
        if (!item || typeof item !== "object") report.skippedCounts[field] = (report.skippedCounts[field] || 0) + 1;
        const ref = charReference(item);
        if (ref && !characters.has(ref)) report.missingReferences.push({ domain, sourceId: objectId(domain, item, index), targetId: ref, reason: "character reference not found in backup" });
      });
    }
    return report;
  }

  importSullyBackup(source, { actorId = "migration", mode = "import" } = {}) {
    const migrationId = randomUUID();
    const report = this.analyzeMigration(source);
    const sourceHash = contentHash(source);
    const now = new Date().toISOString();
    const inc = (group, key, amount = 1) => { group[key] = (group[key] || 0) + amount; };
    const noteHashDiff = (domain, id, beforeHash, afterHash) => {
      if (beforeHash && beforeHash !== afterHash && report.hashDifferences.length < 500) report.hashDifferences.push({ domain, id, beforeHash, afterHash });
    };

    return this.transaction(() => {
      this.db.prepare("INSERT INTO migration_reports(migration_id,mode,status,source_hash,created_at,report_json) VALUES(?,?,?,?,?,?)")
        .run(migrationId, mode, "running", sourceHash, now, JSON.stringify(report));

      const importedAuthorityKeys = new Set();
      const putAuthority = (type, raw, fallbackId = "") => {
        if (!raw || typeof raw !== "object") return null;
        const id = entityId(type, raw) || fallbackId;
        if (!id) { inc(report.skippedCounts, `${type}s`); return null; }
        const authorityKey = `${type}:${id}`;
        if (importedAuthorityKeys.has(authorityKey)) { inc(report.skippedCounts, `${type}sDuplicateId`); return this.getEntity(type, id, { includeDeleted: true }); }
        importedAuthorityKeys.add(authorityKey);
        const current = this.getEntity(type, id, { includeDeleted: true });
        const normalized = { ...raw };
        if (type === "character") normalized.characterId = id;
        if (type === "userProfile") normalized.userId = id;
        if (type === "worldbook") normalized.worldbookId = id;
        if (type === "world") normalized.worldId = id;
        const incomingHash = contentHash(normalized);
        noteHashDiff(type, id, current?.hash, incomingHash);
        if (current && !current.deletedAt && current.hash === incomingHash) { inc(report.skippedCounts, `${type}sUnchanged`); return current; }
        const saved = this.putEntity(type, id, normalized, { actorId, sourceAuthority: "sullyos_import", details: { migrationId } });
        inc(report.importedCounts, `${type}s`);
        return saved;
      };

      for (const item of source.characters || []) putAuthority("character", item);
      if (source.userProfile) putAuthority("userProfile", source.userProfile, "me");
      for (const item of source.worldbooks || []) putAuthority("worldbook", item);
      for (const item of source.worlds || []) putAuthority("world", item);

      for (const character of source.characters || []) {
        const charId = entityId("character", character);
        if (!charId) continue;
        if (Array.isArray(character.memories)) this.putMigrationObjects("legacy_fragment", character.memories, migrationId, report, charId);
        for (const [month, text] of Object.entries(character.refinedMemories || {})) this.putMigrationObjects("legacy_refined", [{ id: `${charId}:${month}`, charId, month, text }], migrationId, report, charId);
        if (character.impression) this.putMigrationObjects("impression", [{ id: `${charId}:impression`, charId, ...character.impression }], migrationId, report, charId);
        const behavior = character.activeMsg2Config || character.proactiveConfig;
        if (behavior) this.putMigrationObjects("active_behavior_config", [{ id: `${charId}:active`, charId, ...behavior }], migrationId, report, charId);
        for (const mounted of character.mountedWorldbooks || []) {
          const wbId = entityId("worldbook", mounted);
          if (!wbId) continue;
          if (!this.getEntity("worldbook", wbId)) putAuthority("worldbook", mounted);
          const currentMount = this.db.prepare("SELECT * FROM worldbook_mounts WHERE character_id=? AND worldbook_id=?").get(charId, wbId);
          this.mountWorldbook(charId, wbId, { actorId, details: { migrationId } });
          if (currentMount && !currentMount.deleted_at) inc(report.skippedCounts, "mountsUnchanged");
          else inc(report.importedCounts, "mounts");
        }
      }

      for (const [field, domain] of Object.entries(MIGRATION_ARRAY_DOMAINS)) this.putMigrationObjects(domain, source[field] || [], migrationId, report);
      for (const [field, domain] of Object.entries(MIGRATION_SINGLETON_DOMAINS)) if (source[field]) this.putMigrationObjects(domain, [{ id: field, ...source[field] }], migrationId, report);
      if (source.memoryPalaceHighWaterMarks) this.putMigrationObjects("memory_high_water_marks", [{ id: "global", value: source.memoryPalaceHighWaterMarks }], migrationId, report);
      if (source.memoryPalaceFlags) this.putMigrationObjects("memory_flags", [{ id: "global", value: source.memoryPalaceFlags }], migrationId, report);
      if (source.memoryPalaceConfig) this.putMigrationObjects("memory_config", [{ id: "global", value: source.memoryPalaceConfig }], migrationId, report);

      const completedAt = new Date().toISOString();
      const finalReport = { migrationId, mode, status: "completed", sourceHash, createdAt: now, completedAt, ...report };
      this.db.prepare("UPDATE migration_reports SET status='completed',completed_at=?,report_json=? WHERE migration_id=?").run(completedAt, JSON.stringify(finalReport), migrationId);
      this.audit(actorId, "migration", "migration", migrationId, null, 1, null, sourceHash, null, { importedCounts: report.importedCounts });
      return finalReport;
    });
  }

  putMigrationObjects(domain, items, migrationId, report, forcedCharId = "") {
    const select = this.db.prepare("SELECT content_hash FROM migration_objects WHERE domain=? AND object_id=?");
    const upsert = this.db.prepare(`INSERT INTO migration_objects(domain,object_id,char_id,data_json,content_hash,source_migration_id,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(domain,object_id) DO UPDATE SET char_id=excluded.char_id,data_json=excluded.data_json,content_hash=excluded.content_hash,source_migration_id=excluded.source_migration_id,updated_at=excluded.updated_at`);
    const seen = new Set();
    (items || []).forEach((item, index) => {
      if (!item || typeof item !== "object") { report.skippedCounts[domain] = (report.skippedCounts[domain] || 0) + 1; return; }
      const baseId = objectId(domain, item, index);
      const id = forcedCharId && !baseId.startsWith(`${forcedCharId}:`) ? `${forcedCharId}:${baseId}` : baseId;
      if (seen.has(id)) { report.skippedCounts[`${domain}DuplicateId`] = (report.skippedCounts[`${domain}DuplicateId`] || 0) + 1; return; }
      seen.add(id);
      const hash = contentHash(item);
      const before = select.get(domain, id);
      if (before?.content_hash === hash) { report.skippedCounts[`${domain}Unchanged`] = (report.skippedCounts[`${domain}Unchanged`] || 0) + 1; return; }
      if (before?.content_hash && before.content_hash !== hash && report.hashDifferences.length < 500) report.hashDifferences.push({ domain, id, beforeHash: before.content_hash, afterHash: hash });
      upsert.run(domain, id, forcedCharId || charReference(item) || null, JSON.stringify(item), hash, migrationId, new Date().toISOString());
      report.importedCounts[domain] = (report.importedCounts[domain] || 0) + 1;
    });
  }

  listMigrations(limit = 50) {
    return this.db.prepare("SELECT migration_id,mode,status,source_hash,created_at,completed_at,report_json FROM migration_reports ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(200, Number(limit) || 50))).map((row) => ({ migrationId: row.migration_id, mode: row.mode, status: row.status, sourceHash: row.source_hash, createdAt: row.created_at, completedAt: row.completed_at, report: parseJson(row.report_json, {}) }));
  }

  getMigration(id) {
    const row = this.db.prepare("SELECT * FROM migration_reports WHERE migration_id=?").get(id);
    return row ? parseJson(row.report_json, {}) : null;
  }

  stats() {
    const entities = Object.fromEntries(this.db.prepare("SELECT entity_type,COUNT(*) AS count,SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted FROM authority_entities GROUP BY entity_type").all().map((row) => [row.entity_type, { count: Number(row.count), deleted: Number(row.deleted || 0) }]));
    const archives = Object.fromEntries(this.db.prepare("SELECT domain,COUNT(*) AS count FROM migration_objects GROUP BY domain").all().map((row) => [row.domain, Number(row.count)]));
    const runtime = Object.fromEntries(this.db.prepare("SELECT domain_key,data_json FROM runtime_domains WHERE domain_key LIKE 'hub:%' ORDER BY domain_key").all().map((row) => {
      const value = parseJson(row.data_json);
      return [row.domain_key.slice(4), Array.isArray(value) ? value.length : value && typeof value === "object" ? 1 : value == null ? 0 : 1];
    }));
    runtime.messages = Number(this.db.prepare("SELECT COUNT(*) AS count FROM runtime_messages").get().count);
    const eventStore = {
      commands: Number(this.db.prepare("SELECT COUNT(*) AS count FROM commands").get().count),
      events: Number(this.db.prepare("SELECT COUNT(*) AS count FROM events").get().count),
      snapshots: Number(this.db.prepare("SELECT COUNT(*) AS count FROM character_snapshots").get().count),
      clientCursors: Number(this.db.prepare("SELECT COUNT(*) AS count FROM client_cursors").get().count),
      scheduledJobs: Number(this.db.prepare("SELECT COUNT(*) AS count FROM scheduled_jobs").get().count),
      outboxDeliveries: Number(this.db.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get().count),
    };
    return { file: this.file, entities, runtime, recallState: this.recallRuntimeStats(), eventStore, archives, migrations: Number(this.db.prepare("SELECT COUNT(*) AS count FROM migration_reports").get().count) };
  }

  close() {
    this.db.close();
  }
}
