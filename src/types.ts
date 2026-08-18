export type StoryStatus = 'active' | 'paused' | 'archived'

export interface CharacterSetting {
  name: string
  profile: string
}

export interface StorySetting {
  /**
   * 初始 canon：只由显式配置修改。模型引起的长期变化应写入
   * StoryState.settingOverlay，避免一次生成把人物设定直接改写。
   */
  character: CharacterSetting
  user: { displayName: string; profile: string }
  relationship: string
  world: string
  supportingCast: string
  location: string
  style: string
  timezone: string
}

export interface StoryState {
  /** Evolving overlay. The original setting remains the story's canon/base. */
  settingOverlay: StorySettingOverlay
  activeSceneId?: number
  activeArcId?: number
  /**
   * 空闲期更新的事实型剧本引子。它描述故事现在从哪里继续，不保存正文
   * 句式，因此实时写作无需反复学习主模型以前写过的 prose。
   */
  storyHook?: StoryHook
  /** The script row included in the latest hook; newer rows supply Scene Trace deltas. */
  storyHookEntryId?: number
  /** @deprecated Retained for old state records; cadence is now time-based. */
  storyHookAdvanceCount: number
  /** Live/follow-up writing created facts that a small patch should absorb. */
  storyHookDirty: boolean
  narrativeUpdateCount: number
  /** Last complete hook rewrite. Small patches intentionally do not change it. */
  lastStoryHookUpdateAt?: string
  /** Last post-conversation hook patch, kept for diagnostics. */
  lastStoryHookPatchAt?: string
  /** 自动推进时钟；ISO 字符串便于跨进程/数据库 JSON 持久化。 */
  automation: StoryAutomationState
}

/**
 * Replace-in-place anchor written only during an ordinary idle advance.
 * Every field uses short factual notes rather than narrative prose.
 */
export interface StoryHook {
  currentLife: string
  presentState: string[]
  ongoingThreads: string[]
  castAndRelations: string[]
  unresolvedMatters: string[]
  recentFacts: string[]
  /**
   * Compact participant-related facts carried forward only with a concrete
   * source reference. This keeps an evocative script sentence from quietly
   * becoming the system's only evidence about what a user did or said.
   */
  participantMatters?: ParticipantTraceFact[]
}

/**
 * A post-conversation delta. It only contains hook fields whose current
 * meaning changed; unspecified fields remain untouched until the next full
 * idle rewrite.
 */
export interface StoryHookPatch {
  currentLife?: string
  presentState?: string[]
  ongoingThreads?: string[]
  castAndRelations?: string[]
  unresolvedMatters?: string[]
  recentFacts?: string[]
  participantMatters?: ParticipantTraceFact[]
}

/** A reusable participant fact paired with one or more observed source ids. */
export interface ParticipantTraceFact {
  fact: string
  evidenceIds: string[]
}

/**
 * Small factual card emitted with one narrative turn. It preserves concrete
 * recent details while keeping the previous model prose out of later prompts.
 */
export interface SceneTrace {
  situation: string
  /** Completed protagonist actions, kept separate from descriptive prose. */
  actions?: string[]
  details: string[]
  unfinished: string[]
  /**
   * The semantic result of a private exchange. This is deliberately factual
   * rather than a copy of a chat bubble, so later turns can retain what was
   * understood without learning the writer's earlier wording and cadence.
   */
  exchange?: ConversationTrace
  /** User-related continuity notes. Every item must cite an input evidence id. */
  participantFacts?: ParticipantTraceFact[]
}

export interface ConversationTrace {
  /** What the participant meant, asked, asserted, or referred to. */
  userMeaning?: string
  /** What the protagonist actually conveyed or decided in response. */
  responseMeaning?: string
  /** Whether the exchange is settled, intentionally open, or not applicable. */
  status?: 'answered' | 'acknowledged' | 'open' | 'none'
}

/**
 * One compact, delivery-grounded continuity card for a completed writing
 * turn.  It deliberately combines split chat bubbles into the same logical
 * exchange and stores factual scene state rather than previous script prose.
 */
