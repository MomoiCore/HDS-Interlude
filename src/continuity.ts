import { ActiveSceneEntry, NarrativeDecision, NarrativeFocus, NarrativeIntent, NarrativePhase, RecentLogicalTurn } from './types'

/** The writing task should match how much real time has actually elapsed. */
export type NarrativeWritingMode = 'instant-exchange' | 'short-passage' | 'medium-passage' | 'long-passage'

export function narrativeWritingMode(
  phase: NarrativePhase,
  from: Date,
  now: Date,
  hasActiveScene: boolean,
): NarrativeWritingMode {
  const elapsed = Math.max(0, now.getTime() - from.getTime())
  if (phase === 'user-message' && hasActiveScene && elapsed <= 2 * 60_000) return 'instant-exchange'
  if (elapsed <= 30 * 60_000) return 'short-passage'
  if (elapsed <= 2 * 60 * 60_000) return 'medium-passage'
  return 'long-passage'
}

export interface NarrativeFocusBalance {
  windowTurns: number
  recentCounts: Partial<Record<NarrativeFocus, number>>
  dominant: NarrativeFocus[]
  underusedCandidates: NarrativeFocus[]
}

/** Summarize recent narrative emphasis without another model call. Counts are
 * descriptive rather than a scheduler: the writer still checks whether an
 * underused life dimension belongs in the current scene. */
export function narrativeFocusBalance(turns: RecentLogicalTurn[]): NarrativeFocusBalance | undefined {
  const dimensions: NarrativeFocus[] = [
    'routine', 'study-work', 'interest', 'social', 'relationship',
    'body', 'environment', 'unexpected', 'reflection',
  ]
  const window = turns.slice(-12)
  const counts = new Map<NarrativeFocus, number>(dimensions.map(dimension => [dimension, 0]))
  for (const turn of window) {
    for (const dimension of new Set(turn.focus)) {
      if (counts.has(dimension)) counts.set(dimension, (counts.get(dimension) ?? 0) + 1)
    }
  }
  const used = dimensions.filter(dimension => (counts.get(dimension) ?? 0) > 0)
  if (!used.length) return undefined
  const dominant = [...dimensions]
    .sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0))
    .filter(dimension => (counts.get(dimension) ?? 0) > 0)
    .slice(0, 3)
  const underusedCandidates = [...dimensions]
    .sort((left, right) => (counts.get(left) ?? 0) - (counts.get(right) ?? 0))
    .slice(0, 4)
  return {
    windowTurns: window.length,
    recentCounts: Object.fromEntries(used.map(dimension => [dimension, counts.get(dimension)])),
    dominant,
    underusedCandidates,
  }
}

/**
 * Keep authored prose as the scene's literary continuity, while leaving
 * settled chat transport to the factual logical-turn ledger. Pending inbound
 * events remain pinned because they have not yet been incorporated.
 */
export function selectActiveScenePromptEntries(
  entries: ActiveSceneEntry[],
  characterBudget: number,
  narrativeLimit: number,
) {
  const ordered = [...entries].sort(compareSceneEntry)
  const scripts = ordered.filter(entry => entry.type === 'script').slice(-Math.max(1, narrativeLimit))
  const pendingEvents = ordered.filter(entry =>
    (entry.type === 'user-message' || entry.type === 'group-message')
    && (entry.eventStatus === 'pending' || entry.eventStatus === 'unseen'))

  const pinned = uniqueSceneEntries(pendingEvents)
  const selectedScripts: ActiveSceneEntry[] = []
  let used = pinned.reduce((sum, entry) => sum + activeSceneEntrySize(entry), 0)
  const budget = Math.max(1_000, characterBudget)

  for (let index = scripts.length - 1; index >= 0; index--) {
    const entry = scripts[index]
    // Keep the newest literary version when two adjacent model passages are
    // essentially the same. Their factual turn cards remain available, so no
    // event or action result is lost while the prompt stops amplifying a copy.
    if (selectedScripts.some(selected => nearDuplicateProse(entry.content, selected.content))) continue
    const size = activeSceneEntrySize(entry)
    if (selectedScripts.length && used + size > budget) continue
    selectedScripts.unshift(entry)
    used += size
  }

  return uniqueSceneEntries([...selectedScripts, ...pinned])
    .sort(compareSceneEntry)
}

function nearDuplicateProse(left: string, right: string) {
  const normalize = (value: string) => value.replace(/[\s\p{P}\p{S}]+/gu, '').toLocaleLowerCase()
  const a = normalize(left)
  const b = normalize(right)
  return Math.min(a.length, b.length) >= 120 && diceCoefficient(a, b) >= 0.93
}

function uniqueSceneEntries(entries: ActiveSceneEntry[]) {
  return [...new Map(entries.map(entry => [entry.id, entry])).values()]
}

function compareSceneEntry(left: ActiveSceneEntry, right: ActiveSceneEntry) {
  return left.occurredAt.getTime() - right.occurredAt.getTime()
    || numericEntryId(left.id) - numericEntryId(right.id)
}

function numericEntryId(id: string) {
  const value = Number(id.replace(/^entry:/, ''))
  return Number.isFinite(value) ? value : 0
}

function activeSceneEntrySize(entry: ActiveSceneEntry) {
  return entry.content.length
    + (entry.eventEffect?.length ?? 0)
    + 80
}

