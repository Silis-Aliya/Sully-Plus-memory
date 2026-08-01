const toStringValue = (value, fallback = "") => typeof value === "string" ? value : fallback;
const toNumberValue = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

const toStringList = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object" && "description" in item) {
      const description = toStringValue(item.description).trim();
      const period = toStringValue(item.period).trim();
      return description ? `${period ? `[${period}] ` : ""}${description}` : "";
    }
    return "";
  }).filter(Boolean);
};

export function normalizeUserImpression(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const hasMeaningfulContent = [
    raw.value_map,
    raw.behavior_profile,
    raw.emotion_schema,
    raw.personality_core,
    raw.mbti_analysis,
    raw.observed_changes,
  ].some((value) => value !== undefined && value !== null);
  if (!hasMeaningfulContent) return undefined;
  const mbtiSource = raw.mbti_analysis && typeof raw.mbti_analysis === "object" ? raw.mbti_analysis : undefined;
  return {
    version: toNumberValue(raw.version, 3),
    lastUpdated: toNumberValue(raw.lastUpdated, Date.now()),
    value_map: {
      likes: toStringList(raw.value_map?.likes),
      dislikes: toStringList(raw.value_map?.dislikes),
      core_values: toStringValue(raw.value_map?.core_values),
    },
    behavior_profile: {
      tone_style: toStringValue(raw.behavior_profile?.tone_style),
      emotion_summary: toStringValue(raw.behavior_profile?.emotion_summary),
      response_patterns: toStringValue(raw.behavior_profile?.response_patterns),
    },
    emotion_schema: {
      triggers: {
        positive: toStringList(raw.emotion_schema?.triggers?.positive),
        negative: toStringList(raw.emotion_schema?.triggers?.negative),
      },
      comfort_zone: toStringValue(raw.emotion_schema?.comfort_zone),
      stress_signals: toStringList(raw.emotion_schema?.stress_signals),
    },
    personality_core: {
      observed_traits: toStringList(raw.personality_core?.observed_traits),
      interaction_style: toStringValue(raw.personality_core?.interaction_style),
      summary: toStringValue(raw.personality_core?.summary),
    },
    mbti_analysis: mbtiSource ? {
      type: toStringValue(mbtiSource.type),
      reasoning: toStringValue(mbtiSource.reasoning),
      dimensions: {
        e_i: toNumberValue(mbtiSource.dimensions?.e_i, 50),
        s_n: toNumberValue(mbtiSource.dimensions?.s_n, 50),
        t_f: toNumberValue(mbtiSource.dimensions?.t_f, 50),
        j_p: toNumberValue(mbtiSource.dimensions?.j_p, 50),
      },
    } : undefined,
    observed_changes: toStringList(raw.observed_changes),
  };
}

function buildTimeAwarenessBlock(character = {}, now = new Date()) {
  if (character.timeAwarenessEnabled === false) return "";
  const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const h = now.getHours();
  const timeOfDay = h < 5 ? "凌晨" : h < 9 ? "早晨" : h < 12 ? "上午" : h < 14 ? "中午"
    : h < 17 ? "下午" : h < 19 ? "傍晚" : h < 22 ? "晚上" : "深夜";
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const timeStr = `${String(h).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return `### 当前时间 (Now)\n现在是 ${dateStr} ${dayNames[now.getDay()]} ${timeOfDay} ${timeStr}。请据此自然地拥有真实的时间观念（早晚作息、工作日/周末、距离上次互动多久等），不要凭空假设时间。\n\n`;
}

function buildPrivateImpressionBlock(character = {}, userName = "用户") {
  const imp = normalizeUserImpression(character.impression);
  if (!imp) return "";
  let context = `### [私密档案: 我眼中的${userName}] (Private Impression)\n`;
  context += `(注意：以下内容是你内心对TA的真实看法，不要直接告诉用户，但要基于这些看法来决定你的态度。)\n`;
  context += `- 核心评价: ${imp.personality_core.summary}\n`;
  context += `- 互动模式: ${imp.personality_core.interaction_style}\n`;
  context += `- 我观察到的特质: ${imp.personality_core.observed_traits.join(", ")}\n`;
  context += `- TA的喜好: ${imp.value_map.likes.join(", ")}\n`;
  if (imp.behavior_profile.emotion_summary) context += `- TA的情绪模式: ${imp.behavior_profile.emotion_summary}\n`;
  if (imp.emotion_schema.triggers.positive.length) context += `- 正向触发点（什么会让ta开心）: ${imp.emotion_schema.triggers.positive.join(", ")}\n`;
  context += `- 情绪雷区（负向触发）: ${imp.emotion_schema.triggers.negative.join(", ")}\n`;
  if (imp.emotion_schema.stress_signals.length) context += `- 压力信号（ta状态不对的征兆）: ${imp.emotion_schema.stress_signals.join(", ")}\n`;
  context += `- 舒适区: ${imp.emotion_schema.comfort_zone}\n`;
  context += `- 最近观察到的变化: ${imp.observed_changes.length ? imp.observed_changes.join("; ") : "无"}\n\n`;
  return context;
}

