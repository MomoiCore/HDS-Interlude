export type StoryStatus = 'active' | 'paused' | 'archived';
export interface CharacterSetting {
    name: string;
    profile: string;
}
export interface StorySetting {
    character: CharacterSetting;
    user: {
        displayName: string;
        profile: string;
    };
    relationship: string;
    world: string;
    supportingCast: string;
    location: string;
    style: string;
    timezone: string;
}
export interface StoryState {
    openThreads: string[];
    relationshipNotes: string[];
}
export interface InterludeStory {
    id: string;
    platform: string;
    selfId: string;
    userId: string;
    channelId: string;
    status: StoryStatus;
    setting: StorySetting;
    state: StoryState;
    cursorAt: Date;
    createdAt: Date;
    updatedAt: Date;
}
export interface ScriptEntry {
    id: number;
    storyId: string;
    kind: string;
    actor: string;
    content: string;
    occurredAt: Date;
    metadata: Record<string, unknown>;
    createdAt: Date;
}
export interface NarrativeMemory {
    id: number;
    storyId: string;
    category: string;
    content: string;
    importance: number;
    status: string;
    sourceEntryId: number | null;
    createdAt: Date;
    updatedAt: Date;
}
export type IntentStatus = 'pending' | 'completed' | 'cancelled';
export interface NarrativeIntent {
    id: number;
    storyId: string;
    type: string;
    summary: string;
    notBefore: Date;
    status: IntentStatus;
    payload: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}
export interface ScriptEntryDraft {
    kind: string;
    actor?: string;
    content: string;
    occurredAt?: string;
    metadata?: Record<string, unknown>;
}
export interface MemoryDraft {
    category: string;
    content: string;
    importance?: number;
}
export interface IntentDraft {
    type: string;
    summary: string;
    notBefore: string;
    payload?: Record<string, unknown>;
}
export interface OutgoingMessageDraft {
    content: string;
}
export type InteractionReplyMode = 'none' | 'immediate' | 'delayed';
export interface NarrativeInteraction {
    seen: boolean;
    reply: {
        mode: InteractionReplyMode;
        content?: string;
        sendAt?: string;
    };
}
export interface NarrativeDecision {
    /** The continuous prose written by the main narrative model. */
    script?: string;
    /** The machine-readable result placed after the prose. */
    interaction?: NarrativeInteraction;
    entries?: ScriptEntryDraft[];
    memories?: MemoryDraft[];
    intents?: IntentDraft[];
    messages?: OutgoingMessageDraft[];
    statePatch?: Partial<StoryState>;
}
export type NarrativePhase = 'advance' | 'user-message' | 'intent-due';
export interface NarrativeRequest {
    phase: NarrativePhase;
    story: InterludeStory;
    from: Date;
    now: Date;
    userMessage?: string;
    dueIntents: NarrativeIntent[];
    supersededIntents: NarrativeIntent[];
    recentEntries: ScriptEntry[];
    memories: NarrativeMemory[];
}
export interface NarrativeProvider {
    decide(request: NarrativeRequest): Promise<NarrativeDecision>;
}
export declare const emptyStorySetting: () => StorySetting;
export declare const emptyStoryState: () => StoryState;
