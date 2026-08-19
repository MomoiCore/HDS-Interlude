# HDS Interlude 配置项详细说明
## 阅读顺序

第一次配置先看 `BEGINNER_GUIDE.md`。Console 现按实际配置顺序显示：剧本起点、模型与提示词、QQ 接入与白名单、共享关系网、对话与时间、连续性与记忆、网页观察、日志与隐私。本文件按字段解释这些配置。



Console 只显示字段的操作摘要；本文件补充字段语义、约束、推荐值和排障信息。配置项名称与 `src/index.ts` Schema 保持一致。

## Console 页面顺序

1. `storyDefaults`：建立角色、世界与默认关系。
2. `model`：登记服务商和模型预设，再填写主提示词与专项模型。
3. `onebot`：限制哪个机器人 QQ 发言、哪些 QQ 或群能进入故事。
4. `sharedStory`：配置多人共用剧情与跨账号联系。
5. `runtime`：调整消息合并、分段打字、重试与自动推进。
6. `memory`：调整剧本引子、事实卡、压缩、余波和 Overlay。
7. `browser`：可选的 Puppeteer 网页观察。
8. `logging`：排障期间使用，生产环境建议关闭内容预览。

首次运行建议按前五项配置；其余配置有默认值，可在私聊稳定后逐步打开。

## 1. 推荐的首次测试顺序

1. 在 `model.mode` 选择 `openai-compatible`。
2. 在 `model.providers` 填一条服务商：`enabled`、`endpoint`、`apiKey`；随后在 `model.models` 登记主叙事模型，并在 `model.mainModelId` 下拉菜单中选择它。
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

这里集中填写服务商连接信息。Console 会把每个服务商显示成可折叠的纵向配置项；模型名、输出上限和 JSON 模式统一放在下一节的 `model.models`，因此不会在每个任务中重复填写。

| 字段 | 详细说明 |
| --- | --- |
| `id` | 服务商代号，例如 `primary`、`backup`。模型预设会用它复用对应服务商配置。 |
| `label` | Console 里显示的备注名称，不影响调用。 |
| `enabled` | 是否允许使用这一行。关闭后故障切换也不会选它。 |
| `endpoint` | OpenAI 兼容 Chat Completions 接口地址。按 Console 提示填写根地址或完整路径；不要填控制台网页、`/models` 地址或服务商主页。 |
| `apiKey` | 服务商密钥。它相当于密码，不要贴到公开日志、截图或群聊里。 |
| `extraHeaders` | 额外 HTTP 请求头，必须是 JSON 对象。大多数服务商不需要。 |
| `extraBody` | 额外请求体参数，必须是 JSON 对象。只有服务商文档要求时再填。 |

### 2.3 model.failover

故障切换用于主服务商失败时自动切换到备用服务商。需要至少两条启用的 `providers` 配置。

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 是否启用自动切换。 |
| `strategy` | `priority` 优先使用列表首项，失败后切换备用项；`round-robin` 在多个服务商间轮流调用。 |
| `maxAttemptsPerProvider` | 同一个服务商失败后在切换前重试的次数。首次测试建议保持 `1`。 |
| `cooldownMinutes` | 服务商失败后暂时跳过的分钟数，用于减少对故障接口的重复请求。 |

### 2.4 `model.models` 与各调用位置的模型选择

现在由 `model.models` 统一登记模型。每一行填写模型预设 ID、显示名称、所属服务商 ID、服务商实际模型名、默认最大输出、超时与 JSON 模式；服务商本身只负责 endpoint、API Key、请求头等连接信息。

主叙事使用 `model.mainModelId`，压缩使用 `model.compaction.modelId`，群聊快速判断使用 `model.groupGate.modelId`，Embedding 使用 `model.embedding.modelId`。这些字段在 Console 中是由模型列表生成的下拉菜单；新建或删除模型预设后，先保存/重载一次，即可刷新选项。每个文本生成任务仍可单独设置 temperature、topP、最大输出和超时时间，不会互相覆盖。

### 2.4.1 近期剧本、逻辑回合与对话前沿

主模型通过三条互补通道读取短期连续性：`activeScene` 提供最近的剧本原文和待处理事件，`recentSceneProgress` 提供最近逻辑回合的动作与状态轨迹，`recentDialogue` 提供最近十个相关回合的真实收发消息、已完成交流动作和待解决问题。对话后续会把这些历史消息标记为已完成上下文，只有新的交流动作才会生成新的可见消息。更早的主角措辞仍完整保存在数据库，但只以事实含义参与后续写作。

