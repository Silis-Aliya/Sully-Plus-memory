import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /navItem\("independentChat","独立聊天"/);
assert.match(html, /function renderIndependentChat\(\)/);
assert.match(html, /\/v1\/chat\/turns/);
assert.match(html, /\/v1\/events\?after=0/);
assert.match(html, /\/snapshot/);
assert.match(html, /Hub 自己组装、运行、保存与回放/);
assert.match(html, /independentChatSurface/);
assert.match(html, /data-hub-zone/);
assert.match(html, /surface=\$\{encodeURIComponent\(targetSurface\)\}/);
assert.match(html, /彼方活动/);
assert.match(html, /只读区域/);
assert.match(html, /eventSurfaceCounts/);
assert.match(html, /direct:me:/);
assert.match(html, /navItem\("contextAssembly","上下文组装"/);
assert.match(html, /function renderContextAssembly\(\)/);
assert.match(html, /\/api\/v1\/context\/assemble/);
assert.match(html, /临时双栏对比/);
assert.match(html, /修改权威来源/);
assert.match(html, /function createRuntimeJob\(\)/);
assert.match(html, /\/v1\/scheduled-jobs/);
assert.match(html, /\/v1\/runtime\/tick/);
assert.match(html, /\/v1\/outbox\?clientId=/);
assert.match(html, /可靠 Outbox/);

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean);
assert.ok(scripts.length > 0, 'index.html should contain an inline application script');
for (const source of scripts) new Function(source);

console.log(JSON.stringify({ ok: true, scripts: scripts.length, independentChat: true, contextAssembly: true, actionRuntime: true, outbox: true }));
