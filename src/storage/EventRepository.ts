/**
 * Phase 3B-20 slice — `EventRepository.ts`
 *
 * Extracted from `src/storage/SqliteStorage.ts`. Contains
 * the `EventRepository` class that owns the
 * `events` table operations: `listEvents`,
 * `appendEvent` (including the inline sequence /
 * duplicate-repair logic), and the private
 * `appendEventRowWithSequence` helper.
 *
 * The repository is constructed with a `DatabaseSync`
 * handle (the same one the `SqliteStorage` class uses)
 * and is wired into `SqliteStorage` as a field so the
 * public `listEvents` / `appendEvent` methods on
 * `SqliteStorage` delegate to the repository. Future
 * repositories (TaskRepository, AuditRepository) will
 * follow the same pattern.
 *
 * Why extracted:
 *
 * - `SqliteStorage.ts` is a 1753-line file that
 *   manages all SQLite table initializations,
 *   schemas, transaction locks, serialization maps,
 *   event logging, task storage, and audit logs.
 *   Changes to different data models are coupled in
 *   this file, making testing of isolated entities
 *   harder and increasing merge-conflict risk.
 * - The event operations are the most-frequently
 *   exercised part of the storage (every runtime turn
 *   yields at least one event; `listEvents` is the
 *   hot path for the per-loop revision tracking).
 *   Pulling them out into a dedicated class makes
 *   the event boundary explicit and lets the rest of
 *   the storage evolve independently.
 * - Future slices (TaskRepository / AuditRepository)
 *   will follow the same construction pattern.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same SQL
 *   statements, same `JSON.parse` / `JSON.stringify`
 *   semantics, same `BEGIN IMMEDIATE` / `COMMIT` /
 *   `ROLLBACK` transaction handling, same duplicate-
 *   repair logic, same `nextCursor` / `lastSeq`
 *   return shape.
 * - Eliminate ~130 lines of inline code from
 *   `SqliteStorage.ts`.
 *
 * Non-goals:
 *
 * - Do not change the SQL schema or the
 *   `sequencedEventKey` helper — those are owned by
 *   the storage class. The repository accepts the
 *   helper as a constructor argument so it does not
 *   depend on the storage internals.
 * - Do not change the tool-trace side effects on
 *   `tool_started` / `tool_completed` events — the
 *   main loop's `appendEvent` flow already calls
 *   `saveToolTrace` / `getToolTrace` on these events.
 *   The repository accepts callbacks to fire those
 *   side effects so it does not own the tool-trace
 *   schema.
 * - Do not change the `executeMetricsFromEvent` /
 *   `saveExecutionMetrics` side effects — the
 *   repository accepts a callback for those too.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { NexusEvent } from '../shared/events.js'
import type { EventListOptions, EventListResult } from './Storage.js'

export type EventRepositoryOptions = {
  /** Builds the `event_key` row from the session id,
   *  sequence number, event JSON, and the event
   *  itself. The helper lives in `SqliteStorage.ts`
   *  as a private function; the repository accepts
   *  it as a constructor argument so it does not
   *  depend on the storage internals. */
  sequencedEventKey: (sessionId: string, eventSeq: number, eventJson: string, event: NexusEvent) => string
  /** Tool-trace side effects for `tool_started` /
   *  `tool_completed` events. The repository fires
   *  these on the appropriate events so the event
   *  pipeline stays the same as the prior inline
   *  implementation. */
  onToolStarted: (sessionId: string, event: Extract<NexusEvent, { type: 'tool_started' }>) => Promise<void>
  onToolCompleted: (sessionId: string, event: Extract<NexusEvent, { type: 'tool_completed' }>) => Promise<void>
  /** Execution-metrics side effect. The repository
   *  fires this for events that carry embedded
   *  metrics (e.g. `usage` events). */
  onExecutionMetrics: (sessionId: string, event: NexusEvent) => Promise<void>
}

