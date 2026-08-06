import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  contractManifest,
  schemas,
  validateContract,
} from "../packages/hub-contract/index.mjs";

assert.equal(PROTOCOL_VERSION, "1.0");
assert.equal(contractManifest.schemas.length, 9);
assert.deepEqual(Object.keys(schemas).sort(), ["character", "command", "error", "event", "message", "snapshot", "userProfile", "world", "worldbook"]);

assert.equal(validateContract("message", {
  id: 1,
  charId: "char-1",
  sourceId: "source-1",
  role: "assistant",
  type: "text",
  content: "hello",
  timestamp: 1785900000000,
  surface: "chat",
  visibility: "user",
  conversationId: "direct:me:char-1",
  origin: "character",
  metadata: {},
}).ok, true);

const validCommand = {
  commandId: "cmd-00000001",
  type: "chat.send",
  actorId: "user-1",
  characterId: "char-1",
  expectedVersion: 42,
  issuedAt: "2026-08-03T12:30:00.000Z",
  protocolVersion: "1.0",
  payload: { text: "hello" },
};
assert.deepEqual(validateContract("command", validCommand), { ok: true, errors: [] });

const missingId = validateContract("command", { ...validCommand, commandId: undefined });
assert.equal(missingId.ok, false);

const unknownField = validateContract("command", { ...validCommand, accidentalField: true });
assert.equal(unknownField.ok, false);
assert.equal(unknownField.errors.some((item) => item.path === "$.accidentalField"), true);

const validCharacter = validateContract("character", {
  characterId: "char-1",
  name: "Sully",
  version: 1,
  updatedAt: "2026-08-03T12:30:00.000Z",
});
assert.equal(validCharacter.ok, true);

console.log(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION, schemas: contractManifest.schemas.length }));
