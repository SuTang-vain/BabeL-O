// Phase 0 reproduction for tool-pair-message-ordering-plan.md.
//
// Loads the REAL event stream of session_6ce63133 (6 turns, 4
// back-to-back PROVIDER_ERROR 400s in turns 3-6) and asserts that
// mapEventsToMessages produces a tool_use/tool_result sequence in
// which every assistant(tool_use=[...]) is immediately followed by
// exactly one user(tool_result=[...]) message, with no other user or
// assistant message in between.
//
// Real session evidence:
// - turn 2 starts 4 parallel tools at seq 113/115/117/119. Three
//   complete cleanly (seq 114/116/118). The 4th (Glob 18b) is
//   suspended by scope_boundary_detected (seq 120) and only
//   resumes after permission_response (seq 124). scope_boundary_*
//   events are pushed as standalone user messages between the
//   assistant(tool_use) and the closing tool_result.
// - turn 3 loop 2 (seq 188) sends the entire history to minimax,
//   which rejects with 2013 "tool call result does not follow tool
//   tool call". Subsequent turns replay the same misordered pair
//   against minimax and deepseek-v4-pro, producing 4 consecutive
//   400s.
//
// On origin/develop this script FAILS at the first offending pair.
// After Phase 1 lands, the same script must PASS.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mapEventsToMessages } from '../dist/runtime/eventsTranslator.js'

const SID = 'session_6ce63133-fecb-4c03-adf2-349f38074c98'
const realDb = join(homedir(), '.babel-o', 'db.sqlite')

const db = new DatabaseSync(realDb, { readOnly: true })
const rows = db
  .prepare('SELECT event_json FROM events WHERE session_id = ? ORDER BY event_seq ASC')
  .all(SID)
const events = rows.map((r) => JSON.parse(String(r.event_json)))
db.close()
console.log(`loaded ${events.length} events for ${SID}`)

// Replay the entire session as it would be assembled right before
// turn 3 loop 2 (the first failure). Map events to messages and
// inspect the resulting ModelMessage[].
const messages = mapEventsToMessages(events, '', { replayReasoningContent: true })
console.log(`messages produced: ${messages.length}`)
console.log()

// Build an inventory of every tool_use and tool_result block in
// order, keyed by the message index they live in.
const inventory = []
for (let i = 0; i < messages.length; i++) {
  const m = messages[i]
  if (!Array.isArray(m.content)) continue
  for (const b of m.content) {
    if (b.type === 'tool_use') {
      inventory.push({ msgIdx: i, role: m.role, kind: 'tool_use', id: b.id, name: b.name })
    } else if (b.type === 'tool_result') {
      inventory.push({
        msgIdx: i,
        role: m.role,
        kind: 'tool_result',
        id: b.toolUseId,
        isError: b.isError ?? false,
      })
    }
  }
}

// For every assistant(tool_use) message, find the expected closing
// user(tool_result) and assert it is the very next message and
// covers every tool_use id from that assistant message.
const issues = []
for (let mi = 0; mi < messages.length; mi++) {
  const m = messages[mi]
  if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
  const useBlocks = m.content.filter((b) => b.type === 'tool_use')
  if (useBlocks.length === 0) continue
  const useIds = useBlocks.map((b) => b.id)
  const next = messages[mi + 1]
  if (!next || next.role !== 'user' || !Array.isArray(next.content)) {
    issues.push({
      msgIdx: mi,
      reason: 'no-following-user(tool_result)',
      tool_use_ids: useIds,
    })
    continue
  }
  const resultBlocks = next.content.filter((b) => b.type === 'tool_result')
  if (resultBlocks.length === 0) {
    issues.push({
      msgIdx: mi,
      reason: 'following-user-has-no-tool_result',
      tool_use_ids: useIds,
      between_messages: [mi, mi + 1],
    })
    continue
  }
  const resultIds = resultBlocks.map((b) => b.toolUseId)
  const missing = useIds.filter((id) => !resultIds.includes(id))
  const extra = resultIds.filter((id) => !useIds.includes(id))
  if (missing.length > 0 || extra.length > 0) {
    issues.push({
      msgIdx: mi,
      reason: 'pair-mismatch',
      tool_use_ids: useIds,
      tool_result_ids: resultIds,
      missing_tool_results_for: missing,
      extra_tool_results_for: extra,
    })
  }
}

console.log('=== Tool pair contiguity report ===')
console.log(`assistant(tool_use) messages inspected: ${messages.filter((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')).length}`)
console.log(`contiguity issues: ${issues.length}`)
console.log()

if (issues.length > 0) {
  console.log('=== Offending pairs ===')
  for (const issue of issues) {
    const assistantMsg = messages[issue.msgIdx]
    const useIds = assistantMsg.content.filter((b) => b.type === 'tool_use').map((b) => b.id)
    console.log(`msg #${issue.msgIdx} assistant(tool_use=[${useIds.join(', ')}])`)
    console.log(`  reason: ${issue.reason}`)
    if (issue.missing_tool_results_for?.length) {
      console.log(`  missing tool_result for: ${issue.missing_tool_results_for.join(', ')}`)
    }
    if (issue.extra_tool_results_for?.length) {
      console.log(`  extra tool_result for: ${issue.extra_tool_results_for.join(', ')}`)
    }
    // Print the messages between assistant and the (broken) closing user
    // so we can see which runtime-injected user messages split the pair.
    let j = issue.msgIdx + 1
    let printed = 0
    while (j < messages.length && printed < 5) {
      const m = messages[j]
      const role = m.role
      if (typeof m.content === 'string') {
        console.log(`  between msg #${j} ${role} [str] ${m.content.slice(0, 80)}`)
      } else {
        const kinds = m.content.map((b) => b.type).join(',')
        const sample = m.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(' | ')
          .slice(0, 80)
        console.log(`  between msg #${j} ${role} [${kinds}] ${sample}`)
      }
      j += 1
      printed += 1
    }
  }
  console.log()
}

