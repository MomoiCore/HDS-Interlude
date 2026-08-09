import { Context, Service, Session } from 'koishi';
import { ModelConfig } from './narrator';
import { InterludeStory, NarrativeProvider, OutgoingMessageDraft, ScriptEntry, StorySetting, StoryState } from './types';
export interface Config {
    model: ModelConfig;
    runtime: RuntimeConfig;
    storyDefaults: StoryDefaults;
    logging: LoggingConfig;
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
    previewLength: number;
}
export declare class InterludeService extends Service {
    config: Config;
    static inject: string[];
    private narrator;
    private queues;
    constructor(ctx: Context, config: Config);
    setNarrator(provider: NarrativeProvider): void;
    getNarrator(): NarrativeProvider;
    findStory(session: Session): Promise<InterludeStory>;
    createStory(session: Session, name?: string): Promise<InterludeStory>;
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
    recentEntries(storyId: string, limit?: number): Promise<ScriptEntry[]>;
    memories(storyId: string, limit?: number): Promise<import("./types").NarrativeMemory[]>;
    receive(session: Session): Promise<boolean>;
    advanceStory(story: InterludeStory, force?: boolean): Promise<OutgoingMessageDraft[]>;
    sweep(): Promise<void>;
    private advanceUnlocked;
    private decide;
    private tryDecide;
    private persistDecision;
    private appendEntry;
    private appendMemory;
    private appendIntent;
    private dueIntents;
    private cancelPendingDelayedReplies;
    private sendScheduledMessages;
    private report;
    private getStory;
    private serial;
}