`runtime.activeSceneEntryLimit` 是数据库扫描上限；`runtime.activeSceneNarrativeLimit` 控制实际提供给主模型的最近剧本段落数，默认 `20`；`runtime.activeSceneCharacterBudget` 控制字符预算。`runtime.interactionLedgerLimit` 与 `runtime.interactionLedgerCharacterBudget` 控制始终启用的近期逻辑回合。每张回合卡保存关注面、完成动作、具体锚点、真实外部事件造成的影响、交流含义和未完事项。只有适配器确认投递成功的消息才能进入对话前沿；草稿和失败投递不会被当作已经说出口的话。

上下文组装时会合并几乎完全相同的相邻剧本文学段落，只保留较新的版本；对应回合的真实事件和状态卡不会被合并或删除。活动场景不足 20 段时，会从上一场景尾部补足可用的转场内容。

写作粒度由插件按真实间隔选择，不需要额外配置或模型调用：约 2 分钟内为即时增量，2～30 分钟为紧凑片段，30 分钟～2 小时为中段生活推进，超过 2 小时为关键时刻式长段推进。插件还会统计最近 12 个回合使用过的生活关注面，并把较少使用的候选面提供给主模型；它们只在当前日程、环境、身体状态、兴趣或配角关系确实支持时使用。

### 2.4.2 近期生活事实桥

`runtime.recentLifeFactsEnabled` 会额外提供活动场景之外、但仍处于近期时间窗内的生活事实。它从 `sceneTrace` 中读取时间、地点、行动、配角互动、承诺与未完事项；已存在于活动场景原文中的条目会被排除，未投递草稿也不会进入。

默认保留最近 48 小时、最多 24 条、3200 个字符。这一层专门用于处理“昨晚”“今天早些时候”“刚才和谁在做什么”之类的引用：插件会为每条事实计算角色本地日期、本地时刻、相对时间和距今时长；每个覆盖到的本地日期还会保留 1～2 条具体锚点，避免今天的密集对话把昨晚事实完全挤掉。它只增加一次较大的脚本事实读取，不增加模型调用；希望覆盖更长的安静期时可将小时数提高到 72，并相应控制字符预算。

旧配置中的 `providers[].model`、`providers[].temperature` 和 `providers[].topP` 仍保留作为兼容回退；新配置建议统一使用模型预设，避免同一个模型在多个位置重复填写。

### 2.5 `model.groupGate`：群聊快速判断模型

群聊消息不会直接进入主叙事模型。插件先合并短时间内的连续消息，再调用此处配置的快速模型，得到是否需要主模型处理的分数和简短理由；分数达到 `threshold` 后才调用主模型。

- `enabled`：启用群聊快速判断。未启用或未选择 `modelId` 时，群聊保持静默。
- `modelId`：从模型预设下拉菜单选择快速模型。优先选择低延迟、低成本且能稳定输出 JSON 的模型。
- `temperature`、`maxTokens`、`timeout`：建议分别从 `0.2`、`500`、`10000` 毫秒开始测试。
- `threshold`：最低通过分数。默认 `0.65`；数值较低会提高回复频率，数值较高会降低回复频率。
- `prompt`：追加给快速判断器的群聊规则，例如主角更常回应哪些话题。

### 2.6 `model.vision`：原生识图

将 `enabled` 打开后，OneBot/NapCat 私聊中的结构化图片会和同一轮文字合并发送给主叙事模型。这里使用 OpenAI-compatible 的原生多模态输入，不调用额外图片描述模型，也不会把图片 Base64 写入剧本或记忆。

所选主模型必须支持视觉输入。OneBot/NapCat 图片会优先通过当前机器人账号的 `get_image` 获取真实图片地址，因此电脑端 JPG、本地文件标识和手机端图片都走同一条路径；读取失败、非图片响应或超过 4 MiB 的图片会被忽略，文字回合继续执行。GIF、动态 WebP 和 APNG 在启用 Puppeteer 时会先截取代表帧，再作为 PNG 输入；没有 Puppeteer 时保留原始图片输入，不会生成图片描述文字。图片内容会发送给你配置的模型服务商，请按服务商隐私政策进行测试。

