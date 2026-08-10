import { Context, Schema, Session } from 'koishi'
import { CompactionConfig, EmbeddingConfig, FailoverConfig, ModelConfig, ProviderConfig } from './narrator'
import { Config as InterludeConfig, InterludeService, LoggingConfig, MemoryConfig, OneBotAccountRule, OneBotNapCatConfig, RestWindow, RuntimeConfig, SharedStoryConfig, StoryDefaults } from './service'
import { StorySetting } from './types'

declare module 'koishi' { interface Context { interlude: InterludeService } }

export const name = 'hds-interlude'
export const inject = ['database', 'http']

const defaultProvider: ProviderConfig = {
  id: 'primary',
  label: 'Primary provider',
  enabled: true,
  endpoint: '',
  apiKey: '',
  model: '',
  temperature: 0.8,
  topP: 1,
  maxTokens: 4096,
  timeout: 60_000,
  responseFormat: 'json-object',
  extraHeaders: '',
  extraBody: '',
}

const Provider: Schema<ProviderConfig> = Schema.object({
  id: Schema.string().default('primary').description('服务商唯一标识；在主模型、压缩模型和 Embedding 配置中引用。'),
  label: Schema.string().default('Primary provider').description('仅用于 Console 显示的名称。'),
  enabled: Schema.boolean().default(true).description('是否将该服务商纳入可用候选。'),
  endpoint: Schema.string().default('').description('OpenAI 兼容 Chat Completions 完整地址，例如 /v1/chat/completions。'),
  apiKey: Schema.string().role('secret').default('').description('鉴权密钥；仅保存在 Koishi 配置中。'),
  model: Schema.string().default('').description('聊天模型标识，例如 gpt-4o-mini。'),
  temperature: Schema.number().min(0).max(2).default(0.8).description('采样温度；值越高输出越随机。'),
  topP: Schema.number().min(0).max(1).default(1).description('核采样概率；通常与 temperature 二选一调整。'),
  maxTokens: Schema.natural().min(0).max(100_000).default(4096).description('单次响应的最大生成 token 数。'),
  timeout: Schema.natural().min(1_000).max(300_000).default(60_000).role('ms').description('单次 HTTP 请求超时，单位毫秒。'),
  responseFormat: Schema.union(['json-object', 'prompt-only']).default('json-object').description('请求 JSON 模式；服务商不支持时使用 prompt-only。'),
  extraHeaders: Schema.string().role('textarea').default('').description('额外 HTTP 请求头，必须是 JSON 对象；无特殊需求留空。'),
  extraBody: Schema.string().role('textarea').default('').description('额外请求体字段，必须是 JSON 对象；无特殊需求留空。'),
})

const Failover: Schema<FailoverConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('主服务商失败时是否尝试其它已启用服务商。'),
  strategy: Schema.union(['priority', 'round-robin']).default('priority').description('priority 按配置顺序选择；round-robin 轮换选择。'),
  maxAttemptsPerProvider: Schema.natural().min(1).max(5).default(1).description('单个服务商连续失败前的最大尝试次数。'),
  cooldownMinutes: Schema.natural().min(0).max(1_440).default(5).description('服务商失败后的冷却时间，单位分钟。'),
})

const Embedding: Schema<EmbeddingConfig> = Schema.object({
  liveQuery: Schema.boolean().default(false).description('是否在每次实时对话中额外请求 Embedding 做语义检索。关闭可减少一次网络请求、降低回复延迟；后台向量补齐不受影响。'),
  enabled: Schema.boolean().default(false).description('启用长期事实的语义检索。关闭时退化为规则排序。'),
  providerId: Schema.string().default('').description('生成向量所使用的服务商 id；留空时自动选择。'),
  endpoint: Schema.string().default('').description('Embedding 接口地址；留空时根据聊天接口推导。'),
  model: Schema.string().default('').description('Embedding 模型标识，例如 text-embedding-3-small。'),
  dimensions: Schema.natural().min(0).max(32_768).default(0).description('向量维度；0 表示由服务商决定。'),
  timeout: Schema.natural().min(500).max(120_000).default(10_000).role('ms').description('向量请求超时，单位毫秒。'),
  maxInputCharacters: Schema.natural().min(100).max(32_000).default(4_000).description('单条事实送入 Embedding 的最大字符数。'),
  backfillBatchSize: Schema.natural().min(0).max(100).default(5).description('每轮后台补齐向量的事实数量；0 表示不补齐旧记录。'),
})

