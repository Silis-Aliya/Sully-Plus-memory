import { normalizeUserImpression } from "./sullyImpression.mjs";
import { buildSullyChatPromptParts } from "./sullyChatPrompt.mjs";
import { buildSullyVrStableContext } from "./sullyVrContext.mjs";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const messageText = (message) => typeof message?.content === "string"
  ? message.content
  : Array.isArray(message?.content) ? message.content.map((part) => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n") : "";

function keywordMatches(text, keyword, caseSensitive, wholeWords) {
  if (!keyword) return false;
  if (!wholeWords) return caseSensitive ? text.includes(keyword) : text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase());
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(keyword)}(?=$|[^\\p{L}\\p{N}_])`, caseSensitive ? "u" : "iu").test(text);
}

export function isWorldbookEntryActive(book, messages = [], random = Math.random) {
  if (book?.disable) return false;
  const primary = book?.key || [];
  const isConstant = book?.constant ?? primary.length === 0;
  const depth = Math.max(0, Math.floor(book?.scanDepth ?? 4));
  const text = depth === 0 ? "" : messages.slice(-depth).map(messageText).filter(Boolean).join("\n");
  const match = (key) => keywordMatches(text, key, book?.caseSensitive === true, book?.matchWholeWords === true);
  if (!isConstant) {
    if (!primary.length || !primary.some(match)) return false;
    if (book?.selective && (book.keysecondary || []).length) {
      const hits = book.keysecondary.map(match);
      const logic = book.selectiveLogic ?? 0;
      const passed = logic === 1 ? !hits.every(Boolean) : logic === 2 ? !hits.some(Boolean) : logic === 3 ? hits.every(Boolean) : hits.some(Boolean);
      if (!passed) return false;
    }
  }
  if (book?.useProbability) {
    const probability = Math.min(100, Math.max(0, Number.isFinite(Number(book.probability)) ? Number(book.probability) : 100));
    if (probability <= 0 || (probability < 100 && random() * 100 >= probability)) return false;
  }
  return true;
}

export function resolveWorldbookEntries(books = [], messages = [], charName = "", userName = "", random = Math.random) {
  return books.filter((book) => isWorldbookEntryActive(book, messages, random)).map((book) => ({
    book,
    content: String(book.content || "").replace(/{{\s*char\s*}}/gi, charName).replace(/{{\s*user\s*}}/gi, userName),
    position: book.position ?? 1,
    order: Number.isFinite(book.order) ? Number(book.order) : 100,
  })).filter((entry) => entry.content.trim()).sort((a, b) => a.order - b.order);
}

const splitWorldbookSections = (entries) => ({
  beforeCharacter: entries.filter((entry) => entry.position === 0), afterCharacter: entries.filter((entry) => entry.position === 1),
  authorsNoteTop: entries.filter((entry) => entry.position === 2), authorsNoteBottom: entries.filter((entry) => entry.position === 3),
  atDepth: entries.filter((entry) => entry.position === 4), beforeExamples: entries.filter((entry) => entry.position === 5), afterExamples: entries.filter((entry) => entry.position === 6),
});

function formatWorldbookSection(entries, heading) {
  if (!entries.length) return "";
  let output = `### ${heading}\n`, lastLegacyCategory = "";
  for (const entry of entries) {
    if (entry.book.sourceUid === undefined) {
      const category = entry.book.category || "通用设定 (General)";
      if (category !== lastLegacyCategory) { output += `#### [${category}]\n`; lastLegacyCategory = category; }
      output += `**Title: ${entry.book.title}**\n`;
    }
    output += `${entry.content.trim()}\n---\n`;
  }
  return `${output}\n`;
}