export class EventRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: EventRepositoryOptions,
  ) {}

  async listEvents(
    sessionId: string,
    options: EventListOptions = {},
  ): Promise<EventListResult> {
    const limit = options.limit ?? 100
    const order = options.order ?? 'asc'
    const comparison = order === 'asc' ? '>' : '<'
    const direction = order === 'asc' ? 'ASC' : 'DESC'
    const cursor = Number(options.cursor ?? 0)
    const eventTypes = options.eventTypes && options.eventTypes.length > 0
      ? options.eventTypes
      : null
    // Push the event-type filter into SQL so filtered queries (e.g.
    // contextSearch with eventTypeFilter) are NOT bounded by the row limit
    // the way an unfiltered ascending scan is. Without this, a long session
    // (11k+ events) silently drops the newest matching events past the cap.
    const typeClause = eventTypes
      ? `AND event_type IN (${eventTypes.map(() => '?').join(', ')})`
      : ''
    const typeParams = eventTypes ?? []
    const rows = options.cursor
      ? (this.db
          .prepare(
            `SELECT event_seq, event_json FROM events
             WHERE session_id = ? AND event_seq ${comparison} ? ${typeClause}
             ORDER BY event_seq ${direction}, event_key ${direction}
             LIMIT ?`,
          )
          .all(sessionId, Number.isFinite(cursor) ? cursor : 0, ...typeParams, limit + 1) as any[])
      : (this.db
          .prepare(
            `SELECT event_seq, event_json FROM events
             WHERE session_id = ? ${typeClause}
             ORDER BY event_seq ${direction}, event_key ${direction}
             LIMIT ?`,
          )
          .all(sessionId, ...typeParams, limit + 1) as any[])

    const page = rows.slice(0, limit)
    return {
      events: page.map((row) => JSON.parse(String(row.event_json)) as NexusEvent),
      nextCursor:
        rows.length > limit ? String(page.at(-1)?.event_seq ?? '') : undefined,
      lastSeq:
        page.length > 0
          ? page.reduce<number>((max, row) => {
              const seq = Number(row.event_seq ?? 0)
              return Number.isFinite(seq) && seq > max ? seq : max
            }, 0)
          : undefined,
    }
  }

  async appendEvent(sessionId: string, event: NexusEvent): Promise<void> {
    this.appendEventRowWithSequence(sessionId, event)

    if (event.type === 'session_started') {
      this.db
        .prepare(`UPDATE sessions SET cwd = ?, updated_at = ? WHERE session_id = ?`)
        .run(event.cwd, event.timestamp, sessionId)
    }

    if (event.type === 'tool_started') {
      await this.options.onToolStarted(sessionId, event)
    } else if (event.type === 'tool_completed') {
      await this.options.onToolCompleted(sessionId, event)
    }

    await this.options.onExecutionMetrics(sessionId, event)
  }

  private appendEventRowWithSequence(sessionId: string, event: NexusEvent): void {
    this.db.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      const eventJson = JSON.stringify(event)
      const duplicateRow = this.db
        .prepare(`SELECT event_seq FROM events WHERE session_id = ? AND timestamp = ? AND event_type = ? AND event_json = ? LIMIT 1`)
        .get(sessionId, event.timestamp, event.type, eventJson) as any
      if (!duplicateRow) {
        const eventSeqRow = this.db
          .prepare(`SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM events WHERE session_id = ?`)
          .get(sessionId) as any
        const eventSeq = Number(eventSeqRow?.next_seq ?? 1)
        const eventKey = this.options.sequencedEventKey(sessionId, eventSeq, eventJson, event)
        this.db
          .prepare(
            `INSERT INTO events (
              event_key, session_id, timestamp, event_type, event_json, event_seq
            ) VALUES (
              :eventKey, :sessionId, :timestamp, :eventType, :eventJson, :eventSeq
            )`,
          )
          .run({
            eventKey,
            sessionId,
            timestamp: event.timestamp,
            eventType: event.type,
            eventJson,
            eventSeq,
          })
      }

      this.db
        .prepare(`UPDATE sessions SET updated_at = ? WHERE session_id = ?`)
        .run(event.timestamp, sessionId)

      this.db.exec('COMMIT')
      committed = true
    } catch (error) {
      if (!committed) {
        try {
          this.db.exec('ROLLBACK')
        } catch {}
      }
      throw error
    }
  }
}
