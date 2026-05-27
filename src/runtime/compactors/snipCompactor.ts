import type { NexusEvent } from '../../shared/events.js'

export function snipEvent(event: NexusEvent, maxOutputChars: number): NexusEvent {
  if (event.type !== 'tool_completed') return event
  if (!Number.isFinite(maxOutputChars) || maxOutputChars <= 0) return event

  const outputText =
    typeof event.output === 'string'
      ? event.output
      : JSON.stringify(event.output, null, 2)

  if (outputText.length <= maxOutputChars) return event

  const edgeChars = Math.max(1, Math.floor(maxOutputChars * 0.4))
  const omitted = Math.max(0, outputText.length - edgeChars * 2)
  const compacted = [
    outputText.slice(0, edgeChars),
    '',
    `[... ${omitted} chars truncated from tool output ...]`,
    '',
    outputText.slice(-edgeChars),
  ].join('\n')

  return {
    ...event,
    output: compacted,
    truncated: true,
    originalBytes: event.originalBytes ?? Buffer.byteLength(outputText, 'utf8'),
  }
}

export function snipEvents(events: NexusEvent[], maxOutputChars: number): NexusEvent[] {
  return events.map(event => snipEvent(event, maxOutputChars))
}

export function snipEventsWithTurnBoundary(
  events: NexusEvent[],
  currentTurnMaxChars: number,
  priorTurnMaxChars: number,
): NexusEvent[] {
  if (currentTurnMaxChars <= priorTurnMaxChars || priorTurnMaxChars <= 0) {
    return snipEvents(events, currentTurnMaxChars)
  }

  let lastUserIndex = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user_message') {
      lastUserIndex = i
      break
    }
  }

  return events.map((event, index) => {
    if (event.type !== 'tool_completed') return event
    const limit = index < lastUserIndex ? priorTurnMaxChars : currentTurnMaxChars
    return snipEvent(event, limit)
  })
}
