# HDS Interlude / 幕间系统

> 聊天在幕前发生，生活在幕间继续。

> **Beta 0.1.0-beta**：首次公开测试版，用于验证功能、兼容性与长期运行稳定性。请在测试环境中使用，并妥善保管 API Key 与私聊数据。

HDS Interlude 是一个基于 Koishi 的多人共享主剧本拟真聊天框架。它不把角色理解为“收到消息后立即生成回答的 Bot”，而把每个角色理解为一部持续推进的生活剧本的主角；多个 QQ 账号可以成为这部剧本里的不同关系对象。

用户发来的消息不是命令，也不是必须立刻回答的问题；它是发生在角色现实中的外部事件。角色会看见、忽略、犹豫、延迟、回复，也会在自己的日程和关系变化里主动联系。可见聊天消息只是剧本中已经发生的一个动作。

本仓库提供的是框架、数据协议和运行机制，不附带特定角色或特定模型服务商。

## 1. 设计原则

- 剧本优先：系统的主体是持续增长的生活剧本，而不是扁平聊天记录。
- 现实时间优先：每次推进只补写从上次游标到现在已经发生的时间，不预写未来。
- 单次主写作：一条用户消息只调用一次主叙事模型；同一回合同时完成补写、用户介入与互动决定。
- 沉默是合法结果：角色不必为了保持聊天而回复。
- 未来以意图保存：角色可以打算联系用户，但真正发生前只保存为 intent，到时间后仍要重新判断。
- 连续性优先：长期关系、承诺、日程与人物状态必须可追溯。
- Canon 与演化分离：初始设定不被模型自动覆盖；剧情导致的变化写入独立覆盖层。
- 压缩不阻塞互动：低成本记忆压缩在主回合之后异步运行，不增加用户等候时间。
- 一人多线：同一个机器人账号下的多个私聊共享角色生活，但每个账号保留独立关系分支、待回复数和投递目标。
- 全局串行：同一主剧本的消息、定时意图和跨账号动作共用一条队列，避免角色同时对不同人说出互相矛盾的话。

## 2. 系统如何看待一段对话

一个机器人角色对应一个主故事（InterludeStory），每个私聊账号是故事中的参与者（InterludeParticipant）。故事不是单一文本，而是以下几层共同组成的状态：

| 层级 | 保存内容 | 用途 |
| --- | --- | --- |
| 基础设定 / canon | 主角、默认用户资料、世界、地点、配角、叙事风格 | 剧本开始时已经成立的事实；只由显式设置修改 |
| 参与者关系分支 | QQ 账号、人物代号、个人资料、与主角的关系、未读和待回复状态 | 同一主角面对不同人时的差异；不会把 A 的关系覆盖到 B |
| 演化覆写 / overlay | 经证据确认的性格、关系、世界现状变化 | 让人物自然变化，而不污染初始设定 |
| 原始剧本 | 剧本正文、带参与者标记的用户消息、角色消息、系统事件 | 保存细节、语气与可审计的历史 |
| 活动场景 | 场景引子、场景摘要、未压缩条目计数 | 以少量 token 告诉主模型“此刻正在发生什么” |
| 剧情弧线 | 一个阶段的标题与摘要 | 保存跨场景的关系和事件走向 |
| 长期事实 | 承诺、重要事件、世界事实、关系变化 | 用语义相关度、重要性、置信度、时间衰减与未解决状态重排后检索 |
| 意图 | 延迟回复、后续联系、待决定的行动 | 记录可能的未来，不把未来写成事实 |

基础设定与演化覆写共同构成主模型看到的“当前角色状态”。例如，初始设定可以是“内向、谨慎”，而经过多次有证据的互动后，覆写层增加“在用户面前更愿意主动表达”，而不是直接把初始人设改成“外向”。

## 3. 一条私聊消息的完整流程

~~~mermaid
sequenceDiagram
  participant A as 账号 A
  participant B as 账号 B
  participant K as Koishi / InterludeService
  participant D as 数据库
  participant N as 主叙事模型
  participant C as 后台压缩模型

  A->>K: 私聊消息
  K->>D: 读取共享主剧本、A 的关系分支和其他账号的忙碌统计
  K->>D: 只取消 A 尚未发出的延迟回复
  K->>N: 单次连续写作请求
  N-->>K: 剧本正文 + 当前 interaction + 可选跨账号 action
  K->>D: 验证并持久化结果
  alt 角色给 A 回复
    K-->>A: 发送角色消息
  else 角色同时想起 B
    K-->>B: 发送经过权限检查的跨账号消息
  else 延迟回复或沉默
    K-->>A: 当前不发送消息
  end
  K-->>C: 达到阈值后异步压缩已发生剧本
  C-->>D: 场景摘要、长期事实和状态提案
~~~

对应的执行步骤：

