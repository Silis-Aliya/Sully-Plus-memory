# SullyOS → Memory Hub Prompt / Context 覆盖审计

审计基线：2026-08-06，SullyOS-fork 当前工作树。本文只记录真实代码覆盖，不把 README 或 UI 视为实现证据。本轮没有修改任何 SullyOS Prompt。

## 结论

当前 SullyOS 核心角色上下文并未整体漂移。对同一组 fixtures 关闭 Hub 额外 Chat Prompt 后，Stable、Volatile 和最终消息数组与当前 SullyOS `ContextBuilder` 输出哈希完全一致。此前看见的哈希差异来自 Hub 测试默认额外拼入了 Chat App Rules 和 recency tail，属于比较口径不一致；新的交叉断言已经把两层分开。

Memory Palace 提取、迁移、外部记忆、EventBox 压缩、RoomPlate、认知消化、人格判断、日程注入、VR 说明和当前已搬运的 Chat 固定块仍通过直接源文件锁定。

但是 CC 上下文当前存在五个部署前缺口，其中第一项需要 Prompt 注入范围确认。

## 实际代码证据

| 范围 | 当前证据 | 结论 |
| --- | --- | --- |
| `ContextBuilder.buildCoreContext` | SullyOS authority fixture 与 Hub `includeChatPrompt=false` 的 Stable/Volatile/finalMessages 哈希一致 | 核心身份、User、Impression、Legacy、RoomPlate、世界书 0–6、时间、召回和 Buff 的已有 fixture 语义一致 |
| Chat 固定块 | `test:chat-prompt` 直接读取当前 `utils/chatPrompts.ts` | Chat App Rules、语音关闭提示、关于对方的表达、回到你自己仍逐字一致 |
| Memory Palace Prompt | `test:memory-palace-prompts` 直接读取当前 SullyOS 源文件 | 已搬运模板逐字一致 |
| 日程 | `test:schedule-injection` 锁定完整源文件 SHA-256 | 当前一致 |
| VR | `test:vr-context` 直接读取当前 Chat 源块 | 当前一致 |
| CC 稳定层 | `server.mjs:buildCcContextPackage` 把 `buildContextParity().stableSystemPrompt` 交给 Runner | 当前错误地包含手机聊天规则 |
| CC 唤醒增量 | messages、events、recall、runtimeState、unfinishedTasks | 主干已具备，但未覆盖 AMSG2 的所有到点信号 |

## 目标分类

### 写入角色 CLAUDE.md

- CharacterProfile 的名字、备注、核心人设、自我领悟和世界观
- 固定/稳定世界书及挂载关系
- UserProfile 当前由 SullyOS 核心上下文使用的文本字段
- Impression、RoomPlate、Legacy 月度核心记忆
- 通用 Anti-Filler 与已确认的 CC 角色运行规则
- VR 的稳定世界定义（启用时）

### 每次 CC 唤醒增量发送

- 唤醒原因
- 新增原始聊天与角色自己后来发出的消息
- 当前时间、双方时区参照、日程、位置、活动和情绪状态
- 当前激活的关键词/概率世界书
- 3–5 条自动召回记忆
- 新事件、未完成任务和最近活动
- 需要时的实时世界信息

### 只属于 SullyOS 普通聊天前台

- 手机气泡、引用、表情、转账、语音标签和定时消息输出格式
- 双语、HTML 卡片、思考链
- 麦当劳、瑞幸及用户配置的普通聊天 MCP
- 电话/见面结束后切回文字聊天的提示
- Code 区进度卡和其他具体 App 的格式 Prompt

这些内容不应因为“保持一致”而全部写进 CC 的 `CLAUDE.md`。普通聊天继续由 SullyOS 当前主模型 API 执行，它们留在 SullyOS 才是正确对齐。

### Hub 后台记忆任务

- Memory Palace 提取、迁移、外部记忆
- EventBox 压缩与二次压缩
- RoomPlate 整理
- Digest / 认知消化
- Impression 与人格检测

这些继续受现有逐字 Prompt 锁保护。

## 部署前阻塞项

1. **CC 的 CLAUDE.md 混入 Chat App Rules**
   `buildCcContextPackage` 当前调用 `buildContextParity` 时没有关闭 `includeChatPrompt`。生成的角色文件因此同时收到“后台自由活动”和“你当前处于手机聊天、不要输出行为”两套规则。这不是 SullyOS Prompt 原文错误，而是注入目标错误。移除该注入前必须向用户展示变更前后的完整组装 Prompt 并确认。

2. **CC 稳定角色来源仍先读旧运行数据**
   当前从 `data.characters` 取角色，再读取 authority User。应改成 CharacterDefinition、Worldbook mounts 和 UserIdentity 权威实体优先，旧数据只作恢复回退。

3. **动态世界书没有进入 CC 唤醒包**
   稳定层使用 `messages: []`，所以关键词和概率世界书不会激活；唤醒增量又没有单独返回 activated worldbooks。它们目前会丢失。

4. **SullyOS AMSG2 的到点语义未完全映射**
   Hub 已有新增消息、事件、状态、任务和 recall，但还缺明确的对方时钟、自发消息 self-log 语义、实时世界块等。应搬数据语义，不应复制 FirePack 的普通聊天 Prompt。

5. **Claude Code compact 检测未完成**
   Runner 能在重启或 stableContextVersion 改变时重建 `CLAUDE.md`，但还不能可靠识别 CC 内部 compact 并主动刷新身份层。

## 可重复审计

```powershell
npm run audit:sully-context
npm run test:context-parity
npm run test:chat-prompt
npm run test:memory-palace-prompts
npm run test:schedule-injection
npm run test:vr-context
```

`audit:sully-context` 会：

- 扫描 SullyOS 中所有 Prompt 候选文件并按顶层目录计数；
- 检查关键源文件哈希，SullyOS 更新后要求重新审计；
- 检查源标记与 Hub 对应实现是否仍存在；
- 对 core-only fixtures 执行 SullyOS authority 交叉哈希断言；
- 输出 CC 部署阻塞项。

任何 Prompt 原文或注入范围修改，仍须先展示完整修改前后 Prompt 并由用户确认。
