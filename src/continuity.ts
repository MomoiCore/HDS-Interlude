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
 * Build one chronological source of short-term truth for the writer.
 *
 * A previous refactor kept prose here but moved settled user/character
 * messages into separate semantic cards. That made a single exchange appear
 * several times in the prompt: once as prose, once as a model summary, and
 * once as a dialogue ledger. In dense conversations the model then imitated
 * its own summaries instead of continuing the actual sequence. Keep the
 * recent script and the confirmed transport that belongs beside it together.
 */
export function selectActiveScenePromptEntries(
  entries: ActiveSceneEntry[],
  characterBudget: number,
  narrativeLimit: number,
) {
  const ordered = [...entries].sort(compareSceneEntry)
  const scripts = ordered.filter(entry => entry.type === 'script')
  const selectedScripts = scripts.slice(-Math.max(1, narrativeLimit))
  const pendingEvents = ordered.filter(entry =>
    (entry.type === 'user-message' || entry.type === 'group-message')
    && (entry.eventStatus === 'pending' || entry.eventStatus === 'unseen'))
  if (!selectedScripts.length) return uniqueSceneEntries(pendingEvents).sort(compareSceneEntry)

  // Start just after the script that precedes the retained window. This
  // includes the user event immediately before the first retained script,
  // every delivered bubble produced by retained turns, and their original
  // chronological order. A current event is removed later by service.ts, so
  // it still has exactly one owner: currentEvent.
  const firstScript = selectedScripts[0]
  const firstScriptIndex = ordered.findIndex(entry => entry.id === firstScript.id)
  let startIndex = 0
  for (let index = firstScriptIndex - 1; index >= 0; index--) {
    if (ordered[index].type === 'script') {
      startIndex = index + 1
      break
    }
  }
  const transcript = ordered.slice(startIndex)
  const selectedIds = new Set(selectedScripts.map(entry => entry.id))
  const kept = transcript.filter(entry =>
    selectedIds.has(entry.id)
    || entry.type === 'user-message'
    || entry.type === 'group-message'
    || entry.type === 'character-message'
    || entry.type === 'character-group-message')

  // The normal budget is intentionally generous enough for complete turns.
  // If an owner explicitly lowers it, retain the newest contiguous suffix
  // instead of dropping messages from the middle of a turn.
  const selected: ActiveSceneEntry[] = []
  let used = 0
  const budget = Math.max(1_000, characterBudget)
  for (let index = kept.length - 1; index >= 0; index--) {
    const entry = kept[index]
    const size = activeSceneEntrySize(entry)
    if (selected.length && used + size > budget) break
    selected.unshift(entry)
    used += size
  }
  // A pending source event is never optional, even when a small manual
  // budget has already filled the transcript.
  return uniqueSceneEntries([...selected, ...pendingEvents])
    .sort(compareSceneEntry)
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
