import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScheduleInjection, getFlowNarrativeKey, resolveScheduleSlots } from "../sullyScheduleInjection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sullyRoot = process.env.SULLYOS_ROOT || "D:\\SullyOS-fork";
const sourcePath = path.join(sullyRoot, "utils", "scheduleInjection.ts");
const source = await readFile(sourcePath);
const sourceHash = createHash("sha256").update(source).digest("hex");
assert.equal(sourceHash, "5cb9b0c65ffe1f60c2e75c0e601f2f3dd910066d405cbbf0f24b0cd3a2649697");

assert.equal(getFlowNarrativeKey(6), "morning");
assert.equal(getFlowNarrativeKey(14), "afternoon");
assert.equal(getFlowNarrativeKey(22), "evening");

const schedule = {
  slots: [
    { startTime: "08:00", activity: "画画", location: "工作室", innerThought: "颜色比预想中安静。" },
    { startTime: "12:00", activity: "吃午饭", location: "厨房" },
  ],
};
const now = new Date(2026, 7, 5, 10, 30, 0);
assert.equal(resolveScheduleSlots(schedule, now).current.activity, "画画");
assert.equal(resolveScheduleSlots(schedule, now).next.activity, "吃午饭");
assert.equal(buildScheduleInjection(schedule, undefined, now), [
  "当前时段：08:00 你正在画画（工作室）",
  "之后安排：12:00 吃午饭",
  "此刻你的心中盘旋着这些想法……",
  "颜色比预想中安静。",
  "（不是台词，不用说出口——让它影响你的语气和情绪就好。）",
  "",
].join("\n"));

assert.equal(buildScheduleInjection(schedule, "刚才那一笔还留在心里。", now).includes("颜色比预想中安静。"), false);
assert.equal(buildScheduleInjection(schedule, "刚才那一笔还留在心里。", now).includes("刚才那一笔还留在心里。"), true);

const preDawn = buildScheduleInjection({ slots: [{ startTime: "08:00", activity: "起床" }] }, undefined, new Date(2026, 7, 5, 1, 0, 0));
assert.equal(preDawn, "夜深了，今天的安排还没开始，最早的一件是起床（08:00）\n\n");

console.log(JSON.stringify({ ok: true, source: path.relative(root, sourcePath), sourceHash }));
