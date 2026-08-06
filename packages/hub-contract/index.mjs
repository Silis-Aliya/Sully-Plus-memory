import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_PACKAGE_VERSION = "1.1.0";
export const PROTOCOL_VERSION = "1.0";
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION];

const schemaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "schemas");
const schemaFiles = {
  character: "character.schema.json",
  userProfile: "user-profile.schema.json",
  worldbook: "worldbook.schema.json",
  world: "world.schema.json",
  command: "command.schema.json",
  event: "event.schema.json",
  snapshot: "snapshot.schema.json",
  message: "message.schema.json",
  error: "error.schema.json",
};

export const schemas = Object.fromEntries(await Promise.all(
  Object.entries(schemaFiles).map(async ([name, file]) => [
    name,
    JSON.parse(await fs.readFile(path.join(schemaDir, file), "utf8")),
  ]),
));

export const contractManifest = {
  packageVersion: CONTRACT_PACKAGE_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  timeFormat: "UTC ISO-8601 date-time",
  deletionSemantics: "Omitted fields are unchanged; explicit field removal uses command.unset; entity deletion creates a tombstone with deletedAt.",
  idempotency: "A commandId is executed at most once and retries return the original result.",
  eventOrdering: "eventId is a monotonically increasing server sequence.",
  surfaceIsolation: "Chat, activity, world, state, memory, schedule, and system records are routed independently; only user-visible chat records enter chat context.",
  schemas: Object.entries(schemas).map(([name, schema]) => ({
    name,
    title: schema.title,
    id: schema.$id,
    endpoint: `/api/contracts/schemas/${name}`,
  })),
};

function matchesType(value, expected) {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === expected;
}

export function validateContract(name, value) {
  const schema = schemas[name];
  if (!schema) return { ok: false, errors: [{ path: "$", message: `Unknown schema: ${name}` }] };
  const errors = [];
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!allowedTypes.some((type) => matchesType(value, type))) {
    return { ok: false, errors: [{ path: "$", message: `Expected ${allowedTypes.join(" or ")}` }] };
  }
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push({ path: `$.${key}`, message: "Required field is missing" });
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) errors.push({ path: `$.${key}`, message: "Unknown field" });
    }
  }
  for (const [key, rule] of Object.entries(schema.properties || {})) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const field = value[key];
    const types = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : [];
    if (types.length && !types.some((type) => matchesType(field, type))) {
      errors.push({ path: `$.${key}`, message: `Expected ${types.join(" or ")}` });
      continue;
    }
    if (rule.const !== undefined && field !== rule.const) errors.push({ path: `$.${key}`, message: `Must equal ${JSON.stringify(rule.const)}` });
    if (rule.enum && !rule.enum.includes(field)) errors.push({ path: `$.${key}`, message: `Unsupported value: ${field}` });
    if (typeof field === "string" && rule.minLength && field.length < rule.minLength) errors.push({ path: `$.${key}`, message: `Minimum length is ${rule.minLength}` });
    if (typeof field === "string" && rule.pattern && !new RegExp(rule.pattern).test(field)) errors.push({ path: `$.${key}`, message: "Invalid format" });
    if (typeof field === "string" && rule.format === "date-time" && Number.isNaN(Date.parse(field))) errors.push({ path: `$.${key}`, message: "Expected ISO-8601 date-time" });
    if (typeof field === "number" && rule.minimum !== undefined && field < rule.minimum) errors.push({ path: `$.${key}`, message: `Minimum is ${rule.minimum}` });
    if (typeof field === "number" && rule.maximum !== undefined && field > rule.maximum) errors.push({ path: `$.${key}`, message: `Maximum is ${rule.maximum}` });
  }
  return { ok: errors.length === 0, errors };
}
