import { Context, Logger } from 'koishi'
import {
  CompactionDecision, CompactionRequest, NarrativeDecision, NarrativeProvider,
  NarrativeCompactor, NarrativeEmbedder, NarrativeRequest,
} from './types'

export type ProviderResponseFormat = 'json-object' | 'prompt-only'
export type ProviderStrategy = 'priority' | 'round-robin'

export interface ProviderConfig {
  id: string
  label: string
  enabled: boolean
  endpoint: string
  apiKey: string
  model: string
  temperature: number
  topP: number
  maxTokens: number
  timeout: number
  responseFormat: ProviderResponseFormat
  extraHeaders: string
  extraBody: string
}

export interface FailoverConfig {
  enabled: boolean
  strategy: ProviderStrategy
  maxAttemptsPerProvider: number
  cooldownMinutes: number
}

export interface ModelConfig {
  mode: 'fallback' | 'openai-compatible'
  providers: ProviderConfig[]
  failover: FailoverConfig
  mainPrompt?: string
  formatPrompt?: string
  fixedPrompt: string
  stylePrompt: string
  compaction?: CompactionConfig
  embedding?: EmbeddingConfig
}

export interface CompactionConfig {
  enabled: boolean
  providerId: string
  model: string
  temperature: number
  topP: number
  maxTokens: number
  timeout: number
  responseFormat: ProviderResponseFormat
  mainPrompt?: string
  fixedPrompt: string
  stylePrompt: string
}

/**
 * Embedding is deliberately configured separately from chat generation. A single
 * provider can be reused for its credentials, while the endpoint and model may
 * point at a cheaper or local vector model.
 */
export interface EmbeddingConfig {
  enabled: boolean
  /** Reuses apiKey and extraHeaders from a configured chat provider. */
  providerId: string
  /** OpenAI-compatible /embeddings endpoint. Leave empty to derive it from the chat endpoint. */
  endpoint: string
  model: string
  /** 0 omits the optional OpenAI dimensions parameter. */
  dimensions: number
  timeout: number
  maxInputCharacters: number
  /** Number of legacy facts to vectorize in each background maintenance pass. */
  backfillBatchSize: number
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>
}

export class SilentNarrator implements NarrativeProvider {
  async decide(): Promise<NarrativeDecision> { return {} }
}

export class SilentCompactor implements NarrativeCompactor {
  async compact(): Promise<CompactionDecision> { return {} }
}

/** A no-op embedder lets memory retrieval fall back to rule-based ranking. */
export class SilentEmbedder implements NarrativeEmbedder {
  async embed(): Promise<number[]> { return [] }
}

/**
 * Minimal OpenAI-compatible embedding client. It intentionally performs no
 * chat-provider failover: an embedding failure is non-fatal and the caller
 * simply uses importance/confidence/recency ranking for that turn.
 */
export class OpenAICompatibleEmbedder implements NarrativeEmbedder {
  constructor(private ctx: Context, private config: ModelConfig) {}

  async embed(input: string): Promise<number[]> {
    const embedding = this.config.embedding
    if (!embedding?.enabled || !embedding.model?.trim()) return []
    const provider = this.selectProvider(embedding.providerId)
    if (!provider) return []
    const endpoint = embedding.endpoint.trim() || deriveEmbeddingEndpoint(provider.endpoint)
    if (!endpoint) return []

    const text = input.trim().slice(0, Math.max(1, embedding.maxInputCharacters))
    if (!text) return []
    const response = await this.ctx.http.post<EmbeddingResponse>(endpoint, {
      model: embedding.model,
      input: text,
      ...(embedding.dimensions > 0 ? { dimensions: embedding.dimensions } : {}),
    }, {
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        ...parseObject(provider.extraHeaders, 'extraHeaders'),
      },
      timeout: embedding.timeout,
    })
    const vector = response.data?.[0]?.embedding
    if (!Array.isArray(vector) || !vector.length || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('Embedding provider returned an invalid vector.')
    }
    return vector
  }

  private selectProvider(providerId: string) {
    // An embedding endpoint may be configured independently. Do not require
    // the chat endpoint here, otherwise a provider with only an explicit
    // embedding URL could never be selected for vector retrieval.
    const providers = this.config.providers.filter(provider => provider.enabled)
    if (providerId?.trim()) return providers.find(provider => provider.id === providerId)
    return providers[0]
  }
}