export interface RecentLogicalTurn {
  entryId: number
  participantId: string
  phase: NarrativePhase
  occurredAt: Date
  situation: string
  actions: string[]
  details: string[]
  unfinished: string[]
  /** Exact external wording observed during this logical turn. */
  userMessages: string[]
  /** Only bubbles confirmed by the adapter as delivered. */
  characterMessages: string[]
  /** Compact meaning of the exchange, never a transcript of old reply wording. */
  exchange?: ConversationTrace
  /** Lets an aftermath pass distinguish a settled exchange from an open one. */
  interactionState: 'sent' | 'seen-no-reply' | 'unseen' | 'scheduled' | 'none'
  /** User-related continuity notes. Every item cites observed input evidence. */
  participantFacts?: ParticipantTraceFact[]
}

/**
 * A compact chronological fact from the current life period.  Unlike a
 * logical turn it carries no chat transcript, so it can bridge last night or
 * earlier the same day without feeding old authored wording back to the
 * narrator.
 */
export interface RecentLifeFact {
  entryId: number
  occurredAt: Date
  phase: NarrativePhase
  situation: string
  actions: string[]
  details: string[]
  unfinished: string[]
  exchange?: ConversationTrace
}

/**
 * Ground-truth material about a participant. The writer may use it to
 * understand that participant, and cites its id when preserving a new
 * participant-related note in sceneTrace or storyHook.
 */
export interface ParticipantKnownFact {
  id: string
  participantId: string
  source: 'current-event' | 'message' | 'durable-fact' | 'profile' | 'relationship'
  fact: string
  occurredAt?: Date
}

/**
 * One character can maintain several relationships in the same main story.
 * This state belongs to one real person / account, rather than to the whole
 * world, so one conversation cannot accidentally overwrite another person's
 * relationship notes or pending messages.
 */
export interface ParticipantState {
  openThreads: string[]
  relationshipNotes: string[]
  relationshipOverlay?: string
  unreadMessageCount: number
  pendingReplyCount: number
  lastUserMessageAt?: string
  lastCharacterMessageAt?: string
}

export interface StoryAutomationState {
  /** 对话活跃期结束时间；在此之前只处理必要的到期意图，不补写日常生活。 */
  quietUntil?: string
  /** 下一次自动生活补写的最早时间。 */
  nextAdvanceAt?: string
  lastAutoAdvanceAt?: string
  lastUserMessageAt?: string
  /** Latest message/reply that anchored a conversation aftermath cycle. */
  lastConversationActivityAt?: string
  /** Short life-writing passes scheduled from the latest conversation endpoint. */
  conversationFollowUpAt?: string[]
  /** Relationship branch whose recent conversation supplies the 10/20-minute
   * user-side aftermath context. Omitted for ordinary background advancement. */
  conversationFollowUpParticipantId?: string
}

export interface StorySettingOverlay {
  characterProfile?: string
  relationship?: string
  world?: string
  supportingCast?: string
  location?: string
  /** Small, accumulated trait changes expressed as evidence-backed notes. */
  characterTraits?: string[]
}

export interface InterludeStory {
  id: string
  platform: string
  selfId: string
  userId: string
  channelId: string
  status: StoryStatus
  setting: StorySetting
  state: StoryState
  cursorAt: Date
  createdAt: Date
  updatedAt: Date
}

/** A private-message endpoint and its relationship branch inside one story. */
export interface InterludeParticipant {
  id: string
  storyId: string
  platform: string
  selfId: string
  userId: string
  channelId: string
  /** Multiple accounts may deliberately share the same real-person id. */
  personId: string
  displayName: string
  profile: string
  relationship: string
  state: ParticipantState
  status: 'active' | 'paused'
  createdAt: Date
  updatedAt: Date
}

