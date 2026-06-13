package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/sahilm/fuzzy"
)

// slashCommand describes a single Phase 4 slash-palette entry. A command
// either has zero args (run immediately when the user presses Enter in
// the palette) or has args (insert the prefix and return to composing
// so the user can type the rest of the command). The palette never
// pre-empts the textinput when a command needs an argument.
type slashCommand struct {
	name     string
	aliases  []string
	summary  string
	shortcut string
	hasArgs  bool
	argHint  string
	prefix   string // when non-empty, the palette inserts this string into the textinput and returns to composing
	run      func(m *model, args []string) tea.Cmd
}

func (c slashCommand) Shortcut() string { return c.shortcut }

// toolDescriptor is the read-only row the /tools palette renders. The
// fields map 1:1 to /v1/tools/audit entries. The Phase 4
// wire path (fetchToolAudit) hydrates toolDescriptor from
// runtimeToolAuditEntry; staticToolDescriptorCatalog remains
// as the offline fallback when the Nexus endpoint is
// unreachable.
type toolDescriptor struct {
	name     string
	risk     string
	source   string
	approval bool
	summary  string
}

// staticToolDescriptorCatalog returns the Phase 4 hard-coded
// tool list as a slice of toolDescriptor. Used as the offline
// fallback when /v1/tools/audit is unreachable and as a
// reference shape for tests that compare the static catalog to
// the wire result. Mirrors the static catalog the Go TUI
// rendered before the Phase 4 wire.
func staticToolDescriptorCatalog() []toolDescriptor {
	return []toolDescriptor{
		{name: "Read", risk: "read", source: "builtin", approval: false, summary: "read a workspace file"},
		{name: "Write", risk: "write", source: "builtin", approval: true, summary: "create or overwrite a file"},
		{name: "Edit", risk: "write", source: "builtin", approval: true, summary: "edit an existing file"},
		{name: "Bash", risk: "execute", source: "builtin", approval: true, summary: "run a shell command"},
		{name: "Glob", risk: "read", source: "builtin", approval: false, summary: "expand a glob pattern"},
		{name: "Grep", risk: "read", source: "builtin", approval: false, summary: "search for a regex in workspace"},
		{name: "WebSearch", risk: "read", source: "builtin", approval: false, summary: "search the public web"},
		{name: "TaskCreate", risk: "task", source: "builtin", approval: true, summary: "create a tracked task"},
	}
}

// slashCommands is the static Phase 4 registry. Real backend calls
// (profile select, config refresh) go through Nexus HTTP; placeholder
// commands surface a status line so the user knows the entry exists
// but is not yet wired.
var slashCommands []slashCommand