export class OpenAICompatibleNarrator implements NarrativeProvider {
  /**
   * 主写作与压缩共用服务商选择、冷却和 OpenAI 兼容协议；二者的提示词和
   * token/temperature 配置不同，因此同一个实例可承担两个接口。
   */
  private cooldownUntil = new Map<string, number>()
  private roundRobinOffset = 0
  private readonly logger: Logger

  constructor(private ctx: Context, private config: ModelConfig) {
    // Context-bound loggers are registered with Koishi's logger service;
    // constructing Logger directly can bypass Console/runtime log targets.
    this.logger = ctx.logger('hds-interlude')
  }

  async decide(request: NarrativeRequest): Promise<NarrativeDecision> {
    // 主叙事调用允许逐服务商重试与故障切换：一次失败不能让故事卡死在某个 endpoint。
    const providers = this.selectProviders()
    if (!providers.length) throw new Error('No enabled OpenAI-compatible provider is available.')

    const failures: string[] = []
    for (const provider of providers) {
      const attempts = Math.max(1, this.config.failover.maxAttemptsPerProvider)
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await this.requestProvider(provider, request)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          failures.push(`${provider.label || provider.id} (attempt ${attempt}): ${detail}`)
          this.logger.warn('叙事模型服务商失败：%s；尝试=%s', provider.label || provider.id, detail)
        }
      }

      this.cooldownUntil.set(provider.id, Date.now() + this.config.failover.cooldownMinutes * 60_000)
      if (!this.config.failover.enabled) break
    }

    throw new Error(`All narrative providers failed. ${failures.join(' | ')}`)
  }

  async compact(request: CompactionRequest): Promise<CompactionDecision> {
    // 压缩处于后台，不应抛出“无可用模型”来影响正常聊天；服务层会记录失败并等待下次机会。
    const compactConfig = this.config.compaction
    if (compactConfig?.enabled === false) return {}
    // 压缩可以单独指定更便宜的模型，因此服务商本身不一定填写主聊天
    // 模型；主叙事请求仍使用默认的“必须有聊天模型”筛选。
    const providers = this.selectProviders(false)
    if (!providers.length) return {}
    const selected = compactConfig?.providerId
      ? providers.filter(provider => provider.id === compactConfig.providerId)
      : providers
    const provider = selected[0] ?? providers[0]
    const model = compactConfig?.model || provider.model
    if (!model) return {}
    const maxTokens = compactConfig?.maxTokens ?? provider.maxTokens
    const response = await this.ctx.http.post<ChatCompletionResponse>(provider.endpoint, {
      ...parseObject(provider.extraBody, 'extraBody', this.logger),
      model,
      temperature: compactConfig?.temperature ?? Math.min(provider.temperature, 0.4),
      top_p: compactConfig?.topP ?? Math.min(provider.topP, 1),
      ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
      ...(compactConfig?.responseFormat ?? provider.responseFormat) === 'json-object' ? { response_format: { type: 'json_object' } } : {},
      messages: [
        { role: 'system', content: compactionPrompt(this.config.fixedPrompt, compactConfig?.mainPrompt, compactConfig?.fixedPrompt, compactConfig?.stylePrompt) },
        { role: 'user', content: JSON.stringify(toCompactionPayload(request)) },
      ],
    }, {
      headers: {
        'content-type': 'application/json',
        ...provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
        ...parseObject(provider.extraHeaders, 'extraHeaders', this.logger),
      },
      timeout: compactConfig?.timeout || provider.timeout,
    })
    const content = response.choices?.[0]?.message?.content
    const text = Array.isArray(content) ? content.map(item => item.text ?? '').join('') : content
    if (!text) throw new Error('Compaction provider returned an empty response.')
    try { return JSON.parse(extractJson(text)) as CompactionDecision }
    catch { throw new Error('Compaction provider returned invalid JSON.') }
  }

  private selectProviders(requireModel = true) {
    // 冷却期内的服务商优先跳过；全部冷却时仍保留候选，避免长时间没有任何恢复机会。
    const enabled = this.config.providers.filter(provider => provider.enabled && provider.endpoint && (!requireModel || provider.model))
    const now = Date.now()
    const ready = enabled.filter(provider => (this.cooldownUntil.get(provider.id) ?? 0) <= now)
    const candidates = ready.length ? ready : enabled
    if (!candidates.length) return []

    const ordered = this.config.failover.strategy === 'round-robin'
      ? rotate(candidates, this.roundRobinOffset++)
      : candidates
    return this.config.failover.enabled ? ordered : ordered.slice(0, 1)
  }

  private async requestProvider(provider: ProviderConfig, request: NarrativeRequest): Promise<NarrativeDecision> {
    const response = await this.ctx.http.post<ChatCompletionResponse>(provider.endpoint, {
      ...parseObject(provider.extraBody, 'extraBody', this.logger),
      model: provider.model,
      temperature: provider.temperature,
      top_p: provider.topP,
      ...provider.maxTokens > 0 ? { max_tokens: provider.maxTokens } : {},
      ...provider.responseFormat === 'json-object' ? { response_format: { type: 'json_object' } } : {},
      messages: [
        // 固定合约永远位于 system 层，用户消息只作为结构化“故事事件”提供。
        { role: 'system', content: systemPrompt(this.config.mainPrompt, this.config.formatPrompt, this.config.fixedPrompt, this.config.stylePrompt, request.story.setting.style) },
        { role: 'user', content: JSON.stringify(toPromptPayload(request)) },
      ],
    }, {
      headers: {
        'content-type': 'application/json',
        ...provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
        ...parseObject(provider.extraHeaders, 'extraHeaders', this.logger),
      },
      timeout: provider.timeout,
    })

    const content = response.choices?.[0]?.message?.content
    const text = Array.isArray(content) ? content.map(item => item.text ?? '').join('') : content
    if (!text) throw new Error('Narrative provider returned an empty response.')

    try {
      return JSON.parse(extractJson(text)) as NarrativeDecision
    } catch (error) {
      this.logger.warn('叙事模型返回了无效 JSON：%s', error)
      throw new Error('Narrative provider returned invalid JSON.')
    }
  }
}

