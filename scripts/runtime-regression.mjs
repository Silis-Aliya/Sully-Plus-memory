import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = path.join(root, ".runtime-regression");
const hubPort = 18899;
const modelPort = 18898;
const hubUrl = `http://127.0.0.1:${hubPort}`;
const modelUrl = `http://127.0.0.1:${modelPort}/v1`;
let hubProcess;
let chatMode = "memory";
let lastImpressionPrompt = "";
let impressionCalls = 0;
let lastChatMessages = [];

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

const modelServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (req.url?.endsWith("/chat/completions")) {
    const systemContent = String(body.messages?.find((item) => item.role === "system")?.content || "");
    const userContent = String(body.messages?.find((item) => item.role === "user")?.content || "");
    if (systemContent.includes("月度记忆精炼")) {
      return json(res, 200, {
        choices: [{ message: { content: "这个月我和用户完成了独立运行时回归测试。\n关键词: runtime, regression" } }],
      });
    }
    if (userContent.includes("输出JSON结构v3.0") && userContent.includes("五维画像更新")) {
      lastImpressionPrompt = userContent;
      impressionCalls += 1;
      return json(res, 200, {
        choices: [{ message: { content: JSON.stringify({
          version: 3,
          lastUpdated: Date.now(),
          value_map: { likes: ["认真交流"], dislikes: ["敷衍"], core_values: "我认为TA重视真实。" },
          behavior_profile: { tone_style: "直接", emotion_summary: "近期平稳", response_patterns: "会解释自己的判断" },
          emotion_schema: { triggers: { positive: ["被认真回应"], negative: ["被忽略"] }, comfort_zone: "清晰交流", stress_signals: ["反复确认"] },
          personality_core: { observed_traits: ["认真", "敏锐"], interaction_style: "会追问细节", summary: "我眼中的TA重视真实和连续性。" },
          mbti_analysis: { type: "INTJ", reasoning: "重视结构", dimensions: { e_i: 30, s_n: 70, t_f: 65, j_p: 75 } },
          observed_changes: impressionCalls > 1 ? ["开始更明确地表达边界"] : [],
        }) } }],
      });
    }
    if (chatMode === "error") {
      return json(res, 503, { error: { message: "mock extraction failure" } });
    }
    if (chatMode === "empty") {
      return json(res, 200, {
        choices: [{ message: { content: "[]" } }],
      });
    }
    if (chatMode === "chat") {
      lastChatMessages = body.messages || [];
      return json(res, 200, {
        choices: [{ message: { content: "Hub authority chat reply" } }],
      });
    }
    return json(res, 200, {
      choices: [{
        message: {
          content: JSON.stringify([{
            content: "用户与 Silis 完成了一次独立运行时回归测试。",
            room: "study",
            importance: 7,
            tags: ["runtime", "regression"],
            mood: "neutral",
            date: "2026-07-31",
          }]),
        },
      }],
    });
  }
  if (req.url?.endsWith("/embeddings")) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return json(res, 200, {
      data: inputs.map((_, index) => ({ index, embedding: [1, index + 1, 0.5] })),
      model: body.model,
    });
  }
  if (req.url?.endsWith("/models")) {
    return json(res, 200, { data: [{ id: "mock-model" }] });
  }
  return json(res, 404, { error: "not found" });
});

