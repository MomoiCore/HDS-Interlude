import { Context, h, Logger, Service, Session, Time } from 'koishi'
import { registerTables } from './database'
import { readFile } from 'node:fs/promises'
import { createCompactor, createEmbedder, createNarrator, ModelConfig } from './narrator'
import {
  CompactionDecision, emptyStorySetting, emptyStoryState, IntentDraft, InterludeArc, InterludeScene,
  InterludeParticipant, InterludeStory, MemoryDraft, NarrativeDecision, NarrativeFact, NarrativeIntent,
  GroupContext, GroupGateDecision, GroupGateRequest, GroupMessageContext, NarrativeInteraction, NarrativeProvider, NarrativeRequest, NarrativeCompactor,
  NarrativeEmbedder, NarrativeFocus, OutgoingMessageDraft, ParticipantKnownFact, ParticipantState, RecentLifeFact, RecentLogicalTurn, RecentProactiveContact, SceneTrace, ScriptEntry, ScriptEntryDraft,
  ActiveSceneContext, ActiveSceneEntry, SceneEventResult, SceneStateDecision, SceneStateSnapshot,
  StatePatchDraft, StatePatchProposal, StoryHook, StoryHookPatch, StorySetting, StoryState,
  BrowserIntentDraft, NarrativeImage, OverlaySnapshot, WebObservation, emptyParticipantState,
} from './types'
import {
  activeRelationshipMoment, applyRelationshipMomentUpdate, followUpHasNewContactMove,
  normalizeRelationshipMomentUpdate, normalizeStoredRelationshipMoment,
} from './relationship'
import {
  narrativeWritingMode, pendingSplitMessageHeads, repeatedNarrativeMatch, repeatedReplyMatch, selectActiveScenePromptEntries,
} from './continuity'

// Only QQ/OneBot CDN hosts are fetched in the native-vision path. This keeps
// arbitrary user-provided URLs from becoming an internal-network fetch proxy.
function isTrustedImageHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  const allowed = ['gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'multimedia.nt.qq.com.cn', 'thirdqq.qlogo.cn', 'q.qlogo.cn']
  return allowed.some(domain => host === domain || host.endsWith(`.${domain}`))
}

export interface Config {
  model: ModelConfig
  runtime: RuntimeConfig
  storyDefaults: StoryDefaults
  logging: LoggingConfig
  memory?: MemoryConfig
  sharedStory?: SharedStoryConfig
  /** Optional, read-only browser observations powered by koishi-plugin-puppeteer. */
  browser?: BrowserConfig
  /** Optional OneBot/NapCat account gate. It only affects the onebot platform. */
  onebot?: OneBotNapCatConfig
}

type HookUpdateMode = NonNullable<NarrativeRequest['hookUpdate']>

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
  /** Explicit OneBot group allowlist. Group members do not need DM whitelist access. */
  groupChats?: GroupChatRule[]
  /** Prevent an echoed self-message from entering the narrative. */
  ignoreSelfMessages: boolean
}

export interface GroupChatRule {
  groupId: string
  label: string
  enabled: boolean
  purpose: string
  characterRole: string
  responseMode: 'mention-only' | 'selective' | 'active'
  contextLimit: number
  debounceSeconds: number
  cooldownSeconds: number
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
  /** Minimum independent narrative turns for a minor overlay change. */
  statePatchMinTurns?: number
  /** Minimum distinct calendar days represented by minor-patch evidence. */
  statePatchMinDays?: number
  /** Cooldown between stable overlay changes on the same target/path. */
  statePatchCooldownHours?: number
  autoApplyStatePatches: boolean
  allowMajorStateChanges: boolean
  maxFactsPerStory: number
  /** Keep short-lived dramatic aftereffects as context for later writing. */
  activeConsequencesEnabled: boolean
  /** Maximum active consequences carried into one main-narrative prompt. */
  activeConsequencePromptLimit: number
  /** Longest permitted lifetime of one consequence; protects canon from drift. */
  activeConsequenceMaxDays: number
  /** Used when the narrator omits a precise strength for a valid consequence. */
  activeConsequenceDefaultStrength: number
  /** One overwriteable short-term card connecting participant affect, the
   * protagonist's situation, and the next communication posture. */
  relationshipMomentEnabled?: boolean
  relationshipMomentDefaultHours?: number
  relationshipMomentMaxHours?: number
  overlayCompressionEnabled?: boolean
  overlayRecentDays?: number
  overlayMonthlyAfterDays?: number
  overlayWeeklyWindowDays?: number
  overlayMonthlyWindowDays?: number
  overlayWeeklySummaryCharacters?: number
  overlayMonthlySummaryCharacters?: number
  /** @deprecated Retained only to load old Console configurations. */
  storyHookRefreshAdvances?: number
  /** Apply a compact hook patch at the final configured conversation follow-up. */
  storyHookPatchAfterConversation?: boolean
  /** Idle time before the next ordinary advance performs a full hook rewrite. */
  storyHookFullRefreshIdleMinutes?: number
}

export interface RuntimeConfig {
  captureDirectMessages: boolean
  autoCreate: boolean
  ignoreCommandMessages: boolean
  allowProactiveMessages: boolean
  /** Minimum narrator-declared willingness for a background-initiated contact. */
  proactiveWillingnessThreshold?: number
  sweepIntervalMinutes: number
  minimumAdvanceMinutes: number
  maxStoriesPerSweep: number
  contextEntryLimit: number
  /** Maximum raw rows read from the current active scene. */
  activeSceneEntryLimit?: number
  /** Maximum recent authored script passages sent as literary continuity. */
  activeSceneNarrativeLimit?: number
  /** Character budget for verbatim current-scene prose and real messages. */
  activeSceneCharacterBudget?: number
  /** Character budget retained from the immediately preceding scene. */
  previousSceneTailCharacters?: number
  /** Shared character budget for recent Scene Trace cards and follow-up user events. */
  contextCharacterBudget?: number
  /** Number and character budget for factual, delivery-grounded logical turns. */
  interactionLedgerLimit?: number
  interactionLedgerCharacterBudget?: number
  /** Factual life bridge for the previous day; it excludes transcript wording. */
  recentLifeFactsEnabled?: boolean
  recentLifeFactHours?: number
  recentLifeFactLimit?: number
  recentLifeFactCharacterBudget?: number
  memoryLimit: number
  maxScriptCharacters: number
  maxMessageCharacters: number
  minimumDelayedReplySeconds: number
  maximumDelayedReplyMinutes: number
  cancelDelayedRepliesOnUserMessage: boolean
  /** Retry a user turn after a transient narrative-provider failure. */
  narrativeRetryDelaySeconds?: number
  /** Maximum automatic retries per failed user turn; 0 disables retry. */
  narrativeRetryMaxAttempts?: number
  /** Split model reply.content into multiple QQ messages at the configured separator. */
  splitReplyMessages?: boolean
  messageSeparator?: string
  typingBaseDelaySeconds?: number
  typingCharactersPerSecond?: number
  typingMaxDelaySeconds?: number
  /** Wait after the newest user message before starting a writing request. */
  userMessageDebounceSeconds?: number
  /** A new message inside this early request window supersedes that request. */
  staleNarrativeRequestWindowSeconds?: number
  /** 新版自动推进调度；旧版 minimumAdvanceMinutes 仍保留兼容。 */
  autoAdvanceEnabled?: boolean
  autoAdvanceIntervalMinutes?: number
  autoAdvanceJitterMinutes?: number
  /** Short life-writing passes after a conversation, in minutes. */
  conversationFollowUpMinutes?: number[]
  /** Small random offset applied to each short conversation follow-up. */
  conversationFollowUpJitterMinutes?: number
  pauseAfterConversationMinutes?: number
  restWindows?: RestWindow[]
}

export interface BrowserConfig {
  enabled: boolean
  /** Immediate browsing is opt-in because it intentionally adds one more model/browser round trip. */
  mode: 'deferred-only' | 'allow-immediate'
  allowSearch: boolean
  allowVisit: boolean
  searchUrlTemplate: string
  allowedDomains: string[]
  blockedDomains: string[]
  maxConcurrentPages: number
  /** Bound work per background sweep so a backlog cannot hold the story queue for minutes. */
  maxResearchPerSweep: number
  navigationTimeout: number
  waitUntil: 'domcontentloaded' | 'networkidle2'
  maxTextCharacters: number
  maxExcerptCharacters: number
  maxObservationsInPrompt: number
  cacheMinutes: number
  allowGroupTriggeredResearch: boolean
  logObservationPreview: boolean
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
  followUpMinutes: number[]
  followUpJitterMinutes: number
  pauseAfterConversationMinutes: number
  restWindows: RestWindow[]
}

interface BufferedUserMessage {
  content: string
  occurredAt: Date
  supersededIntents: NarrativeIntent[]
  /** Short-lived source links only; never written to HDSI storage. */
  imageSources: string[]
}

/** A per-relationship input buffer. Messages are durable immediately, while
 * the narrator waits briefly for the user to finish a short burst. */
interface BufferedNarrativeTurn {
  storyId: string
  participantId: string
  messages: BufferedUserMessage[]
  latestSession?: Session
  /** Context timers return a disposer rather than Node's native Timeout. */
  timer?: () => void
  nextRevision: number
  inFlightRequestId?: number
  inFlightStartedAt?: number
  inFlightAbortController?: AbortController
  obsoleteRequestIds: Set<number>
}

interface BufferedGroupTurn {
  storyId: string
  groupId: string
  rule: GroupChatRule
  channelId: string
  latestSession?: Session
  messages: GroupMessageContext[]
  timer?: () => void
  revision: number
}

