# Memory Hub 复刻 SullyOS Memory Palace：给 Codex 的施工说明

这份文件是给 Codex / CC / 代码实现窗口看的。

目标不是重新设计记忆系统。目标是把 `D:\SullyOS-fork\utils\memoryPalace` 里的 SullyOS Memory Palace 记忆整理 prompt 和后台逻辑，原样搬到 Memory Hub，让 Memory Hub 成为可以独立运行的记忆宫殿后台。

## 最高优先级要求

不要重写 Memory Palace prompt。

不要优化、改名、融合、删减、翻译、重排任何 prompt 文案。

Memory Hub 是 SullyOS Memory Palace 的独立版后台，不是重新设计的记忆系统。

请从：

```text
D:\SullyOS-fork\utils\memoryPalace
```

直接复制以下 prompt builder / LLM 调用函数到 Memory Hub，并保持 prompt 字符串逐字一致。

只允许做：

1. 把依赖改成 Memory Hub 自己的数据结构；
2. 把 DB 写入改成 hub-data.json / Memory Hub storage；
3. 把 LLM 调用改成 Memory Hub 的 lightLLM 配置；
4. 保留所有七房间、EventBox、RoomPlate、Anticipation、Digest 原逻辑。

不允许做：

1. 不允许把七房间规则改成自己的版本；
2. 不允许新增自创的替代 prompt；
3. 不允许把 user_room / self_room / attic / windowsill 的语义重新解释；
4. 不允许删掉 relatedTo / sameAs / eventName / eventTags；
5. 不允许删掉 RoomPlate 的 bedroom 禁止关系命名规则；
6. 不允许删掉 self_insight 稀有性规则；
7. 不允许删掉 Anticipation 的 fulfill / disappoint / keep；
8. 不允许默认写回 SullyOS；
9. 不允许重启、占用或修改 SullyOS 端口。

## Memory Hub 的定位

Memory Hub 就是独立运行的 SullyOS 记忆宫殿。

必须完整保留：

```text
living_room   客厅
bedroom       卧室
study         书房
user_room     用户房间
self_room     自我房间
attic         阁楼
windowsill    窗台
```

必须完整保留：

```text
MemoryNode
MemoryVector
MemoryLink
EventBox
RoomPlate
Anticipation
DigestReport
Memory Extraction
EventBox Compression
RoomPlate Consolidation
Cognitive Digestion
Personality Detection
External Memory Import
```

## 谁负责什么 / prompt 在哪里 / 给谁用

| 模型任务 | SullyOS 原文件 | 原函数 / prompt 位置 | Memory Hub 里给谁用 |
|---|---|---|---|
| 聊天记录 → MemoryNode 提取 | `utils/memoryPalace/extraction.ts` | `buildRulesBlock()` + `extractMemoriesFromBuffer()` 里的 `systemPrompt` | `/api/memory/extract`，RawLog / chat log 入宫 |
| 旧记忆关联 / EventBox 绑定提示 | `utils/memoryPalace/extraction.ts` | `buildRelatedMemoriesBlock()`、`buildRelatedToRule()`、`buildRelatedToFormatHint()` | MemoryNode 提取时顺便生成 `relatedTo / sameAs / eventName / eventTags` |
| 月度旧记忆迁移 → MemoryNode | `utils/memoryPalace/migration.ts` | `extractMonthMemories()` 里的 `systemPrompt` | SullyOS 旧 `char.memories/refinedMemories` 迁入 Hub |
| 外部文本搬家 → MemoryNode | `utils/memoryPalace/externalMemory.ts` | `buildExternalMemoryPrompt()` | 导入外部 JSON / 长文本 / 旧记忆库 |
| EventBox 压缩总结 | `utils/memoryPalace/eventBoxCompression.ts` | `callCompressionLLM()` 里的 `systemPrompt` | `/api/memory/eventbox/summarize` |
| EventBox 超长后二次压缩 | `utils/memoryPalace/eventBoxCompression.ts` | `recompressSummary()` 里的 `systemPrompt` | EventBox summary 超过硬上限时 |
| RoomPlate 门牌整理 | `utils/memoryPalace/roomPlates.ts` | `ROOM_RULES` + `callPlateLLM()` 里的 `systemPrompt` | `/api/memory/plates/consolidate` |
| 认知消化 Digest | `utils/memoryPalace/digestion.ts` | `callDigestLLM()` 里的 `systemPrompt` | `/api/memory/digest/run` |
| 人格风格 / 反刍倾向检测 | `utils/memoryPalace/digestion.ts` | `detectPersonalityStyle()` 里的 `systemPrompt` | 首次启用 TA 的记忆宫殿 / 初始化 self_room |
| Anticipation 窗台处理 | `utils/memoryPalace/digestion.ts` | `callDigestLLM()` 内 `[W*]` 的 fulfill / disappoint / keep 规则 | Digest 内部处理窗台期盼 |

