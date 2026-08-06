import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
  EVENT_BOX_SUMMARY_TARGET_MAX_CHARS,
  EVENT_BOX_SUMMARY_TARGET_MIN_CHARS,
  PLATE_ENTRY_CAPS,
  PLATE_ENTRY_TARGET_CHARS,
  PLATE_TITLES,
  REFLECT_MAX_ASPIRES,
  REFLECT_MAX_DISTILLS,
  REFLECT_MAX_WORRIES,
  ROOM_RULES,
  VALID_ROOMS,
  buildCompressionSystemPrompt,
  buildDigestSystemPrompt,
  buildExternalMemoryPrompt,
  buildExtractionSystemPrompt,
  buildMigrationSystemPrompt,
  buildPersonalityStylePrompt,
  buildPlateSystemPrompt,
  buildRecompressSummaryPrompt,
  buildRelatedMemoriesBlock,
  buildRelatedToFormatHint,
  buildRelatedToRule,
  buildRulesBlock,
} from "../sullyMemoryPalacePrompts.mjs";

const hubRoot = resolve(import.meta.dirname, "..");
const sullyRoot = resolve(process.env.SULLYOS_ROOT || "D:\\SullyOS-fork");
const normalize = (value) => value.replace(/\r\n/g, "\n");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const read = (root, path) => normalize(readFileSync(resolve(root, path), "utf8"));

function templateAfter(source, anchor) {
  const anchorAt = source.indexOf(anchor);
  assert.notEqual(anchorAt, -1, `找不到 Prompt 锚点: ${anchor}`);
  const start = source.indexOf("`", anchorAt);
  assert.notEqual(start, -1, `锚点后找不到模板开始符: ${anchor}`);
  const skipQuoted = (at, quote) => {
    for (let i = at + 1; i < source.length; i += 1) {
      if (source[i] === "\\") i += 1;
      else if (source[i] === quote) return i + 1;
    }
    return source.length;
  };
  const scanExpression = (at) => {
    let depth = 1;
    for (let i = at; i < source.length;) {
      const ch = source[i];
      if (ch === "'" || ch === '"') { i = skipQuoted(i, ch); continue; }
      if (ch === "`") { i = scanTemplate(i) + 1; continue; }
      if (ch === "/" && source[i + 1] === "/") {
        i = source.indexOf("\n", i + 2); if (i < 0) return source.length; continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i = source.indexOf("*/", i + 2); if (i < 0) return source.length; i += 2; continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}" && --depth === 0) return i + 1;
      i += 1;
    }
    return source.length;
  };
  const scanTemplate = (at) => {
    for (let i = at + 1; i < source.length; i += 1) {
      if (source[i] === "\\") { i += 1; continue; }
      if (source[i] === "`") return i;
      if (source[i] === "$" && source[i + 1] === "{") i = scanExpression(i + 2) - 1;
    }
    return -1;
  };
  const end = scanTemplate(start);
  assert.notEqual(end, -1, `锚点后找不到模板结束符: ${anchor}`);
  return source.slice(start, end + 1);
}

const hub = read(hubRoot, "sullyMemoryPalacePrompts.mjs");
const sources = {
  extraction: read(sullyRoot, "utils/memoryPalace/extraction.ts"),
  migration: read(sullyRoot, "utils/memoryPalace/migration.ts"),
  external: read(sullyRoot, "utils/memoryPalace/externalMemory.ts"),
  compression: read(sullyRoot, "utils/memoryPalace/eventBoxCompression.ts"),
  plates: read(sullyRoot, "utils/memoryPalace/roomPlates.ts"),
  digestion: read(sullyRoot, "utils/memoryPalace/digestion.ts"),
};