interface DueIntentWake {
  cancel: () => void
  dueAt: number
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
  /** Controls how much normal operational activity is written at info level. */
  verbosity?: 'summary' | 'standard' | 'diagnostic'
  format: 'compact' | 'detailed'
  logScriptPreview: boolean
  /** Emit user-visible incoming/outgoing message bodies to the plugin log. */
  logMessageContent?: boolean
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
  private bufferedNarrativeTurns = new Map<string, BufferedNarrativeTurn>()
  private bufferedGroupTurns = new Map<string, BufferedGroupTurn>()
  /** Earliest wake-up for persisted typing segments; one timer per story. */
  private dueIntentWakeTimers = new Map<string, DueIntentWake>()
  /** Prevent a background life turn from racing an unlocked live model call. */
  private narratingStories = new Set<string>()
  private factBackfills = new Set<string>()
  /** Coalesce repeated post-turn compaction requests into one queued pass. */
  private scheduledCompactions = new Set<string>()
  /** sql.js/SQLite has one writable connection; serialize writes globally. */
  private databaseWriteQueue: Promise<unknown> = Promise.resolve()
  /** The browser is bounded separately from narrative work so a burst of
   * deferred intents cannot spawn an uncontrolled number of Chromium pages. */
  private browserActive = 0
  private browserWaiters: Array<() => void> = []
  /** Use Koishi's context-bound logger so Console/runtime targets receive records. */
  private readonly serviceLogger: Logger
  private backgroundStarted = false
  private databaseResetting = false
  private sweepRunning = false
  private compactionSweepRunning = false

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
    ctx.on('ready', () => this.reportStandaloneOperation('summary', 'info', '服务已就绪'))
    this.reportStandaloneOperation('summary', 'info', '服务初始化完成 模型模式=%s 共享主剧本=%s 自动推进=%s', config.model.mode, this.sharedStoryConfig.enabled, this.autoAdvanceConfig.enabled)
  }

  private startBackgroundTasks() {
    if (this.backgroundStarted) return
    this.backgroundStarted = true
    // Life advancement and memory compaction are both serialized per story.
    const sweepInterval = Math.max(1, this.config.runtime.sweepIntervalMinutes)
    this.ctx.setInterval(() => void this.sweep().catch(error => this.serviceLogger.warn('后台推进失败：%s', error)), sweepInterval * Time.minute)
    if (this.memoryConfig.enabled) this.ctx.setInterval(() => void this.compactStories().catch(error => this.serviceLogger.warn('后台记忆整理失败：%s', error)), Math.max(1, this.memoryConfig.backgroundIntervalMinutes) * Time.minute)
    this.reportStandaloneOperation('standard', 'info', '后台调度已启动 剧本扫描=%d分钟 记忆扫描=%d分钟', sweepInterval, this.memoryConfig.backgroundIntervalMinutes)
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

  /** Group access uses an explicit group allowlist; group members do not need
   * to be present in the private-message user whitelist. */
  canHandleGroupSession(session: Session): boolean {
    if (!isOneBotPlatform(session.platform)) return false
    const config = this.config.onebot
    if (!config?.enabled) return false
    const selfId = normalizeAccountId(session.selfId)
    const userId = normalizeAccountId(session.userId)
    if (config.ignoreSelfMessages && selfId && selfId === userId) return false
    if (!isEnabledAccount(config.botAccounts, selfId)) return false
    const group = this.groupRule(sessionGroupId(session))
    return !!group?.enabled
  }

  private groupRule(groupId: string) {
    const normalized = normalizeGroupId(groupId)
    return (this.config.onebot?.groupChats ?? []).find(group => group.enabled !== false && normalizeGroupId(group.groupId) === normalized)
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
      this.reportStandaloneOperation('diagnostic', 'debug', '私聊被 OneBot 白名单拦截 平台=%s 机器人ID=%s 用户ID=%s', session.platform, session.selfId, session.userId)
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
    if (this.sharedStoryConfig.enabled) {
      // Shared mode deliberately has one canonical active story in the whole
      // Koishi instance. Sandbox and OneBot must not run parallel lives.
      const existing = await this.getCanonicalStory(storyIdForCharacter(session.platform, session.selfId))
      if (existing) {
        const sharedId = storyIdForCharacter(session.platform, session.selfId)
        if (existing.platform === session.platform && existing.id !== sharedId) return this.migrateLegacyStory(existing, session)
        await this.migrateLegacyBranchIntoShared(existing, session)
        return existing
      }
    }
    const id = legacyStoryIdFor(session.platform, session.selfId, session.userId)
    const existing = (await this.dbGet('interlude_story', { id }))[0]
    if (existing || !this.sharedStoryConfig.enabled) return existing

    // Old beta versions used one story id per QQ. Migrate lazily when that QQ
    // first returns, so existing scripts become the first relationship branch
    // of the new shared story instead of silently disappearing.
    const legacyId = legacyStoryIdFor(session.platform, session.selfId, session.userId)
    const legacy = (await this.dbGet('interlude_story', { id: legacyId }))[0]
    return legacy ? this.migrateLegacyStory(legacy, session) : undefined
  }

  /**
   * Resolve and enforce the one global active story. The preferred id wins
   * when present; otherwise the most recently updated row is retained and
   * every other active row is archived immediately.
   */
  private async getCanonicalStory(preferredId?: string) {
    const active = await this.dbGet('interlude_story', { status: 'active' }, {
      sort: { updatedAt: 'desc' },
    })
    if (!active.length) return undefined
    const canonical = (preferredId && active.find(story => story.id === preferredId))
      ?? active.find(story => story.id.startsWith('character:'))
      ?? active[0]
    const now = new Date()
    for (const story of active) {
      if (story.id === canonical.id) continue
      await this.dbSet('interlude_story', { id: story.id }, { status: 'archived', updatedAt: now })
      this.reportStandalone('warn', '主剧本归档完成 原因=检测到多个活动故事 保留=%s 已归档=%s 范围=%s', canonical.id, story.id, '全局')
    }
    return canonical
  }

  async findParticipant(session: Session, story?: InterludeStory) {
    const resolved = story ?? await this.findStory(session)
    if (!resolved) return undefined
    // Participant ids from older betas were global to a bot/user pair.  Do
    // not trust that id alone: when shared mode is toggled or a legacy branch
    // is being migrated, the same pair can temporarily exist under another
    // story.  The story-bound lookup prevents accidentally moving or exposing
    // the wrong relationship branch.
    const rows = await this.dbGet('interlude_participant', { storyId: resolved.id })
    return rows.find(item => sameParticipantEndpoint(item, session))
  }

  async participants(storyId: string, includePaused = false) {
    const rows = await this.dbGet('interlude_participant', { storyId })
    return rows
      .filter(participant => includePaused || participant.status === 'active')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  async createStory(session: Session, name?: string) {
    if (!this.canHandleSession(session) && !this.canHandleGroupSession(session)) throw new Error('This session is not allowed to use HDS Interlude.')
    const existing = await this.findStory(session)
    if (existing) {
      if (session.isDirect) await this.ensureParticipant(existing, session)
      return existing
    }
    const now = new Date()
    const setting = this.initialStorySetting(name)
    const story: InterludeStory = {
      id: this.sharedStoryConfig.enabled
        ? storyIdForCharacter(session.platform, session.selfId)
        : legacyStoryIdFor(session.platform, session.selfId, session.userId),
      platform: session.platform, selfId: session.selfId, userId: '',
      channelId: '', status: 'active', setting, state: emptyStoryState(),
      cursorAt: now, createdAt: now, updatedAt: now,
    }
    try {
      await this.dbCreate('interlude_story', story)
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
    if (session.isDirect) await this.ensureParticipant(story, session, now)
    await this.appendEntry(story.id, {
      kind: 'setup', actor: 'system', content: `The story begins with ${setting.character.name}.`,
      occurredAt: now.toISOString(), metadata: {},
    }, now)
    await this.scheduleNextAutomaticAdvance(story.id, now)
    return story
  }

  /**
   * Enrolls a QQ account as a relationship branch and synchronizes its Console
   * identity fields. Callers that already resolved the participant can pass it
   * in to avoid a second database read.
   */
  async ensureParticipant(story: InterludeStory, session: Session, now = new Date(), knownExisting?: InterludeParticipant) {
    const account = this.userAccountRule(session.userId)
    const preset = this.participantPreset(session.userId)
    const existing = knownExisting ?? await this.findParticipant(session, story)
    if (existing) {
      // Console edits to the whitelist are intentional identity changes.
      // Keep relationship evolution in participant.state.relationshipOverlay;
      // only this base profile/relationship is refreshed here.
      const personId = account?.personId?.trim() || preset?.personId?.trim() || existing.personId || session.userId
      const displayName = account?.label?.trim() || preset?.label?.trim() || existing.displayName || session.username || session.userId
      const profile = account?.profile?.trim() || preset?.profile?.trim() || existing.profile || this.config.storyDefaults.userProfile
      const relationship = account?.relationship?.trim() || preset?.relationship?.trim() || existing.relationship || this.config.storyDefaults.relationship
      const changed = existing.storyId !== story.id
        || existing.channelId !== session.channelId
        || existing.personId !== personId
        || existing.displayName !== displayName
        || existing.profile !== profile
        || existing.relationship !== relationship
      if (changed) {
        await this.dbSet('interlude_participant', { id: existing.id }, {
          storyId: story.id, channelId: session.channelId, personId, displayName, profile, relationship, updatedAt: now,
        })
        this.reportOperation('diagnostic', 'debug', story, 'user-message', '参与者资料已从 Console 同步 参与者=%s', existing.id)
      }
      return {
        ...existing, storyId: story.id, channelId: session.channelId, personId, displayName, profile, relationship,
        updatedAt: changed ? now : existing.updatedAt,
      }
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
    await this.dbCreate('interlude_participant', participant)
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
    const state = { ...normalizeStoryState(story.state), storyHookDirty: true }
    await this.dbSet('interlude_story', { id: story.id }, { setting, state, updatedAt: now })
    return { ...story, setting, state, updatedAt: now }
  }

  async setStatus(story: InterludeStory, status: InterludeStory['status']) {
    const now = new Date()
    await this.dbSet('interlude_story', { id: story.id }, { status, updatedAt: now })
    return { ...story, status, updatedAt: now }
  }

  async recentEntries(storyId: string, limit = this.config.runtime.contextEntryLimit) {
    const bounded = Math.max(1, Math.min(limit, 600))
    const rows = await this.dbGet('interlude_script_entry', { storyId }, {
      limit: bounded,
      sort: { occurredAt: 'desc' },
    })
    return rows.reverse()
  }

  /**
   * Read only narrator script rows for the recent-life bridge.  This avoids
   * scanning every split chat bubble just to recover what happened last night.
   * The result is still transformed into short factual cards before it reaches
   * the model.
   */
  private async recentSceneTraceEntries(storyId: string, limit = 160) {
    const rows = await this.dbGet('interlude_script_entry', { storyId, kind: 'script' }, {
      limit: Math.max(24, Math.min(limit, 320)),
      sort: { occurredAt: 'desc' },
    }) as ScriptEntry[]
    return rows.reverse()
  }

  /** Inspect the same factual turn cards used by the live narrator.  This is
   * intentionally read-only and keeps raw script prose out of the result. */
  async recentLogicalTurns(storyId: string, participantId = '') {
    const limit = Math.max(12, Math.min(40, this.config.runtime.interactionLedgerLimit ?? 18))
    const entries = await this.recentEntries(storyId, Math.min(600, Math.max(200, limit * 10)))
    const visible = participantId
      ? entries.filter(entry => !entry.participantId || entry.participantId === participantId)
      : entries
    return collectRecentLogicalTurns(
      visible, participantId, limit,
      Math.max(2_400, Math.min(8_000, this.config.runtime.interactionLedgerCharacterBudget ?? 3_600)),
    )
  }

  /** Read-only diagnostic view of the exact short-term source sent to the
   * narrator. Content is already bounded by the active-scene Console limits. */
  async activeSceneSource(storyId: string, participantId = '') {
    const story = await this.getStory(storyId)
    const participant = participantId ? await this.getParticipant(participantId) : null
    return this.loadActiveSceneContext(story, await this.activeScene(storyId), participant ?? null, participant ? 'user-message' : 'advance', new Set())
  }

  /** Read-only inspection of the transcript-free daily life bridge. */
  async recentLifeFacts(storyId: string, participantId = '') {
    if (this.config.runtime.recentLifeFactsEnabled === false) return []
    const [story, entries] = await Promise.all([this.getStory(storyId), this.recentSceneTraceEntries(storyId, 160)])
    const visible = participantId
      ? entries.filter(entry => !entry.participantId || entry.participantId === participantId)
      : entries
    return collectRecentLifeFacts(
      visible,
      new Date(),
      Math.max(6, Math.min(168, this.config.runtime.recentLifeFactHours ?? 48)),
      Math.max(4, Math.min(60, this.config.runtime.recentLifeFactLimit ?? 24)),
      Math.max(600, Math.min(8_000, this.config.runtime.recentLifeFactCharacterBudget ?? 3_200)),
      story.setting.timezone,
      new Set(),
    )
  }

  async memories(storyId: string, limit = this.config.runtime.memoryLimit, participantId?: string) {
    const bounded = Math.max(1, Math.min(limit * 4, 500))
    const rows = await this.dbGet('interlude_memory', { storyId, status: 'active' }, {
      limit: bounded,
      sort: { importance: 'desc', updatedAt: 'desc' },
    })
    return rows
      .filter(memory => participantId === undefined || !memory.participantId || memory.participantId === participantId)
      .sort((a, b) => b.importance - a.importance || b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
  }

  /** Administrative view: includes global and participant-specific durable facts. */
  async adminFacts(storyId: string, limit = 20) {
    return this.ctx.database.get('interlude_fact', { storyId, status: 'active' }, {
      limit: Math.max(1, Math.min(limit, 100)),
      sort: { updatedAt: 'desc' },
    })
  }

  async adminPendingIntents(storyId: string, limit = 20) {
    return this.ctx.database.get('interlude_intent', { storyId, status: 'pending' }, {
      limit: Math.max(1, Math.min(limit, 100)),
      sort: { notBefore: 'asc' },
    })
  }

  async adminStatePatches(storyId: string, limit = 20) {
    return this.ctx.database.get('interlude_state_patch', { storyId }, {
      limit: Math.max(1, Math.min(limit, 100)),
      sort: { createdAt: 'desc' },
    })
  }

  /** Adds an audit-visible system note without pretending it came from the model. */
  async addAdminScriptNote(story: InterludeStory, content: string) {
    const text = clip(content, this.config.runtime.maxScriptCharacters)
    if (!text) return false
    const now = new Date()
    await this.appendEntry(story.id, {
      kind: 'admin-note', actor: 'system', content: `[管理员注记] ${text}`,
      occurredAt: now.toISOString(),
      metadata: {
        source: 'administrator',
        sceneTrace: { situation: '管理员补充了故事事实。', details: [text], unfinished: [] },
      },
    }, now)
    this.scheduleCompaction(story.id)
    return true
  }

  /** Adds a high-confidence fact for corrections that must survive compaction. */
  async addAdminFact(story: InterludeStory, scope: NarrativeFact['scope'], content: string) {
    const text = clip(content, this.memoryConfig.factContentCharacters)
    if (!text) return false
    const now = new Date()
    await this.dbCreate('interlude_fact', {
      storyId: story.id, participantId: '', scope, content: text,
      importance: 0.8, confidence: 1, unresolved: false, embedding: await this.embedText(text),
      status: 'active', sourceEntryIds: [], lastSeenAt: now, createdAt: now, updatedAt: now,
    })
    return true
  }

  /** Reversible deletion: facts are retained as superseded rows for audit. */
  async forgetAdminFact(storyId: string, id: number) {
    const fact = (await this.ctx.database.get('interlude_fact', { id, storyId, status: 'active' }))[0]
    if (!fact) return false
    await this.dbSet('interlude_fact', { id }, { status: 'superseded', updatedAt: new Date() })
    return true
  }

  async cancelAdminIntent(storyId: string, id: number) {
    const intent = (await this.ctx.database.get('interlude_intent', { id, storyId, status: 'pending' }))[0]
    if (!intent) return false
    await this.dbSet('interlude_intent', { id }, { status: 'cancelled', updatedAt: new Date() })
    return true
  }

  async rejectAdminStatePatch(storyId: string, id: number) {
    const patch = (await this.ctx.database.get('interlude_state_patch', { id, storyId, status: 'proposed' }))[0]
    if (!patch) return false
    await this.dbSet('interlude_state_patch', { id }, { status: 'rejected' })
    return true
  }

  /** Clear only the evolving setting overlay; keep Canon, script and memories. */
  async clearSettingOverlay(story: InterludeStory, target: 'character' | 'relationship' | 'world' | 'all') {
    this.invalidateBufferedNarratives(story.id)
    return this.serial(story.id, async () => this.clearSettingOverlayUnlocked(await this.getStory(story.id), target))
  }

  private async clearSettingOverlayUnlocked(story: InterludeStory, target: 'character' | 'relationship' | 'world' | 'all') {
    const now = new Date()
    const overlay = { ...(story.state.settingOverlay ?? {}) }
    if (target === 'character' || target === 'all') {
      delete overlay.characterProfile
      overlay.characterTraits = []
    }
    if (target === 'relationship' || target === 'all') delete overlay.relationship
    if (target === 'world' || target === 'all') delete overlay.world
    await this.dbSet('interlude_story', { id: story.id }, {
      state: { ...story.state, settingOverlay: overlay }, updatedAt: now,
    })

    let participantCount = 0
    if (target === 'relationship' || target === 'all') {
      const participants = await this.participants(story.id, true)
      for (const participant of participants) {
        const state = normalizeParticipantState(participant.state)
        if (!state.relationshipOverlay) continue
        participantCount++
        await this.dbSet('interlude_participant', { id: participant.id }, {
          state: { ...state, relationshipOverlay: undefined }, updatedAt: now,
        })
      }
    }

    // Preserve proposals for audit, but invalidate both active overlay rows and
    // pending candidates. Otherwise a candidate created before the clear could
    // be applied later and silently resurrect the old personality/relationship.
    const patches = await this.ctx.database.get('interlude_state_patch', { storyId: story.id })
    for (const patch of patches) {
      if (!['proposed', 'applied', 'compacted'].includes(patch.status) || (target !== 'all' && patch.target !== target)) continue
      await this.dbSet('interlude_state_patch', { id: patch.id }, { status: 'cleared' })
    }
    const snapshots = await this.dbGet('interlude_overlay_snapshot', { storyId: story.id, status: 'active' }) as OverlaySnapshot[]
    for (const snapshot of snapshots) {
      if (target !== 'all' && snapshot.target !== target) continue
      await this.dbSet('interlude_overlay_snapshot', { id: snapshot.id }, { status: 'superseded', updatedAt: now })
    }
    return { participantCount }
  }

  /**
   * Destructive administrative operation. The caller must validate the
   * confirmation phrase. A full purge also rebuilds Canon from the current
   * Console configuration, so an old profile cannot survive in later prompts.
   */
  async purgeAllStoryData(storyId: string) {
    this.invalidateBufferedNarratives(storyId)
    await this.purgeTable('interlude_script_entry', { storyId }, {
      kind: 'redacted', actor: 'system', content: '[管理员已删除剧本内容]', metadata: { redacted: true },
    })
    await this.purgeTable('interlude_memory', { storyId }, { status: 'deleted', content: '[管理员已删除记忆]' })
    await this.purgeTable('interlude_intent', { storyId }, { status: 'cancelled', summary: '[管理员已取消意图]' })
    await this.purgeTable('interlude_scene', { storyId }, { status: 'closed', hook: '', summary: '', entryCount: 0 })
    await this.purgeTable('interlude_arc', { storyId }, { status: 'closed', summary: '', sceneCount: 0 })
    await this.purgeTable('interlude_fact', { storyId }, { status: 'superseded', content: '[管理员已删除事实]' })
    await this.purgeTable('interlude_state_patch', { storyId }, { status: 'rejected', proposedValue: '[管理员已删除提案]', evidence: '' })
    await this.purgeTable('interlude_overlay_snapshot', { storyId }, { status: 'superseded', summary: '[管理员已删除 overlay 归档]', majorEvents: [], sourcePatchIds: [] })
    await this.purgeTable('interlude_web_observation', { storyId }, { status: 'deleted', url: '', title: '', excerpt: '', summary: '[管理员已删除网页观察]' })
    const now = new Date()
    const story = await this.getStory(storyId)
    const setting = this.initialStorySetting()
    await this.dbSet('interlude_story', { id: storyId }, {
      setting, state: emptyStoryState(), cursorAt: now, updatedAt: now,
    })
    await this.resetParticipantCanon(storyId, now)
    await this.ensureContinuity({ ...story, setting, state: emptyStoryState(), cursorAt: now }, now)
  }

  /** Reset all platforms, retaining exactly one empty global canonical story. */
  async purgeAllData(preferredStoryId?: string) {
    const all = await this.ctx.database.get('interlude_story', {}, { sort: { updatedAt: 'desc' } })
    const active = all.filter(story => story.status === 'active')
    if (!active.length) return undefined
    const canonical = (preferredStoryId && active.find(story => story.id === preferredStoryId)) ?? active[0]
    for (const story of all) await this.purgeAllStoryData(story.id)
    const now = new Date()
    for (const story of all) {
      if (story.id === canonical.id) continue
      await this.dbSet('interlude_story', { id: story.id }, { status: 'archived', updatedAt: now })
    }
    return canonical.id
  }

  /** Delete one adapter/platform's records without touching other platforms. */
  async purgePlatformData(platform: string) {
    const all = await this.ctx.database.get('interlude_story', {}, { sort: { updatedAt: 'desc' } })
    const targets = all.filter(story => samePlatformFamily(story.platform, platform))
    for (const story of targets) {
      await this.purgeAllStoryData(story.id)
      await this.dbSet('interlude_story', { id: story.id }, { status: 'archived', updatedAt: new Date() })
    }
    return targets.length
  }

  /**
   * Clear only HDSI-owned tables. Koishi's users/channels and other plugins
   * are intentionally untouched; deleting the physical SQLite file from a
   * command would be unsafe while the driver is open.
   */
  async clearDatabase() {
    if (this.databaseResetting) throw new Error('HDSI 数据库清空已经在进行中。')
    this.databaseResetting = true
    this.invalidateBufferedNarratives()
    try {
    const tables = [
      'interlude_script_entry', 'interlude_memory', 'interlude_intent',
      'interlude_scene', 'interlude_arc', 'interlude_fact', 'interlude_state_patch', 'interlude_overlay_snapshot', 'interlude_web_observation',
      'interlude_participant', 'interlude_story',
    ] as const
    let removed = 0
    let logicallyCleared = 0
    for (const table of tables) {
      const rows = await this.ctx.database.get(table, {})
      if (!rows.length) continue
      removed += rows.length
      try {
        await this.dbRemove(table, {})
      } catch (error) {
        // Preserve the established disk-I/O fallback: content is redacted and
        // stories are archived so a locked sql.js file cannot revive a story.
        this.serviceLogger.warn('SQLite 清空表失败，改用逻辑清空：表=%s 错误=%s', table, error)
        for (const row of rows) {
          const id = (row as any).id
          const fallback: any = table === 'interlude_story'
            ? { status: 'archived', setting: this.initialStorySetting(), state: emptyStoryState() }
            : table === 'interlude_participant'
              ? { status: 'paused', profile: '', relationship: '', state: emptyParticipantState() }
              : table === 'interlude_script_entry'
                ? { kind: 'redacted', actor: 'system', content: '[HDSI 数据库已清空]', metadata: { redacted: true } }
                : table === 'interlude_memory'
                  ? { status: 'deleted', content: '[HDSI 数据库已清空]' }
                  : table === 'interlude_intent'
                    ? { status: 'cancelled', summary: '[HDSI 数据库已清空]' }
                    : table === 'interlude_scene' || table === 'interlude_arc'
                      ? { status: 'closed', hook: '', summary: '', entryCount: 0, sceneCount: 0 }
                      : table === 'interlude_fact'
                        ? { status: 'superseded', content: '[HDSI 数据库已清空]' }
                        : table === 'interlude_web_observation'
                          ? { status: 'deleted', url: '', title: '', excerpt: '', summary: '[HDSI 数据库已清空]' }
                        : { status: 'rejected', proposedValue: '[HDSI 数据库已清空]', evidence: '' }
          await this.dbSet(table, { id }, fallback)
          logicallyCleared++
        }
      }
    }
    return { removed, logicallyCleared }
    } finally {
      this.databaseResetting = false
    }
  }

  /** Remove script and derived memory records whose timestamps overlap a range. */
  async purgeStoryRange(storyId: string, from: Date, to: Date) {
    this.invalidateBufferedNarratives(storyId)
    const inRange = (value: Date | null | undefined) => !!value && value >= from && value <= to
    const entries = await this.ctx.database.get('interlude_script_entry', { storyId })
    const entryIds = new Set(entries.filter(entry => inRange(entry.occurredAt)).map(entry => entry.id))
    for (const entry of entries) if (entryIds.has(entry.id)) await this.purgeTable('interlude_script_entry', { id: entry.id }, {
      kind: 'redacted', actor: 'system', content: '[管理员已删除剧本内容]', metadata: { redacted: true },
    })

    const memories = await this.ctx.database.get('interlude_memory', { storyId })
    for (const memory of memories) {
      if (inRange(memory.createdAt) || (memory.sourceEntryId != null && entryIds.has(memory.sourceEntryId))) {
        await this.purgeTable('interlude_memory', { id: memory.id }, { status: 'deleted', content: '[管理员已删除记忆]' })
      }
    }

    const facts = await this.ctx.database.get('interlude_fact', { storyId })
    for (const fact of facts) {
      const sourced = (fact.sourceEntryIds ?? []).some(id => entryIds.has(id))
      if (inRange(fact.createdAt) || inRange(fact.updatedAt) || inRange(fact.lastSeenAt) || sourced) {
        await this.purgeTable('interlude_fact', { id: fact.id }, { status: 'superseded', content: '[管理员已删除事实]' })
      }
    }

    const intents = await this.ctx.database.get('interlude_intent', { storyId })
    for (const intent of intents) {
      if (inRange(intent.createdAt) || inRange(intent.notBefore) || inRange(intent.updatedAt)) {
        await this.purgeTable('interlude_intent', { id: intent.id }, { status: 'cancelled', summary: '[管理员已取消意图]' })
      }
    }

    const scenes = await this.ctx.database.get('interlude_scene', { storyId })
    for (const scene of scenes) {
      const overlaps = scene.startedAt <= to && (!scene.endedAt || scene.endedAt >= from)
      if (overlaps) await this.purgeTable('interlude_scene', { id: scene.id }, { status: 'closed', hook: '', summary: '', entryCount: 0 })
    }
    const arcs = await this.ctx.database.get('interlude_arc', { storyId })
    for (const arc of arcs) if (inRange(arc.createdAt) || inRange(arc.updatedAt)) await this.purgeTable('interlude_arc', { id: arc.id }, { status: 'closed', summary: '', sceneCount: 0 })

    const patches = await this.ctx.database.get('interlude_state_patch', { storyId })
    for (const patch of patches) if (inRange(patch.createdAt) || inRange(patch.appliedAt)) await this.purgeTable('interlude_state_patch', { id: patch.id }, { status: 'rejected', proposedValue: '[管理员已删除提案]', evidence: '' })

    const observations = await this.ctx.database.get('interlude_web_observation', { storyId })
    for (const observation of observations) {
      if (inRange(observation.createdAt) || inRange(observation.accessedAt)) {
        await this.purgeTable('interlude_web_observation', { id: observation.id }, { status: 'deleted', url: '', title: '', excerpt: '', summary: '[管理员已删除网页观察]' })
      }
    }

    const story = await this.getStory(storyId)
    const state = normalizeStoryState(story.state)
    const now = new Date()
    const nextState: StoryState = {
      ...state, storyHook: undefined, storyHookEntryId: undefined,
      storyHookAdvanceCount: 0, storyHookDirty: false, lastStoryHookUpdateAt: undefined,
    }
    await this.dbSet('interlude_story', { id: storyId }, {
      state: nextState,
      updatedAt: now,
    })
    await this.ensureContinuity({ ...story, state: nextState }, now)
  }

  /** Entry point for configured OneBot group chats. Group members do not need
   * private-message authorization; the group allowlist controls access. */
  async receiveGroup(session: Session) {
    if (this.databaseResetting || !this.canHandleGroupSession(session)) return false
    const groupId = sessionGroupId(session)
    const rule = this.groupRule(groupId)
    if (!rule) return false
    if (rule.responseMode === 'mention-only' && !mentionsBot(session)) return false
    let story = await this.findStory(session)
    if (!story && this.config.runtime.autoCreate) story = await this.createStory(session)
    if (!story || story.status !== 'active') return false
    const now = new Date()
    const senderId = normalizeAccountId(session.userId)
    const senderName = this.groupSenderName(senderId, session)
    await this.serial(story.id, async () => {
      const current = await this.getStory(story!.id)
      await this.appendEntry(current.id, {
        kind: 'group-message', actor: 'user', content: session.content,
        occurredAt: now.toISOString(),
        metadata: { groupId, senderId, senderName, channelId: session.channelId },
      }, now)
      await this.pauseAutomaticAdvanceAfterUserMessage(current.id, now)
    })
    this.bufferGroupMessage(story, rule, session, { senderId, senderName, content: session.content, occurredAt: now, direction: 'user' })
    this.reportOperation('diagnostic', 'debug', story, 'user-message', '收到群消息 群=%s 发送者=%s', groupId, senderId)
    return true
  }

  async receive(session: Session) {
    if (this.databaseResetting) return false
    // Check before find/create so an unauthorized QQ can neither trigger the
    // model nor create a persistent story by merely sending a private message.
    if (!this.canHandleSession(session)) return false
    let story = await this.findStory(session)
    if (!story && this.config.runtime.autoCreate) story = await this.createStory(session)
    if (!story || story.status !== 'active') {
      this.reportStandaloneOperation('diagnostic', 'debug', '私聊未处理：故事不存在或已暂停 平台=%s 机器人ID=%s 用户ID=%s', session.platform, session.selfId, session.userId)
      return false
    }
    let participant = await this.findParticipant(session, story)
    if (participant) {
      // A whitelist row can be edited after this QQ first joined the shared
      // story. Refresh the current branch before composing its model context.
      // ensureParticipant performs no write when nothing actually changed.
      participant = await this.ensureParticipant(story, session, new Date(), participant)
    } else if (this.config.runtime.autoCreate || this.sharedStoryConfig.autoEnrollParticipants) {
      participant = await this.ensureParticipant(story, session)
    }
    if (!participant || participant.status !== 'active') {
      this.reportOperation('diagnostic', 'debug', story, 'user-message', '私聊未处理：参与者不存在或已暂停 用户ID=%s', session.userId)
      return false
    }
    this.reportOperation('diagnostic', 'debug', story, 'user-message', '收到参与者私聊消息 参与者=%s', participant.id)
    const visualInput = this.describeVisionEvent(session)
    if (this.config.logging?.logMessageContent) {
      this.reportOperation('diagnostic', 'info', story, 'user-message', '用户消息内容：%s', visualInput.content.slice(0, this.config.logging.previewLength))
    }

    const accepted = await this.serial(story.id, async () => {
      const current = await this.getStory(story.id)
      const currentParticipant = await this.getParticipant(participant!.id)
      if (!currentParticipant || currentParticipant.status !== 'active') return undefined
      const now = new Date()
      const incomingParticipant = await this.recordIncomingMessage(currentParticipant, now)
      const superseded = this.config.runtime.cancelDelayedRepliesOnUserMessage
        ? await this.cancelPendingOutgoingMessages(current.id, incomingParticipant.id, now)
        : []
      // A retry represents one interrupted foreground event. A newly arrived
      // message starts a fresh combined foreground turn, so keeping the old
      // retry would make the scheduler narrate the same source event twice.
      // This is deliberately independent from the optional delayed-reply
      // cancellation setting: retry lifecycle must never create a duplicate
      // response.
      await this.cancelNarrativeRetries(current.id, incomingParticipant.id, now, '收到新的用户消息')
      const incomingEntry = await this.appendEntry(current.id, {
        kind: 'user-message', actor: 'user', content: visualInput.content,
        occurredAt: now.toISOString(), metadata: { platform: session.platform, messageId: session.messageId, personId: incomingParticipant.personId },
      }, now, incomingParticipant.id)
      const currentState = normalizeStoryState(current.state)
      await this.dbSet('interlude_story', { id: current.id }, {
        state: {
          ...currentState,
          pendingSceneEventIds: Array.from(new Set([...(currentState.pendingSceneEventIds ?? []), `entry:${incomingEntry.id}`])).slice(-200),
        },
        updatedAt: now,
      })
      // Messages are persisted at arrival. The model request itself is
      // debounced below, so a burst can become one coherent writing turn.
      await this.pauseAutomaticAdvanceAfterUserMessage(current.id, now)
      return { story: current, participant: incomingParticipant, now, superseded }
    })
    if (!accepted) return false
    this.bufferUserNarrative(accepted.story, accepted.participant, session, accepted.now, accepted.superseded, visualInput.content, visualInput.sources)
    if (visualInput.sources.length) {
      this.reportOperation('standard', 'info', accepted.story, 'user-message', '当前事件包含图片附件 数量=%d 原生识图=%s', visualInput.sources.length, this.config.model.vision?.enabled ? '开启' : '关闭')
    }
    this.reportOperation('standard', 'info', accepted.story, 'user-message', '用户回合已入队 参与者=%s 已取消旧计划=%d', accepted.participant.id, accepted.superseded.length)
    return true
  }

  private groupSenderName(userId: string, session: Session) {
    const account = this.userAccountRule(userId)
    return account?.label?.trim() || session.username || userId
  }

  private bufferGroupMessage(story: InterludeStory, rule: GroupChatRule, session: Session, message: GroupMessageContext) {
    const key = `${story.id}:${normalizeGroupId(rule.groupId)}`
    const existing = this.bufferedGroupTurns.get(key)
    const turn: BufferedGroupTurn = existing ?? {
      storyId: story.id, groupId: normalizeGroupId(rule.groupId), rule,
      channelId: session.channelId, messages: [], revision: 0,
    }
    if (turn.timer) turn.timer()
    turn.channelId = session.channelId
    turn.latestSession = session
    turn.messages.push(message)
    const revision = ++turn.revision
    const delay = Math.max(0, rule.debounceSeconds ?? 1) * Time.second
    turn.timer = this.ctx.setTimeout(() => void this.flushGroupTurn(key, revision), delay)
    this.bufferedGroupTurns.set(key, turn)
  }

  private async flushGroupTurn(key: string, revision: number) {
    const turn = this.bufferedGroupTurns.get(key)
    if (!turn || turn.revision !== revision || this.databaseResetting) return
    if (this.narratingStories.has(turn.storyId)) {
      turn.timer = this.ctx.setTimeout(() => void this.flushGroupTurn(key, revision), 250)
      return
    }
    turn.timer = undefined
    const batch = turn.messages.splice(0)
    if (!batch.length) {
      this.bufferedGroupTurns.delete(key)
      return
    }
    let story: InterludeStory
    try {
      story = await this.getStory(turn.storyId)
    } catch (error) {
      this.serviceLogger.warn('群聊回合读取剧本失败，已放弃本批消息：%s', error)
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
      return
    }
    if (story.status !== 'active') {
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
      return
    }
    if (await this.groupCooldownActive(story.id, turn.groupId, turn.rule.cooldownSeconds)) {
      this.reportOperation('diagnostic', 'debug', story, 'user-message', '群聊仍在冷却期，跳过群发言判断 群=%s', turn.groupId)
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
      return
    }
    let gate: GroupGateDecision
    const gateStartedAt = Date.now()
    try {
      const contextMessages = await this.groupMessages(story.id, turn.groupId, turn.rule.contextLimit)
      const gateRequest: GroupGateRequest = {
        groupId: turn.groupId, label: turn.rule.label, purpose: turn.rule.purpose,
        characterRole: turn.rule.characterRole, responseMode: turn.rule.responseMode,
        messages: contextMessages, botUserId: story.selfId,
      }
      this.reportOperation('standard', 'info', story, 'user-message', '模型调用开始 任务=群聊判断 模型=%s 群=%s 上下文=%d', this.groupGateModelLabel(), turn.groupId, contextMessages.length)
      gate = this.narrator.gateGroup
        ? await this.narrator.gateGroup(gateRequest)
        : { shouldConsiderReply: false, score: 0, kind: 'unavailable', reason: 'group gate is unavailable', contextSummary: '' }
    } catch (error) {
      this.report('warn', story, 'user-message', '模型调用失败 任务=群聊判断 耗时=%dms 群=%s 错误=%s', Date.now() - gateStartedAt, turn.groupId, error)
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
      return
    }
    this.reportOperation('standard', 'info', story, 'user-message', '模型调用完成 任务=群聊判断 耗时=%dms 群=%s 分数=%s', Date.now() - gateStartedAt, turn.groupId, gate.score)
    if (!gate.shouldConsiderReply) {
      this.reportOperation('standard', 'info', story, 'user-message', '群聊判断完成 结果=跳过 群=%s 类型=%s 分数=%s', turn.groupId, gate.kind, gate.score)
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
      return
    }
    this.narratingStories.add(turn.storyId)
    try {
      this.reportOperation('standard', 'info', story, 'user-message', '群聊判断通过，即将进入主叙事 群=%s 类型=%s 分数=%s', turn.groupId, gate.kind, gate.score)
      const snapshot = await this.serial(story.id, async () => {
        const current = await this.getStory(story.id)
        const contextMessages = await this.groupMessages(current.id, turn.groupId, turn.rule.contextLimit)
        const now = new Date()
        return { story: current, from: narrativeCursor(current, now), now, contextMessages }
      })
      const groupContext: GroupContext = {
        groupId: turn.groupId, channelId: turn.channelId, label: turn.rule.label,
        purpose: turn.rule.purpose, characterRole: turn.rule.characterRole,
        // The buffered batch is supplied as currentEvent below. Keep only the
        // earlier group conversation here so the same messages are not
        // presented once as history and once as the present event.
        messages: snapshot.contextMessages.slice(0, Math.max(0, snapshot.contextMessages.length - batch.length)),
        gateKind: gate.kind, gateReason: gate.reason, gateSummary: gate.contextSummary, targetUserId: gate.targetUserId,
      }
      const userMessage = batch.map((message, index) => `[群聊连续消息 ${index + 1}，发送者 ${message.senderId}]\n${message.content}`).join('\n\n')
      const { decision, hookUpdate, succeeded, writingMode } = await this.tryDecide(snapshot.story, null, 'user-message', snapshot.from, snapshot.now, userMessage, [], [], groupContext)
      const result = await this.serial(story.id, async () => {
        if (this.databaseResetting || !succeeded) return { content: '', messages: [] as OutgoingMessageDraft[] }
        const current = await this.getStory(story.id)
        const messages = await this.persistDecision(current, null, decision, snapshot.from, snapshot.now, false, 'user-message', userMessage, hookUpdate, writingMode)
        const content = normalizeGroupReply(decision.groupReply, this.config.runtime.maxMessageCharacters)
        if (content) {
          await this.appendEntry(current.id, {
            kind: 'character-group-message', actor: 'character', content,
            occurredAt: snapshot.now.toISOString(),
            metadata: { groupId: turn.groupId, channelId: turn.channelId, gateKind: gate.kind },
          }, snapshot.now)
        }
        await this.dbSet('interlude_story', { id: current.id }, { cursorAt: snapshot.now, updatedAt: new Date() })
        if (succeeded) await this.scheduleConversationFollowUpsAfterTurn(current.id, snapshot.now, decision.interaction)
        return { content, messages }
      })
      if (result.content) await this.sendGroupMessage(snapshot.story, turn.channelId, result.content)
      this.scheduleCompaction(story.id)
    } catch (error) {
      this.report('warn', story, 'user-message', '群聊主叙事失败，保持静默 群=%s 错误=%s', turn.groupId, error)
    } finally {
      this.narratingStories.delete(turn.storyId)
      if (!turn.messages.length && !turn.timer) this.bufferedGroupTurns.delete(key)
    }
  }

  private async groupMessages(storyId: string, groupId: string, limit: number) {
    const rows = await this.ctx.database.get('interlude_script_entry', { storyId }, {
      limit: Math.max(20, Math.min(200, limit * 8)), sort: { occurredAt: 'desc' },
    })
    return rows
      .filter(entry => ['group-message', 'character-group-message'].includes(entry.kind) && normalizeGroupId(String(entry.metadata?.groupId ?? '')) === normalizeGroupId(groupId))
      .slice(0, Math.max(1, limit))
      .reverse()
      .map(entry => ({
        senderId: String(entry.metadata?.senderId ?? (entry.actor === 'character' ? 'character' : 'unknown')),
        senderName: String(entry.metadata?.senderName ?? (entry.actor === 'character' ? '主角' : entry.metadata?.senderId ?? '群成员')),
        content: entry.content, occurredAt: entry.occurredAt,
        direction: entry.actor === 'character' ? 'character' as const : 'user' as const,
      }))
  }

  private async groupCooldownActive(storyId: string, groupId: string, cooldownSeconds: number) {
    if (cooldownSeconds <= 0) return false
    const rows = await this.ctx.database.get('interlude_script_entry', { storyId, kind: 'character-group-message' }, {
      limit: 50, sort: { occurredAt: 'desc' },
    })
    const latest = rows.find(entry => normalizeGroupId(String(entry.metadata?.groupId ?? '')) === normalizeGroupId(groupId))
    return !!latest && Date.now() - latest.occurredAt.getTime() < cooldownSeconds * Time.second
  }

  private async sendGroupMessage(story: InterludeStory, channelId: string, content: string) {
    const bot = this.ctx.bots.find(item => String(item.selfId) === String(story.selfId)
      && (item.platform === story.platform || isOneBotPlatform(item.platform) && isOneBotPlatform(story.platform)))
    if (!bot) {
      this.report('warn', story, 'user-message', '没有可用机器人账号投递群消息 群频道=%s', channelId)
      return
    }
    for (const segment of this.splitOutgoingMessage(content)) {
      try { await bot.sendMessage(channelId, segment) }
      catch (error) { this.report('warn', story, 'user-message', '群消息投递失败 群频道=%s 错误=%s', channelId, error) }
    }
  }

  /**
   * Persisted messages wait here briefly before they reach the narrator. This
   * makes “你好 / 在吗 / 我有件事想问” one event without risking message loss.
   */
  private bufferUserNarrative(story: InterludeStory, participant: InterludeParticipant, session: Session, now: Date, supersededIntents: NarrativeIntent[], content = String(session.content ?? ''), imageSources: string[] = []) {
    const key = participant.id
    const existing = this.bufferedNarrativeTurns.get(key)
    const turn: BufferedNarrativeTurn = existing ?? {
      storyId: story.id, participantId: participant.id, messages: [], nextRevision: 0, obsoleteRequestIds: new Set(),
    }
    const requestStartedAt = turn.inFlightStartedAt ?? 0
    const staleWindow = Math.max(0, this.config.runtime.staleNarrativeRequestWindowSeconds ?? 5) * Time.second
    if (turn.inFlightRequestId && staleWindow > 0 && now.getTime() - requestStartedAt <= staleWindow) {
      turn.obsoleteRequestIds.add(turn.inFlightRequestId)
      turn.inFlightAbortController?.abort()
      this.reportOperation('standard', 'info', story, 'user-message', '连续消息使旧请求过期 参与者=%s 请求=%d', participant.id, turn.inFlightRequestId)
    }
    turn.messages.push({ content, occurredAt: now, supersededIntents, imageSources })
    turn.latestSession = session
    if (turn.timer) turn.timer()
    const revision = ++turn.nextRevision
    const delay = Math.max(0, this.config.runtime.userMessageDebounceSeconds ?? 2) * Time.second
    turn.timer = this.ctx.setTimeout(() => void this.flushBufferedNarrative(key, revision), delay)
    this.bufferedNarrativeTurns.set(key, turn)
    this.reportOperation('diagnostic', 'debug', story, 'user-message', '短时消息合并 参与者=%s 待处理=%d 等待=%dms', participant.id, turn.messages.length, delay)
  }

  /** Extract structured image segments without treating them as a second event. */
  private describeVisionEvent(session: Session) {
    const raw = String(session.content ?? '')
    const sources = extractSessionImageSources(session)
    const text = raw.replace(/<\/?(?:img|image)\b[^>]*>/gi, '').replace(/\[CQ:image,[^\]]*\]/gi, '').trim()
    // The attachment itself is passed through the native multimodal channel.
    // Keep ordinary text free of image placeholders: a failed/filtered fetch
    // must look like no visual input rather than an invitation to invent one.
    const content = text
    return { content, sources }
  }

  private async loadNativeImages(story: InterludeStory, sources: string[], session?: Session): Promise<NarrativeImage[]> {
    if (!this.config.model.vision?.enabled || !sources.length) return []
    const images = await Promise.all(sources.slice(0, 3).map(async (source, index) => {
      try {
        const image = await this.fetchNativeImage(source, (session as any)?.bot)
        return image ? { id: `turn-image-${index + 1}`, ...image } : undefined
      } catch (error) {
        this.reportStandalone('warn', '图片读取失败，已继续处理文字消息 错误=%s', error)
        return undefined
      }
    }))
    return images.filter((image): image is NarrativeImage => !!image)
  }

  private async fetchNativeImage(source: string, bot?: any, adapterProvided = false): Promise<{ mimeType: string, dataUri: string } | undefined> {
    const value = String(source ?? '').trim()
    if (value.startsWith('onebot-url:')) {
      const url = value.slice('onebot-url:'.length)
      return this.fetchNativeImage(url, bot, true)
    }
    if (value.startsWith('onebot-file:')) {
      const file = value.slice('onebot-file:'.length)
      if (!file || !bot?.getImage) return undefined
      const info = await bot.getImage(file)
      const candidates = [info?.url, info?.file, info?.path].map(item => String(item ?? '').trim()).filter(Boolean)
      for (const candidate of candidates) {
        if (/^https?:\/\//i.test(candidate)) {
          const image = await this.fetchNativeImage(candidate, undefined, true)
          if (image) return image
        } else {
          try {
            const bytes = await readFile(candidate)
            const image = await this.imageBytesToNative(bytes, guessImageMime(bytes, info?.type))
            if (image) return image
          } catch { /* adapter may return a non-local alias; try its next field */ }
        }
      }
      return undefined
    }
    if (/^data:image\//i.test(value)) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value)
      if (!match) return undefined
      const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) return undefined
      const mimeType = match[1].toLowerCase()
      return this.imageBytesToNative(bytes, mimeType)
    }
    let url: URL
    try { url = new URL(value) } catch { return undefined }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (!adapterProvided && !isTrustedImageHost(url.hostname)) return undefined
    const response = await this.ctx.http('GET', url.href, { responseType: 'arraybuffer', timeout: 10_000, redirect: 'error' })
    const bytes = Buffer.from(response.data)
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) return undefined
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || guessImageMime(bytes)
    return this.imageBytesToNative(bytes, mimeType)
  }

  /** Convert adapter/fetched bytes into one bounded native-vision attachment.
   * Animated stickers are rendered to a representative PNG frame when the
   * optional Puppeteer service is available; otherwise the original image is
   * still passed through rather than inventing a description. */
  private async imageBytesToNative(bytes: Buffer, mimeType: string): Promise<{ mimeType: string, dataUri: string } | undefined> {
    const normalized = String(mimeType || guessImageMime(bytes) || '').toLowerCase()
    if (!normalized.startsWith('image/')) return undefined
    const dataUri = `data:${normalized};base64,${bytes.toString('base64')}`
    if (isAnimatedImageMime(normalized)) {
      const frame = await this.renderAnimatedImageFrame(dataUri)
      if (frame) return frame
      this.reportStandalone('warn', '动态图片未能抽帧，已使用原始图片输入；请启用 Puppeteer 以提高识别兼容性。')
    }
    return { mimeType: normalized, dataUri }
  }

  private async renderAnimatedImageFrame(dataUri: string) {
    const puppeteer = (this.ctx as any).puppeteer
    if (!puppeteer?.page) return undefined
    return this.withBrowserSlot(async () => {
      let page: any
      try {
        page = await puppeteer.page()
        await page.setContent(`<img id="hdsi-image" src="${dataUri}" style="display:block;max-width:4096px;max-height:4096px">`, { waitUntil: 'load', timeout: 10_000 })
        await page.evaluate(() => new Promise<void>(resolve => {
          const image = document.querySelector('#hdsi-image') as HTMLImageElement | null
          if (!image || image.complete) return resolve()
          image.addEventListener('load', () => resolve(), { once: true })
          image.addEventListener('error', () => resolve(), { once: true })
        }))
        const element = await page.$('#hdsi-image')
        if (!element) return undefined
        const buffer = Buffer.from(await element.screenshot({ type: 'png' }))
        if (!buffer.length || buffer.length > 4 * 1024 * 1024) return undefined
        return { mimeType: 'image/png', dataUri: `data:image/png;base64,${buffer.toString('base64')}` }
      } catch (error) {
        this.reportStandalone('debug', '动态图片抽帧失败：%s', error)
        return undefined
      } finally {
        if (page) await page.close().catch(() => undefined)
      }
    })
  }

  /** Prevent timers or already-returning model calls from resurrecting data
   * after an administrator resets the story or clears HDSI tables. */
  private invalidateBufferedNarratives(storyId?: string) {
    for (const [key, turn] of this.bufferedNarrativeTurns) {
      if (storyId && turn.storyId !== storyId) continue
      if (turn.timer) turn.timer()
      turn.inFlightAbortController?.abort()
      if (turn.inFlightRequestId) turn.obsoleteRequestIds.add(turn.inFlightRequestId)
      this.bufferedNarrativeTurns.delete(key)
    }
    // Group turns have their own debounce timers. They must be cancelled by
    // the same reset/purge path, otherwise an old buffered group message can
    // write a fresh entry after the administrator has cleared the story.
    for (const [key, turn] of this.bufferedGroupTurns) {
      if (storyId && turn.storyId !== storyId) continue
      if (turn.timer) turn.timer()
      this.bufferedGroupTurns.delete(key)
    }
    for (const [key, wake] of this.dueIntentWakeTimers) {
      if (storyId && key !== storyId) continue
      wake.cancel()
      this.dueIntentWakeTimers.delete(key)
    }
  }

  /** True while a live or debounced conversation should take priority over background work. */
  private hasPendingNarrative(storyId: string) {
    if (this.narratingStories.has(storyId)) return true
    for (const turn of this.bufferedNarrativeTurns.values()) {
      if (turn.storyId === storyId && (turn.messages.length || turn.timer || turn.inFlightRequestId)) return true
    }
    for (const turn of this.bufferedGroupTurns.values()) {
      if (turn.storyId === storyId && (turn.messages.length || turn.timer)) return true
    }
    return false
  }

  private async flushBufferedNarrative(key: string, revision: number) {
    if (this.databaseResetting) return
    const turn = this.bufferedNarrativeTurns.get(key)
    if (!turn || turn.nextRevision !== revision) return
    // One shared story has one narrator at a time. If another relationship is
    // currently waiting on the provider, keep this batch intact and retry
    // shortly instead of taking an inconsistent cursor snapshot.
    if (this.narratingStories.has(turn.storyId)) {
      turn.timer = this.ctx.setTimeout(() => void this.flushBufferedNarrative(key, revision), 250)
      return
    }
    this.narratingStories.add(turn.storyId)
    turn.timer = undefined
    const batch = turn.messages.splice(0)
    if (!batch.length) {
      this.narratingStories.delete(turn.storyId)
      return
    }
    const requestId = revision
    turn.inFlightRequestId = requestId
    const abortController = new AbortController()
    turn.inFlightAbortController = abortController
    // Start the stale-request window before any image download. Image fetches
    // are part of this request; otherwise a slow CDN response leaves a gap in
    // which new messages cannot supersede the old turn.
    turn.inFlightStartedAt = Date.now()
    try {
      // Snapshot only the lightweight decision inputs under the story lock.
      // The network request stays outside it, so a new user message can be
      // recorded immediately and invalidate this request when appropriate.
      const snapshot = await this.serial(turn.storyId, async () => {
        const story = await this.getStory(turn.storyId)
        const participant = await this.getParticipant(turn.participantId)
        if (!participant || participant.status !== 'active' || story.status !== 'active') return undefined
        const now = new Date()
        const due = (await this.dueIntents(story.id, now))
          .filter(intent => !intent.participantId || intent.participantId === participant.id)
        return { story, participant, from: narrativeCursor(story, now), now, due }
      })
      if (!snapshot) return

      const userMessage = formatBufferedUserMessages(batch)
      const imageSources = Array.from(new Set(batch.flatMap(message => message.imageSources))).slice(0, 3)
      const images = await this.loadNativeImages(snapshot.story, imageSources, turn.latestSession)
      // If another message arrived while an image was being downloaded, put
      // this batch back and let the newer revision compose one combined event.
      if (turn.nextRevision !== revision) {
        turn.messages.unshift(...batch)
        return
      }
      const superseded = batch.flatMap(message => message.supersededIntents)
      const { decision, hookUpdate, succeeded, effectiveNow, immediateObservations, writingMode } = await this.tryDecide(
        snapshot.story, snapshot.participant, 'user-message', snapshot.from, snapshot.now, userMessage, snapshot.due, superseded, undefined, images,
        abortController.signal,
      )

      const result = await this.serial(turn.storyId, async () => {
        if (this.databaseResetting) return { obsolete: true, messages: [] as OutgoingMessageDraft[] }
        if (turn.obsoleteRequestIds.has(requestId)) return { obsolete: true, messages: [] as OutgoingMessageDraft[] }
        const current = await this.getStory(turn.storyId)
        const currentParticipant = await this.getParticipant(turn.participantId)
        if (!currentParticipant || currentParticipant.status !== 'active' || current.status !== 'active') {
          return { obsolete: true, messages: [] as OutgoingMessageDraft[] }
        }
        const now = new Date()
        // Persist a successful/failed immediate observation only after this
        // request has survived debounce invalidation. This keeps an obsolete
        // result from contaminating the next combined user turn.
        for (const observation of immediateObservations) await this.persistCollectedWebObservation(observation)
        const messages = await this.persistDecision(current, currentParticipant, decision, snapshot.from, effectiveNow, true, 'user-message', userMessage, hookUpdate, writingMode)
        if (succeeded) {
          await this.dbSet('interlude_story', { id: current.id }, { cursorAt: effectiveNow, updatedAt: now })
          if (snapshot.due.length) await this.dbSet('interlude_intent', { id: { $in: snapshot.due.map(intent => intent.id) } }, { status: 'completed', updatedAt: now })
          // A successful foreground turn has already incorporated every
          // message up to its cursor. Retire any older retry plans for this
          // relationship before their wake timer can start a duplicate turn.
          await this.cancelNarrativeRetries(current.id, currentParticipant.id, now, '新的写作回合已成功')
        } else {
          await this.scheduleNarrativeRetry(current.id, currentParticipant.id, now, 0, {
            from: snapshot.from,
            userMessage,
          })
        }
        if (succeeded) await this.scheduleConversationFollowUpsAfterTurn(current.id, effectiveNow, decision.interaction, currentParticipant.id)
        this.reportOperation('summary', 'info', current, 'user-message', '写作回合完成 参与者=%s 合并消息=%d 成功=%s 可见消息=%d', currentParticipant.id, batch.length, succeeded, messages.length)
        return { obsolete: false, messages }
      })

      if (result.obsolete) {
        this.reportOperation('standard', 'info', snapshot.story, 'user-message', '已丢弃过期主模型结果 参与者=%s 请求=%d', snapshot.participant.id, requestId)
        return
      }
      if (this.canHandleParticipant(snapshot.participant)) {
        await this.sendOutgoingMessages(snapshot.story, result.messages, snapshot.participant, turn.latestSession)
      }
      this.scheduleCompaction(turn.storyId)
    } catch (error) {
      this.reportStandalone('warn', '合并写作任务失败：参与者=%s 错误=%s', turn.participantId, error)
    } finally {
      if (turn.inFlightRequestId === requestId) {
        turn.inFlightRequestId = undefined
        turn.inFlightStartedAt = undefined
        turn.inFlightAbortController = undefined
        this.narratingStories.delete(turn.storyId)
      }
      turn.obsoleteRequestIds.delete(requestId)
      if (!turn.messages.length && !turn.timer && !turn.inFlightRequestId) this.bufferedNarrativeTurns.delete(key)
    }
  }

  async advanceStory(story: InterludeStory, force = true) {
    if (!this.canHandleStory(story)) return []
    const messages = await this.serial(story.id, async () => this.advanceUnlocked(await this.getStory(story.id), new Date(), force))
    if (force || messages.length) this.reportOperation('summary', 'info', story, 'advance', '剧本推进完成 可见消息=%d', messages.length)
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

  /** Merge and compress already-applied overlay patches without running the
   * full scene/fact compaction pass. This is safe for manual maintenance. */
  async compactOverlay(story: InterludeStory) {
    if (!this.canHandleStory(story)) return false
    return this.serial(story.id, async () => this.compactOverlayUnlocked(await this.getStory(story.id), new Date()))
  }

  /** Administrative overlay view used by the Console command. */
  async adminOverlayStatus(storyId: string) {
    const [story, patches, snapshots, participants] = await Promise.all([
      this.getStory(storyId),
      this.dbGet('interlude_state_patch', { storyId }, { sort: { createdAt: 'desc' } }) as Promise<StatePatchProposal[]>,
      this.dbGet('interlude_overlay_snapshot', { storyId, status: 'active' }, { sort: { periodEnd: 'desc' } }) as Promise<OverlaySnapshot[]>,
      this.participants(storyId, true),
    ])
    return {
      state: story.state.settingOverlay ?? {},
      proposed: patches.filter(patch => patch.status === 'proposed'),
      applied: patches.filter(patch => patch.status === 'applied' || patch.status === 'compacted'),
      cleared: patches.filter(patch => patch.status === 'cleared'),
      snapshots,
      participantOverlays: participants.filter(participant => !!normalizeParticipantState(participant.state).relationshipOverlay),
    }
  }

  async sweep() {
    if (this.databaseResetting || this.sweepRunning) return
    this.sweepRunning = true
    const startedAt = Date.now()
    try {
      const story = await this.getCanonicalStory()
      if (!story || !this.canHandleStory(story)) {
        this.reportStandaloneOperation('diagnostic', 'debug', '后台扫描跳过：没有可处理的活动主剧本')
        return
      }
      if (this.hasPendingNarrative(story.id)) {
        // A split-message is already a committed transport event. It may be
        // delivered while a newer narrative request is waiting, whereas a
        // fresh life-writing pass must still yield to that foreground turn.
        const pendingDue = await this.dueIntents(story.id, new Date())
        const deliveryOnly = pendingDue.length > 0 && pendingDue.every(intent => intent.type === 'split-message')
        if (!deliveryOnly) {
          this.reportOperation('diagnostic', 'debug', story, 'advance', '后台扫描跳过：前台消息回合或合并计时器仍在处理中')
          return
        }
        this.reportOperation('diagnostic', 'debug', story, 'advance', '前台回合处理中，先投递已确定的分段消息 数量=%d', pendingDue.length)
      }
      this.reportOperation('standard', 'info', story, 'advance', '后台扫描开始 游标=%s 下次自动推进=%s',
        formatLogTime(story.cursorAt, story.setting.timezone), formatLogTime(toDate(story.state.automation?.nextAdvanceAt), story.setting.timezone))
      const messages = await this.advanceStory(story, false)
      if (messages.length) await this.sendScheduledMessages(story, messages)
      this.reportOperation('standard', 'info', story, 'advance', '后台扫描完成 耗时=%dms 已投递=%d', Date.now() - startedAt, messages.length)
    } finally {
      this.sweepRunning = false
    }
  }

  private async advanceUnlocked(story: InterludeStory, now: Date, force: boolean) {
    const from = narrativeCursor(story, now)
    const elapsed = Math.max(0, now.getTime() - from.getTime())
    let due = await this.dueIntents(story.id, now)
    // Older plugin versions could leave a retry pending after a foreground
    // turn had already moved the story cursor. Never let that historical row
    // re-open a completed user event merely because its timer later fires.
    due = await this.discardObsoleteNarrativeRetries(story, due, now)
    const messages: OutgoingMessageDraft[] = []
    // Later <sep/> bubbles are delivery events, not new writing turns.  They
    // are persisted only at their actual send time, which also lets a newer
    // incoming message cancel them before the character "finishes typing".
    // Deliver at most one split segment per wake-up. If the scheduler was
    // blocked for a while, sending every overdue segment together would skip
    // the configured typing-time simulation.
    const splitSegments = due
      .filter(intent => intent.type === 'split-message')
      .sort((left, right) => left.notBefore.getTime() - right.notBefore.getTime())
      .slice(0, 1)
    for (const intent of splitSegments) {
      const content = clip(intent.payload?.content, this.config.runtime.maxMessageCharacters)
      const participant = intent.participantId ? await this.getParticipant(intent.participantId) : undefined
      if (!content || !participant || participant.status !== 'active') {
        await this.dbSet('interlude_intent', { id: intent.id }, { status: 'cancelled', updatedAt: now })
        continue
      }
      await this.dbSet('interlude_intent', { id: intent.id }, { status: 'completed', updatedAt: now })
      messages.push({
        participantId: participant.id, content,
        metadata: {
          visible: true, splitSegment: true,
          turnEntryId: Number(intent.payload?.turnEntryId) || undefined,
          turnPhase: intent.payload?.turnPhase,
        },
      })
      await this.restoreNextSplitDelay(story.id, intent, now)
    }
    if (splitSegments.length) await this.scheduleNextSplitWake(story.id)
    due = due.filter(intent => intent.type !== 'split-message')
    // Browser research is an external, already-happened observation once it
    // completes. It must never be handed to the narrator as an ordinary
    // future plan, otherwise the model could write as if it had read a page
    // before Puppeteer actually did so.
    // Keep a backlog of optional research from turning one background sweep
    // into several serial page loads. The remaining intents stay pending for
    // the next sweep and never block a live user turn for an unbounded time.
    const browserIntents = due
      .filter(intent => intent.type === 'browser-research')
      .slice(0, Math.max(1, this.browserConfig.maxResearchPerSweep))
    for (const intent of browserIntents) await this.executeDeferredBrowserIntent(story, intent, now)
    // Browser intents always complete (successfully or as a recorded failure)
    // in executeDeferredBrowserIntent(), so re-reading the whole pending list
    // here only adds a SQLite round trip to every background sweep.
    due = due.filter(intent => intent.type !== 'browser-research')
    // Turning off automatic advancement must suppress *every* background
    // writing path, including short plans that were persisted before the
    // owner disabled the feature. Manual `interlude.advance` still passes
    // `force` and remains available.
    const autoAdvanceEnabled = this.autoAdvanceConfig.enabled
    const dueFollowUps = autoAdvanceEnabled ? this.dueConversationFollowUps(story, now) : []
    const automaticDue = autoAdvanceEnabled && (dueFollowUps.length > 0 || this.isAutomaticAdvanceDue(story, now))
    const pausedForConversation = this.isAutomaticAdvancePaused(story, now)
    this.reportOperation('diagnostic', 'debug', story, 'advance',
      '后台状态 到期计划=%d 分段消息=%d 网页任务=%d 短期跟进=%d 自动推进到期=%s 对话暂停=%s',
      due.length, splitSegments.length, browserIntents.length, dueFollowUps.length, automaticDue, pausedForConversation)
    // A due typing segment can be delivered during the conversation pause;
    // it is already a committed message, not an automatic life update.
    if (!force && !due.length && (!automaticDue || pausedForConversation)) return messages

    // A manual advance may be queued behind a background pass. Do not open a
    // second narrator turn merely for a few seconds of empty time.
    const minimumManualAdvanceMs = Math.max(1, this.config.runtime.minimumAdvanceMinutes) * Time.minute
    const manualAdvanceTooSoon = force
      && !due.length
      && !dueFollowUps.length
      && elapsed < minimumManualAdvanceMs
    if (manualAdvanceTooSoon) {
      this.reportOperation('standard', 'info', story, 'advance',
        '手动推进跳过：游标距离现在不足 %d 分钟，且没有到期计划或对话后续任务', this.config.runtime.minimumAdvanceMinutes)
      return messages
    }

    let advanced = false
    let delayedReplyProcessed = false
    // A due plan is itself a complete writing turn: it fills the old cursor→now
    // gap and then decides the plan. Avoid a preceding ordinary advance, which
    // would make the next request write the same now→now moment again.
    const hasNarrativeDue = due.length > 0
    if (elapsed > 0 && !hasNarrativeDue && (force || (automaticDue && !pausedForConversation))) {
      const followUpParticipantId = dueFollowUps.length ? story.state.automation?.conversationFollowUpParticipantId : ''
      const followUpParticipant = followUpParticipantId ? await this.getParticipant(followUpParticipantId) : undefined
      const phase: NarrativeRequest['phase'] = followUpParticipant?.status === 'active'
        ? 'conversation-follow-up'
        : 'advance'
      this.reportOperation('standard', 'info', story, phase,
        '即将执行自动写作 类型=%s 时间段=%s→%s', phaseLabel(phase), formatLogTime(from, story.setting.timezone), formatLogTime(now, story.setting.timezone))
      const { decision, hookUpdate, succeeded, writingMode } = await this.tryDecide(story, followUpParticipant ?? null, phase, from, now, undefined, [])
      if (succeeded) {
        const permitMessages = phase === 'conversation-follow-up' || this.config.runtime.allowProactiveMessages
        messages.push(...await this.persistDecision(story, followUpParticipant ?? null, decision, from, now, permitMessages, phase, '', hookUpdate, writingMode))
        await this.dbSet('interlude_story', { id: story.id }, { cursorAt: now, updatedAt: now })
        advanced = true
      }
    }

    const dueBatches = groupDueIntents(due)
    // One shared story has one clock. Process one relationship branch per
    // sweep so another branch cannot trigger a duplicate now→now scene.
    const dueBatch = dueBatches[0]
    if (dueBatch) {
      const current = await this.getStory(story.id)
      // 如果本轮没有先做 automatic advance，到期意图也必须从故事游标
      // 补写到现在；否则“延迟回复到点”会漏掉中间这段角色生活。
      const dueFrom = narrativeCursor(current, now)
      // Each batch is one relationship branch. This keeps prompts private
      // while still draining every plan that was already due this sweep.
      const dueParticipantId = dueBatch[0]?.participantId || ''
      const dueParticipant = dueParticipantId ? await this.getParticipant(dueParticipantId) : undefined
      const retryIntent = dueBatch.find(intent => intent.type === 'narrative-retry')
      const retryMessage = retryIntent ? clip(retryIntent.payload?.userMessage, this.config.runtime.maxMessageCharacters * 8) : ''
      const retryPhase: NarrativeRequest['phase'] = retryIntent && retryMessage ? 'user-message' : 'intent-due'
      const retryFrom = retryIntent && retryMessage ? (toDate(retryIntent.payload?.from) ?? dueFrom) : dueFrom
      this.reportOperation('standard', 'info', current, retryPhase,
        '即将处理到期计划 数量=%d 类型=%s 参与者=%s', dueBatch.length, Array.from(new Set(dueBatch.map(intent => intent.type))).join(','), dueParticipant?.id || '全局')
      const { decision, hookUpdate, succeeded, writingMode } = await this.tryDecide(
        current, dueParticipant ?? null, retryPhase, retryFrom, now,
        retryMessage || undefined, dueBatch,
      )
      const permitMessages = this.config.runtime.allowProactiveMessages || dueBatch.some(intent => intent.payload?.userInitiated === true)
      messages.push(...await this.persistDecision(
        current, dueParticipant ?? null, decision, retryFrom, now, permitMessages,
        retryPhase, retryMessage, hookUpdate, writingMode,
      ))
      if (succeeded) {
        await this.dbSet('interlude_story', { id: current.id }, { cursorAt: now, updatedAt: now })
        await this.dbSet('interlude_intent', { id: { $in: dueBatch.map(intent => intent.id) } }, { status: 'completed', updatedAt: now })
        if (dueParticipant) await this.cancelNarrativeRetries(current.id, dueParticipant.id, now, '到期写作已成功', dueBatch.map(intent => intent.id))
        if (dueBatch.some(intent => intent.type === 'delayed-reply')) {
          delayedReplyProcessed = true
          await this.pauseAutomaticAdvanceAfterDelayedReply(story.id, now, dueParticipant?.id ?? '')
        } else if (!advanced && !delayedReplyProcessed) {
          await this.scheduleNextAutomaticAdvance(story.id, now)
        }
        if (retryPhase === 'user-message' && dueParticipant) {
          await this.scheduleConversationFollowUpsAfterTurn(current.id, now, decision.interaction, dueParticipant.id)
        }
      } else {
        // A failed user turn gets a persisted retry. Otherwise a transient
        // 403/5xx would leave its already-recorded incoming message waiting
        // forever for somebody to send another DM.
        const retries = dueBatch.filter(intent => intent.type === 'narrative-retry')
        if (retries.length) {
          const attempts = Math.max(...retries.map(intent => Number(intent.payload?.attempt) || 0))
          await this.dbSet('interlude_intent', { id: { $in: retries.map(intent => intent.id) } }, { status: 'cancelled', updatedAt: now })
          const original = retries[0]
          await this.scheduleNarrativeRetry(current.id, dueParticipant?.id ?? '', now, attempts, {
            from: toDate(original?.payload?.from) ?? retryFrom,
            userMessage: clip(original?.payload?.userMessage, this.config.runtime.maxMessageCharacters * 8) || retryMessage,
          })
        }
        // Keep ordinary delayed plans pending until the provider recovers.
      }
    }
    if (dueBatches.length > 1) {
      const current = await this.getStory(story.id)
      this.reportOperation('standard', 'info', current, 'intent-due',
        '其余 %d 组到期计划已保留，下一次扫描将按新的时间段继续处理', dueBatches.length - 1)
      this.scheduleDueIntentWake(story.id, new Date(now.getTime() + Math.max(Time.second, this.config.runtime.sweepIntervalMinutes * Time.minute)))
    }
    if (advanced && !delayedReplyProcessed) {
      const hasMoreFollowUps = dueFollowUps.length > 0 && await this.completeConversationFollowUps(story.id, dueFollowUps, now)
      if (!hasMoreFollowUps) await this.scheduleNextAutomaticAdvance(story.id, now)
    }
    return messages
  }

  private async decide(story: InterludeStory, participant: InterludeParticipant | null, phase: NarrativeRequest['phase'], from: Date, now: Date, userMessage: string | undefined, dueIntents: NarrativeIntent[], supersededIntents: NarrativeIntent[] = [], groupContext?: GroupContext, images: NarrativeImage[] = [], extraWebContext: WebObservation[] = [], abortSignal?: AbortSignal) {
    // 这里是主模型上下文的唯一入口。短期连续性由近期剧本原文、事实型
    // 逻辑轨迹和当前真实事件共同组成；Hook 与事实负责更早的历史。
    // User and due-intent turns may arrive before the next background sweep.
    // Retire expired consequences here too, while keeping this a cheap local
    // database operation rather than a separate model request.
    // Expired consequences are already excluded by activeConsequences().
    // Retire their rows during unattended work so a live message does not pay
    // for a second scan and possible SQLite write before its model request.
    if (phase !== 'user-message') await this.expireActiveConsequences(story.id, now)
    const storyState = normalizeStoryState(story.state)
    const contextEntryLimit = Math.max(1, this.config.runtime.contextEntryLimit)
    // A logical turn normally has a user row, a script row, and one or more
    // delivered bubbles. Scan enough transport rows to retain several whole
    // turns instead of merely the latest few message fragments.
    // Transport-heavy turns can contain several <sep/> rows. Scan enough rows
    // to recover the configured number of complete narrator turns rather than
    // letting chat bubbles silently shrink the continuity horizon.
    const logicalTurnLimit = Math.max(12, Math.min(40, this.config.runtime.interactionLedgerLimit ?? 18))
    const contextScanLimit = Math.min(600, Math.max(200, contextEntryLimit * 5, logicalTurnLimit * 10))
    const contextCharacterBudget = Math.max(1_000, this.config.runtime.contextCharacterBudget ?? 6_000)
    const recentLifeFactsEnabled = this.config.runtime.recentLifeFactsEnabled !== false
    const recentLifeFactHours = Math.max(6, Math.min(168, this.config.runtime.recentLifeFactHours ?? 48))
    const recentLifeFactLimit = Math.max(4, Math.min(60, this.config.runtime.recentLifeFactLimit ?? 24))
    const recentLifeFactCharacterBudget = Math.max(600, Math.min(8_000, this.config.runtime.recentLifeFactCharacterBudget ?? 3_200))
    const factQuery = createFactQuery(participant, userMessage, dueIntents, supersededIntents)
    const [recentEntries, memories, scene, arc, facts, allParticipants, webContext, activeConsequences, overlaySnapshots, recentSceneEntries] = await Promise.all([
      // Scan more rows than will be sent: most rows are transport/audit data,
      // while only compact Scene Trace metadata enters the model prompt.
      this.recentEntries(story.id, contextScanLimit),
      this.memories(story.id, this.config.runtime.memoryLimit, participant?.id),
      this.activeScene(story.id),
      storyState.storyHook ? Promise.resolve(undefined) : this.activeArc(story.id),
      this.facts(story.id, this.config.runtime.memoryLimit, factQuery, participant?.id),
      this.participants(story.id),
      this.webObservations(story.id, participant?.id),
      this.activeConsequences(
        story.id,
        now,
        phase === 'advance' || this.sharedStoryConfig.shareParticipantDetails ? undefined : participant?.id,
      ),
      this.overlaySnapshotsForPrompt(story.id, participant?.id, phase === 'advance'),
      recentLifeFactsEnabled ? this.recentSceneTraceEntries(story.id, 160) : Promise.resolve([] as ScriptEntry[]),
    ])
    const visibleEntries = phase === 'advance' || this.sharedStoryConfig.shareParticipantDetails
      ? recentEntries
      : recentEntries.filter(entry => {
        // Group transcripts are part of the shared life, but do not expose
        // their raw text to a private relationship unless the owner opts in.
        if (!groupContext && (entry.kind === 'group-message' || entry.kind === 'character-group-message')) return false
        return !entry.participantId || entry.participantId === participant?.id
      })
    // A complete logical turn carries the scene state, all source messages
    // from one user batch, and only character bubbles that were actually
    // delivered. This replaces separate Scene Trace, raw follow-up messages,
    // and the old per-bubble interaction ledger.
    const compatibilityLogicalTurns = collectRecentLogicalTurns(
      visibleEntries, participant?.id ?? '',
      logicalTurnLimit,
      Math.max(2_400, Math.min(8_000, this.config.runtime.interactionLedgerCharacterBudget ?? 3_600)),
    )
    const recentProactiveContacts = collectRecentProactiveContacts(
      visibleEntries, participant?.id ?? '', now,
    )
    // Logical cards preserve the immediate exchange. The separate life bridge
    // reaches further back through compact scene facts, so references such as
    // “last night” retain concrete actions without restoring old prose or
    // crowding the request with every short message bubble.
    const visibleSceneEntries = phase === 'advance' || this.sharedStoryConfig.shareParticipantDetails
      ? recentSceneEntries
      : recentSceneEntries.filter(entry => !entry.participantId || entry.participantId === participant?.id)
    // This small evidence ledger contains only observed inbound messages.
    // Profile/relationship baselines live in currentParticipant and durable
    // facts live in the unified continuityFacts payload, avoiding three
    // copies of the same information in one narrator request.
    const participantKnownFacts = collectParticipantKnownFacts(
      phase, participant, visibleEntries, from, now,
      Math.min(16, Math.max(6, contextEntryLimit)), Math.floor(contextCharacterBudget / 3),
    )
    const currentEventIds = new Set(participantKnownFacts
      .filter(fact => fact.source === 'current-event')
      .map(fact => fact.id))
    const activeScene = await this.loadActiveSceneContext(story, scene ?? null, participant, phase, currentEventIds, recentEntries)
    // Raw prose preserves literary continuity, while the compact logical
    // turns preserve the trajectory and settled exchange meaning. They are
    // complementary: disabling the cards as soon as a small scene exists
    // creates a context cliff and lets the newest paragraph dominate.
    const recentLogicalTurns = compatibilityLogicalTurns
    const activeSceneScriptIds = new Set<number>([
      ...(activeScene?.entries ?? []), ...(activeScene?.previousSceneTail ?? []),
    ].filter(entry => entry.type === 'script').map(entry => Number(entry.id.replace(/^entry:/, ''))).filter(Number.isFinite))
    const recentLifeFacts = recentLifeFactsEnabled
      ? collectRecentLifeFacts(
        visibleSceneEntries,
        now,
        recentLifeFactHours,
        recentLifeFactLimit,
        recentLifeFactCharacterBudget,
        story.setting.timezone,
        new Set([...recentLogicalTurns.map(turn => turn.entryId), ...activeSceneScriptIds]),
      )
      : []
    const bootstrapContext = !storyState.storyHook
      ? {
          scene: scene ?? null,
          arc: arc ?? null,
          // Old installations have no Scene Trace metadata yet. One bounded
          // excerpt lets the first idle refresh build a hook; it disappears
          // from every later request once that hook exists.
          recentExcerpt: phase === 'advance' && !recentLogicalTurns.length
            ? latestNarrativeExcerpt(visibleEntries, Math.min(2_500, contextCharacterBudget))
            : undefined,
        }
      : undefined
    const participants = allParticipants
      .filter(item => item.id !== participant?.id && this.canHandleParticipant(item))
      .sort((left, right) => participantRelevance(right) - participantRelevance(left))
      .slice(0, this.sharedStoryConfig.participantContextLimit)
      .map(item => {
        const state = normalizeParticipantState(item.state)
        return {
          ...item,
          state: {
            ...state,
            relationshipMoment: this.memoryConfig.relationshipMomentEnabled === false
              ? undefined
              : activeRelationshipMoment(state.relationshipMoment, now),
          },
        }
      })
    const visibleDueIntents = this.sharedStoryConfig.shareParticipantDetails
      ? dueIntents.filter(intent => intent.type !== 'narrative-retry')
      : dueIntents.filter(intent => intent.type !== 'narrative-retry'
        && (!intent.participantId || intent.participantId === participant?.id))
    // A relationship consequence belongs to the protagonist's actual life.
    // Background writing therefore sees its compact effect even when raw
    // cross-participant chat history remains private. Live turns still see
    // only their own (and global) consequences unless sharing is enabled.
    const visibleConsequences = phase === 'advance' || this.sharedStoryConfig.shareParticipantDetails
      ? activeConsequences
      : activeConsequences.filter(intent => !intent.participantId || intent.participantId === participant?.id)
    const mergedWebContext = [...webContext, ...extraWebContext]
      .filter(observation => observation.status !== 'deleted')
      .sort((left, right) => left.accessedAt.getTime() - right.accessedAt.getTime())
      .slice(-Math.max(1, this.browserConfig.maxObservationsInPrompt))
    const hookUpdate = this.hookUpdateMode(story, phase, now)
    const writingMode = narrativeWritingMode(phase, from, now, !!activeScene?.entries.length)
    const promptParticipantState = participant ? normalizeParticipantState(participant.state) : undefined
    const promptParticipant = participant ? {
      ...participant,
      state: {
        ...promptParticipantState!,
        relationshipMoment: this.memoryConfig.relationshipMomentEnabled === false
          ? undefined
          : activeRelationshipMoment(promptParticipantState?.relationshipMoment, now),
      },
    } : null
    this.reportOperation('diagnostic', 'debug', story, phase,
      '写作尺度=%s 实际间隔=%d秒 原剧本=%d 逻辑回合=%d 近期生活事实=%d 当前事件=%d',
      writingMode, Math.max(0, Math.round((now.getTime() - from.getTime()) / 1_000)),
      activeScene?.entries.filter(entry => entry.type === 'script').length ?? 0,
      recentLogicalTurns.length, recentLifeFacts.length, currentEventIds.size)
    const request: NarrativeRequest = {
      phase, refreshStoryHook: hookUpdate === 'full', hookUpdate, story, from, now, userMessage, images, abortSignal,
      writingMode,
      participant: phase === 'advance' ? null : promptParticipant,
      // A background turn may see relationship state through these opaque
      // participant summaries and may proactively contact one account only
      // when the owner explicitly enables proactive messages.
      participants,
      dueIntents: visibleDueIntents, activeConsequences: visibleConsequences, supersededIntents,
      shareParticipantDetails: this.sharedStoryConfig.shareParticipantDetails,
      storyHook: storyState.storyHook,
      activeScene,
      recentLogicalTurns,
      recentLifeFacts,
      recentProactiveContacts,
      participantKnownFacts,
      memories, bootstrapContext, facts, groupContext, webContext: mergedWebContext, overlaySnapshots,
    }
    let rawDecision = await this.narrator.decide(request)
    const repeated = repeatedReplyMatch(rawDecision, recentLogicalTurns)
    const repeatedNarrative = repeatedNarrativeMatch(rawDecision, [
      ...(activeScene?.previousSceneTail ?? []), ...(activeScene?.entries ?? []),
    ])
    if (repeated || repeatedNarrative) {
      const correctionReason = [repeated?.reason, repeatedNarrative?.reason].filter(Boolean).join('+')
      this.reportOperation('standard', 'warn', story, phase,
        '检测到主模型写作停滞，执行一次上下文纠正重写 原因=%s 上一回合=%s',
        correctionReason, repeated?.previous.entryId ?? repeatedNarrative?.previous.id ?? '?')
      rawDecision = await this.narrator.decide({
        ...request,
        revision: {
          reason: correctionReason,
          previousDeliveredMessages: repeated?.previous.characterMessages ?? [],
          previousResponseMeanings: recentLogicalTurns.slice(-12)
            .map(turn => turn.exchange?.newMove || turn.exchange?.responseMeaning || '').filter(Boolean),
          completedMoves: recentLogicalTurns.slice(-12)
            .flatMap(turn => turn.exchange?.completedMoves ?? []).filter(Boolean),
          previousScript: repeatedNarrative?.previous.content,
          previousSceneAction: activeScene?.state?.currentAction,
        },
      })
      const repeatedAgain = repeatedReplyMatch(rawDecision, recentLogicalTurns)
      const repeatedNarrativeAgain = repeatedNarrativeMatch(rawDecision, [
        ...(activeScene?.previousSceneTail ?? []), ...(activeScene?.entries ?? []),
      ])
      if (repeatedAgain && repeatedAgain.reason !== 'same-conversation-move' && rawDecision.interaction) {
        // The literary turn is still useful, but an exact transport replay is
        // never a new completed action. Keep the event noticed and let the next
        // real turn continue instead of delivering the duplicate twice.
        rawDecision = {
          ...rawDecision,
          interaction: { seen: rawDecision.interaction.seen !== false, reply: { mode: 'none' } },
          sceneTrace: rawDecision.sceneTrace ? {
            ...rawDecision.sceneTrace,
            exchange: {
              userMeaning: rawDecision.sceneTrace.exchange?.userMeaning,
              status: 'open',
            },
          } : rawDecision.sceneTrace,
        }
        this.reportOperation('standard', 'warn', story, phase,
          '纠正重写仍复用上一回合表达，已保留剧本推进并取消重复投递')
      }
      if (repeatedAgain?.reason === 'same-conversation-move') {
        this.reportOperation('diagnostic', 'debug', story, phase,
          '纠正后交流目的仍接近既有回合；当前事件可能确实要求延续该目的，保留模型的新措辞')
      }
      if (repeatedNarrativeAgain) {
        this.reportOperation('standard', 'warn', story, phase,
          '纠正重写后剧本仍与上一段高度相似；已保留本轮事实结果供下一回合继续，原因=%s', repeatedNarrativeAgain.reason)
      }
    }
    // The model may compose prose freely, but only source-linked participant
    // notes are retained as future factual context. This is intentionally a
    // narrow data-boundary check, not a prose filter or a second model pass.
    const allowedEventIds = new Set([
      ...currentEventIds,
      ...(activeScene?.pendingEventIds ?? []),
    ])
    return {
      decision: constrainSceneEvidence(
        constrainParticipantEvidence(rawDecision, new Set(participantKnownFacts.map(fact => fact.id))),
        allowedEventIds,
        currentEventIds,
      ),
      hookUpdate,
      writingMode,
    }
  }

  /**
   * Hooks now have two intentionally different jobs.  The final 10/20-minute
   * aftermath pass merges a small delta after a conversation has settled;
   * a full replacement waits for a genuinely quiet period.  Both modes reuse
   * the normal narrator turn and therefore never create a second request.
   */
  private hookUpdateMode(story: InterludeStory, phase: NarrativeRequest['phase'], now: Date): HookUpdateMode {
    const state = normalizeStoryState(story.state)
    if (!state.storyHook && (phase === 'advance' || phase === 'conversation-follow-up')) return 'full'

    const config = this.memoryConfig
    const futureFollowUps = (state.automation?.conversationFollowUpAt ?? [])
      .map(toDate).some(value => !!value && value > now)
    if (phase === 'conversation-follow-up') {
      // The final scheduled aftermath pass is the natural end of a dense
      // conversation. A later user message clears this plan and starts a new
      // cycle, so an old patch can never apply to the new conversation.
      return config.storyHookPatchAfterConversation !== false && state.storyHookDirty && !futureFollowUps
        ? 'patch'
        : 'none'
    }
    if (phase !== 'advance') return 'none'

    const idleMinutes = Math.max(30, Math.min(10_080, config.storyHookFullRefreshIdleMinutes ?? 240))
    const lastConversation = toDate(state.automation?.lastConversationActivityAt ?? state.automation?.lastUserMessageAt)
    const lastFullHook = toDate(state.lastStoryHookUpdateAt)
    const reference = [lastConversation, lastFullHook]
      .filter((value): value is Date => !!value)
      .sort((left, right) => right.getTime() - left.getTime())[0]
    // Old story states lack the new timestamps. Refresh them once on the
    // next idle pass, then they enter the four-hour cadence normally.
    if (!reference) return 'full'
    if (now.getTime() - reference.getTime() >= idleMinutes * Time.minute) return 'full'
    // Recover a missed final short pass without waiting for the next dense
    // conversation, but never let that catch-up override a due full refresh.
    return config.storyHookPatchAfterConversation !== false && state.storyHookDirty && !futureFollowUps
      ? 'patch'
      : 'none'
  }

  private async tryDecide(story: InterludeStory, participant: InterludeParticipant | null, phase: NarrativeRequest['phase'], from: Date, now: Date, userMessage: string | undefined, dueIntents: NarrativeIntent[], supersededIntents: NarrativeIntent[] = [], groupContext?: GroupContext, images: NarrativeImage[] = [], abortSignal?: AbortSignal) {
    let immediateObservations: WebObservation[] = []
    let effectiveNow = now
    const startedAt = Date.now()
    this.reportOperation('standard', 'info', story, phase,
      '模型调用开始 任务=主叙事 模型=%s 参与者=%s 时间段=%s→%s 到期计划=%d',
      this.mainModelLabel(), participant?.id || '全局', formatLogTime(from, story.setting.timezone), formatLogTime(now, story.setting.timezone), dueIntents.length)
    try {
      let narrative = await this.decide(story, participant, phase, from, effectiveNow, userMessage, dueIntents, supersededIntents, groupContext, images, [], abortSignal)
      let { decision, hookUpdate, writingMode } = narrative
      const immediate = phase === 'user-message' && participant && !groupContext && this.browserConfig.enabled && this.browserConfig.mode === 'allow-immediate'
        ? decision.browserIntents?.map(intent => normalizeBrowserIntentDraft(intent, this.browserConfig)).find(intent => intent?.timing === 'immediate')
        : undefined
      if (immediate) {
        // The first pass merely proposes the action. Do not persist its prose
        // or chat decision: after the real page read, ask the narrator once
        // more with the observation so the final script stays a single,
        // coherent piece of writing rather than two stitched tool calls.
        this.reportOperation('standard', 'info', story, phase, '即时网页观察开始 模式=%s', immediate.mode)
        const observation = await this.collectWebObservation(story, immediate, participant.id, null, new Date(), false)
        immediateObservations = [observation]
        effectiveNow = new Date()
        narrative = await this.decide(story, participant, phase, from, effectiveNow, userMessage, dueIntents, supersededIntents, groupContext, images, immediateObservations, abortSignal)
        decision = narrative.decision
        hookUpdate = narrative.hookUpdate
        writingMode = narrative.writingMode
      }
      const result = {
        decision,
        hookUpdate,
        succeeded: true,
        effectiveNow,
        immediateObservations,
        writingMode,
      }
      if (this.config.logging?.logScriptPreview && result.decision.script) {
        this.report('info', story, phase, '当前剧本内容：\n%s', result.decision.script.slice(0, this.config.logging.previewLength))
      }
      this.reportOperation('standard', 'info', story, phase,
        '模型调用完成 任务=主叙事 耗时=%dms 剧本文字=%d 回复模式=%s',
        Date.now() - startedAt, result.decision.script?.length ?? 0, result.decision.interaction?.reply?.mode ?? 'none')
      return result
    } catch (error) {
      if (abortSignal?.aborted) {
        this.reportOperation('diagnostic', 'debug', story, phase,
          '旧主模型请求已取消 耗时=%dms 原因=新的用户消息已合并', Date.now() - startedAt)
      } else {
        this.report('warn', story, phase, '模型调用失败 任务=主叙事 耗时=%dms 错误=%s', Date.now() - startedAt, error)
      }
      return { decision: {}, hookUpdate: 'none' as HookUpdateMode, succeeded: false, effectiveNow, immediateObservations, writingMode: undefined }
    }
  }

  private async persistDecision(story: InterludeStory, participant: InterludeParticipant | null, raw: NarrativeDecision, from: Date, now: Date, permitMessages: boolean, phase: NarrativeRequest['phase'], observedContext = '', hookUpdate: HookUpdateMode = 'none', writingMode?: NarrativeRequest['writingMode']) {
    // 先规范化，再写库：不信任模型给出的时间、长度和结构，尤其不能让未来剧情落库。
    const allParticipants = await this.participants(story.id)
    const permittedParticipantIds = new Set(allParticipants.filter(item => this.canHandleParticipant(item)).map(item => item.id))
    const refreshStoryHook = hookUpdate === 'full'
    const decision = normalizeDecision(
      raw, from, now, permitMessages, this.config.runtime, this.sharedStoryConfig,
      participant?.id ?? '', permittedParticipantIds, phase, this.memoryConfig, refreshStoryHook, hookUpdate === 'patch',
    )
    let scriptEntry: ScriptEntry | undefined
    let persistedSceneState: SceneStateDecision | undefined
    if (decision.script) {
      if (!decision.sceneTrace) {
        this.reportOperation('standard', 'warn', story, phase, '主叙事未返回 Scene Trace，已保存最小事实卡；请检查模型是否遵守当前 JSON 协议')
      }
      if (refreshStoryHook && !decision.storyHook) {
        this.reportOperation('standard', 'warn', story, phase, '主叙事未返回剧本引子，本次保留原引子并在后续常规推进重试')
      }
      if (hookUpdate === 'patch' && !decision.storyHookPatch) {
        this.reportOperation('standard', 'warn', story, phase, '主叙事未返回剧本引子小修改，本次保留待吸收事实，后续空闲推进将再次尝试')
      }
      const sceneTrace = decision.sceneTrace ?? fallbackSceneTrace(phase, observedContext)
      persistedSceneState = completeSceneStateDecision(
        decision.sceneState,
        sceneTrace,
        normalizeSceneStateSnapshot(normalizeStoryState(story.state).activeSceneState),
      )
      scriptEntry = await this.appendEntry(story.id, {
        kind: 'script',
        actor: 'narrator',
        content: decision.script,
        occurredAt: now.toISOString(),
          metadata: {
            phase, writingMode, hookUpdate, interaction: decision.interaction ?? null, sceneTrace,
            sceneState: persistedSceneState ?? null, eventResults: decision.eventResults,
            relationshipMomentUpdate: decision.relationshipMomentUpdate ?? null,
          storyHookPatch: decision.storyHookPatch ?? null,
          // The card collector uses this bounded interval to attach the exact
          // inbound batch to one authored turn without guessing from prose.
          continuityTurn: { from: from.toISOString(), phase, participantId: participant?.id ?? '' },
        },
      }, now, participant?.id ?? '')
    }
    await this.applyIntentUpdates(story.id, decision.intentUpdates, now, participant?.id)
    for (const entry of decision.entries) await this.appendEntry(story.id, entry, now, participant?.id ?? '')
    for (const memory of decision.memories) await this.appendMemory(story.id, memory, now, memory.participantId ?? participant?.id ?? '')
    for (const intent of decision.intents) {
      // A reminder or promise created while handling a user's message is a
      // response to that relationship, even if it becomes due much later.
      // Carry that provenance into the shared intent ledger so its due-turn
      // is allowed to send the eventual message without enabling broad
      // background outreach.
      const payload = isRecord(intent.payload) ? intent.payload : {}
      await this.appendIntent(story.id, {
        ...intent,
        payload: phase === 'user-message' && participant
          ? { ...payload, userInitiated: payload.userInitiated !== false }
          : payload,
      }, now, intent.participantId ?? participant?.id ?? '')
    }
    for (const browserIntent of decision.browserIntents) {
      // An immediate intent is handled before the final narrator pass when
      // enabled. If it reaches this point (disabled mode, group turn, or a
      // second consecutive request), safely downgrade it to deferred work.
      if (participant || phase !== 'user-message' || this.browserConfig.allowGroupTriggeredResearch) {
        await this.appendBrowserIntent(story.id, browserIntent, now, participant?.id ?? '')
      }
    }
    if (participant && (decision.statePatch || decision.relationshipMomentUpdate)) {
      const participantPatch: Partial<ParticipantState> = { ...(decision.statePatch ?? {}) }
      if (decision.relationshipMomentUpdate && this.memoryConfig.relationshipMomentEnabled !== false) {
        participantPatch.relationshipMoment = applyRelationshipMomentUpdate(
          activeRelationshipMoment(normalizeParticipantState(participant.state).relationshipMoment, now),
          decision.relationshipMomentUpdate,
          now,
        )
      }
      // Keep the in-memory participant current for the later seen/delivery
      // bookkeeping in this same transaction; otherwise that write could
      // restore the pre-update JSON state and silently discard this card.
      participant = await this.updateParticipantState(participant, participantPatch, now)
      if (decision.relationshipMomentUpdate) {
        this.reportOperation('diagnostic', 'debug', story, phase,
          '关系态势已处理 参与者=%s 动作=%s 强度=%s', participant.id,
          decision.relationshipMomentUpdate.action,
          typeof participantPatch.relationshipMoment?.intensity === 'number' ? participantPatch.relationshipMoment.intensity.toFixed(2) : '-')
      }
    } else if (participant && phase === 'user-message' && this.memoryConfig.relationshipMomentEnabled !== false) {
      this.reportOperation('diagnostic', 'debug', story, phase, '主叙事未返回关系态势更新，已保留当前状态 参与者=%s', participant.id)
    }

    if (decision.script) {
      const state = normalizeStoryState(story.state)
      const nextCount = Math.max(0, Math.floor(state.narrativeUpdateCount || 0)) + 1
      const nextState: StoryState = { ...state, narrativeUpdateCount: nextCount }
      const pendingEvents = new Set(state.pendingSceneEventIds ?? [])
      for (const result of decision.eventResults ?? []) {
        if (result.status === 'pending' || result.status === 'unseen') pendingEvents.add(result.eventId)
        else pendingEvents.delete(result.eventId)
      }
      nextState.pendingSceneEventIds = [...pendingEvents].slice(-200)
      if (persistedSceneState) {
        nextState.activeSceneState = {
          label: persistedSceneState.label,
          location: persistedSceneState.location,
          activity: persistedSceneState.activity,
          currentAction: persistedSceneState.currentAction,
          completedActions: persistedSceneState.completedActions,
          pausedActions: persistedSceneState.pausedActions,
          bodyState: persistedSceneState.bodyState,
          mood: persistedSceneState.mood,
          attention: persistedSceneState.attention,
          participants: persistedSceneState.participants,
          openMatters: persistedSceneState.openMatters,
          updatedAt: now.toISOString(),
        }
        if (persistedSceneState.action === 'close-and-open') {
          nextState.sceneTransitionPending = {
            ...persistedSceneState,
            requestedAt: now.toISOString(),
            sourceEntryId: scriptEntry?.id,
          }
        }
      }
      if (hookUpdate === 'full') {
        if (decision.storyHook) {
          nextState.storyHook = decision.storyHook
          nextState.storyHookEntryId = scriptEntry?.id
          nextState.storyHookAdvanceCount = 0
          // A bootstrap refresh can happen at the first 10-minute follow-up.
          // Keep the cycle dirty while another scheduled aftermath pass still
          // exists so the final pass can add its intended small patch.
          nextState.storyHookDirty = phase === 'conversation-follow-up'
            && (state.automation?.conversationFollowUpAt ?? []).map(toDate).some(value => !!value && value > now)
          nextState.lastStoryHookUpdateAt = now.toISOString()
        }
      } else if (hookUpdate === 'patch' && decision.storyHookPatch && state.storyHook) {
        nextState.storyHook = mergeStoryHookPatch(state.storyHook, decision.storyHookPatch)
        nextState.storyHookDirty = false
        nextState.lastStoryHookPatchAt = now.toISOString()
      } else if (phase !== 'advance') {
        nextState.storyHookDirty = true
      }
      await this.dbSet('interlude_story', { id: story.id }, { state: nextState, updatedAt: now })
      if (hookUpdate === 'patch' && decision.storyHookPatch) {
        this.reportOperation('standard', 'info', story, phase, '剧本引子已合并对话末尾小修改 字段=%s', Object.keys(decision.storyHookPatch).join(','))
      } else if (hookUpdate === 'full' && decision.storyHook) {
        this.reportOperation('standard', 'info', story, phase, '剧本引子已完成空闲期完整更新')
      }
    }

    const messages: OutgoingMessageDraft[] = []
    const interaction = decision.interaction
    const hasImmediateParticipantReply = !!(participant && permitMessages
      && interaction?.reply.mode === 'immediate' && interaction.reply.content)
    // A successfully delivered immediate reply clears the participant state in
    // recordDeliveredOutgoingMessage(). Avoid writing the same row twice on the
    // common foreground path. If delivery fails, the catch path still records
    // that the character saw this particular user turn.
    if (participant && interaction?.seen && !hasImmediateParticipantReply) await this.markParticipantSeen(participant, now)
    if (hasImmediateParticipantReply && participant && interaction?.reply.content) {
      messages.push({ participantId: participant.id, content: interaction.reply.content })
    }
    if (participant && permitMessages && interaction?.reply.mode === 'delayed' && interaction.reply.content && interaction.reply.sendAt) {
      const sendAt = new Date(interaction.reply.sendAt)
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
      this.scheduleDueIntentWake(story.id, sendAt)
    }

    // A cross-account message is itself proactive from the target's point of
    // view. Allow it during a live user event, or during background work only
    // when the global proactive-message switch is enabled.
    const crossActions = phase === 'user-message' || this.config.runtime.allowProactiveMessages
      ? decision.crossConversationActions
      : []
    if (phase === 'advance' && decision.crossConversationActions.length) {
      this.reportOperation('standard', 'info', story, phase, '主动联系候选通过 数量=%d 意愿=%s',
        decision.crossConversationActions.length,
        decision.crossConversationActions.map(action => typeof action.willingness === 'number' ? action.willingness.toFixed(2) : '?').join(','))
    }
    for (const action of crossActions) {
      if (action.mode === 'immediate') {
        messages.push({
          participantId: action.participantId,
          content: action.content,
          metadata: {
            proactiveContact: {
              meaning: action.meaning || action.reason || '主角主动联系了当前参与者。',
              reason: action.reason,
              willingness: action.willingness,
            },
          },
        })
      } else {
        const sendAtValue = (action as { sendAt?: string }).sendAt
        if (action.mode !== 'delayed' || !sendAtValue) continue
        const sendAt = new Date(sendAtValue)
        await this.appendIntent(story.id, {
          type: 'cross-conversation-message', summary: 'The character planned a message to another relationship branch.',
          notBefore: sendAtValue, payload: {
            content: action.content, userInitiated: false, crossConversation: true,
            willingness: action.willingness, reason: action.reason, meaning: action.meaning,
          },
        }, now, action.participantId)
        this.scheduleDueIntentWake(story.id, sendAt)
      }
    }

    for (const message of messages) {
      // <sep/> bubbles are not all visible at the same instant. Persist the
      // first one now; later bubbles become ordinary due intents so a new
      // incoming message can cancel them before they are actually sent.
      const [first, ...later] = this.splitOutgoingMessage(message.content)
      if (!first) continue
      message.content = first
      message.metadata = {
        ...(message.metadata ?? {}), visible: true, interaction: interaction ?? null,
        turnEntryId: scriptEntry?.id, turnPhase: phase, decisionAt: now.toISOString(),
      }
      // The narrator may have spent tens of seconds generating before this
      // decision reaches the transport layer.  Typing begins when the first
      // bubble is actually committed, never from the earlier prompt time.
      const typingStartedAt = new Date()
      let delay = 0
      for (let index = 0; index < later.length; index++) {
        const content = later[index]
        delay += this.typingDelayMilliseconds(content)
        const sendAt = new Date(typingStartedAt.getTime() + delay)
        await this.appendIntent(story.id, {
          type: 'split-message',
          summary: 'The character is still typing the next message segment.',
          notBefore: sendAt.toISOString(),
          payload: {
            content, visibleMessage: true, userInitiated: phase === 'user-message',
            turnEntryId: scriptEntry?.id, turnPhase: phase,
            segmentIndex: index + 1, segmentCount: later.length + 1,
          },
        }, typingStartedAt, message.participantId)
        this.scheduleDueIntentWake(story.id, sendAt)
      }
    }
    return messages
  }

  private async appendEntry(storyId: string, entry: ScriptEntryDraft, now: Date, participantId = '') {
    const occurredAt = toDate(entry.occurredAt) ?? now
    const created = await this.dbCreate('interlude_script_entry', {
      storyId, participantId, kind: clip(entry.kind, 32) || 'life', actor: clip(entry.actor ?? 'character', 32),
      content: clip(entry.content, 12_000), occurredAt,
      metadata: isRecord(entry.metadata) ? entry.metadata : {}, createdAt: now,
    }) as ScriptEntry
    // entryCount 只统计当前活动场景自上次压缩后的新增原始记录，用于触发后台压缩。
    // 它是派生统计字段；SQLite/sql.js 偶发 I/O 锁定时不能让已经写入的
    // 剧本条目回滚，也不能让本轮叙事被误判为模型失败。因此这里采用
    // best-effort 更新，失败只记录警告，下一次压缩/写入会再次校正。
    try {
      // Keep the legacy entryCount untouched here.  Counting pending source
      // rows during compaction avoids a second SQLite write for every entry.
    } catch (error) {
      this.serviceLogger.warn('场景条目计数更新失败，已保留剧本条目：%s', error)
    }
    return created
  }

  private async appendMemory(storyId: string, memory: MemoryDraft, now: Date, participantId = '') {
    await this.dbCreate('interlude_memory', {
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
    // The previous floor of 50 caused every live turn to scan a large slice of
    // the facts table, even when the narrator only needed a handful of facts.
    // Keep enough candidates for semantic re-ranking without making the
    // latency-sensitive path do unnecessary database work.
    const candidateLimit = Math.max(20, Math.min(limit * 5, this.memoryConfig.maxFactsPerStory, 300))
    // Live embedding adds an extra HTTP request to every user turn. Keep it
    // opt-in; start it together with the SQLite read so network latency does
    // not sit behind an avoidable database round trip.
    const [rows, queryEmbedding] = await Promise.all([
      this.dbGet('interlude_fact', { storyId, status: 'active' }, {
        limit: candidateLimit,
        sort: { importance: 'desc', updatedAt: 'desc' },
      }),
      query.trim() && this.config.model.embedding?.liveQuery
        ? this.embedText(query)
        : Promise.resolve([] as number[]),
    ])
    return rows
      .filter(fact => participantId === undefined || !fact.participantId || fact.participantId === participantId)
      .map(fact => ({ fact, score: factScore(fact, this.memoryConfig, queryEmbedding) }))
      .sort((a, b) => b.score - a.score
        || b.fact.updatedAt.getTime() - a.fact.updatedAt.getTime()
        || b.fact.id - a.fact.id)
      .slice(0, limit)
      .map(item => item.fact)
  }

  /** Returns only observations that are safe for this narration branch. A
   * participant's browsing is not shown to another private participant unless
   * the owner has explicitly enabled shared relationship details. */
  private async webObservations(storyId: string, participantId?: string) {
    // Browsing is optional. Avoid a database read on every live turn when the
    // feature is disabled, which is the default for most installations.
    if (!this.browserConfig.enabled) return []
    const limit = Math.max(1, Math.min(this.browserConfig.maxObservationsInPrompt, 20))
    const rows = await this.dbGet('interlude_web_observation', { storyId }, {
      limit: Math.max(limit * 4, 20), sort: { accessedAt: 'desc' },
    })
    return rows
      // Failed/blocked attempts already have a terse script event. Keeping
      // their error text in every later prompt wastes tokens and can crowd
      // out useful successful observations.
      .filter(observation => observation.status === 'success')
      .filter(observation => this.sharedStoryConfig.shareParticipantDetails
        || !observation.participantId || observation.participantId === (participantId ?? ''))
      .slice(0, limit)
      .reverse()
  }

  async activeScene(storyId: string): Promise<InterludeScene | null> {
    const rows = await this.dbGet('interlude_scene', { storyId, status: 'active' }, {
      limit: 1,
      sort: { updatedAt: 'desc' },
    })
    return rows[0] ?? null
  }

  /** Build the verbatim short-term continuity source used by the main writer.
   * Raw entries stay immutable; user-event state is derived from later script
   * acknowledgements, so a crash can never silently mark a message handled. */
  private async loadActiveSceneContext(
    story: InterludeStory,
    scene: InterludeScene | null,
    participant: InterludeParticipant | null,
    phase: NarrativeRequest['phase'],
    currentEventIds: Set<string>,
    prefetchedEntries?: ScriptEntry[],
  ): Promise<ActiveSceneContext | undefined> {
    if (!scene) return undefined
    const entryLimit = Math.max(20, Math.min(1_000, this.config.runtime.activeSceneEntryLimit ?? 400))
    const characterBudget = Math.max(4_000, Math.min(200_000, this.config.runtime.activeSceneCharacterBudget ?? 60_000))
    const tailBudget = Math.max(500, Math.min(20_000, this.config.runtime.previousSceneTailCharacters ?? 4_000))
    const narrativeLimit = Math.max(8, Math.min(60, this.config.runtime.activeSceneNarrativeLimit ?? 20))
    const prefetchedSceneEntries = (prefetchedEntries ?? [])
      .filter(entry => entry.occurredAt >= scene.startedAt)
      .slice(-entryLimit)
    const prefetchedCoversScene = !!prefetchedEntries?.length && (
      prefetchedSceneEntries.filter(entry => entry.kind === 'script').length >= narrativeLimit
      || prefetchedEntries[0].occurredAt <= scene.startedAt
    )
    const rawLatest = prefetchedCoversScene
      ? prefetchedSceneEntries
      : await this.dbGet('interlude_script_entry', {
          storyId: story.id, occurredAt: { $gte: scene.startedAt },
        }, { limit: entryLimit, sort: { occurredAt: 'desc' } }) as ScriptEntry[]
    const pendingIds = (normalizeStoryState(story.state).pendingSceneEventIds ?? [])
      .map(value => Number(value.replace(/^entry:/, ''))).filter(Number.isFinite)
    const loadedIds = new Set(rawLatest.map(entry => entry.id))
    const missingPendingIds = pendingIds.filter(id => !loadedIds.has(id))
    const pendingRows = missingPendingIds.length
      ? await this.dbGet('interlude_script_entry', { storyId: story.id, id: { $in: missingPendingIds } }) as ScriptEntry[]
      : []
    const rawEntries = Array.from(new Map([...rawLatest, ...pendingRows].map(entry => [entry.id, entry])).values())
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id - right.id)
    const visible = rawEntries.filter(entry => activeSceneEntryVisible(entry, participant, phase, this.sharedStoryConfig.shareParticipantDetails))
    const eventState = collectSceneEventState(visible)
    const mapped = visible.map(entry => toActiveSceneEntry(entry, eventState))
      .filter((entry): entry is ActiveSceneEntry => !!entry)
      .filter(entry => !currentEventIds.has(entry.id))
    // Keep roughly the same stable prose window that worked in the original
    // implementation. Settled transport bubbles are represented once in the
    // logical-turn/dialogue ledgers, so they cannot become a style template.
    const entries = selectActiveScenePromptEntries(mapped, characterBudget, narrativeLimit)

    let previousSceneTail: ActiveSceneEntry[] = []
    // The previous tail is a temporary bridge, not a permanent second copy of
    // history. Once the new scene has several authored passages, its own prose
    // and the logical trajectory are sufficient and the extra query can stop.
    const currentScriptCount = entries.filter(entry => entry.type === 'script').length
    const missingNarrativePassages = Math.max(0, narrativeLimit - currentScriptCount)
    if (missingNarrativePassages > 0) {
      const previous = (await this.dbGet('interlude_scene', { storyId: story.id, status: 'closed' }, {
        limit: 1, sort: { endedAt: 'desc' },
      }) as InterludeScene[])[0]
      if (previous) {
        const previousRows = await this.dbGet('interlude_script_entry', {
          storyId: story.id, occurredAt: { $gte: previous.startedAt, $lte: previous.endedAt ?? scene.startedAt },
        }, { limit: Math.min(200, entryLimit), sort: { occurredAt: 'desc' } }) as ScriptEntry[]
        const previousVisible = previousRows.reverse()
          .filter(entry => activeSceneEntryVisible(entry, participant, phase, this.sharedStoryConfig.shareParticipantDetails))
        const previousState = collectSceneEventState(previousVisible)
        previousSceneTail = selectActiveScenePromptEntries(
          previousVisible.map(entry => toActiveSceneEntry(entry, previousState)).filter((entry): entry is ActiveSceneEntry => !!entry),
          tailBudget,
          missingNarrativePassages,
        )
      }
    }
    const pendingEventIds = entries
      .filter(entry => entry.type === 'user-message' || entry.type === 'group-message')
      .filter(entry => entry.eventStatus === 'pending' || entry.eventStatus === 'unseen')
      .map(entry => entry.id)
    return {
      sceneId: scene.id,
      startedAt: scene.startedAt,
      state: normalizeSceneStateSnapshot(story.state.activeSceneState),
      previousSceneTail,
      entries,
      pendingEventIds,
    }
  }

  async activeArc(storyId: string): Promise<InterludeArc | null> {
    const rows = await this.dbGet('interlude_arc', { storyId, status: 'active' }, {
      limit: 1,
      sort: { updatedAt: 'desc' },
    })
    return rows[0] ?? null
  }

  private async appendIntent(storyId: string, intent: IntentDraft, now: Date, participantId = '') {
    const notBefore = toDate(intent.notBefore)
    const payload = isRecord(intent.payload) ? intent.payload : {}
    const activeConsequence = isActiveConsequenceDraft(intent)
    if (activeConsequence && !this.memoryConfig.activeConsequencesEnabled) return
    const requestedExpiresAt = activeConsequence ? consequenceExpiresAt(payload) : undefined
    const maxLifetime = Math.max(1, this.memoryConfig.activeConsequenceMaxDays) * Time.day
    const expiresAt = requestedExpiresAt && requestedExpiresAt > now
      ? new Date(Math.min(requestedExpiresAt.getTime(), now.getTime() + maxLifetime))
      : undefined
    // Scheduled plans always remain future-facing. An active consequence is
    // different: it is a present condition caused by something already in
    // the script, so it begins at now and only needs a bounded expiry.
    if (!notBefore || (!activeConsequence && notBefore <= now) || (activeConsequence && !expiresAt)) return
    const normalizedPayload = activeConsequence ? {
      ...payload,
      strength: consequenceStrength(payload, this.memoryConfig.activeConsequenceDefaultStrength),
      expiresAt: expiresAt!.toISOString(),
    } : payload
    await this.dbCreate('interlude_intent', {
      storyId, participantId, type: clip(intent.type, 32) || 'follow-up', summary: clip(intent.summary, 4_000), notBefore,
      status: 'pending', payload: normalizedPayload, createdAt: now, updatedAt: now,
    })
  }

  /** Active consequences share the intent table but are never scheduler work.
   * Their payload keeps the lifecycle explicit so old scheduled intents keep
   * their existing behaviour without a migration. */
  private async activeConsequences(storyId: string, now: Date, participantId?: string) {
    if (!this.memoryConfig.activeConsequencesEnabled) return []
    const rows = await this.dbGet('interlude_intent', { storyId, status: 'pending' }, {
      limit: 100, sort: { updatedAt: 'desc' },
    })
    return rows
      .filter(isActiveConsequence)
      .filter(intent => intent.notBefore <= now)
      .filter(intent => {
        const expiresAt = consequenceExpiresAt(intent.payload)
        return !!expiresAt && expiresAt > now
      })
      .filter(intent => participantId === undefined || !intent.participantId || intent.participantId === participantId)
      .sort((left, right) => consequenceStrength(right.payload) - consequenceStrength(left.payload)
        || right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, Math.max(1, this.memoryConfig.activeConsequencePromptLimit))
  }

  private async expireActiveConsequences(storyId: string, now: Date) {
    if (!this.memoryConfig.activeConsequencesEnabled) return
    const rows = await this.dbGet('interlude_intent', { storyId, status: 'pending' }, {
      limit: 100, sort: { updatedAt: 'asc' },
    })
    const expired = rows.filter(intent => isActiveConsequence(intent) && (consequenceExpiresAt(intent.payload)?.getTime() ?? 0) <= now.getTime())
    if (expired.length) {
      await this.dbSet('interlude_intent', { id: { $in: expired.map(intent => intent.id) } }, { status: 'completed', updatedAt: now })
    }
  }

  /** Only active consequences visible to the writer may be resolved. This
   * prevents a remote model from changing arbitrary future plans by id. */
  private async applyIntentUpdates(storyId: string, updates: ReturnType<typeof normalizeIntentUpdates>, now: Date, participantId?: string) {
    if (!updates.length) return
    const ids = updates.map(update => update.id)
    const rows = await this.dbGet('interlude_intent', { storyId, id: { $in: ids }, status: 'pending' })
    const allowed = new Map(rows
      .filter(isActiveConsequence)
      .filter(intent => !participantId || !intent.participantId || intent.participantId === participantId)
      .map(intent => [intent.id, intent]))
    for (const update of updates) {
      const intent = allowed.get(update.id)
      if (!intent) continue
      const payload = {
        ...intent.payload,
        ...(update.resolution ? { resolution: update.resolution } : {}),
      }
      await this.dbSet('interlude_intent', { id: intent.id }, { status: update.status, payload, updatedAt: now })
    }
  }

  /** Stores a narrator-proposed browser action as a future intent. The model
   * never writes page content directly; a separate Puppeteer task creates the
   * observation later. */
  private async appendBrowserIntent(storyId: string, draft: BrowserIntentDraft, now: Date, fallbackParticipantId = '') {
    const config = this.browserConfig
    if (!config.enabled) return
    const normalized = normalizeBrowserIntentDraft(draft, config)
    if (!normalized) return
    // A model may describe a reason involving another person, but it may not
    // silently attach a web observation to another relationship branch. The
    // active participant owns a live-turn browse; unattended life browsing is
    // world-level. This is both a privacy boundary and a simpler mental model.
    const participantId = fallbackParticipantId
    const allowedParticipant = participantId ? await this.getParticipant(participantId) : undefined
    if (participantId && (!allowedParticipant || !this.canHandleParticipant(allowedParticipant))) return
    const notBefore = new Date(now.getTime() + Time.second)
    await this.appendIntent(storyId, {
      type: 'browser-research',
      summary: clip(normalized.purpose, 500) || 'The character planned to read a public web page.',
      notBefore: notBefore.toISOString(),
      payload: {
        mode: normalized.mode,
        query: normalized.query ?? '',
        url: normalized.url ?? '',
        purpose: normalized.purpose,
      },
    }, now, participantId)
    this.reportStandaloneOperation('diagnostic', 'debug', '已创建网页浏览意图：故事=%s 模式=%s', storyId, normalized.mode)
  }

  /** Executes a due browser intent once, records its bounded observation, and
   * marks the future plan complete regardless of success. A failed browser is
   * still an event (the character could not access the page), but it never
   * blocks later dialogue or background life updates. */
  private async executeDeferredBrowserIntent(story: InterludeStory, intent: NarrativeIntent, now: Date) {
    const payload = browserIntentFromPayload(intent.payload)
    const observation = await this.collectWebObservation(story, payload, intent.participantId, intent.id, now)
    await this.dbSet('interlude_intent', { id: intent.id }, { status: 'completed', updatedAt: new Date() })
    return observation
  }

  /** Read a page through Koishi Puppeteer. This is intentionally read-only:
   * it rejects non-public destinations, extracts visible text only, and closes
   * the page after every observation. */
  private async collectWebObservation(story: InterludeStory, draft: BrowserIntentDraft | null, participantId: string, intentId: number | null, now: Date, persist = true): Promise<WebObservation> {
    const config = this.browserConfig
    const normalized = draft ? normalizeBrowserIntentDraft(draft, config) : undefined
    if (!normalized || !config.enabled) {
      return this.saveWebObservation(story.id, participantId, intentId, normalized?.mode ?? 'visit', normalized?.query ?? '', normalized?.url ?? '', '', '', '浏览未执行：功能未启用或请求不符合安全规则。', 'blocked', now, persist)
    }

    const target = resolveBrowserTarget(normalized, config)
    if (!target) {
      this.report('warn', story, 'intent-due', '网页浏览被安全策略拦截：模式=%s', normalized.mode)
      return this.saveWebObservation(story.id, participantId, intentId, normalized.mode, normalized.query ?? '', normalized.url ?? '', '', '', '浏览目标未通过公开网页安全校验。', 'blocked', now, persist)
    }

    const cached = await this.findCachedWebObservation(story.id, participantId, normalized, now)
    if (cached) {
      if (!persist) return { ...cached, id: 0, intentId, accessedAt: now, createdAt: now }
      await this.appendEntry(story.id, {
        kind: 'web-observation', actor: 'system',
        content: `The character revisited a recent web observation: ${cached.title || cached.url}.`,
        occurredAt: now.toISOString(), metadata: { observationId: cached.id, cached: true, status: cached.status },
      }, now, participantId)
      return cached
    }

    const puppeteer = (this.ctx as any).puppeteer
    if (!puppeteer?.page) {
      this.report('warn', story, 'intent-due', '网页浏览服务不可用：请安装并启用 koishi-plugin-puppeteer。')
      return this.saveWebObservation(story.id, participantId, intentId, normalized.mode, normalized.query ?? '', target, '', '', '浏览器服务不可用。', 'failed', now, persist)
    }

    return this.withBrowserSlot(async () => {
      let page: any
      try {
        page = await puppeteer.page()
        await page.setUserAgent('Mozilla/5.0 (compatible; HDS-Interlude/0.1.2-beta3-recreate; +https://koishi.chat/)')
        await page.setRequestInterception(true)
        page.on('request', (request: any) => {
          const resourceType = request.resourceType?.() ?? 'document'
          const requestUrl = request.url?.() ?? ''
          const allowedResource = ['document', 'stylesheet', 'script', 'xhr', 'fetch', 'image'].includes(resourceType)
          const allowedUrl = isSafePublicWebUrl(requestUrl, config)
          const operation = allowedResource && allowedUrl ? request.continue() : request.abort('blocked')
          void Promise.resolve(operation).catch(() => undefined)
        })
        page.on('popup', (popup: any) => void popup.close().catch(() => undefined))
        await page.goto(target, { waitUntil: config.waitUntil, timeout: config.navigationTimeout })
        const finalUrl = String(page.url?.() ?? target)
        if (!isSafePublicWebUrl(finalUrl, config)) throw new Error('页面重定向到了不允许的地址。')
        const result = await page.evaluate(() => ({
          title: String(document.title || '').trim(),
          text: String(document.body?.innerText || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(),
        }))
        const text = clip(String(result?.text ?? ''), config.maxTextCharacters)
        const title = clip(String(result?.title ?? ''), 500)
        const excerpt = clip(text, config.maxExcerptCharacters)
        const summary = clip(`${title ? `${title}。` : ''}${excerpt}`, config.maxExcerptCharacters)
        const observation = await this.saveWebObservation(story.id, participantId, intentId, normalized.mode, normalized.query ?? '', finalUrl, title, excerpt, summary || '页面没有可提取的正文。', 'success', new Date(), persist)
        this.reportOperation('standard', 'info', story, 'intent-due', '网页读取完成 标题=%s 正文=%d字', title || '未命名页面', text.length)
        if (config.logObservationPreview) this.report('debug', story, 'intent-due', '网页观察节选：%s', excerpt)
        return observation
      } catch (error) {
        this.report('warn', story, 'intent-due', '网页读取失败：%s', error)
        return this.saveWebObservation(story.id, participantId, intentId, normalized.mode, normalized.query ?? '', target, '', '', `网页读取失败：${clip(String(error instanceof Error ? error.message : error), 500)}`, 'failed', new Date(), persist)
      } finally {
        if (page) await page.close().catch(() => undefined)
      }
    })
  }

  private async saveWebObservation(storyId: string, participantId: string, intentId: number | null, mode: 'search' | 'visit', query: string, url: string, title: string, excerpt: string, summary: string, status: WebObservation['status'], now: Date, persist = true): Promise<WebObservation> {
    const candidate: WebObservation = {
      id: 0, storyId, participantId, intentId, mode, query: clip(query, 500), url: clip(url, 2_000), title: clip(title, 500),
      excerpt: clip(excerpt, this.browserConfig.maxExcerptCharacters), summary: clip(summary, this.browserConfig.maxExcerptCharacters),
      status, accessedAt: now, createdAt: now,
    }
    if (!persist) return candidate
    const observation = await this.dbCreate('interlude_web_observation', candidate) as WebObservation
    await this.appendEntry(storyId, {
      kind: 'web-observation', actor: 'system',
      content: webObservationEntryContent(observation), occurredAt: now.toISOString(),
      metadata: { observationId: observation.id, status, mode, url: observation.url },
    }, now, participantId)
    return observation
  }

  /** Immediate browser reads are intentionally held in memory until the
   * final narrator result survives the stale-request check. This prevents an
   * obsolete two-second message burst from leaving a durable web event behind. */
  private async persistCollectedWebObservation(observation: WebObservation) {
    return this.saveWebObservation(
      observation.storyId, observation.participantId, observation.intentId, observation.mode,
      observation.query, observation.url, observation.title, observation.excerpt, observation.summary,
      observation.status, observation.accessedAt,
    )
  }

  private async findCachedWebObservation(storyId: string, participantId: string, draft: BrowserIntentDraft, now: Date) {
    const minutes = this.browserConfig.cacheMinutes
    if (minutes <= 0) return undefined
    const cutoff = new Date(now.getTime() - minutes * Time.minute)
    const rows = await this.ctx.database.get('interlude_web_observation', { storyId, participantId, status: 'success' }, {
      limit: 20, sort: { accessedAt: 'desc' },
    })
    return rows.find(observation => observation.accessedAt >= cutoff
      && observation.mode === draft.mode
      && (draft.mode === 'search' ? observation.query === (draft.query ?? '') : observation.url === (draft.url ?? '')))
  }

  private async withBrowserSlot<T>(task: () => Promise<T>) {
    const max = Math.max(1, this.browserConfig.maxConcurrentPages)
    if (this.browserActive >= max) await new Promise<void>(resolve => this.browserWaiters.push(resolve))
    this.browserActive++
    try {
      return await task()
    } finally {
      this.browserActive--
      this.browserWaiters.shift()?.()
    }
  }

  /** Persist a bounded retry so a transient provider failure cannot strand a user turn. */
  private async scheduleNarrativeRetry(
    storyId: string,
    participantId: string,
    now: Date,
    previousAttempts = 0,
    origin?: { from: Date; userMessage: string },
  ) {
    const delaySeconds = Math.max(5, this.config.runtime.narrativeRetryDelaySeconds ?? 60)
    const maxAttempts = Math.max(0, this.config.runtime.narrativeRetryMaxAttempts ?? 6)
    const pending = await this.ctx.database.get('interlude_intent', { storyId, participantId, status: 'pending' })
    const existing = pending.filter(intent => intent.type === 'narrative-retry')
    if (existing.length) await this.dbSet('interlude_intent', { id: { $in: existing.map(intent => intent.id) } }, { status: 'cancelled', updatedAt: now })
    if (!participantId || previousAttempts >= maxAttempts) {
      this.reportStandalone('warn', '叙事模型自动重试已停止：故事=%s 参与者=%s 已尝试=%d 上限=%d', storyId, participantId || '全局', previousAttempts, maxAttempts)
      return false
    }
    const attempt = previousAttempts + 1
    const notBefore = new Date(now.getTime() + delaySeconds * Time.second)
    await this.appendIntent(storyId, {
      type: 'narrative-retry',
      summary: `Retry the interrupted narrative turn after provider failure (attempt ${attempt}/${maxAttempts}).`,
      notBefore: notBefore.toISOString(),
      payload: {
        narrativeRetry: true,
        userInitiated: true,
        attempt,
        from: origin?.from.toISOString(),
        userMessage: clip(origin?.userMessage, this.config.runtime.maxMessageCharacters * 8),
      },
    }, now, participantId)
    this.reportStandalone('warn', '叙事模型请求失败，已安排自动重试：故事=%s 参与者=%s 第%d/%d次，%d秒后执行', storyId, participantId, attempt, maxAttempts, delaySeconds)
    return true
  }

  /**
   * Retries are a recovery mechanism for one failed foreground turn, never a
   * second source of conversation. Cancel them as soon as that relationship
   * receives a newer message or completes a later writing turn.
   */
  private async cancelNarrativeRetries(storyId: string, participantId: string, now: Date, reason: string, excludedIds: number[] = []) {
    if (!participantId) return 0
    const pending = await this.ctx.database.get('interlude_intent', { storyId, participantId, status: 'pending' })
    const excluded = new Set(excludedIds)
    const retries = pending.filter(intent => intent.type === 'narrative-retry' && !excluded.has(intent.id))
    if (!retries.length) return 0
    await this.dbSet('interlude_intent', { id: { $in: retries.map(intent => intent.id) } }, { status: 'cancelled', updatedAt: now })
    this.reportStandaloneOperation('diagnostic', 'info', '已取消失效叙事重试 故事=%s 参与者=%s 数量=%d 原因=%s', storyId, participantId, retries.length, reason)
    return retries.length
  }

  /**
   * Compatibility guard for retry rows created before the explicit cleanup
   * path existed. Once a later turn has advanced the story cursor past the
   * retry's creation point, its original user event is already settled.
   */
  private async discardObsoleteNarrativeRetries(story: InterludeStory, intents: NarrativeIntent[], now: Date) {
    const stale = intents.filter(intent => intent.type === 'narrative-retry'
      && story.cursorAt.getTime() >= intent.createdAt.getTime())
    if (!stale.length) return intents
    await this.dbSet('interlude_intent', { id: { $in: stale.map(intent => intent.id) } }, { status: 'cancelled', updatedAt: now })
    this.reportOperation('standard', 'info', story, 'intent-due',
      '已跳过过期叙事重试 数量=%d：剧本游标已覆盖原失败回合', stale.length)
    const staleIds = new Set(stale.map(intent => intent.id))
    return intents.filter(intent => !staleIds.has(intent.id))
  }

  private async dueIntents(storyId: string, now: Date) {
    const intents = await this.ctx.database.get('interlude_intent', { storyId, status: 'pending' }, {
      sort: { notBefore: 'asc' },
    })
    const splitHeadIds = new Set(pendingSplitMessageHeads(intents).map(intent => intent.id))
    return intents.filter(intent => intent.notBefore <= now
      && !isActiveConsequence(intent)
      && (intent.type !== 'split-message' || splitHeadIds.has(intent.id)))
  }

  /** Wake the scheduler close to a short typing delay instead of waiting for
   * the normal background sweep. The due intent remains the source of truth. */
  private scheduleDueIntentWake(storyId: string, notBefore: Date) {
    const delay = Math.max(0, notBefore.getTime() - Date.now())
    const existing = this.dueIntentWakeTimers.get(storyId)
    // Several <sep/> segments can be scheduled at once. Keep the earliest
    // wake-up; the next due segment schedules the following wake as needed.
    if (existing && existing.dueAt <= notBefore.getTime()) return
    if (existing) existing.cancel()
    const wake = () => {
      this.dueIntentWakeTimers.delete(storyId)
      // A long narrative request can overlap the simulated typing delay. Keep
      // the intent pending and retry shortly after the scheduler is free,
      // rather than waiting for the next normal sweep.
      if (this.databaseResetting) return
      void (async () => {
        const due = await this.dueIntents(storyId, new Date())
        // Split segments are already committed transport events. Deliver them
        // through the story queue directly; do not make them wait for the
        // five-minute sweep or start another narrator request.
        if (due.length && due.every(intent => intent.type === 'split-message')) {
          await this.deliverDueSplitSegments(storyId)
          return
        }
        if (this.sweepRunning || this.hasPendingNarrative(storyId)) {
          const retryAt = Date.now() + Time.second
          const retry = this.ctx.setTimeout(wake, Time.second)
          this.dueIntentWakeTimers.set(storyId, { cancel: retry, dueAt: retryAt })
          return
        }
        await this.sweep()
      })().catch(error => this.serviceLogger.debug('到期消息唤醒失败：%s', error))
    }
    const timer = this.ctx.setTimeout(wake, delay)
    this.dueIntentWakeTimers.set(storyId, { cancel: timer, dueAt: notBefore.getTime() })
    this.reportStandaloneOperation('standard', 'info', '已设置到期计时器 故事=%s 触发时间=%s 等待=%dms', storyId, formatLogTime(notBefore, 'Asia/Shanghai'), delay)
  }

  private async scheduleNextSplitWake(storyId: string) {
    const pending = await this.ctx.database.get('interlude_intent', { storyId, status: 'pending' }, {
      sort: { notBefore: 'asc' },
    })
    const next = pendingSplitMessageHeads(pending)
      .sort((left, right) => left.notBefore.getTime() - right.notBefore.getTime())[0]
    if (next) this.scheduleDueIntentWake(storyId, next.notBefore)
  }

  /** If a scheduler pause made several segments overdue, only the next index
   * in this same turn receives a fresh typing delay. Later indices stay
   * blocked behind it regardless of their older absolute timestamps. */
  private async restoreNextSplitDelay(storyId: string, delivered: NarrativeIntent, now: Date) {
    const pending = await this.ctx.database.get('interlude_intent', {
      storyId, status: 'pending', type: 'split-message', participantId: delivered.participantId,
    }, { sort: { createdAt: 'asc' } })
    const turnEntryId = Number(delivered.payload?.turnEntryId) || 0
    const sameTurn = pending.filter(intent => {
      const candidateTurnId = Number(intent.payload?.turnEntryId) || 0
      return turnEntryId ? candidateTurnId === turnEntryId : candidateTurnId === 0
    })
    const next = pendingSplitMessageHeads(sameTurn)[0]
    if (!next || next.notBefore > now) return
    const content = clip(next.payload?.content, this.config.runtime.maxMessageCharacters)
    if (!content) return
    await this.dbSet('interlude_intent', { id: next.id }, {
      notBefore: new Date(now.getTime() + this.typingDelayMilliseconds(content)), updatedAt: now,
    })
  }

  /** Deliver already-decided <sep/> segments without invoking the narrator. */
  private async deliverDueSplitSegments(storyId: string) {
    const result = await this.serial(storyId, async () => {
      const story = await this.getStory(storyId)
      const now = new Date()
      const due = (await this.dueIntents(storyId, now))
        .filter(intent => intent.type === 'split-message')
        .sort((left, right) => left.notBefore.getTime() - right.notBefore.getTime())
      const next = due[0]
      const messages: OutgoingMessageDraft[] = []
      if (next) {
        const intent = next
        const content = clip(intent.payload?.content, this.config.runtime.maxMessageCharacters)
        const participant = intent.participantId ? await this.getParticipant(intent.participantId) : undefined
        if (!content || !participant || participant.status !== 'active') {
          await this.dbSet('interlude_intent', { id: intent.id }, { status: 'cancelled', updatedAt: now })
        } else {
          await this.dbSet('interlude_intent', { id: intent.id }, { status: 'completed', updatedAt: now })
          messages.push({
            participantId: participant.id, content,
            metadata: {
              visible: true, splitSegment: true,
              turnEntryId: Number(intent.payload?.turnEntryId) || undefined,
              turnPhase: intent.payload?.turnPhase,
            },
          })
        }
      }
      // When several segments became overdue together, restore a fresh
      // typing interval instead of immediately draining the backlog.
      if (next) await this.restoreNextSplitDelay(storyId, next, now)
      await this.scheduleNextSplitWake(storyId)
      return { story, messages }
    })
    if (result.messages.length) await this.sendScheduledMessages(result.story, result.messages)
    // A scene transition may be waiting for every segment of the same
    // committed reply to leave the transport queue. Re-run maintenance after
    // delivery so the old scene can be archived without waiting for a sweep.
    this.scheduleCompaction(storyId)
  }

  private async cancelPendingOutgoingMessages(storyId: string, participantId: string, now: Date) {
    const intents = await this.ctx.database.get('interlude_intent', { storyId, status: 'pending' })
    const matching = intents.filter(intent =>
      intent.participantId === participantId
      && (intent.type === 'delayed-reply' || intent.type === 'cross-conversation-message' || intent.type === 'split-message'))
    if (!matching.length) return matching

    await this.dbSet('interlude_intent', { id: { $in: matching.map(intent => intent.id) } }, {
      status: 'cancelled',
      updatedAt: now,
    })
    const wake = this.dueIntentWakeTimers.get(storyId)
    if (wake) {
      wake.cancel()
      this.dueIntentWakeTimers.delete(storyId)
    }
    await this.scheduleNextSplitWake(storyId)
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
    const participants = await Promise.all(ids.map(id => current?.id === id ? Promise.resolve(current) : this.getParticipant(id)))
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
        this.reportOperation('standard', 'info', story, 'intent-due', '消息投递开始 参与者=%s', target.id)
        if (this.config.logging?.logMessageContent) {
          this.report('info', story, 'intent-due', '主角消息内容：%s', message.content.slice(0, this.config.logging.previewLength))
        }
        if (session && current?.id === target.id) {
          await session.send(message.content)
          await this.recordDeliveredOutgoingMessage(story, target, message)
          continue
        }
        const bot = this.findBotForParticipant(target)
        if (!bot) {
          this.report('warn', story, 'intent-due', '没有可用机器人账号投递消息 参与者=%s', target.id)
          continue
        }
        await bot.sendMessage(target.channelId, message.content)
        await this.recordDeliveredOutgoingMessage(story, target, message)
      } catch (error) {
        this.report('warn', story, 'intent-due', '消息投递失败 参与者=%s 错误=%s', target.id, error)
        const interaction = isRecord(message.metadata?.interaction) ? message.metadata.interaction : undefined
        const decisionAt = toDate(message.metadata?.decisionAt)
        if (interaction?.seen === true && decisionAt) {
          // Sending failed, but the model did see the source message. Only clear
          // unread state up to that decision; a newer user event must survive.
          try {
            const latest = await this.getParticipant(target.id)
            if (latest) await this.markParticipantSeenThrough(latest, decisionAt, new Date())
          } catch (stateError) {
            this.serviceLogger.debug('消息失败后的已读状态写入跳过：%s', stateError)
          }
        }
      }
    }
  }

  /** Write the visible-message fact only after the adapter has accepted the send. */
  private async recordDeliveredOutgoingMessage(story: InterludeStory, participant: InterludeParticipant, message: OutgoingMessageDraft) {
    const now = new Date()
    const decisionAt = toDate(message.metadata?.decisionAt) ?? now
    try {
      await this.serial(story.id, async () => {
        const currentParticipant = await this.getParticipant(participant.id)
        if (!currentParticipant) return
        await this.appendEntry(story.id, {
          kind: 'character-message', actor: 'character', content: message.content,
          occurredAt: now.toISOString(), metadata: { visible: true, delivery: 'delivered', deliveredAt: now.toISOString(), ...(message.metadata ?? {}) },
        }, now, currentParticipant.id)
        await this.recordCharacterMessage(currentParticipant, now, decisionAt)
      })
    } catch (error) {
      // The adapter already accepted this message. A transient SQLite issue
      // must not turn that completed delivery into a transport failure.
      this.serviceLogger.debug('可见消息投递记录写入跳过：%s', error)
    }
  }

  private splitOutgoingMessage(content: string) {
    if (this.config.runtime.splitReplyMessages === false) return [content]
    const separator = this.config.runtime.messageSeparator?.trim() || '<sep/>'
    if (!separator || !content.includes(separator)) return [content]
    return content.split(separator).map(part => part.trim()).filter(Boolean)
  }

  private typingDelayMilliseconds(nextSegment: string) {
    const baseSeconds = Math.max(0, this.config.runtime.typingBaseDelaySeconds ?? 1)
    const charactersPerSecond = Math.max(1, this.config.runtime.typingCharactersPerSecond ?? 8)
    const maximumSeconds = Math.max(baseSeconds, this.config.runtime.typingMaxDelaySeconds ?? 12)
    const seconds = Math.min(maximumSeconds, baseSeconds + Math.ceil(nextSegment.length / charactersPerSecond))
    return seconds * Time.second
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
      followUpMinutes: normalizeFollowUpMinutes(runtime.conversationFollowUpMinutes),
      followUpJitterMinutes: Math.max(0, Math.min(10, runtime.conversationFollowUpJitterMinutes ?? 1)),
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

  private dueConversationFollowUps(story: InterludeStory, now: Date) {
    const planned = (story.state.automation?.conversationFollowUpAt ?? [])
      .map(toDate)
      .filter((value): value is Date => !!value)
      .sort((left, right) => left.getTime() - right.getTime())
    return planned.filter(value => value <= now)
  }

  /** Remove elapsed short passes after their single writing turn. The next
   * remaining pass stays persisted, so reloads never restart the 10/20-minute
   * sequence or accidentally run both passes at once. */
  private async completeConversationFollowUps(storyId: string, processed: Date[], now: Date) {
    const story = await this.getStory(storyId)
    const completed = new Set(processed.map(value => value.toISOString()))
    const remaining = (story.state.automation?.conversationFollowUpAt ?? [])
      .map(toDate)
      // Remove only the pass that this narrator request actually processed.
      // If the request itself took a long time and the later 20-minute pass
      // became due meanwhile, keep that final pass so it can still apply the
      // small Hook patch rather than being silently skipped.
      .filter((value): value is Date => !!value && !completed.has(value.toISOString()))
      .sort((left, right) => left.getTime() - right.getTime())
    const automation = {
      ...(story.state.automation ?? {}),
      conversationFollowUpAt: remaining.map(value => value.toISOString()),
      ...(remaining.length ? {} : { conversationFollowUpParticipantId: undefined }),
      nextAdvanceAt: remaining[0]?.toISOString(),
    }
    await this.dbSet('interlude_story', { id: story.id }, { state: { ...story.state, automation }, updatedAt: now })
    return remaining.length > 0
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
    // Cancel the old post-conversation cadence as soon as a new message
    // arrives. The new cadence is set after this turn has actually decided
    // whether it replies now, later, or not at all.
    const story = await this.getStory(storyId)
    const fallbackNext = new Date(now.getTime() + automaticIntervalMinutes(story, now, this.autoAdvanceConfig) * Time.minute)
    const automation = {
      ...(story.state.automation ?? {}),
      conversationFollowUpAt: [],
      conversationFollowUpParticipantId: undefined,
      quietUntil: undefined,
      lastUserMessageAt: now.toISOString(),
      lastConversationActivityAt: now.toISOString(),
      // Covers group-gate silence and provider failures: no old short timer
      // may fire while this fresh conversation event is still unresolved.
      nextAdvanceAt: fallbackNext.toISOString(),
    }
    await this.dbSet('interlude_story', { id: story.id }, { state: { ...story.state, automation }, updatedAt: now })
  }

  private async pauseAutomaticAdvanceAfterDelayedReply(storyId: string, now: Date, participantId = '') {
    await this.scheduleConversationFollowUpsAfterTurn(storyId, now, undefined, participantId)
  }

  /** Schedule the 10/20-minute aftermath passes from the actual endpoint of
   * a conversation. A delayed reply anchors them after its planned send time. */
  private async scheduleConversationFollowUpsAfterTurn(storyId: string, now: Date, rawInteraction?: NarrativeInteraction, participantId = '') {
    const config = this.autoAdvanceConfig
    if (!config.enabled) return
    const story = await this.getStory(storyId)
    const interaction = rawInteraction ? normalizeInteraction(rawInteraction, now, this.config.runtime) : undefined
    const delayedUntil = interaction?.reply.mode === 'delayed' ? toDate(interaction.reply.sendAt) : undefined
    const anchor = delayedUntil && delayedUntil > now ? delayedUntil : now
    // Sleep/rest windows keep their low-frequency cadence: do not wake the
    // story twice in twenty minutes merely because a conversation ended near
    // bedtime.
    const followUps = activeRestWindow(config.restWindows, story.setting.timezone, anchor)
      ? []
      : scheduleConversationFollowUps(anchor, config)
    const normalNext = followUps.at(-1) ?? new Date(anchor.getTime() + automaticIntervalMinutes(story, anchor, config) * Time.minute)
    const automation = {
      ...(story.state.automation ?? {}),
      // Follow-ups are the only special post-conversation schedule. Regular
      // 40-minute cadence resumes after the final short pass, not from every
      // incoming message.
      quietUntil: undefined,
      lastConversationActivityAt: now.toISOString(),
      conversationFollowUpAt: followUps.map(value => value.toISOString()),
      conversationFollowUpParticipantId: followUps.length ? participantId || undefined : undefined,
      nextAdvanceAt: normalNext.toISOString(),
    }
    await this.dbSet('interlude_story', { id: story.id }, { state: { ...story.state, automation }, updatedAt: now })
    this.reportOperation('standard', 'info', story, 'conversation-follow-up', '已更新对话后续计划 短期补写=%s 常规推进=%s',
      followUps.length ? followUps.map(value => formatLogTime(value, story.setting.timezone)).join('、') : '无',
      formatLogTime(normalNext, story.setting.timezone))
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
      conversationFollowUpAt: [],
      conversationFollowUpParticipantId: undefined,
      lastAutoAdvanceAt: now.toISOString(),
      nextAdvanceAt: nextAdvanceAt.toISOString(),
    }
    await this.dbSet('interlude_story', { id: story.id }, { state: { ...story.state, automation }, updatedAt: now })
    this.reportOperation('standard', 'info', story, 'advance', '已设置下次自动推进 时间=%s 间隔=%d分钟', formatLogTime(nextAdvanceAt, story.setting.timezone), intervalMinutes)
  }

  private get sharedStoryConfig(): SharedStoryConfig {
    const { enabled: _legacyEnabled, ...overrides } = this.config.sharedStory ?? {}
    return {
      // Beta2 deliberately keeps the single-story guard hard-enabled. Older
      // builds exposed a rollback switch here, but turning it off could create
      // fresh per-account stories that a later background sweep would revive.
      enabled: true,
      autoEnrollParticipants: true,
      allowCrossConversationMessages: true,
      shareParticipantDetails: false,
      maxCrossConversationActions: 1,
      participantContextLimit: 6,
      managerAccounts: [],
      participantPresets: [],
      ...overrides,
    }
  }

  private mainModelLabel() {
    const modelId = this.config.model.mainModelId?.trim()
    const profile = modelId ? this.config.model.models?.find(item => item.enabled !== false && item.id === modelId) : undefined
    const provider = profile
      ? this.config.model.providers.find(item => item.id === profile.providerId)
      : this.config.model.providers.find(item => item.enabled)
    const providerLabel = provider?.label?.trim() || provider?.id || ''
    const model = profile?.label?.trim() || profile?.model || provider?.model || '未配置'
    return providerLabel ? `${providerLabel}/${model}` : model
  }

  private groupGateModelLabel() {
    const config = this.config.model.groupGate
    const modelId = config?.modelId?.trim()
    const profile = modelId ? this.config.model.models?.find(item => item.enabled !== false && item.id === modelId) : undefined
    const provider = profile
      ? this.config.model.providers.find(item => item.id === profile.providerId)
      : this.config.model.providers.find(item => item.id === config?.providerId) ?? this.config.model.providers.find(item => item.enabled)
    const providerLabel = provider?.label?.trim() || provider?.id || ''
    const model = profile?.label?.trim() || profile?.model || config?.model || provider?.model || '未配置'
    return providerLabel ? `${providerLabel}/${model}` : model
  }

  private participantPreset(userId: string) {
    return (this.sharedStoryConfig.participantPresets ?? []).find(preset =>
      preset.enabled !== false && normalizeAccountId(preset.qq) === normalizeAccountId(userId))
  }

  /** The clean Canon used both by story creation and a full administrative reset. */
  private initialStorySetting(name?: string): StorySetting {
    const setting = emptyStorySetting()
    const defaults = this.config.storyDefaults
    setting.character.name = name?.trim() || defaults.characterName || setting.character.name
    setting.character.profile = defaults.characterProfile
    setting.user.displayName = 'Multiple participants'
    setting.user.profile = defaults.userProfile
    setting.relationship = defaults.relationship
    setting.world = defaults.world
    setting.supportingCast = defaults.supportingCast
    setting.location = defaults.location
    setting.style = defaults.style || setting.style
    setting.timezone = defaults.timezone || setting.timezone
    return setting
  }

  /** Rebuild per-account relationship baselines and discard evolving state. */
  private async resetParticipantCanon(storyId: string, now: Date) {
    const participants = await this.dbGet('interlude_participant', { storyId })
    for (const participant of participants) {
      const account = this.userAccountRule(participant.userId)
      const preset = this.participantPreset(participant.userId)
      await this.dbSet('interlude_participant', { id: participant.id }, {
        personId: account?.personId?.trim() || preset?.personId?.trim() || participant.personId || participant.userId,
        displayName: account?.label?.trim() || preset?.label?.trim() || participant.displayName || participant.userId,
        profile: account?.profile?.trim() || preset?.profile?.trim() || this.config.storyDefaults.userProfile,
        relationship: account?.relationship?.trim() || preset?.relationship?.trim() || this.config.storyDefaults.relationship,
        state: emptyParticipantState(),
        updatedAt: now,
      })
    }
  }

  private userAccountRule(userId: string) {
    const accounts = this.config.onebot?.userAccounts ?? []
    const normalized = normalizeAccountId(userId)
    return accounts.find(account => account.enabled !== false && normalizeAccountId(account.qq) === normalized)
  }

  private async getParticipant(id: string) {
    return (await this.dbGet('interlude_participant', { id }))[0]
  }

  private async recordIncomingMessage(participant: InterludeParticipant, now: Date) {
    const current = normalizeParticipantState(participant.state)
    const state: ParticipantState = {
      ...current,
      unreadMessageCount: current.unreadMessageCount + 1,
      pendingReplyCount: current.pendingReplyCount + 1,
      lastUserMessageAt: now.toISOString(),
    }
    await this.dbSet('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  private async markParticipantSeen(participant: InterludeParticipant, now: Date) {
    const current = normalizeParticipantState(participant.state)
    const state: ParticipantState = { ...current, unreadMessageCount: 0 }
    await this.dbSet('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  /** Clear only the unread state that existed when this decision was made. */
  private async markParticipantSeenThrough(participant: InterludeParticipant, decisionAt: Date, now: Date) {
    const current = normalizeParticipantState(participant.state)
    const lastUserMessageAt = toDate(current.lastUserMessageAt)
    if (lastUserMessageAt && lastUserMessageAt > decisionAt) return participant
    return this.markParticipantSeen(participant, now)
  }

  private async recordCharacterMessage(participant: InterludeParticipant, now: Date, decisionAt = now) {
    const current = normalizeParticipantState(participant.state)
    // The transport callback can be queued behind a brand-new incoming
    // message. Do not erase that newer unread/pending state merely because an
    // earlier outgoing message finished its database bookkeeping afterwards.
    const newerUserMessage = toDate(current.lastUserMessageAt)
    const preserveNewerUserState = !!newerUserMessage && newerUserMessage > decisionAt
    const state: ParticipantState = {
      ...current,
      unreadMessageCount: preserveNewerUserState ? current.unreadMessageCount : 0,
      pendingReplyCount: preserveNewerUserState ? current.pendingReplyCount : 0,
      lastCharacterMessageAt: now.toISOString(),
    }
    await this.dbSet('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    return { ...participant, state, updatedAt: now }
  }

  private async updateParticipantState(participant: InterludeParticipant, patch: Partial<ParticipantState>, now: Date) {
    const state = mergeParticipantState(normalizeParticipantState(participant.state), patch)
    await this.dbSet('interlude_participant', { id: participant.id }, { state, updatedAt: now })
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
      await this.dbCreate('interlude_story', story)
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
      'interlude_scene', 'interlude_arc', 'interlude_fact', 'interlude_state_patch', 'interlude_overlay_snapshot', 'interlude_web_observation',
    ] as const
    for (const table of tables) await this.dbSet(table, { storyId: legacy.id }, { storyId: story.id } as any)
    // The old story only had one user, so account-bound records can safely be
    // attached to that initial relationship branch during migration.
    for (const table of ['interlude_script_entry', 'interlude_memory', 'interlude_intent', 'interlude_fact', 'interlude_state_patch', 'interlude_overlay_snapshot', 'interlude_web_observation'] as const) {
      await this.dbSet(table, { storyId: story.id }, { participantId: participant.id } as any)
    }
    await this.dbSet('interlude_story', { id: legacy.id }, { status: 'archived', updatedAt: now })
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
    for (const table of ['interlude_script_entry', 'interlude_memory', 'interlude_intent', 'interlude_fact', 'interlude_state_patch', 'interlude_overlay_snapshot', 'interlude_web_observation'] as const) {
      await this.dbSet(table, { storyId: legacy.id }, { storyId: story.id, participantId: participant.id } as any)
    }
    await this.dbSet('interlude_story', { id: legacy.id }, { status: 'archived', updatedAt: now })
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
      factLimit: this.config.runtime.memoryLimit,
      factContentCharacters: 4_000,
      factImportanceWeight: 0.5,
      factConfidenceWeight: 0.35,
      factRecencyWeight: 0.15,
      semanticWeight: 0.55,
      unresolvedWeight: 0.2,
      statePatchConfidenceThreshold: 0.82,
      majorStatePatchConfidenceThreshold: 0.95,
      statePatchMinEvidence: 3,
      statePatchMinTurns: 3,
      statePatchMinDays: 2,
      statePatchCooldownHours: 72,
      autoApplyStatePatches: true,
      allowMajorStateChanges: true,
      maxFactsPerStory: 200,
      activeConsequencesEnabled: true,
      activeConsequencePromptLimit: 6,
      activeConsequenceMaxDays: 7,
      activeConsequenceDefaultStrength: 0.55,
      relationshipMomentEnabled: true,
      relationshipMomentDefaultHours: 24,
      relationshipMomentMaxHours: 168,
      overlayCompressionEnabled: true,
      overlayRecentDays: 2,
      overlayMonthlyAfterDays: 10,
      overlayWeeklyWindowDays: 5,
      overlayMonthlyWindowDays: 10,
      overlayWeeklySummaryCharacters: 1_600,
      overlayMonthlySummaryCharacters: 2_400,
      storyHookRefreshAdvances: 4,
      storyHookPatchAfterConversation: true,
      storyHookFullRefreshIdleMinutes: 240,
      ...(this.config.memory ?? {}),
    }
  }

  private get browserConfig(): BrowserConfig {
    const merged: BrowserConfig = {
      enabled: false,
      mode: 'deferred-only',
      allowSearch: true,
      allowVisit: true,
      searchUrlTemplate: 'https://html.duckduckgo.com/html/?q={query}',
      allowedDomains: [],
      blockedDomains: [],
      maxConcurrentPages: 1,
      maxResearchPerSweep: 1,
      navigationTimeout: 15_000,
      waitUntil: 'domcontentloaded',
      maxTextCharacters: 12_000,
      maxExcerptCharacters: 3_000,
      maxObservationsInPrompt: 4,
      cacheMinutes: 30,
      allowGroupTriggeredResearch: false,
      logObservationPreview: false,
      ...(this.config.browser ?? {}),
    }
    // Schema defaults cover Console input, but old YAML and programmatic
    // callers can still provide undefined/invalid numeric fields. Normalise
    // here so one malformed browser option cannot silently disable all due
    // research or break the page semaphore.
    return {
      ...merged,
      maxConcurrentPages: Math.max(1, Math.min(4, Number(merged.maxConcurrentPages) || 1)),
      maxResearchPerSweep: Math.max(1, Math.min(20, Number(merged.maxResearchPerSweep) || 1)),
      navigationTimeout: Math.max(1_000, Number(merged.navigationTimeout) || 15_000),
      maxTextCharacters: Math.max(500, Number(merged.maxTextCharacters) || 12_000),
      maxExcerptCharacters: Math.max(200, Number(merged.maxExcerptCharacters) || 3_000),
      maxObservationsInPrompt: Math.max(1, Math.min(20, Number(merged.maxObservationsInPrompt) || 4)),
      cacheMinutes: Math.max(0, Number(merged.cacheMinutes) || 0),
    }
  }

  private async ensureContinuity(story: InterludeStory, now: Date) {
    // 每个故事始终应有一个活动场景和一个活动弧线。旧数据升级或手动关闭场景后，
    // 此方法负责补齐它们，并把 id 缓存在 story.state 供 Console/外部工具查看。
    let arc = await this.activeArc(story.id)
    if (!arc) {
      await this.dbCreate('interlude_arc', {
        storyId: story.id, status: 'active', title: 'Beginning', summary: '', sceneCount: 0,
        createdAt: now, updatedAt: now,
      })
      arc = await this.activeArc(story.id)
    }
    let scene = await this.activeScene(story.id)
    if (!scene) {
      await this.dbCreate('interlude_scene', {
        storyId: story.id, status: 'active', startedAt: now, endedAt: null,
        hook: '', summary: '', entryCount: 0, lastEntryId: null, createdAt: now, updatedAt: now,
      })
      scene = await this.activeScene(story.id)
      if (arc) await this.dbSet('interlude_arc', { id: arc.id }, { sceneCount: arc.sceneCount + 1, updatedAt: now })
    }
    if (arc && scene && (story.state.activeArcId !== arc.id || story.state.activeSceneId !== scene.id)) {
      const state = { ...story.state, activeArcId: arc.id, activeSceneId: scene.id }
      await this.dbSet('interlude_story', { id: story.id }, { state, updatedAt: now })
    }
  }

  private scheduleCompaction(storyId: string) {
    if (this.scheduledCompactions.has(storyId)) return
    this.scheduledCompactions.add(storyId)
    if (!this.memoryConfig.enabled) {
      // Scene boundaries remain a core narration concern even when optional
      // long-term memory extraction is disabled. This path performs only the
      // local boundary switch and never calls the compaction model.
      void this.serial(storyId, async () => {
        await this.finalizeSceneTransitionWithoutCompaction(await this.getStory(storyId), new Date())
      }).catch(error => this.serviceLogger.debug('无记忆模式场景转场跳过：%s', error))
        .finally(() => this.scheduledCompactions.delete(storyId))
      return
    }
    this.reportStandaloneOperation('diagnostic', 'debug', '记忆整理已排队 故事=%s', storyId)
    const run = () => {
      if (this.databaseResetting) {
        this.scheduledCompactions.delete(storyId)
        return
      }
      // Let an active or debounced user turn go first. This keeps compaction
      // fully off the latency-sensitive path even during a busy conversation.
      if (this.hasPendingNarrative(storyId)) {
        this.reportStandaloneOperation('diagnostic', 'debug', '记忆整理等待前台回合结束 故事=%s', storyId)
        this.ctx.setTimeout(run, 500)
        return
      }
      void this.serial(storyId, async () => {
        if (this.hasPendingNarrative(storyId)) return
        await this.compactUnlocked(await this.getStory(storyId), new Date(), false)
      }).catch(error => this.serviceLogger.debug('记忆压缩跳过：%s', error))
        .finally(() => this.scheduledCompactions.delete(storyId))
    }
    run()
  }

  private async finalizeSceneTransitionWithoutCompaction(story: InterludeStory, now: Date) {
    const transition = normalizeStoryState(story.state).sceneTransitionPending
    if (!transition?.sourceEntryId) return false
    const pending = await this.ctx.database.get('interlude_intent', {
      storyId: story.id, status: 'pending', type: 'split-message',
    })
    if (pending.some(intent => Number(intent.payload?.turnEntryId) === transition.sourceEntryId)) return false
    const scene = await this.activeScene(story.id)
    if (!scene) return false
    const endedAt = toDate(transition.requestedAt) ?? now
    await this.dbSet('interlude_scene', { id: scene.id }, {
      status: 'closed', endedAt: endedAt <= now ? endedAt : now, updatedAt: now,
    })
    await this.ensureContinuity(story, new Date(Math.min(endedAt.getTime(), now.getTime()) + 1))
    const refreshed = await this.getStory(story.id)
    await this.dbSet('interlude_story', { id: story.id }, {
      state: { ...normalizeStoryState(refreshed.state), sceneTransitionPending: undefined }, updatedAt: now,
    })
    this.reportOperation('standard', 'info', story, 'advance', '场景转场完成：长期记忆已关闭，保留原文场景边界')
    return true
  }

  private async compactStories() {
    if (!this.memoryConfig.enabled || this.compactionSweepRunning) return
    this.compactionSweepRunning = true
    try {
      const story = await this.getCanonicalStory()
      if (!story || !this.canHandleStory(story)) return
      this.scheduleFactEmbeddingBackfill(story.id)
      this.scheduleCompaction(story.id)
    } finally {
      this.compactionSweepRunning = false
    }
  }

  private async compactUnlocked(story: InterludeStory, now: Date, force: boolean) {
    await this.ensureContinuity(story, now)
    const overlayCompacted = await this.compactOverlayUnlocked(story, now)
    const scene = await this.activeScene(story.id)
    if (!scene) return overlayCompacted
    const transitionPending = normalizeStoryState(story.state).sceneTransitionPending
    if (transitionPending?.sourceEntryId) {
      const pendingTransport = await this.ctx.database.get('interlude_intent', {
        storyId: story.id,
        status: 'pending',
        type: 'split-message',
      })
      const sameTurnStillSending = pendingTransport.some(intent =>
        Number(intent.payload?.turnEntryId) === transitionPending.sourceEntryId)
      if (sameTurnStillSending) {
        this.reportOperation('diagnostic', 'debug', story, 'advance',
          '场景归档等待同一回合的分段消息投递完成 源条目=%d', transitionPending.sourceEntryId)
        return overlayCompacted
      }
    }
    // lastEntryId 将场景摘要变成增量检查点：已经压缩过的原文不再重复传给模型。
    const entryFilter: any = { storyId: story.id, occurredAt: { $gte: scene.startedAt } }
    const idRange: Record<string, number> = {}
    if (scene.lastEntryId != null) idRange.$gt = scene.lastEntryId
    // A transition has an immutable script-row boundary. Entries arriving
    // while its split bubbles are still being delivered belong to the next
    // scene and must never be absorbed into the archive being closed.
    if (transitionPending?.sourceEntryId) idRange.$lte = transitionPending.sourceEntryId
    if (Object.keys(idRange).length) entryFilter.id = idRange
    const entries = await this.ctx.database.get('interlude_script_entry', entryFilter, {
      limit: Math.max(this.memoryConfig.compactionEntryLimit * 2, this.memoryConfig.compactionEntryLimit),
      sort: { occurredAt: 'asc' },
    })
    const sceneEntries = limitEntriesByCharacters(entries, this.memoryConfig.compactionCharacterLimit)
    const chars = sceneEntries.reduce((sum, entry) => sum + entry.content.length, 0)
    // 任一阈值达到即可压缩；手动命令可以 force，用于调试或故事阶段转换。
    if (!force && !transitionPending && sceneEntries.length < this.memoryConfig.sceneEntryThreshold && chars < this.memoryConfig.sceneCharacterThreshold) {
      this.reportOperation('diagnostic', 'debug', story, 'advance', '记忆整理跳过：未达到阈值 条目=%d/%d 字符=%d/%d', sceneEntries.length, this.memoryConfig.sceneEntryThreshold, chars, this.memoryConfig.sceneCharacterThreshold)
      return overlayCompacted
    }
    const current = await this.getStory(story.id)
    if (transitionPending?.sourceEntryId
      && !sceneEntries.length
      && (scene.lastEntryId ?? 0) >= transitionPending.sourceEntryId
      && !!scene.summary.trim()) {
      // The incremental archive already reached this transition in an earlier
      // maintenance batch. Close locally instead of paying for an empty
      // compactor request.
      const transitionAt = toDate(transitionPending.requestedAt)
      await this.persistCompaction(current, scene, { scene: { close: true } }, [], now, transitionAt ?? undefined)
      this.reportOperation('standard', 'info', story, 'advance', '场景归档完成：复用已生成摘要，无需额外模型调用')
      return true
    }
    const participants = await this.participants(story.id)
    const visibleCompactionEntries = (this.sharedStoryConfig.shareParticipantDetails
      ? sceneEntries
      : sceneEntries.map(entry => entry.participantId
        // Narrator prose is the protagonist's shared life and remains useful
        // after account identifiers are removed. Exact participant transport
        // text stays private unless explicit sharing is enabled.
        ? entry.kind === 'script'
          ? { ...entry, participantId: '' }
          : { ...entry, participantId: '', content: '[participant-specific transport content omitted by privacy setting]' }
        : entry))
      .filter(entry => !!entry.content.trim())
    const visibleCompactionFacts = this.sharedStoryConfig.shareParticipantDetails
      ? await this.facts(story.id, this.memoryConfig.maxFactsPerStory)
      : (await this.facts(story.id, this.memoryConfig.maxFactsPerStory)).filter(fact => !fact.participantId)
    let decision: CompactionDecision = {}
    const startedAt = Date.now()
    this.reportOperation('standard', 'info', story, 'advance', '记忆整理开始 条目=%d 字符=%d 强制=%s', sceneEntries.length, chars, force)
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
    const compactedThroughId = sceneEntries.at(-1)?.id ?? scene.lastEntryId ?? 0
    const reachedTransition = !transitionPending?.sourceEntryId
      || compactedThroughId >= transitionPending.sourceEntryId
    if (transitionPending) {
      const archivedSummary = decision.scene?.summary?.trim() || scene.summary.trim()
      if (archivedSummary && reachedTransition) {
        decision.scene = { ...(decision.scene ?? {}), close: true }
      } else {
        decision.scene = { ...(decision.scene ?? {}), close: false }
        this.reportOperation('standard', archivedSummary ? 'info' : 'warn', story, 'advance',
          archivedSummary
            ? '场景转场分批整理中：当前压缩尚未到达转场边界'
            : '场景转场暂缓：压缩模型未返回旧场景摘要，下次后台整理将重试')
      }
    } else if (decision.scene?.close) {
      // The compactor archives; it does not author life transitions. Only a
      // scene change already written and declared by the main narrator may
      // close the active source window.
      decision.scene = { ...decision.scene, close: false }
    }
    const transitionAt = transitionPending ? toDate(transitionPending.requestedAt) : undefined
    await this.persistCompaction(current, scene, decision, sceneEntries, now, transitionAt ?? undefined)
    if (transitionPending && !decision.scene?.close && !reachedTransition && sceneEntries.length) {
      // scheduledCompactions is still occupied until this task returns; defer
      // the next incremental archive just past that cleanup point.
      this.ctx.setTimeout(() => this.scheduleCompaction(story.id), 50)
    }
    this.reportOperation('standard', 'info', story, 'advance', '记忆整理完成 耗时=%dms 剧本条目=%d 长期事实=%d 状态变更=%d', Date.now() - startedAt, sceneEntries.length, decision.facts?.length ?? 0, decision.statePatches?.length ?? 0)
    return true
  }

  /** Older state patches are compacted only by the background maintenance
   * lane. Live turns always retain the last few days as raw detail. */
  private async compactOverlayUnlocked(story: InterludeStory, now: Date) {
    const config = this.memoryConfig
    if (!config.overlayCompressionEnabled) return false
    try {
    const recentCutoff = new Date(now.getTime() - (config.overlayRecentDays ?? 2) * Time.day)
    const monthlyCutoff = new Date(now.getTime() - (config.overlayMonthlyAfterDays ?? 10) * Time.day)
    const applied = await this.dbGet('interlude_state_patch', { storyId: story.id, status: 'applied' }, { sort: { appliedAt: 'asc' } }) as StatePatchProposal[]
    const weekly = applied.filter(patch => (patch.appliedAt ?? patch.createdAt) <= recentCutoff)
    let changed = false
    for (const group of groupOverlayPatches(weekly, config.overlayWeeklyWindowDays ?? 5)) {
      const existing = (await this.dbGet('interlude_overlay_snapshot', {
        storyId: story.id, participantId: group.participantId, target: group.target, tier: 'weekly', periodStart: group.from,
      }))[0] as OverlaySnapshot | undefined
      if (existing) continue
      const participant = group.participantId ? await this.getParticipant(group.participantId) : undefined
      const decision = await this.compactor.compactOverlay({ story, participant, target: group.target, tier: 'weekly', from: group.from, to: group.to, patches: group.patches })
      const summary = clip(decision.summary, config.overlayWeeklySummaryCharacters ?? 1_600)
      if (!summary) continue
      await this.dbCreate('interlude_overlay_snapshot', {
        storyId: story.id, participantId: group.participantId, target: group.target, tier: 'weekly', periodStart: group.from, periodEnd: group.to,
        summary, majorEvents: normalizeMajorEvents(decision.majorEvents, group.patches), sourcePatchIds: group.patches.map(patch => patch.id), status: 'active', createdAt: now, updatedAt: now,
      })
      for (const patch of group.patches) await this.dbSet('interlude_state_patch', { id: patch.id }, { status: 'compacted' })
      changed = true
    }

    const snapshots = await this.dbGet('interlude_overlay_snapshot', { storyId: story.id, tier: 'weekly', status: 'active' }, { sort: { periodEnd: 'asc' } }) as OverlaySnapshot[]
    for (const group of groupOverlaySnapshots(snapshots.filter(snapshot => snapshot.periodEnd <= monthlyCutoff), config.overlayMonthlyWindowDays ?? 10)) {
      const existing = (await this.dbGet('interlude_overlay_snapshot', {
        storyId: story.id, participantId: group.participantId, target: group.target, tier: 'monthly', periodStart: group.from,
      }))[0] as OverlaySnapshot | undefined
      if (existing) continue
      const participant = group.participantId ? await this.getParticipant(group.participantId) : undefined
      const decision = await this.compactor.compactOverlay({ story, participant, target: group.target, tier: 'monthly', from: group.from, to: group.to, patches: [], snapshots: group.snapshots })
      const summary = clip(decision.summary, config.overlayMonthlySummaryCharacters ?? 2_400)
      if (!summary) continue
      await this.dbCreate('interlude_overlay_snapshot', {
        storyId: story.id, participantId: group.participantId, target: group.target, tier: 'monthly', periodStart: group.from, periodEnd: group.to,
        summary, majorEvents: normalizeMajorEvents(decision.majorEvents, [], group.snapshots), sourcePatchIds: group.snapshots.flatMap(snapshot => snapshot.sourcePatchIds), status: 'active', createdAt: now, updatedAt: now,
      })
      for (const snapshot of group.snapshots) await this.dbSet('interlude_overlay_snapshot', { id: snapshot.id }, { status: 'superseded', updatedAt: now })
      changed = true
    }
    if (changed) {
      await this.rebuildLiveOverlayState(story, now)
      this.reportOperation('standard', 'info', story, 'advance', 'Overlay 分层归档完成：最近 %d 天保留原始补丁，短期窗口=%d天，长期窗口=%d天', config.overlayRecentDays ?? 2, config.overlayWeeklyWindowDays ?? 5, config.overlayMonthlyWindowDays ?? 10)
    }
    return changed
    } catch (error) {
      // Overlay maintenance is optional background work. A bad compression
      // response must leave raw patches untouched and never block narration.
      this.reportOperation('standard', 'warn', story, 'advance', 'Overlay 分层归档跳过：%s', error)
      return false
    }
  }

  private async overlaySnapshotsForPrompt(storyId: string, participantId?: string, background = false) {
    if (!this.memoryConfig.overlayCompressionEnabled) return [] as OverlaySnapshot[]
    const rows = await this.dbGet('interlude_overlay_snapshot', { storyId, status: 'active' }, { sort: { periodEnd: 'desc' } }) as OverlaySnapshot[]
    const visible = rows.filter(snapshot => !snapshot.participantId || (background ? this.sharedStoryConfig.shareParticipantDetails : snapshot.participantId === participantId))
    // Current long-term state plus recent short-window deltas is sufficient; older
    // snapshots remain searchable/auditable without permanently taxing prompts.
    const result: OverlaySnapshot[] = []
    for (const target of ['character', 'world', 'relationship'] as const) {
      const matches = visible.filter(snapshot => snapshot.target === target)
      const monthly = matches.find(snapshot => snapshot.tier === 'monthly')
      if (monthly) result.push(monthly)
      result.push(...matches.filter(snapshot => snapshot.tier === 'weekly').slice(0, 4))
    }
    return result
  }

  /** Once a snapshot safely represents older changes, keep state.overlay as
   * the live (uncompacted) delta only. This is what actually reduces prompt
   * size; snapshots carry the older evolution separately. */
  private async rebuildLiveOverlayState(story: InterludeStory, now: Date) {
    const [applied, snapshots] = await Promise.all([
      this.dbGet('interlude_state_patch', { storyId: story.id, status: 'applied' }) as Promise<StatePatchProposal[]>,
      this.dbGet('interlude_overlay_snapshot', { storyId: story.id, status: 'active' }) as Promise<OverlaySnapshot[]>,
    ])
    const overlay = { ...(story.state.settingOverlay ?? {}) }
    const hasGlobalHistory = (target: StatePatchProposal['target']) => snapshots.some(snapshot => snapshot.target === target && !snapshot.participantId)
    if (hasGlobalHistory('character')) {
      overlay.characterProfile = undefined
      overlay.characterTraits = []
      for (const patch of applied.filter(item => !item.participantId && item.target === 'character')) {
        if (patch.path.includes('trait')) overlay.characterTraits.push(clip(patch.proposedValue, 500))
        else overlay.characterProfile = mergeNote(overlay.characterProfile, patch.proposedValue)
      }
      overlay.characterTraits = Array.from(new Set(overlay.characterTraits)).slice(-30)
    }
    if (hasGlobalHistory('world')) {
      overlay.world = undefined
      for (const patch of applied.filter(item => !item.participantId && item.target === 'world')) overlay.world = mergeNote(overlay.world, patch.proposedValue)
    }
    if (hasGlobalHistory('relationship')) {
      overlay.relationship = undefined
      for (const patch of applied.filter(item => !item.participantId && item.target === 'relationship')) overlay.relationship = mergeNote(overlay.relationship, patch.proposedValue)
    }
    await this.dbSet('interlude_story', { id: story.id }, { state: { ...story.state, settingOverlay: overlay }, updatedAt: now })

    const participantIds = Array.from(new Set(snapshots.filter(snapshot => snapshot.target === 'relationship' && !!snapshot.participantId).map(snapshot => snapshot.participantId)))
    for (const participantId of participantIds) {
      const participant = await this.getParticipant(participantId)
      if (!participant) continue
      const state = normalizeParticipantState(participant.state)
      state.relationshipOverlay = undefined
      for (const patch of applied.filter(item => item.target === 'relationship' && item.participantId === participantId)) {
        state.relationshipOverlay = mergeNote(state.relationshipOverlay, patch.proposedValue)
      }
      await this.dbSet('interlude_participant', { id: participant.id }, { state, updatedAt: now })
    }
  }

  private async persistCompaction(story: InterludeStory, scene: InterludeScene, decision: CompactionDecision, entries: ScriptEntry[], now: Date, transitionAt?: Date) {
    // 摘要更新成功后才移动 lastEntryId，确保失败时原始条目仍会在下次被重新处理。
    const scenePatch = decision.scene ?? {}
    await this.dbSet('interlude_scene', { id: scene.id }, {
      hook: clip(scenePatch.hook ?? scene.hook, this.memoryConfig.sceneHookCharacters),
      summary: clip(scenePatch.summary ?? scene.summary, this.memoryConfig.sceneSummaryCharacters),
      entryCount: 0, lastEntryId: entries.at(-1)?.id ?? scene.lastEntryId, updatedAt: now,
    })
    if (scenePatch.close) {
      const endedAt = transitionAt && transitionAt <= now ? transitionAt : now
      await this.dbSet('interlude_scene', { id: scene.id }, { status: 'closed', endedAt, updatedAt: now })
      // Start one millisecond after the closing script row. Scene membership
      // is time-based in the existing schema, so this prevents the boundary
      // row from appearing in both old and new scenes.
      await this.ensureContinuity(story, new Date(endedAt.getTime() + 1))
      const refreshed = await this.getStory(story.id)
      const refreshedState = normalizeStoryState(refreshed.state)
      await this.dbSet('interlude_story', { id: story.id }, {
        state: { ...refreshedState, sceneTransitionPending: undefined }, updatedAt: now,
      })
    }
    const arc = await this.activeArc(story.id)
    if (arc && decision.arc) {
      await this.dbSet('interlude_arc', { id: arc.id }, {
        title: clip(decision.arc.title ?? arc.title, 255), summary: clip(decision.arc.summary ?? arc.summary, this.memoryConfig.arcSummaryCharacters), updatedAt: now,
      })
    }
    for (const fact of decision.facts ?? []) {
      if (!hasCompactionEvidence(fact.sourceEntryIds, entries)) continue
      await this.persistFact(story.id, fact, entries, now)
    }
    for (const patch of decision.statePatches ?? []) {
      if (!hasCompactionEvidence(patch.sourceEntryIds, entries)) continue
      await this.persistStatePatch(story, patch, entries, now)
    }
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
      await this.dbSet('interlude_fact', { id: same.id }, {
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
      if (oldest) await this.dbSet('interlude_fact', { id: oldest.id }, { status: 'superseded', updatedAt: now })
    }
    await this.dbCreate('interlude_fact', {
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
    // `modelId` selects a model preset and is the preferred Console path.  The
    // previous check looked only at the legacy free-form `model`, so a valid
    // preset silently disabled historical-fact backfill.
    const hasEmbeddingModel = !!(embedding?.modelId?.trim() || embedding?.model?.trim())
    if (!embedding?.enabled || !hasEmbeddingModel || batchSize <= 0) return
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
      if (embedding.length) await this.dbSet('interlude_fact', { id: fact.id }, { embedding, updatedAt: new Date() })
    }
  }

  private async persistStatePatch(story: InterludeStory, draft: StatePatchDraft, entries: ScriptEntry[], now: Date) {
    const confidence = clampNumber(draft.confidence, 0, 0, 1)
    const participantId = resolveParticipantId(draft.participantId, draft.sourceEntryIds, entries)
    const path = clip(draft.path, 255)
    const sourceEntryIds = (draft.sourceEntryIds ?? []).filter(id => entries.some(entry => entry.id === id)).slice(0, 20)
    const proposedValue = clip(draft.proposedValue, 4_000)
    const impact = draft.impact === 'major' ? 'major' : 'minor'
    if (!path || !proposedValue || !sourceEntryIds.length) return

    // Merge repeated proposals for one setting path before evaluating them.
    const candidates = await this.dbGet('interlude_state_patch', {
      storyId: story.id, participantId, target: draft.target, path,
    }) as StatePatchProposal[]
    const matching = candidates.filter(candidate => patchClaimsMatch(candidate.proposedValue, proposedValue))
    if (matching.some(candidate => candidate.status === 'applied' || candidate.status === 'compacted')) return
    const candidate = matching.find(item => item.status === 'proposed')
    const mergedSourceEntryIds = Array.from(new Set([
      ...(candidate?.sourceEntryIds ?? []), ...sourceEntryIds,
    ])).slice(0, 80)
    const sourceRows = await this.dbGet('interlude_script_entry', {
      storyId: story.id, id: { $in: mergedSourceEntryIds },
    }) as ScriptEntry[]
    const evidence = statePatchEvidence(sourceRows, story.setting.timezone)
    const minimumTurns = Math.max(3, this.memoryConfig.statePatchMinTurns ?? this.memoryConfig.statePatchMinEvidence)
    const minimumDays = Math.max(1, this.memoryConfig.statePatchMinDays ?? 2)
    const minimum = impact === 'major' ? this.memoryConfig.majorStatePatchConfidenceThreshold : this.memoryConfig.statePatchConfidenceThreshold
    const mergedConfidence = Math.max(candidate?.confidence ?? 0, confidence)
    const mergedEvidenceText = mergeNote(candidate?.evidence, draft.evidence)
    const proposal = candidate ?? await this.dbCreate('interlude_state_patch', {
      storyId: story.id, participantId, target: draft.target, path, proposedValue,
      evidence: clip(mergedEvidenceText, 4_000), confidence: mergedConfidence, impact,
      status: 'proposed', sourceEntryIds: mergedSourceEntryIds, createdAt: now, appliedAt: null,
    })
    if (candidate?.id) {
      await this.dbSet('interlude_state_patch', { id: candidate.id }, {
        evidence: clip(mergedEvidenceText, 4_000), confidence: mergedConfidence, impact: candidate.impact === 'major' || impact === 'major' ? 'major' : 'minor', sourceEntryIds: mergedSourceEntryIds,
      })
    }

    // Ordinary changes require independent narrative turns on different days.
    if (!this.memoryConfig.autoApplyStatePatches || (impact === 'major' && !this.memoryConfig.allowMajorStateChanges)) return
    const stableEvidence = impact === 'major'
      ? mergedConfidence >= minimum
      : mergedConfidence >= minimum && evidence.turns >= minimumTurns && evidence.days >= minimumDays
    if (!stableEvidence) {
      this.reportOperation('diagnostic', 'debug', story, 'advance',
        'Overlay 候选继续累计 目标=%s/%s 回合=%d/%d 日期=%d/%d', draft.target, path, evidence.turns, minimumTurns, evidence.days, minimumDays)
      return
    }

    const cooldownHours = Math.max(1, this.memoryConfig.statePatchCooldownHours ?? 72)
    const recentApplied = candidates
      .filter(item => item.status === 'applied' || item.status === 'compacted')
      .map(item => item.appliedAt ?? item.createdAt)
      .sort((left, right) => right.getTime() - left.getTime())[0]
    if (recentApplied && now.getTime() - recentApplied.getTime() < cooldownHours * Time.hour) {
      this.reportOperation('diagnostic', 'debug', story, 'advance',
        'Overlay 冷却中，候选保留 目标=%s/%s 冷却=%d小时', draft.target, path, cooldownHours)
      return
    }

    const overlay = { ...(story.state.settingOverlay ?? {}) }
    if (draft.target === 'character') {
      if (draft.path.includes('trait')) overlay.characterTraits = Array.from(new Set([...(overlay.characterTraits ?? []), clip(draft.proposedValue, 500)])).slice(-30)
      else overlay.characterProfile = mergeNote(overlay.characterProfile, draft.proposedValue)
    } else if (draft.target === 'relationship' && participantId) {
      const participant = await this.getParticipant(participantId)
      if (participant) {
        const state = normalizeParticipantState(participant.state)
        await this.dbSet('interlude_participant', { id: participant.id }, {
          state: { ...state, relationshipOverlay: mergeNote(state.relationshipOverlay, draft.proposedValue) }, updatedAt: now,
        })
      }
    } else if (draft.target === 'relationship') overlay.relationship = mergeNote(overlay.relationship, draft.proposedValue)
    else overlay.world = mergeNote(overlay.world, draft.proposedValue)
    if (draft.target !== 'relationship' || !participantId) {
      const state = { ...story.state, settingOverlay: overlay }
      await this.dbSet('interlude_story', { id: story.id }, { state, updatedAt: now })
    }
    if (proposal?.id) await this.dbSet('interlude_state_patch', { id: proposal.id }, { status: 'applied', appliedAt: now })
  }

  private report(level: 'error' | 'warn' | 'info' | 'debug', story: InterludeStory, phase: NarrativeRequest['phase'], message: string, ...args: unknown[]) {
    this.writeReport(level, story, phase, message, args)
  }

  /** Emit an operational record only when the selected verbosity includes it.
   * Summary is for outcomes, standard is for scheduler/model activity, and
   * diagnostic is for skip reasons and internal counters. */
  private reportOperation(verbosity: 'summary' | 'standard' | 'diagnostic', level: 'error' | 'warn' | 'info' | 'debug', story: InterludeStory, phase: NarrativeRequest['phase'], message: string, ...args: unknown[]) {
    if (!this.allowsVerbosity(verbosity)) return
    this.writeReport(level, story, phase, message, args)
  }

  private writeReport(level: 'error' | 'warn' | 'info' | 'debug', story: InterludeStory, phase: NarrativeRequest['phase'], message: string, args: unknown[]) {
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
    this.writeStandalone(level, message, args)
  }

  private reportStandaloneOperation(verbosity: 'summary' | 'standard' | 'diagnostic', level: 'error' | 'warn' | 'info' | 'debug', message: string, ...args: unknown[]) {
    if (!this.allowsVerbosity(verbosity)) return
    this.writeStandalone(level, message, args)
  }

  private writeStandalone(level: 'error' | 'warn' | 'info' | 'debug', message: string, args: unknown[]) {
    const rank = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
    const configuredLevel = this.config.logging?.level ?? 'info'
    if (rank[configuredLevel] < rank[level]) return
    const output = `生命周期：${message}`
    if (level === 'error') this.serviceLogger.error(output, ...args as any[])
    else if (level === 'warn') this.serviceLogger.warn(output, ...args as any[])
    else if (level === 'info') this.serviceLogger.info(output, ...args as any[])
    else this.serviceLogger.debug(output, ...args as any[])
  }

  private allowsVerbosity(required: 'summary' | 'standard' | 'diagnostic') {
    const rank = { summary: 1, standard: 2, diagnostic: 3 }
    const configured = this.config.logging?.verbosity ?? 'standard'
    return rank[configured] >= rank[required]
  }

  private async getStory(id: string) {
    const story = (await this.dbGet('interlude_story', { id }))[0]
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

  private dbWrite<T>(task: () => Promise<T>) {
    const run = this.databaseWriteQueue.then(() => this.retryDbWrite(task), () => this.retryDbWrite(task))
    this.databaseWriteQueue = run.catch(() => undefined)
    return run
  }

  /**
   * A SQLite/sql.js read can fail during the same short filesystem hiccup as a
   * write. Reads stay concurrent for normal performance; only transient driver
   * errors receive a small bounded retry instead of aborting a user turn.
   */
  private async dbRead<T>(task: () => Promise<T>) {
    const delays = [50, 125, 250]
    for (let attempt = 0; ; attempt++) {
      try {
        return await task()
      } catch (error) {
        if (attempt >= delays.length || !isTransientDatabaseError(error)) {
          if (isTransientDatabaseError(error)) {
            this.serviceLogger.warn('SQLite 读取连续失败，已停止重试：%s', error)
          }
          throw error
        }
        const delay = delays[attempt] + Math.floor(Math.random() * 25)
        this.serviceLogger.debug('SQLite 读取暂时失败，%dms 后重试（第 %d 次）：%s', delay, attempt + 1, error)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  private dbGet(table: string, query: unknown, options?: unknown): Promise<any[]> {
    return this.dbRead(() => this.ctx.database.get(table as never, query as never, options as never) as Promise<any[]>)
  }

  private async retryDbWrite<T>(task: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await task()
      } catch (error) {
        // sql.js/SQLite may briefly report disk I/O or locking errors while
        // Koishi flushes its in-memory database. A short retry is useful, but
        // logging every transient attempt as a warning makes normal file
        // flush contention look like a fatal HDSI failure. Keep the retry
        // bounded, add a little jitter, and only warn on the final failure.
        if (attempt >= 7 || !isTransientDatabaseError(error)) {
          if (isTransientDatabaseError(error)) {
            this.serviceLogger.warn('SQLite 写入连续失败，已停止重试：%s', error)
          }
          throw error
        }
        const delays = [100, 250, 500, 1_000, 2_000, 3_000, 5_000]
        const baseDelay = delays[attempt] ?? 5_000
        const delay = baseDelay + Math.floor(Math.random() * Math.min(250, baseDelay / 4))
        this.serviceLogger.debug('SQLite 写入暂时失败，%dms 后重试（第 %d 次）：%s', delay, attempt + 1, error)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  private dbCreate(table: string, data: unknown): Promise<any> {
    return this.dbWrite(async () => {
      try {
        return await this.ctx.database.create(table as never, data as never)
      } catch (error) {
        // sql.js can report disk I/O after SQLite has already committed an
        // INSERT. Before retrying, look for the same logical row; this keeps a
        // transient flush error from creating duplicate split-message intents,
        // script entries, or memories.
        if (!isTransientDatabaseError(error)) throw error
        const existing = await this.findPossiblyCommittedCreate(table, data)
        if (existing) return existing
        throw error
      }
    })
  }

  private async findPossiblyCommittedCreate(table: string, data: unknown) {
    if (!isRecord(data)) return undefined
    const storyId = typeof data.storyId === 'string' ? data.storyId : ''
    if (!storyId) return undefined
    const rows = await this.dbGet(table, { storyId }, { limit: 100 })
    return rows.find(row => {
      if (table === 'interlude_intent') {
        return row.participantId === data.participantId
          && row.type === data.type
          && row.summary === data.summary
          && sameTimestamp(row.notBefore, data.notBefore)
          && JSON.stringify(row.payload ?? {}) === JSON.stringify(data.payload ?? {})
      }
      if (table === 'interlude_script_entry') {
        return row.participantId === data.participantId
          && row.kind === data.kind
          && row.actor === data.actor
          && row.content === data.content
          && sameTimestamp(row.occurredAt, data.occurredAt)
      }
      if (table === 'interlude_memory') {
        return row.participantId === data.participantId
          && row.category === data.category
          && row.content === data.content
          && sameTimestamp(row.createdAt, data.createdAt)
      }
      return typeof data.id === 'string' && row.id === data.id
    })
  }

  private dbSet(table: string, query: unknown, data: unknown): Promise<any> {
    return this.dbWrite(() => this.ctx.database.set(table as never, query as never, data as never))
  }

  private dbRemove(table: string, query: unknown): Promise<any> {
    return this.dbWrite(() => this.ctx.database.remove(table as never, query as never))
  }

  /**
   * SQLite/sql.js may fail physical DELETE when its backing file is locked.
   * Fall back to redaction so an administrative purge still completes and the
   * removed content is no longer exposed to prompts or management commands.
   */
  private async purgeTable(table: string, query: unknown, fallback: unknown) {
    try {
      await this.dbRemove(table, query)
    } catch (error) {
      this.serviceLogger.warn('SQLite 物理删除失败，改用逻辑删除 表=%s 错误=%s', table, error)
      await this.dbSet(table, query, fallback)
    }
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

function extractSessionImageSources(session: Session) {
  const raw = String(session.content ?? '')
  const sources: string[] = []
  const add = (value: unknown, kind: 'url' | 'file' | 'adapter-url' = 'url') => {
    const source = String(value ?? '').trim()
    if (!source || sources.includes(source)) return
    if (source.length > 8 * 1024 * 1024) return
    if (/^https?:\/\//i.test(source)) sources.push(kind === 'adapter-url' ? `onebot-url:${source}` : source)
    else if (/^data:image\//i.test(source)) sources.push(source)
    else if (kind === 'file') sources.push(`onebot-file:${source}`)
  }
  const visit = (element: any) => {
    if (!element) return
    const type = String(element.type ?? '').toLowerCase()
    if (type === 'img' || type === 'image') {
      const src = element.attrs?.src ?? element.attrs?.url ?? element.data?.src ?? element.data?.url
      if (src) add(src)
      else add(element.attrs?.file ?? element.data?.file, 'file')
    }
    for (const child of element.children ?? []) visit(child)
  }
  // Session.elements is adapter-owned and can be reused or enriched by other
  // middleware. Parse this message's raw content only, otherwise an old image
  // element may be accidentally attached to a later text-only turn.
  try { for (const element of h.parse(raw) as any[]) visit(element) } catch {}
  if (!sources.length) {
    const pattern = /<(?:img|image)\b[^>]*(?:src|url)=["']([^"']+)["'][^>]*>/gi
    for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) add(match[1])
  }
  // OneBot/NapCat may leave a CQ image segment in the raw message instead of
  // converting it to an HTML image element. Prefer its CDN URL; if only the
  // file token is present, keep that token so the current bot can call
  // get_image(file) without trusting arbitrary user URLs.
  const cqPattern = /\[CQ:image,([^\]]+)\]/gi
  for (let match = cqPattern.exec(raw); match; match = cqPattern.exec(raw)) {
    const fields: Record<string, string> = {}
    for (const part of match[1].split(',')) {
      const index = part.indexOf('=')
      if (index > 0) fields[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim()
    }
    add(fields.url || fields.cache_url, 'adapter-url')
    if (!fields.url && !fields.cache_url) add(fields.file, 'file')
  }
  return sources
}

function guessImageMime(bytes: Buffer, hinted?: unknown) {
  const hint = String(hinted ?? '').toLowerCase()
  if (hint.startsWith('image/')) return hint
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return ''
}

function isAnimatedImageMime(mime: string) {
  return mime === 'image/gif' || mime === 'image/webp' || mime === 'image/apng'
}

function sessionGroupId(session: Session) {
  const raw = String((session as any).guildId || session.channelId || '')
  return normalizeGroupId(raw)
}

function normalizeGroupId(value: string) {
  return String(value || '').trim().replace(/^(?:group|guild):/i, '')
}

function mentionsBot(session: Session) {
  const selfId = normalizeAccountId(session.selfId)
  const content = String(session.content || '')
  if (!selfId) return false
  return content.includes(selfId) || new RegExp(`<at[^>]+id=["']?${selfId}["']?`, 'i').test(content)
}

function normalizeGroupReply(raw: NarrativeDecision['groupReply'], maxCharacters: number) {
  if (!raw || raw.mode !== 'immediate') return ''
  return clip(raw.content, Math.max(1, maxCharacters))
}

/** Treat OneBot transport aliases as one administrator-facing platform family. */
function samePlatformFamily(left: string | undefined, right: string | undefined) {
  if (isOneBotPlatform(left) && isOneBotPlatform(right)) return true
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
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
    'conversation-follow-up': '对话后续',
    advance: '自动推进',
    'intent-due': '到期意图',
  } as Record<NarrativeRequest['phase'], string>)[phase] ?? phase
}

function formatLogTime(value: Date | null | undefined, timezone: string) {
  if (!value || Number.isNaN(value.getTime())) return '-'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || 'UTC', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(value)
  } catch {
    return value.toISOString()
  }
}

/** A stable local calendar key used only for factual selection. It keeps
 * “last night” anchored to the character's timezone rather than UTC dates. */
function storyLocalDateKey(value: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(value)
    const pick = (type: string) => parts.find(part => part.type === type)?.value ?? ''
    const year = pick('year')
    const month = pick('month')
    const day = pick('day')
    if (year && month && day) return `${year}-${month}-${day}`
  } catch {}
  return value.toISOString().slice(0, 10)
}

function isTransientDatabaseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /disk\s*i\/o|database is locked|busy|unable to open/i.test(message)
}

function isEnabledAccount(accounts: OneBotAccountRule[] | undefined, qq: string) {
  const normalized = normalizeAccountId(qq)
  if (!normalized) return false
  return (accounts ?? []).some(account => account.enabled !== false && normalizeAccountId(account.qq) === normalized)
}

/**
 * Build the small, source-addressable ledger of observed participant events.
 * Baseline profile/relationship and durable facts travel through their own
 * non-duplicated prompt layers. A live or short follow-up turn can use the
 * exact inbound messages that actually happened.
 */
function collectParticipantKnownFacts(
  phase: NarrativeRequest['phase'], participant: InterludeParticipant | null, entries: ScriptEntry[],
  from: Date, now: Date, limit: number, characterBudget: number,
) {
  const selected: ParticipantKnownFact[] = []
  let remaining = Math.max(600, characterBudget)
  const add = (fact: ParticipantKnownFact) => {
    if (!fact.fact.trim() || selected.length >= limit || fact.fact.length > remaining) return
    if (selected.some(item => item.id === fact.id)) return
    selected.push(fact)
    remaining -= fact.fact.length
  }
  // Current events are already supplied verbatim. The logical-turn cards
  // carry settled historical messages for a conversation-follow-up, so this
  // separate participant-fact channel never revives old messages as fresh
  // events.
  const includeExactMessages = phase === 'user-message' || phase === 'intent-due'
  const messageKinds = new Set(['user-message', 'group-message'])
  const messages = includeExactMessages ? entries.filter(entry => messageKinds.has(entry.kind)
    && entry.occurredAt >= from && entry.occurredAt <= now
    && (!participant || !entry.participantId || entry.participantId === participant.id)
    && !!entry.content.trim()) : []
  // Add exact messages newest-first, then restore natural chronology in the
  // card list only through their timestamp. This gives a dense burst its real
  // material without inviting older model-written dialogue back into context.
  for (const entry of [...messages].reverse()) {
    add({
      id: `entry:${entry.id}`,
      participantId: entry.participantId || participant?.id || '',
      source: entry.occurredAt >= from ? 'current-event' : 'message',
      fact: entry.content,
      occurredAt: entry.occurredAt,
    })
  }

  return selected.sort((left, right) => (left.occurredAt?.getTime() ?? 0) - (right.occurredAt?.getTime() ?? 0))
}

/** Keep only compact participant notes whose source ids were actually handed
 * to this exact model request. The script itself is intentionally untouched. */
function constrainParticipantEvidence(decision: NarrativeDecision, allowedEvidenceIds: Set<string>): NarrativeDecision {
  const retain = (items: SceneTrace['participantFacts']) => (items ?? []).map(item => ({
    fact: item.fact,
    evidenceIds: item.evidenceIds.filter(id => allowedEvidenceIds.has(id)),
  })).filter(item => item.evidenceIds.length)
  if (decision.sceneTrace?.participantFacts) {
    decision.sceneTrace = { ...decision.sceneTrace, participantFacts: retain(decision.sceneTrace.participantFacts) }
  }
  if (decision.storyHook?.participantMatters) {
    decision.storyHook = { ...decision.storyHook, participantMatters: retain(decision.storyHook.participantMatters) }
  }
  if (decision.storyHookPatch?.participantMatters) {
    decision.storyHookPatch = { ...decision.storyHookPatch, participantMatters: retain(decision.storyHookPatch.participantMatters) }
  }
  if (decision.relationshipMomentUpdate?.userSignal) {
    const evidenceIds = decision.relationshipMomentUpdate.userSignal.evidenceIds.filter(id => allowedEvidenceIds.has(id))
    decision.relationshipMomentUpdate = {
      ...decision.relationshipMomentUpdate,
      userSignal: evidenceIds.length ? { ...decision.relationshipMomentUpdate.userSignal, evidenceIds } : undefined,
    }
  }
  return decision
}

/** Keep the model's event acknowledgements tied to immutable database rows.
 * Missing results for the current batch receive a transport-grounded default,
 * so a short or loosely worded message can never disappear between turns. */
function constrainSceneEvidence(
  decision: NarrativeDecision,
  allowedEventIds: Set<string>,
  currentEventIds: Set<string>,
): NarrativeDecision {
  const normalized = normalizeSceneEventResults(decision.eventResults)
    .filter(result => allowedEventIds.has(result.eventId))
  const byId = new Map(normalized.map(result => [result.eventId, result]))
  const interaction = isRecord(decision.interaction) ? decision.interaction : undefined
  // If a provider omits per-message results, do not claim that every message
  // in a dense batch received an answer. The raw events remain in the scene;
  // "noticed" only says the turn incorporated them.
  const defaultStatus: SceneEventResult['status'] = interaction?.seen === false ? 'unseen' : 'noticed'
  for (const eventId of currentEventIds) {
    if (!byId.has(eventId)) byId.set(eventId, { eventId, status: defaultStatus })
  }
  return {
    ...decision,
    sceneState: normalizeSceneStateDecision(decision.sceneState),
    eventResults: [...byId.values()].slice(0, 50),
  }
}

function activeSceneEntryVisible(
  entry: ScriptEntry,
  participant: InterludeParticipant | null,
  phase: NarrativeRequest['phase'],
  shareParticipantDetails: boolean,
) {
  if (phase === 'advance' || shareParticipantDetails) return true
  // Group-triggered writing has no private participant object. Keep private
  // account transcripts out of that request while retaining global/group
  // scene prose and events.
  if (!participant) return phase === 'user-message' ? !entry.participantId : true
  if (entry.kind === 'group-message' || entry.kind === 'character-group-message') return false
  return !entry.participantId || entry.participantId === participant.id
}

function collectSceneEventState(entries: ScriptEntry[]) {
  const state = new Map<string, SceneEventResult>()
  const deliveredTurns = new Set(entries
    .filter(entry => entry.kind === 'character-message' && isDeliveredCharacterMessage(entry) && isRecord(entry.metadata))
    .map(entry => Number(entry.metadata.turnEntryId)).filter(Number.isFinite))
  for (const entry of entries) {
    if (entry.kind !== 'script' || !isRecord(entry.metadata)) continue
    for (const result of normalizeSceneEventResults(entry.metadata.eventResults)) {
      state.set(result.eventId, result.status === 'responded' && !deliveredTurns.has(entry.id)
        ? { ...result, status: 'noticed' }
        : result)
    }
  }
  return state
}

function toActiveSceneEntry(entry: ScriptEntry, eventState: Map<string, SceneEventResult>): ActiveSceneEntry | undefined {
  const id = `entry:${entry.id}`
  const base = {
    id, actor: entry.actor, participantId: entry.participantId || undefined,
    occurredAt: entry.occurredAt, content: entry.content,
  }
  if (entry.kind === 'script') {
    const trace = isRecord(entry.metadata) ? normalizeSceneTrace(entry.metadata.sceneTrace) : undefined
    return { ...base, type: 'script', exchange: trace?.exchange }
  }
  if (entry.kind === 'user-message' || entry.kind === 'group-message') {
    const result = eventState.get(id)
    return {
      ...base,
      type: entry.kind,
      // Selective group traffic is archived even when the cheap gate decides
      // it does not merit a main-narrator turn. Private messages always remain
      // pending until the protagonist actually handles them.
      eventStatus: result?.status ?? (entry.kind === 'group-message' ? 'absorbed' : 'pending'),
      eventEffect: result?.effect,
    }
  }
  if (entry.kind === 'character-message') {
    if (!isDeliveredCharacterMessage(entry)) return undefined
    return { ...base, type: 'character-message' }
  }
  if (entry.kind === 'character-group-message') return { ...base, type: 'character-group-message' }
  return undefined
}

/**
 * Build factual continuity cards from completed narrator turns.  A card is a
 * turn-level record, not a chat bubble: split messages are attached to their
 * source script only after the adapter confirms delivery.  This keeps the
 * writer aware of both the protagonist's immediately preceding life and the
 * real conversation outcome without replaying authored prose.
 */
function collectRecentLogicalTurns(entries: ScriptEntry[], participantId: string, limit: number, characterBudget: number) {
  const ordered = [...entries].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id - right.id)
  const candidates: RecentLogicalTurn[] = []
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]
    if (entry.kind !== 'script' || !isRecord(entry.metadata)) continue
    if (participantId && entry.participantId && entry.participantId !== participantId) continue
    const trace = normalizeSceneTrace(entry.metadata.sceneTrace)
    if (!trace) continue
    const phase = isNarrativePhase(entry.metadata.phase) ? entry.metadata.phase : 'advance'
    const turn = isRecord(entry.metadata.continuityTurn) ? entry.metadata.continuityTurn : {}
    const from = toDate(turn.from) ?? ordered.slice(0, index).reverse().find(item => item.kind === 'script')?.occurredAt ?? entry.occurredAt
    const userMessages = ordered
      .filter(item => (item.kind === 'user-message' || item.kind === 'group-message')
        && (!participantId || !item.participantId || item.participantId === participantId)
        && item.occurredAt >= from && item.occurredAt <= entry.occurredAt && !!item.content.trim())
      .map(item => item.content.trim())
    const deliveredMessages = ordered
      .filter(item => item.kind === 'character-message' && item.participantId === (participantId || entry.participantId)
        && isDeliveredTurnMessage(item, entry.id))
      .map(item => item.content.trim())
      .filter(Boolean)
    // Existing stories do not have turnEntryId metadata yet.  Until new
    // deliveries accumulate, attach their delivered bubbles to the nearest
    // preceding legacy script. This is intentionally upgrade-only; new rows
    // always use the explicit link above and never rely on timing guesses.
    const nextScriptAt = ordered.slice(index + 1).find(item => item.kind === 'script')?.occurredAt
    const characterMessages = deliveredMessages.length || isRecord(entry.metadata.continuityTurn)
      ? deliveredMessages
      : ordered
        .filter(item => item.kind === 'character-message' && item.participantId === (participantId || entry.participantId)
          && item.occurredAt >= entry.occurredAt && (!nextScriptAt || item.occurredAt < nextScriptAt)
          && isDeliveredCharacterMessage(item))
        .map(item => item.content.trim())
        .filter(Boolean)
    const interactionState = logicalTurnInteractionState(entry, characterMessages.length)
    // A due intent may send a message or resolve a plan without any newly
    // observed user input. Older retry bugs could leave such rows with a
    // model-authored exchange summary that looked like a fresh user event.
    // Keep their life state, but never let an ungrounded summary become
    // conversational evidence in a later prompt.
    const exchangeTrace = phase === 'intent-due' && !userMessages.length
      ? undefined
      : trace.exchange
    candidates.push({
      entryId: entry.id,
      participantId: entry.participantId,
      phase,
      occurredAt: entry.occurredAt,
      situation: trace.situation,
      focus: trace.focus ?? [],
      // Old entries predate the explicit actions field. Their concise detail
      // notes remain the best available life-state bridge during upgrade.
      actions: trace.actions?.length ? trace.actions : trace.details.slice(0, 2),
      anchors: trace.anchors ?? [],
      eventEffects: normalizeSceneEventResults(entry.metadata.eventResults)
        .filter(result => !!result.effect),
      details: trace.details,
      unfinished: trace.unfinished,
      userMessages,
      characterMessages,
      exchange: deliveryGroundedConversationTrace(exchangeTrace, userMessages, characterMessages, interactionState),
      interactionState,
      participantFacts: trace.participantFacts ?? [],
    })
  }

  // Cross-account contacts originate in another relationship's script, which
  // is intentionally hidden from this participant. The recipient still needs
  // a truthful record that a message was delivered, so expose a minimal
  // recipient-side card without leaking the source branch's scene details.
  if (participantId) {
    const knownTurnIds = new Set(candidates.map(card => card.entryId))
    const orphanDeliveries = new Map<number, ScriptEntry[]>()
    for (const entry of ordered) {
      const turnEntryId = isRecord(entry.metadata) ? Number(entry.metadata.turnEntryId) : 0
      if (entry.kind !== 'character-message' || entry.participantId !== participantId || !turnEntryId || knownTurnIds.has(turnEntryId) || !isDeliveredCharacterMessage(entry)) continue
      const group = orphanDeliveries.get(turnEntryId) ?? []
      group.push(entry)
      orphanDeliveries.set(turnEntryId, group)
    }
    for (const [entryId, messages] of orphanDeliveries) {
      const latest = messages.at(-1)!
      const first = messages[0]
      const phase = isRecord(first.metadata) && isNarrativePhase(first.metadata.turnPhase) ? first.metadata.turnPhase : 'intent-due'
      candidates.push({
        entryId, participantId, phase, occurredAt: latest.occurredAt,
        situation: '主角在自己的生活中向当前参与者发出了消息。',
        focus: ['relationship'], actions: ['已向当前参与者发送消息。'], anchors: [], eventEffects: [],
        details: [], unfinished: [], userMessages: [],
        characterMessages: messages.map(message => message.content.trim()).filter(Boolean),
        exchange: { responseMeaning: '主角已主动联系当前参与者。', status: 'answered' },
        interactionState: 'sent', participantFacts: [],
      })
    }
  }
  candidates.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.entryId - right.entryId)

  const selected: RecentLogicalTurn[] = []
  let remaining = Math.max(1_200, characterBudget)
  for (let index = candidates.length - 1; index >= 0 && selected.length < Math.max(1, limit) && remaining > 0; index--) {
    const card = fitLogicalTurnCard(candidates[index], remaining)
    const size = logicalTurnCardSize(card)
    if (!size) continue
    selected.unshift(card)
    remaining -= size
  }
  return selected
}

/** Recent proactive contacts are semantic history, not a throttle. They let
 * the narrator decide whether a new life event genuinely changes the reason
 * to reach out instead of re-sending the same check-in after every advance. */
function collectRecentProactiveContacts(entries: ScriptEntry[], participantId: string, now: Date) {
  const since = now.getTime() - 48 * Time.hour
  const selected: RecentProactiveContact[] = []
  const seen = new Set<string>()
  for (const entry of [...entries].sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id - left.id)) {
    if (entry.kind !== 'character-message' || entry.occurredAt.getTime() < since || !isDeliveredCharacterMessage(entry) || !isRecord(entry.metadata)) continue
    if (participantId && entry.participantId !== participantId) continue
    const contact = isRecord(entry.metadata.proactiveContact) ? entry.metadata.proactiveContact : undefined
    if (!contact) continue
    const meaning = typeof contact.meaning === 'string' ? clip(contact.meaning, 300) : ''
    if (!meaning) continue
    const key = `${entry.participantId}\u0000${meaning.toLocaleLowerCase().replace(/\s+/g, ' ')}`
    if (seen.has(key)) continue
    seen.add(key)
    selected.push({
      participantId: entry.participantId,
      occurredAt: entry.occurredAt,
      meaning,
      reason: typeof contact.reason === 'string' ? clip(contact.reason, 240) : undefined,
    })
    if (selected.length >= 8) break
  }
  return selected.reverse()
}

/**
 * Build a second, transcript-free continuity layer for the recent day.  The
 * newest logical cards already contain the immediate dialogue semantics;
 * these older scene facts preserve the surrounding life that made those
 * exchanges meaningful.  No prior prose or old chat bubble wording crosses
 * this boundary.
 */
function collectRecentLifeFacts(
  entries: ScriptEntry[], now: Date, hours: number, limit: number, characterBudget: number, timezone: string, excludeEntryIds: Set<number>,
) {
  const since = now.getTime() - hours * Time.hour
  const candidates: RecentLifeFact[] = []
  for (const entry of entries) {
    if (entry.occurredAt.getTime() < since || excludeEntryIds.has(entry.id) || !isRecord(entry.metadata)) continue
    const trace = normalizeSceneTrace(entry.metadata.sceneTrace)
    if (!trace) continue
    const phase = isNarrativePhase(entry.metadata.phase) ? entry.metadata.phase : 'advance'
    // A due intent has no incoming message of its own. Its model-written
    // summary must not be reused as evidence that the participant said
    // something again during an automatic or retry pass.
    const userMeaning = phase === 'intent-due' ? '' : trace.exchange?.userMeaning?.trim()
    candidates.push({
      entryId: entry.id,
      occurredAt: entry.occurredAt,
      phase,
      situation: trace.situation,
      focus: trace.focus ?? [],
      actions: trace.actions?.length ? trace.actions : trace.details.slice(0, 2),
      anchors: trace.anchors ?? [],
      eventEffects: normalizeSceneEventResults(entry.metadata.eventResults).filter(result => !!result.effect),
      details: trace.details,
      unfinished: trace.unfinished,
      // Older life cards may retain what a participant raised, but never a
      // model-drafted response. Immediate cards carry delivery-grounded reply
      // semantics when that information is needed.
      exchange: userMeaning ? { userMeaning, status: trace.exchange?.status === 'none' ? 'none' : 'open' } : undefined,
    })
  }
  // Keep at least one or two concrete anchors from every represented local
  // calendar day before filling the rest with the newest facts. A dense day
  // of chat can therefore not erase last night merely because its entries are
  // older than the latest twenty turns.
  const byLocalDay = new Map<string, RecentLifeFact[]>()
  for (const fact of candidates) {
    const day = storyLocalDateKey(fact.occurredAt, timezone)
    const bucket = byLocalDay.get(day) ?? []
    bucket.push(fact)
    byLocalDay.set(day, bucket)
  }
  const dayKeys = [...byLocalDay.keys()].sort()
  const anchorsPerDay = Math.max(1, Math.min(2, Math.floor(Math.max(1, limit) / Math.max(1, dayKeys.length))))
  const anchorIds = new Set<number>()
  for (const day of dayKeys) {
    const anchors = [...(byLocalDay.get(day) ?? [])]
      .sort((left, right) => lifeFactAnchorScore(right) - lifeFactAnchorScore(left)
        || right.occurredAt.getTime() - left.occurredAt.getTime())
      .slice(0, anchorsPerDay)
    for (const anchor of anchors) anchorIds.add(anchor.entryId)
  }
  const priority = [
    ...candidates.filter(fact => anchorIds.has(fact.entryId)).sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime()),
    ...[...candidates].reverse().filter(fact => !anchorIds.has(fact.entryId)),
  ]
  const selected: RecentLifeFact[] = []
  const selectedIds = new Set<number>()
  let remaining = Math.max(600, characterBudget)
  for (const candidate of priority) {
    if (selected.length >= Math.max(1, limit) || remaining <= 0 || selectedIds.has(candidate.entryId)) continue
    const fact = fitRecentLifeFact(candidate, remaining)
    const size = recentLifeFactSize(fact)
    if (!size) continue
    selected.push(fact)
    selectedIds.add(fact.entryId)
    remaining -= size
  }
  return selected.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
}

function lifeFactAnchorScore(fact: RecentLifeFact) {
  return fact.actions.length * 4
    + fact.anchors.length * 4
    + fact.eventEffects.length * 5
    + fact.unfinished.length * 5
    + fact.details.length * 2
    + (fact.exchange?.userMeaning ? 2 : 0)
    + Math.min(3, Math.floor((fact.situation.length + fact.details.join('').length) / 100))
}

function fitRecentLifeFact(fact: RecentLifeFact, remaining: number): RecentLifeFact {
  const text = (value: string, limit: number) => clip(value.replace(/\s+/g, ' ').trim(), limit)
  const list = (items: string[], itemLimit: number, count: number) => items.map(item => text(item, itemLimit)).filter(Boolean).slice(-count)
  const compact: RecentLifeFact = {
    ...fact,
    situation: text(fact.situation, 220),
    focus: fact.focus.slice(0, 4),
    actions: list(fact.actions, 150, 3),
    anchors: list(fact.anchors, 180, 5),
    eventEffects: fact.eventEffects.map(result => ({
      eventId: result.eventId, status: result.status, effect: text(result.effect ?? '', 180) || undefined,
    })).filter(result => result.effect).slice(0, 4),
    details: list(fact.details, 150, 5),
    unfinished: list(fact.unfinished, 180, 3),
    exchange: fact.exchange ? { userMeaning: text(fact.exchange.userMeaning ?? '', 180), status: fact.exchange.status } : undefined,
  }
  const maximum = Math.max(160, Math.min(500, remaining))
  while (recentLifeFactSize(compact) > maximum) {
    if (compact.details.length) compact.details.shift()
    else if (compact.anchors.length > 1) compact.anchors.shift()
    else if (compact.eventEffects.length > 1) compact.eventEffects.shift()
    else if (compact.unfinished.length > 1) compact.unfinished.shift()
    else if (compact.actions.length > 1) compact.actions.shift()
    else if (compact.exchange?.userMeaning && compact.exchange.userMeaning.length > 100) compact.exchange.userMeaning = text(compact.exchange.userMeaning, 100)
    else if (compact.situation.length > 100) compact.situation = text(compact.situation, Math.max(100, compact.situation.length - 60))
    else break
  }
  return compact
}

function recentLifeFactSize(fact: RecentLifeFact) {
  return fact.situation.length
    + fact.anchors.reduce((sum, item) => sum + item.length, 0)
    + fact.eventEffects.reduce((sum, item) => sum + (item.effect?.length ?? 0), 0)
    + fact.actions.reduce((sum, item) => sum + item.length, 0)
    + fact.details.reduce((sum, item) => sum + item.length, 0)
    + fact.unfinished.reduce((sum, item) => sum + item.length, 0)
    + (fact.exchange?.userMeaning?.length ?? 0)
}

function isDeliveredTurnMessage(entry: ScriptEntry, turnEntryId: number) {
  if (!isRecord(entry.metadata) || Number(entry.metadata.turnEntryId) !== turnEntryId) return false
  return isDeliveredCharacterMessage(entry)
}

function isDeliveredCharacterMessage(entry: ScriptEntry) {
  if (!isRecord(entry.metadata)) return false
  const delivery = entry.metadata.delivery
  if (delivery === 'pending' || delivery === 'failed' || typeof entry.metadata.deliveryFailedAt === 'string') return false
  return delivery === 'delivered' || !!toDate(entry.metadata.deliveredAt) || entry.metadata.visible === true
}

function logicalTurnInteractionState(entry: ScriptEntry, deliveredCount: number): RecentLogicalTurn['interactionState'] {
  if (deliveredCount) return 'sent'
  const interaction = isRecord(entry.metadata) && isRecord(entry.metadata.interaction) ? entry.metadata.interaction : undefined
  if (!interaction) return 'none'
  if (interaction.seen !== true) return 'unseen'
  const reply = isRecord(interaction.reply) ? interaction.reply : undefined
  if (!reply || reply.mode === 'none') return 'seen-no-reply'
  return reply.mode === 'delayed' ? 'scheduled' : 'none'
}

/**
 * Pre-refactor rows have no semantic exchange trace.  Keep their observed
 * user wording, but turn any delivered reply into a neutral delivery fact so
 * old short bubbles cannot become in-context wording examples after upgrade.
 */
function legacyConversationTrace(userMessages: string[], characterMessages: string[], status: RecentLogicalTurn['interactionState']) {
  const userMeaning = userMessages.length ? clip(userMessages.join(' / ').replace(/\s+/g, ' ').trim(), 220) : ''
  const responseMeaning = characterMessages.length
    ? '主角已向参与者作出可见回应；具体措辞以已投递聊天记录为准。'
    : ''
  if (!userMeaning && !responseMeaning && status === 'none') return undefined
  return {
    userMeaning: userMeaning || undefined,
    responseMeaning: responseMeaning || undefined,
    status: status === 'sent' ? 'answered' : status === 'seen-no-reply' || status === 'unseen' || status === 'scheduled' ? 'open' : 'none',
  } as const
}

/**
 * A writer may draft a reply before transport succeeds.  Later context must
 * never treat that draft as something the participant has already learned.
 * Keep the user's meaning in either case; expose the response meaning only
 * after the corresponding bubble is confirmed delivered.
 */
function deliveryGroundedConversationTrace(
  trace: SceneTrace['exchange'] | undefined,
  userMessages: string[],
  characterMessages: string[],
  status: RecentLogicalTurn['interactionState'],
) {
  if (characterMessages.length) return trace ?? legacyConversationTrace(userMessages, characterMessages, status)
  const userMeaning = trace?.userMeaning || (userMessages.length
    ? clip(userMessages.join(' / ').replace(/\s+/g, ' ').trim(), 220)
    : '')
  if (!userMeaning && status === 'none') return undefined
  return {
    userMeaning: userMeaning || undefined,
    openQuestions: trace?.openQuestions ?? [],
    status: status === 'seen-no-reply' ? 'acknowledged' : status === 'none' ? 'none' : 'open',
  } as const
}

/** Keep cards dense enough to preserve many complete turns.  The most useful
 * facts (current situation, completed actions, delivery state) survive first.
 * Delivered bubble text remains available for auditing, but is excluded from
 * the prompt budget so it cannot crowd out state or become a style example. */
function fitLogicalTurnCard(card: RecentLogicalTurn, remaining: number): RecentLogicalTurn {
  const text = (value: string, limit: number) => clip(value.replace(/\s+/g, ' ').trim(), limit)
  const list = (items: string[], itemLimit: number, count: number) => items.map(item => text(item, itemLimit)).filter(Boolean).slice(-count)
  const compact: RecentLogicalTurn = {
    ...card,
    situation: text(card.situation, 220),
    focus: card.focus.slice(0, 4),
    actions: list(card.actions, 150, 3),
    anchors: list(card.anchors, 180, 5),
    eventEffects: card.eventEffects.map(result => ({
      eventId: result.eventId, status: result.status, effect: text(result.effect ?? '', 180) || undefined,
    })).filter(result => result.effect).slice(0, 4),
    details: list(card.details, 140, 4),
    unfinished: list(card.unfinished, 160, 3),
    userMessages: list(card.userMessages, 240, 3),
    characterMessages: list(card.characterMessages, 220, 4),
    exchange: card.exchange ? {
      userMeaning: text(card.exchange.userMeaning ?? '', 220),
      responseMeaning: text(card.exchange.responseMeaning ?? '', 220),
      completedMoves: list(card.exchange.completedMoves ?? [], 180, 5),
      openQuestions: list(card.exchange.openQuestions ?? [], 180, 5),
      newMove: text(card.exchange.newMove ?? '', 220) || undefined,
      status: card.exchange.status,
    } : undefined,
    participantFacts: (card.participantFacts ?? []).map(item => ({
      fact: text(item.fact, 140), evidenceIds: item.evidenceIds.slice(0, 4),
    })).filter(item => item.fact).slice(0, 3),
  }
  const maximum = Math.max(180, Math.min(620, remaining))
  while (logicalTurnCardSize(compact) > maximum) {
    if (compact.details.length) compact.details.shift()
    else if (compact.anchors.length > 1) compact.anchors.shift()
    else if (compact.eventEffects.length > 1) compact.eventEffects.shift()
    else if (compact.participantFacts?.length) compact.participantFacts.shift()
    else if (compact.unfinished.length > 1) compact.unfinished.shift()
    else if (compact.userMessages.length > 1) compact.userMessages.shift()
    else if (compact.actions.length > 1) compact.actions.shift()
    else if (compact.situation.length > 120) compact.situation = text(compact.situation, Math.max(120, compact.situation.length - 60))
    else break
  }
  return compact
}

function logicalTurnCardSize(card: RecentLogicalTurn) {
  return card.situation.length
    + card.anchors.reduce((sum, item) => sum + item.length, 0)
    + card.eventEffects.reduce((sum, item) => sum + (item.effect?.length ?? 0), 0)
    + card.actions.reduce((sum, item) => sum + item.length, 0)
    + card.details.reduce((sum, item) => sum + item.length, 0)
    + card.unfinished.reduce((sum, item) => sum + item.length, 0)
    + card.userMessages.reduce((sum, item) => sum + item.length, 0)
    + (card.exchange?.userMeaning?.length ?? 0)
    + (card.exchange?.responseMeaning?.length ?? 0)
    + (card.exchange?.completedMoves ?? []).reduce((sum, item) => sum + item.length, 0)
    + (card.exchange?.openQuestions ?? []).reduce((sum, item) => sum + item.length, 0)
    + (card.exchange?.newMove?.length ?? 0)
    + (card.participantFacts ?? []).reduce((sum, item) => sum + item.fact.length, 0)
}

function latestNarrativeExcerpt(entries: ScriptEntry[], characterBudget: number) {
  const entry = [...entries].reverse().find(item => item.kind === 'script' && item.content.trim())
  if (!entry) return undefined
  return entry.content.length <= characterBudget
    ? entry.content
    : `[旧数据迁移摘录]${entry.content.slice(-characterBudget)}`
}

function fallbackSceneTrace(phase: NarrativeRequest['phase'], observedContext: string): SceneTrace {
  const observed = clip(observedContext.replace(/\s+/g, ' ').trim(), 800)
  return {
    situation: `${phaseLabel(phase)}已推进至本轮结束时间。`,
    focus: [],
    actions: [],
    anchors: [],
    details: observed ? [`本轮收到的外部事件：${observed}`] : [],
    unfinished: [],
  }
}

function isNarrativePhase(value: unknown): value is NarrativeRequest['phase'] {
  return value === 'advance' || value === 'conversation-follow-up' || value === 'user-message' || value === 'intent-due'
}

function normalizeDecision(raw: NarrativeDecision, from: Date, now: Date, permitMessages: boolean, runtime: RuntimeConfig, shared: SharedStoryConfig, currentParticipantId: string, permittedParticipantIds: Set<string>, phase: NarrativeRequest['phase'] = 'advance', memory?: MemoryConfig, refreshStoryHook = false, patchStoryHook = false) {
  const script = typeof raw?.script === 'string'
    ? raw.script.trim().slice(0, runtime.maxScriptCharacters)
    : ''
  // The only channel for a private reply is interaction. Automatic life
  // passes have no live participant event, so they cannot emit it at all.
  let interaction = phase === 'advance' ? undefined : normalizeInteraction(raw?.interaction, now, runtime)
  // `entries` used to be a second, model-controlled event channel. Incoming
  // and outgoing messages already have dedicated transport code; retaining
  // arbitrary entries is enough for non-chat narrative annotations only.
  // Script prose is the one narrative record for a turn. Chat transport has
  // its own persistence below, so model-defined entries are intentionally
  // ignored instead of becoming a second, ambiguous event channel.
  const entries: ScriptEntryDraft[] = []
  // Optional memories are model suggestions, not a source of truth.  Never
  // let a model turn an invented online contact into durable retrieval data.
  const memories = Array.isArray(raw?.memories)
    ? raw.memories.filter(validMemory).map(memory => ({ ...memory, participantId: permittedOrGlobal(memory.participantId, currentParticipantId, permittedParticipantIds) }))
    : []
  const intents = Array.isArray(raw?.intents) ? raw.intents
    .filter(intent => validIntent(intent, from, now, memory))
    .map(intent => ({ ...intent, participantId: permittedOrGlobal(intent.participantId, currentParticipantId, permittedParticipantIds) }))
    .slice(0, 8)
    : []
  const intentUpdates = normalizeIntentUpdates(raw?.intentUpdates)
  const browserIntents = Array.isArray(raw?.browserIntents)
    ? raw.browserIntents.map(normalizeBrowserIntentDraftLoose).filter((intent): intent is BrowserIntentDraft => !!intent).slice(0, 1)
    : []
  // Private replies use interaction.reply; cross-account contact uses the
  // explicit crossConversationActions field. The legacy `messages` array is
  // not accepted because it has no event semantics or delivery guarantee.
  const messages: OutgoingMessageDraft[] = []
  const proactive = phase === 'advance'
  const crossConversationActions = permitMessages && shared.allowCrossConversationMessages && Array.isArray(raw?.crossConversationActions)
    ? raw.crossConversationActions
      .map(action => normalizeConversationAction(action, runtime, permittedParticipantIds, currentParticipantId, now, proactive))
      .filter((action): action is NonNullable<ReturnType<typeof normalizeConversationAction>> => !!action)
      .slice(0, Math.max(0, shared.maxCrossConversationActions))
    : []
  const statePatch = isRecord(raw?.statePatch) ? pickParticipantStatePatch(raw.statePatch) : undefined
  const sceneTrace = normalizeSceneTrace(raw?.sceneTrace)
  if (interaction?.reply.mode !== 'none' && !followUpHasNewContactMove(phase, sceneTrace?.exchange?.newMove)) {
    interaction = { seen: true, reply: { mode: 'none' } }
  }
  const relationshipMomentUpdate = memory?.relationshipMomentEnabled === false
    ? undefined
    : normalizeRelationshipMomentUpdate(raw?.relationshipMomentUpdate, {
        now,
        defaultHours: memory?.relationshipMomentDefaultHours ?? 24,
        maxHours: memory?.relationshipMomentMaxHours ?? 168,
      })
  const sceneState = normalizeSceneStateDecision(raw?.sceneState)
  const eventResults = normalizeSceneEventResults(raw?.eventResults)
  const storyHook = refreshStoryHook ? normalizeStoryHook(raw?.storyHook ?? raw?.continuity) : undefined
  const storyHookPatch = patchStoryHook ? normalizeStoryHookPatch(raw?.storyHookPatch) : undefined
  return { script, sceneTrace, sceneState, eventResults, storyHook, storyHookPatch, interaction, relationshipMomentUpdate, entries, memories, intents, intentUpdates, browserIntents, messages, statePatch, crossConversationActions }
}

function normalizeSceneEventResults(value: unknown): SceneEventResult[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set<SceneEventResult['status']>(['pending', 'unseen', 'noticed', 'responded', 'absorbed'])
  const result: SceneEventResult[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || typeof item.eventId !== 'string' || !/^entry:\d+$/.test(item.eventId)) continue
    if (!allowed.has(item.status as SceneEventResult['status'])) continue
    const eventId = item.eventId
    if (seen.has(eventId)) continue
    seen.add(eventId)
    result.push({
      eventId,
      status: item.status as SceneEventResult['status'],
      effect: typeof item.effect === 'string' ? clip(item.effect.replace(/\s+/g, ' ').trim(), 300) || undefined : undefined,
    })
  }
  return result.slice(0, 50)
}

function normalizeSceneStateSnapshot(value: unknown): SceneStateSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const text = (item: unknown, limit: number) => typeof item === 'string' ? clip(item.replace(/\s+/g, ' ').trim(), limit) : ''
  const list = (item: unknown, limit: number, count: number) => Array.isArray(item)
    ? item.map(value => text(value, limit)).filter(Boolean).slice(0, count)
    : []
  const snapshot: SceneStateSnapshot = {
    label: text(value.label, 160),
    location: text(value.location, 240),
    activity: text(value.activity, 300),
    currentAction: text(value.currentAction, 300) || undefined,
    completedActions: list(value.completedActions, 220, 6),
    pausedActions: list(value.pausedActions, 260, 6),
    bodyState: text(value.bodyState, 220) || undefined,
    mood: text(value.mood, 220) || undefined,
    attention: text(value.attention, 240) || undefined,
    participants: list(value.participants, 120, 12),
    openMatters: list(value.openMatters, 240, 12),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
  }
  return snapshot.label || snapshot.location || snapshot.activity || snapshot.currentAction
    || snapshot.completedActions?.length || snapshot.pausedActions?.length || snapshot.bodyState
    || snapshot.mood || snapshot.attention || snapshot.participants.length || snapshot.openMatters.length
    ? snapshot
    : undefined
}

function normalizeSceneStateDecision(value: unknown): SceneStateDecision | undefined {
  if (!isRecord(value)) return undefined
  const snapshot = normalizeSceneStateSnapshot(value)
  if (!snapshot) return undefined
  const closeReason = typeof value.closeReason === 'string' ? clip(value.closeReason.replace(/\s+/g, ' ').trim(), 300) : ''
  // A real transition needs a concrete reason. This prevents a bare short
  // message from accidentally fragmenting the scene when a provider omits
  // the scene fields or guesses at the output enum.
  const action = value.action === 'close-and-open' && closeReason ? 'close-and-open' : 'continue'
  return {
    ...snapshot,
    action,
    closeReason: closeReason || undefined,
  }
}

/** Providers often omit the fine-grained frontier fields even when they
 * return a usable scene label. Fill those fields from factual turn output and
 * the preceding scene state so the next dense exchange cannot teleport the
 * protagonist back to an earlier pose or activity. */
function completeSceneStateDecision(
  decision: SceneStateDecision | undefined,
  trace: SceneTrace,
  previous: SceneStateSnapshot | undefined,
): SceneStateDecision | undefined {
  if (!decision && !previous && !trace.situation && !trace.actions?.length && !trace.unfinished.length) return undefined
  const unique = (values: Array<string | undefined>, limit: number) => [...new Set(values.map(value => value?.trim()).filter((value): value is string => !!value))].slice(-limit)
  const latestAction = trace.actions?.at(-1)
  const base = decision ?? {
    action: 'continue' as const,
    label: previous?.label || '当前生活场景',
    location: previous?.location || '',
    activity: previous?.activity || trace.situation,
    participants: previous?.participants ?? [],
    openMatters: previous?.openMatters ?? [],
  }
  return {
    ...base,
    label: base.label || previous?.label || '当前生活场景',
    location: base.location || previous?.location || '',
    activity: base.activity || previous?.activity || trace.situation,
    currentAction: base.currentAction || previous?.currentAction || latestAction,
    completedActions: unique([...(base.completedActions ?? []), ...(trace.actions ?? [])], 6),
    pausedActions: unique(base.pausedActions ?? previous?.pausedActions ?? [], 6),
    bodyState: base.bodyState || previous?.bodyState,
    mood: base.mood || previous?.mood,
    attention: base.attention || previous?.attention,
    participants: unique(base.participants?.length ? base.participants : previous?.participants ?? [], 12),
    openMatters: unique(base.openMatters?.length ? base.openMatters : trace.unfinished.length ? trace.unfinished : previous?.openMatters ?? [], 12),
  }
}

function normalizeSceneTrace(value: unknown): SceneTrace | undefined {
  if (!isRecord(value)) return undefined
  const text = (item: unknown, limit: number) => typeof item === 'string' ? clip(item, limit).trim() : ''
  const list = (item: unknown, limit: number) => Array.isArray(item)
    ? item.map(value => text(value, limit)).filter(Boolean)
    : []
  const situation = text(value.situation, 300)
  const allowedFocus = new Set<NarrativeFocus>([
    'routine', 'study-work', 'interest', 'social', 'relationship',
    'body', 'environment', 'unexpected', 'reflection',
  ])
  const focus = Array.isArray(value.focus)
    ? value.focus.filter((item): item is NarrativeFocus => typeof item === 'string' && allowedFocus.has(item as NarrativeFocus)).slice(0, 2)
    : []
  const actions = list(value.actions, 180).slice(0, 4)
  const anchors = list(value.anchors, 220).slice(0, 6)
  const details = list(value.details, 220).slice(0, 6)
  const unfinished = list(value.unfinished, 240).slice(0, 4)
  const exchange = normalizeConversationTrace(value.exchange)
  const participantFacts = normalizeParticipantTraceFacts(value.participantFacts)
  if (!situation && !focus.length && !actions.length && !anchors.length && !details.length && !unfinished.length && !exchange && !participantFacts.length) return undefined
  return { situation, focus, actions, anchors, details, unfinished, exchange, participantFacts }
}

function normalizeConversationTrace(value: unknown): SceneTrace['exchange'] | undefined {
  if (!isRecord(value)) return undefined
  const text = (item: unknown) => typeof item === 'string' ? clip(item.replace(/\s+/g, ' ').trim(), 260) : ''
  const userMeaning = text(value.userMeaning)
  const rawResponseMeaning = text(value.responseMeaning)
  const responseMeaning = /^(none|null|无|没有)$/i.test(rawResponseMeaning) ? '' : rawResponseMeaning
  const list = (item: unknown) => Array.isArray(item)
    ? item.map(value => text(value)).filter(Boolean).slice(0, 6)
    : []
  const completedMoves = list(value.completedMoves)
  const openQuestions = list(value.openQuestions)
  const newMove = text(value.newMove)
  const status = value.status === 'answered' || value.status === 'acknowledged' || value.status === 'open' || value.status === 'none'
    ? value.status
    : undefined
  if (!userMeaning && !responseMeaning && !completedMoves.length && !openQuestions.length && !newMove && !status) return undefined
  return {
    userMeaning: userMeaning || undefined,
    responseMeaning: responseMeaning || undefined,
    completedMoves,
    openQuestions,
    newMove: newMove || undefined,
    status,
  }
}

function normalizeStoryHook(value: unknown): StoryHook | undefined {
  if (!isRecord(value)) return undefined
  const text = (item: unknown, limit: number) => typeof item === 'string' ? clip(item, limit).trim() : ''
  const list = (item: unknown, limit: number, count = 8) => Array.isArray(item)
    ? item.map(value => text(value, limit)).filter(Boolean).slice(0, count)
    : []
  // Older custom prompts may still return current/next/recent/salient. Map
  // those facts once so upgrading does not discard continuity.
  const currentLife = text(value.currentLife ?? value.current, 500)
  const presentState = list(value.presentState, 200, 5)
  const ongoingThreads = list(value.ongoingThreads ?? value.next, 260, 6)
  const castAndRelations = list(value.castAndRelations, 260, 6)
  const unresolvedMatters = list(value.unresolvedMatters ?? value.salient, 260, 6)
  const recentFacts = list(value.recentFacts ?? value.recent, 220, 8)
  const participantMatters = normalizeParticipantTraceFacts(value.participantMatters)
  if (!currentLife && !presentState.length && !ongoingThreads.length && !castAndRelations.length && !unresolvedMatters.length && !recentFacts.length && !participantMatters.length) return undefined
  return { currentLife, presentState, ongoingThreads, castAndRelations, unresolvedMatters, recentFacts, participantMatters }
}

/** Parse a deliberately partial Hook update. Arrays only appear when the
 * model wants to refresh that category; merging happens locally afterwards. */
function normalizeStoryHookPatch(value: unknown): StoryHookPatch | undefined {
  if (!isRecord(value)) return undefined
  const text = (item: unknown, limit: number) => typeof item === 'string' ? clip(item, limit).trim() : ''
  const list = (item: unknown, limit: number, count: number) => Array.isArray(item)
    ? item.map(value => text(value, limit)).filter(Boolean).slice(0, count)
    : undefined
  const patch: StoryHookPatch = {}
  if (typeof value.currentLife === 'string') {
    const currentLife = text(value.currentLife, 500)
    if (currentLife) patch.currentLife = currentLife
  }
  const presentState = list(value.presentState, 200, 4)
  const ongoingThreads = list(value.ongoingThreads, 260, 4)
  const castAndRelations = list(value.castAndRelations, 260, 4)
  const unresolvedMatters = list(value.unresolvedMatters, 260, 4)
  const recentFacts = list(value.recentFacts, 220, 5)
  const participantMatters = Array.isArray(value.participantMatters)
    ? normalizeParticipantTraceFacts(value.participantMatters).slice(0, 4)
    : undefined
  if (presentState?.length) patch.presentState = presentState
  if (ongoingThreads?.length) patch.ongoingThreads = ongoingThreads
  if (castAndRelations?.length) patch.castAndRelations = castAndRelations
  if (unresolvedMatters?.length) patch.unresolvedMatters = unresolvedMatters
  if (recentFacts?.length) patch.recentFacts = recentFacts
  if (participantMatters?.length) patch.participantMatters = participantMatters
  return Object.keys(patch).length ? patch : undefined
}

/** A small patch replaces only the immediate present, while list-style
 * continuity is merged newest-first so it cannot erase an older open thread. */
function mergeStoryHookPatch(base: StoryHook, patch: StoryHookPatch): StoryHook {
  return {
    currentLife: patch.currentLife || base.currentLife,
    presentState: patch.presentState?.length ? patch.presentState : base.presentState,
    ongoingThreads: mergeHookNotes(base.ongoingThreads, patch.ongoingThreads, 6),
    castAndRelations: mergeHookNotes(base.castAndRelations, patch.castAndRelations, 6),
    unresolvedMatters: mergeHookNotes(base.unresolvedMatters, patch.unresolvedMatters, 6),
    recentFacts: mergeHookNotes(base.recentFacts, patch.recentFacts, 8),
    participantMatters: mergeParticipantTraceFacts(base.participantMatters, patch.participantMatters, 6),
  }
}

function mergeHookNotes(existing: string[], incoming: string[] | undefined, limit: number) {
  return Array.from(new Set([...(incoming ?? []), ...existing].map(value => value.trim()).filter(Boolean))).slice(0, limit)
}

function mergeParticipantTraceFacts(existing: StoryHook['participantMatters'], incoming: StoryHookPatch['participantMatters'], limit: number) {
  const result: NonNullable<StoryHook['participantMatters']> = []
  const seen = new Set<string>()
  for (const item of [...(incoming ?? []), ...(existing ?? [])]) {
    const key = `${item.fact}\u0000${item.evidenceIds.join('\u0000')}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= limit) break
  }
  return result
}

function normalizeParticipantTraceFacts(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    if (!isRecord(item)) return undefined
    const fact = typeof item.fact === 'string' ? clip(item.fact, 260).trim() : ''
    const evidenceIds = Array.isArray(item.evidenceIds)
      ? item.evidenceIds.filter((id): id is string => typeof id === 'string' && /^(entry|fact):\d+$|^(profile|relationship):.+$/.test(id.trim())).map(id => id.trim()).slice(0, 4)
      : []
    return fact && evidenceIds.length ? { fact, evidenceIds } : undefined
  }).filter((item): item is NonNullable<typeof item> => !!item).slice(0, 6)
}

/**
 * The prose channel is intentionally free-form, so a model can occasionally
 * turn a plausible imagined notification into a historical fact.  Do not
 * attempt to fact-check ordinary life writing here; only remove sentences that
 * explicitly assert a new incoming contact while the current event ledger
 * contains no corresponding incoming message.  The structured interaction
 * remains the sole authority for character messages sent by this plugin.
 */
/* Legacy prose sanitizer retained temporarily for source compatibility. New
 * live and compaction paths no longer call it: event ownership is enforced by
 * turn type and transport persistence instead of rewriting generated prose. */
function sanitizeNarrativeScript(script: string, observedContext = '', allowCharacterTyping = false) {
  if (!script) return ''
  // A current user/group event can justify a generic "the phone lit up" in
  // that same turn, but it never justifies inventing a *different named
  // person* contacting the character.  Do not use a broad context marker as
  // an allow-all switch: every regular private turn contains one.
  const hasCurrentExternalEvent = !!observedContext.replace(/\s+/g, ' ').trim()
  return removeUnobservedContactSentences(script, hasCurrentExternalEvent, allowCharacterTyping)
}

/**
 * Removes only assertive claims that an unobserved digital contact happened.
 * Named third-party contacts are always removed. Generic notification prose
 * is allowed only while the current turn actually carries an external event.
 * This deliberately does not touch memories, guesses, offline encounters, or
 * a character's own intention to contact someone.
 */
function removeUnobservedContactSentences(script: string, allowGenericCurrentEvent = false, allowCharacterTyping = false) {
  // Do not mistake "you sent a message" for a third-party contact. The
  // current message itself is persisted as a structured entry, but keeping
  // its surrounding prose intact makes a live scene read naturally.
  const namedContact = /(?:来自|是|收到|看见|看到|跳出来的是|弹出来的是)?[“"']?(?!你|我|他|她|它|对方|用户)[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_·-]{0,19}[”"']?(?:发来(?:的)?|回复(?:了)?|回(?:了)?|找(?:了)?|传来(?:的)?|的)?(?:消息|微信|QQ|私信|来信|通知)/
  const genericContact = /手机(?:又|忽然|突然|这时)?(?:震动|响了|亮了)|(?:收到|跳出|弹出|传来).{0,20}(?:消息|通知|来信)/
  const digitalUiContact = /(?:跳出来的头像|弹出来的头像|聊天框(?:里|上)?|消息列表(?:里|上)?|通知栏(?:里|上)?|手机屏幕(?:上)?).{0,80}(?:显示|写着|来自|是|跳出|弹出|出现|[\u4e00-\u9fa5A-Za-z])/ 
  const relayedDigitalContact = /(?:通过|从)[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_·-]{0,19}(?:的)?(?:转述|消息|聊天记录|截图)/
  const quoteOnly = /^[“"'][\s\S]{1,500}[”"'][。！？!?]?$/
  let removeFollowingQuote = false
  const kept: string[] = []
  for (const sentence of script.split(/(?<=[。！？!?])|\n+/)) {
    const text = sentence.trim()
    if (!text) continue
    const isDigitalContact = namedContact.test(text) || digitalUiContact.test(text) || relayedDigitalContact.test(text)
    if (isDigitalContact || (!allowGenericCurrentEvent && genericContact.test(text))) {
      removeFollowingQuote = true
      continue
    }
    if (removeFollowingQuote && quoteOnly.test(text)) continue
    removeFollowingQuote = false
    kept.push(text)
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The same narrow detector protects old memories/facts from being recycled
 * into a fresh prompt. It intentionally ignores ordinary offline social life. */

function normalizeBrowserIntentDraftLoose(value: unknown): BrowserIntentDraft | undefined {
  if (!isRecord(value) || (value.mode !== 'search' && value.mode !== 'visit') || typeof value.purpose !== 'string') return undefined
  const query = typeof value.query === 'string' ? clip(value.query, 500) : ''
  const url = typeof value.url === 'string' ? clip(value.url, 2_000) : ''
  if (value.mode === 'search' && !query) return undefined
  if (value.mode === 'visit' && !url) return undefined
  return {
    mode: value.mode,
    ...(query ? { query } : {}), ...(url ? { url } : {}),
    purpose: clip(value.purpose, 500),
    timing: value.timing === 'immediate' ? 'immediate' : 'deferred',
    ...(typeof value.participantId === 'string' ? { participantId: value.participantId.trim() } : {}),
  }
}

function normalizeBrowserIntentDraft(draft: BrowserIntentDraft, config: BrowserConfig): BrowserIntentDraft | undefined {
  const normalized = normalizeBrowserIntentDraftLoose(draft)
  if (!normalized) return undefined
  if (normalized.mode === 'search' && !config.allowSearch) return undefined
  if (normalized.mode === 'visit' && !config.allowVisit) return undefined
  return normalized
}

function browserIntentFromPayload(payload: Record<string, unknown>): BrowserIntentDraft | null {
  return normalizeBrowserIntentDraftLoose({
    mode: payload?.mode,
    query: payload?.query,
    url: payload?.url,
    purpose: payload?.purpose || 'The character planned to read a public web page.',
    timing: 'deferred',
  }) ?? null
}

function resolveBrowserTarget(draft: BrowserIntentDraft, config: BrowserConfig) {
  if (draft.mode === 'search') {
    const template = config.searchUrlTemplate?.trim()
    if (!template || !template.includes('{query}')) return undefined
    const target = template.replaceAll('{query}', encodeURIComponent(draft.query ?? ''))
    return isSafePublicWebUrl(target, config) ? target : undefined
  }
  return draft.url && isSafePublicWebUrl(draft.url, config) ? draft.url : undefined
}

function isSafePublicWebUrl(value: string, config: BrowserConfig) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (url.username || url.password) return false
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '::1') return false
    if (isPrivateHost(host)) return false
    const blocked = normalizeDomains(config.blockedDomains)
    const allowed = normalizeDomains(config.allowedDomains)
    if (blocked.some(domain => domainMatches(host, domain))) return false
    return !allowed.length || allowed.some(domain => domainMatches(host, domain))
  } catch {
    return false
  }
}

function normalizeDomains(values: string[] | undefined) {
  return (values ?? []).map(value => String(value ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean)
}

function domainMatches(host: string, domain: string) { return host === domain || host.endsWith(`.${domain}`) }

function isPrivateHost(host: string) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
  }
  // Literal IPv6 and IPv4-mapped addresses are not needed for public-web
  // narration and are safest treated as local/private destinations.
  return host.includes(':')
}

function webObservationEntryContent(observation: WebObservation) {
  if (observation.status === 'success') {
    const source = observation.title || observation.url || 'a public web page'
    // The full bounded excerpt is supplied through webContext. Keeping it out
    // of the ordinary script stream avoids duplicating tokens and prevents
    // page text from being mistaken for a first-party narrative instruction.
    return `The character read a public web page: ${source}.`
  }
  return `The character's attempted web lookup did not complete: ${clip(observation.summary, 800)}`
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

function validIntent(value: unknown, from: Date, now: Date, memory?: MemoryConfig): value is IntentDraft {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.summary !== 'string') return false
  const notBefore = toDate(value.notBefore)
  if (!notBefore) return false
  if (!isActiveConsequenceDraft(value)) return notBefore > now
  const expiresAt = consequenceExpiresAt(value.payload)
  const payload = value.payload
  const effect = isRecord(payload) && typeof payload.effect === 'string' ? payload.effect.trim() : ''
  const strength = isRecord(payload) ? payload.strength : undefined
  // Consequences are intentionally short-to-medium-lived story pressure,
  // not a backdoor for permanently rewriting canon. Keep the source time
  // close to this writing turn and cap their natural lifetime at 30 days.
  const maximumLifetime = Math.max(1, memory?.activeConsequenceMaxDays ?? 7) * Time.day
  return !!memory?.activeConsequencesEnabled && !!effect
    && (strength === undefined || typeof strength === 'number' && Number.isFinite(strength) && strength >= 0 && strength <= 1)
    && notBefore <= now && notBefore >= from
    && !!expiresAt && expiresAt > now && expiresAt.getTime() - now.getTime() <= maximumLifetime
}

type NormalizedIntentUpdate = { id: number; status: 'completed' | 'cancelled'; resolution?: string }

function normalizeIntentUpdates(value: unknown): NormalizedIntentUpdate[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item) && Number.isInteger(item.id) && Number(item.id) > 0 && (item.status === 'completed' || item.status === 'cancelled'))
    .map(item => ({
      id: Number(item.id), status: item.status as 'completed' | 'cancelled',
      ...(typeof item.resolution === 'string' && item.resolution.trim() ? { resolution: clip(item.resolution, 1_000) } : {}),
    }))
    .slice(0, 8)
}