1. 根据机器人账号查找共享主故事，再找到当前 QQ 对应的参与者关系分支。
2. 将真实现在记为 now。系统只允许主模型补写 cursorAt 到 now 的内容。
3. 若当前账号有尚未发送的 delayed-reply 或跨账号延迟联系，且它再次发消息，先只取消发往这个账号的旧计划；不会误删其他账号的计划。
4. 被覆盖的延迟消息内容和原定时间不会丢失，而是作为 supersededDelayedReplies 提供给本次主模型。模型因此可以理解“角色本来想联系，但新消息又来了”。
5. 组装单次主模型请求：时间段、当前参与者关系、共享场景、其他账号的待回复统计、最近原始剧本、活动场景、剧情弧线、基础设定、演化覆写、到期意图；长期事实会先用当前消息、未解决线索和到期计划进行语义召回，再重排到受控数量。
6. 主模型连续写作：先补写过去时间内角色的生活，再把用户消息写进现实，最后决定当前时刻角色是否已经看见和回复。
7. 插件验证输出。未来时间的剧本条目会被拒绝；未来行为只能写成 intent 或 delayed reply。
8. immediate 消息按 participantId 投递到目标账号。delayed 消息保存为带目标参与者的意图，等待到期后再由模型复核，而不是由定时器机械发送。
9. 主回合返回给用户后，后台压缩器按阈值整理本场景的已发生历史；它不在这条私聊的等待路径中。

因此，一条消息不会触发“先补写一次、再判断回复一次”的两次主模型调用。

## 4. 主叙事模型的输入与输出

### 输入

主模型请求由插件固定系统约束、用户可编辑的主叙事提示词/格式补充提示词/固定规则/文风提示词，以及结构化故事上下文组成。

固定约束要求模型：

- 返回 JSON，不使用 Markdown 包裹。
- script 只能叙述现在之前已经发生的事情。
- interaction 明确说明是否看见、是否回复、回复方式和延迟时间。
- 角色有独立生活，用户消息不是必须回应的命令。
- 被覆盖的延迟回复只能作为上下文，不能自动照发。

`mainPrompt` 负责创作方向，`formatPrompt` 负责补充结构化输出说明，`fixedPrompt` 负责长期规则，`stylePrompt` 负责 script 正文文风。它们都不能推翻插件固定的 JSON 和时间校验。

### 输出协议

~~~json
{
  "script": "晚上七点四十七分，林知遥刚把洗好的杯子倒扣在沥水架上……",
  "interaction": {
    "seen": true,
    "reply": {
      "mode": "delayed",
      "content": "我刚有点事。",
      "sendAt": "2026-08-08T12:02:00.000Z"
    }
  },
  "crossConversationActions": [
    {
      "participantId": "onebot:123456:friend-qq",
      "mode": "immediate",
      "content": "我这边有点事，晚点找你。"
    }
  ],
  "memories": [
    {
      "category": "promise",
      "content": "她答应忙完会告诉用户结果。",
      "importance": 0.8
    }
  ],
  "intents": [
    {
      "type": "follow-up",
      "summary": "忙完后考虑联系用户。",
      "notBefore": "2026-08-08T13:00:00.000Z"
    }
  ],
  "statePatch": {
    "openThreads": ["用户的请求仍未答复"]
  }
}
~~~

interaction.reply.mode 的含义：

| mode | 含义 |
| --- | --- |
| none | 当前不发消息。seen=false 为未注意到，seen=true 为看见但不回答 |
| immediate | 角色已经在当前时刻发送 content |
| delayed | 角色现在决定稍后发送。sendAt 必须严格晚于 now |

script 是剧本，interaction 是机器可执行的幕前结果。两者分离，既保留文学连续性，也保证 Koishi 能正确发送或不发送消息。

`crossConversationActions` 是共享主剧本专用的可选动作。它只能指向已经加入同一主剧本、并通过 OneBot 权限检查的参与者。默认只把其他账号的未读数、待回复数和时间统计提供给模型；如果打开 `sharedStory.shareParticipantDetails`，才会额外提供其他关系的历史剧本，但其他参与者的资料与关系字段仍保持匿名，因此涉及真实聊天时仍应先确认参与者同意。

同一主剧本的所有账号共用一条写作队列。账号 A 的消息正在触发模型推理时，账号 B 的消息会排在同一个队列中，而不会启动第二个互相矛盾的角色副本。

从旧版升级时，插件会在账号首次返回时把旧的“每账号故事”迁移为对应机器人的共享主剧本参与者；如果同一机器人下还有其它旧账号故事，它们会在各自首次返回时合并并标记为 archived，避免后台继续把旧副本当成另一种生活推进。

## 5. 延迟回复为什么能像真实聊天一样被打断

延迟回复不是“先生成一句话，定时后无条件发送”。

当主模型选择 delayed 时，插件保存一条 delayed-reply intent。到期时系统会再次提供它给主模型，询问角色在那个真实时刻是否真的发送。

如果用户在到期前再次发消息：

1. 旧 delayed-reply 立即标记 cancelled。
2. 旧计划作为被打断的上下文交给下一次主写作。
3. 主模型可以因连续提示音感到烦躁而立刻回复，也可以继续沉默或重新安排延迟。
4. 旧内容绝不会在之后突然冒出来。

这条规则让“多发几条消息影响角色反应”成为剧情的一部分，而不是单纯的队列覆盖。

## 自动剧情推进与休息期

当没有活跃对话时，插件会自动补写角色已经经历的生活，而不是永远等用户先说话。

- 默认普通时段为 40 分钟，带 5 分钟随机浮动，也就是大约每 35–45 分钟补写一次。
- 每次自动推进都从故事 cursorAt 写到当前真实时间，所以模型补写的是上一段真实经过的生活，而不是预演未来。
- 默认夜间休息窗口为 23:00–07:00。在该窗口内，每次间隔随机取 120–240 分钟，适合用较少回合补写睡眠、休息和清晨前后的状态变化。
- restWindows 支持多条记录，也支持跨午夜。例如午休、夜班后的补觉、周末的不同作息都可以单独定义。
- 每个故事使用自身的 timezone 判断当前是否处于休息窗口。

对话会暂时暂停生活补写：