### 2.7 `onebot.groupChats`：群聊白名单与群设定

每一行对应一个允许 HDSI 参与的 QQ 群。它独立于 `onebot.userAccounts`：群成员会以 QQ 号和群名片被识别，但不会因此获得私聊授权。

- `groupId`：QQ 群号。
- `purpose`：群的用途、成员关系和讨论氛围。
- `characterRole`：主角在该群中的身份、与成员的距离和通常说话方式。
- `responseMode`：`mention-only` 仅在 @ 主角时判断；`selective` 判断所有新消息；`active` 使用更高的发言评估频率。
- `contextLimit`：提供给快速判断器和主模型的最近群消息条数。
- `debounceSeconds`：把连续群消息合并为一次判断的等待时间。
- `cooldownSeconds`：主角在群里说过话后，下一次可发言前的冷却时间。

群聊原文默认不进入私聊主模型上下文。它会以共享剧本事件保存，并可在后续记忆整理中提取为非逐字的事件影响。

### 2.8 model.mainPrompt、model.formatPrompt、model.fixedPrompt 与 model.stylePrompt

`mainPrompt` 是主叙事提示词，决定模型如何持续写作、推进剧本、处理关系和用户事件。可在此填写完整的创作要求。

`formatPrompt` 是输出格式补充提示词，可以增加字段使用说明，但不能取消插件固定的 JSON、时间和安全校验。

`fixedPrompt` 是所有故事都必须遵守的额外规则，例如“不要暴露住址”“不要描写某类内容”。它不能覆盖插件内置的时间规则和 JSON 输出规则。

`stylePrompt` 是默认文风提示词，只影响剧本文字的写法。角色专属文风仍然建议写在 `storyDefaults.style`。

插件固定提示词会根据当前任务只加载一套阶段规则：用户消息、对话后续、独立生活推进或到期意图；同时只加载当前时间尺度对应的即时、短段、中段或长段写作策略。请求中的 `writingScope` 会同步给出实际经过秒数、连续性范围和时间线形状，诊断日志会显示实际命中的尺度。默认提示词以正面写作要求为主，强调从 `sceneState.currentAction` 继续、保留已经完成的动作、使用具体生活细节并完成新的交流动作。用户填写的 `mainPrompt` 与 `stylePrompt` 会在固定事实协议之后追加，因此适合描述创作方向和文风，不需要重复 JSON 字段或时间规则。

主模型直接复用近期整组回复或近似重写上一段剧本时，插件会触发一次纠正重写。它使用现有主模型与同一份当前事件，不是常规附加调用。`narrative-retry` 只恢复发生服务商错误的原始用户回合，并携带原始消息和起始时间；内部重试意图不会作为剧情计划暴露给主模型。

### 2.9 model.compaction

压缩模型负责将较早的剧本整理为场景摘要、长期事实和状态变化提案。它在后台运行，不占用当前私聊的主模型等待路径。

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 是否启用压缩模型。建议开启。 |
| `modelId` | 从模型预设下拉菜单选择压缩模型。可选择更便宜、更快的模型。 |
| `temperature` | 压缩随机性。建议低一些，例如 `0.3`。 |
| `maxTokens` | 压缩模型单次输出上限。 |
| `timeout` | 等压缩模型返回的最长时间。压缩失败不会中断聊天。 |
| `topP` | 压缩模型 top-p。不了解时保持 `1`。 |
| `responseFormat` | 压缩模型结构化返回方式；不支持 JSON mode 时改为 `prompt-only`。 |
| `mainPrompt` | 压缩模型的主要整理要求，例如“优先保留承诺、未解决事项和因果关系”。 |
| `fixedPrompt` | 只给压缩模型看的额外规则，例如“承诺和未解决事项必须保留”。 |
| `stylePrompt` | 压缩摘要的写法，建议简短、客观、按时间顺序。 |

### 2.10 model.embedding

向量模型用于按当前消息的语义检索相关旧事实。它是可选增强项，首次启动可不配置。

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 是否启用语义检索。普通聊天稳定后再打开。 |
| `modelId` | 从模型预设下拉菜单选择 Embedding 模型；它会复用该模型所属服务商的 API Key 和额外请求头。 |
| `endpoint` | Embeddings 接口地址。标准 `/chat/completions` 地址可自动推导到 `/embeddings`；其他网关建议填完整地址。 |
| `dimensions` | 向量维度。只有服务商要求时才填，通常保持 `0`。 |
| `timeout` | 向量请求超时时间。失败后会退回普通记忆排序。 |
| `maxInputCharacters` | 每次拿去做语义理解的文字上限。 |
| `backfillBatchSize` | 后台每次给多少条旧事实补向量。`0` 表示不补旧历史。 |