function isActiveConsequence(intent: NarrativeIntent) {
  return intent.type === 'active-consequence' && isRecord(intent.payload) && intent.payload.lifecycle === 'active'
}

function isActiveConsequenceDraft(intent: Pick<IntentDraft, 'type' | 'payload'> | Record<string, unknown>) {
  return intent.type === 'active-consequence' && isRecord(intent.payload) && intent.payload.lifecycle === 'active'
}

function consequenceExpiresAt(payload: unknown) {
  if (!isRecord(payload)) return undefined
  return toDate(payload.expiresAt)
}

function consequenceStrength(payload: unknown, fallback = 0.55) {
  return clampNumber(isRecord(payload) ? payload.strength : undefined, fallback, 0, 1)
}

function validMessage(value: unknown, maxLength: number): value is Partial<OutgoingMessageDraft> {
  return isRecord(value) && typeof value.content === 'string' && !!value.content.trim() && value.content.length <= maxLength
}

function normalizeMessage(value: unknown, maxLength: number, currentParticipantId: string, permittedParticipantIds: Set<string>) {
  if (!validMessage(value, maxLength)) return undefined
  const participantId = permittedOrGlobal(value.participantId, currentParticipantId, permittedParticipantIds)
  return participantId ? { participantId, content: value.content.trim().slice(0, maxLength) } : undefined
}

