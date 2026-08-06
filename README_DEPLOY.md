# SullyOS Memory Hub VPS Deploy

Memory Hub is the VPS authority and bridge shared by SullyOS and Claude Code. SullyOS uses HTTPS and Outbox; Claude Code uses the HTTP-backed MCP server. Ombre export remains an optional legacy integration and is not part of the required production message path.

```text
phone / browser / SullyOS
        |
        v
https://memory.example.com  Memory Hub
        |
        +--> authority.sqlite / Scheduler / Event / Outbox
        |
        +--> MCP Server <--> Claude Code runner
```

## Required Runtime

- Node.js 22.5+（Memory Hub 权威层使用内置 `node:sqlite`）
- A reverse proxy such as Nginx or Caddy
- A persistent data directory, for example `/var/lib/sully-memory-hub`

## Environment

Copy `.env.example` to `.env` and edit values:

```bash
cp .env.example .env
```

Important variables:

- `MEMORY_HUB_HOST=127.0.0.1`
- `MEMORY_HUB_PORT=8787`
- `MEMORY_HUB_PUBLIC_URL=https://memory.example.com`
- `MEMORY_HUB_DATA_DIR=/var/lib/sully-memory-hub`
- `MEMORY_HUB_TOKEN=...`
- `MEMORY_HUB_ALLOWED_ORIGINS=https://memory.example.com,https://sully.example.com`
- `MEMORY_HUB_RUNTIME_READ_MODE=v2`（only after parity verification and V2 promotion）
- `MEMORY_HUB_RUNTIME_NATIVE_WRITES_ENABLED=true`（only after V2 promotion）
- `MEMORY_HUB_URL=http://127.0.0.1:8787`
- `CC_RUNNER_CLAUDE_COMMAND=/absolute/path/to/claude`

Use a long random token for `MEMORY_HUB_TOKEN`. The dashboard sends it as `X-Memory-Hub-Token`.

Do not upload a local `.env`, `.audit-backups`, recovery directories, logs, or `node_modules`. Transfer the code and a separately created, consistent `authority.sqlite` snapshot. Keep the original database and recovery material until the VPS copy has passed parity and smoke tests.

## Start Locally On VPS

```bash
npm start
```

Health check（角色、消息与运行域都从 `authority.sqlite` 恢复；无需 `hub-data.json`）：

```bash
curl http://127.0.0.1:8787/api/health
```

## SullyOS Export Contract

SullyOS should expose a global, read-only Memory Palace endpoint such as:

```text
GET /memory-palace/export.json
```

Expected shape:

```json
{
  "characters": [
    {
      "id": "sully",
      "name": "Sully",
      "avatar": "S",
      "visibility": "private",
      "description": "..."
    }
  ],
  "memories": [
    {
      "id": "node-id",
      "charId": "sully",
      "groupId": "",
      "room": "living_room",
      "title": "title",
      "content": "memory content",
      "importance": 7,
      "mood": "feel label",
      "tags": ["tag"],
      "syncState": "pending",
      "occurredAt": "2026-07-28T00:00:00.000Z"
    }
  ],
  "roomPlates": [
    {
      "id": "plate-id",
      "charId": "sully",
      "room": "self_room",
      "title": "core coordinate",
      "content": "stable fact"
    }
  ],
  "impressions": [],
  "feels": [],
  "eventBoxes": [],
  "anticipations": [],
  "digestReports": []
}
```

This endpoint should export the whole SullyOS Memory Palace management surface. `charId` is a filter/index field inside the global dataset, not a separate per-character palace connection.

Memory Hub also accepts the existing SullyOS Memory Palace export shape, as long as it represents the global export payload:

```json
{
  "type": "sully_memory_palace_export",
  "characters": [
    {
      "charId": "sully",
      "charName": "Sully",
      "nodes": [],
      "eventBoxes": [],
      "anticipations": [],
      "roomPlates": []
    }
  ]
}
```

The target display contract is:

- `MemoryNode` -> room node list
- `RoomPlate.entries` -> 门牌 / 地标 page and room side panel counts
- `CharacterProfile.impression` / `impressions` -> 印象档案 page
- `EventBox` -> 事件盒 page
- `Anticipation` -> 窗台期盼 page
- `DigestReport` -> 认知消化 page

## Optional Legacy Ombre Bridge Contract

This section is retained only for backward compatibility. The target SullyOS ↔ Hub ↔ CC architecture does not require Ombre and does not route CC activity through a second chat model.

Memory Hub posts pending memories to:

```text
POST {OMBRE_SULLY_BRIDGE_URL}/api/sully/memories
```

If `OMBRE_SULLY_BRIDGE_URL` already ends with `/api/sully`, Hub appends `/memories`.

Headers:

```text
Content-Type: application/json
X-Sully-Bridge-Key: <OMBRE_SULLY_BRIDGE_KEY>
```

Payload uses Ombre's Sully bridge fields:

```json
{
  "sullyNodeId": "node-id",
  "charId": "sully",
  "charName": "Sully",
  "groupId": "",
  "room": "living_room",
  "visibility": "private",
  "scope": "memory_palace",
  "source": "sullyos_memory_palace",
  "content": "memory content",
  "title": "title",
  "tags": ["tag"],
  "importance": 7,
  "mood": "feel label",
  "type": "dynamic"
}
```

## Nginx

See `deploy/nginx-memory-hub.conf`.

## systemd

See `deploy/sully-memory-hub.service`.

Place the project at `/opt/sully-memory-hub`, create `/var/lib/sully-memory-hub`, then:

```bash
sudo cp deploy/sully-memory-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sully-memory-hub
sudo systemctl status sully-memory-hub
```

### Claude Code runner

Do not enable the runner while `authorityMode` is still `shadow`. After V2
promotion and parity verification, install Claude Code for the `sully` service
user, verify that `claude` is on its PATH, then install the separate runner:

```bash
sudo cp deploy/sully-memory-hub-cc-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sully-memory-hub-cc-runner
sudo systemctl status sully-memory-hub-cc-runner
```

The runner does not schedule its own check-ins. It only claims Hub-created
`brain.wake`, `autonomy.wake`, and `computer.task` wake rows. It resumes the
per-character Claude `sessionId`, mounts the HTTP-only Memory Hub MCP server,
and commits the final Claude result verbatim as an internal activity using a
stable command ID. A user-visible message is created only when CC explicitly
uses the Hub message tool; the runner never turns background prose into a chat
bubble automatically.
