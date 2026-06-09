package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/gorilla/websocket"
)

type config struct {
	baseURL        string
	cwd            string
	sessionID      string
	apiKey         string
	altScreen      bool
	pollIntervalMs int
}

type streamStartedMsg struct {
	events    <-chan streamEvent
	decisions chan<- permissionDecision
}

type streamEventMsg struct {
	event streamEvent
}

type streamClosedMsg struct{}

type streamEvent struct {
	payload map[string]any
	err     error
}

type permissionDecision struct {
	sessionID string
	toolUseID string
	approved  bool
	reason    string
}

type pendingPermission struct {
	sessionID string
	toolUseID string
	name      string
	risk      string
	input     string
	message   string
}

type runtimeCapabilities struct {
	ToolCalling      bool `json:"toolCalling"`
	JSONOutput       bool `json:"jsonOutput"`
	StructuredOutput bool `json:"structuredOutput"`
	Streaming        bool `json:"streaming"`
}

type runtimeProfileTombstone struct {
	DeletedAt string `json:"deletedAt"`
}

type runtimeConfig struct {
	Type             string                             `json:"type"`
	Version          int                                `json:"version"`
	ModelID          string                             `json:"modelId"`
	ModelName        string                             `json:"modelName"`
	ProviderID       string                             `json:"providerId"`
	ProviderName     string                             `json:"providerName"`
	ModelSource      string                             `json:"modelSource"`
	HasAPIKey        bool                               `json:"hasApiKey"`
	APIKeySource     string                             `json:"apiKeySource"`
	BaseURL          string                             `json:"baseUrl"`
	BaseURLSource    string                             `json:"baseUrlSource"`
	ActiveProfile    string                             `json:"activeProfile"`
	ContextWindow    int                                `json:"contextWindow"`
	DefaultMaxTokens int                                `json:"defaultMaxTokens"`
	Capabilities     runtimeCapabilities                `json:"capabilities"`
	Tombstones       map[string]runtimeProfileTombstone `json:"tombstones"`
}

type runtimeProfile struct {
	Name             string              `json:"name"`
	Active           bool                `json:"active"`
	Model            string              `json:"model"`
	Provider         string              `json:"provider"`
	Roles            map[string]string   `json:"roles"`
	HasAPIKey        bool                `json:"hasApiKey"`
	HasBaseURL       bool                `json:"hasBaseUrl"`
	ModelName        string              `json:"modelName"`
	ProviderName     string              `json:"providerName"`
	ContextWindow    int                 `json:"contextWindow"`
	DefaultMaxTokens int                 `json:"defaultMaxTokens"`
	Capabilities     runtimeCapabilities `json:"capabilities"`
}

type runtimeProfilesResponse struct {
	Type          string                             `json:"type"`
	Version       int                                `json:"version"`
	ActiveProfile string                             `json:"activeProfile"`
	Profiles      []runtimeProfile                   `json:"profiles"`
	Tombstones    map[string]runtimeProfileTombstone `json:"tombstones"`
}

type transcriptLine struct {
	kind string
	text string
}

type runtimeConfigMsg struct {
	config runtimeConfig
	err    error
}

type runtimeProfilesMsg struct {
	response runtimeProfilesResponse
	err      error
}

type profileSelectMsg struct {
	profile string
	config  runtimeConfig
	err     error
}

// pollTickMsg fires when the background /v1/runtime/config poll is
// due. The handler should call fetchRuntimeConfig with `?since=`
// when m.configVersion > 0.
type pollTickMsg struct{}

// inputMode is the §5 / Phase 3 single-input-owner state machine.
// Only one mode is active at a time; transitions are explicit and
// always round-trip back to modeComposing when an overlay closes.
type inputMode string

const (
	modeComposing   inputMode = "composing"   // textinput owns keys
	modePermission  inputMode = "permission"  // a/y/r/n/esc only
	modeSlashPick   inputMode = "slashPick"   // one-shot slash palette (no live filter yet)
	modeHelpOverlay inputMode = "helpOverlay" // read-only help; up/down/esc/enter
)

func (m inputMode) canEditInput() bool { return m == modeComposing }

type model struct {
	cfg            config
	input          textinput.Model
	viewport       viewport.Model
	spinner        spinner.Model
	transcript     []transcriptLine
	inputMode      inputMode
	helpScroll     int
	running        bool
	events         <-chan streamEvent
	decisions      chan<- permissionDecision
	pending        *pendingPermission
	lastEventType  string
	sessionID      string
	modelID        string
	providerID     string
	activeProfile  string
	configVersion  int
	profileCount   int
	tombstoneCount int
	paletteFilter  string
	paletteSelected int
	startedAt      time.Time
	width          int
	height         int
}

func (m *model) setMode(next inputMode) {
	if m.inputMode == next {
		return
	}
	m.inputMode = next
}

// slashCommand describes a single Phase 4 slash-palette entry. A command
// either has zero args (run immediately when the user presses Enter in
// the palette) or has args (insert the prefix and return to composing
// so the user can type the rest of the command). The palette never
// pre-empts the textinput when a command needs an argument.
type slashCommand struct {
	name    string
	aliases []string
	summary string
	hasArgs bool
	argHint string
	prefix  string // when non-empty, the palette inserts this string into the textinput and returns to composing
	run     func(m *model, args []string) tea.Cmd
}

// toolDescriptor is the read-only row the /tools palette renders. The
// fields map 1:1 to /v1/tools/audit entries; the static defaults
// below will be replaced by HTTP-fetched data in Phase 7.
type toolDescriptor struct {
	name     string
	risk     string
	source   string
	approval bool
	summary  string
}