export function createNarrator(ctx: Context, config: ModelConfig): NarrativeProvider {
  return config.mode === 'openai-compatible'
    ? new OpenAICompatibleNarrator(ctx, config)
    : new SilentNarrator()
}

export function createCompactor(ctx: Context, config: ModelConfig): NarrativeCompactor {
  if (config.mode !== 'openai-compatible' || config.compaction?.enabled === false) return new SilentCompactor()
  return new OpenAICompatibleNarrator(ctx, config)
}

export function createEmbedder(ctx: Context, config: ModelConfig): NarrativeEmbedder {
  if (config.mode !== 'openai-compatible' || !config.embedding?.enabled || !config.embedding.model?.trim()) {
    return new SilentEmbedder()
  }
  return new OpenAICompatibleEmbedder(ctx, config)
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = (fenced?.[1] ?? text).trim()
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate
  // Some compatible gateways prepend a short explanation even when the
  // response format is JSON. Recover the outer object without accepting a
  // future prose suffix as part of the JSON payload.
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate
}

function parseObject(value: string, field: string, logger?: Logger) {
  if (!value?.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {}
  logger?.warn('忽略无效的服务商 JSON 字段：%s', field)
  return {}
}

function rotate<T>(values: T[], offset: number) {
  const start = offset % values.length
  return [...values.slice(start), ...values.slice(0, start)]
}

function deriveEmbeddingEndpoint(chatEndpoint: string) {
  // The automatic route only handles the conventional OpenAI-compatible path.
  // Non-standard gateways should use model.embedding.endpoint explicitly.
  const endpoint = chatEndpoint.trim()
  return /\/chat\/completions\/?(?:\?.*)?$/i.test(endpoint)
    ? endpoint.replace(/\/chat\/completions\/?(?:\?.*)?$/i, '/embeddings')
    : ''
}

function systemPrompt(mainPrompt: string | undefined, formatPrompt: string | undefined, fixedPrompt: string, baseStylePrompt: string, storyStylePrompt: string) {
  // 格式/现实性合约与可编辑文风明确分段，避免文风提示无意间削弱时间和 JSON 约束。
  return [
    'FORMAT AND REALITY CONTRACT (fixed by the plugin; do not change it):',
    'You are the main narrative author for HDS Interlude, a persistent life script shared by one character and multiple relationships.',
    'Return one JSON object with a continuous prose field named script, followed by a structured interaction result.',
    'The script must cover the supplied interval, incorporate the external user event when present, and stop at the point where the character has finished deciding whether to speak.',
    'The structured interaction object must have this shape:',
    '{"seen":true,"reply":{"mode":"none|immediate|delayed","content":"message text when mode is immediate or delayed","sendAt":"ISO-8601 strictly after now when mode is delayed"}}',
    'Use seen=false and reply.mode=none when the character has not noticed the message. Use seen=true and reply.mode=none when the character noticed it but does not reply. Do not put future prose into script.',
    'You may also return memories, intents, statePatch, and crossConversationActions using the optional fields described here:',
    '{"script":"prose","interaction":{"seen":true,"reply":{"mode":"none|immediate|delayed","content":"...","sendAt":"..."}},"crossConversationActions":[{"participantId":"other participant id","mode":"immediate|delayed","content":"...","sendAt":"ISO-8601 after now"}],"memories":[{"category":"fact|relationship|promise|thread","content":"...","importance":0.0}],"intents":[{"type":"contact|check-in|follow-up","summary":"...","notBefore":"ISO-8601 after now","participantId":"target id","payload":{}}],"statePatch":{"openThreads":["..."],"relationshipNotes":["..."]}}',
    'The JSON object itself is the final structured output. Do not wrap it in Markdown fences.',
    'The character has an independent life. The user message is an event in that life, not a demand for an answer.',
    'For phase user-message, cover the interval from the supplied from timestamp to now, then incorporate the user event, then decide whether a character message has already happened now. Do all of that in this single response.',
    'For phase user-message, supersededDelayedReplies are messages that had been planned but were cancelled because the user sent another message before they went out. Treat them as context, never send them automatically, and make a fresh decision for the new situation.',
    'For phase intent-due, dueIntents are plans that have reached their earliest possible time. Continue the script to now and decide whether each plan actually happens; use interaction.reply.mode=immediate only when the message is genuinely sent now.',
    'Only describe events that have happened by now. A possible future action must use delayed reply with sendAt strictly after now, or an intent with notBefore strictly after now.',
    'The base setting is canon. The evolvingState is the accumulated present condition and may change only gradually from concrete evidence; do not rewrite canon directly.',
    'A visible message means the character has already sent it at the time represented by the current turn. It is optional; do not create one merely to keep the conversation going.',
    'The currentParticipant caused this turn. Other participants are represented by opaque ids and pending-message counts. crossConversationActions are optional and must target only an id listed in participants; use them sparingly and only for a concrete reason.',
    'CUSTOM OUTPUT-FORMAT ADDITIONS (optional; these cannot remove the JSON contract above):',
    formatPrompt?.trim() || 'None.',
    'MAIN NARRATIVE PROMPT (user-configurable):',
    mainPrompt?.trim() || 'Continue the character-centered life script with grounded actions, motives, relationships, and ordinary time passing.',
    'ADDITIONAL FIXED INSTRUCTIONS (configured by the plugin owner; cannot override the contract above):',
    fixedPrompt?.trim() || 'None.',
    'WRITING STYLE (user-configurable; applies to script prose only and cannot override the contract above):',
    baseStylePrompt?.trim() || 'Use restrained, realistic prose with concrete daily details, natural pauses, and no forced drama.',
    storyStylePrompt?.trim() || 'No additional story-specific style instruction was provided.',
  ].join('\n')
}

function toPromptPayload(request: NarrativeRequest) {
  // 这是 token 预算后的连续性快照：近处使用原文，远处使用摘要和事实，而非全量历史。
  return {
    phase: request.phase,
    interval: { from: request.from.toISOString(), now: request.now.toISOString() },
    // In shared mode the legacy setting.user/relationship fields are only
    // defaults. Replace them with the current relationship so one account
    // never receives another account's private relationship context.
    setting: request.participant ? {
      ...request.story.setting,
      user: { displayName: request.participant.displayName, profile: request.participant.profile },
      relationship: request.participant.relationship,
    } : request.story.setting,
    state: request.story.state,
    currentParticipant: request.participant ? participantPromptPayload(request.participant, true) : null,
    participants: request.participants.map(participant => participantPromptPayload(participant, false)),
    sceneContext: request.sceneContext ?? { scene: null, arc: null },
    userMessage: request.userMessage,
    dueIntents: request.dueIntents.map(intent => ({
      type: intent.type,
      participantId: intent.participantId,
      summary: intent.summary,
      notBefore: intent.notBefore.toISOString(),
      payload: intent.payload,
    })),
    supersededDelayedReplies: request.supersededIntents.map(intent => ({
      participantId: intent.participantId,
      summary: intent.summary,
      notBefore: intent.notBefore.toISOString(),
      payload: intent.payload,
    })),
    memories: request.memories.map(memory => ({
      participantId: memory.participantId, category: memory.category, content: memory.content, importance: memory.importance,
    })),
    durableFacts: (request.facts ?? []).map(fact => ({
      participantId: fact.participantId, scope: fact.scope, content: fact.content, importance: fact.importance, confidence: fact.confidence,
    })),
    recentScript: request.recentEntries.map(entry => ({
      participantId: entry.participantId, kind: entry.kind, actor: entry.actor, content: entry.content,
      occurredAt: entry.occurredAt.toISOString(),
    })),
  }
}

function participantPromptPayload(participant: NonNullable<NarrativeRequest['participant']>, includeCurrentDetails: boolean) {
  const state = participant.state
  return {
    id: participant.id,
    ...(includeCurrentDetails ? {
      personId: participant.personId,
      displayName: participant.displayName,
      profile: participant.profile,
      relationship: participant.relationship,
      openThreads: state.openThreads,
      relationshipNotes: state.relationshipNotes,
      relationshipOverlay: state.relationshipOverlay,
    } : {}),
    unreadMessageCount: state.unreadMessageCount,
    pendingReplyCount: state.pendingReplyCount,
    lastUserMessageAt: state.lastUserMessageAt,
    lastCharacterMessageAt: state.lastCharacterMessageAt,
    updatedAt: participant.updatedAt.toISOString(),
  }
}

function compactionPrompt(fixedPrompt: string, compactionMainPrompt = '', compactionFixedPrompt = '', compactionStylePrompt = '') {
  // 压缩器只能提炼过去，并且只能“提出”状态变化；实际应用仍由 service 的阈值检查决定。
  return [
    'You are the low-cost continuity editor for HDS Interlude.',
    'Compress only events that have already happened. Never invent future events.',
    'Return JSON with optional scene, arc, facts, and statePatches.',
    '{"scene":{"hook":"short active-scene hook","summary":"compact scene summary","close":false},"arc":{"title":"...","summary":"..."},"facts":[{"scope":"character|world|relationship|event|promise","participantId":"optional relationship id","content":"...","importance":0.0,"confidence":0.0,"unresolved":false,"sourceEntryIds":[1]}],"statePatches":[{"target":"character|world|relationship","participantId":"relationship id when target is relationship","path":"...","proposedValue":"...","evidence":"...","confidence":0.0,"impact":"minor|major","sourceEntryIds":[1]}]}',
    'Facts must be durable and non-redundant. Set participantId for relationship-specific facts; leave it empty for world-wide facts. Set unresolved=true for a promise, question, conflict, or other fact whose outcome is still pending; otherwise use false. State patches are proposals, not direct rewrites; use high confidence only when the evidence is repeated or a major event is explicit.',
    'COMPACTION MAIN PROMPT (user-configurable):', compactionMainPrompt?.trim() || 'Compress completed scenes into concise continuity notes while preserving causality, promises, unresolved matters, and gradual character change.',
    'ADDITIONAL FIXED INSTRUCTIONS:', fixedPrompt?.trim() || 'None.',
    'COMPACTION-SPECIFIC FIXED INSTRUCTIONS:', compactionFixedPrompt?.trim() || 'None.',
    'COMPACTION WRITING STYLE (applies only to summaries, not to the main script):', compactionStylePrompt?.trim() || 'Concise, factual, chronological, and concrete.',
  ].join('\n')
}

function toCompactionPayload(request: CompactionRequest) {
  return {
    interval: { from: request.from.toISOString(), now: request.now.toISOString() },
    setting: {
      ...request.story.setting,
      user: { displayName: 'Multiple participants', profile: '' },
      relationship: '',
    },
    evolvingState: request.story.state,
    scene: request.scene,
    arc: request.arc,
    participants: request.participants.map(participant => participantPromptPayload(participant, false)),
    existingFacts: request.facts.map(fact => ({ participantId: fact.participantId, scope: fact.scope, content: fact.content, importance: fact.importance, confidence: fact.confidence, unresolved: fact.unresolved })),
    entries: request.entries.map(entry => ({ id: entry.id, participantId: entry.participantId, kind: entry.kind, actor: entry.actor, content: entry.content, occurredAt: entry.occurredAt.toISOString() })),
  }
}
