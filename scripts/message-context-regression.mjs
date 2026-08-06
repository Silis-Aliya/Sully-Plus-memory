import assert from "node:assert/strict";
import { formatSullyMessageForModel, formatSullyXhsCardForModel } from "../sullyMessageContext.mjs";

const card = {
  id: 60539,
  role: "user",
  type: "xhs_card",
  content: "title-only storage value",
  timestamp: Date.UTC(2026, 7, 6, 15, 31),
  metadata: {
    xhsNote: {
      title: "梁圣？暂时降级为梁子 😡",
      author: "测试作者",
      likes: 12,
      noteId: "note-123",
      sourceUrl: "https://example.test/note-123",
      desc: "笔记正文",
      comments: Array.from({ length: 17 }, (_, index) => ({ author: `作者${index + 1}`, content: `评论${index + 1}` })),
    },
  },
};

const text = formatSullyXhsCardForModel(card, { timeZone: "Europe/London" });
assert.match(text, /^\[2026-08-06 16:31\] \[用户分享了小红书笔记\]/);
assert.match(text, /标题: 梁圣？暂时降级为梁子 😡/);
assert.match(text, /作者: 测试作者/);
assert.match(text, /赞: 12/);
assert.match(text, /noteId: note-123/);
assert.match(text, /链接: https:\/\/example\.test\/note-123/);
assert.match(text, /正文: 笔记正文/);
assert.match(text, /作者15: 评论15/);
assert.doesNotMatch(text, /作者16: 评论16/);

const missingBody = formatSullyXhsCardForModel({ ...card, role: "assistant", metadata: { xhsNote: { title: "只有标题" } } });
assert.match(missingBody, /\[你分享了小红书笔记\]/);
assert.match(missingBody, /正文: 未获取（没有可用 noteId 时，先承认只看到标题\/链接，不要假装读过正文）/);
assert.doesNotMatch(missingBody, /请根据你的性格/);

const original = { role: "user", type: "text", content: "普通消息" };
assert.equal(formatSullyMessageForModel(original), original);

console.log(JSON.stringify({ ok: true, xhsCardCharacters: text.length, commentsIncluded: 15 }));
