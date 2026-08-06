const clean = value => String(value ?? '').trim();

export const SULLY_COMPAT_VERSION = '1.0';

export function normalizeSullyChatTurnRequest(input = {}) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rawMessage = body.message && typeof body.message === 'object' && !Array.isArray(body.message)
    ? body.message
    : Array.isArray(body.messages) && body.messages.length
      ? body.messages[body.messages.length - 1]
      : {};
  const characterId = clean(body.characterId || body.charId || rawMessage.characterId || rawMessage.charId);
  const content = clean(rawMessage.content ?? rawMessage.text ?? body.content ?? body.text);
  const sourceId = clean(rawMessage.sourceId ?? rawMessage.messageId ?? rawMessage.id);
  const timestamp = Number(rawMessage.timestamp ?? rawMessage.createdAt ?? body.now ?? Date.now());
  const messageType = clean(rawMessage.type || 'text').toLowerCase();
  const warnings = [];
  if (messageType !== 'text') warnings.push({ code: 'MESSAGE_TYPE_DOWNGRADED', field: 'message.type', value: messageType, supported: ['text'] });
  if (rawMessage.groupId || body.groupId) warnings.push({ code: 'GROUP_CHAT_NOT_YET_SUPPORTED', field: 'groupId' });
  if (rawMessage.attachments || rawMessage.metadata?.attachments) warnings.push({ code: 'ATTACHMENTS_NOT_YET_SUPPORTED', field: 'message.attachments' });

  return {
    compatibility: {
      source: 'sullyos',
      version: SULLY_COMPAT_VERSION,
      warnings,
    },
    request: {
      ...body,
      characterId,
      actorId: clean(body.actorId || 'sullyos-compat'),
      userId: clean(body.userId || 'me'),
      content,
      message: {
        ...rawMessage,
        ...(sourceId ? { sourceId } : {}),
        charId: characterId,
        role: 'user',
        type: 'text',
        content,
        timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
        metadata: {
          ...(rawMessage.metadata && typeof rawMessage.metadata === 'object' ? rawMessage.metadata : {}),
          sullyCompat: true,
          ...(messageType !== 'text' ? { originalType: messageType } : {}),
        },
      },
    },
  };
}

export function sullyCompatibilityDescriptor() {
  return {
    ok: true,
    adapter: 'sullyos-chat',
    version: SULLY_COMPAT_VERSION,
    authority: 'memory-hub',
    acceptedInput: {
      character: ['characterId', 'charId'],
      content: ['message.content', 'message.text', 'content', 'text'],
      messageIdentity: ['message.sourceId', 'message.messageId', 'message.id'],
      timestamp: ['message.timestamp', 'message.createdAt', 'now'],
    },
    endpoints: {
      describe: '/api/v1/compat/sully',
      preview: '/api/v1/compat/sully/chat/preview',
      execute: '/api/v1/compat/sully/chat/turns',
    },
    currentLimits: ['single-character', 'text-turn', 'no-group-chat', 'no-attachments', 'no-tool-loop'],
  };
}
