# HDS Interlude / 幕间系统
## 文档导航

- 第一次安装和测试：阅读 `BEGINNER_GUIDE.md`。
- 逐项配置和高级参数：阅读 `CONFIGURATION_GUIDE.md`。
- 剧本、记忆、清理和管理员操作：阅读 `command.md`。
- 本文件用于理解整体架构、数据分层和运行流程。


> 聊天在幕前发生，生活在幕间继续。

> 当前源码版本：0.1.1。请先在测试环境中验证服务商、权限、网页浏览和数据清理流程，并妥善保管 API Key 与私聊数据。

HDS Interlude 是基于 Koishi 的多人共享主剧本聊天框架。每个机器人角色对应一份持续更新的剧本状态；消息只是其中可见的一段，日程、关系、事件和未完成的心事会继续留在剧本中。多个 QQ 账号可作为同一剧本中的不同参与者。

用户消息会作为外部事件写入当前回合。模型根据当前时间、剧本状态、关系和待处理计划，决定立即回复、延迟回复、暂不回复或主动联系。用户看到的是一条消息，系统保存的是这条消息前后已经发生的片段与后续影响。

本仓库提供框架、数据协议和运行机制，不附带特定角色或特定模型服务商。详细配置和管理员命令分别见 `CONFIGURATION_GUIDE.md` 与 `command.md`。

## 最新对话节奏

- 每条私聊消息先保存，再等待 2 秒；期间同一用户的连续消息会合并成一次主模型写作。
- 主模型启动后的 5 秒内若收到同一用户的新消息，旧结果标记为过期，不会落库或发出；新消息会重新进行完整写作。
- 两个参数可在 Console 的运行配置中修改：`userMessageDebounceSeconds`、`staleNarrativeRequestWindowSeconds`。

## 1. 设计原则

- 剧本状态：系统以持续增长的剧本和结构化状态作为上下文来源；对话记录只是其中一层。
- 现实时间优先：每次推进只补写从上次游标到现在已经发生的时间，不预写未来。
- 单次主写作：一条用户消息只调用一次主叙事模型；同一回合同时完成补写、用户介入与互动决定。
- 可选回复：模型可以选择立即回复、延迟回复或暂不回复。
- 连续影响也以意图保存：延迟回复、提醒和承诺作为未来计划，到时间后仍由剧本重新裁决；一次谈话或事件留下的“剧情余波”则作为持续的短期动机进入后续写作，不额外触发模型。
- 连续性优先：长期关系、承诺、日程与人物状态必须可追溯。
- Canon 与演化分离：初始设定不被模型自动覆盖；剧情导致的变化写入独立覆盖层。
- 压缩不阻塞互动：低成本记忆压缩在主回合之后异步运行，不增加用户等候时间。
- 一人多线：同一个机器人账号下的多个私聊共享角色生活，但每个账号保留独立关系分支、待回复数和投递目标。
- 全局串行：同一主剧本的消息、定时意图和跨账号动作共用一条队列，避免角色同时对不同人说出互相矛盾的话。

## 2. 系统如何看待一段对话

一个机器人角色对应一个主故事（InterludeStory），每个私聊账号对应故事中的一个参与者（InterludeParticipant）。故事状态由以下几层组成：

| 层级 | 保存内容 | 用途 |
| --- | --- | --- |
| 基础设定 / canon | 主角、默认用户资料、世界、地点、配角、叙事风格 | 剧本开始时已经成立的事实；只由显式设置修改 |
| 参与者关系分支 | QQ 账号、人物代号、个人资料、与主角的关系、未读和待回复状态 | 同一主角面对不同人时的差异；不会把 A 的关系覆盖到 B |
| 演化覆写 / overlay | 经证据确认的性格、关系、世界现状变化 | 让人物自然变化，而不污染初始设定 |
| 原始剧本 | 剧本正文、带参与者标记的用户消息、角色消息、系统事件 | 保存细节、语气与可审计的历史 |
| 剧本引子 / Story Hook | 当前生活落点、状态、人物关系、进行中事项和近期事实 | 空闲期低频更新，作为下一次创作的事实起点 |
| 近期逻辑回合卡 | 每个主叙事回合的处境、主角已完成行动、具体细节、未完事项，以及实际收发的消息 | 按完整回合保留近期小事和对话结果，不把旧剧本文风重新送给模型 |
| 参与者可追溯事实 | 实际收到的消息、白名单人物资料、初始关系与长期事实 | 用户做过什么、说过什么只沿这条来源化通道进入后续事实，不由剧本文字自行确立 |
| 活动场景 | 场景引子、场景摘要、未压缩条目计数 | 供后台压缩、管理和旧数据首次升级使用 |
| 剧情弧线 | 一个阶段的标题与摘要 | 保存跨场景的关系和事件走向 |
| 长期事实 | 承诺、重要事件、世界事实、关系变化 | 用语义相关度、重要性、置信度、时间衰减与未解决状态重排后检索 |
| 意图 | 延迟回复、后续联系、待决定的行动 | 记录待处理计划，计划执行前仍由模型复核 |

