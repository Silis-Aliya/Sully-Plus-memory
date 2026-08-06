# Runtime V2 incremental storage

Runtime V2 is a side-by-side, row-oriented representation of the existing
Memory Hub runtime data. It does not replace the current read path and it does
not delete or update `runtime_domains` or `runtime_messages`.

## Commands

Read-only validation of the configured authority database:

```powershell
npm run migrate:runtime-v2
```

Read-only shadow-write status:

```powershell
npm run status:runtime-v2
```

Compare legacy reads with V2 without changing the production read path:

```powershell
npm run parity:runtime-v2
```

Runtime server read modes are controlled by `MEMORY_HUB_RUNTIME_READ_MODE`:

- `legacy` (default): all production reads use the existing tables.
- `compare`: production reads remain legacy while a Worker periodically runs
  full V2 parity without blocking the HTTP event loop.
- `v2`: startup runs full parity synchronously. V2 runtime reads are enabled
  only when it passes; otherwise the process falls back to `legacy`.

Domains not yet represented in V2 are configuration/authority domains and
continue to use their current authoritative storage in every mode.

## Native incremental commands

`POST /api/v1/runtime/commands` supports these idempotent command types:

- `runtime.message.commit`
- `memory.node.put`
- `memory.node.delete`
- `character.state.patch`
- `memory.vector.put` / `memory.vector.delete`
- `memory.link.put` / `memory.link.delete`
- `memory.event_box.put` / `memory.event_box.delete`
- `memory.room_plate.put` / `memory.room_plate.delete`
- `runtime.anticipation.put` / `runtime.anticipation.delete`
- `memory.digest.put` / `memory.digest.delete`
- `schedule.job.put` / `schedule.job.cancel`

They write V2 rows, commands, events, state-event history, and explicitly
requested Outbox deliveries in one transaction. They never rebuild the legacy
JSON arrays. The endpoint is disabled by default and additionally requires both
an effective `v2` read mode and a persisted `authority_mode=v2` promotion. A
fresh or migrated database remains in `shadow` authority mode, so an environment
variable alone cannot accidentally create V2-only data that becomes invisible
after a legacy fallback. Promotion is intentionally deferred to a separately
tested operational step.

EventBox members and RoomPlate entries are diffed by stable ID and updated as
individual rows; removed children receive tombstones. Scheduled-job commands
reuse the existing authoritative `scheduled_jobs` table and its claim/retry
state machine instead of creating a parallel V2 scheduler.

Scheduled execution is authority-aware. In `shadow` it preserves the legacy
message path for rollback parity. After promotion it commits scheduled messages
and state patches directly to V2 inside the same transaction as events,
snapshots, job completion, and the native-mutation counter; runtime caches are
then rebuilt from V2. It never writes the legacy message table in promoted mode.

Install the V2 schema and resume the backfill:

```powershell
npm run migrate:runtime-v2 -- --apply
```

Use a different database or batch size when required:

```powershell
npm run migrate:runtime-v2 -- --database D:\path\authority.sqlite --batch-size 500
```

Run the isolated migration regression test:

```powershell
npm run test:runtime-v2
npm run test:runtime-v2-native-command
npm run test:runtime-v2-native-api
npm run test:runtime-v2-promotion
```

## Authority promotion protocol

Promotion is an explicit two-step operation. It is never performed by schema
migration or server startup.

1. Run with `MEMORY_HUB_RUNTIME_READ_MODE=v2` and keep native writes disabled.
2. `POST /api/runtime/v2/promotion/prepare` with a stable `actorId`.
3. Inspect the returned full parity report and retain its `promotionId` and
   `parityHash`.
4. `POST /api/runtime/v2/promotion/commit` with the same actor, promotion ID,
   and parity hash. Commit reruns parity and rejects any intervening runtime
   change, failed shadow domain, or processing command.
5. Only after commit, enable `MEMORY_HUB_RUNTIME_NATIVE_WRITES_ENABLED=true`.

Prepared promotions expire after 15 minutes. A newer preparation supersedes an
older one. Every attempt is persisted in `v2_runtime_promotions`; active mode,
promotion ID, and the native mutation sequence are persisted in
`v2_runtime_control`.

