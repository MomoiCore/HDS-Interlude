# HDS Interlude 新手引导

HDS Interlude 是 Koishi 的持续叙事聊天插件。插件使用共享主剧本保存角色状态、关系分支、已发生事件、待处理计划和长期记忆。用户消息会进入当前剧本回合；主模型在同一次请求中补写已过去的时间，并决定是否发送、延迟发送或暂不发送消息。实时写作使用“剧本引子 + 近期逻辑回合卡”，不会把成批旧剧本正文反复交给模型模仿。回合卡保留主角刚完成的行动、生活状态、用户实际消息与已送达回复；参与者自己的消息、资料和关系则通过独立的可追溯事实进入模型，因此剧情里的猜测不会自动被当成用户真的做过的事。

## 适用场景

- 角色需要保留长期关系、日程、承诺和事件连续性。
- 多个 QQ 账号需要与同一角色共享一个主剧本。
- 需要延迟回复、主动联系、自动推进或提醒计划。
- 需要通过摘要、长期事实和语义检索控制上下文长度。

## 首次配置

1. 在 Koishi Console 启用 `hds-interlude`。
2. 在“模型与服务商”中配置 OpenAI Chat Completions 兼容服务商，并在主叙事模型位置选择一个模型预设。
3. 在“剧本起点”中填写主角资料、默认关系、世界设定、地点、时区和叙事风格。
4. 使用 OneBot/NapCat 时，在 `onebot.botAccounts` 填写机器人 QQ；在 `onebot.userAccounts` 逐项填写允许私聊的测试 QQ、人物资料和初始关系。
5. 保存配置后，在已授权私聊中执行：

```text
interlude.init 主角名字
```

Console 页面从上到下就是推荐填写顺序：`storyDefaults` → `model` → `onebot` → `sharedStory` → `runtime` → `memory`。首次测试只需前五项；网页观察和详细日志可以之后再开。

6. 发送一条普通消息，确认模型调用、日志和消息投递正常。

空的私聊用户白名单表示不允许任何 QQ 进入私聊剧本。

## 建议测试顺序

1. 先关闭 `runtime.allowProactiveMessages`、Embedding 和网页浏览，只验证私聊回复。确认角色的日常推进稳定后，再开启主动联系；主动联系由主模型逐次给出意愿值，不使用机械冷却。
2. 在两秒内发送多条短消息，确认它们只产生一次主模型写作回合。
3. 测试延迟回复：用户再次发言后，旧延迟计划应取消并重新判断。
4. 开启 `runtime.autoAdvanceEnabled`，使用 `interlude.advance` 检查自动回合的剧本和消息行为。
5. 将两个 QQ 加入白名单，确认它们共享主剧本且各自保留关系资料。
6. 最后启用记忆压缩、Embedding、群聊和 Puppeteer。

## 推荐配置预设

下面是适合第一次测试的推荐值。配置路径使用 Console 中的完整字段名；API Key、QQ 号和 Token 请填写自己的内容，不要照抄示例。

### 1. 模型与提示词

```yaml
model.mode: openai-compatible
model.mainModelId: 主叙事模型预设 ID
model.mainTemperature: 0.7
model.mainTopP: 0.9
model.mainMaxTokens: 0
model.mainTimeout: 0
model.mainResponseFormat: prompt-only
model.formatPrompt: ''
model.fixedPrompt: ''
model.failover.enabled: true
model.failover.strategy: priority
model.failover.maxAttemptsPerProvider: 2
model.failover.cooldownMinutes: 5
model.groupGate.enabled: false
model.embedding.enabled: false
model.vision.enabled: true
runtime.interactionLedgerLimit: 12
runtime.interactionLedgerCharacterBudget: 2400
```

近期逻辑回合卡会让角色知道最近实际说过什么、已经完成什么事情，以及哪些事仍未结束。它不会把长篇旧剧本塞回主模型；默认值通常无需调整。

先在服务商列表填写连接信息，再在模型列表登记实际模型；后续各功能只需从模型预设下拉菜单选择即可：

```yaml
model.providers[].id: primary
model.providers[].label: Primary provider
model.providers[].enabled: true
model.providers[].endpoint: https://你的服务商/v1/chat/completions
model.providers[].apiKey: 你的 API Key
model.providers[].extraHeaders: ''
model.providers[].extraBody: ''

model.models[].id: narrative
model.models[].label: 主叙事模型
model.models[].enabled: true
model.models[].providerId: primary
model.models[].model: 你的模型名称
model.models[].maxTokens: 4096
model.models[].timeout: 60000
model.models[].responseFormat: prompt-only
```

保存/重载一次后，在 `model.mainModelId` 选择 `narrative`。若还要配置压缩、群聊判断或 Embedding，也是在 `model.models` 增加对应预设，再到各功能的 `modelId` 下拉菜单选择；服务商地址和 API Key 不需要重复填写。

主叙事提示词：