### 2.11 `browser`：Puppeteer 只读网页观察

这是可选能力。除了启用本插件的 `browser.enabled`，还必须在 Koishi 中安装并启用官方 `koishi-plugin-puppeteer`；未安装浏览器服务时 HDSI 会把浏览任务记录为失败观察，但不会影响正常私聊、群聊、记忆或自动推进。

网页浏览按“先观察、后写入上下文”的顺序运行：主模型先产生 `browserIntent`，Puppeteer 再读取公开网页，后续主叙事回合才会收到 `webContext`。页面 HTML、Cookie、脚本、表单和登录态不会传给模型。

| 字段 | 说明与建议 |
| --- | --- |
| `enabled` | 总开关。首次测试保持关闭；确认 Puppeteer 可用后再打开。 |
| `mode` | `deferred-only` 是默认模式：不会增加当前私聊延迟。`allow-immediate` 允许私聊在一次浏览后再写一次最终剧本，能使用当前网页信息但会明显更慢。 |
| `allowSearch` / `allowVisit` | 分别允许搜索和访问明确 URL。两者均为只读；不会登录、发送表单、评论、购买或下载。 |
| `searchUrlTemplate` | 搜索页模板，必须保留 `{query}`。默认 DuckDuckGo 轻量结果页；如替换，确认目标是公开 HTTPS 页面。 |
| `allowedDomains` | 域名白名单。留空表示允许所有通过基础安全校验的公开域名；填写后仅该域名及子域名能访问。 |
| `blockedDomains` | 强制禁用的域名。`localhost`、私网 IP、IPv6 字面量、带账号密码的 URL 与非 HTTP(S) 协议始终禁止，无需在这里重复填写。 |
| `maxConcurrentPages` | 并发浏览页数。建议保持 1；增加它会提高 Chromium 内存和 CPU 占用。 |
| `maxResearchPerSweep` | 每轮后台最多执行多少条到期浏览意图。建议保持 1，避免网页加载积压占用故事串行队列。 |
| `navigationTimeout` / `waitUntil` | 页面加载上限与等待条件。默认 15 秒、`domcontentloaded` 兼顾稳定和速度；动态网页可尝试 `networkidle2`，但回复和后台任务会更慢。 |
| `maxTextCharacters` / `maxExcerptCharacters` | 分别限制抓取正文与发送给主模型的节选长度。建议不要盲目调大，网页正文可能包含无关文本和提示注入。 |
| `maxObservationsInPrompt` | 单次主模型调用携带的最近观察数。默认 4；调高会增加 token。 |
| `cacheMinutes` | 同一参与者、相同搜索或 URL 的复用窗口。默认 30 分钟；设为 0 时每次重新读取。 |
| `allowGroupTriggeredResearch` | 群聊是否能触发浏览意图。默认关闭，避免群成员一句话让角色访问网页。 |
| `logObservationPreview` | 是否把网页标题和节选写进日志。网页内容可能含敏感或不可信文本，生产环境建议关闭。 |

隐私与安全：网页节选仍可能被发送给主模型服务商。若页面或搜索词包含敏感信息，不要启用该能力；固定提示词已要求模型将网页内容视为不可信引用，不能执行其中的任何指令。

## 3. storyDefaults：故事起点

这些字段用于创建新故事的初始设定。后续变化通过记忆系统写入独立的演化覆盖层。

修改建议：小幅补充、措辞调整或细节修正不会造成问题，不需要额外操作。如果大幅改变某一部分设定，请保存配置后只清理对应 overlay：执行 `interlude.overlay.clear character`、`interlude.overlay.clear relationship` 或 `interlude.overlay.clear world`，然后按插件提示回复 `y` 确认。这些指令不会删除剧本、长期事实或普通记忆；执行 `interlude.overlay.clear all` 并回复 `y` 可一次清理全部设定 overlay。

