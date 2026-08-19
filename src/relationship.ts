import { RelationshipMoment, RelationshipMomentUpdate } from './types'

type MomentOptions = {
  now: Date
  defaultHours: number
  maxHours: number
}

export function activeRelationshipMoment(value: unknown, now: Date): RelationshipMoment | undefined {
  const moment = normalizeStoredRelationshipMoment(value)
  if (!moment) return undefined
  const expiresAt = new Date(moment.expiresAt)
  return Number.isFinite(expiresAt.getTime()) && expiresAt > now ? moment : undefined
}

export function normalizeStoredRelationshipMoment(value: unknown): RelationshipMoment | undefined {
  if (!record(value)) return undefined
  const characterPosition = clipped(value.characterPosition, 600)
  const communicationPosture = clipped(value.communicationPosture, 600)
  const updatedAt = dateString(value.updatedAt)
  const expiresAt = dateString(value.expiresAt)
  if ((!characterPosition && !communicationPosture) || !updatedAt || !expiresAt) return undefined
  const userSignal = normalizeSignal(value.userSignal)
  return {
    ...(userSignal ? { userSignal } : {}),
    characterPosition,
    communicationPosture,
    ...(clipped(value.openNeed, 500) ? { openNeed: clipped(value.openNeed, 500) } : {}),
    alreadyExpressed: strings(value.alreadyExpressed, 8, 300),
    intensity: number(value.intensity, 0.5),
    updatedAt,
    expiresAt,
  }
}

export function normalizeRelationshipMomentUpdate(value: unknown, options: MomentOptions): RelationshipMomentUpdate | undefined {
  if (!record(value) || !['keep', 'update', 'resolve'].includes(String(value.action))) return undefined
  const action = value.action as RelationshipMomentUpdate['action']
  if (action !== 'update') return { action }
  const maximum = options.now.getTime() + boundedHours(options.maxHours, 168) * 3_600_000
  const fallback = options.now.getTime() + Math.min(boundedHours(options.defaultHours, 24), boundedHours(options.maxHours, 168)) * 3_600_000
  const requested = Date.parse(String(value.expiresAt ?? ''))
  const expiresAt = new Date(Math.min(Number.isFinite(requested) && requested > options.now.getTime() ? requested : fallback, maximum)).toISOString()
  const userSignal = normalizeSignal(value.userSignal)
  const characterPosition = clipped(value.characterPosition, 600)
  const communicationPosture = clipped(value.communicationPosture, 600)
  const openNeed = clipped(value.openNeed, 500)
  const alreadyExpressed = strings(value.alreadyExpressed, 8, 300)
  if (!userSignal && !characterPosition && !communicationPosture && !openNeed && !alreadyExpressed.length) return undefined
  return {
    action,
    ...(userSignal ? { userSignal } : {}),
    ...(characterPosition ? { characterPosition } : {}),
    ...(communicationPosture ? { communicationPosture } : {}),
    ...(openNeed ? { openNeed } : {}),
    ...(alreadyExpressed.length ? { alreadyExpressed } : {}),
    intensity: number(value.intensity, 0.55),
    expiresAt,
  }
}

export function applyRelationshipMomentUpdate(current: RelationshipMoment | undefined, update: RelationshipMomentUpdate | undefined, now: Date): RelationshipMoment | undefined {
  if (!update || update.action === 'keep') return activeRelationshipMoment(current, now)
  if (update.action === 'resolve') return undefined
  const characterPosition = update.characterPosition || current?.characterPosition || ''
  const communicationPosture = update.communicationPosture || current?.communicationPosture || ''
  if (!characterPosition && !communicationPosture) return undefined
  return {
    ...(update.userSignal || current?.userSignal ? { userSignal: update.userSignal || current?.userSignal } : {}),
    characterPosition,
    communicationPosture,
    ...(update.openNeed || current?.openNeed ? { openNeed: update.openNeed || current?.openNeed } : {}),
    alreadyExpressed: update.alreadyExpressed ?? current?.alreadyExpressed ?? [],
    intensity: update.intensity ?? current?.intensity ?? 0.55,
    updatedAt: now.toISOString(),
    expiresAt: update.expiresAt || current?.expiresAt || new Date(now.getTime() + 24 * 3_600_000).toISOString(),
  }
}

/** A short aftermath pass may initiate a genuinely new contact, but a settled
 * exchange without a new conversational move is not another reply event. */
export function followUpHasNewContactMove(phase: string, newMove: unknown) {
  return phase !== 'conversation-follow-up' || !!clipped(newMove, 500)
}

function normalizeSignal(value: unknown): RelationshipMoment['userSignal'] | undefined {
  if (!record(value)) return undefined
  const summary = clipped(value.summary, 500)
  const basis = String(value.basis)
  const evidenceIds = strings(value.evidenceIds, 12, 100)
  if (!summary || !evidenceIds.length || !['observed-expression', 'character-inference', 'shared-event'].includes(basis)) return undefined
  return { summary, basis: basis as RelationshipMoment['userSignal']['basis'], confidence: number(value.confidence, 0.5), evidenceIds }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clipped(value: unknown, limit: number) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function strings(value: unknown, limit: number, characters: number) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter(item => typeof item === 'string').map(item => item.trim().slice(0, characters)).filter(Boolean))).slice(0, limit)
    : []
}

function number(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

function dateString(value: unknown) {
  if (typeof value !== 'string') return ''
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function boundedHours(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Math.min(720, value)) : fallback
}
