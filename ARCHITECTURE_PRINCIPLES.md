# Memory Hub 架构准则

本文档是 Memory Hub 的最高实现约束。功能设计、数据迁移、同步策略、后端逻辑和 UI 接线发生冲突时，以本文档为准。

## 核心定位

Memory Hub 是一套可以脱离 SullyOS 独立运行的记忆库与记忆运行时。

它不是 SullyOS 的只读查看器，也不是 SullyOS 必须依赖的共享 Core。SullyOS 保持原有独立实现；Memory Hub 在自己的运行环境中完整实现同一套记忆语义，并可以与 SullyOS 同步。

在相同输入、相同模型配置和相同原版模式下，记忆逻辑放在 SullyOS 内运行，或放在 Memory Hub 内运行，结果应没有语义差异。

## 完整记忆大脑范围

“与 SullyOS 一致”不只指 Memory Palace，至少包括以下四层。

### 1. Legacy 长期记忆

- `memories: MemoryFragment[]` 日度记忆
- `refinedMemories: Record<string, string>` 月度精炼记忆
- `activeMemoryMonths: string[]` 按需展开的详细月份
- `[[RECALL: YYYY-MM]]` 月份调取与激活
- 日度记忆、月度核心记忆在上下文中的原有注入顺序和格式

`refinedMemories` 是 SullyOS 的月度长期核心记忆，不是 MemoryNode，不属于七房间，也不能擅自改写成 `self_room`、pinned 或 protected 节点。

### 2. 角色认知层

- 当前 `impression` 私密印象档案
- `selfInsights` 内在认知
- `personalityStyle`
- `ruminationTendency`
- 印象生成和更新所使用的完整上下文、最近消息范围与写回结构

印象档案是一个角色当前版本的长期用户画像，不是多个时间存档，也不是 RoomPlate 或 MemoryNode 的替代品。

### 3. Memory Palace

- 完整 MemoryNode 字段与七房间语义
- extraction / migration / external import
- relatedTo / sameAs / eventName / eventTags
- EventBox bind、summary、live、archived、seal、compression
- RoomPlate
- windowsill / Anticipation
- digestion 与源记忆 `digestedAt`
- embedding、重建、rerank
- recall、activation、formatter、pinned、recall receipt
- 自动调度、高水位线、热区、缓冲区、并发锁和失败恢复

### 4. 最终上下文组装

Memory Hub 独立运行时必须能按 SullyOS 的原有顺序组装角色上下文，包括：

1. 角色身份与设定
2. 时间感知
3. `selfInsights`
4. 世界观与世界书
5. 用户资料
6. 当前 `impression`
7. RoomPlate 常驻注入
8. Legacy 月度核心记忆与激活月份
9. Memory Palace 本轮召回
10. 情绪与其它运行态

只实现搜索结果或 formatter，不等于实现完整记忆大脑。

## Prompt 规则

- 指定从 SullyOS 搬运的 prompt 必须逐字一致。
- 七房间语义不得改写。
- 不得删改 `relatedTo/sameAs/eventName/eventTags`。
- 不得删改 RoomPlate 的 bedroom 禁止关系命名规则。
- 不得删改 `self_insight` 稀有性规则。
- 不得删改 Anticipation 的 `fulfill/disappoint/keep`。
- 只允许修改数据来源、持久化、API、模型配置和运行环境适配。
- 任何 prompt 修改前必须先提交完整 prompt 给用户确认。

## SullyOS 同步原则

### 单向镜像阶段

- SullyOS 新增，Hub 新增。
- SullyOS 更新，Hub 按稳定 ID 更新，不追加旧副本。
- SullyOS 删除，Hub 删除对应的 SullyOS 镜像及孤儿向量、关系和派生索引。
- 全量快照以 SullyOS 当前状态为准。
- 单角色同步只影响目标角色。
- Hub 本地产生的数据必须有明确来源标记，不能被全量镜像误删。

### 独立运行阶段

- SullyOS 离线时，Hub 可继续接收消息并运行完整流程。
- Hub 本地产生的合法结果进入本地权威层，不伪装成 SullyOS 镜像。
- SullyOS 恢复后，先预览差异，再按显式冲突策略写回。
- 删除使用 tombstone 或等价的明确删除操作，不能只靠数组缺项猜测。

## Memory Hub 增强层

以下属于用户明确要求的可选增强，不得悄悄改变 SullyOS 原版模式：

- 完整召回审计 trace
- EventBox “SullyOS 原版 / 增强展开”切换
- 命中 live 必带、重要度/时间/query similarity 补足
- 可配置 live 数量和 omitted 入口
- Breath 可视化与管理入口
- 健康检查、备份、手动调度和维护 UI

增强功能必须可以关闭，并回到 SullyOS 原版行为。

## 数据与持久化

- 所有源对象保留完整字段，不得为了 UI 展示重建成残缺对象。
- 源数据、Hub 本地权威数据、可重建派生数据必须分层。
- 每个对象至少能追踪 `sourceAuthority`、稳定 ID、更新时间和同步状态。
- MemoryNode、vector、link、EventBox、RoomPlate、Anticipation 必须保持引用完整性。
- JSON 可以作为交换和备份格式，但不应长期承担超大关系图的高频全量覆盖写入。

## 验收标准

只有同时满足以下条件，才能称为“完整独立运行”：

1. 关闭 SullyOS 后，Hub 能持续接收真实聊天消息并自动执行完整记忆流水线。
2. Hub 重启后不会重复抽取、重复压缩或丢失 digest 轮次。
3. 同一 fixture 在 SullyOS 和 Hub 原版模式下产生相同 prompt、状态转换和最终注入文本。
4. 模型失败不会错误推进高水位线或把半成品写成成功。
5. Legacy 月度核心记忆、印象、自我领悟、RoomPlate 和 Palace 召回按原顺序共同进入上下文。
6. SullyOS 的新增、修改和删除在 Hub 中一一对应。
7. Hub 离线期间的新增、修改和删除可在恢复连接后审计并写回 SullyOS。
8. 所有用户按钮都连接真实后端流程，并显示真实成功、跳过或失败原因。
