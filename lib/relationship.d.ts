import { RelationshipMoment, RelationshipMomentUpdate } from './types';
type MomentOptions = {
    now: Date;
    defaultHours: number;
    maxHours: number;
};
export declare function activeRelationshipMoment(value: unknown, now: Date): RelationshipMoment | undefined;
export declare function normalizeStoredRelationshipMoment(value: unknown): RelationshipMoment | undefined;
export declare function normalizeRelationshipMomentUpdate(value: unknown, options: MomentOptions): RelationshipMomentUpdate | undefined;
export declare function applyRelationshipMomentUpdate(current: RelationshipMoment | undefined, update: RelationshipMomentUpdate | undefined, now: Date): RelationshipMoment | undefined;
/** A short aftermath pass may initiate a genuinely new contact, but a settled
 * exchange without a new conversational move is not another reply event. */
export declare function followUpHasNewContactMove(phase: string, newMove: unknown): boolean;
export {};
