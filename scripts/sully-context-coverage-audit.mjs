import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextParity } from "../contextParity.mjs";

const hubRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sullyRoot = path.resolve(process.env.SULLYOS_ROOT || path.join(hubRoot, "..", "SullyOS-fork"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const normalizedFileHash = async (file) => sha256(await readFile(file));

const lockedSourceFiles = {
  "utils/context.ts": "7ce55124522a480670960d84ac819b642770098e9be2e42948f575bec8d0f0cf",
  "utils/worldbook.ts": "6f09e9e9df7e2dafd25566837b3723e306da0025a6830b91234ace8f06cf8fdd",
  "utils/chatPrompts.ts": "58a6560b05dfb360fd33ddaced159c7c6685942133c6e378bc6f5ff770b38eb5",
  "utils/chatRequestPayload.ts": "684b7ecd9a85be768fd94d8dc297ec867a2293d11cc9f1edaed32310f9048eab",
  "utils/scheduleInjection.ts": "5cb9b0c65ffe1f60c2e75c0e601f2f3dd910066d405cbbf0f24b0cd3a2649697",
  "utils/activeMsgClient.ts": "66c7c1a36726070601e089bcef3a2401612c0e1425ffb9e2aacfa4e5f41b5d7e",
  "utils/amsgFirePack.ts": "9bfa8d8e1084f73d5e110a572872b49a2aae13791e1370ea5d36adab437eda10",
  "utils/amsgFireScene.ts": "309f7e0004db669f448ba078c1f74da8ade2056bfeba21da24282462af2752bf",
  "utils/htmlPrompt.ts": "8afe47a46cf4975fa9890f6a1cc947c666a551d6216644f8f17941a463075608",
  "utils/thinkingChainPrompt.ts": "9cd4226fbee970cfd4a9a699e22adb713aae7d36621c9ad358a7e5e79622a80d",
  "utils/memoryPalace/extraction.ts": "be2d58c1160e662087f345c772bc9dc27282fb4f64c53b4a6e2777216ff68c02",
  "utils/memoryPalace/migration.ts": "5646600085478cced2ce5ccfa3f24af1bc000adc00eb65915afe87f8625af8f2",
  "utils/memoryPalace/externalMemory.ts": "0708eac229fe5ed93d6fb79e4ed4dd30be2e1f223be56c401ee30165aacdba8c",
  "utils/memoryPalace/eventBoxCompression.ts": "5643d82b1194ace788cffdb06bf6eb2d8ddb0b7bb3ba17e931e64091b557af4d",
  "utils/memoryPalace/roomPlates.ts": "ef351118429399a6bd2f64f5a0a77b37d344b5deb4527461c32e5ccdd75d9d2f",
  "utils/memoryPalace/digestion.ts": "156930ee12d33cb8315c6d3dbcc6a364a0cd3de607c08b5d24551bff030eaaac",
};

const markerChecks = [
  { domain: "stable", source: "utils/context.ts", marker: "buildCoreContext:", hub: "contextParity.mjs", hubMarker: "export function buildCoreContext" },
  { domain: "stable", source: "utils/worldbook.ts", marker: "injectWorldbookDepthEntries", hub: "contextParity.mjs", hubMarker: "export function injectWorldbookDepthEntries" },
  { domain: "chat-only", source: "utils/chatPrompts.ts", marker: "聊天 App 行为规范 (Chat App Rules)", hub: "sullyChatPrompt.mjs", hubMarker: "聊天 App 行为规范 (Chat App Rules)" },
  { domain: "chat-only", source: "utils/chatRequestPayload.ts", marker: "CRITICAL: 双语输出模式", disposition: "SullyOS ordinary-chat only" },
  { domain: "chat-only", source: "utils/htmlPrompt.ts", marker: "buildHtmlPrompt", disposition: "SullyOS ordinary-chat only" },
  { domain: "chat-only", source: "utils/thinkingChainPrompt.ts", marker: "buildThinkingChainPrompt", disposition: "SullyOS ordinary-chat only" },
  { domain: "volatile", source: "utils/scheduleInjection.ts", marker: "不是台词，不用说出口", hub: "sullyScheduleInjection.mjs", hubMarker: "不是台词，不用说出口" },
  { domain: "autonomy", source: "utils/amsgFirePack.ts", marker: "AMSG_SLOT_SELF_LOG", disposition: "Map to Hub incremental wake context; do not copy FirePack prompt" },
  { domain: "autonomy", source: "utils/amsgFirePack.ts", marker: "AMSG_SLOT_REALTIME_WORLD", disposition: "Missing Hub wake equivalent" },
  { domain: "autonomy", source: "utils/amsgFireScene.ts", marker: "renderFireSceneBlock", disposition: "Partially represented by Hub runtime state" },
  { domain: "memory", source: "utils/memoryPalace/extraction.ts", marker: "buildRelatedToRule", hub: "sullyMemoryPalacePrompts.mjs", hubMarker: "buildRelatedToRule" },
  { domain: "memory", source: "utils/memoryPalace/migration.ts", marker: "以下是你 ${monthKey} 这个月", hub: "sullyMemoryPalacePrompts.mjs", hubMarker: "以下是你 ${monthKey} 这个月" },
  { domain: "memory", source: "utils/memoryPalace/eventBoxCompression.ts", marker: "下面这些记忆都属于一件事", hub: "sullyMemoryPalacePrompts.mjs", hubMarker: "下面这些记忆都属于一件事" },
  { domain: "memory", source: "utils/memoryPalace/roomPlates.ts", marker: "与你朝夕相处的人", hub: "sullyMemoryPalacePrompts.mjs", hubMarker: "与你朝夕相处的人" },
  { domain: "memory", source: "utils/memoryPalace/digestion.ts", marker: "以下是你的核心人设", hub: "sullyMemoryPalacePrompts.mjs", hubMarker: "以下是你的核心人设" },
];

const sourceHashes = [];
for (const [relative, expected] of Object.entries(lockedSourceFiles)) {
  const absolute = path.join(sullyRoot, ...relative.split("/"));
  const actual = await normalizedFileHash(absolute).catch(() => "missing");
  sourceHashes.push({ file: relative, expected, actual, current: actual === expected });
}

const markerResults = [];
for (const check of markerChecks) {
  const sourceText = await readFile(path.join(sullyRoot, ...check.source.split("/")), "utf8").catch(() => "");
  let hubPresent = null;
  if (check.hub) {
    const hubText = await readFile(path.join(hubRoot, ...check.hub.split("/")), "utf8").catch(() => "");
    hubPresent = hubText.includes(check.hubMarker);
  }
  markerResults.push({ ...check, sourcePresent: sourceText.includes(check.marker), hubPresent });
}

const sourceAuthorityHashes = {
  "context-parity-p0": {
    stable: "df9c9c3c5338a8b7299343c2397732b472a92d21eb75966db1193735a2be0d6a",
    volatile: "d2108a25e07dea9599dea46c8d9aee666c10bb3fb202c051c1f9fe3eff850e6a",
    finalMessages: "ce3e32eb99871decc7fb50178632932d3cfec15b588c6b13a52f6f40b0ff0b4c",
  },
  "context-parity-gates": {
    stable: "9e1420e5cd362fc4e962c8c416192fe5a2e1f4ed2c00ae3342ace26c6f20d688",
    volatile: "dcfae1757455fd89e074e6a1c802c30e182cefb80755eac326e97a0e61c43826",
    finalMessages: "ff106a5ec8a651d36e3e3a8b6823127d5c8bd54a8abd6971cd2a8de9ddd26cc9",
  },
};

const crossParity = [];
for (const [fixtureName, expected] of Object.entries(sourceAuthorityHashes)) {
  const fixture = JSON.parse(await readFile(path.join(hubRoot, "fixtures", `${fixtureName}.json`), "utf8"));
  const actual = buildContextParity({ ...fixture, includeChatPrompt: false });
  const hashes = {
    stable: sha256(actual.stableSystemPrompt),
    volatile: sha256(actual.volatileContext),
    finalMessages: sha256(JSON.stringify(actual.finalMessages)),
  };
  crossParity.push({ fixture: fixtureName, expected, actual: hashes, exact: JSON.stringify(expected) === JSON.stringify(hashes) });
}

const promptCandidatePattern = /(systemPrompt|systemInstruction|baseSystemPrompt|contextPrompt|build[A-Za-z0-9_]*Prompt|prompt\s*[+:]?=|Prompt\s*=|generateContent\(|generateText\(|callAI\(|callLLM\(|chat\.completions)/;
async function walk(dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "coverage"].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) output.push(absolute);
  }
  return output;
}
const candidateFiles = [];
for (const absolute of await walk(sullyRoot)) {
  const text = await readFile(absolute, "utf8");
  if (promptCandidatePattern.test(text)) candidateFiles.push(path.relative(sullyRoot, absolute).replaceAll("\\", "/"));
}
const candidateGroups = candidateFiles.reduce((groups, file) => {
  const top = file.split("/")[0];
  groups[top] = (groups[top] || 0) + 1;
  return groups;
}, {});

const blockingGaps = [
  { id: "cc-chat-rules-in-stable", approvalRequired: true, detail: "CC CLAUDE.md currently receives SullyOS phone-chat rules because buildCcContextPackage uses buildContextParity with includeChatPrompt=true." },
  { id: "cc-authority-character-source", approvalRequired: false, detail: "CC stable assembly reads data.characters before the authoritative CharacterDefinition, so a newer authority edit can be missed." },
  { id: "cc-dynamic-worldbooks", approvalRequired: false, detail: "CC stable assembly passes messages:[]; keyword/probability worldbooks are neither stable nor delivered as a per-wake activated block." },
  { id: "cc-amsg2-runtime-signals", approvalRequired: false, detail: "Hub wake deltas cover messages/events/state/tasks/recall but do not yet provide all AMSG2 equivalents such as user clock, self-log semantics and realtime-world block." },
  { id: "cc-compact-detection", approvalRequired: false, detail: "The runner cannot yet reliably detect Claude Code internal compaction and force a role-context refresh." },
];

const failures = [
  ...sourceHashes.filter((item) => !item.current).map((item) => `source-hash:${item.file}`),
  ...markerResults.filter((item) => !item.sourcePresent || item.hubPresent === false).map((item) => `marker:${item.source}:${item.marker}`),
  ...crossParity.filter((item) => !item.exact).map((item) => `cross-parity:${item.fixture}`),
];

const report = {
  ok: failures.length === 0,
  auditedAt: new Date().toISOString(),
  sullyRoot,
  candidatePromptFiles: { count: candidateFiles.length, groups: candidateGroups },
  sourceHashes,
  markerResults,
  crossParity,
  blockingGaps,
  deploymentReadyForCc: false,
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