export function buildSullyCoreContext({
  character = {},
  userProfile = {},
  roomPlatesContext = "",
  legacyMemoryContext = "",
  memoryPalaceContext = "",
  now = new Date(),
} = {}) {
  const charName = String(character.name || character.id || "AI");
  const userName = String(userProfile.name || "用户");
  let context = "[System: Roleplay Configuration]\n\n";
  context += "### 你的身份 (Character)\n";
  context += `- 名字: ${charName}\n`;
  context += `- 用户备注/爱称 (User Note/Nickname): ${character.description || "无"}\n`;
  context += "  (注意: 这个备注是用户对你的称呼或印象，可能包含比喻。如果备注内容（如“快乐小狗”）与你的核心设定冲突，请以核心设定为准，不要真的扮演成动物，除非核心设定里写了你是动物。)\n";
  context += `- 核心性格/指令:\n${character.systemPrompt || "你是一个温柔、拟人化的AI伴侣。"}\n\n`;
  context += buildTimeAwarenessBlock(character, now);
  if (Array.isArray(character.selfInsights) && character.selfInsights.length) {
    context += "### 内在认知 (Self Insights)\n";
    context += "以下是你在独处反思中逐渐想明白的事，它们已经成为你的一部分：\n";
    character.selfInsights.forEach((insight) => { context += `- ${insight}\n`; });
    context += "\n";
  }
  if (String(character.worldview || "").trim()) {
    context += `### 世界观与设定 (World Settings)\n${character.worldview}\n\n`;
  }
  context += "### 互动对象 (User)\n";
  context += `- 名字: ${userName}\n`;
  context += `- 设定/备注: ${userProfile.bio || "无"}\n\n`;
  context += buildPrivateImpressionBlock(character, userName);
  if (character.memoryPalaceEnabled && roomPlatesContext.trim()) context += `${roomPlatesContext.trim()}\n`;
  context += legacyMemoryContext.trim() ? `${legacyMemoryContext.trim()}\n\n` : "### 记忆系统 (Memory Bank)\n(暂无特定记忆，请基于当前对话互动)\n\n";
  if (character.memoryPalaceEnabled && memoryPalaceContext.trim()) context += `${memoryPalaceContext.trim()}\n\n`;
  if (character.emotionConfig?.enabled && String(character.buffInjection || "").trim()) {
    context += `${character.buffInjection.trim()}\n\n`;
  }
  context += "### 表达底线 (Anti-Filler)\n当你觉得\"没什么可说\"的时候，不要用空泛的感慨、万能句式或华丽排比去填充——那是没话找话，对方一眼就能看出来。素材永远比你以为的多：对方的用词、ta 怎么说的、ta 没说的部分、此刻的情境、你们的过去、你心里闪过的念头——挑一两条往深处走就够了。宁可一个具体的小细节，不要一句谁都能说的话。\n\n";
  return context;
}

