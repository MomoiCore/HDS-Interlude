import { Context } from 'koishi';
import { NarrativeDecision, NarrativeProvider, NarrativeRequest } from './types';
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
    fixedPrompt: string;
    stylePrompt: string;
}
export declare class SilentNarrator implements NarrativeProvider {
    decide(): Promise<NarrativeDecision>;
}
export declare class OpenAICompatibleNarrator implements NarrativeProvider {
    private ctx;
    private config;
    private cooldownUntil;
    private roundRobinOffset;
    constructor(ctx: Context, config: ModelConfig);
    decide(request: NarrativeRequest): Promise<NarrativeDecision>;
    private selectProviders;
    private requestProvider;
}
export declare function createNarrator(ctx: Context, config: ModelConfig): NarrativeProvider;
