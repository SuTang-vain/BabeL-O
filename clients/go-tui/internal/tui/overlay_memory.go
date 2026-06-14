package tui

import (
	"encoding/json"
	"fmt"
	"strings"
)

func buildMemoryOverlayLines(raw []byte) []string {
	if len(raw) == 0 {
		return []string{"No memory status payload available."}
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return []string{"Unable to decode memory status: " + err.Error()}
	}
	switch stringField(payload, "type") {
	case "memory_search_result":
		return buildMemorySearchOverlayLines(payload)
	case "memory_candidates":
		return buildMemoryCandidatesOverlayLines(payload)
	case "memory_action_approval_required":
		return buildMemoryApprovalOverlayLines(payload)
	case "memory_note_saved", "memory_session_flushed":
		return buildMemoryMutationOverlayLines(payload)
	case "error":
		return buildMemoryErrorOverlayLines(payload)
	}
	everCore := asMap(payload["everCore"])
	capability := asMap(payload["capability"])
	guidance := asMap(payload["guidance"])
	summary := "unavailable"
	if anyBool(capability["available"]) {
		summary = "available"
	} else if anyBool(everCore["enabled"]) && !anyBool(everCore["healthy"]) {
		summary = "unhealthy"
	} else if !anyBool(everCore["enabled"]) {
		summary = "disabled"
	}
	lines := []string{
		mutedStyle.Render("  memory status · MemoryOS"),
		"Status: " + summary,
		fmt.Sprintf("everCore: enabled=%v healthy=%v mode=%s", anyBool(everCore["enabled"]), anyBool(everCore["healthy"]), fallbackUnknown(stringField(everCore, "mode"))),
	}
	if url := stringField(everCore, "url"); url != "" {
		lines = append(lines, "Endpoint: "+url)
	}
	if appID := stringField(everCore, "appId"); appID != "" {
		lines = append(lines, "App: "+appID)
	}
	if projectID := stringField(everCore, "projectId"); projectID != "" {
		lines = append(lines, "Project: "+projectID)
	}
	if agentID := stringField(everCore, "agentId"); agentID != "" {
		lines = append(lines, "Agent: "+agentID)
	}
	if method := stringField(everCore, "retrieveMethod"); method != "" {
		lines = append(lines, fmt.Sprintf("Retrieval: method=%s topK=%d", method, anyInt(everCore["topK"])))
	}
	namespace := asMap(everCore["namespace"])
	if len(namespace) > 0 {
		parts := []string{
			"Namespace:",
			"layer=" + fallbackUnknown(stringField(namespace, "layer")),
			"isolation=" + fallbackUnknown(stringField(namespace, "isolationKey")),
			"source=" + fallbackUnknown(stringField(namespace, "projectIdSource")),
		}
		if warning := stringField(namespace, "warningCode"); warning != "" {
			parts = append(parts, "warning="+warning)
		}
		lines = append(lines, strings.Join(parts, " "))
	}
	sidecar := asMap(everCore["sidecar"])
	if len(sidecar) > 0 {
		parts := []string{
			"Sidecar:",
			"managed=" + fmt.Sprint(anyBool(sidecar["managed"])),
			"running=" + fmt.Sprint(anyBool(sidecar["running"])),
			"healthy=" + fmt.Sprint(anyBool(sidecar["healthy"])),
		}
		if dataDir := stringField(sidecar, "dataDir"); dataDir != "" {
			parts = append(parts, "dataDir="+dataDir)
		}
		if pid := anyInt(sidecar["pid"]); pid > 0 {
			parts = append(parts, fmt.Sprintf("pid=%d", pid))
		}
		lines = append(lines, strings.Join(parts, " "))
	}
	if errorCode := stringField(everCore, "errorCode"); errorCode != "" {
		lines = append(lines, "Error: "+errorCode+" "+stringField(everCore, "errorMessage"))
	}
	// MemoryOS bootstrap section. The Go TUI's persistent
	// `[m: …]` footer reads the same `bootstrap.status` field;
	// the overlay here shows the full picture (dataDir, llm,
	// errorCode, policy, build tool, MCP tools) so an
	// operator can diagnose without leaving the TUI.
	bootstrap := asMap(payload["bootstrap"])
	if len(bootstrap) > 0 {
		parts := []string{
			"MemoryOS:",
			"status=" + fallbackUnknown(stringField(bootstrap, "status")),
			"configured=" + fmt.Sprint(anyBool(bootstrap["configured"])),
		}
		if optedIn := anyBool(bootstrap["optedIn"]); optedIn {
			parts = append(parts, "optedIn=true")
		}
		if optedOut := anyBool(bootstrap["optedOut"]); optedOut {
			parts = append(parts, "optedOut=true")
		}
		if external := anyBool(bootstrap["externalHintShown"]); external {
			parts = append(parts, "externalHintShown=true")
		}
		if policy := stringField(bootstrap, "autoBootstrapPolicy"); policy != "" {
			parts = append(parts, "autoBootstrap="+policy)
		}
		if tool := stringField(bootstrap, "fallbackBuildTool"); tool != "" && tool != "none" {
			parts = append(parts, "buildTool="+tool)
		}
		if dataDir := stringField(bootstrap, "dataDir"); dataDir != "" {
			parts = append(parts, "dataDir="+dataDir)
		}
		if src := stringField(bootstrap, "sourceRepo"); src != "" {
			parts = append(parts, "sourceRepo="+src)
		}
		if ref := stringField(bootstrap, "sourceRef"); ref != "" {
			parts = append(parts, "sourceRef="+ref)
		}
		if commit := stringField(bootstrap, "sourceCommit"); commit != "" {
			parts = append(parts, "sourceCommit="+commit)
		}
		if cmd := stringField(bootstrap, "managedCommand"); cmd != "" {
			parts = append(parts, "managedCommand="+cmd)
		}
		if ts := stringField(bootstrap, "lastCheckedAt"); ts != "" {
			parts = append(parts, "lastCheckedAt="+ts)
		}
		if ts := stringField(bootstrap, "lastBuildAt"); ts != "" {
			parts = append(parts, "lastBuildAt="+ts)
		}
		if mcp := bootstrap["mcpToolsEnabled"]; mcp != nil {
			parts = append(parts, fmt.Sprintf("mcpToolsEnabled=%v", anyBool(mcp)))
		}
		if errorCode := stringField(bootstrap, "errorCode"); errorCode != "" {
			parts = append(parts, "error="+errorCode)
		}
		if errorMessage := stringField(bootstrap, "errorMessage"); errorMessage != "" {
			parts = append(parts, "message="+errorMessage)
		}
		if llmPassthrough := asMap(bootstrap["llmPassthrough"]); len(llmPassthrough) > 0 {
			llmParts := []string{}
			if protocol := stringField(llmPassthrough, "protocol"); protocol != "" {
				llmParts = append(llmParts, "protocol="+protocol)
			}
			if model := stringField(llmPassthrough, "model"); model != "" {
				llmParts = append(llmParts, "model="+model)
			}
			if source := stringField(llmPassthrough, "source"); source != "" {
				llmParts = append(llmParts, "source="+source)
			}
			if len(llmParts) > 0 {
				parts = append(parts, "llm="+strings.Join(llmParts, ","))
			}
		}
		lines = append(lines, strings.Join(parts, " "))

		// MCP tools hint: when bootstrap is ready but the model
		// can't see the write tools, surface the one-line fix so
		// the user knows the lever exists. Mirrors the TS TUI
		// `formatEverCoreWelcomeHint` for parity.
		if stringField(bootstrap, "status") == "ready" && !anyBool(everCore["mcpToolsEnabled"]) {
			lines = append(lines, mutedStyle.Render("  MemoryOS is on (read-only). To let the model save notes: set BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=1 (or run `bbl memory enable-tools`)."))
		}

		// "What to do next" action line. Each actionable
		// bootstrap state surfaces the next CLI command
		// inline so an operator never has to leave the TUI
		// to find the fix.
		if action := memoryActionLine(stringField(bootstrap, "status"), stringField(bootstrap, "errorCode"), anyBool(everCore["mcpToolsEnabled"]), stringField(bootstrap, "autoBootstrapPolicy")); action != "" {
			lines = append(lines, mutedStyle.Render("  Next: "+action))
		}
	}
	lines = append(lines,
		"Capability: auto-search="+fallbackUnknown(stringField(capability, "autoSearch"))+" save="+fallbackUnknown(stringField(capability, "save")),
		fmt.Sprintf("Boundaries: memoryIsHint=%v workspaceEvidenceRequired=%v candidatesAutoWrite=%v", anyBool(guidance["memoryIsHint"]), anyBool(guidance["projectFactsRequireWorkspaceEvidence"]), anyBool(guidance["candidatesAutoWrite"])),
		"Actions: status/search/candidates are read-only; save/flush/restart require permission.",
	)
	return lines
}

