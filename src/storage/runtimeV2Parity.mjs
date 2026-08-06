import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeV2ReadRepository } from "./runtimeV2ReadRepository.mjs";

const DOMAIN_CONFIG = {
  memories: { table: "v2_memory_nodes", idColumn: "memory_id", id: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),'legacy-memory:' || j.key)" },
  links: { table: "v2_memory_links", idColumn: "link_id", id: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),'legacy-link:' || j.key)" },
  eventBoxes: { table: "v2_event_boxes", idColumn: "event_box_id", id: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),'legacy-event-box:' || j.key)" },
  roomPlates: { table: "v2_room_plates", idColumn: "room_plate_id", id: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),COALESCE(NULLIF(json_extract(j.value,'$.charId'),''),'unbound') || ':' || COALESCE(NULLIF(json_extract(j.value,'$.room'),''),'unknown'))" },
  anticipations: { table: "v2_anticipations", idColumn: "anticipation_id", id: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),'legacy-anticipation:' || j.key)" },
  digestReports: { table: "v2_digest_reports", idColumn: "digest_report_id", id: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),'legacy-digest:' || j.key)" },
};

function vectorBuffer(values) {
  const floats = Float32Array.from(values.map((value) => Number(value) || 0));
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function vectorHash(raw) {
  try {
    const item = JSON.parse(raw);
    const values = Array.isArray(item.vector) && item.vector.length ? item.vector : item.embedding;
    return createHash("sha256").update(vectorBuffer(Array.isArray(values) ? values : [])).digest("hex");
  } catch { return ""; }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function jsonHash(raw) {
  try { return createHash("sha256").update(JSON.stringify(canonical(JSON.parse(raw)))).digest("hex"); }
  catch { return ""; }
}

function vectorMetadataHash(raw) {
  try {
    const item = JSON.parse(raw);
    delete item.vector;
    delete item.embedding;
    return createHash("sha256").update(JSON.stringify(canonical(item))).digest("hex");
  } catch { return ""; }
}

function diffPaths(before, after, prefix = "$", output = [], limit = 25) {
  if (output.length >= limit) return output;
  if (Object.is(before, after)) return output;
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object") {
    output.push(prefix);
    return output;
  }
  if (Array.isArray(before) !== Array.isArray(after)) {
    output.push(prefix);
    return output;
  }
  const keys = Array.isArray(before)
    ? [...Array(Math.max(before.length, after.length)).keys()]
    : [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    if (!(key in before) || !(key in after)) output.push(`${prefix}.${key}`);
    else diffPaths(before[key], after[key], `${prefix}.${key}`, output, limit);
    if (output.length >= limit) break;
  }
  return output;
}

function parse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

export class RuntimeV2Parity {
  constructor(databaseFile, { sampleLimit = 20 } = {}) {
    this.databaseFile = path.resolve(databaseFile);
    this.sampleLimit = Math.max(1, Math.min(100, Number(sampleLimit) || 20));
  }

  run() {
    const db = new DatabaseSync(this.databaseFile, { readOnly: true });
    db.function("v2_vector_hash", vectorHash);
    db.function("v2_json_hash", jsonHash);
    db.function("v2_vector_metadata_hash", vectorMetadataHash);
    try {
      const messages = this.compareMessages(db);
      const domains = Object.fromEntries(Object.keys(DOMAIN_CONFIG).map((domain) => [domain, this.compareDomain(db, domain)]));
      domains.vectors = this.compareVectors(db);
      domains.characterRuntime = this.compareCharacterRuntime(db);
      domains.eventBoxMembers = this.compareEventBoxMembers(db);
      domains.roomPlateEntries = this.compareRoomPlateEntries(db);
      const sections = [messages, ...Object.values(domains)];
      const summary = sections.reduce((result, item) => ({
        sourceObjects: result.sourceObjects + item.sourceCount,
        targetObjects: result.targetObjects + item.targetCount,
        missing: result.missing + item.missing,
        extra: result.extra + item.extra,
        fieldMismatches: result.fieldMismatches + item.fieldMismatches,
        orderMismatches: result.orderMismatches + item.orderMismatches,
      }), { sourceObjects: 0, targetObjects: 0, missing: 0, extra: 0, fieldMismatches: 0, orderMismatches: 0 });
      return { mode: "shadow-read-only", databaseFile: this.databaseFile, generatedAt: new Date().toISOString(), messages, domains, summary: { ...summary, ok: summary.missing === 0 && summary.extra === 0 && summary.fieldMismatches === 0 && summary.orderMismatches === 0 } };
    } finally {
      db.close();
    }
  }

  compareMessages(db) {
    const sourceCount = Number(db.prepare("SELECT COUNT(*) count FROM runtime_messages").get().count);
    const targetCount = Number(db.prepare("SELECT COUNT(*) count FROM v2_messages WHERE deleted_at IS NULL").get().count);
    const joined = db.prepare(`SELECT
      SUM(CASE WHEN v.message_id IS NULL THEN 1 ELSE 0 END) missing,
      SUM(CASE WHEN v.message_id IS NOT NULL AND r.content_hash<>v.content_hash THEN 1 ELSE 0 END) field_mismatches,
      SUM(CASE WHEN v.message_id IS NOT NULL AND r.sequence_no<>v.source_sequence_no THEN 1 ELSE 0 END) order_mismatches
      FROM runtime_messages r LEFT JOIN v2_messages v ON v.character_id=r.char_id AND v.source_message_id=r.message_id AND v.source_client_id='legacy-runtime' AND v.deleted_at IS NULL`).get();
    const extra = Number(db.prepare(`SELECT COUNT(*) count FROM v2_messages v LEFT JOIN runtime_messages r ON r.char_id=v.character_id AND r.message_id=v.source_message_id
      WHERE v.deleted_at IS NULL AND v.source_client_id='legacy-runtime' AND r.message_id IS NULL`).get().count);
    const samples = db.prepare(`SELECT r.char_id object_id,r.message_id source_id,r.sequence_no source_sequence,v.source_sequence_no target_sequence,r.data_json source_raw,v.raw_json target_raw,
      CASE WHEN v.message_id IS NULL THEN 'missing' WHEN r.content_hash<>v.content_hash THEN 'field_mismatch' ELSE 'order_mismatch' END kind
      FROM runtime_messages r LEFT JOIN v2_messages v ON v.character_id=r.char_id AND v.source_message_id=r.message_id AND v.source_client_id='legacy-runtime' AND v.deleted_at IS NULL
      WHERE v.message_id IS NULL OR r.content_hash<>v.content_hash OR r.sequence_no<>v.source_sequence_no ORDER BY r.sequence_no LIMIT ?`).all(this.sampleLimit)
      .map((row) => ({ kind: row.kind, characterId: row.object_id, sourceId: row.source_id, sourceSequence: row.source_sequence, targetSequence: row.target_sequence, paths: row.kind === "field_mismatch" ? diffPaths(parse(row.source_raw), parse(row.target_raw)) : [] }));
    return { sourceCount, targetCount, missing: Number(joined.missing || 0), extra, fieldMismatches: Number(joined.field_mismatches || 0), orderMismatches: Number(joined.order_mismatches || 0), samples };
  }

  compareDomain(db, domain) {
    const config = DOMAIN_CONFIG[domain], domainKey = `hub:${domain}`;
    const sourceCte = `WITH source AS (SELECT ${config.id} object_id,CAST(j.key AS INTEGER) ordinal,j.value raw_json FROM runtime_domains r,json_each(r.data_json) j WHERE r.domain_key=?)`;
    const joined = db.prepare(`${sourceCte} SELECT COUNT(*) source_count,
      SUM(CASE WHEN t.${config.idColumn} IS NULL THEN 1 ELSE 0 END) missing,
      SUM(CASE WHEN t.${config.idColumn} IS NOT NULL AND source.raw_json<>t.raw_json THEN 1 ELSE 0 END) field_mismatches,
      SUM(CASE WHEN t.${config.idColumn} IS NOT NULL AND (o.ordinal IS NULL OR source.ordinal<>o.ordinal) THEN 1 ELSE 0 END) order_mismatches
      FROM source LEFT JOIN ${config.table} t ON t.${config.idColumn}=source.object_id AND t.deleted_at IS NULL
      LEFT JOIN v2_source_order o ON o.domain_key=? AND o.object_id=source.object_id AND o.deleted_at IS NULL`).get(domainKey, domainKey);
    const targetCount = Number(db.prepare(`SELECT COUNT(*) count FROM ${config.table} WHERE deleted_at IS NULL`).get().count);
    const sourceCount = Number(joined.source_count || 0), missing = Number(joined.missing || 0), fieldMismatches = Number(joined.field_mismatches || 0), orderMismatches = Number(joined.order_mismatches || 0);
    const extra = Math.max(0, targetCount - (sourceCount - missing));
    const samples = missing || fieldMismatches || orderMismatches
      ? db.prepare(`${sourceCte} SELECT source.object_id,source.ordinal source_ordinal,o.ordinal target_ordinal,source.raw_json source_raw,t.raw_json target_raw,
          CASE WHEN t.${config.idColumn} IS NULL THEN 'missing' WHEN source.raw_json<>t.raw_json THEN 'field_mismatch' ELSE 'order_mismatch' END kind
          FROM source LEFT JOIN ${config.table} t ON t.${config.idColumn}=source.object_id AND t.deleted_at IS NULL
          LEFT JOIN v2_source_order o ON o.domain_key=? AND o.object_id=source.object_id AND o.deleted_at IS NULL
          WHERE t.${config.idColumn} IS NULL OR source.raw_json<>t.raw_json OR o.ordinal IS NULL OR source.ordinal<>o.ordinal LIMIT ?`).all(domainKey, domainKey, this.sampleLimit)
          .map((row) => ({ kind: row.kind, objectId: row.object_id, sourceOrdinal: row.source_ordinal, targetOrdinal: row.target_ordinal, paths: row.kind === "field_mismatch" ? diffPaths(parse(row.source_raw), parse(row.target_raw)) : [] }))
      : [];
    return { sourceCount, targetCount, missing, extra, fieldMismatches, orderMismatches, samples };
  }

  compareVectors(db) {
    const domainKey = "hub:vectors";
    const sourceCte = `WITH source AS (SELECT NULLIF(json_extract(j.value,'$.memoryId'),'') object_id,CAST(j.key AS INTEGER) ordinal,j.value raw_json,
      COALESCE(json_array_length(json_extract(j.value,'$.vector')),json_array_length(json_extract(j.value,'$.embedding')),0) dimensions,v2_vector_hash(j.value) vector_hash,
      v2_vector_metadata_hash(j.value) metadata_hash,CASE WHEN json_type(j.value,'$.vector')='array' AND json_array_length(json_extract(j.value,'$.vector'))>0 THEN 'vector' ELSE 'embedding' END vector_field,
      CASE WHEN json_type(j.value,'$.dimensions') IS NULL THEN 0 ELSE 1 END had_dimensions
      FROM runtime_domains r,json_each(r.data_json) j WHERE r.domain_key=?)`;
    const joined = db.prepare(`${sourceCte} SELECT COUNT(*) source_count,SUM(CASE WHEN v.memory_id IS NULL THEN 1 ELSE 0 END) missing,
      SUM(CASE WHEN v.memory_id IS NOT NULL AND (source.dimensions<>v.dimensions OR source.vector_hash<>v.vector_hash OR source.metadata_hash<>v2_json_hash(v.raw_metadata_json) OR source.vector_field<>v.source_vector_field OR source.had_dimensions<>v.source_had_dimensions) THEN 1 ELSE 0 END) field_mismatches,
      SUM(CASE WHEN v.memory_id IS NOT NULL AND (o.ordinal IS NULL OR source.ordinal<>o.ordinal) THEN 1 ELSE 0 END) order_mismatches
      FROM source LEFT JOIN v2_memory_vectors v ON v.memory_id=source.object_id AND v.deleted_at IS NULL
      LEFT JOIN v2_source_order o ON o.domain_key=? AND o.object_id=source.object_id AND o.deleted_at IS NULL`).get(domainKey, domainKey);
    const targetCount = Number(db.prepare("SELECT COUNT(*) count FROM v2_memory_vectors WHERE deleted_at IS NULL").get().count);
    const sourceCount = Number(joined.source_count || 0), missing = Number(joined.missing || 0), fieldMismatches = Number(joined.field_mismatches || 0), orderMismatches = Number(joined.order_mismatches || 0);
    const extra = Math.max(0, targetCount - (sourceCount - missing));
    const samples = missing || fieldMismatches || orderMismatches
      ? db.prepare(`${sourceCte} SELECT source.object_id,source.ordinal source_ordinal,o.ordinal target_ordinal,source.dimensions source_dimensions,v.dimensions target_dimensions,
          source.vector_field source_vector_field,v.source_vector_field target_vector_field,source.had_dimensions source_had_dimensions,v.source_had_dimensions target_had_dimensions,
          CASE WHEN v.memory_id IS NULL THEN 'missing' WHEN source.dimensions<>v.dimensions OR source.vector_hash<>v.vector_hash OR source.metadata_hash<>v2_json_hash(v.raw_metadata_json) OR source.vector_field<>v.source_vector_field OR source.had_dimensions<>v.source_had_dimensions THEN 'field_mismatch' ELSE 'order_mismatch' END kind
          FROM source LEFT JOIN v2_memory_vectors v ON v.memory_id=source.object_id AND v.deleted_at IS NULL
          LEFT JOIN v2_source_order o ON o.domain_key=? AND o.object_id=source.object_id AND o.deleted_at IS NULL
          WHERE v.memory_id IS NULL OR source.dimensions<>v.dimensions OR source.vector_hash<>v.vector_hash OR source.metadata_hash<>v2_json_hash(v.raw_metadata_json) OR source.vector_field<>v.source_vector_field OR source.had_dimensions<>v.source_had_dimensions OR o.ordinal IS NULL OR source.ordinal<>o.ordinal LIMIT ?`).all(domainKey, domainKey, this.sampleLimit)
          .map((row) => ({ kind: row.kind, objectId: row.object_id, sourceOrdinal: row.source_ordinal, targetOrdinal: row.target_ordinal, sourceDimensions: row.source_dimensions, targetDimensions: row.target_dimensions, sourceVectorField: row.source_vector_field, targetVectorField: row.target_vector_field, sourceHadDimensions: Boolean(row.source_had_dimensions), targetHadDimensions: Boolean(row.target_had_dimensions) }))
      : [];
    return { sourceCount, targetCount, missing, extra, fieldMismatches, orderMismatches, samples };
  }

  compareCharacterRuntime(db) {
    const source = db.prepare("SELECT data_json FROM runtime_domains WHERE domain_key='hub:characterRuntime'").get();
    const legacy = parse(source?.data_json || "{}") || {};
    const target = new RuntimeV2ReadRepository(db).characterRuntime();
    const sourceIds = Object.keys(legacy), targetIds = Object.keys(target);
    const missingIds = sourceIds.filter((id) => !(id in target));
    const extraIds = targetIds.filter((id) => !(id in legacy));
    const mismatches = sourceIds.filter((id) => id in target && JSON.stringify(legacy[id]) !== JSON.stringify(target[id]));
    return { sourceCount: sourceIds.length, targetCount: targetIds.length, missing: missingIds.length, extra: extraIds.length, fieldMismatches: mismatches.length, orderMismatches: 0, samples: [...missingIds.map((objectId) => ({ kind: "missing", objectId })), ...extraIds.map((objectId) => ({ kind: "extra", objectId })), ...mismatches.map((objectId) => ({ kind: "field_mismatch", objectId, paths: diffPaths(legacy[objectId], target[objectId]) }))].slice(0, this.sampleLimit) };
  }

  compareEventBoxMembers(db) {
    const sourceCte = `WITH boxes AS (SELECT json_extract(j.value,'$.id') box_id,j.value raw FROM runtime_domains r,json_each(r.data_json) j WHERE r.domain_key='hub:eventBoxes'),
      source AS (
        SELECT box_id,json_each.value memory_id,'live' member_state,CAST(json_each.key AS INTEGER) ordinal FROM boxes,json_each(json_extract(boxes.raw,'$.liveMemoryIds'))
        UNION ALL SELECT box_id,json_each.value,'archived',CAST(json_each.key AS INTEGER) FROM boxes,json_each(json_extract(boxes.raw,'$.archivedMemoryIds'))
        UNION ALL SELECT box_id,json_extract(raw,'$.summaryNodeId'),'summary',0 FROM boxes WHERE COALESCE(json_extract(raw,'$.summaryNodeId'),'')<>''
      )`;
    const joined = db.prepare(`${sourceCte} SELECT COUNT(*) source_count,SUM(CASE WHEN t.event_box_id IS NULL THEN 1 ELSE 0 END) missing,
      SUM(CASE WHEN t.event_box_id IS NOT NULL AND source.ordinal<>t.ordinal THEN 1 ELSE 0 END) order_mismatches
      FROM source LEFT JOIN v2_event_box_members t ON t.event_box_id=source.box_id AND t.memory_id=source.memory_id AND t.member_state=source.member_state AND t.deleted_at IS NULL`).get();
    const sourceCount = Number(joined.source_count || 0), missing = Number(joined.missing || 0), orderMismatches = Number(joined.order_mismatches || 0);
    const targetCount = Number(db.prepare("SELECT COUNT(*) count FROM v2_event_box_members WHERE deleted_at IS NULL").get().count);
    const extra = Math.max(0, targetCount - (sourceCount - missing));
    const samples = missing || orderMismatches
      ? db.prepare(`${sourceCte} SELECT source.box_id event_box_id,source.memory_id,source.member_state,source.ordinal source_ordinal,t.ordinal target_ordinal,
          CASE WHEN t.event_box_id IS NULL THEN 'missing' ELSE 'order_mismatch' END kind FROM source
          LEFT JOIN v2_event_box_members t ON t.event_box_id=source.box_id AND t.memory_id=source.memory_id AND t.member_state=source.member_state AND t.deleted_at IS NULL
          WHERE t.event_box_id IS NULL OR source.ordinal<>t.ordinal LIMIT ?`).all(this.sampleLimit)
      : [];
    return { sourceCount, targetCount, missing, extra, fieldMismatches: 0, orderMismatches, samples };
  }

  compareRoomPlateEntries(db) {
    const plateId = "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),COALESCE(NULLIF(json_extract(j.value,'$.charId'),''),'unbound') || ':' || COALESCE(NULLIF(json_extract(j.value,'$.room'),''),'unknown'))";
    const sourceCte = `WITH plates AS (SELECT ${plateId} plate_id,j.value raw FROM runtime_domains r,json_each(r.data_json) j WHERE r.domain_key='hub:roomPlates'),
      source AS (SELECT plate_id,COALESCE(NULLIF(json_extract(e.value,'$.id'),''),plate_id || ':entry:' || e.key) entry_id,CAST(e.key AS INTEGER) ordinal,e.value raw_json FROM plates,json_each(json_extract(plates.raw,'$.entries')) e)`;
    const joined = db.prepare(`${sourceCte} SELECT COUNT(*) source_count,SUM(CASE WHEN t.entry_id IS NULL THEN 1 ELSE 0 END) missing,
      SUM(CASE WHEN t.entry_id IS NOT NULL AND (source.raw_json<>t.raw_json OR source.plate_id<>t.room_plate_id) THEN 1 ELSE 0 END) field_mismatches,
      SUM(CASE WHEN t.entry_id IS NOT NULL AND source.ordinal<>t.ordinal THEN 1 ELSE 0 END) order_mismatches
      FROM source LEFT JOIN v2_room_plate_entries t ON t.entry_id=source.entry_id AND t.deleted_at IS NULL`).get();
    const sourceCount = Number(joined.source_count || 0), missing = Number(joined.missing || 0), fieldMismatches = Number(joined.field_mismatches || 0), orderMismatches = Number(joined.order_mismatches || 0);
    const targetCount = Number(db.prepare("SELECT COUNT(*) count FROM v2_room_plate_entries WHERE deleted_at IS NULL").get().count);
    const extra = Math.max(0, targetCount - (sourceCount - missing));
    const samples = missing || fieldMismatches || orderMismatches
      ? db.prepare(`${sourceCte} SELECT source.plate_id,source.entry_id,source.ordinal source_ordinal,t.ordinal target_ordinal,source.raw_json source_raw,t.raw_json target_raw,
          CASE WHEN t.entry_id IS NULL THEN 'missing' WHEN source.raw_json<>t.raw_json OR source.plate_id<>t.room_plate_id THEN 'field_mismatch' ELSE 'order_mismatch' END kind
          FROM source LEFT JOIN v2_room_plate_entries t ON t.entry_id=source.entry_id AND t.deleted_at IS NULL
          WHERE t.entry_id IS NULL OR source.raw_json<>t.raw_json OR source.plate_id<>t.room_plate_id OR source.ordinal<>t.ordinal LIMIT ?`).all(this.sampleLimit)
          .map((row) => ({ kind: row.kind, plateId: row.plate_id, entryId: row.entry_id, sourceOrdinal: row.source_ordinal, targetOrdinal: row.target_ordinal, paths: row.kind === "field_mismatch" ? diffPaths(parse(row.source_raw), parse(row.target_raw)) : [] }))
      : [];
    return { sourceCount, targetCount, missing, extra, fieldMismatches, orderMismatches, samples };
  }
}