const Model: Schema<ModelConfig> = Schema.object({
  mode: Schema.union(['fallback', 'openai-compatible']).default('fallback').description('模型调用模式；fallback 仅用于未配置服务商时的本地回退。'),
  // 服务商字段较多，使用可折叠的纵向表单；横向 table 在 Console 窄屏上会溢出。
  providers: Schema.array(Provider.collapse(true)).default([defaultProvider]).description('聊天服务商列表；折叠行可避免窄屏横向溢出。'),
  failover: Failover.default({ enabled: true, strategy: 'priority', maxAttemptsPerProvider: 1, cooldownMinutes: 5 }).description('主模型请求失败时的切换策略。'),
  mainPrompt: Schema.string().role('textarea').default('Continue the character-centered life script with grounded actions, motives, relationships, and ordinary time passing.').description('主叙事行为指令：定义模型如何连续写作、推进生活并处理外部事件。'),
  formatPrompt: Schema.string().role('textarea').default('').description('结构化输出补充说明；只能扩展固定协议，不能覆盖 JSON、时间和安全校验。'),
  fixedPrompt: Schema.string().role('textarea').default('').description('所有故事通用的长期约束。'),
  stylePrompt: Schema.string().role('textarea').default('Use restrained, realistic prose with concrete daily details, natural pauses, and no forced drama.').description('全局叙事文风；故事级 style 可进一步覆盖。'),
  embedding: Embedding.default({ enabled: false, providerId: '', endpoint: '', model: '', dimensions: 0, timeout: 10_000, maxInputCharacters: 4_000, backfillBatchSize: 5 }).description('长期事实的语义召回设置。'),
  compaction: (Schema.object({
    enabled: Schema.boolean().default(true).description('启用后台剧本压缩与长期事实提取。'),
    providerId: Schema.string().default('').description('压缩请求使用的服务商 id；留空时自动选择。'),
    model: Schema.string().default('').description('压缩模型标识；建议使用低成本模型。'),
    temperature: Schema.number().min(0).max(2).default(0.3).description('压缩采样温度；建议保持较低以提高稳定性。'),
    maxTokens: Schema.natural().min(0).max(100_000).default(2048).description('压缩响应的最大 token 数。'),
    timeout: Schema.natural().min(1_000).max(300_000).default(60_000).role('ms').description('压缩请求超时，单位毫秒。'),
    topP: Schema.number().min(0).max(1).default(1).description('压缩请求的核采样概率。'),
    responseFormat: Schema.union(['json-object', 'prompt-only']).default('json-object').description('压缩请求的 JSON 模式；不支持时改为 prompt-only。'),
    mainPrompt: Schema.string().role('textarea').default('Compress completed scenes into concise continuity notes while preserving causality, promises, unresolved matters, and gradual character change.').description('压缩任务指令：定义摘要、事实和状态变更的提取目标。'),
    fixedPrompt: Schema.string().role('textarea').default('').description('压缩器必须遵守的长期规则。'),
    stylePrompt: Schema.string().role('textarea').default('Concise, factual, chronological, and concrete.').description('压缩结果的表达风格。'),
  }) as unknown as Schema<CompactionConfig>).default({ enabled: true, providerId: '', model: '', temperature: 0.3, topP: 1, maxTokens: 2048, timeout: 60_000, responseFormat: 'json-object', mainPrompt: 'Compress completed scenes into concise continuity notes while preserving causality, promises, unresolved matters, and gradual character change.', fixedPrompt: '', stylePrompt: 'Concise, factual, chronological, and concrete.' }),
})

const RestWindowSchema: Schema<RestWindow> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用该休息窗口。'),
  label: Schema.string().default('night sleep').description('窗口名称，仅用于识别。'),
  start: Schema.string().pattern(/^\d{1,2}:\d{2}$/).default('23:00').description('窗口开始时间，格式 HH:mm。'),
  end: Schema.string().pattern(/^\d{1,2}:\d{2}$/).default('07:00').description('窗口结束时间，格式 HH:mm；可跨午夜。'),
  minIntervalMinutes: Schema.natural().min(30).max(1_440).default(120).description('窗口内自动推进的最短间隔。'),
  maxIntervalMinutes: Schema.natural().min(30).max(1_440).default(240).description('窗口内自动推进的最长间隔。'),
})