func buildMemorySearchOverlayLines(payload map[string]any) []string {
	lines := []string{
		mutedStyle.Render("  memory search · read-only hints"),
		"Query: " + fallbackUnknown(stringField(payload, "query")),
		fmt.Sprintf("Result: hits=%d extracted=%d truncated=%v method=%s topK=%d", anyInt(payload["hitCount"]), anyInt(payload["totalExtractedHits"]), anyBool(payload["truncated"]), fallbackUnknown(stringField(payload, "method")), anyInt(payload["topK"])),
		fmt.Sprintf("Budget: injectedChars=%d budgetChars=%d maxHitChars=%d latencyMs=%d", anyInt(payload["injectedChars"]), anyInt(payload["budgetChars"]), anyInt(payload["maxHitChars"]), anyInt(payload["searchLatencyMs"])),
		"Guidance: memory hints are not workspace facts; verify project facts with workspace/session evidence.",
	}
	if content := stringField(payload, "content"); content != "" {
		lines = append(lines, "Hits:")
		lines = append(lines, strings.Split(content, "\n")...)
	}
	return lines
}

func buildMemoryCandidatesOverlayLines(payload map[string]any) []string {
	lines := []string{
		mutedStyle.Render("  memory candidates · review-only governance"),
		fmt.Sprintf("Candidates: count=%d limit=%d includeRejected=%v", len(anySlice(payload["candidates"])), anyInt(payload["limit"]), anyBool(payload["includeRejected"])),
		"Guidance: autoWrite=false; save requires explicit approval.",
	}
	candidates := anySlice(payload["candidates"])
	if len(candidates) == 0 {
		return append(lines, "No memory candidates found.")
	}
	for _, item := range candidates {
		candidate := asMap(item)
		governance := asMap(candidate["governance"])
		approval := asMap(governance["approval"])
		lines = append(lines,
			fmt.Sprintf("- %s scope=%s decision=%s approval=%s:%s autoWrite=%v evidence=%d", fallbackUnknown(stringField(candidate, "messageId")), fallbackUnknown(stringField(governance, "scope")), fallbackUnknown(stringField(governance, "decision")), fallbackUnknown(stringField(approval, "status")), fallbackUnknown(stringField(approval, "requiredBy")), anyBool(governance["autoWrite"]), len(anySlice(candidate["evidence"]))),
		)
		if content := stringField(candidate, "content"); content != "" {
			lines = append(lines, "  "+truncateMemoryLine(content, 160))
		}
		if blocked := anyStringSlice(governance["blockedReasons"]); len(blocked) > 0 {
			lines = append(lines, "  blocked="+strings.Join(blocked, ","))
		}
		if review := anyStringSlice(governance["reviewReasons"]); len(review) > 0 {
			lines = append(lines, "  review="+strings.Join(review, ","))
		}
	}
	return lines
}

