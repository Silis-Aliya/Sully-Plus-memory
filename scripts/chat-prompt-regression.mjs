import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildSullyChatPromptParts, SULLY_CHAT_PROMPT_SOURCE } from "../sullyChatPrompt.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const parts = buildSullyChatPromptParts({
  charName: "test-char",
  userName: "test-user",
  emojiContextStr: "none",
  scheduleMessageTagEnabled: true,
  chatVoiceEnabled: true,
});

// These hashes were produced after rendering the corresponding SullyOS source
// template with the same inputs and comparing both strings character-for-character.
assert.equal(sha256(parts.stableRules), "277ac5a7ea4747d5ba347f8dfce7e4a3dea11515b538ba0ccb3b87338f7f0a95");
assert.equal(sha256(parts.recencyTail), "19ce49c3a860dc5ad87719153af9e5a2d69b08dd508ac47c7ba30ac0757fa8f0");
assert.equal(parts.source, SULLY_CHAT_PROMPT_SOURCE);
assert.ok(parts.stableRules.includes("### 聊天 App 行为规范 (Chat App Rules)"));
assert.ok(parts.recencyTail.endsWith("从 test-char 心里自然冒出来的。"));

const voiceOff = buildSullyChatPromptParts({ charName: "test-char", userName: "test-user", chatVoiceEnabled: false });
assert.ok(voiceOff.stableRules.includes("语音消息功能当前未开启"));

console.log(JSON.stringify({ ok: true, source: parts.source, stableHash: sha256(parts.stableRules), recencyHash: sha256(parts.recencyTail) }));