export interface ScriptEntry {
  id: number
  storyId: string
  /** Empty for world/system events; otherwise identifies the involved account. */
  participantId: string
  kind: string
  actor: string
  content: string
  occurredAt: Date
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface NarrativeMemory {
  id: number
  storyId: string
  participantId: string
  category: string
  content: string
  importance: number
  status: string
  sourceEntryId: number | null
  createdAt: Date
  updatedAt: Date
}

export type SceneStatus = 'active' | 'closed'

export interface InterludeScene {
  id: number
  storyId: string
  status: SceneStatus
  startedAt: Date
  endedAt: Date | null
  hook: string
  summary: string
  entryCount: number
  /** 最近一次已经被写入场景摘要的条目；下一轮只压缩它之后的新内容。 */
  lastEntryId: number | null
  createdAt: Date
  updatedAt: Date
}

export interface InterludeArc {
  id: number
  storyId: string
  status: 'active' | 'closed'
  title: string
  summary: string
  sceneCount: number
  createdAt: Date
  updatedAt: Date
}

export type StatePatchTarget = 'character' | 'world' | 'relationship'
export type StatePatchStatus = 'proposed' | 'applied' | 'compacted' | 'rejected' | 'cleared'

export interface StatePatchProposal {
  /**
   * 压缩器提出、插件审核的变化，而不是对 canon 的直接写入。
   * 保留证据和状态可支持审计、人工确认与日后的重新评估。
   */
  id: number
  storyId: string
  participantId: string
  target: StatePatchTarget
  path: string
  proposedValue: string
  evidence: string
  confidence: number
  impact: 'minor' | 'major'
  status: StatePatchStatus
  sourceEntryIds: number[]
  createdAt: Date
  appliedAt: Date | null
}

/** A compressed, auditable layer of setting evolution. Raw applied patches
 * remain intact and are only marked compacted after a snapshot is stored. */
export interface OverlaySnapshot {
  id: number
  storyId: string
  participantId: string
  target: StatePatchTarget
  /** Kept as weekly/monthly for database compatibility; runtime windows are
   * five days and ten days respectively. */
  tier: 'weekly' | 'monthly'
  periodStart: Date
  periodEnd: Date
  summary: string
  majorEvents: string[]
  sourcePatchIds: number[]
  status: 'active' | 'superseded'
  createdAt: Date
  updatedAt: Date
}

export interface NarrativeFact {
  id: number
  storyId: string
  /** Empty means a world-wide fact; otherwise it is relationship-specific. */
  participantId: string
  scope: 'character' | 'world' | 'relationship' | 'event' | 'promise'
  content: string
  importance: number
  confidence: number
  unresolved: boolean
  embedding?: number[]
  status: 'active' | 'superseded'
  sourceEntryIds: number[]
  lastSeenAt: Date
  createdAt: Date
  updatedAt: Date
}

export type IntentStatus = 'pending' | 'completed' | 'cancelled'

export interface NarrativeIntent {
  id: number
  storyId: string
  /** Target private-message relationship for a future contact. */
  participantId: string
  type: string
  summary: string
  notBefore: Date
  status: IntentStatus
  payload: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

/** A bounded, read-only observation collected through Koishi Puppeteer.
 * Web pages are untrusted source material: only the extracted text below is
 * sent back to the narrator, never page HTML, scripts, cookies, or actions. */
export interface WebObservation {
  id: number
  storyId: string
  /** Empty means a world-level observation; otherwise it belongs to one relationship. */
  participantId: string
  intentId: number | null
  mode: 'search' | 'visit'
  query: string
  url: string
  title: string
  excerpt: string
  summary: string
  status: 'success' | 'failed' | 'blocked' | 'deleted'
  accessedAt: Date
  createdAt: Date
}

export interface ScriptEntryDraft {
  kind: string
  actor?: string
  content: string
  occurredAt?: string
  metadata?: Record<string, unknown>
}

export interface MemoryDraft { category: string; content: string; importance?: number; participantId?: string }
export interface IntentDraft { type: string; summary: string; notBefore: string; payload?: Record<string, unknown>; participantId?: string }
/** A narrator may close an active narrative consequence once the script has
 * naturally absorbed it. Scheduled intents complete through their due-turn
 * path, so this is deliberately limited to existing persistent context. */
export interface IntentUpdateDraft {
  id: number
  status: 'completed' | 'cancelled'
  resolution?: string
}
/** Metadata is written only after the transport layer confirms delivery. */
export interface OutgoingMessageDraft { participantId: string; content: string; metadata?: Record<string, unknown> }

/** A future browsing action proposed by the narrator. It is not an observed
 * fact until Puppeteer finishes and produces a WebObservation. */
export interface BrowserIntentDraft {
  mode: 'search' | 'visit'
  query?: string
  url?: string
  purpose: string
  timing?: 'deferred' | 'immediate'
  participantId?: string
}

/** A message to another relationship branch generated in the same writing turn. */
export interface ConversationActionDraft {
  participantId: string
  mode: 'immediate' | 'delayed'
  content: string
  sendAt?: string
  /** 0..1: how strongly the protagonist actually wants to initiate contact now. */
  willingness?: number
  /** Short audit note explaining the concrete reason for this contact. */
  reason?: string
}

export type InteractionReplyMode = 'none' | 'immediate' | 'delayed'

export interface NarrativeInteraction {
  seen: boolean
  reply: {
    mode: InteractionReplyMode
    content?: string
    sendAt?: string
  }
}

export interface NarrativeDecision {
  /** The continuous prose written by the main narrative model. */
  script?: string
  /** Factual delta for this turn; stored beside the script, never displayed. */
  sceneTrace?: SceneTrace
  /** Present only when an ordinary idle turn explicitly requests a hook refresh. */
  storyHook?: StoryHook
  /** Small delta requested at the settled end of a conversation cycle. */
  storyHookPatch?: StoryHookPatch
  /** @deprecated Accepted while upgrading responses based on an older custom prompt. */
  continuity?: unknown
  /** The machine-readable result placed after the prose. */
  interaction?: NarrativeInteraction
  memories?: MemoryDraft[]
  intents?: IntentDraft[]
  /** Resolves existing active-consequence intents visible in this turn. */
  intentUpdates?: IntentUpdateDraft[]
  browserIntents?: BrowserIntentDraft[]
  /** Applies to the current participant only; world state uses compaction proposals. */
  statePatch?: Partial<ParticipantState>
  /** Optional outbound actions aimed at other accounts in the same main story. */
  crossConversationActions?: ConversationActionDraft[]
  /** Optional visible reply to the configured OneBot group that caused this turn. */
  groupReply?: {
    mode: 'none' | 'immediate'
    content?: string
  }
}

export type NarrativePhase = 'advance' | 'conversation-follow-up' | 'user-message' | 'intent-due'

/** A transient native-vision attachment for the current private-message turn.
 * It is intentionally never persisted in script entries, memories, or facts. */
export interface NarrativeImage {
  id: string
  mimeType: string
  dataUri: string
}

export interface NarrativeRequest {
  /** 主模型读取事实型引子和增量卡，不读取最近剧本正文。 */
  phase: NarrativePhase
  /** Replace the factual story hook on this ordinary idle turn. */
  refreshStoryHook?: boolean
  /** The hook work requested in this existing narrator call. */
  hookUpdate?: 'none' | 'patch' | 'full'
  story: InterludeStory
  from: Date
  now: Date
  userMessage?: string
  /** Native image inputs observed in this one incoming user event only. */
  images?: NarrativeImage[]
  /** The relationship that caused this turn; null for unattended life updates. */
  participant: InterludeParticipant | null
  /** Other currently enrolled relationship branches, ordered by relevance. */
  participants: InterludeParticipant[]
  /** Sensitive details of other participants are opt-in because the model may be remote. */
  shareParticipantDetails: boolean
  dueIntents: NarrativeIntent[]
  /** Consequences already in motion. They are context, never newly due events. */
  activeConsequences: NarrativeIntent[]
  supersededIntents: NarrativeIntent[]
  storyHook?: StoryHook
  /** Factual, delivery-grounded recent logical turns; no previous script prose. */
  recentLogicalTurns: RecentLogicalTurn[]
  /** Factual life bridge for the recent day, intentionally without chat wording. */
  recentLifeFacts: RecentLifeFact[]
  /** Observed participant material, deliberately separate from authored prose. */
  participantKnownFacts: ParticipantKnownFact[]
  memories: NarrativeMemory[]
  /** One-time upgrade/bootstrap context, omitted once a story hook exists. */
  bootstrapContext?: SceneContext & { recentExcerpt?: string }
  facts?: NarrativeFact[]
  /** Older setting evolution, separated from the live three-day overlay. */
  overlaySnapshots?: OverlaySnapshot[]
  /** Recent, safety-filtered web observations available as narrative context. */
  webContext?: WebObservation[]
  /** Present only for a group-scene turn; private-message privacy remains unchanged. */
  groupContext?: GroupContext
}

export interface GroupMessageContext {
  senderId: string
  senderName: string
  content: string
  occurredAt: Date
  direction?: 'user' | 'character'
}

export interface GroupContext {
  groupId: string
  channelId: string
  label: string
  purpose: string
  characterRole: string
  messages: GroupMessageContext[]
  gateKind?: string
  gateReason?: string
  gateSummary?: string
  targetUserId?: string
}

export interface GroupGateRequest {
  groupId: string
  label: string
  purpose: string
  characterRole: string
  /** Optional for compatibility with custom group gates written before 0.1.1-beta. */
  responseMode?: 'mention-only' | 'selective' | 'active'
  messages: GroupMessageContext[]
  botUserId: string
}

export interface GroupGateDecision {
  shouldConsiderReply: boolean
  score: number
  kind: string
  reason: string
  contextSummary: string
  targetUserId?: string
}

export interface NarrativeProvider {
  decide(request: NarrativeRequest): Promise<NarrativeDecision>
  /** Optional low-cost prefilter used only for configured group chats. */
  gateGroup?(request: GroupGateRequest): Promise<GroupGateDecision>
}

export const emptyStorySetting = (): StorySetting => ({
  character: { name: 'Unnamed character', profile: '' },
  user: { displayName: '', profile: '' },
  relationship: '', world: '', supportingCast: '', location: '',
  style: 'Realistic, restrained, and centered on ordinary life.',
  timezone: 'Asia/Shanghai',
})

export const emptyStoryState = (): StoryState => ({
  settingOverlay: { characterTraits: [] }, automation: {}, narrativeUpdateCount: 0,
  storyHookAdvanceCount: 0, storyHookDirty: false,
})

export const emptyParticipantState = (): ParticipantState => ({
  openThreads: [], relationshipNotes: [], unreadMessageCount: 0, pendingReplyCount: 0,
})

export interface SceneContext {
  scene: InterludeScene | null
  arc: InterludeArc | null
}

export interface CompactionRequest {
  /**
   * 后台压缩只处理已发生、且尚未写进当前场景摘要的原始条目。
   * 它与主叙事回合分离，不能增加用户发送消息时的等待时间。
   */
  story: InterludeStory
  from: Date
  now: Date
  entries: ScriptEntry[]
  scene: InterludeScene | null
  arc: InterludeArc | null
  participants: InterludeParticipant[]
  facts: NarrativeFact[]
}

export interface FactDraft {
  scope: NarrativeFact['scope']
  participantId?: string
  content: string
  importance?: number
  confidence?: number
  unresolved?: boolean
  sourceEntryIds?: number[]
}

export interface StatePatchDraft {
  target: StatePatchTarget
  participantId?: string
  path: string
  proposedValue: string
  evidence: string
  confidence?: number
  impact?: 'minor' | 'major'
  sourceEntryIds?: number[]
}

export interface CompactionDecision {
  scene?: { hook?: string; summary?: string; close?: boolean }
  arc?: { title?: string; summary?: string }
  facts?: FactDraft[]
  statePatches?: StatePatchDraft[]
}

export interface OverlayCompactionRequest {
  story: InterludeStory
  participant?: InterludeParticipant
  target: StatePatchTarget
  tier: OverlaySnapshot['tier']
  from: Date
  to: Date
  patches: StatePatchProposal[]
  snapshots?: OverlaySnapshot[]
}

export interface OverlayCompactionDecision {
  summary: string
  majorEvents?: string[]
}

export interface NarrativeCompactor {
  compact(request: CompactionRequest): Promise<CompactionDecision>
  compactOverlay(request: OverlayCompactionRequest): Promise<OverlayCompactionDecision>
}

export interface NarrativeEmbedder {
  embed(input: string): Promise<number[]>
}