func init() {
	slashCommands = []slashCommand{
		{
			name:    "/help",
			summary: "show local command reference",
			run: func(m *model, _ []string) tea.Cmd {
				// Inline the name list to avoid the static-init cycle
				// (slashCommands is still being constructed when this
				// lambda is created; reading the slice from inside the
				// body would require it to be fully built first).
				names := []string{
					"/help", "/config", "/profile", "/clear", "/exit",
					"/context", "/compact", "/memory", "/inbox", "/model", "/models", "/tool", "/tools",
					"/session", "/sessions", "/agents", "/bash", "/read", "/grep", "/glob",
					"/write", "/edit",
				}
				m.appendLine("status", "local commands: "+strings.Join(names, ", "))
				return nil
			},
		},
		{
			name:    "/config",
			summary: "refresh shared Nexus config + profile state",
			run: func(m *model, _ []string) tea.Cmd {
				m.appendLine("status", "refreshing shared Nexus config")
				return tea.Batch(fetchRuntimeConfig(m.cfg, 0), fetchRuntimeProfiles(m.cfg))
			},
		},
		{
			name:    "/profile",
			aliases: []string{"/profiles"},
			summary: "list profiles (no args) or select a profile",
			hasArgs: true,
			argHint: "[name]",
			run: func(m *model, args []string) tea.Cmd {
				if len(args) == 0 {
					m.appendLine("status", "loading shared Nexus profiles")
					return fetchRuntimeProfiles(m.cfg)
				}
				profile := args[0]
				if profile == m.activeProfile && profile != "" {
					m.appendLine("status", "profile already active: "+profile)
					return nil
				}
				// Profile switch is a session-affecting action: gate it
				// behind a y/n overlay so an accidental submit can't
				// change provider/model mid-conversation. The HTTP call
				// is deferred to the y/enter branch in the mode dispatch.
				m.pendingProfileName = profile
				m.setMode(modeProfileConfirm)
				return nil
			},
		},
		{
			name:    "/clear",
			summary: "clear transcript",
			run: func(m *model, _ []string) tea.Cmd {
				m.transcript = nil
				return nil
			},
		},
		{
			name:     "/exit",
			aliases:  []string{"/quit"},
			summary:  "quit the Go TUI",
			shortcut: "ctrl+q",
			run: func(_ *model, _ []string) tea.Cmd {
				return tea.Quit
			},
		},
		{
			name:    "/context",
			summary: "analyze current context window usage via Nexus",
			run: func(m *model, _ []string) tea.Cmd {
				if m.sessionID == "" {
					m.appendLine("status", "context: no active session yet — submit a prompt first")
					return nil
				}
				return fetchContextAnalysis(m.cfg, m.sessionID)
			},
		},
		{
			name:    "/compact",
			summary: "trigger context compaction on the active session",
			run: func(m *model, _ []string) tea.Cmd {
				if m.sessionID == "" {
					m.appendLine("status", "compact: no active session yet — submit a prompt first")
					return nil
				}
				m.appendLine("status", "compacting shared Nexus context: "+shortID(m.sessionID))
				return triggerCompact(m.cfg, m.sessionID)
			},
		},
		{
			name:    "/memory",
			summary: "open long-term memory status/actions overlay",
			hasArgs: true,
			argHint: "[status|search <query>|candidates|save <note>|flush|restart]",
			run: func(m *model, args []string) tea.Cmd {
				if len(args) == 0 || args[0] == "status" {
					m.appendLine("status", "loading shared Nexus memory status")
					return fetchMemoryStatus(m.cfg)
				}
				sub := args[0]
				rest := strings.TrimSpace(strings.Join(args[1:], " "))
				switch sub {
				case "search":
					if rest == "" {
						m.appendLine("error", "/memory search requires a query")
						return nil
					}
					m.appendLine("status", "searching shared Nexus memory")
					return fetchMemorySearch(m.cfg, rest)
				case "candidates":
					m.appendLine("status", "loading shared Nexus memory candidates")
					return fetchMemoryCandidates(m.cfg, m.sessionID)
				case "save":
					if rest == "" {
						m.appendLine("error", "/memory save requires a note")
						return nil
					}
					m.appendLine("status", "requesting memory save approval envelope")
					return requestMemorySaveNote(m.cfg, rest, m.sessionID)
				case "flush":
					if m.sessionID == "" {
						m.appendLine("error", "/memory flush requires an active session")
						return nil
					}
					m.appendLine("status", "requesting memory flush approval envelope")
					return requestMemoryFlush(m.cfg, m.sessionID)
				case "restart":
					m.appendLine("status", "requesting memory restart approval envelope")
					return requestMemoryRestart(m.cfg)
				default:
					m.appendLine("error", "unknown /memory sub-command: "+sub+" (supported: status, search <query>, candidates, save <note>, flush, restart)")
					return nil
				}
			},
		},
		{
			name:    "/inbox",
			summary: "open SessionChannel inbox overlay",
			run: func(m *model, args []string) tea.Cmd {
				// Sub-commands: "/inbox all" and "/inbox ack <messageId>".
				// Bare "/inbox" fetches unread-only (matches the TS TUI
				// default). Without an active session both variants
				// short-circuit with a friendly status line so the user
				// isn't confused by a 404 from the Nexus API.
				if len(args) > 0 {
					switch args[0] {
					case "all":
						return m.fetchInboxWithSession(true)
					case "ack":
						if len(args) < 2 {
							m.appendLine("error", "/inbox ack requires a message id: /inbox ack <messageId>")
							return nil
						}
						return m.ackInboxMessageWithSession(args[1])
					default:
						m.appendLine("error", "unknown /inbox sub-command: "+args[0]+" (supported: all, ack <messageId>)")
						return nil
					}
				}
				return m.fetchInboxWithSession(false)
			},
		},
		{
			name:     "/model",
			summary:  "open interactive model registry (provider → api key → base URL → model)",
			shortcut: "ctrl+l",
			hasArgs:  true,
			argHint:  "[id]",
			run: func(m *model, args []string) tea.Cmd {
				if len(m.modelCatalog.Providers) == 0 {
					m.appendLine("status", "loading shared Nexus model configuration")
					return fetchRuntimeModels(m.cfg, "model")
				}
				m.openModelRegistry()
				// /model <id> is a quick direct-select: seed the
				// draft input with the requested model id so the
				// operator can override or accept the default
				// values in the subsequent apiKey / baseURL
				// steps. openModelRegistry() reset the draft
				// above, so set it AFTER.
				if len(args) > 0 {
					m.modelPickProviderDraft = args[0]
				}
				return nil
			},
		},
		{
			name:    "/models",
			summary: "list models from shared Nexus registry",
			run: func(m *model, _ []string) tea.Cmd {
				m.appendLine("status", "loading shared Nexus models capability matrix")
				return fetchRuntimeModels(m.cfg, "models")
			},
		},
		{
			name:     "/tools",
			aliases:  []string{"/tool"},
			summary:  "open tool audit overlay",
			shortcut: "ctrl+o",
			run: func(m *model, _ []string) tea.Cmd {
				// Phase 4 wire: GET /v1/tools/audit replaces the
				// static catalog. On wire success the overlay shows
				// the real runtime tool registry (builtin + MCP
				// tools, risk + approval + suggested allow rule).
				// On wire failure the slash handler falls back to
				// the static catalog so the user can still see a
				// known-good list when the Nexus is unreachable.
				m.appendLine("status", "loading shared Nexus tools audit")
				return fetchToolAudit(m.cfg, "user")
			},
		},
		{
			name:    "/session",
			aliases: []string{"/sessions"},
			summary: "show, switch, or create the active session",
			argHint: "[new|use <sessionId>|current]",
			run: func(m *model, args []string) tea.Cmd {
				return m.handleSessionCommand(args)
			},
		},
		{
			name:     "/tasks",
			summary:  "open task board overlay",
			shortcut: "ctrl+t",
			run: func(m *model, _ []string) tea.Cmd {
				return m.fetchSessionTasksWithSession()
			},
		},
		{
			name:    "/activity",
			summary: "open recent activity overlay",
			run: func(m *model, _ []string) tea.Cmd {
				// No HTTP round-trip — the activity buffer is
				// populated by consumeNexusEvent as the user
				// types and the model runs. The overlay is
				// purely a viewport over the in-memory buffer.
				m.activityOverlayScroll = 0
				summary := fmt.Sprintf("activity: %d event(s) recorded", len(m.activityEvents))
				m.appendLine("status", summary)
				m.setMode(modeActivityOverlay)
				return nil
			},
		},
		{
			name:     "/agents",
			summary:  "open multi-agent status overlay",
			shortcut: "ctrl+g",
			run: func(m *model, _ []string) tea.Cmd {
				return m.fetchSessionAgentsWithSession()
			},
		},
		// Prefix-insertion commands: when picked from the palette, the
		// command name + space is inserted into the textinput and the user
		// is dropped back into composing. They never run server-side.
		{
			name:    "/bash",
			summary: "insert Bash prefix",
			hasArgs: true,
			argHint: "<command>",
			prefix:  "/bash ",
		},
		{
			name:    "/read",
			summary: "insert Read prefix",
			hasArgs: true,
			argHint: "<path>",
			prefix:  "/read ",
		},
		{
			name:    "/grep",
			summary: "insert Grep prefix",
			hasArgs: true,
			argHint: "<pattern>",
			prefix:  "/grep ",
		},
		{
			name:    "/glob",
			summary: "insert Glob prefix",
			hasArgs: true,
			argHint: "<pattern>",
			prefix:  "/glob ",
		},
		{
			name:    "/write",
			summary: "insert Write prefix",
			hasArgs: true,
			argHint: "<path> <text>",
			prefix:  "/write ",
		},
		{
			name:    "/edit",
			summary: "insert Edit prefix",
			hasArgs: true,
			argHint: "<path> <old> <new>",
			prefix:  "/edit ",
		},
	}
}