1. 用户每发一条消息，自动推进至少暂停 pauseAfterConversationMinutes（默认 40 分钟）。
2. 如果角色安排了延迟回复，暂停期会延长到“延迟回复完成后再过 40 分钟”。
3. 到期的延迟回复仍会被处理；暂停的是日常生活补写，不是已经计划好的回复裁决。
4. 用户再次发消息会覆盖旧延迟回复，并重新开始静默计时。

自动调度的下一个时间点会写入故事状态，而不是每次后台扫描时重新随机，因此重启后也不会变成高频、机械的推进。

## 6. 分层记忆：如何省 token 但不丢剧本状态

主模型不会读取整个历史。它读取的是连续性包：

1. 最近原始剧本条目：保留刚刚发生的动作、语气、措辞和未完成动作。
2. 当前场景引子与摘要：保留本场景的地点、人物、情绪、冲突与未完事项。
3. 当前剧情弧线：保留更长周期的关系变化和主线。
4. 基础设定与演化覆写：提供角色与世界的当前轮廓。
5. 长期事实：从大量旧事件中语义召回与当前消息最相关的项目，再结合叙事重要性、可信度、时间和未解决事项重排。
6. 当前用户消息、到期意图和被打断的延迟计划。

这样，模型可以知道“她刚洗完最后一个碗”“她答应过会给结果”“两人最近关系在缓慢靠近”，却不必在每次请求中携带数月全文。

### 6.1 后台压缩器

达到下面任一条件时，活动场景可以被压缩：

- 未压缩剧本条目达到 memory.sceneEntryThreshold。
- 未压缩内容字符数达到 memory.sceneCharacterThreshold。
- 管理员执行 interlude.compact。

压缩器是独立的低成本模型调用，建议使用更便宜、低温度的模型。它只看到已发生内容，输出：

- scene.hook：一句短的接续提示。
- scene.summary：本场景的压缩叙事摘要。
- arc：当前剧情阶段的标题和摘要。
- facts：值得长期保存的事实候选。
- statePatches：角色、关系、世界的变化提案及其证据。

压缩是异步的：主模型回复完成之后才排队执行，因此不会给私聊额外增加一次大模型延迟。

### 6.2 长期事实

长期事实存放在 interlude_fact。每条事实带有：

- scope：character、world、relationship、event 或 promise。
- importance：叙事重要性。
- confidence：它是否被历史充分支持。
- unresolved：是否仍是未完成的承诺、问题或冲突。
- embedding：可选的语义向量，只用于检索，绝不传给主叙事模型。
- sourceEntryIds：可追溯到哪些原始剧本条目。
- status：active 或 superseded。

在用户消息回合，插件会把“当前用户消息 + openThreads + 到期/被打断的计划”作为检索 query。若配置了 OpenAI-compatible embedding 模型，会比较 query 与事实向量的余弦相似度，再与可配置的“重要度、置信度、最近出现时间、未解决状态”加权重排，并受 memory.factLimit 控制。重复事实会合并而不是无限追加。

向量服务是增强层而不是依赖：模型未配置、旧事实尚未回填向量、服务超时或请求失败时，系统自动回退到原有的规则排序，主模型回合照常进行。新事实会在压缩时直接写入向量；历史事实则由后台按小批次补齐，避免把一次性重建索引塞进用户私聊的等待路径。

### 6.3 设定演化与证据门槛

压缩器不能直接修改 story.setting。它只能写入 interlude_state_patch 提案：

- target：character、relationship 或 world。
- path：变化的具体方向，例如 traits.patience。
- proposedValue：建议写入覆盖层的内容。
- evidence：为什么可以认为发生了变化。
- sourceEntryIds：证据来自哪些剧本条目。
- confidence 和 impact：置信度与普通/重大变化标识。

插件只在满足门槛时将提案标记 applied 并更新 state.settingOverlay：

- 普通变化需要达到 statePatchConfidenceThreshold，并且至少具有 statePatchMinEvidence 条证据。
- 重大变化允许较少证据，但必须达到更高的 majorStatePatchConfidenceThreshold。
- 未满足条件的提案仍被保留为 proposed，便于审计或后续人工处理。

这避免了“用户夸了角色一次，角色从内向变成外向”这类突变。

## 7. 数据表

| 表 | 职责 |
| --- | --- |
| interlude_story | 故事身份、基础设定、演化状态、时间游标 |
| interlude_participant | 每个 QQ 的人物代号、关系资料、未读/待回复状态和投递频道 |
| interlude_script_entry | 带 participantId 的原始剧本、用户事件、可见角色消息、取消事件 |
| interlude_intent | 带目标 participantId 的延迟回复和其它未来意图 |
| interlude_memory | 可全局或按参与者归属的耐久记忆 |
| interlude_scene | 活动或已关闭场景、摘要、未压缩计数 |
| interlude_arc | 剧情弧线摘要 |
| interlude_fact | 压缩器抽取的长期事实 |
| interlude_state_patch | 带证据的全局或关系分支变化提案和应用状态 |

原始剧本不会因为压缩而删除。摘要是降低上下文成本的索引层，不是唯一真相来源；需要时可以使用原始条目重新压缩。

## 8. 安装与最小配置

开发仓库的 koishi.yml 已加载本地插件。安装后可以在私聊中创建一个故事：

~~~text
interlude.init 林知遥
interlude.setup {"character":{"name":"林知遥","profile":"夜班花店店员，习惯把疲惫藏在很轻的语气里。"},"relationship":"大学旧友，失联多年后重新联系。","world":"当代上海。","style":"现实主义日常叙事，克制、具体、不过度戏剧化。"}
~~~