// Cross-check with the real session: confirm that the
// call_019eeec4a8687d83a0f0a18b Glob is the tool that triggered
// the misordering.
const offendingToolUseId = 'call_019eeec4a8687d83a0f0a18b'
const offendingInInventory = inventory.find((b) => b.id === offendingToolUseId)
console.log('=== Offending tool id cross-check ===')
console.log(`inventory contains ${offendingToolUseId}:`, offendingInInventory ? 'yes' : 'no')
if (offendingInInventory) {
  console.log('  found at msg #' + offendingInInventory.msgIdx + ' (' + offendingInInventory.kind + ', ' + offendingInInventory.role + ')')
}

console.log()
if (issues.length === 0) {
  console.log('PHASE 0 GATE PASS: all assistant(tool_use) messages are immediately followed by exactly one matching user(tool_result) message')
} else {
  console.log(`PHASE 0 GATE FAIL (${issues.length} issue(s)): at least one assistant(tool_use) message is split across multiple user messages by runtime-injected events`)
}

console.log()
console.log('=== Phase 3: real-session replay gate ===')
let phase3Failures = 0
const expect3 = (cond, msg) => {
  if (!cond) { console.error(`  FAIL: ${msg}`); phase3Failures += 1 }
  else { console.log(`  ok: ${msg}`) }
}

// (a) The offending Glob must carry a REAL tool_result from the event stream,
//     not the synthetic "denied or interrupted" placeholder. This proves the
//     scope-boundary suspension did not corrupt the tool pair.
const offendingResult = inventory.find(
  (b) => b.kind === 'tool_result' && b.id === offendingToolUseId,
)
expect3(!!offendingResult, `offending Glob ${offendingToolUseId} has a tool_result block`)
if (offendingResult) {
  // The synthetic placeholder content is "Error: Tool execution was denied or
  // interrupted." — the real Glob result is a JSON array of matches.
  const resultMsg = messages[offendingResult.msgIdx]
  const block = resultMsg.content.find(
    (b) => b.type === 'tool_result' && b.toolUseId === offendingToolUseId,
  )
  expect3(
    typeof block.content === 'string' && !block.content.includes('denied or interrupted'),
    'offending Glob tool_result is real (not the synthetic placeholder)',
  )
  expect3(block.isError === false, 'offending Glob tool_result is not an error')
}

// (b) The assistant text replies from turns 1 and 2 must still be present
//     (zero semantic loss from deferral).
const allText = messages
  .filter((m) => m.role === 'assistant')
  .flatMap((m) => (typeof m.content === 'string' ? [m.content] : []))
  .join('\n')
expect3(allText.includes('对比分析'), 'turn 1 assistant text reply (对比分析) preserved')
expect3(allText.includes('推荐结论'), 'turn 2 assistant text reply (推荐结论) preserved')

// (c) Per-turn contiguity: for every user_message boundary, re-assemble the
//     window up to the NEXT context_usage (the pre-invocation snapshot) and
//     assert no split pair. This simulates what each provider call would see.
const userMsgSeqs = []
for (let i = 0; i < events.length; i++) {
  if (events[i].type === 'user_message') userMsgSeqs.push(i)
}
let perTurnSplits = 0
for (let t = 0; t < userMsgSeqs.length; t++) {
  const endIdx = t + 1 < userMsgSeqs.length ? userMsgSeqs[t + 1] : events.length
  const window = events.slice(0, endIdx)
  const winMsgs = mapEventsToMessages(window, '继续', { replayReasoningContent: true })
  for (let mi = 0; mi < winMsgs.length; mi++) {
    const m = winMsgs[mi]
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const useIds = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id)
    if (useIds.length === 0) continue
    const next = winMsgs[mi + 1]
    const resultIds = (next?.role === 'user' && Array.isArray(next.content))
      ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.toolUseId)
      : []
    const missing = useIds.filter((id) => !resultIds.includes(id))
    if (missing.length > 0 || resultIds.length === 0) {
      perTurnSplits += 1
      console.log(`  turn ${t + 1}: split pair at msg ${mi} (missing: ${missing.join(',')})`)
    }
  }
}
expect3(perTurnSplits === 0, `every per-turn provider call sees a contiguous tool-pair history (${perTurnSplits} split(s))`)

console.log()
if (issues.length === 0 && phase3Failures === 0) {
  console.log('PHASE 3 GATE PASS: session_6ce63133 replays with contiguous tool pairs, real results, and preserved text')
  process.exit(0)
} else {
  console.log(`GATE FAIL (${issues.length} contiguity issue(s), ${phase3Failures} phase-3 failure(s))`)
  process.exit(1)
}
