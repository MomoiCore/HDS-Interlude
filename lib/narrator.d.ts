import { Context } from 'koishi';
import { CompactionDecision, CompactionRequest, GroupGateDecision, GroupGateRequest, NarrativeDecision, NarrativeProvider, OverlayCompactionDecision, OverlayCompactionRequest, NarrativeCompactor, NarrativeEmbedder, NarrativeRequest } from './types';
export type ProviderResponseFormat = 'json-object' | 'prompt-only';
export type ProviderStrategy = 'priority' | 'round-robin';
export interface ProviderConfig {
    id: string;
    label: string;
    enabled: boolean;
    endpoint: string;
    apiKey: string;
    model: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    timeout: number;
    responseFormat: ProviderResponseFormat;
    extraHeaders: string;
    extraBody: string;
}
export interface FailoverConfig {
    enabled: boolean;
    strategy: ProviderStrategy;
    maxAttemptsPerProvider: number;
    cooldownMinutes: number;
}
export interface ModelConfig {
    mode: 'fallback' | 'openai-compatible';
    providers: ProviderConfig[];
    failover: FailoverConfig;
    mainPrompt?: string;
    formatPrompt?: string;
    fixedPrompt: string;
    stylePrompt: string;
    /** Central model catalogue. Task-specific settings may reference an entry by id. */
    models?: ModelProfile[];
    mainModelId?: string;
    mainTemperature?: number;
    mainTopP?: number;
    mainMaxTokens?: number;
    mainTimeout?: number;
    mainResponseFormat?: ProviderResponseFormat;
    compaction?: CompactionConfig;
    embedding?: EmbeddingConfig;
    groupGate?: GroupGateConfig;
    /** OpenAI-compatible native image inputs for the current private-message turn. */
    vision?: VisionConfig;
}
export interface VisionConfig {
    enabled: boolean;
}
export interface ModelProfile {
    id: string;
    label: string;
    enabled?: boolean;
    providerId: string;
    model: string;
    maxTokens: number;
    timeout: number;
    responseFormat: ProviderResponseFormat;
}
export interface GroupGateConfig {
    enabled: boolean;
    modelId?: string;
    providerId: string;
    model: string;
    temperature: number;
    topP?: number;
    maxTokens: number;
    timeout: number;
    threshold: number;
    prompt: string;
}
export interface CompactionConfig {
    enabled: boolean;
    modelId?: string;
    providerId: string;
    model: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    timeout: number;
    responseFormat: ProviderResponseFormat;
    mainPrompt?: string;
    fixedPrompt: string;
    stylePrompt: string;
}
/**
 * Embedding is deliberately configured separately from chat generation. A single
 * provider can be reused for its credentials, while the endpoint and model may
 * point at a cheaper or local vector model.
 */
export interface EmbeddingConfig {
    enabled: boolean;
    /** Enable semantic query embedding on the latency-sensitive live turn. */
    liveQuery?: boolean;
    /** Reuses apiKey and extraHeaders from a configured chat provider. */
    providerId: string;
    modelId?: string;
    /** OpenAI-compatible /embeddings endpoint. Leave empty to derive it from the chat endpoint. */
    endpoint: string;
    model: string;
    /** 0 omits the optional OpenAI dimensions parameter. */
    dimensions: number;
    timeout: number;
    maxInputCharacters: number;
    /** Number of legacy facts to vectorize in each background maintenance pass. */
    backfillBatchSize: number;
}
export declare class SilentNarrator implements NarrativeProvider {
    decide(): Promise<NarrativeDecision>;
    gateGroup(): Promise<GroupGateDecision>;
}
export declare class SilentCompactor implements NarrativeCompactor {
    compact(): Promise<CompactionDecision>;
    compactOverlay(): Promise<OverlayCompactionDecision>;
}
/** A no-op embedder lets memory retrieval fall back to rule-based ranking. */
export declare class SilentEmbedder implements NarrativeEmbedder {
    embed(): Promise<number[]>;
}
/**
 * Minimal OpenAI-compatible embedding client. It intentionally performs no
 * chat-provider failover: an embedding failure is non-fatal and the caller
 * simply uses importance/confidence/recency ranking for that turn.
 */