默认叙事器是静默的：它不会擅自扮演角色。要启用生成，请在 Koishi Console 中将 model.mode 设置为 openai-compatible，并配置至少一个 OpenAI Chat Completions 兼容服务商。

~~~yaml
./plugins/hds-interlude:default:
  model:
    mode: openai-compatible
    providers:
      - id: primary
        label: Primary
        enabled: true
        endpoint: https://example.com/v1/chat/completions
        apiKey: your-api-key
        model: your-main-model
        temperature: 0.8
        topP: 1
        maxTokens: 4096
        timeout: 60000
        responseFormat: json-object
        extraHeaders: ''
        extraBody: ''
    failover:
      enabled: true
      strategy: priority
      maxAttemptsPerProvider: 1
      cooldownMinutes: 5
    mainPrompt: >-
      Continue the character-centered life script with grounded actions,
      motives, relationships, and ordinary time passing.
    formatPrompt: ''
    fixedPrompt: ''
    stylePrompt: Use restrained, realistic prose with concrete daily details.
    compaction:
      enabled: true
      providerId: primary
      model: your-cheaper-model
      temperature: 0.3
      topP: 1
      maxTokens: 2048
      timeout: 60000
      responseFormat: json-object
      mainPrompt: >-
        Compress completed scenes into concise continuity notes while preserving
        causality, promises, unresolved matters, and gradual character change.
      fixedPrompt: ''
      stylePrompt: Concise, factual, chronological, and concrete.
    embedding:
      enabled: true
      providerId: primary
      # 留空时由 /v1/chat/completions 自动推导为 /v1/embeddings。
      endpoint: ''
      model: text-embedding-3-small
      # 0 表示不传 dimensions，使用服务商默认值。
      dimensions: 0
      # embedding 失败会降级，建议按实际延迟控制得更短。
      timeout: 10000
      maxInputCharacters: 4000
      # 每次后台记忆维护补齐的旧事实向量数。
      backfillBatchSize: 5
  sharedStory:
    enabled: true
    autoEnrollParticipants: true
    allowCrossConversationMessages: true
    shareParticipantDetails: false
    maxCrossConversationActions: 1
    participantContextLimit: 6
  runtime:
    cancelDelayedRepliesOnUserMessage: true
    allowProactiveMessages: false
    autoAdvanceEnabled: true
    autoAdvanceIntervalMinutes: 40
    autoAdvanceJitterMinutes: 5
    pauseAfterConversationMinutes: 40
    restWindows:
      - enabled: true
        label: night sleep
        start: '23:00'
        end: '07:00'
        minIntervalMinutes: 120
        maxIntervalMinutes: 240
  memory:
    enabled: true
    backgroundIntervalMinutes: 10
    maxStoriesPerCompactionRun: 20
    sceneEntryThreshold: 12
    sceneCharacterThreshold: 8000
    compactionEntryLimit: 80
    compactionCharacterLimit: 32000
    sceneHookCharacters: 2000
    sceneSummaryCharacters: 8000
    arcSummaryCharacters: 12000
    recentEntryLimit: 30
    factLimit: 20
    factContentCharacters: 4000
    factImportanceWeight: 0.5
    factConfidenceWeight: 0.35
    factRecencyWeight: 0.15
    semanticWeight: 0.55
    unresolvedWeight: 0.2
    statePatchConfidenceThreshold: 0.82
    majorStatePatchConfidenceThreshold: 0.95
    statePatchMinEvidence: 2
    autoApplyStatePatches: true
    allowMajorStateChanges: true
    maxFactsPerStory: 200
~~~

model.providers 支持多个服务商。主模型调用失败时，系统可以按优先级或轮询方式故障切换。压缩模型可复用主模型，也可以选用同一服务商下更便宜的模型。

embedding 默认关闭，避免在未明确配置成本与隐私策略前额外发送文本。启用后，providerId 复用对应主服务商的 API Key 和额外请求头；embedding.endpoint 留空仅支持标准的 `/chat/completions` → `/embeddings` 推导，其他网关应填写完整接口地址。

## 9. Koishi 配置项

本节是配置索引与最短填写路线；字段的完整语义、边界和排障建议见同目录的 [`CONFIGURATION_GUIDE.md`](CONFIGURATION_GUIDE.md)。同一配置只在一个位置展开解释，避免 README 与 Console 文案产生分歧。

Console 中的字段只保留了适合测试员快速理解的短说明；完整的字段解释、推荐值、账号控制示例和常见故障排查见
[CONFIGURATION_GUIDE.md](CONFIGURATION_GUIDE.md)。

### OneBot / NapCat QQ 账号控制

如果通过 OneBot 或 NapCat 连接 QQ，Koishi 可能同时收到多个机器人账号的事件。`onebot` 配置段就是“账号闸门”：它决定哪些机器人可以代表角色发言，以及哪些 QQ 用户可以触发故事。它只影响 `platform=onebot`，QQ 以外的平台保持原有行为。

在 Console 中按下面方式填写：

| 选项 | 填什么 | 推荐测试值 |
| --- | --- | --- |
| `onebot.enabled` | 是否启用账号控制 | 打开 |
| `botAccounts` | NapCat 登录的机器人 QQ 号、备注、启用开关 | 只添加要说话的机器人 |
| `userAccounts` | 测试员 QQ 号、角色称呼、人物资料、初始关系、启用开关 | 只添加测试员，并为每个账号填写身份 |
| `ignoreSelfMessages` | 忽略机器人自己发出的回显 | 打开 |

