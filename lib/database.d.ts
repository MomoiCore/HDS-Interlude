import { Context } from 'koishi';
import { InterludeStory, NarrativeIntent, NarrativeMemory, ScriptEntry } from './types';
declare module 'koishi' {
    interface Tables {
        interlude_story: InterludeStory;
        interlude_script_entry: ScriptEntry;
        interlude_memory: NarrativeMemory;
        interlude_intent: NarrativeIntent;
    }
}
export declare function registerTables(ctx: Context): void;
