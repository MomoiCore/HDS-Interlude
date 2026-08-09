import { Context, Logger, Service, Session, Time } from 'koishi'
import { registerTables } from './database'
import { createCompactor, createEmbedder, createNarrator, ModelConfig } from './narrator'
import {
  CompactionDecision, emptyStorySetting, emptyStoryState, IntentDraft, InterludeArc, InterludeScene,
  InterludeParticipant, InterludeStory, MemoryDraft, NarrativeDecision, NarrativeFact, NarrativeIntent,
  NarrativeInteraction, NarrativeProvider, NarrativeRequest, NarrativeCompactor,
  NarrativeEmbedder, OutgoingMessageDraft, ParticipantState, ScriptEntry, ScriptEntryDraft, StatePatchDraft, StorySetting, StoryState,
  emptyParticipantState,
} from './types'

export interface Config {
  model: ModelConfig
  runtime: RuntimeConfig
  storyDefaults: StoryDefaults
  logging: LoggingConfig
  memory?: MemoryConfig
  sharedStory?: SharedStoryConfig
  /** Optional OneBot/NapCat account gate. It only affects the onebot platform. */
  onebot?: OneBotNapCatConfig
}

/** One row in the Console account tables. QQ ids are strings because QQ ids
 * can exceed JavaScript's safe integer range and Koishi exposes them as text. */
export interface OneBotAccountRule {
  qq: string
  label: string
  enabled: boolean
  /** Optional identity fields for a whitelisted private-message user. */
  personId?: string
  profile?: string
  relationship?: string
}

export interface OneBotNapCatConfig {
  /** When false (or omitted for old configurations), OneBot access is unchanged. */
  enabled: boolean
  /** NapCat accounts that are allowed to send the character's messages. */
  botAccounts: OneBotAccountRule[]
  /** @deprecated Kept only so old YAML can still load; runtime is allowlist-only. */
  userMode?: 'allowlist' | 'blocklist'
  userAccounts: OneBotAccountRule[]
  /** Prevent an echoed self-message from entering the narrative. */
  ignoreSelfMessages: boolean
}

export interface MemoryConfig {
  enabled: boolean
  backgroundIntervalMinutes: number
  maxStoriesPerCompactionRun: number
  sceneEntryThreshold: number
  sceneCharacterThreshold: number
  compactionEntryLimit: number
  compactionCharacterLimit: number
  sceneHookCharacters: number
  sceneSummaryCharacters: number
  arcSummaryCharacters: number
  recentEntryLimit: number
  factLimit: number
  factContentCharacters: number
  factImportanceWeight: number
  factConfidenceWeight: number
  factRecencyWeight: number
  semanticWeight: number
  unresolvedWeight: number
  statePatchConfidenceThreshold: number
  majorStatePatchConfidenceThreshold: number
  statePatchMinEvidence: number
  autoApplyStatePatches: boolean
  allowMajorStateChanges: boolean
  maxFactsPerStory: number
}

export interface RuntimeConfig {
  captureDirectMessages: boolean
  autoCreate: boolean
  ignoreCommandMessages: boolean
  allowProactiveMessages: boolean
  sweepIntervalMinutes: number
  minimumAdvanceMinutes: number
  maxStoriesPerSweep: number
  contextEntryLimit: number
  memoryLimit: number
  maxScriptCharacters: number
  maxMessageCharacters: number
  minimumDelayedReplySeconds: number
  maximumDelayedReplyMinutes: number
  cancelDelayedRepliesOnUserMessage: boolean
  /** 新版自动推进调度；旧版 minimumAdvanceMinutes 仍保留兼容。 */
  autoAdvanceEnabled?: boolean
  autoAdvanceIntervalMinutes?: number
  autoAdvanceJitterMinutes?: number
  pauseAfterConversationMinutes?: number
  restWindows?: RestWindow[]
}

/** Console presets that turn QQ accounts into named relationship branches. */
export interface ParticipantPreset {
  qq: string
  personId: string
  label: string
  profile: string
  relationship: string
  enabled: boolean
}

export interface SharedStoryConfig {
  /** One main story per bot account. Kept configurable for a safe rollback. */
  enabled: boolean
  /** Enroll an allowed account into an existing main story on its first DM. */
  autoEnrollParticipants: boolean
  /** Allow one incoming message to cause an explicitly justified message to another account. */
  allowCrossConversationMessages: boolean
  /** Send other participants' relationship/profile details to the model provider. */
  shareParticipantDetails: boolean
  /** Hard cap for cross-account messages produced by one narrative turn. */
  maxCrossConversationActions: number
  /** Number of other relationship summaries sent to the main narrator. */
  participantContextLimit: number
  /** Empty keeps legacy behaviour; otherwise only these QQs may run global management commands. */
  managerAccounts: string[]
  /** Optional QQ-to-person presets; accounts with the same personId share identity notes. */
  /** @deprecated Use onebot.userAccounts identity fields in new configs. */
  participantPresets?: ParticipantPreset[]
}

export interface RestWindow {
  enabled: boolean
  label: string
  start: string
  end: string
  minIntervalMinutes: number
  maxIntervalMinutes: number
}

interface AutoAdvanceConfig {
  enabled: boolean
  intervalMinutes: number
  jitterMinutes: number
  pauseAfterConversationMinutes: number
  restWindows: RestWindow[]
}

export interface StoryDefaults {
  characterName: string
  characterProfile: string
  userProfile: string
  relationship: string
  world: string
  supportingCast: string
  location: string
  style: string
  timezone: string
}

export interface LoggingConfig {
  level: 'silent' | 'error' | 'warn' | 'info' | 'debug'
  format: 'compact' | 'detailed'
  logScriptPreview: boolean
  previewLength: number
}