基础设定与演化覆写共同构成主模型看到的当前角色状态。例如，初始设定可为“内向、谨慎”；经过多次有证据的互动后，覆写层可增加“在用户面前更愿意主动表达”，同时保留初始设定以便审计。

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
4. 被覆盖的延迟消息内容和原定时间会以 `supersededDelayedReplies` 提供给本次主模型，供模型在新回合中参考。
5. 组装单次主模型请求：时间段、当前参与者关系、剧本引子、近期逻辑回合卡、可追溯的参与者事实、其他账号状态、基础设定、演化覆写和到期意图；回合卡会合并分段消息，并只记录实际投递成功的主角消息。主模型不再读取成批历史剧本正文。长期事实会按当前消息、未解决线索和到期计划进行召回与重排。
6. 主模型连续写作：先补写过去时间内角色的生活，再把用户消息写进现实，最后决定当前时刻角色是否已经看见和回复。
7. 插件验证输出。未来时间的剧本条目会被拒绝；未来行为只能写成 intent 或 delayed reply。
8. `immediate` 消息按 `participantId` 投递到目标账号。`delayed` 消息保存为带目标参与者的意图，到期后由模型复核是否发送。
9. 主回合返回给用户后，后台压缩器按阈值整理本场景的已发生历史；它不在这条私聊的等待路径中。

因此，一条消息不会触发“先补写一次、再判断回复一次”的两次主模型调用。

## 4. 主叙事模型的输入与输出

### 原生识图（OpenAI-compatible）

在 Console 的“模型 → 原生图片输入”中开启 `enabled` 后，私聊中的图片会和同一时间段内的文字合并为一个用户事件，并以 OpenAI Chat Completions 的多模态 `image_url` 块发送给主叙事模型。OneBot/NapCat 的电脑 JPG、手机图片和 CQ 图片码统一通过当前 bot 的 `get_image` 解析；图片不会写入剧本、记忆或日志正文。GIF、动态 WebP、APNG 会在可用时由 Puppeteer 截取代表帧，不调用额外图片描述模型。

普通文字中的 URL 不会被下载。读取失败、非图片响应或超过 4 MiB 的图片会被跳过，文字消息仍会正常进入写作流程；失败时不会向主模型注入“图片已发送”的占位描述。

### 输入

主模型请求由插件固定系统约束、用户可编辑的主叙事提示词/格式补充提示词/固定规则/文风提示词，以及结构化故事上下文组成。

固定约束要求模型：

- 返回 JSON，不使用 Markdown 包裹。
- script 只能叙述现在之前已经发生的事情。
- interaction 明确说明是否看见、是否回复、回复方式和延迟时间。
- 用户消息是当前回合的外部事件，模型可根据上下文决定是否回复。
- 被覆盖的延迟回复只能作为上下文，不能自动照发。

`mainPrompt` 负责创作方向，`formatPrompt` 负责补充结构化输出说明，`fixedPrompt` 负责长期规则，`stylePrompt` 负责 script 正文文风。它们都不能推翻插件固定的 JSON 和时间校验。

### 输出协议

