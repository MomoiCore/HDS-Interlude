# HDS Interlude 配置项详细说明

Console 只显示字段的操作摘要；本文件补充字段语义、约束、推荐值和排障信息。配置项名称与 `src/index.ts` Schema 保持一致。

## 1. 推荐的首次测试顺序

1. 在 `model.mode` 选择 `openai-compatible`。
2. 在 `model.providers` 填一条聊天服务商：`enabled`、`endpoint`、`apiKey`、`model`。
3. 在 `storyDefaults` 填主角、默认关系、世界观和文风。
4. 在 `sharedStory` 保持共享主剧本开启；多人测试时为每个账号配置白名单身份。
5. 如果使用 NapCat / OneBot QQ，在 `onebot.botAccounts` 和 `onebot.userAccounts` 中分别填写机器人与测试员 QQ。
6. 首轮建议保持 `model.embedding.enabled=false`、`runtime.allowProactiveMessages=false`。
7. 保存配置后，在私聊发送 `interlude.init 主角名字`，再发送普通聊天内容。

## 2. model：模型配置

### 2.1 model.mode

`fallback` 表示不调用真实模型，只保存故事和消息，适合检查插件是否安装成功。

`openai-compatible` 表示使用 OpenAI Chat Completions 兼容接口，开始真实写作和回复。

### 2.2 model.providers

这里填写聊天模型服务商。Console 会把每个服务商显示成可折叠的纵向配置项，避免字段太多时横向表格超出屏幕；第一次测试只需要一项。

| 字段 | 详细说明 |
| --- | --- |
| `id` | 服务商代号，例如 `primary`、`backup`。压缩模型和向量模型可以用它复用对应服务商配置。 |
| `label` | Console 里显示的备注名称，不影响调用。 |
| `enabled` | 是否允许使用这一行。关闭后故障切换也不会选它。 |
| `endpoint` | OpenAI 兼容 Chat Completions 接口地址。按 Console 提示填写根地址或完整路径；不要填控制台网页、`/models` 地址或服务商主页。 |
| `apiKey` | 服务商密钥。它相当于密码，不要贴到公开日志、截图或群聊里。 |
| `model` | 聊天模型名称，必须和服务商文档一致。 |
| `temperature` | 写作随机性。首次测试建议 `0.6` 到 `0.9`，默认 `0.8`。 |
| `topP` | 另一种随机性参数。不熟悉时保持 `1`。 |
| `maxTokens` | 单次最多输出多少 token。越大越完整，但更慢、更贵。填 `0` 表示不主动限制。 |
| `timeout` | 等模型返回的最长时间，单位毫秒。`60000` 等于 60 秒。 |
| `responseFormat` | `json-object` 会请求 JSON mode；服务商不支持时改成 `prompt-only`。 |
| `extraHeaders` | 额外 HTTP 请求头，必须是 JSON 对象。大多数服务商不需要。 |
| `extraBody` | 额外请求体参数，必须是 JSON 对象。只有服务商文档要求时再填。 |

### 2.3 model.failover

故障切换用于主服务商失败时自动换备用服务商。只有 `providers` 里有两条以上启用配置时才有明显效果。

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 是否启用自动切换。 |
| `strategy` | `priority` 总是优先第一条，失败才换备用；`round-robin` 会轮流使用多个服务商。 |
| `maxAttemptsPerProvider` | 同一个服务商失败后原地重试几次。首次测试保持 `1`。 |
| `cooldownMinutes` | 某个服务商失败后暂时跳过多久，避免每条消息都撞同一个故障接口。 |

### 2.4 model.mainPrompt、model.formatPrompt、model.fixedPrompt 与 model.stylePrompt

`mainPrompt` 是主叙事提示词，决定模型如何持续写作、推进生活、处理关系和用户事件。测试员可以在这里写完整的创作要求。

`formatPrompt` 是输出格式补充提示词，可以增加字段使用说明，但不能取消插件固定的 JSON、时间和安全校验。

`fixedPrompt` 是所有故事都必须遵守的额外规则，例如“不要暴露住址”“不要描写某类内容”。它不能覆盖插件内置的时间规则和 JSON 输出规则。

`stylePrompt` 是默认文风提示词，只影响剧本文字的写法。角色专属文风仍然建议写在 `storyDefaults.style`。

### 2.5 model.compaction