func buildMemoryApprovalOverlayLines(payload map[string]any) []string {
	return []string{
		mutedStyle.Render("  memory action · approval required"),
		"Action: " + fallbackUnknown(stringField(payload, "action")),
		"Risk: " + fallbackUnknown(stringField(payload, "risk")),
		"Required confirmation: " + fallbackUnknown(stringField(payload, "requiredConfirmation")),
		"Guidance: " + fallbackUnknown(stringField(payload, "guidance")),
		"No memory write/lifecycle operation was executed.",
	}
}

func buildMemoryMutationOverlayLines(payload map[string]any) []string {
	lines := []string{
		mutedStyle.Render("  memory action · completed"),
		"Type: " + fallbackUnknown(stringField(payload, "type")),
		"Provider: " + fallbackUnknown(stringField(payload, "provider")),
	}
	if sessionID := stringField(payload, "sessionId"); sessionID != "" {
		lines = append(lines, "Session: "+sessionID)
	}
	if saved := anyInt(payload["savedMessages"]); saved > 0 {
		lines = append(lines, fmt.Sprintf("Saved: messages=%d chars=%d", saved, anyInt(payload["savedChars"])))
	}
	if anyBool(payload["flushed"]) {
		lines = append(lines, "Flushed: true")
	}
	lines = append(lines, "Guidance: search cache invalidated; memory remains a hint, not a fact source.")
	return lines
}

func buildMemoryErrorOverlayLines(payload map[string]any) []string {
	return []string{
		mutedStyle.Render("  memory action · error"),
		"Code: " + fallbackUnknown(stringField(payload, "code")),
		"Message: " + fallbackUnknown(stringField(payload, "message")),
	}
}

// MemoryInfoCardTopic names the lifecycle / info card to render
// in the /memory overlay. Each topic corresponds to a `bbl
// memory …` CLI sub-command. The TUI cannot mutate the local
// bootstrap state directly (that lives in `bbl memory`), so the
// overlay's role is to show the operator (a) the current state,
// (b) what the command does, and (c) the exact CLI invocation
// to run.
type MemoryInfoCardTopic string