## 重要说明：EventBox 绑定不是单独 LLM prompt

SullyOS 的 EventBox 绑定不是单独一个 LLM prompt。

它是 MemoryNode 提取 prompt 里顺便让模型输出：

```json
{
  "relatedTo": ["O0"],
  "sameAs": ["0"],
  "eventName": "...",
  "eventTags": ["..."]
}
```

然后代码层 `eventBox.ts` 用这些字段去绑定盒子。

所以不要新增一个自创的 “EventBox bind prompt”。如果需要实现绑定 API，只能搬 SullyOS 的：

```text
buildRelatedMemoriesBlock()
buildRelatedToRule()
buildRelatedToFormatHint()
```

以及相关解析逻辑：

```text
parseRelatedToAndHints()
```

## 需要原样搬运的 SullyOS 文件/函数

### 1. MemoryNode 提取

来源：

```text
D:\SullyOS-fork\utils\memoryPalace\extraction.ts
```

必须原样搬：

```text
buildRulesBlock
buildConversationText
buildRelatedMemoriesBlock
buildRelatedToRule
buildRelatedToFormatHint
parseRelatedToAndHints
extractMemoriesFromBuffer 内的 systemPrompt
```

负责：

```text
聊天消息 / RawLog → MemoryNode[]
同时让 LLM 判断 relatedTo / sameAs / eventName / eventTags
同时支持 pinDays / unpin / correct
```

Memory Hub 使用位置：

```text
POST /api/memory/extract
```

写回：

```text
hubData.memories
hubData.eventBoxes（通过后续 EventBox binding）
hubData.memoryLinks / corrections / pinnedUntil
```

### 2. 月度旧记忆迁移

来源：

```text
D:\SullyOS-fork\utils\memoryPalace\migration.ts
```

必须原样搬：

```text
extractMonthMemories 内的 systemPrompt
```

负责：

```text
传统日度 / 月度总结 → MemoryNode[]
保留日期、七房间、情绪坐标、relatedTo/eventName/eventTags
```

Memory Hub 使用位置：

```text
POST /api/memory/migrate-month
```

或导入 SullyOS `char.memories/refinedMemories` 时内部调用。

### 3. 外部记忆搬家

来源：

```text
D:\SullyOS-fork\utils\memoryPalace\externalMemory.ts
```

必须原样搬：

```text
buildExternalMemoryPrompt
parseCompleteExternalMemoryReply
```

负责：

```text
外部应用 / 旧记忆系统 / 长文本 → 无损迁入 MemoryNode[]
```

重点：

```text
不得总结、概括、润色、改写、合并同类项或去重；
不得用一句结论代替一段经历；
不得输出“略”“其余同上”等省略表达。
```

Memory Hub 使用位置：

```text
POST /api/memory/import-external
```

### 4. EventBox 压缩

来源：

```text
D:\SullyOS-fork\utils\memoryPalace\eventBoxCompression.ts
```

必须原样搬：

```text
callCompressionLLM 内的 systemPrompt
recompressSummary 内的 systemPrompt
```

负责：

```text
同一 EventBox 内 live nodes 达阈值后，压缩为 summary MemoryNode
如果 summary 超长，调用二次压缩 prompt
```

Memory Hub 使用位置：

```text
POST /api/memory/eventbox/summarize
```

写回：

```text
hubData.memories 新增 isBoxSummary=true 的 MemoryNode
hubData.eventBoxes[].summaryNodeId
原 live nodes archived=true
```

### 5. RoomPlate 门牌整理

来源：

```text
D:\SullyOS-fork\utils\memoryPalace\roomPlates.ts
```

必须原样搬：

```text
ROOM_RULES
callPlateLLM 内的 systemPrompt
mergePlateEntries
violatesBedroomRule
formatRoomPlatesSection
buildRoomPlatesInjection
```

负责：

```text
把事件盒 summary / 认知消化产物 / 高价值记忆，整理成 RoomPlate entries。
门牌是常驻认知，不是追加流水账。
```

必须保留原逻辑：