const Runtime: Schema<RuntimeConfig> = Schema.object({
  splitReplyMessages: Schema.boolean().default(true).description('是否将主模型回复中的 <sep/> 拆成多条 QQ 消息。'),
  messageSeparator: Schema.string().default('<sep/>').description('分段消息标记。通常保持 <sep/>；模型会在需要多条气泡时输出它。'),
  typingBaseDelaySeconds: Schema.number().min(0).max(60).default(1).description('发送第二条及后续分段消息前的基础打字等待秒数。'),
  typingCharactersPerSecond: Schema.number().min(1).max(100).default(8).description('模拟打字速度，每秒字符数；数值越小，长消息等待越久。'),
  typingMaxDelaySeconds: Schema.number().min(0).max(120).default(12).description('单条后续分段消息的最长打字等待秒数。'),
  userMessageDebounceSeconds: Schema.number().min(0).max(15).default(2).description('短消息合并等待：每次收到私聊后，等待这段时间再请求主模型；期间的新消息会合并进同一次写作。设为 0 可关闭。'),
  staleNarrativeRequestWindowSeconds: Schema.number().min(0).max(30).default(5).description('旧请求过期窗口：主模型开始写作后的这段时间内，若同一用户又发消息，旧结果将丢弃，并在新消息等待结束后重新写作。'),
  narrativeRetryDelaySeconds: Schema.natural().min(5).max(3_600).default(60).description('叙事模型请求失败后，自动再次尝试处理该用户回合前等待的秒数。'),
  narrativeRetryMaxAttempts: Schema.natural().min(0).max(50).default(6).description('单次用户回合因模型失败可自动重试的最多次数；0 表示关闭。'),
  captureDirectMessages: Schema.boolean().default(true).description('是否拦截并处理私聊文本消息。'),
  autoCreate: Schema.boolean().default(false).description('无主剧本时是否自动创建；关闭后需先执行 interlude.init。'),
  ignoreCommandMessages: Schema.boolean().default(true).description('是否跳过 interlude.* 管理命令，避免进入剧本。'),
  allowProactiveMessages: Schema.boolean().default(false).description('是否允许无新消息时向参与者主动发送可见消息。'),
  sweepIntervalMinutes: Schema.natural().min(1).max(1_440).default(5).description('后台扫描周期；仅用于发现到期任务，不代表每轮都调用模型。'),
  minimumAdvanceMinutes: Schema.natural().min(1).max(10_080).default(30).description('旧版兼容字段；自动生活主要由 autoAdvanceIntervalMinutes 控制。'),
  maxStoriesPerSweep: Schema.natural().min(1).max(1_000).default(20).description('单轮后台扫描最多处理的主剧本数量。'),
  contextEntryLimit: Schema.natural().min(1).max(200).default(30).description('主模型读取的最近剧本条目数；越大越耗 token。'),
  memoryLimit: Schema.natural().min(1).max(200).default(20).description('主模型读取的长期事实数量；会经过相关性重排。'),
  maxScriptCharacters: Schema.natural().min(500).max(12_000).default(8_000).description('单次写作允许追加的剧本文本上限。'),
  maxMessageCharacters: Schema.natural().min(1).max(12_000).default(2_000).description('单条可见消息的最大字符数。'),
  minimumDelayedReplySeconds: Schema.natural().min(0).max(86_400).default(10).description('模型允许设置的最短延迟，单位秒。'),
  maximumDelayedReplyMinutes: Schema.natural().min(1).max(43_200).default(1_440).description('模型允许设置的最长延迟，单位分钟。'),
  cancelDelayedRepliesOnUserMessage: Schema.boolean().default(true).description('新消息到达时取消同一参与者的旧延迟计划，并重新决策。'),
  autoAdvanceEnabled: Schema.boolean().default(true).description('无对话时是否按真实时间补写角色生活。'),
  autoAdvanceIntervalMinutes: Schema.natural().min(5).max(1_440).default(40).description('普通时段自动推进的目标间隔，单位分钟。'),
  autoAdvanceJitterMinutes: Schema.natural().min(0).max(60).default(5).description('自动推进间隔的随机浮动范围，单位分钟。'),
  pauseAfterConversationMinutes: Schema.natural().min(1).max(1_440).default(40).description('对话或延迟投递完成后暂停自动生活的时长。'),
  restWindows: Schema.array(RestWindowSchema).role('table').default([
    { enabled: true, label: 'night sleep', start: '23:00', end: '07:00', minIntervalMinutes: 120, maxIntervalMinutes: 240 },
  ]).description('可配置多个低频推进窗口，例如睡眠或午休。'),
})