type slashCommandMatch struct {
	command slashCommand
	match   fuzzy.Match
}

func (m slashCommandMatch) Filter() string {
	return m.commandFilter()
}

func (m slashCommandMatch) commandFilter() string {
	parts := []string{strings.TrimPrefix(m.command.name, "/")}
	for _, alias := range m.command.aliases {
		parts = append(parts, strings.TrimPrefix(alias, "/"))
	}
	return strings.Join(parts, " ")
}

func (m *slashCommandMatch) SetMatch(match fuzzy.Match) {
	m.match = match
}

// filterSlashCommandMatches narrows the registry with fuzzy matching.
// Empty query preserves registry order. Non-empty query is ranked by
// sahilm/fuzzy so non-prefix but useful matches (e.g. "mdl" → /model)
// still appear.
func filterSlashCommandMatches(prefix string) []slashCommandMatch {
	items := make([]slashCommandMatch, len(slashCommands))
	for i, command := range slashCommands {
		items[i] = slashCommandMatch{command: command}
	}
	query := strings.ToLower(strings.TrimPrefix(prefix, "/"))
	if query == "" {
		return items
	}

	// Preserve the old prefix-filter feel first: when the user types
	// "prof", /profile should be the only result even though another
	// command's summary contains similar letters.
	prefixMatches := make([]slashCommandMatch, 0, len(items))
	for _, item := range items {
		if slashCommandHasPrefix(item.command, query) {
			prefixMatches = append(prefixMatches, withSlashCommandNameMatch(item, query))
		}
	}
	if len(prefixMatches) > 0 {
		return prefixMatches
	}

	// Next, fuzzy-match command names and aliases only. This enables
	// shorthand like "mdl" → /model without summary text outranking the
	// command the operator likely intended.
	commandFilters := make([]string, len(items))
	for i, item := range items {
		commandFilters[i] = item.commandFilter()
	}
	commandMatches := fuzzy.Find(query, commandFilters)
	if len(commandMatches) > 0 {
		out := make([]slashCommandMatch, 0, len(commandMatches))
		for _, match := range commandMatches {
			item := items[match.Index]
			item.match = match
			out = append(out, item)
		}
		return out
	}

	return nil
}