压缩模型负责把较久的剧本整理成场景摘要、长期事实和状态变化提案。它在后台运行，不应该卡住用户当前这条私聊。

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 是否启用压缩模型。建议开启。 |
| `providerId` | 使用哪条 `providers` 配置。留空时自动使用当前可用服务商。 |
| `model` | 压缩模型名称。可填更便宜、更快的模型；留空则使用对应服务商的聊天模型。 |
| `temperature` | 压缩随机性。建议低一些，例如 `0.3`。 |
| `maxTokens` | 压缩模型单次输出上限。 |
| `timeout` | 等压缩模型返回的最长时间。压缩失败不会中断聊天。 |
| `topP` | 压缩模型 top-p。不了解时保持 `1`。 |
| `responseFormat` | 压缩模型结构化返回方式；不支持 JSON mode 时改为 `prompt-only`。 |
| `mainPrompt` | 压缩模型的主要整理要求，例如“优先保留承诺、未解决事项和因果关系”。 |
| `fixedPrompt` | 只给压缩模型看的额外规则，例如“承诺和未解决事项必须保留”。 |
| `stylePrompt` | 压缩摘要的写法，建议简短、客观、按时间顺序。 |

### 2.6 model.embedding

向量模型用于“按当前消息的意思找回相关旧事”。它是增强项，不是启动插件的必填项。

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 是否启用语义检索。普通聊天稳定后再打开。 |
| `providerId` | 使用哪条 `providers` 配置中的 API Key 和额外请求头。 |
| `endpoint` | Embeddings 接口地址。标准 `/chat/completions` 地址可自动推导到 `/embeddings`；其他网关建议填完整地址。 |
| `model` | 向量模型名称，不是聊天模型名称。 |
| `dimensions` | 向量维度。只有服务商要求时才填，通常保持 `0`。 |
| `timeout` | 向量请求超时时间。失败后会退回普通记忆排序。 |
| `maxInputCharacters` | 每次拿去做语义理解的文字上限。 |
| `backfillBatchSize` | 后台每次给多少条旧事实补向量。`0` 表示不补旧历史。 |

## 3. storyDefaults：故事起点

这些字段定义新故事开始时已经成立的过去和起点，不是永久不变的人设卡。后续剧情会通过记忆系统慢慢形成演化覆写。

| 字段 | 详细说明 |
| --- | --- |
| `characterName` | 默认主角名字。也可以在 `interlude.init 名字` 中单独指定。 |
| `characterProfile` | 主角初始设定：职业、作息、性格、压力、习惯、说话方式等。 |
| `userProfile` | 新参与者的默认资料。不想预设真实测试员信息时可留空；单个 QQ 可在 `onebot.userAccounts` 白名单行覆盖。 |
| `relationship` | 新参与者和主角的默认关系；单个 QQ 应在 `onebot.userAccounts` 白名单行覆盖。 |
| `world` | 故事时代、世界规则和现实程度。 |
| `supportingCast` | 配角、家人、朋友、同事，以及他们和主角的关系。 |
| `location` | 主要生活地点，用于帮助模型写出地点感。 |
| `style` | 此故事专属叙事风格，例如“现实主义日常，克制，关系变化缓慢”。 |
| `timezone` | 故事时区，用来判断白天、休息和延迟回复。中国大陆通常填 `Asia/Shanghai`。 |

## 4. sharedStory：多人共享主剧本

开启后，故事按“机器人账号”而不是“用户账号”建立：同一个 NapCat 机器人 QQ 的多个私聊会进入同一部生活剧本。每个 QQ 仍有自己的参与者状态、未读数、待回复数、关系资料和延迟回复计划。

旧 Beta 数据不会在切换后立刻删除。账号下一次发消息时，插件会把旧的账号故事迁移为该共享主剧本中的参与者；同一机器人下其它旧账号故事会在各自返回时合并并归档。

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 是否启用共享主剧本。默认开启。关闭后会暂时按旧方式把每个账号当作独立故事。 |
| `autoEnrollParticipants` | 获授权的新 QQ 第一次私聊时是否自动加入已有主剧本。开启后无需每个账号都手动执行 `interlude.init`。 |
| `allowCrossConversationMessages` | 模型是否可以因为 A 的消息，顺带联系 B。例如角色正在和 A 处理事情，便对 B 说“我有点事，晚点找你”。关闭后仍共用生活，但不会跨账号主动发言。 |
| `shareParticipantDetails` | 是否把其他 QQ 的历史剧本提供给模型。**这会把多个账号的信息发给模型服务商，只有在所有参与者同意且服务商可信时才应开启。**默认关闭时，模型只看到其他账号的匿名 id、待回复数和时间统计；即使打开，其他参与者的资料与关系字段仍保持匿名。 |
| `maxCrossConversationActions` | 单次写作最多跨账号做几次可见联系。建议保持 `1`。填 `0` 等同于禁止这类动作。 |
| `participantContextLimit` | 每次主模型最多看到多少个其他参与者的摘要。人数很多时降低它可以省 token。 |
| `managerAccounts` | 可以运行 `interlude.setup`、暂停/恢复、手动推进和压缩命令的 QQ。留空时所有获授权账号都能管理；多人测试建议只填写管理员 QQ。 |
| `participantPresets` | 仅用于读取旧版 YAML 的兼容字段；Console 不显示。新配置统一使用 `onebot.userAccounts` 白名单行。 |

