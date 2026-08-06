import { AuthorityError } from "../../authorityStore.mjs";
import { deriveActivityStatePatch } from "../runtime/activityState.mjs";

export const V2_NATIVE_COMMAND_TYPES = new Set([
  "runtime.message.commit",
  "runtime.activity.commit",
  "memory.node.put",
  "memory.node.delete",
  "memory.vector.put",
  "memory.vector.delete",
  "memory.link.put",
  "memory.link.delete",
  "memory.event_box.put",
  "memory.event_box.delete",
  "memory.room_plate.put",
  "memory.room_plate.delete",
  "runtime.anticipation.put",
  "runtime.anticipation.delete",
  "memory.digest.put",
  "memory.digest.delete",
  "schedule.job.put",
  "schedule.job.cancel",
  "character.state.patch",
]);

const clean = (value) => value === undefined || value === null ? "" : String(value).trim();

function normalizeError(error) {
  if (error instanceof AuthorityError) return error;
  return new AuthorityError(error?.code || "V2_NATIVE_COMMAND_FAILED", String(error?.message || error), Number(error?.status || 500), error?.details);
}

function mergeObject(current, patch) {
  const result = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    result[key] = value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])
      ? mergeObject(result[key], value)
      : value;
  }
  return result;
}

function unsetPath(target, path) {
  const parts = String(path || "").replace(/^\//, "").split(path?.startsWith("/") ? "/" : ".").filter(Boolean).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (!parts.length) return;
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!cursor[parts[index]] || typeof cursor[parts[index]] !== "object") return;
    cursor = cursor[parts[index]];
  }
  delete cursor[parts.at(-1)];
}

export class RuntimeV2NativeCommandExecutor {
  constructor(authorityStore, { protocolVersion = "1.0" } = {}) {
    this.store = authorityStore;
    this.runtime = authorityStore.runtimeV2;
    this.protocolVersion = protocolVersion;
  }