`POST /api/runtime/v2/promotion/rollback` is intentionally accepted only while
the native mutation sequence is unchanged from the promotion baseline. Once a
V2-native message, memory mutation, or state mutation exists, rollback returns
`V2_ROLLBACK_REQUIRES_RECONCILIATION`; the V2 data must first be replayed into
the legacy store by a future reconciliation operation. This prevents a rollback
from silently hiding authoritative activity.

After promotion, persisted `authority_mode=v2` takes precedence over a missing
or stale legacy read-mode environment variable on restart. A promoted database
uses V2 operational health checks at startup instead of requiring continued
equality with the now non-authoritative legacy representation.
If promoted V2 health fails, runtime reads enter `blocked` and return an error;
they never silently expose stale legacy state as if it were authoritative.

## CC wake and MCP bridge

`brain.wake`, `autonomy.wake`, and `computer.task` jobs do not call the normal
chat model. When V2 authority is active, the scheduler creates a durable
`v2_cc_wake_runs` row, emits `brain.wake.requested`, creates an Outbox delivery,
and completes the scheduling job. A runner claims the wake with an expiring,
reclaimable lease through `POST /api/v1/cc/wakes/claim`.

The claimed context contains the full stable Sully context only on the first
wake or when its hash changes. Normal wakes receive the reason, all raw messages
and events after the session cursors, automatic recall capped at five items,
current state, and unfinished jobs. The session persists `sessionId`, message
and event cursors, stable context version/hash, and last wake time.

Run the CC-only stdio bridge with:

```powershell
$env:MEMORY_HUB_URL="https://memory.example.com"
$env:MEMORY_HUB_TOKEN="replace-with-vps-token"
npm run start:mcp
```

It exposes exactly these tools:

- `sully_get_character_context`
- `sully_get_recent_messages`
- `sully_recall`
- `sully_get_runtime_state`
- `sully_commit_activity`
- `sully_commit_message`
- `sully_schedule_wake`
- `sully_cancel_wake`
- `sully_list_events`

The MCP process only makes authenticated HTTP requests using
`MEMORY_HUB_URL` and `MEMORY_HUB_TOKEN`; it never opens or copies
`authority.sqlite`. `sully_commit_activity` stores CC prose verbatim and can
atomically complete the wake lease, update state, create a user-visible message,
and enqueue delivery. No normal chat-model rewrite is involved.

`npm run start:cc-runner` starts the separate VPS Claude Code worker. Its
process lifecycle follows Cyberboss's shared-runtime idea: Claude uses
stream-json, each character keeps a recoverable session ID, and the process is
idle between turns. Unlike Cyberboss's local check-in poller, this worker never
chooses wake times; Hub remains the only scheduler. A failed lease is requeued
up to `CC_RUNNER_MAX_ATTEMPTS`, and reclaimed wakes reuse the exact context
captured on their first claim so a restart cannot lose the stable personality
block or advance the delta cursor.

The runner input is mechanical: the unchanged Hub/Sully stable context followed
by the serialized wake context. No new character or memory prompt is introduced.
The runner commits Claude's final result verbatim as an internal activity. It
does not automatically expose a background activity as a chat message.

## Safety and rollback

- The default command opens the database in read-only mode.
- `--apply` only creates and fills tables prefixed with `v2_`.
- Checkpoints make a stopped backfill resumable.
- A subsequent run marks abandoned `running` records as `interrupted` and
  performs a WAL checkpoint after the source reader is closed.
- Existing JSON domains, messages, backups, and recovery files are retained.
- Production still reads the legacy tables until a separate, explicitly tested
  read-path switch is approved.
- Before that switch, rollback is simply leaving the V2 path disabled. The V2
  tables should be retained for diagnosis rather than dropped.

## Data layout

The schema normalizes messages, memory nodes and vector BLOBs, links, EventBox
membership, RoomPlate entries, anticipations, digests, runtime state, delivery
metadata, and future CC session/wake bookkeeping. Migration runs, checkpoints,
and row-level issues are recorded separately so that validation is inspectable.
