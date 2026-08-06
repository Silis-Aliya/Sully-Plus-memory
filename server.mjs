import http from "node:http";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
  EVENT_BOX_SUMMARY_TARGET_MAX_CHARS,
  PLATE_ENTRY_CAPS,
  PLATE_ENTRY_HARD_MAX_CHARS,
  PLATE_ROOMS,
  REFLECT_MAX_ASPIRES,
  REFLECT_MAX_DISTILLS,
  REFLECT_MAX_WORRIES,
  buildCompressionSystemPrompt,
  buildDigestSystemPrompt,
  buildExtractionSystemPrompt,
  buildExternalMemoryPrompt,
  buildMigrationSystemPrompt,
  buildPersonalityStylePrompt,
  buildPlateSystemPrompt,
  buildRecompressSummaryPrompt,
} from "./sullyMemoryPalacePrompts.mjs";
import {
  LEGACY_REFINE_TEMPLATES,
  buildLegacyMemoryContext,
  buildLegacyMonthlyRefinementRequest,
  legacyMonthFragments,
  normalizeLegacyMonth,
  runLegacyRecall,
} from "./sullyLegacyMemory.mjs";
import {
  buildSullyCoreContext,
  buildSullyImpressionRequest,
  normalizeUserImpression,
} from "./sullyImpression.mjs";
import {
  CONTRACT_PACKAGE_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  contractManifest,
  schemas as contractSchemas,
  validateContract,
} from "./packages/hub-contract/index.mjs";
import { AuthorityError, AuthorityStore, contentHash } from "./authorityStore.mjs";
import { normalizeSullyChatTurnRequest, sullyCompatibilityDescriptor } from "./sullyCompatAdapter.mjs";
import { buildContextParity } from "./contextParity.mjs";
import { buildScheduleInjection, resolveScheduleSlots } from "./sullyScheduleInjection.mjs";
import { RuntimeV2ReadRepository } from "./src/storage/runtimeV2ReadRepository.mjs";
import { RuntimeReadModeController } from "./src/storage/runtimeReadModeController.mjs";
import { RuntimeV2NativeCommandExecutor } from "./src/storage/runtimeV2NativeCommandExecutor.mjs";
import { RuntimeV2PromotionManager } from "./src/storage/runtimeV2PromotionManager.mjs";
import { deriveActivityStatePatch } from "./src/runtime/activityState.mjs";
import { formatSullyVrCardMessage } from "./sullyVrContext.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.MEMORY_HUB_PORT || 8787);
const HOST = process.env.MEMORY_HUB_HOST || "127.0.0.1";
const PUBLIC_BASE_URL = process.env.MEMORY_HUB_PUBLIC_URL || "";
const HUB_TOKEN = process.env.MEMORY_HUB_TOKEN || "";
const ALLOWED_ORIGINS = (process.env.MEMORY_HUB_ALLOWED_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const DATA_DIR = process.env.MEMORY_HUB_DATA_DIR || path.join(__dirname, ".memory-hub");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const DATA_FILE = path.join(DATA_DIR, "hub-data.json");
const RUNTIME_FILE = path.join(DATA_DIR, "runtime.json");
const AUTHORITY_DB_FILE = path.join(DATA_DIR, "authority.sqlite");
const MESSAGE_TEXT_MAX_BYTES = Math.max(1024, Number(process.env.MEMORY_HUB_MESSAGE_TEXT_MAX_BYTES || 64 * 1024));
const MESSAGE_INLINE_MEDIA_MAX_BYTES = Math.max(1024, Number(process.env.MEMORY_HUB_INLINE_MEDIA_MAX_BYTES || 1024 * 1024));
const MESSAGE_JSON_MAX_BYTES = Math.max(MESSAGE_TEXT_MAX_BYTES, Number(process.env.MEMORY_HUB_MESSAGE_JSON_MAX_BYTES || 2 * 1024 * 1024));
const STORAGE_QUOTA_BYTES = Math.max(100 * 1024 * 1024, Number(process.env.MEMORY_HUB_STORAGE_QUOTA_BYTES || 10 * 1024 * 1024 * 1024));
const ACTION_RUNTIME_INTERVAL_MS = Math.max(1000, Number(process.env.MEMORY_HUB_ACTION_RUNTIME_INTERVAL_MS || 5000));
const ACTION_RUNTIME_ENABLED = !["0", "false", "off"].includes(cleanEnv(process.env.MEMORY_HUB_ACTION_RUNTIME_ENABLED || "true").toLowerCase());
const RUNTIME_READ_MODE = cleanEnv(process.env.MEMORY_HUB_RUNTIME_READ_MODE || "legacy").toLowerCase();
const RUNTIME_PARITY_INTERVAL_MS = Math.max(60_000, Number(process.env.MEMORY_HUB_RUNTIME_PARITY_INTERVAL_MS || 15 * 60 * 1000));
const RUNTIME_NATIVE_WRITES_ENABLED = ["1", "true", "on"].includes(cleanEnv(process.env.MEMORY_HUB_RUNTIME_NATIVE_WRITES_ENABLED || "false").toLowerCase());

function cleanEnv(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

async function loadDotEnv(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env is optional.
  }
}

const ROOMS = new Set([
  "living_room",
  "bedroom",
  "study",
  "user_room",
  "self_room",
  "attic",
  "windowsill",
]);

// Keep these values aligned with SullyOS utils/memoryPalace/types.ts.
const MEMORY_ROOM_CONFIGS = {
  living_room: { capacity: 200, decayRate: 0.9972 },
  bedroom: { capacity: null, decayRate: 0.9995 },
  study: { capacity: null, decayRate: 0.9995 },
  user_room: { capacity: null, decayRate: 0.9995 },
  self_room: { capacity: null, decayRate: null },
  attic: { capacity: null, decayRate: null },
  windowsill: { capacity: null, decayRate: null },
};

const EFFECTIVE_IMPORTANCE_FLOOR_RATIOS = {
  living_room: 0.8,
  bedroom: 0.9,
  study: 0.9,
  user_room: 0.9,
  self_room: 1,
  attic: 1,
  windowsill: 1,
};

const DEFAULT_SETTINGS = {
  sullyUrl: process.env.SULLYOS_EXPORT_BASE_URL || "http://localhost:5173",
  exportPath: "/memory-palace/export.json",
  ombreUrl: process.env.OMBRE_SULLY_BRIDGE_URL || "http://localhost:8000",
  ombreBridgeKey: process.env.OMBRE_SULLY_BRIDGE_KEY || "",
  syncMode: "readonly",
  embeddingSource: process.env.EMBEDDING_SOURCE || "sully",
  embeddingBaseUrl: "",
  embeddingApiKey: "",
  embeddingModel: "",
  embeddingDimensions: "",
  lightLLMSource: process.env.LIGHT_LLM_SOURCE || "sully",
  lightLLMBaseUrl: "",
  lightLLMApiKey: "",
  lightLLMModel: "",
  rerankSource: process.env.RERANK_SOURCE || "sully",
  rerankEnabled: false,
  rerankBaseUrl: "",
  rerankApiKey: "",
  rerankModel: "",
  rerankTopN: 5,
  digestAutoEnabled: true,
  digestAutoRounds: 50,
};

const EMPTY_DATA = {
  characters: [],
  memories: [],
  vectors: [],
  embeddingConfig: {},
  modelConfig: {},
  memoryPalaceConfig: {},
  activity: {},
  links: [],
  roomPlates: [],
  impressions: [],
  coreMemories: [],
  feels: [],
  eventBoxes: [],
  anticipations: [],
  digestReports: [],
  digestRoundCounters: {},
  lastDigestAt: {},
};

const EMPTY_RUNTIME = {
  version: 1,
  nextMessageSeq: 1,
  messages: [],
  highWaterMarks: {},
  pendingJobs: {},
  digestRoundCounters: {},
  lastRuns: {},
};

const RUNTIME_HOT_ZONE_SIZE = 200;
const RUNTIME_BUFFER_THRESHOLD = 100;
const RUNTIME_PROCESS_RATIO = 0.85;
const RUNTIME_CHUNK_SIZE = 250;
const runtimeProcessingLocks = new Set();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

await fs.mkdir(DATA_DIR, { recursive: true });
let hubDataCache = null;
let runtimeDataCache = null;
const authorityStore = new AuthorityStore(AUTHORITY_DB_FILE);
const runtimeV2Reader = new RuntimeV2ReadRepository(authorityStore.db);
const runtimeReadMode = new RuntimeReadModeController({
  mode: RUNTIME_READ_MODE,
  databaseFile: AUTHORITY_DB_FILE,
  intervalMs: RUNTIME_PARITY_INTERVAL_MS,
  authorityMode: () => authorityStore.runtimeV2.authorityMode(),
  authorityHealth: () => authorityStore.runtimeV2Health(),
});
runtimeReadMode.initialize();
const runtimeNativeCommands = new RuntimeV2NativeCommandExecutor(authorityStore, { protocolVersion: PROTOCOL_VERSION });
const runtimeV2Promotion = new RuntimeV2PromotionManager(authorityStore);
const V2_RUNTIME_DOMAINS = ["memories", "vectors", "links", "eventBoxes", "roomPlates", "anticipations", "digestReports", "characterRuntime"];

function useV2RuntimeReads() {
  const authoritative = authorityStore.runtimeV2.authorityMode() === "v2";
  if (!runtimeReadMode.usesV2Reads()) {
    if (authoritative) throw new AuthorityError("V2_AUTHORITY_UNAVAILABLE", "V2 authority is active but unavailable; legacy fallback is blocked", 503, runtimeReadMode.publicStatus());
    return false;
  }
  const health = authorityStore.runtimeV2Health();
  if (health.ok) return true;
  runtimeReadMode.degrade(`V2 shadow write health failed (${health.openFailures} open failures, ${health.failedDomains} failed domains)`);
  if (authoritative) throw new AuthorityError("V2_AUTHORITY_UNAVAILABLE", "V2 authority health failed; legacy fallback is blocked", 503, { health, readMode: runtimeReadMode.publicStatus() });
  return false;
}
const CHARACTER_DEFINITION_FIELDS = new Set([
  "characterId", "name", "avatar", "description", "systemPrompt", "worldview",
  "exampleDialogue", "writerPersona", "personalityStyle", "ruminationTendency", "timeZone",
]);
const CHARACTER_METADATA_FIELDS = new Set(["id", "version", "updatedAt", "deletedAt", "sourceAuthority", "_hash", "_fieldVersions"]);

function splitCharacterProfile(character) {
  const id = clean(character?.characterId || character?.id || "");
  const definition = { characterId: id };
  const runtime = { id };
  for (const [key, value] of Object.entries(character || {})) {
    if (CHARACTER_METADATA_FIELDS.has(key) || key === "mountedWorldbooks") continue;
    if (CHARACTER_DEFINITION_FIELDS.has(key)) definition[key] = value;
    else runtime[key] = value;
  }
  if (!definition.name) definition.name = id || "Unnamed Character";
  return { id, definition, runtime, mountedWorldbooks: Array.isArray(character?.mountedWorldbooks) ? character.mountedWorldbooks : [] };
}

function persistCharacterDefinitions(characters, actorId = "unified-state") {
  const runtimeById = {};
  for (const character of characters || []) {
    const split = splitCharacterProfile(character);
    if (!split.id) continue;
    authorityStore.putEntity("character", split.id, split.definition, { actorId, sourceAuthority: "hub" });
    runtimeById[split.id] = split.runtime;
    for (const mounted of split.mountedWorldbooks) {
      const worldbookId = clean(mounted?.worldbookId || mounted?.id || "");
      if (!worldbookId) continue;
      if (!authorityStore.getEntity("worldbook", worldbookId)) {
        authorityStore.putEntity("worldbook", worldbookId, { ...mounted, worldbookId }, { actorId, sourceAuthority: "hub" });
      }
      try { authorityStore.mountWorldbook(split.id, worldbookId, { actorId }); } catch {}
    }
  }
  return runtimeById;
}

function canonicalizeHubState(data, actorId = "unified-state") {
  const source = data && typeof data === "object" ? data : EMPTY_DATA;
  const runtimeById = persistCharacterDefinitions(source.characters || [], actorId);
  const state = { ...source, unifiedStateVersion: 1, characterRuntime: runtimeById };
  delete state.characters;
  return state;
}

function materializeHubState(state) {
  const source = state && typeof state === "object" ? state : EMPTY_DATA;
  const runtimeById = source.characterRuntime && typeof source.characterRuntime === "object" ? source.characterRuntime : {};
  const worldbooks = new Map(authorityStore.listEntities("worldbook", { limit: 5000 }).map((record) => [record.entityId, record.data]));
  const characters = authorityStore.listEntities("character", { limit: 5000 }).map((record) => {
    const mountedWorldbooks = authorityStore.listMounts(record.entityId)
      .map((mount) => worldbooks.get(mount.worldbookId))
      .filter(Boolean);
    return { id: record.entityId, ...record.data, ...(runtimeById[record.entityId] || {}), mountedWorldbooks };
  });
  const data = { ...source, characters };
  delete data.characterRuntime;
  return data;
}

function refreshHubDataCache() {
  hubDataCache = materializeHubState(loadHubRuntimeDomains());
  return hubDataCache;
}

function loadHubRuntimeDomains() {
  const rows = authorityStore.listRuntimeDomains();
  const legacy = Object.fromEntries(Object.entries(rows)
    .filter(([key]) => key.startsWith("hub:"))
    .map(([key, record]) => [key.slice(4), record.data]));
  if (!useV2RuntimeReads()) return legacy;
  for (const domain of V2_RUNTIME_DOMAINS) legacy[domain] = runtimeV2Reader.getDomain(domain);
  return legacy;
}

function persistHubRuntimeDomains(canonical) {
  const desired = new Set(Object.keys(canonical || {}).map((key) => `hub:${key}`));
  const current = authorityStore.listRuntimeDomainKeys();
  for (const [key, value] of Object.entries(canonical || {})) authorityStore.putRuntimeDomain(`hub:${key}`, value);
  for (const key of current) if (key.startsWith("hub:") && !desired.has(key)) authorityStore.deleteRuntimeDomain(key);
}

function loadMessageRuntime() {
  const meta = authorityStore.getRuntimeDomain("message:meta", EMPTY_RUNTIME)?.data || EMPTY_RUNTIME;
  const messages = useV2RuntimeReads() ? runtimeV2Reader.listMessages() : authorityStore.listRuntimeMessages();
  return { ...EMPTY_RUNTIME, ...meta, messages };
}

function persistMessageRuntime(runtime) {
  const meta = { ...(runtime || EMPTY_RUNTIME) };
  const messages = Array.isArray(meta.messages) ? meta.messages : [];
  delete meta.messages;
  authorityStore.replaceRuntimeMessages(messages);
  authorityStore.putRuntimeDomain("message:meta", meta);
}

const RUNTIME_SURFACES = new Set(["chat", "activity", "world", "state", "memory", "schedule", "system"]);
const RUNTIME_VISIBILITIES = new Set(["user", "internal"]);

function normalizeRuntimeSurface(value, fallback = "") {
  const normalized = clean(value).toLowerCase();
  return RUNTIME_SURFACES.has(normalized) ? normalized : fallback;
}

function inferRuntimeMessageSurface(item = {}) {
  const explicit = normalizeRuntimeSurface(item.surface || item.metadata?.surface || item.metadata?.runtimeSurface);
  if (explicit) return explicit;
  const hint = clean(item.type || item.metadata?.eventType || item.metadata?.kind || "").toLowerCase();
  if (/(memory|legacy|impression|recall)/.test(hint)) return "memory";
  if (/(world|scene|location|room)/.test(hint)) return "world";
  if (/(schedule|reminder|task|job)/.test(hint)) return "schedule";
  if (/(state|emotion|mood|buff|energy|relationship|anticipation)/.test(hint)) return "state";
  if (/(activity|action|life[_-]?sim|diary)/.test(hint)) return "activity";
  if (clean(item.role).toLowerCase() === "system") return "system";
  return "chat";
}

function effectiveRuntimeMessageScope(item = {}) {
  const type = clean(item.type || item.messageType || item.metadata?.eventType || item.metadata?.kind).toLowerCase();
  const role = clean(item.role).toLowerCase();
  const content = clean(item.content || item.text || item.body || "");
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const explicitSurface = normalizeRuntimeSurface(item.surface || metadata.surface || metadata.runtimeSurface);
  // SullyOS historically stored every rendered phone item in one chat array.
  // These structural records are not dialogue even when legacy data says
  // surface=chat. Keep the stored source untouched and derive the read surface.
  if (type === "vr_card" || metadata.vrCard === true || /^「彼方\s*[·・]/.test(content)) {
    return { surface: "activity", visibility: "internal", conversationId: null };
  }
  if (metadata.hidden === true || metadata.proactiveHint === true) {
    return { surface: "system", visibility: "internal", conversationId: null };
  }
  // An explicitly assigned non-chat domain is authoritative. In particular,
  // activity records may legitimately use role=system without becoming system
  // control messages on read.
  if (explicitSurface && explicitSurface !== "chat") {
    return { surface: explicitSurface, visibility: normalizeRuntimeVisibility(item.visibility || metadata.visibility, explicitSurface), conversationId: null };
  }
  const chatSystemCard = ["score_card", "music_invite_result"].includes(type);
  if (role === "system" && !chatSystemCard) {
    return { surface: "system", visibility: "internal", conversationId: null };
  }
  const surface = inferRuntimeMessageSurface(item);
  const visibility = normalizeRuntimeVisibility(item.visibility || metadata.visibility, surface);
  const charId = clean(item.charId || item.characterId);
  const conversationId = surface === "chat" ? clean(item.conversationId || metadata.conversationId || `direct:me:${charId}`) : null;
  return { surface, visibility, conversationId };
}

function normalizeRuntimeVisibility(value, surface) {
  const normalized = clean(value).toLowerCase();
  if (RUNTIME_VISIBILITIES.has(normalized)) return normalized;
  return surface === "chat" ? "user" : "internal";
}

function inferRuntimeOrigin(item = {}, role = "") {
  const explicit = clean(item.origin || item.metadata?.origin).toLowerCase();
  if (explicit) return explicit;
  if (item.metadata?.proactive || item.metadata?.jobId) return "scheduler";
  if (role === "assistant") return "character";
  if (role === "user") return "user";
  return "system";
}

function normalizeRuntimeMessageScope(item = {}, charId = "", role = "") {
  const surface = inferRuntimeMessageSurface(item);
  const visibility = normalizeRuntimeVisibility(item.visibility || item.metadata?.visibility, surface);
  const conversationId = surface === "chat"
    ? clean(item.conversationId || item.metadata?.conversationId || `direct:me:${charId}`)
    : null;
  return { surface, visibility, conversationId, origin: inferRuntimeOrigin(item, role) };
}

function isChatRuntimeMessage(item = {}, conversationId = "") {
  const scope = effectiveRuntimeMessageScope(item);
  if (scope.surface !== "chat" || scope.visibility !== "user") return false;
  return !conversationId || scope.conversationId === conversationId;
}

function isVrCardRuntimeMessage(item = {}) {
  const type = clean(item.type || item.messageType).toLowerCase();
  const content = clean(item.content || item.text || item.body || "");
  return type === "vr_card" || item.metadata?.vrCard === true || /^「彼方\s*[·・]/.test(content);
}

function inferEventSurface(type = "") {
  const normalized = clean(type).toLowerCase();
  if (normalized.startsWith("message.")) return "chat";
  if (normalized.startsWith("memory.") || normalized.includes("recall") || normalized.includes("impression") || normalized.includes("legacy")) return "memory";
  if (normalized.startsWith("world.") || normalized.startsWith("scene.") || normalized.includes("location")) return "world";
  if (normalized.startsWith("schedule.") || normalized.startsWith("job.")) return "schedule";
  if (normalized.startsWith("character.state") || normalized.includes("emotion") || normalized.includes("mood") || normalized.includes("buff")) return "state";
  if (normalized.startsWith("character.activity") || normalized.startsWith("activity.")) return "activity";
  return "system";
}

function decorateHubEvent(event = {}) {
  const embeddedMessage = event.payload?.message;
  const embeddedScope = embeddedMessage && typeof embeddedMessage === "object" ? effectiveRuntimeMessageScope(embeddedMessage) : null;
  const surface = embeddedScope?.surface || normalizeRuntimeSurface(event.surface, inferEventSurface(event.type));
  const visibility = embeddedScope?.visibility || normalizeRuntimeVisibility(event.visibility, surface === "chat" ? "chat" : surface);
  return { ...event, surface, visibility };
}

function scheduleFeatureOn(character = {}) {
  return character.scheduleFeatureEnabled === true
    || (character.scheduleFeatureEnabled !== false && Boolean(character.scheduleStyle));
}

function resolveCharacterTimeZone(character = {}) {
  return character.customTimezoneEnabled && clean(character.customTimezone)
    ? clean(character.customTimezone)
    : "";
}

function nowInCharacterTimeZone(character = {}, base = new Date()) {
  const timeZone = resolveCharacterTimeZone(character);
  if (!timeZone) return base;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(base);
    const map = {};
    for (const part of parts) map[part.type] = part.value;
    let hour = Number.parseInt(map.hour, 10);
    if (hour === 24) hour = 0;
    return new Date(
      Number.parseInt(map.year, 10), Number.parseInt(map.month, 10) - 1, Number.parseInt(map.day, 10),
      hour, Number.parseInt(map.minute, 10), Number.parseInt(map.second, 10),
    );
  } catch {
    return base;
  }
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function runtimeCollectionValues(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((item) => Array.isArray(item) ? item : [item]);
}

function resolveHubDailySchedule(data = {}, character = {}, baseNow = new Date()) {
  if (!scheduleFeatureOn(character)) return null;
  const wallNow = nowInCharacterTimeZone(character, baseNow);
  const dateKey = localDateKey(wallNow);
  const characterId = clean(character.id || character.characterId || "");
  const schedules = runtimeCollectionValues(data.dailySchedules)
    .filter((item) => item && clean(item.charId || item.characterId || "") === characterId && Array.isArray(item.slots));
  return schedules.find((item) => clean(item.date || "") === dateKey || clean(item.id || "") === `${characterId}_${dateKey}`)
    || schedules.find((item) => {
      const generatedAt = Number(item.generatedAt);
      return Number.isFinite(generatedAt) && localDateKey(nowInCharacterTimeZone(character, new Date(generatedAt))) === dateKey;
    })
    || null;
}

function runtimeActivityDetails(state = {}, character = {}) {
  const activity = state.activity ?? character.activity;
  const object = activity && typeof activity === "object" && !Array.isArray(activity) ? activity : {};
  const name = typeof activity === "string"
    ? clean(activity)
    : clean(object.activity || object.name || object.label || object.title || object.type || "");
  const rawLocation = state.location ?? object.location ?? character.location;
  const location = typeof rawLocation === "string"
    ? clean(rawLocation)
    : clean(rawLocation?.name || rawLocation?.label || rawLocation?.sceneName || rawLocation?.sceneId || rawLocation?.location || "");
  return {
    name,
    location,
    innerThought: clean(state.innerState || state.evolvedNarrative || object.innerThought || ""),
    startedAt: object.startedAt || state.activityStartedAt || null,
  };
}

function buildHubScheduleRuntimeContext(data = {}, character = {}, snapshot = null, nowValue = Date.now()) {
  const parsedNow = new Date(nowValue ?? Date.now());
  const baseNow = Number.isNaN(parsedNow.getTime()) ? new Date() : parsedNow;
  const wallNow = nowInCharacterTimeZone(character, baseNow);
  const activity = runtimeActivityDetails(snapshot?.state || {}, character);
  const scheduleEnabled = scheduleFeatureOn(character);
  if (!scheduleEnabled && !activity.name) return { text: "", schedule: null, wallNow };
  const storedSchedule = scheduleEnabled ? resolveHubDailySchedule(data, character, baseNow) : null;
  let schedule = storedSchedule ? { ...storedSchedule, slots: storedSchedule.slots.map((slot) => ({ ...slot })) } : null;

  if (activity.name) {
    if (!schedule?.slots?.length) {
      const startDate = activity.startedAt ? nowInCharacterTimeZone(character, new Date(activity.startedAt)) : wallNow;
      const safeStart = Number.isNaN(startDate.getTime()) ? wallNow : startDate;
      schedule = {
        id: `${clean(character.id || character.characterId)}_${localDateKey(wallNow)}`,
        charId: clean(character.id || character.characterId),
        date: localDateKey(wallNow),
        generatedAt: baseNow.getTime(),
        slots: [{ startTime: `${String(safeStart.getHours()).padStart(2, "0")}:${String(safeStart.getMinutes()).padStart(2, "0")}`, activity: activity.name, ...(activity.location ? { location: activity.location } : {}), ...(activity.innerThought ? { innerThought: activity.innerThought } : {}) }],
      };
    } else {
      const resolved = resolveScheduleSlots(schedule, wallNow);
      const index = resolved.current ? schedule.slots.indexOf(resolved.current) : -1;
      if (index >= 0) {
        schedule.slots[index] = { ...schedule.slots[index], activity: activity.name, ...(activity.location ? { location: activity.location } : {}), ...(activity.innerThought ? { innerThought: activity.innerThought } : {}) };
      } else {
        schedule.slots.unshift({ startTime: `${String(wallNow.getHours()).padStart(2, "0")}:${String(wallNow.getMinutes()).padStart(2, "0")}`, activity: activity.name, ...(activity.location ? { location: activity.location } : {}), ...(activity.innerThought ? { innerThought: activity.innerThought } : {}) });
      }
    }
  }

  const evolvedNarrative = activity.innerThought || undefined;
  return { text: schedule ? buildScheduleInjection(schedule, evolvedNarrative, wallNow) : "", schedule, wallNow };
}

const MIGRATION_RUNTIME_FALLBACKS = {
  scheduled_message: "scheduledMessages",
  daily_schedule: "dailySchedules",
  world_episode: "worldEpisodes",
  story_theater: "storyTheaters",
  story_theater_preset: "storyTheaterPresets",
  story_theater_mask: "storyTheaterMasks",
  group: "groups",
  character_group: "characterGroups",
  topic_box: "topicBoxes",
  digest_report: "digestReports",
  memory_batch: "memoryBatches",
  life_sim_state: "lifeSimState",
  vr_music_room_state: "vrMusicRoom",
  vr_guestbook_state: "vrGuestbook",
  realtime_config: "realtimeConfig",
};

function promoteLegacyRuntimeIfNeeded() {
  if (Object.keys(loadHubRuntimeDomains()).length) return false;
  const hubDocument = authorityStore.getStateDocument("hub-runtime")?.data || EMPTY_DATA;
  const materialized = Array.isArray(hubDocument?.characters) ? hubDocument : materializeHubState(hubDocument);
  const runtimeDocument = authorityStore.getStateDocument("message-runtime")?.data || EMPTY_RUNTIME;
  const archived = authorityStore.migrationObjectsByDomain();
  const runtime = { ...EMPTY_RUNTIME, ...runtimeDocument };
  if (!Array.isArray(runtime.messages) || runtime.messages.length === 0) runtime.messages = archived.message || [];
  runtime.nextMessageSeq = runtime.messages.reduce((max, item) => Math.max(max, Number(item?.id || 0) + 1), Math.max(Number(runtime.nextMessageSeq || 1), runtime.messages.length + 1));
  authorityStore.transaction(() => {
    const canonical = canonicalizeHubState(materialized, "runtime-promotion");
    for (const [domain, key] of Object.entries(MIGRATION_RUNTIME_FALLBACKS)) {
      const items = archived[domain] || [];
      if (!items.length) continue;
      if (domain.endsWith("_state") || domain === "realtime_config") canonical[key] = items[0];
      else if (!Array.isArray(canonical[key]) || canonical[key].length === 0) canonical[key] = items;
    }
    persistHubRuntimeDomains(canonical);
    persistMessageRuntime(runtime);
    authorityStore.finalizeRuntimePromotion({ actorId: "runtime-promotion" });
  });
  return true;
}

promoteLegacyRuntimeIfNeeded();
hubDataCache = materializeHubState(loadHubRuntimeDomains());
runtimeDataCache = loadMessageRuntime();

function corsOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return "*";
  if (ALLOWED_ORIGINS.includes("*")) return origin;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (!ALLOWED_ORIGINS.length && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)) return origin;
  return "";
}

function send(reqOrRes, resOrStatus, statusOrBody, bodyOrHeaders = {}, maybeHeaders = {}) {
  const hasReq = typeof reqOrRes.method === "string";
  const req = hasReq ? reqOrRes : { headers: {} };
  const res = hasReq ? resOrStatus : reqOrRes;
  const status = hasReq ? statusOrBody : resOrStatus;
  const body = hasReq ? bodyOrHeaders : statusOrBody;
  const headers = hasReq ? maybeHeaders : bodyOrHeaders;
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const origin = corsOrigin(req);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Memory-Hub-Token, X-Sully-Bridge-Key",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    ...headers,
  });
  res.end(payload);
}

function isPublicApi(pathname) {
  return pathname === "/api/health";
}

function authorized(req) {
  if (!HUB_TOKEN) return true;
  const token = String(req.headers["x-memory-hub-token"] || "")
    || String(req.headers["x-sully-bridge-key"] || "")
    || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return token === HUB_TOKEN;
}

async function readJsonFile(file, fallback, options = {}) {
  if (file === DATA_FILE && hubDataCache) return hubDataCache;
  if (file === RUNTIME_FILE && runtimeDataCache) return runtimeDataCache;
  if (file === DATA_FILE) return refreshHubDataCache();
  if (file === RUNTIME_FILE) return (runtimeDataCache = loadMessageRuntime());
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (file === DATA_FILE) hubDataCache = parsed;
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (file === DATA_FILE) {
      try {
        return JSON.parse(await fs.readFile(`${file}.bak`, "utf8"));
      } catch {
        if (options.allowCorruptFallback) return fallback;
        throw new Error(`Memory Hub data file is not valid JSON: ${file}. Please restore from backup or re-import SullyOS JSON.`);
      }
    }
    return fallback;
  }
}

async function writeJsonFile(file, data) {
  if (file === DATA_FILE || file === RUNTIME_FILE) {
    JSON.parse(JSON.stringify(data));
    authorityStore.transaction(() => {
      if (file === DATA_FILE) persistHubRuntimeDomains(canonicalizeHubState(data, "memory-hub-runtime"));
      else persistMessageRuntime(data);
    });
    if (file === DATA_FILE) hubDataCache = materializeHubState(loadHubRuntimeDomains());
    if (file === RUNTIME_FILE) runtimeDataCache = loadMessageRuntime();
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(data);
  JSON.parse(payload);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${file}.bak`;
  let existingFileIsValid = false;
  if (file === DATA_FILE) {
    try {
      const current = await fs.readFile(file, "utf8");
      JSON.parse(current);
      existingFileIsValid = true;
      await fs.writeFile(backup, current, "utf8");
    } catch {
      // Do not promote an invalid current file to backup.
    }
  }
  await fs.writeFile(tmp, payload, "utf8");
  JSON.parse(await fs.readFile(tmp, "utf8"));
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    if (process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EEXIST")) {
      if (file === DATA_FILE) {
        const displaced = existingFileIsValid ? `${file}.previous-${Date.now()}` : `${file}.corrupt-${Date.now()}`;
        try { await fs.rename(file, displaced); }
        catch { await fs.rm(file, { force: true }); }
      } else {
        await fs.rm(file, { force: true });
      }
      await fs.rename(tmp, file);
    } else {
      try { await fs.rm(tmp, { force: true }); } catch {}
      throw error;
    }
  }
  if (file === DATA_FILE) hubDataCache = data;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function clean(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value).trim();
}

function room(value) {
  const raw = clean(value, "living_room");
  const aliases = {
    living: "living_room",
    "瀹㈠巺": "living_room",
    "鍗у": "bedroom",
    "书房": "study",
    user: "user_room",
    userRoom: "user_room",
    "鐢ㄦ埛鎴块棿": "user_room",
    self: "self_room",
    selfRoom: "self_room",
    "鑷垜鎴块棿": "self_room",
    "闃佹ゼ": "attic",
    "绐楀彴": "windowsill",
  };
  const normalized = aliases[raw] || raw;
  return ROOMS.has(normalized) ? normalized : "living_room";
}

function extractEmbeddingConfig(source = {}) {
  const configs = [
    source.embeddingConfig,
    source.embedding,
    source.modelConfig?.embedding,
    source.memoryPalaceConfig?.embedding,
    source.memoryPalaceConfig?.embeddingConfig,
    source.memoryPalace?.embedding,
    source.memoryPalace?.embeddingConfig,
    source.settings?.memoryPalaceConfig?.embedding,
    source.settings?.embedding,
    source.config?.embedding,
  ].filter(Boolean);
  const merged = Object.assign({}, ...configs);
  return {
    baseUrl: clean(merged.baseUrl || merged.apiBase || merged.api_base || merged.endpoint || merged.url || merged.embeddingBaseUrl || ""),
    apiKey: clean(merged.apiKey || merged.api_key || merged.key || merged.token || merged.embeddingApiKey || ""),
    model: clean(merged.model || merged.modelName || merged.embeddingModel || ""),
    dimensions: clean(merged.dimensions || merged.dimension || merged.dims || merged.embeddingDimensions || ""),
  };
}

function normalizeApiConfig(config = {}, fallback = {}) {
  const merged = { ...fallback, ...(config || {}) };
  return {
    baseUrl: clean(merged.baseUrl || merged.apiBase || merged.api_base || merged.endpoint || merged.url || ""),
    apiKey: clean(merged.apiKey || merged.api_key || merged.key || merged.token || ""),
    model: clean(merged.model || merged.modelName || ""),
  };
}

function normalizeComparableUrl(baseUrl = "") {
  return clean(baseUrl).replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function extractModelConfig(source = {}) {
  const palace = source.memoryPalaceConfig || source.modelConfig || source.memoryPalace || source.settings?.memoryPalaceConfig || {};
  const embedding = extractEmbeddingConfig(source);
  const rawRerank = palace.rerank || source.rerank || source.rerankConfig || source.settings?.rerank || {};
  const lightLLM = normalizeApiConfig(
    palace.lightLLM || palace.lightLlm || palace.lightApi || source.lightLLM || source.lightLlm || source.settings?.lightLLM,
    { apiKey: embedding.apiKey || "" }
  );
  if (!lightLLM.apiKey && embedding.apiKey && lightLLM.baseUrl && normalizeComparableUrl(lightLLM.baseUrl) === normalizeComparableUrl(embedding.baseUrl)) lightLLM.apiKey = embedding.apiKey;
  const rerank = {
    ...normalizeApiConfig(rawRerank, { model: "BAAI/bge-reranker-v2-m3", apiKey: embedding.apiKey || "" }),
    enabled: Boolean(rawRerank.enabled ?? rawRerank.rerankEnabled ?? rawRerank.useRerank ?? rawRerank.baseUrl ?? rawRerank.model),
    topN: Number(rawRerank.topN || rawRerank.top_n || rawRerank.limit || 5) || 5,
  };
  if (!rerank.apiKey && embedding.apiKey && rerank.baseUrl && normalizeComparableUrl(rerank.baseUrl) === normalizeComparableUrl(embedding.baseUrl)) rerank.apiKey = embedding.apiKey;
  return { embedding, lightLLM, rerank };
}

function hasApiConfigValue(config = {}) {
  return Boolean(config.baseUrl || config.apiKey || config.model || config.dimensions || config.enabled || config.topN);
}

function mergeModelConfigFromPayload(data = {}, payload = {}) {
  const palace = payload.memoryPalaceConfig || payload.modelConfig || payload.memoryPalace || payload.settings?.memoryPalaceConfig || {};
  const hasEmbeddingInput = Boolean(
    payload.embeddingConfig
    || payload.embedding
    || palace.embedding
    || palace.embeddingConfig
    || payload.settings?.embedding
    || payload.config?.embedding
  );
  const hasLightLLMInput = Boolean(
    palace.lightLLM
    || palace.lightLlm
    || palace.lightApi
    || payload.lightLLM
    || payload.lightLlm
    || payload.settings?.lightLLM
  );
  const hasRerankInput = Boolean(
    palace.rerank
    || payload.rerank
    || payload.rerankConfig
    || payload.settings?.rerank
  );
  if (!hasEmbeddingInput && !hasLightLLMInput && !hasRerankInput) return false;

  const modelConfig = extractModelConfig(payload);
  const hasEmbedding = hasEmbeddingInput && hasApiConfigValue(modelConfig.embedding);
  const hasLightLLM = hasLightLLMInput && hasApiConfigValue(modelConfig.lightLLM);
  const hasRerank = hasRerankInput && hasApiConfigValue(modelConfig.rerank);

  data.embeddingConfig = hasEmbedding
    ? { ...(data.embeddingConfig || {}), ...modelConfig.embedding }
    : (data.embeddingConfig || {});
  data.modelConfig = {
    ...(data.modelConfig || {}),
    ...(hasEmbedding ? { embedding: { ...((data.modelConfig || {}).embedding || {}), ...modelConfig.embedding } } : {}),
    ...(hasLightLLM ? { lightLLM: { ...((data.modelConfig || {}).lightLLM || {}), ...modelConfig.lightLLM } } : {}),
    ...(hasRerank ? { rerank: { ...((data.modelConfig || {}).rerank || {}), ...modelConfig.rerank } } : {}),
  };
  data.memoryPalaceConfig = {
    ...(data.memoryPalaceConfig || {}),
    ...(hasEmbedding ? { embedding: { ...((data.memoryPalaceConfig || {}).embedding || {}), ...modelConfig.embedding } } : {}),
    ...(hasLightLLM ? { lightLLM: { ...((data.memoryPalaceConfig || {}).lightLLM || {}), ...modelConfig.lightLLM } } : {}),
    ...(hasRerank ? { rerank: { ...((data.memoryPalaceConfig || {}).rerank || {}), ...modelConfig.rerank } } : {}),
  };
  return true;
}

function normalizeCoreMemoryEntries(raw, context = {}) {
  const charId = clean(context.charId || context.id || "");
  const charName = clean(context.charName || context.name || "");
  const sourceName = clean(context.source || "sullyos_ai_context");
  const toItem = (value, key, index = 0) => {
    const entry = value && typeof value === "object" && !Array.isArray(value) ? value : { summary: value };
    const period = clean(entry.period || entry.month || entry.date || entry.key || key || "");
    const content = clean(entry.content || entry.text || entry.summary || entry.body || "");
    if (!content) return null;
    const id = clean(entry.id || entry.memoryId || entry.nodeId || `${charId || "core"}:core:${period || index + 1}`);
    return {
      ...entry,
      id,
      charId: clean(entry.charId || entry.characterId || entry.roleId || charId),
      charName: clean(entry.charName || entry.characterName || charName),
      period,
      title: clean(entry.title || entry.name || (period ? `${period} 月度核心记忆` : `月度核心记忆 ${index + 1}`)),
      content,
      importance: Number(entry.importance ?? entry.weight ?? 10),
      mood: clean(entry.mood || entry.feel || entry.emotion || ""),
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : ["核心记忆"],
      room: clean(entry.room || ""),
      type: clean(entry.type || "legacy_refined_memory"),
      source: clean(entry.source || sourceName),
      syncState: clean(entry.syncState || entry.status || "synced"),
      pinned: Boolean(entry.pinned),
      protected: Boolean(entry.protected),
      alwaysInject: entry.alwaysInject !== false,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      occurredAt: clean(entry.occurredAt || entry.createdAt || entry.updatedAt || period || ""),
    };
  };
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((item, index) => toItem(item, item?.period || item?.date || item?.month || "", index)).filter(Boolean);
  if (typeof raw === "object") return Object.entries(raw).map(([key, value], index) => toItem(value, key, index)).filter(Boolean);
  return [toItem(raw, "", 0)].filter(Boolean);
}

function normalizeData(input) {
  const source = Array.isArray(input) ? { memories: input } : { ...(input || {}) };
  const isPalaceExport = source.type === "sully_memory_palace_export" && Array.isArray(source.characters);
  const palaceCharacters = isPalaceExport ? source.characters : [];
  const rawMemories = isPalaceExport
    ? palaceCharacters.flatMap((character) => (character.nodes || []).map((node) => ({
      ...node,
      charId: node.charId || character.charId,
      charName: character.charName,
    })))
    : (source.memories || source.memoryNodes || source.nodes || source.memory || []);
  const memories = rawMemories
    .map((item, index) => ({
      ...item,
      id: clean(item.id || item.memoryId || item.nodeId || item.sullyNodeId || `memory-${index + 1}`),
      charId: clean(item.charId || item.characterId || item.roleId || item.ownerId || ""),
      groupId: clean(item.groupId || item.threadId || ""),
      groupName: clean(item.groupName || item.threadName || ""),
      room: room(item.room || item.roomId || item.category),
      title: clean(item.title || item.name || item.id || `记忆 ${index + 1}`),
      content: clean(item.content || item.text || item.summary || item.body || ""),
      importance: Number(item.importance ?? item.weight ?? 5),
      mood: clean(item.mood || item.feel || item.emotion || ""),
      syncState: clean(item.syncState || item.status || (isPalaceExport ? "synced" : "pending")),
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      occurredAt: clean(item.occurredAt || item.createdAt || item.updatedAt || ""),
      timestamp: item.timestamp,
      time: item.time,
      visibility: clean(item.visibility || "private"),
      source: clean(item.source || "sullyos_memory_palace"),
      type: clean(item.type || item.memoryType || "dynamic"),
      valence: item.valence,
      arousal: item.arousal,
      eventBoxId: clean(item.eventBoxId || item.boxId || ""),
      archived: Boolean(item.archived),
      isBoxSummary: Boolean(item.isBoxSummary),
      embedded: typeof item.embedded === "boolean" ? item.embedded : undefined,
      vectorRefresh: Boolean(item.vectorRefresh || item.needsEmbeddingRefresh),
      embeddedAt: item.embeddedAt,
      embeddedModel: clean(item.embeddedModel || ""),
      lastAccessedAt: item.lastAccessedAt,
      accessCount: Number(item.accessCount || 0),
      pinnedUntil: item.pinnedUntil ?? null,
      sourceId: item.sourceId ?? null,
      origin: clean(item.origin || ""),
      digestedAt: item.digestedAt ?? null,
      relatedTo: Array.isArray(item.relatedTo) ? item.relatedTo.map(String) : item.relatedTo,
      sameAs: Array.isArray(item.sameAs) ? item.sameAs.map(String) : item.sameAs,
      eventName: clean(item.eventName || ""),
      eventTags: Array.isArray(item.eventTags) ? item.eventTags.map(String) : item.eventTags,
    }))
    .filter((item) => item.content);

  const rawCharacters = isPalaceExport
    ? palaceCharacters.map((character) => ({
      ...character,
      id: character.charId,
      name: character.charName || character.charId,
      counts: character.counts,
      memories: Array.isArray(character.memories) ? character.memories : [],
      refinedMemories: character.refinedMemories,
      activeMemoryMonths: Array.isArray(character.activeMemoryMonths) ? character.activeMemoryMonths : [],
      selfInsights: Array.isArray(character.selfInsights) ? character.selfInsights : [],
      personalityStyle: character.personalityStyle,
      ruminationTendency: character.ruminationTendency,
      memoryPalaceEnabled: character.memoryPalaceEnabled,
      autoArchiveEnabled: character.autoArchiveEnabled,
      impression: character.impression,
      learned: character.learned,
      worldview: character.worldview,
      systemPrompt: character.systemPrompt,
    }))
    : (source.characters || source.roles || source.agents || []);
  const characters = rawCharacters.map((item, index) => ({
    ...item,
    id: clean(item.id || item.charId || item.characterId || item.name || `character-${index + 1}`),
    name: clean(item.name || item.label || item.id || `角色 ${index + 1}`),
    avatar: clean(item.avatar || item.name || item.id || "S").slice(0, 1).toUpperCase(),
    visibility: clean(item.visibility || "private"),
    description: clean(item.description || item.desc || "Imported SullyOS character"),
    impression: item.impression || item.userImpression || item.characterImpression,
    learned: item.learned || item.learnedImpression || item.learnedNotes,
    memories: Array.isArray(item.memories) ? item.memories : [],
    refinedMemories: item.refinedMemories || item.coreMemories || item.keyMemories || item.aiContext || {},
    activeMemoryMonths: Array.isArray(item.activeMemoryMonths) ? item.activeMemoryMonths.map(String) : [],
    selfInsights: Array.isArray(item.selfInsights) ? item.selfInsights.map(String) : [],
    personalityStyle: clean(item.personalityStyle || ""),
    ruminationTendency: item.ruminationTendency,
    worldview: clean(item.worldview || ""),
    systemPrompt: clean(item.systemPrompt || item.prompt || ""),
  }));

  const coreMemories = [
    ...normalizeCoreMemoryEntries(source.coreMemories || source.keyMemories || source.refinedMemories || source.aiContext, { source: "memory_hub_import" }),
    ...(isPalaceExport
      ? palaceCharacters.flatMap((character) => normalizeCoreMemoryEntries(
        character.refinedMemories || character.coreMemories || character.keyMemories || character.aiContext,
        { charId: character.charId, charName: character.charName, source: "sullyos_ai_context" }
      ))
      : rawCharacters.flatMap((character) => normalizeCoreMemoryEntries(
        character.refinedMemories || character.coreMemories || character.keyMemories || character.aiContext,
        { charId: character.id || character.charId || character.characterId || character.name, charName: character.name || character.charName || character.label, source: "sullyos_ai_context" }
      )))
  ];

  return {
    characters,
    memories,
    coreMemories,
    vectors: (isPalaceExport
      ? palaceCharacters.flatMap((character) => (character.vectors || []).map((vector) => ({
        ...vector,
        charId: character.charId,
      })))
      : (source.vectors || source.memoryVectors || []))
      .map((vector) => ({
        ...vector,
        embedding: Array.isArray(vector.embedding) ? vector.embedding : vector.vector,
        dimensions: vector.dimensions ?? (Array.isArray(vector.embedding) ? vector.embedding.length : Array.isArray(vector.vector) ? vector.vector.length : undefined),
      })),
    links: isPalaceExport
      ? palaceCharacters.flatMap((character) => (character.links || character.memoryLinks || []).map((link) => ({
        ...link,
        charId: link.charId || character.charId,
      })))
      : (source.links || source.memoryLinks || source.memory_links || []),
    roomPlates: isPalaceExport
      ? palaceCharacters.flatMap((character) => (character.roomPlates || []).map((plate) => ({ ...plate, charId: plate.charId || character.charId })))
      : (source.roomPlates || source.plates || source.anchors || []),
    impressions: [
      ...(source.impressions || []),
      ...(!isPalaceExport ? (rawCharacters || []).filter((character) => character.impression).map((character) => ({
        id: `${character.id || character.charId || character.name}:impression`,
        charId: character.id || character.charId,
        type: "character_impression",
        content: character.impression,
        updatedAt: character.impression?.lastUpdated || character.updatedAt || Date.now(),
      })) : []),
    ],
    feels: source.feels || source.feel || [],
    eventBoxes: isPalaceExport
      ? palaceCharacters.flatMap((character) => (character.eventBoxes || []).map((box) => ({ ...box, charId: box.charId || character.charId })))
      : (source.eventBoxes || source.boxes || []),
    anticipations: isPalaceExport
      ? palaceCharacters.flatMap((character) => (character.anticipations || []).map((item) => ({ ...item, charId: item.charId || character.charId })))
      : (source.anticipations || source.windowsill || []),
    digestReports: source.digestReports || source.digest_reports || [],
    digestRoundCounters: source.digestRoundCounters || source.digest_round_counters || {},
    lastDigestAt: source.lastDigestAt || source.last_digest_at || {},
    activity: source.activity || source.memoryActivity || {},
    embeddingConfig: extractEmbeddingConfig(source),
    modelConfig: extractModelConfig(source),
    memoryPalaceConfig: source.memoryPalaceConfig || source.modelConfig || {},
    importedAt: new Date().toISOString(),
  };
}

function vectorKey(vector) {
  return String(vector.memoryId || vector.id || "");
}

function mergeListByKey(baseItems = [], incomingItems = [], keyFn = (item) => item?.id, mergeFn = (oldItem, newItem) => ({ ...oldItem, ...newItem })) {
  const list = Array.isArray(baseItems) ? [...baseItems] : [];
  const indexByKey = new Map(list.map((item, index) => [keyFn(item), index]).filter(([key]) => key));
  for (const incoming of Array.isArray(incomingItems) ? incomingItems : []) {
    const key = keyFn(incoming);
    if (!key) {
      list.push(incoming);
      continue;
    }
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, list.length);
      list.push(incoming);
    } else {
      list[index] = mergeFn(list[index], incoming);
    }
  }
  return list;
}

function mergeSullyIntoHub(baseData = EMPTY_DATA, incomingData = EMPTY_DATA) {
  const now = new Date().toISOString();
  const base = normalizeData(baseData);
  const incoming = normalizeData(incomingData);
  const incomingCharacterIds = new Set(
    incoming.characters.map((item) => String(item?.id || item?.charId || "")).filter(Boolean)
  );
  const markSullyMirror = (item = {}) => ({
    ...item,
    sourceAuthority: "sullyos",
    lastSeenInSullyAt: now,
  });
  const preserveHubState = (oldItem = {}, newItem = {}) => ({
    ...oldItem,
    ...newItem,
    syncState: oldItem.duplicateOf || oldItem.mergedInto ? (oldItem.syncState || "merged") : (newItem.syncState || oldItem.syncState || "synced"),
    duplicateOf: oldItem.duplicateOf,
    mergedInto: oldItem.mergedInto,
    mergedAt: oldItem.mergedAt,
    archived: Boolean(newItem.archived || oldItem.archived),
    hubUpdatedAt: oldItem.hubUpdatedAt || oldItem.importedAt || "",
    lastSeenInSullyAt: now,
    sourceAuthority: "sullyos",
  });
  return {
    ...base,
    characters: mergeListByKey(base.characters, incoming.characters.map(markSullyMirror)),
    memories: mergeListByKey(
      base.memories,
      incoming.memories.map(markSullyMirror),
      (item) => item?.id,
      preserveHubState
    ),
    vectors: mergeListByKey(base.vectors, incoming.vectors.map(markSullyMirror), vectorKey, (oldItem, newItem) => ({ ...oldItem, ...newItem })),
    links: mergeListByKey(base.links, incoming.links.map(markSullyMirror), (item) => item?.id || `${item?.sourceId || item?.source || item?.from || ""}->${item?.targetId || item?.target || item?.to || ""}:${item?.type || item?.relation || ""}`),
    roomPlates: mergeListByKey(base.roomPlates, incoming.roomPlates.map(markSullyMirror), (item) => item?.id || `${item?.charId || ""}:${item?.room || ""}:${item?.name || item?.title || ""}`),
    impressions: mergeListByKey(
      base.impressions.filter((item) => !incomingCharacterIds.has(String(item?.charId || item?.characterId || ""))),
      incoming.impressions.map(markSullyMirror),
      (item) => item?.id || `${item?.charId || ""}:${item?.type || ""}`
    ),
    coreMemories: mergeListByKey(base.coreMemories, incoming.coreMemories.map(markSullyMirror)),
    feels: mergeListByKey(base.feels, incoming.feels.map(markSullyMirror), (item) => item?.id || `${item?.charId || ""}:${item?.room || ""}:${item?.label || item?.mood || item?.updatedAt || ""}`),
    eventBoxes: mergeListByKey(base.eventBoxes, incoming.eventBoxes.map(markSullyMirror)),
    anticipations: mergeListByKey(base.anticipations, incoming.anticipations.map(markSullyMirror)),
    digestReports: mergeListByKey(base.digestReports, incoming.digestReports.map(markSullyMirror)),
    digestRoundCounters: { ...(base.digestRoundCounters || {}), ...(incoming.digestRoundCounters || {}) },
    lastDigestAt: { ...(base.lastDigestAt || {}), ...(incoming.lastDigestAt || {}) },
    activity: { ...(base.activity || {}), ...(incoming.activity || {}) },
    embeddingConfig: { ...(base.embeddingConfig || {}), ...(incoming.embeddingConfig || {}) },
    modelConfig: { ...(base.modelConfig || {}), ...(incoming.modelConfig || {}) },
    memoryPalaceConfig: { ...(base.memoryPalaceConfig || {}), ...(incoming.memoryPalaceConfig || {}) },
    importedAt: now,
    sourceState: {
      ...(base.sourceState || {}),
      sullyos: { lastMergeAt: now, memories: incoming.memories.length, coreMemories: incoming.coreMemories.length, characters: incoming.characters.length },
    },
  };
}

function removeDeletedSullyCharacters(baseData = EMPTY_DATA, incomingData = EMPTY_DATA) {
  const base = normalizeData(baseData);
  const incoming = normalizeData(incomingData);
  const incomingCharacterIds = new Set(
    incoming.characters.map((item) => String(item?.id || item?.charId || "")).filter(Boolean)
  );
  const deletedCharacterIds = new Set(
    base.characters
      .map((item) => String(item?.id || item?.charId || ""))
      .filter((id) => id && !incomingCharacterIds.has(id))
  );
  if (!deletedCharacterIds.size) {
    return { data: base, deletedCharacterIds: [], deleted: {} };
  }

  const belongsToDeletedCharacter = (item) =>
    deletedCharacterIds.has(String(item?.charId || item?.characterId || ""));
  const prune = (items = []) => (Array.isArray(items) ? items.filter((item) => !belongsToDeletedCharacter(item)) : []);
  const memories = prune(base.memories);
  const survivingMemoryIds = new Set(memories.map((item) => String(item?.id || "")).filter(Boolean));
  const deletedMemoryIds = new Set(
    (base.memories || []).filter(belongsToDeletedCharacter).map((item) => String(item?.id || "")).filter(Boolean)
  );
  const vectors = (base.vectors || []).filter((item) => {
    if (belongsToDeletedCharacter(item)) return false;
    const memoryId = String(item?.memoryId || item?.id || "");
    return !memoryId || survivingMemoryIds.has(memoryId);
  });
  const links = (base.links || []).filter((item) => {
    if (belongsToDeletedCharacter(item)) return false;
    const sourceId = String(item?.sourceId || item?.source || item?.from || "");
    const targetId = String(item?.targetId || item?.target || item?.to || "");
    return !deletedMemoryIds.has(sourceId) && !deletedMemoryIds.has(targetId);
  });
  const filterCharacterMap = (value = {}) => Object.fromEntries(
    Object.entries(value || {}).filter(([key]) => !deletedCharacterIds.has(String(key)))
  );
  const activity = Object.fromEntries(
    Object.entries(base.activity || {}).filter(([key, value]) => {
      if (deletedCharacterIds.has(String(key))) return false;
      if (belongsToDeletedCharacter(value)) return false;
      return !String(key).startsWith("mn_") || survivingMemoryIds.has(String(key));
    })
  );
  const next = {
    ...base,
    characters: base.characters.filter((item) => !deletedCharacterIds.has(String(item?.id || item?.charId || ""))),
    memories,
    vectors,
    links,
    roomPlates: prune(base.roomPlates),
    impressions: prune(base.impressions),
    coreMemories: prune(base.coreMemories),
    feels: prune(base.feels),
    eventBoxes: prune(base.eventBoxes),
    anticipations: prune(base.anticipations),
    digestReports: prune(base.digestReports),
    digestRoundCounters: filterCharacterMap(base.digestRoundCounters),
    lastDigestAt: filterCharacterMap(base.lastDigestAt),
    activity,
  };
  const deleted = {};
  for (const key of ["characters", "memories", "vectors", "links", "roomPlates", "impressions", "coreMemories", "feels", "eventBoxes", "anticipations", "digestReports"]) {
    deleted[key] = (base[key] || []).length - (next[key] || []).length;
  }
  return { data: next, deletedCharacterIds: [...deletedCharacterIds], deleted };
}

function removeDeletedSullySnapshotEntities(baseData = EMPTY_DATA, incomingData = EMPTY_DATA) {
  const characterMirror = removeDeletedSullyCharacters(baseData, incomingData);
  const base = characterMirror.data;
  const incoming = normalizeData(incomingData);
  const incomingCharacterIds = new Set(
    incoming.characters.map((item) => String(item?.id || item?.charId || "")).filter(Boolean)
  );
  const isKnownSullyMirror = (item = {}) => {
    if (item.sourceAuthority === "memory_hub") return false;
    if (item.sourceAuthority === "sullyos" || item.lastSeenInSullyAt) return true;
    return String(item.source || "").toLowerCase().includes("sully");
  };
  const keyFor = {
    memories: (item) => String(item?.id || ""),
    coreMemories: (item) => String(item?.id || ""),
    roomPlates: (item) => String(item?.id || ""),
    eventBoxes: (item) => String(item?.id || ""),
    anticipations: (item) => String(item?.id || ""),
    digestReports: (item) => String(item?.id || ""),
  };
  const next = { ...base };
  const deleted = { ...(characterMirror.deleted || {}) };
  for (const collection of Object.keys(keyFor)) {
    const incomingKeys = new Set((incoming[collection] || []).map(keyFor[collection]).filter(Boolean));
    const before = base[collection] || [];
    next[collection] = before.filter((item) => {
      const charId = String(item?.charId || item?.characterId || "");
      if (!incomingCharacterIds.has(charId) || !isKnownSullyMirror(item)) return true;
      return incomingKeys.has(keyFor[collection](item));
    });
    deleted[collection] = (deleted[collection] || 0) + before.length - next[collection].length;
  }

  const survivingMemoryIds = new Set((next.memories || []).map((item) => String(item?.id || "")).filter(Boolean));
  const vectorsBefore = base.vectors || [];
  next.vectors = vectorsBefore.filter((item) => {
    const memoryId = String(item?.memoryId || item?.id || "");
    return !memoryId || survivingMemoryIds.has(memoryId);
  });
  deleted.vectors = (deleted.vectors || 0) + vectorsBefore.length - next.vectors.length;

  const linksBefore = base.links || [];
  next.links = linksBefore.filter((item) => {
    const sourceId = String(item?.sourceId || item?.source || item?.from || "");
    const targetId = String(item?.targetId || item?.target || item?.to || "");
    return (!sourceId || survivingMemoryIds.has(sourceId)) && (!targetId || survivingMemoryIds.has(targetId));
  });
  deleted.links = (deleted.links || 0) + linksBefore.length - next.links.length;

  return {
    data: next,
    deletedCharacterIds: characterMirror.deletedCharacterIds,
    deleted,
  };
}

function vectorValues(vector) {
  return Array.isArray(vector?.embedding) ? vector.embedding : Array.isArray(vector?.vector) ? vector.vector : [];
}

function analyzeHubData(hubData) {
  const memories = hubData.memories || [];
  const vectors = hubData.vectors || [];
  const memoryIds = new Set(memories.map((item) => item.id));
  const vectorByMemory = new Map(vectors.map((item) => [vectorKey(item), item]).filter(([key]) => key));
  const pendingVectors = memories.filter((item) => item.content && (item.embedded === false || item.vectorRefresh));
  const missingVectors = memories.filter((item) => item.content && !vectorByMemory.has(item.id));
  const orphanVectors = vectors.filter((item) => !memoryIds.has(vectorKey(item)));
  const models = [...new Set(vectors.map((item) => item.model).filter(Boolean))];
  const dimensions = [...new Set(vectors.map((item) => item.dimensions ?? vectorValues(item).length).filter((item) => item !== undefined && item !== null))];
  const missingCharId = memories.filter((item) => !item.charId);
  const missingRoom = memories.filter((item) => !ROOMS.has(item.room));
  const byRoom = {};
  const byChar = {};
  for (const item of memories) {
    byRoom[item.room || "missing"] = (byRoom[item.room || "missing"] || 0) + 1;
    byChar[item.charId || "missing"] = (byChar[item.charId || "missing"] || 0) + 1;
  }
  return {
    counts: {
      characters: (hubData.characters || []).length,
      memories: memories.length,
      coreMemories: (hubData.coreMemories || []).length,
      vectors: vectors.length,
      links: (hubData.links || []).length,
      roomPlates: (hubData.roomPlates || []).length,
      impressions: (hubData.impressions || []).length,
      eventBoxes: (hubData.eventBoxes || []).length,
      anticipations: (hubData.anticipations || []).length,
      digestReports: (hubData.digestReports || []).length,
      pendingSync: memories.filter((item) => item.syncState !== "synced").length,
    },
    vectorHealth: {
      missingVectors: missingVectors.length,
      pendingVectors: pendingVectors.length,
      orphanVectors: orphanVectors.length,
      models,
      dimensions,
      modelMismatch: models.length > 1,
      dimensionMismatch: dimensions.length > 1,
    },
    boundaryHealth: {
      missingCharId: missingCharId.length,
      missingRoom: missingRoom.length,
    },
    byRoom,
    byChar,
  };
}

function lightHubData(hubData, options = {}) {
  const linkLimit = Math.max(0, Math.min(Number(options.linkLimit ?? 5000), 20000));
  return {
    ...hubData,
    links: (hubData.links || []).slice(0, linkLimit),
    totalLinks: (hubData.links || []).length,
    vectors: (hubData.vectors || []).map(({ embedding, vector, ...metadata }) => metadata),
    vectorValuesIncluded: false,
  };
}

function searchHubData(hubData, query, filters = {}) {
  const q = String(query || "").trim().toLowerCase();
  const charId = String(filters.charId || "").trim();
  const roomFilter = String(filters.room || "").trim();
  const memories = hubData.memories || [];
  if (!q && !charId && !roomFilter) return memories.slice(0, 50);
  return memories.filter((item) => {
    if (charId && item.charId !== charId) return false;
    if (roomFilter && item.room !== roomFilter) return false;
    if (!q) return true;
    const haystack = [
      item.id,
      item.title,
      item.content,
      item.room,
      item.charId,
      item.mood,
      ...(item.tags || []),
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  }).slice(0, Number(filters.limit || 100));
}

function contextKey(item) {
  if (item.groupId) return `group:${item.groupId}`;
  if (item.charId) return `character:${item.charId}`;
  return "unbound:memory";
}

function summarizeContexts(hubData) {
  const memories = hubData.memories || [];
  const characters = new Map((hubData.characters || []).map((item) => [item.id, item]));
  const contexts = new Map();
  for (const character of characters.values()) {
    const key = `character:${character.id}`;
    contexts.set(key, {
      key,
      kind: "character",
      charId: character.id,
      charName: character.name || character.id,
      groupId: "",
      groupName: "",
      label: character.name || character.id,
      total: 0,
      byRoom: {},
      byType: { character_index: 1 },
      anchors: 0,
    });
  }
  for (const memory of memories) {
    const key = contextKey(memory);
    const existing = contexts.get(key) || {
      key,
      kind: memory.groupId ? "group" : memory.charId ? "character" : "unbound",
      charId: memory.charId || "",
      charName: characters.get(memory.charId)?.name || memory.charName || memory.charId || "",
      groupId: memory.groupId || "",
      groupName: memory.groupName || "",
      label: memory.groupName || characters.get(memory.charId)?.name || memory.charName || memory.charId || "Unbound memory",
      total: 0,
      byRoom: {},
      byType: {},
      anchors: 0,
    };
    existing.total += 1;
    existing.byRoom[memory.room || "missing"] = (existing.byRoom[memory.room || "missing"] || 0) + 1;
    existing.byType[memory.type || "dynamic"] = (existing.byType[memory.type || "dynamic"] || 0) + 1;
    if (memory.anchor || memory.pinnedUntil) existing.anchors += 1;
    contexts.set(key, existing);
  }
  for (const plate of hubData.roomPlates || []) {
    if (!plate.charId) continue;
    const key = `character:${plate.charId}`;
    const existing = contexts.get(key) || {
      key,
      kind: "character",
      charId: plate.charId,
      charName: characters.get(plate.charId)?.name || plate.charName || plate.charId,
      groupId: "",
      groupName: "",
      label: characters.get(plate.charId)?.name || plate.charName || plate.charId,
      total: 0,
      byRoom: {},
      byType: {},
      anchors: 0,
    };
    const entries = Array.isArray(plate.entries) ? plate.entries.length : 0;
    existing.byRoom[plate.room || "missing"] = (existing.byRoom[plate.room || "missing"] || 0) + entries;
    existing.byType.room_plate = (existing.byType.room_plate || 0) + entries;
    existing.anchors += entries;
    contexts.set(key, existing);
  }
  return [...contexts.values()].sort((a, b) => b.total - a.total);
}

function normalizeBridgeMemory(body) {
  const data = normalizeData({ memories: [body], characters: [] });
  const memory = data.memories[0];
  return {
    memory,
    vector: body.embedding ? {
      id: body.vectorId || `vector:${memory.id}`,
      memoryId: memory.id,
      charId: memory.charId,
      dimensions: Array.isArray(body.embedding) ? body.embedding.length : undefined,
      embedding: body.embedding,
      model: body.embeddingModel || body.model || "",
    } : null,
  };
}

function mergeById(items, incoming) {
  if (!incoming?.id) return items || [];
  const list = Array.isArray(items) ? items : [];
  const index = list.findIndex((item) => item.id === incoming.id);
  if (index >= 0) return list.map((item, idx) => idx === index ? { ...item, ...incoming } : item);
  return [...list, incoming];
}

function normalizeCharacterIndexItem(item, index = 0) {
  const id = clean(item.id || item.charId || item.characterId || item.name || `character-${index + 1}`);
  const name = clean(item.name || item.charName || item.label || id);
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(item, key);
  const refinedMemories = item.refinedMemories ?? item.coreMemories ?? item.keyMemories ?? item.aiContext;
  return {
    ...item,
    id,
    name,
    sourceAuthority: "sullyos",
    lastSeenInSullyAt: new Date().toISOString(),
    avatar: clean(item.avatar || name || id || "R").slice(0, 1).toUpperCase(),
    visibility: clean(item.visibility || "private"),
    description: clean(item.description || item.desc || "Imported SullyOS AI index"),
    memoryPalaceEnabled: Boolean(item.memoryPalaceEnabled),
    autoArchiveEnabled: Boolean(item.autoArchiveEnabled),
    ...(hasOwn("memories") ? { memories: Array.isArray(item.memories) ? item.memories : [] } : {}),
    ...(refinedMemories !== undefined ? { refinedMemories: refinedMemories || {} } : {}),
    ...(hasOwn("activeMemoryMonths")
      ? { activeMemoryMonths: Array.isArray(item.activeMemoryMonths) ? item.activeMemoryMonths.map(String) : [] }
      : {}),
    ...(hasOwn("selfInsights")
      ? { selfInsights: Array.isArray(item.selfInsights) ? item.selfInsights.map(String) : [] }
      : {}),
    ...(hasOwn("personalityStyle") ? { personalityStyle: clean(item.personalityStyle || "") } : {}),
    ...(hasOwn("ruminationTendency") ? { ruminationTendency: item.ruminationTendency } : {}),
    impression: item.impression || item.userImpression || item.characterImpression,
    learned: item.learned || item.learnedImpression || item.learnedNotes,
    worldview: clean(item.worldview || ""),
    systemPrompt: clean(item.systemPrompt || item.prompt || ""),
  };
}

function normalizeRoomPlateItem(item, index = 0) {
  const charId = clean(item.charId || item.characterId || item.roleId || "");
  const room = clean(item.room || item.plateRoom || "user_room");
  const rawEntries = Array.isArray(item.entries)
    ? item.entries
    : [{ id: item.entryId || item.id, text: item.text || item.content || item.title, tag: item.tag, sourceCount: item.sourceCount, updatedAt: item.updatedAt }].filter((entry) => entry.text);
  const entries = rawEntries.map((entry, entryIndex) => ({
    id: clean(entry.id || `${item.id || `${charId}:${room}`}:entry-${entryIndex + 1}`),
    text: clean(entry.text || entry.content || entry.summary || ""),
    firstLearnedAt: entry.firstLearnedAt || entry.createdAt || item.firstLearnedAt || item.createdAt || "",
    updatedAt: entry.updatedAt || item.updatedAt || "",
    sourceCount: Number(entry.sourceCount || entry.count || entry.evidenceCount || 1),
    tag: clean(entry.tag || entry.label || item.tag || ""),
  })).filter((entry) => isRealPlateText(entry.text));
  return {
    id: clean(item.id || `${charId || "global"}:${room}:${index + 1}`),
    charId,
    charName: clean(item.charName || item.characterName || ""),
    room,
    title: clean(item.title || ""),
    entries,
    updatedAt: item.updatedAt || "",
    version: Number(item.version || 1),
  };
}

function isRealPlateText(value) {
  const text = clean(value);
  if (!text) return false;
  if (/^[?\s]+$/.test(text)) return false;
  if (/^[锟絓s]+$/.test(text)) return false;
  return true;
}

function toBridgeMemory(memory) {
  return {
    bucketId: memory.bucketId || memory.id,
    sullyNodeId: memory.sullyNodeId || memory.id,
    charId: memory.charId || "",
    charName: memory.charName || "",
    groupId: memory.groupId || "",
    groupName: memory.groupName || "",
    room: memory.room,
    type: memory.type || "dynamic",
    visibility: memory.visibility || "private",
    scope: memory.scope || "memory_palace",
    source: memory.source || "sullyos_memory_palace",
    title: memory.title || "",
    tags: memory.tags || [],
    importance: memory.importance || 5,
    mood: memory.mood || "",
    valence: memory.valence ?? 0,
    arousal: memory.arousal ?? 0,
    anchor: Boolean(memory.anchor || memory.pinnedUntil),
    occurredAt: memory.occurredAt || memory.createdAt || "",
    createdAt: memory.createdAt || memory.occurredAt || "",
    triggeredBy: memory.triggeredBy || "",
    content: memory.content || "",
  };
}

function ombreMemoryEndpoint(settings) {
  const raw = clean(settings.ombreUrl || DEFAULT_SETTINGS.ombreUrl).replace(/\/$/, "");
  if (raw.endsWith("/api/sully/memories")) return raw;
  if (raw.endsWith("/api/sully")) return `${raw}/memories`;
  return `${raw}/api/sully/memories`;
}

async function fetchSullyExport(settings) {
  const url = new URL(settings.exportPath || "/", settings.sullyUrl || DEFAULT_SETTINGS.sullyUrl).toString();
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`SullyOS export failed: HTTP ${response.status}`);
  return { url, data: await response.json() };
}

function selectSullyCharacter(source, charId) {
  if (!charId) return source;
  const data = normalizeData(source);
  const belongsToCharacter = (item) => String(item?.charId || item?.characterId || "") === String(charId);
  const memoryIds = new Set(data.memories.filter(belongsToCharacter).map((item) => String(item.id)));
  return {
    ...data,
    characters: data.characters.filter((item) => String(item.id || item.charId) === String(charId)),
    memories: data.memories.filter(belongsToCharacter),
    coreMemories: data.coreMemories.filter(belongsToCharacter),
    vectors: data.vectors.filter((item) => belongsToCharacter(item) || memoryIds.has(String(item.memoryId || item.id))),
    links: data.links.filter((item) => belongsToCharacter(item) || memoryIds.has(String(item.sourceId || item.from || "")) || memoryIds.has(String(item.targetId || item.to || ""))),
    roomPlates: data.roomPlates.filter(belongsToCharacter),
    impressions: data.impressions.filter(belongsToCharacter),
    feels: data.feels.filter(belongsToCharacter),
    eventBoxes: data.eventBoxes.filter(belongsToCharacter),
    anticipations: data.anticipations.filter(belongsToCharacter),
    digestReports: data.digestReports.filter(belongsToCharacter),
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function connectionTest(settings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const results = [];
  results.push({
    id: "hub-local",
    label: "Memory Hub 本机 API",
    ok: true,
    status: 200,
    url: `http://${HOST}:${PORT}/api/health`,
    detail: `server running 路 dataDir ${DATA_DIR}`,
  });

  const sullyUrl = new URL(merged.exportPath || "/", merged.sullyUrl || DEFAULT_SETTINGS.sullyUrl).toString();
  try {
    const response = await fetchWithTimeout(sullyUrl, { headers: { Accept: "application/json" } });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const normalized = parsed ? normalizeData(parsed) : EMPTY_DATA;
    results.push({
      id: "sullyos",
      label: "SullyOS export endpoint",
      ok: response.ok && Boolean(parsed),
      status: response.status,
      url: sullyUrl,
      detail: parsed
        ? (normalized.characters.length + " AI / " + normalized.memories.length + " memories / " + normalized.vectors.length + " vectors")
        : "Response is not JSON",
    });
  } catch (error) {
    results.push({
      id: "sullyos",
      label: "SullyOS export endpoint",
      ok: false,
      url: sullyUrl,
      error: String(error?.message || error),
      detail: "Check that SullyOS is running and the memory palace export endpoint is enabled.",
    });
  }

  const publicBase = clean(merged.memoryHubPublicUrl || PUBLIC_BASE_URL || "");
  if (publicBase) {
    const healthUrl = new URL("/api/health", publicBase).toString();
    try {
      const response = await fetchWithTimeout(healthUrl, { headers: { Accept: "application/json" } });
      const body = await response.json().catch(() => null);
      results.push({
        id: "hub-public",
        label: "Memory Hub public access",
        ok: response.ok && body?.ok === true,
        status: response.status,
        url: healthUrl,
        detail: body?.ok ? ("publicUrl " + (body.publicUrl || publicBase)) : "Public URL is reachable but did not return a healthy response",
      });
    } catch (error) {
      results.push({
        id: "hub-public",
        label: "Memory Hub public access",
        ok: false,
        url: healthUrl,
        error: String(error?.message || error),
        detail: "Public URL is not reachable yet. Check VPS, tunnel, or reverse proxy settings.",
      });
    }
  } else {
    results.push({
      id: "hub-public",
      label: "Memory Hub public access",
      ok: null,
      url: "",
      detail: "MEMORY_HUB_PUBLIC_URL is not configured; skipping public deployment check.",
    });
  }

  return {
    ok: results.every((item) => item.ok !== false),
    checkedAt: new Date().toISOString(),
    results,
  };
}

function sullyEmbeddingConfig(hubData = {}) {
  const cfg = extractEmbeddingConfig(hubData);
  return {
    baseUrl: clean(cfg.baseUrl || ""),
    apiKey: clean(cfg.apiKey || ""),
    model: clean(cfg.model || ""),
    dimensions: clean(cfg.dimensions || ""),
  };
}

function manualEmbeddingConfig(settings = {}, bodyEmbedding = {}) {
  return {
    baseUrl: clean(bodyEmbedding.baseUrl || settings.embeddingBaseUrl || ""),
    apiKey: clean(bodyEmbedding.apiKey || settings.embeddingApiKey || ""),
    model: clean(bodyEmbedding.model || settings.embeddingModel || ""),
    dimensions: clean(bodyEmbedding.dimensions || settings.embeddingDimensions || ""),
  };
}

function envEmbeddingConfig() {
  return {
    baseUrl: clean(process.env.EMBEDDING_BASE_URL || ""),
    apiKey: clean(process.env.EMBEDDING_API_KEY || ""),
    model: clean(process.env.EMBEDDING_MODEL || ""),
    dimensions: clean(process.env.EMBEDDING_DIMENSIONS || ""),
  };
}

function manualLightLLMConfig(settings = {}, bodyLight = {}) {
  return normalizeApiConfig(bodyLight, {
    baseUrl: settings.lightLLMBaseUrl || "",
    apiKey: settings.lightLLMApiKey || "",
    model: settings.lightLLMModel || "",
  });
}

function envLightLLMConfig() {
  return normalizeApiConfig({
    baseUrl: process.env.LIGHT_LLM_BASE_URL || process.env.LIGHTLLM_BASE_URL || "",
    apiKey: process.env.LIGHT_LLM_API_KEY || process.env.LIGHTLLM_API_KEY || "",
    model: process.env.LIGHT_LLM_MODEL || process.env.LIGHTLLM_MODEL || "",
  });
}

function resolveLightLLMConfig(settings = {}, hubData = {}, bodyLight = {}) {
  const source = clean(bodyLight.source || settings.lightLLMSource || "sully");
  const env = envLightLLMConfig();
  const sully = extractModelConfig(hubData).lightLLM;
  const manual = manualLightLLMConfig(settings, bodyLight);
  if (source === "env") return { ...env, source: "env", sourceLabel: "VPS .env" };
  if (source === "manual") return { ...manual, source: "manual", sourceLabel: "鎵嬪姩濉啓" };
  return { ...sully, source: "sully", sourceLabel: "SullyOS 閰嶇疆" };
}

function manualRerankConfig(settings = {}, bodyRerank = {}) {
  return {
    ...normalizeApiConfig(bodyRerank, {
      baseUrl: settings.rerankBaseUrl || "",
      apiKey: settings.rerankApiKey || "",
      model: settings.rerankModel || "BAAI/bge-reranker-v2-m3",
    }),
    enabled: Boolean(bodyRerank.enabled ?? settings.rerankEnabled),
    topN: Number(bodyRerank.topN || settings.rerankTopN || 5) || 5,
  };
}

function envRerankConfig() {
  return {
    ...normalizeApiConfig({
      baseUrl: process.env.RERANK_BASE_URL || "",
      apiKey: process.env.RERANK_API_KEY || "",
      model: process.env.RERANK_MODEL || "BAAI/bge-reranker-v2-m3",
    }),
    enabled: clean(process.env.RERANK_ENABLED || "").toLowerCase() !== "false",
    topN: Number(process.env.RERANK_TOP_N || 5) || 5,
  };
}

function resolveRerankConfig(settings = {}, hubData = {}, bodyRerank = {}) {
  const source = clean(bodyRerank.source || settings.rerankSource || "sully");
  const env = envRerankConfig();
  const sully = extractModelConfig(hubData).rerank;
  const manual = manualRerankConfig(settings, bodyRerank);
  if (source === "env") return { ...env, enabled: Boolean(bodyRerank.enabled ?? settings.rerankEnabled ?? env.enabled), source: "env", sourceLabel: "VPS .env" };
  if (source === "manual") return { ...manual, source: "manual", sourceLabel: "鎵嬪姩濉啓" };
  return { ...sully, source: "sully", sourceLabel: "SullyOS 閰嶇疆" };
}

function resolveEmbeddingConfig(settings = {}, hubData = {}, bodyEmbedding = {}) {
  const source = clean(bodyEmbedding.source || settings.embeddingSource || "sully");
  const env = envEmbeddingConfig();
  const sully = sullyEmbeddingConfig(hubData);
  const manual = manualEmbeddingConfig(settings, bodyEmbedding);
  if (source === "env") return { ...env, source: "env", sourceLabel: "VPS .env" };
  if (source === "manual") return { ...manual, source: "manual", sourceLabel: "鎵嬪姩濉啓" };
  if (source === "auto") {
    if (env.baseUrl || env.model || env.apiKey) return { ...env, source: "env", sourceLabel: "VPS .env" };
    if (sully.baseUrl || sully.model || sully.apiKey) return { ...sully, source: "sully", sourceLabel: "SullyOS 閰嶇疆" };
    return { ...manual, source: "manual", sourceLabel: "鎵嬪姩濉啓" };
  }
  return { ...sully, source: "sully", sourceLabel: "SullyOS 閰嶇疆" };
}

function embeddingModelsUrl(baseUrl) {
  const base = clean(baseUrl).replace(/\/+$/, "");
  if (!base) throw new Error("embedding baseUrl is empty");
  return /\/v1$/i.test(base) ? base + "/models" : base + "/v1/models";
}

function embeddingCreateUrl(baseUrl) {
  const base = clean(baseUrl).replace(/\/+$/, "");
  if (!base) throw new Error("embedding baseUrl is empty");
  return /\/v1$/i.test(base) ? base + "/embeddings" : base + "/v1/embeddings";
}

function chatCompletionsUrl(baseUrl) {
  const base = clean(baseUrl).replace(/\/+$/, "");
  if (!base) throw new Error("lightLLM baseUrl is empty");
  return /\/v1$/i.test(base) ? base + "/chat/completions" : base + "/v1/chat/completions";
}

function rerankUrl(baseUrl) {
  const base = clean(baseUrl).replace(/\/+$/, "");
  if (!base) throw new Error("rerank baseUrl is empty");
  return /\/v1$/i.test(base) ? base + "/rerank" : base + "/v1/rerank";
}

async function readApiResponse(response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function upstreamErrorMessage(body, response) {
  const detail = clean(
    body?.error?.message ||
    body?.error?.msg ||
    body?.error ||
    body?.message ||
    body?.msg ||
    body?.detail ||
    body?.raw ||
    ""
  );
  return detail ? `HTTP ${response.status}: ${detail}` : "HTTP " + response.status;
}

async function testLightLLM(config) {
  if (!config.baseUrl) throw new Error("lightLLM baseUrl is empty");
  if (!config.model) throw new Error("lightLLM model is empty");
  const response = await fetchWithTimeout(chatCompletionsUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 5,
    }),
  }, 30000);
  const body = await readApiResponse(response);
  if (!response.ok) throw new Error(upstreamErrorMessage(body, response));
  return { ok: true, message: "lightLLM connection ok: " + (config.sourceLabel || config.source || "config") + " / " + config.model };
}

async function testRerank(config) {
  if (!config.baseUrl) throw new Error("rerank baseUrl is empty");
  const response = await fetchWithTimeout(rerankUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
    },
    body: JSON.stringify({
      model: config.model || "BAAI/bge-reranker-v2-m3",
      query: "测试问题：外公身体怎么样",
      documents: ["外公前几天去医院做了心脏检查，结果正常", "今天下雨了，路上有点堵", "她最喜欢吃妈妈做的红烧肉"],
      top_n: 3,
      return_documents: false,
    }),
  }, 30000);
  const body = await readApiResponse(response);
  if (!response.ok) throw new Error(upstreamErrorMessage(body, response));
  const rows = Array.isArray(body.results) ? body.results : Array.isArray(body.data) ? body.data : [];
  return { ok: true, message: rows.length ? "rerank connection ok: returned " + rows.length + " rows" : "rerank API connected but returned empty results" };
}

async function rerankDocumentsHub(config, query, documents = [], topN = 5) {
  const cleanQuery = clean(query);
  const cleanDocs = documents.map((item) => clean(item)).filter(Boolean);
  if (!config.enabled || !config.baseUrl || !cleanQuery || !cleanDocs.length) return [];
  const response = await fetchWithTimeout(rerankUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
    },
    body: JSON.stringify({
      model: config.model || "BAAI/bge-reranker-v2-m3",
      query: cleanQuery,
      documents: cleanDocs,
      top_n: Math.min(Math.max(1, Number(topN) || 5), cleanDocs.length),
      return_documents: false,
    }),
  }, 30000);
  const body = await readApiResponse(response);
  if (!response.ok) throw new Error(upstreamErrorMessage(body, response));
  const rows = Array.isArray(body.results) ? body.results : Array.isArray(body.data) ? body.data : [];
  return rows
    .filter((row) => Number.isInteger(row?.index))
    .map((row) => ({
      index: row.index,
      relevance_score: typeof row.relevance_score === "number" ? row.relevance_score : (typeof row.score === "number" ? row.score : 0),
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score);
}

function sanitizeEmbeddingConfig(config) {
  return {
    source: config.source,
    sourceLabel: config.sourceLabel,
    baseUrl: config.baseUrl,
    model: config.model,
    dimensions: config.dimensions,
    apiKeyConfigured: Boolean(config.apiKey),
  };
}

function stripMarkdownFence(text = "") {
  return clean(text).replace(/^```(?:json|JSON)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();
}

function safeParseJsonArray(text = "") {
  const cleaned = stripMarkdownFence(text);
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {}
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
  }
  return [];
}

function safeParseJsonObject(text = "") {
  const cleaned = stripMarkdownFence(text);
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {}
  }
  return null;
}

async function callMemoryPalaceLLM(config, messages, options = {}) {
  if (!config.baseUrl) throw new Error("lightLLM baseUrl is empty");
  if (!config.model) throw new Error("lightLLM model is empty");
  const payload = {
    model: config.model,
    messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    stream: false,
  };
  if (payload.temperature === undefined) delete payload.temperature;
  if (payload.max_tokens === undefined) delete payload.max_tokens;
  const response = await fetchWithTimeout(chatCompletionsUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
    },
    body: JSON.stringify(payload),
  }, options.timeoutMs || 120000);
  const body = await readApiResponse(response);
  if (!response.ok) throw new Error(upstreamErrorMessage(body, response));
  const reply = body.choices?.[0]?.message?.content || "";
  return { body, reply };
}

function resolveMemoryPalaceLightLLM(settings, data, body = {}) {
  const config = resolveLightLLMConfig(settings, data, body.lightLLM || body.modelConfig?.lightLLM || {});
  if (!config.apiKey) throw new Error("lightLLM apiKey is empty");
  return config;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatPromptMessage(item = {}, charName = "AI", userName = "用户") {
  const role = clean(item.role || item.sender || item.type || "");
  const speaker = clean(item.name || item.senderName || (role === "assistant" ? charName : userName));
  const content = clean(item.content || item.text || item.body || "");
  const ts = Number(item.timestamp || item.createdAt || item.time || 0);
  const line = speaker ? `${speaker}: ${content}` : content;
  if (!ts || ts <= 0) return line;
  const d = new Date(ts);
  return `[${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}] ${line}`;
}

function conversationTextForPrompt(body, charName, userName) {
  if (body.conversationText) return clean(body.conversationText);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((item) => formatPromptMessage(item, charName, userName)).join("\n");
}

function normalizeRuntimeState(raw = {}) {
  const state = raw && typeof raw === "object" ? raw : {};
  const messages = Array.isArray(state.messages)
    ? state.messages
      .filter((item) => item && Number.isFinite(Number(item.id)) && clean(item.charId))
      .map((item) => {
        const charId = clean(item.charId);
        const role = clean(item.role || "user").toLowerCase();
        return {
          ...item,
          id: Number(item.id),
          charId,
          sourceId: clean(item.sourceId || ""),
          role,
          content: clean(item.content || item.text || item.body || ""),
          timestamp: Number(item.timestamp || item.createdAt || Date.now()),
          metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
          ...normalizeRuntimeMessageScope(item, charId, role),
        };
      })
    : [];
  const maxId = messages.reduce((max, item) => Math.max(max, item.id), 0);
  return {
    version: 1,
    nextMessageSeq: Math.max(Number(state.nextMessageSeq || 1), maxId + 1),
    messages,
    highWaterMarks: state.highWaterMarks && typeof state.highWaterMarks === "object" ? state.highWaterMarks : {},
    pendingJobs: state.pendingJobs && typeof state.pendingJobs === "object" ? state.pendingJobs : {},
    digestRoundCounters: state.digestRoundCounters && typeof state.digestRoundCounters === "object" ? state.digestRoundCounters : {},
    lastRuns: state.lastRuns && typeof state.lastRuns === "object" ? state.lastRuns : {},
  };
}

function runtimeMessageKey(charId, sourceId) {
  return sourceId ? `${charId}:${sourceId}` : "";
}

function inlineMediaBytes(value) {
  if (typeof value === "string") {
    const match = value.match(/^data:(image|audio|video)\/[^;,]+(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) return 0;
    const payload = match[2].replace(/\s/g, "");
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
  }
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + inlineMediaBytes(item), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((sum, item) => sum + inlineMediaBytes(item), 0);
  return 0;
}

function validateRuntimeMessageSize(message) {
  const content = clean(message?.content || message?.text || message?.body || "");
  const contentIsMedia = /^data:(image|audio|video)\//i.test(content);
  const textBytes = contentIsMedia ? 0 : Buffer.byteLength(content, "utf8");
  const mediaBytes = inlineMediaBytes(message);
  const jsonBytes = Buffer.byteLength(JSON.stringify(message || {}), "utf8");
  if (textBytes > MESSAGE_TEXT_MAX_BYTES) throw new AuthorityError("MESSAGE_TOO_LARGE", `Message text exceeds ${MESSAGE_TEXT_MAX_BYTES} bytes`, 413, { textBytes, limit: MESSAGE_TEXT_MAX_BYTES });
  if (mediaBytes > MESSAGE_INLINE_MEDIA_MAX_BYTES) throw new AuthorityError("INLINE_MEDIA_TOO_LARGE", `Inline media exceeds ${MESSAGE_INLINE_MEDIA_MAX_BYTES} bytes`, 413, { mediaBytes, limit: MESSAGE_INLINE_MEDIA_MAX_BYTES });
  if (jsonBytes > MESSAGE_JSON_MAX_BYTES) throw new AuthorityError("MESSAGE_TOO_LARGE", `Message object exceeds ${MESSAGE_JSON_MAX_BYTES} bytes`, 413, { jsonBytes, limit: MESSAGE_JSON_MAX_BYTES });
  return { textBytes, mediaBytes, jsonBytes };
}

function runtimeMessageStorageMetrics(messages = [], databaseBytes = 0) {
  const totals = { count: messages.length, textBytes: 0, inlineMediaBytes: 0, jsonBytes: 0, inlineMediaMessages: 0, oversizedLegacyMessages: 0 };
  for (const message of messages) {
    const content = clean(message?.content || message?.text || message?.body || "");
    const mediaBytes = inlineMediaBytes(message);
    const jsonBytes = Buffer.byteLength(JSON.stringify(message || {}), "utf8");
    totals.textBytes += /^data:(image|audio|video)\//i.test(content) ? 0 : Buffer.byteLength(content, "utf8");
    totals.inlineMediaBytes += mediaBytes;
    totals.jsonBytes += jsonBytes;
    if (mediaBytes > 0) totals.inlineMediaMessages += 1;
    if (jsonBytes > MESSAGE_JSON_MAX_BYTES || mediaBytes > MESSAGE_INLINE_MEDIA_MAX_BYTES) totals.oversizedLegacyMessages += 1;
  }
  const ratio = STORAGE_QUOTA_BYTES ? databaseBytes / STORAGE_QUOTA_BYTES : 0;
  return {
    ...totals,
    databaseBytes,
    quotaBytes: STORAGE_QUOTA_BYTES,
    quotaRatio: Number(ratio.toFixed(6)),
    level: ratio >= 0.85 ? "critical" : ratio >= 0.7 ? "warning" : "ok",
    limits: { messageTextBytes: MESSAGE_TEXT_MAX_BYTES, inlineMediaBytes: MESSAGE_INLINE_MEDIA_MAX_BYTES, messageJsonBytes: MESSAGE_JSON_MAX_BYTES },
  };
}

function appendRuntimeMessages(runtime, charId, incoming = []) {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  const existingBySource = new Map(
    runtime.messages
      .map((item, index) => [runtimeMessageKey(item.charId, item.sourceId), index])
      .filter(([key]) => key)
  );
  const appended = [];
  const updated = [];
  for (const source of list) {
    if (!source || typeof source !== "object") continue;
    validateRuntimeMessageSize(source);
    const targetCharId = clean(source.charId || source.characterId || charId);
    if (!targetCharId) continue;
    const sourceId = clean(source.sourceId ?? source.messageId ?? source.id ?? "");
    const role = clean(source.role || source.senderRole || source.type || "user").toLowerCase();
    const item = {
      ...source,
      charId: targetCharId,
      sourceId,
      role: role === "assistant" || role === "system" ? role : "user",
      content: clean(source.content || source.text || source.body || ""),
      timestamp: Number(source.timestamp || source.createdAt || source.time || Date.now()),
      metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {},
      ...normalizeRuntimeMessageScope(source, targetCharId, role === "assistant" || role === "system" ? role : "user"),
    };
    const sourceKey = runtimeMessageKey(targetCharId, sourceId);
    const existingIndex = sourceKey ? existingBySource.get(sourceKey) : undefined;
    if (existingIndex !== undefined) {
      const current = runtime.messages[existingIndex];
      runtime.messages[existingIndex] = { ...current, ...item, id: current.id };
      updated.push(runtime.messages[existingIndex]);
      continue;
    }
    const saved = { ...item, id: runtime.nextMessageSeq++ };
    runtime.messages.push(saved);
    if (sourceKey) existingBySource.set(sourceKey, runtime.messages.length - 1);
    appended.push(saved);
  }
  runtime.messages.sort((a, b) => a.id - b.id);
  return { appended, updated };
}

function persistActivityStateFromMessages(data, runtime, charId, messages = []) {
  const activityMessages = messages
    .filter((item) => effectiveRuntimeMessageScope(item).surface === "activity")
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  if (!activityMessages.length) return { changed: false, snapshot: authorityStore.getSnapshot(charId), patch: null, inputCount: messages.length, activityCount: 0 };

  const current = authorityStore.getSnapshot(charId);
  const character = current?.character
    || authorityStore.getEntity("character", charId)?.data
    || (data.characters || []).find((item) => clean(item.id || item.characterId) === charId)
    || null;
  const user = current?.user || authorityStore.getEntity("userProfile", "me")?.data || character?.userProfile || null;
  let patch = {};
  for (const message of activityMessages) patch = mergeRuntimePatch(patch, deriveActivityStatePatch(message));
  const nextState = mergeRuntimePatch(current?.state || data.characterRuntime?.[charId] || {}, patch);
  if (JSON.stringify(nextState) === JSON.stringify(current?.state || {})) return { changed: false, snapshot: current, patch, inputCount: messages.length, activityCount: activityMessages.length };

  const snapshot = authorityStore.transaction(() => {
    const stateEvent = authorityStore.appendEvent({
      type: "character.state.updated",
      characterId: charId,
      occurredAt: new Date().toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        source: "runtime.activity.ingest",
        activityMessageIds: activityMessages.map((item) => item.sourceId || item.id),
        patch,
      },
    });
    return authorityStore.putSnapshot(charId, {
      lastEventId: stateEvent.eventId,
      protocolVersion: PROTOCOL_VERSION,
      character,
      user,
      world: current?.world || null,
      state: nextState,
      recentMessages: runtime.messages.filter((item) => item.charId === charId && isChatRuntimeMessage(item)).slice(-100),
    }, { expectedVersion: current?.snapshotVersion || 0 });
  });
  return { changed: true, snapshot, patch, inputCount: messages.length, activityCount: activityMessages.length };
}

async function backfillLatestActivityStates() {
  const [data, runtime] = await Promise.all([
    readJsonFile(DATA_FILE, EMPTY_DATA),
    readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME),
  ]);
  const normalizedRuntime = normalizeRuntimeState(runtime);
  const latestByCharacter = new Map();
  for (const message of normalizedRuntime.messages) {
    if (effectiveRuntimeMessageScope(message).surface !== "activity") continue;
    const charId = clean(message.charId || message.characterId);
    if (!charId) continue;
    const current = latestByCharacter.get(charId);
    const currentTime = Number(current?.timestamp || current?.createdAt || 0);
    const messageTime = Number(message.timestamp || message.createdAt || 0);
    if (!current || messageTime > currentTime || (messageTime === currentTime && Number(message.id || 0) > Number(current.id || 0))) latestByCharacter.set(charId, message);
  }
  let changed = 0;
  for (const [charId, message] of latestByCharacter) {
    const result = persistActivityStateFromMessages(data, normalizedRuntime, charId, [message]);
    if (result.changed) changed += 1;
  }
  return { characters: latestByCharacter.size, changed };
}

function isRuntimeSemanticMessage(item = {}) {
  if (!isChatRuntimeMessage(item)) return false;
  if (item.metadata?.hidden || item.metadata?.noMemory) return false;
  const content = clean(item.content || "");
  if (!content) return false;
  if (/^data:(image|audio|video)\//i.test(content)) return false;
  if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|mp3|wav|mp4)(?:\?\S*)?$/i.test(content)) return false;
  return true;
}

function runtimeBufferState(runtime, charId, force = false) {
  const messages = runtime.messages
    .filter((item) => item.charId === charId && isRuntimeSemanticMessage(item))
    .sort((a, b) => a.id - b.id);
  const highWaterMark = Number(runtime.highWaterMarks?.[charId] || 0);
  if (messages.length <= RUNTIME_HOT_ZONE_SIZE) {
    return {
      messages,
      highWaterMark,
      hotZoneStartId: messages[0]?.id || 0,
      buffer: [],
      toProcess: [],
      threshold: force ? 10 : RUNTIME_BUFFER_THRESHOLD,
      reason: "hot_zone",
    };
  }
  const hotZoneStartIndex = messages.length - RUNTIME_HOT_ZONE_SIZE;
  const hotZoneStartId = messages[hotZoneStartIndex].id;
  const buffer = messages.filter((item) => item.id > highWaterMark && item.id < hotZoneStartId);
  const threshold = force ? 10 : RUNTIME_BUFFER_THRESHOLD;
  const processCount = buffer.length >= threshold ? Math.ceil(buffer.length * RUNTIME_PROCESS_RATIO) : 0;
  return {
    messages,
    highWaterMark,
    hotZoneStartId,
    buffer,
    toProcess: processCount ? buffer.slice(0, processCount) : [],
    threshold,
    reason: buffer.length < threshold ? "threshold" : "",
  };
}

function parseMemoryDate(value, fallback = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().replace(/[年\/.]/g, "-").replace(/月/g, "-").replace(/日/g, "").replace(/-+/g, "-");
  const parts = normalized.split("-").map((part) => parseInt(part, 10));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return fallback;
  const [y, m, d] = parts;
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? fallback : date.getTime();
}

function generatedMemoryId(prefix = "mn_hub") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeGeneratedMemory(item = {}, context = {}) {
  const createdAt = parseMemoryDate(item.date, context.createdAt || Date.now());
  const pinDays = Number(item.pinDays || 0);
  return {
    id: clean(item.id || generatedMemoryId(context.prefix || "mn_hub")),
    charId: clean(item.charId || context.charId || ""),
    charName: clean(item.charName || context.charName || ""),
    content: clean(item.content || item.text || item.summary || ""),
    title: clean(item.title || item.eventName || ""),
    room: room(item.room || "living_room"),
    tags: Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean) : [],
    importance: Math.max(1, Math.min(10, Math.round(Number(item.importance || 5)))),
    mood: clean(item.mood || "neutral"),
    valence: typeof item.valence === "number" ? Math.max(-1, Math.min(1, item.valence)) : undefined,
    arousal: typeof item.arousal === "number" ? Math.max(-1, Math.min(1, item.arousal)) : undefined,
    createdAt,
    updatedAt: Date.now(),
    lastAccessedAt: createdAt,
    accessCount: 0,
    embedded: false,
    pinnedUntil: pinDays > 0 && pinDays <= 30 ? createdAt + pinDays * 24 * 60 * 60 * 1000 : null,
    eventBoxId: clean(item.eventBoxId || ""),
    relatedTo: Array.isArray(item.relatedTo) ? item.relatedTo.map(String) : undefined,
    sameAs: Array.isArray(item.sameAs) ? item.sameAs.map(String) : undefined,
    eventName: clean(item.eventName || ""),
    eventTags: Array.isArray(item.eventTags) ? item.eventTags.map(String).filter(Boolean) : undefined,
    syncState: "hub_generated",
    sourceAuthority: "memory_hub",
    source: clean(context.source || "memory_palace"),
    origin: clean(context.origin || "extraction"),
  };
}

function characterForPrompt(data, body = {}) {
  const charId = clean(body.charId || body.characterId || body.roleId || "");
  const character = (data.characters || []).find((item) => item.id === charId) || {};
  const charName = clean(body.charName || body.characterName || character.name || charId || "AI");
  const userName = clean(body.userName || body.userLabel || "用户");
  const charContext = clean(body.charContext || [
    character.systemPrompt ? `核心设定:\n${character.systemPrompt}` : "",
    Array.isArray(character.selfInsights) && character.selfInsights.length
      ? `### 内在认知 (Self Insights)\n以下是你在独处反思中逐渐想明白的事，它们已经成为你的一部分：\n${character.selfInsights.map((insight) => `- ${insight}`).join("\n")}`
      : "",
    character.worldview ? `世界观:\n${character.worldview}` : "",
    character.impression ? `印象:\n${JSON.stringify(character.impression)}` : "",
  ].filter(Boolean).join("\n"));
  return { charId, charName, userName, charContext, character };
}

function defaultPlate(charId, roomKey) {
  return {
    id: `${charId || "global"}:${roomKey}`,
    charId,
    room: roomKey,
    entries: [],
    updatedAt: Date.now(),
    version: 0,
  };
}

function normalizePlateOutput(items = [], charId = "") {
  const grouped = new Map();
  for (const item of items) {
    if (!PLATE_ROOMS.includes(item?.room)) continue;
    const list = grouped.get(item.room) || [];
    list.push({
      id: clean(item.id || `${charId || "global"}:${item.room}:entry-${list.length + 1}`),
      text: clean(item.text || ""),
      tag: clean(item.tag || ""),
      basedOn: item.basedOn ?? null,
      firstLearnedAt: Date.now(),
      updatedAt: Date.now(),
      sourceCount: 1,
    });
    grouped.set(item.room, list);
  }
  return [...grouped.entries()].map(([roomKey, entries]) => ({
    id: `${charId || "global"}:${roomKey}`,
    charId,
    room: roomKey,
    entries,
    updatedAt: Date.now(),
    version: 1,
  }));
}

function mergeGeneratedMemories(data, memories = []) {
  const valid = memories.filter((item) => item.content && ROOMS.has(item.room));
  if (!valid.length) return [];
  data.memories = mergeListByKey(data.memories || [], valid);
  data.updatedAt = new Date().toISOString();
  return valid;
}

function findCharacterIndex(data, charId) {
  return (data.characters || []).findIndex((item) => String(item?.id || "") === String(charId || ""));
}

function syncLegacyRefinedMemoryMirror(data, character, month, summary) {
  const id = `${character.id}:core:${month}`;
  data.coreMemories = (data.coreMemories || []).filter((item) => item.id !== id);
  if (!summary) return;
  const [entry] = normalizeCoreMemoryEntries({ [month]: summary }, {
    charId: character.id,
    charName: character.name,
    source: "memory_hub_legacy_refinement",
  });
  if (entry) {
    data.coreMemories = mergeListByKey(data.coreMemories, [{
      ...entry,
      id,
      sourceAuthority: "memory_hub",
      syncState: "hub_generated",
      updatedAt: Date.now(),
    }]);
  }
}

function syncCharacterImpressionMirror(data, character, impression) {
  const charId = clean(character.id || "");
  data.impressions = (data.impressions || []).filter((item) => !(
    clean(item.charId || item.characterId || "") === charId
    && clean(item.type || "character_impression") === "character_impression"
  ));
  if (!impression) return;
  data.impressions.push({
    id: `${charId}:impression`,
    charId,
    charName: clean(character.name || charId),
    type: "character_impression",
    content: impression,
    updatedAt: impression.lastUpdated || Date.now(),
    source: "memory_hub_impression_v3",
    sourceAuthority: "memory_hub",
    syncState: "hub_generated",
  });
}

function legacyStatusForCharacter(character = {}) {
  const grouped = new Map();
  for (const fragment of Array.isArray(character.memories) ? character.memories : []) {
    const month = normalizeLegacyMonth(String(fragment.date || "").slice(0, 7));
    if (!month) continue;
    const items = grouped.get(month) || [];
    items.push(fragment);
    grouped.set(month, items);
  }
  const refined = character.refinedMemories && typeof character.refinedMemories === "object"
    ? character.refinedMemories
    : {};
  const active = new Set(Array.isArray(character.activeMemoryMonths) ? character.activeMemoryMonths : []);
  const months = [...new Set([...grouped.keys(), ...Object.keys(refined).map(normalizeLegacyMonth).filter(Boolean)])]
    .sort((a, b) => b.localeCompare(a))
    .map((month) => ({
      month,
      fragments: (grouped.get(month) || []).slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))),
      fragmentCount: (grouped.get(month) || []).length,
      refined: clean(refined[month] || ""),
      active: active.has(month),
    }));
  return {
    charId: clean(character.id || ""),
    charName: clean(character.name || character.id || ""),
    months,
    activeMemoryMonths: [...active].sort(),
    context: buildLegacyMemoryContext(character, { includeDetailedMemories: true }),
  };
}

function applyLegacyRecallDirectives(data, charId, messages = []) {
  const characterIndex = findCharacterIndex(data, charId);
  if (characterIndex < 0) return [];
  let character = data.characters[characterIndex];
  const traces = [];
  for (const message of messages) {
    if (clean(message?.role || "") !== "assistant") continue;
    const content = clean(message?.content || message?.text || "");
    const matches = [...content.matchAll(/\[\[RECALL:\s*(\d{4})[-/年](\d{1,2})\]\]/g)];
    for (const match of matches) {
      const result = runLegacyRecall(character, match[0]);
      traces.push(result);
      if (result.ok && !result.alreadyActive) {
        const active = new Set(Array.isArray(character.activeMemoryMonths) ? character.activeMemoryMonths : []);
        active.add(result.yearMonth);
        character = { ...character, activeMemoryMonths: [...active] };
      }
    }
  }
  data.characters[characterIndex] = character;
  return traces;
}

function eventBoxId() {
  return `eb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function plateEntryId() {
  return `pe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function anticipationId() {
  return `ant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const EVENT_BOX_COMPRESSION_THRESHOLD = 4;
const EVENT_BOX_LIVE_HARD_CAP = 15;
const EVENT_BOX_SEAL_THRESHOLD = 12;
const ROOM_LABEL_PREFIX = { user_room: "U", self_room: "R", bedroom: "B", study: "S" };
const BEDROOM_LABEL_RE = /我们(?:现在|如今|已经)?(?:是|算是|成了|成为|变成)[^，。；！？]{0,8}(?:恋人|情侣|男女朋友|男朋友|女朋友|夫妻|朋友|兄妹|姐弟|家人|知己|暧昧)/;

function violatesBedroomRule(text = "") {
  return BEDROOM_LABEL_RE.test(clean(text));
}

function parseSubmissionLine(line = "") {
  const m = /^\s*[\[【]([^\]】]{1,6})[\]】]\s*(.+)$/s.exec(line || "");
  if (m) return { tag: m[1].trim(), text: m[2].trim() };
  return { text: clean(line) };
}

function mergePlateEntries(roomKey, existing = [], items = [], now = Date.now()) {
  const prefix = ROOM_LABEL_PREFIX[roomKey];
  const byLabel = new Map();
  existing.forEach((entry, index) => byLabel.set(`${prefix}${index}`, entry));
  const merged = [];
  const usedIds = new Set();
  for (const item of items) {
    let text = clean(item.text || "").replace(/\s+/g, " ");
    if (!text) continue;
    if (text.length > PLATE_ENTRY_HARD_MAX_CHARS) text = text.slice(0, PLATE_ENTRY_HARD_MAX_CHARS);
    if (roomKey === "bedroom" && violatesBedroomRule(text)) continue;
    const tag = clean(item.tag || "").replace(/\s+/g, "").slice(0, 6) || undefined;
    const base = item.basedOn ? byLabel.get(String(item.basedOn).trim().toUpperCase()) : undefined;
    if (base && !usedIds.has(base.id)) {
      usedIds.add(base.id);
      const changed = base.text !== text;
      merged.push({
        ...base,
        text,
        tag: tag ?? base.tag,
        updatedAt: changed ? now : base.updatedAt,
        sourceCount: Number(base.sourceCount || 0) + 1,
      });
      continue;
    }
    const sameText = existing.find((entry) => entry.text === text && !usedIds.has(entry.id));
    if (sameText) {
      usedIds.add(sameText.id);
      merged.push({ ...sameText, tag: tag ?? sameText.tag, sourceCount: Number(sameText.sourceCount || 0) + 1 });
    } else {
      merged.push({ id: plateEntryId(), text, tag, firstLearnedAt: now, updatedAt: now, sourceCount: 1 });
    }
  }
  return merged.slice(0, PLATE_ENTRY_CAPS[roomKey] || 10);
}

function fallbackMergePlateSubmissions(data, charId, submissions = {}, rooms = PLATE_ROOMS) {
  const now = Date.now();
  const updated = [];
  for (const roomKey of rooms) {
    const lines = submissions[roomKey] || [];
    if (!lines.length) continue;
    const plate = (data.roomPlates || []).find((item) => item.charId === charId && item.room === roomKey) || defaultPlate(charId, roomKey);
    const seen = new Set((plate.entries || []).map((entry) => entry.text));
    let added = 0;
    for (const line of lines) {
      if ((plate.entries || []).length >= (PLATE_ENTRY_CAPS[roomKey] || 10)) break;
      const { text: rawText, tag } = parseSubmissionLine(line);
      const text = rawText.replace(/\s+/g, " ").trim().slice(0, PLATE_ENTRY_HARD_MAX_CHARS);
      if (!text || seen.has(text)) continue;
      if (roomKey === "bedroom" && violatesBedroomRule(text)) continue;
      seen.add(text);
      plate.entries = [...(plate.entries || []), { id: plateEntryId(), text, tag, firstLearnedAt: now, updatedAt: now, sourceCount: 1 }];
      added += 1;
    }
    if (added > 0) {
      plate.updatedAt = now;
      plate.version = Number(plate.version || 0) + 1;
      data.roomPlates = mergeById(data.roomPlates || [], plate);
      updated.push(roomKey);
    }
  }
  return updated;
}

function fulfillAnticipationInData(data, anticipation) {
  if (!anticipation) return null;
  const now = Date.now();
  const updated = { ...anticipation, status: "fulfilled", resolvedAt: now };
  data.anticipations = mergeById(data.anticipations || [], updated);
  const memory = normalizeGeneratedMemory({
    content: `我曾经期盼的事情实现了：${anticipation.content}`,
    room: "bedroom",
    tags: ["期盼实现", "温暖"],
    importance: 7,
    mood: "grateful",
  }, { charId: anticipation.charId, charName: anticipation.charName || "", source: "sullyos_memory_palace", origin: "anticipation_fulfilled", prefix: "mn" });
  memory.boxId = "";
  memory.boxTopic = "期盼实现";
  mergeGeneratedMemories(data, [memory]);
  return memory;
}

function disappointAnticipationInData(data, anticipation) {
  if (!anticipation) return null;
  const now = Date.now();
  const updated = { ...anticipation, status: "disappointed", resolvedAt: now };
  data.anticipations = mergeById(data.anticipations || [], updated);
  const memory = normalizeGeneratedMemory({
    content: `我曾经期盼但最终落空了：${anticipation.content}`,
    room: "attic",
    tags: ["期盼落空", "遗憾"],
    importance: 6,
    mood: "sad",
  }, { charId: anticipation.charId, charName: anticipation.charName || "", source: "sullyos_memory_palace", origin: "anticipation_disappointed", prefix: "mn" });
  memory.boxId = "";
  memory.boxTopic = "期盼落空";
  mergeGeneratedMemories(data, [memory]);
  return memory;
}

function createAnticipationInData(data, charId, content) {
  const now = Date.now();
  const anticipation = {
    id: anticipationId(),
    charId,
    content: clean(content),
    status: "active",
    createdAt: now,
    anchoredAt: null,
    resolvedAt: null,
  };
  data.anticipations = mergeById(data.anticipations || [], anticipation);
  return anticipation;
}

function processAnticipationLifecycleInData(data, charId = "") {
  const now = Date.now();
  const threshold = 7 * 24 * 60 * 60 * 1000;
  let changed = 0;
  data.anticipations = (data.anticipations || []).map((item) => {
    if ((charId && item.charId !== charId) || item.status !== "active") return item;
    if (now - Number(item.createdAt || now) < threshold) return item;
    changed += 1;
    return { ...item, status: "anchor", anchoredAt: now };
  });
  return changed;
}

function dailyLogsTextForPrompt(body = {}) {
  if (body.logsText) return clean(body.logsText);
  const logs = Array.isArray(body.dailyLogs) ? body.dailyLogs : [];
  return logs
    .slice()
    .sort((a, b) => clean(a.date).localeCompare(clean(b.date)))
    .map((item) => `[${clean(item.date)}] (${clean(item.mood || "neutral")}): ${clean(item.summary || item.content || item.text)}`)
    .join("\n\n");
}

function formatMemoryDate(timestamp) {
  const d = new Date(Number(timestamp) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function liveNodesTextForPrompt(nodes = []) {
  return nodes
    .map((item) => {
      const date = clean(item.date || formatMemoryDate(item.createdAt || item.updatedAt || Date.now()));
      const importance = Number(item.importance || 5);
      const mood = clean(item.mood || "neutral");
      return `[${date}｜重要性${importance}｜${mood}] ${clean(item.content || item.summary || item.text)}`;
    })
    .join("\n\n");
}

function materialForDigest(data, body = {}, charId = "") {
  if (body.material && typeof body.material === "object") return body.material;
  const allNodes = (data.memories || []).filter((item) => !charId || item.charId === charId);
  const roomNodes = (roomKey) => allNodes.filter((item) => item.room === roomKey);
  return {
    atticNodes: roomNodes("attic"),
    anticipations: (data.anticipations || []).filter((item) => !charId || item.charId === charId),
    studyNodes: roomNodes("study"),
    userRoomNodes: roomNodes("user_room"),
    selfRoomNodes: roomNodes("self_room"),
    recentContext: allNodes
      .slice()
      .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
      .slice(0, 12),
    recentEpisodes: Array.isArray(body.recentEpisodes) ? body.recentEpisodes : [],
  };
}

function memoryContextForPersonality(data, charId = "") {
  const sampleNodes = (data.memories || [])
    .filter((item) => !charId || item.charId === charId)
    .slice()
    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
    .slice(0, 20);
  return sampleNodes.length > 0
    ? `\n## 已有的记忆样本\n${sampleNodes.map((n, i) => `${i + 1}. [${n.room}/${n.mood}] ${n.content}`).join("\n")}`
    : "";
}

function relatedMemoriesForPrompt(data, body = {}, charId = "") {
  if (Array.isArray(body.relatedMemories)) return body.relatedMemories;
  const query = clean(body.query || body.conversationText || body.logsText || "");
  const source = (data.memories || []).filter((item) => !charId || item.charId === charId);
  const scored = query
    ? searchHubData({ ...data, memories: source }, query, { limit: 30 })
    : source
      .slice()
      .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
      .slice(0, 30);
  return scored.map((item) => ({
    id: item.id,
    room: item.room,
    content: item.content,
  }));
}

function parseRelatedToAndHints(parsed = [], memories = [], relatedMemories = []) {
  const crossTimeLinks = [];
  const eventBoxHints = [];
  let memIdx = 0;
  for (const item of parsed) {
    if (!item || !item.content || !item.room) continue;
    const mem = memories[memIdx];
    if (!mem) continue;
    let hasAnyLink = false;
    if (relatedMemories.length > 0 && Array.isArray(item.relatedTo) && item.relatedTo.length > 0) {
      for (const ref of item.relatedTo) {
        const idx = parseInt(String(ref).replace(/^O/i, ""), 10);
        if (idx >= 0 && idx < relatedMemories.length && relatedMemories[idx]?.id) {
          crossTimeLinks.push({ newMemoryId: mem.id, existingMemoryId: relatedMemories[idx].id });
          hasAnyLink = true;
        }
      }
    }
    if (Array.isArray(item.sameAs) && item.sameAs.length > 0) {
      for (const ref of item.sameAs) {
        const idx = parseInt(String(ref).replace(/^N/i, ""), 10);
        if (idx >= 0 && idx < memIdx && memories[idx]) {
          crossTimeLinks.push({ newMemoryId: mem.id, existingMemoryId: memories[idx].id });
          hasAnyLink = true;
        }
      }
    }
    if (hasAnyLink) {
      const eventName = clean(item.eventName || "");
      const eventTags = Array.isArray(item.eventTags) ? item.eventTags.map(String).filter(Boolean) : [];
      if (eventName || eventTags.length > 0) eventBoxHints.push({ newMemoryId: mem.id, eventName, eventTags });
    }
    memIdx += 1;
  }
  return { crossTimeLinks, eventBoxHints };
}

function newEventBox(charId, name = "", tags = []) {
  const now = Date.now();
  return {
    id: eventBoxId(),
    charId,
    name: clean(name || "未命名事件"),
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean).slice(0, 20) : [],
    summaryNodeId: null,
    liveMemoryIds: [],
    archivedMemoryIds: [],
    compressionCount: 0,
    createdAt: now,
    updatedAt: now,
    lastCompressedAt: null,
  };
}

function addMemoriesToEventBox(data, box, memoryIds = []) {
  const inBox = new Set([...(box.liveMemoryIds || []), ...(box.archivedMemoryIds || [])]);
  if (box.summaryNodeId) inBox.add(box.summaryNodeId);
  let added = 0;
  data.memories = (data.memories || []).map((memory) => {
    if (!memoryIds.includes(memory.id) || inBox.has(memory.id)) return memory;
    if (memory.eventBoxId && memory.eventBoxId !== box.id) return memory;
    added += 1;
    if (!memory.isBoxSummary && !memory.archived && !(box.liveMemoryIds || []).includes(memory.id)) box.liveMemoryIds.push(memory.id);
    if (memory.archived && !(box.archivedMemoryIds || []).includes(memory.id)) box.archivedMemoryIds.push(memory.id);
    return { ...memory, eventBoxId: box.id };
  });
  if (added > 0) {
    box.updatedAt = Date.now();
    data.eventBoxes = mergeById(data.eventBoxes || [], box);
  }
  return added;
}

function mergeEventBoxes(data, boxes = []) {
  if (boxes.length <= 1) return boxes[0] || null;
  const sorted = boxes.slice().sort((a, b) => {
    const c = Number(b.compressionCount || 0) - Number(a.compressionCount || 0);
    return c || Number(a.createdAt || 0) - Number(b.createdAt || 0);
  });
  const primary = sorted[0];
  const others = sorted.slice(1);
  for (const other of others) {
    const otherSummary = other.summaryNodeId;
    data.memories = (data.memories || []).map((memory) => {
      if (memory.id === otherSummary) {
        primary.liveMemoryIds = [...new Set([...(primary.liveMemoryIds || []), memory.id])];
        return { ...memory, isBoxSummary: false, archived: false, eventBoxId: primary.id };
      }
      if ([...(other.archivedMemoryIds || []), ...(other.liveMemoryIds || [])].includes(memory.id)) {
        return { ...memory, eventBoxId: primary.id };
      }
      return memory;
    });
    primary.archivedMemoryIds = [...new Set([...(primary.archivedMemoryIds || []), ...(other.archivedMemoryIds || [])])];
    primary.liveMemoryIds = [...new Set([...(primary.liveMemoryIds || []), ...(other.liveMemoryIds || [])])];
    if (otherSummary) primary.liveMemoryIds = [...new Set([...(primary.liveMemoryIds || []), otherSummary])];
  }
  primary.updatedAt = Date.now();
  data.eventBoxes = (data.eventBoxes || []).filter((box) => box.id === primary.id || !others.some((other) => other.id === box.id));
  data.eventBoxes = mergeById(data.eventBoxes, primary);
  return primary;
}

function bindMemoriesIntoEventBoxInData(data, charId, links = [], hints = []) {
  const touched = new Set();
  if (!links.length) return touched;
  const grouped = new Map();
  for (const { newMemoryId, existingMemoryId } of links) {
    const list = grouped.get(newMemoryId) || [];
    if (!list.includes(existingMemoryId)) list.push(existingMemoryId);
    grouped.set(newMemoryId, list);
  }
  const hintByNew = new Map(hints.map((hint) => [hint.newMemoryId, hint]));
  for (const [newId, existingIds] of grouped) {
    const newNode = (data.memories || []).find((item) => item.id === newId);
    if (!newNode) continue;
    const existingNodes = existingIds.map((id) => (data.memories || []).find((item) => item.id === id)).filter(Boolean);
    const boxIds = new Set([newNode.eventBoxId, ...existingNodes.map((item) => item.eventBoxId)].filter(Boolean));
    const boxes = [...boxIds].map((id) => (data.eventBoxes || []).find((box) => box.id === id)).filter(Boolean);
    const openBoxes = boxes.filter((box) => !box.sealed && (box.liveMemoryIds || []).length < EVENT_BOX_LIVE_HARD_CAP);
    const sealedBoxes = boxes.filter((box) => box.sealed || (box.liveMemoryIds || []).length >= EVENT_BOX_LIVE_HARD_CAP);
    let target = null;
    if (openBoxes.length === 0) {
      const hint = hintByNew.get(newId) || {};
      const predecessor = sealedBoxes.slice().sort((a, b) => Number(b.lastCompressedAt || b.updatedAt || 0) - Number(a.lastCompressedAt || a.updatedAt || 0))[0];
      target = newEventBox(charId, hint.eventName || predecessor?.name || "", hint.eventTags || predecessor?.tags || []);
      if (predecessor) target.predecessorBoxId = predecessor.id;
      data.eventBoxes = mergeById(data.eventBoxes || [], target);
    } else if (openBoxes.length === 1) {
      target = openBoxes[0];
    } else {
      target = mergeEventBoxes(data, openBoxes);
    }
    if (!target) continue;
    const ids = [newId, ...existingNodes.filter((item) => !item.eventBoxId || !sealedBoxes.some((box) => box.id === item.eventBoxId)).map((item) => item.id)];
    addMemoriesToEventBox(data, target, ids);
    touched.add(target.id);
  }
  return touched;
}

function defaultRoomPlates(data, charId = "") {
  return PLATE_ROOMS.map((roomKey) => (
    (data.roomPlates || []).find((item) => item.charId === charId && item.room === roomKey) || defaultPlate(charId, roomKey)
  ));
}

function pickPlateMaterialLines(nodes = [], roomKey, sinceTs = 0) {
  const candidates = nodes.filter((item) => item.room === roomKey && !item.archived);
  const summaries = candidates.filter((item) => item.isBoxSummary);
  const fresh = candidates
    .filter((item) => !item.isBoxSummary && Number(item.createdAt || 0) > sinceTs)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const anchors = sinceTs > 0
    ? candidates
      .filter((item) => !item.isBoxSummary && Number(item.createdAt || 0) <= sinceTs)
      .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0) || Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 5)
    : [];
  return [...summaries, ...fresh, ...anchors]
    .slice(0, 15)
    .map((item) => clean(item.content).replace(/\s+/g, " ").slice(0, 160));
}

async function consolidateHubPlates(data, config, { charId, charName, userName, materials, extraMaterial, identityContext = "", persist = true } = {}) {
  const allNodes = (data.memories || []).filter((item) => !charId || item.charId === charId);
  const plateMaterials = Array.isArray(materials) && materials.length
    ? materials
    : PLATE_ROOMS.map((roomKey) => {
      const extra = (extraMaterial?.[roomKey] || []).map((line) => clean(line).replace(/\s+/g, " ").slice(0, 320)).filter(Boolean);
      return { room: roomKey, lines: [...extra, ...pickPlateMaterialLines(allNodes, roomKey, 0)] };
    });
  const plates = defaultRoomPlates(data, charId).filter((plate) => plateMaterials.some((item) => item.room === plate.room));
  const hasMaterial = plateMaterials.some((item) => (item.lines || []).length > 0);
  const hasEntries = plates.some((plate) => (plate.entries || []).length > 0);
  if (!hasMaterial && !hasEntries) return { updated: [], roomPlates: plates, fallback: false };
  let parsed = [];
  try {
    const { reply } = await callMemoryPalaceLLM(config, [
      { role: "system", content: buildPlateSystemPrompt({ charName, userName, plates, materials: plateMaterials, identityContext }) },
      { role: "user", content: "请开始整理。" },
    ], { temperature: 0.3, maxTokens: 8000, timeoutMs: 120000 });
    parsed = safeParseJsonArray(reply).filter((item) => item && typeof item.text === "string" && PLATE_ROOMS.includes(item.room));
  } catch {
    parsed = [];
  }
  if (!parsed.length) {
    const updated = extraMaterial ? fallbackMergePlateSubmissions(data, charId, extraMaterial, plates.map((plate) => plate.room)) : [];
    return { updated, roomPlates: defaultRoomPlates(data, charId), fallback: true };
  }
  const now = Date.now();
  const updated = [];
  const skipped = [];
  for (const plate of plates) {
    const roomItems = parsed.filter((item) => item.room === plate.room);
    if (!roomItems.length) {
      skipped.push(plate.room);
      continue;
    }
    const mergedEntries = mergePlateEntries(plate.room, plate.entries || [], roomItems, now);
    const nextPlate = { ...plate, entries: mergedEntries, updatedAt: now, version: Number(plate.version || 0) + 1 };
    if (persist) data.roomPlates = mergeById(data.roomPlates || [], nextPlate);
    updated.push(plate.room);
  }
  if (extraMaterial && skipped.length) {
    updated.push(...fallbackMergePlateSubmissions(data, charId, extraMaterial, skipped));
  }
  return { updated: [...new Set(updated)], roomPlates: defaultRoomPlates(data, charId), fallback: false, rawCount: parsed.length };
}

function findSourceNode(material, id) {
  return [
    ...(material.atticNodes || []),
    ...(material.studyNodes || []),
    ...(material.userRoomNodes || []),
    ...(material.selfRoomNodes || []),
    ...(material.recentEpisodes || []),
    ...(material.recentContext || []),
  ].find((item) => item.id === id);
}

function findNearDuplicateInRoom(data, charId, roomKey, content) {
  const needle = clean(content).replace(/\s+/g, "");
  if (!needle) return null;
  return (data.memories || []).find((item) => item.charId === charId && item.room === roomKey && clean(item.content).replace(/\s+/g, "") === needle) || null;
}

function markNodeDigested(data, id, at = Date.now()) {
  data.memories = (data.memories || []).map((item) => item.id === id ? { ...item, digestedAt: at } : item);
}

function updateMemoryInData(data, id, patch = {}) {
  let updated = null;
  data.memories = (data.memories || []).map((item) => {
    if (item.id !== id) return item;
    const contentChanged = Object.prototype.hasOwnProperty.call(patch, "content") && clean(patch.content) !== clean(item.content);
    updated = { ...item, ...patch, ...(contentChanged ? { embedded: false, vectorRefresh: true } : {}), updatedAt: Date.now() };
    return updated;
  });
  return updated;
}

function calculateEffectiveImportanceInHub(node, now = Date.now()) {
  const room = clean(node?.room || "living_room");
  const config = MEMORY_ROOM_CONFIGS[room] || MEMORY_ROOM_CONFIGS.living_room;
  const importance = Math.max(1, Math.min(10, Number(node?.importance || 5)));
  if (config.decayRate === null) return importance;
  const createdAt = Number(node?.createdAt || 0);
  const hours = createdAt ? (now - createdAt) / 3600000 : 0;
  if (hours <= 0) return importance;
  const decayed = importance * Math.pow(config.decayRate, hours);
  const floor = importance * (EFFECTIVE_IMPORTANCE_FLOOR_RATIOS[room] ?? 0.8);
  return Math.max(decayed, floor);
}

function shouldPromoteHubMemory(node, now = Date.now()) {
  if (node?.room !== "living_room") return false;
  const importance = Number(node.importance || 5);
  if (importance >= 8) return true;
  const createdAt = Number(node.createdAt || 0);
  const ageHours = createdAt ? (now - createdAt) / 3600000 : 0;
  if (importance >= 6 && ageHours >= 24) return true;
  return Number(node.accessCount || 0) >= 3;
}

function runMemoryConsolidationInData(data, charId, now = Date.now()) {
  const promoted = [];
  const evicted = [];
  const changedIds = new Set();
  const scopedLivingRoom = () => (data.memories || []).filter((node) => (
    node.charId === charId && node.room === "living_room"
  ));

  for (const node of scopedLivingRoom()) {
    if (!shouldPromoteHubMemory(node, now)) continue;
    node.room = "bedroom";
    promoted.push(node.id);
    changedIds.add(node.id);
  }

  const capacity = MEMORY_ROOM_CONFIGS.living_room.capacity;
  const remaining = scopedLivingRoom();
  if (capacity !== null && remaining.length > capacity) {
    const toEvict = remaining
      .map((node) => ({ node, effective: calculateEffectiveImportanceInHub(node, now) }))
      .sort((a, b) => a.effective - b.effective)
      .slice(0, remaining.length - capacity);
    for (const { node } of toEvict) {
      node.room = "attic";
      evicted.push(node.id);
      changedIds.add(node.id);
    }
  }

  const metadataSynced = syncVectorMetadata(data, [...changedIds]);
  return {
    promoted,
    evicted,
    changed: changedIds.size,
    metadataSynced,
    livingRoomCount: scopedLivingRoom().length,
    capacity,
  };
}

function applyDigestActionsToData(data, actions = [], charId, material = {}) {
  const result = {
    resolved: [], deepened: [], faded: [],
    fulfilled: [], disappointed: [], internalized: [],
    synthesizedUser: [], selfInsights: [], selfConfused: [],
    worries: [], aspirations: [], distilled: [],
  };
  const plateSubmissions = {};
  const submitToPlate = (roomKey, line) => {
    if (!PLATE_ROOMS.includes(roomKey) || !clean(line)) return;
    plateSubmissions[roomKey] = [...(plateSubmissions[roomKey] || []), clean(line)];
  };
  let worryCount = 0;
  let aspireCount = 0;
  let distillCount = 0;
  for (const action of actions) {
    const kind = clean(action.action);
    if (kind === "resolve") {
      const node = (material.atticNodes || []).find((item) => item.id === action.id);
      if (node) {
        const updated = updateMemoryInData(data, node.id, { room: "bedroom", mood: "peaceful", content: clean(action.reflection || node.content) });
        if (updated) result.resolved.push({ id: updated.id, content: updated.content });
      }
    } else if (kind === "deepen") {
      const node = (material.atticNodes || []).find((item) => item.id === action.id);
      if (node) {
        const updated = updateMemoryInData(data, node.id, { importance: Math.min(10, Number(node.importance || 5) + 1), content: clean(action.reflection || node.content) });
        if (updated) result.deepened.push({ id: updated.id, content: updated.content });
      }
    } else if (kind === "fade") {
      const node = (material.atticNodes || []).find((item) => item.id === action.id);
      if (node) {
        const updated = updateMemoryInData(data, node.id, { importance: Math.max(1, Number(node.importance || 5) - 2) });
        if (updated) result.faded.push({ id: updated.id, content: updated.content });
      }
    } else if (kind === "fulfill") {
      const ant = (material.anticipations || []).find((item) => item.id === action.id);
      const memory = fulfillAnticipationInData(data, ant);
      if (ant) result.fulfilled.push({ id: ant.id, content: ant.content, memoryId: memory?.id });
    } else if (kind === "disappoint") {
      const ant = (material.anticipations || []).find((item) => item.id === action.id);
      const memory = disappointAnticipationInData(data, ant);
      if (ant) result.disappointed.push({ id: ant.id, content: ant.content, memoryId: memory?.id });
    } else if (kind === "internalize") {
      const node = (material.studyNodes || []).find((item) => item.id === action.id);
      if (node && action.reflection) {
        markNodeDigested(data, node.id);
        result.internalized.push({ id: node.id, content: clean(action.reflection) });
        submitToPlate("self_room", action.reflection);
      }
    } else if (kind === "synthesize_user") {
      const node = (material.userRoomNodes || []).find((item) => item.id === action.id);
      if (node && action.reflection) {
        markNodeDigested(data, node.id);
        const category = clean(action.category || "综合");
        result.synthesizedUser.push({ id: node.id, content: clean(action.reflection), category });
        submitToPlate("user_room", `[${category}] ${action.reflection}`);
      }
    } else if (kind === "self_insight") {
      const node = (material.selfRoomNodes || []).find((item) => item.id === action.id);
      if (node && action.insight) {
        markNodeDigested(data, node.id);
        result.selfInsights.push(clean(action.insight));
        submitToPlate("self_room", action.insight);
      }
    } else if (kind === "self_confuse") {
      const node = (material.selfRoomNodes || []).find((item) => item.id === action.id);
      if (node && action.reflection) {
        markNodeDigested(data, node.id);
        if (findNearDuplicateInRoom(data, charId, "attic", action.reflection)) continue;
        const memory = normalizeGeneratedMemory({
          content: action.reflection,
          room: "attic",
          tags: ["自我困惑", "反刍", ...((node.tags || []).filter((tag) => tag !== "自我困惑" && tag !== "反刍"))],
          importance: 6,
          mood: "confused",
        }, { charId, charName: node.charName || "", source: "sullyos_memory_palace", origin: "digestion", prefix: "mn" });
        memory.boxId = "digest_self_confuse";
        memory.boxTopic = "自我反刍困惑";
        memory.sourceId = node.id;
        memory.createdAt = node.createdAt || memory.createdAt;
        mergeGeneratedMemories(data, [memory]);
        result.selfConfused.push({ id: memory.id, content: memory.content });
      }
    } else if (kind === "worry") {
      const episode = (material.recentEpisodes || []).find((item) => item.id === action.id);
      if (episode && action.reflection && worryCount < REFLECT_MAX_WORRIES) {
        if (findNearDuplicateInRoom(data, charId, "attic", action.reflection)) continue;
        worryCount += 1;
        const memory = normalizeGeneratedMemory({
          content: action.reflection,
          room: "attic",
          tags: ["回看", "担忧", ...((episode.tags || []).slice(0, 3))],
          importance: 5,
          mood: "anxious",
        }, { charId, charName: episode.charName || "", source: "sullyos_memory_palace", origin: "digestion", prefix: "mn" });
        memory.sourceId = episode.id;
        mergeGeneratedMemories(data, [memory]);
        result.worries.push({ id: memory.id, content: memory.content });
      }
    } else if (kind === "aspire") {
      const episode = (material.recentEpisodes || []).find((item) => item.id === action.id);
      if (episode && action.reflection && aspireCount < REFLECT_MAX_ASPIRES) {
        aspireCount += 1;
        const ant = createAnticipationInData(data, charId, action.reflection);
        result.aspirations.push({ id: ant.id, content: ant.content });
      }
    } else if (kind === "distill") {
      const episode = (material.recentEpisodes || []).find((item) => item.id === action.id);
      const roomKey = clean(action.plate_room || "");
      if (episode && action.reflection && distillCount < REFLECT_MAX_DISTILLS && PLATE_ROOMS.includes(roomKey)) {
        distillCount += 1;
        submitToPlate(roomKey, action.reflection);
        result.distilled.push({ id: episode.id, content: clean(action.reflection), category: roomKey });
      }
    } else if (kind === "keep") {
      const node = findSourceNode(material, action.id);
      if (node && (action.markDigested || action.seen)) markNodeDigested(data, node.id);
    }
  }
  return { result, plateSubmissions };
}

async function runDigestOnceInData(settings, data, body = {}, { trigger = "manual" } = {}) {
  const { charId, charName, charContext } = characterForPrompt(data, body);
  const config = resolveMemoryPalaceLightLLM(settings, data, body);
  const material = materialForDigest(data, body, charId);
  const { reply } = await callMemoryPalaceLLM(config, [
    { role: "system", content: buildDigestSystemPrompt({ charName, charPersona: clean(body.charPersona || charContext), material, userName: clean(body.userName || "用户") }) },
    { role: "user", content: "请开始审视。" },
  ], { temperature: 0.6, maxTokens: 8000, timeoutMs: 120000 });
  const actions = safeParseJsonArray(reply);
  const anticipationChanged = processAnticipationLifecycleInData(data, charId);
  const applied = applyDigestActionsToData(data, actions, charId, material);
  // SullyOS treats every reviewed study/user/self candidate as consumed,
  // including omitted/keep decisions, so stale candidates do not re-enter
  // every digestion cycle. Attic and anticipation items remain stateful.
  const reviewedAt = Date.now();
  const reviewedIds = new Set([
    ...(material.studyNodes || []),
    ...(material.userRoomNodes || []),
    ...(material.selfRoomNodes || []),
  ].map((item) => item.id).filter(Boolean));
  if (reviewedIds.size) {
    data.memories = (data.memories || []).map((memory) =>
      reviewedIds.has(memory.id) && !memory.digestedAt
        ? { ...memory, digestedAt: reviewedAt, updatedAt: reviewedAt }
        : memory
    );
  }
  let plateUpdate = { updated: [], fallback: false };
  if (body.consolidatePlates !== false && Object.keys(applied.plateSubmissions).length > 0) {
    plateUpdate = await consolidateHubPlates(data, config, {
      charId,
      charName,
      userName: clean(body.userName || "用户"),
      extraMaterial: applied.plateSubmissions,
      identityContext: clean(body.identityContext || ""),
      persist: true,
    });
  }
  const vectorized = await autoVectorizePendingMemories(settings, data, { charId, limit: body.vectorLimit || 25, skipDedup: false });
  return {
    id: clean(body.reportId || generatedMemoryId("digest")),
    charId,
    charName,
    actions,
    result: applied.result,
    vectorized,
    anticipationChanged,
    plateSubmissions: applied.plateSubmissions,
    plateUpdated: plateUpdate.updated || [],
    rawCount: actions.length,
    createdAt: Date.now(),
    source: "sullyos_memory_palace",
    trigger,
  };
}

async function runDigestTickInData(settings, data, body = {}) {
  const { charId } = characterForPrompt(data, body);
  if (!charId) return { enabled: false, threshold: 0, count: 0, triggered: false, report: null, error: "charId is required" };
  const enabled = body.enabled ?? settings.digestAutoEnabled;
  const threshold = Math.max(1, Math.min(500, Number(body.threshold || settings.digestAutoRounds || 50) || 50));
  const counters = data.digestRoundCounters || {};
  const current = Number(counters[charId] || 0) + 1;
  counters[charId] = current;
  data.digestRoundCounters = counters;
  let triggered = false;
  let report = null;
  if (enabled && current >= threshold) {
    counters[charId] = 0;
    report = await runDigestOnceInData(settings, data, body, { trigger: `auto_${threshold}_rounds` });
    data.digestReports = mergeById(data.digestReports || [], report);
    data.lastDigestAt = { ...(data.lastDigestAt || {}), [charId]: Date.now() };
    triggered = true;
  }
  return { enabled: Boolean(enabled), threshold, count: counters[charId], triggered, report };
}

async function enforceEventBoxSummaryLength(content, config, charName) {
  const original = String(content || "");
  if (original.length <= EVENT_BOX_SUMMARY_HARD_MAX_CHARS) return original;
  let recompressed = "";
  try {
    const { reply } = await callMemoryPalaceLLM(config, [
      { role: "system", content: buildRecompressSummaryPrompt({ targetMaxChars: EVENT_BOX_SUMMARY_TARGET_MAX_CHARS, charName }) },
      { role: "user", content: original },
    ], { temperature: 0.3, maxTokens: 4000, timeoutMs: 90000 });
    recompressed = clean(reply)
      .replace(/^```[a-zA-Z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
  } catch (error) {
    console.warn("[Memory Hub] EventBox summary recompression failed:", error?.message || error);
  }
  if (recompressed && recompressed.length <= EVENT_BOX_SUMMARY_HARD_MAX_CHARS) return recompressed;
  const fallback = recompressed && recompressed.length < original.length ? recompressed : original;
  return `${fallback.slice(0, EVENT_BOX_SUMMARY_HARD_MAX_CHARS)}……`;
}

async function compressEventBoxInData(data, config, boxId, { charId, charName, userName, updatePlate = true, settings = null } = {}) {
  const box = (data.eventBoxes || []).find((item) => item.id === boxId);
  if (!box || box.sealed) return null;
  const liveIds = box.liveMemoryIds || [];
  if (liveIds.length < EVENT_BOX_COMPRESSION_THRESHOLD) return null;
  const liveNodes = liveIds.map((id) => (data.memories || []).find((item) => item.id === id)).filter(Boolean);
  if (liveNodes.length < EVENT_BOX_COMPRESSION_THRESHOLD) return null;
  const oldSummary = box.summaryNodeId ? (data.memories || []).find((item) => item.id === box.summaryNodeId) : null;
  const oldSummaryContent = clean(oldSummary?.content || "");
  const oldSummaryBlock = oldSummaryContent
    ? `\n## 你之前已经回忆过这件事一次，那时记下的是：\n${oldSummaryContent}\n\n后来又新增了下面这些：\n`
    : `\n## 关于这件事的零散记忆碎片：\n`;
  const { reply } = await callMemoryPalaceLLM(config, [
    { role: "system", content: buildCompressionSystemPrompt({ box, charName, userName }) },
    { role: "user", content: `${oldSummaryBlock}\n${liveNodesTextForPrompt(liveNodes)}` },
  ], { temperature: 0.5, maxTokens: 8000, timeoutMs: 120000 });
  const summary = safeParseJsonObject(reply);
  if (!summary?.content) return null;
  summary.content = await enforceEventBoxSummaryLength(summary.content, config, charName);
  const generatedSummary = normalizeGeneratedMemory({
    ...summary,
    room: summary.room || box.room || "living_room",
    eventBoxId: box.id,
    eventName: summary.name || box.name,
    eventTags: summary.tags || box.tags,
  }, { charId, charName, source: "sullyos_memory_palace", origin: "eventbox_compression", prefix: "mn_box" });
  const memory = oldSummary
    ? {
        ...oldSummary,
        ...generatedSummary,
        id: oldSummary.id,
        createdAt: oldSummary.createdAt,
        lastAccessedAt: Date.now(),
        embedded: false,
        vectorRefresh: true,
        archived: false,
      }
    : generatedSummary;
  memory.isBoxSummary = true;
  mergeGeneratedMemories(data, [memory]);
  data.memories = (data.memories || []).map((item) => liveIds.includes(item.id) ? { ...item, archived: true, eventBoxId: box.id, updatedAt: Date.now() } : item);
  const metadataSynced = syncVectorMetadata(data, liveIds);
  const vectorized = settings ? await autoVectorizeMemories(settings, data, [memory], { skipDedup: true }) : { attempted: 0, stored: 0, skipped: 0, error: "" };
  const archivedMemoryIds = [...new Set([...(box.archivedMemoryIds || []), ...liveIds])];
  const totalBoxEvents = archivedMemoryIds.length;
  const nextBox = {
    ...box,
    name: clean(summary.name || box.name),
    tags: Array.isArray(summary.tags) ? summary.tags.map(String).filter(Boolean).slice(0, 15) : (box.tags || []),
    summaryNodeId: memory.id,
    liveMemoryIds: [],
    archivedMemoryIds,
    compressionCount: Number(box.compressionCount || 0) + 1,
    lastCompressedAt: Date.now(),
    updatedAt: Date.now(),
    sealed: box.sealed || totalBoxEvents >= EVENT_BOX_SEAL_THRESHOLD,
  };
  data.eventBoxes = mergeById(data.eventBoxes || [], nextBox);
  if (updatePlate && PLATE_ROOMS.includes(memory.room)) {
    await consolidateHubPlates(data, config, {
      charId,
      charName,
      userName,
      materials: [{ room: memory.room, lines: [memory.content] }],
      persist: true,
    });
  }
  return { box: nextBox, summary, memory, vectorized, metadataSynced };
}

async function runMemoryExtractionPipeline(settings, data, body = {}, options = {}) {
  const { charId, charName, userName, charContext } = characterForPrompt(data, body);
  const conversationText = conversationTextForPrompt(body, charName, userName);
  if (!conversationText) {
    return {
      ok: true,
      promptSource: "SullyOS extraction.ts",
      skipped: true,
      reason: "empty conversationText",
      imported: 0,
      memories: [],
      rawCount: 0,
      related: { crossTimeLinks: [], eventBoxHints: [] },
      touchedEventBoxes: [],
      compressed: [],
      vectorized: { attempted: 0, stored: 0, skipped: 0, error: "" },
    };
  }
  const config = resolveMemoryPalaceLightLLM(settings, data, body);
  const relatedMemories = relatedMemoriesForPrompt(data, { ...body, conversationText }, charId);
  const systemPrompt = buildExtractionSystemPrompt({
    charName,
    userName,
    charContext,
    relatedMemories,
    pinnedMemories: body.pinnedMemories || [],
  });
  const { reply } = await callMemoryPalaceLLM(config, [
    { role: "system", content: systemPrompt },
    { role: "user", content: `对话内容：\n${conversationText}` },
  ], { temperature: 0.4, maxTokens: 12000, timeoutMs: 180000 });
  const parsed = safeParseJsonArray(reply);
  const memories = parsed
    .filter((item) => item && item.content && item.room)
    .map((item) => normalizeGeneratedMemory(item, { charId, charName, source: "sullyos_memory_palace", origin: clean(options.origin || body.origin || "extraction") }));
  const related = parseRelatedToAndHints(parsed, memories, relatedMemories);
  let vectorized = { attempted: 0, stored: 0, skipped: 0, error: "" };
  let touchedEventBoxes = [];
  const compressed = [];
  let consolidation = { promoted: [], evicted: [], changed: 0, metadataSynced: 0, livingRoomCount: 0, capacity: MEMORY_ROOM_CONFIGS.living_room.capacity };
  if (options.persist !== false) {
    mergeGeneratedMemories(data, memories);
    data.memoryLinks = mergeListByKey(data.memoryLinks || [], related.crossTimeLinks.map((item) => ({ ...item, id: `${item.newMemoryId}:${item.existingMemoryId}` })));
    data.eventBoxHints = mergeListByKey(data.eventBoxHints || [], related.eventBoxHints.map((item) => ({ ...item, id: item.newMemoryId })));
    touchedEventBoxes = [...bindMemoriesIntoEventBoxInData(data, charId, related.crossTimeLinks, related.eventBoxHints)];
    data.lastTouchedEventBoxes = touchedEventBoxes;
    vectorized = await autoVectorizeMemories(settings, data, memories, { skipDedup: Boolean(options.skipDedup) });
    if (body.autoCompress !== false) {
      for (const boxId of touchedEventBoxes) {
        const result = await compressEventBoxInData(data, config, boxId, { charId, charName, userName, updatePlate: body.updatePlate !== false, settings });
        if (result) compressed.push(result);
      }
    }
    consolidation = runMemoryConsolidationInData(data, charId);
  }
  return {
    ok: true,
    promptSource: "SullyOS extraction.ts",
    imported: memories.length,
    memories,
    rawCount: parsed.length,
    related,
    touchedEventBoxes,
    compressed,
    vectorized,
    consolidation,
  };
}

function mergeRuntimeAutoArchive(data, charId, memoryIds, highWaterMark) {
  const characterIndex = (data.characters || []).findIndex((item) => item.id === charId);
  if (characterIndex < 0) return { enabled: false, fragments: 0 };
  const character = data.characters[characterIndex];
  if (!character.autoArchiveEnabled) return { enabled: false, fragments: 0 };
  const selected = (data.memories || [])
    .filter((item) => memoryIds.includes(item.id))
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  if (!selected.length) return { enabled: true, fragments: 0 };
  const byDate = new Map();
  for (const memory of selected) {
    const d = new Date(Number(memory.createdAt || Date.now()));
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const bullets = byDate.get(date) || [];
    bullets.push(`- ${clean(memory.content).replace(/\n/g, " ")}`);
    byDate.set(date, bullets);
  }
  const legacy = Array.isArray(character.memories) ? [...character.memories] : [];
  let fragments = 0;
  for (const [date, bullets] of byDate) {
    const existingIndex = legacy.findIndex((item) => item.date === date && item.mood === "palace");
    if (existingIndex >= 0) {
      legacy[existingIndex] = {
        ...legacy[existingIndex],
        summary: [clean(legacy[existingIndex].summary), ...bullets].filter(Boolean).join("\n"),
      };
    } else {
      legacy.push({
        id: `hub_auto_${date}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        date,
        summary: bullets.join("\n"),
        mood: "palace",
        sourceAuthority: "memory_hub",
      });
    }
    fragments += 1;
  }
  data.characters[characterIndex] = {
    ...character,
    memories: legacy,
    hideBeforeMessageId: highWaterMark,
  };
  return { enabled: true, fragments };
}

function runtimeJobVectorsReady(data, job) {
  const vectorIds = new Set((data.vectors || []).map(vectorKey).filter(Boolean));
  return Array.isArray(job?.memoryIds)
    && job.memoryIds.length > 0
    && job.memoryIds.every((id) => vectorIds.has(id));
}

function commitRuntimePendingJob(data, runtime, charId, job) {
  runtime.highWaterMarks = { ...(runtime.highWaterMarks || {}), [charId]: Number(job.toId || 0) };
  const autoArchive = mergeRuntimeAutoArchive(data, charId, job.memoryIds || [], Number(job.toId || 0));
  delete runtime.pendingJobs[charId];
  runtime.lastRuns[charId] = {
    at: new Date().toISOString(),
    status: "completed",
    fromId: job.fromId,
    toId: job.toId,
    processedMessages: job.processedMessages,
    memoryIds: job.memoryIds || [],
    autoArchive,
  };
  return autoArchive;
}

async function processRuntimeMessageBuffer(settings, data, runtime, body = {}) {
  const charId = clean(body.charId || body.characterId || "");
  if (!charId) return { ok: false, skipped: true, reason: "charId_required", dataChanged: false };
  if (runtimeProcessingLocks.has(charId)) {
    return { ok: true, skipped: true, reason: "lock", dataChanged: false };
  }
  runtimeProcessingLocks.add(charId);
  try {
    let recoveredPending = false;
    const pending = runtime.pendingJobs?.[charId];
    if (pending) {
      const pendingMemories = (data.memories || []).filter((item) => (pending.memoryIds || []).includes(item.id));
      if (!runtimeJobVectorsReady(data, pending) && pendingMemories.length) {
        await autoVectorizeMemories(settings, data, pendingMemories, { skipDedup: true });
      }
      if (!runtimeJobVectorsReady(data, pending)) {
        runtime.lastRuns[charId] = {
          at: new Date().toISOString(),
          status: "awaiting_vectors",
          fromId: pending.fromId,
          toId: pending.toId,
          processedMessages: pending.processedMessages,
          memoryIds: pending.memoryIds || [],
        };
        return {
          ok: true,
          skipped: true,
          reason: "awaiting_vectors",
          pendingJob: pending,
          dataChanged: true,
        };
      }
      commitRuntimePendingJob(data, runtime, charId, pending);
      recoveredPending = true;
    }

    const state = runtimeBufferState(runtime, charId, Boolean(body.force));
    if (!state.toProcess.length) {
      runtime.lastRuns[charId] = {
        at: new Date().toISOString(),
        status: "skipped",
        reason: state.reason,
        highWaterMark: state.highWaterMark,
        buffer: state.buffer.length,
        threshold: state.threshold,
      };
      return {
        ok: true,
        skipped: true,
        reason: state.reason,
        highWaterMark: state.highWaterMark,
        buffer: state.buffer.length,
        threshold: state.threshold,
        hotZone: RUNTIME_HOT_ZONE_SIZE,
        dataChanged: recoveredPending,
      };
    }

    const chunks = [];
    for (let index = 0; index < state.toProcess.length; index += RUNTIME_CHUNK_SIZE) {
      chunks.push(state.toProcess.slice(index, index + RUNTIME_CHUNK_SIZE));
    }
    const batchResults = [];
    const memoryIds = [];
    let successfulMessages = 0;
    let lastSuccessfulMessageId = state.highWaterMark;
    let failedBatch = null;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const memoryIdsBefore = new Set((data.memories || []).map((item) => item.id));
      try {
        const extraction = await runMemoryExtractionPipeline(
          settings,
          data,
          { ...body, charId, messages: chunk, conversationText: "", digestMode: "none" },
          { persist: true, origin: "chat_turn", skipDedup: true }
        );
        memoryIds.push(...(extraction.memories || []).map((item) => item.id));
        successfulMessages += chunk.length;
        lastSuccessfulMessageId = chunk[chunk.length - 1].id;
        batchResults.push({
          index: index + 1,
          total: chunks.length,
          messages: chunk.length,
          imported: extraction.imported || 0,
          vectorized: extraction.vectorized,
          ok: true,
        });
      } catch (error) {
        const recoveredMemoryIds = (data.memories || [])
          .filter((item) => !memoryIdsBefore.has(item.id))
          .map((item) => item.id);
        if (recoveredMemoryIds.length) {
          memoryIds.push(...recoveredMemoryIds);
          successfulMessages += chunk.length;
          lastSuccessfulMessageId = chunk[chunk.length - 1].id;
        }
        failedBatch = {
          index: index + 1,
          total: chunks.length,
          messages: chunk.length,
          imported: recoveredMemoryIds.length,
          recovered: recoveredMemoryIds.length > 0,
          ok: false,
          error: String(error?.message || error),
        };
        batchResults.push(failedBatch);
        if (!recoveredMemoryIds.length) break;
      }
    }
    if (!successfulMessages) {
      runtime.lastRuns[charId] = {
        at: new Date().toISOString(),
        status: "failed",
        processedMessages: 0,
        batches: batchResults,
      };
      return {
        ok: false,
        skipped: true,
        reason: "extraction_failed",
        error: failedBatch?.error || "memory extraction failed",
        processedMessages: 0,
        batches: batchResults,
        dataChanged: false,
      };
    }

    if (!memoryIds.length) {
      runtime.highWaterMarks = {
        ...(runtime.highWaterMarks || {}),
        [charId]: lastSuccessfulMessageId,
      };
      runtime.lastRuns[charId] = {
        at: new Date().toISOString(),
        status: "completed_no_memories",
        highWaterMark: lastSuccessfulMessageId,
        processedMessages: successfulMessages,
        batches: batchResults,
      };
      return {
        ok: true,
        skipped: false,
        committed: true,
        reason: "no_memories",
        highWaterMark: lastSuccessfulMessageId,
        processedMessages: successfulMessages,
        memories: 0,
        batches: batchResults,
        failedBatch,
        dataChanged: recoveredPending,
      };
    }

    const job = {
      id: `runtime:${charId}:${state.toProcess[0].id}-${lastSuccessfulMessageId}`,
      charId,
      status: "awaiting_vectors",
      fromId: state.toProcess[0].id,
      toId: lastSuccessfulMessageId,
      processedMessages: successfulMessages,
      memoryIds: [...new Set(memoryIds)],
      batches: batchResults,
      createdAt: new Date().toISOString(),
    };
    runtime.pendingJobs = { ...(runtime.pendingJobs || {}), [charId]: job };
    if (!runtimeJobVectorsReady(data, job)) {
      runtime.lastRuns[charId] = { ...job, at: new Date().toISOString() };
      return {
        ok: true,
        skipped: false,
        committed: false,
        reason: "awaiting_vectors",
        pendingJob: job,
        batches: batchResults,
        dataChanged: true,
      };
    }
    const autoArchive = commitRuntimePendingJob(data, runtime, charId, job);
    return {
      ok: true,
      skipped: false,
      committed: true,
      highWaterMark: job.toId,
      processedMessages: job.processedMessages,
      memories: job.memoryIds.length,
      batches: batchResults,
      autoArchive,
      failedBatch,
      dataChanged: true,
    };
  } finally {
    runtimeProcessingLocks.delete(charId);
  }
}

async function fetchEmbeddingModels(config) {
  const url = embeddingModelsUrl(config.baseUrl);
  const headers = { Accept: "application/json" };
  if (config.apiKey) headers.Authorization = "Bearer " + config.apiKey;
  const response = await fetch(url, { headers });
  const body = await readApiResponse(response);
  if (!response.ok) {
    const message = upstreamErrorMessage(body, response);
    throw new Error("models fetch failed: " + message);
  }
  const models = Array.isArray(body.data)
    ? body.data.map((item) => item.id || item.name).filter(Boolean)
    : [];
  return { url, models, rawCount: Array.isArray(body.data) ? body.data.length : 0 };
}

function memoryEmbeddingText(memory) {
  return [
    memory.title,
    memory.content,
    memory.room,
    memory.mood,
    ...(memory.tags || []),
  ].filter(Boolean).join("\n");
}

async function createEmbeddings(config, inputs) {
  if (!config.baseUrl) throw new Error("embedding baseUrl is empty");
  if (!config.model) throw new Error("embedding model is empty");
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (config.apiKey) headers.Authorization = "Bearer " + config.apiKey;
  const payload = { model: config.model, input: inputs };
  const dimensions = Number(config.dimensions);
  if (Number.isFinite(dimensions) && dimensions > 0) payload.dimensions = dimensions;
  const response = await fetch(embeddingCreateUrl(config.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await readApiResponse(response);
  if (!response.ok) {
    const message = upstreamErrorMessage(body, response);
    throw new Error("embedding failed: " + message);
  }
  const rows = Array.isArray(body.data) ? body.data : [];
  return rows.map((item) => item.embedding).filter(Array.isArray);
}

const VECTOR_DEDUP_THRESHOLD = 0.9;

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
}

function normalizeModelName(model = "") {
  return clean(model).replace(/^Pro\//i, "").toLowerCase();
}

function markMemoriesNeedEmbedding(hubData, ids = []) {
  const set = new Set(ids.filter(Boolean));
  if (!set.size) return 0;
  let changed = 0;
  hubData.memories = (hubData.memories || []).map((memory) => {
    if (!set.has(memory.id)) return memory;
    changed += 1;
    return { ...memory, embedded: false, updatedAt: Date.now() };
  });
  return changed;
}

async function vectorizeAndStoreHub(settings, hubData, nodes = [], options = {}) {
  const candidates = nodes.filter((node) => node?.id && node.content);
  if (!candidates.length) return { stored: 0, skipped: 0, attempted: 0 };
  const config = resolveEmbeddingConfig(settings, hubData, options.embedding || {});
  const embeddings = await createEmbeddings(config, candidates.map((node) => node.content));
  const charId = candidates[0]?.charId || "";
  const existingVectors = options.skipDedup
    ? []
    : (hubData.vectors || []).filter((vector) => !charId || vector.charId === charId);
  let stored = 0;
  let skipped = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const node = candidates[i];
    const embedding = embeddings[i];
    if (!Array.isArray(embedding)) continue;
    const duplicate = !options.skipDedup && !node.vectorRefresh && existingVectors
      .filter((vector) => vectorKey(vector) !== node.id)
      .some((vector) => cosineSimilarity(embedding, vectorValues(vector)) > VECTOR_DEDUP_THRESHOLD);
    if (duplicate) {
      skipped += 1;
      continue;
    }
    const memoryVector = {
      id: `vector:${node.id}`,
      memoryId: node.id,
      charId: node.charId,
      room: node.room,
      model: config.model,
      dimensions: embedding.length,
      embedding,
      archived: Boolean(node.archived),
      isBoxSummary: Boolean(node.isBoxSummary),
      eventBoxId: node.eventBoxId || "",
      updatedAt: new Date().toISOString(),
    };
    hubData.vectors = mergeById(hubData.vectors || [], memoryVector);
    existingVectors.push(memoryVector);
    hubData.memories = (hubData.memories || []).map((memory) => memory.id === node.id ? { ...memory, embedded: true, vectorRefresh: false, updatedAt: Date.now() } : memory);
    stored += 1;
  }
  hubData.embeddingConfig = extractEmbeddingConfig(hubData);
  hubData.importedAt = new Date().toISOString();
  return { stored, skipped, attempted: candidates.length, model: config.model, dimensions: config.dimensions || embeddings[0]?.length || "" };
}

function syncVectorMetadata(hubData, ids = []) {
  const idSet = new Set(ids.filter(Boolean));
  const memoryById = new Map((hubData.memories || []).map((memory) => [memory.id, memory]));
  let changed = 0;
  hubData.vectors = (hubData.vectors || []).map((vector) => {
    const id = vectorKey(vector);
    if (idSet.size && !idSet.has(id)) return vector;
    const memory = memoryById.get(id);
    if (!memory) return vector;
    changed += 1;
    return {
      ...vector,
      charId: memory.charId,
      room: memory.room,
      archived: Boolean(memory.archived),
      isBoxSummary: Boolean(memory.isBoxSummary),
      eventBoxId: memory.eventBoxId || "",
      updatedAt: new Date().toISOString(),
    };
  });
  return changed;
}

async function autoVectorizeMemories(settings, hubData, memories = [], options = {}) {
  const candidates = memories.filter((memory) => memory?.id && memory.content);
  if (!candidates.length) return { attempted: 0, stored: 0, skipped: 0, error: "" };
  try {
    const result = await vectorizeAndStoreHub(settings, hubData, candidates, options);
    return { attempted: result.attempted || candidates.length, stored: result.stored || 0, skipped: result.skipped || 0, model: result.model || "", dimensions: result.dimensions || "", error: "" };
  } catch (error) {
    markMemoriesNeedEmbedding(hubData, candidates.map((memory) => memory.id));
    hubData.vectorQueueErrors = [
      ...((hubData.vectorQueueErrors || []).slice(-19)),
      { at: new Date().toISOString(), ids: candidates.map((memory) => memory.id), error: String(error?.message || error) },
    ];
    return { attempted: candidates.length, stored: 0, skipped: 0, error: String(error?.message || error) };
  }
}

async function autoVectorizePendingMemories(settings, hubData, options = {}) {
  const charId = clean(options.charId || "");
  const limit = Math.max(1, Math.min(Number(options.limit || 25), 100));
  const vectorByMemory = new Map((hubData.vectors || []).map((item) => [vectorKey(item), item]).filter(([key]) => key));
  const pending = (hubData.memories || [])
    .filter((memory) => memory.content && (!charId || memory.charId === charId) && (memory.embedded === false || memory.vectorRefresh || !vectorByMemory.has(memory.id)))
    .slice(0, limit);
  return autoVectorizeMemories(settings, hubData, pending, { embedding: options.embedding || {}, skipDedup: Boolean(options.skipDedup) });
}

function checkModelConsistencyHub(hubData, charId, currentModel) {
  const vectors = (hubData.vectors || []).filter((vector) => !charId || vector.charId === charId);
  if (!vectors.length) return "empty";
  const sample = vectors.find((vector) => vector.model);
  if (!sample) return "match";
  return normalizeModelName(sample.model) === normalizeModelName(currentModel) ? "match" : "mismatch";
}

function textTokens(text) {
  const raw = clean(text).toLowerCase();
  const matches = raw.match(/#[\w\u4e00-\u9fa5-]+|[\u4e00-\u9fa5]{2,8}|[a-z][a-z0-9_-]{2,}/g) || [];
  const stop = new Set(["current", "this", "that", "self", "none", "memory", "room", "important", "sync", "sullyos"]);
  return new Set(matches.map((item) => item.replace(/^#/, "").trim()).filter((item) => item && !stop.has(item)));
}

function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter += 1;
  return inter / (a.size + b.size - inter || 1);
}

function daysBetween(a, b) {
  const ta = Date.parse(a || "");
  const tb = Date.parse(b || "");
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.abs(ta - tb) / 86400000;
}

function vectorSignature(values, bands = 12, width = 6) {
  if (!Array.isArray(values) || !values.length) return [];
  const step = Math.max(1, Math.floor(values.length / (bands * width)));
  const signatures = [];
  for (let band = 0; band < bands; band += 1) {
    let bits = "";
    for (let i = 0; i < width; i += 1) {
      const index = (band * width + i) * step;
      bits += Number(values[index] || 0) >= 0 ? "1" : "0";
    }
    signatures.push(`${band}:${bits}`);
  }
  return signatures;
}

function duplicateCandidates(hubData, options = {}) {
  const charId = clean(options.charId || "");
  const limit = Math.max(1, Math.min(Number(options.limit || 120), 300));
  const minVector = Math.max(0.72, Math.min(Number(options.minVector || 0.86), 0.99));
  const minHybrid = Math.max(0.55, Math.min(Number(options.minHybrid || 0.78), 0.98));
  const memories = (hubData.memories || [])
    .filter((memory) => !charId || memory.charId === charId)
    .filter((memory) => memory.syncState !== "merged" && !memory.duplicateOf && !memory.mergedInto)
    .filter((memory) => memory?.id && memory.embedded !== false);
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const vectorByMemory = new Map((hubData.vectors || [])
    .filter((vector) => !charId || vector.charId === charId)
    .map((vector) => [vectorKey(vector), vector])
    .filter(([key, vector]) => key && memoryById.has(key) && vectorValues(vector).length));
  const prepared = memories.map((memory) => {
    const vector = vectorByMemory.get(memory.id);
    const values = vectorValues(vector);
    const tokens = textTokens(memoryEmbeddingText(memory));
    return { memory, vector, values, tokens };
  });
  const candidateKeys = new Set();
  const buckets = new Map();
  const addToBucket = (key, index) => {
    if (!key) return;
    const list = buckets.get(key) || [];
    if (list.length < 120) list.push(index);
    buckets.set(key, list);
  };
  prepared.forEach((item, index) => {
    addToBucket(`char:${item.memory.charId || ""}`, index);
    addToBucket(`room:${item.memory.charId || ""}:${item.memory.room || ""}`, index);
    if (item.memory.eventBoxId) addToBucket(`event:${item.memory.charId || ""}:${item.memory.eventBoxId}`, index);
    for (const tag of item.memory.tags || []) addToBucket(`tag:${item.memory.charId || ""}:${String(tag).toLowerCase()}`, index);
    for (const sig of vectorSignature(item.values)) addToBucket(`vec:${item.memory.charId || ""}:${sig}`, index);
  });
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i], b = list[j];
        candidateKeys.add(a < b ? `${a}:${b}` : `${b}:${a}`);
      }
    }
  }
  const results = [];
  for (const key of candidateKeys) {
    const [ia, ib] = key.split(":").map(Number);
    const a = prepared[ia], b = prepared[ib];
    if (!a || !b || a.memory.id === b.memory.id) continue;
    const vectorScore = a.values.length && b.values.length ? cosineSimilarity(a.values, b.values) : 0;
    const textScore = jaccard(a.tokens, b.tokens);
    const sameRoom = a.memory.room && a.memory.room === b.memory.room;
    const sameEvent = a.memory.eventBoxId && a.memory.eventBoxId === b.memory.eventBoxId;
    const sameTags = (a.memory.tags || []).filter((tag) => (b.memory.tags || []).includes(tag));
    const closeDays = daysBetween(a.memory.createdAt || a.memory.timestamp || a.memory.updatedAt, b.memory.createdAt || b.memory.timestamp || b.memory.updatedAt);
    const timeScore = Number.isFinite(closeDays) ? Math.max(0, 1 - closeDays / 14) : 0;
    const metadataBoost = (sameRoom ? 0.04 : 0) + (sameEvent ? 0.08 : 0) + Math.min(0.06, sameTags.length * 0.02) + (timeScore * 0.04);
    const hybridScore = Math.min(1, vectorScore * 0.72 + textScore * 0.18 + metadataBoost);
    if (vectorScore < minVector && hybridScore < minHybrid && !(sameEvent && (vectorScore >= 0.78 || textScore >= 0.35))) continue;
    const reasons = [];
    if (vectorScore) reasons.push("vector similar " + vectorScore.toFixed(3));
    if (textScore >= 0.12) reasons.push("text overlap " + textScore.toFixed(2));
    if (sameEvent) reasons.push("same EventBox");
    if (sameRoom) reasons.push("same room");
    if (sameTags.length) reasons.push("same tags " + sameTags.slice(0, 4).join(" / "));
    if (timeScore >= 0.5) reasons.push("near in time " + closeDays.toFixed(1) + " days");
    results.push({
      id: `${a.memory.id}::${b.memory.id}`,
      score: Number(hybridScore.toFixed(4)),
      vectorScore: Number(vectorScore.toFixed(4)),
      textScore: Number(textScore.toFixed(4)),
      reasons,
      a: a.memory,
      b: b.memory,
    });
  }
  results.sort((left, right) => right.score - left.score || right.vectorScore - left.vectorScore);
  return {
    ok: true,
    candidates: results.slice(0, limit),
    totalCandidates: results.length,
    scannedMemories: memories.length,
    scannedVectors: vectorByMemory.size,
    thresholds: { minVector, minHybrid },
  };
}

function mergeDuplicateMemories(hubData, options = {}) {
  const keepId = clean(options.keepId || "");
  const mergeId = clean(options.mergeId || "");
  if (!keepId || !mergeId || keepId === mergeId) {
    const error = new Error("keepId and mergeId are required and must be different");
    error.statusCode = 400;
    throw error;
  }
  const memories = hubData.memories || [];
  const keepIndex = memories.findIndex((item) => item.id === keepId);
  const mergeIndex = memories.findIndex((item) => item.id === mergeId);
  if (keepIndex < 0 || mergeIndex < 0) {
    const error = new Error("memory not found");
    error.statusCode = 404;
    throw error;
  }
  const keep = memories[keepIndex];
  const merged = memories[mergeIndex];
  if (keep.charId && merged.charId && keep.charId !== merged.charId) {
    const error = new Error("refuse to merge memories from different AI brains");
    error.statusCode = 409;
    throw error;
  }
  const now = new Date().toISOString();
  const keepContent = clean(keep.content || "");
  const mergeContent = clean(merged.content || "");
  const contentAlreadyIncluded = mergeContent && keepContent.includes(mergeContent);
  const combinedContent = mergeContent && !contentAlreadyIncluded
    ? `${keepContent || clean(keep.title || keep.id)}\n\n【合并自 ${mergeId}】\n${mergeContent}`.trim()
    : keepContent;
  const tags = [...new Set([...(keep.tags || []), ...(merged.tags || [])].map(clean).filter(Boolean))];
  const mergedFrom = [...new Set([...(keep.mergedFrom || []), mergeId, ...(merged.mergedFrom || [])].filter(Boolean))];
  memories[keepIndex] = {
    ...keep,
    content: combinedContent || keep.content || merged.content,
    tags,
    importance: Math.max(Number(keep.importance || 0), Number(merged.importance || 0)) || keep.importance || merged.importance,
    mood: keep.mood || merged.mood,
    room: keep.room || merged.room,
    eventBoxId: keep.eventBoxId || merged.eventBoxId,
    mergedFrom,
    mergedAt: now,
    syncState: keep.syncState === "merged" ? "synced" : keep.syncState,
    updatedAt: now,
  };
  memories[mergeIndex] = {
    ...merged,
    archived: true,
    syncState: "merged",
    duplicateOf: keepId,
    mergedInto: keepId,
    mergedAt: now,
    updatedAt: now,
  };
  hubData.vectors = (hubData.vectors || []).map((vector) => (
    vectorKey(vector) === mergeId
      ? { ...vector, archived: true, mergedInto: keepId, updatedAt: now }
      : vector
  ));
  hubData.importedAt = now;
  return { ok: true, keep: memories[keepIndex], merged: memories[mergeIndex] };
}

function keywordScore(query, item) {
  const q = clean(query).toLowerCase();
  if (!q) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  const haystack = [
    item.id,
    item.title,
    item.content,
    item.room,
    item.charId,
    item.mood,
    item.type,
    ...(item.tags || []),
  ].join(" ").toLowerCase();
  let score = haystack.includes(q) ? 4 : 0;
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  return score;
}

function roomPlateRecallEntries(roomPlates = []) {
  return roomPlates.flatMap((plate) => {
    const entries = Array.isArray(plate.entries) ? plate.entries : [];
    return entries.map((entry, index) => ({
      id: entry.id || `${plate.id || plate.room || "plate"}:${index}`,
      plateId: plate.id || "",
      charId: plate.charId || "",
      room: plate.room || "",
      title: entry.title || entry.tag || plate.room || "闂ㄧ墝",
      content: entry.text || entry.content || entry.summary || "",
      text: entry.text || entry.content || entry.summary || "",
      tag: entry.tag || "闂ㄧ墝",
      type: "room_plate",
      sourceCount: entry.sourceCount,
      firstLearnedAt: entry.firstLearnedAt,
      updatedAt: entry.updatedAt || plate.updatedAt,
    })).filter((entry) => entry.content || entry.title);
  });
}

function formatMemoryDateWithDistance(timestamp, now = Date.now()) {
  const time = memoryTimeMs({ createdAt: timestamp });
  if (!time) return "时间未知";
  const d = new Date(time);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const days = Math.floor((now - time) / (24 * 60 * 60 * 1000));
  if (!Number.isFinite(days)) return date;
  if (days <= 0) return `${date}（今天）`;
  if (days === 1) return `${date}（昨天）`;
  if (days < 30) return `${date}（${days}天前）`;
  if (days < 365) return `${date}（${Math.floor(days / 30)}个月前）`;
  return `${date}（${Math.floor(days / 365)}年前）`;
}

function hubRoomLabel(roomKey, userName = "用户") {
  return {
    living_room: "客厅",
    bedroom: "卧室",
    study: "书房",
    user_room: `${userName}的房间`,
    self_room: "自我房间",
    attic: "阁楼",
    windowsill: "窗台",
  }[roomKey] || roomKey || "未知房间";
}

function hubRoomDescription(roomKey) {
  return {
    living_room: "日常闲聊、近期互动",
    bedroom: "亲密情感、深层羁绊",
    study: "工作学习、技能成长",
    user_room: "用户个人信息、习惯",
    self_room: "角色自我认同、演变",
    attic: "未消化的困惑、潜意识",
    windowsill: "期盼、目标、憧憬",
  }[roomKey] || "";
}

function buildStandaloneRecallItem(memory, score, now) {
  return {
    type: "memory",
    score,
    room: memory.room,
    body: `(${formatMemoryDateWithDistance(memory.createdAt || memory.updatedAt || memory.occurredAt, now)}, 重要性: ${memory.importance || 5})\n${memory.content}`,
    createdAt: memoryTimeMs(memory),
    importance: Number(memory.importance || 5),
    debugLabel: `mem ${memory.id}`,
    sourceIds: [memory.id],
    memories: [memory],
  };
}

function eventBoxLiveNodeScore(memory, query = "", now = Date.now(), hitIds = new Set()) {
  const importance = Number(memory.importance || 5);
  const ageDays = memoryTimeMs(memory) ? Math.max(0, (now - memoryTimeMs(memory)) / 86400000) : 999;
  const recency = Math.max(0, 1 - ageDays / 60);
  const similarity = keywordScore(query, memory);
  const hitBoost = hitIds.has(memory.id) ? 100 : 0;
  return {
    score: hitBoost + importance * 1.2 + recency * 3 + similarity * 2,
    importance,
    recency: Number(recency.toFixed(4)),
    similarity,
    ageDays: Number(ageDays.toFixed(1)),
  };
}

function selectEventBoxLiveNodes(liveNodes = [], hitNodeIds = [], { mode = "compat", query = "", liveLimit = 5, now = Date.now() } = {}) {
  const hitIds = new Set(hitNodeIds);
  if (mode !== "enhanced") {
    return {
      selected: liveNodes.slice(0, 8),
      omitted: Math.max(0, liveNodes.length - 8),
      debug: liveNodes.slice(0, 8).map((memory, index) => ({ id: memory.id, reason: `compat slice(0,8) #${index + 1}` })),
    };
  }
  const limit = Math.max(1, Math.min(Number(liveLimit || 5), 20));
  const byId = new Map(liveNodes.map((memory) => [memory.id, memory]));
  const selected = [];
  const selectedIds = new Set();
  const debug = [];
  for (const id of hitNodeIds) {
    const memory = byId.get(id);
    if (!memory || selectedIds.has(memory.id)) continue;
    selected.push(memory);
    selectedIds.add(memory.id);
    debug.push({ id: memory.id, reason: "命中的 live node 必带", metrics: eventBoxLiveNodeScore(memory, query, now, hitIds) });
  }
  const ranked = liveNodes
    .filter((memory) => !selectedIds.has(memory.id))
    .map((memory) => ({ memory, metrics: eventBoxLiveNodeScore(memory, query, now, hitIds) }))
    .sort((a, b) => b.metrics.score - a.metrics.score || memoryTimeMs(b.memory) - memoryTimeMs(a.memory));
  for (const item of ranked) {
    if (selected.length >= limit) break;
    selected.push(item.memory);
    selectedIds.add(item.memory.id);
    const reasons = [];
    if (item.metrics.importance >= 8) reasons.push(`importance ${item.metrics.importance}`);
    if (item.metrics.recency > 0.5) reasons.push(`recency ${item.metrics.ageDays}d`);
    if (item.metrics.similarity > 0) reasons.push(`query similarity ${item.metrics.similarity}`);
    debug.push({ id: item.memory.id, reason: reasons.join(" + ") || "补足 live node 名额", metrics: item.metrics });
  }
  return { selected, omitted: Math.max(0, liveNodes.length - selected.length), debug };
}

function buildEventBoxRecallItem(hubData, box, score, now, options = {}) {
  const memoryById = new Map((hubData.memories || []).map((item) => [item.id, item]));
  const summary = box.summaryNodeId ? memoryById.get(box.summaryNodeId) || null : null;
  const liveNodes = (box.liveMemoryIds || [])
    .map((id) => memoryById.get(id))
    .filter((item) => item && !item.archived)
    .sort((a, b) => memoryTimeMs(a) - memoryTimeMs(b));
  if (!summary && !liveNodes.length) return null;
  const repNode = summary || liveNodes.slice().sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))[0];
  const selection = selectEventBoxLiveNodes(liveNodes, options.hitNodeIds || [], {
    mode: options.eventBoxMode || "compat",
    query: options.query || "",
    liveLimit: options.eventBoxLiveLimit || 5,
    now,
  });
  const liveToShow = selection.selected;
  const omitted = selection.omitted;
  let body = `📦 **事件盒：${box.name || box.title || box.id}**`;
  const tags = Array.isArray(box.tags) ? box.tags.filter(Boolean).slice(0, 6) : [];
  if (tags.length) body += `  〈${tags.join(" · ")}〉`;
  body += "\n";
  if (summary) {
    body += `_整合回忆_ (${formatMemoryDateWithDistance(summary.createdAt || summary.updatedAt, now)}, 重要性 ${summary.importance || 5}, 已压缩 ${box.compressionCount || 0} 次)\n`;
    body += `${summary.content}\n`;
  }
  if (liveToShow.length) {
    body += summary ? `_新增片段_：\n` : "";
    for (const memory of liveToShow) {
      body += `- [${formatMemoryDateWithDistance(memory.createdAt || memory.updatedAt, now)}] ${memory.content}\n`;
    }
    if (omitted > 0) body += `（另有 ${omitted} 条同盒活节点未展示）\n`;
  }
  const sourceIds = [summary?.id, ...liveToShow.map((item) => item.id)].filter(Boolean);
  return {
    type: "event_box",
    eventBoxId: box.id,
    eventBox: box,
    score,
    room: repNode.room,
    body: body.trimEnd(),
    createdAt: memoryTimeMs(summary || liveToShow[liveToShow.length - 1] || box),
    importance: Number(repNode.importance || 5),
    debugLabel: `box ${box.id} (${liveNodes.length} live${summary ? " + summary" : ""})`,
    sourceIds,
    memories: [summary, ...liveToShow].filter(Boolean),
    debug: {
      mode: options.eventBoxMode || "compat",
      summaryId: summary?.id || "",
      liveTotal: liveNodes.length,
      liveSelected: selection.debug,
      omitted,
      hitNodeIds: options.hitNodeIds || [],
    },
  };
}

function expandAndFormatHubRecall(scored = [], hubData, { charId = "", userName = "用户", maxOutputItems = 15, query = "", eventBoxMode = "compat", eventBoxLiveLimit = 5, now = Date.now() } = {}) {
  now = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const allCharNodes = (hubData.memories || []).filter((item) => !charId || item.charId === charId);
  const pinnedNodes = allCharNodes.filter((item) => item.pinnedUntil && item.pinnedUntil > now && !item.archived);
  const pinnedIds = new Set(pinnedNodes.map((item) => item.id));
  const boxes = new Map((hubData.eventBoxes || []).filter((box) => !charId || box.charId === charId).map((box) => [box.id, box]));
  const boxHits = new Map();
  const standalone = [];
  for (const memory of scored) {
    if (pinnedIds.has(memory.id)) continue;
    const ebId = memory.eventBoxId;
    if (ebId && boxes.has(ebId)) {
      const cur = boxHits.get(ebId) || { topScore: -Infinity, hitNodeIds: new Set() };
      cur.topScore = Math.max(cur.topScore, Number(memory.recallScore || 0));
      cur.hitNodeIds.add(memory.id);
      boxHits.set(ebId, cur);
    } else if (!memory.archived) {
      standalone.push(memory);
    }
  }
  const items = [];
  for (const [boxId, hit] of boxHits) {
    const item = buildEventBoxRecallItem(hubData, boxes.get(boxId), hit.topScore, now, {
      hitNodeIds: [...hit.hitNodeIds],
      query,
      eventBoxMode,
      eventBoxLiveLimit,
    });
    if (item) {
      item.hitNodeIds = [...hit.hitNodeIds];
      items.push(item);
    }
  }
  for (const memory of standalone) items.push(buildStandaloneRecallItem(memory, Number(memory.recallScore || 0), now));
  items.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
  const finalItems = items.slice(0, maxOutputItems);
  const activeAnticipations = (hubData.anticipations || []).filter((item) => (!charId || item.charId === charId) && (item.status === "active" || item.status === "anchor"));
  let markdown = "";
  if (finalItems.length || pinnedNodes.length || activeAnticipations.length) {
    markdown += "### 记忆宫殿 (Memory Palace)\n";
    markdown += "以下是你脑海中浮现的相关记忆片段，它们可能影响你此刻的感受和反应：\n\n";
  }
  if (pinnedNodes.length) {
    markdown += "📌 **便利贴（近期重要事项）**\n";
    for (const memory of pinnedNodes) {
      const daysLeft = Math.ceil((memory.pinnedUntil - now) / (24 * 60 * 60 * 1000));
      markdown += `- [${formatMemoryDateWithDistance(memory.createdAt || memory.updatedAt, now)}] ${memory.content}（剩余 ${daysLeft} 天）\n`;
    }
    markdown += "\n";
  }
  const byRoom = new Map();
  for (const item of finalItems) {
    const list = byRoom.get(item.room) || [];
    list.push(item);
    byRoom.set(item.room, list);
  }
  for (const roomKey of ["bedroom", "living_room", "study", "user_room", "self_room", "attic", "windowsill"]) {
    const list = byRoom.get(roomKey) || [];
    for (const item of list) {
      markdown += `**[${hubRoomLabel(roomKey, userName)} · ${hubRoomDescription(roomKey)}]** ${item.body}\n\n`;
    }
  }
  if (activeAnticipations.length) {
    markdown += "> **窗台期盼**:\n";
    for (const ant of activeAnticipations) {
      const label = ant.status === "anchor" ? "🔒 锚点" : "✨ 期盼";
      markdown += `> - ${label}: ${ant.content}\n`;
    }
    markdown += "\n";
  }
  return {
    markdown: markdown.trim(),
    items: finalItems,
    pinned: pinnedNodes,
    anticipations: activeAnticipations,
    stats: {
      boxes: boxHits.size,
      standalone: standalone.length,
      finalItems: finalItems.length,
      pinned: pinnedNodes.length,
      cut: Math.max(0, items.length - finalItems.length),
    },
  };
}

function formatRoomPlatesContext(roomPlates = [], userName = "用户") {
  const sections = [];
  const titles = { user_room: `关于${userName}`, self_room: "我是谁", bedroom: "我们之间", study: "我的领域" };
  for (const roomKey of ["user_room", "self_room", "bedroom", "study"]) {
    const plate = roomPlates.find((item) => item.room === roomKey);
    const entries = Array.isArray(plate?.entries) ? plate.entries.filter((entry) => clean(entry.text || entry.content)) : [];
    if (!entries.length) continue;
    const suffix = roomKey === "bedroom" ? "（没有名字，也不需要名字——只有质地）" : "";
    sections.push(`**${titles[roomKey]}**${suffix}\n${entries.map((entry) => `- ${clean(entry.text || entry.content)}`).join("\n")}`);
  }
  return sections.length
    ? `### 底色认知 (Resident Knowledge)\n以下是你早已知道的背景。它们是你认知的底色，不是话题——不要主动提起，也不要逐条复述，只在相关时让它们自然影响你的反应、措辞与温度。\n\n${sections.join("\n\n")}\n`
    : "";
}

async function reindexHubVectors(settings, hubData, options = {}) {
  const stats = analyzeHubData(hubData);
  const memories = hubData.memories || [];
  const vectorByMemory = new Map((hubData.vectors || []).map((item) => [vectorKey(item), item]).filter(([key]) => key));
  const missingVectors = memories.filter((item) => item.content && (item.embedded === false || item.vectorRefresh || !vectorByMemory.has(item.id)));
  const limit = Math.max(1, Math.min(Number(options.limit || 25), 100));
  const charId = clean(options.charId || "");
  const config = resolveEmbeddingConfig(settings, hubData, options.embedding || {});
  const consistency = checkModelConsistencyHub(hubData, charId, config.model);
  const rebuild = Boolean(options.rebuild || options.force || consistency === "mismatch");
  const scopedMemories = memories.filter((memory) => (!charId || memory.charId === charId) && memory.content);
  const candidates = (rebuild ? scopedMemories : missingVectors.filter((memory) => !charId || memory.charId === charId)).slice(0, limit);
  if (options.dryRun) {
    return { ok: true, dryRun: true, candidates: candidates.length, totalMissing: stats.vectorHealth.missingVectors, pendingVectors: stats.vectorHealth.pendingVectors, orphanVectors: stats.vectorHealth.orphanVectors, consistency, rebuild };
  }
  const result = await vectorizeAndStoreHub(settings, hubData, candidates, { embedding: options.embedding || {}, skipDedup: Boolean(rebuild || options.skipDedup) });
  const metadataSynced = syncVectorMetadata(hubData, candidates.map((item) => item.id));
  await writeJsonFile(DATA_FILE, hubData);
  return { ok: true, dryRun: false, indexed: result.stored, skipped: result.skipped, candidates: candidates.length, pendingVectors: stats.vectorHealth.pendingVectors, model: config.model, dimensions: result.dimensions || config.dimensions || "", consistency, rebuild, metadataSynced };
}

async function recallHubData(settings, hubData, body = {}) {
  const query = clean(body.query || "");
  const charId = clean(body.charId || "");
  const roomFilter = clean(body.room || "");
  if (!query) return { ok: true, mode: "empty", memories: [], items: [], memoryPalaceContext: "", plates: [], impressions: [], feels: [], note: "Enter a test query" };
  const memories = (hubData.memories || []).filter((item) => (
    (!charId || item.charId === charId)
    && (!roomFilter || item.room === roomFilter)
    && !item.archived
  ));
  const vectors = (hubData.vectors || []).filter((item) => !charId || item.charId === charId);
  const vectorByMemory = new Map(vectors.map((item) => [vectorKey(item), item]).filter(([key]) => key));
  let mode = "keyword";
  let queryVector = null;
  try {
    if (vectors.length) {
      const config = resolveEmbeddingConfig(settings, hubData, body.embedding || {});
      queryVector = (await createEmbeddings(config, [query]))[0] || null;
      if (queryVector) mode = "vector";
    }
  } catch {
    mode = "keyword";
  }
  const limit = Math.max(1, Math.min(Number(body.limit || 15), 50));
  const candidateLimit = Math.max(Number(body.candidateLimit || 50), limit);
  const scoredPool = memories.map((memory) => {
    const vector = vectorByMemory.get(memory.id);
    const vectorScore = queryVector && vector ? cosineSimilarity(queryVector, vectorValues(vector)) : 0;
    const textScore = keywordScore(query, memory);
    const importanceBoost = (Number(memory.importance) || 0) / 100;
    return { ...memory, recallScore: vectorScore ? vectorScore + textScore * 0.01 + importanceBoost : textScore + importanceBoost };
  }).filter((memory) => memory.recallScore > 0 && (queryVector || keywordScore(query, memory) > 0)).sort((a, b) => b.recallScore - a.recallScore).slice(0, candidateLimit);
  let scored = scoredPool.slice(0, limit);
  const rerankConfig = resolveRerankConfig(settings, hubData, body.rerank || {});
  const rerankMeta = {
    enabled: Boolean(rerankConfig.enabled),
    attempted: false,
    picked: 0,
    error: "",
    model: rerankConfig.model || "",
  };
  if (rerankConfig.enabled && scoredPool.length) {
    try {
      rerankMeta.attempted = true;
      const rows = await rerankDocumentsHub(
        rerankConfig,
        query,
        scoredPool.map((memory) => memory.content),
        Math.min(
          Math.max(limit, Number(rerankConfig.topN || body.rerankTopN || 5) + 10),
          scoredPool.length,
        ),
      );
      const rerankedIds = new Set();
      const reranked = rows
        .map((row) => {
          const memory = scoredPool[row.index];
          if (!memory) return null;
          rerankedIds.add(memory.id);
          return { ...memory, rerankScore: row.relevance_score };
        })
        .filter(Boolean);
      const remainder = scoredPool.filter((memory) => !rerankedIds.has(memory.id));
      scored = [...reranked, ...remainder].slice(0, limit);
      rerankMeta.picked = reranked.length;
      if (reranked.length) mode = mode === "vector" ? "vector+rerank" : "keyword+rerank";
    } catch (error) {
      rerankMeta.error = String(error?.message || error);
    }
  }
  const eventBoxMode = clean(body.eventBoxMode || settings.recallEventBoxMode || "compat") === "enhanced" ? "enhanced" : "compat";
  const eventBoxLiveLimit = Math.max(1, Math.min(Number(body.eventBoxLiveLimit || settings.recallEventBoxLiveLimit || 5) || 5, 20));
  const formatted = expandAndFormatHubRecall(scored, hubData, {
    charId,
    userName: clean(body.userName || "用户"),
    maxOutputItems: limit,
    query,
    eventBoxMode,
    eventBoxLiveLimit,
    now: body.now,
  });
  const recallState = authorityStore.recordRecallState(
    scored.map((memory) => memory.id),
    charId,
    body.now ?? Date.now(),
    { persist: body.persistState === true },
  );
  const userName = clean(body.userName || "用户");
  const scopedRoomPlates = (hubData.roomPlates || []).filter((item) => !charId || item.charId === charId);
  const roomPlatesContext = formatRoomPlatesContext(scopedRoomPlates, userName);
  const relatedText = `${query} ${scored.map((item) => `${item.title} ${item.content} ${(item.tags || []).join(" ")}`).join(" ")}`;
  const pickRelated = (items) => (items || [])
    .filter((item) => !charId || item.charId === charId)
    .map((item) => ({ ...item, recallScore: keywordScore(relatedText, item) }))
    .filter((item) => item.recallScore > 0)
    .sort((a, b) => b.recallScore - a.recallScore)
    .slice(0, 8);
  const promptContext = [roomPlatesContext, formatted.markdown].filter(Boolean).join("\n\n");
  const scoredIds = new Set(scored.map((item) => item.id));
  const finalSourceIds = new Set(formatted.items.flatMap((item) => item.sourceIds || []));
  const trace = {
    eventBoxMode,
    eventBoxLiveLimit,
    candidates: scoredPool.map((memory, index) => ({ rank: index + 1, id: memory.id, room: memory.room, eventBoxId: memory.eventBoxId || "", archived: Boolean(memory.archived), score: Number(memory.recallScore || 0), content: clean(memory.content).slice(0, 160) })),
    selectedCandidates: scored.map((memory, index) => ({ rank: index + 1, id: memory.id, room: memory.room, eventBoxId: memory.eventBoxId || "", archived: Boolean(memory.archived), score: Number(memory.recallScore || 0), rerankScore: typeof memory.rerankScore === "number" ? memory.rerankScore : undefined })),
    eventBoxTriggers: formatted.items.filter((item) => item.type === "event_box").map((item) => ({ eventBoxId: item.eventBoxId, name: item.eventBox?.name || item.eventBox?.title || item.eventBoxId, hitNodeIds: item.hitNodeIds || [], sourceIds: item.sourceIds || [], debug: item.debug || {} })),
    expandedEventBoxes: formatted.items.filter((item) => item.type === "event_box").map((item) => ({ eventBoxId: item.eventBoxId, name: item.eventBox?.name || item.eventBoxId, summaryId: item.debug?.summaryId || "", liveSelected: item.debug?.liveSelected || [], omitted: item.debug?.omitted || 0 })),
    pinned: formatted.pinned.map((memory) => ({ id: memory.id, room: memory.room, content: clean(memory.content).slice(0, 160), pinnedUntil: memory.pinnedUntil })),
    roomPlates: scopedRoomPlates.map((plate) => ({ id: plate.id || `${plate.charId}:${plate.room}`, room: plate.room, entries: (plate.entries || []).map((entry) => ({ id: entry.id || "", text: clean(entry.text || entry.content).slice(0, 160), tag: entry.tag || "" })) })).filter((plate) => plate.entries.length),
    windowsill: formatted.anticipations.map((item) => ({ id: item.id, status: item.status, content: clean(item.content).slice(0, 160) })),
    archivedSkipped: scored.filter((memory) => memory.archived && !finalSourceIds.has(memory.id)).map((memory) => ({ id: memory.id, room: memory.room, eventBoxId: memory.eventBoxId || "", score: Number(memory.recallScore || 0), reason: memory.eventBoxId ? "archived node triggered/related to EventBox, not directly output" : "archived standalone skipped" })),
    finalPromptSections: [
      roomPlatesContext ? { title: "RoomPlate", text: roomPlatesContext } : null,
      formatted.markdown ? { title: "Memory Palace", text: formatted.markdown } : null,
    ].filter(Boolean),
    finalSourceIds: [...finalSourceIds],
    unusedSelectedCandidates: scored.filter((memory) => !finalSourceIds.has(memory.id) && scoredIds.has(memory.id)).map((memory) => ({ id: memory.id, archived: Boolean(memory.archived), eventBoxId: memory.eventBoxId || "" })),
  };
  return {
    ok: true,
    mode,
    query,
    charId,
    memories: formatted.items.flatMap((item) => item.memories || []),
    rawMemories: scored,
    candidateMemories: scoredPool,
    items: formatted.items,
    pinned: formatted.pinned,
    anticipations: formatted.anticipations,
    memoryPalaceContext: formatted.markdown,
    roomPlatesContext,
    promptContext,
    formatterStats: formatted.stats,
    trace,
    rerank: rerankMeta,
    stateChanges: recallState.changes,
    statePersisted: recallState.persisted,
    plates: pickRelated(roomPlateRecallEntries(hubData.roomPlates)),
    impressions: pickRelated(hubData.impressions),
    feels: pickRelated(hubData.feels),
    note: mode.includes("vector") ? "SullyOS-style formatter over embedding vector candidates" : "SullyOS-style formatter over keyword candidates",
  };
}

function memoryTimeMs(memory = {}) {
  const raw = memory.updatedAt || memory.occurredAt || memory.createdAt || memory.timestamp || memory.time || 0;
  if (typeof raw === "number") return raw > 1e12 ? raw : raw * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function breathActivity(hubData) {
  if (!hubData.activity || typeof hubData.activity !== "object" || Array.isArray(hubData.activity)) hubData.activity = {};
  return hubData.activity;
}

function isPinnedMemory(memory = {}) {
  const tags = (memory.tags || []).map((tag) => clean(tag).toLowerCase());
  const type = clean(memory.type).toLowerCase();
  return Boolean(memory.pinned || memory.protected)
    || type === "permanent"
    || Number(memory.importance || 0) >= 10
    || tags.some((tag) => ["core", "pinned", "permanent", "原则", "准则", "核心"].includes(tag));
}

function memoryVitality(memory = {}, activity = {}, now = Date.now()) {
  const importance = Math.max(0, Math.min(10, Number(memory.importance || 5)));
  const pinned = isPinnedMemory(memory);
  const sourceMs = memoryTimeMs(memory);
  const sourceAgeDays = sourceMs ? Math.max(0, (now - sourceMs) / 86400000) : 365;
  const lastTouch = Date.parse(activity.lastActivatedAt || "");
  const touchAgeDays = Number.isFinite(lastTouch) ? Math.max(0, (now - lastTouch) / 86400000) : Infinity;
  const activationCount = Number(activity.activationCount || 0);
  const sourceHalfLife = pinned ? Infinity : importance >= 8 ? 365 : importance >= 6 ? 160 : 60;
  const sourceRetention = pinned ? 1 : Math.pow(0.5, sourceAgeDays / sourceHalfLife);
  const touchRetention = Number.isFinite(touchAgeDays) ? Math.pow(0.5, touchAgeDays / 30) : 0;
  const activationBoost = Math.min(1.2, Math.log1p(activationCount) * 0.24);
  const score = pinned
    ? 1
    : Math.max(0.04, Math.min(1, sourceRetention * 0.56 + touchRetention * 0.32 + activationBoost + importance / 100));
  const dormant = !pinned && score < 0.28;
  const coldImportant = !pinned && importance >= 8 && (!Number.isFinite(touchAgeDays) || touchAgeDays >= 14);
  const label = pinned ? "核心固定" : coldImportant ? "久未浮现" : dormant ? "沉睡" : score >= 0.72 ? "活跃" : "稳定";
  return {
    score,
    label,
    pinned,
    dormant,
    coldImportant,
    sourceAgeDays: Number(sourceAgeDays.toFixed(1)),
    touchAgeDays: Number.isFinite(touchAgeDays) ? Number(touchAgeDays.toFixed(1)) : null,
    decay: pinned ? 0 : Number((1 - score).toFixed(4)),
  };
}

function breathFootprint(memory = {}, activity = {}, hubData = {}) {
  const vectorIds = new Set((hubData.vectors || []).map((item) => vectorKey(item)).filter(Boolean));
  const eventBox = (hubData.eventBoxes || []).find((box) => box.id && box.id === memory.eventBoxId);
  const vitality = memoryVitality(memory, activity);
  return [
    memory.createdAt || memory.occurredAt ? { label: "创建", value: memory.createdAt || memory.occurredAt, source: "SullyOS" } : null,
    memory.syncState ? { label: "同步", value: memory.syncState, source: "Hub" } : null,
    { label: "vitality", value: `${vitality.label} ${Math.round(vitality.score * 100)}%`, source: "Hub vitality" },
    vectorIds.has(memory.id) ? { label: "vector", value: "indexed", source: "Vector" } : { label: "vector", value: "missing", source: "Vector" },
    memory.eventBoxId ? { label: "eventBox", value: eventBox?.name || eventBox?.title || memory.eventBoxId, source: "SullyOS" } : null,
    activity.activationCount ? { label: "activation", value: `${activity.activationCount} times`, source: "Hub touch" } : null,
    activity.lastActivatedAt ? { label: "lastTouched", value: activity.lastActivatedAt, source: "Hub touch" } : null,
    memory.archived ? { label: "status", value: "archived", source: "SullyOS" } : null,
    memory.mergedInto ? { label: "合并", value: `mergedInto ${memory.mergedInto}`, source: "Hub" } : null,
  ].filter(Boolean);
}

function breathMemory(memory, score, reason, hubData) {
  const activity = breathActivity(hubData)[memory.id] || {};
  const vitality = memoryVitality(memory, activity);
  return {
    ...memory,
    breathScore: Number(score.toFixed(4)),
    reason,
    pinned: vitality.pinned,
    vitality,
    activationCount: Number(activity.activationCount || 0),
    lastActivatedAt: activity.lastActivatedAt || "",
    lastSurfacedAt: activity.lastSurfacedAt || "",
    footprint: breathFootprint(memory, activity, hubData),
  };
}

function touchBreathMemories(hubData, memories, reason, { activation = false } = {}) {
  const activity = breathActivity(hubData);
  const now = new Date().toISOString();
  for (const memory of memories || []) {
    if (!memory?.id) continue;
    const old = activity[memory.id] || {};
    activity[memory.id] = {
      ...old,
      activationCount: Number(old.activationCount || 0) + (activation ? 1 : 0),
      lastActivatedAt: activation ? now : old.lastActivatedAt || "",
      lastSurfacedAt: now,
      lastReason: reason,
    };
  }
  hubData.importedAt = now;
}

async function breathHubData(settings, hubData, body = {}) {
  const mode = clean(body.mode || (body.query ? "search" : "surface")).toLowerCase();
  const charId = clean(body.charId || "");
  const roomFilter = clean(body.room || "");
  const limit = Math.max(1, Math.min(Number(body.limit || 12), 50));
  const includeArchived = Boolean(body.includeArchived);
  const allMemories = (hubData.memories || []).filter((memory) => (
    (!charId || memory.charId === charId)
    && (!roomFilter || memory.room === roomFilter)
    && (includeArchived || !memory.archived)
  ));
  const activity = breathActivity(hubData);
  const now = Date.now();
  const ageDays = (memory) => memoryTimeMs(memory) ? Math.max(0, (now - memoryTimeMs(memory)) / 86400000) : 180;
  const act = (memory) => activity[memory.id] || {};

  if (mode === "catalog") {
    const items = allMemories
      .slice()
      .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0) || memoryTimeMs(b) - memoryTimeMs(a))
      .slice(0, limit)
      .map((memory) => ({
        id: memory.id,
        title: memory.title || memory.id,
        room: memory.room,
        charId: memory.charId,
        tags: memory.tags || [],
        importance: memory.importance || 5,
        mood: memory.mood || "",
        pinned: isPinnedMemory(memory),
        archived: Boolean(memory.archived),
        hasVector: (hubData.vectors || []).some((vector) => vectorKey(vector) === memory.id),
        createdAt: memory.createdAt || memory.occurredAt || memory.updatedAt || "",
        activationCount: Number(act(memory).activationCount || 0),
      }));
    return { ok: true, mode, charId, memories: items, note: "catalog mode returns metadata only" };
  }

  if (mode === "feel") {
    const feels = (hubData.feels || [])
      .filter((item) => !charId || item.charId === charId)
      .filter((item) => !roomFilter || item.room === roomFilter)
      .slice()
      .sort((a, b) => memoryTimeMs(b) - memoryTimeMs(a))
      .slice(0, limit);
    return { ok: true, mode, charId, memories: [], plates: [], impressions: [], feels, note: "feel mode returns current AI emotion residue, separate from ordinary memories" };
  }

  if (mode === "importance") {
    const min = Number(body.importanceMin || 8);
    const memories = allMemories
      .filter((memory) => Number(memory.importance || 0) >= min)
      .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0) || memoryTimeMs(b) - memoryTimeMs(a))
      .slice(0, limit)
      .map((memory) => breathMemory(memory, Number(memory.importance || 0), `importance >= ${min}`, hubData));
    return { ok: true, mode, charId, memories, plates: [], impressions: [], feels: [], note: "importance mode skips semantic search and sorts by high importance" };
  }

  if (mode === "search") {
    const result = await recallHubData(settings, hubData, { ...body, charId, room: roomFilter, limit });
    const memories = (result.memories || []).map((memory) => breathMemory(memory, Number(memory.recallScore || 0), String(result.mode || "").includes("vector") ? "vector/keyword hit" : "keyword hit", hubData));
    touchBreathMemories(hubData, memories, "breath_search", { activation: true });
    return { ...result, mode: "search", memories, note: "breath_search: " + (result.note || "") };
  }

  const corePinned = (hubData.coreMemories || [])
    .filter((memory) => !charId || memory.charId === charId)
    .filter((memory) => !roomFilter || memory.room === roomFilter || memory.room === "self_room")
    .slice()
    .sort((a, b) => String(b.period || b.occurredAt || b.updatedAt || "").localeCompare(String(a.period || a.occurredAt || a.updatedAt || "")))
    .slice(0, 3)
    .map((memory) => breathMemory(memory, 120 + Number(memory.importance || 10), "core memory / TA context", hubData));

  const pinned = [
    ...corePinned,
    ...allMemories
    .filter(isPinnedMemory)
    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
    .slice(0, Math.max(0, 4 - corePinned.length))
    .map((memory) => breathMemory(memory, 100 + Number(memory.importance || 0), "core rule / pinned", hubData))
  ];

  const pinnedIds = new Set(pinned.map((memory) => memory.id));
  const regular = allMemories
    .filter((memory) => !pinnedIds.has(memory.id))
    .filter((memory) => !["feel", "plan", "letter"].includes(clean(memory.type).toLowerCase()))
    .map((memory) => {
      const a = act(memory);
      const importance = Number(memory.importance || 5);
      const vitality = memoryVitality(memory, a, now);
      const recency = Math.max(0, 1 - ageDays(memory) / 45);
      const touchAge = vitality.touchAgeDays ?? 999;
      const recentTouch = Math.max(0, 1 - touchAge / 14);
      const surfacedAt = Date.parse(a.lastSurfacedAt || "");
      const surfaceAgeHours = Number.isFinite(surfacedAt) ? Math.max(0, (now - surfacedAt) / 3600000) : Infinity;
      const surfaceCooldown = Number.isFinite(surfaceAgeHours) && surfaceAgeHours < 8 ? (1 - surfaceAgeHours / 8) * 4.8 : 0;
      const cold = vitality.coldImportant ? 2.2 : 0;
      const roomBoost = roomFilter && memory.room === roomFilter ? .8 : 0;
      const varietyJitter = Math.random() * 1.15;
      const score = importance * 1.05 + vitality.score * 6 + recency * 1.8 + recentTouch * 2.4 + cold + roomBoost + varietyJitter - surfaceCooldown;
      return { memory, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit - pinned.length - 2))
    .map((item) => {
      const vitality = memoryVitality(item.memory, act(item.memory), now);
      return breathMemory(item.memory, item.score, vitality.dormant ? "沉睡记忆低频浮现" : vitality.score >= .72 ? "活跃记忆自然浮现" : "自然浮现", hubData);
    });

  const longAbsent = allMemories
    .filter((memory) => !pinnedIds.has(memory.id))
    .filter((memory) => Number(memory.importance || 0) >= 8)
    .filter((memory) => {
      const last = Date.parse(act(memory).lastActivatedAt || act(memory).lastSurfacedAt || "");
      return !Number.isFinite(last) || now - last > 1000 * 60 * 60 * 24 * 7;
    })
    .sort((a, b) => (ageDays(b) + Number(b.importance || 0)) - (ageDays(a) + Number(a.importance || 0)))
    .slice(0, 2)
    .map((memory) => {
      const vitality = memoryVitality(memory, act(memory), now);
      return breathMemory(memory, 10 + Number(memory.importance || 0) + vitality.score * 3, "久未浮现 / suddenly remembered", hubData);
    });

  const memories = [...pinned, ...regular, ...longAbsent]
    .filter((memory, index, list) => list.findIndex((item) => item.id === memory.id) === index)
    .slice(0, limit);
  touchBreathMemories(hubData, memories, "breath_surface", { activation: false });
  const relatedText = memories.map((item) => `${item.title} ${item.content} ${(item.tags || []).join(" ")}`).join(" ");
  const pickRelated = (items) => (items || [])
    .filter((item) => !charId || item.charId === charId)
    .map((item) => ({ ...item, recallScore: keywordScore(relatedText, item) }))
    .filter((item) => item.recallScore > 0)
    .sort((a, b) => b.recallScore - a.recallScore)
    .slice(0, 6);
  return {
    ok: true,
    mode: "surface",
    charId,
    memories,
    plates: pickRelated(roomPlateRecallEntries(hubData.roomPlates)),
    impressions: pickRelated(hubData.impressions),
    feels: [],
    note: "breath mode surfaces core, pinned, and a few dormant memories; writes only Hub activity by default",
  };
}

function toOmbrePayload(memory, char) {
  return {
    id: memory.id,
    sullyNodeId: memory.id,
    charId: memory.charId,
    charName: char?.name || memory.charId,
    groupId: memory.groupId || "",
    room: memory.room,
    visibility: memory.visibility || char?.visibility || "private",
    scope: "memory_palace",
    source: memory.source || "sullyos_memory_palace",
    occurredAt: memory.occurredAt || new Date().toISOString(),
    content: memory.content,
    title: memory.title,
    tags: memory.tags || [],
    importance: memory.importance || 5,
    mood: memory.mood || "",
    type: memory.type || "dynamic",
    valence: Number(memory.valence || 0),
    arousal: Number(memory.arousal || 0),
    eventBoxId: memory.eventBoxId || "",
    archived: Boolean(memory.archived),
    isBoxSummary: Boolean(memory.isBoxSummary),
  };
}

async function syncToOmbre(settings, hubData, options = {}) {
  if (settings.syncMode === "readonly" && !options.force) {
    return { ok: false, error: "syncMode is readonly", synced: 0, results: [] };
  }
  const endpoint = ombreMemoryEndpoint(settings);
  const pending = (hubData.memories || []).filter((item) => options.all || item.syncState !== "synced");
  const characters = new Map((hubData.characters || []).map((item) => [item.id, item]));
  const headers = { "Content-Type": "application/json" };
  if (settings.ombreBridgeKey) headers["X-Sully-Bridge-Key"] = settings.ombreBridgeKey;

  const results = [];
  for (const memory of pending) {
    const payload = toOmbrePayload(memory, characters.get(memory.charId));
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      results.push({ id: memory.id, ok: response.ok && body.ok !== false, status: response.status, body });
    } catch (error) {
      results.push({ id: memory.id, ok: false, error: String(error?.message || error) });
    }
  }
  return {
    ok: results.every((item) => item.ok),
    endpoint,
    attempted: pending.length,
    synced: results.filter((item) => item.ok).length,
    results,
  };
}

function normalizeHubCommand(input = {}, defaults = {}) {
  const commandId = clean(input.commandId || defaults.commandId || randomUUID());
  const existingIssuedAt = input.issuedAt === undefined && commandId
    ? authorityStore.getCommand(commandId)?.issuedAt
    : null;
  return {
    commandId,
    type: clean(input.type || defaults.type || "command.submit"),
    actorId: clean(input.actorId || defaults.actorId || "sullyos-client"),
    characterId: input.characterId === null ? null : clean(input.characterId || defaults.characterId || "") || null,
    worldId: input.worldId === null ? null : clean(input.worldId || defaults.worldId || "") || null,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: Number(input.expectedVersion) }),
    issuedAt: input.issuedAt || defaults.issuedAt || existingIssuedAt || new Date().toISOString(),
    protocolVersion: clean(input.protocolVersion || defaults.protocolVersion || PROTOCOL_VERSION),
    ...(input.client === undefined ? {} : { client: input.client }),
    payload: input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload : (defaults.payload || {}),
    ...(Array.isArray(input.unset) ? { unset: input.unset } : {}),
  };
}

function requireValidContract(name, value) {
  const result = validateContract(name, value);
  if (!result.ok) throw new AuthorityError("VALIDATION_FAILED", `${name} contract validation failed`, 400, { errors: result.errors });
}

function resolveChatTurnConfig(body = {}, data = {}, settings = {}) {
  const requested = body.apiConfig || body.modelConfig || {};
  const stored = data.modelConfig?.chat || data.modelConfig?.main || data.chatModelConfig || data.modelConfig?.lightLLM || {};
  return normalizeApiConfig(requested, {
    baseUrl: stored.baseUrl || settings.chatBaseUrl || "",
    apiKey: stored.apiKey || settings.chatApiKey || "",
    model: stored.model || settings.chatModel || "",
  });
}

async function requestAssembledContext(characterId, body = {}) {
  const localHost = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
  const response = await fetchWithTimeout(`http://${localHost}:${PORT}/api/v1/context/assemble`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(HUB_TOKEN ? { "X-Memory-Hub-Token": HUB_TOKEN } : {}) },
    body: JSON.stringify({ characterId, userId: body.userId, conversationId: body.conversationId, historyLimit: body.historyLimit, recallLimit: body.recallLimit, candidateLimit: body.candidateLimit, eventBoxMode: body.eventBoxMode, eventBoxLiveLimit: body.eventBoxLiveLimit, now: body.now }),
  }, 120000);
  const result = await readApiResponse(response);
  if (!response.ok) throw new AuthorityError(result.code || "CONTEXT_ASSEMBLY_FAILED", result.error || "Context assembly failed", response.status, result.details);
  return result;
}

function mergeRuntimePatch(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return current;
  const next = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else if (value && typeof value === "object" && !Array.isArray(value) && next[key] && typeof next[key] === "object" && !Array.isArray(next[key])) next[key] = mergeRuntimePatch(next[key], value);
    else next[key] = value;
  }
  return next;
}

async function ensureCharacterSnapshot(characterId) {
  const existing = authorityStore.getSnapshot(characterId);
  if (existing) return existing;
  const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
  const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
  const character = authorityStore.getEntity("character", characterId)?.data || (data.characters || []).find((item) => clean(item.id || item.characterId) === characterId);
  if (!character) throw new AuthorityError("NOT_FOUND", `character ${characterId} was not found`, 404);
  const user = authorityStore.getEntity("userProfile", "me")?.data || character.userProfile || null;
  return authorityStore.transaction(() => {
    const event = authorityStore.appendEvent({ type: "character.snapshot.initialized", characterId, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { source: "action-runtime" } });
    return authorityStore.putSnapshot(characterId, { lastEventId: event.eventId, protocolVersion: PROTOCOL_VERSION, character, user, world: null, state: data.characterRuntime?.[characterId] || {}, recentMessages: runtime.messages.filter((item) => item.charId === characterId && isChatRuntimeMessage(item)).slice(-100) });
  });
}

async function buildCcContextPackage(characterId, { wakeRun = null, leaseToken = "", reason = "manual", recallLimit = 5, forceStable = false, sessionId = null } = {}) {
  const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
  const character = (data.characters || []).find((item) => clean(item.id || item.characterId) === characterId);
  if (!character) throw new AuthorityError("NOT_FOUND", `character ${characterId} was not found`, 404);
  const session = authorityStore.runtimeV2.getCcSession(characterId) || authorityStore.runtimeV2.putCcSession(characterId, { sessionId, status: "idle" });
  const userProfile = authorityStore.getEntity("userProfile", "me")?.data || character.userProfile || { name: "用户" };
  const roomPlatesContext = formatRoomPlatesContext((data.roomPlates || []).filter((item) => clean(item.charId || item.characterId) === characterId), clean(userProfile.name || "用户"));
  const snapshot = await ensureCharacterSnapshot(characterId);
  const contextCharacter = { ...character, vrState: { ...(character.vrState || {}), ...(snapshot.state?.vrState || {}) } };
  const scheduleRuntime = buildHubScheduleRuntimeContext(data, contextCharacter, snapshot, Date.now());
  const stable = buildContextParity({ character: contextCharacter, userProfile, messages: [], memoryPalaceContext: "", roomPlatesContext, runtimeStateContext: scheduleRuntime.text, now: Date.now(), modelConfig: data.modelConfig || {} });
  const stableContextHash = contentHash(stable.stableSystemPrompt), stableChanged = stableContextHash !== session.stableContextHash;
  const stableContextVersion = stableChanged ? session.stableContextVersion + 1 : session.stableContextVersion;
  const messages = runtimeV2Reader.listMessages({ charId: characterId, afterSourceSequence: session.lastSeenMessageSeq, limit: 500 });
  const toMessageSeq = messages.reduce((max, item) => Math.max(max, Number(item.id || 0)), session.lastSeenMessageSeq);
  const events = authorityStore.listEvents({ after: session.lastSeenEventId, limit: 500, characterId });
  const wakeJob = wakeRun?.jobId ? authorityStore.getScheduledJob(wakeRun.jobId) : null;
  const deliveryTargets = Array.isArray(wakeJob?.payload?.deliveryTargets)
    ? [...new Set(wakeJob.payload.deliveryTargets.map((value) => clean(value)).filter(Boolean))]
    : [];
  const query = clean([reason, ...messages.slice(-8).map((item) => item.content)].join("\n"));
  let recall = { items: [], memoryPalaceContext: "" };
  if (character.memoryPalaceEnabled && query) {
    const settings = { ...DEFAULT_SETTINGS, ...(await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS)) };
    recall = await recallHubData(settings, data, { charId: characterId, userName: clean(userProfile.name || "用户"), query, limit: Math.max(1, Math.min(5, Number(recallLimit) || 5)), candidateLimit: 30, persistState: true });
  }
  const context = {
    characterId,
    sessionId: sessionId || session.sessionId,
    wakeRunId: wakeRun?.wakeRunId || null,
    wakeReason: reason,
    wake: wakeRun ? { jobId: wakeRun.jobId || null, jobType: wakeJob?.jobType || null, deliveryTargets } : null,
    deliveryTargets,
    stableContextVersion,
    stableContextHash,
    stableContext: forceStable || stableChanged || !session.lastWakeAt ? stable.stableSystemPrompt : null,
    delta: { fromMessageSeq: session.lastSeenMessageSeq, toMessageSeq, messages, fromEventId: session.lastSeenEventId, toEventId: events.at(-1)?.eventId || session.lastSeenEventId, events },
    recall: { items: (recall.items || []).slice(0, 5), memoryPalaceContext: recall.memoryPalaceContext || "" },
    runtimeState: authorityStore.runtimeV2.getCharacterState(characterId)?.state || snapshot.state || {},
    unfinishedTasks: authorityStore.listScheduledJobs({ characterId, limit: 100 }).filter((job) => ["pending", "retry", "running"].includes(job.status)),
    generatedAt: new Date().toISOString(),
  };
  if (wakeRun) {
    authorityStore.transaction(() => {
      authorityStore.runtimeV2.attachCcWakeContext(wakeRun.wakeRunId, leaseToken, context, { fromMessageSeq: session.lastSeenMessageSeq, toMessageSeq, fromEventId: session.lastSeenEventId, toEventId: context.delta.toEventId, sessionId: context.sessionId });
      authorityStore.runtimeV2.putCcSession(characterId, { sessionId: context.sessionId, stableContextVersion, stableContextHash, lastWakeAt: new Date().toISOString(), status: "running" });
    });
  }
  return context;
}

function characterUnavailableUntil(snapshot, now = Date.now()) {
  const state = snapshot?.state || {};
  const candidates = [state.busyUntil, state.nextAvailableAt, state.activity?.busyUntil, state.schedule?.busyUntil]
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value) && value > now);
  if (candidates.length) return new Date(Math.min(...candidates)).toISOString();
  if (state.available === false || state.status === "busy") return new Date(now + 5 * 60 * 1000).toISOString();
  return null;
}

async function executeScheduledJob(job) {
  const snapshot = await ensureCharacterSnapshot(job.characterId);
  const unavailableUntil = characterUnavailableUntil(snapshot);
  if (unavailableUntil) {
    const deferred = authorityStore.transaction(() => {
      const result = authorityStore.deferScheduledJob(job.jobId, unavailableUntil, "character-busy");
      authorityStore.appendEvent({ commandId: job.commandId, type: "schedule.deferred", characterId: job.characterId, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { jobId: job.jobId, dueAt: unavailableUntil, reason: "character-busy" } });
      return result;
    });
    return { status: "deferred", job: deferred };
  }

  if (["brain.wake", "autonomy.wake", "computer.task"].includes(job.jobType)) {
    if (authorityStore.runtimeV2.authorityMode() !== "v2") {
      const dueAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const deferred = authorityStore.transaction(() => authorityStore.deferScheduledJob(job.jobId, dueAt, "v2-authority-required"));
      return { status: "deferred", reason: "v2-authority-required", job: deferred };
    }
    return authorityStore.transaction(() => {
      const session = authorityStore.runtimeV2.getCcSession(job.characterId) || authorityStore.runtimeV2.putCcSession(job.characterId, { status: "idle" });
      const created = authorityStore.runtimeV2.createCcWakeRun({ characterId: job.characterId, jobId: job.jobId, sessionId: session.sessionId, wakeReason: clean(job.payload?.reason || job.jobType) });
      const triggered = authorityStore.appendEvent({ commandId: job.commandId, type: "schedule.triggered", characterId: job.characterId, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { jobId: job.jobId, jobType: job.jobType } });
      const event = authorityStore.appendEvent({ commandId: job.commandId, type: "brain.wake.requested", characterId: job.characterId, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { wakeRunId: created.wakeRun.wakeRunId, jobId: job.jobId, jobType: job.jobType, reason: created.wakeRun.wakeReason, triggeredEventId: triggered.eventId } });
      const targets = Array.isArray(job.payload?.deliveryTargets) && job.payload.deliveryTargets.length ? job.payload.deliveryTargets : [`cc:${job.characterId}`];
      const deliveries = authorityStore.enqueueOutboxForEvent(event.eventId, targets).map((item) => item.deliveryId);
      const completed = authorityStore.completeScheduledJob(job.jobId);
      if (created.created) authorityStore.runtimeV2.bumpNativeMutationSequence();
      return { status: "wake-queued", job: completed, wakeRun: created.wakeRun, triggeredEventId: triggered.eventId, eventId: event.eventId, deliveries };
    });
  }

  const payload = job.payload || {};
  const statePatch = payload.statePatch || (job.jobType === "state.patch" ? payload.patch || {} : {});
  const messageSpec = payload.message || (job.jobType === "message.notify" ? { content: payload.content, role: payload.role } : null);
  const nativeAuthority = authorityStore.runtimeV2.authorityMode() === "v2";
  let recentMessages = (snapshot.recentMessages || []).filter((item) => isChatRuntimeMessage(item));
  let message = null;
  let nativeMessageSpec = null;
  if (clean(messageSpec?.content || "")) {
    if (nativeAuthority) {
      nativeMessageSpec = {
        messageId: clean(messageSpec.messageId || messageSpec.sourceId) || `${job.jobId}:message`,
        sourceMessageId: clean(messageSpec.sourceId) || `${job.jobId}:message`,
        characterId: job.characterId,
        role: clean(messageSpec.role || "assistant"),
        messageType: clean(messageSpec.type || "text"),
        content: clean(messageSpec.content),
        surface: clean(messageSpec.surface || "chat"),
        visibility: clean(messageSpec.visibility || "user"),
        origin: "scheduler",
        occurredAt: new Date(messageSpec.timestamp || job.dueAt).toISOString(),
        metadata: { ...(messageSpec.metadata || {}), jobId: job.jobId, authority: "memory-hub", proactive: true },
      };
    } else {
      const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
      const appended = appendRuntimeMessages(runtime, job.characterId, [{
        sourceId: clean(messageSpec.sourceId || "") || `${job.jobId}:message`,
        role: clean(messageSpec.role || "assistant"),
        type: clean(messageSpec.type || "text"),
        content: clean(messageSpec.content),
        timestamp: Number(messageSpec.timestamp || Date.now()),
        metadata: { ...(messageSpec.metadata || {}), jobId: job.jobId, authority: "memory-hub", proactive: true },
      }]);
      await writeJsonFile(RUNTIME_FILE, runtime);
      message = appended.appended[0] || appended.updated[0] || null;
      recentMessages = runtime.messages.filter((item) => item.charId === job.characterId && isChatRuntimeMessage(item)).slice(-100);
    }
  }

  const result = authorityStore.transaction(() => {
    const triggered = authorityStore.appendEvent({ commandId: job.commandId, type: "schedule.triggered", characterId: job.characterId, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { jobId: job.jobId, jobType: job.jobType } });
    let lastEvent = triggered;
    let deliveries = [];
    const nextState = mergeRuntimePatch(snapshot.state || {}, statePatch);
    let nativeMutated = false;
    if (nativeMessageSpec) {
      const committed = authorityStore.runtimeV2.commitMessage(nativeMessageSpec);
      message = committed.message;
      nativeMutated ||= committed.created;
      recentMessages = runtimeV2Reader.listRecentMessages({ charId: job.characterId, limit: 200 }).filter((item) => isChatRuntimeMessage(item)).slice(-100);
    }
    if (contentHash(nextState) !== contentHash(snapshot.state || {})) {
      let entityVersion = snapshot.snapshotVersion + 1;
      if (nativeAuthority) {
        const currentState = authorityStore.runtimeV2.getCharacterState(job.characterId);
        const savedState = authorityStore.runtimeV2.putCharacterState(job.characterId, nextState, { expectedVersion: currentState?.version || 0 });
        if (savedState.changed) authorityStore.runtimeV2.appendStateEvent(job.characterId, savedState.state.version, { patch: statePatch, source: "scheduled-job", jobId: job.jobId }, job.commandId);
        nativeMutated ||= savedState.changed;
        entityVersion = savedState.state.version;
      }
      lastEvent = authorityStore.appendEvent({ commandId: job.commandId, type: "character.state.updated", characterId: job.characterId, entityVersion, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { jobId: job.jobId, patch: statePatch } });
    }
    if (message) {
      lastEvent = authorityStore.appendEvent({ commandId: job.commandId, type: "message.proactive.created", characterId: job.characterId, occurredAt: new Date(message.occurredAt || message.timestamp).toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { jobId: job.jobId, message } });
      deliveries = authorityStore.enqueueOutboxForEvent(lastEvent.eventId, Array.isArray(payload.deliveryTargets) ? payload.deliveryTargets : []).map((item) => item.deliveryId);
    }
    const snapshotEvent = authorityStore.appendEvent({ commandId: job.commandId, type: "character.snapshot.updated", characterId: job.characterId, entityVersion: snapshot.snapshotVersion + 1, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { reason: "scheduled.action.completed", jobId: job.jobId, lastActionEventId: lastEvent.eventId } });
    const nextSnapshot = authorityStore.putSnapshot(job.characterId, { ...snapshot, lastEventId: snapshotEvent.eventId, state: nextState, recentMessages }, { expectedVersion: snapshot.snapshotVersion });
    const completed = authorityStore.completeScheduledJob(job.jobId);
    if (nativeMutated) authorityStore.runtimeV2.bumpNativeMutationSequence();
    return { status: "completed", job: completed, snapshot: nextSnapshot, message, eventId: snapshotEvent.eventId, deliveries };
  });
  if (nativeAuthority) {
    runtimeDataCache = loadMessageRuntime();
    hubDataCache = materializeHubState(loadHubRuntimeDomains());
  }
  return result;
}

let actionRuntimeRunning = false;
async function runActionRuntimeTick({ limit = 20 } = {}) {
  if (actionRuntimeRunning) return { skipped: true, reason: "tick-already-running", claimed: 0, results: [] };
  actionRuntimeRunning = true;
  const results = [];
  try {
    const jobs = authorityStore.transaction(() => authorityStore.claimDueJobs({ limit }));
    for (const job of jobs) {
      try { results.push({ jobId: job.jobId, ...(await executeScheduledJob(job)) }); }
      catch (error) {
        const failed = authorityStore.transaction(() => {
          authorityStore.appendEvent({ commandId: job.commandId, type: "schedule.failed", characterId: job.characterId, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { jobId: job.jobId, error: String(error?.message || error) } });
          return authorityStore.failScheduledJob(job.jobId, error?.message || error);
        });
        results.push({ jobId: job.jobId, status: failed.status, error: failed.lastError });
      }
    }
    return { skipped: false, claimed: jobs.length, results };
  } finally {
    actionRuntimeRunning = false;
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (!isPublicApi(pathname) && !authorized(req)) {
    return send(req, res, 401, {
      ok: false,
      error: "Unauthorized",
      hint: "Set X-Memory-Hub-Token or Authorization: Bearer <MEMORY_HUB_TOKEN>.",
    });
  }

  if (pathname === "/api/health") {
    return send(req, res, 200, {
      ok: true,
      service: "memory-hub",
      host: HOST,
      port: PORT,
      publicUrl: PUBLIC_BASE_URL,
      dataDir: DATA_DIR,
      authRequired: Boolean(HUB_TOKEN),
      protocolVersion: PROTOCOL_VERSION,
      runtimeRead: runtimeReadMode.publicStatus(),
      runtimeNativeWritesEnabled: RUNTIME_NATIVE_WRITES_ENABLED,
    });
  }

  if (pathname === "/api/contracts" && req.method === "GET") {
    return send(req, res, 200, {
      ok: true,
      contract: contractManifest,
      runtime: {
        mode: "independent-character-runtime",
        authority: "memory-hub",
        persistence: "authority.sqlite runtime domains",
        commandBus: "implemented",
        eventLog: "implemented",
        snapshots: "implemented",
        realtimeTransport: "planned",
      },
      capabilities: {
        implemented: [
          "memory.runtime.v1",
          "memory.recall.v1",
          "sullyos.import.v1",
          "contract.discovery.v1",
          "contract.validation.v1",
          "character.authority.v1",
          "user-profile.authority.v1",
          "world.authority.v1",
          "worldbook.authority.v1",
          "worldbook.mounts.v1",
          "sullyos.full-migration.v1",
          "authority.audit.v1",
          "context.parity.preview.v1",
          "context.assemble.v1",
          "unified-state.sqlite.v1",
          "independent-runtime.v1",
          "command-bus.v1",
          "event-stream.v1",
          "snapshot.v1",
          "chat-turn-execution.v1",
          "sullyos-chat-compat.v1",
          "character-state-reducer.v1",
          "scheduled-action-runtime.v1",
          "outbox-delivery.v1"
        ],
        planned: ["model-generated-proactive-actions.v1"]
      }
    });
  }

  if (pathname.startsWith("/api/contracts/schemas/") && req.method === "GET") {
    const name = decodeURIComponent(pathname.slice("/api/contracts/schemas/".length));
    const schema = contractSchemas[name];
    if (!schema) return send(req, res, 404, { ok: false, code: "NOT_FOUND", error: `Unknown contract schema: ${name}` });
    return send(req, res, 200, { ok: true, name, packageVersion: CONTRACT_PACKAGE_VERSION, protocolVersion: PROTOCOL_VERSION, schema });
  }

  if (pathname === "/api/contracts/validate" && req.method === "POST") {
    const body = await readBody(req);
    const protocolVersion = clean(body.protocolVersion || PROTOCOL_VERSION);
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      return send(req, res, 400, {
        ok: false,
        code: "PROTOCOL_VERSION_UNSUPPORTED",
        error: `Unsupported protocol version: ${protocolVersion}`,
        supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      });
    }
    const result = validateContract(clean(body.schema), body.data);
    return send(req, res, result.ok ? 200 : 400, {
      ...result,
      schema: clean(body.schema),
      protocolVersion,
      ...(result.ok ? {} : { code: "VALIDATION_FAILED", error: "Contract validation failed" }),
    });
  }

  if (pathname === "/api/v1/compat/sully" && req.method === "GET") {
    return send(req, res, 200, sullyCompatibilityDescriptor());
  }

  if (pathname === "/api/v1/compat/sully/chat/preview" && req.method === "POST") {
    const adapted = normalizeSullyChatTurnRequest(await readBody(req));
    return send(req, res, 200, { ok: true, ...adapted });
  }

  if (pathname === "/api/v1/cc/context" && req.method === "POST") {
    if (authorityStore.runtimeV2.authorityMode() !== "v2") throw new AuthorityError("V2_AUTHORITY_NOT_PROMOTED", "CC context requires V2 authority", 409);
    const body = await readBody(req), characterId = clean(body.characterId || body.charId);
    return send(req, res, 200, { ok: true, context: await buildCcContextPackage(characterId, { reason: clean(body.reason || "manual"), recallLimit: body.recallLimit, forceStable: body.forceStable === true, sessionId: clean(body.sessionId) || null }) });
  }

  if (pathname === "/api/v1/cc/wakes/claim" && req.method === "POST") {
    if (authorityStore.runtimeV2.authorityMode() !== "v2") throw new AuthorityError("V2_AUTHORITY_NOT_PROMOTED", "CC wake claims require V2 authority", 409);
    const body = await readBody(req);
    const wakeRun = authorityStore.transaction(() => authorityStore.runtimeV2.claimCcWakeRun({ characterId: clean(body.characterId || body.charId), leaseMs: body.leaseMs }));
    if (!wakeRun) return send(req, res, 200, { ok: true, wakeRun: null, context: null });
    // Reclaimed/retried wakes reuse the exact first claim context. This keeps the
    // stable personality block and cursor boundary intact across runner crashes.
    const context = wakeRun.context || await buildCcContextPackage(wakeRun.characterId, { wakeRun, leaseToken: wakeRun.leaseToken, reason: wakeRun.wakeReason, recallLimit: body.recallLimit, forceStable: body.forceStable === true, sessionId: clean(body.sessionId || wakeRun.sessionId) || null });
    return send(req, res, 200, { ok: true, wakeRun: authorityStore.runtimeV2.getCcWakeRun(wakeRun.wakeRunId), context });
  }

  const ccWakeFailMatch = pathname.match(/^\/api\/v1\/cc\/wakes\/([^/]+)\/fail$/);
  if (ccWakeFailMatch && req.method === "POST") {
    const body = await readBody(req), wakeRunId = decodeURIComponent(ccWakeFailMatch[1]);
    const wakeRun = authorityStore.transaction(() => {
      const updated = body.retry === true
        ? authorityStore.runtimeV2.retryCcWakeRun(wakeRunId, clean(body.leaseToken), clean(body.error || "CC wake will be retried"))
        : authorityStore.runtimeV2.completeCcWakeRun(wakeRunId, clean(body.leaseToken), { error: clean(body.error || "CC wake failed") });
      authorityStore.runtimeV2.putCcSession(updated.characterId, { status: "idle" });
      return updated;
    });
    return send(req, res, 200, { ok: true, wakeRun });
  }

  if ((pathname === "/api/v1/scheduled-jobs" || pathname === "/v1/scheduled-jobs") && req.method === "POST") {
    const body = await readBody(req);
    const characterId = clean(body.characterId || body.charId || "");
    await ensureCharacterSnapshot(characterId);
    const outcome = authorityStore.transaction(() => {
      const created = authorityStore.createScheduledJob({ ...body, characterId });
      if (created.created) authorityStore.appendEvent({ commandId: created.job.commandId, type: "schedule.created", characterId, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { jobId: created.job.jobId, jobType: created.job.jobType, dueAt: created.job.dueAt } });
      return created;
    });
    return send(req, res, outcome.created ? 201 : 200, { ok: true, idempotentReplay: !outcome.created, ...outcome });
  }

  if ((pathname === "/api/v1/scheduled-jobs" || pathname === "/v1/scheduled-jobs") && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const jobs = authorityStore.listScheduledJobs({ characterId: clean(url.searchParams.get("characterId") || ""), status: clean(url.searchParams.get("status") || ""), limit: url.searchParams.get("limit") || 200 });
    return send(req, res, 200, { ok: true, jobs });
  }

  const scheduledJobMatch = pathname.match(/^\/(?:api\/)?v1\/scheduled-jobs\/([^/]+)$/);
  if (scheduledJobMatch && req.method === "GET") {
    const job = authorityStore.getScheduledJob(decodeURIComponent(scheduledJobMatch[1]));
    if (!job) throw new AuthorityError("NOT_FOUND", "scheduled job was not found", 404);
    return send(req, res, 200, { ok: true, job });
  }
  if (scheduledJobMatch && req.method === "DELETE") {
    const job = authorityStore.transaction(() => {
      const cancelled = authorityStore.cancelScheduledJob(decodeURIComponent(scheduledJobMatch[1]));
      authorityStore.appendEvent({ commandId: cancelled.commandId, type: "schedule.cancelled", characterId: cancelled.characterId, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { jobId: cancelled.jobId } });
      return cancelled;
    });
    return send(req, res, 200, { ok: true, job });
  }

  if ((pathname === "/api/v1/runtime/tick" || pathname === "/v1/runtime/tick") && req.method === "POST") {
    const body = await readBody(req);
    return send(req, res, 200, { ok: true, ...(await runActionRuntimeTick({ limit: body.limit || 20 })) });
  }

  if ((pathname === "/api/v1/outbox" || pathname === "/v1/outbox") && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const clientId = clean(url.searchParams.get("clientId") || "");
    if (!clientId) throw new AuthorityError("VALIDATION_FAILED", "clientId is required", 400);
    const deliveries = authorityStore.transaction(() => authorityStore.claimOutboxDeliveries(clientId, { after: url.searchParams.get("after") || 0, limit: url.searchParams.get("limit") || 100 }));
    return send(req, res, 200, { ok: true, clientId, deliveries });
  }

  const outboxActionMatch = pathname.match(/^\/(?:api\/)?v1\/outbox\/([^/]+)\/(ack|retry)$/);
  if (outboxActionMatch && req.method === "POST") {
    const body = await readBody(req);
    const deliveryId = decodeURIComponent(outboxActionMatch[1]);
    const action = outboxActionMatch[2];
    const clientId = clean(body.clientId || "");
    if (!clientId) throw new AuthorityError("VALIDATION_FAILED", "clientId is required", 400);
    const delivery = authorityStore.transaction(() => action === "ack"
      ? authorityStore.acknowledgeOutboxDelivery(clientId, deliveryId)
      : authorityStore.retryOutboxDelivery(clientId, deliveryId, body.error));
    return send(req, res, 200, { ok: true, delivery });
  }

  if ((pathname === "/api/v1/commands" || pathname === "/v1/commands") && req.method === "POST") {
    const command = normalizeHubCommand(await readBody(req));
    requireValidContract("command", command);
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(command.protocolVersion)) throw new AuthorityError("PROTOCOL_VERSION_UNSUPPORTED", `Unsupported protocol version: ${command.protocolVersion}`, 400);
    const outcome = authorityStore.transaction(() => {
      const created = authorityStore.createCommand(command);
      if (!created.created) return { created: false, command: created.command, events: authorityStore.listEvents({ after: 0, limit: 1000 }).filter((event) => event.commandId === command.commandId) };
      const event = authorityStore.appendEvent({ commandId: command.commandId, type: "command.accepted", characterId: command.characterId, worldId: command.worldId, occurredAt: new Date().toISOString(), protocolVersion: command.protocolVersion, payload: { commandType: command.type, actorId: command.actorId } });
      return { created: true, command: created.command, events: [event] };
    });
    return send(req, res, outcome.created ? 202 : 200, { ok: true, idempotentReplay: !outcome.created, ...outcome });
  }

  if ((pathname === "/api/v1/runtime/commands" || pathname === "/v1/runtime/commands") && req.method === "POST") {
    if (!RUNTIME_NATIVE_WRITES_ENABLED) throw new AuthorityError("V2_NATIVE_WRITE_DISABLED", "V2 native writes are disabled; set MEMORY_HUB_RUNTIME_NATIVE_WRITES_ENABLED=true only after V2 read promotion", 409);
    if (authorityStore.runtimeV2.authorityMode() !== "v2") throw new AuthorityError("V2_AUTHORITY_NOT_PROMOTED", "V2 native writes require a persisted V2 authority promotion", 409, { authorityMode: authorityStore.runtimeV2.authorityMode() });
    if (!useV2RuntimeReads()) throw new AuthorityError("V2_NATIVE_READ_REQUIRED", "V2 native writes require an effective V2 runtime read mode", 409, runtimeReadMode.publicStatus());
    const command = normalizeHubCommand(await readBody(req));
    requireValidContract("command", command);
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(command.protocolVersion)) throw new AuthorityError("PROTOCOL_VERSION_UNSUPPORTED", `Unsupported protocol version: ${command.protocolVersion}`, 400);
    const outcome = runtimeNativeCommands.execute(command);
    if (!outcome.idempotentReplay && ["runtime.message.commit", "runtime.activity.commit"].includes(command.type)) runtimeDataCache = loadMessageRuntime();
    if (!outcome.idempotentReplay && /^(?:memory\.(?:node|vector|link|event_box|room_plate|digest)|runtime\.(?:anticipation|activity)|character\.state)\./.test(command.type)) hubDataCache = materializeHubState(loadHubRuntimeDomains());
    return send(req, res, outcome.idempotentReplay ? 200 : 201, { ok: true, ...outcome });
  }

  if ((pathname === "/api/runtime/v2/promotion" || pathname === "/api/v1/runtime/promotion") && req.method === "GET") {
    return send(req, res, 200, { ok: true, ...runtimeV2Promotion.status(), readMode: runtimeReadMode.publicStatus(), nativeWritesEnabled: RUNTIME_NATIVE_WRITES_ENABLED });
  }

  if ((pathname === "/api/runtime/v2/promotion/prepare" || pathname === "/api/v1/runtime/promotion/prepare") && req.method === "POST") {
    if (!useV2RuntimeReads()) throw new AuthorityError("V2_PROMOTION_READ_MODE_REQUIRED", "Promotion preparation requires a healthy effective V2 read mode", 409, runtimeReadMode.publicStatus());
    const body = await readBody(req);
    const promotion = runtimeV2Promotion.prepare({ actorId: clean(body.actorId || "operator") });
    return send(req, res, 201, { ok: true, promotion });
  }

  if ((pathname === "/api/runtime/v2/promotion/commit" || pathname === "/api/v1/runtime/promotion/commit") && req.method === "POST") {
    if (!useV2RuntimeReads()) throw new AuthorityError("V2_PROMOTION_READ_MODE_REQUIRED", "Promotion commit requires a healthy effective V2 read mode", 409, runtimeReadMode.publicStatus());
    const body = await readBody(req);
    const status = runtimeV2Promotion.commit(clean(body.promotionId), clean(body.parityHash), { actorId: clean(body.actorId || "operator") });
    return send(req, res, 200, { ok: true, ...status, readMode: runtimeReadMode.publicStatus() });
  }

  if ((pathname === "/api/runtime/v2/promotion/rollback" || pathname === "/api/v1/runtime/promotion/rollback") && req.method === "POST") {
    const body = await readBody(req);
    const status = runtimeV2Promotion.rollback({ actorId: clean(body.actorId || "operator"), reason: clean(body.reason || "operator rollback") });
    runtimeReadMode.initialize();
    return send(req, res, 200, { ok: true, ...status, readMode: runtimeReadMode.publicStatus() });
  }

  if ((pathname === "/api/v1/chat/turns" || pathname === "/v1/chat/turns" || pathname === "/api/v1/compat/sully/chat/turns") && req.method === "POST") {
    const rawBody = await readBody(req);
    const adapted = pathname === "/api/v1/compat/sully/chat/turns" ? normalizeSullyChatTurnRequest(rawBody) : null;
    const body = adapted?.request || rawBody;
    const characterId = clean(body.characterId || body.charId || "");
    const content = clean(body.message?.content || body.content || body.text || "");
    if (!characterId || !content) throw new AuthorityError("VALIDATION_FAILED", "characterId and message content are required", 400);
    const command = normalizeHubCommand(body.command || body, { type: "chat.turn.submit", characterId, actorId: body.actorId || "sullyos-client", payload: { content, message: body.message || null } });
    command.type = "chat.turn.submit";
    command.characterId = characterId;
    command.payload = { ...(command.payload || {}), content, message: body.message || null };
    requireValidContract("command", command);

    const admitted = authorityStore.transaction(() => {
      const created = authorityStore.createCommand(command);
      if (created.created) authorityStore.appendEvent({ commandId: command.commandId, type: "command.accepted", characterId, occurredAt: new Date().toISOString(), protocolVersion: command.protocolVersion, payload: { commandType: command.type, actorId: command.actorId } });
      return created;
    });
    if (!admitted.created && admitted.command.status === "completed") return send(req, res, 200, { ok: true, idempotentReplay: true, ...(adapted ? { compatibility: adapted.compatibility } : {}), command: admitted.command, ...(admitted.command.result || {}) });
    if (!admitted.created && admitted.command.status === "failed") return send(req, res, 409, { ok: false, idempotentReplay: true, ...(adapted ? { compatibility: adapted.compatibility } : {}), command: admitted.command, error: admitted.command.error });
    const started = authorityStore.startCommand(command.commandId);
    if (!started.started) throw new AuthorityError("COMMAND_IN_PROGRESS", "Command is already being processed", 409, { commandId: command.commandId, status: started.command?.status });

    try {
      const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
      const character = (data.characters || []).find((item) => clean(item.id || item.characterId) === characterId);
      if (!character) throw new AuthorityError("NOT_FOUND", `character ${characterId} was not found`, 404);
      const admittedSnapshot = authorityStore.getSnapshot(characterId);
      if (command.expectedVersion !== undefined && Number(command.expectedVersion) !== Number(admittedSnapshot?.snapshotVersion || 0)) {
        throw new AuthorityError("VERSION_CONFLICT", "Character snapshot version conflict", 409, { currentVersion: admittedSnapshot?.snapshotVersion || 0 });
      }
      const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
      const conversationId = clean(body.conversationId || body.message?.conversationId || `direct:me:${characterId}`);
      const userAppend = appendRuntimeMessages(runtime, characterId, [{ ...(body.message || {}), sourceId: clean(body.message?.sourceId || "") || `${command.commandId}:user`, role: "user", content, timestamp: Number(body.message?.timestamp || body.now || Date.now()), surface: "chat", visibility: "user", conversationId, origin: "user", metadata: { ...(body.message?.metadata || {}), commandId: command.commandId, authority: "memory-hub" } }]);
      await writeJsonFile(RUNTIME_FILE, runtime);
      const userMessage = userAppend.appended[0] || userAppend.updated[0];
      const userEvent = authorityStore.appendEvent({ commandId: command.commandId, type: "message.user.created", characterId, occurredAt: new Date(userMessage.timestamp).toISOString(), protocolVersion: command.protocolVersion, payload: { message: userMessage } });

      const assembled = await requestAssembledContext(characterId, body);
      const settings = { ...DEFAULT_SETTINGS, ...(await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS)) };
      const config = resolveChatTurnConfig(body, data, settings);
      if (!config.baseUrl || !config.model) throw new AuthorityError("MODEL_CONFIG_MISSING", "Hub chat model baseUrl and model are required", 400);
      const completion = await callMemoryPalaceLLM(config, assembled.finalMessages, { temperature: body.temperature, maxTokens: body.maxTokens || body.max_tokens, timeoutMs: body.timeoutMs || 180000 });
      const assistantContent = clean(completion.reply || "");
      if (!assistantContent) throw new AuthorityError("MODEL_EMPTY_RESPONSE", "Chat model returned an empty response", 502);

      const freshRuntime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
      const assistantAppend = appendRuntimeMessages(freshRuntime, characterId, [{ sourceId: `${command.commandId}:assistant`, role: "assistant", content: assistantContent, timestamp: Date.now(), surface: "chat", visibility: "user", conversationId, origin: "character", metadata: { commandId: command.commandId, authority: "memory-hub", model: config.model } }]);
      await writeJsonFile(RUNTIME_FILE, freshRuntime);
      const assistantMessage = assistantAppend.appended[0] || assistantAppend.updated[0];
      let snapshot;
      const emitted = authorityStore.transaction(() => {
        const assistantEvent = authorityStore.appendEvent({ commandId: command.commandId, type: "message.assistant.created", characterId, occurredAt: new Date(assistantMessage.timestamp).toISOString(), protocolVersion: command.protocolVersion, payload: { message: assistantMessage, model: config.model } });
        const previous = authorityStore.getSnapshot(characterId);
        const snapshotEvent = authorityStore.appendEvent({ commandId: command.commandId, type: "character.snapshot.updated", characterId, entityVersion: Number(previous?.snapshotVersion || 0) + 1, occurredAt: new Date().toISOString(), protocolVersion: command.protocolVersion, payload: { reason: "chat.turn.completed", assistantEventId: assistantEvent.eventId } });
        snapshot = authorityStore.putSnapshot(characterId, { lastEventId: snapshotEvent.eventId, protocolVersion: command.protocolVersion, character, user: authorityStore.getEntity("userProfile", clean(body.userId || "me"))?.data || character.userProfile || null, world: previous?.world || null, state: previous?.state || data.characterRuntime?.[characterId] || {}, recentMessages: freshRuntime.messages.filter((item) => item.charId === characterId && isChatRuntimeMessage(item)).slice(-100) }, { expectedVersion: command.expectedVersion ?? previous?.snapshotVersion ?? 0 });
        const result = { commandId: command.commandId, userEventId: userEvent.eventId, assistantEventId: assistantEvent.eventId, snapshotEventId: snapshotEvent.eventId, assistantMessage, snapshot, context: body.includeContext ? assembled : undefined };
        authorityStore.finishCommand(command.commandId, { status: "completed", result });
        return { assistantEvent, snapshotEvent, result };
      });
      return send(req, res, 201, { ok: true, idempotentReplay: false, ...(adapted ? { compatibility: adapted.compatibility } : {}), command: authorityStore.getCommand(command.commandId), ...emitted.result });
    } catch (error) {
      const normalized = error instanceof AuthorityError ? error : new AuthorityError("CHAT_TURN_FAILED", String(error?.message || error), 502);
      authorityStore.transaction(() => {
        authorityStore.appendEvent({ commandId: command.commandId, type: "command.failed", characterId, occurredAt: new Date().toISOString(), protocolVersion: command.protocolVersion, payload: { code: normalized.code, error: normalized.message } });
        authorityStore.finishCommand(command.commandId, { status: "failed", error: { code: normalized.code, message: normalized.message, details: normalized.details } });
      });
      throw normalized;
    }
  }

  if ((pathname === "/api/v1/events" || pathname === "/v1/events") && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const after = Math.max(0, Number(url.searchParams.get("after") || 0) || 0);
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 200) || 200));
    const characterId = clean(url.searchParams.get("characterId") || "");
    const clientId = clean(url.searchParams.get("clientId") || "");
    const requestedSurface = normalizeRuntimeSurface(url.searchParams.get("surface") || "");
    const requestedVisibility = clean(url.searchParams.get("visibility") || "").toLowerCase();
    const candidates = authorityStore.listEvents({ after, limit: requestedSurface || requestedVisibility ? 1000 : limit, characterId }).map(decorateHubEvent);
    const events = candidates.filter((event) => (!requestedSurface || event.surface === requestedSurface) && (!requestedVisibility || event.visibility === requestedVisibility)).slice(0, limit);
    const lastEventId = events.at(-1)?.eventId || after;
    const cursor = clientId ? authorityStore.advanceClientCursor(clientId, lastEventId) : null;
    const surfaceCounts = Object.fromEntries([...RUNTIME_SURFACES].map((surface) => [surface, candidates.filter((event) => event.surface === surface).length]));
    return send(req, res, 200, { ok: true, after, lastEventId, hasMore: events.length === limit, surface: requestedSurface || null, visibility: requestedVisibility || null, surfaceCounts, events, cursor: cursor ? { clientId: cursor.client_id, lastEventId: Number(cursor.last_event_id), updatedAt: cursor.updated_at } : null });
  }

  const snapshotMatch = pathname.match(/^\/(?:api\/)?v1\/characters\/([^/]+)\/snapshot$/);
  if (snapshotMatch && req.method === "GET") {
    const characterId = decodeURIComponent(snapshotMatch[1]);
    let snapshot = authorityStore.getSnapshot(characterId);
    if (!snapshot) {
      const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
      const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
      const character = (data.characters || []).find((item) => clean(item.id || item.characterId) === characterId);
      if (!character) throw new AuthorityError("NOT_FOUND", `character ${characterId} was not found`, 404);
      const user = authorityStore.getEntity("userProfile", "me")?.data || character.userProfile || null;
      const recentMessages = runtime.messages.filter((item) => item.charId === characterId && isChatRuntimeMessage(item)).slice(-100);
      snapshot = authorityStore.transaction(() => {
        const event = authorityStore.appendEvent({ type: "character.snapshot.initialized", characterId, occurredAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, payload: { source: "runtime" } });
        return authorityStore.putSnapshot(characterId, { lastEventId: event.eventId, protocolVersion: PROTOCOL_VERSION, character, user, world: null, state: data.characterRuntime?.[characterId] || {}, recentMessages });
      });
    }
    snapshot = { ...snapshot, recentMessages: (snapshot.recentMessages || []).filter((item) => isChatRuntimeMessage(item)) };
    requireValidContract("snapshot", snapshot);
    return send(req, res, 200, { ok: true, snapshot });
  }

  if (pathname === "/api/v1/context/preview" && req.method === "POST") {
    const body = await readBody(req);
    const input = { ...(body.fixture || body) };
    if (body.recallQuery && body.memoryState) {
      const settings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
      const recalled = await recallHubData(settings, normalizeData(body.memoryState), {
        query: clean(body.recallQuery),
        charId: clean(input.character?.id || input.character?.characterId || body.charId),
        userName: clean(input.userProfile?.name || "用户"),
        limit: body.recallLimit || 15,
        candidateLimit: body.candidateLimit || 50,
        eventBoxMode: clean(body.eventBoxMode || settings.recallEventBoxMode || "compat"),
        now: body.now ?? input.now,
      });
      input.memoryPalaceContext = recalled.memoryPalaceContext || "";
      input.roomPlatesContext = recalled.roomPlatesContext || input.roomPlatesContext || "";
      input.recallResult = {
        mode: recalled.mode,
        items: recalled.items || [],
        candidates: recalled.trace?.candidates || [],
        memoryPalaceContext: recalled.memoryPalaceContext || "",
      };
      input.stateChanges = recalled.stateChanges || [];
    }
    return send(req, res, 200, { ok: true, promptSource: "SullyOS utils/context.ts:107 + utils/worldbook.ts", ...buildContextParity(input) });
  }

  if (pathname === "/api/v1/context/assemble" && req.method === "POST") {
    const body = await readBody(req);
    const characterId = clean(body.characterId || body.charId || "");
    if (!characterId) throw new AuthorityError("VALIDATION_FAILED", "characterId is required", 400);
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
    const character = (data.characters || []).find((item) => clean(item.id || item.characterId) === characterId);
    if (!character) throw new AuthorityError("NOT_FOUND", `character ${characterId} was not found`, 404);
    const userRecord = authorityStore.getEntity("userProfile", clean(body.userId || "me"));
    const userProfile = userRecord?.data || character.userProfile || { name: clean(body.userName || "用户"), bio: clean(body.userBio || "") };
    const runtimeSnapshot = authorityStore.getSnapshot(characterId);
    const contextCharacter = {
      ...character,
      vrState: { ...(character.vrState || {}), ...(runtimeSnapshot?.state?.vrState || {}) },
    };
    const historyLimit = Math.max(1, Math.min(1000, Number(body.historyLimit || character.contextLimit || 100) || 100));
    const conversationId = clean(body.conversationId || `direct:me:${characterId}`);
    const messages = runtime.messages
      .filter((item) => item.charId === characterId && (isChatRuntimeMessage(item, conversationId) || isVrCardRuntimeMessage(item)))
      .slice(-historyLimit)
      .map((item) => isVrCardRuntimeMessage(item)
        ? formatSullyVrCardMessage(item, contextCharacter)
        : { role: item.role, content: item.content ?? item.text ?? "", id: item.id, timestamp: item.timestamp });
    const query = clean(body.query || messages.slice(-12).map((item) => clean(item.content)).filter(Boolean).join("\n"));
    let recalled = { items: [], memoryPalaceContext: "", roomPlatesContext: "" };
    if (character.memoryPalaceEnabled && query) {
      const settings = { ...DEFAULT_SETTINGS, ...(await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS)) };
      recalled = await recallHubData(settings, data, {
        charId: characterId,
        userName: clean(userProfile.name || "用户"),
        query,
        limit: Math.max(1, Math.min(30, Number(body.recallLimit || 15) || 15)),
        candidateLimit: Math.max(10, Math.min(200, Number(body.candidateLimit || 50) || 50)),
        eventBoxMode: clean(body.eventBoxMode || settings.recallEventBoxMode || "compat"),
        eventBoxLiveLimit: Number(body.eventBoxLiveLimit || settings.recallEventBoxLiveLimit || 5),
        persistState: true,
        now: body.now,
      });
    }
    const roomPlatesContext = recalled.roomPlatesContext || formatRoomPlatesContext((data.roomPlates || []).filter((item) => item.charId === characterId), clean(userProfile.name || "用户"));
    const scheduleRuntime = buildHubScheduleRuntimeContext(data, contextCharacter, runtimeSnapshot, body.now ?? Date.now());
    const assembled = buildContextParity({
      character: contextCharacter,
      userProfile,
      messages,
      memoryPalaceContext: recalled.memoryPalaceContext || "",
      roomPlatesContext,
      recallResult: { mode: recalled.mode || "none", items: recalled.items || [], candidates: recalled.trace?.candidates || [], memoryPalaceContext: recalled.memoryPalaceContext || "" },
      stateChanges: recalled.stateChanges || [],
      runtimeStateContext: scheduleRuntime.text,
      now: body.now || Date.now(),
      lastInteractionTs: messages.length > 1 ? messages[messages.length - 2]?.timestamp : undefined,
      modelConfig: data.modelConfig || {},
    });
    const mountedWorldbooks = Array.isArray(character.mountedWorldbooks) ? character.mountedWorldbooks : [];
    const sourceBlocks = [
      { key: "character", title: "角色人设", source: "authority.sqlite · CharacterDefinition", editable: true, target: "characters", enabled: true, content: clean(character.systemPrompt || "") },
      { key: "worldview", title: "世界观", source: "authority.sqlite · CharacterDefinition.worldview", editable: true, target: "characters", enabled: Boolean(clean(character.worldview || "")), content: clean(character.worldview || "") },
      { key: "user", title: "User 档案", source: "authority.sqlite · UserIdentity", editable: true, target: "users", enabled: true, content: JSON.stringify(userProfile || {}, null, 2) },
      { key: "impression", title: "私人印象", source: "authority.sqlite · CharacterDefinition.impression", editable: true, target: "characters", enabled: Boolean(character.impression), content: character.impression ? JSON.stringify(character.impression, null, 2) : "" },
      { key: "legacy", title: "Legacy 月度记忆", source: "authority.sqlite · Character Runtime", editable: true, target: "coreMemories", enabled: Boolean(Object.keys(character.refinedMemories || {}).length || character.activeMemoryMonths?.length), content: JSON.stringify({ refinedMemories: character.refinedMemories || {}, activeMemoryMonths: character.activeMemoryMonths || [] }, null, 2) },
      { key: "roomPlates", title: "RoomPlate 底色认知", source: "authority.sqlite · runtime_domains", editable: true, target: "plates", enabled: Boolean(clean(roomPlatesContext)), content: roomPlatesContext || "" },
      { key: "recall", title: "Memory Palace Recall", source: "authority.sqlite · runtime memory", editable: false, target: "searchIndex", enabled: Boolean(clean(recalled.memoryPalaceContext || "")), content: recalled.memoryPalaceContext || "" },
      { key: "runtime", title: "角色运行状态", source: "authority.sqlite · Character Runtime + SullyOS scheduleInjection.ts", editable: false, target: "runtimeCenter", enabled: true, content: JSON.stringify({ emotion: character.emotion, buffs: character.buffs, anticipations: character.anticipations, location: runtimeSnapshot?.state?.location ?? character.location, activity: runtimeSnapshot?.state?.activity ?? character.activity, lastActivity: runtimeSnapshot?.state?.lastActivity, vrState: contextCharacter.vrState, scheduleStyle: character.scheduleStyle, scheduleInjection: scheduleRuntime.text }, null, 2) },
      { key: "worldbooks", title: "世界书", source: "authority.sqlite · Worldbook + mounts", editable: true, target: "worldbooks", enabled: mountedWorldbooks.length > 0, content: JSON.stringify({ mounted: mountedWorldbooks.map((book) => ({ id: book.worldbookId || book.id, title: book.title, position: book.position, order: book.order })), activated: assembled.activatedWorldbooks || [] }, null, 2) },
      { key: "chatPrompt", title: "Chat Prompt", source: assembled.chatPromptParts?.source || "SullyOS utils/chatPrompts.ts", editable: false, target: "", enabled: Boolean(assembled.chatPromptParts?.stableRules || assembled.chatPromptParts?.recencyTail), content: [assembled.chatPromptParts?.stableRules, assembled.chatPromptParts?.recencyTail].filter(Boolean).join("\n\n") },
    ];
    return send(req, res, 200, {
      ok: true,
      authority: "memory-hub",
      storage: "authority.sqlite",
      characterId,
      userId: userRecord?.entityId || clean(body.userId || "me"),
      promptSource: "Memory Hub ContextAssembler parity port",
      runtimeState: { schedule: scheduleRuntime.schedule, scheduleInjection: scheduleRuntime.text, wallNow: scheduleRuntime.wallNow.toISOString() },
      sourceBlocks,
      ...assembled,
    });
  }

  const authorityCollections = {
    characters: { type: "character", schema: "character", idField: "characterId" },
    users: { type: "userProfile", schema: "userProfile", idField: "userId" },
    worlds: { type: "world", schema: "world", idField: "worldId" },
    worldbooks: { type: "worldbook", schema: "worldbook", idField: "worldbookId" },
  };
  const authorityMatch = pathname.match(/^\/api\/v1\/(characters|users|worlds|worldbooks)(?:\/([^/]+))?$/);
  if (authorityMatch) {
    const collection = authorityMatch[1];
    const config = authorityCollections[collection];
    const id = authorityMatch[2] ? decodeURIComponent(authorityMatch[2]) : "";
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const present = (record) => record ? {
      ...record.data,
      [config.idField]: record.entityId,
      version: record.version,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
      sourceAuthority: record.sourceAuthority,
      _hash: record.hash,
      _fieldVersions: authorityStore.fieldVersions(config.type, record.entityId),
    } : null;
    const validate = (data, version) => {
      const candidate = { ...data, [config.idField]: clean(data?.[config.idField] || data?.id || id), version, updatedAt: new Date().toISOString() };
      const result = validateContract(config.schema, candidate);
      if (!result.ok) throw new AuthorityError("VALIDATION_FAILED", `${config.schema} contract validation failed`, 400, { errors: result.errors });
      return candidate;
    };

    if (!id && req.method === "GET") {
      const items = authorityStore.listEntities(config.type, { includeDeleted: url.searchParams.get("includeDeleted") === "1", limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") }).map(present);
      return send(req, res, 200, { ok: true, items, total: items.length });
    }
    if (!id && req.method === "POST") {
      const body = await readBody(req);
      const raw = body.data && typeof body.data === "object" ? body.data : body;
      const entityId = clean(raw[config.idField] || raw.id);
      if (!entityId) throw new AuthorityError("VALIDATION_FAILED", `${config.idField} is required`, 400);
      const current = authorityStore.getEntity(config.type, entityId, { includeDeleted: true });
      const data = validate(raw, Number(current?.version || 0) + 1);
      delete data.version; delete data.updatedAt; delete data.deletedAt; delete data._hash; delete data._fieldVersions;
      const record = authorityStore.transaction(() => authorityStore.putEntity(config.type, entityId, data, { expectedVersion: body.expectedVersion, actorId: clean(body.actorId || "api"), commandId: clean(body.commandId || "") || null, sourceAuthority: "hub" }));
      if (config.type === "character" || config.type === "worldbook") refreshHubDataCache();
      return send(req, res, current ? 200 : 201, { ok: true, item: present(record) });
    }
    if (!id) return send(req, res, 405, { ok: false, code: "VALIDATION_FAILED", error: "Method not allowed" });

    if (req.method === "GET") {
      const record = authorityStore.getEntity(config.type, id, { includeDeleted: url.searchParams.get("includeDeleted") === "1" });
      if (!record) throw new AuthorityError("NOT_FOUND", `${config.type} ${id} was not found`, 404);
      return send(req, res, 200, { ok: true, item: present(record) });
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      const body = await readBody(req);
      const raw = body.data && typeof body.data === "object" ? body.data : body;
      const current = authorityStore.getEntity(config.type, id);
      if (!current && req.method === "PATCH") throw new AuthorityError("NOT_FOUND", `${config.type} ${id} was not found`, 404);
      const metadataKeys = new Set(["expectedVersion", "actorId", "commandId", "unset", "protocolVersion"]);
      const cleanRaw = Object.fromEntries(Object.entries(raw).filter(([key]) => !metadataKeys.has(key)));
      const merged = req.method === "PATCH" ? { ...current.data, ...cleanRaw } : cleanRaw;
      for (const key of body.unset || []) delete merged[key];
      const data = validate(merged, Number(current?.version || 0) + 1);
      delete data.version; delete data.updatedAt; delete data.deletedAt; delete data._hash; delete data._fieldVersions;
      const record = authorityStore.transaction(() => authorityStore.putEntity(config.type, id, data, { expectedVersion: body.expectedVersion, actorId: clean(body.actorId || "api"), commandId: clean(body.commandId || "") || null, sourceAuthority: "hub", details: { unset: body.unset || [] } }));
      if (config.type === "character" || config.type === "worldbook") refreshHubDataCache();
      return send(req, res, current ? 200 : 201, { ok: true, item: present(record) });
    }
    if (req.method === "DELETE") {
      const body = await readBody(req);
      const record = authorityStore.transaction(() => authorityStore.deleteEntity(config.type, id, { expectedVersion: body.expectedVersion, actorId: clean(body.actorId || "api"), commandId: clean(body.commandId || "") || null }));
      if (config.type === "character" || config.type === "worldbook") refreshHubDataCache();
      return send(req, res, 200, { ok: true, tombstone: present(record) });
    }
  }

  const mountMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)\/worldbooks(?:\/([^/]+))?$/);
  if (mountMatch) {
    const characterId = decodeURIComponent(mountMatch[1]);
    const worldbookId = mountMatch[2] ? decodeURIComponent(mountMatch[2]) : "";
    if (!worldbookId && req.method === "GET") return send(req, res, 200, { ok: true, items: authorityStore.listMounts(characterId, { includeDeleted: new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).searchParams.get("includeDeleted") === "1" }) });
    if (!worldbookId) throw new AuthorityError("VALIDATION_FAILED", "worldbookId is required", 400);
    const body = req.method === "POST" || req.method === "DELETE" ? await readBody(req) : {};
    if (req.method === "POST") {
      const item = authorityStore.transaction(() => authorityStore.mountWorldbook(characterId, worldbookId, { expectedVersion: body.expectedVersion, actorId: clean(body.actorId || "api"), commandId: clean(body.commandId || "") || null }));
      refreshHubDataCache();
      return send(req, res, 200, { ok: true, item });
    }
    if (req.method === "DELETE") {
      const tombstone = authorityStore.transaction(() => authorityStore.unmountWorldbook(characterId, worldbookId, { expectedVersion: body.expectedVersion, actorId: clean(body.actorId || "api"), commandId: clean(body.commandId || "") || null }));
      refreshHubDataCache();
      return send(req, res, 200, { ok: true, tombstone });
    }
  }

  if (pathname === "/api/v1/authority/stats" && req.method === "GET") return send(req, res, 200, { ok: true, ...authorityStore.stats() });
  if (pathname === "/api/v1/audit" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    return send(req, res, 200, { ok: true, items: authorityStore.listAudit({ type: clean(url.searchParams.get("type") || ""), id: clean(url.searchParams.get("id") || ""), limit: url.searchParams.get("limit") }) });
  }
  if (pathname === "/api/v1/migrations/sully/preview" && req.method === "POST") {
    const body = await readBody(req);
    const source = body.backup || body.data || body;
    return send(req, res, 200, { ok: true, mode: "preview", report: authorityStore.analyzeMigration(source), sourceHash: contentHash(source) });
  }
  if (pathname === "/api/v1/migrations/sully/import" && req.method === "POST") {
    const body = await readBody(req);
    const source = body.backup || body.data || body;
    const report = authorityStore.importSullyBackup(source, { actorId: clean(body.actorId || "sullyos-migration"), mode: clean(body.mode || "import") });
    const current = await readJsonFile(DATA_FILE, EMPTY_DATA, { allowCorruptFallback: true });
    const unified = mergeSullyIntoHub(current, source);
    const incomingCharacterIds = new Set((source.characters || []).map((item) => clean(item?.characterId || item?.charId || item?.id || "")).filter(Boolean));
    const currentCharacters = new Map((current.characters || []).map((item) => [clean(item?.characterId || item?.id || ""), item]));
    unified.characters = (unified.characters || []).map((item) => {
      const id = clean(item?.characterId || item?.id || "");
      return !incomingCharacterIds.has(id) && currentCharacters.has(id) ? currentCharacters.get(id) : item;
    });
    const archived = authorityStore.migrationObjectsByDomain();
    for (const [domain, key] of Object.entries(MIGRATION_RUNTIME_FALLBACKS)) {
      const items = archived[domain] || [];
      if (!items.length) continue;
      unified[key] = domain.endsWith("_state") || domain === "realtime_config" ? items[0] : items;
    }
    const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
    if ((archived.message || []).length) runtime.messages = archived.message;
    runtime.nextMessageSeq = runtime.messages.reduce((max, item) => Math.max(max, Number(item?.id || 0) + 1), Math.max(Number(runtime.nextMessageSeq || 1), runtime.messages.length + 1));
    authorityStore.transaction(() => {
      persistHubRuntimeDomains(canonicalizeHubState(unified, "sullyos-migration"));
      persistMessageRuntime(runtime);
      authorityStore.clearMigrationObjects({ actorId: "sullyos-migration" });
    });
    hubDataCache = materializeHubState(loadHubRuntimeDomains());
    runtimeDataCache = loadMessageRuntime();
    return send(req, res, 201, { ok: true, report });
  }
  if (pathname === "/api/v1/migrations" && req.method === "GET") return send(req, res, 200, { ok: true, items: authorityStore.listMigrations(new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).searchParams.get("limit")) });
  const migrationReportMatch = pathname.match(/^\/api\/v1\/migrations\/([^/]+)$/);
  if (migrationReportMatch && req.method === "GET") {
    const report = authorityStore.getMigration(decodeURIComponent(migrationReportMatch[1]));
    if (!report) throw new AuthorityError("NOT_FOUND", "Migration report was not found", 404);
    return send(req, res, 200, { ok: true, report });
  }

  if (pathname === "/api/config" && req.method === "GET") {
    const settings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    return send(res, 200, { ok: true, settings: { ...DEFAULT_SETTINGS, ...settings } });
  }

  if (pathname === "/api/config" && req.method === "POST") {
    const body = await readBody(req);
    const settings = { ...DEFAULT_SETTINGS, ...body };
    await writeJsonFile(SETTINGS_FILE, settings);
    return send(res, 200, { ok: true, settings });
  }

  if (pathname === "/api/state" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const settings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    if (url.searchParams.get("light") === "1") {
      return send(res, 200, { ok: true, settings: { ...DEFAULT_SETTINGS, ...settings }, data: lightHubData(data, { linkLimit: url.searchParams.get("linkLimit") || 5000 }) });
    }
    return send(res, 200, { ok: true, settings: { ...DEFAULT_SETTINGS, ...settings }, data });
  }

  if (pathname === "/api/stats" && req.method === "GET") {
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    return send(req, res, 200, { ok: true, stats: analyzeHubData(data) });
  }

  if (pathname === "/api/backup" && req.method === "GET") {
    const settings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return send(req, res, 200, {
      type: "memory_hub_full_backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { ...DEFAULT_SETTINGS, ...settings },
      data,
    }, {
      "Content-Disposition": `attachment; filename="memory-hub-full-backup-${stamp}.json"`,
      "Cache-Control": "no-store",
    });
  }

  if (pathname === "/api/vector-values" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const charId = clean(url.searchParams.get("charId") || "");
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 150), 300));
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const memoryIds = new Set(
      (data.memories || [])
        .filter((item) => !charId || item.charId === charId)
        .slice(0, limit)
        .map((item) => item.id)
    );
    const vectors = (data.vectors || [])
      .filter((item) => memoryIds.has(vectorKey(item)))
      .slice(0, limit);
    return send(req, res, 200, { ok: true, charId, vectors });
  }

  if (pathname === "/api/connection-test" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const result = await connectionTest({ ...storedSettings, ...(body.settings || body || {}) });
    return send(req, res, 200, result);
  }

  if (pathname === "/api/model/test" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const hubData = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const type = clean(body.type || "embedding");
    const modelConfig = body.modelConfig || {};
    if (type === "embedding") {
      const config = resolveEmbeddingConfig(settings, hubData, modelConfig.embedding || {});
      const result = await fetchEmbeddingModels(config);
      return send(req, res, 200, { ok: true, type, message: "embedding connection ok: " + (config.sourceLabel || config.source || "config") + " / " + (config.model || result.models?.[0] || "model unspecified"), models: result.models || [] });
    }
    if (type === "lightLLM") {
      const config = resolveLightLLMConfig(settings, hubData, modelConfig.lightLLM || {});
      const result = await testLightLLM(config);
      return send(req, res, 200, { ...result, type });
    }
    if (type === "rerank") {
      const config = resolveRerankConfig(settings, hubData, modelConfig.rerank || {});
      const result = await testRerank(config);
      return send(req, res, 200, { ...result, type });
    }
    return send(req, res, 400, { ok: false, error: "Unknown model test type: " + type });
  }

  if (pathname === "/api/memory/extract" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const result = await runMemoryExtractionPipeline(settings, data, body, { persist: body.persist !== false && !body.data, origin: "extraction" });
    if (body.persist !== false && !body.data) {
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, result);
  }

  if (pathname === "/api/memory/migrate-month" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const { charId, charName, userName, charContext } = characterForPrompt(data, body);
    const config = resolveMemoryPalaceLightLLM(settings, data, body);
    const logsText = dailyLogsTextForPrompt(body);
    const relatedMemories = relatedMemoriesForPrompt(data, { ...body, logsText }, charId);
    const systemPrompt = buildMigrationSystemPrompt({
      charName,
      monthKey: clean(body.monthKey || body.month || ""),
      charContext,
      userName,
      relatedMemories,
    });
    const { reply } = await callMemoryPalaceLLM(config, [
      { role: "system", content: systemPrompt },
      { role: "user", content: logsText },
    ], { temperature: 0.5, maxTokens: 12000, timeoutMs: 300000 });
    const parsed = safeParseJsonArray(reply);
    const memories = parsed
      .filter((item) => item && item.content && item.room)
      .map((item) => normalizeGeneratedMemory(item, { charId, charName, source: "sullyos_memory_palace", origin: "migration" }));
    const related = parseRelatedToAndHints(parsed, memories, relatedMemories);
    let vectorized = { attempted: 0, stored: 0, skipped: 0, error: "" };
    let consolidation = null;
    if (body.persist !== false && !body.data) {
      mergeGeneratedMemories(data, memories);
      data.memoryLinks = mergeListByKey(data.memoryLinks || [], related.crossTimeLinks.map((item) => ({ ...item, id: `${item.newMemoryId}:${item.existingMemoryId}` })));
      data.eventBoxHints = mergeListByKey(data.eventBoxHints || [], related.eventBoxHints.map((item) => ({ ...item, id: item.newMemoryId })));
      const touchedEventBoxes = bindMemoriesIntoEventBoxInData(data, charId, related.crossTimeLinks, related.eventBoxHints);
      data.lastTouchedEventBoxes = [...touchedEventBoxes];
      vectorized = await autoVectorizeMemories(settings, data, memories, { skipDedup: false });
      if (body.autoCompress !== false) {
        for (const boxId of touchedEventBoxes) {
          await compressEventBoxInData(data, config, boxId, { charId, charName, userName, updatePlate: body.updatePlate !== false, settings });
        }
      }
      consolidation = runMemoryConsolidationInData(data, charId);
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, { ok: true, promptSource: "SullyOS migration.ts", imported: memories.length, memories, rawCount: parsed.length, related, vectorized, consolidation });
  }

  if (pathname === "/api/memory/import-external" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const { charId, charName, userName } = characterForPrompt(data, body);
    const config = resolveMemoryPalaceLightLLM(settings, data, body);
    const rawText = clean(body.rawText || body.text || body.content || "");
    const { reply } = await callMemoryPalaceLLM(config, [
      { role: "system", content: buildExternalMemoryPrompt(charName, userName) },
      { role: "user", content: `这是第 1/1 批外部记忆原文：\n\n${rawText}` },
    ], { temperature: 0.05, maxTokens: 16000, timeoutMs: 180000 });
    const parsed = safeParseJsonArray(reply);
    const memories = parsed
      .filter((item) => item && item.content && item.room)
      .map((item) => normalizeGeneratedMemory(item, { charId, charName, source: "sullyos_memory_palace", origin: "external_import" }));
    let vectorized = { attempted: 0, stored: 0, skipped: 0, error: "" };
    let consolidation = null;
    if (body.persist !== false && !body.data) {
      mergeGeneratedMemories(data, memories);
      vectorized = await autoVectorizeMemories(settings, data, memories, { skipDedup: false });
      consolidation = runMemoryConsolidationInData(data, charId);
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, { ok: true, promptSource: "SullyOS externalMemory.ts", imported: memories.length, memories, rawCount: parsed.length, vectorized, consolidation });
  }

  if (pathname === "/api/memory/pipeline/chat-turn" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const { charId } = characterForPrompt(data, body);
    if (!charId) return send(req, res, 400, { ok: false, error: "charId is required" });
    const beforeAnticipations = processAnticipationLifecycleInData(data, charId);
    const extraction = body.extract === false
      ? { ok: true, skipped: true, imported: 0, memories: [], rawCount: 0, related: { crossTimeLinks: [], eventBoxHints: [] }, touchedEventBoxes: [], compressed: [], vectorized: { attempted: 0, stored: 0, skipped: 0, error: "" } }
      : await runMemoryExtractionPipeline(settings, data, body, { persist: body.persist !== false && !body.data, origin: clean(body.origin || "chat_turn") });
    const pendingVectorized = body.persist !== false && !body.data
      ? await autoVectorizePendingMemories(settings, data, { charId, limit: body.vectorLimit || 25, skipDedup: false })
      : { attempted: 0, stored: 0, skipped: 0, error: "" };
    let digest = { mode: "tick", enabled: false, threshold: 0, count: 0, triggered: false, report: null };
    if (body.digestMode !== "none") {
      if (body.digestMode === "manual" || body.digestNow === true) {
        const report = await runDigestOnceInData(settings, data, body, { trigger: "manual_pipeline" });
        if (body.persist !== false && !body.data) {
          data.digestReports = mergeById(data.digestReports || [], report);
          data.lastDigestAt = { ...(data.lastDigestAt || {}), [charId]: Date.now() };
        }
        digest = { mode: "manual", enabled: true, threshold: 0, count: data.digestRoundCounters?.[charId] || 0, triggered: true, report };
      } else {
        digest = { mode: "tick", ...(await runDigestTickInData(settings, data, body)) };
      }
    }
    if (digest.error) return send(req, res, 400, { ok: false, error: digest.error });
    const afterAnticipations = processAnticipationLifecycleInData(data, charId);
    const metadataSynced = syncVectorMetadata(data);
    if (body.persist !== false && !body.data) {
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, {
      ok: true,
      promptSource: "SullyOS unified memory pipeline",
      charId,
      extraction,
      digest,
      anticipations: { before: beforeAnticipations, after: afterAnticipations },
      vectorized: {
        extraction: extraction.vectorized,
        pending: pendingVectorized,
        digest: digest.report?.vectorized || null,
      },
      eventBoxes: {
        touched: extraction.touchedEventBoxes || [],
        compressed: extraction.compressed?.length || 0,
      },
      metadataSynced,
    });
  }

  if (pathname === "/api/memory/eventbox/summarize" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const { charId, charName, userName } = characterForPrompt(data, body);
    const config = resolveMemoryPalaceLightLLM(settings, data, body);
    const box = body.box || {};
    const liveNodes = Array.isArray(body.liveNodes) ? body.liveNodes : (Array.isArray(body.memories) ? body.memories : []);
    const oldSummaryContent = clean(body.oldSummaryContent || body.oldSummary?.content || "");
    const oldSummaryBlock = oldSummaryContent
      ? `\n## 你之前已经回忆过这件事一次，那时记下的是：\n${oldSummaryContent}\n\n后来又新增了下面这些：\n`
      : `\n## 关于这件事的零散记忆碎片：\n`;
    const { reply } = await callMemoryPalaceLLM(config, [
      { role: "system", content: buildCompressionSystemPrompt({ box, charName, userName }) },
      { role: "user", content: `${oldSummaryBlock}\n${liveNodesTextForPrompt(liveNodes)}` },
    ], { temperature: 0.5, maxTokens: 8000, timeoutMs: 120000 });
    const summary = safeParseJsonObject(reply) || { content: clean(reply) };
    if (summary.content) {
      summary.content = await enforceEventBoxSummaryLength(summary.content, config, charName);
    }
    let memory = null;
    if (summary.content) {
      const previousBox = (data.eventBoxes || []).find((item) => item.id === box.id) || box;
      const previousSummary = previousBox.summaryNodeId
        ? (data.memories || []).find((item) => item.id === previousBox.summaryNodeId)
        : null;
      const generatedSummary = normalizeGeneratedMemory({
        ...summary,
        room: summary.room || box.room || previousBox.room || "living_room",
        eventBoxId: box.id,
        eventName: summary.name || box.name || previousBox.name,
        eventTags: summary.tags || box.tags || previousBox.tags,
      }, { charId, charName, source: "sullyos_memory_palace", origin: "eventbox_compression", prefix: "mn_box" });
      memory = previousSummary
        ? {
            ...previousSummary,
            ...generatedSummary,
            id: previousSummary.id,
            createdAt: previousSummary.createdAt,
            lastAccessedAt: Date.now(),
            embedded: false,
            vectorRefresh: true,
            archived: false,
          }
        : generatedSummary;
      memory.isBoxSummary = true;
    }
    let vectorized = { attempted: 0, stored: 0, skipped: 0, error: "" };
    let metadataSynced = 0;
    if (body.persist !== false && !body.data && memory) {
      mergeGeneratedMemories(data, [memory]);
      if (box.id) {
        const liveIds = liveNodes.map((item) => item.id).filter(Boolean);
        data.memories = (data.memories || []).map((item) => {
          if (!liveIds.includes(item.id)) return item;
          return { ...item, archived: true, eventBoxId: box.id, updatedAt: Date.now() };
        });
        metadataSynced = syncVectorMetadata(data, liveIds);
        const previousBox = (data.eventBoxes || []).find((item) => item.id === box.id) || box;
        const archivedMemoryIds = [...new Set([...(previousBox.archivedMemoryIds || []), ...liveIds])];
        const liveMemoryIds = (previousBox.liveMemoryIds || []).filter((id) => !liveIds.includes(id));
        const totalBoxEvents = archivedMemoryIds.length + liveMemoryIds.length;
        const nextBox = {
          ...previousBox,
          ...box,
          charId,
          name: summary.name || box.name || previousBox.name,
          tags: Array.isArray(summary.tags) ? summary.tags : (box.tags || previousBox.tags || []),
          summaryNodeId: memory.id,
          liveMemoryIds,
          archivedMemoryIds,
          compressionCount: Number(previousBox.compressionCount || 0) + 1,
          lastCompressedAt: Date.now(),
          updatedAt: Date.now(),
          sealed: previousBox.sealed || totalBoxEvents >= EVENT_BOX_SEAL_THRESHOLD,
        };
        data.eventBoxes = mergeById(data.eventBoxes || [], nextBox);
        if (body.updatePlate !== false && PLATE_ROOMS.includes(memory.room)) {
          await consolidateHubPlates(data, config, {
            charId,
            charName,
            userName,
            materials: [{ room: memory.room, lines: [memory.content] }],
            persist: true,
          });
        }
      }
      vectorized = await autoVectorizeMemories(settings, data, [memory], { skipDedup: true });
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, { ok: true, promptSource: "SullyOS eventBoxCompression.ts", summary, memory, vectorized, metadataSynced });
  }

  if (pathname === "/api/memory/eventbox/recompress" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const { charName } = characterForPrompt(data, body);
    const config = resolveMemoryPalaceLightLLM(settings, data, body);
    const { reply } = await callMemoryPalaceLLM(config, [
      { role: "system", content: buildRecompressSummaryPrompt({ targetMaxChars: body.targetMaxChars, charName }) },
      { role: "user", content: clean(body.text || body.content || "") },
    ], { temperature: 0.3, maxTokens: 4000, timeoutMs: 90000 });
    return send(req, res, 200, { ok: true, promptSource: "SullyOS eventBoxCompression.ts", content: clean(reply) });
  }

  if (pathname === "/api/memory/consolidate" && req.method === "POST") {
    const body = await readBody(req);
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const charId = clean(body.charId || body.characterId || "");
    if (!charId) return send(req, res, 400, { ok: false, error: "charId is required" });
    const result = runMemoryConsolidationInData(data, charId, Number(body.now || 0) || Date.now());
    if (!body.data && body.persist !== false) {
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, {
      ok: true,
      promptSource: "SullyOS consolidation.ts",
      charId,
      ...result,
      ...(body.returnData ? { data } : {}),
    });
  }

  if (pathname === "/api/memory/eventbox/compress" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const { charId, charName, userName } = characterForPrompt(data, body);
    const config = resolveMemoryPalaceLightLLM(settings, data, body);
    const ids = Array.isArray(body.boxIds) ? body.boxIds : (body.boxId ? [body.boxId] : (data.lastTouchedEventBoxes || []));
    const compressed = [];
    for (const boxId of ids) {
      const result = await compressEventBoxInData(data, config, boxId, { charId, charName, userName, updatePlate: body.updatePlate !== false, settings });
      if (result) compressed.push(result);
    }
    if (body.persist !== false && !body.data) {
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, { ok: true, promptSource: "SullyOS eventBoxCompression.ts", compressed: compressed.length, results: compressed });
  }

  if (pathname === "/api/memory/anticipations/process" && req.method === "POST") {
    const body = await readBody(req);
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const { charId } = characterForPrompt(data, body);
    const changed = processAnticipationLifecycleInData(data, charId);
    if (body.persist !== false && !body.data) {
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, { ok: true, promptSource: "SullyOS anticipation.ts", changed, anticipations: (data.anticipations || []).filter((item) => !charId || item.charId === charId) });
  }

  if (pathname === "/api/memory/plates/consolidate" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const { charId, charName, userName } = characterForPrompt(data, body);
    const config = resolveMemoryPalaceLightLLM(settings, data, body);
    const materials = Array.isArray(body.materials)
      ? body.materials
      : undefined;
    const result = await consolidateHubPlates(data, config, {
      charId,
      charName,
      userName,
      materials,
      extraMaterial: body.extraMaterial || body.plateSubmissions,
      identityContext: clean(body.identityContext || ""),
      persist: body.persist !== false && !body.data,
    });
    if (body.persist !== false && !body.data) {
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, { ok: true, promptSource: "SullyOS roomPlates.ts", ...result });
  }

  if (pathname === "/api/memory/digest/run" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const report = await runDigestOnceInData(settings, data, body, { trigger: "manual" });
    if (body.persist !== false && !body.data) {
      data.digestReports = mergeById(data.digestReports || [], report);
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, { ok: true, promptSource: "SullyOS digestion.ts", report });
  }

  if (pathname === "/api/memory/digest/tick" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const tick = await runDigestTickInData(settings, data, body);
    if (tick.error) return send(req, res, 400, { ok: false, error: tick.error });
    if (body.persist !== false && !body.data) {
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, { ok: true, promptSource: "SullyOS digestion.ts", ...tick });
  }

  if (pathname === "/api/memory/personality/detect" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const { charId, charName, charContext } = characterForPrompt(data, body);
    const config = resolveMemoryPalaceLightLLM(settings, data, body);
    const { reply } = await callMemoryPalaceLLM(config, [
      { role: "system", content: buildPersonalityStylePrompt({ charName, charPersona: clean(body.charPersona || charContext), memoryContext: clean(body.memoryContext || memoryContextForPersonality(data, charId)) }) },
      { role: "user", content: "请判断。" },
    ], { temperature: 0.3, maxTokens: 8000, timeoutMs: 120000 });
    const profile = safeParseJsonObject(reply) || { raw: clean(reply) };
    const record = { id: charId || charName, charId, charName, profile, updatedAt: Date.now(), source: "sullyos_memory_palace" };
    if (body.persist !== false && !body.data) {
      data.personalityProfiles = mergeById(data.personalityProfiles || [], record);
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, { ok: true, promptSource: "SullyOS digestion.ts", profile: record });
  }

  if (pathname === "/api/search" && req.method === "POST") {
    const body = await readBody(req);
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const results = searchHubData(data, body.query, body);
    return send(req, res, 200, { ok: true, results, total: results.length });
  }

  if (pathname === "/api/recall" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const result = await recallHubData(settings, data, { ...body, persistState: !body.data && body.persistState !== false });
    return send(req, res, 200, result);
  }

  if (pathname === "/api/breath" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const result = await breathHubData(settings, data, body);
    if (!body.data) await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, { ...result, activity: data.activity || {} });
  }

  if (pathname === "/api/duplicates" && req.method === "POST") {
    const body = await readBody(req);
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const result = duplicateCandidates(data, body);
    return send(req, res, 200, result);
  }

  if (pathname === "/api/duplicates/merge" && req.method === "POST") {
    const body = await readBody(req);
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const result = mergeDuplicateMemories(data, body);
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, { ...result, data: lightHubData(data) });
  }

  if ((pathname === "/api/embedding/models" || pathname === "/api/embedding/test") && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const hubData = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const config = resolveEmbeddingConfig(settings, hubData, body.embedding || {});
    const result = await fetchEmbeddingModels(config);
    const selectedModel = config.model || result.models[0] || "";
    return send(req, res, 200, {
      ok: true,
      action: pathname === "/api/embedding/test" ? "test" : "models",
      ...sanitizeEmbeddingConfig({ ...config, model: selectedModel }),
      url: result.url,
      models: result.models,
      total: result.models.length,
    });
  }

  if (pathname === "/api/sully/schema" && req.method === "GET") {
    return send(req, res, 200, {
      ok: true,
      service: "memory-hub",
      schema: "sullyos-ombre-bridge-compatible",
      endpoints: [
        "GET /api/sully/contexts",
        "POST /api/sully/config",
        "GET /api/sully/characters",
        "POST /api/sully/characters",
        "GET /api/sully/core-memories",
        "POST /api/sully/core-memories",
        "GET /api/sully/memories",
        "POST /api/sully/memories",
        "GET /api/sully/room-plates",
        "POST /api/sully/room-plates",
        "POST /api/sully/event-boxes",
        "POST /api/sully/anticipations",
        "POST /api/sully/digest-reports",
        "GET /api/runtime/messages",
        "POST /api/runtime/messages",
        "POST /api/v1/runtime/commands",
        "GET /api/runtime/v2/promotion",
        "POST /api/runtime/v2/promotion/prepare",
        "POST /api/runtime/v2/promotion/commit",
        "POST /api/runtime/v2/promotion/rollback",
        "POST /api/v1/cc/context",
        "POST /api/v1/cc/wakes/claim",
        "POST /api/v1/cc/wakes/:id/fail",
        "GET /api/runtime/status",
        "GET /api/runtime/storage",
        "GET /api/runtime/v2/read-status",
        "POST /api/runtime/process",
        "GET /api/legacy/status",
        "GET /api/legacy/context",
        "POST /api/legacy/refine-month",
        "POST /api/legacy/months/activate",
        "POST /api/legacy/recall",
        "GET /api/impression/status",
        "POST /api/impression/generate",
        "POST /api/memory/pipeline/chat-turn",
        "POST /api/memory/extract",
        "POST /api/memory/migrate-month",
        "POST /api/memory/import-external",
        "POST /api/memory/eventbox/summarize",
        "POST /api/memory/eventbox/recompress",
        "POST /api/memory/eventbox/compress",
        "POST /api/memory/anticipations/process",
        "POST /api/memory/plates/consolidate",
        "POST /api/memory/digest/run",
        "POST /api/memory/digest/tick",
        "POST /api/memory/personality/detect",
        "POST /api/memory/consolidate",
      ],
      note: "Memory Hub stores SullyOS memory palace nodes first; syncing to real Ombre is a separate manual step.",
    });
  }

  if (pathname === "/api/legacy/status" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const charId = clean(url.searchParams.get("charId") || "");
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const character = (data.characters || []).find((item) => item.id === charId);
    if (!character) return send(req, res, 404, { ok: false, error: "character not found" });
    return send(req, res, 200, { ok: true, templates: LEGACY_REFINE_TEMPLATES.map(({ id, name }) => ({ id, name })), ...legacyStatusForCharacter(character) });
  }

  if (pathname === "/api/legacy/context" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const charId = clean(url.searchParams.get("charId") || "");
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const character = (data.characters || []).find((item) => item.id === charId);
    if (!character) return send(req, res, 404, { ok: false, error: "character not found" });
    const includeDetailedMemories = url.searchParams.get("detailed") !== "0";
    return send(req, res, 200, {
      ok: true,
      charId,
      includeDetailedMemories,
      context: buildLegacyMemoryContext(character, { includeDetailedMemories }),
    });
  }

  if (pathname === "/api/legacy/refine-month" && req.method === "POST") {
    const body = await readBody(req);
    const charId = clean(body.charId || body.characterId || "");
    const month = normalizeLegacyMonth(body.month || `${body.year || ""}-${body.monthNumber || ""}`);
    if (!charId) return send(req, res, 400, { ok: false, error: "charId is required" });
    if (!month) return send(req, res, 400, { ok: false, error: "month must use YYYY-MM" });
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const characterIndex = findCharacterIndex(data, charId);
    if (characterIndex < 0) return send(req, res, 404, { ok: false, error: "character not found" });
    const character = data.characters[characterIndex];
    const userName = clean(body.userName || character.userProfile?.name || character.userName || "用户");
    const userBio = clean(body.userBio || character.userProfile?.bio || character.userBio || "");
    const request = buildLegacyMonthlyRefinementRequest({
      character,
      month,
      userName,
      userBio,
      templateId: clean(body.templateId || "refine_atmosphere"),
    });
    if (!request.fragments.length) return send(req, res, 400, { ok: false, error: `${month} 没有 MemoryFragment` });
    const config = resolveMemoryPalaceLightLLM(settings, data, body);
    const { reply } = await callMemoryPalaceLLM(config, request.messages, { temperature: 0.3, timeoutMs: 180000 });
    const summary = clean(reply);
    if (!summary) return send(req, res, 502, { ok: false, error: "月度精炼模型返回为空" });
    const refinedMemories = { ...(character.refinedMemories || {}), [month]: summary };
    const nextCharacter = { ...character, refinedMemories };
    data.characters[characterIndex] = nextCharacter;
    syncLegacyRefinedMemoryMirror(data, nextCharacter, month, summary);
    data.updatedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, {
      ok: true,
      promptSource: "SullyOS Character.tsx + MemoryArchivist.tsx + ChatConstants.ts",
      charId,
      month,
      templateId: request.templateId,
      templateName: request.templateName,
      fragmentCount: request.fragments.length,
      summary,
      context: buildLegacyMemoryContext(nextCharacter, { includeDetailedMemories: true }),
    });
  }

  if (pathname === "/api/legacy/months/activate" && req.method === "POST") {
    const body = await readBody(req);
    const charId = clean(body.charId || body.characterId || "");
    const month = normalizeLegacyMonth(body.month || "");
    if (!charId || !month) return send(req, res, 400, { ok: false, error: "charId and YYYY-MM month are required" });
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const characterIndex = findCharacterIndex(data, charId);
    if (characterIndex < 0) return send(req, res, 404, { ok: false, error: "character not found" });
    const character = data.characters[characterIndex];
    const active = new Set(Array.isArray(character.activeMemoryMonths) ? character.activeMemoryMonths : []);
    const nextActive = body.active === undefined ? !active.has(month) : Boolean(body.active);
    if (nextActive) active.add(month);
    else active.delete(month);
    const nextCharacter = { ...character, activeMemoryMonths: [...active] };
    data.characters[characterIndex] = nextCharacter;
    data.updatedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, {
      ok: true,
      charId,
      month,
      active: nextActive,
      activeMemoryMonths: nextCharacter.activeMemoryMonths,
      context: buildLegacyMemoryContext(nextCharacter, { includeDetailedMemories: true }),
    });
  }

  if (pathname === "/api/legacy/recall" && req.method === "POST") {
    const body = await readBody(req);
    const charId = clean(body.charId || body.characterId || "");
    const requestedMonth = normalizeLegacyMonth(body.month || body.yearMonth || "");
    const text = requestedMonth
      ? `[[RECALL: ${requestedMonth}]]`
      : clean(body.text || body.content || body.directive || "");
    if (!charId || !text) return send(req, res, 400, { ok: false, error: "charId and recall month or text are required" });
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const characterIndex = findCharacterIndex(data, charId);
    if (characterIndex < 0) return send(req, res, 404, { ok: false, error: "character not found" });
    let character = data.characters[characterIndex];
    const result = runLegacyRecall(character, text);
    if (result.ok && !result.alreadyActive) {
      const active = new Set(Array.isArray(character.activeMemoryMonths) ? character.activeMemoryMonths : []);
      active.add(result.yearMonth);
      character = { ...character, activeMemoryMonths: [...active] };
      data.characters[characterIndex] = character;
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, result.ok ? 200 : 404, {
      ...result,
      charId,
      context: buildLegacyMemoryContext(character, { includeDetailedMemories: true }),
    });
  }

  if (pathname === "/api/impression/status" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const charId = clean(url.searchParams.get("charId") || "");
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
    const character = (data.characters || []).find((item) => item.id === charId);
    if (!character) return send(req, res, 404, { ok: false, error: "character not found" });
    const selfRoomPlate = (data.roomPlates || []).find((item) => item.charId === charId && item.room === "self_room");
    return send(req, res, 200, {
      ok: true,
      charId,
      charName: clean(character.name || charId),
      impression: normalizeUserImpression(character.impression) || null,
      recentMessages: runtime.messages.filter((item) => item.charId === charId && isChatRuntimeMessage(item)).length,
      legacySelfInsights: Array.isArray(character.selfInsights) ? character.selfInsights : [],
      selfRoomPlateEntries: Array.isArray(selfRoomPlate?.entries) ? selfRoomPlate.entries : [],
    });
  }

  if (pathname === "/api/impression/generate" && req.method === "POST") {
    const body = await readBody(req);
    const charId = clean(body.charId || body.characterId || "");
    const requestedType = clean(body.type || body.mode || "update") === "initial" ? "initial" : "update";
    if (!charId) return send(req, res, 400, { ok: false, error: "charId is required" });
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
    const characterIndex = findCharacterIndex(data, charId);
    if (characterIndex < 0) return send(req, res, 404, { ok: false, error: "character not found" });
    const character = data.characters[characterIndex];
    const userProfile = {
      name: clean(body.userName || character.userProfile?.name || character.userName || settings.userName || "用户"),
      bio: clean(body.userBio || character.userProfile?.bio || character.userBio || settings.userBio || ""),
    };
    const runtimeMessages = runtime.messages.filter((item) => item.charId === charId && isChatRuntimeMessage(item));
    const query = runtimeMessages
      .slice(-12)
      .filter((item) => item.type !== "code_card")
      .map((item) => clean(item.content || item.text || item.body || ""))
      .filter(Boolean)
      .join("\n");
    const roomPlatesContext = character.memoryPalaceEnabled
      ? formatRoomPlatesContext((data.roomPlates || []).filter((item) => item.charId === charId), userProfile.name)
      : "";
    let memoryPalaceContext = "";
    if (character.memoryPalaceEnabled && query) {
      const recalled = await recallHubData(settings, data, {
        charId,
        userName: userProfile.name,
        query,
        limit: Math.max(1, Math.min(Number(body.recallLimit || 15), 30)),
        eventBoxMode: clean(body.eventBoxMode || settings.recallEventBoxMode || "compat"),
        eventBoxLiveLimit: Number(body.eventBoxLiveLimit || settings.recallEventBoxLiveLimit || 5),
        persistState: true,
      });
      memoryPalaceContext = recalled.memoryPalaceContext || "";
    }
    const fullContext = buildSullyCoreContext({
      character,
      userProfile,
      roomPlatesContext,
      legacyMemoryContext: buildLegacyMemoryContext(character, { includeDetailedMemories: true }),
      memoryPalaceContext,
    });
    const request = buildSullyImpressionRequest({
      character,
      userProfile,
      runtimeMessages,
      type: requestedType,
      fullContext,
    });
    const config = resolveMemoryPalaceLightLLM(settings, data, body);
    const { reply } = await callMemoryPalaceLLM(config, request.messages, {
      temperature: 0.5,
      maxTokens: 8000,
      timeoutMs: 180000,
    });
    const parsed = safeParseJsonObject(reply);
    const impression = normalizeUserImpression(parsed);
    if (!impression) return send(req, res, 502, { ok: false, error: "印象生成结果不完整" });
    const nextCharacter = { ...character, impression, updatedAt: Date.now() };
    data.characters[characterIndex] = nextCharacter;
    syncCharacterImpressionMirror(data, nextCharacter, impression);
    data.updatedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, {
      ok: true,
      promptSource: "SullyOS apps/Character.tsx handleGenerateImpression + utils/context.ts buildCoreContext",
      charId,
      type: request.type,
      recentMessageCount: request.recentMessages.length,
      context: {
        selfInsights: Array.isArray(character.selfInsights) ? character.selfInsights.length : 0,
        roomPlates: roomPlatesContext ? 1 : 0,
        memoryPalace: memoryPalaceContext ? 1 : 0,
        legacyMemory: Object.keys(character.refinedMemories || {}).length,
      },
      impression,
    });
  }

  if (pathname === "/api/runtime/messages" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const charId = clean(url.searchParams.get("charId") || "");
    const after = Number(url.searchParams.get("after") || 0);
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 200), 1000));
    const requestedSurface = normalizeRuntimeSurface(url.searchParams.get("surface") || "");
    const requestedVisibility = clean(url.searchParams.get("visibility") || "").toLowerCase();
    const conversationId = clean(url.searchParams.get("conversationId") || "");
    const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
    const scopedMessages = runtime.messages.map((item) => ({ ...item, ...effectiveRuntimeMessageScope(item) }));
    const messages = scopedMessages
      .filter((item) => (!charId || item.charId === charId)
        && item.id > after
        && (!requestedSurface || item.surface === requestedSurface)
        && (!requestedVisibility || item.visibility === requestedVisibility)
        && (!conversationId || item.conversationId === conversationId))
      .slice(-limit);
    const surfaceCounts = Object.fromEntries([...RUNTIME_SURFACES].map((surface) => [surface, scopedMessages.filter((item) => (!charId || item.charId === charId) && item.surface === surface).length]));
    return send(req, res, 200, { ok: true, charId, surface: requestedSurface || null, visibility: requestedVisibility || null, conversationId: conversationId || null, messages, total: messages.length, surfaceCounts });
  }

  if (pathname === "/api/runtime/status" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const charId = clean(url.searchParams.get("charId") || "");
    const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
    const ids = charId
      ? [charId]
      : [...new Set(runtime.messages.map((item) => item.charId).filter(Boolean))];
    const characters = ids.map((id) => {
      const state = runtimeBufferState(runtime, id, false);
      return {
        charId: id,
        messages: state.messages.length,
        highWaterMark: state.highWaterMark,
        buffer: state.buffer.length,
        processable: state.toProcess.length,
        hotZone: RUNTIME_HOT_ZONE_SIZE,
        threshold: RUNTIME_BUFFER_THRESHOLD,
        pendingJob: runtime.pendingJobs?.[id] || null,
        digestRounds: Number(runtime.digestRoundCounters?.[id] || 0),
        lastRun: runtime.lastRuns?.[id] || null,
        locked: runtimeProcessingLocks.has(id),
      };
    });
    return send(req, res, 200, { ok: true, characters });
  }

  if (pathname === "/api/runtime/storage" && req.method === "GET") {
    const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
    const databaseBytes = Number((await fs.stat(AUTHORITY_DB_FILE)).size || 0);
    return send(req, res, 200, { ok: true, storage: runtimeMessageStorageMetrics(runtime.messages, databaseBytes) });
  }

  if (pathname === "/api/runtime/v2/read-status" && req.method === "GET") {
    return send(req, res, 200, { ok: true, ...runtimeReadMode.status(), authorityMode: authorityStore.runtimeV2.authorityMode(), nativeWritesEnabled: RUNTIME_NATIVE_WRITES_ENABLED, shadow: authorityStore.runtimeV2Status() });
  }

  if (pathname === "/api/runtime/messages" && req.method === "POST") {
    const body = await readBody(req);
    const incoming = Array.isArray(body) ? body : (body.messages || (body.message ? [body.message] : []));
    const charId = clean(body.charId || body.characterId || incoming[0]?.charId || incoming[0]?.characterId || "");
    if (!charId) return send(req, res, 400, { ok: false, error: "charId is required" });
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
    const appended = appendRuntimeMessages(runtime, charId, incoming);
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    let dataChanged = false;
    const chatChanges = [...appended.appended, ...appended.updated].filter((item) => isChatRuntimeMessage(item));
    const legacyRecalls = applyLegacyRecallDirectives(data, charId, chatChanges);
    if (legacyRecalls.some((item) => item.ok && !item.alreadyActive)) dataChanged = true;
    let processing = { ok: true, skipped: true, reason: "auto_process_disabled", dataChanged: false };
    if (body.autoProcess !== false) {
      processing = await processRuntimeMessageBuffer(settings, data, runtime, { ...body, charId });
      dataChanged = dataChanged || Boolean(processing.dataChanged);
    }
    const anticipationChanged = processAnticipationLifecycleInData(data, charId);
    if (anticipationChanged > 0) dataChanged = true;

    const completedTurn = body.turnCompleted === true
      || appended.appended.some((item) => item.role === "assistant" && isChatRuntimeMessage(item));
    const digest = {
      enabled: Boolean(body.digestEnabled ?? settings.digestAutoEnabled),
      threshold: Math.max(1, Math.min(500, Number(body.digestThreshold || settings.digestAutoRounds || 50) || 50)),
      count: Number(runtime.digestRoundCounters?.[charId] || 0),
      triggered: false,
      report: null,
      error: "",
    };
    if (completedTurn && body.digestMode !== "none") {
      digest.count += 1;
      runtime.digestRoundCounters = { ...(runtime.digestRoundCounters || {}), [charId]: digest.count };
      if (digest.enabled && digest.count >= digest.threshold) {
        try {
          digest.report = await runDigestOnceInData(settings, data, body, { trigger: `runtime_auto_${digest.threshold}_rounds` });
          data.digestReports = mergeById(data.digestReports || [], digest.report);
          data.lastDigestAt = { ...(data.lastDigestAt || {}), [charId]: Date.now() };
          runtime.digestRoundCounters[charId] = 0;
          digest.count = 0;
          digest.triggered = true;
          dataChanged = true;
        } catch (error) {
          digest.error = String(error?.message || error);
        }
      }
    }
    if (dataChanged) {
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    await writeJsonFile(RUNTIME_FILE, runtime);
    const activityState = persistActivityStateFromMessages(data, runtime, charId, incoming);
    return send(req, res, 200, {
      ok: true,
      charId,
      appended: appended.appended.length,
      updated: appended.updated.length,
      processing,
      digest,
      anticipationChanged,
      legacyRecalls,
      activityState: {
        changed: activityState.changed,
        inputCount: activityState.inputCount,
        activityCount: activityState.activityCount,
        snapshotVersion: activityState.snapshot?.snapshotVersion || 0,
        state: activityState.snapshot?.state || null,
      },
    });
  }

  if (pathname === "/api/runtime/process" && req.method === "POST") {
    const body = await readBody(req);
    const charId = clean(body.charId || body.characterId || "");
    if (!charId) return send(req, res, 400, { ok: false, error: "charId is required" });
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const runtime = normalizeRuntimeState(await readJsonFile(RUNTIME_FILE, EMPTY_RUNTIME));
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const result = await processRuntimeMessageBuffer(settings, data, runtime, { ...body, charId });
    if (result.dataChanged) {
      data.updatedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    await writeJsonFile(RUNTIME_FILE, runtime);
    return send(req, res, 200, result);
  }

  if (pathname === "/api/sully/contexts" && req.method === "GET") {
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    return send(req, res, 200, { ok: true, contexts: summarizeContexts(data) });
  }

  if (pathname === "/api/sully/config" && req.method === "POST") {
    const body = await readBody(req);
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA, { allowCorruptFallback: true });
    const changed = mergeModelConfigFromPayload(data, body);
    if (!changed) {
      return send(req, res, 400, {
        ok: false,
        error: "No model config found in payload.memoryPalaceConfig",
      });
    }
    data.importedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, {
      ok: true,
      embeddingConfig: sanitizeEmbeddingConfig({ ...(data.embeddingConfig || {}), source: "sully", sourceLabel: "SullyOS config" }),
      modelStatus: {
        embedding: Boolean(data.modelConfig?.embedding?.baseUrl && data.modelConfig?.embedding?.apiKey && data.modelConfig?.embedding?.model),
        lightLLM: Boolean(data.modelConfig?.lightLLM?.baseUrl && data.modelConfig?.lightLLM?.apiKey && data.modelConfig?.lightLLM?.model),
        rerank: Boolean(data.modelConfig?.rerank?.baseUrl && data.modelConfig?.rerank?.apiKey && data.modelConfig?.rerank?.model),
      },
    });
  }
  if (pathname === "/api/sully/characters" && req.method === "GET") {
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    return send(req, res, 200, { ok: true, characters: data.characters || [] });
  }

  if (pathname === "/api/sully/characters" && req.method === "POST") {
    const body = await readBody(req);
    const incoming = Array.isArray(body) ? body : (body.characters || []);
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    mergeModelConfigFromPayload(data, body);
    for (const [index, item] of incoming.entries()) {
      const character = normalizeCharacterIndexItem(item, index);
      data.characters = mergeById(data.characters, character);
      const entries = normalizeCoreMemoryEntries(
        item.refinedMemories || item.coreMemories || item.keyMemories || item.aiContext,
        { charId: character.id, charName: character.name, source: "sullyos_ai_context" }
      );
      if (entries.length) data.coreMemories = mergeListByKey(data.coreMemories || [], entries);
    }
    data.importedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, { ok: true, characters: data.characters || [], total: (data.characters || []).length });
  }

  if (pathname === "/api/sully/core-memories" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const charId = clean(url.searchParams.get("charId") || "");
    const results = (data.coreMemories || []).filter((item) => !charId || item.charId === charId);
    return send(req, res, 200, { ok: true, coreMemories: results, total: results.length });
  }

  if (pathname === "/api/sully/core-memories" && req.method === "POST") {
    const body = await readBody(req);
    const incoming = Array.isArray(body)
      ? body
      : (body.coreMemories || body.refinedMemories || body.keyMemories || body.aiContext || []);
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const entries = normalizeCoreMemoryEntries(incoming, {
      charId: body.charId || body.characterId || body.roleId,
      charName: body.charName || body.characterName || body.name,
      source: "sullyos_ai_context",
    });
    data.coreMemories = mergeListByKey(data.coreMemories || [], entries);
    data.importedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, { ok: true, coreMemories: data.coreMemories || [], imported: entries.length, total: (data.coreMemories || []).length });
  }

  if (pathname === "/api/sully/room-plates" && req.method === "GET") {
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    return send(req, res, 200, { ok: true, roomPlates: data.roomPlates || [] });
  }

  if (pathname === "/api/sully/room-plates" && req.method === "POST") {
    const body = await readBody(req);
    const incoming = Array.isArray(body) ? body : (body.roomPlates || body.plates || []);
    const deletedIds = new Set((body.deletedIds || []).map(String).filter(Boolean));
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    if (deletedIds.size) data.roomPlates = (data.roomPlates || []).filter((item) => !deletedIds.has(item.id));
    for (const [index, item] of incoming.entries()) {
      const plate = normalizeRoomPlateItem(item, index);
      if (plate.entries.length > 0) data.roomPlates = mergeById(data.roomPlates, plate);
    }
    data.importedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, { ok: true, roomPlates: data.roomPlates || [], imported: incoming.length, deleted: deletedIds.size, total: (data.roomPlates || []).length });
  }

  if (pathname === "/api/sully/event-boxes" && req.method === "POST") {
    const body = await readBody(req);
    const incoming = Array.isArray(body) ? body : (body.eventBoxes || body.boxes || []);
    const deletedIds = new Set((body.deletedIds || []).map(String).filter(Boolean));
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    if (deletedIds.size) data.eventBoxes = (data.eventBoxes || []).filter((item) => !deletedIds.has(item.id));
    data.eventBoxes = mergeListByKey(data.eventBoxes || [], incoming.filter((item) => item?.id));
    data.importedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, { ok: true, imported: incoming.length, deleted: deletedIds.size, total: data.eventBoxes.length });
  }

  if (pathname === "/api/sully/anticipations" && req.method === "POST") {
    const body = await readBody(req);
    const incoming = Array.isArray(body) ? body : (body.anticipations || []);
    const deletedIds = new Set((body.deletedIds || []).map(String).filter(Boolean));
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    if (deletedIds.size) data.anticipations = (data.anticipations || []).filter((item) => !deletedIds.has(item.id));
    data.anticipations = mergeListByKey(data.anticipations || [], incoming.filter((item) => item?.id));
    data.importedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, { ok: true, imported: incoming.length, deleted: deletedIds.size, total: data.anticipations.length });
  }

  if (pathname === "/api/sully/digest-reports" && req.method === "POST") {
    const body = await readBody(req);
    const incoming = Array.isArray(body) ? body : (body.digestReports || body.reports || []);
    const deletedIds = new Set((body.deletedIds || []).map(String).filter(Boolean));
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    if (deletedIds.size) data.digestReports = (data.digestReports || []).filter((item) => !deletedIds.has(item.id));
    data.digestReports = mergeListByKey(data.digestReports || [], incoming.filter((item) => item?.id));
    data.importedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, { ok: true, imported: incoming.length, deleted: deletedIds.size, total: data.digestReports.length });
  }

  if (pathname === "/api/sully/memories" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const filters = {
      query: url.searchParams.get("q") || "",
      charId: url.searchParams.get("charId") || "",
      groupId: url.searchParams.get("groupId") || "",
      room: url.searchParams.get("room") || "",
      type: url.searchParams.get("type") || "",
      limit: Number(url.searchParams.get("limit") || 50),
    };
    const q = filters.query.trim().toLowerCase();
    const results = (data.memories || []).filter((item) => {
      if (filters.charId && item.charId !== filters.charId) return false;
      if (filters.groupId && item.groupId !== filters.groupId) return false;
      if (filters.room && item.room !== filters.room) return false;
      if (filters.type && filters.type !== "no_feel" && item.type !== filters.type) return false;
      if (filters.type === "no_feel" && item.type === "feel") return false;
      if (!q) return true;
      return [item.id, item.title, item.content, item.room, item.charId, item.groupId, item.mood, ...(item.tags || [])]
        .join(" ")
        .toLowerCase()
        .includes(q);
    }).slice(0, filters.limit).map(toBridgeMemory);
    return send(req, res, 200, { ok: true, results, total: results.length });
  }

  if (pathname === "/api/sully/memories" && req.method === "POST") {
    const body = await readBody(req);
    const deletedIds = new Set((body.deletedIds || []).map(String).filter(Boolean));
    if (deletedIds.size) {
      const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
      const protectedIds = new Set(
        (data.memories || [])
          .filter((item) => deletedIds.has(String(item.id || "")) && item.sourceAuthority === "memory_hub")
          .map((item) => String(item.id))
      );
      const effectiveDeletedIds = new Set([...deletedIds].filter((id) => !protectedIds.has(id)));
      const before = {
        memories: (data.memories || []).length,
        vectors: (data.vectors || []).length,
        links: (data.links || []).length,
      };
      data.memories = (data.memories || []).filter((item) => !effectiveDeletedIds.has(String(item.id || "")));
      data.vectors = (data.vectors || []).filter((item) => !effectiveDeletedIds.has(vectorKey(item)));
      data.links = (data.links || []).filter((item) => {
        const sourceId = String(item.sourceId || item.source || "");
        const targetId = String(item.targetId || item.target || "");
        return !effectiveDeletedIds.has(sourceId) && !effectiveDeletedIds.has(targetId);
      });
      data.eventBoxes = (data.eventBoxes || []).map((box) => ({
        ...box,
        memoryIds: (box.memoryIds || []).filter((id) => !effectiveDeletedIds.has(String(id))),
        liveMemoryIds: (box.liveMemoryIds || []).filter((id) => !effectiveDeletedIds.has(String(id))),
        archivedMemoryIds: (box.archivedMemoryIds || []).filter((id) => !effectiveDeletedIds.has(String(id))),
        summaryMemoryId: effectiveDeletedIds.has(String(box.summaryMemoryId || "")) ? undefined : box.summaryMemoryId,
      }));
      data.importedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
      return send(req, res, 200, {
        ok: true,
        deleted: {
          requested: deletedIds.size,
          protected: protectedIds.size,
          memories: before.memories - data.memories.length,
          vectors: before.vectors - data.vectors.length,
          links: before.links - data.links.length,
        },
      });
    }
    const incoming = normalizeBridgeMemory(body);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = await readJsonFile(DATA_FILE, DEMO_DATA);
    mergeModelConfigFromPayload(data, body);
    const previous = (data.memories || []).find((item) => item.id === incoming.memory.id);
    const hasExistingVector = (data.vectors || []).some((item) => vectorKey(item) === incoming.memory.id);
    const contentChanged = Boolean(previous && previous.content !== incoming.memory.content);
    const preserveVector = !incoming.vector && Boolean(previous) && !contentChanged && hasExistingVector;
    const memory = {
      ...incoming.memory,
      syncState: "synced",
      sourceAuthority: "sullyos",
      lastSeenInSullyAt: new Date().toISOString(),
      embedded: Boolean(incoming.vector || preserveVector),
      vectorRefresh: contentChanged,
    };
    data.memories = mergeById(data.memories, memory);
    let vectorized = { attempted: 0, stored: 0, skipped: 0, error: "" };
    let metadataSynced = 0;
    if (incoming.vector) {
      data.vectors = mergeById(data.vectors, incoming.vector);
      metadataSynced = syncVectorMetadata(data, [memory.id]);
    } else if (preserveVector) {
      metadataSynced = syncVectorMetadata(data, [memory.id]);
    } else {
      vectorized = await autoVectorizeMemories(settings, data, [memory], { skipDedup: false });
    }
    data.importedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, {
      ok: true,
      bucket_id: incoming.memory.id,
      sullyNodeId: incoming.memory.id,
      savedTo: "memory-hub",
      vectorized,
      metadataSynced,
      data: toBridgeMemory(incoming.memory),
    });
  }

  if ((pathname === "/api/maintenance/reindex-preview" || pathname === "/api/embedding/reindex") && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const result = await reindexHubVectors(settings, data, {
      ...body,
      dryRun: pathname === "/api/maintenance/reindex-preview" || Boolean(body.dryRun),
    });
    return send(req, res, 200, { action: pathname === "/api/embedding/reindex" ? "reindex" : "reindex-preview", ...result });
  }

  if (pathname === "/api/embedding/sync-metadata" && req.method === "POST") {
    const body = await readBody(req);
    const data = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const ids = Array.isArray(body.memoryIds) ? body.memoryIds.map(String).filter(Boolean) : [];
    const changed = syncVectorMetadata(data, ids);
    if (body.persist !== false && !body.data) {
      data.importedAt = new Date().toISOString();
      await writeJsonFile(DATA_FILE, data);
    }
    return send(req, res, 200, { ok: true, changed, scoped: ids.length });
  }

  if (pathname === "/api/maintenance/cleanup-orphans" && req.method === "POST") {
    const data = await readJsonFile(DATA_FILE, EMPTY_DATA);
    const memoryIds = new Set((data.memories || []).map((item) => item.id));
    const before = (data.vectors || []).length;
    data.vectors = (data.vectors || []).filter((item) => memoryIds.has(vectorKey(item)));
    data.importedAt = new Date().toISOString();
    await writeJsonFile(DATA_FILE, data);
    return send(req, res, 200, {
      ok: true,
      removed: before - data.vectors.length,
      remaining: data.vectors.length,
      data: lightHubData(data),
    });
  }

  if (pathname === "/api/state" && req.method === "POST") {
    const body = await readBody(req);
    const incoming = normalizeData(body.data || body);
    let data = incoming;
    if (!body.replace) {
      const existing = await readJsonFile(DATA_FILE, EMPTY_DATA, { allowCorruptFallback: true });
      const existingVectors = new Map((existing.vectors || []).map((item) => [vectorKey(item), item]).filter(([key]) => key));
      data = {
        ...incoming,
        links: Number(body.data?.totalLinks || 0) > (incoming.links || []).length ? (existing.links || []) : incoming.links,
        vectors: (incoming.vectors || []).map((item) => {
          if (vectorValues(item).length) return item;
          const stored = existingVectors.get(vectorKey(item));
          return stored ? { ...stored, ...item } : item;
        }),
      };
    }
    await writeJsonFile(DATA_FILE, data);
    return send(res, 200, { ok: true, data: lightHubData(data) });
  }

  if (pathname === "/api/import" && req.method === "POST") {
    const body = await readBody(req);
    const storedSettings = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...(body.settings || {}) };
    const incoming = normalizeData(body);
    const isSullyPalaceSnapshot = body?.type === "sully_memory_palace_export" && Array.isArray(body?.characters);
    let mirror = { data: EMPTY_DATA, deletedCharacterIds: [], deleted: {} };
    let data = incoming;
    if (isSullyPalaceSnapshot) {
      const currentData = await readJsonFile(DATA_FILE, EMPTY_DATA, { allowCorruptFallback: true });
      mirror = removeDeletedSullySnapshotEntities(currentData, incoming);
      data = mergeSullyIntoHub(mirror.data, incoming);
    }
    const metadataSynced = syncVectorMetadata(data);
    const vectorized = await autoVectorizePendingMemories(settings, data, { limit: body.vectorLimit || 25, skipDedup: false });
    await writeJsonFile(DATA_FILE, data);
    return send(res, 200, {
      ok: true,
      mirrorSync: isSullyPalaceSnapshot,
      deletedCharacterIds: mirror.deletedCharacterIds,
      deleted: mirror.deleted,
      data: lightHubData(data),
      vectorized,
      metadataSynced,
    });
  }

  if (pathname === "/api/sully/fetch" && req.method === "POST") {
    const current = await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    const requestBody = await readBody(req);
    const settings = { ...DEFAULT_SETTINGS, ...current, ...requestBody };
    const fetched = await fetchSullyExport(settings);
    const selectedData = selectSullyCharacter(fetched.data, requestBody.charId);
    const currentData = await readJsonFile(DATA_FILE, EMPTY_DATA, { allowCorruptFallback: true });
    const hub = requestBody.charId ? selectSullyCharacter(currentData, requestBody.charId) : currentData;
    const sully = normalizeData(selectedData);
    const domains = ["characters", "memories", "coreMemories", "vectors", "links", "roomPlates", "impressions", "eventBoxes", "anticipations", "digestReports"];
    const idOf = (item, index) => clean(item?.id || item?.characterId || item?.charId || item?.memoryId || item?.worldbookId || `${index}`);
    const preview = (source) => Object.fromEntries(domains.map((domain) => {
      const items = Array.isArray(source?.[domain]) ? source[domain] : [];
      return [domain, { count: items.length, hash: contentHash(items) }];
    }));
    const differences = Object.fromEntries(domains.map((domain) => {
      const hubItems = Array.isArray(hub?.[domain]) ? hub[domain] : [];
      const sullyItems = Array.isArray(sully?.[domain]) ? sully[domain] : [];
      const hubIds = new Set(hubItems.map(idOf));
      const sullyIds = new Set(sullyItems.map(idOf));
      return [domain, {
        onlyInHub: [...hubIds].filter((id) => !sullyIds.has(id)).slice(0, 200),
        onlyInSully: [...sullyIds].filter((id) => !hubIds.has(id)).slice(0, 200),
        sameCount: hubItems.length === sullyItems.length,
        sameHash: contentHash(hubItems) === contentHash(sullyItems),
      }];
    }));
    return send(res, 200, {
      ok: true,
      sourceUrl: fetched.url,
      mode: "ephemeral-compare",
      persisted: false,
      selectedCharId: requestBody.charId || "",
      hubPreview: preview(hub),
      sullyPreview: preview(sully),
      differences,
    });
  }

  if (pathname === "/api/ombre/sync" && req.method === "POST") {
    const body = await readBody(req);
    const settings = { ...DEFAULT_SETTINGS, ...(await readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS)), ...(body.settings || {}) };
    const hubData = body.data ? normalizeData(body.data) : await readJsonFile(DATA_FILE, EMPTY_DATA);
    const result = await syncToOmbre(settings, hubData, body);
    if (result.ok) {
      const syncedIds = new Set(result.results.filter((item) => item.ok).map((item) => item.id));
      hubData.memories = (hubData.memories || []).map((item) => syncedIds.has(item.id) ? { ...item, syncState: "synced" } : item);
      await writeJsonFile(DATA_FILE, hubData);
    }
    return send(res, result.ok ? 200 : 502, result);
  }

  return send(res, 404, { ok: false, error: "Not found" });
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const full = path.normalize(path.join(__dirname, safePath));
  if (!full.startsWith(__dirname)) return send(res, 403, "Forbidden");
  try {
    const body = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    const cacheableAsset = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico"].includes(ext);
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cacheableAsset ? "public, max-age=3600" : "no-store, no-cache, must-revalidate, proxy-revalidate",
    };
    if (!cacheableAsset) {
      headers.Pragma = "no-cache";
      headers.Expires = "0";
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    send(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) {
      return await handleApi(req, res, url.pathname);
    }
    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    if (error instanceof AuthorityError) {
      return send(req, res, error.status || 400, {
        ok: false,
        code: error.code,
        error: error.message,
        retryable: error.status >= 500,
        details: error.details,
      });
    }
    return send(res, 500, { ok: false, error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`Memory Hub running at http://${shownHost}:${PORT}`);
  if (PUBLIC_BASE_URL) console.log(`Public URL: ${PUBLIC_BASE_URL}`);
  if (HUB_TOKEN) console.log("API auth: enabled via MEMORY_HUB_TOKEN");
  console.log(`Runtime read mode: ${runtimeReadMode.status().effectiveMode} (configured: ${runtimeReadMode.status().configuredMode})`);
  console.log(`V2 native writes: ${RUNTIME_NATIVE_WRITES_ENABLED ? "enabled" : "disabled"}`);
  setTimeout(() => {
    backfillLatestActivityStates()
      .then((result) => console.log(`Activity state backfill: ${result.changed}/${result.characters} character snapshots updated`))
      .catch((error) => console.error("Activity state backfill failed:", error));
  }, 50).unref();
  runtimeReadMode.start();
  if (ACTION_RUNTIME_ENABLED) {
    const timer = setInterval(() => { runActionRuntimeTick().catch((error) => console.error("Action runtime tick failed:", error)); }, ACTION_RUNTIME_INTERVAL_MS);
    timer.unref();
    setTimeout(() => { runActionRuntimeTick().catch((error) => console.error("Initial action runtime tick failed:", error)); }, 100).unref();
    console.log(`Action runtime: enabled (${ACTION_RUNTIME_INTERVAL_MS} ms)`);
  } else {
    console.log("Action runtime: disabled");
  }
});
