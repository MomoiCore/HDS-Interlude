var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  Config: () => Config,
  InterludeService: () => InterludeService,
  OpenAICompatibleNarrator: () => OpenAICompatibleNarrator,
  SilentNarrator: () => SilentNarrator,
  apply: () => apply,
  createNarrator: () => createNarrator,
  emptyStorySetting: () => emptyStorySetting,
  emptyStoryState: () => emptyStoryState,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(src_exports);
var import_koishi3 = require("koishi");

// src/service.ts
var import_koishi2 = require("koishi");

// src/database.ts
function registerTables(ctx) {
  ctx.model.extend("interlude_story", {
    id: "string(255)",
    platform: "string(63)",
    selfId: "string(63)",
    userId: "string(127)",
    channelId: "string(127)",
    status: "string(16)",
    setting: "json",
    state: "json",
    cursorAt: "timestamp",
    createdAt: "timestamp",
    updatedAt: "timestamp"
  }, { primary: "id", indexes: ["platform", "selfId", "userId"] });
  ctx.model.extend("interlude_script_entry", {
    id: "unsigned",
    storyId: "string(255)",
    kind: "string(32)",
    actor: "string(32)",
    content: "text",
    occurredAt: "timestamp",
    metadata: "json",
    createdAt: "timestamp"
  }, { primary: "id", autoInc: true, indexes: ["storyId", "occurredAt"] });
  ctx.model.extend("interlude_memory", {
    id: "unsigned",
    storyId: "string(255)",
    category: "string(32)",
    content: "text",
    importance: "double",
    status: "string(16)",
    sourceEntryId: "unsigned",
    createdAt: "timestamp",
    updatedAt: "timestamp"
  }, { primary: "id", autoInc: true, indexes: ["storyId", "importance"] });
  ctx.model.extend("interlude_intent", {
    id: "unsigned",
    storyId: "string(255)",
    type: "string(32)",
    summary: "text",
    notBefore: "timestamp",
    status: "string(16)",
    payload: "json",
    createdAt: "timestamp",
    updatedAt: "timestamp"
  }, { primary: "id", autoInc: true, indexes: ["storyId", "status", "notBefore"] });
}
__name(registerTables, "registerTables");

// src/narrator.ts
var import_koishi = require("koishi");
var logger = new import_koishi.Logger("hds-interlude");
var SilentNarrator = class {
  static {
    __name(this, "SilentNarrator");
  }
  async decide() {
    return {};
  }
};
var OpenAICompatibleNarrator = class {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }
  static {
    __name(this, "OpenAICompatibleNarrator");
  }
  cooldownUntil = /* @__PURE__ */ new Map();
  roundRobinOffset = 0;
  async decide(request) {
    const providers = this.selectProviders();
    if (!providers.length) throw new Error("No enabled OpenAI-compatible provider is available.");
    const failures = [];
    for (const provider of providers) {
      const attempts = Math.max(1, this.config.failover.maxAttemptsPerProvider);
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await this.requestProvider(provider, request);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failures.push(`${provider.label || provider.id} (attempt ${attempt}): ${detail}`);
          logger.warn("Narrative provider %s failed: %s", provider.label || provider.id, detail);
        }
      }
      this.cooldownUntil.set(provider.id, Date.now() + this.config.failover.cooldownMinutes * 6e4);
      if (!this.config.failover.enabled) break;
    }
    throw new Error(`All narrative providers failed. ${failures.join(" | ")}`);
  }
  selectProviders() {
    const enabled = this.config.providers.filter((provider) => provider.enabled && provider.endpoint && provider.model);
    const now = Date.now();
    const ready = enabled.filter((provider) => (this.cooldownUntil.get(provider.id) ?? 0) <= now);
    const candidates = ready.length ? ready : enabled;
    if (!candidates.length) return [];
    const ordered = this.config.failover.strategy === "round-robin" ? rotate(candidates, this.roundRobinOffset++) : candidates;
    return this.config.failover.enabled ? ordered : ordered.slice(0, 1);
  }
  async requestProvider(provider, request) {
    const response = await this.ctx.http.post(provider.endpoint, {
      ...parseObject(provider.extraBody, "extraBody"),
      model: provider.model,
      temperature: provider.temperature,
      top_p: provider.topP,
      ...provider.maxTokens > 0 ? { max_tokens: provider.maxTokens } : {},
      ...provider.responseFormat === "json-object" ? { response_format: { type: "json_object" } } : {},
      messages: [
        { role: "system", content: systemPrompt(this.config.fixedPrompt, this.config.stylePrompt, request.story.setting.style) },
        { role: "user", content: JSON.stringify(toPromptPayload(request)) }
      ]
    }, {
      headers: {
        "content-type": "application/json",
        ...provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
        ...parseObject(provider.extraHeaders, "extraHeaders")
      },
      timeout: provider.timeout
    });
    const content = response.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((item) => item.text ?? "").join("") : content;
    if (!text) throw new Error("Narrative provider returned an empty response.");
    try {
      return JSON.parse(extractJson(text));
    } catch (error) {
      logger.warn("Narrative provider returned invalid JSON: %s", error);
      throw new Error("Narrative provider returned invalid JSON.");
    }
  }
};
function createNarrator(ctx, config) {
  return config.mode === "openai-compatible" ? new OpenAICompatibleNarrator(ctx, config) : new SilentNarrator();
}
__name(createNarrator, "createNarrator");
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced?.[1] ?? text;
}
__name(extractJson, "extractJson");
function parseObject(value, field) {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
  }
  logger.warn("Ignoring invalid provider %s JSON.", field);
  return {};
}
__name(parseObject, "parseObject");
function rotate(values, offset) {
  const start = offset % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}
