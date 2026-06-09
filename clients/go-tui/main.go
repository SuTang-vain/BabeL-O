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

// contextAnalysisMsg is the response from
// GET /v1/sessions/:sessionId/context. The Go TUI only reads the
// stable top-level diagnostic envelope (summary / status / signals /
// recommendations); the rest of the payload is opaque and stays in
// the raw json for any future richer renderer.
type contextAnalysisMsg struct {
	sessionID string
	raw       []byte
	err       error
}

// compactResultMsg is the response from
// POST /v1/sessions/:sessionId/compact. The Go TUI prints
// beforeEventCount → afterEventCount + the boundary event type /
// code, so we keep the raw bytes for any future richer renderer.
type compactResultMsg struct {
	sessionID string
	raw       []byte
	err       error
}

// sessionChannelKind mirrors the SessionChannelKind union from
// src/shared/sessionChannel.ts. The Go TUI only renders a small
// fixed set in the inbox footer / event cards; unknown values
// fall through to "unknown" so a server-side addition can't
// crash the client.
type sessionChannelKind string

const (
	channelKindDirect       sessionChannelKind = "direct"
	channelKindGroup        sessionChannelKind = "group"
	channelKindParentChild  sessionChannelKind = "parent_child"
	channelKindWorkspacePair sessionChannelKind = "workspace_pair"
	channelKindProjectBridge sessionChannelKind = "project_bridge"
)

type sessionMessageType string

const (
	messageTypeQuestion          sessionMessageType = "question"
	messageTypeAnswer            sessionMessageType = "answer"
	messageTypeFinding           sessionMessageType = "finding"
	messageTypeRequestReview     sessionMessageType = "request_review"
	messageTypeRequestValidation sessionMessageType = "request_validation"
	messageTypeHypothesis        sessionMessageType = "hypothesis"
	messageTypeDecision          sessionMessageType = "decision"
	messageTypeBlocked           sessionMessageType = "blocked"
	messageTypeMemoryCandidate   sessionMessageType = "memory_candidate"
	messageTypeHandoff           sessionMessageType = "handoff"
)

type sessionMessagePriority string

const (
	priorityLow    sessionMessagePriority = "low"
	priorityNormal sessionMessagePriority = "normal"
	priorityHigh   sessionMessagePriority = "high"
)

type sessionMessageStatus string

const (
	messageStatusQueued       sessionMessageStatus = "queued"
	messageStatusDelivered    sessionMessageStatus = "delivered"
	messageStatusAcknowledged sessionMessageStatus = "acknowledged"
	messageStatusExpired      sessionMessageStatus = "expired"
)

type sessionChannelStatus string

const (
	channelStatusOpen     sessionChannelStatus = "open"
	channelStatusClosed   sessionChannelStatus = "closed"
	channelStatusArchived sessionChannelStatus = "archived"
)

// evidenceRef mirrors the EvidenceRef in src/shared/sessionChannel.ts.
// It is rendered as a compact "type:ref (label)" list on inbox
// overlay rows and event cards.
type evidenceRef struct {
	Type  string `json:"type"`
	Ref   string `json:"ref"`
	Label string `json:"label"`
}

// sessionChannel is the read-only summary view of a SessionChannel
// used by the inbox footer and overlay. The Go TUI does not mutate
// channels; it only reads kind / participantSessionIds / status for
// display purposes.
type sessionChannel struct {
	ChannelID            string             `json:"channelId"`
	Kind                 sessionChannelKind `json:"kind"`
	ParticipantSessionIDs []string          `json:"participantSessionIds"`
	CreatedBySessionID   string             `json:"createdBySessionId"`
	CreatedAt            string             `json:"createdAt"`
	Status               sessionChannelStatus `json:"status"`
}

// sessionMessage is the read-only view of a SessionMessage used by
// the inbox overlay, footer status and key event card. Only the
// fields the Go TUI displays are surfaced as struct tags; the raw
// payload is preserved for any future richer renderer (mirroring
// the contextAnalysisMsg / compactResultMsg pattern). Metadata is
// kept as a generic map so optional governance blobs
// (memoryCandidateGovernance) survive the typed decode without
// forcing the struct to track every new server-side field.
type sessionMessage struct {
	MessageID      string                 `json:"messageId"`
	ChannelID      string                 `json:"channelId"`
	FromSessionID  string                 `json:"fromSessionId"`
	ToSessionID    string                 `json:"toSessionId"`
	Broadcast      bool                   `json:"broadcast"`
	Type           sessionMessageType     `json:"type"`
	Content        string                 `json:"content"`
	Evidence       []evidenceRef          `json:"evidence"`
	Priority       sessionMessagePriority `json:"priority"`
	CreatedAt      string                 `json:"createdAt"`
	DeliveredAt    string                 `json:"deliveredAt"`
	AcknowledgedAt string                 `json:"acknowledgedAt"`
	Status         sessionMessageStatus   `json:"status"`
	Metadata       map[string]any         `json:"metadata,omitempty"`
}

// sessionInboxResponse is the envelope for
// GET /v1/sessions/:sessionId/inbox. The Go TUI only reads the
// stable top-level fields it displays; the rest of the payload
// (and any future fields added by the server) stay in the raw json
// (see inboxMsg.raw) so schema churn upstream cannot break the
// client.
type sessionInboxResponse struct {
	Type               string            `json:"type"`
	SessionID          string            `json:"sessionId"`
	Messages           []sessionMessage  `json:"messages"`
	Limit              int               `json:"limit"`
	IncludeAcknowledged bool             `json:"includeAcknowledged"`
}

// inboxMsg is the response from
// GET /v1/sessions/:sessionId/inbox. The Go TUI decodes the
// envelope via the typed struct above; raw bytes are retained
// for the same reason contextAnalysisMsg keeps them. The trigger
// field tells the Update handler whether to open the overlay
// ("user" — fired by /inbox / /inbox all) or just refresh the
// snapshot in-place ("auto" — fired by end-of-turn auto-refresh
// in consumeNexusEvent).
type inboxMsg struct {
	sessionID         string
	raw               []byte
	envelope          sessionInboxResponse
	includeAck        bool
	trigger           string
	err               error
}

// inboxAckMsg is the response from
// POST /v1/sessions/:sessionId/inbox/:messageId/ack. The Go TUI
// does not need the full message body back — only a success
// signal — so the message field is preserved as raw bytes for
// any future audit / governance renderer.
type inboxAckMsg struct {
	sessionID string
	messageID string
	raw       []byte
	err       error
}

// agentProfileId mirrors AgentProfileId in
// src/shared/agentJob.ts. The Go TUI only renders the agentType
// string; unknown values fall through to the raw text so a
// server-side addition cannot crash the client.
type agentProfileId string

const (
	agentProfileExplore   agentProfileId = "explore"
	agentProfileReview    agentProfileId = "review"
	agentProfileTest      agentProfileId = "test"
	agentProfileImplement agentProfileId = "implement"
	agentProfileDebug     agentProfileId = "debug"
	agentProfileGeneral   agentProfileId = "general"
)

// agentJobStatus mirrors AgentJobStatus in
// src/shared/agentJob.ts. The icon helper below turns each
// status into a 1-line terminal-friendly marker.
type agentJobStatus string

const (
	agentStatusQueued            agentJobStatus = "queued"
	agentStatusRunning           agentJobStatus = "running"
	agentStatusWaitingPermission agentJobStatus = "waiting_permission"
	agentStatusCompleted         agentJobStatus = "completed"
	agentStatusFailed            agentJobStatus = "failed"
	agentStatusCancelled         agentJobStatus = "cancelled"
)

// contextForkMode mirrors ContextForkMode in
// src/shared/agentJob.ts. Rendered in the governance summary
// when non-default.
type contextForkMode string

const (
	contextForkMinimal      contextForkMode = "minimal"
	contextForkWorkingSet   contextForkMode = "working-set"
	contextForkTaskFocused  contextForkMode = "task-focused"
	contextForkFullSummary  contextForkMode = "full-summary"
	contextForkDebugReplay  contextForkMode = "debug-replay"
)

// agentIsolationMode mirrors AgentIsolationMode in
// src/shared/agentJob.ts. Rendered in the governance summary
// when non-default (worktree).
type agentIsolationMode string

const (
	isolationNone     agentIsolationMode = "none"
	isolationWorktree agentIsolationMode = "worktree"
)

// agentJobGovernance mirrors AgentJobGovernance in
// src/shared/agentJob.ts. The Go TUI uses active/max + depth
// to render a compact "active N/M · depth D/maxD" summary in
// each row.
type agentJobGovernance struct {
	MaxConcurrentAgents int    `json:"maxConcurrentAgents"`
	ActiveAgents        int    `json:"activeAgents"`
	MaxDepth            int    `json:"maxDepth"`
	Depth               int    `json:"depth"`
	MaxRuntimeMs        int    `json:"maxRuntimeMs"`
	TimeoutAt           string `json:"timeoutAt,omitempty"`
}

// agentJob is the read-only view of an AgentJob used by the
// agent status overlay. Only the fields the Go TUI displays
// are surfaced as struct tags; the raw payload is preserved
// in agentJobsMsg.raw for any future richer renderer (mirroring
// the contextAnalysisMsg / compactResultMsg / inboxMsg pattern).
type agentJob struct {
	JobID           string              `json:"jobId"`
	ParentSessionID string              `json:"parentSessionId"`
	ChildSessionID  string              `json:"childSessionId"`
	ParentTaskID    string              `json:"parentTaskId,omitempty"`
	AgentType       agentProfileId      `json:"agentType"`
	Status          agentJobStatus      `json:"status"`
	Prompt          string              `json:"prompt"`
	ContextForkMode contextForkMode     `json:"contextForkMode"`
	Isolation       agentIsolationMode  `json:"isolation"`
	CreatedAt       string              `json:"createdAt"`
	UpdatedAt       string              `json:"updatedAt"`
	StartedAt       string              `json:"startedAt,omitempty"`
	CompletedAt     string              `json:"completedAt,omitempty"`
	Governance      *agentJobGovernance `json:"governance,omitempty"`
}