const Memory: Schema<MemoryConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用场景压缩、长期事实和状态演化。'),
  backgroundIntervalMinutes: Schema.natural().min(1).max(1_440).default(10).description('后台记忆整理检查周期，单位分钟。'),
  sceneEntryThreshold: Schema.natural().min(1).max(500).default(12).description('未压缩剧本条目达到此数量时触发整理。'),
  sceneCharacterThreshold: Schema.natural().min(500).max(200_000).default(8_000).description('未压缩剧本字符数达到此值时触发整理。'),
  recentEntryLimit: Schema.natural().min(1).max(200).default(30).description('每次主模型请求附带的最近原始条目数。'),
  factLimit: Schema.natural().min(1).max(200).default(20).description('每次主模型请求附带的长期事实数。'),
  statePatchConfidenceThreshold: Schema.number().min(0).max(1).default(0.82).description('普通设定变更的最低置信度。'),
  majorStatePatchConfidenceThreshold: Schema.number().min(0).max(1).default(0.95).description('重大设定变更的最低置信度。'),
  statePatchMinEvidence: Schema.natural().min(1).max(20).default(2).description('普通设定变更至少需要的独立证据条数。'),
  maxFactsPerStory: Schema.natural().min(10).max(2_000).default(200).description('单个主剧本保留的长期事实总量上限。'),
  maxStoriesPerCompactionRun: Schema.natural().min(1).max(1_000).default(20).description('单轮后台整理最多处理的主剧本数。'),
  compactionEntryLimit: Schema.natural().min(1).max(500).default(80).description('压缩模型单次读取的最大剧本条目数。'),
  compactionCharacterLimit: Schema.natural().min(500).max(200_000).default(32_000).description('压缩模型单次读取的最大字符数。'),
  sceneHookCharacters: Schema.natural().min(100).max(10_000).default(2_000).description('场景引子的最大字符数。'),
  sceneSummaryCharacters: Schema.natural().min(500).max(50_000).default(8_000).description('场景摘要的最大字符数。'),
  arcSummaryCharacters: Schema.natural().min(500).max(100_000).default(12_000).description('剧情弧线摘要的最大字符数。'),
  factContentCharacters: Schema.natural().min(100).max(20_000).default(4_000).description('单条长期事实的最大字符数。'),
  factImportanceWeight: Schema.number().min(0).max(1).default(0.5).description('事实排序中的重要度权重。'),
  factConfidenceWeight: Schema.number().min(0).max(1).default(0.35).description('事实排序中的置信度权重。'),
  factRecencyWeight: Schema.number().min(0).max(1).default(0.15).description('事实排序中的时间衰减权重。'),
  semanticWeight: Schema.number().min(0).max(2).default(0.55).description('启用 Embedding 后的语义相关度权重。'),
  unresolvedWeight: Schema.number().min(0).max(2).default(0.2).description('未解决事项的额外排序权重。'),
  autoApplyStatePatches: Schema.boolean().default(true).description('是否自动应用达到门槛的设定演化建议。'),
  allowMajorStateChanges: Schema.boolean().default(true).description('是否允许自动应用重大人物或世界状态变更。'),
})

const StoryDefaults: Schema<StoryDefaults> = Schema.object({
  characterName: Schema.string().default('Unnamed character').description('主角显示名称。'),
  characterProfile: Schema.string().role('textarea').default('').description('主角的背景、性格、日程和说话方式；作为故事起点，不是永久锁定的人设。'),
  userProfile: Schema.string().role('textarea').default('').description('未单独配置参与者时使用的默认用户资料；可被白名单行覆盖。'),
  relationship: Schema.string().role('textarea').default('').description('未单独配置参与者时使用的初始关系；可被白名单行覆盖。'),
  world: Schema.string().role('textarea').default('').description('故事时代、地点和现实规则；作为剧本的初始世界状态。'),
  supportingCast: Schema.string().role('textarea').default('').description('配角及其与主角的关系；无配角可留空。'),
  location: Schema.string().default('').description('主角的主要活动地点。'),
  style: Schema.string().role('textarea').default('现实主义日常叙事，情绪克制，关系变化缓慢而具体。').description('该主剧本的文风；优先级高于全局 stylePrompt。'),
  timezone: Schema.string().default('Asia/Shanghai').description('用于自动推进、休息窗口和延迟时间解析的 IANA 时区。'),
})

const Logging: Schema<LoggingConfig> = Schema.object({
  level: Schema.union(['silent', 'error', 'warn', 'info', 'debug']).default('info').description('日志阈值；info 显示正常生命周期，debug 追加详细诊断。'),
  format: Schema.union(['compact', 'detailed']).default('detailed').description('compact 为单行摘要；detailed 将故事、阶段和事件拆成多行，便于阅读。'),
  logScriptPreview: Schema.boolean().default(false).description('是否输出本轮剧本内容；可能包含私聊信息，生产环境建议关闭。'),
  logMessageContent: Schema.boolean().default(false).description('是否输出用户消息和主角可见消息内容；涉及隐私，生产环境建议关闭。'),
  previewLength: Schema.natural().min(50).max(4_000).default(500).description('剧本和消息内容写入日志时的最大字符数。'),
})