const (
	MemoryCardSetup       MemoryInfoCardTopic = "setup"
	MemoryCardAuto        MemoryInfoCardTopic = "auto"
	MemoryCardEnableTools MemoryInfoCardTopic = "enable-tools"
	MemoryCardDisableTools MemoryInfoCardTopic = "disable-tools"
	MemoryCardOptOut      MemoryInfoCardTopic = "opt-out"
	MemoryCardExternal    MemoryInfoCardTopic = "external"
	MemoryCardReset       MemoryInfoCardTopic = "reset"
	MemoryCardDoctor      MemoryInfoCardTopic = "doctor"
)

// buildMemoryInfoCardLines renders an info card overlay for the
// given lifecycle topic. The card always opens in the same
// `modeMemoryOverlay` surface used by `/memory status`, so the
// user navigates with the same up/down/esc/q keys.
//
// `payload` is the latest runtime status JSON (or empty if the
// overlay was opened before the first poll). The card pulls
// current state — build status, MCP tools flag, auto-bootstrap
// policy — from `payload` when present, and falls back to
// "unknown" labels otherwise.
//
// The TUI deliberately does NOT execute the underlying `bbl
// memory …` invocation; doing so would require a side-channel
// to the CLI process and would muddle audit / permission
// boundaries. Instead the card surfaces the literal command line
// the operator should run in their shell.
// buildMemoryInfoCardLines renders a hierarchical info card
// for the given lifecycle topic. The card is the canonical
// MemoryOS lifecycle surface in the Go TUI: every `/memory`
// sub-command opens the same `modeMemoryOverlay` panel, so the
// operator navigates with a single up/down/esc/q muscle memory.
//
// Card layout (every card follows the same shape so the
// hierarchy is obvious at a glance):
//
//   1. Header        : topic + one-line summary
//   2. State table   : right-aligned key:value rows with a
//                      leading status indicator (●/○/✗/…/↗)
//   3. Steps         : numbered list ([1] [2] [3]) when the
//                      action has ordered phases; bullet list
//                      otherwise
//   4. Action        : highlighted "▶  bbl memory …" line
//   5. Footer        : close hint
//
// The TUI deliberately does NOT execute the underlying `bbl
// memory …` invocation; doing so would require a side-channel
// to the CLI process and would muddle audit / permission
// boundaries. Instead the card surfaces the literal command line
// the operator should run in their shell.
func buildMemoryInfoCardLines(topic MemoryInfoCardTopic, payload []byte) []string {
	bootstrap := asMap(payloadBootstrap(payload))
	everCore := asMap(payloadEverCore(payload))

	lines := []string{
		infoCardHeaderLine(topic),
		mutedStyle.Render(infoCardSeparator()),
	}
	lines = append(lines, infoCardStateSection(topic, bootstrap, everCore)...)
	lines = append(lines,
		"",
		infoCardSectionTitle("What this does"),
	)
	lines = append(lines, infoCardStepsSection(topic, bootstrap, everCore)...)
	lines = append(lines,
		"",
		infoCardSectionTitle("How to run"),
		"  ▶  "+infoCardCommand(topic),
		"",
		mutedStyle.Render("  " + infoCardSeparator()),
		mutedStyle.Render("  " + infoCardCloseHint()),
	)
	return lines
}

// infoCardHeaderLine returns the title row. Format:
//
//	"  MemoryOS · Setup   ◯  run `bbl memory setup` to begin"
//
// The right-aligned one-liner is the same idea as the welcome
// hint banner: it answers the implicit "what is this card for?"
// question without scrolling.
func infoCardHeaderLine(topic MemoryInfoCardTopic) string {
	title := "MemoryOS · " + infoCardTitle(topic)
	return mutedStyle.Render("  "+title) + "  " + infoCardStatusBadge(topic, asMap(payloadEverCore(nil)))
}

// infoCardSeparator draws a hairline under the header. Uses
// plain ASCII dashes (not box-drawing chars) to stay readable
// on every terminal.
func infoCardSeparator() string {
	return strings.Repeat("─", 60)
}

func infoCardCloseHint() string {
	return "Press q / Esc / Enter to close this panel."
}

func infoCardSectionTitle(label string) string {
	return mutedStyle.Render("  ▸  " + label)
}