NapCat/OneBot 会把当前机器人账号放在 `selfId`，把私聊发件人放在 `userId`。因此，`botAccounts` 填机器人 QQ，`userAccounts` 填允许互动的真人 QQ。HDSI 会自动兼容 `123456`、`private:123456`、`onebot:123456` 等传输前缀，推荐填写纯数字。HDSI 始终使用白名单：用户表为空时所有 QQ 都会被拒绝；每一行的 `enabled` 关闭后立即失效，不需要删除这一行。每个白名单行还决定角色眼中的这个人是谁，至少应填写 `label`、`profile` 和 `relationship`。

建议的安全测试配置：

```yaml
onebot:
  enabled: true
  botAccounts:
    - { qq: '机器人QQ号', label: '测试机器人', enabled: true }
  userAccounts:
    - qq: '测试员QQ号'
      label: '小林'
      personId: 'friend-a'
      profile: '主角的大学朋友，平时在附近工作。'
      relationship: '熟悉但最近联系不多。'
      enabled: true
  ignoreSelfMessages: true
```

行为说明：未授权用户的私聊不会创建故事、不会调用主模型，也不会收到角色回复；关闭机器人账号后，已有故事的自动推进、延迟回复和主动消息也会被跳过；用户从白名单移除后，旧的延迟计划在真正发送前会再次被拦截。管理命令同样受此权限控制。群聊不会被 HDSI 私聊中间件接管。

### OneBot 测试清单

1. 用 NapCat 登录机器人 QQ，并在 Console 的 `botAccounts` 填入这个 QQ。
2. 在 `userAccounts` 添加测试员 QQ，并为每一行填写角色称呼、人物资料和初始关系。
3. 测试员发送 `interlude.init 主角名字` 后再发送普通消息，应能正常生成回复。
4. 用未加入白名单的 QQ 发消息，不应创建故事，也不应触发模型。
5. 关闭机器人行或移除测试员行；再次发消息，以及等待已有延迟回复到点，均不应收到角色消息。


| 配置段 | 关键内容 |
| --- | --- |
| model | 服务商、密钥、模型、温度、top-p、token 上限、超时、JSON 模式、额外请求头/请求体、故障切换 |
| model.mainPrompt / model.formatPrompt | 主叙事要求与输出格式补充说明 |
| model.fixedPrompt / model.stylePrompt | 主模型永久规则与全局剧本文风 |
| model.compaction | 后台压缩模型、采样参数、JSON 模式、压缩主提示词、固定规则与文风 |
| model.embedding | embedding 服务商、模型、endpoint、维度、超时、输入裁剪与历史事实向量回填批量 |
| runtime | 私聊接管、自动建档、40 分钟生活补写、休息窗口、主动联系、上下文长度、延迟回复规则 |
| sharedStory | 多账号共用主剧本、自动加入、跨账号联系上限、隐私详情共享和人物预设 |
| memory | 压缩节奏、单次输入上限、摘要长度、语义/重要度/置信度/时效/未解决事项检索权重、演化自动应用与门槛 |
| storyDefaults | 新故事的主角、用户、关系、世界、配角、地点、时区、文风预设 |
| logging | 插件日志级别、紧凑/详细格式、剧本预览长度 |

### 9.1 给测试员的最短填写路线

第一次测试不需要理解全部选项。按下面顺序填写即可：

1. 打开 Koishi Console 的 `hds-interlude` 配置页，在 `model.mode` 选择 `openai-compatible`。
2. 在 `model.providers` 保留第一行，只填四项：`enabled` 打开、`endpoint`、`apiKey`、`model`。其它先保持默认。
3. 在 `storyDefaults` 至少填写 `characterName`、`characterProfile`、`relationship`、`world` 和 `style`；这些就是测试角色的起点。
4. 首轮建议保持 `model.compaction.enabled=true`、`model.embedding.enabled=false`、`runtime.allowProactiveMessages=false`。这样会有记忆整理，但不会额外配置向量服务，也不会在无人发言时主动打扰测试员。
5. 保存/重载配置后，在测试私聊中发送 `interlude.init 主角名字`，再像普通聊天一样发一条消息。

如果要测试多人共享：保持 `sharedStory.enabled=true`，把每个 QQ 加入 `onebot.userAccounts`，并在对应白名单行填写 `label`、`profile`、`relationship`。然后直接用第二个账号发送 `interlude.init` 或普通消息，它会加入同一个机器人主剧本，而不是创建第二部生活。默认不把其他账号的关系详情发给远程模型，只提供匿名的待回复统计；确认测试参与者同意后，才考虑打开 `sharedStory.shareParticipantDetails`。

填写 API Key 时请当作密码处理：不要复制到测试报告、群聊记录、截图或公开文档。

### 9.2 模型服务：哪些是必填，哪些先别碰

`model.mode`：

| 选项 | 测试员应如何选择 |
| --- | --- |
| `fallback` | 不会调用任何 AI，只用来确认插件、命令和数据库安装正常。角色不会真的回复。 |
| `openai-compatible` | 正式功能测试必须选它。服务商需要提供 OpenAI Chat Completions 兼容接口。 |

`model.providers` 在 Console 中是可折叠的服务商列表（每个服务商展开后纵向填写，窄屏也能正常操作）；首次测试只需要第一项：