const OneBotBotAccount: Schema<OneBotAccountRule> = Schema.object({
  qq: Schema.string().default('').description('机器人 QQ 号；为空表示不限制发送账号。'),
  label: Schema.string().default('').description('账号备注，仅用于识别。'),
  enabled: Schema.boolean().default(true).description('是否允许此机器人账号投递角色消息。'),
})

// The allowlist is also the identity sheet for the shared story. Collapsing
// each row keeps the Console usable when a tester has many QQ accounts.
const OneBotUserAccount: Schema<OneBotAccountRule> = Schema.object({
  qq: Schema.string().default('').description('允许互动的用户 QQ；未列出的账号直接拒绝。'),
  label: Schema.string().default('').description('主角对该用户的称呼；留空时使用平台昵称。'),
  personId: Schema.string().default('').description('稳定的人物标识；同一现实人物的多个账号可复用。'),
  profile: Schema.string().role('textarea').default('').description('主角已知的用户背景；仅用于该关系分支。'),
  relationship: Schema.string().role('textarea').default('').description('该用户与主角的初始关系，例如“熟悉但近来联系不多”。'),
  enabled: Schema.boolean().default(true).description('是否接受该账号的私聊并允许向其投递消息。'),
}).collapse(true)

const OneBot: Schema<OneBotNapCatConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用 OneBot/NapCat 账号过滤。'),
  botAccounts: Schema.array(OneBotBotAccount).role('table').default([]).description('允许投递角色消息的机器人账号；为空时不限制机器人账号。'),
  userAccounts: Schema.array(OneBotUserAccount).role('table').default([]).description('用户白名单及关系初始化表；空表拒绝所有用户。展开行填写人物资料。'),
  ignoreSelfMessages: Schema.boolean().default(true).description('忽略机器人自身产生的消息事件。'),
})

const SharedStory: Schema<SharedStoryConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('将同一机器人账号下的参与者合并到一个主剧本。'),
  autoEnrollParticipants: Schema.boolean().default(true).description('白名单用户首次私聊时是否自动加入主剧本。'),
  allowCrossConversationMessages: Schema.boolean().default(true).description('是否允许主模型向其它参与者生成跨账号消息。'),
  shareParticipantDetails: Schema.boolean().default(false).description('是否向模型提供其它参与者的历史剧本；关系字段始终匿名，涉及隐私请谨慎开启。'),
  maxCrossConversationActions: Schema.natural().min(0).max(5).default(1).description('单次主模型回合最多执行的跨账号投递动作。'),
  participantContextLimit: Schema.natural().min(1).max(20).default(6).description('单次请求附带的其它参与者上下文数量。'),
  managerAccounts: Schema.array(Schema.string()).role('table').default([]).description('可执行管理命令的 QQ；留空表示所有已授权用户。'),
})

export const Config: Schema<InterludeConfig> = Schema.object({
  onebot: OneBot.description('OneBot/NapCat 的机器人账号和用户白名单。'),
  sharedStory: SharedStory.description('多人共享主剧本及跨账号行为。'),
  memory: Memory.description('剧本压缩、事实召回和设定演化。'),
  model: Model.description('主叙事、压缩和 Embedding 模型配置。'),
  runtime: Runtime.description('消息接管、延迟回复和自动推进调度。'),
  storyDefaults: StoryDefaults.description('新主剧本的初始 Canon。'),
  logging: Logging.description('运行日志级别、格式和隐私选项。'),
})

export function apply(ctx: Context, config: InterludeConfig) {
  const startupLogger = ctx.logger('hds-interlude')
  startupLogger.info('plugin load started')
  const service = new InterludeService(ctx, config)
  registerCommands(ctx, service)

  ctx.middleware(async (session, next) => {
    if (!config.runtime.captureDirectMessages || !session.isDirect || !session.content?.trim()) return next()
    if (config.runtime.ignoreCommandMessages && looksLikeInterludeCommand(session.content)) return next()
    const consumed = await service.receive(session)
    return consumed ? undefined : next()
  })
  startupLogger.info('plugin load completed')
}

