/**
 * chatCompletionsRoute.ts — OpenAI-compatible `/v1/chat/completions` gateway.
 *
 * Feasibility spike (docs/babel-ai-engine.md §4): exposes BabeL-O's provider
 * registry / adapters / retry as a pure-LLM endpoint for external clients
 * (AetheL). It deliberately bypasses the agent loop (LLMCodingRuntime):
 * no tool loop, no permission gates, no session persistence.
 *
 * Contract:
 * - POST /v1/chat/completions
 * - Request: OpenAI chat.completions subset (model/messages/stream/temperature/
 *   max_tokens/response_format/thinking)
 * - Response: OpenAI chat.completion JSON (non-stream) or SSE chunk stream
 * - Errors: OpenAI-style `{ error: { message, type, code, status } }`
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ConfigManager } from '../shared/config.js'
import { getAdapter, providerRegistry } from '../providers/registry.js'
import { ProviderError } from '../shared/errors.js'
import type {
  ModelMessage,
  ModelQueryParams,
} from '../providers/adapters/ModelAdapter.js'

const CHAT_TIMEOUT_MS = 120_000

const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  response_format: z
    .object({
      type: z.enum(['json_object', 'json_schema']),
      json_schema: z.unknown().optional(),
    })
    .optional(),
  thinking: z
    .object({
      budgetTokens: z.number(),
    })
    .optional(),
})

function openAiError(
  message: string,
  type: string,
  status: number,
  code?: string,
) {
  return {
    error: {
      message,
      type,
      ...(code ? { code } : {}),
      status,
    },
  }
}

export function registerChatCompletionsRoute(app: FastifyInstance): void {
  app.post(
    '/v1/chat/completions',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = chatCompletionRequestSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send(
          openAiError('Invalid request body', 'invalid_request_error', 400),
        )
      }
      const body = parsed.data

      // Model ownership stays with BabeL-O: no model (or empty model) in
      // the request means activeProfile/defaultModel (babel-ai-engine.md ADR-B2).
      const settings = ConfigManager.getInstance().resolveSettings({
        model: body.model && body.model.length > 0 ? body.model : undefined,
      })

      // Reject unknown provider IDs up front instead of passing them through
      // to the adapter (which would surface as an upstream 401). "Known"
      // means: built-in registry OR a user-configured custom provider —
      // custom providers may use models outside the static model catalog.
      const configManager = ConfigManager.getInstance()
      const configuredProviders = configManager.load().providers ?? {}
      const providerKnown =
        providerRegistry.some((p) => p.id === settings.providerId) ||
        Boolean(configuredProviders[settings.providerId])
      if (!providerKnown) {
        return reply.code(400).send(
          openAiError(
            `Unknown model "${settings.modelId}"`,
            'invalid_request_error',
            400,
            'MODEL_NOT_FOUND',
          ),
        )
      }

      const adapter = getAdapter(settings.providerId)

      const systemPrompt =
        body.messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n') || undefined

      const messages: ModelMessage[] = body.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        }))

      const params: ModelQueryParams = {
        model: settings.modelId,
        systemPrompt,
        messages,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        responseFormat: body.response_format,
        thinking: body.thinking,
      }

      const abortController = new AbortController()
      const timeout = setTimeout(() => abortController.abort(), CHAT_TIMEOUT_MS)

      const adapterOptions = {
        signal: abortController.signal,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
      }

      const fail = (error: unknown, reply: FastifyReply) => {
        if (error instanceof ProviderError) {
          return reply
            .code(error.httpStatus >= 400 && error.httpStatus < 600 ? error.httpStatus : 502)
            .send(
              openAiError(
                error.message,
                'provider_error',
                error.httpStatus,
                'PROVIDER_ERROR',
              ),
            )
        }
        if (abortController.signal.aborted) {
          return reply.code(408).send(
            openAiError('Request timed out', 'request_timeout', 408),
          )
        }
        return reply.code(500).send(
          openAiError(
            error instanceof Error ? error.message : String(error),
            'internal_error',
            500,
          ),
        )
      }

      try {
        if (body.stream) {
          reply.hijack()
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            // node-fetch (openai SDK v4) throws ERR_STREAM_PREMATURE_CLOSE
            // on chunked SSE + keep-alive when the server closes the socket
            // right after [DONE]; close explicitly instead.
            Connection: 'close',
          })
          reply.raw.flushHeaders?.()

          const chunkId = `chatcmpl-${Date.now()}`
          let finishReason: string | null = null
          let usage: { prompt_tokens: number; completion_tokens: number } | undefined

          try {
            for await (const delta of adapter.queryStream(params, adapterOptions)) {
              if (delta.type === 'text') {
                reply.raw.write(
                  `data: ${JSON.stringify({
                    id: chunkId,
                    object: 'chat.completion.chunk',
                    choices: [
                      { index: 0, delta: { content: delta.text }, finish_reason: null },
                    ],
                  })}\n\n`,
                )
              } else if (delta.type === 'thinking') {
                reply.raw.write(
                  `data: ${JSON.stringify({
                    id: chunkId,
                    object: 'chat.completion.chunk',
                    choices: [
                      { index: 0, delta: { reasoning_content: delta.text }, finish_reason: null },
                    ],
                  })}\n\n`,
                )
              } else if (delta.type === 'usage') {
                usage = {
                  prompt_tokens: delta.inputTokens,
                  completion_tokens: delta.outputTokens,
                }
              } else if (delta.type === 'finish') {
                finishReason =
                  delta.reason === 'tool_use'
                    ? 'tool_calls'
                    : delta.reason === 'max_tokens'
                      ? 'length'
                      : 'stop'
              }
            }
          } catch (error) {
            // Stream already started: emit an error event then close.
            reply.raw.write(
              `data: ${JSON.stringify(openAiError('Provider stream failed', 'provider_error', 502))}\n\n`,
            )
            reply.raw.write('data: [DONE]\n\n')
            reply.raw.end()
            return
          }

          reply.raw.write(
            `data: ${JSON.stringify({
              id: chunkId,
              object: 'chat.completion.chunk',
              choices: [
                { index: 0, delta: {}, finish_reason: finishReason ?? 'stop' },
              ],
              ...(usage
                ? {
                    usage: {
                      ...usage,
                      total_tokens: usage.prompt_tokens + usage.completion_tokens,
                    },
                  }
                : {}),
            })}\n\n`,
          )
          reply.raw.write('data: [DONE]\n\n')
          reply.raw.end()
          return
        }

        // Non-stream: use the adapter's non-streaming fast path when
        // available (avoids the streaming tax), else collect from stream.
        if (adapter.queryNonStream) {
          const completion = await adapter.queryNonStream(params, adapterOptions)
          return reply.send({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: settings.modelId,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: completion.content.length > 0 ? completion.content : null,
                  ...(completion.reasoningContent
                    ? { reasoning_content: completion.reasoningContent }
                    : {}),
                },
                finish_reason: 'stop',
              },
            ],
            ...(completion.usage
              ? {
                  usage: {
                    prompt_tokens: completion.usage.inputTokens,
                    completion_tokens: completion.usage.outputTokens,
                    total_tokens:
                      completion.usage.inputTokens + completion.usage.outputTokens,
                  },
                }
              : {}),
          })
        }

        let content = ''
        let reasoning = ''
        let usage: { prompt_tokens: number; completion_tokens: number } | undefined
        for await (const delta of adapter.queryStream(params, adapterOptions)) {
          if (delta.type === 'text') {
            content += delta.text
          } else if (delta.type === 'thinking') {
            reasoning += delta.text
          } else if (delta.type === 'usage') {
            usage = {
              prompt_tokens: delta.inputTokens,
              completion_tokens: delta.outputTokens,
            }
          }
        }
        return reply.send({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: settings.modelId,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: content.length > 0 ? content : null,
                ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
              },
              finish_reason: 'stop',
            },
          ],
          ...(usage
            ? {
                usage: {
                  ...usage,
                  total_tokens: usage.prompt_tokens + usage.completion_tokens,
                },
              }
            : {}),
        })
      } catch (error) {
        return fail(error, reply)
      } finally {
        clearTimeout(timeout)
      }
    },
  )
}