__name(rotate, "rotate");
function systemPrompt(fixedPrompt, baseStylePrompt, storyStylePrompt) {
  return [
    "FORMAT AND REALITY CONTRACT (fixed by the plugin; do not change it):",
    "You are the main narrative author for HDS Interlude, a persistent one-to-one life script.",
    "Return one JSON object with a continuous prose field named script, followed by a structured interaction result.",
    "The script must cover the supplied interval, incorporate the external user event when present, and stop at the point where the character has finished deciding whether to speak.",
    "The structured interaction object must have this shape:",
    '{"seen":true,"reply":{"mode":"none|immediate|delayed","content":"message text when mode is immediate or delayed","sendAt":"ISO-8601 strictly after now when mode is delayed"}}',
    "Use seen=false and reply.mode=none when the character has not noticed the message. Use seen=true and reply.mode=none when the character noticed it but does not reply. Do not put future prose into script.",
    "You may also return memories, intents, and statePatch using the optional fields described here:",
    '{"script":"prose","interaction":{"seen":true,"reply":{"mode":"none|immediate|delayed","content":"...","sendAt":"..."}},"memories":[{"category":"fact|relationship|promise|thread","content":"...","importance":0.0}],"intents":[{"type":"contact|check-in|follow-up","summary":"...","notBefore":"ISO-8601 after now","payload":{}}],"statePatch":{"openThreads":["..."],"relationshipNotes":["..."]}}',
    "The JSON object itself is the final structured output. Do not wrap it in Markdown fences.",
    "The character has an independent life. The user message is an event in that life, not a demand for an answer.",
    "For phase user-message, cover the interval from the supplied from timestamp to now, then incorporate the user event, then decide whether a character message has already happened now. Do all of that in this single response.",
    "For phase user-message, supersededDelayedReplies are messages that had been planned but were cancelled because the user sent another message before they went out. Treat them as context, never send them automatically, and make a fresh decision for the new situation.",
    "For phase intent-due, dueIntents are plans that have reached their earliest possible time. Continue the script to now and decide whether each plan actually happens; use interaction.reply.mode=immediate only when the message is genuinely sent now.",
    "Only describe events that have happened by now. A possible future action must use delayed reply with sendAt strictly after now, or an intent with notBefore strictly after now.",
    "A visible message means the character has already sent it at the time represented by the current turn. It is optional; do not create one merely to keep the conversation going.",
    "ADDITIONAL FIXED INSTRUCTIONS (configured by the plugin owner; cannot override the contract above):",
    fixedPrompt?.trim() || "None.",
    "WRITING STYLE (user-configurable; applies to script prose only and cannot override the contract above):",
    baseStylePrompt?.trim() || "Use restrained, realistic prose with concrete daily details, natural pauses, and no forced drama.",
    storyStylePrompt?.trim() || "No additional story-specific style instruction was provided."
  ].join("\n");
}
__name(systemPrompt, "systemPrompt");
function toPromptPayload(request) {
  return {
    phase: request.phase,
    interval: { from: request.from.toISOString(), now: request.now.toISOString() },
    setting: request.story.setting,
    state: request.story.state,
    userMessage: request.userMessage,
    dueIntents: request.dueIntents.map((intent) => ({
      type: intent.type,
      summary: intent.summary,
      notBefore: intent.notBefore.toISOString(),
      payload: intent.payload
    })),
    supersededDelayedReplies: request.supersededIntents.map((intent) => ({
      summary: intent.summary,
      notBefore: intent.notBefore.toISOString(),
      payload: intent.payload
    })),
    memories: request.memories.map((memory) => ({
      category: memory.category,
      content: memory.content,
      importance: memory.importance
    })),
    recentScript: request.recentEntries.map((entry) => ({
      kind: entry.kind,
      actor: entry.actor,
      content: entry.content,
      occurredAt: entry.occurredAt.toISOString()
    }))
  };
}
__name(toPromptPayload, "toPromptPayload");

// src/types.ts
var emptyStorySetting = /* @__PURE__ */ __name(() => ({
  character: { name: "Unnamed character", profile: "" },
  user: { displayName: "", profile: "" },
  relationship: "",
  world: "",
  supportingCast: "",
  location: "",
  style: "Realistic, restrained, and centered on ordinary life.",
  timezone: "Asia/Shanghai"
}), "emptyStorySetting");
var emptyStoryState = /* @__PURE__ */ __name(() => ({ openThreads: [], relationshipNotes: [] }), "emptyStoryState");