| 字段 | 详细说明 |
| --- | --- |
| `characterName` | 默认主角名字。也可以在 `interlude.init 名字` 中单独指定。 |
| `characterProfile` | 主角初始设定：职业、作息、性格、压力、习惯、说话方式等。 |
| `userProfile` | 新参与者的默认资料。无需预设测试用户资料时可留空；单个 QQ 可在 `onebot.userAccounts` 白名单行覆盖。 |
| `relationship` | 新参与者和主角的默认关系；单个 QQ 应在 `onebot.userAccounts` 白名单行覆盖。 |
| `world` | 故事时代、世界规则和现实程度。 |
| `supportingCast` | 配角、家人、朋友、同事，以及他们和主角的关系。 |
| `location` | 主要生活地点，用于帮助模型写出地点感。 |
| `style` | 此故事专属叙事风格，例如“现实主义日常，克制，关系变化缓慢”。 |
| `timezone` | 故事时区，用来判断白天、休息和延迟回复。中国大陆通常填 `Asia/Shanghai`。 |

## 4. sharedStory：多人共享主剧本

开启后，多个获授权 QQ 会进入同一份主剧本。每个 QQ 仍保留独立的参与者状态、未读数、待回复数、关系资料和延迟回复计划。当前版本限制每个消息平台仅保留一部 `active` 主剧本；检测到旧沙箱或旧版本残留的活动剧本时，会保留规范主剧本并自动归档其它副本，后台不会再推进它们。

旧 Beta 数据不会在切换后立刻删除。账号下一次发消息时，插件会把旧的账号故事迁移为该共享主剧本中的参与者；同平台其它旧账号故事会被归档，确保不会并行推进。

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 历史兼容字段。运行时固定启用共享单主剧本，关闭该字段不会恢复旧的每账号多剧本模式。 |
| `autoEnrollParticipants` | 获授权的新 QQ 第一次私聊时是否自动加入已有主剧本。开启后无需每个账号都手动执行 `interlude.init`。 |
| `allowCrossConversationMessages` | 模型是否可以因为 A 的消息，顺带联系 B。例如角色正在和 A 处理事情，便对 B 说“我有点事，晚点找你”。关闭后仍共用生活，但不会跨账号主动发言。 |
| `shareParticipantDetails` | 是否允许实时私聊回合读取其它关系分支的事实上下文。默认关闭时，当前私聊只读取本关系的近期事实卡；全局空闲推进仍会用各分支的事实卡维持同一份生活，但不会回灌原始聊天正文。共享主剧本仍涉及多账号信息，请只使用可信模型服务商。 |
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
| `allowProactiveMessages` | 是否允许角色在用户没有新消息时主动发可见消息。开启后由主模型在每次自动推进中为每个候选动作输出 `willingness`、`reason` 和实际传达的 `meaning`；近期主动联系会作为语义历史进入下一次推进，不使用固定冷却或随机概率发送。 |
| `proactiveWillingnessThreshold` | 主动联系意愿门槛，默认 `0.65`。低于门槛的候选不投递；调低会更主动，调高会更克制。 |
| `sweepIntervalMinutes` | 后台检查延迟回复和自动推进的间隔；检查本身不一定调用模型。 |
| `minimumAdvanceMinutes` | 旧版兼容项，通常不用改。 |
| `maxStoriesPerSweep` | 每轮后台最多处理多少个故事。 |
| `activeSceneEntryLimit` | 活动场景数据库扫描上限，默认 `400`。用于穿过用户消息和分段投递行找到足够的剧本，不会全量进入提示词。 |
| `activeSceneNarrativeLimit` | 实际附带的最近剧本段落数，默认 `20`。建议先保持默认。 |
| `activeSceneCharacterBudget` | 最近剧本和未处理事件的字符预算，默认 `60000`。 |
| `previousSceneTailCharacters` | 上一已结束场景尾部预算，默认 `4000`，用于保持转场衔接。 |
| `contextEntryLimit` | 旧数据兼容和场景外事实扫描上限，默认 `30`。不控制活动场景原文。 |
| `contextCharacterBudget` | 兼容回退和可追溯事实的字符预算，默认 `6000`。 |
| `interactionLedgerLimit` | 近期逻辑回合数量，默认 `18`；始终与剧本原文配合使用。 |
| `interactionLedgerCharacterBudget` | 近期逻辑回合字符预算，默认 `3600`；保存动作、锚点、外部影响与交流含义。最近对话前沿另保留少量真实收发消息。 |
| `recentLifeFactsEnabled` | 是否启用活动场景之外的近期生活事实桥。默认开启。 |
| `recentLifeFactHours` | 近期生活事实覆盖时长，默认 `48` 小时。用于保留今天、昨晚和前一天的连续生活。 |
| `recentLifeFactLimit` | 每次最多附带多少条较早生活事实，默认 `24`。插件会优先保证每个本地日期保留关键锚点；提高会增强跨日连贯性并增加上下文。 |
| `recentLifeFactCharacterBudget` | 近期生活事实字符预算，默认 `3200`。优先保留行动、地点、人物、外部事件影响、约定和未完事项。 |
| `memoryLimit` | 每次给主模型的长期事实条数。 |
| `maxScriptCharacters` | 单次保存的幕后剧本正文上限。 |
| `maxMessageCharacters` | 角色单次可见消息长度上限。 |
| `minimumDelayedReplySeconds` | 延迟回复最短等待秒数。 |
| `maximumDelayedReplyMinutes` | 延迟回复最长等待分钟数。 |
| `userMessageDebounceSeconds` | 短时连续消息合并等待时间，默认 2 秒。每收到新消息都会重新计时，窗口内的消息只触发一次主模型写作。设为 0 可关闭。 |
| `staleNarrativeRequestWindowSeconds` | 主模型开始请求后的旧结果过期窗口，默认 5 秒。同一用户在窗口内继续发消息时，插件会尝试取消正在运行的旧网络请求；旧结果不会落库或发出，合并后的消息会重新写作。服务商或网络层不支持取消时仍会安全丢弃旧结果。 |
| `cancelDelayedRepliesOnUserMessage` | 用户在旧延迟发出前又发消息时，是否取消发往该账号的旧延迟计划（包括跨账号延迟联系）并重新推理。建议开启。 |
| `autoAdvanceEnabled` | 是否在没有活跃对话时自动补写剧本。 |
| `autoAdvanceIntervalMinutes` | 常规自动推进的间隔分钟数，默认 40 分钟。 |
| `autoAdvanceJitterMinutes` | 自动推进时间的随机浮动范围（分钟）。 |
| `conversationFollowUpMinutes` | 对话结束后安排短期补写的时间点，默认 `[10, 20]` 分钟；两次完成后恢复普通自动推进。 |
| `conversationFollowUpJitterMinutes` | 短期补写时间的随机浮动，默认 1 分钟。 |
| `pauseAfterConversationMinutes` | 旧版兼容项；新版主要由短期补写计划控制。 |
| `restWindows` | 低频自动推进时段，例如睡眠、午休或补觉。每行可设置开始、结束、最短和最长补写间隔。 |