export declare class OpenAICompatibleEmbedder implements NarrativeEmbedder {
    private ctx;
    private config;
    constructor(ctx: Context, config: ModelConfig);
    embed(input: string): Promise<number[]>;
    private selectProvider;
}
export declare class OpenAICompatibleNarrator implements NarrativeProvider {
    private ctx;
    private config;
    /**
     * 主写作与压缩共用服务商选择、冷却和 OpenAI 兼容协议；二者的提示词和
     * token/temperature 配置不同，因此同一个实例可承担两个接口。
     */
    private cooldownUntil;
    private roundRobinOffset;
    private readonly logger;
    constructor(ctx: Context, config: ModelConfig);
    decide(request: NarrativeRequest): Promise<NarrativeDecision>;
    gateGroup(request: GroupGateRequest): Promise<GroupGateDecision>;
    compact(request: CompactionRequest): Promise<CompactionDecision>;
    compactOverlay(request: OverlayCompactionRequest): Promise<OverlayCompactionDecision>;
    private selectProviders;
    /** Select the first enabled centrally registered model belonging to a backup provider. */
    private routeForProvider;
    /** Keep the user-selected model's service first, then retain normal failover order. */
    private orderPreferredProvider;
    private requestProvider;
}
export declare function createNarrator(ctx: Context, config: ModelConfig): NarrativeProvider;
export declare function createCompactor(ctx: Context, config: ModelConfig): NarrativeCompactor;
export declare function createEmbedder(ctx: Context, config: ModelConfig): NarrativeEmbedder;
export declare function phaseWritingPrompt(phase: NarrativeRequest['phase']): "CURRENT WRITING PHASE — USER EVENT: Continue from the final physical action and settled exchange in the supplied scene. Let the newly observed message batch enter at interval.now as one external event. First decide how much attention the protagonist can naturally give it within the current activity, body state, mood and completed exchange; then choose unseen, noticed-without-reply, an immediate reply or a delayed reply. A visible message is one possible life action, chosen when it carries a concrete new concern, answer, question, arrangement or relationship movement. Show the concrete activity and attention state the event meets, and let the script continue even when the natural interaction result is silence. Use the chronological activeScene transcript to resolve references such as “刚才”, “那个” or “我说过”, then continue after the completed moves already recorded there." | "CURRENT WRITING PHASE — CONVERSATION AFTERMATH: Continue the protagonist into the next piece of ordinary life after the settled exchange. Let what was understood become a proportionate feeling, practical choice, changed action, remembered commitment or open thought. Historical user messages and delivered replies are completed context. When currentParticipant.relationshipMoment is present, return relationshipMomentUpdate to keep, develop or resolve its effect as this life beat warrants. A visible message begins only when this later life beat develops a distinct afterthought, question, decision or concrete motive of its own; record that distinct step in sceneTrace.exchange.newMove. An ordinary continuation can end with interaction.reply.mode=\"none\" while preserving the relationship effect." | "CURRENT WRITING PHASE — DUE INTENT: Place each due plan inside the protagonist’s present activity and circumstances. Show whether the plan is carried out, adjusted, postponed with a new reason, or naturally resolved now. A visible message is part of the script when the protagonist actually sends it during this turn." | "CURRENT WRITING PHASE — INDEPENDENT LIFE ADVANCE: Use the full elapsed interval to continue the protagonist’s autonomous life. Let schedule, unfinished tasks, bodily needs, interests, surroundings, supporting-cast initiatives and small external developments combine into an orderly passage. End with the concrete action and situation reached at interval.now; a proactive contact may arise from a specific present motive. There is no current private message in this phase: omit sceneTrace.exchange entirely and do not restate an earlier conversation as if it were happening now.";
export declare function writingModePrompt(mode: NarrativeRequest['writingMode']): "CURRENT TIME SCALE — INSTANT EXCHANGE: Seconds to about two minutes have passed. Continue the same physical moment from sceneState.currentAction. Write only the newly reached movement, attention change, event effect and next conversational step. Keep established surroundings implicit, preserve the protagonist’s position and ongoing task, and let a few purposeful sentences carry the scene forward." | "CURRENT TIME SCALE — SHORT PASSAGE: A few minutes to about thirty minutes have passed. Advance one compact life beat from the existing action through a concrete change to its present result. Let one or two functional details move with it: an object being handled, a task step, a bodily need, a nearby person’s action or an environmental interruption." | "CURRENT TIME SCALE — MEDIUM PASSAGE: Roughly thirty minutes to two hours have passed. Select a short chronological sequence of meaningful moments. Progress the main activity and one or two grounded secondary movements—body, environment, interest, practical pressure or supporting-cast interaction—then carry their concrete consequences into the ending state." | "CURRENT TIME SCALE: Match the amount of written change to interval.from → interval.now. Preserve the current action in a dense exchange and use selected chronological anchor moments for a longer interval." | "CURRENT TIME SCALE — LONG PASSAGE: Several hours or more have passed. Represent the interval through a few time-ordered anchor moments. Follow realistic transitions such as travel, meals, rest, work or study stages, changing company and unfinished plans; preserve the causal thread between them and finish at the supplied present time.";
