CREATE TABLE IF NOT EXISTS v2_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS v2_migration_runs (
  run_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  report_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS v2_migration_checkpoints (
  domain TEXT PRIMARY KEY,
  last_index INTEGER NOT NULL DEFAULT -1,
  migrated_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_shadow_domains (
  domain_key TEXT PRIMARY KEY,
  source_version INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'current',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_shadow_write_failures (
  failure_id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  source_hash TEXT,
  error_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_shadow_failures_open ON v2_shadow_write_failures(resolved_at, failure_id);

CREATE TABLE IF NOT EXISTS v2_runtime_control (
  control_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_runtime_promotions (
  promotion_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  parity_hash TEXT NOT NULL,
  parity_json TEXT NOT NULL,
  shadow_marker TEXT NOT NULL,
  baseline_native_mutation_seq INTEGER NOT NULL DEFAULT 0,
  prepared_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT,
  rolled_back_at TEXT,
  rollback_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_runtime_promotions_status ON v2_runtime_promotions(status, prepared_at DESC);

CREATE TABLE IF NOT EXISTS v2_source_order (
  domain_key TEXT NOT NULL,
  object_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(domain_key, object_id)
);
CREATE INDEX IF NOT EXISTS idx_v2_source_order_active ON v2_source_order(domain_key, deleted_at, ordinal);

CREATE TABLE IF NOT EXISTS v2_chat_turns (
  turn_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source_client_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_v2_chat_turns_character ON v2_chat_turns(character_id, started_at);

CREATE TABLE IF NOT EXISTS v2_messages (
  message_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  source_sequence_no INTEGER,
  character_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT,
  role TEXT NOT NULL,
  message_type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  surface TEXT NOT NULL,
  visibility TEXT NOT NULL,
  origin TEXT NOT NULL,
  source_client_id TEXT,
  source_message_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(source_client_id, source_message_id)
);
CREATE INDEX IF NOT EXISTS idx_v2_messages_character_seq ON v2_messages(character_id, message_seq);
CREATE INDEX IF NOT EXISTS idx_v2_messages_conversation_seq ON v2_messages(conversation_id, message_seq);
CREATE INDEX IF NOT EXISTS idx_v2_messages_turn ON v2_messages(turn_id, message_seq);
CREATE INDEX IF NOT EXISTS idx_v2_messages_surface ON v2_messages(character_id, surface, visibility, message_seq);

CREATE TABLE IF NOT EXISTS v2_message_attachments (
  attachment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_kind TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  byte_size INTEGER,
  content_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(message_id) REFERENCES v2_messages(message_id)
);

CREATE TABLE IF NOT EXISTS v2_memory_nodes (
  memory_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL DEFAULT 1,
  character_id TEXT NOT NULL,
  room TEXT NOT NULL,
  content TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  importance REAL NOT NULL DEFAULT 0,
  mood TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  event_box_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  is_box_summary INTEGER NOT NULL DEFAULT 0,
  embedded INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_memory_nodes_character_room ON v2_memory_nodes(character_id, room, created_at);
CREATE INDEX IF NOT EXISTS idx_v2_memory_nodes_event_box ON v2_memory_nodes(event_box_id);

CREATE TABLE IF NOT EXISTS v2_memory_vectors (
  memory_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL DEFAULT 1,
  character_id TEXT,
  model TEXT NOT NULL DEFAULT '',
  dimensions INTEGER NOT NULL,
  vector_blob BLOB NOT NULL,
  vector_hash TEXT NOT NULL,
  source_vector_field TEXT NOT NULL DEFAULT 'vector',
  source_had_dimensions INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  raw_metadata_json TEXT NOT NULL DEFAULT '{}',
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_memory_vectors_character ON v2_memory_vectors(character_id);

CREATE TABLE IF NOT EXISTS v2_memory_links (
  link_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL DEFAULT 1,
  character_id TEXT,
  source_memory_id TEXT NOT NULL,
  target_memory_id TEXT NOT NULL,
  link_type TEXT NOT NULL,
  strength REAL NOT NULL DEFAULT 0,
  activation_count INTEGER NOT NULL DEFAULT 0,
  last_activated_at TEXT,
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_memory_links_source ON v2_memory_links(source_memory_id, link_type);
CREATE INDEX IF NOT EXISTS idx_v2_memory_links_target ON v2_memory_links(target_memory_id, link_type);
CREATE INDEX IF NOT EXISTS idx_v2_memory_links_character ON v2_memory_links(character_id);

CREATE TABLE IF NOT EXISTS v2_event_boxes (
  event_box_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL DEFAULT 1,
  character_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  summary_memory_id TEXT,
  predecessor_box_id TEXT,
  compression_count INTEGER NOT NULL DEFAULT 0,
  sealed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_event_boxes_character ON v2_event_boxes(character_id, updated_at);

CREATE TABLE IF NOT EXISTS v2_event_box_members (
  event_box_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  member_state TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  PRIMARY KEY(event_box_id, memory_id, member_state)
);
CREATE INDEX IF NOT EXISTS idx_v2_event_box_members_memory ON v2_event_box_members(memory_id);

CREATE TABLE IF NOT EXISTS v2_room_plates (
  room_plate_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL DEFAULT 1,
  character_id TEXT NOT NULL,
  room TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(character_id, room)
);

CREATE TABLE IF NOT EXISTS v2_room_plate_entries (
  entry_id TEXT PRIMARY KEY,
  room_plate_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  room TEXT NOT NULL,
  text TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  first_learned_at TEXT,
  updated_at TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 1,
  ordinal INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_room_plate_entries_plate ON v2_room_plate_entries(room_plate_id, ordinal);

CREATE TABLE IF NOT EXISTS v2_anticipations (
  anticipation_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL DEFAULT 1,
  character_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  anchored_at TEXT,
  resolved_at TEXT,
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_anticipations_character ON v2_anticipations(character_id, status, created_at);

CREATE TABLE IF NOT EXISTS v2_digest_reports (
  digest_report_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL DEFAULT 1,
  character_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  examined_json TEXT NOT NULL DEFAULT '[]',
  outcomes_json TEXT NOT NULL DEFAULT '[]',
  plate_submissions_json TEXT NOT NULL DEFAULT '[]',
  plate_updated_json TEXT NOT NULL DEFAULT '[]',
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_digest_reports_character ON v2_digest_reports(character_id, created_at);

CREATE TABLE IF NOT EXISTS v2_character_runtime_state (
  character_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS v2_runtime_state_events (
  state_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  patch_json TEXT NOT NULL,
  command_id TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_runtime_state_events_character ON v2_runtime_state_events(character_id, state_event_id);

CREATE TABLE IF NOT EXISTS v2_cc_sessions (
  character_id TEXT PRIMARY KEY,
  runtime_type TEXT NOT NULL,
  session_id TEXT,
  last_seen_message_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_event_id INTEGER NOT NULL DEFAULT 0,
  stable_context_version INTEGER NOT NULL DEFAULT 0,
  stable_context_hash TEXT,
  last_wake_at TEXT,
  last_compacted_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_cc_wake_runs (
  wake_run_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  job_id TEXT,
  session_id TEXT,
  wake_reason TEXT NOT NULL,
  context_from_message_seq INTEGER NOT NULL DEFAULT 0,
  context_to_message_seq INTEGER NOT NULL DEFAULT 0,
  context_from_event_id INTEGER NOT NULL DEFAULT 0,
  context_to_event_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  context_json TEXT,
  context_hash TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  result_event_id INTEGER,
  error_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_cc_wake_runs_character ON v2_cc_wake_runs(character_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_cc_wake_runs_job ON v2_cc_wake_runs(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS v2_client_devices (
  client_id TEXT PRIMARY KEY,
  client_type TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  push_endpoint_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS v2_client_subscriptions (
  client_id TEXT NOT NULL,
  character_id TEXT,
  surface TEXT,
  visibility TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(client_id, character_id, surface, visibility)
);

CREATE TABLE IF NOT EXISTS v2_outbox_dead_letters (
  delivery_id TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL,
  target_client_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  last_error TEXT,
  payload_json TEXT NOT NULL,
  failed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_migration_issues (
  issue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  source_index INTEGER,
  object_id TEXT,
  issue_code TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_migration_issues_run ON v2_migration_issues(run_id, domain, issue_code);
