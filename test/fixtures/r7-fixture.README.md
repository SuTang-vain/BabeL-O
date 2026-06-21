# R7 Replay Gate Fixture

`r7-fixture.sqlite` is a snapshot of the 3 real regression sessions that
drove the context-cwd-drift Active Plan and long-running-context-assembly
R0-R7 follow-up. Each session's `events` (all 63320) and `sessions` row
(origin_cwd backfilled via v15 migration) are preserved so the test can
replay the original prompt paths through the fixed resolution pipeline and
verify R7 acceptance conditions (no drift to / or ~/Library, session_root_continuity
emits, contextRecent works).

## Source

Extracted from `~/.babel-o/db.sqlite` (real, live) at 2026-06-18, filtered
to the 3 fixture sessions:

- `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7` (19666 events; drove Phase A)
- `session_cf361f04-7ab1-43a5-907a-41a808942686` (23678 events; drove Phase A Follow-up)
- `session_10320709-2b06-405f-8f51-d954435d4a70` (19976 events; drove §11/§12/§13 + Bugs 1-4)

## Schema

v15 (matches `~/.babel-o/db.sqlite` current version after Bug 2 migration):
`sessions` has 18 columns including `origin_cwd`; `events` has the
`(session_id, event_seq)` unique index from Phase A.

## Refresh

To re-extract after a real session produces new evidence:

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const src = new DatabaseSync("/Users/tangyaoyue/.babel-o/db.sqlite", { readOnly: true });
fs.rmSync("/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/fixtures/r7-fixture.sqlite", { force: true });
const dst = new DatabaseSync("/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/fixtures/r7-fixture.sqlite");
const SIDS = ["session_981cc5c2-230c-40d1-953c-b956e9dbaaf7", "session_cf361f04-7ab1-43a5-907a-41a808942686", "session_10320709-2b06-405f-8f51-d954435d4a70"];
const sessCols = src.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
const evCols = src.prepare("PRAGMA table_info(events)").all().map(c => c.name);
dst.exec("CREATE TABLE sessions (" + sessCols.map(c => c + " TEXT").join(",") + ", PRIMARY KEY (session_id))");
dst.exec("CREATE TABLE events (" + evCols.map(c => c + " TEXT").join(",") + ", PRIMARY KEY (event_key))");
const insS = dst.prepare("INSERT INTO sessions (" + sessCols.join(",") + ") VALUES (" + sessCols.map(() => "?").join(",") + ")");
const insE = dst.prepare("INSERT INTO events (" + evCols.join(",") + ") VALUES (" + evCols.map(() => "?").join(",") + ")");
for (const sid of SIDS) {
  const row = src.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sid);
  if (row) insS.run(...sessCols.map(c => row[c]));
  for (const ev of src.prepare("SELECT * FROM events WHERE session_id = ?").iterate(sid))
    insE.run(...evCols.map(c => ev[c]));
}
console.log("re-extracted");
'
```

## Why not generated synthetically?

The 3 sessions contain real prompt paths, real cwd drift, real
CONTEXT_STORAGE_UNAVAILABLE failures, real session events. A synthetic
fixture would either reproduce the failures (testing nothing) or invent
non-evidence. The real fixture is the only honest regression gate.