旧版 `participantPresets` 字段（仅用于迁移历史 YAML，不应作为新配置入口）：

| 字段 | 详细说明 |
| --- | --- |
| `qq` | 私聊发件人的 QQ 号。需要同时被 `onebot.userAccounts` 允许。 |
| `personId` | 人物稳定代号。两个 QQ 写同一个 `personId` 时，模型会得到相同的人物标签；账号的未读数和消息投递仍各自独立。建议使用英文或数字短代号。 |
| `label` | Console 与剧情中的人物备注。 |
| `profile` | 这个人的背景、身份或与主角相关的已知资料。 |
| `relationship` | 这个人和主角的初始关系。 |
| `enabled` | 是否启用这一条人物预设。关闭后该 QQ 会使用默认资料。 |

推荐的双账号测试：先让 A 与角色聊天几轮，再让 B 连续发送消息。保持 `maxCrossConversationActions=1`，观察角色是否会基于全局待回复状态选择优先级、延迟或向另一方解释忙碌。

## 5. runtime：运行参数

| 字段 | 详细说明 |
| --- | --- |
| `captureDirectMessages` | 是否接管私聊。关闭后已有故事也不会自动处理新私聊。 |
| `autoCreate` | 新私聊是否自动建故事。关闭时测试员需要先发 `interlude.init`。 |
| `ignoreCommandMessages` | 是否把 `interlude.*` 命令排除在剧情外。建议开启。 |
| `allowProactiveMessages` | 是否允许角色在用户没有新消息时主动发可见消息。首次测试建议关闭。 |
| `sweepIntervalMinutes` | 后台检查延迟回复和自动生活推进的间隔，不是每次都会调用模型。 |
| `minimumAdvanceMinutes` | 旧版兼容项，通常不用改。 |
| `maxStoriesPerSweep` | 每轮后台最多处理多少个故事。 |
| `contextEntryLimit` | 每次给主模型的最近原始剧本条数。 |
| `memoryLimit` | 每次给主模型的长期事实条数。 |
| `maxScriptCharacters` | 单次保存的幕后剧本正文上限。 |
| `maxMessageCharacters` | 角色单次可见消息长度上限。 |
| `minimumDelayedReplySeconds` | 延迟回复最短等待秒数。 |
| `maximumDelayedReplyMinutes` | 延迟回复最长等待分钟数。 |
| `cancelDelayedRepliesOnUserMessage` | 用户在旧延迟发出前又发消息时，是否取消发往该账号的旧延迟计划（包括跨账号延迟联系）并重新推理。建议开启。 |
| `autoAdvanceEnabled` | 是否在没有活跃对话时自动补写角色生活。 |
| `autoAdvanceIntervalMinutes` | 清醒时大约多久自动补写一次生活，默认 40 分钟。 |
| `autoAdvanceJitterMinutes` | 自动推进前后随机浮动多少分钟，让节奏不机械。 |
| `pauseAfterConversationMinutes` | 用户说话或延迟回复完成后，多久才恢复自动生活推进。 |
| `restWindows` | 睡眠、午休或补觉时段。每行可设置开始、结束、最短和最长补写间隔。 |

`restWindows.start` 和 `restWindows.end` 使用 24 小时制 `HH:mm`。结束时间早于开始时间表示跨午夜，例如 `23:00` 到 `07:00`。

## 6. memory：记忆系统

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 是否启用场景摘要、长期事实和角色变化记忆。建议开启。 |
| `backgroundIntervalMinutes` | 后台多久检查一次是否需要整理旧剧本。 |
| `sceneEntryThreshold` | 当前场景累计多少条新记录后触发整理。 |
| `sceneCharacterThreshold` | 当前场景累计多少字后触发整理。条数和字数满足任一条件即可。 |
| `recentEntryLimit` | 主模型保留多少条最近完整剧本。 |
| `factLimit` | 主模型每次最多带入多少条长期事实。 |
| `statePatchConfidenceThreshold` | 普通人物、关系、世界变化自动生效所需置信度。 |
| `majorStatePatchConfidenceThreshold` | 重大变化自动生效所需置信度。建议保持较高。 |
| `statePatchMinEvidence` | 普通变化至少需要多少条剧本证据。 |
| `maxFactsPerStory` | 单个故事最多保存多少条长期事实。 |
| `maxStoriesPerCompactionRun` | 每轮后台最多整理多少个故事。 |
| `compactionEntryLimit` | 单次整理最多读取多少条原始剧本。 |
| `compactionCharacterLimit` | 单次整理最多读取多少字。 |
| `sceneHookCharacters` | 当前场景“接着写什么”的短提示长度上限。 |
| `sceneSummaryCharacters` | 当前场景摘要长度上限。 |
| `arcSummaryCharacters` | 跨场景剧情弧线摘要长度上限。 |
| `factContentCharacters` | 单条长期事实内容长度上限。 |
| `factImportanceWeight` | 检索旧事实时重要度的权重。 |
| `factConfidenceWeight` | 检索旧事实时置信度的权重。 |
| `factRecencyWeight` | 检索旧事实时最近出现时间的权重。 |
| `semanticWeight` | 启用向量后，语义相关度的权重。 |
| `unresolvedWeight` | 未完成承诺、未解决问题的额外权重。 |
| `autoApplyStatePatches` | 达到门槛后是否自动应用人物、关系或世界变化。 |
| `allowMajorStateChanges` | 是否允许重大变化自动生效。关闭后重大变化只保存为提案。 |

