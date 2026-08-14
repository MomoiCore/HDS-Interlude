import { Context, Service, Session } from 'koishi';
import { ModelConfig } from './narrator';
import { InterludeArc, InterludeScene, InterludeParticipant, InterludeStory, NarrativeFact, NarrativeIntent, NarrativeProvider, NarrativeCompactor, NarrativeEmbedder, OutgoingMessageDraft, ScriptEntry, StorySetting, StoryState } from './types';
export interface Config {
    model: ModelConfig;
    runtime: RuntimeConfig;
    storyDefaults: StoryDefaults;
    logging: LoggingConfig;
    memory?: MemoryConfig;
    sharedStory?: SharedStoryConfig;
    /** Optional, read-only browser observations powered by koishi-plugin-puppeteer. */
    browser?: BrowserConfig;
    /** Optional OneBot/NapCat account gate. It only affects the onebot platform. */
    onebot?: OneBotNapCatConfig;
}
/** One row in the Console account tables. QQ ids are strings because QQ ids
 * can exceed JavaScript's safe integer range and Koishi exposes them as text. */
export interface OneBotAccountRule {
    qq: string;
    label: string;
    enabled: boolean;
    /** Optional identity fields for a whitelisted private-message user. */
    personId?: string;
    profile?: string;
    relationship?: string;
}
export interface OneBotNapCatConfig {
    /** When false (or omitted for old configurations), OneBot access is unchanged. */
    enabled: boolean;
    /** NapCat accounts that are allowed to send the character's messages. */
    botAccounts: OneBotAccountRule[];
    /** @deprecated Kept only so old YAML can still load; runtime is allowlist-only. */
    userMode?: 'allowlist' | 'blocklist';
    userAccounts: OneBotAccountRule[];
    /** Explicit OneBot group allowlist. Group members do not need DM whitelist access. */
    groupChats?: GroupChatRule[];
    /** Prevent an echoed self-message from entering the narrative. */
    ignoreSelfMessages: boolean;
}
export interface GroupChatRule {
    groupId: string;
    label: string;
    enabled: boolean;
    purpose: string;
    characterRole: string;
    responseMode: 'mention-only' | 'selective' | 'active';
    contextLimit: number;
    debounceSeconds: number;
    cooldownSeconds: number;
}
export interface MemoryConfig {
    enabled: boolean;
    backgroundIntervalMinutes: number;
    maxStoriesPerCompactionRun: number;
    sceneEntryThreshold: number;
    sceneCharacterThreshold: number;
    compactionEntryLimit: number;
    compactionCharacterLimit: number;
    sceneHookCharacters: number;
    sceneSummaryCharacters: number;
    arcSummaryCharacters: number;
    recentEntryLimit: number;
    factLimit: number;
    factContentCharacters: number;
    factImportanceWeight: number;
    factConfidenceWeight: number;
    factRecencyWeight: number;
    semanticWeight: number;
    unresolvedWeight: number;
    statePatchConfidenceThreshold: number;
    majorStatePatchConfidenceThreshold: number;
    statePatchMinEvidence: number;
    autoApplyStatePatches: boolean;
    allowMajorStateChanges: boolean;
    maxFactsPerStory: number;
}
export interface RuntimeConfig {
    captureDirectMessages: boolean;
    autoCreate: boolean;
    ignoreCommandMessages: boolean;
    allowProactiveMessages: boolean;
    sweepIntervalMinutes: number;
    minimumAdvanceMinutes: number;
    maxStoriesPerSweep: number;
    contextEntryLimit: number;
    memoryLimit: number;
    maxScriptCharacters: number;
    maxMessageCharacters: number;
    minimumDelayedReplySeconds: number;
    maximumDelayedReplyMinutes: number;
    cancelDelayedRepliesOnUserMessage: boolean;
    /** Retry a user turn after a transient narrative-provider failure. */
    narrativeRetryDelaySeconds?: number;
    /** Maximum automatic retries per failed user turn; 0 disables retry. */
    narrativeRetryMaxAttempts?: number;
    /** Split model reply.content into multiple QQ messages at the configured separator. */
    splitReplyMessages?: boolean;
    messageSeparator?: string;
    typingBaseDelaySeconds?: number;
    typingCharactersPerSecond?: number;
    typingMaxDelaySeconds?: number;
    /** Wait after the newest user message before starting a writing request. */
    userMessageDebounceSeconds?: number;
    /** A new message inside this early request window supersedes that request. */
    staleNarrativeRequestWindowSeconds?: number;
    /** 新版自动推进调度；旧版 minimumAdvanceMinutes 仍保留兼容。 */
    autoAdvanceEnabled?: boolean;
    autoAdvanceIntervalMinutes?: number;
    autoAdvanceJitterMinutes?: number;
    pauseAfterConversationMinutes?: number;
    restWindows?: RestWindow[];
}
export interface BrowserConfig {
    enabled: boolean;
    /** Immediate browsing is opt-in because it intentionally adds one more model/browser round trip. */
    mode: 'deferred-only' | 'allow-immediate';
    allowSearch: boolean;
    allowVisit: boolean;
    searchUrlTemplate: string;
    allowedDomains: string[];
    blockedDomains: string[];
    maxConcurrentPages: number;
    /** Bound work per background sweep so a backlog cannot hold the story queue for minutes. */
    maxResearchPerSweep: number;
    navigationTimeout: number;
    waitUntil: 'domcontentloaded' | 'networkidle2';
    maxTextCharacters: number;
    maxExcerptCharacters: number;
    maxObservationsInPrompt: number;
    cacheMinutes: number;
    allowGroupTriggeredResearch: boolean;
    logObservationPreview: boolean;
}
/** Console presets that turn QQ accounts into named relationship branches. */
export interface ParticipantPreset {
    qq: string;
    personId: string;
    label: string;
    profile: string;
    relationship: string;
    enabled: boolean;
}
export interface SharedStoryConfig {
    /** One main story per bot account. Kept configurable for a safe rollback. */
    enabled: boolean;
    /** Enroll an allowed account into an existing main story on its first DM. */
    autoEnrollParticipants: boolean;
    /** Allow one incoming message to cause an explicitly justified message to another account. */
    allowCrossConversationMessages: boolean;
    /** Send other participants' relationship/profile details to the model provider. */
    shareParticipantDetails: boolean;
    /** Hard cap for cross-account messages produced by one narrative turn. */
    maxCrossConversationActions: number;
    /** Number of other relationship summaries sent to the main narrator. */
    participantContextLimit: number;
    /** Empty keeps legacy behaviour; otherwise only these QQs may run global management commands. */
    managerAccounts: string[];
    /** Optional QQ-to-person presets; accounts with the same personId share identity notes. */
    /** @deprecated Use onebot.userAccounts identity fields in new configs. */
    participantPresets?: ParticipantPreset[];
}
export interface RestWindow {
    enabled: boolean;
    label: string;
    start: string;
    end: string;
    minIntervalMinutes: number;
    maxIntervalMinutes: number;
}
export interface StoryDefaults {
    characterName: string;
    characterProfile: string;
    userProfile: string;
    relationship: string;
    world: string;
    supportingCast: string;
    location: string;
    style: string;
    timezone: string;
}
export interface LoggingConfig {
    level: 'silent' | 'error' | 'warn' | 'info' | 'debug';
    format: 'compact' | 'detailed';
    logScriptPreview: boolean;
    /** Emit user-visible incoming/outgoing message bodies to the plugin log. */
    logMessageContent?: boolean;
    previewLength: number;
}
export declare class InterludeService extends Service {
    config: Config;
    static inject: string[];
    private narrator;
    private compactor;
    private embedder;
    /**
     * 同一故事的用户消息、到期意图和后台压缩必须串行。否则“用户新消息
     * 取消旧延迟回复”可能与定时发送同时发生，造成过期消息仍被发出。
     */
    private queues;
    private bufferedNarrativeTurns;
    private bufferedGroupTurns;
    /** Prevent a background life turn from racing an unlocked live model call. */
    private narratingStories;
    private factBackfills;
    /** Coalesce repeated post-turn compaction requests into one queued pass. */
    private scheduledCompactions;
    /** sql.js/SQLite has one writable connection; serialize writes globally. */
    private databaseWriteQueue;
    /** The browser is bounded separately from narrative work so a burst of
     * deferred intents cannot spawn an uncontrolled number of Chromium pages. */
    private browserActive;
    private browserWaiters;
    /** Use Koishi's context-bound logger so Console/runtime targets receive records. */
    private readonly serviceLogger;
    private backgroundStarted;
    private databaseResetting;
    private sweepRunning;
    private compactionSweepRunning;
    constructor(ctx: Context, config: Config);
    private startBackgroundTasks;
    setNarrator(provider: NarrativeProvider): void;
    getNarrator(): NarrativeProvider;
    setCompactor(provider: NarrativeCompactor): void;
    /** Allows a custom/local vector service without replacing the main narrator. */
    setEmbedder(provider: NarrativeEmbedder): void;
    /**
     * Returns whether this session is allowed to use HDSI. Koishi's OneBot
     * adapter uses `selfId` for the logged-in bot QQ and `userId` for the sender
     * QQ. Other adapters deliberately keep their old behaviour.
     */
    canHandleSession(session: Session): boolean;
    /** Group access uses an explicit group allowlist; group members do not need
     * to be present in the private-message user whitelist. */
    canHandleGroupSession(session: Session): boolean;
    private groupRule;
    /** Same account gate for direct-message work that already has a participant. */
    canHandleParticipant(participant: InterludeParticipant): boolean;
    canManageSession(session: Session): boolean;
    /** Background life updates only require the bot account to remain enabled. */
    canHandleStory(story: InterludeStory): boolean;
    findStory(session: Session): Promise<InterludeStory>;
    /**
     * Resolve and enforce the one global active story. The preferred id wins
     * when present; otherwise the most recently updated row is retained and
     * every other active row is archived immediately.
     */
    private getCanonicalStory;
    findParticipant(session: Session, story?: InterludeStory): Promise<InterludeParticipant>;
    participants(storyId: string, includePaused?: boolean): Promise<InterludeParticipant[]>;
    createStory(session: Session, name?: string): Promise<InterludeStory>;
    /** Enrolls a QQ account as a relationship branch and refreshes its channel. */
    ensureParticipant(story: InterludeStory, session: Session, now?: Date): Promise<InterludeParticipant>;
    updateSetting(story: InterludeStory, patch: Partial<StorySetting>): Promise<{
        setting: StorySetting;
        updatedAt: Date;
        id: string;
        platform: string;
        selfId: string;
        userId: string;
        channelId: string;
        status: import("./types").StoryStatus;
        state: StoryState;
        cursorAt: Date;
        createdAt: Date;
    }>;
    setStatus(story: InterludeStory, status: InterludeStory['status']): Promise<{
        status: import("./types").StoryStatus;
        updatedAt: Date;
        id: string;
        platform: string;
        selfId: string;
        userId: string;
        channelId: string;
        setting: StorySetting;
        state: StoryState;
        cursorAt: Date;
        createdAt: Date;
    }>;
    recentEntries(storyId: string, limit?: number): Promise<import("minato").FlatPick<ScriptEntry, any>[]>;
    memories(storyId: string, limit?: number, participantId?: string): Promise<import("minato").FlatPick<import("./types").NarrativeMemory, any>[]>;
    /** Administrative view: includes global and participant-specific durable facts. */
    adminFacts(storyId: string, limit?: number): Promise<import("minato").FlatPick<NarrativeFact, any>[]>;
    adminPendingIntents(storyId: string, limit?: number): Promise<import("minato").FlatPick<NarrativeIntent, any>[]>;
    adminStatePatches(storyId: string, limit?: number): Promise<import("minato").FlatPick<import("./types").StatePatchProposal, any>[]>;
    /** Adds an audit-visible system note without pretending it came from the model. */
    addAdminScriptNote(story: InterludeStory, content: string): Promise<boolean>;
    /** Adds a high-confidence fact for corrections that must survive compaction. */
    addAdminFact(story: InterludeStory, scope: NarrativeFact['scope'], content: string): Promise<boolean>;
    /** Reversible deletion: facts are retained as superseded rows for audit. */
    forgetAdminFact(storyId: string, id: number): Promise<boolean>;
    cancelAdminIntent(storyId: string, id: number): Promise<boolean>;
    rejectAdminStatePatch(storyId: string, id: number): Promise<boolean>;
    /** Clear only the evolving setting overlay; keep Canon, script and memories. */
    clearSettingOverlay(story: InterludeStory, target: 'character' | 'relationship' | 'world' | 'all'): Promise<{
        participantCount: number;
    }>;
    private clearSettingOverlayUnlocked;
    /**
     * Destructive administrative operation. The caller must validate the
     * confirmation phrase. A full purge also rebuilds Canon from the current
     * Console configuration, so an old profile cannot survive in later prompts.
     */
    purgeAllStoryData(storyId: string): Promise<void>;
    /** Reset all platforms, retaining exactly one empty global canonical story. */
    purgeAllData(preferredStoryId?: string): Promise<string>;
    /** Delete one adapter/platform's records without touching other platforms. */
    purgePlatformData(platform: string): Promise<number>;
    /**
     * Clear only HDSI-owned tables. Koishi's users/channels and other plugins
     * are intentionally untouched; deleting the physical SQLite file from a
     * command would be unsafe while the driver is open.
     */
    clearDatabase(): Promise<{
        removed: number;
        logicallyCleared: number;
    }>;
    /** Remove script and derived memory records whose timestamps overlap a range. */
    purgeStoryRange(storyId: string, from: Date, to: Date): Promise<void>;
    /** Entry point for configured OneBot group chats. Group members do not need
     * private-message authorization; the group allowlist controls access. */
    receiveGroup(session: Session): Promise<boolean>;
    receive(session: Session): Promise<boolean>;
    private groupSenderName;
    private bufferGroupMessage;
    private flushGroupTurn;
    private groupMessages;
    private groupCooldownActive;
    private sendGroupMessage;
    /**
     * Persisted messages wait here briefly before they reach the narrator. This
     * makes “你好 / 在吗 / 我有件事想问” one event without risking message loss.
     */
    private bufferUserNarrative;
    /** Prevent timers or already-returning model calls from resurrecting data
     * after an administrator resets the story or clears HDSI tables. */
    private invalidateBufferedNarratives;
    /** True while a live or debounced conversation should take priority over background work. */
    private hasPendingNarrative;
    private flushBufferedNarrative;
    advanceStory(story: InterludeStory, force?: boolean): Promise<OutgoingMessageDraft[]>;
    /** Used by commands/tests to deliver a mixed set of account-targeted actions safely. */
    deliverMessages(story: InterludeStory, messages: OutgoingMessageDraft[], session?: Session): Promise<void>;
    compactStory(story: InterludeStory, force?: boolean): Promise<boolean>;
    sweep(): Promise<void>;
    private advanceUnlocked;
    private decide;
    private tryDecide;
    private persistDecision;
    private appendEntry;
    private appendMemory;
    /**
     * Retrieves the smallest useful slice of durable facts. When an embedding
     * model is available, semantic relevance is combined with narrative quality
     * signals instead of replacing them; a failed vector lookup simply has a
     * semantic score of zero for this turn.
     */
    facts(storyId: string, limit?: number, query?: string, participantId?: string): Promise<import("minato").FlatPick<NarrativeFact, any>[]>;
    /** Returns only observations that are safe for this narration branch. A
     * participant's browsing is not shown to another private participant unless
     * the owner has explicitly enabled shared relationship details. */
    private webObservations;
    activeScene(storyId: string): Promise<InterludeScene | null>;
    activeArc(storyId: string): Promise<InterludeArc | null>;
    private appendIntent;
    /** Stores a narrator-proposed browser action as a future intent. The model
     * never writes page content directly; a separate Puppeteer task creates the
     * observation later. */
    private appendBrowserIntent;
    /** Executes a due browser intent once, records its bounded observation, and
     * marks the future plan complete regardless of success. A failed browser is
     * still an event (the character could not access the page), but it never
     * blocks later dialogue or background life updates. */
    private executeDeferredBrowserIntent;
    /** Read a page through Koishi Puppeteer. This is intentionally read-only:
     * it rejects non-public destinations, extracts visible text only, and closes
     * the page after every observation. */
    private collectWebObservation;
    private saveWebObservation;
    /** Immediate browser reads are intentionally held in memory until the
     * final narrator result survives the stale-request check. This prevents an
     * obsolete two-second message burst from leaving a durable web event behind. */
    private persistCollectedWebObservation;
    private findCachedWebObservation;
    private withBrowserSlot;
    /** Persist a bounded retry so a transient provider failure cannot strand a user turn. */
    private scheduleNarrativeRetry;
    private dueIntents;
    private cancelPendingOutgoingMessages;
    private sendScheduledMessages;
    /**
     * Immediate replies may reuse the incoming Session; cross-account and timed
     * messages are delivered through the target participant's channel instead.
     * This is the boundary that prevents a shared story from accidentally
     * sending every reply back to the account that happened to trigger the turn.
     */
    private sendOutgoingMessages;
    private splitOutgoingMessage;
    private typingDelayMilliseconds;
    /** Deliver a separated chat bubble without blocking the next narrative turn. */
    private deliverSegment;
    private findBotForParticipant;
    private get autoAdvanceConfig();
    private isAutomaticAdvancePaused;
    private isAutomaticAdvanceDue;
    private pauseAutomaticAdvanceAfterUserMessage;
    private pauseAutomaticAdvanceAfterDelayedReply;
    private pauseAutomaticAdvance;
    private scheduleNextAutomaticAdvance;
    private get sharedStoryConfig();
    private participantPreset;
    /** The clean Canon used both by story creation and a full administrative reset. */
    private initialStorySetting;
    /** Rebuild per-account relationship baselines and discard evolving state. */
    private resetParticipantCanon;
    private userAccountRule;
    private getParticipant;
    private recordIncomingMessage;
    private markParticipantSeen;
    private recordCharacterMessage;
    private updateParticipantState;
    /** Converts one old account-bound story into a bot-bound shared story once. */
    private migrateLegacyStory;
    /**
     * A deployment can contain several old per-account stories. Once the first
     * one created the shared story, fold later legacy branches into it as their
     * users return; otherwise their old active rows would keep being swept in
     * parallel and create a second life for the same character.
     */
    private migrateLegacyBranchIntoShared;
    private get memoryConfig();
    private get browserConfig();
    private ensureContinuity;
    private scheduleCompaction;
    private compactStories;
    private compactUnlocked;
    private persistCompaction;
    private persistFact;
    private embedText;
    private scheduleFactEmbeddingBackfill;
    private backfillFactEmbeddings;
    private persistStatePatch;
    private report;
    private reportStandalone;
    private getStory;
    private serial;
    private dbWrite;
    private retryDbWrite;
    private dbCreate;
    private dbSet;
    private dbRemove;
    /**
     * SQLite/sql.js may fail physical DELETE when its backing file is locked.
     * Fall back to redaction so an administrative purge still completes and the
     * removed content is no longer exposed to prompts or management commands.
     */
    private purgeTable;
}