function registerCommands(ctx: Context, service: InterludeService) {
  ctx.command('interlude', 'HDS Interlude：私聊故事测试与管理命令')

  ctx.command('interlude.init [name:text]', '为当前私聊创建故事；name 填主角名字，可省略')
    .action(async ({ session }, name) => {
      if (!service.canHandleSession(session)) return '当前 QQ 账号未获 HDSI 互动授权。请在 Console 的“NapCat / OneBot QQ 账号控制”中检查机器人 QQ 号、用户 QQ 白名单和启用状态。'
      const existing = await service.findStory(session)
      if (existing) {
        const participant = await service.ensureParticipant(existing, session)
        return `已把 ${participant.displayName} 加入 ${existing.setting.character.name} 的共享主剧本；当前账号使用人物代号 ${participant.personId}。`
      }
      const story = await service.createStory(session, name)
      const participant = await service.findParticipant(session, story)
      return `已创建 ${story.setting.character.name} 的共享主剧本，并加入 ${participant?.displayName || session.userId}。其它获授权账号之后私聊时会进入同一段生活。`
    })

  ctx.command('interlude.setup <json:text>', '高级：用 JSON 单独修改当前故事设定；普通测试请优先在 Console 填 storyDefaults')
    .action(async ({ session }, json) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。请在 Console 的 sharedStory.managerAccounts 中添加此 QQ，或留空允许所有获授权账号。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      try {
        const patch = JSON.parse(json) as Partial<StorySetting>
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设定必须是 JSON 对象。普通测试无需使用此命令。')
        const updated = await service.updateSetting(story, patch)
        return `已保存 ${updated.setting.character.name} 的当前故事设定。`
      } catch (error) {
        return `JSON 格式不正确：${(error as Error).message}`
      }
    })

  ctx.command('interlude.status', '查看当前故事是否启用、主角、游标和主动消息开关')
    .action(async ({ session }) => {
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return [
        `主角：${story.setting.character.name}`,
        `关系人数：${(await service.participants(story.id)).length}`,
        `故事状态：${story.status}`,
        `已写到：${story.cursorAt.toISOString()}`,
        `模型模式：${service.config.model.mode}`,
        `允许主动可见消息：${service.config.runtime.allowProactiveMessages ? '开启' : '关闭'}`,
      ].join('\n')
    })

  ctx.command('interlude.pause', '暂停当前故事的自动处理，不删除任何记录')
    .action(async ({ session }) => changeStatus(service, session, 'paused'))

  ctx.command('interlude.resume', '恢复当前故事的自动处理')
    .action(async ({ session }) => changeStatus(service, session, 'active'))

  ctx.command('interlude.advance', '手动把故事补写到现在；用于测试自动生活推进')
    .action(async ({ session }) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const messages = await service.advanceStory(story)
      await service.deliverMessages(story, messages, session)
      return messages.length ? '剧本已补写到现在，并已发送其中已经发生的可见角色消息。' : '剧本已补写到现在；这次没有发生可见角色消息。'
    })

  ctx.command('interlude.timeline [limit:number]', '查看最近剧本记录；limit 为条数，默认 10')
    .action(async ({ session }, limit = 10) => {
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const participant = await service.findParticipant(session, story)
      const entries = (await service.recentEntries(story.id, Math.max(1, Math.min(limit * 3, 90))))
        .filter(entry => !entry.participantId || entry.participantId === participant?.id)
        .slice(-Math.max(1, Math.min(limit, 30)))
      if (!entries.length) return '当前故事还没有剧本记录。'
      return entries.map(entry => `[${entry.occurredAt.toISOString()}] ${entry.actor}/${entry.kind}: ${entry.content}`).join('\n')
    })

  ctx.command('interlude.memory [limit:number]', '查看主模型提取出的耐久记忆；limit 为条数，默认 10')
    .action(async ({ session }, limit = 10) => {
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const participant = await service.findParticipant(session, story)
      const memories = await service.memories(story.id, Math.max(1, Math.min(limit, 30)), participant?.id)
      if (!memories.length) return '暂时还没有提取出耐久记忆；多进行一些对话并等待后台整理后再看。'
      return memories.map(memory => `[${memory.category}/${memory.importance.toFixed(2)}] ${memory.content}`).join('\n')
    })

  ctx.command('interlude.context', '查看场景摘要、剧情弧线、人物变化覆写和长期事实')
    .action(async ({ session }) => {
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const participant = await service.findParticipant(session, story)
      const [scene, arc, facts] = await Promise.all([
        service.activeScene(story.id), service.activeArc(story.id), service.facts(story.id, 8, '', participant?.id),
      ])
      return [
        `场景引子：${scene?.hook || '尚未整理'}`,
        `场景摘要：${scene?.summary || '尚未整理'}`,
        `剧情弧线：${arc?.title || '开场'} — ${arc?.summary || '尚未整理'}`,
        `当前关系：${participant?.displayName || session.userId}（${participant?.relationship || '未填写'}）`,
        `当前关系状态：${JSON.stringify(participant?.state ?? {})}`,
        `主角全局变化：${JSON.stringify(story.state.settingOverlay ?? {})}`,
        `长期事实：${facts.length ? facts.map(fact => `[${fact.scope}/${fact.importance.toFixed(2)}] ${fact.content}`).join(' | ') : '暂无'}`,
      ].join('\n')
    })

  ctx.command('interlude.compact', '立即整理一次当前故事的旧剧本；用于测试记忆压缩')
    .action(async ({ session }) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const compacted = await service.compactStory(story)
      return compacted ? '已完成一次连续性记忆整理。' : '当前还没有达到需要整理的剧本量。'
    })

  ctx.command('interlude.script [limit:number]', '管理员：查看当前主剧本的最近原始条目，默认 20 条')
    .action(async ({ session }, limit = 20) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const entries = await service.recentEntries(story.id, Math.max(1, Math.min(limit, 50)))
      if (!entries.length) return '当前主剧本还没有原始条目。'
      return entries.map(entry => `#${entry.id} [${entry.occurredAt.toISOString()}] ${entry.actor}/${entry.kind}${entry.participantId ? `/${entry.participantId}` : ''}\n${entry.content}`).join('\n\n')
    })

  ctx.command('interlude.script.note <content:text>', '管理员：向剧本写入一条人工注记，不伪装成模型输出')
    .action(async ({ session }, content) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return await service.addAdminScriptNote(story, content) ? '已写入管理员注记，后续压缩会将其纳入连续性。' : '注记为空，未写入。'
    })

  ctx.command('interlude.memory.facts [limit:number]', '管理员：列出长期事实及其编号，默认 20 条')
    .action(async ({ session }, limit = 20) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const facts = await service.adminFacts(story.id, limit)
      if (!facts.length) return '当前没有有效的长期事实。'
      return facts.map(fact => `#${fact.id} [${fact.scope}] 重要度=${fact.importance.toFixed(2)} 置信度=${fact.confidence.toFixed(2)} 未解决=${fact.unresolved}\n${fact.content}`).join('\n\n')
    })

  ctx.command('interlude.memory.add <scope:string> <content:text>', '管理员：手动添加长期事实；scope 为 character/world/relationship/event/promise')
    .action(async ({ session }, scope, content) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      if (!isFactScope(scope)) return 'scope 必须是 character、world、relationship、event 或 promise。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return await service.addAdminFact(story, scope, content) ? '已添加高置信度长期事实。' : '事实内容为空，未添加。'
    })

  ctx.command('interlude.memory.forget <id:number>', '管理员：将指定长期事实标记为已失效，可审计且不会物理删除')
    .action(async ({ session }, id) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return await service.forgetAdminFact(story.id, id) ? `长期事实 #${id} 已标记为失效。` : `未找到有效的长期事实 #${id}。`
    })

  ctx.command('interlude.memory.intents [limit:number]', '管理员：查看等待中的延迟回复和后续联系计划')
    .action(async ({ session }, limit = 20) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const intents = await service.adminPendingIntents(story.id, limit)
      if (!intents.length) return '当前没有等待中的意图或延迟消息。'
      return intents.map(intent => `#${intent.id} [${intent.type}] 参与者=${intent.participantId || '全局'} 最早执行=${intent.notBefore.toISOString()}\n${intent.summary}`).join('\n\n')
    })

  ctx.command('interlude.memory.cancel <id:number>', '管理员：取消指定的等待中意图或延迟消息')
    .action(async ({ session }, id) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return await service.cancelAdminIntent(story.id, id) ? `意图 #${id} 已取消。` : `未找到等待中的意图 #${id}。`
    })

  ctx.command('interlude.memory.patches [limit:number]', '管理员：查看人物、关系和世界设定的演化提案')
    .action(async ({ session }, limit = 20) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      const patches = await service.adminStatePatches(story.id, limit)
      if (!patches.length) return '当前没有设定演化提案。'
      return patches.map(patch => `#${patch.id} [${patch.status}/${patch.target}/${patch.impact}] 置信度=${patch.confidence.toFixed(2)}\n提案：${patch.proposedValue}\n证据：${patch.evidence}`).join('\n\n')
    })

  ctx.command('interlude.memory.reject <id:number>', '管理员：拒绝一条尚未应用的设定演化提案')
    .action(async ({ session }, id) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      return await service.rejectAdminStatePatch(story.id, id) ? `设定演化提案 #${id} 已拒绝。` : `未找到待审核的设定演化提案 #${id}。`
    })

  ctx.command('interlude.database.clear <confirmation:text>', '管理员：清空 HDSI 自有 SQLite 数据表；不会删除 Koishi 用户和其它插件数据')
    .action(async ({ session }, confirmation) => {
      if (!requireManager(service, session)) return '无权限：当前账号不是 HDSI 管理员。'
      if (confirmation !== '确认清空HDSI数据库') return '为防止误删，请完整输入：确认清空HDSI数据库'
      const result = await service.clearDatabase()
      return `HDSI 数据库清空完成：处理 ${result.removed} 条记录${result.logicallyCleared ? `，其中 ${result.logicallyCleared} 条因 SQLite 锁定改为逻辑清空` : ''}。`
    })

  ctx.command('interlude.purge.all <confirmation:text>', '管理员：彻底重置所有平台的剧本、记忆与 Canon；需要确认口令')
    .action(async ({ session }, confirmation) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      if (confirmation !== '确认删除全部剧本和记忆') return '为防止误删，请完整输入：确认删除全部剧本和记忆'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      await service.purgeAllData(story.id)
      return '已彻底重置所有平台：旧剧本、场景摘要、剧情弧线、长期事实、记忆、意图、状态演化和参与者关系状态均已清除；当前故事保留为空白的全局主剧本，Canon 已按当前 Console 配置重建。'
    })

  ctx.command('interlude.purge.platform <platform:string> <confirmation:text>', '管理员：删除指定平台的全部剧本和记忆；例如 sandbox 或 onebot')
    .action(async ({ session }, platform, confirmation) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      if (confirmation !== '确认删除平台剧本和记忆') return '为防止误删，请完整输入：确认删除平台剧本和记忆'
      const normalized = String(platform ?? '').trim().toLowerCase()
      if (!normalized) return '请填写平台名，例如 sandbox 或 onebot。'
      const count = await service.purgePlatformData(normalized)
      return count
        ? `已清空并归档平台 ${normalized} 的 ${count} 部剧本；其它平台不受影响。`
        : `没有找到平台 ${normalized} 的 HDSI 剧本。`
    })

  ctx.command('interlude.purge.range <from:text> <to:text> <confirmation:text>', '管理员：删除时间范围内的剧本和关联记忆；时间使用 ISO-8601')
    .action(async ({ session }, fromText, toText, confirmation) => {
      if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
      if (confirmation !== '确认删除时间段剧本和记忆') return '为防止误删，请完整输入：确认删除时间段剧本和记忆'
      const from = new Date(fromText)
      const to = new Date(toText)
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) return '时间范围无效，请使用 ISO-8601，例如 2026-08-01T00:00:00+08:00。'
      const story = await requireStory(service, session)
      if (typeof story === 'string') return story
      await service.purgeStoryRange(story.id, from, to)
      return `已删除 ${from.toISOString()} 至 ${to.toISOString()} 范围内的剧本和关联记忆；Canon 与参与者身份未删除。`
    })
}