| 字段 | 怎么填 / 不填会怎样 |
| --- | --- |
| `id` | 内部代号，保持 `primary` 即可。压缩模型和向量模型会用它复用 API Key。 |
| `label` | 页面显示名，例如“主模型”。只方便人看，不影响实际调用。 |
| `enabled` | 打开才会使用这行服务商。 |
| `endpoint` | 服务商提供的完整“聊天补全”接口，例如 `https://域名/v1/chat/completions`。不是网页首页，也不是 `/models`。 |
| `apiKey` | 服务商的密钥；务必保密。 |
| `model` | 服务商文档里的聊天模型名称。填写错误通常会提示模型不存在。 |
| `temperature` | 写作变化程度。首次建议 `0.8`；低于 `0.6` 会较死板，高于 `1.0` 更容易跳脱。 |
| `topP` | 高级随机性参数；不了解时保持 `1`，不要和 temperature 一起乱调。 |
| `maxTokens` | 单次最多生成多长。首次用 `4096`；越大越完整，也越慢、越贵。`0` 表示不主动限制。 |
| `timeout` | 最长等候时间，单位毫秒。`60000` 就是 60 秒；第一次保持默认。 |
| `responseFormat` | 服务商支持 JSON Mode 时选 `json-object`。如果服务商报“不支持 response_format”，改成 `prompt-only`。 |
| `extraHeaders` | 只有服务商明确要求额外请求头才填，且必须是 JSON。正常情况留空。 |
| `extraBody` | 只有服务商文档要求额外模型参数才填，且必须是 JSON。不会写 JSON 就留空。 |

`model.failover`（故障切换）只有准备了两行及以上 providers 才需要：`enabled` 表示主服务失败时试备用服务；`priority` 表示平时总用第一行、失败才切换，最适合测试；`round-robin` 才是轮流调用；`maxAttemptsPerProvider=1` 表示失败后尽快切换；`cooldownMinutes=5` 表示失败服务 5 分钟内暂不再试。

`model.mainPrompt` 可以写主模型的完整创作方向；`model.formatPrompt` 可以补充结构化字段说明；`model.fixedPrompt` 可以写所有故事都必须遵守的规则；`model.stylePrompt` 是全局文风。四项都可以在 Console 直接编辑。

### 9.2.1 多账号共享主剧本

`sharedStory` 控制“一个机器人、多个关系对象、一个主剧本”的行为。数据层和消息队列的工作方式见第 2、3 节；这里仅列出可调字段：

| 字段 | 含义 |
| --- | --- |
| `enabled` | 打开后故事按机器人账号归档，多个获授权 QQ 进入同一主剧本；关闭可临时退回旧的每账号故事模式。 |
| `autoEnrollParticipants` | 新 QQ 第一次私聊时自动成为主剧本参与者。 |
| `allowCrossConversationMessages` | 允许模型在当前回合顺带给其他参与者发消息。关闭后仍共享生活，但不会跨账号主动联系。 |
| `shareParticipantDetails` | 是否把其他账号的历史剧本交给模型。涉及隐私，默认关闭；即使打开，其他参与者的资料与关系字段仍不直接发送，模型只会通过剧本内容了解已经发生的事情。 |
| `maxCrossConversationActions` | 一次写作最多跨账号发送几条消息。建议保持 `1`，避免角色突然群发。 |
| `participantContextLimit` | 每次主模型最多读取多少个其他参与者的摘要。 |
| `managerAccounts` | 可以使用 `interlude.setup`、暂停、手动推进和压缩命令的 QQ。留空保持旧行为：所有获授权账号都可管理。多人真实测试建议只填测试管理员 QQ。 |
| `participantPresets` | 仅用于读取旧版 YAML 的兼容字段；新配置统一使用 `onebot.userAccounts` 白名单行。 |

旧版 `participantPresets` 示例（仅用于迁移旧 YAML，Console 中不再显示）：

```yaml
sharedStory:
  enabled: true
  autoEnrollParticipants: true
  allowCrossConversationMessages: true
  shareParticipantDetails: false
  maxCrossConversationActions: 1
  participantContextLimit: 6
  participantPresets:
    - qq: '10001'
      personId: 'friend-a'
      label: '小林'
      profile: '主角的大学朋友。'
      relationship: '熟悉但最近联系不多。'
      enabled: true
    - qq: '10002'
      personId: 'friend-b'
      label: '阿周'
      profile: '主角的同事。'
      relationship: '工作关系，偶尔私聊。'
      enabled: true
```

### 9.3 压缩模型与向量模型：第二阶段再测试

`model.compaction` 是后台“记忆整理员”。它把已发生的剧本整理为场景摘要、长期事实和人物变化线索，不在用户正在等待回复的路径上运行。

| 字段 | 测试建议 |
| --- | --- |
| `enabled` | 建议开启；如果只想先排查基础聊天，也可以暂时关闭。 |
| `providerId` | 填 `primary` 就复用第一行服务商；留空也会自动选择可用服务商。 |
| `model` | 可选的低价模型名。首次测试留空，直接复用聊天模型。 |
| `temperature` / `topP` | 整理要稳定，保持 `0.3` / `1`。 |
| `maxTokens` / `timeout` | 首次保持 `2048` / `60000`。压缩失败不影响当前聊天。 |
| `responseFormat` | 规则和聊天模型相同：支持 JSON Mode 就用 `json-object`，否则用 `prompt-only`。 |
| `mainPrompt` | 压缩整理的主要目标。 |
| `fixedPrompt` | 只写给整理员的规则，例如“保留承诺和未解决问题”。不需要时留空。 |
| `stylePrompt` | 摘要的写法。建议保持“简短、客观、按时间顺序”，最省 token。 |

