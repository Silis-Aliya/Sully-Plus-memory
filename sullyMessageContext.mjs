// Message-to-model adapters ported from SullyOS chat history assembly.
// Source: D:/SullyOS-fork/utils/chatPrompts.ts (formatDate + xhs_card branch).
// Stored messages remain untouched; this module only creates model-facing views.

function wallDate(timestamp, timeZone = "") {
  const base = new Date(Number(timestamp) || Date.now());
  if (!timeZone) return base;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(base);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    let hour = Number.parseInt(values.hour, 10);
    if (hour === 24) hour = 0;
    return new Date(
      Number.parseInt(values.year, 10),
      Number.parseInt(values.month, 10) - 1,
      Number.parseInt(values.day, 10),
      hour,
      Number.parseInt(values.minute, 10),
      Number.parseInt(values.second, 10),
    );
  } catch {
    return base;
  }
}

export function formatSullyMessageDate(timestamp, timeZone = "") {
  const date = wallDate(timestamp, timeZone);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatSullyXhsCardForModel(message = {}, { timeZone = "" } = {}) {
  const note = message.metadata?.xhsNote || {};
  const sender = message.role === "user" ? "用户" : "你";
  const noteComments = Array.isArray(note.comments) ? note.comments : [];
  const commentsLine = noteComments.length
    ? `\n热评: ${noteComments.slice(0, 15).map((comment) => `${comment.author || "匿名"}: ${comment.content}`).join(" | ")}`
    : "";
  const locatorLine = [
    note.noteId ? `noteId: ${note.noteId}` : "",
    note.sourceUrl || note.url ? `链接: ${note.sourceUrl || note.url}` : "",
  ].filter(Boolean).join("\n");
  const detailHint = note.noteId
    ? `如果需要读完整内容，使用 [[XHS_DETAIL: ${note.noteId}]]，不要假装读过正文`
    : "没有可用 noteId 时，先承认只看到标题/链接，不要假装读过正文";
  const bodyLine = note.desc
    ? `正文: ${note.desc}`
    : `正文: 未获取（${detailHint}）`;
  const time = formatSullyMessageDate(message.timestamp, timeZone);
  return `[${time}] [${sender}分享了小红书笔记]\n标题: ${note.title || "无标题"}\n作者: ${note.author || "未知"}\n赞: ${note.likes || 0}${locatorLine ? `\n${locatorLine}` : ""}\n${bodyLine}${commentsLine}\n${message.role === "user" ? "(请根据你的性格对这个帖子发表看法；正文为空时先承认只看到标题/链接，必要时再读取详情)" : ""}`;
}

export function formatSullyMessageForModel(message = {}, options = {}) {
  if (String(message.type || message.messageType || "").toLowerCase() !== "xhs_card") return message;
  return { ...message, content: formatSullyXhsCardForModel(message, options) };
}

export function formatSullyMessagesForModel(messages = [], options = {}) {
  return messages.map((message) => formatSullyMessageForModel(message, options));
}