// infoCardStatusBadge returns the leading indicator for the
// card title. The shape mirrors the footer indicator so the
// operator can map between the persistent status line and the
// card's title row.
func infoCardStatusBadge(topic MemoryInfoCardTopic, everCore map[string]any) string {
	switch topic {
	case MemoryCardEnableTools:
		if anyBool(everCore["mcpToolsEnabled"]) {
			return mutedStyle.Render("● on")
		}
		return mutedStyle.Render("○ off")
	case MemoryCardDisableTools:
		if anyBool(everCore["mcpToolsEnabled"]) {
			return mutedStyle.Render("● on")
		}
		return mutedStyle.Render("○ off")
	case MemoryCardOptOut:
		return mutedStyle.Render("○ off")
	case MemoryCardDoctor:
		return mutedStyle.Render("● snapshot")
	}
	return mutedStyle.Render("● open")
}

// infoCardStateSection renders the right-aligned key:value
// table at the top of the card. Empty / unknown values render
// as `—` so the column stays visually balanced.
//
// Layout: the function first scans the rows to find the
// longest *key name* (without colon), then right-pads every
// key to that width, then appends `:` + value. The colons
// line up vertically because they sit at the end of the
// longest-padded key column. Continuation lines (empty key)
// indent to the same column as their parent key's colon.
func infoCardStateSection(topic MemoryInfoCardTopic, bootstrap, everCore map[string]any) []string {
	rows := infoCardStateRows(topic, bootstrap, everCore)
	if len(rows) == 0 {
		return nil
	}
	// Compute the longest key name (no colon). A continuation
	// row with an empty key uses the same width as the longest
	// key so its value column aligns with the rest of the
	// table.
	keyWidth := 0
	for _, row := range rows {
		if w := len(row[0]); w > keyWidth {
			keyWidth = w
		}
	}
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		key := row[0]
		val := row[1]
		if val == "" {
			val = "—"
		}
		if key == "" {
			// Continuation line: pad the empty key to keyWidth
			// so the value starts at the same column as the
			// rest of the table.
			lines = append(lines, "  "+strings.Repeat(" ", keyWidth+1)+val)
			continue
		}
		// "key" + (keyWidth - len(key)) padding + ":" + one
		// space + value. The colons line up because they sit
		// exactly at the right edge of the padded key column.
		pad := keyWidth - len(key)
		lines = append(lines, "  "+key+strings.Repeat(" ", pad)+": "+val)
	}
	return lines
}

// infoCardStateRows returns the (key, value) pairs for the
// top-of-card state table. Each card picks the rows that make
// sense for its topic; unrelated rows are omitted so the card
// stays focused. Keys are bare names (no trailing colon) so the
// renderer can pad to a fixed column width.
func infoCardStateRows(topic MemoryInfoCardTopic, bootstrap, everCore map[string]any) [][2]string {
	switch topic {
	case MemoryCardSetup:
		return [][2]string{
			{"Status", fallbackUnknown(stringField(bootstrap, "status"))},
			{"Path", fallbackUnknown(stringField(bootstrap, "path"))},
			{"Source repo", fallbackUnknown(stringField(bootstrap, "sourceRepo"))},
			{"Source ref", fallbackUnknown(stringField(bootstrap, "sourceRef"))},
			{"Build tool", fallbackUnknown(stringField(bootstrap, "fallbackBuildTool"))},
		}
	case MemoryCardAuto:
		statePolicy := stringField(bootstrap, "autoBootstrapPolicy")
		if statePolicy == "" {
			statePolicy = "prompt"
		}
		return [][2]string{
			{"Current policy", statePolicy + "  (state)"},
			{"Env override", "BABEL_O_EVERCORE_AUTO_BOOTSTRAP=" + envAutoBootstrap()},
			{"Precedence", "env > state > default(prompt)"},
		}
	case MemoryCardEnableTools, MemoryCardDisableTools:
		runtimeMCP := anyBool(everCore["mcpToolsEnabled"])
		stateMCP := anyBool(bootstrap["mcpToolsEnabled"])
		effective := "off"
		if runtimeMCP {
			effective = "on (runtime)"
		} else if stateMCP {
			effective = "on (state)"
		}
		return [][2]string{
			{"MCP tools", effective},
			{"Env override", "BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=" + envMCPTools()},
			{"Precedence", "env > state > default(off)"},
		}
	case MemoryCardOptOut:
		state := "no"
		if anyBool(bootstrap["optedOut"]) {
			state = "yes"
		}
		return [][2]string{
			{"optedOut", state},
			{"Re-enable path", "bbl memory setup (re-prompts on next TTY)"},
		}
	case MemoryCardExternal:
		state := "no"
		if anyBool(bootstrap["externalHintShown"]) {
			state = "yes"
		}
		return [][2]string{
			{"externalHintShown", state},
			{"Required env", "BABEL_O_EVERCORE_MODE=external"},
			{"", "BABEL_O_EVERCORE_BASE_URL=http://127.0.0.1:<port>"},
		}
	case MemoryCardReset:
		return [][2]string{
			{"Status", fallbackUnknown(stringField(bootstrap, "status"))},
			{"Path", fallbackUnknown(stringField(bootstrap, "path"))},
		}
	case MemoryCardDoctor:
		healthy := anyBool(everCore["healthy"])
		enabled := anyBool(everCore["enabled"])
		status := fallbackUnknown(stringField(bootstrap, "status"))
		return [][2]string{
			{"everCore", "enabled=" + boolWord(enabled) + "  healthy=" + boolWord(healthy)},
			{"bootstrap", "status=" + status},
			{"errorCode", fallbackUnknown(stringField(bootstrap, "errorCode"))},
			{"autoBootstrap", fallbackUnknown(stringField(bootstrap, "autoBootstrapPolicy"))},
			{"buildTool", fallbackUnknown(stringField(bootstrap, "fallbackBuildTool"))},
		}
	}
	return nil
}