func slashCommandHasPrefix(command slashCommand, query string) bool {
	if strings.HasPrefix(strings.ToLower(strings.TrimPrefix(command.name, "/")), query) {
		return true
	}
	for _, alias := range command.aliases {
		if strings.HasPrefix(strings.ToLower(strings.TrimPrefix(alias, "/")), query) {
			return true
		}
	}
	return false
}

func withSlashCommandNameMatch(item slashCommandMatch, query string) slashCommandMatch {
	name := strings.ToLower(strings.TrimPrefix(item.command.name, "/"))
	if strings.HasPrefix(name, query) {
		item.match = fuzzy.Match{Str: item.command.name, MatchedIndexes: sequentialIndexes(len(query))}
		return item
	}
	for _, alias := range item.command.aliases {
		trimmed := strings.ToLower(strings.TrimPrefix(alias, "/"))
		if strings.HasPrefix(trimmed, query) {
			item.match = fuzzy.Match{Str: alias, MatchedIndexes: nil}
			return item
		}
	}
	return item
}

func sequentialIndexes(n int) []int {
	indexes := make([]int, n)
	for i := range indexes {
		indexes[i] = i
	}
	return indexes
}

func ptrsToSlashCommandMatches(items []slashCommandMatch) []*slashCommandMatch {
	out := make([]*slashCommandMatch, len(items))
	for i := range items {
		out[i] = &items[i]
	}
	return out
}

func slashCommandMatchValues(items []*slashCommandMatch) []slashCommandMatch {
	out := make([]slashCommandMatch, len(items))
	for i, item := range items {
		out[i] = *item
	}
	return out
}