const cases = [
  ["记忆提取规则", sources.extraction, "function buildRulesBlock", hub, "export function buildRulesBlock"],
  ["已有记忆区块", sources.extraction, "export function buildRelatedMemoriesBlock", hub, "export function buildRelatedMemoriesBlock"],
  ["事件盒关联规则", sources.extraction, "export function buildRelatedToRule", hub, "export function buildRelatedToRule"],
  ["事件盒输出字段", sources.extraction, "export function buildRelatedToFormatHint", hub, "export function buildRelatedToFormatHint"],
  ["Memory Palace 记忆提取", sources.extraction, "const systemPrompt = `你是 ${charName}。根据给定的对话内容", hub, "return `你是 ${charName}。根据给定的对话内容"],
  ["Memory Palace 月度迁移", sources.migration, "const systemPrompt = `你是 ${charName}。以下是你 ${monthKey}", hub, "return `你是 ${charName}。以下是你 ${monthKey}"],
  ["外部记忆导入", sources.external, "export function buildExternalMemoryPrompt", hub, "export function buildExternalMemoryPrompt"],
  ["事件盒压缩", sources.compression, "const systemPrompt = `你是 ${charName}。下面这些记忆都属于一件事", hub, "export function buildCompressionSystemPrompt"],
  ["事件盒二次压缩", sources.compression, "const systemPrompt = `你是 ${charName}。下面这段第一人称回忆写得太长", hub, "export function buildRecompressSummaryPrompt"],
  ["RoomPlate 整理", sources.plates, "const systemPrompt = `${identityContext", hub, "return `${identityContext"],
  ["认知消化", sources.digestion, "const systemPrompt = `你是 ${charName}。以下是你的核心人设", hub, "return `你是 ${charName}。以下是你的核心人设"],
  ["人格风格判断", sources.digestion, "const systemPrompt = `你是一个性格分析专家", hub, "export function buildPersonalityStylePrompt"],
];

const report = [];
const sourceTemplates = new Map();
for (const [name, sourceFile, sourceAnchor, hubFile, hubAnchor] of cases) {
  const original = templateAfter(sourceFile, sourceAnchor);
  const port = templateAfter(hubFile, hubAnchor);
  sourceTemplates.set(name, original);
  let firstDiff = -1;
  while (firstDiff < Math.min(original.length, port.length) && original[firstDiff + 1] === port[firstDiff + 1]) firstDiff += 1;
  firstDiff += 1;
  report.push({
    name,
    sourceHash: sha256(original),
    hubHash: sha256(port),
    exact: original === port,
    ...(original === port ? {} : {
      firstDiff,
      sourceNear: original.slice(Math.max(0, firstDiff - 70), firstDiff + 140),
      hubNear: port.slice(Math.max(0, firstDiff - 70), firstDiff + 140),
    }),
  });
}

const sourceLocks = {
  "记忆提取规则": "7bb220892a961b3a224f1ad2315cc0ac3f93efb64be77de2a759b8068c9c997f",
  "已有记忆区块": "eb5a76fe48212a7629c7b99ac97a2d9968977a1aaacb23eee4a4e56d88941cf0",
  "事件盒关联规则": "64059377bea353e5c2a50e7168a9518adc0b3ea2fddea6dee08ed3b1e82d8bf9",
  "事件盒输出字段": "2273e4f0116aece2d819529163e082bd8a64b45b9039834996cbf1dfc2290bea",
  "Memory Palace 记忆提取": "22319bd98ba8a6893b56f7e260b0c680c5eaf5921f8f815fd5460b3dcad273da",
  "Memory Palace 月度迁移": "de986918e0ba86050a0b2b14ef543b438d472c3ee5c8f259626315997bf2e085",
  "外部记忆导入": "d2451687bfc931802c78bffa4dc3415afa1a76a90006179f6f77f1a0a1a4d939",
  "事件盒压缩": "cdc785e4107f5bafbe7ac0a831c32626dbc7835a27108c97db0085698d39fbc4",
  "事件盒二次压缩": "b706df394b1e140d60b65ef66504e7c66372e42f098df224047c7b20ff5aaa48",
  "RoomPlate 整理": "81615c6ae3eb9e3b1d4f68cbde6e82f71c383baa7b3ede89dccc3d49f05bee16",
  "认知消化": "6667b9b43503d1214b3015c71bd440edc4721015b2edef6faaf1e52028bb8cf3",
  "人格风格判断": "4482beba6fc7eb9bb711ae3166c0bfa18a95ae3e8cdf654b7c01b01c6c7a194e",
};
for (const item of report) {
  assert.equal(item.sourceHash, sourceLocks[item.name], `SullyOS 原文已变化，必须人工确认后更新锁: ${item.name}`);
}