```text
合并语义（不是追加）
LLM 每次输出目标房间的完整新条目列表
旧条目不被重新输出即被淘汰
卧室门牌「我们之间」禁止给关系命名
```

Memory Hub 使用位置：

```text
POST /api/memory/plates/consolidate
```

写回：

```text
hubData.roomPlates
```

### 6. Cognitive Digestion 认知消化

来源：

```text
D:\SullyOS-fork\utils\memoryPalace\digestion.ts
```

必须原样搬：

```text
callDigestLLM 内的 systemPrompt
executeActions 相关逻辑
saveDigestReport
runCognitiveDigestion
```

负责：

```text
阁楼困惑
窗台期盼
书房知识内化
用户房间信息整合
自我房间反刍 / self_insight / self_confuse
最近经历回看 worry / aspire / distill
```

必须保留原动作：

```text
resolve
deepen
fade
fulfill
disappoint
internalize
synthesize_user
self_insight
self_confuse
worry
aspire
distill
keep
```

Memory Hub 使用位置：

```text
POST /api/memory/digest/run
```

写回：

```text
hubData.memories[].digestedAt
hubData.memories 新增 attic / digestion 产物
hubData.roomPlates
hubData.digestReports
hubData.anticipations
```

### 7. Personality Detection 人格审视

来源：

```text
D:\SullyOS-fork\utils\memoryPalace\digestion.ts
```

必须原样搬：

```text
detectPersonalityStyle 内的 systemPrompt
```

负责：

```text
首次启用记忆宫殿时，判断 personalityStyle 和 ruminationTendency。
```

Memory Hub 使用位置：

```text
POST /api/memory/personality/detect
```

或首次创建 / 导入 TA 大脑时内部调用。

写回：

```text
character.personalityStyle
character.ruminationTendency
可生成 self_room 初始化记忆
```

## Memory Hub 代码结构建议

可以新增：

```text
lib/sullyMemoryPalacePrompts.mjs
lib/sullyMemoryPalaceEngine.mjs
```

`sullyMemoryPalacePrompts.mjs` 只放从 SullyOS 原样搬来的 prompt builder。

`sullyMemoryPalaceEngine.mjs` 负责：

```text
读取 hubData
选候选
调用 lightLLM
解析 JSON
写回 hub-data.json
备份
dryRun
```

不要把 prompt 全塞进 `server.mjs`。

## API 建议

```text
POST /api/memory/extract
POST /api/memory/import-external
POST /api/memory/migrate-month
POST /api/memory/eventbox/summarize
POST /api/memory/plates/consolidate
POST /api/memory/digest/run
POST /api/memory/personality/detect
POST /api/context-pack
```

其中 `/api/context-pack` 可以是 Memory Hub 自己新增的 CC 输出层，但不能改动 SullyOS Memory Palace 的整理 prompt。

Context Pack 是包装层，不是 Memory Palace 原 prompt 的替代品。

## 安全要求

1. 所有写入 `hub-data.json` 前先备份。
2. `dryRun=true` 时绝不写入。
3. hub-data.json 非法 JSON 时不要覆盖，返回错误提示恢复备份。
4. 不打印 API key。
5. 不删除原始 MemoryNode。
6. `digestedAt` 只是退出消化候选，不代表删除。
7. 不写回 SullyOS。
8. 不影响 SullyOS 端口。
9. 不允许“清空后重导”作为普通操作。

## 验收标准

1. Memory Hub 可以用 SullyOS 原 prompt 从 RawLog 提取 MemoryNode。
2. MemoryNode 提取仍完整支持七房间。
3. MemoryNode 提取仍支持 relatedTo / sameAs / eventName / eventTags。
4. EventBox 压缩使用 SullyOS 原 prompt。
5. RoomPlate 整理使用 SullyOS 原 prompt。
6. 认知消化使用 SullyOS 原 prompt。
7. self_room 反刍后按 SullyOS 原逻辑进入 self_insight / self_confuse / keep。
8. self_insight 进入「我是谁」门牌，而不是无限追加 self_room 节点。
9. self_confuse 生成 attic 节点。
10. Anticipation 窗台仍支持 fulfill / disappoint / keep。
11. digestReports 能记录 examined / outcomes / plateSubmissions / plateUpdated。
12. 刷新 Memory Hub 不会丢角色选择和导入数据。

## 最重要的一句话

Memory Hub 不要发明新的记忆整理 prompt。

真正最终版必须以：

```text
D:\SullyOS-fork\utils\memoryPalace
```

里的 SullyOS 源码 prompt 为准。

