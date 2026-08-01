# SullyOS Memory Hub VPS Deploy

Memory Hub is meant to sit between the SullyOS global Memory Palace and Ombre Brain.

```text
phone / browser / SullyOS
        |
        v
https://memory.example.com  Memory Hub
        |
        +--> SullyOS global Memory Palace read-only export endpoint
        |
        +--> Ombre Brain /api/sully/memories bridge
```

## Required Runtime

- Node.js 18+
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
- `SULLYOS_EXPORT_BASE_URL=https://sully.example.com`
- `OMBRE_SULLY_BRIDGE_URL=https://ombre.example.com`
- `OMBRE_SULLY_BRIDGE_KEY=...`

Use a long random token for `MEMORY_HUB_TOKEN`. The dashboard sends it as `X-Memory-Hub-Token`.

## Start Locally On VPS

```bash
npm start
```

Health check:

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

## Ombre Bridge Contract

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