```text
model.mainPrompt:
以有丰富生活感和稍微突发奇想offset的行为、动机和人际关系为基础推动时光的流逝，延续以角色为中心的精彩生活剧本。
```

全局文风提示词：

```text
model.stylePrompt:
你正在持续创作一部以主角为中心的现实主义生活剧本。

每次写作时，请先感受主角在这段真实时间里正在经历怎样的生活：她的日程、行动、身体状态、心情、环境、正在处理的事情，以及与周围人物之间自然流动的关系。让剧本从这些真实而具体的生活质感中展开。

用户消息是发生在当前时刻的一项外部事件。把它自然放入主角原本正在继续的现实中，结合她当下的处境、注意力、情绪和人与人之间的关系，呈现这条消息带来的细微影响。主角可以很快注意到，也可以在完成手头的事、与别人相处、整理情绪或改变计划后才处理它。

在合适的情况下，为当前时间段补充一些属于主角自己的生活内容，例如日常事务、工作或学业、兴趣、身体感受、偶遇、配角互动、临时变化、尚未解决的小事、环境细节或内在念头。让这些内容与既有剧情保持因果和连续性，并自然留下后续的空间。

鼓励生活保留适度的不确定性与变化：计划可能调整，邀约可能出现，配角可能带来新的情绪或信息，旧问题也可能以平静的方式重新浮现。事件保持克制、可信，并让主角的选择具有现实动机。

采用贴近主角的第三人称限知视角，像一部持续上演的话剧。叙事细腻、克制、连贯，关注具体行动、人物来往、情绪余波与关系的缓慢变化。

叙事推进至当前时刻结束。可以保留正在进行的事情、未说出口的念头、尚未解决的关系线索和未来意图；请将已经发生的内容写得完整而自然。

主角的线上聊天风格保持真人感：慵懒、简洁、碎片化，一次只说一两个短句，并随着她当时的状态自然变化。
```

剧本压缩模型：

```yaml
model.compaction.enabled: true
model.compaction.providerId: 留空表示自动选择
model.compaction.model: 低成本模型名称
model.compaction.temperature: 0.3
model.compaction.topP: 1
model.compaction.maxTokens: 2048
model.compaction.timeout: 60000
model.compaction.responseFormat: prompt-only
model.compaction.mainPrompt: 将已完成的剧情场景压缩为简洁的连贯性剧本，同时保留因果关系、人物承诺、有悬念的情节以及角色性格心态的渐进变化。
model.compaction.fixedPrompt: ''
model.compaction.stylePrompt: 简洁、陈述事实、按时间顺序描述、事件具体。
```

### 2. 剧本起点

```yaml
storyDefaults.characterName: Minase HDSI
storyDefaults.characterProfile: 18岁的女孩，刚刚高考结束，正准备开始大学生活。平时喜欢熬夜，有点内向，容易胆怯，生活比较丰富，喜欢尝试一些能力范围内没试过的东西，对想干的事情非常有行动力，在线上聊天话很少且发言简洁、有点喜欢吐槽，但对待事情十分认真，心态很平和
storyDefaults.userProfile: 一位普通网友
storyDefaults.relationship: 该用户与主角不经常联系
storyDefaults.world: 现实社会，主角平常生活在中国
storyDefaults.supportingCast: 主角的父母，对主角比较严格，工作早出晚归；主角的一个亲姐姐，大主角3岁；主角的一位好友，名叫希绘（Nozomi），比较外向，比主角小一点，两人非常要好。
storyDefaults.location: 填写主角的主要活动地点
storyDefaults.style: 当代现实主义生活剧。主角拥有丰富、具体且持续变化的个人生活；配角也有各自的节奏、立场与情绪。关系在日常互动和小事件中缓慢发展，生活常常留下未完成但真实感的余波。
storyDefaults.timezone: Asia/Shanghai
```

### 3. OneBot/NapCat 与多人共享剧本

```yaml
onebot.enabled: true
onebot.ignoreSelfMessages: true
onebot.botAccounts[].qq: 机器人 QQ 号
onebot.botAccounts[].enabled: true
onebot.userAccounts[].qq: 允许互动的用户 QQ 号
onebot.userAccounts[].label: 用户备注
onebot.userAccounts[].enabled: true
onebot.userAccounts[].profile: 该用户在主角眼中的身份和背景
onebot.userAccounts[].relationship: 该用户与主角的初始关系

sharedStory.enabled: true
sharedStory.autoEnrollParticipants: true
sharedStory.allowCrossConversationMessages: true
sharedStory.shareParticipantDetails: false
sharedStory.maxCrossConversationActions: 1
sharedStory.participantContextLimit: 6
```

空的 `onebot.userAccounts` 会拒绝所有私聊。每个用户都应单独填写 `profile` 和 `relationship`，不要把所有账号都当作同一个人。

### 4. 私聊、自动推进与主动联系

