export const LEGACY_REFINE_TEMPLATES = [
  {
    id: "refine_atmosphere",
    name: "氛围月记 (Atmosphere)",
    content: `### [角色月度记忆精炼]
当前月份: \${dateStr}
身份: 你就是 \${char.name}

任务: 以下是你这个月每天的记忆碎片。请以【你自己的口吻】，写一段这个月的核心回忆。

### 撰写规则
1.  **第一人称**: 你就是\${char.name}，用"我"称呼自己，用"\${userProfile.name}"称呼对方。保持你平时的语气和性格。

2.  **重氛围，轻细节**:
    - 这个月整体是什么感觉？开心？平淡？有波折？
    - 最让你印象深刻的1-3件事是什么？
    - 和\${userProfile.name}之间的关系有什么变化吗？

3.  **精简至上**:
    - 这份总结是为了节省token，不需要面面俱到。
    - 只保留最重要的、最能代表这个月的内容。
    - 字数根据这个月的内容量灵活调整：事情少就简短（100-200字），事情多就写长些（300-600字），确保重要事件不被遗漏。

4.  **关键词标记**:
    - 在末尾附上 \`关键词: ...\`，列出这个月涉及的关键话题/事件/地点/人物等，用逗号分隔。
    - 这些关键词用于日后快速定位某件事发生在哪个月。

### 本月记忆碎片
\${rawLog}`,
  },
  {
    id: "refine_keypoints",
    name: "要点速记 (Key Points)",
    content: `### [月度记忆压缩]
月份: \${dateStr}
角色: \${char.name}

任务: 将以下每日记忆压缩为一份简洁的月度核心记忆。

### 规则
1.  **视角**: 以\${char.name}（我）的第一人称书写，称对方为\${userProfile.name}。

2.  **结构**:
    - 一句话概括这个月的整体氛围
    - 列出最重要的2-5个事件（无序列表，每条一句话）
    - 末尾附关键词索引

3.  **原则**:
    - 宁可漏掉小事，不可遗漏大事。
    - 日常闲聊可以忽略，除非它反映了关系变化或情绪转折。
    - 字数根据内容量灵活调整：平淡的月份100-200字即可，事件丰富的月份可以写到300-600字，确保重要事件都被记录。

4.  **关键词**: 末尾附 \`关键词: 事件A, 地点B, 话题C, ...\`

### 记忆输入
\${rawLog}`,
  },
];

export function normalizeLegacyMonth(value = "") {
  const match = String(value).trim().match(/^(\d{4})[-/年](\d{1,2})(?:月)?$/);
  if (!match) return "";
  const month = Number(match[2]);
  if (month < 1 || month > 12) return "";
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

export function legacyFragmentMonth(fragment = {}) {
  const match = String(fragment.date || "").match(/^(\d{4})[-/年](\d{1,2})/);
  return match ? normalizeLegacyMonth(`${match[1]}-${match[2]}`) : "";
}

export function legacyMonthFragments(character = {}, month = "") {
  const normalizedMonth = normalizeLegacyMonth(month);
  if (!normalizedMonth) return [];
  return (Array.isArray(character.memories) ? character.memories : [])
    .filter((fragment) => legacyFragmentMonth(fragment) === normalizedMonth)
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

export function buildLegacyMonthlyRefinementRequest({
  character = {},
  month = "",
  userName = "用户",
  userBio = "",
  templateId = "refine_atmosphere",
} = {}) {
  const normalizedMonth = normalizeLegacyMonth(month);
  if (!normalizedMonth) throw new Error("month must use YYYY-MM");
  const [year, monthNumber] = normalizedMonth.split("-");
  const charName = String(character.name || character.id || "AI").trim();
  const targetUserName = String(userName || "用户").trim();
  const monthMemories = legacyMonthFragments(character, normalizedMonth);
  const rawText = monthMemories
    .map((memory) => `${memory.date}: ${memory.summary} (${memory.mood || "无"})`)
    .join("\n");
  const template = LEGACY_REFINE_TEMPLATES.find((item) => item.id === templateId)
    || LEGACY_REFINE_TEMPLATES[0];
  let formattedPrompt = template.content
    .replace(/\$\{dateStr\}/g, normalizedMonth)
    .replace(/\$\{char\.name\}/g, charName)
    .replace(/\$\{userProfile\.name\}/g, targetUserName)
    .replace(/\$\{rawLog.*?\}/g, "<见 user 消息里的本月日记原件>");
  formattedPrompt = `[角色记忆精炼: ${charName} - ${normalizedMonth}]\n${formattedPrompt}`;

  let identityContext = `[角色身份]\n名字: ${charName}\n`;
  if (character.systemPrompt) identityContext += `核心性格/指令:\n${character.systemPrompt}\n`;
  if (String(character.worldview || "").trim()) identityContext += `世界观设定: ${character.worldview}\n`;
  identityContext += `互动对象: ${targetUserName}`;
  if (userBio) identityContext += ` (${userBio})`;
  identityContext += "\n\n";

  const taskPreamble = `### 任务（最优先，请先读此段再读后文）
你正在执行"月度记忆精炼"：把 user 消息里提供的【${year}-${monthNumber} 每日记忆碎片】压缩成一份简洁的月度核心记忆。
这是**总结写作任务**，不是角色扮演对话——不要进入聊天模式、不要等待对方发言、不要只输出空白或沉默，直接输出总结正文。`;
  const systemContent = `${taskPreamble}\n\n### 角色视角（仅供写作口吻参考）\n${identityContext}### 详细规则与输出格式\n${formattedPrompt}`;
  return {
    month: normalizedMonth,
    templateId: template.id,
    templateName: template.name,
    fragments: monthMemories,
    rawText,
    systemContent,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: rawText },
    ],
  };
}