func highlightSlashCommandName(item slashCommandMatch) string {
	name := item.command.name
	if len(item.match.MatchedIndexes) == 0 {
		return name
	}
	matched := make(map[int]bool, len(item.match.MatchedIndexes))
	for _, idx := range item.match.MatchedIndexes {
		// Match indexes are relative to Filter(), whose first segment is
		// the command name without the leading slash. Shift by one so
		// highlighted columns line up with the rendered slash command.
		if idx+1 < len(name) {
			matched[idx+1] = true
		}
	}
	var out strings.Builder
	out.Grow(len(name) + len(item.match.MatchedIndexes)*(len(buttonHotkeyOpen)+len(buttonHotkeyClose)))
	for idx, r := range name {
		if matched[idx] {
			out.WriteString(buttonHotkeyOpen)
			out.WriteRune(r)
			out.WriteString(buttonHotkeyClose)
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}

// filterSlashCommands preserves the legacy API used by command
// execution/tests while the renderer consumes filterSlashCommandMatches
// to access matched indexes for highlighting.
func filterSlashCommands(prefix string) []slashCommand {
	matched := filterSlashCommandMatches(prefix)
	out := make([]slashCommand, len(matched))
	for i, item := range matched {
		out[i] = item.command
	}
	return out
}

// findSlashCommand returns the slash command whose name (or alias)
// matches input exactly (case-insensitive). Returns nil if no match.
func findSlashCommand(input string) *slashCommand {
	name := strings.ToLower(strings.TrimSpace(input))
	if name == "" {
		return nil
	}
	for i, c := range slashCommands {
		if strings.ToLower(c.name) == name {
			return &slashCommands[i]
		}
		for _, a := range c.aliases {
			if strings.ToLower(a) == name {
				return &slashCommands[i]
			}
		}
	}
	return nil
}

func findSlashCommandByShortcut(shortcut string) *slashCommand {
	shortcut = strings.ToLower(strings.TrimSpace(shortcut))
	if shortcut == "" {
		return nil
	}
	for i, c := range slashCommands {
		if strings.ToLower(c.Shortcut()) == shortcut {
			return &slashCommands[i]
		}
	}
	return nil
}

func shortcutKeyString(msg tea.KeyMsg) string {
	return msg.String()
}

func (m *model) dispatchCommandShortcut(msg tea.KeyMsg) (tea.Cmd, bool) {
	cmd := findSlashCommandByShortcut(shortcutKeyString(msg))
	if cmd == nil {
		return nil, false
	}
	m.paletteFilter = ""
	m.paletteSelected = 0
	m.setMode(modeComposing)
	m.resize()
	if cmd.prefix != "" {
		m.setInputValue(cmd.prefix)
		m.appendLine("status", "inserted prefix: "+cmd.prefix)
		return nil, true
	}
	return cmd.run(m, nil), true
}

// runPaletteSelection executes (or inserts the prefix of) the
// currently selected command in the slash palette, then resets
// palette state and returns to composing. For zero-arg commands
// the runner fires immediately; for has-arg commands the prefix
// (e.g. "/bash ") is dropped into the textinput so the user can
// continue typing the rest of the command.
func (m *model) runPaletteSelection() tea.Cmd {
	matched := filterSlashCommands(m.paletteFilter)
	if len(matched) == 0 {
		m.appendLine("status", "no command matches: /"+m.paletteFilter)
		return nil
	}
	idx := m.paletteSelected
	if idx < 0 || idx >= len(matched) {
		idx = 0
	}
	cmd := matched[idx]
	m.paletteFilter = ""
	m.paletteSelected = 0
	m.setMode(modeComposing)
	m.resize()

	if cmd.prefix != "" {
		// Insert the prefix into the textinput so the user can keep
		// typing arguments.
		m.setInputValue(cmd.prefix)
		m.appendLine("status", "inserted prefix: "+cmd.prefix)
		return nil
	}
	if cmd.hasArgs {
		// Has-arg command with no prefix means the command takes a
		// positional arg parsed by handleLocalCommand; insert the
		// command name + space and stay in composing.
		inserted := cmd.name + " "
		m.setInputValue(inserted)
		m.appendLine("status", "type the argument, then press enter: "+inserted)
		return nil
	}
	// Zero-arg command: run it immediately.
	m.appendLine("user", cmd.name)
	runCmd := cmd.run(m, nil)
	m.viewport.GotoBottom()
	return runCmd
}

// renderToolPalette pushes the static tool catalog into the transcript
// as a set of status lines, one tool per line. The shape (name,
// risk, source, approval, summary) matches /v1/tools/audit so the
// Phase 7 wiring can drop in without changing the user-facing UX.
func (m *model) renderToolPalette(tools []toolDescriptor) {
	m.appendLine("status", fmt.Sprintf("tools (%d, read-only):", len(tools)))
	for _, t := range tools {
		approval := "no-approval"
		if t.approval {
			approval = "approval-required"
		}
		// Pad name to 12 chars for column alignment.
		name := t.name
		for len(name) < 12 {
			name += " "
		}
		line := fmt.Sprintf("  %s  risk=%-7s  source=%-8s  %s  — %s", name, t.risk, t.source, approval, t.summary)
		m.appendLine("tool", line)
	}
}

// renderSlashPalette paints the live-filter palette above the input
// line. It is a compact overlay: header (current filter), up to
// 6 candidates with the selected one highlighted, and a hint row.
func (m model) renderSlashPalette(width int) string {
	if m.inputMode != modeSlashPick {
		return ""
	}
	matched := filterSlashCommandMatches(m.paletteFilter)
	// visibleHeight mirrors the TS TUI's slash palette (8 rows);
	// it keeps the palette compact enough to read at a glance
	// while letting the user scroll through longer filtered lists
	// (the static catalog has ~20 entries, so we need paging).
	const visibleHeight = 8
	total := len(matched)
	visible := total
	if visible > visibleHeight {
		visible = visibleHeight
	}
	scrollOffset := 0
	if m.paletteSelected >= visibleHeight {
		scrollOffset = m.paletteSelected - visibleHeight + 1
	}
	if scrollOffset+visible > total {
		scrollOffset = max(0, total-visible)
	}
	header := titleStyle.Render("Slash · " + "/" + m.paletteFilter)
	// Two-column layout (command + summary). The earlier
	// `kind` column was redundant — `→ run` / `→ enter arg:
	// …` is implied by whether the command has args, and
	// dropping the middle column frees ~28 columns for the
	// summary text on narrow terminals so the operator can
	// read the description without the trailing
	// truncation eating the first two words.
	lines := []string{header, divider(width), mutedStyle.Render("  command                summary")}
	if total == 0 {
		lines = append(lines, mutedStyle.Render("  (no commands match)"))
	} else {
		// Clamp selection to a valid range in case the filter shrank.
		idx := m.paletteSelected
		if idx < 0 || idx >= total {
			idx = 0
		}
		// command column: 20 chars wide (covers `/profile`,
		// `/compact`, `/inbox`, etc. plus the trailing space).
		// Summary column gets the remainder of the row width
		// and is truncated with `…` when it overflows.
		const commandColumnWidth = 20
		summaryWidth := max(8, width-commandColumnWidth-4)
		remainingAbove := scrollOffset
		if remainingAbove > 0 {
			lines = append(lines, mutedStyle.Render(fmt.Sprintf("  ↑ %d more", remainingAbove)))
		}
		for i := 0; i < visible; i++ {
			actualIdx := scrollOffset + i
			c := matched[actualIdx]
			marker := "  "
			if actualIdx == idx {
				marker = "> "
			}
			name := highlightSlashCommandName(c)
			plainName := c.command.name
			if len(plainName) < commandColumnWidth-1 {
				name = name + strings.Repeat(" ", commandColumnWidth-1-len(plainName))
			}
			summary := truncatePlain(c.command.summary, summaryWidth)
			line := fmt.Sprintf("%s%s  %s", marker, name, mutedStyle.Render(summary))
			if actualIdx == idx {
				line = focusedLineStyle.Render(line)
			}
			lines = append(lines, line)
		}
		remainingBelow := total - (scrollOffset + visible)
		if remainingBelow > 0 {
			lines = append(lines, mutedStyle.Render(fmt.Sprintf("  ↓ %d more", remainingBelow)))
		}
	}
	lines = append(lines, mutedStyle.Render("↑↓/Tab navigate · Enter select · Esc cancel"))
	return strings.Join(lines, "\n")
}

func (m *model) handleLocalCommand(input string) tea.Cmd {
	fields := strings.Fields(input)
	if len(fields) == 0 {
		return nil
	}
	m.appendLine("user", input)
	cmd := findSlashCommand(fields[0])
	if cmd == nil {
		m.appendLine("error", "unknown local command: "+fields[0])
		return nil
	}
	if cmd.run == nil {
		// Prefix-insertion commands (e.g. /bash) have no server-side
		// runner; they only fire from the slash palette. If a user
		// somehow submits them directly, surface a helpful error
		// instead of nil-pointer-dereferencing.
		m.appendLine("error", "command is not executable via direct submit: "+fields[0]+" (open the slash palette to use it)")
		return nil
	}
	return cmd.run(m, fields[1:])
}