`restWindows.start` 和 `restWindows.end` 使用 24 小时制 `HH:mm`。结束时间早于开始时间表示跨午夜，例如 `23:00` 到 `07:00`。

## 6. memory：记忆系统

### 活动场景、事件状态与剧本引子

活动场景是实时写作的文学连续性源，逻辑回合是状态连续性源。每次主叙事都会返回 `sceneState`，记录当前地点、主要活动、具体动作、刚完成或暂停的动作、身体、情绪、注意力、涉及人物和未完事项。模型遗漏细分字段时，插件会从本轮已完成动作和上一场景状态补全连续性前沿。短时间密集对话只追加实际发生的增量；睡眠与醒来、明显换地点、主要活动完成或生活阶段转换等真实边界才会请求 `close-and-open`。

每条真实用户消息有不可伪造的事件 id。主模型用 `eventResults` 将它标记为未看见、已注意、已回复或已吸收；未看见事件会继续保留，直到后续场景确实处理。角色消息只有适配器发送成功后才进入活动场景。这样可以同时避免漏掉零碎话语、虚构用户额外消息以及把未发送草稿当成既成事实。

`storyHook` 只承担近期剧本和逻辑回合之前的稳定历史。最后一次约第 10/20 分钟的短期推进会返回小型 `storyHookPatch`；连续空闲达到 `storyHookFullRefreshIdleMinutes` 后，下一次常规推进才完整重写。近期剧本、逻辑回合、事实桥和 Hook 按时间层级分工，避免同一句角色发言在多个字段中重复出现。