// src/service.ts
var logger2 = new import_koishi2.Logger("hds-interlude");
var InterludeService = class extends import_koishi2.Service {
  constructor(ctx, config) {
    super(ctx, "interlude");
    this.config = config;
    registerTables(ctx);
    this.narrator = createNarrator(ctx, config.model);
    ctx.setInterval(() => void this.sweep().catch((error) => logger2.warn(error)), Math.max(1, config.runtime.sweepIntervalMinutes) * import_koishi2.Time.minute);
  }
  static {
    __name(this, "InterludeService");
  }
  static inject = ["database", "http"];
  narrator;
  queues = /* @__PURE__ */ new Map();
  setNarrator(provider) {
    this.narrator = provider;
  }
  getNarrator() {
    return this.narrator;
  }
  async findStory(session) {
    const id = storyIdFor(session.platform, session.selfId, session.userId);
    return (await this.ctx.database.get("interlude_story", { id }))[0];
  }
  async createStory(session, name2) {
    const existing = await this.findStory(session);
    if (existing) return existing;
    const now = /* @__PURE__ */ new Date();
    const setting = emptyStorySetting();
    const defaults = this.config.storyDefaults;
    setting.character.name = name2?.trim() || defaults.characterName || setting.character.name;
    setting.character.profile = defaults.characterProfile;
    setting.user.displayName = session.username || session.userId;
    setting.user.profile = defaults.userProfile;
    setting.relationship = defaults.relationship;
    setting.world = defaults.world;
    setting.supportingCast = defaults.supportingCast;
    setting.location = defaults.location;
    setting.style = defaults.style || setting.style;
    setting.timezone = defaults.timezone || setting.timezone;
    const story = {
      id: storyIdFor(session.platform, session.selfId, session.userId),
      platform: session.platform,
      selfId: session.selfId,
      userId: session.userId,
      channelId: session.channelId,
      status: "active",
      setting,
      state: emptyStoryState(),
      cursorAt: now,
      createdAt: now,
      updatedAt: now
    };
    await this.ctx.database.create("interlude_story", story);
    await this.appendEntry(story.id, {
      kind: "setup",
      actor: "system",
      content: `The story begins with ${setting.character.name}.`,
      occurredAt: now.toISOString(),
      metadata: {}
    }, now);
    return story;
  }
  async updateSetting(story, patch) {
    const setting = mergeSetting(story.setting, patch);
    const now = /* @__PURE__ */ new Date();
    await this.ctx.database.set("interlude_story", { id: story.id }, { setting, updatedAt: now });
    return { ...story, setting, updatedAt: now };
  }
  async setStatus(story, status) {
    const now = /* @__PURE__ */ new Date();
    await this.ctx.database.set("interlude_story", { id: story.id }, { status, updatedAt: now });
    return { ...story, status, updatedAt: now };
  }
  async recentEntries(storyId, limit = this.config.runtime.contextEntryLimit) {
    const rows = await this.ctx.database.get("interlude_script_entry", { storyId });
    return rows.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, limit).reverse();
  }
  async memories(storyId, limit = this.config.runtime.memoryLimit) {
    const rows = await this.ctx.database.get("interlude_memory", { storyId, status: "active" });
    return rows.sort((a, b) => b.importance - a.importance || b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, limit);
  }
  async receive(session) {
    let story = await this.findStory(session);
    if (!story && this.config.runtime.autoCreate) story = await this.createStory(session);
    if (!story || story.status !== "active") return false;
    await this.ctx.database.set("interlude_story", { id: story.id }, { channelId: session.channelId, updatedAt: /* @__PURE__ */ new Date() });
    const messages = await this.serial(story.id, async () => {
      const current = await this.getStory(story.id);
      const now = /* @__PURE__ */ new Date();
      const from = new Date(current.cursorAt);
      const superseded = this.config.runtime.cancelDelayedRepliesOnUserMessage ? await this.cancelPendingDelayedReplies(current.id, now) : [];
      const due = await this.dueIntents(current.id, now);
      const { decision, succeeded } = await this.tryDecide(current, "user-message", from, now, session.content, due, superseded);
      await this.appendEntry(current.id, {
        kind: "user-message",
        actor: "user",
        content: session.content,
        occurredAt: now.toISOString(),
        metadata: { platform: session.platform, messageId: session.messageId }
      }, now);
      const messages2 = await this.persistDecision(current, decision, from, now, true, "user-message");
      await this.ctx.database.set("interlude_story", { id: current.id }, { cursorAt: now, updatedAt: now });
      if (succeeded && due.length) {
        await this.ctx.database.set("interlude_intent", { id: { $in: due.map((intent) => intent.id) } }, { status: "completed", updatedAt: now });
      }
      return messages2;
    });
    for (const message of messages) await session.send(message.content);
    return true;
  }
  async advanceStory(story, force = true) {
    return this.serial(story.id, async () => this.advanceUnlocked(await this.getStory(story.id), /* @__PURE__ */ new Date(), force));
  }
  async sweep() {
    const stories = await this.ctx.database.get("interlude_story", { status: "active" });
    const sorted = stories.sort((a, b) => a.cursorAt.getTime() - b.cursorAt.getTime());
    for (const story of sorted.slice(0, this.config.runtime.maxStoriesPerSweep)) {
      const messages = await this.advanceStory(story, false);
      if (messages.length) await this.sendScheduledMessages(story, messages);
    }
  }
  async advanceUnlocked(story, now, force) {
    const from = new Date(story.cursorAt);
    const elapsed = Math.max(0, now.getTime() - from.getTime());
    const due = await this.dueIntents(story.id, now);
    if (!force && elapsed < this.config.runtime.minimumAdvanceMinutes * import_koishi2.Time.minute && !due.length) return [];
    const messages = [];
    if (elapsed > 0) {
      const { decision } = await this.tryDecide(story, "advance", from, now, void 0, []);
      messages.push(...await this.persistDecision(story, decision, from, now, this.config.runtime.allowProactiveMessages, "advance"));
    }
    await this.ctx.database.set("interlude_story", { id: story.id }, { cursorAt: now, updatedAt: now });
    if (due.length) {
      const current = await this.getStory(story.id);
      const { decision, succeeded } = await this.tryDecide(current, "intent-due", now, now, void 0, due);
      const permitMessages = this.config.runtime.allowProactiveMessages || due.some((intent) => intent.payload?.userInitiated === true);
      messages.push(...await this.persistDecision(current, decision, now, now, permitMessages, "intent-due"));
      if (succeeded) {
        await this.ctx.database.set("interlude_intent", { id: { $in: due.map((intent) => intent.id) } }, { status: "completed", updatedAt: now });
      }
    }
    return messages;
  }
  async decide(story, phase, from, now, userMessage, dueIntents, supersededIntents = []) {
    return this.narrator.decide({
      phase,
      story,
      from,
      now,
      userMessage,
      dueIntents,
      supersededIntents,
      recentEntries: await this.recentEntries(story.id),
      memories: await this.memories(story.id)
    });
  }
  async tryDecide(story, phase, from, now, userMessage, dueIntents, supersededIntents = []) {
    try {
      const result = {
        decision: await this.decide(story, phase, from, now, userMessage, dueIntents, supersededIntents),
        succeeded: true
      };
      if (this.config.logging.logScriptPreview && result.decision.script) {
        this.report("debug", story, phase, "script preview: %s", result.decision.script.slice(0, this.config.logging.previewLength));
      }
      return result;
    } catch (error) {
      this.report("warn", story, phase, "narrative decision failed: %s", error);
      return { decision: {}, succeeded: false };
    }
  }
  async persistDecision(story, raw, from, now, permitMessages, phase) {
    const decision = normalizeDecision(raw, from, now, permitMessages, this.config.runtime);
    if (decision.script) {
      await this.appendEntry(story.id, {
        kind: "script",
        actor: "narrator",
        content: decision.script,
        occurredAt: now.toISOString(),
        metadata: { phase, interaction: decision.interaction ?? null }
      }, now);
    }
    for (const entry of decision.entries) await this.appendEntry(story.id, entry, now);
    for (const memory of decision.memories) await this.appendMemory(story.id, memory, now);
    for (const intent of decision.intents) await this.appendIntent(story.id, intent, now);
    if (decision.statePatch) await this.ctx.database.set("interlude_story", { id: story.id }, { state: mergeState(story.state, decision.statePatch), updatedAt: now });
    const messages = [...decision.messages];
    const interaction = decision.interaction;
    if (permitMessages && interaction?.reply.mode === "immediate" && interaction.reply.content) {
      messages.push({ content: interaction.reply.content });
    }
    if (permitMessages && interaction?.reply.mode === "delayed" && interaction.reply.content && interaction.reply.sendAt) {
      await this.appendIntent(story.id, {
        type: "delayed-reply",
        summary: "The character decided to send a delayed reply.",
        notBefore: interaction.reply.sendAt,
        payload: {
          content: interaction.reply.content,
          userInitiated: phase === "user-message",
          interaction: true
        }
      }, now);
    }
    for (const message of messages) {
      await this.appendEntry(story.id, {
        kind: "character-message",
        actor: "character",
        content: message.content,
        occurredAt: now.toISOString(),
        metadata: { visible: true, interaction: interaction ?? null }
      }, now);
    }
    return messages;
  }
  async appendEntry(storyId, entry, now) {
    const occurredAt = toDate(entry.occurredAt) ?? now;
    await this.ctx.database.create("interlude_script_entry", {
      storyId,
      kind: clip(entry.kind, 32) || "life",
      actor: clip(entry.actor ?? "character", 32),
      content: clip(entry.content, 12e3),
      occurredAt,
      metadata: isRecord(entry.metadata) ? entry.metadata : {},
      createdAt: now
    });
  }
  async appendMemory(storyId, memory, now) {
    await this.ctx.database.create("interlude_memory", {
      storyId,
      category: clip(memory.category, 32) || "fact",
      content: clip(memory.content, 4e3),
      importance: clampNumber(memory.importance, 0.5, 0, 1),
      status: "active",
      sourceEntryId: null,
      createdAt: now,
      updatedAt: now
    });
  }
  async appendIntent(storyId, intent, now) {
    const notBefore = toDate(intent.notBefore);
    if (!notBefore || notBefore <= now) return;
    await this.ctx.database.create("interlude_intent", {
      storyId,
      type: clip(intent.type, 32) || "follow-up",
      summary: clip(intent.summary, 4e3),
      notBefore,
      status: "pending",
      payload: isRecord(intent.payload) ? intent.payload : {},
      createdAt: now,
      updatedAt: now
    });
  }
  async dueIntents(storyId, now) {
    const intents = await this.ctx.database.get("interlude_intent", { storyId, status: "pending" });
    return intents.filter((intent) => intent.notBefore <= now);
  }
  async cancelPendingDelayedReplies(storyId, now) {
    const intents = await this.ctx.database.get("interlude_intent", {
      storyId,
      status: "pending",
      type: "delayed-reply"
    });
    if (!intents.length) return intents;
    await this.ctx.database.set("interlude_intent", { id: { $in: intents.map((intent) => intent.id) } }, {
      status: "cancelled",
      updatedAt: now
    });
    await this.appendEntry(storyId, {
      kind: "intent-cancelled",
      actor: "system",
      content: "A newer user message superseded a pending delayed reply.",
      occurredAt: now.toISOString(),
      metadata: { intentIds: intents.map((intent) => intent.id) }
    }, now);
    return intents;
  }
  async sendScheduledMessages(story, messages) {
    const bot = this.ctx.bots.find((bot2) => bot2.platform === story.platform && bot2.selfId === story.selfId);
    if (!bot) return this.report("warn", story, "intent-due", "no bot is available for scheduled delivery");
    for (const message of messages) await bot.sendMessage(story.channelId, message.content);
  }
  report(level, story, phase, message, ...args) {
    const rank = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
    if (rank[this.config.logging.level] < rank[level]) return;
    const prefix = this.config.logging.format === "compact" ? `${phase} ${story.id}` : `story=${story.id} phase=${phase} character=${story.setting.character.name}`;
    const output = `${prefix} ${message}`;
    if (level === "error") logger2.error(output, ...args);
    else if (level === "warn") logger2.warn(output, ...args);
    else if (level === "info") logger2.info(output, ...args);
    else logger2.debug(output, ...args);
  }
  async getStory(id) {
    const story = (await this.ctx.database.get("interlude_story", { id }))[0];
    if (!story) throw new Error(`Interlude story not found: ${id}`);
    return story;
  }
  serial(id, task) {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(task);
    this.queues.set(id, current);
    void current.then(
      () => {
        if (this.queues.get(id) === current) this.queues.delete(id);
      },
      () => {
        if (this.queues.get(id) === current) this.queues.delete(id);
      }
    );
    return current;
  }
};
function storyIdFor(platform, selfId, userId) {
  return `${platform}:${selfId}:${userId}`;
}
__name(storyIdFor, "storyIdFor");
function normalizeDecision(raw, from, now, permitMessages, runtime) {
  const script = typeof raw?.script === "string" ? raw.script.trim().slice(0, runtime.maxScriptCharacters) : "";
  const interaction = normalizeInteraction(raw?.interaction, now, runtime);
  const entries = Array.isArray(raw?.entries) ? raw.entries.filter((entry) => validEntry(entry, from, now)) : [];
  const memories = Array.isArray(raw?.memories) ? raw.memories.filter(validMemory) : [];
  const intents = Array.isArray(raw?.intents) ? raw.intents.filter((intent) => validIntent(intent, now)) : [];
  const messages = permitMessages && Array.isArray(raw?.messages) ? raw.messages.filter((message) => validMessage(message, runtime.maxMessageCharacters)) : [];
  const statePatch = isRecord(raw?.statePatch) ? pickStatePatch(raw.statePatch) : void 0;
  return { script, interaction, entries, memories, intents, messages, statePatch };
}
__name(normalizeDecision, "normalizeDecision");
function normalizeInteraction(value, now, runtime) {
  if (!isRecord(value) || typeof value.seen !== "boolean" || !isRecord(value.reply)) return void 0;
  const mode = value.reply.mode;
  if (mode !== "none" && mode !== "immediate" && mode !== "delayed") return void 0;
  const content = typeof value.reply.content === "string" ? value.reply.content.trim().slice(0, runtime.maxMessageCharacters) : void 0;
  const sendAt = toDate(value.reply.sendAt);
  if (!value.seen) return { seen: false, reply: { mode: "none" } };
  if (mode === "none") return { seen: true, reply: { mode: "none" } };
  if (!content) return { seen: true, reply: { mode: "none" } };
  if (mode === "immediate") return { seen: true, reply: { mode, content } };
  const delay = sendAt?.getTime() - now.getTime();
  if (!sendAt || delay < runtime.minimumDelayedReplySeconds * 1e3 || delay > runtime.maximumDelayedReplyMinutes * import_koishi2.Time.minute) return { seen: true, reply: { mode: "none" } };
  return { seen: true, reply: { mode, content, sendAt: sendAt.toISOString() } };
}
__name(normalizeInteraction, "normalizeInteraction");
function validEntry(value, from, now) {
  if (!isRecord(value) || typeof value.content !== "string" || !value.content.trim()) return false;
  const occurredAt = value.occurredAt === void 0 ? now : toDate(value.occurredAt);
  return !!occurredAt && occurredAt >= from && occurredAt <= now;
}
__name(validEntry, "validEntry");
function validMemory(value) {
  return isRecord(value) && typeof value.category === "string" && typeof value.content === "string" && !!value.content.trim();
}
__name(validMemory, "validMemory");
function validIntent(value, now) {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.summary !== "string") return false;
  const notBefore = toDate(value.notBefore);
  return !!notBefore && notBefore > now;
}
__name(validIntent, "validIntent");
function validMessage(value, maxLength) {
  return isRecord(value) && typeof value.content === "string" && !!value.content.trim() && value.content.length <= maxLength;
}
__name(validMessage, "validMessage");
function pickStatePatch(value) {
  const patch = {};
  if (Array.isArray(value.openThreads) && value.openThreads.every((item) => typeof item === "string")) patch.openThreads = value.openThreads.map((item) => clip(item, 500)).slice(0, 50);
  if (Array.isArray(value.relationshipNotes) && value.relationshipNotes.every((item) => typeof item === "string")) patch.relationshipNotes = value.relationshipNotes.map((item) => clip(item, 500)).slice(0, 50);
  return patch;
}
__name(pickStatePatch, "pickStatePatch");
function mergeSetting(base, patch) {
  return { ...base, ...patch, character: { ...base.character, ...patch.character }, user: { ...base.user, ...patch.user } };
}
__name(mergeSetting, "mergeSetting");
function mergeState(base, patch) {
  return { ...base, ...patch };
}
__name(mergeState, "mergeState");
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? void 0 : value;
  if (typeof value !== "string" && typeof value !== "number") return void 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? void 0 : date;
}
__name(toDate, "toDate");
function clip(value, length) {
  return typeof value === "string" ? value.trim().slice(0, length) : "";
}
__name(clip, "clip");
function clampNumber(value, fallback, min, max) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
__name(clampNumber, "clampNumber");