// infoCardStepsSection returns the middle section. Setup-style
// actions use a numbered list (`[1] [2] [3]`); policy/external
// cards use a bulleted list (`-`). Either way, the leading
// character is column-aligned to keep the card scannable.
func infoCardStepsSection(topic MemoryInfoCardTopic, bootstrap, everCore map[string]any) []string {
	switch topic {
	case MemoryCardSetup:
		return []string{
			"     [1] Clone EverOS from the configured source repo (depth 1).",
			"     [2] Build the Python virtualenv via `uv sync` (or `pip` fallback).",
			"     [3] Write `~/.babel-o/everos-bootstrap.json` with managedCommand, dataDir, and `buildStatus: ready`.",
		}
	case MemoryCardAuto:
		return []string{
			"     •  `on`   — every cold start attempts background bootstrap if pre-reqs are met.",
			"     •  `off`  — never auto-bootstrap; run `bbl memory setup` explicitly.",
			"     •  `prompt` (default) — TTY users see the first-run prompt; non-TTY stays off.",
		}
	case MemoryCardEnableTools:
		return []string{
			"     [1] Persist `mcpToolsEnabled: true` to `~/.babel-o/everos-bootstrap.json`.",
			"     [2] Future cold starts expose the model-visible memory tools:",
			"           - mcp:evercore:memory_save_note   (requires permission)",
			"           - mcp:evercore:memory_flush_session   (requires permission)",
			"           - mcp:evercore:memory_restart   (requires permission)",
			"     [3] Runtime resolves the flag (state > env > default off).",
		}
	case MemoryCardDisableTools:
		return []string{
			"     [1] Persist `mcpToolsEnabled: false` to `~/.babel-o/everos-bootstrap.json`.",
			"     [2] Future cold starts hide the model-visible memory tools; the model",
			"         still sees read-only memory hints via the capability block.",
		}
	case MemoryCardOptOut:
		return []string{
			"     [1] Persist `optedOut: true` to `~/.babel-o/everos-bootstrap.json`.",
			"     [2] Future cold starts skip the first-run prompt permanently.",
			"     [3] The persistent [m: …] footer still shows MemoryOS state; no background bootstrap is attempted.",
		}
	case MemoryCardExternal:
		return []string{
			"     [1] Persist `externalHintShown: true` to `~/.babel-o/everos-bootstrap.json`.",
			"     [2] Set the runtime env in your shell:",
			"           - BABEL_O_EVERCORE_MODE=external",
			"           - BABEL_O_EVERCORE_BASE_URL=http://127.0.0.1:<port>",
			"     [3] The model will connect to your external EverOS via Nexus (loopback only).",
		}
	case MemoryCardReset:
		return []string{
			"     [1] Delete `~/.babel-o/everos-bootstrap.json` so a fresh bootstrap can run.",
			"     [2] The cloned source tree under `~/.babel-o/everos/source/` is NOT removed",
			"         (use `rm -rf` for that).",
			"     [3] The sidecar data directory and managed sidecar process are NOT touched.",
			"         Run `bbl memory restart` first if you need a full reset.",
		}
	case MemoryCardDoctor:
		return []string{
			"     [1] Provider diagnostics (auth, baseUrl, model resolution).",
			"     [2] Keychain reachability (per-platform).",
			"     [3] Sidecar port / health probe.",
			"     [4] MemoryOS bootstrap status (current snapshot above).",
		}
	}
	return nil
}