实时请求会并行读取静态图片、长期事实和可选的查询向量。最近对话原文具有独立长度预算，且不会重复附带已经存在于 `recentSceneProgress` 的交换摘要；这些调整只减少重复传输和串行等待，不删除活动场景原文、当前事件或未解决事项。

### 参与者可追溯事实

当前实际入站消息及其来源 id 直接位于 `currentEvent.messages`。白名单中的 `profile` / `relationship` 只由 `currentParticipant` 提供，长期事实与普通记忆只由去重后的 `continuityFacts` 提供；同一信息不会在多个上下文字段中重复出现。模型可以把确实来自入站事件的内容写入 `sceneTrace.participantFacts` 或 `storyHook.participantMatters`，并附上来源 id。

插件在保存时只保留来源 id 与本轮实际材料匹配的参与者事实。剧本正文仍可描写主角对某人的期待、猜测或情绪，但这类文学内容不会自动变成“用户已经做过某事”的记忆。这一机制不增加模型调用，也不改写剧本文字。

### 关系态势卡

关系态势卡是每个参与者当前的一张短期状态，不是追加式聊天摘要。它把用户已经表现出的状态、角色此刻的身体与心情、双方当前气氛和下一步交流方向连接起来。普通中性消息不会自动清空已有态势；主模型可以在同一次写作中保持、更新或结束它。用户状态仍是角色视角下的可修正理解，来自消息的判断必须携带真实事件 id。卡片还保存 `alreadyExpressed`，用于标记已经发送过的关心、建议或立场，避免下一轮将同一个交流动作重新发送。

| 字段 | 说明与建议 |
| --- | --- |
| `relationshipMomentEnabled` | 是否启用关系态势卡。关闭后不向主模型注入或保存新的态势；Canon、Overlay 和剧本不受影响。 |
| `relationshipMomentDefaultHours` | 模型没有给出期限时的默认持续时间，默认 24 小时。 |
| `relationshipMomentMaxHours` | 单张态势允许持续的上限，默认 168 小时。到期卡片不再进入提示词，避免一次情绪永久支配关系。 |

关系态势卡影响回复时机、解释方向、长短、直接程度、关心方式、追问和克制程度。它不提供固定台词，也不把角色强制改写成统一的温柔语气。优先级上，当前真实事件和主角当前处境决定本轮行为，关系态势承接短期影响，稳定 Overlay 与 Canon 提供长期基线。它由主叙事响应中的 `relationshipMomentUpdate` 写入，不会产生独立调用；关闭后只是不再读写新卡片，已有 Canon、Overlay、剧本和长期记忆不会被清除。

### 剧情余波（active consequences）

剧情余波用于保存一段谈话或事件已产生、且仍会影响近期决策的短期影响。例如，一句重要的话会在后续几天影响角色判断，或一次约定会暂时改变日程。它与提醒、承诺、延迟回复共用意图系统，但不会单独触发模型请求；仅在下一次用户消息、短期跟进、自动推进或到期计划的正常写作中作为背景提供。

| 字段 | 说明与建议 |
| --- | --- |
| `activeConsequencesEnabled` | 是否启用剧情余波。建议开启；关闭后不会新增余波，也不会将已有余波送入主模型。 |
| `activeConsequencePromptLimit` | 单次写作最多携带的余波条数。默认 `6` 已足够；多人关系很多时可调低以节省 token。 |
| `activeConsequenceMaxDays` | 一条余波最长保留时间。默认 `7` 天；到期后自动失效。余波用于短期影响，不替代长期事实或人设演化。 |
| `activeConsequenceDefaultStrength` | 主模型未给出强度时的默认影响程度。推荐保留 `0.55`；数值越高，越容易在近期剧本中被写到。 |

主模型只会为确实影响后续行动、情绪、关系判断或日程安排的事件建立余波。后续剧本可将余波标记为已处理、覆盖或完成；管理员也可通过 `interlude.memory.intents` 查看，并用 `interlude.memory.cancel <id>` 手动结束。