`model.embedding` 是“按意思找回旧事”的可选功能，不是首次启动的必填项：

| 字段 | 测试建议 |
| --- | --- |
| `enabled` | 第一轮关闭；普通记忆、聊天稳定后再打开。向量服务异常时会自动退回普通排序。 |
| `providerId` | 使用哪一行 providers 的 API Key，通常填 `primary` 或留空。 |
| `endpoint` | 填向量（Embeddings）接口。聊天地址以 `/chat/completions` 结尾时可留空自动推导；不标准网关需按文档填写完整地址。 |
| `model` | 向量模型名，不是聊天模型名，例如 `text-embedding-3-small`。没有向量服务就不要填写。 |
| `dimensions` | 高级项。通常填 `0`，由服务商决定。 |
| `timeout` | 默认 `10000`（10 秒）。超时只降级检索，不会让聊天失败。 |
| `maxInputCharacters` | 默认 `4000`。越大可能更准，但会更慢、更贵。 |
| `backfillBatchSize` | 每轮后台补多少条旧事实向量；默认 `5` 平稳补齐，`0` 不补旧记录。 |

### 9.4 测试角色设定：直接写人话

`storyDefaults` 不要求测试员懂提示词。它是新故事创建时的“开场资料”；可直接用完整中文句子填写。

| 字段 | 推荐填写方式 |
| --- | --- |
| `characterName` | 主角名字，例如“林知遥”。 |
| `characterProfile` | 写职业、作息、性格、习惯、近期压力和说话方式。例如“夜班花店店员，慢热，忙时会短暂不回消息”。 |
| `userProfile` | 新参与者的默认资料；不想替真实测试员预设身份就留空，也可以在 `onebot.userAccounts` 白名单行按 QQ 覆盖。 |
| `relationship` | 新参与者和主角的默认关系；具体账号可在 `onebot.userAccounts` 白名单行覆盖。 |
| `world` | 写时代和世界规则，例如“2026 年上海的现实生活，没有超自然元素”。 |
| `supportingCast` | 写重要配角，例如“店长周宁：主角的同事，关系普通”。没有就留空。 |
| `location` | 写主要生活地点，例如“上海静安区”。 |
| `style` | 写此故事的文风，例如“现实主义日常，细节具体，关系变化缓慢，不狗血”。 |
| `timezone` | 用于白天、睡眠和延迟回复。中国大陆通常填 `Asia/Shanghai`；美国纽约填 `America/New_York`。 |

这些内容只定义故事起点。系统允许角色在有证据的长期剧情中慢慢变化，但不会把一次普通对话直接改写成完全不同的人设。

### 9.5 自动生活与延迟回复

`runtime` 控制插件何时接管消息、角色何时继续生活。首次测试建议先保持默认；若只想测“用户发一句、角色如何反应”，可把 `autoAdvanceEnabled` 关掉。

| 字段 | 给测试员的解释 |
| --- | --- |
| `captureDirectMessages` | 是否接管已有故事的私聊。想临时停止测试但保留数据时可关闭。 |
| `autoCreate` | 新私聊是否自动建故事。打开更省步骤；关闭时需要先用 `interlude.init`。 |
| `ignoreCommandMessages` | 建议开启，避免管理命令被当作角色收到的聊天。 |
| `allowProactiveMessages` | 允许角色在用户没发新消息时主动发可见消息。首次测试建议关闭，以免意外打扰或增加调用。 |
| `sweepIntervalMinutes` | 每隔多久检查延迟回复和自动生活，默认 5 分钟；不是每次都调用模型。 |
| `minimumAdvanceMinutes` | 旧版兼容项，通常不要改；实际节奏主要看 `autoAdvanceIntervalMinutes`。 |
| `maxStoriesPerSweep` | 每次后台最多照看多少故事。单人测试保持 20。 |
| `contextEntryLimit` / `memoryLimit` | 一次带给主模型多少最近剧本/长期事实。默认 30 / 20；越大越贵、越慢。 |
| `maxScriptCharacters` / `maxMessageCharacters` | 幕后剧本和可见消息的最长字符数。首次保持 8000 / 2000。 |
| `minimumDelayedReplySeconds` / `maximumDelayedReplyMinutes` | 角色可安排延迟回复的最短秒数、最长分钟数。默认 10 秒到 24 小时。 |
| `cancelDelayedRepliesOnUserMessage` | 建议开启。用户连续发消息会取消旧延迟计划，让角色重新决定，更像真实聊天。 |
| `autoAdvanceEnabled` | 是否在无人说话时继续补写角色生活。首次可关闭，专测聊天；测“独立生活感”时再开启。 |
| `autoAdvanceIntervalMinutes` | 清醒时大约多少分钟自动补写一次生活，默认 40。数值越小，细节和成本都越高。 |
| `autoAdvanceJitterMinutes` | 自动时间前后随机浮动多少分钟。默认 5 更自然；填 0 便于固定节奏复测。 |
| `pauseAfterConversationMinutes` | 用户说完话或延迟回复完成后，先安静多久才恢复自动生活，默认 40 分钟。 |
| `restWindows` | 睡眠/午休时间表，可填多行。每行有名称、开始/结束时间、最短/最长补写间隔；时间使用 `HH:mm`，例如 `23:00` 到 `07:00` 可以跨午夜。 |