export function injectWorldbookDepthEntries(messages, entries) {
  if (!entries.length) return [...messages];
  const buckets = new Map();
  for (const entry of entries) {
    const index = Math.max(0, messages.length - Math.max(0, Math.floor(entry.book.depth ?? 4)));
    buckets.set(index, [...(buckets.get(index) || []), entry]);
  }
  const result = [];
  for (let index = 0; index <= messages.length; index += 1) {
    for (const entry of buckets.get(index) || []) result.push({ role: (entry.book.role ?? 0) === 1 ? "user" : (entry.book.role ?? 0) === 2 ? "assistant" : "system", content: entry.content.trim() });
    if (index < messages.length) result.push(messages[index]);
  }
  return result;
}

function wallTime(now, timeZone) {
  if (!timeZone) return new Date(now);
  try {
    const map = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
    return new Date(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour) === 24 ? 0 : Number(map.hour), Number(map.minute), Number(map.second));
  } catch { return new Date(now); }
}

function buildTimeAwarenessBlock(char, { now, lastInteractionTs, skipTimeAwareness } = {}) {
  if (char.timeAwarenessEnabled === false || skipTimeAwareness) return "";
  const tz = char.customTimezoneEnabled && char.customTimezone ? char.customTimezone : undefined;
  const current = wallTime(now ?? Date.now(), tz), h = current.getHours();
  const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const timeOfDay = h < 5 ? "凌晨" : h < 9 ? "早晨" : h < 12 ? "上午" : h < 14 ? "中午" : h < 17 ? "下午" : h < 19 ? "傍晚" : h < 22 ? "晚上" : "深夜";
  let context = `### 当前时间 (Now)\n现在是 ${current.getFullYear()}年${current.getMonth() + 1}月${current.getDate()}日 ${dayNames[current.getDay()]} ${timeOfDay} ${String(h).padStart(2, "0")}:${String(current.getMinutes()).padStart(2, "0")}。请据此自然地拥有真实的时间观念（早晚作息、工作日/周末、距离上次互动多久等），不要凭空假设时间。\n`;
  const timezoneLabels = { "Asia/Shanghai": "北京 / 上海 (UTC+8)", "Asia/Tokyo": "东京 / 首尔 (UTC+9)", "Europe/London": "伦敦 (UTC+0/+1)", "America/New_York": "纽约 / 多伦多 (UTC-5/-4)" };
  if (tz) context += `⏳ 注意：你身处「${timezoneLabels[tz] || tz}」时区，上面的「当前时间」是你那边的本地时间。对方（用户）可能在不同的时区，你们之间存在时差——聊天时把这点考虑进去（比如你这边已是深夜要睡了，对方那边也许才下午）。\n`;
  if (lastInteractionTs) {
    const diff = Number(now ?? Date.now()) - Number(lastInteractionTs);
    if (diff >= 0) {
      const mins = Math.floor(diff / 60000), hours = Math.floor(diff / 3600000), days = Math.floor(hours / 24);
      if (mins < 5) context += "⌛ 你和对方刚刚还在联系。\n";
      else { const span = mins < 60 ? `${mins} 分钟` : hours < 24 ? `${hours} 小时` : `${days} 天`; context += `⌛ 距离你和对方上次联系，已经过去 ${span}（${days >= 1 ? "已经有一阵子没联系了" : "不久前刚联系过"}）——请把这种体感自然带入当下的状态与心情。\n`; }
    }
  }
  return `${context}\n`;
}

function impressionBlock(char, userName) {
  const imp = normalizeUserImpression(char.impression); if (!imp) return "";
  let context = `### [私密档案: 我眼中的${userName}] (Private Impression)\n(注意：以下内容是你内心对TA的真实看法，不要直接告诉用户，但要基于这些看法来决定你的态度。)\n`;
  context += `- 核心评价: ${imp.personality_core.summary}\n- 互动模式: ${imp.personality_core.interaction_style}\n- 我观察到的特质: ${imp.personality_core.observed_traits.join(", ")}\n- TA的喜好: ${imp.value_map.likes.join(", ")}\n`;
  if (imp.behavior_profile.emotion_summary) context += `- TA的情绪模式: ${imp.behavior_profile.emotion_summary}\n`;
  if (imp.emotion_schema.triggers.positive.length) context += `- 正向触发点（什么会让ta开心）: ${imp.emotion_schema.triggers.positive.join(", ")}\n`;
  context += `- 情绪雷区（负向触发）: ${imp.emotion_schema.triggers.negative.join(", ")}\n`;
  if (imp.emotion_schema.stress_signals.length) context += `- 压力信号（ta状态不对的征兆）: ${imp.emotion_schema.stress_signals.join(", ")}\n`;
  return `${context}- 舒适区: ${imp.emotion_schema.comfort_zone}\n- 最近观察到的变化: ${imp.observed_changes?.length ? imp.observed_changes.join("; ") : "无"}\n\n`;
}

