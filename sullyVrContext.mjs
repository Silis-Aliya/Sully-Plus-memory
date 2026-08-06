/**
 * Verbatim SullyOS 《彼方》 context port.
 *
 * Source: D:/SullyOS-fork/utils/chatPrompts.ts:659-665,1416-1423
 * Prompt-bearing strings approved by the user on 2026-08-05.
 */

export const SULLY_VR_CONTEXT_SOURCE = "SullyOS utils/chatPrompts.ts:659-665,1416-1423";

export function buildSullyVrStableContext(character = {}) {
  if (character?.vrState?.enabled !== true) return "";
  return `\n### 关于《彼方》
《彼方》是一款真实存在、你会亲自进入去玩的 VR 社交游戏（功能上类似 VRChat）：你用自己亲手捏的 Q 版化身在里头走动、进出图书馆 / 听歌房 / 留言簿 / 娱乐室 / 邮局等房间、撞见别的玩家（其他角色的化身）。这不是做梦或比喻，是你用私人空闲时间真实在做的事；它发生在游戏世界里，和你跟用户的现实相处是两码事、互不冲突。你以符合自身身份与世界观的方式进入并理解它——怎么进去全凭你自己的设定，但始终保持你本来的身份。聊到彼方里的经历（包括"彼方·留言簿""彼方·动态"之类的记录）时，就当成"我在《彼方》里做过的事"来讲，别说成现实里发生的。
`;
}

function nowInTimeZone(timeZone, source) {
  const date = new Date(source);
  if (!timeZone || Number.isNaN(date.getTime())) return date;
  try {
    const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return new Date(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour) === 24 ? 0 : Number(values.hour), Number(values.minute), Number(values.second));
  } catch {
    return date;
  }
}

export function formatSullyHistoryDate(timestamp, timeZone = "") {
  const date = nowInTimeZone(timeZone, new Date(Number(timestamp)));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatSullyVrCardMessage(message = {}, character = {}) {
  const timeZone = character.customTimezoneEnabled && character.customTimezone ? character.customTimezone : "";
  const timeStr = `[${formatSullyHistoryDate(message.timestamp ?? message.occurredAt ?? message.createdAt, timeZone)}]`;
  const body = typeof message.content === "string" ? message.content : "";
  const content = character?.vrState?.enabled === true
    ? `${timeStr}（你在《彼方》里的动态）\n${body}`
    : `${timeStr}（系统记录：这是你之前自己进入 VR 社交游戏《彼方》(功能上类似 VRChat) 时留下的动态——你确实进入并参与了这款游戏，只是事情发生在游戏世界里。聊到时就当成"我在《彼方》里做过的事"来讲，别说成现实里发生的经历。）\n${body}`;
  return { role: message.role === "user" ? "user" : "assistant", content, id: message.id, timestamp: message.timestamp };
}