async function requireStory(service: InterludeService, session: Session) {
  if (!service.canHandleSession(session)) return '当前 QQ 账号未获 HDSI 互动授权。请在 Console 的“NapCat / OneBot QQ 账号控制”中检查机器人 QQ 号、用户 QQ 白名单和启用状态。'
  return await service.findStory(session) ?? '当前私聊还没有故事。请先发送：interlude.init 主角名字'
}

async function changeStatus(service: InterludeService, session: Session, status: 'active' | 'paused') {
  if (!requireManager(service, session)) return '当前 QQ 没有共享主剧本的管理权限。'
  const story = await requireStory(service, session)
  if (typeof story === 'string') return story
  await service.setStatus(story, status)
  return status === 'active' ? '故事已恢复自动处理。' : '故事已暂停自动处理；已有记录不会删除。'
}

function requireManager(service: InterludeService, session: Session) { return service.canManageSession(session) }

function isFactScope(value: string): value is 'character' | 'world' | 'relationship' | 'event' | 'promise' {
  return ['character', 'world', 'relationship', 'event', 'promise'].includes(value)
}

function looksLikeInterludeCommand(content: string) { return /^[!/.]?interlude(?:\s|$)/i.test(content.trim()) }

export * from './narrator'
export * from './service'
export * from './types'