### 9.6 记忆、人物变化与日志

`memory` 是高级区。首次测试建议全部保持默认；它们不会改变模型连接，只影响长期连贯性和成本。

| 字段组 | 作用与测试建议 |
| --- | --- |
| `enabled` | 场景摘要、长期事实和角色缓慢变化总开关。建议开启。 |
| `backgroundIntervalMinutes` | 多久检查一次是否需要整理旧剧本，默认 10 分钟。 |
| `sceneEntryThreshold` / `sceneCharacterThreshold` | 新剧本达到多少条或多少字就整理一次，任一达到即触发。默认 12 条或 8000 字。 |
| `recentEntryLimit` / `factLimit` | 给主模型的最近原文和长期事实数量。默认 30 / 20；增大会增加 token。 |
| `maxFactsPerStory` | 每个故事最多保存多少长期事实，默认 200。 |
| `maxStoriesPerCompactionRun` | 每轮最多整理多少故事，单人测试保持 20。 |
| `compactionEntryLimit` / `compactionCharacterLimit` | 一次整理最多读多少条/多少字，默认 80 / 32000，是成本保护阀。 |
| `sceneHookCharacters` / `sceneSummaryCharacters` / `arcSummaryCharacters` / `factContentCharacters` | 各类摘要的最大长度。初次测试不用调。 |
| `factImportanceWeight` / `factConfidenceWeight` / `factRecencyWeight` | 长期事实按重要性、可信度、最近出现时间的权重。默认 0.5 / 0.35 / 0.15。 |
| `semanticWeight` | 启用 embedding 后，当前消息与旧事“意思相近”的权重。默认 0.55；没有向量服务时自动忽略。 |
| `unresolvedWeight` | 未完成承诺、问题或冲突的额外优先级。默认 0.2。 |
| `statePatchConfidenceThreshold` / `statePatchMinEvidence` | 普通性格和关系变化的保守程度。默认要求较高置信度且至少两条证据，避免一次对话改人设。 |
| `majorStatePatchConfidenceThreshold` / `allowMajorStateChanges` | 重大变化的更严格门槛和自动应用开关。保守测试可关闭自动重大变化。 |
| `autoApplyStatePatches` | 是否自动应用满足门槛的慢变化；想人工审核每次变化时关闭。 |

`logging` 只影响排查信息，不影响角色：默认 `level=info`、`format=detailed` 会用中文分行显示收到私聊、模型决策完成、消息投递、自动推进和压缩完成；出现 API 或模型问题时可临时切到 `debug`。`logScriptPreview` 可能把私聊内容写进日志，排查后应关闭。

推荐实践：

- 主模型温度可以在 0.7 到 1.0；压缩模型通常使用 0.2 到 0.4。
- 叙事模型应有足够输出长度，避免 script 被截断。
- 压缩模型不需要很强的文采，更需要稳定、可控、低成本的结构化抽取能力。
- 生产环境不要在日志里长期开启完整剧本预览，其中可能包含私聊内容。

## 10. 命令

| 命令 | 作用 |
| --- | --- |
| interlude.init [name] | 创建共享主剧本，或把当前 QQ 加入已有主剧本 |
| interlude.setup <json> | 显式合并基础设定，也就是修改 canon |
| interlude.status | 查看主剧本状态、关系人数、游标与模型模式 |
| interlude.pause / interlude.resume | 暂停或恢复自动处理 |
| interlude.advance | 手动将故事推进到真实现在 |
| interlude.timeline [limit] | 查看最近原始剧本 |
| interlude.memory [limit] | 查看主回合产出的耐久记忆 |
| interlude.context | 查看活动场景、剧情弧线、演化覆写和已检索事实 |
| interlude.compact | 立即请求一次记忆压缩 |

## 11. 代码结构和扩展点

| 文件 | 职责 |
| --- | --- |
| src/index.ts | Koishi 插件入口、Console Schema、命令、私聊中间件 |
| src/service.ts | 故事生命周期、串行队列、持久化、延迟回复、后台调度、压缩、状态演化 |
| src/narrator.ts | OpenAI 兼容调用、故障切换、主写作提示词、压缩提示词、JSON 解析 |
| src/database.ts | Koishi 数据表声明 |
| src/types.ts | 跨模块的故事、剧本、意图、记忆、压缩协议类型 |

可以替换主叙事器或压缩器：

~~~ts
ctx.interlude.setNarrator(myNarrativeProvider)
ctx.interlude.setCompactor(myNarrativeCompactor)
~~~

主叙事器实现 NarrativeProvider.decide(request)。压缩器实现 NarrativeCompactor.compact(request)。二者都是结构化接口，因此可以改接本地模型、任务队列、RAG 服务或专门的长期记忆服务。

## 12. 运行边界

- HDSI 提供叙事连续性机制，不保证模型生成的文学质量、事实正确性或内容安全。
- 延迟回复到期后会再次做剧情判断，不是一个无条件发送定时器。
- 压缩摘要是辅助记忆。原始剧本保留在数据库中，允许审计和重建。
- 当前串行队列位于单个 Node.js 进程内。多实例部署需要分布式锁。
- 长期运行时，数据库体积、检索质量、摘要漂移和隐私保护需要额外的生产级方案。
- 多账号共享并不等于默认公开彼此私聊：`sharedStory.shareParticipantDetails=false` 时，主模型不会读取其他参与者的剧本内容，只会获得匿名忙碌统计。若要打开历史共享，应先取得所有参与者同意并评估模型服务商的数据处理方式。