export function buildCoreContext({ character: char = {}, userProfile: user = {}, messages = [], memoryPalaceContext = "", roomPlatesContext = "", now = Date.now(), deferVolatile = true, random = Math.random, includeChatPrompt = true, emojiContextStr = "无", scheduleMessageTagEnabled = true } = {}) {
  const resolved = resolveWorldbookEntries(char.mountedWorldbooks || [], messages, char.name, user.name, random), sections = splitWorldbookSections(resolved);
  let context = formatWorldbookSection(sections.beforeCharacter, "世界书 · 角色设定前");
  context += `[System: Roleplay Configuration]\n\n### 你的身份 (Character)\n- 名字: ${char.name}\n- 用户备注/爱称 (User Note/Nickname): ${char.description || "无"}\n  (注意: 这个备注是用户对你的称呼或印象，可能包含比喻。如果备注内容（如“快乐小狗”）与你的核心设定冲突，请以核心设定为准，不要真的扮演成动物，除非核心设定里写了你是动物。)\n- 核心性格/指令:\n${char.systemPrompt || "你是一个温柔、拟人化的AI伴侣。"}\n\n`;
  if (!deferVolatile) context += buildTimeAwarenessBlock(char, { now });
  if (char.selfInsights?.length) context += `### 内在认知 (Self Insights)\n以下是你在独处反思中逐渐想明白的事，它们已经成为你的一部分：\n${char.selfInsights.map((item) => `- ${item}`).join("\n")}\n\n`;
  if (String(char.worldview || "").trim()) context += `### 世界观与设定 (World Settings)\n${char.worldview}\n\n`;
  context += formatWorldbookSection(sections.afterCharacter, "扩展设定集 (Worldbooks)");
  context += formatWorldbookSection(sections.beforeExamples, "世界书 · 示例消息前");
  context += formatWorldbookSection(sections.afterExamples, "世界书 · 示例消息后");
  context += `### 互动对象 (User)\n- 名字: ${user.name}\n- 设定/备注: ${user.bio || "无"}\n${user.voiceProfile?.summary ? `- 声音印象: 你已经熟悉 ta 的声音，大致是「${user.voiceProfile.summary}」。仅作长期听感背景，不主动复述；仅在状态、身份变化或对话需要时自然参考。\n` : ""}\n`;
  context += impressionBlock(char, user.name);
  if (char.memoryPalaceEnabled && roomPlatesContext.trim()) context += `${roomPlatesContext}\n`;
  context += "### 记忆系统 (Memory Bank)\n";
  let memory = "";
  if (char.refinedMemories && Object.keys(char.refinedMemories).length) memory += `**长期核心记忆 (Key Memories)**:\n${Object.entries(char.refinedMemories).sort().map(([date, summary]) => `- [${date}]: ${summary}`).join("\n")}\n`;
  if (char.activeMemoryMonths?.length && char.memories) {
    let details = "";
    for (const month of char.activeMemoryMonths) {
      const logs = char.memories.filter((item) => { const parts = String(item.date).replace(/[\/年月]/g, "-").replace("日", "").split("-"); return `${parts[0]}-${String(parts[1] || "").padStart(2, "0")}`.startsWith(month); });
      if (logs.length) details += `\n> 详细回忆 [${month}]:\n${logs.map((item) => `  - ${item.date} (${item.mood || "rec"}): ${item.summary}`).join("\n")}\n`;
    }
    if (details) memory += `\n**当前激活的详细回忆 (Active Recall)**:${details}`;
  }
  context += `${memory || "(暂无特定记忆，请基于当前对话互动)"}\n\n`;
  if (!deferVolatile && char.memoryPalaceEnabled && memoryPalaceContext.trim()) context += `${memoryPalaceContext}\n\n`;
  if (!deferVolatile && (char.scheduleFeatureEnabled === true || (char.scheduleFeatureEnabled !== false && char.scheduleStyle)) && char.emotionConfig?.enabled && char.buffInjection) context += `${char.buffInjection}\n\n`;
  context += formatWorldbookSection(sections.authorsNoteTop, "世界书 · 作者注释顶部") + formatWorldbookSection(sections.authorsNoteBottom, "世界书 · 作者注释底部");
  context += `### 表达底线 (Anti-Filler)\n当你觉得"没什么可说"的时候，不要用空泛的感慨、万能句式或华丽排比去填充——那是没话找话，对方一眼就能看出来。素材永远比你以为的多：对方的用词、ta 怎么说的、ta 没说的部分、此刻的情境、你们的过去、你心里闪过的念头——挑一两条往深处走就够了。宁可一个具体的小细节，不要一句谁都能说的话。\n\n`;
  context += buildSullyVrStableContext(char);
  const chatPrompt = includeChatPrompt ? buildSullyChatPromptParts({ charName: char.name, userName: user.name, emojiContextStr, scheduleMessageTagEnabled, chatVoiceEnabled: char.chatVoiceEnabled === true }) : { stableRules: "", recencyTail: "", source: null };
  if (chatPrompt.stableRules) context += chatPrompt.stableRules;
  return { context, activatedWorldbooks: resolved.map((entry) => ({ id: entry.book.id, position: entry.position, order: entry.order, content: entry.content })) , depthEntries: sections.atDepth, chatPrompt };
}