function hasCompactionEvidence(sourceEntryIds: number[] | undefined, entries: ScriptEntry[]) {
  if (!Array.isArray(sourceEntryIds) || sourceEntryIds.length === 0) return false
  const ids = new Set(entries.map(entry => entry.id))
  return sourceEntryIds.some(id => ids.has(id))
}

function normalizeConversationAction(value: unknown, runtime: RuntimeConfig, permittedParticipantIds: Set<string>, currentParticipantId: string, now = new Date(), proactive = false) {
  if (!isRecord(value) || typeof value.participantId !== 'string' || !value.participantId || value.participantId === currentParticipantId) return undefined
  if (!permittedParticipantIds.has(value.participantId) || (value.mode !== 'immediate' && value.mode !== 'delayed')) return undefined
  const content = typeof value.content === 'string' ? value.content.trim().slice(0, runtime.maxMessageCharacters) : ''
  if (!content) return undefined
  const willingness = typeof value.willingness === 'number' && Number.isFinite(value.willingness)
    ? clampNumber(value.willingness, 0, 0, 1)
    : undefined
  if (proactive && (willingness === undefined || willingness < (runtime.proactiveWillingnessThreshold ?? 0.65))) return undefined
  const reason = typeof value.reason === 'string' ? clip(value.reason, 300) : undefined
  const meaning = typeof value.meaning === 'string' ? clip(value.meaning, 300) : undefined
  if (value.mode === 'immediate') return {
    participantId: value.participantId, mode: value.mode, content,
    ...(willingness === undefined ? {} : { willingness }), ...(reason ? { reason } : {}), ...(meaning ? { meaning } : {}),
  }
  const sendAt = toDate(value.sendAt)
  const delay = sendAt?.getTime() - now.getTime()
  if (!sendAt || delay < runtime.minimumDelayedReplySeconds * 1_000 || delay > runtime.maximumDelayedReplyMinutes * Time.minute) return undefined
  return {
    participantId: value.participantId, mode: value.mode, content, sendAt: sendAt.toISOString(),
    ...(willingness === undefined ? {} : { willingness }), ...(reason ? { reason } : {}), ...(meaning ? { meaning } : {}),
  }
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
    relationshipMoment: patch.relationshipMoment === undefined && !Object.prototype.hasOwnProperty.call(patch, 'relationshipMoment')
      ? base.relationshipMoment
      : patch.relationshipMoment,
  }
}