| 字段 | 详细说明 |
| --- | --- |
| `enabled` | 是否启用场景摘要、长期事实和角色变化记忆。建议开启。 |
| `backgroundIntervalMinutes` | 后台多久检查一次是否需要整理旧剧本。 |
| `storyHookPatchAfterConversation` | 是否在最后一次短期补写时合并一个小型 `storyHookPatch`。默认开启；它只更新变化的字段，不覆盖完整引子。 |
| `storyHookFullRefreshIdleMinutes` | 连续空闲多久后，下一次常规自动推进完整重写 `storyHook`。默认 `240` 分钟，即 4 小时。 |
| `sceneEntryThreshold` | 当前场景累计多少条新记录后触发整理。 |
| `sceneCharacterThreshold` | 当前场景累计多少字后触发整理。条数和字数满足任一条件即可。 |
| `factLimit` | 主模型每次最多带入多少条长期事实。 |
| `statePatchConfidenceThreshold` | 普通人物、关系、世界变化自动生效所需置信度；不足时只保留候选。 |
| `majorStatePatchConfidenceThreshold` | 重大变化自动生效所需置信度。建议保持较高。 |
| `statePatchMinEvidence` | 兼容旧配置的证据回合数下限。运行时不会低于 3，不再按一次压缩中的记录条数直接应用。 |
| `statePatchMinTurns` | 普通变化至少需要来自多少个不同剧本回合。默认 `3`。 |
| `statePatchMinDays` | 普通变化至少跨越多少个日历日。默认 `2`。重大变化不受此项限制。 |
| `statePatchCooldownHours` | 同一目标路径应用长期变化后的冷却时间。默认 `72` 小时。 |
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

### 6.4 overlay 的生命周期

overlay 只表示经过长期证据确认的稳定变化，不记录一次聊天中的临时情绪。状态提案按以下流程处理：

```text
proposed → applied → compacted
             │
             └→ cleared（管理员清理后）
```

普通变化需要至少 3 个不同剧本回合、跨越至少 2 个日历日，并受到同一路径冷却限制。近期关系变化优先由关系态势卡、Scene Trace、剧本引子、`relationshipNotes` 和剧情余波承载；这些内容不会立即改写 canon 或稳定 overlay。

相关指令：

- `interlude.overlay.status`：查看当前 overlay、候选提案和压缩快照数量。
- `interlude.overlay.compact`：只合并/压缩已应用 overlay。
- `interlude.overlay.clear character|relationship|world|all`：清理对应 overlay，并同时使相关候选提案失效。
- `interlude.compact`：完整整理剧本、事实、状态提案，并顺带执行 overlay 维护。

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
| `level` | 错误级别阈值。日常使用建议 `info`；排查异常时临时使用 `debug`。 |
| `verbosity` | 运行信息密度。`summary` 只记录回合结果、失败和重要归档；`standard` 追加模型调用、后台扫描、计时器、自动推进和记忆整理；`diagnostic` 追加跳过原因、队列状态和上下文统计。默认 `standard`。 |
| `format` | 显示布局。`detailed` 将任务、故事、阶段和详情分行显示；`compact` 输出单行摘要，适合日志量较大的环境。 |
| `logScriptPreview` | 是否输出本轮剧本内容。可能含私聊内容，排查后应关闭。 |
| `logMessageContent` | 是否输出用户消息和主角可见消息正文。涉及隐私，生产环境建议关闭。 |
| `previewLength` | 剧本或消息正文写入日志时的最大字符数。 |

推荐组合：常规测试使用 `level=info`、`verbosity=standard`、`format=detailed`；只关心是否成功运行时使用 `summary`；定位时序、合并、自动推进或任务跳过问题时使用 `diagnostic`，并在排查完成后恢复为 `standard`。`verbosity` 不会自动输出消息正文，正文仍由 `logScriptPreview` 和 `logMessageContent` 控制。

## 9. 常见测试建议

- 首次只填一条 `providers`，确认聊天可用后再加备用服务商。
- `embedding` 先保持关闭，普通聊天稳定后再测试语义召回。
- `allowProactiveMessages` 先保持关闭，避免无人发言时主动打扰测试员。
- `memory` 建议开启，它不会让每条消息多等一次主模型。
- 使用 QQ 测试时必须把测试员逐个加入 `onebot.userAccounts` 白名单；旧的 `userMode` 不再配置。
- 修改账号白名单后，旧的延迟回复在实际发送前也会再次检查权限。
- 多人测试时，先确认每个 QQ 都在 `onebot.userAccounts` 中，并在对应行填写不同的 `label`、`profile` 和 `relationship`。旧版 `sharedStory.participantPresets` 仅作为 YAML 兼容入口。
- `shareParticipantDetails` 默认关闭，用于避免默认将其他账号的私聊关系详情发送到远程模型。