// sessionAgentJobsResponse is the envelope for
// GET /v1/sessions/:sessionId/agents. The Go TUI only reads the
// stable top-level fields it displays; the rest of the payload
// stays in the raw json (see agentJobsMsg.raw) so schema churn
// upstream cannot break the client.
type sessionAgentJobsResponse struct {
	Type      string     `json:"type"`
	SessionID string     `json:"sessionId"`
	Jobs      []agentJob `json:"jobs"`
}

// agentJobsMsg is the response from
// GET /v1/sessions/:sessionId/agents. The Go TUI decodes the
// envelope via the typed struct above; raw bytes are retained
// for the same reason contextAnalysisMsg / inboxMsg keep them.
// The trigger field tells the Update handler whether to open
// the overlay ("user" — fired by /agents) or just refresh the
// snapshot in-place ("auto" — fired by end-of-turn auto-refresh
// in consumeNexusEvent).
type agentJobsMsg struct {
	sessionID string
	raw       []byte
	envelope  sessionAgentJobsResponse
	trigger   string
	err       error
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
	modeComposing      inputMode = "composing"      // textinput owns keys
	modePermission     inputMode = "permission"     // a/y/r/n/esc only
	modeSlashPick      inputMode = "slashPick"      // one-shot slash palette (no live filter yet)
	modeHelpOverlay    inputMode = "helpOverlay"    // read-only help; up/down/esc/enter
	modeProfileConfirm inputMode = "profileConfirm" // y/n/esc only; gates selectRuntimeProfile
	modeContextOverlay inputMode = "contextOverlay" // read-only context analysis; up/down/esc/enter
	modeInboxOverlay   inputMode = "inboxOverlay"   // read-only SessionChannel inbox; up/down/a/esc/enter/q
	modeAgentOverlay   inputMode = "agentOverlay"   // read-only multi-agent status; up/down/esc/enter/q
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
	pendingProfileName string
	contextOverlayLines  []string
	contextOverlayScroll int
	inboxMessages    []sessionMessage
	inboxChannels    []sessionChannel
	inboxOverlaySelected int
	inboxOverlayScroll   int
	inboxOverlayIncludeAck bool
	seenInboxCardMessageIDs map[string]struct{}
	agentJobs        []agentJob
	agentOverlayScroll int
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
		name:    "/exit",
		aliases: []string{"/quit"},
		summary: "quit the Go TUI",
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
			m.appendLine("status", "analyzing shared Nexus context: "+shortID(m.sessionID))
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
		name:    "/inbox",
		summary: "open SessionChannel inbox overlay (Phase 6)",
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
		summary: "open multi-agent status overlay (Phase 6 PR3)",
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
	confirmStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("215")).Bold(true)
	contextStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("75"))
	assistantStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("15"))
	userStyle        = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	thinkingStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("141"))
	dividerStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("238"))
	footerStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	focusedLineStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("252"))
	inboxStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("33"))
	agentStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("141"))
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
		seenInboxCardMessageIDs: map[string]struct{}{},
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

		case modeProfileConfirm:
			// Profile switch is gated: y/enter fires the HTTP call,
			// n/esc cancels. Anything else is swallowed so the
			// textinput never sees a stray key while the prompt is
			// up.
			switch strings.ToLower(key) {
			case "y", "enter":
				profile := m.pendingProfileName
				m.pendingProfileName = ""
				m.setMode(modeComposing)
				if profile == "" {
					m.appendLine("error", "no pending profile to confirm")
					return m, nil
				}
				m.appendLine("status", "selecting shared Nexus profile: "+profile)
				return m, selectRuntimeProfile(m.cfg, profile)
			case "n", "esc":
				cancelled := m.pendingProfileName
				m.pendingProfileName = ""
				m.setMode(modeComposing)
				m.appendLine("status", "profile switch cancelled: "+cancelled)
				return m, nil
			}
			return m, nil

		case modeContextOverlay:
			// Read-only context analysis overlay (Phase 5 续).
			// up/down/tab/pgdn scroll forward; up/tab/pgup scroll
			// back. esc/enter/q close and clear the lines buffer.
			switch key {
			case "esc", "enter", "q":
				m.setMode(modeComposing)
				m.contextOverlayLines = nil
				m.contextOverlayScroll = 0
				m.appendLine("status", "context closed")
				return m, nil
			case "up", "k":
				if m.contextOverlayScroll > 0 {
					m.contextOverlayScroll--
				}
				return m, nil
			case "down", "j", "tab":
				maxScroll := max(0, len(m.contextOverlayLines)-1)
				if m.contextOverlayScroll < maxScroll {
					m.contextOverlayScroll++
				}
				return m, nil
			}
			return m, nil

		case modeInboxOverlay:
			// Read-only SessionChannel inbox overlay (Phase 6 §1).
			// up/k move selection back; down/j/tab move it forward.
			// 'a' acks the selected message; 'q' / 'c' quote the
			// selected message into the textinput (Phase 6 PR2);
			// esc/enter close. The user must review the quoted
			// text in composing mode before submitting — the
			// overlay never auto-submits.
			// All other keys are swallowed so they never reach the
			// textinput (single-input-owner invariant).
			switch key {
			case "esc", "enter":
				m.setMode(modeComposing)
				m.inboxOverlayScroll = 0
				m.inboxOverlaySelected = 0
				m.appendLine("status", "inbox closed")
				return m, nil
			case "up", "k":
				if m.inboxOverlaySelected > 0 {
					m.inboxOverlaySelected--
				}
				return m, nil
			case "down", "j", "tab":
				if m.inboxOverlaySelected+1 < len(m.inboxMessages) {
					m.inboxOverlaySelected++
				}
				return m, nil
			case "a":
				return m, m.ackSelectedInboxMessage()
			case "q", "c":
				return m, m.quoteSelectedInboxMessage()
			}
			return m, nil

		case modeAgentOverlay:
			// Read-only multi-agent status overlay (Phase 6 PR3).
			// up/k scroll back; down/j/tab scroll forward;
			// esc/enter/q close. No per-row actions yet (ack /
			// cancel are CLI-only via `bbl agents cancel
			// <jobId>`; the Go TUI stays read-only for agent
			// jobs to avoid duplicating the Nexus ownership
			// surface). All other keys are swallowed so they
			// never reach the textinput.
			switch key {
			case "esc", "enter", "q":
				m.setMode(modeComposing)
				m.agentOverlayScroll = 0
				m.appendLine("status", "agent status closed")
				return m, nil
			case "up", "k":
				if m.agentOverlayScroll > 0 {
					m.agentOverlayScroll--
				}
				return m, nil
			case "down", "j", "tab":
				allLines := buildAgentOverlayLines(m.agentJobs)
				maxScroll := max(0, len(allLines)-1)
				if m.agentOverlayScroll < maxScroll {
					m.agentOverlayScroll++
				}
				return m, nil
			}
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
				// Note: do NOT m.setMode(modeComposing) here — some
				// slash commands (e.g. /profile <name>) intentionally
				// transition to modeProfileConfirm, and clobbering
				// that would skip the y/n overlay. Other commands
				// stay in composing by default (no setMode call),
				// which matches the previous behavior.
				cmd := m.handleLocalCommand(prompt)
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
		eventCmd := m.consumeNexusEvent(msg.event.payload)
		if m.running {
			return m, tea.Batch(waitForStreamEvent(m.events), eventCmd)
		}
		return m, eventCmd

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

	case contextAnalysisMsg:
		if msg.err != nil {
			m.appendLine("error", "context: "+msg.err.Error())
			return m, nil
		}
		// Push the stable top-level envelope to the transcript (so
		// it survives in the scrollback + PTY harnesses can assert
		// on it) AND open the full context overlay with the rest of
		// the diagnostics. The overlay is the primary UX; the
		// transcript line is the persistent breadcrumb.
		m.appendLine("status", formatContextAnalysis(msg.raw))
		m.contextOverlayLines = buildContextOverlayLines(msg.raw)
		m.contextOverlayScroll = 0
		m.setMode(modeContextOverlay)
		return m, nil

	case compactResultMsg:
		if msg.err != nil {
			m.appendLine("error", "compact: "+msg.err.Error())
			return m, nil
		}
		m.appendLine("status", formatCompactResult(msg.raw))
		return m, nil

	case inboxMsg:
		if msg.err != nil {
			m.appendLine("error", "inbox: "+msg.err.Error())
			return m, nil
		}
		m.inboxMessages = msg.envelope.Messages
		m.inboxChannels = nil // /v1/sessions/:id/inbox doesn't echo channels; reset.
		m.inboxOverlayIncludeAck = msg.includeAck
		// Render event cards for any new key messages first —
		// this must happen before the open-overlay path so the
		// cards land in the transcript and the overlay shows the
		// fresh snapshot. seenInboxCardMessageIDs dedupes
		// across re-renders.
		m.renderNewInboxEventCards()
		if msg.trigger == "auto" {
			// Phase 6 PR2 end-of-turn auto-refresh: update the
			// footer / overlay state silently. Do NOT open the
			// overlay — the user just finished a turn and
			// shouldn't be ambushed with a modal they didn't ask
			// for. The footer status line will reflect the new
			// count, and any new key message already pushed its
			// event card into the transcript above this point.
			return m, nil
		}
		// User-initiated /inbox: reset overlay selection / scroll
		// (the user expects a clean landing) and open the overlay.
		m.inboxOverlaySelected = 0
		m.inboxOverlayScroll = 0
		// Persist a single-line summary breadcrumb in the transcript
		// (so the user can scroll back and grep the count) AND open
		// the overlay so the full SessionChannel inbox is visible
		// without an extra keystroke. The overlay is the primary UX.
		summary := fmt.Sprintf("inbox: %d message(s) (unread-only=%v)",
			len(m.inboxMessages), !m.inboxOverlayIncludeAck)
		m.appendLine("status", summary)
		m.setMode(modeInboxOverlay)
		return m, nil

	case inboxAckMsg:
		if msg.err != nil {
			m.appendLine("error", "inbox ack: "+msg.err.Error())
			return m, nil
		}
		// Mark the message as acknowledged in the local snapshot so
		// the footer status / overlay re-render with the new count
		// without forcing a full re-fetch. The server is already
		// authoritative; this is purely a UX shortcut.
		for index, message := range m.inboxMessages {
			if message.MessageID == msg.messageID {
				m.inboxMessages[index].Status = messageStatusAcknowledged
				m.inboxMessages[index].AcknowledgedAt = "now"
				break
			}
		}
		m.appendLine("status", "inbox ack: "+msg.messageID)
		return m, nil

	case agentJobsMsg:
		if msg.err != nil {
			m.appendLine("error", "agents: "+msg.err.Error())
			return m, nil
		}
		m.agentJobs = msg.envelope.Jobs
		if msg.trigger == "auto" {
			// Phase 6 PR3 end-of-turn auto-refresh: update the
			// snapshot silently. Do NOT open the overlay — the
			// user just finished a turn and shouldn't be
			// ambushed with a modal they didn't ask for. Future
			// PRs can wire a "running sub-agent" badge to the
			// header / footer if the count of running jobs
			// changes mid-turn.
			return m, nil
		}
		// User-initiated /agents: reset scroll + push breadcrumb
		// + open the overlay.
		m.agentOverlayScroll = 0
		summary := fmt.Sprintf("agents: %d job(s)", len(m.agentJobs))
		m.appendLine("status", summary)
		m.setMode(modeAgentOverlay)
		return m, nil

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
	profileConfirm := m.renderProfileConfirm(width)
	contextOverlay := m.renderContextOverlay(width)
	inboxOverlay := m.renderInboxOverlay(width)
	agentOverlay := m.renderAgentOverlay(width)

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
	if profileConfirm != "" {
		parts = append(parts, profileConfirm)
	}
	if contextOverlay != "" {
		parts = append(parts, contextOverlay)
	}
	if inboxOverlay != "" {
		parts = append(parts, inboxOverlay)
	}
	if agentOverlay != "" {
		parts = append(parts, agentOverlay)
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
	"Profile confirm overlay:",
	"  y / enter        confirm the pending profile switch",
	"  n / esc          cancel and stay on the current profile",
	"",
	"Context overlay (Phase 5 续):",
	"  up / down / tab  scroll through the context analysis",
	"  esc / enter / q  close the overlay",
	"",
	"Inbox overlay (Phase 6 §1 + PR2):",
	"  /inbox           open SessionChannel inbox (unread-only)",
	"  /inbox all       include acknowledged messages",
	"  /inbox ack <id>  acknowledge a single message",
	"  up / down / tab  move selection through the message list",
	"  a                ack the selected message",
	"  q / c            quote the selected message into the prompt",
	"  esc / enter      close the overlay",
	"",
	"Agent status overlay (Phase 6 PR3):",
	"  /agents          open multi-agent status for the current session",
	"  up / down / tab  scroll through the agent jobs list",
	"  esc / enter / q  close the overlay",
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

// renderProfileConfirm paints the y/n confirmation overlay for a
// pending /profile <name> switch. The prompt explains what is about
// to change (current -> new profile) and lists the y/n/esc key
// reference so the user never has to guess. Like renderHelp, it
// returns "" outside the matching mode so it can be unconditionally
// spliced into the View() parts list.
func (m model) renderProfileConfirm(width int) string {
	if m.inputMode != modeProfileConfirm {
		return ""
	}
	name := firstNonEmpty(m.pendingProfileName, "<name>")
	from := m.activeProfile
	header := titleStyle.Render("Confirm profile switch")
	lines := []string{header, divider(width)}
	if from == "" {
		lines = append(lines, fmt.Sprintf("  → Switch active profile to: %s", name))
	} else {
		lines = append(lines, fmt.Sprintf("  current: %s", from))
		lines = append(lines, fmt.Sprintf("  → new:   %s", name))
	}
	lines = append(lines, "")
	lines = append(lines, "  y / enter   confirm and switch")
	lines = append(lines, "  n / esc     cancel and stay on the current profile")
	body := strings.Join(lines, "\n")
	return strings.Join([]string{divider(width), confirmStyle.Render(wrapPlain(body, max(0, width-2)))}, "\n")
}

// renderContextOverlay paints the multi-line context analysis
// (Phase 5 续). It is a read-only scrollable overlay, similar in
// shape to renderHelp: header + divider + clamped line window +
// bottom hint. Outside modeContextOverlay it returns "" so the
// View() parts list can splice it unconditionally.
func (m model) renderContextOverlay(width int) string {
	if m.inputMode != modeContextOverlay {
		return ""
	}
	if len(m.contextOverlayLines) == 0 {
		return ""
	}
	header := titleStyle.Render("Context · Phase 5 overlay")
	divider := divider(width)
	// Reserve one row for header, one for the bottom hint, and one
	// for a scroll indicator. The remaining rows are the visible
	// window of contextOverlayLines.
	reserved := 4
	visibleRows := max(0, m.height-reserved)
	if visibleRows == 0 {
		visibleRows = max(1, len(m.contextOverlayLines))
	}
	maxScroll := max(0, len(m.contextOverlayLines)-visibleRows)
	if m.contextOverlayScroll > maxScroll {
		m.contextOverlayScroll = maxScroll
	}
	start := m.contextOverlayScroll
	end := start + visibleRows
	if end > len(m.contextOverlayLines) {
		end = len(m.contextOverlayLines)
	}
	body := strings.Join(m.contextOverlayLines[start:end], "\n")
	scrollHint := fmt.Sprintf("  scroll %d/%d", start+1, len(m.contextOverlayLines))
	footerHint := "  up/down/tab scroll  esc/enter/q close"
	plain := strings.Join([]string{body, scrollHint, footerHint}, "\n")
	return strings.Join([]string{divider, contextStyle.Render(wrapPlain(plain, max(0, width-2)))}, "\n") + "\n" + header + "\n" + divider
}

// buildContextOverlayLines turns the raw /v1/sessions/:id/context
// payload into the line buffer that the contextOverlay renders. It
// pulls a stable subset of the diagnostics (sections, compact
// retention, long-term memory, scoped memory, session memory lite,
// auto compact, recovery, repeated tool inputs, working set paths)
// plus the top signals and recommendations. Unknown / missing
// fields are silently skipped so the line count stays bounded.
func buildContextOverlayLines(raw []byte) []string {
	var payload struct {
		Type         string `json:"type"`
		SessionID    string `json:"sessionId"`
		Cwd          string `json:"cwd"`
		ModelID      string `json:"modelId"`
		Budget       struct {
			MaxTokens   int `json:"maxTokens"`
			LayerBudgets struct {
				System   int `json:"system"`
				Summary  int `json:"summary"`
				History  int `json:"history"`
				Memory   int `json:"memory"`
				ReservedOutput int `json:"reservedOutput"`
			} `json:"layerBudgets"`
		} `json:"budget"`
		Window struct {
			MaxTokens     int `json:"maxTokens"`
			TokenEstimate int `json:"tokenEstimate"`
		} `json:"window"`
		Sections struct {
			SystemPromptChars     int  `json:"systemPromptChars"`
			ProjectMemoryChars    int  `json:"projectMemoryChars"`
			SessionSummaryChars   int  `json:"sessionSummaryChars"`
			ActiveSkillsChars     int  `json:"activeSkillsChars"`
			MessageCount          int  `json:"messageCount"`
			SelectedEventCount    int  `json:"selectedEventCount"`
			OmittedEventCount     int  `json:"omittedEventCount"`
			SnippedEventCount     int  `json:"snippedEventCount"`
			MicrocompactedEventCount int `json:"microcompactedEventCount"`
			MemoryTruncated       bool `json:"memoryTruncated"`
			ToolDefinitionCount   int  `json:"toolDefinitionCount"`
		} `json:"sections"`
		Compact struct {
			HasBoundary            bool   `json:"hasBoundary"`
			Trigger                string `json:"trigger"`
			SummaryChars           int    `json:"summaryChars"`
			RetainedEventCount     int    `json:"retainedEventCount"`
			RetainedSegmentValid   bool   `json:"retainedSegmentValid"`
			RetainedSegmentWarning string `json:"retainedSegmentWarning"`
			BeforeEventCount       int    `json:"beforeEventCount"`
			AfterEventCount        int    `json:"afterEventCount"`
		} `json:"compact"`
		Diagnostics struct {
			RemainingTokens   int  `json:"remainingTokens"`
			RemainingPercent  int  `json:"remainingPercent"`
			AutoCompact       struct {
				ShouldCompact    bool `json:"shouldCompact"`
				ThresholdPercent int  `json:"thresholdPercent"`
				FuseOpen         bool `json:"fuseOpen"`
				FailureCount     int  `json:"failureCount"`
				FailureLimit     int  `json:"failureLimit"`
			} `json:"autoCompact"`
			LongTermMemory struct {
				Provider      string `json:"provider"`
				Enabled       bool   `json:"enabled"`
				HitCount      int    `json:"hitCount"`
				InjectedChars int    `json:"injectedChars"`
				BudgetChars   int    `json:"budgetChars"`
				Truncated     bool   `json:"truncated"`
				Scope         string `json:"scope"`
				NamespaceID   string `json:"namespaceId"`
				SearchLatencyMs float64 `json:"searchLatencyMs"`
				Error         string `json:"error"`
			} `json:"longTermMemory"`
			ScopedMemory []struct {
				Scope        string `json:"scope"`
				Provider     string `json:"provider"`
				Enabled      bool   `json:"enabled"`
				HitCount     int    `json:"hitCount"`
				InjectedChars int   `json:"injectedChars"`
				BudgetChars  int    `json:"budgetChars"`
				Truncated    bool   `json:"truncated"`
				NamespaceID  string `json:"namespaceId"`
			} `json:"scopedMemory"`
			SessionMemoryLite struct {
				Enabled bool `json:"enabled"`
				LastUpdate struct {
					Trigger      string `json:"trigger"`
					Reason       string `json:"reason"`
					SummaryChars int    `json:"summaryChars"`
					EventCount   int    `json:"eventCount"`
				} `json:"lastUpdate"`
				NextDecision struct {
					ShouldUpdate bool   `json:"shouldUpdate"`
					Reason       string `json:"reason"`
				} `json:"nextDecision"`
				CostPolicy struct {
					SummaryMode    string `json:"summaryMode"`
					MaxSummaryChars int   `json:"maxSummaryChars"`
				} `json:"costPolicy"`
			} `json:"sessionMemoryLite"`
			CompactRetention struct {
				HasBoundary          bool   `json:"hasBoundary"`
				RetainedEventCount   int    `json:"retainedEventCount"`
				RetainedSegmentValid bool   `json:"retainedSegmentValid"`
				RetainedSegmentWarning string `json:"retainedSegmentWarning"`
				FallbackToFullHistory bool  `json:"fallbackToFullHistory"`
			} `json:"compactRetention"`
			CompactTokenDelta struct {
				HasBoundary            bool `json:"hasBoundary"`
				BeforeEventCount       int  `json:"beforeEventCount"`
				AfterEventCount        int  `json:"afterEventCount"`
				EstimatedTokensSaved   int  `json:"estimatedTokensSaved"`
			} `json:"compactTokenDelta"`
			ResumeRecovery struct {
				Active   bool   `json:"active"`
				Code     string `json:"code"`
				Message  string `json:"message"`
				Timestamp string `json:"timestamp"`
			} `json:"resumeRecovery"`
			WorkingSetPaths []struct {
				Path   string `json:"path"`
				Touches int   `json:"touches"`
			} `json:"workingSetPaths"`
			RepeatedToolInputs []struct {
				Name         string `json:"name"`
				Count        int    `json:"count"`
				InputPreview string `json:"inputPreview"`
			} `json:"repeatedToolInputs"`
			LargeToolResults []struct {
				Name        string `json:"name"`
				OutputChars int    `json:"outputChars"`
				InputPreview string `json:"inputPreview"`
			} `json:"largeToolResults"`
		} `json:"diagnostics"`
		Diagnostic struct {
			Name            string          `json:"name"`
			Status          string          `json:"status"`
			Summary         string          `json:"summary"`
			Signals         []contextSignal `json:"signals"`
			Recommendations []string        `json:"recommendations"`
		} `json:"diagnostic"`
		Recommendations []string `json:"recommendations"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return []string{fmt.Sprintf("context overlay: decode failed: %v", err)}
	}
	lines := []string{}
	// Header.
	modelPart := strings.TrimSpace(payload.ModelID)
	if modelPart == "" {
		modelPart = "default"
	}
	lines = append(lines, fmt.Sprintf("Context · %s · %s", shortID(payload.SessionID), modelPart))
	// Summary + status.
	if s := strings.TrimSpace(payload.Diagnostic.Summary); s != "" {
		lines = append(lines, "  "+s)
	}
	if status := strings.TrimSpace(payload.Diagnostic.Status); status != "" {
		lines = append(lines, fmt.Sprintf("  status: %s", status))
	}
	// Sections.
	if payload.Sections.MessageCount > 0 || payload.Sections.SelectedEventCount > 0 || payload.Sections.ToolDefinitionCount > 0 {
		lines = append(lines, "  sections:")
		lines = append(lines, fmt.Sprintf("    messages: %d (selected=%d omitted=%d snipped=%d microcompact=%d)",
			payload.Sections.MessageCount, payload.Sections.SelectedEventCount,
			payload.Sections.OmittedEventCount, payload.Sections.SnippedEventCount,
			payload.Sections.MicrocompactedEventCount))
		lines = append(lines, fmt.Sprintf("    chars: system=%s project-memory=%s session-summary=%s skills=%s",
			formatCharCount(payload.Sections.SystemPromptChars),
			formatCharCount(payload.Sections.ProjectMemoryChars),
			formatCharCount(payload.Sections.SessionSummaryChars),
			formatCharCount(payload.Sections.ActiveSkillsChars),
		))
		lines = append(lines, fmt.Sprintf("    tools visible: %d%s",
			payload.Sections.ToolDefinitionCount,
			ternary(payload.Sections.MemoryTruncated, " (memory truncated)", "")))
	}
	// Budget breakdown (only when populated).
	if lb := payload.Budget.LayerBudgets; lb.System+lb.Summary+lb.History+lb.Memory > 0 {
		lines = append(lines, "  budget layers (tokens):")
		lines = append(lines, fmt.Sprintf("    system=%d summary=%d history=%d memory=%d reserved-output=%d",
			lb.System, lb.Summary, lb.History, lb.Memory, lb.ReservedOutput))
	}
	// Compact retention + token delta.
	if payload.Diagnostics.CompactRetention.HasBoundary {
		validity := "valid"
		if !payload.Diagnostics.CompactRetention.RetainedSegmentValid {
			validity = "fallback"
		}
		warning := ""
		if w := strings.TrimSpace(payload.Diagnostics.CompactRetention.RetainedSegmentWarning); w != "" {
			warning = " · " + w
		}
		lines = append(lines, fmt.Sprintf("  compact retention: %s · events=%d%s",
			validity, payload.Diagnostics.CompactRetention.RetainedEventCount, warning))
	}
	if payload.Diagnostics.CompactTokenDelta.HasBoundary {
		lines = append(lines, fmt.Sprintf("  compact delta: events %d→%d · saved≈%d tokens",
			payload.Diagnostics.CompactTokenDelta.BeforeEventCount,
			payload.Diagnostics.CompactTokenDelta.AfterEventCount,
			payload.Diagnostics.CompactTokenDelta.EstimatedTokensSaved,
		))
	}
	// Auto compact.
	if payload.Diagnostics.AutoCompact.ShouldCompact {
		lines = append(lines, fmt.Sprintf("  auto compact: threshold reached at %d%%",
			payload.Diagnostics.AutoCompact.ThresholdPercent))
	}
	if payload.Diagnostics.AutoCompact.FuseOpen {
		lines = append(lines, fmt.Sprintf("  auto compact: fuse open after %d/%d failures",
			payload.Diagnostics.AutoCompact.FailureCount,
			payload.Diagnostics.AutoCompact.FailureLimit))
	}
	// Long-term memory.
	ltm := payload.Diagnostics.LongTermMemory
	ltmProvider := ltm.Provider
	if !ltm.Enabled || ltmProvider == "" {
		ltmProvider = "disabled"
	}
	ltmScopePart := ""
	if ltm.Scope != "" && ltm.Scope != "unknown" {
		ltmScopePart = fmt.Sprintf(" scope=%s%s", ltm.Scope,
			ternary(ltm.NamespaceID != "", " namespace="+ltm.NamespaceID, ""))
	}
	lines = append(lines, fmt.Sprintf("  long-term memory: %s%s · hits=%d injected=%s/%s",
		ltmProvider, ltmScopePart, ltm.HitCount,
		formatCharCount(ltm.InjectedChars), formatCharCount(ltm.BudgetChars)))
	if ltm.Truncated {
		lines = append(lines, "  long-term memory: truncated (budget pressure)")
	}
	if ltm.SearchLatencyMs > 0 {
		lines = append(lines, fmt.Sprintf("  long-term memory: search latency=%dms",
			int(ltm.SearchLatencyMs)))
	}
	if ltm.Error != "" {
		lines = append(lines, "  long-term memory: error="+ltm.Error)
	}
	// Scoped memory.
	for _, sm := range payload.Diagnostics.ScopedMemory {
		if sm.Scope == "unknown" {
			continue
		}
		provider := sm.Provider
		if !sm.Enabled || provider == "" {
			provider = "disabled"
		}
		lines = append(lines, fmt.Sprintf("  scoped memory: %s %s · hits=%d injected=%s/%s%s",
			sm.Scope, provider, sm.HitCount,
			formatCharCount(sm.InjectedChars), formatCharCount(sm.BudgetChars),
			ternary(sm.NamespaceID != "", " namespace="+sm.NamespaceID, "")))
	}
	// Session memory lite.
	sml := payload.Diagnostics.SessionMemoryLite
	if sml.Enabled || sml.LastUpdate.Trigger != "" {
		lastLine := "none"
		if sml.LastUpdate.Trigger != "" {
			lastLine = fmt.Sprintf("%s/%s events=%d summary=%s",
				sml.LastUpdate.Trigger,
				ternary(sml.LastUpdate.Reason == "", "unknown", sml.LastUpdate.Reason),
				sml.LastUpdate.EventCount,
				formatCharCount(sml.LastUpdate.SummaryChars))
		}
		lines = append(lines, fmt.Sprintf("  session memory lite: enabled=%v last=%s next=%s policy=%s",
			sml.Enabled, lastLine,
			ternary(sml.NextDecision.ShouldUpdate, "update", "skip")+"·"+sml.NextDecision.Reason,
			sml.CostPolicy.SummaryMode))
	}
	// Resume recovery.
	if payload.Diagnostics.ResumeRecovery.Active {
		lines = append(lines, fmt.Sprintf("  resume recovery: %s · %s",
			payload.Diagnostics.ResumeRecovery.Code,
			payload.Diagnostics.ResumeRecovery.Message))
	}
	// Working set paths.
	if len(payload.Diagnostics.WorkingSetPaths) > 0 {
		parts := []string{}
		limit := len(payload.Diagnostics.WorkingSetPaths)
		if limit > 3 {
			limit = 3
		}
		for _, entry := range payload.Diagnostics.WorkingSetPaths[:limit] {
			parts = append(parts, fmt.Sprintf("%s×%d", entry.Path, entry.Touches))
		}
		lines = append(lines, "  working set paths: "+strings.Join(parts, ", "))
	}
	// Repeated tool inputs.
	if len(payload.Diagnostics.RepeatedToolInputs) > 0 {
		limit := len(payload.Diagnostics.RepeatedToolInputs)
		if limit > 2 {
			limit = 2
		}
		for _, entry := range payload.Diagnostics.RepeatedToolInputs[:limit] {
			lines = append(lines, fmt.Sprintf("  repeated tool input: %s ×%d · %s",
				entry.Name, entry.Count, entry.InputPreview))
		}
	}
	// Large tool results.
	if len(payload.Diagnostics.LargeToolResults) > 0 {
		limit := len(payload.Diagnostics.LargeToolResults)
		if limit > 2 {
			limit = 2
		}
		for _, entry := range payload.Diagnostics.LargeToolResults[:limit] {
			lines = append(lines, fmt.Sprintf("  large tool result: %s %s · %s",
				entry.Name, formatCharCount(entry.OutputChars), entry.InputPreview))
		}
	}
	// Signals.
	if signals := payload.Diagnostic.Signals; len(signals) > 0 {
		lines = append(lines, "  signals:")
		limit := len(signals)
		if limit > 5 {
			limit = 5
		}
		for _, sig := range signals[:limit] {
			level := strings.TrimSpace(sig.Level)
			if level == "" {
				level = "info"
			}
			lines = append(lines, fmt.Sprintf("    [%s] %s %s",
				level, strings.TrimSpace(sig.Code), strings.TrimSpace(sig.Message)))
		}
		if len(signals) > 5 {
			lines = append(lines, fmt.Sprintf("    ... +%d more", len(signals)-5))
		}
	}
	// Recommendations.
	if recs := payload.Diagnostic.Recommendations; len(recs) > 0 {
		lines = append(lines, "  recommendations:")
		limit := len(recs)
		if limit > 5 {
			limit = 5
		}
		for _, rec := range recs[:limit] {
			lines = append(lines, "    - "+strings.TrimSpace(rec))
		}
		if len(recs) > 5 {
			lines = append(lines, fmt.Sprintf("    ... +%d more", len(recs)-5))
		}
	}
	return lines
}

// ternary is a small inline helper to keep the buildContextOverlayLines
// body readable when picking between two short strings.
func ternary(cond bool, whenTrue, whenFalse string) string {
	if cond {
		return whenTrue
	}
	return whenFalse
}

// isKeyInboxMessage mirrors shouldRenderInboxEventCard in
// src/cli/inboxOverlay.ts. Handoff / blocked / request_review /
// request_validation are always key; finding is only key when
// priority=high; memory_candidate is key when its governance
// decision is rejected/requires_approval or approval.status is
// required/rejected. Key messages trigger an event card in the
// main conversation flow and a "high: <type>" tag in the footer.
func isKeyInboxMessage(message sessionMessage) bool {
	switch message.Type {
	case messageTypeHandoff, messageTypeBlocked,
		messageTypeRequestReview, messageTypeRequestValidation:
		return true
	case messageTypeFinding:
		return message.Priority == priorityHigh
	case messageTypeMemoryCandidate:
		governance := asMap(message.Metadata["memoryCandidateGovernance"])
		if governance == nil {
			return false
		}
		decision := stringField(governance, "decision")
		if decision == "rejected" || decision == "requires_approval" {
			return true
		}
		approval := asMap(governance["approval"])
		approvalStatus := stringField(approval, "status")
		return approvalStatus == "required" || approvalStatus == "rejected"
	}
	return false
}

// asMap is a tiny defensive helper that returns its input as a
// generic map. It is used by inbox governance checks that need to
// reach into optional metadata fields without forcing the typed
// sessionMessage struct to grow new optional fields.
func asMap(value any) map[string]any {
	typed, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return typed
}

// formatInboxEvidence renders the evidence list as
// "type:ref (label), type:ref" — same shape as
// formatEvidenceRefs in src/cli/inboxOverlay.ts. Returns "" when
// no evidence is attached.
func formatInboxEvidence(evidence []evidenceRef) string {
	if len(evidence) == 0 {
		return ""
	}
	parts := make([]string, 0, len(evidence))
	for _, ref := range evidence {
		entry := strings.TrimSpace(ref.Type) + ":" + strings.TrimSpace(ref.Ref)
		if label := strings.TrimSpace(ref.Label); label != "" {
			entry += " (" + label + ")"
		}
		parts = append(parts, entry)
	}
	return strings.Join(parts, ", ")
}

// formatInboxGovernanceSummary renders a one-line governance
// summary for memory_candidate messages. Mirrors
// formatGovernanceSummary in src/cli/inboxOverlay.ts. Returns ""
// when the message isn't a memory_candidate or when the optional
// governance blob is missing.
func formatInboxGovernanceSummary(message sessionMessage) string {
	if message.Type != messageTypeMemoryCandidate {
		return ""
	}
	governance := asMap(message.Metadata["memoryCandidateGovernance"])
	if governance == nil {
		return ""
	}
	approval := asMap(governance["approval"])
	parts := []string{
		"decision=" + fallbackUnknown(stringField(governance, "decision")),
		"scope=" + fallbackUnknown(stringField(governance, "scope")),
		"approval=" + fallbackUnknown(stringField(approval, "status")) +
			":" + fallbackUnknown(stringField(approval, "requiredBy")),
	}
	if auto, ok := governance["autoWrite"].(bool); ok {
		parts = append(parts, fmt.Sprintf("auto_write=%v", auto))
	}
	return strings.Join(parts, " ")
}

// fallbackUnknown renders "<x>" for the in-line label when a
// missing or blank string would otherwise leave a bare "=" in the
// summary line. Mirrors the inline `?? "unknown"` behavior in
// formatGovernanceSummary in the TS TUI.
func fallbackUnknown(value string) string {
	if strings.TrimSpace(value) == "" {
		return "unknown"
	}
	return value
}

// formatInboxMessageHeaderRow renders the first row of a message
// inside the inbox overlay. It uses `›` as the selected marker
// (mirroring the TS TUI) and a ` ` pad for unselected rows so the
// column alignment is stable.
func formatInboxMessageHeaderRow(message sessionMessage, selected bool) string {
	marker := " "
	if selected {
		marker = "›"
	}
	status := strings.TrimSpace(string(message.Status))
	if message.AcknowledgedAt != "" && status == "" {
		status = "acknowledged"
	}
	if status == "" {
		status = string(messageStatusDelivered)
	}
	return fmt.Sprintf("%s %s [%s] %s", marker, message.MessageID, message.CreatedAt, status)
}

// formatInboxMessageMetaRow renders the second row of a message
// (type / priority / from / target / channel / kind). The target
// is `to=<id>` for direct sends and `broadcast=true` for fan-out.
func formatInboxMessageMetaRow(message sessionMessage, channel sessionChannel) string {
	target := "broadcast=true"
	if to := strings.TrimSpace(message.ToSessionID); to != "" {
		target = "to=" + to
	}
	channelKind := string(channel.Kind)
	if channelKind == "" {
		channelKind = string(channelKindDirect)
	}
	return fmt.Sprintf("  %s · %s · from=%s · %s · kind=%s · channel=%s",
		message.Type, message.Priority, message.FromSessionID,
		target, channelKind, message.ChannelID)
}

// formatInboxMessageContentRow renders the content line, prefixed
// with two spaces for indent. The text is left untouched — the
// overlay scrolls vertically, not horizontally, and the chat TUI
// keeps long content as a single line for grep-ability.
func formatInboxMessageContentRow(message sessionMessage) string {
	return "  " + message.Content
}

// buildInboxMessageRows returns the ordered list of row strings for
// a single message in the inbox overlay. Returns an empty slice
// for the zero-value message so callers can iterate safely.
func buildInboxMessageRows(message sessionMessage, channel sessionChannel, selected bool) []string {
	rows := []string{
		formatInboxMessageHeaderRow(message, selected),
		formatInboxMessageMetaRow(message, channel),
		formatInboxMessageContentRow(message),
	}
	if evidence := formatInboxEvidence(message.Evidence); evidence != "" {
		rows = append(rows, "  evidence: "+evidence)
	}
	if gov := formatInboxGovernanceSummary(message); gov != "" {
		rows = append(rows, "  governance: "+gov)
	}
	return rows
}

// formatInboxFooterStatus mirrors formatInboxFooterStatus in
// src/cli/inboxOverlay.ts. Renders a compact
// "linked sessions: N [...]; inbox: N unread; channels: kind1 N/kind2 M; high: <type>"
// summary used both by the persistent footer status line and the
// "summary" line at the top of the overlay. Returns "" when there
// is nothing to surface, so callers can no-op.
func formatInboxFooterStatus(sessionID string, messages []sessionMessage, channels []sessionChannel) string {
	unread := 0
	for _, message := range messages {
		if message.Status == messageStatusAcknowledged || message.AcknowledgedAt != "" {
			continue
		}
		unread++
	}
	linked := map[string]struct{}{}
	for _, channel := range channels {
		found := false
		for _, participant := range channel.ParticipantSessionIDs {
			if participant == sessionID {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		for _, participant := range channel.ParticipantSessionIDs {
			if participant == sessionID {
				continue
			}
			linked[participant] = struct{}{}
		}
	}
	if len(linked) == 0 {
		for _, message := range messages {
			if message.FromSessionID == sessionID {
				continue
			}
			linked[message.FromSessionID] = struct{}{}
		}
	}
	parts := []string{}
	if linkedSummary := formatLinkedSessionSummary(linked); linkedSummary != "" {
		parts = append(parts, linkedSummary)
	}
	if len(linked) > 0 || unread > 0 {
		parts = append(parts, fmt.Sprintf("inbox: %d unread", unread))
	}
	if kinds := summarizeChannelKinds(channels, sessionID); kinds != "" {
		parts = append(parts, "channels: "+kinds)
	}
	for _, message := range messages {
		if isKeyInboxMessage(message) {
			parts = append(parts, "high: "+string(message.Type))
			break
		}
	}
	return strings.Join(parts, " · ")
}

// formatLinkedSessionSummary renders the
// "linked sessions: N [s1, s2, s3 +X more]" segment used by
// formatInboxFooterStatus. Caps at 3 short IDs and trims with
// "+N" so the footer status stays on one line in narrow widths.
func formatLinkedSessionSummary(linked map[string]struct{}) string {
	if len(linked) == 0 {
		return ""
	}
	ids := make([]string, 0, len(linked))
	for id := range linked {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	limit := 3
	if len(ids) < limit {
		limit = len(ids)
	}
	shown := make([]string, 0, limit+1)
	for _, id := range ids[:limit] {
		shown = append(shown, shortID(id))
	}
	extra := ""
	if len(ids) > limit {
		extra = fmt.Sprintf(" +%d", len(ids)-limit)
	}
	return fmt.Sprintf("linked sessions: %d [%s%s]", len(ids), strings.Join(shown, ", "), extra)
}

// summarizeChannelKinds returns a stable
// "direct 1/group 2/parent_child 1" segment for the channels the
// current session participates in. The order is sorted by kind so
// the footer string is stable across runs (mirrors the TS
// summarizeChannelKinds helper).
func summarizeChannelKinds(channels []sessionChannel, sessionID string) string {
	counts := map[sessionChannelKind]int{}
	for _, channel := range channels {
		found := false
		for _, participant := range channel.ParticipantSessionIDs {
			if participant == sessionID {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		counts[channel.Kind]++
	}
	if len(counts) == 0 {
		return ""
	}
	keys := make([]string, 0, len(counts))
	for kind := range counts {
		keys = append(keys, string(kind))
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, kind := range keys {
		parts = append(parts, fmt.Sprintf("%s %d", kind, counts[sessionChannelKind(kind)]))
	}
	return strings.Join(parts, "/")
}

// buildInboxOverlayLines turns the inbox response into the ordered
// list of lines the inbox overlay will render. Each message
// contributes 3-5 lines (header / meta / content / optional
// evidence / optional governance); the overlay window is then
// clamped in renderInboxOverlay. Returns an empty slice for the
// "no messages" case so the caller can show a friendly placeholder.
func buildInboxOverlayLines(messages []sessionMessage, channels []sessionChannel, selected int, includeAck bool) []string {
	if len(messages) == 0 {
		placeholder := "No unread inbox messages."
		if includeAck {
			placeholder = "No inbox messages."
		}
		return []string{placeholder}
	}
	channelByID := make(map[string]sessionChannel, len(channels))
	for _, channel := range channels {
		channelByID[channel.ChannelID] = channel
	}
	lines := []string{}
	for index, message := range messages {
		channel := channelByID[message.ChannelID]
		isSelected := index == selected
		lines = append(lines, buildInboxMessageRows(message, channel, isSelected)...)
	}
	return lines
}

// renderInboxOverlay paints the multi-line SessionChannel inbox
// view. It is the Phase 6 §1 primary UX for the inbox slash
// command. The overlay is composed of:
//   - titleStyle header (Phase 6 banner + session id)
//   - persistent footer status summary (linked / unread / channels / high)
//   - clamped window of buildInboxOverlayLines
//   - bottom hint (selection marker, scroll, close, ack keys)
//
// Outside modeInboxOverlay it returns "" so it can be
// unconditionally spliced into the View() parts list.
func (m model) renderInboxOverlay(width int) string {
	if m.inputMode != modeInboxOverlay {
		return ""
	}
	banner := "Inbox · Phase 6 overlay"
	if m.inboxOverlayIncludeAck {
		banner = "Inbox · all · Phase 6 overlay"
	}
	header := titleStyle.Render(banner)
	summary := formatInboxFooterStatus(m.sessionID, m.inboxMessages, m.inboxChannels)
	if summary == "" {
		summary = "(no inbox summary available)"
	}
	lines := []string{header, divider(width), summary}
	visibleRows := max(1, m.height-10)
	allLines := buildInboxOverlayLines(m.inboxMessages, m.inboxChannels, m.inboxOverlaySelected, m.inboxOverlayIncludeAck)
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.inboxOverlayScroll > maxScroll {
		// View() is read-only; clamp locally for the rendered slice.
		// The next key event will reconcile m.inboxOverlayScroll.
		end := maxScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		lines = append(lines, allLines[maxScroll:end]...)
	} else {
		end := m.inboxOverlayScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		lines = append(lines, allLines[m.inboxOverlayScroll:end]...)
	}
	hint := "↑/↓/Tab move · a ack selected · esc/enter/q close"
	lines = append(lines, mutedStyle.Render(hint))
	return strings.Join([]string{divider(width), inboxStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2)))}, "\n")
}

// quoteInboxMessageContent renders a multi-line block that can be
// pre-filled into the textinput when the user chooses to quote a
// SessionChannel message into the current prompt. Mirrors
// quoteInboxMessage in src/cli/inboxOverlay.ts. The block always
// starts with the "verify evidence" guard line so the user is
// reminded not to act on the inbox context blindly. Missing
// optional fields (evidence / governance) are dropped; required
// fields fall back to "unknown" via fallbackUnknown so a
// server-side addition cannot break the rendering.
func quoteInboxMessageContent(message sessionMessage) string {
	header := fmt.Sprintf("message=%s type=%s priority=%s from=%s channel=%s",
		fallbackUnknown(message.MessageID),
		fallbackUnknown(string(message.Type)),
		fallbackUnknown(string(message.Priority)),
		fallbackUnknown(message.FromSessionID),
		fallbackUnknown(message.ChannelID),
	)
	parts := []string{
		"Use this SessionChannel inbox context only after verifying evidence:",
		header,
		"content: " + fallbackUnknown(message.Content),
	}
	if evidence := formatInboxEvidence(message.Evidence); evidence != "" {
		parts = append(parts, "evidence: "+evidence)
	}
	if gov := formatInboxGovernanceSummary(message); gov != "" {
		parts = append(parts, "memory_candidate "+gov)
	}
	return strings.Join(parts, "\n")
}

// renderInboxEventCard is the main-flow event card for a single
// key SessionChannel message. It is intentionally compact (a
// short banner + metadata + the "open inbox / ack / quote" hint)
// so the user's main transcript stays readable. Returns "" for
// non-key messages so callers can route through it unconditionally.
// formatAgentStatusIcon returns a short, terminal-friendly
// status marker (e.g. "[running]", "[done]", "[failed]"). The
// TS TUI uses Unicode icons in chalk colors, but the Go TUI
// keeps it plain text so the cooked-mode PTY harness can
// assert on the literal string without stripping ANSI codes.
// Unknown statuses fall through to the raw text so a
// server-side addition cannot crash the client.
func formatAgentStatusIcon(status agentJobStatus) string {
	switch status {
	case agentStatusQueued:
		return "[queue]"
	case agentStatusRunning:
		return "[run]"
	case agentStatusWaitingPermission:
		return "[perm]"
	case agentStatusCompleted:
		return "[done]"
	case agentStatusFailed:
		return "[fail]"
	case agentStatusCancelled:
		return "[cancel]"
	}
	return "[" + fallbackUnknown(string(status)) + "]"
}

// formatAgentGovernanceSummary returns a compact
// "active N/M · depth D/maxD" segment for the agent overlay
// row. Returns "" when no governance blob is attached so the
// row stays tight for default-nothing jobs.
func formatAgentGovernanceSummary(governance *agentJobGovernance) string {
	if governance == nil {
		return ""
	}
	parts := []string{
		fmt.Sprintf("active %d/%d", governance.ActiveAgents, governance.MaxConcurrentAgents),
	}
	if governance.MaxDepth > 0 || governance.Depth > 0 {
		parts = append(parts, fmt.Sprintf("depth %d/%d", governance.Depth, governance.MaxDepth))
	}
	return strings.Join(parts, " · ")
}

// formatAgentJobRow renders a single agent job for the agent
// status overlay. The row is two physical lines:
//   - main row: status icon + agentType + child=<shortID> +
//     optional governance summary + optional task#<id>
//   - indent row: first 80 chars of the prompt (single line,
//     indent-prefixed) for human-scannability
//
// Mirrors the TS TUI formatMultiAgentRow shape (status + source
// + agentType + depth + title + child + governance + transcript
// path) but collapses the transcriptPath line since the Go
// TUI overlay is read-only and the path is mostly useful for
// `bbl sessions` CLI invocations.
func formatAgentJobRow(job agentJob) []string {
	parts := []string{
		formatAgentStatusIcon(job.Status),
		"job",
		string(fallbackUnknown(string(job.AgentType))),
	}
	if job.Governance != nil && job.Governance.Depth > 0 {
		parts = append(parts, fmt.Sprintf("d%d", job.Governance.Depth))
	}
	main := strings.Join(parts, " ")
	if child := strings.TrimSpace(job.ChildSessionID); child != "" {
		main += "  child=" + shortID(child)
	}
	if gov := formatAgentGovernanceSummary(job.Governance); gov != "" {
		main += "  " + gov
	}
	if taskID := strings.TrimSpace(job.ParentTaskID); taskID != "" {
		main += "  task=#" + taskID
	}
	rows := []string{main}
	if prompt := singleLine(strings.TrimSpace(job.Prompt)); prompt != "" {
		rows = append(rows, "  prompt: "+truncatePlain(prompt, 100))
	}
	return rows
}

// buildAgentOverlayLines turns the agent jobs snapshot into the
// ordered list of lines the agent overlay will render. Each
// job contributes 1-2 lines (main row + optional prompt row);
// the overlay window is then clamped in renderAgentOverlay.
// Returns a single placeholder line for the empty case so the
// caller can show a friendly message.
func buildAgentOverlayLines(jobs []agentJob) []string {
	if len(jobs) == 0 {
		return []string{"No agent jobs for this session."}
	}
	lines := []string{}
	for _, job := range jobs {
		lines = append(lines, formatAgentJobRow(job)...)
	}
	return lines
}

// renderAgentOverlay paints the multi-line multi-agent status
// view. It is the Phase 6 PR3 primary UX for the /agents slash
// command. The overlay is composed of:
//   - titleStyle header (Phase 6 PR3 banner + session id)
//   - summary line (running / waiting_permission / queued /
//     failed / cancelled / completed counts)
//   - clamped window of buildAgentOverlayLines
//   - bottom hint (scroll + close keys)
//
// Outside modeAgentOverlay it returns "" so it can be
// unconditionally spliced into the View() parts list.
func (m model) renderAgentOverlay(width int) string {
	if m.inputMode != modeAgentOverlay {
		return ""
	}
	header := titleStyle.Render("Agent status · Phase 6 PR3 overlay · " + shortID(m.sessionID))
	summary := summarizeAgentJobs(m.agentJobs)
	visibleRows := max(1, m.height-10)
	allLines := buildAgentOverlayLines(m.agentJobs)
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.agentOverlayScroll > maxScroll {
		// View() is read-only; clamp locally for the rendered
		// slice. The next key event will reconcile
		// m.agentOverlayScroll.
		end := maxScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[maxScroll:end]
	} else {
		end := m.agentOverlayScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[m.agentOverlayScroll:end]
	}
	lines := []string{header, divider(width), summary}
	lines = append(lines, allLines...)
	hint := "↑/↓/Tab scroll · esc/enter/q close"
	lines = append(lines, mutedStyle.Render(hint))
	return strings.Join([]string{divider(width), agentStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2)))}, "\n")
}

// summarizeAgentJobs is the per-status count line shown at the
// top of the agent overlay. Mirrors summarizeMultiAgentRows in
// src/cli/renderEvents.ts. Returns "no agent jobs" for an
// empty snapshot so the summary line is never blank.
func summarizeAgentJobs(jobs []agentJob) string {
	counts := map[agentJobStatus]int{}
	for _, job := range jobs {
		counts[job.Status]++
	}
	statusOrder := []agentJobStatus{
		agentStatusRunning,
		agentStatusWaitingPermission,
		agentStatusQueued,
		agentStatusFailed,
		agentStatusCancelled,
		agentStatusCompleted,
	}
	parts := []string{}
	for _, status := range statusOrder {
		if count := counts[status]; count > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", status, count))
		}
	}
	if len(parts) == 0 {
		return "no agent jobs"
	}
	return strings.Join(parts, " · ")
}

func renderInboxEventCard(message sessionMessage, channel sessionChannel) string {
	if !isKeyInboxMessage(message) {
		return ""
	}
	target := "broadcast=true"
	if to := strings.TrimSpace(message.ToSessionID); to != "" {
		target = "to=" + to
	}
	channelKind := string(channel.Kind)
	if channelKind == "" {
		channelKind = string(channelKindDirect)
	}
	rows := []string{
		fmt.Sprintf("SessionChannel %s · %s · from=%s · %s",
			message.Type, message.Priority, message.FromSessionID, target),
		fmt.Sprintf("channel=%s kind=%s message=%s", message.ChannelID, channelKind, message.MessageID),
		"collaboration context only; verify evidence before acting",
	}
	if evidence := formatInboxEvidence(message.Evidence); evidence != "" {
		rows = append(rows, "evidence: "+evidence)
	}
	rows = append(rows, fmt.Sprintf("[open inbox: /inbox] [ack: /inbox ack %s] [quote: /inbox then q]", message.MessageID))
	body := strings.Join(rows, "\n")
	return strings.Join([]string{divider(80), inboxStyle.Render(wrapPlain(body, 78)), divider(80)}, "\n")
}

// renderNewInboxEventCards walks the current inbox snapshot and
// pushes a compact event card into the transcript for every key
// message that hasn't been rendered yet. Mirrors
// renderNewInboxEventCards in src/cli/commands/chat.ts. The set
// of seen message IDs is kept on the model so the next /inbox
// call (or any future refresh trigger) only surfaces fresh
// messages, not the historical ones the user already saw.
func (m *model) renderNewInboxEventCards() {
	if m.seenInboxCardMessageIDs == nil {
		m.seenInboxCardMessageIDs = map[string]struct{}{}
	}
	channelByID := map[string]sessionChannel{}
	for _, channel := range m.inboxChannels {
		channelByID[channel.ChannelID] = channel
	}
	for _, message := range m.inboxMessages {
		if _, seen := m.seenInboxCardMessageIDs[message.MessageID]; seen {
			continue
		}
		if !isKeyInboxMessage(message) {
			continue
		}
		if card := renderInboxEventCard(message, channelByID[message.ChannelID]); card != "" {
			m.appendLine("inbox", card)
		}
		m.seenInboxCardMessageIDs[message.MessageID] = struct{}{}
	}
}

// formatCharCount renders a char count in human-friendly form
// (e.g. 1234 -> "1.2k", 12 -> "12", 0 -> "0"). The chat TUI uses
// the same idea in contextView.
func formatCharCount(n int) string {
	switch {
	case n <= 0:
		return "0"
	case n < 1000:
		return fmt.Sprintf("%d", n)
	case n < 10_000:
		return fmt.Sprintf("%.1fk", float64(n)/1000.0)
	case n < 1_000_000:
		return fmt.Sprintf("%dk", n/1000)
	default:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000.0)
	}
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
	inbox := formatInboxFooterStatus(m.sessionID, m.inboxMessages, m.inboxChannels)
	if inbox != "" {
		// The footer is a single line: keep the hint short and
		// append the inbox status with a leading "  · " so the
		// user can still spot the keyboard hint at a glance.
		inbox = "  · " + inbox
	}
	return footerStyle.Render(truncatePlain(fmt.Sprintf("%s%s%s  ctrl+c quit  q quit when idle", hint, elapsed, inbox), width))
}

// fetchInboxWithSession is the gated entry point the /inbox slash
// command uses: it requires an active session, then either kicks
// off a fetch (unread-only or with acknowledged) or short-circuits
// with a friendly status line. Mirrors the "context: no active
// session yet" pattern from /context and /compact. The trigger
// field is "user" so the handler opens the overlay on response.
func (m *model) fetchInboxWithSession(includeAck bool) tea.Cmd {
	if m.sessionID == "" {
		m.appendLine("status", "inbox: no active session yet — submit a prompt first")
		return nil
	}
	scope := "unread"
	if includeAck {
		scope = "all"
	}
	m.appendLine("status", "loading shared Nexus inbox ("+scope+"): "+shortID(m.sessionID))
	return fetchInbox(m.cfg, m.sessionID, includeAck, "user")
}

// ackInboxMessageWithSession is the gated entry point the /inbox
// ack <messageId> sub-command uses. Like fetchInboxWithSession it
// short-circuits without an active session, then calls
// ackInboxMessage to issue the POST.
func (m *model) ackInboxMessageWithSession(messageID string) tea.Cmd {
	if m.sessionID == "" {
		m.appendLine("status", "inbox ack: no active session yet — submit a prompt first")
		return nil
	}
	m.appendLine("status", "acking inbox message: "+messageID)
	return ackInboxMessage(m.cfg, m.sessionID, messageID)
}

// ackSelectedInboxMessage fires ackInboxMessage for the currently
// selected message in the inbox overlay. It is called from the
// modeInboxOverlay 'a' key dispatch so the user never has to type
// the message id by hand when the message is on screen.
func (m *model) ackSelectedInboxMessage() tea.Cmd {
	if m.inputMode != modeInboxOverlay {
		return nil
	}
	if m.inboxOverlaySelected < 0 || m.inboxOverlaySelected >= len(m.inboxMessages) {
		return nil
	}
	message := m.inboxMessages[m.inboxOverlaySelected]
	return ackInboxMessage(m.cfg, m.sessionID, message.MessageID)
}

// quoteSelectedInboxMessage is the Phase 6 PR2 path that
// round-trips the user from modeInboxOverlay back to
// modeComposing with a quote of the selected message prefilled
// in the textinput. The user reviews the quoted text before
// submitting; the overlay never auto-submits. Mirrors the
// `q` / `c` branch in src/cli/inboxOverlay.ts
// reduceInboxOverlayKey. The selection / scroll state is
// preserved across the round-trip so re-opening the inbox
// resumes on the same row (this is just a defensive no-op for
// now since the overlay is closed and re-opened by an explicit
// /inbox command, but the field shape mirrors Phase 6 §1).
func (m *model) quoteSelectedInboxMessage() tea.Cmd {
	if m.inputMode != modeInboxOverlay {
		return nil
	}
	if m.inboxOverlaySelected < 0 || m.inboxOverlaySelected >= len(m.inboxMessages) {
		return nil
	}
	message := m.inboxMessages[m.inboxOverlaySelected]
	quote := quoteInboxMessageContent(message)
	m.input.SetValue(quote)
	m.input.CursorEnd()
	m.setMode(modeComposing)
	m.inboxOverlayScroll = 0
	// Preserve inboxOverlaySelected so a future reopen lands on
	// the same row, matching the TS TUI "same selection" UX.
	m.appendLine("status", "quoted inbox message: "+message.MessageID+" into prompt")
	return nil
}

// fetchSessionAgentsWithSession is the gated entry point the
// /agents slash command uses: it requires an active session,
// then either kicks off a fetch or short-circuits with a
// friendly status line. Mirrors the "context: no active
// session yet" pattern from /context / /compact and the
// fetchInboxWithSession pattern from Phase 6 §1. The trigger
// field is "user" so the agentJobsMsg handler opens the
// overlay on response.
func (m *model) fetchSessionAgentsWithSession() tea.Cmd {
	if m.sessionID == "" {
		m.appendLine("status", "agents: no active session yet — submit a prompt first")
		return nil
	}
	m.appendLine("status", "loading shared Nexus agents: "+shortID(m.sessionID))
	return fetchSessionAgents(m.cfg, m.sessionID, "user")
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

// consumeNexusEvent applies a single Nexus event to the model and
// optionally returns a follow-up tea.Cmd. The Phase 6 PR2
// auto-refresh hook uses this return value to fire an inbox
// re-fetch at the end of every turn (the cmd is nil for events
// that don't need a follow-up).
func (m *model) consumeNexusEvent(event map[string]any) tea.Cmd {
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
		// Phase 6 PR2: end-of-turn auto-refresh. The Nexus may
		// have queued or accepted new SessionChannel messages
		// while the model was running, so re-pull the inbox
		// (unread-only, since we want to surface fresh key
		// messages via the event-card path). seenInboxCardMessageIDs
		// already handles de-duplication across turns. The
		// "auto" trigger tells the inboxMsg handler to refresh
		// the snapshot in place without opening the overlay.
		// Phase 6 PR3 also fires a parallel fetchSessionAgents
		// so the /agents overlay stays current across turns.
		if m.sessionID != "" {
			return tea.Batch(
				fetchInbox(m.cfg, m.sessionID, false, "auto"),
				fetchSessionAgents(m.cfg, m.sessionID, "auto"),
			)
		}
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
	return nil
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

func fetchContextAnalysis(cfg config, sessionID string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(cfg, http.MethodGet, "/v1/sessions/"+url.PathEscape(sessionID)+"/context", nil)
		return contextAnalysisMsg{sessionID: sessionID, raw: raw, err: err}
	}
}

func triggerCompact(cfg config, sessionID string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(
			cfg,
			http.MethodPost,
			"/v1/sessions/"+url.PathEscape(sessionID)+"/compact",
			map[string]string{"trigger": "manual"},
		)
		return compactResultMsg{sessionID: sessionID, raw: raw, err: err}
	}
}

// fetchInbox issues GET /v1/sessions/:sessionId/inbox and decodes
// the stable top-level envelope (type / sessionId / messages /
// limit / includeAcknowledged). The raw bytes are retained so any
// future richer renderer (or a server-side schema addition) does
// not break the existing format / overlay code. The trigger field
// ("user" / "auto") tells the Update handler whether to open the
// overlay (user /inbox command) or just refresh the snapshot in
// place (Phase 6 PR2 end-of-turn auto-refresh).
func fetchInbox(cfg config, sessionID string, includeAck bool, trigger string) tea.Cmd {
	return func() tea.Msg {
		query := url.Values{}
		if includeAck {
			query.Set("includeAcknowledged", "true")
		}
		raw, err := nexusRawJSON(
			cfg,
			http.MethodGet,
			"/v1/sessions/"+url.PathEscape(sessionID)+"/inbox",
			nil,
			query,
		)
		out := inboxMsg{sessionID: sessionID, raw: raw, includeAck: includeAck, trigger: trigger, err: err}
		if err == nil {
			if decodeErr := json.Unmarshal(raw, &out.envelope); decodeErr != nil {
				out.err = fmt.Errorf("decode inbox: %w", decodeErr)
			}
		}
		return out
	}
}

// ackInboxMessage issues POST /v1/sessions/:sessionId/inbox/:messageId/ack.
// The Go TUI does not need the full message body back — only a
// success signal — so the message field is preserved as raw bytes
// for any future audit / governance renderer.
func ackInboxMessage(cfg config, sessionID string, messageID string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(
			cfg,
			http.MethodPost,
			"/v1/sessions/"+url.PathEscape(sessionID)+"/inbox/"+url.PathEscape(messageID)+"/ack",
			map[string]any{},
		)
		return inboxAckMsg{sessionID: sessionID, messageID: messageID, raw: raw, err: err}
	}
}

// fetchSessionAgents issues GET /v1/sessions/:sessionId/agents
// and decodes the stable top-level envelope
// (type / sessionId / jobs). The raw bytes are retained so any
// future richer renderer (or a server-side schema addition)
// does not break the existing format / overlay code. The
// trigger field ("user" / "auto") tells the Update handler
// whether to open the overlay (user /agents command) or just
// refresh the snapshot in place (Phase 6 PR3 end-of-turn
// auto-refresh, paired with fetchInbox auto-refresh).
func fetchSessionAgents(cfg config, sessionID string, trigger string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(
			cfg,
			http.MethodGet,
			"/v1/sessions/"+url.PathEscape(sessionID)+"/agents",
			nil,
		)
		out := agentJobsMsg{sessionID: sessionID, raw: raw, trigger: trigger, err: err}
		if err == nil {
			if decodeErr := json.Unmarshal(raw, &out.envelope); decodeErr != nil {
				out.err = fmt.Errorf("decode agent jobs: %w", decodeErr)
			}
		}
		return out
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

// nexusRawJSON is the raw-bytes sibling of nexusJSON: same request
// shape and error semantics, but the response body is returned
// untouched so the caller can lazily decode only the fields it
// needs (and ignore schema churn on the rest of the payload).
func nexusRawJSON(cfg config, method string, path string, body any, query ...url.Values) ([]byte, error) {
	endpoint, err := apiURL(cfg.baseURL, path)
	if err != nil {
		return nil, err
	}
	if len(query) > 0 && len(query[0]) > 0 {
		endpoint = endpoint + "?" + query[0].Encode()
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return nil, err
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
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("%s %s failed: %s %s", method, path, res.Status, summarizeHTTPError(data))
	}
	return data, nil
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

// contextAnalysisDiagnostic mirrors the stable top-level envelope
// from analyzeContext. The Go TUI only renders these fields — the
// rest of the payload is opaque by design.
type contextAnalysisDiagnostic struct {
	Name            string            `json:"name"`
	Status          string            `json:"status"`
	Summary         string            `json:"summary"`
	Signals         []contextSignal   `json:"signals"`
	Recommendations []string          `json:"recommendations"`
}

type contextSignal struct {
	Level   string `json:"level"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// formatContextAnalysis turns the raw /v1/sessions/:id/context
// payload into a compact transcript block. The Go TUI keeps this
// small by design: full diagnostics are 200+ lines on a busy
// session, so we surface the summary + status + top 3 signals +
// top 3 recommendations and leave the rest to a future richer
// renderer (e.g. a contextOverlay).
func formatContextAnalysis(raw []byte) string {
	var top struct {
		Type           string                     `json:"type"`
		SessionID      string                     `json:"sessionId"`
		ModelID        string                     `json:"modelId"`
		Diagnostic     contextAnalysisDiagnostic  `json:"diagnostic"`
		CompactHasBnd  bool                       `json:"-"` // see below
	}
	// We decode the compact.hasBoundary separately because it lives
	// under payload.compact.hasBoundary, not at the top level.
	var compactBlock struct {
		Compact struct {
			HasBoundary bool `json:"hasBoundary"`
		} `json:"compact"`
	}
	if err := json.Unmarshal(raw, &top); err != nil {
		return fmt.Sprintf("context: decode failed: %v", err)
	}
	if err := json.Unmarshal(raw, &compactBlock); err != nil {
		return fmt.Sprintf("context: decode failed: %v", err)
	}
	lines := []string{}
	headerLabel := "context_analysis"
	if model := strings.TrimSpace(top.ModelID); model != "" {
		headerLabel = fmt.Sprintf("context_analysis model=%s", model)
	}
	lines = append(lines, headerLabel)
	if s := strings.TrimSpace(top.Diagnostic.Summary); s != "" {
		lines = append(lines, "  "+s)
	}
	if status := strings.TrimSpace(top.Diagnostic.Status); status != "" {
		lines = append(lines, fmt.Sprintf("  status: %s", status))
	}
	if compactBlock.Compact.HasBoundary {
		lines = append(lines, "  compact: boundary present (post-compact state retained)")
	}
	if signals := top.Diagnostic.Signals; len(signals) > 0 {
		lines = append(lines, "  signals:")
		limit := len(signals)
		if limit > 3 {
			limit = 3
		}
		for _, sig := range signals[:limit] {
			level := strings.TrimSpace(sig.Level)
			if level == "" {
				level = "info"
			}
			lines = append(lines, fmt.Sprintf("    [%s] %s %s",
				level, strings.TrimSpace(sig.Code), strings.TrimSpace(sig.Message)))
		}
		if len(signals) > 3 {
			lines = append(lines, fmt.Sprintf("    ... +%d more", len(signals)-3))
		}
	}
	if recs := top.Diagnostic.Recommendations; len(recs) > 0 {
		lines = append(lines, "  recommendations:")
		limit := len(recs)
		if limit > 3 {
			limit = 3
		}
		for _, rec := range recs[:limit] {
			lines = append(lines, "    - "+strings.TrimSpace(rec))
		}
		if len(recs) > 3 {
			lines = append(lines, fmt.Sprintf("    ... +%d more", len(recs)-3))
		}
	}
	return strings.Join(lines, "\n")
}

// formatCompactResult turns the raw /v1/sessions/:id/compact
// payload into a compact post-compact summary. The Go TUI keeps
// this short — the full retained segment / snipped tool results
// breakdown lives in the response payload and the chat TUI's
// contextView; we surface the most actionable numbers plus the
// boundary event metadata so the user can verify the compact
// actually fired.
func formatCompactResult(raw []byte) string {
	var payload struct {
		Type             string `json:"type"`
		BeforeEventCount int    `json:"beforeEventCount"`
		AfterEventCount  int    `json:"afterEventCount"`
		Event            struct {
			Type              string `json:"type"`
			Code              string `json:"code"`
			Trigger           string `json:"trigger"`
			Summary           string `json:"summary"`
			SummaryChars      int    `json:"summaryChars"`
			SnippedToolResults int   `json:"snippedToolResults"`
			RetainedEvents    []struct {
				Type string `json:"type"`
			} `json:"retainedEvents"`
			RetainedSegment struct {
				Status            string `json:"status"`
				RetainedEventCount int    `json:"retainedEventCount"`
				Warning           string `json:"warning"`
			} `json:"retainedSegment"`
			Budget struct {
				LayerBudgets struct {
					System  int `json:"system"`
					Summary int `json:"summary"`
					History int `json:"history"`
					Memory  int `json:"memory"`
				} `json:"layerBudgets"`
			} `json:"budget"`
		} `json:"event"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Sprintf("compact: decode failed: %v", err)
	}
	lines := []string{
		fmt.Sprintf("compact_result events: %d → %d", payload.BeforeEventCount, payload.AfterEventCount),
	}
	evt := payload.Event
	if evt.Type != "" {
		codePart := ""
		if evt.Code != "" {
			codePart = " " + evt.Code
		}
		triggerPart := ""
		if evt.Trigger != "" {
			triggerPart = " trigger=" + evt.Trigger
		}
		lines = append(lines, "  boundary: "+evt.Type+codePart+triggerPart)
	}
	if summary := strings.TrimSpace(firstLine(evt.Summary, 160)); summary != "" {
		lines = append(lines, "  summary: "+summary)
	}
	if evt.SummaryChars > 0 {
		lines = append(lines, fmt.Sprintf("  summaryChars: %d", evt.SummaryChars))
	}
	if evt.SnippedToolResults > 0 {
		lines = append(lines, fmt.Sprintf("  snippedToolResults: %d", evt.SnippedToolResults))
	}
	if lb := evt.Budget.LayerBudgets; lb.System+lb.Summary+lb.History+lb.Memory > 0 {
		lines = append(lines, fmt.Sprintf("  budget layers: system=%d summary=%d history=%d memory=%d",
			lb.System, lb.Summary, lb.History, lb.Memory))
	}
	if seg := evt.RetainedSegment; seg.Status != "" || seg.RetainedEventCount > 0 {
		warning := ""
		if w := strings.TrimSpace(seg.Warning); w != "" {
			warning = " · " + w
		}
		lines = append(lines, fmt.Sprintf("  retained segment: %s · events=%d%s",
			ternary(seg.Status == "", "n/a", seg.Status),
			seg.RetainedEventCount, warning))
	}
	return strings.Join(lines, "\n")
}

// firstLine trims a string to its first \n and bounds the length
// to maxLen (with a trailing ellipsis when truncated). Used by
// formatCompactResult to keep the summary preview to a single
// transcript line.
func firstLine(s string, maxLen int) string {
	if idx := strings.IndexAny(s, "\r\n"); idx >= 0 {
		s = s[:idx]
	}
	if maxLen > 0 && len(s) > maxLen {
		return s[:maxLen] + "…"
	}
	return s
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
