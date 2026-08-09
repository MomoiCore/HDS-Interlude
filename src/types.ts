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
  /** 自动推进时钟；ISO 字符串便于跨进程/数据库 JSON 持久化。 */
  automation: StoryAutomationState
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
export type StatePatchStatus = 'proposed' | 'applied' | 'rejected'

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

export interface ScriptEntryDraft {
  kind: string
  actor?: string
  content: string
  occurredAt?: string
  metadata?: Record<string, unknown>
}

export interface MemoryDraft { category: string; content: string; importance?: number; participantId?: string }
export interface IntentDraft { type: string; summary: string; notBefore: string; payload?: Record<string, unknown>; participantId?: string }
export interface OutgoingMessageDraft { participantId: string; content: string }

/** A message to another relationship branch generated in the same writing turn. */
export interface ConversationActionDraft {
  participantId: string
  mode: 'immediate' | 'delayed'
  content: string
  sendAt?: string
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
  /** The machine-readable result placed after the prose. */
  interaction?: NarrativeInteraction
  entries?: ScriptEntryDraft[]
  memories?: MemoryDraft[]
  intents?: IntentDraft[]
  messages?: OutgoingMessageDraft[]
  /** Applies to the current participant only; world state uses compaction proposals. */
  statePatch?: Partial<ParticipantState>
  /** Optional outbound actions aimed at other accounts in the same main story. */
  crossConversationActions?: ConversationActionDraft[]
}

export type NarrativePhase = 'advance' | 'user-message' | 'intent-due'

export interface NarrativeRequest {
  /** 主模型只读取经过预算控制的连续性包，不读取完整历史。 */
  phase: NarrativePhase
  story: InterludeStory
  from: Date
  now: Date
  userMessage?: string
  /** The relationship that caused this turn; null for unattended life updates. */
  participant: InterludeParticipant | null
  /** Other currently enrolled relationship branches, ordered by relevance. */
  participants: InterludeParticipant[]
  /** Sensitive details of other participants are opt-in because the model may be remote. */
  shareParticipantDetails: boolean
  dueIntents: NarrativeIntent[]
  supersededIntents: NarrativeIntent[]
  recentEntries: ScriptEntry[]
  memories: NarrativeMemory[]
  sceneContext?: SceneContext
  facts?: NarrativeFact[]
}

export interface NarrativeProvider { decide(request: NarrativeRequest): Promise<NarrativeDecision> }

export const emptyStorySetting = (): StorySetting => ({
  character: { name: 'Unnamed character', profile: '' },
  user: { displayName: '', profile: '' },
  relationship: '', world: '', supportingCast: '', location: '',
  style: 'Realistic, restrained, and centered on ordinary life.',
  timezone: 'Asia/Shanghai',
})

export const emptyStoryState = (): StoryState => ({ settingOverlay: { characterTraits: [] }, automation: {} })

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

export interface NarrativeCompactor {
  compact(request: CompactionRequest): Promise<CompactionDecision>
}

export interface NarrativeEmbedder {
  embed(input: string): Promise<number[]>
}
