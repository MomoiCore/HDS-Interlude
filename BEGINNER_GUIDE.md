# HDS Interlude 新手引导

HDS Interlude 是 Koishi 的持续叙事聊天插件。插件使用共享主剧本保存角色状态、关系分支、已发生事件、待处理计划和长期记忆。用户消息会进入当前活动场景；主模型在同一次请求中续写已经发生的生活，并决定是否发送、延迟发送或暂不发送消息。实时写作读取一条按时间排序的活动场景记录：最近剧本文字、真实用户消息和已经成功投递的角色消息在同一条线上。剧本引子、场景外近期事实和长期记忆负责更早的历史。

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
6. 保持 `memory.relationshipMomentEnabled=true`，发送一条带有明确情绪、求助或约定的消息；再发送一条普通短句，确认角色会延续已发生的交流方向，但不会重复刚刚说过的关心或建议。
7. 最后启用记忆压缩、Embedding、群聊和 Puppeteer。

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
runtime.interactionLedgerLimit: 18
runtime.interactionLedgerCharacterBudget: 3600
runtime.activeSceneEntryLimit: 400
runtime.activeSceneNarrativeLimit: 20
runtime.activeSceneCharacterBudget: 60000
runtime.previousSceneTailCharacters: 4000
runtime.recentLifeFactsEnabled: true
runtime.recentLifeFactHours: 48
runtime.recentLifeFactLimit: 24
runtime.recentLifeFactCharacterBudget: 3200
memory.relationshipMomentEnabled: true
memory.relationshipMomentDefaultHours: 24
memory.relationshipMomentMaxHours: 168
```

`activeSceneEntryLimit` 只控制数据库扫描量；实际写作默认读取最近 20 段剧本、其间已确认的真实收发消息，并固定保留未处理事件。它们共同组成一条短期时间线，用来处理“刚才”“那个”“我说过”等指代。近期逻辑回合保留生活关注面、动作发展和外部事件影响，用于诊断、重复校正和旧数据兼容，不会与完整活动场景重复传给主模型。“近期生活事实桥”默认补充活动场景之外最近 48 小时的事实。

`relationshipMoment` 是一张按账号保存的短期关系卡，不是第二份人设或聊天记录。它只保存仍在作用的交流方向，例如“对方明显焦虑，角色已表达担心、接下来应先确认状况”；当前事件和角色所处生活仍然优先。默认 24 小时到期，最长不超过 168 小时。它由主模型在正常写作时顺带更新，不会增加一次模型调用。

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
持续创作一部以主角为中心的现实主义生活剧本。让日程、具体行动、身体节奏、兴趣、配角关系、现实压力、外部变化和未完事项共同推动时间，并让每个回合从既有生活中产生新的实际进展。
```

全局文风提示词：

```text
model.stylePrompt:
你正在持续创作一部以主角为中心的当代现实主义生活剧本。

从主角此刻手头正在做的事情继续写。让时间通过具体行动向前移动：拿起或放下的物品、进行到哪一步的任务、身体产生的需要、环境中的变化、临时出现的安排，以及周围人物正在做出的选择。细节应参与行动和因果，使读者能够感到这一段生活确实发生过。

根据真实经过的时间选择合适的叙事密度。短暂间隔聚焦一个新动作、注意力变化或对话进展；较长间隔选择几个有连接的生活时刻，表现任务、地点、身体状态、陪伴者和计划怎样逐步变化。

让主角同时拥有眼前事务、当天安排、个人兴趣、现实压力和未解决的小事。每次选择当前最能自然推进的部分，并让偶然变化从既有处境中生长，例如计划调整、物品带来的麻烦、配角提出的新安排、环境变化或意外发现。

让配角拥有自己的日程、目的、情绪和判断。他们可以主动靠近、打断、误解、邀请、帮忙或改变气氛；他们的行动与主角的选择共同形成生活中的人际流动。

用户消息是当前时刻真实发生的一项外部事件。把它放进主角原本正在继续的生活，写清它遇到的具体处境、引起的注意力变化，以及对行动、情绪、关系或计划产生的实际影响。主角按照当时的精力、关系和现实条件决定看见、回应、延后或保持沉默。

采用贴近主角的第三人称限知视角。叙事保持细腻、克制、连贯，以具体动作、功能性的感官细节、人物来往和情绪余波形成生活感。关系通过反复发生的日常选择缓慢变化，已经发生的内容写得完整，正在进行的事情保留自然的后续空间。

主角的线上聊天保持真人感，表达简洁、自然、带有当时的情绪和注意力。每一条消息承接用户当前表达，并提供新的态度、信息、问题或行动；连续气泡共同组成一个完整而有进展的回应。
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
model.compaction.mainPrompt: 把已完成的剧情整理为简洁、连续的事实脉络，保留时间顺序、行动结果、外部事件影响、具体生活锚点、人物承诺、未解决事项，以及性格和关系的渐进变化。
model.compaction.fixedPrompt: ''
model.compaction.stylePrompt: 按时间顺序陈述事实，表达简洁具体，优先保留对后续行动、关系和场景状态仍有影响的细节。
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
runtime.interactionLedgerLimit: 18
runtime.interactionLedgerCharacterBudget: 3600
runtime.recentLifeFactsEnabled: true
runtime.recentLifeFactHours: 48
runtime.recentLifeFactLimit: 24
runtime.recentLifeFactCharacterBudget: 3200

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

默认扫描活动场景最多 400 条数据库记录，从中选取最近 20 段剧本及其间的真实收发消息、所有未处理事件，并保留场景外 48 小时内的生活事实与上一场景最多 4000 字符的衔接。逻辑回合缓存用于诊断、重复校正和旧数据兼容，不会与完整活动场景重复传给主模型。几十秒、几十分钟和几小时的回合会自动采用不同写作范围，诊断日志会显示实际命中的尺度。对话结束后的最后一次短期补写会对剧本引子做一个小修改；连续空闲满 4 小时后，下一次常规推进才完整重写引子。上述处理复用已有写作回合，不会新增独立模型调用。

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
| `memory` | 剧本压缩、事实召回、关系态势、剧情余波和设定演化。 |
| `browser` | 可选的 Puppeteer 网页观察。 |
| `logging` | 日志级别、信息密度、显示布局和内容预览。 |

## 常用管理指令

- `interlude.status`：查看当前主剧本状态。
- `interlude.context`：查看活动场景写作源、待处理事件、近期逻辑回合、剧本引子、近期事实、关系状态和长期事实。
- `interlude.timeline`：查看当前账号相关的近期剧本条目。
- `interlude.memory.intents`：查看延迟回复、提醒、承诺和剧情余波。
- `interlude.pause` / `interlude.resume`：暂停或恢复后台处理。
- `interlude.overlay.status`：查看当前 overlay、待积累提案和压缩快照。
- `interlude.overlay.compact`：只合并/压缩已经应用的 overlay。
- `interlude.overlay.clear character|relationship|world|all`：清理指定类型的设定演化覆盖层；执行后按提示确认，同时会使相关待积累候选失效。

overlay 不会因为一次聊天就改变人格。普通变化需要多个剧本回合和不同日期的证据；近期情绪和关系变化会先进入关系态势卡、剧本或剧情余波。关系态势会让后续几轮继续考虑用户的沮丧、冲突或关心，同时保留角色当时的疲惫、环境和原有性格。只有稳定变化才会进入长期 overlay。

完整配置说明见 `CONFIGURATION_GUIDE.md`，管理员指令说明见 `command.md`。
