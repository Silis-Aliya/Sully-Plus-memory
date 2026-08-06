import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SULLY_VR_CONTEXT_SOURCE,
  buildSullyVrStableContext,
  formatSullyVrCardMessage,
} from "../sullyVrContext.mjs";

const source = await readFile("D:\\SullyOS-fork\\utils\\chatPrompts.ts", "utf8");
const stable = buildSullyVrStableContext({ vrState: { enabled: true } });
const stableBody = stable.trim();
assert.equal(source.replace(/\r\n/g, "\n").includes(stableBody), true, "SullyOS 《彼方》 stable prompt source drifted");
assert.equal(buildSullyVrStableContext({ vrState: { enabled: false } }), "");

const message = {
  id: 7,
  role: "assistant",
  type: "vr_card",
  timestamp: Date.UTC(2026, 7, 5, 12, 34, 0),
  content: "「彼方 · 娱乐室」\n在街机旁边停了一会儿。",
};
const enabled = formatSullyVrCardMessage(message, { vrState: { enabled: true }, customTimezoneEnabled: true, customTimezone: "Europe/London" });
assert.equal(enabled.content, "[2026-08-05 13:34]（你在《彼方》里的动态）\n「彼方 · 娱乐室」\n在街机旁边停了一会儿。");
assert.equal(source.includes("`${timeStr}（你在《彼方》里的动态）\\n${body}`"), true, "SullyOS vr_card enabled wrapper source drifted");

const disabled = formatSullyVrCardMessage(message, { vrState: { enabled: false }, customTimezoneEnabled: true, customTimezone: "Europe/London" });
assert.equal(disabled.content, "[2026-08-05 13:34]（系统记录：这是你之前自己进入 VR 社交游戏《彼方》(功能上类似 VRChat) 时留下的动态——你确实进入并参与了这款游戏，只是事情发生在游戏世界里。聊到时就当成\"我在《彼方》里做过的事\"来讲，别说成现实里发生的经历。）\n「彼方 · 娱乐室」\n在街机旁边停了一会儿。");
assert.equal(source.includes("这是你之前自己进入 VR 社交游戏《彼方》(功能上类似 VRChat) 时留下的动态"), true, "SullyOS vr_card fallback wrapper source drifted");

console.log(JSON.stringify({ ok: true, source: SULLY_VR_CONTEXT_SOURCE }));