// slashCommands is the static Phase 4 registry. Real backend calls
// (profile select, config refresh) go through Nexus HTTP; placeholder
// commands surface a status line so the user knows the entry exists
// but is not yet wired.
var slashCommands = []slashCommand{
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
				"/context", "/compact", "/inbox", "/models", "/tools",
				"/sessions", "/agents", "/bash", "/read", "/grep", "/glob",
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
			m.appendLine("status", "selecting shared Nexus profile: "+profile)
			return selectRuntimeProfile(m.cfg, profile)
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
		name:    "/exit",
		aliases: []string{"/quit"},
		summary: "quit the Go TUI",
		run: func(_ *model, _ []string) tea.Cmd {
			return tea.Quit
		},
	},
	{
		name:    "/context",
		summary: "show context window usage (TODO: wire to Nexus /v1/runtime/metrics)",
		run: func(m *model, _ []string) tea.Cmd {
			m.appendLine("status", "/context not yet implemented in Go TUI MVP")
			return nil
		},
	},
	{
		name:    "/compact",
		summary: "trigger context compaction (TODO: wire to Nexus compact endpoint)",
		run: func(m *model, _ []string) tea.Cmd {
			m.appendLine("status", "/compact not yet implemented in Go TUI MVP")
			return nil
		},
	},
	{
		name:    "/inbox",
		summary: "list SessionChannel inbox (TODO: wire to /v1/sessions/:id/inbox)",
		run: func(m *model, _ []string) tea.Cmd {
			m.appendLine("status", "/inbox not yet implemented in Go TUI MVP")
			return nil
		},
	},
	{
		name:    "/models",
		summary: "list models (TODO: wire to /v1/runtime/models)",
		run: func(m *model, _ []string) tea.Cmd {
			m.appendLine("status", "/models not yet implemented in Go TUI MVP")
			return nil
		},
	},
	{
		name:    "/tools",
		summary: "list tools (read-only palette; Phase 4)",
		run: func(m *model, _ []string) tea.Cmd {
			// Static catalog mirroring the Go runtime's default
			// tool registry. Phase 7 will wire this to /v1/tools/audit
			// so MCP servers and runtime-discovered tools show up
			// here too.
			tools := []toolDescriptor{
				{name: "Read", risk: "read", source: "builtin", approval: false, summary: "read a workspace file"},
				{name: "Write", risk: "write", source: "builtin", approval: true, summary: "create or overwrite a file"},
				{name: "Edit", risk: "write", source: "builtin", approval: true, summary: "edit an existing file"},
				{name: "Bash", risk: "execute", source: "builtin", approval: true, summary: "run a shell command"},
				{name: "Glob", risk: "read", source: "builtin", approval: false, summary: "expand a glob pattern"},
				{name: "Grep", risk: "read", source: "builtin", approval: false, summary: "search for a regex in workspace"},
				{name: "TaskCreate", risk: "task", source: "builtin", approval: true, summary: "create a tracked task"},
			}
			m.renderToolPalette(tools)
			return nil
		},
	},
	{
		name:    "/sessions",
		summary: "list sessions (TODO: wire to /v1/sessions)",
		run: func(m *model, _ []string) tea.Cmd {
			m.appendLine("status", "/sessions not yet implemented in Go TUI MVP")
			return nil
		},
	},
	{
		name:    "/agents",
		summary: "list agent jobs (TODO: wire to /v1/agents)",
		run: func(m *model, _ []string) tea.Cmd {
			m.appendLine("status", "/agents not yet implemented in Go TUI MVP")
			return nil
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

// filterSlashCommands narrows the registry to entries whose name or
// alias starts with the given prefix (case-insensitive). The order is
// preserved so the most "intentional" match is the first listed.
func filterSlashCommands(prefix string) []slashCommand {
	if prefix == "" {
		out := make([]slashCommand, len(slashCommands))
		copy(out, slashCommands)
		return out
	}
	needle := strings.ToLower(strings.TrimPrefix(prefix, "/"))
	out := []slashCommand{}
	for _, c := range slashCommands {
		if strings.HasPrefix(strings.ToLower(strings.TrimPrefix(c.name, "/")), needle) {
			out = append(out, c)
			continue
		}
		for _, a := range c.aliases {
			if strings.HasPrefix(strings.ToLower(strings.TrimPrefix(a, "/")), needle) {
				out = append(out, c)
				break
			}
		}
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

// printableRuneFromKey returns the leading printable rune from a
// tea.KeyMsg, or 0 if the key is a special key (Enter, Esc, arrows,
// etc.) and must NOT be appended to the palette filter.
func printableRuneFromKey(msg tea.KeyMsg) rune {
	if msg.Type == tea.KeyRunes {
		for _, r := range msg.Runes {
			if r >= 0x20 && r != 0x7f {
				return r
			}
		}
	}
	if msg.Type == tea.KeySpace {
		return ' '
	}
	return 0
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

	if cmd.prefix != "" {
		// Insert the prefix into the textinput so the user can keep
		// typing arguments.
		m.input.SetValue(cmd.prefix)
		m.input.CursorEnd()
		m.appendLine("status", "inserted prefix: "+cmd.prefix)
		return nil
	}
	if cmd.hasArgs {
		// Has-arg command with no prefix means the command takes a
		// positional arg parsed by handleLocalCommand; insert the
		// command name + space and stay in composing.
		inserted := cmd.name + " "
		m.input.SetValue(inserted)
		m.input.CursorEnd()
		m.appendLine("status", "type the argument, then press enter: "+inserted)
		return nil
	}
	// Zero-arg command: run it immediately.
	m.appendLine("user", cmd.name)
	return cmd.run(m, nil)
}

var (
	titleStyle       = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	mutedStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	statusStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("81"))
	errorStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	toolStyle        = lipgloss.NewStyle().Foreground(lipgloss.Color("39"))
	permissionStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("220")).Bold(true)
	assistantStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("15"))
	userStyle        = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	thinkingStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("141"))
	dividerStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("238"))
	footerStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	focusedLineStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("252"))
)

func main() {
	cfg := parseFlags()
	m := newModel(cfg)
	opts := []tea.ProgramOption{}
	if cfg.altScreen {
		opts = append(opts, tea.WithAltScreen())
	}
	if _, err := tea.NewProgram(m, opts...).Run(); err != nil {
		fmt.Fprintf(os.Stderr, "go-tui failed: %v\n", err)
		os.Exit(1)
	}
}

func parseFlags() config {
	cwd, _ := os.Getwd()
	cfg := config{}
	flag.StringVar(&cfg.baseURL, "url", "http://127.0.0.1:3000", "BabeL-O Nexus base URL")
	flag.StringVar(&cfg.cwd, "cwd", cwd, "workspace directory sent to Nexus")
	flag.StringVar(&cfg.sessionID, "session", "", "optional existing session id")
	flag.BoolVar(&cfg.altScreen, "alt", true, "use terminal alternate screen")
	flag.IntVar(&cfg.pollIntervalMs, "poll-interval-ms", 30000, "background /v1/runtime/config poll interval in milliseconds; 0 disables polling")
	flag.Parse()
	cfg.apiKey = os.Getenv("NEXUS_API_KEY")
	return cfg
}

