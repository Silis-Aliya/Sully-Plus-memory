import assert from 'node:assert/strict';
import { normalizeSullyChatTurnRequest, sullyCompatibilityDescriptor } from '../sullyCompatAdapter.mjs';

const adapted = normalizeSullyChatTurnRequest({
  charId: 'silis',
  message: {
    id: 42,
    role: 'user',
    type: 'image',
    text: 'hello from SullyOS',
    createdAt: 1785800000000,
    groupId: 'group-1',
    metadata: { client: 'sullyos' },
  },
});

assert.equal(adapted.request.characterId, 'silis');
assert.equal(adapted.request.content, 'hello from SullyOS');
assert.equal(adapted.request.message.sourceId, '42');
assert.equal(adapted.request.message.type, 'text');
assert.equal(adapted.request.message.metadata.originalType, 'image');
assert.deepEqual(adapted.compatibility.warnings.map(item => item.code), [
  'MESSAGE_TYPE_DOWNGRADED',
  'GROUP_CHAT_NOT_YET_SUPPORTED',
]);
assert.equal(sullyCompatibilityDescriptor().authority, 'memory-hub');

console.log(JSON.stringify({ ok: true, adapter: adapted.compatibility.source, warnings: adapted.compatibility.warnings.length }));
