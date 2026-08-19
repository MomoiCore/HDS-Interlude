import { ActiveSceneEntry, NarrativeDecision, NarrativeFocus, NarrativeIntent, NarrativePhase, RecentLogicalTurn } from './types';
/** The writing task should match how much real time has actually elapsed. */
export type NarrativeWritingMode = 'instant-exchange' | 'short-passage' | 'medium-passage' | 'long-passage';
export declare function narrativeWritingMode(phase: NarrativePhase, from: Date, now: Date, hasActiveScene: boolean): NarrativeWritingMode;
export interface NarrativeFocusBalance {
    windowTurns: number;
    recentCounts: Partial<Record<NarrativeFocus, number>>;
    dominant: NarrativeFocus[];
    underusedCandidates: NarrativeFocus[];
}
/** Summarize recent narrative emphasis without another model call. Counts are
 * descriptive rather than a scheduler: the writer still checks whether an
 * underused life dimension belongs in the current scene. */
export declare function narrativeFocusBalance(turns: RecentLogicalTurn[]): NarrativeFocusBalance | undefined;
/**
 * Keep authored prose as the scene's literary continuity, while leaving
 * settled chat transport to the factual logical-turn ledger. Pending inbound
 * events remain pinned because they have not yet been incorporated.
 */
export declare function selectActiveScenePromptEntries(entries: ActiveSceneEntry[], characterBudget: number, narrativeLimit: number): ActiveSceneEntry[];
export interface RepeatedReplyMatch {
    previous: RecentLogicalTurn;
    previousReply: string;
    reason: 'same-reply' | 'same-substantial-segment' | 'near-copy' | 'same-conversation-move';
}
export interface RepeatedNarrativeMatch {
    previous: ActiveSceneEntry;
    reason: 'same-script' | 'near-copy-script';
}
/** Detect a stalled authored passage against the immediately preceding prose.
 * This only requests one revised write; it never rewrites or filters the
 * stored script locally. */
export declare function repeatedNarrativeMatch(decision: NarrativeDecision, entries: ActiveSceneEntry[]): RepeatedNarrativeMatch | undefined;
/**
 * Compare a candidate with the small settled dialogue frontier. This is a
 * correction trigger rather than a delivery-time content filter: the writer
 * gets one chance to make the next conversational move from the new event.
 * Using delivery-grounded response meanings catches a repeated speech act
 * even when the provider paraphrases the old bubbles.
 */
export declare function repeatedReplyMatch(decision: NarrativeDecision, turns: RecentLogicalTurn[]): RepeatedReplyMatch | undefined;
/** Only the head of each committed split-message turn is eligible to send. */
export declare function pendingSplitMessageHeads(intents: NarrativeIntent[]): NarrativeIntent[];