function normalizeParticipantState(value: unknown): ParticipantState {
  const record = isRecord(value) ? value : {}
  return {
    openThreads: Array.isArray(record.openThreads) ? record.openThreads.filter(item => typeof item === 'string').map(item => clip(item, 500)).slice(0, 50) : [],
    relationshipNotes: Array.isArray(record.relationshipNotes) ? record.relationshipNotes.filter(item => typeof item === 'string').map(item => clip(item, 500)).slice(0, 50) : [],
    relationshipOverlay: typeof record.relationshipOverlay === 'string' ? clip(record.relationshipOverlay, 4_000) : undefined,
    relationshipMoment: normalizeStoredRelationshipMoment(record.relationshipMoment),
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
  const storyHook = normalizeStoryHook(record.storyHook ?? record.continuitySnapshot)
  const activeSceneState = normalizeSceneStateSnapshot(record.activeSceneState)
  const transition = normalizeSceneStateDecision(record.sceneTransitionPending)
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
    activeSceneState,
    pendingSceneEventIds: Array.isArray(record.pendingSceneEventIds)
      ? record.pendingSceneEventIds.filter(item => typeof item === 'string' && /^entry:\d+$/.test(item)).slice(-200)
      : [],
    sceneTransitionPending: transition && isRecord(record.sceneTransitionPending) && typeof record.sceneTransitionPending.requestedAt === 'string'
      ? {
          ...transition,
          requestedAt: record.sceneTransitionPending.requestedAt,
          sourceEntryId: typeof record.sceneTransitionPending.sourceEntryId === 'number'
            ? Math.floor(record.sceneTransitionPending.sourceEntryId)
            : undefined,
        }
      : undefined,
    storyHook,
    storyHookEntryId: typeof record.storyHookEntryId === 'number' && Number.isFinite(record.storyHookEntryId)
      ? Math.max(0, Math.floor(record.storyHookEntryId))
      : undefined,
    storyHookAdvanceCount: Math.max(0, Math.floor(typeof record.storyHookAdvanceCount === 'number' ? record.storyHookAdvanceCount : 0)),
    storyHookDirty: record.storyHookDirty === true,
    narrativeUpdateCount: Math.max(0, Math.floor(typeof record.narrativeUpdateCount === 'number' ? record.narrativeUpdateCount : 0)),
    lastStoryHookUpdateAt: typeof record.lastStoryHookUpdateAt === 'string'
      ? record.lastStoryHookUpdateAt
      : typeof record.lastContinuityUpdateAt === 'string' ? record.lastContinuityUpdateAt : undefined,
    lastStoryHookPatchAt: typeof record.lastStoryHookPatchAt === 'string' ? record.lastStoryHookPatchAt : undefined,
    automation: {
      quietUntil: typeof automation.quietUntil === 'string' ? automation.quietUntil : undefined,
      nextAdvanceAt: typeof automation.nextAdvanceAt === 'string' ? automation.nextAdvanceAt : undefined,
      lastAutoAdvanceAt: typeof automation.lastAutoAdvanceAt === 'string' ? automation.lastAutoAdvanceAt : undefined,
      lastUserMessageAt: typeof automation.lastUserMessageAt === 'string' ? automation.lastUserMessageAt : undefined,
      lastConversationActivityAt: typeof automation.lastConversationActivityAt === 'string'
        ? automation.lastConversationActivityAt
        : typeof automation.lastUserMessageAt === 'string' ? automation.lastUserMessageAt : undefined,
      conversationFollowUpAt: Array.isArray(automation.conversationFollowUpAt)
        ? automation.conversationFollowUpAt.filter(item => typeof item === 'string').slice(0, 8)
        : [],
      conversationFollowUpParticipantId: typeof automation.conversationFollowUpParticipantId === 'string'
        ? clip(automation.conversationFollowUpParticipantId, 255)
        : undefined,
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
    // A narrative retry owns one interrupted foreground event. Mixing it with
    // reminders or delayed transport would turn recovery into a new composite
    // scene and can replay an already settled conversational move.
    const key = intent.type === 'narrative-retry'
      ? `__retry__:${intent.id}`
      : intent.participantId || '__global__'
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

function sameTimestamp(left: unknown, right: unknown) {
  const a = toDate(left)
  const b = toDate(right)
  return !!a && !!b && Math.abs(a.getTime() - b.getTime()) < 2_000
}

/** A corrupted/future cursor must never make the narrator "fill in" time
 * backwards. Clamp only the prompt interval; normal successful persistence
 * still advances the stored cursor to the actual wall-clock time. */
function narrativeCursor(story: InterludeStory, now: Date) {
  const cursor = toDate(story.cursorAt) ?? now
  return cursor > now ? now : cursor
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

function formatBufferedUserMessages(messages: BufferedUserMessage[]) {
  if (messages.length === 1) return messages[0].content
  return messages.map((message, index) => {
    const time = message.occurredAt.toISOString()
    return `[连续消息 ${index + 1}，收到时间 ${time}]\n${message.content}`
  }).join('\n\n')
}

function automaticIntervalMinutes(story: InterludeStory, now: Date, config: AutoAdvanceConfig) {
  const restWindow = activeRestWindow(config.restWindows, story.setting.timezone, now)
  if (restWindow) return randomInteger(restWindow.minIntervalMinutes, restWindow.maxIntervalMinutes)
  return Math.max(1, config.intervalMinutes + randomInteger(-config.jitterMinutes, config.jitterMinutes))
}

function normalizeFollowUpMinutes(values: number[] | undefined) {
  const defaults = [10, 20]
  const normalized = (Array.isArray(values) ? values : defaults)
    .map(value => Math.floor(Number(value)))
    .filter(value => Number.isFinite(value) && value >= 1 && value <= 240)
  return Array.from(new Set(normalized)).sort((left, right) => left - right).slice(0, 6)
}

function scheduleConversationFollowUps(anchor: Date, config: AutoAdvanceConfig) {
  let previous = anchor.getTime()
  return config.followUpMinutes.map(minutes => {
    const jitter = config.followUpJitterMinutes
      ? randomInteger(-config.followUpJitterMinutes, config.followUpJitterMinutes)
      : 0
    // Never place a later configured pass before an earlier one, even when
    // jitter is enabled or the owner provides a close custom sequence.
    const at = Math.max(previous + 1_000, anchor.getTime() + Math.max(1, minutes + jitter) * Time.minute)
    previous = at
    return new Date(at)
  })
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

function patchClaimsMatch(left: string, right: string) {
  const a = normalizeFact(left).replace(/[，。！？、,.!?；;:：]/g, '')
  const b = normalizeFact(right).replace(/[，。！？、,.!?；;:：]/g, '')
  if (!a || !b) return false
  if (a === b) return true
  // Allow small wording variations, while avoiding very short claims that
  // could incorrectly merge contradictory changes.
  return Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a))
}

function statePatchEvidence(entries: ScriptEntry[], timezone: string) {
  const narrative = entries.filter(entry => entry.kind === 'script' || entry.actor === 'narrator')
  // Use the narrative timestamp as the turn key. Duplicate rows created at
  // the same instant must not count as independent evidence.
  const turns = new Set(narrative.map(entry => entry.occurredAt.getTime())).size
  const days = new Set(narrative.map(entry => calendarDayKey(entry.occurredAt, timezone))).size
  return { turns, days }
}

function calendarDayKey(value: Date, timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
  } catch {
    return value.toISOString().slice(0, 10)
  }
}

function startOfUtcWindow(value: Date, windowDays: number) {
  const size = Math.max(1, Math.floor(windowDays))
  const epochDay = Math.floor(value.getTime() / Time.day)
  return new Date(Math.floor(epochDay / size) * size * Time.day)
}

function startOfUtcMonth(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1))
}