const render = (name, scope) => {
  const keys = Object.keys(scope);
  return Function(...keys, `"use strict"; return (${sourceTemplates.get(name)});`)(...keys.map((key) => scope[key]));
};
const rendered = [];
const verify = (name, original, port) => {
  rendered.push({ name, sourceHash: sha256(original), hubHash: sha256(port), exact: original === port });
  assert.equal(port, original, `Hub 最终渲染 Prompt 与 SullyOS 原文不一致: ${name}`);
};

const charName = "测试角色";
const userName = "测试用户";
const charContext = "角色设定正文";
const relatedMemories = [{ room: "study", content: "一起研究了测试方法" }];
const pinnedMemories = [{ content: "测试用户本周出差" }];
const userLabel = userName;
const contextBlock = `\n## 你的人设（供参考，帮助你理解对话中的关系和角色定位）\n${charContext}\n`;
const relatedBlock = buildRelatedMemoriesBlock(relatedMemories);
const relatedToRule = buildRelatedToRule();
const relatedToFormat = buildRelatedToFormatHint();
const pinnedBlock = `\n## 当前便利贴（如果对话内容表明某条便利贴已失效，在输出末尾用 unpin 标注）\nP0. ${pinnedMemories[0].content}\n`;
const unpinRule = `\n12. **便利贴摘除**（unpin，可选）：如果对话中明确提到某条便利贴描述的状态已结束（如"感冒好了""提前回来了""考试考完了"），在输出的 JSON 数组末尾加一条 {"unpin": "P0"} 来摘除它。只在对话明确提及时才摘除，不要猜测。`;

verify("已有记忆区块", render("已有记忆区块", { relatedMemories }), relatedBlock);
verify("Memory Palace 记忆提取", render("Memory Palace 记忆提取", {
  charName, contextBlock, relatedBlock, pinnedBlock, userLabel,
  buildRulesBlock, relatedToRule, unpinRule, relatedToFormat,
}), buildExtractionSystemPrompt({ charName, userName, charContext, relatedMemories, pinnedMemories }));
verify("Memory Palace 记忆提取（空可选块）", render("Memory Palace 记忆提取", {
  charName, contextBlock: "", relatedBlock: "", pinnedBlock: "", userLabel,
  buildRulesBlock, relatedToRule: "", unpinRule: "", relatedToFormat: "",
}), buildExtractionSystemPrompt({ charName, userName }));

const migrationContextBlock = `\n## 你的人设\n${charContext}\n`;
verify("Memory Palace 月度迁移", render("Memory Palace 月度迁移", {
  charName, monthKey: "2026-08", contextBlock: migrationContextBlock, relatedBlock,
  userLabel, relatedToRule, relatedToFormat,
}), buildMigrationSystemPrompt({ charName, monthKey: "2026-08", charContext, userName, relatedMemories }));
verify("Memory Palace 月度迁移（空可选块）", render("Memory Palace 月度迁移", {
  charName, monthKey: "2026-08", contextBlock: "", relatedBlock: "",
  userLabel, relatedToRule: "", relatedToFormat: "",
}), buildMigrationSystemPrompt({ charName, monthKey: "2026-08", userName }));

verify("外部记忆导入", render("外部记忆导入", { charName, userLabel }), buildExternalMemoryPrompt(charName, userName));
const box = { name: "测试事件" };
verify("事件盒压缩", render("事件盒压缩", {
  charName, box, userLabel, VALID_ROOMS,
  EVENT_BOX_SUMMARY_TARGET_MIN_CHARS, EVENT_BOX_SUMMARY_TARGET_MAX_CHARS, EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
}), buildCompressionSystemPrompt({ box, charName, userName }));
verify("事件盒二次压缩", render("事件盒二次压缩", { charName, targetMaxChars: 700 }), buildRecompressSummaryPrompt({ charName, targetMaxChars: 700 }));