  execute(command) {
    if (!V2_NATIVE_COMMAND_TYPES.has(command.type)) throw new AuthorityError("COMMAND_TYPE_UNSUPPORTED", `Unsupported V2 native command: ${command.type}`, 400);
    if (this.runtime.authorityMode() !== "v2") throw new AuthorityError("V2_AUTHORITY_NOT_PROMOTED", "V2 native commands require promoted V2 authority", 409, { authorityMode: this.runtime.authorityMode() });
    try {
      return this.store.transaction(() => this.executeTransaction(command));
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code !== "IDEMPOTENCY_CONFLICT") this.recordFailure(command, normalized);
      throw normalized;
    }
  }

  executeTransaction(command) {
    const admitted = this.store.createCommand(command);
    if (!admitted.created) {
      if (admitted.command.status === "completed" || admitted.command.status === "failed") return { created: false, idempotentReplay: true, command: admitted.command, events: this.store.listCommandEvents(command.commandId), result: admitted.command.result };
      if (admitted.command.status === "processing") throw new AuthorityError("COMMAND_IN_PROGRESS", "Command is already being processed", 409, { commandId: command.commandId });
    } else {
      this.store.appendEvent({ commandId: command.commandId, type: "command.accepted", characterId: command.characterId, worldId: command.worldId, occurredAt: new Date().toISOString(), protocolVersion: command.protocolVersion || this.protocolVersion, payload: { commandType: command.type, actorId: command.actorId } });
    }
    const started = this.store.startCommand(command.commandId);
    if (!started.started) throw new AuthorityError("COMMAND_IN_PROGRESS", "Command could not be claimed", 409, { commandId: command.commandId });
    const applied = this.apply(command);
    const nativeMutationSeq = applied.mutated ? this.runtime.bumpNativeMutationSequence() : this.runtime.nativeMutationSequence();
    const event = this.store.appendEvent({ commandId: command.commandId, type: applied.eventType, characterId: command.characterId, worldId: command.worldId, entityVersion: applied.entityVersion, occurredAt: applied.occurredAt || new Date().toISOString(), protocolVersion: command.protocolVersion || this.protocolVersion, payload: applied.eventPayload });
    if (command.type === "runtime.activity.commit" && clean(command.payload?.wakeRunId)) {
      const wakeRun = this.runtime.getCcWakeRun(clean(command.payload.wakeRunId));
      this.runtime.completeCcWakeRun(clean(command.payload.wakeRunId), clean(command.payload.leaseToken), { resultEventId: event.eventId });
      this.runtime.putCcSession(clean(command.characterId), { sessionId: command.payload.sessionId, lastSeenMessageSeq: wakeRun?.contextToMessageSeq || 0, lastSeenEventId: wakeRun?.contextToEventId || 0, lastWakeAt: new Date().toISOString(), status: "idle" });
    }
    const targets = Array.isArray(command.payload?.deliveryTargets) ? command.payload.deliveryTargets : [];
    const deliveries = this.store.enqueueOutboxForEvent(event.eventId, targets);
    const result = { ...applied.result, eventId: event.eventId, deliveries: deliveries.map((item) => item.deliveryId), nativeMutationSeq };
    const completed = this.store.finishCommand(command.commandId, { status: "completed", result });
    return { created: admitted.created, idempotentReplay: false, command: completed, events: this.store.listCommandEvents(command.commandId), result };
  }

  apply(command) {
    const payload = command.payload || {}, characterId = clean(command.characterId || payload.characterId || payload.charId);
    if (command.type === "runtime.message.commit") {
      const message = { ...(payload.message || payload), characterId };
      delete message.deliveryTargets;
      const committed = this.runtime.commitMessage(message);
      const surface = clean(committed.message.surface || "chat");
      return { eventType: surface === "chat" ? "message.created" : `${surface}.message.created`, occurredAt: committed.message.occurredAt, eventPayload: { message: committed.message, created: committed.created }, result: { message: committed.message, created: committed.created }, mutated: committed.created };
    }
    if (command.type === "runtime.activity.commit") {
      if (!characterId || !clean(payload.activity?.content || payload.content)) throw new AuthorityError("VALIDATION_FAILED", "characterId and activity content are required", 400);
      const activitySpec = payload.activity || payload;
      const activity = this.runtime.commitMessage({ ...activitySpec, messageId: clean(activitySpec.messageId || activitySpec.activityId) || `${command.commandId}:activity`, characterId, role: "assistant", surface: "activity", visibility: clean(activitySpec.visibility || "internal"), origin: "cc", metadata: { ...(activitySpec.metadata || {}), wakeRunId: payload.wakeRunId || null, commandId: command.commandId } });
      let userMessage = null;
      if (clean(payload.userMessage?.content)) userMessage = this.runtime.commitMessage({ ...payload.userMessage, messageId: clean(payload.userMessage.messageId) || `${command.commandId}:message`, characterId, role: clean(payload.userMessage.role || "assistant"), surface: "chat", visibility: "user", origin: "cc", metadata: { ...(payload.userMessage.metadata || {}), wakeRunId: payload.wakeRunId || null, commandId: command.commandId } });
      const current = this.runtime.getCharacterState(characterId);
      const explicitPatch = payload.statePatch && typeof payload.statePatch === "object" && !Array.isArray(payload.statePatch) ? payload.statePatch : {};
      const patch = mergeObject(deriveActivityStatePatch(activitySpec), explicitPatch);
      const next = mergeObject(current?.state || {}, patch), state = Object.keys(patch).length ? this.runtime.putCharacterState(characterId, next, { expectedVersion: payload.expectedStateVersion ?? current?.version ?? 0 }) : { changed: false, state: current };
      if (state.changed) this.runtime.appendStateEvent(characterId, state.state.version, { patch, source: "cc-activity", wakeRunId: payload.wakeRunId || null }, command.commandId);
      const maxMessageSeq = Math.max(activity.message.messageSeq || 0, userMessage?.message?.messageSeq || 0);
      return { eventType: "activity.committed", entityVersion: state.state?.version, occurredAt: activity.message.occurredAt, eventPayload: { activity: activity.message, userMessage: userMessage?.message || null, state: state.state, wakeRunId: payload.wakeRunId || null }, result: { activity: activity.message, userMessage: userMessage?.message || null, state: state.state }, maxMessageSeq, mutated: activity.created || Boolean(userMessage?.created) || state.changed };
    }
    if (command.type === "memory.node.put") {
      const saved = this.runtime.putMemoryNode({ ...(payload.memory || payload), characterId }, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.node.upserted", entityVersion: saved.memory.version, eventPayload: { memory: saved.memory, created: saved.created, changed: saved.changed }, result: saved, mutated: saved.changed };
    }
    if (command.type === "memory.node.delete") {
      const memoryId = clean(payload.memoryId || payload.id);
      if (!memoryId) throw new AuthorityError("VALIDATION_FAILED", "memoryId is required", 400);
      const memory = this.runtime.deleteMemoryNode(memoryId, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.node.deleted", entityVersion: memory.version, eventPayload: { memoryId, deletedAt: memory.deletedAt }, result: { memory }, mutated: true };
    }
    if (command.type === "memory.vector.put") {
      const vector = { ...(payload.vectorRecord || payload.vector || payload), characterId };
      delete vector.deliveryTargets;
      const saved = this.runtime.putMemoryVector(vector, { expectedVersion: command.expectedVersion });
      const descriptor = { memoryId: saved.vector.memoryId, version: saved.vector.version, characterId: saved.vector.characterId, model: saved.vector.model, dimensions: saved.vector.dimensions, vectorHash: saved.vector.vectorHash, updatedAt: saved.vector.updatedAt };
      return { eventType: "memory.vector.upserted", entityVersion: saved.vector.version, eventPayload: { vector: descriptor, created: saved.created, changed: saved.changed }, result: { ...saved, vector: descriptor }, mutated: saved.changed };
    }
    if (command.type === "memory.vector.delete") {
      const memoryId = clean(payload.memoryId || payload.id);
      const vector = this.runtime.deleteMemoryVector(memoryId, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.vector.deleted", entityVersion: vector.version, eventPayload: { memoryId, deletedAt: vector.deletedAt }, result: { vector: { ...vector, vector: undefined } }, mutated: true };
    }
    if (command.type === "memory.link.put") {
      const link = { ...(payload.link || payload), characterId };
      delete link.deliveryTargets;
      const saved = this.runtime.putMemoryLink(link, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.link.upserted", entityVersion: saved.link.version, eventPayload: saved, result: saved, mutated: saved.changed };
    }
    if (command.type === "memory.link.delete") {
      const linkId = clean(payload.linkId || payload.id), link = this.runtime.deleteMemoryLink(linkId, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.link.deleted", entityVersion: link.version, eventPayload: { linkId, deletedAt: link.deletedAt }, result: { link }, mutated: true };
    }
    if (command.type === "memory.event_box.put") {
      const eventBox = { ...(payload.eventBox || payload), characterId };
      delete eventBox.deliveryTargets;
      const saved = this.runtime.putEventBox(eventBox, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.event_box.upserted", entityVersion: saved.eventBox.version, eventPayload: saved, result: saved, mutated: saved.changed };
    }
    if (command.type === "memory.event_box.delete") {
      const eventBoxId = clean(payload.eventBoxId || payload.id), eventBox = this.runtime.deleteEventBox(eventBoxId, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.event_box.deleted", entityVersion: eventBox.version, eventPayload: { eventBoxId, deletedAt: eventBox.deletedAt }, result: { eventBox }, mutated: true };
    }
    if (command.type === "memory.room_plate.put") {
      const roomPlate = { ...(payload.roomPlate || payload), characterId };
      delete roomPlate.deliveryTargets;
      const saved = this.runtime.putRoomPlate(roomPlate, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.room_plate.upserted", entityVersion: saved.roomPlate.version, eventPayload: saved, result: saved, mutated: saved.changed };
    }
    if (command.type === "memory.room_plate.delete") {
      const roomPlateId = clean(payload.roomPlateId || payload.id), roomPlate = this.runtime.deleteRoomPlate(roomPlateId, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.room_plate.deleted", entityVersion: roomPlate.version, eventPayload: { roomPlateId, deletedAt: roomPlate.deletedAt }, result: { roomPlate }, mutated: true };
    }
    if (command.type === "runtime.anticipation.put") {
      const anticipation = { ...(payload.anticipation || payload), characterId };
      delete anticipation.deliveryTargets;
      const saved = this.runtime.putAnticipation(anticipation, { expectedVersion: command.expectedVersion });
      return { eventType: "anticipation.upserted", entityVersion: saved.anticipation.version, eventPayload: saved, result: saved, mutated: saved.changed };
    }
    if (command.type === "runtime.anticipation.delete") {
      const anticipationId = clean(payload.anticipationId || payload.id), anticipation = this.runtime.deleteAnticipation(anticipationId, { expectedVersion: command.expectedVersion });
      return { eventType: "anticipation.deleted", entityVersion: anticipation.version, eventPayload: { anticipationId, deletedAt: anticipation.deletedAt }, result: { anticipation }, mutated: true };
    }
    if (command.type === "memory.digest.put") {
      const digestReport = { ...(payload.digestReport || payload), characterId };
      delete digestReport.deliveryTargets;
      const saved = this.runtime.putDigestReport(digestReport, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.digest.upserted", entityVersion: saved.digestReport.version, eventPayload: saved, result: saved, mutated: saved.changed };
    }
    if (command.type === "memory.digest.delete") {
      const digestReportId = clean(payload.digestReportId || payload.id), digestReport = this.runtime.deleteDigestReport(digestReportId, { expectedVersion: command.expectedVersion });
      return { eventType: "memory.digest.deleted", entityVersion: digestReport.version, eventPayload: { digestReportId, deletedAt: digestReport.deletedAt }, result: { digestReport }, mutated: true };
    }
    if (command.type === "schedule.job.put") {
      const job = { ...(payload.job || payload), characterId, commandId: command.commandId };
      delete job.deliveryTargets;
      const saved = this.store.createScheduledJob(job);
      return { eventType: saved.created ? "schedule.created" : "schedule.unchanged", eventPayload: { job: saved.job, created: saved.created }, result: saved, mutated: saved.created };
    }
    if (command.type === "schedule.job.cancel") {
      const jobId = clean(payload.jobId || payload.id), before = this.store.getScheduledJob(jobId), job = this.store.cancelScheduledJob(jobId), changed = before?.status !== job.status;
      return { eventType: changed ? "schedule.cancelled" : "schedule.unchanged", eventPayload: { job, changed }, result: { job, changed }, mutated: changed };
    }
    if (command.type === "character.state.patch") {
      if (!characterId) throw new AuthorityError("VALIDATION_FAILED", "characterId is required", 400);
      const current = this.runtime.getCharacterState(characterId);
      const patch = payload.patch && typeof payload.patch === "object" && !Array.isArray(payload.patch) ? payload.patch : {};
      const unset = [...new Set([...(Array.isArray(command.unset) ? command.unset : []), ...(Array.isArray(payload.unset) ? payload.unset : [])])];
      const next = mergeObject(current?.state || {}, patch);
      unset.forEach((path) => unsetPath(next, path));
      const saved = this.runtime.putCharacterState(characterId, next, { expectedVersion: command.expectedVersion });
      const stateEventId = saved.changed ? this.runtime.appendStateEvent(characterId, saved.state.version, { patch, unset }, command.commandId) : null;
      return { eventType: "character.state.updated", entityVersion: saved.state.version, eventPayload: { patch, unset, state: saved.state, stateEventId, changed: saved.changed }, result: { ...saved, stateEventId }, mutated: saved.changed };
    }
    throw new AuthorityError("COMMAND_TYPE_UNSUPPORTED", `Unsupported command: ${command.type}`, 400);
  }

  recordFailure(command, error) {
    try {
      this.store.transaction(() => {
        let current = this.store.getCommand(command.commandId);
        if (!current) current = this.store.createCommand(command).command;
        if (current.status === "completed" || current.status === "failed") return;
        this.store.appendEvent({ commandId: command.commandId, type: "command.failed", characterId: command.characterId, worldId: command.worldId, occurredAt: new Date().toISOString(), protocolVersion: command.protocolVersion || this.protocolVersion, payload: { code: error.code, error: error.message } });
        this.store.finishCommand(command.commandId, { status: "failed", error: { code: error.code, message: error.message, details: error.details } });
      });
    } catch {}
  }
}