func newModel(cfg config) model {
	input := textinput.New()
	input.Placeholder = "Ask BabeL-O"
	input.Focus()
	input.CharLimit = 4000
	input.Prompt = "> "
	input.Width = 80

	vp := viewport.New(80, 20)

	spin := spinner.New()
	spin.Spinner = spinner.Dot
	spin.Style = statusStyle

	return model{
		cfg:       cfg,
		input:     input,
		viewport:  vp,
		spinner:   spin,
		inputMode: modeComposing,
		transcript: []transcriptLine{
			{kind: "status", text: "Go TUI MVP connected to the Nexus stream API."},
			{kind: "status", text: "Runtime, tools, permissions and context stay owned by BabeL-O Nexus."},
		},
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(
		textinput.Blink,
		m.spinner.Tick,
		fetchRuntimeConfig(m.cfg, 0),
		fetchRuntimeProfiles(m.cfg),
		m.schedulePollTick(),
	)
}

// schedulePollTick arms the next background /v1/runtime/config
// poll, when --poll-interval-ms is non-zero. The returned cmd emits a
// pollTickMsg after the configured interval; the handler then re-arms
// itself so polling continues until the model is destroyed.
func (m model) schedulePollTick() tea.Cmd {
	if m.cfg.pollIntervalMs <= 0 {
		return nil
	}
	d := time.Duration(m.cfg.pollIntervalMs) * time.Millisecond
	return tea.Tick(d, func(time.Time) tea.Msg { return pollTickMsg{} })
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.resize()
		m.refreshViewport()
		return m, nil

	case tea.KeyMsg:
		key := msg.String()

		// `ctrl+c` is global: always quits, even from inside an overlay.
		// `q` only quits when the input box is empty AND we're not in an
		// overlay (so q inside permission / help doesn't quit by accident).
		if key == "ctrl+c" || (key == "q" && m.inputMode == modeComposing && !m.running && strings.TrimSpace(m.input.Value()) == "") {
			return m, tea.Quit
		}

		// Phase 3 single-input-owner: dispatch by current mode.
		switch m.inputMode {
		case modePermission:
			switch strings.ToLower(key) {
			case "a", "y":
				m.sendPermissionDecision(true, "Approved from Go TUI MVP")
				return m, nil
			case "r", "n", "esc":
				m.sendPermissionDecision(false, "Rejected from Go TUI MVP")
				return m, nil
			}
			// While the permission panel is up, any other key is
			// swallowed: textinput must NOT receive it, or it would
			// insert characters into the input box under the panel.
			return m, nil

		case modeHelpOverlay:
			switch key {
			case "esc", "enter", "q":
				m.appendLine("status", "help closed")
				m.setMode(modeComposing)
				return m, nil
			case "up", "k":
				if m.helpScroll > 0 {
					m.helpScroll--
				}
				return m, nil
			case "down", "j":
				m.helpScroll++
				return m, nil
			}
			return m, nil

		case modeSlashPick:
			// Phase 4 live-filter slash palette.
			switch key {
			case "esc":
				m.input.SetValue("")
				m.paletteFilter = ""
				m.paletteSelected = 0
				m.appendLine("status", "slash cancelled")
				m.setMode(modeComposing)
				return m, nil
			case "enter":
				cmd := m.runPaletteSelection()
				return m, cmd
			case "up", "ctrl+p":
				if m.paletteSelected > 0 {
					m.paletteSelected--
				}
				return m, nil
			case "down", "ctrl+n", "tab":
				matched := filterSlashCommands(m.paletteFilter)
				if m.paletteSelected < len(matched)-1 {
					m.paletteSelected++
				}
				return m, nil
			case "backspace":
				if len(m.paletteFilter) > 0 {
					m.paletteFilter = m.paletteFilter[:len(m.paletteFilter)-1]
					m.paletteSelected = 0
				} else {
					// Filter is empty: bail out of the palette entirely.
					m.input.SetValue("")
					m.setMode(modeComposing)
				}
				return m, nil
			}
			// Any printable rune is appended to the live filter. We
			// don't let the textinput itself see the key — the palette
			// is the single-input-owner.
			if r := printableRuneFromKey(msg); r != 0 {
				m.paletteFilter += string(r)
				m.paletteSelected = 0
				return m, nil
			}
			// Unrecognised key in palette mode: swallow so the textinput
			// doesn't accidentally consume it.
			return m, nil
		}

		// `?` toggles the help overlay. Only valid in composing.
		if m.inputMode == modeComposing && key == "?" && strings.TrimSpace(m.input.Value()) == "" {
			m.helpScroll = 0
			m.setMode(modeHelpOverlay)
			return m, nil
		}

		// `/` (empty input) opens the live-filter slash palette. We
		// intercept the character before the textinput can render it
		// so the palette has its own render slot.
		if m.inputMode == modeComposing && key == "/" && strings.TrimSpace(m.input.Value()) == "" {
			m.paletteFilter = ""
			m.paletteSelected = 0
			m.setMode(modeSlashPick)
			return m, nil
		}

		if key == "enter" {
			prompt := strings.TrimSpace(m.input.Value())
			if prompt == "" || m.running {
				return m, nil
			}
			m.input.SetValue("")
			if strings.HasPrefix(prompt, "/") {
				cmd := m.handleLocalCommand(prompt)
				m.setMode(modeComposing)
				return m, cmd
			}
			m.appendLine("user", prompt)
			m.running = true
			m.pending = nil
			m.lastEventType = ""
			m.startedAt = time.Now()
			return m, startStream(m.cfg, prompt)
		}

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	case streamStartedMsg:
		m.events = msg.events
		m.decisions = msg.decisions
		m.appendLine("status", "stream started")
		return m, waitForStreamEvent(msg.events)

	case streamEventMsg:
		if msg.event.err != nil {
			m.appendLine("error", msg.event.err.Error())
			m.running = false
			m.pending = nil
			return m, nil
		}
		m.consumeNexusEvent(msg.event.payload)
		if m.running {
			return m, waitForStreamEvent(m.events)
		}
		return m, nil

	case runtimeConfigMsg:
		if errors.Is(msg.err, errNotModified) {
			// Background poll saw no change; reschedule and stay quiet.
			return m, m.schedulePollTick()
		}
		if msg.err != nil {
			m.appendLine("error", msg.err.Error())
			return m, m.schedulePollTick()
		}
		// Distinguish a background poll from an initial / explicit fetch
		// by inspecting whether the version moved.
		previousVersion := m.configVersion
		m.applyRuntimeConfig(msg.config)
		if msg.config.Version > previousVersion {
			m.appendLine("status", "config updated: "+formatRuntimeConfig(msg.config))
		}
		return m, m.schedulePollTick()

	case runtimeProfilesMsg:
		if msg.err != nil {
			m.appendLine("error", msg.err.Error())
			return m, nil
		}
		m.activeProfile = msg.response.ActiveProfile
		if msg.response.Version > 0 {
			m.configVersion = msg.response.Version
		}
		m.profileCount = len(msg.response.Profiles)
		m.tombstoneCount = len(msg.response.Tombstones)
		m.appendLine("status", formatRuntimeProfiles(msg.response))
		return m, m.schedulePollTick()

	case profileSelectMsg:
		if msg.err != nil {
			m.appendLine("error", msg.err.Error())
			return m, nil
		}
		m.applyRuntimeConfig(msg.config)
		m.appendLine("status", "profile switched: "+firstNonEmpty(msg.config.ActiveProfile, msg.profile))
		return m, fetchRuntimeProfiles(m.cfg)

	case pollTickMsg:
		// Background poll. If we've never fetched a config, defer to the
		// next round rather than blocking the chat loop.
		if m.configVersion <= 0 {
			return m, m.schedulePollTick()
		}
		return m, fetchRuntimeConfig(m.cfg, m.configVersion)

	case streamClosedMsg:
		if m.running {
			m.appendLine("status", "stream closed")
		}
		m.running = false
		m.pending = nil
		return m, nil
	}

	var inputCmd tea.Cmd
	m.input, inputCmd = m.input.Update(msg)
	m.viewport, _ = m.viewport.Update(msg)
	return m, inputCmd
}

