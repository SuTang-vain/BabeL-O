/**
 * Phase 3B-24 slice — `SessionChannelRepository.ts`
 *
 * Extracted from `src/storage/SqliteStorage.ts`. Contains
 * the `SessionChannelRepository` class that owns the
 * `session_channels` and `session_messages` tables.
 *
 * Operations owned by this repository:
 * - `saveSessionChannel`, `getSessionChannel`,
 *   `listSessionChannels` (per-participant filter)
 * - `saveSessionMessage`, `getSessionMessage`,
 *   `listSessionMessages` (offset cursor pagination)
 * - `listSessionInbox` (cross-channel inbox view)
 * - `acknowledgeSessionMessage` (read-modify-write)
 *
 * Plus the inline `sessionChannelParams` /
 * `sessionMessageParams` / `rowToSessionChannel` /
 * `rowToSessionMessage` / `compareMessages` /
 * `isInboxMessage` helpers those methods depend on.
 *
 * The repository is constructed with a `DatabaseSync`
 * handle (the same one the `SqliteStorage` class uses)
 * and is wired into `SqliteStorage` as a field so the
 * public methods on `SqliteStorage` delegate to the
 * repository.
 *
 * Why extracted:
 *
 * - `SqliteStorage.ts` is a ~1450-line file that
 *   manages all SQLite table initializations and
 *   per-domain data. Each table cluster forms an
 *   independent reviewable boundary.
 * - Session channels are a multi-table domain
 *   (channels + messages + inbox) used by the
 *   agent-coordination flow (cross-session messaging,
 *   broadcast / direct delivery, acknowledgement
 *   tracking). Pulling them out makes the boundary
 *   explicit, isolates the `compareMessages` /
 *   `isInboxMessage` filter logic, and lets future
 *   inbox optimizations (per-session index,
 *   delivery cursor) stay within the repository.
 * - The `acknowledgeSessionMessage` read-modify-write
 *   path now lives inside the repository, which is
 *   the natural owner of the message lifecycle.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same SQL UPSERT
 *   statements, same `JSON.parse` / `JSON.stringify`
 *   semantics for `participant_session_ids` /
 *   `policy_json` / `metadata_json` /
 *   `evidence_json` columns, same `broadcast` 0/1
 *   conversion, same offset cursor pagination, same
 *   `compareMessages` ordering, same `isInboxMessage`
 *   filter rules.
 * - Eliminate ~140 lines of inline code + 6 helper
 *   functions from `SqliteStorage.ts`.
 *
 * Non-goals:
 *
 * - Do not change the SQL schema (column order,
 *   constraint, or default).
 * - Do not change the `SessionChannel` / `SessionMessage`
 *   shape or the `acknowledgeSessionMessage` semantics
 *   — those are owned by `src/shared/sessionChannel.ts`.
 * - Do not change the agent-coordination broadcast /
 *   delivery semantics; this slice only moves the
 *   storage boundary.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { SessionChannel, SessionMessage } from '../shared/sessionChannel.js'
import type {
  SessionChannelListOptions,
  SessionInboxOptions,
  SessionMessageListOptions,
  SessionMessageListResult,
} from './Storage.js'

type Row = Record<string, unknown>

export class SessionChannelRepository {
  constructor(private readonly db: DatabaseSync) {}

  async saveSessionChannel(channel: SessionChannel): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO session_channels (
          channel_id, kind, participant_session_ids, created_by_session_id,
          created_at, status, policy_json, metadata_json
        ) VALUES (
          :channelId, :kind, :participantSessionIds, :createdBySessionId,
          :createdAt, :status, :policyJson, :metadataJson
        )
        ON CONFLICT(channel_id) DO UPDATE SET
          kind = excluded.kind,
          participant_session_ids = excluded.participant_session_ids,
          created_by_session_id = excluded.created_by_session_id,
          created_at = excluded.created_at,
          status = excluded.status,
          policy_json = excluded.policy_json,
          metadata_json = excluded.metadata_json`,
      )
      .run(sessionChannelParams(channel))
  }

  async getSessionChannel(channelId: string): Promise<SessionChannel | null> {
    const row = this.db
      .prepare(`SELECT * FROM session_channels WHERE channel_id = ?`)
      .get(channelId) as Row | undefined
    return row ? rowToSessionChannel(row) : null
  }

  async listSessionChannels(options: SessionChannelListOptions = {}): Promise<SessionChannel[]> {
    const limit = options.limit ?? 100
    const rows = this.db
      .prepare(
        `SELECT * FROM session_channels
         ORDER BY created_at ASC, channel_id ASC`,
      )
      .all() as Row[]
    return rows
      .map(rowToSessionChannel)
      .filter(channel => !options.sessionId || channel.participantSessionIds.includes(options.sessionId))
      .slice(0, limit)
  }

  async saveSessionMessage(message: SessionMessage): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO session_messages (
          message_id, channel_id, from_session_id, to_session_id, broadcast,
          type, content, evidence_json, priority, created_at, delivered_at,
          acknowledged_at, status, metadata_json
        ) VALUES (
          :messageId, :channelId, :fromSessionId, :toSessionId, :broadcast,
          :type, :content, :evidenceJson, :priority, :createdAt, :deliveredAt,
          :acknowledgedAt, :status, :metadataJson
        )
        ON CONFLICT(message_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          from_session_id = excluded.from_session_id,
          to_session_id = excluded.to_session_id,
          broadcast = excluded.broadcast,
          type = excluded.type,
          content = excluded.content,
          evidence_json = excluded.evidence_json,
          priority = excluded.priority,
          created_at = excluded.created_at,
          delivered_at = excluded.delivered_at,
          acknowledged_at = excluded.acknowledged_at,
          status = excluded.status,
          metadata_json = excluded.metadata_json`,
      )
      .run(sessionMessageParams(message))
  }

  async getSessionMessage(messageId: string): Promise<SessionMessage | null> {
    const row = this.db
      .prepare(`SELECT * FROM session_messages WHERE message_id = ?`)
      .get(messageId) as Row | undefined
    return row ? rowToSessionMessage(row) : null
  }

  async listSessionMessages(
    channelId: string,
    options: SessionMessageListOptions = {},
  ): Promise<SessionMessageListResult> {
    const limit = options.limit ?? 100
    const order = options.order ?? 'asc'
    const startIndex = options.cursor ? Number(options.cursor) : 0
    const direction = order === 'asc' ? 'ASC' : 'DESC'
    const rows = this.db
      .prepare(
        `SELECT * FROM session_messages
         WHERE channel_id = ?
         ORDER BY created_at ${direction}, message_id ${direction}`,
      )
      .all(channelId) as Row[]
    const page = rows.slice(startIndex, startIndex + limit)
    const nextIndex = startIndex + page.length
    return {
      messages: page.map(rowToSessionMessage),
      nextCursor: nextIndex < rows.length ? String(nextIndex) : undefined,
    }
  }

  async listSessionInbox(
    sessionId: string,
    options: SessionInboxOptions = {},
  ): Promise<SessionMessage[]> {
    const limit = options.limit ?? 20
    const channelRows = this.db
      .prepare(
        `SELECT * FROM session_channels
         ORDER BY created_at ASC, channel_id ASC`,
      )
      .all() as Row[]
    const channelMap = new Map(channelRows.map(row => {
      const channel = rowToSessionChannel(row)
      return [channel.channelId, channel] as const
    }))
    const messageRows = this.db
      .prepare(
        `SELECT * FROM session_messages
         ORDER BY created_at ASC, message_id ASC`,
      )
      .all() as Row[]
    const messages = messageRows
      .map(rowToSessionMessage)
      .filter(message => isInboxMessage(message, sessionId, channelMap.get(message.channelId), options.includeAcknowledged ?? false))
      .sort(compareMessages)
    return messages.slice(Math.max(0, messages.length - limit))
  }

  async acknowledgeSessionMessage(messageId: string, acknowledgedAt: string): Promise<SessionMessage | null> {
    const message = await this.getSessionMessage(messageId)
    if (!message) return null
    const acknowledged: SessionMessage = {
      ...message,
      acknowledgedAt,
      status: 'acknowledged',
    }
    await this.saveSessionMessage(acknowledged)
    return acknowledged
  }
}

// ─── helpers ─────────────────────────────────────────────

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

function sessionChannelParams(channel: SessionChannel): Record<string, string | null> {
  return {
    channelId: channel.channelId,
    kind: channel.kind,
    participantSessionIds: JSON.stringify(channel.participantSessionIds),
    createdBySessionId: channel.createdBySessionId,
    createdAt: channel.createdAt,
    status: channel.status,
    policyJson: JSON.stringify(channel.policy),
    metadataJson: channel.metadata ? JSON.stringify(channel.metadata) : null,
  }
}

function sessionMessageParams(message: SessionMessage): Record<string, string | number | null> {
  return {
    messageId: message.messageId,
    channelId: message.channelId,
    fromSessionId: message.fromSessionId,
    toSessionId: message.toSessionId ?? null,
    broadcast: message.broadcast ? 1 : 0,
    type: message.type,
    content: message.content,
    evidenceJson: message.evidence ? JSON.stringify(message.evidence) : null,
    priority: message.priority,
    createdAt: message.createdAt,
    deliveredAt: message.deliveredAt ?? null,
    acknowledgedAt: message.acknowledgedAt ?? null,
    status: message.status,
    metadataJson: message.metadata ? JSON.stringify(message.metadata) : null,
  }
}

function rowToSessionChannel(row: Row): SessionChannel {
  return {
    channelId: String(row.channel_id),
    kind: String(row.kind) as SessionChannel['kind'],
    participantSessionIds: JSON.parse(String(row.participant_session_ids)),
    createdBySessionId: String(row.created_by_session_id),
    createdAt: String(row.created_at),
    status: String(row.status) as SessionChannel['status'],
    policy: JSON.parse(String(row.policy_json)),
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined,
  }
}

function rowToSessionMessage(row: Row): SessionMessage {
  return {
    messageId: String(row.message_id),
    channelId: String(row.channel_id),
    fromSessionId: String(row.from_session_id),
    toSessionId: nullableString(row.to_session_id),
    broadcast: Number(row.broadcast) === 1,
    type: String(row.type) as SessionMessage['type'],
    content: String(row.content),
    evidence: row.evidence_json ? JSON.parse(String(row.evidence_json)) : undefined,
    priority: String(row.priority) as SessionMessage['priority'],
    createdAt: String(row.created_at),
    deliveredAt: nullableString(row.delivered_at),
    acknowledgedAt: nullableString(row.acknowledged_at),
    status: String(row.status) as SessionMessage['status'],
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined,
  }
}

function compareMessages(left: SessionMessage, right: SessionMessage): number {
  const cmp = left.createdAt.localeCompare(right.createdAt)
  if (cmp !== 0) return cmp
  return left.messageId.localeCompare(right.messageId)
}

function isInboxMessage(
  message: SessionMessage,
  sessionId: string,
  channel: SessionChannel | undefined,
  includeAcknowledged: boolean,
): boolean {
  if (!channel || !channel.participantSessionIds.includes(sessionId)) return false
  if (message.fromSessionId === sessionId) return false
  if (!includeAcknowledged && message.acknowledgedAt) return false
  if (message.toSessionId) return message.toSessionId === sessionId
  return message.broadcast === true
}