func infoCardTitle(topic MemoryInfoCardTopic) string {
	switch topic {
	case MemoryCardSetup:
		return "Setup"
	case MemoryCardAuto:
		return "Auto-bootstrap policy"
	case MemoryCardEnableTools:
		return "Enable model-visible memory tools"
	case MemoryCardDisableTools:
		return "Disable model-visible memory tools"
	case MemoryCardOptOut:
		return "Opt out of first-run prompt"
	case MemoryCardExternal:
		return "Mark as externally managed"
	case MemoryCardReset:
		return "Reset local bootstrap state"
	case MemoryCardDoctor:
		return "Self-check (doctor)"
	}
	return string(topic)
}

func infoCardCommand(topic MemoryInfoCardTopic) string {
	switch topic {
	case MemoryCardSetup:
		return "bbl memory setup [--yes|--status|--retry|--reset|--auto-install-prerequisites]"
	case MemoryCardAuto:
		return "bbl memory auto [on|off|prompt]"
	case MemoryCardEnableTools:
		return "bbl memory enable-tools"
	case MemoryCardDisableTools:
		return "bbl memory disable-tools"
	case MemoryCardOptOut:
		return "bbl memory opt-out"
	case MemoryCardExternal:
		return "bbl memory external"
	case MemoryCardReset:
		return "bbl memory reset --yes"
	case MemoryCardDoctor:
		return "bbl memory doctor    # or: bbl doctor --memory-only"
	}
	return "bbl memory " + string(topic)
}

func payloadBootstrap(payload []byte) any {
	if len(payload) == 0 {
		return nil
	}
	var p map[string]any
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil
	}
	return p["bootstrap"]
}

func payloadEverCore(payload []byte) any {
	if len(payload) == 0 {
		return nil
	}
	var p map[string]any
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil
	}
	return p["everCore"]
}

func envAutoBootstrap() string {
	if v := osGetenv("BABEL_O_EVERCORE_AUTO_BOOTSTRAP"); v != "" {
		return v
	}
	return "<unset>"
}

func envMCPTools() string {
	if v := osGetenv("BABEL_O_ENABLE_EVERCORE_MCP_TOOLS"); v != "" {
		return v
	}
	return "<unset>"
}

// osGetenv is a tiny seam for tests; the default impl just
// returns "<unset>" so the panel label is always meaningful.
// Tests that need to assert on a real env value override
// osGetenv before calling.
var osGetenv = func(key string) string {
	return "<unset>"
}

func boolWord(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func renderMemoryOverlayLines(lines []string, scroll int, height int) []string {
	if len(lines) == 0 {
		lines = []string{"No memory status loaded yet."}
	}
	visibleRows := max(1, height-10)
	maxScroll := max(0, len(lines)-visibleRows)
	if scroll > maxScroll {
		scroll = maxScroll
	}
	end := scroll + visibleRows
	if end > len(lines) {
		end = len(lines)
	}
	return lines[scroll:end]
}

func (m model) renderMemoryOverlay(width int) string {
	if m.inputMode != modeMemoryOverlay {
		return ""
	}
	header := titleStyle.Render("Memory")
	lines := []string{header, divider(width)}
	lines = append(lines, renderMemoryOverlayLines(m.memoryOverlayLines, m.memoryOverlayScroll, m.height)...)
	lines = append(lines, mutedStyle.Render("↑/↓/Tab scroll · esc/enter/q close"))
	return renderOverlayFrame(width, contextStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2))))
}

func anyBool(value any) bool {
	if v, ok := value.(bool); ok {
		return v
	}
	return false
}

func anySlice(value any) []any {
	if v, ok := value.([]any); ok {
		return v
	}
	return nil
}

func anyStringSlice(value any) []string {
	items := anySlice(value)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			result = append(result, strings.TrimSpace(text))
		}
	}
	return result
}

func truncateMemoryLine(value string, maxChars int) string {
	trimmed := strings.TrimSpace(value)
	if maxChars <= 0 || len(trimmed) <= maxChars {
		return trimmed
	}
	return trimmed[:maxChars] + "..."
}

// formatMemoryFooter renders a single-line memory indicator for
// the persistent footer driven by the /v1/runtime/status poll
// (Z6 of the zero-friction memory plan). The indicator encodes
// four states: ready (green), off, failed (with errorCode),
// in-flight (cloning/building/checking_prereqs), and external.
// An empty string means there is nothing actionable to show.
func formatMemoryFooter(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ""
	}
	everCore := asMap(payload["everCore"])
	bootstrap := asMap(payload["bootstrap"])
	bootstrapStatus := stringField(bootstrap, "status")
	switch bootstrapStatus {
	case "ready":
		if anyBool(everCore["healthy"]) {
			return "[m: ready]"
		}
		return "[m: unhealthy]"
	case "failed":
		if code := stringField(bootstrap, "errorCode"); code != "" {
			return "[m: failed ⚠ " + code + "]"
		}
		return "[m: failed ⚠]"
	case "cloning", "building", "checking_prereqs":
		return "[m: " + bootstrapStatus + "…]"
	case "opted_out":
		return "[m: off]"
	case "external":
		return "[m: external]"
	case "not_configured", "":
		return "[m: off]"
	}
	return ""
}