function groupOverlayPatches(patches: StatePatchProposal[], windowDays = 5) {
  const groups = new Map<string, { participantId: string; target: StatePatchProposal['target']; from: Date; to: Date; patches: StatePatchProposal[] }>()
  for (const patch of patches) {
    const from = startOfUtcWindow(patch.appliedAt ?? patch.createdAt, windowDays)
    const key = `${patch.participantId}|${patch.target}|${from.toISOString()}`
    const group = groups.get(key) ?? { participantId: patch.participantId, target: patch.target, from, to: new Date(from.getTime() + windowDays * Time.day), patches: [] }
    group.patches.push(patch)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function groupOverlaySnapshots(snapshots: OverlaySnapshot[], windowDays = 10) {
  const groups = new Map<string, { participantId: string; target: OverlaySnapshot['target']; from: Date; to: Date; snapshots: OverlaySnapshot[] }>()
  for (const snapshot of snapshots) {
    const from = startOfUtcWindow(snapshot.periodEnd, windowDays)
    const key = `${snapshot.participantId}|${snapshot.target}|${from.toISOString()}`
    const group = groups.get(key) ?? { participantId: snapshot.participantId, target: snapshot.target, from, to: new Date(from.getTime() + windowDays * Time.day), snapshots: [] }
    group.snapshots.push(snapshot)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function normalizeMajorEvents(value: unknown, patches: StatePatchProposal[], snapshots: OverlaySnapshot[] = []) {
  const modelEvents = Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => clip(item, 600)) : []
  const retained = [
    ...snapshots.flatMap(snapshot => snapshot.majorEvents ?? []),
    ...patches.filter(patch => patch.impact === 'major').map(patch => clip(patch.proposedValue || patch.evidence, 600)),
  ]
  return Array.from(new Set([...retained, ...modelEvents].filter(Boolean))).slice(-20)
}