## 7. onebot：NapCat / OneBot QQ 账号控制

`onebot` 只影响 `platform=onebot` 的私聊；其他平台不经过该白名单过滤。

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 是否启用 QQ 账号控制。开启后空表通常意味着拒绝。 |
| `botAccounts` | 允许代表角色发言的机器人 QQ，也就是 NapCat 登录的 QQ。 |
| `userAccounts` | 唯一的用户白名单。每行填写 QQ、角色称呼、人物资料、初始关系和启用开关；没有填写的 QQ 不会触发模型。 |
| `ignoreSelfMessages` | 是否忽略机器人自己发出的回显消息。建议开启。 |

`userAccounts` 每一行的身份字段：

| 字段 | 填写方式 |
| --- | --- |
| `qq` | 私聊发件人的 QQ 号。 |
| `label` | 角色如何称呼这个人；留空时使用平台昵称。 |
| `personId` | 人物稳定代号。同一个人换 QQ 时可填写相同代号。 |
| `profile` | 角色已知的身份、职业、生活背景或与主角相关资料。 |
| `relationship` | 角色与这个账号的初始关系。它是关系起点，后续变化写入关系覆写层。 |
| `enabled` | 关闭后该 QQ 立即不能触发故事，也不会收到延迟或主动消息。 |

OneBot/NapCat 中，`session.selfId` 是机器人 QQ，`session.userId` 是私聊发件人 QQ。HDSI 会自动去除常见传输前缀，因此白名单可以填写纯数字 `123456`，也可以填写 `private:123456` 或 `onebot:123456`；推荐统一填写纯数字。HDSI 只使用白名单，`userAccounts` 为空会拒绝所有用户。旧配置中的 `userMode: blocklist` 会被忽略，不会重新开放陌生 QQ。

推荐测试配置：

```yaml
onebot:
  enabled: true
  botAccounts:
    - qq: '机器人QQ号'
      label: '测试机器人'
      enabled: true
  userAccounts:
    - qq: '测试员QQ号'
      label: '小林'
      personId: 'friend-a'
      profile: '主角的大学朋友，平时在附近工作。'
      relationship: '熟悉但最近联系不多。'
      enabled: true
  ignoreSelfMessages: true
```

## 8. logging：日志设置

| 字段 | 详细说明 |
| --- | --- |
| `level` | 日志级别。默认 `info` 会显示收到消息、模型完成、发送消息和压缩完成；排查问题时可临时用 `debug`。 |
| `format` | 默认 `detailed`，将阶段、故事、主角和事件拆成多行；`compact` 适合日志量较大时使用单行摘要。 |
| `logScriptPreview` | 是否在 debug 日志里输出剧本预览。可能含私聊内容，排查后应关闭。 |
| `previewLength` | 剧本预览最多输出多少字。 |

## 9. 常见测试建议

- 首次只填一条 `providers`，确认聊天可用后再加备用服务商。
- `embedding` 先保持关闭，普通聊天稳定后再测试语义召回。
- `allowProactiveMessages` 先保持关闭，避免无人发言时主动打扰测试员。
- `memory` 建议开启，它不会让每条消息多等一次主模型。
- 使用 QQ 测试时必须把测试员逐个加入 `onebot.userAccounts` 白名单；旧的 `userMode` 不再配置。
- 修改账号白名单后，旧的延迟回复在实际发送前也会再次检查权限。
- 多人测试时，先确认每个 QQ 都在 `onebot.userAccounts` 中，并在对应行填写不同的 `label`、`profile` 和 `relationship`。旧版 `sharedStory.participantPresets` 仅作为 YAML 兼容入口。
- `shareParticipantDetails` 默认关闭不是故障：这是为了避免把其他账号的私聊关系详情默认发送到远程模型。