func (m *model) resize() {
	width := max(40, m.width)
	headerHeight := 3
	permissionHeight := 0
	if m.pending != nil {
		permissionHeight = 3
	}
	inputHeight := 3
	footerHeight := 2
	m.input.Width = max(20, width-4)
	m.viewport.Width = width
	m.viewport.Height = max(6, m.height-headerHeight-permissionHeight-inputHeight-footerHeight)
}

func (m model) View() string {
	width := max(40, m.width)
	header := m.renderHeader(width)
	transcript := m.viewport.View()
	permission := m.renderPermission(width)
	input := m.renderInput(width)
	footer := m.renderFooter(width)
	help := m.renderHelp(width)
	palette := m.renderSlashPalette(width)

	parts := []string{header, transcript}
	if permission != "" {
		parts = append(parts, permission)
	}
	if help != "" {
		parts = append(parts, help)
	}
	if palette != "" {
		parts = append(parts, palette)
	}
	parts = append(parts, input, footer)
	return strings.Join(parts, "\n")
}

var helpOverlayLines = []string{
	"BabeL-O Go TUI · Local key reference",
	"",
	"Composing:",
	"  enter            submit the current prompt",
	"  /                (followed by command) open slash palette (one-shot)",
	"  ?  (empty input) toggle this help overlay",
	"  ctrl+c / q       quit when input is empty",
	"",
	"Permission panel:",
	"  a / y            approve",
	"  r / n / esc      reject",
	"  (other keys)     swallowed; textinput never sees them",
	"",
	"Help overlay:",
	"  up / k           scroll up",
	"  down / j         scroll down",
	"  esc / enter / q  close overlay and return to composing",
	"",
	"Local slash commands (run after the leading / and enter):",
	"  /config          refresh shared Nexus config + profile state",
	"  /profile [name]  list profiles, or select a profile",
	"",
	"Press esc / enter / q to close.",
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

func (m model) renderHelp(width int) string {
	if m.inputMode != modeHelpOverlay {
		return ""
	}
	header := titleStyle.Render("Help · Phase 3 overlay")
	lines := []string{header, divider(width)}
	// Clamp helpScroll so the user can't scroll past the end.
	visibleRows := max(0, m.height-12)
	maxScroll := max(0, len(helpOverlayLines)-visibleRows)
	if m.helpScroll > maxScroll {
		// Don't mutate model in a View path; clamp locally for the
		// rendered slice. The next key event will reconcile m.helpScroll.
		clamped := maxScroll
		end := clamped + visibleRows
		if end > len(helpOverlayLines) {
			end = len(helpOverlayLines)
		}
		lines = append(lines, helpOverlayLines[clamped:end]...)
	} else {
		end := m.helpScroll + visibleRows
		if end > len(helpOverlayLines) {
			end = len(helpOverlayLines)
		}
		lines = append(lines, helpOverlayLines[m.helpScroll:end]...)
	}
	return strings.Join(lines, "\n")
}

// renderSlashPalette paints the live-filter palette above the input
// line. It is a compact overlay: header (current filter), up to
// 6 candidates with the selected one highlighted, and a hint row.
func (m model) renderSlashPalette(width int) string {
	if m.inputMode != modeSlashPick {
		return ""
	}
	matched := filterSlashCommands(m.paletteFilter)
	visible := 6
	if len(matched) < visible {
		visible = len(matched)
	}
	header := titleStyle.Render("Slash · " + "/" + m.paletteFilter)
	lines := []string{header, divider(width)}
	if visible == 0 {
		lines = append(lines, mutedStyle.Render("  (no commands match)"))
	} else {
		// Clamp selection to a valid range in case the filter shrank.
		idx := m.paletteSelected
		if idx < 0 || idx >= visible {
			idx = 0
		}
		for i := 0; i < visible; i++ {
			c := matched[i]
			marker := "  "
			if i == idx {
				marker = "> "
			}
			hint := c.argHint
			if c.prefix != "" {
				hint = "→ inserts " + c.prefix
			} else if c.hasArgs {
				hint = "→ enter arg: " + c.argHint
			} else {
				hint = "→ run"
			}
			line := fmt.Sprintf("%s%s    %s    %s", marker, c.name, hint, mutedStyle.Render(c.summary))
			if i == idx {
				line = focusedLineStyle.Render(line)
			}
			lines = append(lines, line)
		}
	}
	lines = append(lines, mutedStyle.Render("↑↓/Tab navigate · Enter select · Esc cancel"))
	return strings.Join(lines, "\n")
}

func (m model) renderHeader(width int) string {
	title := titleStyle.Render("BabeL-O Go TUI MVP")
	state := "idle"
	if m.running {
		state = m.spinner.View() + " running"
	}
	if m.pending != nil {
		state = "permission pending"
	}

	session := "new session"
	if m.sessionID != "" {
		session = shortID(m.sessionID)
	}
	model := m.modelID
	if model == "" {
		model = "model pending"
	}
	profile := firstNonEmpty(m.activeProfile, "none")
	top := joinColumns(width, title, statusStyle.Render(state))
	meta := fmt.Sprintf("url=%s  cwd=%s  session=%s  model=%s  profile=%s", m.cfg.baseURL, m.cfg.cwd, session, model, profile)
	if m.configVersion > 0 || m.profileCount > 0 || m.tombstoneCount > 0 {
		meta += fmt.Sprintf("  config=v%d profiles=%d tombstones=%d", m.configVersion, m.profileCount, m.tombstoneCount)
	}
	return strings.Join([]string{
		top,
		mutedStyle.Render(truncatePlain(meta, width)),
		divider(width),
	}, "\n")
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

func (m *model) applyRuntimeConfig(config runtimeConfig) {
	if config.ModelID != "" {
		m.modelID = config.ModelID
	}
	m.providerID = config.ProviderID
	m.activeProfile = config.ActiveProfile
	if config.Version > 0 {
		m.configVersion = config.Version
	}
	m.tombstoneCount = len(config.Tombstones)
}

func (m model) renderPermission(width int) string {
	if m.pending == nil {
		return ""
	}
	header := fmt.Sprintf(
		"Permission: %s (%s risk)  a/y approve  r/n/esc reject",
		firstNonEmpty(m.pending.name, "tool"),
		firstNonEmpty(m.pending.risk, "unknown"),
	)
	parts := []string{header}
	if input := strings.TrimSpace(m.pending.input); input != "" {
		parts = append(parts, "  input: "+input)
	}
	if msg := strings.TrimSpace(m.pending.message); msg != "" {
		parts = append(parts, "  reason: "+msg)
	}
	joined := strings.Join(parts, "\n")
	return strings.Join([]string{
		divider(width),
		permissionStyle.Render(wrapPlain(joined, max(0, width-2))),
	}, "\n")
}

func (m model) renderInput(width int) string {
	prompt := m.input.View()
	if m.running {
		prompt = focusedLineStyle.Render(prompt)
	}
	return strings.Join([]string{
		divider(width),
		prompt,
	}, "\n")
}

func (m model) renderFooter(width int) string {
	hint := "enter submit"
	if m.running {
		hint = "waiting for Nexus events"
	}
	if m.pending != nil {
		hint = "permission decision required"
	}
	elapsed := ""
	if !m.startedAt.IsZero() && m.running {
		elapsed = fmt.Sprintf("  elapsed=%s", time.Since(m.startedAt).Round(time.Second))
	}
	return footerStyle.Render(truncatePlain(fmt.Sprintf("%s%s  ctrl+c quit  q quit when idle", hint, elapsed), width))
}

func (m *model) sendPermissionDecision(approved bool, reason string) {
	if m.pending == nil || m.decisions == nil {
		return
	}
	decision := permissionDecision{
		sessionID: m.pending.sessionID,
		toolUseID: m.pending.toolUseID,
		approved:  approved,
		reason:    reason,
	}
	select {
	case m.decisions <- decision:
		if approved {
			m.appendLine("permission", "approved")
		} else {
			m.appendLine("permission", "rejected")
		}
	default:
		m.appendLine("error", "permission decision queue is full")
	}
	m.pending = nil
	m.resize()
	// Phase 3: clear the permission input mode so the textinput
	// resumes ownership of subsequent keys.
	m.setMode(modeComposing)
}

func (m *model) consumeNexusEvent(event map[string]any) {
	eventType := stringField(event, "type")
	switch eventType {
	case "session_started":
		m.sessionID = stringField(event, "sessionId")
		m.modelID = stringField(event, "model")
		m.appendLine("session", formatNexusEvent(event))
	case "permission_request":
		m.pending = &pendingPermission{
			sessionID: stringField(event, "sessionId"),
			toolUseID: stringField(event, "toolUseId"),
			name:      stringField(event, "name"),
			risk:      stringField(event, "risk"),
			input:     formatToolInput(stringField(event, "name"), event["input"]),
			message:   stringField(event, "message"),
		}
		m.resize()
		m.appendLine("permission", formatNexusEvent(event))
		// Phase 3: enter the dedicated input mode so the textinput
		// stops receiving keys while the panel is up.
		m.setMode(modePermission)
	case "result", "error":
		m.appendLine(eventType, formatNexusEvent(event))
		m.running = false
		m.pending = nil
		m.resize()
	case "assistant_delta":
		m.appendStreamingLine("assistant", stringField(event, "text"))
	case "thinking_delta":
		m.appendStreamingLine("thinking", stringField(event, "text"))
	case "tool_started", "tool_completed", "tool_denied", "permission_response", "context_warning", "context_blocking", "usage", "hook_started", "hook_completed", "hook_failed":
		m.appendLine(eventType, formatNexusEvent(event))
	default:
		m.appendLine(eventType, formatNexusEvent(event))
	}
	m.lastEventType = eventType
}

func (m *model) appendStreamingLine(kind string, text string) {
	if text == "" {
		return
	}
	if m.lastEventType == kind+"_delta" && len(m.transcript) > 0 {
		last := &m.transcript[len(m.transcript)-1]
		if last.kind == kind {
			last.text += text
			m.refreshViewport()
			return
		}
	}
	m.appendLine(kind, text)
}

func (m *model) appendLine(kind string, text string) {
	m.transcript = append(m.transcript, transcriptLine{kind: kind, text: text})
	m.refreshViewport()
}

func (m *model) refreshViewport() {
	m.viewport.SetContent(renderTranscript(m.transcript, max(40, m.viewport.Width)))
	m.viewport.GotoBottom()
}

func renderTranscript(lines []transcriptLine, width int) string {
	if len(lines) == 0 {
		return mutedStyle.Render("No messages yet.")
	}
	rendered := make([]string, 0, len(lines))
	for _, line := range lines {
		rendered = append(rendered, formatLine(line.kind, line.text, width))
	}
	return strings.Join(rendered, "\n")
}

func formatLine(kind string, text string, width int) string {
	label, style := linePresentation(kind)
	prefix := style.Render(label)
	bodyWidth := max(10, width-lipgloss.Width(label)-1)
	body := wrapPlain(text, bodyWidth)
	bodyLines := strings.Split(body, "\n")
	if len(bodyLines) == 0 {
		bodyLines = []string{""}
	}

	out := make([]string, 0, len(bodyLines))
	out = append(out, prefix+" "+style.Render(bodyLines[0]))
	indent := strings.Repeat(" ", lipgloss.Width(label)+1)
	for _, continuation := range bodyLines[1:] {
		out = append(out, indent+style.Render(continuation))
	}
	return strings.Join(out, "\n")
}

func linePresentation(kind string) (string, lipgloss.Style) {
	switch kind {
	case "assistant":
		return "assistant", assistantStyle
	case "thinking":
		return "thinking ", thinkingStyle
	case "tool_started":
		return "tool >   ", toolStyle
	case "tool_completed":
		return "tool ok  ", toolStyle
	case "tool_denied":
		return "tool no  ", toolStyle
	case "hook_started":
		return "hook >   ", mutedStyle
	case "hook_completed":
		return "hook ok  ", mutedStyle
	case "hook_failed":
		return "hook no  ", errorStyle
	case "task_created":
		return "task +   ", toolStyle
	case "task_session_event":
		return "task     ", toolStyle
	case "agent_job_event":
		return "agent    ", toolStyle
	case "user_message":
		return "you      ", userStyle
	case "user_intake_guidance":
		return "intake   ", mutedStyle
	case "compact_boundary":
		return "compact+ ", statusStyle
	case "compact_failure":
		return "compact! ", errorStyle
	case "context_warning":
		return "ctx warn ", statusStyle
	case "context_blocking":
		return "ctx stop ", errorStyle
	case "session_memory_updated":
		return "memory   ", mutedStyle
	case "execution_metrics":
		return "metrics  ", mutedStyle
	case "permission", "permission_request", "permission_response":
		return "permit   ", permissionStyle
	case "error":
		return "error    ", errorStyle
	case "user":
		return "you      ", userStyle
	case "result":
		return "done     ", statusStyle
	case "session":
		return "session  ", mutedStyle
	case "status":
		return "status   ", mutedStyle
	default:
		if kind == "" {
			return "event    ", mutedStyle
		}
		return padRight(kind, 8), mutedStyle
	}
}

func formatNexusEvent(event map[string]any) string {
	eventType := stringField(event, "type")
	switch eventType {
	case "session_started":
		return fmt.Sprintf("session %s model %s", shortID(stringField(event, "sessionId")), stringField(event, "model"))
	case "thinking_delta":
		return stringField(event, "text")
	case "tool_started":
		return fmt.Sprintf("%s running %s", stringField(event, "name"), compactJSON(event["input"]))
	case "tool_completed":
		return strings.TrimSpace(fmt.Sprintf(
			"%s done success=%v %s",
			stringField(event, "name"),
			event["success"],
			summarizeToolOutput(event["output"]),
		))
	case "tool_denied":
		return fmt.Sprintf("%s denied %s", stringField(event, "name"), stringField(event, "reason"))
	case "permission_request":
		return fmt.Sprintf("%s (%s risk)", stringField(event, "name"), stringField(event, "risk"))
	case "permission_response":
		return fmt.Sprintf("approved=%v reason=%s", event["approved"], stringField(event, "reason"))
	case "context_warning", "context_blocking":
		return fmt.Sprintf("%s tokens=%v max=%v", eventType, event["tokenEstimate"], event["maxTokens"])
	case "usage":
		return fmt.Sprintf("input=%v output=%v cacheRead=%v", event["inputTokens"], event["outputTokens"], event["cacheReadInputTokens"])
	case "hook_started":
		return fmt.Sprintf("%s %s%s started", stringField(event, "hookName"), stringField(event, "hookEvent"), formatOptionalToolName(event))
	case "hook_completed":
		return strings.TrimSpace(fmt.Sprintf(
			"%s %s%s %s",
			stringField(event, "hookName"),
			stringField(event, "hookEvent"),
			formatOptionalToolName(event),
			summarizeHookOutput(event["output"]),
		))
	case "hook_failed":
		return fmt.Sprintf("%s %s%s failed: %s", stringField(event, "hookName"), stringField(event, "hookEvent"), formatOptionalToolName(event), stringField(event, "message"))
	case "user_message":
		return truncatePlain(singleLine(stringField(event, "text")), 200)
	case "user_intake_guidance":
		return fmt.Sprintf("intent=%s requiresTools=%v reason=%s", stringField(event, "intent"), event["requiresTools"], stringField(event, "reason"))
	case "task_created":
		return fmt.Sprintf("id=%s title=%s", shortID(stringField(event, "taskId")), stringField(event, "title"))
	case "task_session_event":
		return fmt.Sprintf("eventType=%s phase=%s%s", stringField(event, "eventType"), stringField(event, "phase"), summarizeTaskSessionPayload(event["payload"]))
	case "agent_job_event":
		return fmt.Sprintf("eventType=%s jobId=%s status=%s agentType=%s", stringField(event, "eventType"), shortID(stringField(event, "jobId")), stringField(event, "status"), stringField(event, "agentType"))
	case "compact_boundary":
		return fmt.Sprintf("trigger=%s before=%d after=%d summary=%dchars snipped=%d", stringField(event, "trigger"), anyInt(event["beforeEventCount"]), anyInt(event["afterEventCount"]), anyInt(event["summaryChars"]), anyInt(event["snippedToolResults"]))
	case "compact_failure":
		return fmt.Sprintf("trigger=%s failures=%d/%d: %s", stringField(event, "trigger"), anyInt(event["failureCount"]), anyInt(event["maxFailures"]), stringField(event, "message"))
	case "session_memory_updated":
		return fmt.Sprintf("trigger=%s reason=%s chars=%d events=%d", stringField(event, "trigger"), firstNonEmpty(stringField(event, "reason"), "n/a"), anyInt(event["summaryChars"]), anyInt(event["eventCount"]))
	case "execution_metrics":
		return fmt.Sprintf("dur=%dms input=%d output=%d tools=%d firstToken=%dms", anyInt(event["executeDurationMs"]), anyInt(event["inputTokens"]), anyInt(event["outputTokens"]), anyInt(event["toolCallCount"]), anyInt(event["providerFirstTokenMs"]))
	case "result":
		return fmt.Sprintf("success=%v %s", event["success"], firstNonEmpty(stringField(event, "message"), stringField(event, "text")))
	case "error":
		return strings.TrimSpace(fmt.Sprintf("%s %s", stringField(event, "code"), stringField(event, "message")))
	default:
		return compactJSON(event)
	}
}

func formatOptionalToolName(event map[string]any) string {
	toolName := stringField(event, "toolName")
	if toolName == "" {
		return ""
	}
	return " " + toolName
}

func summarizeToolOutput(value any) string {
	if value == nil {
		return ""
	}
	if output, ok := value.(map[string]any); ok {
		parts := []string{}
		stdout := strings.TrimSpace(stringAnyField(output, "stdout"))
		stderr := strings.TrimSpace(stringAnyField(output, "stderr"))
		exitCode := output["exitCode"]
		if stdout != "" {
			parts = append(parts, `stdout="`+truncatePlain(singleLine(stdout), 80)+`"`)
		}
		if stderr != "" {
			parts = append(parts, `stderr="`+truncatePlain(singleLine(stderr), 80)+`"`)
		}
		if exitCode != nil {
			parts = append(parts, fmt.Sprintf("exitCode=%v", exitCode))
		}
		if len(parts) > 0 {
			return strings.Join(parts, " ")
		}
	}
	return compactJSON(value)
}

func summarizeHookOutput(value any) string {
	if value == nil {
		return ""
	}
	if output, ok := value.(map[string]any); ok {
		parts := []string{}
		if summary := strings.TrimSpace(stringAnyField(output, "summary")); summary != "" {
			parts = append(parts, truncatePlain(singleLine(summary), 100))
		}
		if decision, ok := output["permissionDecision"]; ok {
			parts = append(parts, fmt.Sprintf("decision=%v", decision))
		}
		if updatedInput, ok := output["updatedInput"]; ok {
			parts = append(parts, "updatedInput="+compactJSON(updatedInput))
		}
		if len(parts) > 0 {
			return strings.Join(parts, " ")
		}
	}
	return compactJSON(value)
}

func stringAnyField(value map[string]any, key string) string {
	raw, ok := value[key]
	if !ok || raw == nil {
		return ""
	}
	if text, ok := raw.(string); ok {
		return text
	}
	return fmt.Sprint(raw)
}

func singleLine(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func anyInt(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int32:
		return int(typed)
	case int64:
		return int(typed)
	case float32:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	default:
		return 0
	}
}

func summarizeTaskSessionPayload(payload any) string {
	if payload == nil {
		return ""
	}
	m, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	parts := []string{}
	if sub := stringAnyField(m, "subagent"); sub != "" {
		parts = append(parts, "subagent="+sub)
	}
	if subId := stringAnyField(m, "subSessionId"); subId != "" {
		parts = append(parts, "subSessionId="+shortID(subId))
	}
	if parent := stringAnyField(m, "parentTaskId"); parent != "" {
		parts = append(parts, "parentTaskId="+parent)
	}
	if depth := m["depth"]; depth != nil {
		parts = append(parts, fmt.Sprintf("depth=%d", anyInt(depth)))
	}
	if status := stringAnyField(m, "status"); status != "" {
		parts = append(parts, "status="+status)
	}
	if len(parts) == 0 {
		return ""
	}
	return " " + strings.Join(parts, " ")
}

// formatToolInput returns a one-line preview of the most relevant
// field for a permission_request payload. The TUI needs this so the
// user can see what they are about to approve.
func formatToolInput(name string, input any) string {
	if input == nil {
		return ""
	}
	m, ok := input.(map[string]any)
	if !ok {
		return singleLine(truncatePlain(fmt.Sprintf("%v", input), 120))
	}
	switch name {
	case "Bash":
		if cmd := stringAnyField(m, "command"); cmd != "" {
			return singleLine(truncatePlain(cmd, 120))
		}
	case "Read", "Write", "Edit":
		if path := stringAnyField(m, "path"); path != "" {
			return path
		}
	case "Grep":
		if pattern := stringAnyField(m, "pattern"); pattern != "" {
			return "pattern=" + pattern
		}
	case "Glob":
		if pattern := stringAnyField(m, "pattern"); pattern != "" {
			return "pattern=" + pattern
		}
	case "ListDir":
		if path := stringAnyField(m, "path"); path != "" {
			return path
		}
	case "TaskCreate":
		if title := stringAnyField(m, "title"); title != "" {
			return "title=" + title
		}
	}
	return singleLine(truncatePlain(compactJSON(input), 120))
}

func startStream(cfg config, prompt string) tea.Cmd {
	return func() tea.Msg {
		eventCh := make(chan streamEvent, 128)
		decisionCh := make(chan permissionDecision, 8)
		go runStream(cfg, prompt, eventCh, decisionCh)
		return streamStartedMsg{events: eventCh, decisions: decisionCh}
	}
}

func waitForStreamEvent(ch <-chan streamEvent) tea.Cmd {
	return func() tea.Msg {
		if ch == nil {
			return streamClosedMsg{}
		}
		event, ok := <-ch
		if !ok {
			return streamClosedMsg{}
		}
		return streamEventMsg{event: event}
	}
}

func fetchRuntimeConfig(cfg config, since int) tea.Cmd {
	return func() tea.Msg {
		var payload runtimeConfig
		var query url.Values
		if since > 0 {
			query = url.Values{"since": {strconv.Itoa(since)}}
		}
		err := nexusJSON(cfg, http.MethodGet, "/v1/runtime/config", nil, &payload, query)
		return runtimeConfigMsg{config: payload, err: err}
	}
}

func pollTick() tea.Msg {
	return pollTickMsg{}
}

func fetchRuntimeProfiles(cfg config) tea.Cmd {
	return func() tea.Msg {
		var payload runtimeProfilesResponse
		err := nexusJSON(cfg, http.MethodGet, "/v1/runtime/config/profiles", nil, &payload)
		return runtimeProfilesMsg{response: payload, err: err}
	}
}

func selectRuntimeProfile(cfg config, profile string) tea.Cmd {
	return func() tea.Msg {
		var payload runtimeConfig
		err := nexusJSON(cfg, http.MethodPost, "/v1/runtime/config/select", map[string]string{"profile": profile}, &payload)
		return profileSelectMsg{profile: profile, config: payload, err: err}
	}
}

func nexusJSON(cfg config, method string, path string, body any, out any, query ...url.Values) error {
	endpoint, err := apiURL(cfg.baseURL, path)
	if err != nil {
		return err
	}
	if len(query) > 0 && len(query[0]) > 0 {
		endpoint = endpoint + "?" + query[0].Encode()
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cfg.apiKey != "" {
		req.Header.Set("X-Nexus-API-Key", cfg.apiKey)
	}
	client := http.Client{Timeout: 10 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	// 304 Not Modified means the server's configVersion has not moved
	// past `since`. Surface a sentinel so the caller can no-op without
	// treating it as an error.
	if res.StatusCode == http.StatusNotModified {
		return errNotModified
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("%s %s failed: %s %s", method, path, res.Status, summarizeHTTPError(data))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}

// errNotModified is returned by nexusJSON when the server replies
// 304 Not Modified; callers compare with errors.Is.
var errNotModified = fmt.Errorf("config not modified")

func apiURL(base string, path string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "http", "https":
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	default:
		return "", fmt.Errorf("unsupported Nexus URL scheme %q", parsed.Scheme)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/" + strings.TrimLeft(path, "/")
	parsed.RawQuery = ""
	return parsed.String(), nil
}

func summarizeHTTPError(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return truncatePlain(singleLine(string(data)), 200)
	}
	code := stringField(payload, "error")
	if hint, ok := friendlyNexusError(code, payload); ok {
		return hint
	}
	return truncatePlain(singleLine(firstNonEmpty(stringField(payload, "message"), code, compactJSON(payload))), 200)
}

// friendlyNexusError maps known §5 path C error codes to human
// hints. Returns ok=false when the code is not in the friendly set.
func friendlyNexusError(code string, payload map[string]any) (string, bool) {
	switch code {
	case "tombstoned_profile":
		profile := stringField(payload, "profile")
		return fmt.Sprintf("profile %q is tombstoned; restore via `bbl config profile restore %s`", profile, profile), true
	case "unknown_profile":
		profile := stringField(payload, "profile")
		return fmt.Sprintf("unknown profile %q", profile), true
	case "not_supported":
		return "model / role / roleModel switching is not supported via HTTP; use `bbl config use <modelId>` CLI", true
	case "missing_profile":
		return "missing profile name in request body", true
	}
	return "", false
}

func formatRuntimeConfig(config runtimeConfig) string {
	auth := "auth=missing"
	if config.HasAPIKey {
		auth = "auth=configured(" + firstNonEmpty(config.APIKeySource, "unknown") + ")"
	}
	profile := firstNonEmpty(config.ActiveProfile, "none")
	prefix := "config"
	if config.Version > 0 {
		prefix = fmt.Sprintf("config v=%d", config.Version)
	}
	return fmt.Sprintf(
		"%s model=%s provider=%s profile=%s %s context=%d",
		prefix,
		firstNonEmpty(config.ModelID, "unknown"),
		firstNonEmpty(config.ProviderID, "unknown"),
		profile,
		auth,
		config.ContextWindow,
	)
}

func formatRuntimeProfiles(response runtimeProfilesResponse) string {
	prefix := "profiles"
	if response.Version > 0 {
		prefix = fmt.Sprintf("profiles v=%d", response.Version)
	}
	lines := []string{}
	if len(response.Profiles) == 0 {
		lines = append(lines, prefix+": none")
	} else {
		parts := make([]string, 0, len(response.Profiles))
		for _, profile := range response.Profiles {
			name := profile.Name
			if profile.Active {
				name = "*" + name
			}
			model := firstNonEmpty(profile.Model, "default")
			parts = append(parts, fmt.Sprintf("%s=%s", name, model))
		}
		lines = append(lines, prefix+": "+strings.Join(parts, ", "))
	}
	if len(response.Tombstones) > 0 {
		lines = append(lines, fmt.Sprintf("tombstones (%d):", len(response.Tombstones)))
		// Stable ordering by name for human-friendly output.
		names := make([]string, 0, len(response.Tombstones))
		for name := range response.Tombstones {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			t := response.Tombstones[name]
			lines = append(lines, fmt.Sprintf("  %s [tombstoned] deletedAt=%s", name, firstNonEmpty(t.DeletedAt, "?")))
		}
	}
	return strings.Join(lines, "\n")
}

func runStream(cfg config, prompt string, eventCh chan<- streamEvent, decisions <-chan permissionDecision) {
	defer close(eventCh)

	wsURL, err := streamURL(cfg.baseURL)
	if err != nil {
		eventCh <- streamEvent{err: err}
		return
	}

	headers := http.Header{}
	if cfg.apiKey != "" {
		headers.Set("X-Nexus-API-Key", cfg.apiKey)
	}

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		eventCh <- streamEvent{err: err}
		return
	}
	defer conn.Close()

	var writeMu sync.Mutex
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case decision, ok := <-decisions:
				if !ok {
					return
				}
				writeMu.Lock()
				_ = conn.WriteJSON(map[string]any{
					"type":      "permission_response",
					"sessionId": decision.sessionID,
					"toolUseId": decision.toolUseID,
					"approved":  decision.approved,
					"reason":    decision.reason,
				})
				writeMu.Unlock()
			case <-done:
				return
			}
		}
	}()

	sessionID := cfg.sessionID
	if sessionID == "" {
		sessionID = fmt.Sprintf("session_go_%d", time.Now().UnixNano())
	}

	writeMu.Lock()
	err = conn.WriteJSON(map[string]any{
		"prompt":    prompt,
		"cwd":       cfg.cwd,
		"sessionId": sessionID,
	})
	writeMu.Unlock()
	if err != nil {
		eventCh <- streamEvent{err: err}
		return
	}

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			eventCh <- streamEvent{err: err}
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(data, &payload); err != nil {
			eventCh <- streamEvent{err: fmt.Errorf("decode Nexus event: %w", err)}
			continue
		}
		eventCh <- streamEvent{payload: payload}
		eventType := stringField(payload, "type")
		if eventType == "result" || eventType == "error" {
			return
		}
	}
}

