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