// formatMemoryHintLine returns a one-line user-facing hint for the
// chat-view banner. Mirrors `formatEverCoreWelcomeHint` on the
// TS side: it surfaces actionable states (failed, not-configured,
// ready-but-tools-off) and stays silent when there is nothing
// to say. The hint is rendered above the input box; an empty
// string means the banner slot is empty.
func formatMemoryHintLine(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ""
	}
	everCore := asMap(payload["everCore"])
	bootstrap := asMap(payload["bootstrap"])
	// `not_configured` is the status set by the TS `everOSBootstrapStatus`
	// helper when the bootstrap file is missing entirely.
	if stringField(bootstrap, "status") == "not_configured" {
		return dim("MemoryOS: not configured. Tip: bbl memory setup")
	}
	status := stringField(bootstrap, "status")
	switch status {
	case "failed":
		code := stringField(bootstrap, "errorCode")
		if code == "" {
			code = "unknown"
		}
		return dim("⚠ MemoryOS: setup failed (" + code + "). Run: bbl memory setup --retry")
	case "cloning", "building", "checking_prereqs":
		return dim("MemoryOS: " + status + " in background…")
	case "opted_out":
		return dim("MemoryOS: opted out. Run: bbl memory setup to enable")
	case "external":
		return dim("MemoryOS: external. Set BABEL_O_EVERCORE_MODE=external + BABEL_O_EVERCORE_BASE_URL.")
	case "not_configured", "":
		return dim("MemoryOS: not configured. Tip: bbl memory setup")
	case "ready":
		if !anyBool(everCore["mcpToolsEnabled"]) {
			return dim("MemoryOS: ready (read-only). bbl memory enable-tools to let the model write.")
		}
	}
	return ""
}

func dim(s string) string { return mutedStyle.Render(s) }

// memoryActionLine maps a (status, errorCode, mcpToolsEnabled,
// autoBootstrapPolicy) tuple to the next CLI command an operator
// should run. Returns an empty string when there is nothing
// actionable to suggest. Mirrors the fix-action rendering in the
// TS `formatEverCoreWelcomeHint` for parity.
func memoryActionLine(status, errorCode string, mcpToolsEnabled bool, autoBootstrapPolicy string) string {
	switch status {
	case "failed":
		// Mirror the per-error-code advice baked into
		// `suggestEverCoreFixAction` on the TS side. Keep the
		// CLI command itself identical so the operator can
		// copy-paste between surfaces.
		switch errorCode {
		case "EVEROS_BOOTSTRAP_UV_MISSING":
			return "install uv (https://docs.astral.sh/uv/) and run `bbl memory setup --retry`"
		case "EVEROS_BOOTSTRAP_PYTHON_MISSING":
			return "install Python 3.12+ and run `bbl memory setup --retry`"
		case "EVEROS_BOOTSTRAP_GIT_MISSING":
			return "install git and run `bbl memory setup --retry`"
		case "EVEROS_BOOTSTRAP_PACKAGE_MANAGER_UNSUPPORTED":
			return "run `bbl memory setup --auto-install-prerequisites`, or install uv manually"
		case "EVEROS_BOOTSTRAP_CONCURRENT_INSTALL_IN_PROGRESS":
			return "another `bbl` is bootstrapping — wait a moment, the next cold start will retry automatically"
		default:
			return "run `bbl memory setup --retry` once the underlying issue is resolved"
		}
	case "cloning", "building", "checking_prereqs":
		return "bootstrap is in flight in the background; the footer indicator will switch to `[m: ready]` when complete"
	case "not_configured", "":
		return "run `bbl memory setup --yes` to clone + build MemoryOS in the background"
	case "opted_out":
		return "run `bbl memory setup` to re-enable (this also re-prompts in interactive chat)"
	case "external":
		return "MemoryOS is external — set BABEL_O_EVERCORE_MODE=external and BABEL_O_EVERCORE_BASE_URL to connect"
	case "ready":
		if !mcpToolsEnabled {
			return "run `bbl memory enable-tools` to let the model save notes (currently read-only)"
		}
		if autoBootstrapPolicy == "" {
			return "run `bbl memory auto on` to keep MemoryOS warm across cold starts (currently defaults to prompt)"
		}
	}
	return ""
}