func streamURL(base string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported Nexus URL scheme %q", parsed.Scheme)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/v1/stream"
	parsed.RawQuery = ""
	return parsed.String(), nil
}

func stringField(value map[string]any, key string) string {
	raw, ok := value[key]
	if !ok || raw == nil {
		return ""
	}
	switch typed := raw.(type) {
	case string:
		return typed
	default:
		return fmt.Sprint(typed)
	}
}

func compactJSON(value any) string {
	if value == nil {
		return ""
	}
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	text := string(data)
	if len(text) > 160 {
		return text[:157] + "..."
	}
	return text
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func shortID(id string) string {
	if len(id) <= 16 {
		return id
	}
	return id[:8] + "..." + id[len(id)-6:]
}

func divider(width int) string {
	return dividerStyle.Render(strings.Repeat("-", max(0, width)))
}

func joinColumns(width int, left string, right string) string {
	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		return truncateVisible(left+" "+right, width)
	}
	return left + strings.Repeat(" ", gap) + right
}

func wrapPlain(text string, width int) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	paragraphs := strings.Split(text, "\n")
	out := make([]string, 0, len(paragraphs))
	for _, paragraph := range paragraphs {
		out = append(out, wrapParagraph(paragraph, width)...)
	}
	return strings.Join(out, "\n")
}