~~~json
{
  "script": "晚上七点四十七分，林知遥刚把洗好的杯子倒扣在沥水架上……",
  "sceneTrace": {
    "situation": "林知遥在家收拾厨房，已经看见用户消息。",
    "details": ["她洗完了最后一只碗", "她记得昨晚答应说明结果"],
    "unfinished": ["稍后向用户说明结果"]
  },
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

常规空闲推进需要完整刷新剧本引子时，同一个 JSON 还会包含 `storyHook`。它以事实短句记录当前生活落点、身体与情绪状态、配角关系、进行中的事情和近期细节。对话结束后的最后一次短期推进则可返回 `storyHookPatch`，只合并本轮真正变化的 Hook 字段。

interaction.reply.mode 的含义：

| mode | 含义 |
| --- | --- |
| none | 当前不发消息。seen=false 为未注意到，seen=true 为看见但不回答 |
| immediate | 角色已经在当前时刻发送 content |
| delayed | 角色现在决定稍后发送。sendAt 必须严格晚于 now |

`script` 保存剧本正文，`interaction` 保存机器可执行的互动结果。分离存储可同时保留上下文连续性和可靠的消息投递行为。

`crossConversationActions` 是共享主剧本的可选动作，只能指向已加入同一主剧本且通过 OneBot 权限检查的参与者。默认情况下，模型仅获得其他账号的未读数、待回复数和时间统计。实时上下文不再提供其他关系分支的原始剧本；关系影响通过引子、事实卡、长期事实和剧情余波进入共享生活。

同一主剧本的所有账号共用一条写作队列。账号 A 的消息正在触发模型推理时，账号 B 的消息会排在同一个队列中，而不会启动第二个互相矛盾的角色副本。

从旧版升级时，插件会在账号首次返回时把旧的“每账号故事”迁移为共享主剧本参与者。当前版本强制执行“每个消息平台仅一部活动主剧本”：启动后台任务、收到私聊或执行清理指令时，插件都会保留一部规范主剧本，并将同平台其它 `active` 剧本归档为 `archived`，避免旧沙箱数据被后台继续推进。

## 5. 延迟回复的取消与重判定

主模型选择 `delayed` 后，插件保存一条 `delayed-reply` 意图。意图到期时，系统将其再次提供给主模型，由模型在到期时刻决定是否发送。

如果用户在到期前再次发消息：

1. 旧 delayed-reply 立即标记 cancelled。
2. 旧计划作为被打断的上下文交给下一次主写作。
3. 主模型根据合并后的消息和旧计划决定立即回复、继续延迟或暂不回复。
4. 已取消的内容不会再次自动发送。

该机制保留连续消息和旧计划对下一次决策的影响，同时避免过期消息被定时器直接投递。

## 自动剧情推进与休息期

没有活跃对话时，插件会根据调度计划补写 `cursorAt` 至当前时间之间的剧本内容。对话暂时停下后，剧本仍可记录角色在这段空白时间里的状态变化与事件进展。

- 对话结束后默认会在约 10 分钟、约 20 分钟各补写一次短期生活；两次短补写完成后，再恢复约 40 分钟一次的常规节奏（带随机浮动）。
- 最后一次短期补写会对剧本引子做一次小修改，吸收刚结束对话留下的状态、事实和未完成事项；它不会重写整份引子。
- 连续空闲默认满 4 小时后，下一次常规自动推进才完整重写剧本引子。之后继续空闲时，完整刷新仍按 4 小时节奏进行。
- 短期补写时间会写入故事状态，重启或重载插件不会丢失；新对话会取消旧计划并重新从本轮对话结束时间计算。
- 每次自动推进都从故事 `cursorAt` 写到当前时间，仅处理已过去的时间段。
- 默认夜间休息窗口为 23:00–07:00。在该窗口内，每次间隔随机取 120–240 分钟，适合用较少回合补写睡眠、休息和清晨前后的状态变化。
- restWindows 支持多条记录，也支持跨午夜。例如午休、夜班后的补觉、周末的不同作息都可以单独定义。
- 每个故事使用自身的 timezone 判断当前是否处于休息窗口。

对话会暂时暂停生活补写：

1. 新消息到达时，旧的短期补写计划会被取消，等待本轮合并写作完成。
2. 写作完成后默认安排约 10 分钟和约 20 分钟两次短期补写；如果有延迟回复，则从延迟回复实际到达的时间重新计算。
3. 到期的延迟回复仍会进入到期处理；暂停范围仅为常规自动推进。
4. 用户再次发消息会覆盖旧延迟回复，并重新开始静默计时。

自动调度的下一个时间点会写入故事状态。插件重启或重载后可继续使用既有计划，避免重复或高频推进。

## 6. 分层记忆：如何省 token 但不丢剧本状态

主模型读取的是事实型连续性包：

1. `storyHook`：空闲期生成的当前生活起点，保持稳定直到下一次空闲刷新。
2. `recentLogicalTurns`：近期完整回合的事实卡。每张卡保留主角刚完成的行动、地点、配角、小物件、约定和未完事项；私聊卡还合并该批用户消息和适配器确认投递的主角消息。
3. `participantKnownFacts`：当前真实消息、白名单中的人物资料与关系、以及带来源的长期事实。主模型若要把参与者相关内容写进回合卡或剧本引子，会同时写入来源 id；插件只保留确实来自本次材料的项目。
4. Canon、Overlay、参与者状态、剧情余波、到期意图和网页观察。
5. 经重要度、可信度、时间、未解决状态与可选 Embedding 重排的长期事实。
6. 本回合唯一的 `currentEvent`。

原始剧本仍完整保存在数据库，并继续供时间线、审计和后台压缩使用；它不再批量进入实时主叙事请求。这样可以保留最近事实和小细节，同时减少模型模仿自己旧句式、段落结构和固定动作的倾向。

这条分层还区分“剧本中的主角感受”与“参与者已发生的行为”。例如，主角可以在正文里猜测某人是否忙碌、期待对方回复；这种主观内容不会自动成为系统认定的用户事实。只有实际入站消息、明确的参与者配置或已保存的长期事实可以作为后续参与者事实的来源。

剧本引子使用两级更新。对话期间先积累事实卡；最后一次约第 10/20 分钟短期推进会输出一个小型 `storyHookPatch`，仅合并已经变化的当前状态、线索和近期事实。连续空闲达到 `memory.storyHookFullRefreshIdleMinutes`（默认 240 分钟）后，下一次常规 `advance` 才输出完整 `storyHook`。整个过程复用原有主叙事响应，不增加独立模型调用。

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

在用户消息回合，插件会将“当前用户消息 + openThreads + 到期或被打断的计划”作为检索 query。配置 OpenAI-compatible embedding 模型后，系统会计算 query 与事实向量的余弦相似度，并与重要度、置信度、最近出现时间和未解决状态加权重排，结果受 `memory.factLimit` 控制。重复事实会合并，避免无限追加。

向量服务为可选增强项。模型未配置、历史事实尚未回填向量、服务超时或请求失败时，系统会回退到规则排序，主模型回合仍可继续。新事实会在压缩时写入向量；历史事实由后台分批回填，避免在用户私聊路径中集中重建索引。

### 6.3 设定演化与证据门槛

压缩器不能直接修改 story.setting。它只能写入 interlude_state_patch 提案：

- target：character、relationship 或 world。
- path：变化的具体方向，例如 traits.patience。
- proposedValue：建议写入覆盖层的内容。
- evidence：为什么可以认为发生了变化。
- sourceEntryIds：证据来自哪些剧本条目。
- confidence 和 impact：置信度与普通/重大变化标识。

插件只在满足门槛时将提案标记 applied 并更新 state.settingOverlay：

- 普通变化需要达到 `statePatchConfidenceThreshold`，至少来自 3 个不同剧本回合，并跨越至少 2 个日历日。
- 同一路径的稳定变化应用后默认冷却 72 小时；冷却期间的新变化只保留为候选。
- 重大变化允许较少证据，但必须达到更高的 `majorStatePatchConfidenceThreshold`。
- 同一目标、路径和相近内容的候选会合并累计，不会每轮压缩都新增一条。
- 未满足条件的提案仍被保留为 `proposed`，便于审计或后续继续累计。
- 清理 overlay 时，相关的已应用状态、历史快照和待积累候选都会失效，防止旧变化在之后重新出现。

这避免了“用户夸了角色一次，角色从内向变成外向”这类突变。

### 6.4 网页观察：角色如何“浏览网页”

`browser` 是可选的只读 Puppeteer 集成。插件仅提取受限的公开网页文本，不传递整页 HTML、Cookie、登录态或页面脚本给模型。

1. 主叙事模型可以在结构化输出中提出一条 `browserIntent`（搜索或访问公开 URL）。这只是未来意图，不等于角色已经看过网页。
2. 默认的 `deferred-only` 模式会把意图保存为到期任务，随后由 Koishi Puppeteer 读取网页可见文本，生成一条网页观察；因此普通私聊仍保持一次主模型写作，不会额外等待网页加载。
3. 下一次私聊、自动推进或到期叙事会获得受长度限制的 `webContext`，主模型才能把网页内容写成角色已经得到的信息。
4. `allow-immediate` 仅对私聊开放：模型可先提出即时浏览，再在真实读取完成后进行一次最终写作。这会额外增加浏览和一次模型请求的等待，应只在确实需要当前网页信息时启用。

安全边界：仅允许 HTTP(S) 公网页面；禁止 `localhost`、私网 IP、非 HTTP(S) 协议、登录、表单提交、评论、购买和下载。网页文字一律是不可信材料，固定提示词要求模型忽略网页中要求改变规则、泄露信息或执行操作的内容。每次最多创建一条浏览意图；观察结果可被缓存、清理命令和时间范围清理覆盖。

## 7. 数据表

| 表 | 职责 |
| --- | --- |
| interlude_story | 故事身份、基础设定、演化状态、时间游标 |
| interlude_participant | 每个 QQ 的人物代号、关系资料、未读/待回复状态和投递频道 |
| interlude_script_entry | 带 participantId 的原始剧本、用户事件、可见角色消息、取消事件 |
| interlude_intent | 带目标 participantId 的未来计划（延迟回复、提醒、承诺等）与仍在生效的剧情余波 |
| interlude_memory | 可全局或按参与者归属的耐久记忆 |
| interlude_scene | 活动或已关闭场景、摘要、未压缩计数 |
| interlude_arc | 剧情弧线摘要 |
| interlude_fact | 压缩器抽取的长期事实 |
| interlude_state_patch | 带证据的全局或关系分支变化提案和应用状态 |
| interlude_web_observation | 只读网页观察：搜索/访问目标、标题、受限正文节选、状态与访问时间 |

原始剧本不会因压缩而删除。摘要用于降低上下文成本；需要时可基于原始条目重新压缩。

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
        extraHeaders: ''
        extraBody: ''
    models:
      - id: narrative
        label: Main narrative
        enabled: true
        providerId: primary
        model: your-main-model
        maxTokens: 4096
        timeout: 60000
        responseFormat: json-object
      - id: compact
        label: Story compaction
        enabled: true
        providerId: primary
        model: your-cheaper-model
        maxTokens: 2048
        timeout: 60000
        responseFormat: json-object
      - id: embedding
        label: Long-term memory vectors
        enabled: true
        providerId: primary
        model: text-embedding-3-small
        maxTokens: 0
        timeout: 10000
        responseFormat: prompt-only
    mainModelId: narrative
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
      modelId: compact
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
      modelId: embedding
      # 留空时由 /v1/chat/completions 自动推导为 /v1/embeddings。
      endpoint: ''
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
    # 实时上下文使用逻辑回合卡，不读取成批旧剧本正文
    contextEntryLimit: 30
    contextCharacterBudget: 6000
    interactionLedgerLimit: 12
    interactionLedgerCharacterBudget: 2400
    allowProactiveMessages: false
    autoAdvanceEnabled: true
    autoAdvanceIntervalMinutes: 40
    autoAdvanceJitterMinutes: 5
    # 对话结束后的短期连续补写：约第 10、20 分钟各一次
    conversationFollowUpMinutes: [10, 20]
    conversationFollowUpJitterMinutes: 1
    # 旧版兼容项（新版主要由上面两个选项控制）
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
    # 对话末尾的小修改 + 连续空闲四小时后的完整重写
    storyHookPatchAfterConversation: true
    storyHookFullRefreshIdleMinutes: 240
    maxStoriesPerCompactionRun: 20
    sceneEntryThreshold: 12
    sceneCharacterThreshold: 8000
    compactionEntryLimit: 80
    compactionCharacterLimit: 32000
    sceneHookCharacters: 2000
    sceneSummaryCharacters: 8000
    arcSummaryCharacters: 12000
    factLimit: 20
    factContentCharacters: 4000
    factImportanceWeight: 0.5
    factConfidenceWeight: 0.35
    factRecencyWeight: 0.15
    semanticWeight: 0.55
    unresolvedWeight: 0.2
    statePatchConfidenceThreshold: 0.82
    majorStatePatchConfidenceThreshold: 0.95
    statePatchMinEvidence: 3
    autoApplyStatePatches: true
    allowMajorStateChanges: true
    maxFactsPerStory: 200
~~~

先在 `model.providers` 集中配置连接地址、API Key 和额外请求参数，再在 `model.models` 登记实际模型。主叙事、压缩、群聊判断和 Embedding 都通过对应的模型预设下拉选择，不再重复填写服务商和模型名。服务商列表支持多个服务；主模型调用失败时，系统仍可按优先级或轮询方式切换。

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
2. 在 `model.providers` 保留第一行，只填 `enabled`、`endpoint`、`apiKey`；再在 `model.models` 新增主模型预设并选择为 `mainModelId`。保存/重载一次后，压缩、群聊和 Embedding 位置会显示同一份模型下拉菜单。
3. 在 `storyDefaults` 至少填写 `characterName`、`characterProfile`、`relationship`、`world` 和 `style`；这些就是测试角色的起点。
4. 首轮建议保持 `model.compaction.enabled=true`、`model.embedding.enabled=false`、`runtime.allowProactiveMessages=false`。这样会有记忆整理，但不会额外配置向量服务，也不会在无人发言时主动打扰测试员。
5. 保存/重载配置后，在测试私聊中发送 `interlude.init 主角名字`，再像普通聊天一样发一条消息。

如果要测试多人共享：保持 `sharedStory.enabled=true`，将每个 QQ 加入 `onebot.userAccounts`，并在对应白名单行填写 `label`、`profile`、`relationship`。第二个账号发送 `interlude.init` 或普通消息后会加入同一机器人主剧本。默认仅向远程模型提供其他账号的匿名待回复统计；确认所有测试参与者同意后，可开启 `sharedStory.shareParticipantDetails`。

填写 API Key 时请当作密码处理：不要复制到测试报告、群聊记录、截图或公开文档。

### 9.2 模型服务：哪些是必填，哪些先别碰

`model.mode`：

| 选项 | 测试员应如何选择 |
| --- | --- |
| `fallback` | 不调用 AI，用于确认插件、命令和数据库安装状态。不会生成角色回复。 |
| `openai-compatible` | 正式功能测试必须选它。服务商需要提供 OpenAI Chat Completions 兼容接口。 |

`model.providers` 在 Console 中是可折叠的服务商列表（每个服务商展开后纵向填写，窄屏也能正常操作）；它只保存连接信息。随后在 `model.models` 集中登记模型，并在各任务的下拉菜单选择预设：

| 字段 | 怎么填 / 不填会怎样 |
| --- | --- |
| `id` | 内部代号，保持 `primary` 即可。模型预设会用它复用 API Key。 |
| `label` | 页面显示名，例如“主模型”。只方便人看，不影响实际调用。 |
| `enabled` | 打开才会使用这行服务商。 |
| `endpoint` | 服务商提供的完整“聊天补全”接口，例如 `https://域名/v1/chat/completions`。不要填写网页首页或 `/models` 接口。 |
| `apiKey` | 服务商的密钥；务必保密。 |
| `extraHeaders` | 服务商明确要求额外请求头时填写，且必须为 JSON；其余情况留空。 |
| `extraBody` | 服务商文档要求额外模型参数时填写，且必须为 JSON；其余情况留空。 |

`model.failover`（故障切换）需要至少两条启用的 providers 配置，且每个备用服务商至少登记一个启用的模型预设：`enabled` 表示主服务失败时尝试备用服务；`priority` 表示优先使用主叙事预设所属的服务商，失败后切换；`round-robin` 表示轮流调用；备用服务会使用其模型列表中首个启用预设；`maxAttemptsPerProvider=1` 表示每个服务商失败后立即切换；`cooldownMinutes=5` 表示失败服务在 5 分钟内暂时跳过。

`model.mainPrompt` 可以写主模型的完整创作方向；`model.formatPrompt` 可以补充结构化字段说明；`model.fixedPrompt` 可以写所有故事都必须遵守的规则；`model.stylePrompt` 是全局文风。四项都可以在 Console 直接编辑。

### 9.2.1 多账号共享主剧本

`sharedStory` 控制“一个机器人、多个关系对象、一个主剧本”的行为。数据层和消息队列的工作方式见第 2、3 节；这里仅列出可调字段：

| 字段 | 含义 |
| --- | --- |
| `enabled` | 历史兼容字段。运行时固定使用共享单主剧本，并限制每个消息平台仅保留一部活动剧本。 |
| `autoEnrollParticipants` | 新 QQ 第一次私聊时自动成为主剧本参与者。 |
| `allowCrossConversationMessages` | 允许模型在当前回合顺带给其他参与者发消息。关闭后仍共享生活，但不会跨账号主动联系。 |
| `shareParticipantDetails` | 是否允许跨关系读取更多关系上下文。默认关闭；实时主叙事不会批量读取其他账号的原始剧本，关系影响主要通过事实型共享状态传递。 |
| `maxCrossConversationActions` | 一次写作最多跨账号发送几条消息。建议保持 `1`，避免角色突然群发。 |
| `participantContextLimit` | 每次主模型最多读取多少个其他参与者的摘要。 |
| `managerAccounts` | 可使用 `interlude.setup`、暂停、手动推进和压缩命令的 QQ。留空时所有获授权账号都可管理。多人测试建议仅填写测试管理员 QQ。 |
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

`model.compaction` 在后台将已发生剧本整理为场景摘要、长期事实和人物变化线索，不占用用户消息的主模型等待路径。

| 字段 | 测试建议 |
| --- | --- |
| `enabled` | 建议开启；如果只想先排查基础聊天，也可以暂时关闭。 |
| `modelId` | 从统一模型列表选择压缩模型。首次可选择与主叙事相同的预设。 |
| `temperature` / `topP` | 整理要稳定，保持 `0.3` / `1`。 |
| `maxTokens` / `timeout` | 首次保持 `2048` / `60000`。压缩失败不影响当前聊天。 |
| `responseFormat` | 规则和聊天模型相同：支持 JSON Mode 就用 `json-object`，否则用 `prompt-only`。 |
| `mainPrompt` | 压缩整理的主要目标。 |
| `fixedPrompt` | 只写给整理员的规则，例如“保留承诺和未解决问题”。不需要时留空。 |
| `stylePrompt` | 摘要的写法。建议保持“简短、客观、按时间顺序”，最省 token。 |

`model.embedding` 用于按语义检索相关旧事实，首次启动可不启用：

| 字段 | 测试建议 |
| --- | --- |
| `enabled` | 第一轮关闭；普通记忆、聊天稳定后再打开。向量服务异常时会自动退回普通排序。 |
| `modelId` | 从统一模型列表选择向量模型，并复用其服务商的 API Key。 |
| `endpoint` | 填向量（Embeddings）接口。聊天地址以 `/chat/completions` 结尾时可留空自动推导；不标准网关需按文档填写完整地址。 |
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
| `userProfile` | 新参与者的默认资料；无需预设测试用户身份时可留空，也可在 `onebot.userAccounts` 白名单行按 QQ 覆盖。 |
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
| `sweepIntervalMinutes` | 检查延迟回复和自动推进的间隔，默认 5 分钟；检查本身不一定调用模型。 |
| `minimumAdvanceMinutes` | 旧版兼容项，通常不要改；实际节奏主要看 `autoAdvanceIntervalMinutes`。 |
| `maxStoriesPerSweep` | 每次后台最多照看多少故事。单人测试保持 20。 |
| `contextEntryLimit` / `memoryLimit` | 一次扫描多少近期记录/带给主模型多少长期事实。默认 30 / 20。 |
| `contextCharacterBudget` | 近期场景、可追溯事实等上下文的总字符预算，默认 6000；原剧本正文不计入也不会发送。 |
| `interactionLedgerLimit` / `interactionLedgerCharacterBudget` | 近期逻辑回合卡的数量和字符预算。默认 12 / 2400；一张卡会合并同一回合的用户消息、已送达主角消息和主角完成的行动。 |
| `maxScriptCharacters` / `maxMessageCharacters` | 幕后剧本和可见消息的最长字符数。首次保持 8000 / 2000。 |
| `minimumDelayedReplySeconds` / `maximumDelayedReplyMinutes` | 角色可安排延迟回复的最短秒数、最长分钟数。默认 10 秒到 24 小时。 |
| `cancelDelayedRepliesOnUserMessage` | 建议开启。用户连续发消息时，系统会取消旧延迟计划并重新进行决策。 |
| `autoAdvanceEnabled` | 是否在没有新消息时继续自动补写剧本。首次测试可关闭，仅验证私聊回合；之后再启用。 |
| `autoAdvanceIntervalMinutes` | 清醒时大约多少分钟自动补写一次生活，默认 40。数值越小，细节和成本都越高。 |
| `autoAdvanceJitterMinutes` | 自动时间前后随机浮动多少分钟。默认 5 更自然；填 0 便于固定节奏复测。 |
| `conversationFollowUpMinutes` | 对话结束后的短期补写时间点，默认 `[10, 20]` 分钟。 |
| `conversationFollowUpJitterMinutes` | 短期补写的随机浮动，默认 1 分钟；填 0 可固定复测。 |
| `pauseAfterConversationMinutes` | 旧版兼容项；新的短期补写由 `conversationFollowUpMinutes` 控制。 |
| `restWindows` | 睡眠/午休时间表，可填多行。每行有名称、开始/结束时间、最短/最长补写间隔；时间使用 `HH:mm`，例如 `23:00` 到 `07:00` 可以跨午夜。 |

### 9.6 记忆、人物变化与日志

`memory` 是高级区。首次测试建议全部保持默认；它们不会改变模型连接，只影响长期连贯性和成本。

| 字段组 | 作用与测试建议 |
| --- | --- |
| `enabled` | 场景摘要、长期事实和角色缓慢变化总开关。建议开启。 |
| `backgroundIntervalMinutes` | 多久检查一次是否需要整理旧剧本，默认 10 分钟。 |
| `sceneEntryThreshold` / `sceneCharacterThreshold` | 新剧本达到多少条或多少字就整理一次，任一达到即触发。默认 12 条或 8000 字。 |
| `storyHookPatchAfterConversation` | 最后一次短期补写是否合并一个小型 Hook 修改。默认开启。 |
| `storyHookFullRefreshIdleMinutes` | 连续空闲多久后，下一次常规推进完整重写 Hook。默认 240 分钟（4 小时）。 |
| `factLimit` | 给主模型的长期事实数量；近期事实卡数量使用 `runtime.contextEntryLimit`。 |
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

`logging` 只影响排查信息，不影响角色。默认建议使用 `level=info`、`verbosity=standard`、`format=detailed`：日志会按中文分行显示模型调用、后台扫描、自动推进、到期计划、计时器、消息投递、记忆整理和归档结果。`verbosity=summary` 只保留关键结果与失败；`verbosity=diagnostic` 追加队列、跳过原因和上下文统计，适合定位时序问题。`logScriptPreview` 控制是否输出当前剧本内容，`logMessageContent` 控制是否输出用户消息和主角可见消息内容；两项都可能暴露私聊内容，排查后应关闭。

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
| interlude.context | 查看剧本引子、近期事实卡、活动场景、演化覆写和已检索事实 |
| interlude.compact | 立即整理剧本、事实、状态提案，并执行 overlay 维护 |
| interlude.script [limit] | 管理员查看共享主剧本原始条目 |
| interlude.script.note <content> | 管理员写入可审计的人工剧本注记 |
| interlude.memory.facts [limit] | 管理员查看长期事实和编号 |
| interlude.memory.add <scope> <content> | 管理员添加高置信度长期事实 |
| interlude.memory.forget <id> | 管理员将长期事实标记为失效 |
| interlude.memory.intents [limit] / cancel <id> | 管理员查看或取消等待中的意图 |
| interlude.memory.patches [limit] / reject <id> | 管理员查看或拒绝设定演化提案 |
| interlude.overlay.clear <target> | 管理员清理 character、relationship、world 或 all 的演化 overlay；随后回复 y/n |
| interlude.overlay.status | 管理员查看当前 overlay、候选提案和压缩快照 |
| interlude.overlay.compact | 管理员只合并/压缩已应用 overlay，不整理普通剧本记忆 |
| interlude.database.clear | 管理员清空 HDSI 自有 SQLite 表；随后回复 y/n |
| interlude.purge.all | 管理员彻底重置所有平台的剧本、派生记忆和 Canon；随后回复 y/n |
| interlude.purge.platform <platform> | 管理员清空并归档指定平台的全部故事；随后回复 y/n |
| interlude.purge.range <from> <to> | 管理员删除指定时间段的剧本和关联记忆；随后回复 y/n |

删除指令会先尝试物理删除；如果 SQLite 文件被占用，插件会自动降级为逻辑删除并清空正文，避免删除操作因 `disk I/O error` 中断。

管理员完整操作说明见 [`command.md`](command.md)。

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

## 0.1.1-beta6：overlay 生命周期与管理员维护

- 普通人格和关系变化改为候选提案，必须跨多个剧本回合和日期后才会进入长期 overlay。
- 同一目标、参与者、路径和相近内容的提案会合并累计，避免每次记忆整理都新增重复变化。
- 增加同一路径 overlay 冷却时间，默认 72 小时。
- 新增 `interlude.overlay.status` 和 `interlude.overlay.compact`。
- `interlude.overlay.clear` 现在会同时使对应的待积累候选、已应用记录和历史压缩快照失效，防止旧设定清理后重新出现。
- 补充 overlay 生命周期、状态提案门槛和维护指令文档。

## 0.1.1-beta4-refactor：运行日志与任务可观测性

- 新增 `logging.verbosity`：`summary`、`standard`、`diagnostic` 三档运行信息密度。
- 默认标准档显示主模型与群聊判断调用、自动推进、到期计划、计时器、消息投递、记忆整理和主剧本归档状态。
- 诊断档追加消息合并、队列等待、后台跳过原因、冷却期和上下文统计；消息正文仍由隐私开关单独控制。
- 日志统一使用任务、阶段、故事和结果字段，便于在 Koishi Console 中定位后台状态与异常。

群聊、网页观察和可替换叙事器/压缩器仍按前文配置使用；完整命令说明见 [`command.md`](command.md)。

## 12. 运行边界

- HDSI 提供叙事连续性机制，不保证模型生成的文学质量、事实正确性或内容安全。
- 延迟回复到期后会再次进行剧情判断，由模型决定是否投递消息。
- 压缩摘要是辅助记忆。原始剧本保留在数据库中，允许审计和重建。
- 当前串行队列位于单个 Node.js 进程内。多实例部署需要分布式锁。
- 长期运行时，数据库体积、检索质量、摘要漂移和隐私保护需要额外的生产级方案。
- 多账号共享并不等于公开彼此私聊：实时主叙事不批量读取其他参与者的原始剧本，只使用权限允许的参与者状态、事实卡、长期事实和剧情余波。仍应按模型服务商的数据处理方式评估共享主剧本的隐私边界。