export class InterludeService extends Service {
  static inject = ['database', 'http']
  private narrator: NarrativeProvider
  private compactor: NarrativeCompactor
  private embedder: NarrativeEmbedder
  /**
   * 同一故事的用户消息、到期意图和后台压缩必须串行。否则“用户新消息
   * 取消旧延迟回复”可能与定时发送同时发生，造成过期消息仍被发出。
   */
  private queues = new Map<string, Promise<unknown>>()
  private factBackfills = new Set<string>()
  /** Use Koishi's context-bound logger so Console/runtime targets receive records. */
  private readonly serviceLogger: Logger
  private backgroundStarted = false

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'interlude')
    this.serviceLogger = ctx.logger('hds-interlude')
    registerTables(ctx)
    this.narrator = createNarrator(ctx, config.model)
    this.compactor = createCompactor(ctx, config.model)
    this.embedder = createEmbedder(ctx, config.model)
    // Defer timer registration by one event-loop turn. This keeps Console
    // plugin load/reload responsive while preserving the same background work.
    ctx.setTimeout(() => this.startBackgroundTasks(), 0)
    // The logger target may not be installed yet during plugin construction;
    // emit a second lifecycle record after Koishi is ready so it is visible in
    // both the terminal and Console log panel.
    ctx.on('ready', () => this.reportStandalone('info', '服务已就绪'))
    this.reportStandalone('info', '服务初始化完成 模型模式=%s 共享主剧本=%s 自动推进=%s', config.model.mode, this.sharedStoryConfig.enabled, this.autoAdvanceConfig.enabled)
  }

  private startBackgroundTasks() {
    if (this.backgroundStarted) return
    this.backgroundStarted = true
    // Life advancement and memory compaction are both serialized per story.
    this.ctx.setInterval(() => void this.sweep().catch(error => this.serviceLogger.warn('后台推进失败：%s', error)), Math.max(1, this.config.runtime.sweepIntervalMinutes) * Time.minute)
    if (this.memoryConfig.enabled) this.ctx.setInterval(() => void this.compactStories().catch(error => this.serviceLogger.warn('后台记忆整理失败：%s', error)), Math.max(1, this.memoryConfig.backgroundIntervalMinutes) * Time.minute)
    this.reportStandalone('debug', '后台调度器已启动')
  }

  setNarrator(provider: NarrativeProvider) { this.narrator = provider }
  getNarrator() { return this.narrator }
  setCompactor(provider: NarrativeCompactor) { this.compactor = provider }
  /** Allows a custom/local vector service without replacing the main narrator. */
  setEmbedder(provider: NarrativeEmbedder) { this.embedder = provider }

  /**
   * Returns whether this session is allowed to use HDSI. Koishi's OneBot
   * adapter uses `selfId` for the logged-in bot QQ and `userId` for the sender
   * QQ. Other adapters deliberately keep their old behaviour.
   */
  canHandleSession(session: Session): boolean {
    if (!isOneBotPlatform(session.platform)) return true
    const config = this.config.onebot
    // Backwards compatibility: an absent/disabled gate does not change old
    // installations. Once enabled, an empty list is intentionally deny-all.
    if (!config?.enabled) return true
    const selfId = normalizeAccountId(session.selfId)
    const userId = normalizeAccountId(session.userId)
    if (config.ignoreSelfMessages && selfId && selfId === userId) return false
    if (!isEnabledAccount(config.botAccounts, selfId)) {
      this.serviceLogger.debug('OneBot 闸门拒绝机器人账号 平台=%s 原始机器人ID=%s 规范化ID=%s', session.platform, session.selfId, selfId)
      return false
    }
    // HDSI deliberately uses an explicit allowlist.  A legacy userMode field
    // is ignored so an old `blocklist` value cannot silently open the bot to
    // every QQ account after an upgrade.
    const allowed = isEnabledAccount(config.userAccounts, userId)
    if (!allowed) this.serviceLogger.debug('OneBot 闸门拒绝用户账号 原始用户ID=%s 规范化ID=%s', session.userId, userId)
    return allowed
  }

  /** Same account gate for direct-message work that already has a participant. */
  canHandleParticipant(participant: InterludeParticipant): boolean {
    if (!isOneBotPlatform(participant.platform)) return true
    const config = this.config.onebot
    if (!config?.enabled) return true
    if (!isEnabledAccount(config.botAccounts, normalizeAccountId(participant.selfId))) return false
    return isEnabledAccount(config.userAccounts, normalizeAccountId(participant.userId))
  }

  canManageSession(session: Session): boolean {
    if (!this.canHandleSession(session)) {
      this.reportStandalone('info', '私聊被 OneBot 白名单拦截 平台=%s 机器人ID=%s 用户ID=%s', session.platform, session.selfId, session.userId)
      return false
    }
    const managers = this.sharedStoryConfig.managerAccounts.map(value => String(value ?? '').trim()).filter(Boolean)
    return !managers.length || managers.some(value => normalizeAccountId(value) === normalizeAccountId(session.userId))
  }

  /** Background life updates only require the bot account to remain enabled. */
  canHandleStory(story: InterludeStory): boolean {
    if (!isOneBotPlatform(story.platform)) return true
    const config = this.config.onebot
    if (!config?.enabled) return true
    return isEnabledAccount(config.botAccounts, normalizeAccountId(story.selfId))
  }

  async findStory(session: Session) {
    const id = this.sharedStoryConfig.enabled
      ? storyIdForCharacter(session.platform, session.selfId)
      : legacyStoryIdFor(session.platform, session.selfId, session.userId)
    const existing = (await this.ctx.database.get('interlude_story', { id }))[0]
    if (existing || !this.sharedStoryConfig.enabled) {
      if (existing && this.sharedStoryConfig.enabled) await this.migrateLegacyBranchIntoShared(existing, session)
      return existing
    }

    // Old beta versions used one story id per QQ. Migrate lazily when that QQ
    // first returns, so existing scripts become the first relationship branch
    // of the new shared story instead of silently disappearing.
    const legacyId = legacyStoryIdFor(session.platform, session.selfId, session.userId)
    const legacy = (await this.ctx.database.get('interlude_story', { id: legacyId }))[0]
    return legacy ? this.migrateLegacyStory(legacy, session) : undefined
  }

  async findParticipant(session: Session, story?: InterludeStory) {
    const resolved = story ?? await this.findStory(session)
    if (!resolved) return undefined
    // Participant ids from older betas were global to a bot/user pair.  Do
    // not trust that id alone: when shared mode is toggled or a legacy branch
    // is being migrated, the same pair can temporarily exist under another
    // story.  The story-bound lookup prevents accidentally moving or exposing
    // the wrong relationship branch.
    const rows = await this.ctx.database.get('interlude_participant', { storyId: resolved.id })
    return rows.find(item => sameParticipantEndpoint(item, session))
  }

  async participants(storyId: string, includePaused = false) {
    const rows = await this.ctx.database.get('interlude_participant', { storyId })
    return rows
      .filter(participant => includePaused || participant.status === 'active')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  async createStory(session: Session, name?: string) {
    if (!this.canHandleSession(session)) throw new Error('This session is not allowed to use HDS Interlude.')
    const existing = await this.findStory(session)
    if (existing) {
      await this.ensureParticipant(existing, session)
      return existing
    }
    const now = new Date()
    const setting = emptyStorySetting()
    const defaults = this.config.storyDefaults
    setting.character.name = name?.trim() || defaults.characterName || setting.character.name
    setting.character.profile = defaults.characterProfile
    // The legacy user field remains as a backwards-compatible default. The
    // real per-person profile and relationship now live on participants.
    setting.user.displayName = 'Multiple participants'
    setting.user.profile = defaults.userProfile
    setting.relationship = defaults.relationship
    setting.world = defaults.world
    setting.supportingCast = defaults.supportingCast
    setting.location = defaults.location
    setting.style = defaults.style || setting.style
    setting.timezone = defaults.timezone || setting.timezone
    const story: InterludeStory = {
      id: this.sharedStoryConfig.enabled
        ? storyIdForCharacter(session.platform, session.selfId)
        : legacyStoryIdFor(session.platform, session.selfId, session.userId),
      platform: session.platform, selfId: session.selfId, userId: '',
      channelId: '', status: 'active', setting, state: emptyStoryState(),
      cursorAt: now, createdAt: now, updatedAt: now,
    }
    try {
      await this.ctx.database.create('interlude_story', story)
    } catch (error) {
      // Two accounts can DM a newly started bot at almost the same time. The
      // database primary key is the final arbiter; join the winner instead of
      // failing one participant's first message.
      const raced = (await this.ctx.database.get('interlude_story', { id: story.id }))[0]
      if (!raced) throw error
      await this.ensureContinuity(raced, now)
      await this.ensureParticipant(raced, session, now)
      return raced
    }
    await this.ensureContinuity(story, now)
    await this.ensureParticipant(story, session, now)
    await this.appendEntry(story.id, {
      kind: 'setup', actor: 'system', content: `The story begins with ${setting.character.name}.`,
      occurredAt: now.toISOString(), metadata: {},
    }, now)
    await this.scheduleNextAutomaticAdvance(story.id, now)
    return story
  }

  /** Enrolls a QQ account as a relationship branch and refreshes its channel. */
  async ensureParticipant(story: InterludeStory, session: Session, now = new Date()) {
    const account = this.userAccountRule(session.userId)
    const preset = this.participantPreset(session.userId)
    const existing = await this.findParticipant(session, story)
    if (existing) {
      // Console edits to the whitelist are intentional identity changes.
      // Keep relationship evolution in participant.state.relationshipOverlay;
      // only this base profile/relationship is refreshed here.
      const personId = account?.personId?.trim() || preset?.personId?.trim() || existing.personId || session.userId
      const displayName = account?.label?.trim() || preset?.label?.trim() || existing.displayName || session.username || session.userId
      const profile = account?.profile?.trim() || preset?.profile?.trim() || existing.profile || this.config.storyDefaults.userProfile
      const relationship = account?.relationship?.trim() || preset?.relationship?.trim() || existing.relationship || this.config.storyDefaults.relationship
      await this.ctx.database.set('interlude_participant', { id: existing.id }, {
        storyId: story.id, channelId: session.channelId, personId, displayName, profile, relationship, updatedAt: now,
      })
      return { ...existing, storyId: story.id, channelId: session.channelId, personId, displayName, profile, relationship, updatedAt: now }
    }
    const baseId = participantIdFor(session.platform, session.selfId, session.userId)
    // Keep the historical id whenever it is free.  If an old per-account
    // story still owns it, use a deterministic story suffix instead of
    // stealing that branch's primary key during rollback/migration.
    const globallyExisting = await this.getParticipant(baseId)
    const id = !globallyExisting || globallyExisting.storyId === story.id
      ? baseId
      : participantIdForStory(story.id, session.platform, session.selfId, session.userId)
    const participant: InterludeParticipant = {
      id, storyId: story.id, platform: session.platform, selfId: session.selfId,
      userId: session.userId, channelId: session.channelId,
      personId: account?.personId?.trim() || preset?.personId?.trim() || session.userId,
      displayName: account?.label?.trim() || preset?.label?.trim() || session.username || session.userId,
      profile: account?.profile?.trim() || preset?.profile?.trim() || this.config.storyDefaults.userProfile,
      relationship: account?.relationship?.trim() || preset?.relationship?.trim() || this.config.storyDefaults.relationship,
      state: emptyParticipantState(), status: 'active', createdAt: now, updatedAt: now,
    }
    try {
      await this.ctx.database.create('interlude_participant', participant)
    } catch (error) {
      // Two first private messages can arrive before either request enters the
      // story queue.  The primary key resolves that race; return the branch
      // created by the other request instead of failing one message.
      const raced = await this.findParticipant(session, story)
      if (!raced) throw error
      return raced
    }
    await this.appendEntry(story.id, {
      kind: 'participant-joined', actor: 'system',
      content: `${participant.displayName} entered the character's relationship network.`,
      occurredAt: now.toISOString(), metadata: { personId: participant.personId },
    }, now, participant.id)
    return participant
  }

  async updateSetting(story: InterludeStory, patch: Partial<StorySetting>) {
    const setting = mergeSetting(story.setting, patch)
    const now = new Date()
    await this.ctx.database.set('interlude_story', { id: story.id }, { setting, updatedAt: now })
    return { ...story, setting, updatedAt: now }
  }

  async setStatus(story: InterludeStory, status: InterludeStory['status']) {
    const now = new Date()
    await this.ctx.database.set('interlude_story', { id: story.id }, { status, updatedAt: now })
    return { ...story, status, updatedAt: now }
  }

  async recentEntries(storyId: string, limit = this.config.runtime.contextEntryLimit) {
    const bounded = Math.max(1, Math.min(limit, 200))
    const rows = await this.ctx.database.get('interlude_script_entry', { storyId }, {
      limit: bounded,
      sort: { occurredAt: 'desc' },
    })
    return rows.reverse()
  }

  async memories(storyId: string, limit = this.config.runtime.memoryLimit, participantId?: string) {
    const bounded = Math.max(1, Math.min(limit * 4, 500))
    const rows = await this.ctx.database.get('interlude_memory', { storyId, status: 'active' }, {
      limit: bounded,
      sort: { importance: 'desc', updatedAt: 'desc' },
    })
    return rows
      .filter(memory => participantId === undefined || !memory.participantId || memory.participantId === participantId)
      .sort((a, b) => b.importance - a.importance || b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
  }

  async receive(session: Session) {
    // Check before find/create so an unauthorized QQ can neither trigger the
    // model nor create a persistent story by merely sending a private message.
    if (!this.canHandleSession(session)) return false
    let story = await this.findStory(session)
    if (!story && this.config.runtime.autoCreate) story = await this.createStory(session)
    if (!story || story.status !== 'active') {
      this.reportStandalone('info', '私聊未处理：故事不存在或已暂停 平台=%s 机器人ID=%s 用户ID=%s', session.platform, session.selfId, session.userId)
      return false
    }
    let participant = await this.findParticipant(session, story)
    if (!participant && (this.config.runtime.autoCreate || this.sharedStoryConfig.autoEnrollParticipants)) {
      participant = await this.ensureParticipant(story, session)
    }
    if (!participant || participant.status !== 'active') {
      this.report('info', story, 'user-message', '私聊未处理：参与者不存在或已暂停 用户ID=%s', session.userId)
      return false
    }
    this.report('info', story, 'user-message', '收到参与者私聊消息 参与者=%s', participant.id)

    const messages = await this.serial(story.id, async () => {
      const current = await this.getStory(story.id)
      const currentParticipant = await this.getParticipant(participant!.id)
      if (!currentParticipant || currentParticipant.status !== 'active') return []
      const now = new Date()
      const from = new Date(current.cursorAt)
      const incomingParticipant = await this.recordIncomingMessage(currentParticipant, now)
      const superseded = this.config.runtime.cancelDelayedRepliesOnUserMessage
        ? await this.cancelPendingOutgoingMessages(current.id, incomingParticipant.id, now)
        : []
      // A live message from A must not silently consume B's due reply. B's
      // intent will be judged in its own scheduled turn and delivered to B.
      const due = (await this.dueIntents(current.id, now))
        .filter(intent => !intent.participantId || intent.participantId === incomingParticipant.id)

      // 一次用户互动就是一次连续写作：模型同时补写 elapsed interval、接收
      // 当前用户事件并决定互动结果，避免“补写”和“回复判断”各调用一次主模型。
      const { decision, succeeded } = await this.tryDecide(current, incomingParticipant, 'user-message', from, now, session.content, due, superseded)
      await this.appendEntry(current.id, {
        kind: 'user-message', actor: 'user', content: session.content,
        occurredAt: now.toISOString(), metadata: { platform: session.platform, messageId: session.messageId, personId: incomingParticipant.personId },
      }, now, incomingParticipant.id)
      const messages = await this.persistDecision(current, incomingParticipant, decision, from, now, true, 'user-message')
      this.report('info', current, 'user-message', '主模型回合完成 参与者=%s 成功=%s 可见消息数=%d 回复模式=%s', incomingParticipant.id, succeeded, messages.length, decision.interaction?.reply.mode ?? 'none')
      // 模型失败时不要推进游标：下一轮仍需补写这段尚未完成的生活，避免
      // 短暂的网络/API 故障把一段真实时间永久跳过去。
      if (succeeded) {
        await this.ctx.database.set('interlude_story', { id: current.id }, { cursorAt: now, updatedAt: now })
      }
      // 每条用户消息都重新开始“对话静默计时”；若本回合安排了延迟回复，
      // 则会把第一次生活补写推迟到那条回复完成后的静默期之后。
      await this.pauseAutomaticAdvanceAfterUserMessage(current.id, now)
      if (succeeded && due.length) {
        await this.ctx.database.set('interlude_intent', { id: { $in: due.map(intent => intent.id) } }, { status: 'completed', updatedAt: now })
      }
      return messages
    })
    // Configuration can be edited while the model request is in flight. Do
    // one final check before emitting the visible reply as well.
    if (!this.canHandleSession(session)) return true
    await this.sendOutgoingMessages(story, messages, participant, session)
    // 压缩被排到当前故事队列末尾，但不 await；用户无需为低成本整理等待。
    this.scheduleCompaction(story.id)
    return true
  }

  async advanceStory(story: InterludeStory, force = true) {
    if (!this.canHandleStory(story)) return []
    const messages = await this.serial(story.id, async () => this.advanceUnlocked(await this.getStory(story.id), new Date(), force))
    if (force || messages.length) this.report('info', story, 'advance', '剧本推进完成 可见消息数=%d', messages.length)
    this.scheduleCompaction(story.id)
    return messages
  }

  /** Used by commands/tests to deliver a mixed set of account-targeted actions safely. */
  async deliverMessages(story: InterludeStory, messages: OutgoingMessageDraft[], session?: Session) {
    const participant = session ? await this.findParticipant(session, story) : undefined
    await this.sendOutgoingMessages(story, messages, participant, session)
  }

  async compactStory(story: InterludeStory, force = true) {
    if (!this.canHandleStory(story)) return false
    return this.serial(story.id, async () => this.compactUnlocked(await this.getStory(story.id), new Date(), force))
  }

  async sweep() {
    const stories = await this.ctx.database.get('interlude_story', { status: 'active' }, {
      limit: Math.max(1, this.config.runtime.maxStoriesPerSweep),
      sort: { cursorAt: 'asc' },
    })
    for (const story of stories) {
      if (!this.canHandleStory(story)) continue
      const messages = await this.advanceStory(story, false)
      if (messages.length) await this.sendScheduledMessages(story, messages)
    }
  }

  private async advanceUnlocked(story: InterludeStory, now: Date, force: boolean) {
    const from = new Date(story.cursorAt)
    const elapsed = Math.max(0, now.getTime() - from.getTime())
    const due = await this.dueIntents(story.id, now)
    const automaticDue = this.isAutomaticAdvanceDue(story, now)
    const pausedForConversation = this.isAutomaticAdvancePaused(story, now)
    if (!force && !due.length && (!automaticDue || pausedForConversation)) return []

    const messages: OutgoingMessageDraft[] = []
    let advanced = false
    let delayedReplyProcessed = false
    if (elapsed > 0 && (force || (automaticDue && !pausedForConversation))) {
      const { decision, succeeded } = await this.tryDecide(story, null, 'advance', from, now, undefined, [])
      if (succeeded) {
        messages.push(...await this.persistDecision(story, null, decision, from, now, this.config.runtime.allowProactiveMessages, 'advance'))
        await this.ctx.database.set('interlude_story', { id: story.id }, { cursorAt: now, updatedAt: now })
        advanced = true
      }
    }

    for (const dueBatch of groupDueIntents(due)) {
      const current = await this.getStory(story.id)
      // 如果本轮没有先做 automatic advance，到期意图也必须从故事游标
      // 补写到现在；否则“延迟回复到点”会漏掉中间这段角色生活。
      const dueFrom = new Date(current.cursorAt)
      // Each batch is one relationship branch. This keeps prompts private
      // while still draining every plan that was already due this sweep.
      const dueParticipantId = dueBatch[0]?.participantId || ''
      const dueParticipant = dueParticipantId ? await this.getParticipant(dueParticipantId) : undefined
      const { decision, succeeded } = await this.tryDecide(current, dueParticipant ?? null, 'intent-due', dueFrom, now, undefined, dueBatch)
      const permitMessages = this.config.runtime.allowProactiveMessages || dueBatch.some(intent => intent.payload?.userInitiated === true)
      messages.push(...await this.persistDecision(current, dueParticipant ?? null, decision, dueFrom, now, permitMessages, 'intent-due'))
      if (succeeded) {
        await this.ctx.database.set('interlude_story', { id: current.id }, { cursorAt: now, updatedAt: now })
        await this.ctx.database.set('interlude_intent', { id: { $in: dueBatch.map(intent => intent.id) } }, { status: 'completed', updatedAt: now })
        if (dueBatch.some(intent => intent.type === 'delayed-reply')) {
          delayedReplyProcessed = true
          await this.pauseAutomaticAdvanceAfterDelayedReply(story.id, now)
        } else if (!advanced && !delayedReplyProcessed) {
          await this.scheduleNextAutomaticAdvance(story.id, now)
        }
      } else {
        // Leave this and later batches pending so the next sweep can retry
        // after a transient model/provider failure.
        break
      }
    }
    if (advanced && !delayedReplyProcessed) await this.scheduleNextAutomaticAdvance(story.id, now)
    return messages
  }

  private async decide(story: InterludeStory, participant: InterludeParticipant | null, phase: NarrativeRequest['phase'], from: Date, now: Date, userMessage: string | undefined, dueIntents: NarrativeIntent[], supersededIntents: NarrativeIntent[] = []) {
    // 这里是主模型上下文的唯一入口。recentEntries 保留近距离质感，场景、弧线和
    // facts 负责把很长的过去压缩成连续性线索。参与者摘要让模型知道角色
    // 同时还在与谁维系关系，而不是把每个 QQ 当成独立世界。
    const factQuery = createFactQuery(participant, userMessage, dueIntents, supersededIntents)
    const [recentEntries, memories, scene, arc, facts, allParticipants] = await Promise.all([
      this.recentEntries(story.id, this.memoryConfig.recentEntryLimit),
      this.memories(story.id, this.memoryConfig.factLimit, participant?.id),
      this.activeScene(story.id),
      this.activeArc(story.id),
      this.facts(story.id, this.memoryConfig.factLimit, factQuery, participant?.id),
      this.participants(story.id),
    ])
    const visibleEntries = this.sharedStoryConfig.shareParticipantDetails
      ? recentEntries
      : recentEntries.filter(entry => !entry.participantId || entry.participantId === participant?.id)
    const participants = allParticipants
      .filter(item => item.id !== participant?.id && this.canHandleParticipant(item))
      .sort((left, right) => participantRelevance(right) - participantRelevance(left))
      .slice(0, this.sharedStoryConfig.participantContextLimit)
    const visibleDueIntents = this.sharedStoryConfig.shareParticipantDetails
      ? dueIntents
      : dueIntents.filter(intent => !intent.participantId || intent.participantId === participant?.id)
    return this.narrator.decide({
      phase, story, from, now, userMessage, participant, participants, dueIntents: visibleDueIntents, supersededIntents,
      shareParticipantDetails: this.sharedStoryConfig.shareParticipantDetails,
      recentEntries: visibleEntries, memories, sceneContext: { scene, arc }, facts,
    })
  }

  private async tryDecide(story: InterludeStory, participant: InterludeParticipant | null, phase: NarrativeRequest['phase'], from: Date, now: Date, userMessage: string | undefined, dueIntents: NarrativeIntent[], supersededIntents: NarrativeIntent[] = []) {
    try {
      const result = {
        decision: await this.decide(story, participant, phase, from, now, userMessage, dueIntents, supersededIntents),
        succeeded: true,
      }
      if (this.config.logging.logScriptPreview && result.decision.script) {
        this.report('debug', story, phase, '剧本预览：%s', result.decision.script.slice(0, this.config.logging.previewLength))
      }
      this.report('info', story, phase, '主模型决策完成 参与者=%s 剧本字数=%d', participant?.id || '全局', result.decision.script?.length ?? 0)
      return result
    } catch (error) {
      this.report('warn', story, phase, '主模型决策失败：%s', error)
      return { decision: {}, succeeded: false }
    }
  }

  private async persistDecision(story: InterludeStory, participant: InterludeParticipant | null, raw: NarrativeDecision, from: Date, now: Date, permitMessages: boolean, phase: NarrativeRequest['phase']) {
    // 先规范化，再写库：不信任模型给出的时间、长度和结构，尤其不能让未来剧情落库。
    const allParticipants = await this.participants(story.id)
    const permittedParticipantIds = new Set(allParticipants.filter(item => this.canHandleParticipant(item)).map(item => item.id))
    const decision = normalizeDecision(
      raw, from, now, permitMessages, this.config.runtime, this.sharedStoryConfig,
      participant?.id ?? '', permittedParticipantIds,
    )
    if (decision.script) {
      await this.appendEntry(story.id, {
        kind: 'script',
        actor: 'narrator',
        content: decision.script,
        occurredAt: now.toISOString(),
        metadata: { phase, interaction: decision.interaction ?? null },
      }, now, participant?.id ?? '')
    }
    for (const entry of decision.entries) await this.appendEntry(story.id, entry, now, participant?.id ?? '')
    for (const memory of decision.memories) await this.appendMemory(story.id, memory, now, memory.participantId ?? participant?.id ?? '')
    for (const intent of decision.intents) await this.appendIntent(story.id, intent, now, intent.participantId ?? participant?.id ?? '')
    if (participant && decision.statePatch) await this.updateParticipantState(participant, decision.statePatch, now)

    const messages = [...decision.messages]
    const interaction = decision.interaction
    if (participant && interaction?.seen) await this.markParticipantSeen(participant, now)
    if (participant && permitMessages && interaction?.reply.mode === 'immediate' && interaction.reply.content) {
      messages.push({ participantId: participant.id, content: interaction.reply.content })
    }
    if (participant && permitMessages && interaction?.reply.mode === 'delayed' && interaction.reply.content && interaction.reply.sendAt) {
      await this.appendIntent(story.id, {
        type: 'delayed-reply',
        summary: 'The character decided to send a delayed reply.',
        notBefore: interaction.reply.sendAt,
        payload: {
          content: interaction.reply.content,
          userInitiated: phase === 'user-message',
          interaction: true,
        },
      }, now, participant.id)
    }

    // A cross-account message is itself proactive from the target's point of
    // view. Allow it during a live user event, or during background work only
    // when the global proactive-message switch is enabled.
    const crossActions = phase === 'user-message' || this.config.runtime.allowProactiveMessages
      ? decision.crossConversationActions
      : []
    for (const action of crossActions) {
      if (action.mode === 'immediate') {
        messages.push({ participantId: action.participantId, content: action.content })
      } else {
        await this.appendIntent(story.id, {
          type: 'cross-conversation-message', summary: 'The character planned a message to another relationship branch.',
          notBefore: action.sendAt!, payload: { content: action.content, userInitiated: false, crossConversation: true },
        }, now, action.participantId)
      }
    }

    for (const message of messages) {
      await this.appendEntry(story.id, {
        kind: 'character-message', actor: 'character', content: message.content,
        occurredAt: now.toISOString(), metadata: { visible: true, interaction: interaction ?? null },
      }, now, message.participantId)
      const target = allParticipants.find(item => item.id === message.participantId)
      if (target) await this.recordCharacterMessage(target, now)
    }
    return messages
  }

  private async appendEntry(storyId: string, entry: ScriptEntryDraft, now: Date, participantId = '') {
    const occurredAt = toDate(entry.occurredAt) ?? now
    await this.ctx.database.create('interlude_script_entry', {
      storyId, participantId, kind: clip(entry.kind, 32) || 'life', actor: clip(entry.actor ?? 'character', 32),
      content: clip(entry.content, 12_000), occurredAt,
      metadata: isRecord(entry.metadata) ? entry.metadata : {}, createdAt: now,
    })
    // entryCount 只统计当前活动场景自上次压缩后的新增原始记录，用于触发后台压缩。
    const scene = await this.activeScene(storyId)
    if (scene) {
      await this.ctx.database.set('interlude_scene', { id: scene.id }, {
        entryCount: scene.entryCount + 1, updatedAt: now,
      })
    }
  }

  private async appendMemory(storyId: string, memory: MemoryDraft, now: Date, participantId = '') {
    await this.ctx.database.create('interlude_memory', {
      storyId, participantId, category: clip(memory.category, 32) || 'fact', content: clip(memory.content, 4_000),
      importance: clampNumber(memory.importance, 0.5, 0, 1), status: 'active', sourceEntryId: null,
      createdAt: now, updatedAt: now,
    })
  }

  /**
   * Retrieves the smallest useful slice of durable facts. When an embedding
   * model is available, semantic relevance is combined with narrative quality
   * signals instead of replacing them; a failed vector lookup simply has a
   * semantic score of zero for this turn.
   */
  async facts(storyId: string, limit = this.memoryConfig.factLimit, query = '', participantId?: string) {
    const candidateLimit = Math.max(50, Math.min(limit * 8, this.memoryConfig.maxFactsPerStory, 500))
    const rows = await this.ctx.database.get('interlude_fact', { storyId, status: 'active' }, {
      limit: candidateLimit,
      sort: { importance: 'desc', updatedAt: 'desc' },
    })
    const queryEmbedding = query.trim() ? await this.embedText(query) : []
    return rows
      .filter(fact => participantId === undefined || !fact.participantId || fact.participantId === participantId)
      .map(fact => ({ fact, score: factScore(fact, this.memoryConfig, queryEmbedding) }))
      .sort((a, b) => b.score - a.score
        || b.fact.updatedAt.getTime() - a.fact.updatedAt.getTime()
        || b.fact.id - a.fact.id)
      .slice(0, limit)
      .map(item => item.fact)
  }

  async activeScene(storyId: string): Promise<InterludeScene | null> {
    const rows = await this.ctx.database.get('interlude_scene', { storyId, status: 'active' }, {
      limit: 1,
      sort: { updatedAt: 'desc' },
    })
    return rows[0] ?? null
  }

  async activeArc(storyId: string): Promise<InterludeArc | null> {
    const rows = await this.ctx.database.get('interlude_arc', { storyId, status: 'active' }, {
      limit: 1,
      sort: { updatedAt: 'desc' },
    })
    return rows[0] ?? null
  }

  private async appendIntent(storyId: string, intent: IntentDraft, now: Date, participantId = '') {
    const notBefore = toDate(intent.notBefore)
    if (!notBefore || notBefore <= now) return
    await this.ctx.database.create('interlude_intent', {
      storyId, participantId, type: clip(intent.type, 32) || 'follow-up', summary: clip(intent.summary, 4_000), notBefore,
      status: 'pending', payload: isRecord(intent.payload) ? intent.payload : {}, createdAt: now, updatedAt: now,
    })
  }

  private async dueIntents(storyId: string, now: Date) {
    const intents = await this.ctx.database.get('interlude_intent', { storyId, status: 'pending' }, {
      sort: { notBefore: 'asc' },
    })
    return intents.filter(intent => intent.notBefore <= now)
  }

  private async cancelPendingOutgoingMessages(storyId: string, participantId: string, now: Date) {
    const intents = await this.ctx.database.get('interlude_intent', { storyId, status: 'pending' })
    const matching = intents.filter(intent =>
      intent.participantId === participantId
      && (intent.type === 'delayed-reply' || intent.type === 'cross-conversation-message'))
    if (!matching.length) return matching

    await this.ctx.database.set('interlude_intent', { id: { $in: matching.map(intent => intent.id) } }, {
      status: 'cancelled',
      updatedAt: now,
    })
    await this.appendEntry(storyId, {
      kind: 'intent-cancelled',
      actor: 'system',
      content: 'A newer user message superseded a pending outgoing message.',
      occurredAt: now.toISOString(),
      metadata: { intentIds: matching.map(intent => intent.id) },
    }, now, participantId)
    return matching
  }

  private async sendScheduledMessages(story: InterludeStory, messages: OutgoingMessageDraft[]) {
    await this.sendOutgoingMessages(story, messages)
  }

  /**
   * Immediate replies may reuse the incoming Session; cross-account and timed
   * messages are delivered through the target participant's channel instead.
   * This is the boundary that prevents a shared story from accidentally
   * sending every reply back to the account that happened to trigger the turn.
   */
  private async sendOutgoingMessages(story: InterludeStory, messages: OutgoingMessageDraft[], current?: InterludeParticipant, session?: Session) {
    if (!messages.length) return
    const ids = Array.from(new Set(messages.map(message => message.participantId).filter(Boolean)))
    const participants = await Promise.all(ids.map(id => this.getParticipant(id)))
    const byId = new Map(participants.filter(Boolean).map(participant => [participant!.id, participant!]))
    for (const message of messages) {
      const target = byId.get(message.participantId)
      if (!target) {
        this.report('warn', story, 'intent-due', '无法投递消息：参与者不存在 %s', message.participantId)
        continue
      }
      if (!this.canHandleParticipant(target)) {
        this.report('warn', story, 'intent-due', '消息被当前账号白名单拦截 参与者=%s', target.id)
        continue
      }
      try {
        this.report('info', story, 'intent-due', '正在投递可见消息 参与者=%s', target.id)
        if (session && current?.id === target.id) {
          await session.send(message.content)
          continue
        }
        const bot = this.findBotForParticipant(target)
        if (!bot) {
          this.report('warn', story, 'intent-due', '没有可用机器人账号投递消息 参与者=%s', target.id)
          continue
        }
        await bot.sendMessage(target.channelId, message.content)
      } catch (error) {
          this.report('warn', story, 'intent-due', '消息投递失败 参与者=%s 错误=%s', target.id, error)
      }
    }
  }

  private findBotForParticipant(participant: InterludeParticipant) {
    return this.ctx.bots.find(bot =>
      String(bot.selfId) === String(participant.selfId)
      && (bot.platform === participant.platform || isOneBotPlatform(bot.platform) && isOneBotPlatform(participant.platform)))
  }

  private get autoAdvanceConfig(): AutoAdvanceConfig {
    const runtime = this.config.runtime
    return {
      enabled: runtime.autoAdvanceEnabled ?? true,
      intervalMinutes: Math.max(1, runtime.autoAdvanceIntervalMinutes ?? 40),
      jitterMinutes: Math.max(0, runtime.autoAdvanceJitterMinutes ?? 5),
      pauseAfterConversationMinutes: Math.max(1, runtime.pauseAfterConversationMinutes ?? 40),
      restWindows: runtime.restWindows ?? [{
        enabled: true, label: 'night sleep', start: '23:00', end: '07:00',
        minIntervalMinutes: 120, maxIntervalMinutes: 240,
      }],
    }
  }

  private isAutomaticAdvancePaused(story: InterludeStory, now: Date) {
    const quietUntil = toDate(story.state.automation?.quietUntil)
    return !!quietUntil && quietUntil > now
  }

  private isAutomaticAdvanceDue(story: InterludeStory, now: Date) {
    const config = this.autoAdvanceConfig
    if (!config.enabled) return false
    const scheduled = toDate(story.state.automation?.nextAdvanceAt)
    if (scheduled) return scheduled <= now
    // Stories created before this scheduler existed have no persisted next time.
    // Use the normal cadence once, then persist a randomized schedule afterwards.
    return now.getTime() - story.cursorAt.getTime() >= config.intervalMinutes * Time.minute
  }

  private async pauseAutomaticAdvanceAfterUserMessage(storyId: string, now: Date) {
    const pending = (await this.ctx.database.get('interlude_intent', { storyId, status: 'pending' }))
      .filter(intent => intent.type === 'delayed-reply' || intent.type === 'cross-conversation-message')
    const delayedUntil = pending.reduce<Date | undefined>((latest, intent) => !latest || intent.notBefore > latest ? intent.notBefore : latest, undefined)
    await this.pauseAutomaticAdvance(storyId, now, delayedUntil, true)
  }

  private async pauseAutomaticAdvanceAfterDelayedReply(storyId: string, now: Date) {
    await this.pauseAutomaticAdvance(storyId, now, undefined, false)
  }

  private async pauseAutomaticAdvance(storyId: string, now: Date, delayedUntil?: Date, recordUserMessage = false) {
    const config = this.autoAdvanceConfig
    if (!config.enabled) return
    const story = await this.getStory(storyId)
    const anchor = delayedUntil && delayedUntil > now ? delayedUntil : now
    const quietUntil = new Date(anchor.getTime() + config.pauseAfterConversationMinutes * Time.minute)
    const automation = {
      ...(story.state.automation ?? {}),
      quietUntil: quietUntil.toISOString(),
      // The first life update happens when the conversation quiet period completes.
      nextAdvanceAt: quietUntil.toISOString(),
      ...(recordUserMessage ? { lastUserMessageAt: now.toISOString() } : {}),
    }
    await this.ctx.database.set('interlude_story', { id: story.id }, { state: { ...story.state, automation }, updatedAt: now })
  }

  private async scheduleNextAutomaticAdvance(storyId: string, now: Date) {
    const config = this.autoAdvanceConfig
    if (!config.enabled) return
    const story = await this.getStory(storyId)
    const intervalMinutes = automaticIntervalMinutes(story, now, config)
    const nextAdvanceAt = new Date(now.getTime() + intervalMinutes * Time.minute)
    const automation = {
      ...(story.state.automation ?? {}),
      quietUntil: undefined,
      lastAutoAdvanceAt: now.toISOString(),
      nextAdvanceAt: nextAdvanceAt.toISOString(),
    }
    await this.ctx.database.set('interlude_story', { id: story.id }, { state: { ...story.state, automation }, updatedAt: now })
  }

  private get sharedStoryConfig(): SharedStoryConfig {
    return {
      enabled: true,
      autoEnrollParticipants: true,
      allowCrossConversationMessages: true,
      shareParticipantDetails: false,
      maxCrossConversationActions: 1,
      participantContextLimit: 6,
      managerAccounts: [],
      participantPresets: [],
      ...(this.config.sharedStory ?? {}),
    }
  }

  private participantPreset(userId: string) {
    return (this.sharedStoryConfig.participantPresets ?? []).find(preset =>
      preset.enabled !== false && normalizeAccountId(preset.qq) === normalizeAccountId(userId))
  }

  private userAccountRule(userId: string) {
    const accounts = this.config.onebot?.userAccounts ?? []
    const normalized = normalizeAccountId(userId)
    return accounts.find(account => account.enabled !== false && normalizeAccountId(account.qq) === normalized)
  }

  private async getParticipant(id: string) {
    return (await this.ctx.database.get('interlude_participant', { id }))[0]
  }

  private async recordIncomingMessage(participant: InterludeParticipant, now: Date) {
    const current = normalizeParticipantState(participant.state)
    const state: ParticipantState = {
      ...current,
      unreadMessageCount: current.unreadMessageCount + 1,
      pendingReplyCount: current.pendingReplyCount + 1,
      lastUserMessageAt: now.toISOString(),
    }
    await this.ctx.database.set('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  private async markParticipantSeen(participant: InterludeParticipant, now: Date) {
    const current = normalizeParticipantState(participant.state)
    const state: ParticipantState = { ...current, unreadMessageCount: 0 }
    await this.ctx.database.set('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  private async recordCharacterMessage(participant: InterludeParticipant, now: Date) {
    const current = normalizeParticipantState(participant.state)
    const state: ParticipantState = {
      ...current, unreadMessageCount: 0, pendingReplyCount: 0,
      lastCharacterMessageAt: now.toISOString(),
    }
    await this.ctx.database.set('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  private async updateParticipantState(participant: InterludeParticipant, patch: Partial<ParticipantState>, now: Date) {
    const state = mergeParticipantState(normalizeParticipantState(participant.state), patch)
    await this.ctx.database.set('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  /** Converts one old account-bound story into a bot-bound shared story once. */
  private async migrateLegacyStory(legacy: InterludeStory, session: Session) {
    const now = new Date()
    const id = storyIdForCharacter(session.platform, session.selfId)
    const existing = (await this.ctx.database.get('interlude_story', { id }))[0]
    if (existing) {
      await this.migrateLegacyBranchIntoShared(existing, session)
      await this.ensureContinuity(existing, now)
      return existing
    }
    const story: InterludeStory = {
      ...legacy,
      id,
      platform: session.platform,
      selfId: session.selfId,
      userId: '',
      channelId: '',
      state: normalizeStoryState(legacy.state),
      updatedAt: now,
    }
    try {
      await this.ctx.database.create('interlude_story', story)
    } catch (error) {
      // Concurrent first visits from two legacy accounts can both decide that
      // no shared row exists.  Join the row that won the primary-key race and
      // merge this branch into it instead of leaving an active legacy copy.
      const raced = (await this.ctx.database.get('interlude_story', { id }))[0]
      if (!raced) throw error
      await this.migrateLegacyBranchIntoShared(raced, session)
      await this.ensureContinuity(raced, now)
      return raced
    }
    const participant = await this.ensureParticipant(story, session, now)
    const tables = [
      'interlude_script_entry', 'interlude_memory', 'interlude_intent',
      'interlude_scene', 'interlude_arc', 'interlude_fact', 'interlude_state_patch',
    ] as const
    for (const table of tables) await this.ctx.database.set(table, { storyId: legacy.id }, { storyId: story.id } as any)
    // The old story only had one user, so account-bound records can safely be
    // attached to that initial relationship branch during migration.
    for (const table of ['interlude_script_entry', 'interlude_memory', 'interlude_intent', 'interlude_fact', 'interlude_state_patch'] as const) {
      await this.ctx.database.set(table, { storyId: story.id }, { participantId: participant.id } as any)
    }
    await this.ctx.database.set('interlude_story', { id: legacy.id }, { status: 'archived', updatedAt: now })
    await this.ensureContinuity(story, now)
    return story
  }

  /**
   * A deployment can contain several old per-account stories. Once the first
   * one created the shared story, fold later legacy branches into it as their
   * users return; otherwise their old active rows would keep being swept in
   * parallel and create a second life for the same character.
   */
  private async migrateLegacyBranchIntoShared(story: InterludeStory, session: Session) {
    const legacyId = legacyStoryIdFor(session.platform, session.selfId, session.userId)
    if (legacyId === story.id) return
    const legacy = (await this.ctx.database.get('interlude_story', { id: legacyId }))[0]
    if (!legacy || legacy.status === 'archived') return
    const now = new Date()
    const participant = await this.ensureParticipant(story, session, now)
    for (const table of ['interlude_script_entry', 'interlude_memory', 'interlude_intent', 'interlude_fact', 'interlude_state_patch'] as const) {
      await this.ctx.database.set(table, { storyId: legacy.id }, { storyId: story.id, participantId: participant.id } as any)
    }
    await this.ctx.database.set('interlude_story', { id: legacy.id }, { status: 'archived', updatedAt: now })
    await this.appendEntry(story.id, {
      kind: 'legacy-branch-merged', actor: 'system',
      content: `Earlier account-specific history for ${participant.displayName} was merged into the shared story.`,
      occurredAt: now.toISOString(), metadata: { legacyStoryId: legacy.id },
    }, now, participant.id)
    await this.ensureContinuity(story, now)
  }

  private get memoryConfig(): MemoryConfig {
    // 保持 memory 为可选配置，方便从旧版本配置平滑升级；未填写时使用保守默认值。
    return {
      enabled: true,
      backgroundIntervalMinutes: 10,
      maxStoriesPerCompactionRun: this.config.runtime.maxStoriesPerSweep,
      sceneEntryThreshold: 12,
      sceneCharacterThreshold: 8_000,
      compactionEntryLimit: 80,
      compactionCharacterLimit: 32_000,
      sceneHookCharacters: 2_000,
      sceneSummaryCharacters: 8_000,
      arcSummaryCharacters: 12_000,
      recentEntryLimit: this.config.runtime.contextEntryLimit,
      factLimit: this.config.runtime.memoryLimit,
      factContentCharacters: 4_000,
      factImportanceWeight: 0.5,
      factConfidenceWeight: 0.35,
      factRecencyWeight: 0.15,
      semanticWeight: 0.55,
      unresolvedWeight: 0.2,
      statePatchConfidenceThreshold: 0.82,
      majorStatePatchConfidenceThreshold: 0.95,
      statePatchMinEvidence: 2,
      autoApplyStatePatches: true,
      allowMajorStateChanges: true,
      maxFactsPerStory: 200,
      ...(this.config.memory ?? {}),
    }
  }

  private async ensureContinuity(story: InterludeStory, now: Date) {
    // 每个故事始终应有一个活动场景和一个活动弧线。旧数据升级或手动关闭场景后，
    // 此方法负责补齐它们，并把 id 缓存在 story.state 供 Console/外部工具查看。
    let arc = await this.activeArc(story.id)
    if (!arc) {
      await this.ctx.database.create('interlude_arc', {
        storyId: story.id, status: 'active', title: 'Beginning', summary: '', sceneCount: 0,
        createdAt: now, updatedAt: now,
      })
      arc = await this.activeArc(story.id)
    }
    let scene = await this.activeScene(story.id)
    if (!scene) {
      await this.ctx.database.create('interlude_scene', {
        storyId: story.id, status: 'active', startedAt: now, endedAt: null,
        hook: '', summary: '', entryCount: 0, lastEntryId: null, createdAt: now, updatedAt: now,
      })
      scene = await this.activeScene(story.id)
      if (arc) await this.ctx.database.set('interlude_arc', { id: arc.id }, { sceneCount: arc.sceneCount + 1, updatedAt: now })
    }
    if (arc && scene && (story.state.activeArcId !== arc.id || story.state.activeSceneId !== scene.id)) {
      const state = { ...story.state, activeArcId: arc.id, activeSceneId: scene.id }
      await this.ctx.database.set('interlude_story', { id: story.id }, { state, updatedAt: now })
    }
  }

  private scheduleCompaction(storyId: string) {
    if (!this.memoryConfig.enabled) return
    // 不 await 的关键在于：把工作放入同一故事的串行队列，既避免与新消息竞争，
    // 又不把压缩模型的等待时间加入刚刚结束的私聊响应。
    void this.serial(storyId, async () => {
      const story = await this.getStory(storyId)
      await this.compactUnlocked(story, new Date(), false)
    }).catch(error => this.serviceLogger.debug('记忆压缩跳过：%s', error))
  }

  private async compactStories() {
    if (!this.memoryConfig.enabled) return
    const stories = await this.ctx.database.get('interlude_story', { status: 'active' }, {
      limit: Math.max(1, this.memoryConfig.maxStoriesPerCompactionRun),
      sort: { updatedAt: 'asc' },
    })
    for (const story of stories) {
      if (!this.canHandleStory(story)) continue
      this.scheduleFactEmbeddingBackfill(story.id)
      this.scheduleCompaction(story.id)
    }
  }

  private async compactUnlocked(story: InterludeStory, now: Date, force: boolean) {
    await this.ensureContinuity(story, now)
    const scene = await this.activeScene(story.id)
    if (!scene) return false
    // lastEntryId 将场景摘要变成增量检查点：已经压缩过的原文不再重复传给模型。
    const entryFilter: any = { storyId: story.id, occurredAt: { $gte: scene.startedAt } }
    if (scene.lastEntryId != null) entryFilter.id = { $gt: scene.lastEntryId }
    const entries = await this.ctx.database.get('interlude_script_entry', entryFilter, {
      limit: Math.max(this.memoryConfig.compactionEntryLimit * 2, this.memoryConfig.compactionEntryLimit),
      sort: { occurredAt: 'asc' },
    })
    const sceneEntries = limitEntriesByCharacters(entries, this.memoryConfig.compactionCharacterLimit)
    const chars = sceneEntries.reduce((sum, entry) => sum + entry.content.length, 0)
    // 任一阈值达到即可压缩；手动命令可以 force，用于调试或故事阶段转换。
    if (!force && scene.entryCount < this.memoryConfig.sceneEntryThreshold && chars < this.memoryConfig.sceneCharacterThreshold) return false
    const current = await this.getStory(story.id)
    const participants = await this.participants(story.id)
    const visibleCompactionEntries = this.sharedStoryConfig.shareParticipantDetails
      ? sceneEntries
      : sceneEntries.map(entry => entry.participantId
        ? { ...entry, participantId: '', content: '[participant-specific conversation omitted by privacy setting]' }
        : entry)
    const visibleCompactionFacts = this.sharedStoryConfig.shareParticipantDetails
      ? await this.facts(story.id, this.memoryConfig.maxFactsPerStory)
      : (await this.facts(story.id, this.memoryConfig.maxFactsPerStory)).filter(fact => !fact.participantId)
    let decision: CompactionDecision = {}
    try {
      decision = await this.compactor.compact({
        story: current, from: scene.startedAt, now, entries: visibleCompactionEntries,
        scene, arc: await this.activeArc(story.id), participants,
        facts: visibleCompactionFacts,
      })
    } catch (error) {
      this.report('warn', story, 'advance', '记忆压缩失败：%s', error)
      return false
    }
    await this.persistCompaction(current, scene, decision, sceneEntries, now)
    this.report('info', story, 'advance', '记忆压缩完成 剧本条目=%d 长期事实=%d 状态变更=%d', sceneEntries.length, decision.facts?.length ?? 0, decision.statePatches?.length ?? 0)
    return true
  }

  private async persistCompaction(story: InterludeStory, scene: InterludeScene, decision: CompactionDecision, entries: ScriptEntry[], now: Date) {
    // 摘要更新成功后才移动 lastEntryId，确保失败时原始条目仍会在下次被重新处理。
    const scenePatch = decision.scene ?? {}
    await this.ctx.database.set('interlude_scene', { id: scene.id }, {
      hook: clip(scenePatch.hook ?? scene.hook, this.memoryConfig.sceneHookCharacters),
      summary: clip(scenePatch.summary ?? scene.summary, this.memoryConfig.sceneSummaryCharacters),
      entryCount: 0, lastEntryId: entries.at(-1)?.id ?? scene.lastEntryId, updatedAt: now,
    })
    if (scenePatch.close) {
      await this.ctx.database.set('interlude_scene', { id: scene.id }, { status: 'closed', endedAt: now, updatedAt: now })
      await this.ensureContinuity(story, now)
    }
    const arc = await this.activeArc(story.id)
    if (arc && decision.arc) {
      await this.ctx.database.set('interlude_arc', { id: arc.id }, {
        title: clip(decision.arc.title ?? arc.title, 255), summary: clip(decision.arc.summary ?? arc.summary, this.memoryConfig.arcSummaryCharacters), updatedAt: now,
      })
    }
    for (const fact of decision.facts ?? []) await this.persistFact(story.id, fact, entries, now)
    for (const patch of decision.statePatches ?? []) await this.persistStatePatch(story, patch, entries, now)
  }

  private async persistFact(storyId: string, draft: { scope: NarrativeFact['scope']; content: string; participantId?: string; importance?: number; confidence?: number; unresolved?: boolean; sourceEntryIds?: number[] }, entries: ScriptEntry[], now: Date) {
    const content = clip(draft.content, this.memoryConfig.factContentCharacters)
    if (!content) return
    const participantId = resolveParticipantId(draft.participantId, draft.sourceEntryIds, entries)
    const existing = await this.ctx.database.get('interlude_fact', { storyId, status: 'active' })
    // 当前先做完全规范化匹配的去重；更复杂的语义去重可在检索层升级时替换。
    const same = existing.find(fact => normalizeFact(fact.content) === normalizeFact(content) && (!fact.participantId || fact.participantId === participantId))
    const sourceEntryIds = (draft.sourceEntryIds ?? []).filter(id => entries.some(entry => entry.id === id)).slice(0, 20)
    // Promise facts are unresolved by default, unless the compactor explicitly
    // says that the promise has already been fulfilled or closed.
    const unresolved = draft.unresolved === true || (draft.unresolved === undefined && draft.scope === 'promise')
    if (same) {
      const embedding = same.embedding?.length ? same.embedding : await this.embedText(content)
      await this.ctx.database.set('interlude_fact', { id: same.id }, {
        importance: Math.max(same.importance, clampNumber(draft.importance, same.importance, 0, 1)),
        confidence: Math.max(same.confidence, clampNumber(draft.confidence, same.confidence, 0, 1)),
        unresolved: same.unresolved || unresolved,
        ...(embedding.length ? { embedding } : {}),
        sourceEntryIds: Array.from(new Set([...same.sourceEntryIds, ...sourceEntryIds])), lastSeenAt: now, updatedAt: now,
      })
      return
    }
    if (existing.length >= this.memoryConfig.maxFactsPerStory) {
      const oldest = existing.sort((a, b) => (a.importance * a.confidence) - (b.importance * b.confidence))[0]
      if (oldest) await this.ctx.database.set('interlude_fact', { id: oldest.id }, { status: 'superseded', updatedAt: now })
    }
    await this.ctx.database.create('interlude_fact', {
      storyId, participantId, scope: draft.scope, content, importance: clampNumber(draft.importance, 0.5, 0, 1),
      confidence: clampNumber(draft.confidence, 0.5, 0, 1), unresolved,
      embedding: await this.embedText(content), status: 'active', sourceEntryIds,
      lastSeenAt: now, createdAt: now, updatedAt: now,
    })
  }

  private async embedText(value: string) {
    try {
      return await this.embedder.embed(value)
    } catch (error) {
      // Embeddings improve recall but must never make a private-message turn fail.
      this.serviceLogger.debug('Embedding 请求跳过：%s', error)
      return []
    }
  }

  private scheduleFactEmbeddingBackfill(storyId: string) {
    const embedding = this.config.model.embedding
    const batchSize = embedding?.backfillBatchSize ?? 5
    if (!embedding?.enabled || !embedding.model?.trim() || batchSize <= 0) return
    if (this.factBackfills.has(storyId)) return
    this.factBackfills.add(storyId)
    // This maintenance task deliberately stays out of the narrative serial queue:
    // it only fills an optional index column and must not delay a new user event.
    void this.backfillFactEmbeddings(storyId, batchSize)
      .catch(error => this.serviceLogger.debug('长期事实向量补齐跳过：%s', error))
      .finally(() => this.factBackfills.delete(storyId))
  }

  private async backfillFactEmbeddings(storyId: string, batchSize: number) {
    const facts = await this.ctx.database.get('interlude_fact', { storyId, status: 'active' })
    const missing = facts
      .filter(fact => !fact.embedding?.length)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, Math.max(0, batchSize))
    for (const fact of missing) {
      const embedding = await this.embedText(fact.content)
      if (embedding.length) await this.ctx.database.set('interlude_fact', { id: fact.id }, { embedding, updatedAt: new Date() })
    }
  }

  private async persistStatePatch(story: InterludeStory, draft: StatePatchDraft, entries: ScriptEntry[], now: Date) {
    const confidence = clampNumber(draft.confidence, 0, 0, 1)
    const participantId = resolveParticipantId(draft.participantId, draft.sourceEntryIds, entries)
    const sourceEntryIds = (draft.sourceEntryIds ?? []).filter(id => entries.some(entry => entry.id === id)).slice(0, 20)
    const proposal = await this.ctx.database.create('interlude_state_patch', {
      storyId: story.id, participantId, target: draft.target, path: clip(draft.path, 255), proposedValue: clip(draft.proposedValue, 4_000),
      evidence: clip(draft.evidence, 4_000), confidence, impact: draft.impact === 'major' ? 'major' : 'minor',
      status: 'proposed', sourceEntryIds, createdAt: now, appliedAt: null,
    })
    // 普通性格/关系变化需要多条证据；重大事件可以单条触发，但要求更高置信度。
    const impact = draft.impact === 'major' ? 'major' : 'minor'
    const minimum = impact === 'major' ? this.memoryConfig.majorStatePatchConfidenceThreshold : this.memoryConfig.statePatchConfidenceThreshold
    if (!this.memoryConfig.autoApplyStatePatches || (impact === 'major' && !this.memoryConfig.allowMajorStateChanges)) return
    if (confidence < minimum || (impact !== 'major' && sourceEntryIds.length < this.memoryConfig.statePatchMinEvidence)) return
    const overlay = { ...(story.state.settingOverlay ?? {}) }
    if (draft.target === 'character') {
      if (draft.path.includes('trait')) overlay.characterTraits = Array.from(new Set([...(overlay.characterTraits ?? []), clip(draft.proposedValue, 500)])).slice(-30)
      else overlay.characterProfile = mergeNote(overlay.characterProfile, draft.proposedValue)
    } else if (draft.target === 'relationship' && participantId) {
      const participant = await this.getParticipant(participantId)
      if (participant) {
        const state = normalizeParticipantState(participant.state)
        await this.ctx.database.set('interlude_participant', { id: participant.id }, {
          state: { ...state, relationshipOverlay: mergeNote(state.relationshipOverlay, draft.proposedValue) }, updatedAt: now,
        })
      }
    } else if (draft.target === 'relationship') overlay.relationship = mergeNote(overlay.relationship, draft.proposedValue)
    else overlay.world = mergeNote(overlay.world, draft.proposedValue)
    if (draft.target !== 'relationship' || !participantId) {
      const state = { ...story.state, settingOverlay: overlay }
      await this.ctx.database.set('interlude_story', { id: story.id }, { state, updatedAt: now })
    }
    if (proposal?.id) await this.ctx.database.set('interlude_state_patch', { id: proposal.id }, { status: 'applied', appliedAt: now })
  }

  private report(level: 'error' | 'warn' | 'info' | 'debug', story: InterludeStory, phase: NarrativeRequest['phase'], message: string, ...args: unknown[]) {
    const rank = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
    const logging = this.config.logging ?? { level: 'info' as const, format: 'detailed' as const, logScriptPreview: false, previewLength: 500 }
    if (rank[logging.level] < rank[level]) return
    const prefix = logging.format === 'compact'
      ? `阶段=${phaseLabel(phase)} | 故事=${story.id}`
      : `阶段：${phaseLabel(phase)}\n故事：${story.id}\n主角：${story.setting.character.name}`
    const output = logging.format === 'compact' ? `${prefix} | ${message}` : `${prefix}\n事件：${message}`
    if (level === 'error') this.serviceLogger.error(output, ...args as any[])
    else if (level === 'warn') this.serviceLogger.warn(output, ...args as any[])
    else if (level === 'info') this.serviceLogger.info(output, ...args as any[])
    else this.serviceLogger.debug(output, ...args as any[])
  }

  private reportStandalone(level: 'error' | 'warn' | 'info' | 'debug', message: string, ...args: unknown[]) {
    const rank = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
    const configuredLevel = this.config.logging?.level ?? 'info'
    if (rank[configuredLevel] < rank[level]) return
    const output = `生命周期：${message}`
    if (level === 'error') this.serviceLogger.error(output, ...args as any[])
    else if (level === 'warn') this.serviceLogger.warn(output, ...args as any[])
    else if (level === 'info') this.serviceLogger.info(output, ...args as any[])
    else this.serviceLogger.debug(output, ...args as any[])
  }

  private async getStory(id: string) {
    const story = (await this.ctx.database.get('interlude_story', { id }))[0]
    if (!story) throw new Error(`Interlude story not found: ${id}`)
    return story
  }

  private serial<T>(id: string, task: () => Promise<T>) {
    // catch 保证前一次失败不会永久堵住同一故事；finally 语义通过 then 的两个分支释放队列。
    const previous = this.queues.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    this.queues.set(id, current)
    void current.then(
      () => { if (this.queues.get(id) === current) this.queues.delete(id) },
      () => { if (this.queues.get(id) === current) this.queues.delete(id) },
    )
    return current
  }
}

function storyIdForCharacter(platform: string, selfId: string) { return `character:${platform}:${selfId}` }

function legacyStoryIdFor(platform: string, selfId: string, userId: string) { return `${platform}:${selfId}:${userId}` }

function participantIdFor(platform: string, selfId: string, userId: string) { return `${platform}:${selfId}:${userId}` }

function participantIdForStory(storyId: string, platform: string, selfId: string, userId: string) {
  return `${participantIdFor(platform, selfId, userId)}:${storyId}`.slice(0, 255)
}

function sameParticipantEndpoint(participant: InterludeParticipant, session: Session) {
  const onebotPair = isOneBotPlatform(participant.platform) && isOneBotPlatform(session.platform)
  return (participant.platform === session.platform || onebotPair)
    && normalizeAccountId(participant.selfId) === normalizeAccountId(session.selfId)
    && normalizeAccountId(participant.userId) === normalizeAccountId(session.userId)
}

function isOneBotPlatform(platform: string | undefined) {
  const value = String(platform ?? '').toLowerCase()
  return value === 'onebot'
    || value.startsWith('onebot:')
    || value === 'napcat'
    || value.startsWith('napcat:')
    || value === 'qq:onebot'
    || value.startsWith('qq:onebot:')
}

/** Normalize transport-qualified QQ ids such as private:123 or onebot:123. */
function normalizeAccountId(value: unknown) {
  let normalized = String(value ?? '').trim().toLowerCase()
  for (let index = 0; index < 3; index++) {
    const next = normalized.replace(/^(?:private|user|onebot|napcat|qq):/i, '').trim()
    if (next === normalized) break
    normalized = next
  }
  return normalized
}

function phaseLabel(phase: NarrativeRequest['phase']) {
  return ({
    'user-message': '用户消息',
    advance: '自动推进',
    'intent-due': '到期意图',
  } as Record<NarrativeRequest['phase'], string>)[phase] ?? phase
}

function isEnabledAccount(accounts: OneBotAccountRule[] | undefined, qq: string) {
  const normalized = normalizeAccountId(qq)
  if (!normalized) return false
  return (accounts ?? []).some(account => account.enabled !== false && normalizeAccountId(account.qq) === normalized)
}

function normalizeDecision(raw: NarrativeDecision, from: Date, now: Date, permitMessages: boolean, runtime: RuntimeConfig, shared: SharedStoryConfig, currentParticipantId: string, permittedParticipantIds: Set<string>) {
  const script = typeof raw?.script === 'string' ? raw.script.trim().slice(0, runtime.maxScriptCharacters) : ''
  const interaction = normalizeInteraction(raw?.interaction, now, runtime)
  const entries = Array.isArray(raw?.entries) ? raw.entries.filter(entry => validEntry(entry, from, now)) : []
  const memories = Array.isArray(raw?.memories) ? raw.memories.filter(validMemory).map(memory => ({ ...memory, participantId: permittedOrGlobal(memory.participantId, currentParticipantId, permittedParticipantIds) })) : []
  const intents = Array.isArray(raw?.intents) ? raw.intents.filter(intent => validIntent(intent, now)).map(intent => ({ ...intent, participantId: permittedOrGlobal(intent.participantId, currentParticipantId, permittedParticipantIds) })) : []
  const messages = permitMessages && Array.isArray(raw?.messages)
    ? raw.messages.map(message => normalizeMessage(message, runtime.maxMessageCharacters, currentParticipantId, permittedParticipantIds)).filter((message): message is OutgoingMessageDraft => !!message)
    : []
  const crossConversationActions = permitMessages && shared.allowCrossConversationMessages && Array.isArray(raw?.crossConversationActions)
    ? raw.crossConversationActions
      .map(action => normalizeConversationAction(action, runtime, permittedParticipantIds, currentParticipantId, now))
      .filter((action): action is NonNullable<ReturnType<typeof normalizeConversationAction>> => !!action)
      .slice(0, Math.max(0, shared.maxCrossConversationActions))
    : []
  const statePatch = isRecord(raw?.statePatch) ? pickParticipantStatePatch(raw.statePatch) : undefined
  return { script, interaction, entries, memories, intents, messages, statePatch, crossConversationActions }
}

function normalizeInteraction(value: unknown, now: Date, runtime: RuntimeConfig): NarrativeInteraction | undefined {
  if (!isRecord(value) || typeof value.seen !== 'boolean' || !isRecord(value.reply)) return undefined
  const mode = value.reply.mode
  if (mode !== 'none' && mode !== 'immediate' && mode !== 'delayed') return undefined
  const content = typeof value.reply.content === 'string' ? value.reply.content.trim().slice(0, runtime.maxMessageCharacters) : undefined
  const sendAt = toDate(value.reply.sendAt)

  if (!value.seen) return { seen: false, reply: { mode: 'none' } }
  if (mode === 'none') return { seen: true, reply: { mode: 'none' } }
  if (!content) return { seen: true, reply: { mode: 'none' } }
  if (mode === 'immediate') return { seen: true, reply: { mode, content } }
  const delay = sendAt?.getTime() - now.getTime()
  if (!sendAt || delay < runtime.minimumDelayedReplySeconds * 1_000 || delay > runtime.maximumDelayedReplyMinutes * Time.minute) return { seen: true, reply: { mode: 'none' } }
  return { seen: true, reply: { mode, content, sendAt: sendAt.toISOString() } }
}

function validEntry(value: unknown, from: Date, now: Date): value is ScriptEntryDraft {
  if (!isRecord(value) || typeof value.content !== 'string' || !value.content.trim()) return false
  const occurredAt = value.occurredAt === undefined ? now : toDate(value.occurredAt)
  return !!occurredAt && occurredAt >= from && occurredAt <= now
}

function validMemory(value: unknown): value is MemoryDraft {
  return isRecord(value) && typeof value.category === 'string' && typeof value.content === 'string' && !!value.content.trim()
}

function validIntent(value: unknown, now: Date): value is IntentDraft {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.summary !== 'string') return false
  const notBefore = toDate(value.notBefore)
  return !!notBefore && notBefore > now
}

function validMessage(value: unknown, maxLength: number): value is Partial<OutgoingMessageDraft> {
  return isRecord(value) && typeof value.content === 'string' && !!value.content.trim() && value.content.length <= maxLength
}

function normalizeMessage(value: unknown, maxLength: number, currentParticipantId: string, permittedParticipantIds: Set<string>) {
  if (!validMessage(value, maxLength)) return undefined
  const participantId = permittedOrGlobal(value.participantId, currentParticipantId, permittedParticipantIds)
  return participantId ? { participantId, content: value.content.trim().slice(0, maxLength) } : undefined
}

function normalizeConversationAction(value: unknown, runtime: RuntimeConfig, permittedParticipantIds: Set<string>, currentParticipantId: string, now = new Date()) {
  if (!isRecord(value) || typeof value.participantId !== 'string' || !value.participantId || value.participantId === currentParticipantId) return undefined
  if (!permittedParticipantIds.has(value.participantId) || (value.mode !== 'immediate' && value.mode !== 'delayed')) return undefined
  const content = typeof value.content === 'string' ? value.content.trim().slice(0, runtime.maxMessageCharacters) : ''
  if (!content) return undefined
  if (value.mode === 'immediate') return { participantId: value.participantId, mode: value.mode, content }
  const sendAt = toDate(value.sendAt)
  const delay = sendAt?.getTime() - now.getTime()
  if (!sendAt || delay < runtime.minimumDelayedReplySeconds * 1_000 || delay > runtime.maximumDelayedReplyMinutes * Time.minute) return undefined
  return { participantId: value.participantId, mode: value.mode, content, sendAt: sendAt.toISOString() }
}

function permittedOrGlobal(value: unknown, fallback: string, permittedParticipantIds: Set<string>) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (candidate && permittedParticipantIds.has(candidate)) return candidate
  return fallback && permittedParticipantIds.has(fallback) ? fallback : ''
}

function pickParticipantStatePatch(value: Record<string, unknown>): Partial<ParticipantState> {
  const patch: Partial<ParticipantState> = {}
  if (Array.isArray(value.openThreads) && value.openThreads.every(item => typeof item === 'string')) patch.openThreads = value.openThreads.map(item => clip(item, 500)).slice(0, 50)
  if (Array.isArray(value.relationshipNotes) && value.relationshipNotes.every(item => typeof item === 'string')) patch.relationshipNotes = value.relationshipNotes.map(item => clip(item, 500)).slice(0, 50)
  return patch
}

function mergeSetting(base: StorySetting, patch: Partial<StorySetting>): StorySetting {
  return { ...base, ...patch, character: { ...base.character, ...patch.character }, user: { ...base.user, ...patch.user } }
}

function mergeParticipantState(base: ParticipantState, patch: Partial<ParticipantState>): ParticipantState {
  return {
    ...base, ...patch,
    openThreads: Array.isArray(patch.openThreads) ? patch.openThreads : base.openThreads,
    relationshipNotes: Array.isArray(patch.relationshipNotes) ? patch.relationshipNotes : base.relationshipNotes,
  }
}

function normalizeParticipantState(value: unknown): ParticipantState {
  const record = isRecord(value) ? value : {}
  return {
    openThreads: Array.isArray(record.openThreads) ? record.openThreads.filter(item => typeof item === 'string').map(item => clip(item, 500)).slice(0, 50) : [],
    relationshipNotes: Array.isArray(record.relationshipNotes) ? record.relationshipNotes.filter(item => typeof item === 'string').map(item => clip(item, 500)).slice(0, 50) : [],
    relationshipOverlay: typeof record.relationshipOverlay === 'string' ? clip(record.relationshipOverlay, 4_000) : undefined,
    unreadMessageCount: Math.max(0, Math.floor(typeof record.unreadMessageCount === 'number' ? record.unreadMessageCount : 0)),
    pendingReplyCount: Math.max(0, Math.floor(typeof record.pendingReplyCount === 'number' ? record.pendingReplyCount : 0)),
    lastUserMessageAt: typeof record.lastUserMessageAt === 'string' ? record.lastUserMessageAt : undefined,
    lastCharacterMessageAt: typeof record.lastCharacterMessageAt === 'string' ? record.lastCharacterMessageAt : undefined,
  }
}

function normalizeStoryState(value: unknown): StoryState {
  const record = isRecord(value) ? value : {}
  const overlay = isRecord(record.settingOverlay) ? record.settingOverlay : {}
  const automation = isRecord(record.automation) ? record.automation : {}
  return {
    settingOverlay: {
      characterProfile: typeof overlay.characterProfile === 'string' ? overlay.characterProfile : undefined,
      relationship: typeof overlay.relationship === 'string' ? overlay.relationship : undefined,
      world: typeof overlay.world === 'string' ? overlay.world : undefined,
      supportingCast: typeof overlay.supportingCast === 'string' ? overlay.supportingCast : undefined,
      location: typeof overlay.location === 'string' ? overlay.location : undefined,
      characterTraits: Array.isArray(overlay.characterTraits) ? overlay.characterTraits.filter(item => typeof item === 'string') : [],
    },
    activeSceneId: typeof record.activeSceneId === 'number' ? record.activeSceneId : undefined,
    activeArcId: typeof record.activeArcId === 'number' ? record.activeArcId : undefined,
    automation: {
      quietUntil: typeof automation.quietUntil === 'string' ? automation.quietUntil : undefined,
      nextAdvanceAt: typeof automation.nextAdvanceAt === 'string' ? automation.nextAdvanceAt : undefined,
      lastAutoAdvanceAt: typeof automation.lastAutoAdvanceAt === 'string' ? automation.lastAutoAdvanceAt : undefined,
      lastUserMessageAt: typeof automation.lastUserMessageAt === 'string' ? automation.lastUserMessageAt : undefined,
    },
  }
}

function participantRelevance(participant: InterludeParticipant) {
  const state = normalizeParticipantState(participant.state)
  const pending = state.pendingReplyCount * 2 + state.unreadMessageCount
  const last = toDate(state.lastUserMessageAt)?.getTime() ?? participant.updatedAt.getTime()
  return pending * 1_000_000_000 + last
}

/** Keeps a single due-turn private to one relationship while ensuring that
 * every plan that was already due at the start of the sweep gets a chance to
 * be judged before the next sweep interval. */
function groupDueIntents(intents: NarrativeIntent[]) {
  const batches = new Map<string, NarrativeIntent[]>()
  for (const intent of [...intents].sort((left, right) => left.notBefore.getTime() - right.notBefore.getTime() || left.id - right.id)) {
    const key = intent.participantId || '__global__'
    const batch = batches.get(key) ?? []
    batch.push(intent)
    batches.set(key, batch)
  }
  return [...batches.values()]
}

function resolveParticipantId(explicit: string | undefined, sourceEntryIds: number[] | undefined, entries: ScriptEntry[]) {
  if (explicit?.trim()) return explicit.trim()
  const ids = (sourceEntryIds ?? []).map(id => entries.find(entry => entry.id === id)?.participantId).filter(Boolean)
  return ids[0] ?? ''
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

function toDate(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function clip(value: unknown, length: number) { return typeof value === 'string' ? value.trim().slice(0, length) : '' }

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function normalizeFact(value: string) { return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ') }

function limitEntriesByCharacters(entries: ScriptEntry[], limit: number) {
  if (limit <= 0) return []
  let used = 0
  const selected: ScriptEntry[] = []
  // 从最新条目向前保留，保证压缩请求优先看到场景接续点。
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (selected.length && used + entry.content.length > limit) break
    selected.unshift(entry)
    used += entry.content.length
  }
  return selected
}

function factScore(fact: NarrativeFact, config: MemoryConfig, queryEmbedding: number[] = []) {
  const ageDays = Math.max(0, (Date.now() - fact.lastSeenAt.getTime()) / (24 * Time.hour))
  const recency = Math.exp(-ageDays / 30)
  const similarity = cosineSimilarity(queryEmbedding, fact.embedding ?? [])
  // Negative similarity is treated as no semantic support. This prevents an
  // unrelated fact from receiving a half-score merely because cosine values
  // mathematically range from -1 to 1.
  const semantic = similarity == null ? 0 : Math.max(0, similarity)
  return fact.importance * config.factImportanceWeight
    + fact.confidence * config.factConfidenceWeight
    + recency * config.factRecencyWeight
    + semantic * config.semanticWeight
    + (fact.unresolved ? 1 : 0) * config.unresolvedWeight
}

function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return undefined
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    leftMagnitude += left[index] * left[index]
    rightMagnitude += right[index] * right[index]
  }
  if (!leftMagnitude || !rightMagnitude) return undefined
  return dot / Math.sqrt(leftMagnitude * rightMagnitude)
}

function createFactQuery(participant: InterludeParticipant | null, userMessage: string | undefined, dueIntents: NarrativeIntent[], supersededIntents: NarrativeIntent[]) {
  const state = participant ? normalizeParticipantState(participant.state) : undefined
  return [
    userMessage ? `Current user message: ${userMessage}` : '',
    ...(state?.openThreads ?? []).map(thread => `Open thread: ${thread}`),
    ...(state?.relationshipNotes ?? []).map(note => `Relationship note: ${note}`),
    ...dueIntents.map(intent => `Due intent: ${intent.summary}`),
    ...supersededIntents.map(intent => `Superseded plan: ${intent.summary}`),
  ].filter(Boolean).join('\n')
}

function automaticIntervalMinutes(story: InterludeStory, now: Date, config: AutoAdvanceConfig) {
  const restWindow = activeRestWindow(config.restWindows, story.setting.timezone, now)
  if (restWindow) return randomInteger(restWindow.minIntervalMinutes, restWindow.maxIntervalMinutes)
  return Math.max(1, config.intervalMinutes + randomInteger(-config.jitterMinutes, config.jitterMinutes))
}

function activeRestWindow(windows: RestWindow[], timezone: string, now: Date) {
  const localMinutes = localClockMinutes(now, timezone)
  return windows.find(window => {
    if (!window.enabled) return false
    const start = clockMinutes(window.start)
    const end = clockMinutes(window.end)
    if (start == null || end == null) return false
    return start <= end
      ? localMinutes >= start && localMinutes < end
      : localMinutes >= start || localMinutes < end
  })
}

function localClockMinutes(now: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
    const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0)
    const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0)
    return hour * 60 + minute
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes()
  }
}

function clockMinutes(value: string) {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value?.trim())
  if (!matched) return undefined
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : undefined
}

function randomInteger(min: number, max: number) {
  const lower = Math.floor(Math.min(min, max))
  const upper = Math.floor(Math.max(min, max))
  return lower + Math.floor(Math.random() * (upper - lower + 1))
}

function mergeNote(existing: string | undefined, next: string) {
  const value = clip(next, 2_000)
  if (!value) return existing
  if (!existing) return value
  if (normalizeFact(existing).includes(normalizeFact(value))) return existing
  return `${existing}\n${value}`.slice(-6_000)
}
