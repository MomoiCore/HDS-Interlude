import { Context } from 'koishi';
import { InterludeArc, InterludeParticipant, InterludeScene, InterludeStory, NarrativeFact, NarrativeIntent, NarrativeMemory, ScriptEntry, StatePatchProposal, WebObservation } from './types';
declare module 'koishi' {
    interface Tables {
        interlude_story: InterludeStory;
        interlude_participant: InterludeParticipant;
        interlude_script_entry: ScriptEntry;
        interlude_memory: NarrativeMemory;
        interlude_intent: NarrativeIntent;
        interlude_scene: InterludeScene;
        interlude_arc: InterludeArc;
        interlude_fact: NarrativeFact;
        interlude_state_patch: StatePatchProposal;
        interlude_web_observation: WebObservation;
    }
}
export declare function registerTables(ctx: Context): void;