async function request(pathname, options = {}) {
  const response = await fetch(hubUrl + pathname, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  assert.equal(response.ok, true, `${pathname}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForHub() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(hubUrl + "/api/health");
      if (response.ok) return;
    } catch {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Memory Hub did not start");
}

try {
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
  await new Promise((resolve) => modelServer.listen(modelPort, "127.0.0.1", resolve));

  hubProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      MEMORY_HUB_PORT: String(hubPort),
      MEMORY_HUB_HOST: "127.0.0.1",
      MEMORY_HUB_DATA_DIR: tempDir,
      MEMORY_HUB_TOKEN: "",
      EMBEDDING_SOURCE: "sully",
      LIGHT_LLM_SOURCE: "sully",
      RERANK_SOURCE: "sully",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childError = "";
  hubProcess.stderr.on("data", (chunk) => {
    childError += chunk.toString("utf8");
  });
  await waitForHub();

  const configured = await request("/api/sully/config", {
    method: "POST",
    body: JSON.stringify({
      memoryPalaceConfig: {
        embedding: {
          baseUrl: modelUrl,
          apiKey: "test-key",
          model: "mock-embedding",
          dimensions: 3,
        },
        lightLLM: {
          baseUrl: modelUrl,
          apiKey: "test-key",
          model: "mock-chat",
        },
      },
    }),
  });
  assert.equal(configured.modelStatus.embedding, true);
  assert.equal(configured.modelStatus.lightLLM, true);
  await request("/api/sully/characters", {
    method: "POST",
    body: JSON.stringify({
      characters: [{
        id: "silis",
        name: "Silis",
        systemPrompt: "保持清醒和真诚。",
        selfInsights: ["我已经明白，稳定来自持续面对真实。"],
        autoArchiveEnabled: true,
        memoryPalaceEnabled: true,
      }],
    }),
  });

  const consolidationNow = Date.UTC(2026, 6, 31, 12, 0, 0);
  const capacityMemories = Array.from({ length: 201 }, (_, index) => ({
    id: `capacity-${index + 1}`,
    charId: "consolidation-test",
    content: `capacity memory ${index + 1}`,
    room: "living_room",
    importance: 1,
    accessCount: 0,
    createdAt: consolidationNow - index * 1000,
  }));
  const consolidationMemories = [
    { id: "promote-important", charId: "consolidation-test", content: "important", room: "living_room", importance: 8, accessCount: 0, createdAt: consolidationNow },
    { id: "promote-settled", charId: "consolidation-test", content: "settled", room: "living_room", importance: 6, accessCount: 0, createdAt: consolidationNow - 25 * 3600000 },
    { id: "promote-accessed", charId: "consolidation-test", content: "accessed", room: "living_room", importance: 3, accessCount: 3, createdAt: consolidationNow },
    ...capacityMemories,
  ];
  const consolidation = await request("/api/memory/consolidate", {
    method: "POST",
    body: JSON.stringify({
      charId: "consolidation-test",
      now: consolidationNow,
      persist: false,
      returnData: true,
      data: {
        memories: consolidationMemories,
        vectors: consolidationMemories.map((memory) => ({
          id: `vector:${memory.id}`,
          memoryId: memory.id,
          charId: memory.charId,
          room: memory.room,
          embedding: [1, 0, 0],
        })),
      },
    }),
  });
  assert.deepEqual(new Set(consolidation.promoted), new Set(["promote-important", "promote-settled", "promote-accessed"]));
  assert.equal(consolidation.evicted.length, 1);
  assert.equal(consolidation.livingRoomCount, 200);
  assert.equal(consolidation.changed, 4);
  assert.equal(consolidation.metadataSynced, 4);
  assert.equal(consolidation.data.memories.length, consolidationMemories.length);
  for (const id of consolidation.promoted) {
    assert.equal(consolidation.data.memories.find((memory) => memory.id === id)?.room, "bedroom");
    assert.equal(consolidation.data.vectors.find((vector) => vector.memoryId === id)?.room, "bedroom");
  }
  const evictedId = consolidation.evicted[0];
  assert.equal(consolidation.data.memories.find((memory) => memory.id === evictedId)?.room, "attic");
  assert.equal(consolidation.data.vectors.find((vector) => vector.memoryId === evictedId)?.room, "attic");

  const messages = Array.from({ length: 301 }, (_, index) => ({
    sourceId: `source-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `第 ${index + 1} 条测试消息`,
    timestamp: Date.UTC(2026, 6, 31, 0, index),
  }));
  const ingest = await request("/api/runtime/messages", {
    method: "POST",
    body: JSON.stringify({
      charId: "silis",
      messages,
      autoProcess: false,
      digestMode: "none",
    }),
  });
  assert.equal(ingest.appended, 301);

  const initialImpression = await request("/api/impression/generate", {
    method: "POST",
    body: JSON.stringify({ charId: "silis", type: "initial", userName: "用户" }),
  });
  assert.equal(initialImpression.type, "initial");
  assert.equal(initialImpression.recentMessageCount, 15);
  assert.equal(initialImpression.context.selfInsights, 1);
  assert.match(lastImpressionPrompt, /内在认知 \(Self Insights\)/);
  assert.match(lastImpressionPrompt, /我已经明白，稳定来自持续面对真实/);
  assert.match(lastImpressionPrompt, /第 301 条测试消息/);
  assert.doesNotMatch(lastImpressionPrompt, /第 286 条测试消息/);

  const updatedImpression = await request("/api/impression/generate", {
    method: "POST",
    body: JSON.stringify({ charId: "silis", type: "update", userName: "用户" }),
  });
  assert.equal(updatedImpression.type, "update");
  assert.equal(updatedImpression.recentMessageCount, 50);
  assert.match(lastImpressionPrompt, /我眼中的TA重视真实和连续性/);
  assert.equal(impressionCalls, 2);

  const impressionStatus = await request("/api/impression/status?charId=silis");
  assert.equal(impressionStatus.legacySelfInsights.length, 1);
  assert.equal(impressionStatus.impression.version, 3);

  const before = await request("/api/runtime/status?charId=silis");
  assert.equal(before.characters[0].messages, 301);
  assert.equal(before.characters[0].buffer, 101);
  assert.equal(before.characters[0].processable, 86);
  assert.equal(before.characters[0].highWaterMark, 0);

  const configuredData = (await request("/api/state?light=1")).data;
  assert.equal(configuredData.memoryPalaceConfig.lightLLM.apiKey, "test-key");

  const duplicate = await request("/api/runtime/messages", {
    method: "POST",
    body: JSON.stringify({
      charId: "silis",
      message: {
        sourceId: "source-1",
        role: "user",
        content: "第 1 条测试消息（已更新）",
      },
      autoProcess: false,
      digestMode: "none",
    }),
  });
  assert.equal(duplicate.appended, 0);
  assert.equal(duplicate.updated, 1);

  const processed = await request("/api/runtime/process", {
    method: "POST",
    body: JSON.stringify({
      charId: "silis",
      digestMode: "none",
      autoCompress: false,
    }),
  });
  if (processed.committed !== true) {
    console.error("runtime process response", JSON.stringify(processed, null, 2));
  }
  const refined = await request("/api/legacy/refine-month", {
    method: "POST",
    body: JSON.stringify({ charId: "silis", month: "2026-07", templateId: "refine_atmosphere" }),
  });
  assert.equal(refined.fragmentCount, 1);
  assert.match(refined.summary, /独立运行时回归测试/);
  assert.match(refined.context, /长期核心记忆/);

  const activated = await request("/api/legacy/months/activate", {
    method: "POST",
    body: JSON.stringify({ charId: "silis", month: "2026-07", active: true }),
  });
  assert.equal(activated.active, true);
  assert.match(activated.context, /当前激活的详细回忆/);

  const recalled = await request("/api/legacy/recall", {
    method: "POST",
    body: JSON.stringify({ charId: "silis", month: "2026-07" }),
  });
  assert.equal(recalled.alreadyActive, true);
  assert.equal(recalled.yearMonth, "2026-07");

  await request("/api/legacy/months/activate", {
    method: "POST",
    body: JSON.stringify({ charId: "silis", month: "2026-07", active: false }),
  });
  const runtimeRecall = await request("/api/runtime/messages", {
    method: "POST",
    body: JSON.stringify({
      charId: "silis",
      message: {
        sourceId: "legacy-recall-1",
        role: "assistant",
        content: "让我想起那个月。[[RECALL: 2026-07]]",
      },
      digestMode: "none",
    }),
  });
  assert.equal(runtimeRecall.legacyRecalls[0].yearMonth, "2026-07");
  assert.equal(runtimeRecall.legacyRecalls[0].alreadyActive, false);

  const legacyStatus = await request("/api/legacy/status?charId=silis");
  assert.equal(legacyStatus.months[0].refined.includes("独立运行时回归测试"), true);
  assert.equal(legacyStatus.months[0].active, true);
  assert.equal(processed.committed, true);
  assert.equal(processed.processedMessages, 86);
  assert.equal(processed.memories, 1);
  assert.equal(processed.highWaterMark, 86);

  const after = await request("/api/runtime/status?charId=silis");
  assert.equal(after.characters[0].highWaterMark, 86);
  assert.equal(after.characters[0].buffer, 16);
  assert.equal(after.characters[0].processable, 0);
  assert.equal(after.characters[0].pendingJob, null);

  chatMode = "empty";
  const noMemory = await request("/api/runtime/process", {
    method: "POST",
    body: JSON.stringify({
      charId: "silis",
      force: true,
      digestMode: "none",
      autoCompress: false,
    }),
  });
  assert.equal(noMemory.committed, true);
  assert.equal(noMemory.reason, "no_memories");
  assert.equal(noMemory.memories, 0);
  assert.equal(noMemory.highWaterMark, 100);

  const addedMessages = Array.from({ length: 99 }, (_, index) => ({
    sourceId: `source-${index + 302}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `第 ${index + 302} 条测试消息`,
    timestamp: Date.UTC(2026, 6, 31, 8, index),
  }));
  await request("/api/runtime/messages", {
    method: "POST",
    body: JSON.stringify({
      charId: "silis",
      messages: addedMessages,
      autoProcess: false,
      digestMode: "none",
    }),
  });
  chatMode = "error";
  const failed = await request("/api/runtime/process", {
    method: "POST",
    body: JSON.stringify({
      charId: "silis",
      digestMode: "none",
      autoCompress: false,
    }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "extraction_failed");
  assert.equal(failed.processedMessages, 0);
  const afterFailure = await request("/api/runtime/status?charId=silis");
  assert.equal(afterFailure.characters[0].highWaterMark, 100);

  const data = (await request("/api/state")).data;
  assert.equal(data.memories.length, 1);
  assert.equal(data.vectors.length, 1);
  assert.equal(data.characters[0].hideBeforeMessageId, 86);
  assert.equal(data.characters[0].memories.length, 1);
  assert.equal(data.characters[0].memories[0].mood, "palace");
  assert.deepEqual(data.characters[0].selfInsights, ["我已经明白，稳定来自持续面对真实。"]);
  assert.equal(data.characters[0].impression.version, 3);
  assert.equal(data.impressions.filter((item) => item.charId === "silis" && item.type === "character_impression").length, 1);

  const runtimeMessages = (await request("/api/runtime/messages?charId=silis&limit=1000")).messages;
  const runtimeStatus = (await request("/api/runtime/status?charId=silis")).characters[0];
  const runtimeStorage = (await request("/api/runtime/storage")).storage;
  assert.equal(runtimeMessages.length, 401);
  assert.equal(runtimeStatus.highWaterMark, 100);
  assert.equal(runtimeStatus.pendingJob, null);
  assert.equal(runtimeStorage.count, 401);
  assert.equal(runtimeStorage.level, "ok");
  assert.equal(runtimeStorage.limits.messageTextBytes, 65536);

  const activityIngest = await request("/api/runtime/messages", {
    method: "POST",
    body: JSON.stringify({
      charId: "silis",
      messages: [
        { sourceId: "background-vr-card", role: "assistant", type: "vr_card", content: "「彼方 · 娱乐室」\nbackground activity must not enter chat", timestamp: Date.UTC(2026, 6, 31, 12, 0, 0), surface: "chat", visibility: "user", metadata: { vrCard: true, room: "gym", activity: "玩完街机后留在娱乐室" } },
        { sourceId: "hidden-proactive", role: "user", type: "text", content: "hidden proactive instruction must not enter chat", surface: "chat", visibility: "user", metadata: { hidden: true, proactiveHint: true } },
      ],
      autoProcess: false,
      digestMode: "none",
    }),
  });
  assert.equal(activityIngest.activityState.changed, true, JSON.stringify(activityIngest.activityState));
  assert.equal(activityIngest.activityState.state.location, "《彼方》·娱乐室");
  assert.equal(activityIngest.activityState.state.activity.name, "在《彼方》的娱乐室停留");
  assert.equal(activityIngest.activityState.state.lastActivity.summary, "玩完街机后留在娱乐室");
  assert.equal(activityIngest.activityState.state.vrState.enabled, true);
  assert.equal(activityIngest.activityState.state.vrState.currentRoom, "gym");
  const isolatedChat = await request("/api/runtime/messages?charId=silis&surface=chat&visibility=user&limit=1000");
  const isolatedActivity = await request("/api/runtime/messages?charId=silis&surface=activity&visibility=internal&limit=1000");
  const isolatedSystem = await request("/api/runtime/messages?charId=silis&surface=system&visibility=internal&limit=1000");
  assert.equal(isolatedChat.messages.some((item) => item.sourceId === "background-vr-card" || item.sourceId === "hidden-proactive"), false);
  assert.equal(isolatedActivity.messages.some((item) => item.sourceId === "background-vr-card"), true);
  assert.equal(isolatedSystem.messages.some((item) => item.sourceId === "hidden-proactive"), true);

  chatMode = "chat";
  const chatTurnBody = {
    commandId: "runtime-chat-turn-0001",
    characterId: "silis",
    actorId: "runtime-regression",
    content: "Run one Hub-authoritative chat turn",
    message: {
      sourceId: "hub-user-source-1",
      role: "user",
      content: "Run one Hub-authoritative chat turn",
    },
    now: Date.UTC(2026, 6, 31, 13, 0, 0),
    apiConfig: {
      baseUrl: modelUrl,
      apiKey: "test-key",
      model: "mock-chat",
    },
  };
  const compatDescriptor = await request("/api/v1/compat/sully");
  assert.equal(compatDescriptor.authority, "memory-hub");
  const compatPreview = await request("/api/v1/compat/sully/chat/preview", {
    method: "POST",
    body: JSON.stringify({ charId: "silis", message: chatTurnBody.message }),
  });
  assert.equal(compatPreview.request.characterId, "silis");
  assert.equal(compatPreview.request.message.sourceId, "hub-user-source-1");
  const compatChatTurnBody = { ...chatTurnBody, charId: chatTurnBody.characterId, characterId: undefined };
  const chatTurn = await request("/api/v1/compat/sully/chat/turns", {
    method: "POST",
    body: JSON.stringify(compatChatTurnBody),
  });
  assert.equal(chatTurn.compatibility.source, "sullyos");
  assert.equal(chatTurn.idempotentReplay, false);
  assert.equal(chatTurn.assistantMessage.content, "Hub authority chat reply");
  const vrContextMessage = lastChatMessages.find((item) => String(item.content || "").includes("background activity must not enter chat"));
  assert.equal(vrContextMessage?.role, "assistant");
  assert.equal(String(vrContextMessage?.content || "").includes("（你在《彼方》里的动态）"), true);
  assert.equal(String(lastChatMessages[0]?.content || "").includes("### 关于《彼方》"), true);
  assert.equal(lastChatMessages.some((item) => String(item.content || "").includes("hidden proactive instruction must not enter chat")), false);
  assert.equal(lastChatMessages.some((item) => String(item.content || "").includes("《彼方》·娱乐室")), true);
  assert.equal(lastChatMessages.some((item) => String(item.content || "").includes("在《彼方》的娱乐室停留")), true);
  assert.equal(chatTurn.snapshot.snapshotVersion, 2);
  assert.equal(chatTurn.snapshot.state.location, "《彼方》·娱乐室");
  const replayedChatTurn = await request("/api/v1/compat/sully/chat/turns", {
    method: "POST",
    body: JSON.stringify(compatChatTurnBody),
  });
  assert.equal(replayedChatTurn.idempotentReplay, true);
  assert.equal(replayedChatTurn.assistantMessage.id, chatTurn.assistantMessage.id);
  const chatEvents = await request("/v1/events?after=0&characterId=silis&clientId=runtime-regression&limit=100");
  assert.deepEqual(chatEvents.events.map((event) => event.type), [
    "character.state.updated",
    "command.accepted",
    "message.user.created",
    "message.assistant.created",
    "character.snapshot.updated",
  ]);
  assert.equal(chatEvents.cursor.lastEventId, chatEvents.lastEventId);
  const chatSnapshot = await request("/v1/characters/silis/snapshot");
  assert.equal(chatSnapshot.snapshot.snapshotVersion, 2);
  assert.equal(chatSnapshot.snapshot.state.lastActivity.summary, "玩完街机后留在娱乐室");
  assert.equal(chatSnapshot.snapshot.recentMessages.at(-1).content, "Hub authority chat reply");
  const messagesAfterChat = (await request("/api/runtime/messages?charId=silis&limit=1000")).messages;
  assert.equal(messagesAfterChat.length, 405);
  const mirroredHubMessages = await request("/api/runtime/messages", {
    method: "POST",
    body: JSON.stringify({
      charId: "silis",
      messages: [
        { sourceId: "hub-user-source-1", role: "user", content: "Run one Hub-authoritative chat turn" },
        { sourceId: chatTurn.assistantMessage.sourceId, role: "assistant", content: "Hub authority chat reply" },
      ],
      autoProcess: false,
      digestMode: "none",
    }),
  });
  assert.equal(mirroredHubMessages.appended, 0);
  assert.equal(mirroredHubMessages.updated, 2);
  assert.equal((await request("/api/runtime/messages?charId=silis&limit=1000")).messages.length, 405);

  const oversizedResponse = await fetch(hubUrl + "/api/runtime/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ charId: "silis", message: { sourceId: "oversized", role: "user", content: "x".repeat(65537) }, autoProcess: false }),
  });
  const oversizedBody = await oversizedResponse.json();
  assert.equal(oversizedResponse.status, 413);
  assert.equal(oversizedBody.code, "MESSAGE_TOO_LARGE");

  console.log(JSON.stringify({
    ok: true,
    messages: runtimeMessages.length,
    processedMessages: processed.processedMessages,
    highWaterMark: runtimeStatus.highWaterMark,
    memories: data.memories.length,
    vectors: data.vectors.length,
    legacyFragments: data.characters[0].memories.length,
  }));

  if (childError) process.stderr.write(childError);
} finally {
  if (hubProcess && !hubProcess.killed) {
    const exited = new Promise((resolve) => hubProcess.once("exit", resolve));
    hubProcess.kill();
    await exited;
  }
  await new Promise((resolve) => modelServer.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true });
}