export interface RepeatedReplyMatch {
  previous: RecentLogicalTurn
  previousReply: string
  reason: 'same-reply' | 'same-substantial-segment' | 'near-copy' | 'same-conversation-move'
}

export interface RepeatedNarrativeMatch {
  previous: ActiveSceneEntry
  reason: 'same-script' | 'near-copy-script'
}

/** Detect a stalled authored passage against the immediately preceding prose.
 * This only requests one revised write; it never rewrites or filters the
 * stored script locally. */
export function repeatedNarrativeMatch(
  decision: NarrativeDecision,
  entries: ActiveSceneEntry[],
): RepeatedNarrativeMatch | undefined {
  const script = decision.script?.trim()
  if (!script) return undefined
  const previous = [...entries].reverse().find(entry => entry.type === 'script' && entry.content.trim())
  if (!previous) return undefined
  const normalize = (value: string) => value.replace(/[\s\p{P}\p{S}]+/gu, '').toLocaleLowerCase()
  const current = normalize(script)
  const settled = normalize(previous.content)
  if (Math.min(current.length, settled.length) < 160) return undefined
  if (current === settled) return { previous, reason: 'same-script' }
  if (diceCoefficient(current, settled) >= 0.82) return { previous, reason: 'near-copy-script' }
  return undefined
}

/**
 * Compare a candidate with the small settled dialogue frontier. This is a
 * correction trigger rather than a delivery-time content filter: the writer
 * gets one chance to make the next conversational move from the new event.
 * Using delivery-grounded response meanings catches a repeated speech act
 * even when the provider paraphrases the old bubbles.
 */
export function repeatedReplyMatch(
  decision: NarrativeDecision,
  turns: RecentLogicalTurn[],
): RepeatedReplyMatch | undefined {
  const content = decision.interaction?.reply?.mode === 'immediate' || decision.interaction?.reply?.mode === 'delayed'
    ? decision.interaction.reply.content?.trim() ?? ''
    : ''
  if (!content) return undefined
  const currentSignature = replySignature(content)
  if (currentSignature.length < 4) return undefined
  const currentSegments = replySegments(content)
  const currentMeaning = replySignature(decision.sceneTrace?.exchange?.newMove
    || decision.sceneTrace?.exchange?.responseMeaning || '')
  const settled = turns.filter(turn => turn.characterMessages.length).slice(-12).reverse()
  for (const previous of settled) {
    const previousReply = previous.characterMessages.join('<sep/>')
    const previousSignature = replySignature(previousReply)
    if (previousSignature.length < 4) continue
    if (currentSignature === previousSignature) return { previous, previousReply, reason: 'same-reply' }

    const previousSegments = new Set(replySegments(previousReply))
    if (currentSegments.some(segment => segment.length >= 6 && previousSegments.has(segment))) {
      return { previous, previousReply, reason: 'same-substantial-segment' }
    }

    if (Math.min(currentSignature.length, previousSignature.length) >= 8
      && diceCoefficient(currentSignature, previousSignature) >= 0.86) {
      return { previous, previousReply, reason: 'near-copy' }
    }

    const previousMeaning = replySignature(previous.exchange?.newMove || previous.exchange?.responseMeaning || '')
    if (Math.min(currentMeaning.length, previousMeaning.length) >= 8
      && diceCoefficient(currentMeaning, previousMeaning) >= 0.82) {
      return { previous, previousReply, reason: 'same-conversation-move' }
    }
  }
  return undefined
}

function replySegments(value: string) {
  return value.split(/<sep\s*\/>/i).map(replySignature).filter(Boolean)
}

function replySignature(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/<sep\s*\/>/gi, '|')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function diceCoefficient(left: string, right: string) {
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0
  const counts = new Map<string, number>()
  for (let index = 0; index < left.length - 1; index++) {
    const pair = left.slice(index, index + 2)
    counts.set(pair, (counts.get(pair) ?? 0) + 1)
  }
  let overlap = 0
  for (let index = 0; index < right.length - 1; index++) {
    const pair = right.slice(index, index + 2)
    const count = counts.get(pair) ?? 0
    if (!count) continue
    overlap++
    counts.set(pair, count - 1)
  }
  return 2 * overlap / (left.length + right.length - 2)
}

/** Only the head of each committed split-message turn is eligible to send. */
export function pendingSplitMessageHeads(intents: NarrativeIntent[]) {
  const groups = new Map<string, NarrativeIntent[]>()
  for (const intent of intents.filter(intent => intent.type === 'split-message' && intent.status === 'pending')) {
    const turnEntryId = Number(intent.payload?.turnEntryId) || 0
    const key = `${intent.participantId}\u0000${turnEntryId || 'legacy'}`
    const group = groups.get(key) ?? []
    group.push(intent)
    groups.set(key, group)
  }
  return [...groups.values()].map(group => group.sort(compareSplitIntent)[0]).sort(compareSplitIntent)
}

function compareSplitIntent(left: NarrativeIntent, right: NarrativeIntent) {
  const leftIndex = Number(left.payload?.segmentIndex)
  const rightIndex = Number(right.payload?.segmentIndex)
  const indexed = Number.isFinite(leftIndex) && Number.isFinite(rightIndex) && leftIndex !== rightIndex
  if (indexed) return leftIndex - rightIndex
  return left.createdAt.getTime() - right.createdAt.getTime()
    || left.notBefore.getTime() - right.notBefore.getTime()
    || left.id - right.id
}