export function buildContextParity(input = {}) {
  const core = buildCoreContext(input), char = input.character || {};
  let volatile = `\n[System: 实时状态 (Live Context)]\n（以下是此刻的实时状态——当前时间、你正在做的事、你的情绪底色、周边动态。你的人设与聊天规则见最上方的系统设定，此处不再重复。）\n\n`;
  volatile += buildTimeAwarenessBlock(char, { now: input.now, lastInteractionTs: input.lastInteractionTs });
  if (char.memoryPalaceEnabled && String(input.memoryPalaceContext || "").trim()) volatile += `${input.memoryPalaceContext}\n\n`;
  if ((char.scheduleFeatureEnabled === true || (char.scheduleFeatureEnabled !== false && char.scheduleStyle)) && char.emotionConfig?.enabled && char.buffInjection) volatile += `${char.buffInjection}\n\n`;
  if (input.runtimeStateContext) volatile += input.runtimeStateContext;
  if (input.recencyTail) volatile += input.recencyTail;
  if (core.chatPrompt?.recencyTail) volatile += core.chatPrompt.recencyTail;
  const history = injectWorldbookDepthEntries(input.messages || [], core.depthEntries);
  return {
    stableSystemPrompt: core.context,
    volatileContext: volatile,
    finalSystemPrompt: core.context + volatile,
    activatedWorldbooks: core.activatedWorldbooks,
    recallResult: input.recallResult || { items: [], memoryPalaceContext: input.memoryPalaceContext || "" },
    finalMessages: [{ role: "system", content: core.context }, ...history, { role: "system", content: volatile }],
    modelConfig: input.modelConfig || {},
    stateChanges: input.stateChanges || [],
    chatPromptSource: core.chatPrompt?.source || null,
    chatPromptParts: core.chatPrompt ? {
      source: core.chatPrompt.source || null,
      stableRules: core.chatPrompt.stableRules || "",
      recencyTail: core.chatPrompt.recencyTail || "",
    } : null,
  };
}