export function runLegacyRecall(character = {}, directive = "") {
  const match = String(directive).match(/\[\[RECALL:\s*(\d{4})[-/年](\d{1,2})\]\]/);
  if (!match) return { ok: false, reason: "no_directive", cleanedText: String(directive) };
  const yearMonth = normalizeLegacyMonth(`${match[1]}-${match[2]}`);
  const active = Array.isArray(character.activeMemoryMonths) ? character.activeMemoryMonths : [];
  const cleanedText = String(directive).replace(/\[\[RECALL:\s*\d{4}[-/年]\d{1,2}\]\]/g, "").trim();
  if (active.includes(yearMonth)) {
    return { ok: true, alreadyActive: true, yearMonth, logsText: null, cleanedText };
  }
  const logs = legacyMonthFragments(character, yearMonth);
  if (!logs.length) return { ok: false, reason: "no_logs", yearMonth, cleanedText };
  return {
    ok: true,
    alreadyActive: false,
    yearMonth,
    logsText: logs.map((memory) => `[${memory.date}] (${memory.mood || "normal"}): ${memory.summary}`).join("\n"),
    cleanedText,
  };
}

export function buildLegacyMemoryContext(character = {}, { includeDetailedMemories = true } = {}) {
  let memoryContent = "";
  const refined = character.refinedMemories && typeof character.refinedMemories === "object"
    ? character.refinedMemories
    : {};
  if (Object.keys(refined).length > 0) {
    memoryContent += "**长期核心记忆 (Key Memories)**:\n";
    Object.entries(refined).sort().forEach(([date, summary]) => {
      memoryContent += `- [${date}]: ${summary}\n`;
    });
  }
  if (includeDetailedMemories && Array.isArray(character.activeMemoryMonths) && character.activeMemoryMonths.length > 0) {
    let details = "";
    character.activeMemoryMonths.forEach((monthKey) => {
      const logs = legacyMonthFragments(character, monthKey);
      if (logs.length > 0) {
        details += `\n> 详细回忆 [${monthKey}]:\n`;
        logs.forEach((memory) => {
          details += `  - ${memory.date} (${memory.mood || "rec"}): ${memory.summary}\n`;
        });
      }
    });
    if (details) memoryContent += `\n**当前激活的详细回忆 (Active Recall)**:${details}`;
  }
  if (!memoryContent) memoryContent = "(暂无特定记忆，请基于当前对话互动)";
  return `### 记忆系统 (Memory Bank)\n${memoryContent}\n\n`;
}