const plates = ["user_room", "self_room", "bedroom", "study"].map((room) => ({ room, entries: [{ text: `${room}旧条目` }] }));
const materials = plates.map(({ room }) => ({ room, lines: [`${room}新材料`] }));
const prefixes = { user_room: "U", self_room: "R", bedroom: "B", study: "S" };
const materialByRoom = new Map(materials.map((item) => [item.room, item.lines]));
const roomBlocks = plates.map((plate) => {
  const title = plate.room === "user_room" ? `${userName}的事` : PLATE_TITLES[plate.room];
  const existingBlock = plate.entries.map((entry, index) => `[${prefixes[plate.room]}${index}] ${entry.text}`).join("\n");
  const materialBlock = materialByRoom.get(plate.room).map((line) => `- ${line}`).join("\n");
  return `## 门牌「${title}」(room: ${plate.room}，上限 ${PLATE_ENTRY_CAPS[plate.room]} 条)\n收录范围：${ROOM_RULES[plate.room]}\n\n现有条目：\n${existingBlock}\n\n新材料（最近的经历/结论，从中蒸馏值得常驻的认知）：\n${materialBlock}`;
}).join("\n\n");
const identityContext = "[角色身份]\n名字: 测试角色";
verify("RoomPlate 整理", render("RoomPlate 整理", {
  identityContext, charName, userName, PLATE_ENTRY_TARGET_CHARS, roomBlocks,
}), buildPlateSystemPrompt({ charName, userName, plates, materials, identityContext }));
const emptyPlates = [{ room: "study", entries: [] }];
const emptyMaterials = [{ room: "study", lines: [] }];
const emptyRoomBlocks = `## 门牌「${PLATE_TITLES.study}」(room: study，上限 ${PLATE_ENTRY_CAPS.study} 条)\n收录范围：${ROOM_RULES.study}\n\n现有条目：\n（还没有条目）\n\n新材料（最近的经历/结论，从中蒸馏值得常驻的认知）：\n（本轮没有新材料，仅整理现有条目）`;
verify("RoomPlate 整理（空可选块）", render("RoomPlate 整理", {
  identityContext: "", charName, userName, PLATE_ENTRY_TARGET_CHARS, roomBlocks: emptyRoomBlocks,
}), buildPlateSystemPrompt({ charName, userName, plates: emptyPlates, materials: emptyMaterials }));

const material = {
  atticNodes: [{ mood: "anxious", importance: 8, content: "尚未解决的困惑" }],
  anticipations: [{ status: "active", content: "共同完成目标" }],
  studyNodes: [{ accessCount: 3, content: "学会新的方法" }],
  userRoomNodes: [{ tags: ["家庭", "居住"], content: "用户的重要事实" }],
  selfRoomNodes: [{ tags: ["性格"], content: "角色的自我认识" }],
  recentEpisodes: [{ createdAt: new Date(2026, 7, 4, 12).getTime(), mood: "tender", content: "最近共同经历" }],
  recentContext: [],
};
const fmtDate = (timestamp) => { const date = new Date(timestamp); return `${date.getMonth() + 1}/${date.getDate()}`; };
verify("认知消化", render("认知消化", {
  charName, charPersona: "核心人设", material, userLabel, fmtDate,
  REFLECT_MAX_WORRIES, REFLECT_MAX_ASPIRES, REFLECT_MAX_DISTILLS,
}), buildDigestSystemPrompt({ charName, charPersona: "核心人设", material, userName }));
const fallbackMaterial = {
  atticNodes: [], anticipations: [], studyNodes: [], userRoomNodes: [], selfRoomNodes: [], recentEpisodes: [],
  recentContext: [{ room: "living_room", mood: "neutral", content: "普通近况" }],
};
verify("认知消化（最近上下文分支）", render("认知消化", {
  charName, charPersona: "核心人设", material: fallbackMaterial, userLabel, fmtDate,
  REFLECT_MAX_WORRIES, REFLECT_MAX_ASPIRES, REFLECT_MAX_DISTILLS,
}), buildDigestSystemPrompt({ charName, charPersona: "核心人设", material: fallbackMaterial, userName }));
verify("人格风格判断", render("人格风格判断", {
  charName, charPersona: "核心人设", memoryContext: "\n## 已有的记忆样本\n1. 测试记忆",
}), buildPersonalityStylePrompt({ charName, charPersona: "核心人设", memoryContext: "\n## 已有的记忆样本\n1. 测试记忆" }));

console.log(JSON.stringify({ ok: true, sullyRoot, sourceLocks, rendered }, null, 2));