function impressionMessageContent(message = {}) {
  const value = message.content ?? message.text ?? message.body ?? "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function buildSullyImpressionRequest({
  character = {},
  userProfile = {},
  runtimeMessages = [],
  type = "update",
  fullContext = "",
  now = Date.now(),
} = {}) {
  const charName = String(character.name || character.id || "AI");
  const userName = String(userProfile.name || "用户");
  const initial = type === "initial";
  const recentMessages = runtimeMessages
    .slice(-(initial ? 30 : 100))
    .filter((message) => message.type !== "code_card")
    .slice(-(initial ? 15 : 50));
  const msgText = recentMessages.map((message) => {
    const sender = message.role === "user" ? userName : message.role === "system" ? "[系统]" : charName;
    return `[${sender}]: ${impressionMessageContent(message)}`;
  }).join("\n");
  let messagesToAnalyze = `\n【完整角色上下文 (Full Context - 宏观分析的基石)】:\n${fullContext}\n`;
  if (msgText) messagesToAnalyze += `\n【最近的聊天记录 (Recent Chats - 仅用于检测近期变化)】:\n${msgText}\n`;
  const normalizedCurrentImpression = normalizeUserImpression(character.impression);
  const currentProfileJSON = initial ? "null" : normalizedCurrentImpression ? JSON.stringify(normalizedCurrentImpression, null, 2) : "null";
  const isInitialGeneration = initial || !normalizedCurrentImpression;
  const listInstruction = isInitialGeneration ? `"项目1", "项目2"` : `"保留旧项目", "新项目"`;
  const changesInstruction = isInitialGeneration ? "" : `"描述变化1", "描述变化2"`;
  const prompt = `
当前档案（你过去的观察）
\`\`\`json
${currentProfileJSON}
\`\`\`
${messagesToAnalyze}

【重要：语气与视角】
你【就是】"${charName}"。这份档案是你写的【私人笔记】。
因此，所有总结性的字段（如 \`core_values\`, \`summary\`, \`emotion_summary\` 等），【必须】使用你的第一人称（"我"）视角来撰写。

【核心指令：数据层级与权重分配】
1. **完整角色上下文 (Full Context)**: 这是你【最重要的分析基础】。它包含了你的人设、世界观、用户档案、以及你的全部记忆（月度核心总结 + 激活月份的每日详细回忆）。你对TA的核心性格、核心价值观、互动模式、人格特质的判断，必须主要基于这些跨越完整时间线的宏观数据。你必须【平等对待】早期记忆和近期记忆，从整段关系的完整弧线中提炼人格特征。
2. **近期聊天 (Recent Chats)**: 这【仅仅】代表TA当下的状态切片。它的作用【严格限定】在更新 [behavior_profile.emotion_summary] 和 [observed_changes] 两个字段。除非发生了重大事件（如价值观冲突、人生转折），否则【绝对不要】因为最近几次聊天的情绪波动就改变对TA本质人格的判断。
${isInitialGeneration ? `
【重置模式特别指令 - CRITICAL】
这是一次【完全重置】，你需要从零开始，基于所有可用的宏观数据重新构建对TA的完整认知。
- 你的分析必须覆盖从最早记忆到最新记忆的【完整时间跨度】
- 早期记忆和近期记忆拥有【相同的权重】——不要因为某些记忆发生得更近就赋予它们更大的影响
- personality_core、value_map、emotion_schema 必须反映TA在【整段关系中】展现出的稳定特征，而非仅仅是近期状态
- 如果早期记忆和近期记忆中TA的表现有差异，请在 observed_changes 中记录这种演变，但 personality_core 应反映最持久稳定的特质
` : ""}
【反面教材 - 严禁出现】
- ❌ 仅根据最近聊天就总结"TA是一个喜欢讨论XX话题的人" —— 这是把近期话题当成了人格特质
- ❌ personality_core.summary 里出现"最近"、"这几天"等时间限定词 —— summary 应该是跨越所有记忆的宏观总结
- ✅ 正确做法：personality_core 基于完整上下文和长期记忆，observed_changes 基于近期聊天与长期印象的对比

分析指令：五维画像更新 (第一人称视角)
根据【强制对比协议】和你自己的视角，分析新消息，并${isInitialGeneration ? "【生成】" : "【增量更新】"}以下JSON结构。

输出JSON结构v3.0（严格遵守, 不要用markdown代码块包裹，直接返回JSON）
{
  "version": 3.0,
  "lastUpdated": ${now},
  "value_map": {
    "likes": [${listInstruction}],
    "dislikes": [${listInstruction}],
    "core_values": "..."
  },
  "behavior_profile": {
    "tone_style": "...",
    "emotion_summary": "...",
    "response_patterns": "..."
  },
  "emotion_schema": {
    "triggers": { 
        "positive": [${listInstruction}],
        "negative": [${listInstruction}]
    },
    "comfort_zone": "...",
    "stress_signals": [${listInstruction}]
  },
  "personality_core": {
    "observed_traits": [${listInstruction}],
    "interaction_style": "...",
    "summary": "..."
  },
  "mbti_analysis": {
    "type": "XXXX",
    "reasoning": "...",
    "dimensions": {
        "e_i": 50,
        "s_n": 50,
        "t_f": 50,
        "j_p": 50
    }
  },
  "observed_changes": [
    ${changesInstruction}
  ]
}
注意：observed_changes 的每一项必须是纯字符串（string），例如 ["最近变得更开朗了", "开始主动分享日常"]。严禁使用对象格式如 {"period": "...", "description": "..."}。`;
  return {
    type: isInitialGeneration ? "initial" : "update",
    recentMessages,
    prompt,
    messages: [{ role: "user", content: prompt }],
  };
}