// src/index.ts
var name = "hds-interlude";
var inject = ["database", "http"];
var defaultProvider = {
  id: "primary",
  label: "Primary provider",
  enabled: true,
  endpoint: "",
  apiKey: "",
  model: "",
  temperature: 0.8,
  topP: 1,
  maxTokens: 4096,
  timeout: 6e4,
  responseFormat: "json-object",
  extraHeaders: "",
  extraBody: ""
};
var Provider = import_koishi3.Schema.object({
  id: import_koishi3.Schema.string().default("primary").description("稳定的服务商标识。故障冷却与轮询都以它区分。"),
  label: import_koishi3.Schema.string().default("Primary provider").description("仅用于 Koishi 界面和日志显示。"),
  enabled: import_koishi3.Schema.boolean().default(true).description("关闭后不会被选中，也不会参与故障切换。"),
  endpoint: import_koishi3.Schema.string().default("").description("OpenAI Chat Completions 兼容接口地址。"),
  apiKey: import_koishi3.Schema.string().role("secret").default("").description("服务商 API Key。"),
  model: import_koishi3.Schema.string().default("").description("该服务商使用的模型名称。"),
  temperature: import_koishi3.Schema.number().min(0).max(2).default(0.8).description("采样温度。较低更稳定，较高更有变化。"),
  topP: import_koishi3.Schema.number().min(0).max(1).default(1).description("核采样参数。通常保持 1，或与温度配合微调。"),
  maxTokens: import_koishi3.Schema.natural().min(0).max(1e5).default(4096).description("单次生成上限；设为 0 时不传该参数。"),
  timeout: import_koishi3.Schema.natural().min(1e3).max(3e5).default(6e4).role("ms").description("单次请求超时。"),
  responseFormat: import_koishi3.Schema.union(["json-object", "prompt-only"]).default("json-object").description("服务商支持 JSON Mode 时选 json-object；否则依靠提示词约束 JSON。"),
  extraHeaders: import_koishi3.Schema.string().role("textarea").default("").description('额外请求头 JSON，例如 {"X-Region":"..."}。API Key 会自动作为 Authorization 发送。'),
  extraBody: import_koishi3.Schema.string().role("textarea").default("").description("服务商专属请求体 JSON，例如 reasoning_effort。核心 model/messages 参数会由插件覆盖。")
});
var Failover = import_koishi3.Schema.object({
  enabled: import_koishi3.Schema.boolean().default(true).description("当前服务商失败后，自动尝试下一个可用服务商。"),
  strategy: import_koishi3.Schema.union(["priority", "round-robin"]).default("priority").description("priority 按列表顺序；round-robin 在可用服务商之间轮换。"),
  maxAttemptsPerProvider: import_koishi3.Schema.natural().min(1).max(5).default(1).description("每个服务商切换前的最大尝试次数。"),
  cooldownMinutes: import_koishi3.Schema.natural().min(0).max(1440).default(5).description("服务商连续失败后的冷却时间。")
});
var Model = import_koishi3.Schema.object({
  mode: import_koishi3.Schema.union(["fallback", "openai-compatible"]).default("fallback").description("fallback 只记录剧本；openai-compatible 启用下方服务商。"),
  providers: import_koishi3.Schema.array(Provider).role("table").default([defaultProvider]).description("按优先级排序的模型/服务商列表。每行可使用不同 endpoint、密钥和模型。"),
  failover: Failover.default({ enabled: true, strategy: "priority", maxAttemptsPerProvider: 1, cooldownMinutes: 5 }).description("故障切换策略。"),
  fixedPrompt: import_koishi3.Schema.string().role("textarea").default("").description("追加到固定系统约束后的长期规则，例如内容边界、角色伦理或世界运行规则。不能覆盖插件的 JSON 与时间约束。"),
  stylePrompt: import_koishi3.Schema.string().role("textarea").default("Use restrained, realistic prose with concrete daily details, natural pauses, and no forced drama.").description("全局文风提示词，只作用于剧本正文。单个故事还可以用 style 覆盖或补充。")
});
var Runtime = import_koishi3.Schema.object({
  captureDirectMessages: import_koishi3.Schema.boolean().default(true).description("接管已创建 HDSI 剧本的私聊消息。"),
  autoCreate: import_koishi3.Schema.boolean().default(false).description("首次私聊时自动创建剧本；关闭时需先使用 interlude.init。"),
  ignoreCommandMessages: import_koishi3.Schema.boolean().default(true).description("不把 interlude 指令当作角色收到的聊天消息。"),
  allowProactiveMessages: import_koishi3.Schema.boolean().default(false).description("允许后台推进在没有新用户消息时主动联系。"),
  sweepIntervalMinutes: import_koishi3.Schema.natural().min(1).max(1440).default(5).description("后台检查到期意图与生活推进的间隔。"),
  minimumAdvanceMinutes: import_koishi3.Schema.natural().min(1).max(10080).default(30).description("空闲剧本经过多久才触发一次后台生活补写。"),
  maxStoriesPerSweep: import_koishi3.Schema.natural().min(1).max(1e3).default(20).description("每次后台扫描最多推进的剧本数量。"),
  contextEntryLimit: import_koishi3.Schema.natural().min(1).max(200).default(30).description("单次写作带入的最近剧本片段数量。"),
  memoryLimit: import_koishi3.Schema.natural().min(1).max(200).default(20).description("单次写作带入的长期记忆数量。"),
  maxScriptCharacters: import_koishi3.Schema.natural().min(500).max(12e3).default(8e3).description("每次模型写出的剧本正文最大字符数。"),
  maxMessageCharacters: import_koishi3.Schema.natural().min(1).max(12e3).default(2e3).description("单条可见角色消息最大字符数。"),
  minimumDelayedReplySeconds: import_koishi3.Schema.natural().min(0).max(86400).default(10).description("模型可以安排的最短延迟回复时间。"),
  maximumDelayedReplyMinutes: import_koishi3.Schema.natural().min(1).max(43200).default(1440).description("模型可以安排的最长延迟回复时间。"),
  cancelDelayedRepliesOnUserMessage: import_koishi3.Schema.boolean().default(true).description("用户在延迟回复发送前再次发消息时，取消旧计划并让主模型重新裁决。")
});
var StoryDefaults = import_koishi3.Schema.object({
  characterName: import_koishi3.Schema.string().default("Unnamed character").description("新剧本默认主角名。"),
  characterProfile: import_koishi3.Schema.string().role("textarea").default("").description("新剧本默认主角设定。"),
  userProfile: import_koishi3.Schema.string().role("textarea").default("").description("用户在角色视角中的默认背景。"),
  relationship: import_koishi3.Schema.string().role("textarea").default("").description("初始人物关系与过去经历。"),
  world: import_koishi3.Schema.string().role("textarea").default("").description("世界观、时代、社会规则和当前背景。"),
  supportingCast: import_koishi3.Schema.string().role("textarea").default("").description("配角、亲友、同事及其与主角的关系。"),
  location: import_koishi3.Schema.string().default("").description("故事默认城市或生活地点。"),
  style: import_koishi3.Schema.string().role("textarea").default("现实主义日常叙事，情绪克制，关系变化缓慢而具体。").description("新剧本的专属文风提示词。"),
  timezone: import_koishi3.Schema.string().default("Asia/Shanghai").description("故事默认时区，用于日程、延迟回复和时间感。")
});
var Logging = import_koishi3.Schema.object({
  level: import_koishi3.Schema.union(["silent", "error", "warn", "info", "debug"]).default("warn").description("HDSI 插件日志等级。不会修改 Koishi 其他插件的全局日志设置。"),
  format: import_koishi3.Schema.union(["compact", "detailed"]).default("compact").description("compact 便于扫描；detailed 会附带剧本和角色上下文。"),
  logScriptPreview: import_koishi3.Schema.boolean().default(false).description("在 debug 日志中输出模型剧本正文开头。可能包含聊天内容。"),
  previewLength: import_koishi3.Schema.natural().min(50).max(4e3).default(500).description("剧本预览最大字符数。")
});
var Config = import_koishi3.Schema.object({
  model: Model.description("模型服务商、故障切换与系统提示词。"),
  runtime: Runtime.description("消息接管、时间推进、上下文和延迟回复策略。"),
  storyDefaults: StoryDefaults.description("新建剧本时预填的角色与世界设定。"),
  logging: Logging.description("HDSI 插件自身的日志详细程度。")
});
function apply(ctx, config) {
  const service = new InterludeService(ctx, config);
  registerCommands(ctx, service);
  ctx.middleware(async (session, next) => {
    if (!config.runtime.captureDirectMessages || !session.isDirect || !session.content?.trim()) return next();
    if (config.runtime.ignoreCommandMessages && looksLikeInterludeCommand(session.content)) return next();
    const consumed = await service.receive(session);
    return consumed ? void 0 : next();
  });
}
__name(apply, "apply");
function registerCommands(ctx, service) {
  ctx.command("interlude", "HDS Interlude story controls");
  ctx.command("interlude.init [name:text]", "Create a direct-message story").action(async ({ session }, name2) => {
    const existing = await service.findStory(session);
    if (existing) return `A story already exists for ${existing.setting.character.name}.`;
    const story = await service.createStory(session, name2);
    return `Interlude started for ${story.setting.character.name}. Use interlude.setup with JSON to add the setting.`;
  });
  ctx.command("interlude.setup <json:text>", "Merge story setting JSON").action(async ({ session }, json) => {
    const story = await requireStory(service, session);
    if (typeof story === "string") return story;
    try {
      const patch = JSON.parse(json);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Setting must be a JSON object.");
      const updated = await service.updateSetting(story, patch);
      return `Setting saved for ${updated.setting.character.name}.`;
    } catch (error) {
      return `Invalid JSON: ${error.message}`;
    }
  });
  ctx.command("interlude.status", "Show story state").action(async ({ session }) => {
    const story = await requireStory(service, session);
    if (typeof story === "string") return story;
    return [
      `Character: ${story.setting.character.name}`,
      `Status: ${story.status}`,
      `Cursor: ${story.cursorAt.toISOString()}`,
      `Model: ${service.config.model.mode}`,
      `Proactive messages: ${service.config.runtime.allowProactiveMessages ? "on" : "off"}`
    ].join("\n");
  });
  ctx.command("interlude.pause", "Pause automatic message handling").action(async ({ session }) => changeStatus(service, session, "paused"));
  ctx.command("interlude.resume", "Resume automatic message handling").action(async ({ session }) => changeStatus(service, session, "active"));
  ctx.command("interlude.advance", "Advance the script to the present time").action(async ({ session }) => {
    const story = await requireStory(service, session);
    if (typeof story === "string") return story;
    const messages = await service.advanceStory(story);
    for (const message of messages) await session.send(message.content);
    return messages.length ? "The script advanced and visible actions were delivered." : "The script advanced. No visible action occurred.";
  });
  ctx.command("interlude.timeline [limit:number]", "Inspect recent script entries").action(async ({ session }, limit = 10) => {
    const story = await requireStory(service, session);
    if (typeof story === "string") return story;
    const entries = await service.recentEntries(story.id, Math.max(1, Math.min(limit, 30)));
    if (!entries.length) return "The script is empty.";
    return entries.map((entry) => `[${entry.occurredAt.toISOString()}] ${entry.actor}/${entry.kind}: ${entry.content}`).join("\n");
  });
  ctx.command("interlude.memory [limit:number]", "Inspect durable narrative memories").action(async ({ session }, limit = 10) => {
    const story = await requireStory(service, session);
    if (typeof story === "string") return story;
    const memories = await service.memories(story.id, Math.max(1, Math.min(limit, 30)));
    if (!memories.length) return "No durable memories have been extracted yet.";
    return memories.map((memory) => `[${memory.category}/${memory.importance.toFixed(2)}] ${memory.content}`).join("\n");
  });
}
__name(registerCommands, "registerCommands");
async function requireStory(service, session) {
  return await service.findStory(session) ?? "No Interlude story exists here. Start with interlude.init.";
}
__name(requireStory, "requireStory");
async function changeStatus(service, session, status) {
  const story = await requireStory(service, session);
  if (typeof story === "string") return story;
  await service.setStatus(story, status);
  return `Interlude is now ${status}.`;
}
__name(changeStatus, "changeStatus");
function looksLikeInterludeCommand(content) {
  return /^[!/.]?interlude(?:\s|$)/i.test(content.trim());
}
__name(looksLikeInterludeCommand, "looksLikeInterludeCommand");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Config,
  InterludeService,
  OpenAICompatibleNarrator,
  SilentNarrator,
  apply,
  createNarrator,
  emptyStorySetting,
  emptyStoryState,
  inject,
  name
});