```yaml
runtime.captureDirectMessages: true
runtime.autoCreate: true
runtime.ignoreCommandMessages: true
runtime.userMessageDebounceSeconds: 2
runtime.staleNarrativeRequestWindowSeconds: 5
runtime.cancelDelayedRepliesOnUserMessage: true
runtime.splitReplyMessages: true
runtime.messageSeparator: '<sep/>'
runtime.typingBaseDelaySeconds: 1
runtime.typingCharactersPerSecond: 8
runtime.typingMaxDelaySeconds: 12
runtime.narrativeRetryDelaySeconds: 60
runtime.narrativeRetryMaxAttempts: 6
runtime.contextEntryLimit: 30
runtime.contextCharacterBudget: 6000

runtime.autoAdvanceEnabled: true
runtime.autoAdvanceIntervalMinutes: 40
runtime.autoAdvanceJitterMinutes: 5
runtime.conversationFollowUpMinutes: [10, 20]
runtime.conversationFollowUpJitterMinutes: 1
runtime.allowProactiveMessages: false
runtime.proactiveWillingnessThreshold: 0.65
```

第一次测试建议关闭 `runtime.allowProactiveMessages`。确认剧本、延迟回复和自动推进稳定后再开启；主动联系由主模型逐次给出意愿值，不使用固定冷却。

睡眠或休息时间可以使用：

```yaml
runtime.restWindows[].enabled: true
runtime.restWindows[].label: night sleep
runtime.restWindows[].start: '23:00'
runtime.restWindows[].end: '07:00'
runtime.restWindows[].minIntervalMinutes: 120
runtime.restWindows[].maxIntervalMinutes: 240
```

### 5. 记忆与网页功能

```yaml
memory.enabled: true
memory.storyHookPatchAfterConversation: true
memory.storyHookFullRefreshIdleMinutes: 240
memory.sceneEntryThreshold: 12
memory.sceneCharacterThreshold: 8000
memory.factLimit: 20
memory.activeConsequencesEnabled: true
memory.activeConsequencePromptLimit: 6
memory.overlayCompressionEnabled: true
memory.overlayRecentDays: 2
memory.overlayWeeklyWindowDays: 5
memory.overlayMonthlyAfterDays: 10
memory.overlayMonthlyWindowDays: 10

browser.enabled: false
browser.mode: deferred-only
```

默认上下文会扫描最多 30 条近期记录，并保留最多 12 张逻辑回合卡、2400 个字符的近期连续性。每张卡包含主角刚完成的行动、生活状态和实际收发消息。对话结束后的最后一次短期补写会对剧本引子做一个小修改；连续空闲满 4 小时后，下一次常规推进才完整重写引子。两种更新都复用已有写作回合，不会新增独立模型调用。

Embedding 可以在基础功能稳定后再开启。网页观察和 Puppeteer 也建议最后启用，以便区分模型、网络和浏览器问题。

### 6. 日志推荐值

```yaml
logging.level: info
logging.verbosity: standard
logging.format: detailed
logging.logScriptPreview: false
logging.logMessageContent: false
```

排查模型或计时器问题时，可以临时将 `logging.level` 改为 `debug`、`logging.verbosity` 改为 `diagnostic`；测试完成后建议恢复，避免日志过长并记录过多隐私内容。

## 常用配置位置

| 配置组 | 用途 |
| --- | --- |
| `storyDefaults` | 新主剧本的 Canon：主角、世界、默认关系和叙事风格。 |
| `model` | 服务商、模型预设、提示词、压缩模型、Embedding 和群聊筛选模型。 |
| `onebot` | 机器人 QQ、私聊白名单、群聊白名单和群聊资料。 |
| `sharedStory` | 多账号关系分支、跨账号消息和管理员权限。 |
| `runtime` | 消息合并、延迟发送、自动推进、休息时段和失败重试。 |
| `memory` | 剧本压缩、事实召回、剧情余波和设定演化。 |
| `browser` | 可选的 Puppeteer 网页观察。 |
| `logging` | 日志级别、信息密度、显示布局和内容预览。 |

## 常用管理指令

- `interlude.status`：查看当前主剧本状态。
- `interlude.context`：查看剧本引子、近期逻辑回合卡、可追溯参与者事实、场景摘要、关系状态和长期事实。
- `interlude.timeline`：查看当前账号相关的近期剧本条目。
- `interlude.memory.intents`：查看延迟回复、提醒、承诺和剧情余波。
- `interlude.pause` / `interlude.resume`：暂停或恢复后台处理。
- `interlude.overlay.status`：查看当前 overlay、待积累提案和压缩快照。
- `interlude.overlay.compact`：只合并/压缩已经应用的 overlay。
- `interlude.overlay.clear character|relationship|world|all`：清理指定类型的设定演化覆盖层；执行后按提示确认，同时会使相关待积累候选失效。

overlay 不会因为一次聊天就改变人格。普通变化需要多个剧本回合和不同日期的证据；近期情绪和关系变化会先留在剧本、关系笔记或剧情余波中。只有稳定变化才会进入长期 overlay。

完整配置说明见 `CONFIGURATION_GUIDE.md`，管理员指令说明见 `command.md`。
