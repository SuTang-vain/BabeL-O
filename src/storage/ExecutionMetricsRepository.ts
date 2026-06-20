/**
 * Phase 3B-26 slice — `ExecutionMetricsRepository.ts`
 *
 * Extracted from `src/storage/SqliteStorage.ts`. Contains
 * the `ExecutionMetricsRepository` class that owns the
 * `execution_metrics` table operations: `saveExecutionMetrics`,
 * `getExecutionMetrics`, plus the inline `booleanToDb` /
 * `dbToBoolean` coercion helpers those methods depend on.
 *
 * The repository is constructed with a `DatabaseSync`
 * handle (the same one the `SqliteStorage` class uses)
 * and is wired into `SqliteStorage` as a field so the
 * public `saveExecutionMetrics` / `getExecutionMetrics`
 * methods on `SqliteStorage` delegate to the repository.
 *
 * Why extracted:
 *
 * - `SqliteStorage.ts` is a ~1200-line file that
 *   manages all SQLite table initializations,
 *   schemas, transaction locks, serialization maps,
 *   and per-domain data. Each table's operations form
 *   an independent reviewable boundary, but they are
 *   currently all inline in one class.
 * - Execution metrics is the broadest scalar column
 *   table in the storage layer (~36 columns covering
 *   timing, token usage, context-window ceilings,
 *   prefix-cache diagnostics, remote-runner stats, and
 *   cache policy flags). Its column shape is the result
 *   of multiple migrations (PRAGMA user_version 4 → 7)
 *   and is a reviewable surface on its own.
 * - The 4 boolean columns (`cache_preservation_mode`,
 *   `long_context_utilization_mode`,
 *   `prefix_cache_volatile_content_last`, plus the
 *   `cache_preservation_mode` row mapping) require
 *   their own `booleanToDb` / `dbToBoolean` coercion
 *   helpers — pulling them in alongside the methods
 *   makes the boundary explicit.
 * - Future slice (`LoopPaneRepository`) will follow
 *   the same construction pattern.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same UPSERT
 *   statement with all 36 columns, same `?? null`
 *   coalescing for nullable scalars, same
 *   `booleanToDb` / `dbToBoolean` 0/1 conversion, same
 *   `ORDER BY timestamp DESC LIMIT 1` for latest-metric
 *   lookup.
 * - Eliminate ~155 lines of inline code + 2 helper
 *   functions from `SqliteStorage.ts`.
 *
 * Non-goals:
 *
 * - Do not change the SQL schema (column order,
 *   constraint, default, or index set).
 * - Do not change the `ExecutionMetrics` shape or the
 *   null-vs-undefined distinction (`?? null` for
 *   insertion, `!== null && !== undefined` for reading)
 *   — those are owned by the storage interface
 *   contract.
 * - Do not touch the schema-migration block that
 *   creates / alters the `execution_metrics` table
 *   (still owned by `SqliteStorage.initialize`); this
 *   slice only moves the per-row operations boundary.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionMetrics } from './Storage.js'

type Row = Record<string, unknown>

export class ExecutionMetricsRepository {
  constructor(private readonly db: DatabaseSync) {}

  async saveExecutionMetrics(metrics: ExecutionMetrics): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO execution_metrics (
          metric_id, session_id, execute_duration_ms, provider_first_token_ms,
          provider_request_duration_ms, stream_delta_count, tool_call_count,
          tool_roundtrip_duration_ms, context_chars_in, context_chars_out,
          input_tokens, output_tokens, cache_creation_input_tokens,
          cache_read_input_tokens, model_context_window,
          reserved_output_tokens, provider_safety_buffer_tokens,
          effective_context_ceiling, legacy_context_ceiling,
          env_max_context_tokens, context_policy_source,
          context_warning_threshold_percent, context_compact_threshold_percent,
          context_warning_threshold_tokens, context_compact_threshold_tokens,
          context_blocking_limit_tokens, cache_read_ratio, cache_preservation_mode,
          long_context_utilization_mode, prefix_cache_immutable_ratio,
          prefix_cache_volatile_content_last, prefix_cache_fingerprint,
          compact_summary_latency_ms, remote_tool_call_count,
          remote_tool_runner_duration_ms, timestamp
        ) VALUES (
          :metricId, :sessionId, :executeDurationMs, :providerFirstTokenMs,
          :providerRequestDurationMs, :streamDeltaCount, :toolCallCount,
          :toolRoundtripDurationMs, :contextCharsIn, :contextCharsOut,
          :inputTokens, :outputTokens, :cacheCreationInputTokens,
          :cacheReadInputTokens, :modelContextWindow,
          :reservedOutputTokens, :providerSafetyBufferTokens,
          :effectiveContextCeiling, :legacyContextCeiling,
          :envMaxContextTokens, :contextPolicySource,
          :contextWarningThresholdPercent, :contextCompactThresholdPercent,
          :contextWarningThresholdTokens, :contextCompactThresholdTokens,
          :contextBlockingLimitTokens, :cacheReadRatio, :cachePreservationMode,
          :longContextUtilizationMode, :prefixCacheImmutableRatio,
          :prefixCacheVolatileContentLast, :prefixCacheFingerprint,
          :compactSummaryLatencyMs, :remoteToolCallCount,
          :remoteToolRunnerDurationMs, :timestamp
        )
        ON CONFLICT(metric_id) DO UPDATE SET
          execute_duration_ms = excluded.execute_duration_ms,
          provider_first_token_ms = excluded.provider_first_token_ms,
          provider_request_duration_ms = excluded.provider_request_duration_ms,
          stream_delta_count = excluded.stream_delta_count,
          tool_call_count = excluded.tool_call_count,
          tool_roundtrip_duration_ms = excluded.tool_roundtrip_duration_ms,
          context_chars_in = excluded.context_chars_in,
          context_chars_out = excluded.context_chars_out,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_creation_input_tokens = excluded.cache_creation_input_tokens,
          cache_read_input_tokens = excluded.cache_read_input_tokens,
          model_context_window = excluded.model_context_window,
          reserved_output_tokens = excluded.reserved_output_tokens,
          provider_safety_buffer_tokens = excluded.provider_safety_buffer_tokens,
          effective_context_ceiling = excluded.effective_context_ceiling,
          legacy_context_ceiling = excluded.legacy_context_ceiling,
          env_max_context_tokens = excluded.env_max_context_tokens,
          context_policy_source = excluded.context_policy_source,
          context_warning_threshold_percent = excluded.context_warning_threshold_percent,
          context_compact_threshold_percent = excluded.context_compact_threshold_percent,
          context_warning_threshold_tokens = excluded.context_warning_threshold_tokens,
          context_compact_threshold_tokens = excluded.context_compact_threshold_tokens,
          context_blocking_limit_tokens = excluded.context_blocking_limit_tokens,
          cache_read_ratio = excluded.cache_read_ratio,
          cache_preservation_mode = excluded.cache_preservation_mode,
          long_context_utilization_mode = excluded.long_context_utilization_mode,
          prefix_cache_immutable_ratio = excluded.prefix_cache_immutable_ratio,
          prefix_cache_volatile_content_last = excluded.prefix_cache_volatile_content_last,
          prefix_cache_fingerprint = excluded.prefix_cache_fingerprint,
          compact_summary_latency_ms = excluded.compact_summary_latency_ms,
          remote_tool_call_count = excluded.remote_tool_call_count,
          remote_tool_runner_duration_ms = excluded.remote_tool_runner_duration_ms,
          timestamp = excluded.timestamp`,
      )
      .run({
        metricId: metrics.metricId,
        sessionId: metrics.sessionId,
        executeDurationMs: metrics.executeDurationMs ?? null,
        providerFirstTokenMs: metrics.providerFirstTokenMs ?? null,
        providerRequestDurationMs: metrics.providerRequestDurationMs ?? null,
        streamDeltaCount: metrics.streamDeltaCount ?? null,
        toolCallCount: metrics.toolCallCount ?? null,
        toolRoundtripDurationMs: metrics.toolRoundtripDurationMs ?? null,
        contextCharsIn: metrics.contextCharsIn ?? null,
        contextCharsOut: metrics.contextCharsOut ?? null,
        inputTokens: metrics.inputTokens ?? null,
        outputTokens: metrics.outputTokens ?? null,
        cacheCreationInputTokens: metrics.cacheCreationInputTokens ?? null,
        cacheReadInputTokens: metrics.cacheReadInputTokens ?? null,
        modelContextWindow: metrics.modelContextWindow ?? null,
        reservedOutputTokens: metrics.reservedOutputTokens ?? null,
        providerSafetyBufferTokens: metrics.providerSafetyBufferTokens ?? null,
        effectiveContextCeiling: metrics.effectiveContextCeiling ?? null,
        legacyContextCeiling: metrics.legacyContextCeiling ?? null,
        envMaxContextTokens: metrics.envMaxContextTokens ?? null,
        contextPolicySource: metrics.contextPolicySource ?? null,
        contextWarningThresholdPercent: metrics.contextWarningThresholdPercent ?? null,
        contextCompactThresholdPercent: metrics.contextCompactThresholdPercent ?? null,
        contextWarningThresholdTokens: metrics.contextWarningThresholdTokens ?? null,
        contextCompactThresholdTokens: metrics.contextCompactThresholdTokens ?? null,
        contextBlockingLimitTokens: metrics.contextBlockingLimitTokens ?? null,
        cacheReadRatio: metrics.cacheReadRatio ?? null,
        cachePreservationMode: booleanToDb(metrics.cachePreservationMode),
        longContextUtilizationMode: booleanToDb(metrics.longContextUtilizationMode),
        prefixCacheImmutableRatio: metrics.prefixCacheImmutableRatio ?? null,
        prefixCacheVolatileContentLast: booleanToDb(metrics.prefixCacheVolatileContentLast),
        prefixCacheFingerprint: metrics.prefixCacheFingerprint ?? null,
        compactSummaryLatencyMs: metrics.compactSummaryLatencyMs ?? null,
        remoteToolCallCount: metrics.remoteToolCallCount ?? null,
        remoteToolRunnerDurationMs: metrics.remoteToolRunnerDurationMs ?? null,
        timestamp: metrics.timestamp,
      })
  }

  async getExecutionMetrics(sessionId: string): Promise<ExecutionMetrics | null> {
    const row = this.db
      .prepare(`SELECT * FROM execution_metrics WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`)
      .get(sessionId) as Row | undefined
    if (!row) return null
    return {
      metricId: String(row.metric_id),
      sessionId: String(row.session_id),
      executeDurationMs: row.execute_duration_ms !== null && row.execute_duration_ms !== undefined ? Number(row.execute_duration_ms) : undefined,
      providerFirstTokenMs: row.provider_first_token_ms !== null && row.provider_first_token_ms !== undefined ? Number(row.provider_first_token_ms) : undefined,
      providerRequestDurationMs: row.provider_request_duration_ms !== null && row.provider_request_duration_ms !== undefined ? Number(row.provider_request_duration_ms) : undefined,
      streamDeltaCount: row.stream_delta_count !== null && row.stream_delta_count !== undefined ? Number(row.stream_delta_count) : undefined,
      toolCallCount: row.tool_call_count !== null && row.tool_call_count !== undefined ? Number(row.tool_call_count) : undefined,
      toolRoundtripDurationMs: row.tool_roundtrip_duration_ms !== null && row.tool_roundtrip_duration_ms !== undefined ? Number(row.tool_roundtrip_duration_ms) : undefined,
      contextCharsIn: row.context_chars_in !== null && row.context_chars_in !== undefined ? Number(row.context_chars_in) : undefined,
      contextCharsOut: row.context_chars_out !== null && row.context_chars_out !== undefined ? Number(row.context_chars_out) : undefined,
      inputTokens: row.input_tokens !== null && row.input_tokens !== undefined ? Number(row.input_tokens) : undefined,
      outputTokens: row.output_tokens !== null && row.output_tokens !== undefined ? Number(row.output_tokens) : undefined,
      cacheCreationInputTokens: row.cache_creation_input_tokens !== null && row.cache_creation_input_tokens !== undefined ? Number(row.cache_creation_input_tokens) : undefined,
      cacheReadInputTokens: row.cache_read_input_tokens !== null && row.cache_read_input_tokens !== undefined ? Number(row.cache_read_input_tokens) : undefined,
      modelContextWindow: row.model_context_window !== null && row.model_context_window !== undefined ? Number(row.model_context_window) : undefined,
      reservedOutputTokens: row.reserved_output_tokens !== null && row.reserved_output_tokens !== undefined ? Number(row.reserved_output_tokens) : undefined,
      providerSafetyBufferTokens: row.provider_safety_buffer_tokens !== null && row.provider_safety_buffer_tokens !== undefined ? Number(row.provider_safety_buffer_tokens) : undefined,
      effectiveContextCeiling: row.effective_context_ceiling !== null && row.effective_context_ceiling !== undefined ? Number(row.effective_context_ceiling) : undefined,
      legacyContextCeiling: row.legacy_context_ceiling !== null && row.legacy_context_ceiling !== undefined ? Number(row.legacy_context_ceiling) : undefined,
      envMaxContextTokens: row.env_max_context_tokens !== null && row.env_max_context_tokens !== undefined ? Number(row.env_max_context_tokens) : undefined,
      contextPolicySource: row.context_policy_source !== null && row.context_policy_source !== undefined ? String(row.context_policy_source) as ExecutionMetrics['contextPolicySource'] : undefined,
      contextWarningThresholdPercent: row.context_warning_threshold_percent !== null && row.context_warning_threshold_percent !== undefined ? Number(row.context_warning_threshold_percent) : undefined,
      contextCompactThresholdPercent: row.context_compact_threshold_percent !== null && row.context_compact_threshold_percent !== undefined ? Number(row.context_compact_threshold_percent) : undefined,
      contextWarningThresholdTokens: row.context_warning_threshold_tokens !== null && row.context_warning_threshold_tokens !== undefined ? Number(row.context_warning_threshold_tokens) : undefined,
      contextCompactThresholdTokens: row.context_compact_threshold_tokens !== null && row.context_compact_threshold_tokens !== undefined ? Number(row.context_compact_threshold_tokens) : undefined,
      contextBlockingLimitTokens: row.context_blocking_limit_tokens !== null && row.context_blocking_limit_tokens !== undefined ? Number(row.context_blocking_limit_tokens) : undefined,
      cacheReadRatio: row.cache_read_ratio !== null && row.cache_read_ratio !== undefined ? Number(row.cache_read_ratio) : undefined,
      cachePreservationMode: dbToBoolean(row.cache_preservation_mode),
      longContextUtilizationMode: dbToBoolean(row.long_context_utilization_mode),
      prefixCacheImmutableRatio: row.prefix_cache_immutable_ratio !== null && row.prefix_cache_immutable_ratio !== undefined ? Number(row.prefix_cache_immutable_ratio) : undefined,
      prefixCacheVolatileContentLast: dbToBoolean(row.prefix_cache_volatile_content_last),
      prefixCacheFingerprint: row.prefix_cache_fingerprint !== null && row.prefix_cache_fingerprint !== undefined ? String(row.prefix_cache_fingerprint) : undefined,
      compactSummaryLatencyMs: row.compact_summary_latency_ms !== null && row.compact_summary_latency_ms !== undefined ? Number(row.compact_summary_latency_ms) : undefined,
      remoteToolCallCount: row.remote_tool_call_count !== null && row.remote_tool_call_count !== undefined ? Number(row.remote_tool_call_count) : undefined,
      remoteToolRunnerDurationMs: row.remote_tool_runner_duration_ms !== null && row.remote_tool_runner_duration_ms !== undefined ? Number(row.remote_tool_runner_duration_ms) : undefined,
      timestamp: String(row.timestamp),
    }
  }
}

// ─── helpers ─────────────────────────────────────────────

function booleanToDb(value: boolean | undefined): number | null {
  if (value === undefined) return null
  return value ? 1 : 0
}

function dbToBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined
  return Number(value) === 1
}
