import { Context } from 'koishi'
import {
  InterludeArc, InterludeParticipant, InterludeScene, InterludeStory, NarrativeFact, NarrativeIntent,
  NarrativeMemory, OverlaySnapshot, ScriptEntry, StatePatchProposal, WebObservation,
} from './types'

declare module 'koishi' {
  interface Tables {
    interlude_story: InterludeStory
    interlude_participant: InterludeParticipant
    interlude_script_entry: ScriptEntry
    interlude_memory: NarrativeMemory
    interlude_intent: NarrativeIntent
    interlude_scene: InterludeScene
    interlude_arc: InterludeArc
    interlude_fact: NarrativeFact
    interlude_state_patch: StatePatchProposal
    interlude_overlay_snapshot: OverlaySnapshot
    interlude_web_observation: WebObservation
  }
}

export function registerTables(ctx: Context) {
  // Koishi keeps the model registry on the parent context during plugin
  // reloads. Re-registering the same eight schemas forces minato to rebuild
  // indexes and is a noticeable source of reload latency.
  const existingTables = (ctx.model as any).tables ?? {}
  // Existing installations already have the original tables registered by a
  // parent context. Do not rebuild those schemas on reload, but keep adding
  // genuinely new tables introduced by later releases.
  if (existingTables.interlude_story) {
    if (!existingTables.interlude_web_observation) registerWebObservationTable(ctx)
    if (!existingTables.interlude_overlay_snapshot) registerOverlaySnapshotTable(ctx)
    return
  }

  // 故事表保存可追溯的 canon 与可变的当前状态；原始剧本文本不内嵌在这里。
  ctx.model.extend('interlude_story', {
    id: 'string(255)', platform: 'string(63)', selfId: 'string(63)', userId: 'string(127)',
    channelId: 'string(127)', status: 'string(16)', setting: 'json', state: 'json',
    cursorAt: 'timestamp', createdAt: 'timestamp', updatedAt: 'timestamp',
  }, { primary: 'id', indexes: ['platform', 'selfId', 'userId'] })

  // A main story belongs to one character/bot identity. Participants point to
  // individual private-message accounts and carry relationship-local state.
  ctx.model.extend('interlude_participant', {
    id: 'string(255)', storyId: 'string(255)', platform: 'string(63)', selfId: 'string(63)',
    userId: 'string(127)', channelId: 'string(127)', personId: 'string(255)',
    displayName: 'string(255)', profile: 'text', relationship: 'text', state: 'json',
    status: 'string(16)', createdAt: 'timestamp', updatedAt: 'timestamp',
  }, { primary: 'id', indexes: ['storyId', 'status', 'personId', 'userId'] })

  // 这是事实来源。场景、事实与状态变化都可以回溯到这些不可变的原始条目。
  ctx.model.extend('interlude_script_entry', {
    id: 'unsigned', storyId: 'string(255)', participantId: 'string(255)', kind: 'string(32)', actor: 'string(32)',
    content: 'text', occurredAt: 'timestamp', metadata: 'json', createdAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['storyId', 'occurredAt'] })

  ctx.model.extend('interlude_memory', {
    id: 'unsigned', storyId: 'string(255)', participantId: 'string(255)', category: 'string(32)', content: 'text',
    importance: 'double', status: 'string(16)', sourceEntryId: 'unsigned',
    createdAt: 'timestamp', updatedAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['storyId', 'importance'] })

  // intent 是未来的可能性，不是已经发生的剧情；到期后仍需模型重新裁决。
  ctx.model.extend('interlude_intent', {
    id: 'unsigned', storyId: 'string(255)', participantId: 'string(255)', type: 'string(32)', summary: 'text',
    notBefore: 'timestamp', status: 'string(16)', payload: 'json',
    createdAt: 'timestamp', updatedAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['storyId', 'status', 'notBefore'] })

  // 场景摘要是对原始条目的低 token 索引，不替代原文。
  ctx.model.extend('interlude_scene', {
    id: 'unsigned', storyId: 'string(255)', status: 'string(16)',
    startedAt: 'timestamp', endedAt: 'timestamp', hook: 'text', summary: 'text',
    entryCount: 'unsigned', lastEntryId: 'unsigned', createdAt: 'timestamp', updatedAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['storyId', 'status', 'startedAt'] })

  // 剧情弧线比场景更长，用于维持关系和长期事件的方向感。
  ctx.model.extend('interlude_arc', {
    id: 'unsigned', storyId: 'string(255)', status: 'string(16)', title: 'string(255)',
    summary: 'text', sceneCount: 'unsigned', createdAt: 'timestamp', updatedAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['storyId', 'status', 'updatedAt'] })

  // 长期事实按重要度与置信度检索，并保留来源条目供审计或重建。
  ctx.model.extend('interlude_fact', {
    id: 'unsigned', storyId: 'string(255)', participantId: 'string(255)', scope: 'string(32)', content: 'text',
    importance: 'double', confidence: 'double', unresolved: 'boolean', embedding: 'json', status: 'string(16)', sourceEntryIds: 'json',
    lastSeenAt: 'timestamp', createdAt: 'timestamp', updatedAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['storyId', 'status', 'importance'] })

  // 设定变化先以提案存在，经过证据与阈值检查后才写入 story.state 的 overlay。
  ctx.model.extend('interlude_state_patch', {
    id: 'unsigned', storyId: 'string(255)', participantId: 'string(255)', target: 'string(32)', path: 'string(255)',
    proposedValue: 'text', evidence: 'text', confidence: 'double', impact: 'string(16)',
    status: 'string(16)', sourceEntryIds: 'json', createdAt: 'timestamp', appliedAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['storyId', 'status', 'confidence'] })

  registerWebObservationTable(ctx)
  registerOverlaySnapshotTable(ctx)
}

/** Kept separately so an upgrade can register only this new table without
 * forcing Minato/sql.js to rebuild every long-lived HDSI index on reload. */
function registerWebObservationTable(ctx: Context) {
  if ((ctx.model as any).tables?.interlude_web_observation) return
  ctx.model.extend('interlude_web_observation', {
    id: 'unsigned', storyId: 'string(255)', participantId: 'string(255)', intentId: 'unsigned',
    mode: 'string(16)', query: 'text', url: 'text', title: 'text', excerpt: 'text', summary: 'text',
    status: 'string(16)', accessedAt: 'timestamp', createdAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['storyId', 'status', 'accessedAt'] })
}

/** Snapshot rows keep older overlay evolution compact without discarding the
 * original state-patch audit trail. Registered separately for fast upgrades. */
function registerOverlaySnapshotTable(ctx: Context) {
  if ((ctx.model as any).tables?.interlude_overlay_snapshot) return
  ctx.model.extend('interlude_overlay_snapshot', {
    id: 'unsigned', storyId: 'string(255)', participantId: 'string(255)', target: 'string(32)', tier: 'string(16)',
    periodStart: 'timestamp', periodEnd: 'timestamp', summary: 'text', majorEvents: 'json', sourcePatchIds: 'json',
    status: 'string(16)', createdAt: 'timestamp', updatedAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['storyId', 'status', 'target', 'periodEnd'] })
}
