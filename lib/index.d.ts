import { Context, Schema } from 'koishi';
import { Config as InterludeConfig, InterludeService } from './service';
declare module 'koishi' {
    interface Context {
        interlude: InterludeService;
    }
}
export declare const name = "hds-interlude";
export declare const inject: string[];
export declare const Config: Schema<InterludeConfig>;
export declare function apply(ctx: Context, config: InterludeConfig): void;
export * from './narrator';
export * from './service';
export * from './types';
