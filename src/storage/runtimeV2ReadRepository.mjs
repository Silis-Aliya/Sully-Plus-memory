const parse = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

function presentMessage(row) {
  const raw = parse(row.raw_json, {});
  if (row.source_sequence_no != null) return raw;
  return { ...raw, id: Number(row.message_seq), charId: row.character_id, sourceId: row.source_message_id || row.message_id, role: row.role, type: row.message_type, content: row.content, timestamp: Date.parse(row.occurred_at), surface: row.surface, visibility: row.visibility, origin: row.origin, conversationId: row.conversation_id, metadata: parse(row.metadata_json, {}) };
}

const DOMAIN_READERS = {
  memories: ["v2_memory_nodes", "memory_id", "raw_json"],
  links: ["v2_memory_links", "link_id", "raw_json"],
  eventBoxes: ["v2_event_boxes", "event_box_id", "raw_json"],
  roomPlates: ["v2_room_plates", "room_plate_id", "raw_json"],
  anticipations: ["v2_anticipations", "anticipation_id", "raw_json"],
  digestReports: ["v2_digest_reports", "digest_report_id", "raw_json"],
};

export class RuntimeV2ReadRepository {
  constructor(db) {
    this.db = db;
  }

  listMessages({ charId = "", afterSourceSequence = 0, limit = 1000000 } = {}) {
    const bounded = Math.max(1, Math.min(1000000, Number(limit) || 1000000));
    const rows = charId
      ? this.db.prepare(`SELECT * FROM v2_messages WHERE deleted_at IS NULL AND character_id=? AND COALESCE(source_sequence_no,message_seq)>?
          ORDER BY COALESCE(source_sequence_no,message_seq),message_seq LIMIT ?`).all(charId, Number(afterSourceSequence) || 0, bounded)
      : this.db.prepare(`SELECT * FROM v2_messages WHERE deleted_at IS NULL AND COALESCE(source_sequence_no,message_seq)>?
          ORDER BY COALESCE(source_sequence_no,message_seq),message_seq LIMIT ?`).all(Number(afterSourceSequence) || 0, bounded);
    return rows.map(presentMessage);
  }

  listRecentMessages({ charId = "", limit = 100 } = {}) {
    const bounded = Math.max(1, Math.min(1000, Number(limit) || 100));
    const rows = charId
      ? this.db.prepare("SELECT * FROM v2_messages WHERE deleted_at IS NULL AND character_id=? ORDER BY COALESCE(source_sequence_no,message_seq) DESC,message_seq DESC LIMIT ?").all(charId, bounded)
      : this.db.prepare("SELECT * FROM v2_messages WHERE deleted_at IS NULL ORDER BY COALESCE(source_sequence_no,message_seq) DESC,message_seq DESC LIMIT ?").all(bounded);
    return rows.reverse().map(presentMessage);
  }

  getDomain(domain) {
    if (domain === "vectors") return this.listVectors();
    if (domain === "characterRuntime") return this.characterRuntime();
    const config = DOMAIN_READERS[domain];
    if (!config) return null;
    const [table, idColumn, jsonColumn] = config;
    return this.db.prepare(`SELECT t.${jsonColumn} AS raw_json FROM ${table} t
      LEFT JOIN v2_source_order o ON o.domain_key=? AND o.object_id=t.${idColumn} AND o.deleted_at IS NULL
      WHERE t.deleted_at IS NULL ORDER BY COALESCE(o.ordinal,9223372036854775807),t.rowid`).all(`hub:${domain}`)
      .map((row) => parse(row.raw_json, {}));
  }

  listVectors() {
    return this.db.prepare(`SELECT v.memory_id,v.character_id,v.model,v.dimensions,v.vector_blob,v.raw_metadata_json,v.source_vector_field,v.source_had_dimensions
      FROM v2_memory_vectors v LEFT JOIN v2_source_order o ON o.domain_key='hub:vectors' AND o.object_id=v.memory_id AND o.deleted_at IS NULL
      WHERE v.deleted_at IS NULL ORDER BY COALESCE(o.ordinal,9223372036854775807),v.rowid`).all().map((row) => {
      const metadata = parse(row.raw_metadata_json, {});
      const values = new Float32Array(row.vector_blob.buffer, row.vector_blob.byteOffset, Number(row.dimensions));
      const result = { ...metadata };
      if (Number(row.source_had_dimensions)) result.dimensions = Number(row.dimensions);
      else delete result.dimensions;
      result[row.source_vector_field || "vector"] = Array.from(values);
      return result;
    });
  }

  characterRuntime() {
    return Object.fromEntries(this.db.prepare(`SELECT s.character_id,s.state_json FROM v2_character_runtime_state s
      LEFT JOIN v2_source_order o ON o.domain_key='hub:characterRuntime' AND o.object_id=s.character_id AND o.deleted_at IS NULL
      WHERE s.deleted_at IS NULL ORDER BY COALESCE(o.ordinal,9223372036854775807),s.rowid`).all().map((row) => {
      const state = parse(row.state_json, {});
      const { characterId: _characterId, ...rest } = state;
      return [row.character_id, rest];
    }));
  }
}