func wrapParagraph(text string, width int) []string {
	if text == "" {
		return []string{""}
	}
	runes := []rune(text)
	lines := make([]string, 0, len(runes)/max(1, width)+1)
	for len(runes) > width {
		cut := width
		for cut > 12 && !isBreakRune(runes[cut-1]) && !isBreakRune(runes[cut]) {
			cut--
		}
		if cut <= 12 {
			cut = width
		}
		lines = append(lines, strings.TrimSpace(string(runes[:cut])))
		runes = []rune(strings.TrimLeft(string(runes[cut:]), " \t"))
	}
	lines = append(lines, string(runes))
	return lines
}

func truncateVisible(text string, width int) string {
	if lipgloss.Width(text) <= width {
		return text
	}
	return truncatePlain(text, width)
}

func truncatePlain(text string, width int) string {
	if width <= 0 {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= width {
		return text
	}
	if width <= 3 {
		return string(runes[:width])
	}
	return string(runes[:width-3]) + "..."
}

func padRight(text string, width int) string {
	if len(text) >= width {
		return text[:width]
	}
	return text + strings.Repeat(" ", width-len(text))
}

func isBreakRune(value rune) bool {
	return value == ' ' || value == '\t' || value == '/' || value == ',' || value == ';' || value == ':'
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
