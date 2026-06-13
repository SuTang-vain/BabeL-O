package tui

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/term"
)

type Config struct {
	BaseURL          string
	Cwd              string
	SessionID        string
	APIKey           string
	AltScreen        bool
	PollIntervalMs   int
	ExecuteTimeoutMs int
	// MouseCapture enables Bubble Tea's mouse tracking so
	// wheel events arrive as MouseWheelMsg instead of being
	// translated by the terminal into ↑/↓ keys. The default
	// CLI path keeps it on and uses the in-app selection
	// renderer + clipboard toast for copying transcript text.
	MouseCapture bool
	// PolicyMode controls the per-request `policy` body field sent to
	// Nexus /v1/stream. Phase B of
	// docs/nexus/reference/go-tui-permission-policy-governance-plan.md.
	// Defaults to "soft-deny" (via buildExecuteRequest) so Go TUI users
	// can run write/execute Bash subcommands (git commit, npm install,
	// etc.) via the existing permission panel. Set to "strict" to
	// preserve the old hard-deny behaviour for a specific session.
	PolicyMode string
	// AllowTools is the comma-separated list of tool names that the
	// current turn's `allowedTools` body field should declare. Phase D
	// of docs/nexus/reference/go-tui-permission-policy-governance-plan.md.
	// When non-empty, those tools auto-execute (no `permission_request`)
	// for this turn only; the next turn re-evaluates from the body.
	// Use "*" or "all" for a wildcard that mirrors the server-startup
	// allowAllTools semantics. Default empty: per-turn override off.
	AllowTools   []string
	PrintVersion bool
}

type streamStartedMsg struct {
	events    <-chan streamEvent
	decisions chan<- permissionDecision
	cancel    chan<- struct{}
	sessionID string
}

type streamEventMsg struct {
	event streamEvent
}

type streamClosedMsg struct{}

type streamCancelMsg struct {
	sessionID string
	err       error
}

type copyToastExpiredMsg struct {
	copiedAt time.Time
}

type selectionHighlightExpiredMsg struct {
	copiedAt  time.Time
	startLine int
	startCol  int
	endLine   int
	endCol    int
}

type streamEvent struct {
	payload map[string]any
	err     error
}

type permissionDecision struct {
	sessionID string
	toolUseID string
	approved  bool
	reason    string
	// Phase A.1 of the enhanced permission panel:
	//   - scope: 'once' (default), 'session' (accumulate rule for
	//     the remaining turns), or 'rule' (Round 2 inline editor
	//     for a custom rule).
	//   - rule: the allow-rule string for scope='session'/'rule';
	//     ignored otherwise. The runtime accumulates it into the
	//     per-session rules map.
	//   - feedback: free-form text the model should act on
	//     (typically paired with approved=false for the
	//     "Reject, tell the model what to do instead" path).
	scope    string
	rule     string
	feedback string
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
	AuthMode         string                             `json:"authMode"`
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

type transcriptItem struct {
	kind       string
	text       string
	toolUseID  string
	toolName   string
	toolInput  string
	toolOutput string
	toolStatus string
	*Versioned
	baseHighlightable
	cache         renderCache
	markdownCache streamingMarkdownCache
}

type runtimeConfigMsg struct {
	config runtimeConfig
	err    error
}

type runtimeProfilesMsg struct {
	response runtimeProfilesResponse
	err      error
}

type registeredModel struct {
	ID               string              `json:"id"`
	Name             string              `json:"name"`
	ContextWindow    int                 `json:"contextWindow"`
	DefaultMaxTokens int                 `json:"defaultMaxTokens"`
	Capabilities     runtimeCapabilities `json:"capabilities"`
}

type registeredProvider struct {
	ID             string            `json:"id"`
	DisplayName    string            `json:"displayName"`
	Adapter        string            `json:"adapter"`
	AuthMode       string            `json:"authMode"`
	DefaultBaseURL string            `json:"defaultBaseUrl"`
	DefaultModel   string            `json:"defaultModel"`
	Configured     bool              `json:"configured"`
	AuthConfigured bool              `json:"authConfigured"`
	AuthSource     string            `json:"authSource"`
	Active         bool              `json:"active"`
	Models         []registeredModel `json:"models"`
}

type runtimeModelsResponse struct {
	Type          string                             `json:"type"`
	Version       int                                `json:"version"`
	Providers     []registeredProvider               `json:"providers"`
	DefaultModel  string                             `json:"defaultModel"`
	ActiveProfile string                             `json:"activeProfile"`
	Tombstones    map[string]runtimeProfileTombstone `json:"tombstones"`
}

type runtimeModelsMsg struct {
	response runtimeModelsResponse
	trigger  string
	err      error
}

type profileSelectMsg struct {
	profile string
	config  runtimeConfig
	err     error
}

// modelSelectMsg is the response from POST
// /v1/runtime/config/select with body {model: "..."}. The
// Go TUI uses this to persist a model picked from the
// /model multi-step flow (Step 4) without going through
// the `bbl config` CLI. On success the returned runtimeConfig
// is applied locally (m.modelID / m.providerID / header chrome
// etc.) so the operator sees the new active settings before
// the next turn lands.
type modelSelectMsg struct {
	modelID string
	config  runtimeConfig
	err     error
}

type providerConfigMsg struct {
	providerID string
	config     runtimeConfig
	err        error
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

type memoryStatusMsg struct {
	raw []byte
	err error
}

// sessionChannelKind mirrors the SessionChannelKind union from
// src/shared/sessionChannel.ts. The Go TUI only renders a small
// fixed set in the inbox footer / event cards; unknown values
// fall through to "unknown" so a server-side addition can't
// crash the client.
type sessionChannelKind string

const (
	channelKindDirect        sessionChannelKind = "direct"
	channelKindGroup         sessionChannelKind = "group"
	channelKindParentChild   sessionChannelKind = "parent_child"
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
	ChannelID             string               `json:"channelId"`
	Kind                  sessionChannelKind   `json:"kind"`
	ParticipantSessionIDs []string             `json:"participantSessionIds"`
	CreatedBySessionID    string               `json:"createdBySessionId"`
	CreatedAt             string               `json:"createdAt"`
	Status                sessionChannelStatus `json:"status"`
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
	Type                string           `json:"type"`
	SessionID           string           `json:"sessionId"`
	Messages            []sessionMessage `json:"messages"`
	Limit               int              `json:"limit"`
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
	sessionID  string
	raw        []byte
	envelope   sessionInboxResponse
	includeAck bool
	trigger    string
	err        error
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
	contextForkMinimal     contextForkMode = "minimal"
	contextForkWorkingSet  contextForkMode = "working-set"
	contextForkTaskFocused contextForkMode = "task-focused"
	contextForkFullSummary contextForkMode = "full-summary"
	contextForkDebugReplay contextForkMode = "debug-replay"
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

// toolRisk mirrors ToolRisk in src/tools/Tool.ts. The Go TUI
// uses these as the per-row risk tag in the /tools audit
// overlay. Unknown values fall through to the raw text so a
// server-side addition cannot break the client.
type toolRisk string

const (
	toolRiskRead    toolRisk = "read"
	toolRiskWrite   toolRisk = "write"
	toolRiskExecute toolRisk = "execute"
	toolRiskTask    toolRisk = "task"
)

// toolSourceType mirrors the nested `source.type` field of
// RuntimeToolAuditEntry in src/runtime/Runtime.ts. The Go TUI
// uses it to switch between the "builtin" and "mcp"
// presentation in the /tools audit row.
type toolSourceType string

const (
	toolSourceBuiltin toolSourceType = "builtin"
	toolSourceMCP     toolSourceType = "mcp"
)

// toolAuditSource is the nested `source` field of
// RuntimeToolAuditEntry. nil when the upstream tool audit
// entry has no source attribution.
type toolAuditSource struct {
	Type         toolSourceType `json:"type"`
	ServerName   string         `json:"serverName,omitempty"`
	OriginalName string         `json:"originalName,omitempty"`
}

// runtimeToolAuditEntry mirrors RuntimeToolAuditEntry in
// src/runtime/Runtime.ts. The Go TUI only reads the stable
// fields it displays; inputSchema stays as a generic map so
// schema churn upstream cannot break the typed decode.
type runtimeToolAuditEntry struct {
	Name               string           `json:"name"`
	Description        string           `json:"description"`
	Risk               toolRisk         `json:"risk"`
	Allowed            bool             `json:"allowed"`
	InputSchema        map[string]any   `json:"inputSchema,omitempty"`
	RequiresApproval   bool             `json:"requiresApproval,omitempty"`
	SuggestedAllowRule string           `json:"suggestedAllowRule,omitempty"`
	MCPServerAllowed   bool             `json:"mcpServerAllowed,omitempty"`
	Source             *toolAuditSource `json:"source,omitempty"`
}

// toolsAuditResponse is the envelope for
// GET /v1/tools/audit. The Go TUI only reads the stable
// top-level fields it displays; the rest of the payload
// stays in toolAuditMsg.raw so schema churn upstream cannot
// break the client.
type toolsAuditResponse struct {
	Type  string                  `json:"type"`
	Tools []runtimeToolAuditEntry `json:"tools"`
}

// toolAuditMsg is the response from
// GET /v1/tools/audit. The Go TUI decodes the envelope via
// the typed struct above; raw bytes are retained for the
// same reason contextAnalysisMsg / inboxMsg / agentJobsMsg
// keep them. The trigger field ("user" / "auto") tells the
// Update handler whether to open the overlay (user /tools
// command) or just refresh the snapshot in place (a future
// end-of-turn auto-refresh).
type toolAuditMsg struct {
	raw      []byte
	envelope toolsAuditResponse
	trigger  string
	err      error
}

// taskStatus mirrors TaskStatus in src/shared/task.ts. The
// Go TUI renders the status as a single-character icon in
// the task board overlay (e.g. "▶" for in_progress, "✓" for
// completed). Unknown statuses fall through to "?" so a
// server-side addition cannot break the client.
type taskStatus string

const (
	taskStatusPending    taskStatus = "pending"
	taskStatusInProgress taskStatus = "in_progress"
	taskStatusBlocked    taskStatus = "blocked"
	taskStatusCompleted  taskStatus = "completed"
	taskStatusFailed     taskStatus = "failed"
	taskStatusCancelled  taskStatus = "cancelled"
)

// taskSource mirrors the `source` field of NexusTask in
// src/shared/task.ts. Used as a compact tag in the task
// board overlay row.
type taskSource string

const (
	taskSourcePlanner  taskSource = "planner"
	taskSourceExecutor taskSource = "executor"
	taskSourceCritic   taskSource = "critic"
	taskSourceUser     taskSource = "user"
	taskSourceSystem   taskSource = "system"
)

// taskReviewStatus mirrors the nested `review.status` field.
type taskReviewStatus string

const (
	taskReviewPending  taskReviewStatus = "pending"
	taskReviewApproved taskReviewStatus = "approved"
	taskReviewRejected taskReviewStatus = "rejected"
)

// taskReview mirrors NexusTask.review in src/shared/task.ts.
// nil when the task has no review row yet.
type taskReview struct {
	Status          taskReviewStatus `json:"status"`
	Reason          string           `json:"reason,omitempty"`
	ReviewerAgentID string           `json:"reviewerAgentId,omitempty"`
}

// nexusTask mirrors NexusTask in src/shared/task.ts. The Go
// TUI only reads the stable fields it displays; the rest of
// the payload stays in tasksListMsg.raw for any future richer
// renderer (mirroring the inbox / context / compact pattern).
type nexusTask struct {
	TaskID             string         `json:"taskId"`
	SessionID          string         `json:"sessionId"`
	Title              string         `json:"title"`
	Description        string         `json:"description,omitempty"`
	Status             taskStatus     `json:"status"`
	OwnerAgentID       string         `json:"ownerAgentId,omitempty"`
	CreatedBySessionID string         `json:"createdBySessionId,omitempty"`
	Source             taskSource     `json:"source,omitempty"`
	DependsOn          []string       `json:"dependsOn"`
	Blocks             []string       `json:"blocks"`
	RetryCount         int            `json:"retryCount"`
	Review             *taskReview    `json:"review,omitempty"`
	Metadata           map[string]any `json:"metadata,omitempty"`
	CreatedAt          string         `json:"createdAt"`
	UpdatedAt          string         `json:"updatedAt"`
	Result             string         `json:"result,omitempty"`
}

// tasksListResponse is the envelope for
// GET /v1/sessions/:sessionId/tasks. The Go TUI only reads the
// stable top-level fields it displays; the rest of the payload
// stays in tasksListMsg.raw so schema churn upstream cannot
// break the client.
type tasksListResponse struct {
	Type      string      `json:"type"`
	SessionID string      `json:"sessionId"`
	Tasks     []nexusTask `json:"tasks"`
}

// tasksListMsg is the response from
// GET /v1/sessions/:sessionId/tasks. The Go TUI decodes the
// envelope via the typed struct above; raw bytes are retained
// for the same reason inboxMsg / agentJobsMsg keep them. The
// trigger field ("user" / "auto") tells the Update handler
// whether to open the overlay (user /tasks command) or just
// refresh the snapshot in place (Phase 6 PR4 end-of-turn
// auto-refresh, paired with fetchInbox + fetchSessionAgents).
type tasksListMsg struct {
	sessionID string
	raw       []byte
	envelope  tasksListResponse
	trigger   string
	err       error
}

// activityEventKind enumerates the high-signal Nexus event
// types the Go TUI records into the in-memory activity buffer
// for the /activity overlay. Mirrors the TS TUI's
// activityOverlay.ts event selection (recent tool runs /
// permission decisions / agent job events / context warnings).
type activityEventKind string

const (
	activityKindToolStarted     activityEventKind = "tool_started"
	activityKindToolCompleted   activityEventKind = "tool_completed"
	activityKindPermission      activityEventKind = "permission"
	activityKindAgentJob        activityEventKind = "agent_job"
	activityKindContextWarning  activityEventKind = "context_warning"
	activityKindContextBlocking activityEventKind = "context_blocking"
)

// activityEventEntry is one row in the in-memory activity
// buffer. Capped at activityBufferCap entries (oldest dropped
// first) so the Go TUI can surface a recent-activity snapshot
// without an extra Nexus round-trip.
type activityEventEntry struct {
	Kind      activityEventKind
	Summary   string
	Timestamp string
}

// activityBufferCap bounds the in-memory activity buffer so a
// long-running session can't grow the model unbounded.
const activityBufferCap = 50

// subAgentStatus mirrors the per-event lifecycle status we
// derive from a task_session_event with a subagent_* eventType.
// The Go TUI uses these as the in-memory tracker state for
// each running / completed / failed / cancelled sub-agent
// surfaced in the /agents overlay and the header running
// badge. The TS TUI's formatAgentLoopRows path uses the same
// status enum for the same set of event types.
type subAgentStatus string

const (
	subAgentStatusRunning   subAgentStatus = "running"
	subAgentStatusCompleted subAgentStatus = "completed"
	subAgentStatusFailed    subAgentStatus = "failed"
	subAgentStatusCancelled subAgentStatus = "cancelled"
)

// subAgentEntry is the in-memory tracker for one
// sub-agent (AgentLoop) lifecycle. The aggregator is keyed
// by the agentId / subSessionId / taskId that the upstream
// event payload carries; on the first subagent_started
// event we insert a new entry, and on subagent_completed /
// subagent_failed / subagent_cancelled we update the status
// in place. Entries that are still in the running status
// drive the header "sub: N running" badge (Phase 6 PR6).
type subAgentEntry struct {
	ID         string         // agentId / subSessionId / taskId (whichever the event payload carries)
	ParentTask string         // optional parentTaskId
	Title      string         // task title or prompt preview (single line)
	Status     subAgentStatus // running / completed / failed / cancelled
	UpdatedAt  string         // last event timestamp
}

// pollTickMsg fires when the background /v1/runtime/config poll is
// due. The handler should call fetchRuntimeConfig with `?since=`
// when m.configVersion > 0.
type pollTickMsg struct{}

// runtimeVersionCompat mirrors the nested
// `goTuiCompatibility` block of /v1/runtime/version. The Go
// TUI uses it for the major-version check at startup
// (Phase 8 PR1). Only `supportedMajors` is used today;
// `latestSupported` is surfaced in the version banner for
// future "your Go TUI is behind" UX.
type runtimeVersionCompat struct {
	SupportedMajors []int  `json:"supportedMajors"`
	LatestSupported string `json:"latestSupported"`
}

// runtimeVersionResponse is the envelope for
// GET /v1/runtime/version. The Go TUI only reads the stable
// fields it uses for the compat check; raw bytes are
// retained for any future richer renderer.
//
// SchemaVersion is a date-based semantic string
// (e.g. "2026-05-21.babel-o.v1") matching the upstream
// Nexus event schema version, NOT a numeric field. The
// field is decoded but currently unused by the runtime
// compat check (which only consults supportedMajors); it
// is kept on the typed struct so any future richer
// renderer can surface it without breaking the existing
// decode path.
type runtimeVersionResponse struct {
	Type                 string               `json:"type"`
	ServerVersion        string               `json:"serverVersion"`
	SchemaVersion        string               `json:"schemaVersion"`
	GoTuiCompatibility   runtimeVersionCompat `json:"goTuiCompatibility"`
	NodeCliCompatibility runtimeVersionCompat `json:"nodeCliCompatibility"`
}

// runtimeVersionMsg is the response from
// GET /v1/runtime/version. The Go TUI only reads the
// supportedMajors + latestSupported fields; raw bytes are
// retained for the same schema-churn reason as
// contextAnalysisMsg / inboxMsg.
type runtimeVersionMsg struct {
	raw      []byte
	envelope runtimeVersionResponse
	err      error
}

// inputMode is the §5 / Phase 3 single-input-owner state machine.
// Only one mode is active at a time; transitions are explicit and
// always round-trip back to modeComposing when an overlay closes.
type inputMode string

const (
	modeComposing         inputMode = "composing"         // textinput owns keys
	modePermission        inputMode = "permission"        // a/y/r/n/esc only
	modeSlashPick         inputMode = "slashPick"         // one-shot slash palette (no live filter yet)
	modeHelpOverlay       inputMode = "helpOverlay"       // read-only help; up/down/esc/enter
	modeProfileConfirm    inputMode = "profileConfirm"    // y/n/esc only; gates selectRuntimeProfile
	modeContextOverlay    inputMode = "contextOverlay"    // read-only context analysis; up/down/esc/enter
	modeInboxOverlay      inputMode = "inboxOverlay"      // read-only SessionChannel inbox; up/down/a/esc/enter/q
	modeAgentOverlay      inputMode = "agentOverlay"      // read-only multi-agent status; up/down/esc/enter/q
	modeTaskBoard         inputMode = "taskBoard"         // read-only task board; up/down/esc/enter/q
	modeActivityOverlay   inputMode = "activityOverlay"   // read-only recent activity; up/down/esc/enter/q
	modeMemoryOverlay     inputMode = "memoryOverlay"     // read-only /v1/runtime/memory/status wire; up/down/esc/enter/q
	modeToolAuditOverlay  inputMode = "toolAuditOverlay"  // read-only /v1/tools/audit wire; up/down/esc/enter/q
	modeModelOverlay      inputMode = "modelOverlay"      // read-only model config/catalog; up/down/esc/enter/q
	modeSessionOverlay    inputMode = "sessionOverlay"    // /session step 1: pick session operation
	modeSessionConfirm    inputMode = "sessionConfirm"    // /session step 2: confirm new-session reset
	modeSessionInput      inputMode = "sessionInput"      // /session step 2: enter/select/switch session id
	modeModelPickProvider inputMode = "modelPickProvider" // /model step 1: provider select
	modeModelPickApiKey   inputMode = "modelPickApiKey"   // /model step 2: API key entry
	modeModelPickBaseURL  inputMode = "modelPickBaseURL"  // /model step 3: base URL entry
	modeModelPickModel    inputMode = "modelPickModel"    // /model step 4: model select
	modeQuitConfirm       inputMode = "quitConfirm"       // y/enter confirms quit, esc/n cancels
	// Phase A.1 Round 2 of the enhanced permission panel:
	// inline text editors reached from the 5-option panel.
	//   - modePermissionEditRule: textinput owns keys; pre-filled
	//     with the runtime-suggested rule; Enter confirms
	//     option 3 ("Approve with editable rule") with the
	//     edited value, Esc returns to the 5-option panel.
	//   - modePermissionEditFeedback: same shape for option 5
	//     ("Reject, tell the model what to do instead"); the
	//     textinput starts empty.
	modePermissionEditRule     inputMode = "permissionEditRule"
	modePermissionEditFeedback inputMode = "permissionEditFeedback"
)

// mouseWheelStepLines keeps wheel scrolling close to terminal-native
// trackpad behavior. Bubble viewport defaults to 3 rows per tick,
// but that feels jumpy in the Go TUI because the transcript is dense
// and the app already receives many wheel ticks on modern terminals.
const mouseWheelStepLines = 1

const mouseEventThrottle = 15 * time.Millisecond

var lastProgramMouseEvent time.Time

// MouseEventFilter mirrors crush's program-level mouse filter:
// high-resolution trackpads can emit floods of motion/wheel events
// faster than the renderer can usefully redraw. Throttling here keeps
// those events away from child components like textarea before Update
// routing has a chance to run.
func MouseEventFilter(_ tea.Model, msg tea.Msg) tea.Msg {
	switch msg.(type) {
	case tea.MouseWheelMsg, tea.MouseMotionMsg:
		now := time.Now()
		if now.Sub(lastProgramMouseEvent) < mouseEventThrottle {
			return nil
		}
		lastProgramMouseEvent = now
	}
	return msg
}

// maxTranscriptWidth mirrors crush's maxTextWidth: on very wide
// terminals (4K monitor @ 200+ cols) the transcript shouldn't
// stretch to fill the screen — long lines become hard to scan
// back to the start. Capping at 120 cols keeps prose readable;
// the header / footer / input still fill the full terminal width
// because their content is short anyway.
const maxTranscriptWidth = 120

// Compact-mode breakpoints (crush's compactModeWidthBreakpoint +
// compactModeHeightBreakpoint). When the terminal is narrower
// than the width breakpoint OR shorter than the height
// breakpoint, the TUI drops secondary chrome (side-channel
// summary, elapsed time, version suffix) so the primary
// controls remain visible. The 120×30 numbers are picked to
// match the common SSH-attach (80×24) and 12" laptop (110×28)
// scenarios where every row counts.
const (
	compactModeWidthBreakpoint  = 120
	compactModeHeightBreakpoint = 30
)

const (
	inputMinHeight = 3
	inputMaxHeight = 15
)

// isCompact reports whether the current terminal dimensions
// trigger the compact layout (drop secondary chrome to free up
// rows / columns for the primary transcript + input).
func (m model) isCompact() bool {
	return m.width < compactModeWidthBreakpoint || m.height < compactModeHeightBreakpoint
}

func (m inputMode) canEditInput() bool { return m == modeComposing }

func (m inputMode) canReceiveTextInput() bool {
	switch m {
	case modeComposing,
		modePermissionEditRule,
		modePermissionEditFeedback,
		modeSessionInput,
		modeModelPickApiKey,
		modeModelPickBaseURL:
		return true
	default:
		return false
	}
}

type model struct {
	cfg                       Config
	input                     textarea.Model
	pastedTextReplacements    map[string]string
	pastedTextCounter         int
	viewport                  viewport.Model
	spinner                   spinner.Model
	gradientSpinner           gradientSpinner
	transcript                []*transcriptItem
	inputMode                 inputMode
	helpScroll                int
	running                   bool
	events                    <-chan streamEvent
	decisions                 chan<- permissionDecision
	streamCancel              chan<- struct{}
	pending                   *pendingPermission
	recentPermissionRules     map[string]permissionRuleSeen
	trustedPermissionSessions map[string]struct{}
	// Phase A.1: 0..4 selector on the 5-option permission panel
	// ("Approve once" / "Approve for session" / "Approve with
	// editable rule" / "Reject" / "Reject, tell the model what
	// to do instead"). Driven by 1-5, up/down, and (on selection)
	// enter; esc cancels as before. Always re-initialised to 0
	// (default cursor on "Approve once") on every fresh
	// `permission_request` event.
	permissionChoice        int
	lastEventType           string
	sessionID               string
	modelID                 string
	providerID              string
	authMode                string
	hasAPIKey               bool
	activeProfile           string
	contextWindow           int
	configVersion           int
	profileCount            int
	tombstoneCount          int
	topCardOpen             bool
	paletteFilter           string
	paletteSelected         int
	pendingProfileName      string
	contextOverlayLines     []string
	contextOverlayScroll    int
	inboxMessages           []sessionMessage
	inboxChannels           []sessionChannel
	inboxOverlaySelected    int
	inboxOverlayScroll      int
	inboxOverlayIncludeAck  bool
	seenInboxCardMessageIDs map[string]struct{}
	agentJobs               []agentJob
	agentOverlayScroll      int
	taskBoard               []nexusTask
	taskBoardScroll         int
	activityEvents          []activityEventEntry
	activityOverlayScroll   int
	memoryOverlayLines      []string
	memoryOverlayScroll     int
	subAgents               map[string]subAgentEntry
	toolAuditEntries        []runtimeToolAuditEntry
	toolAuditScroll         int
	modelCatalog            runtimeModelsResponse
	modelOverlayScroll      int
	sessionPanelSelected    int
	sessionPendingAction    sessionPanelAction
	quitChoice              int
	startedAt               time.Time
	permissionOpenedAt      time.Time
	permissionLastInputAt   time.Time
	graceQuietPeriod        time.Duration
	graceMaxDelay           time.Duration
	connected               bool
	latestUsage             *usageSnapshot
	lastUsage               *usageSnapshot
	contextUsage            *contextUsageSnapshot
	// Phase 4 of docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md:
	// running snapshot of the Nexus-side soft timeout cycle so the
	// footer can show "soft budget reached / extended" and so a
	// subsequent REQUEST_TIMEOUT can be classified as a watchdog
	// cutoff (the soft cycle had already fired) rather than a
	// fresh fatal cutoff. Cleared on result / error like
	// `latestUsage` so the next turn starts clean.
	softTimeoutState *softTimeoutSnapshot
	currentTimeout   timeoutDecision
	// Phase 11 in-app selection. With --mouse the Go TUI
	// captures SGR mouse events and the terminal can no
	// longer do native drag-select. We compensate with an
	// in-app highlight + OSC 52 copy: the operator presses
	// and drags the left button over the transcript
	// viewport, the cells under the drag get a gray
	// background, and on release the selected text is
	// pushed to the system clipboard via OSC 52. Coords
	// are in viewport-content space (line/col), not
	// screen coords, so a scroll/resize keeps the
	// selection anchored to the same text.
	selectionStartLine int
	selectionStartCol  int
	selectionEndLine   int
	selectionEndCol    int
	selectionActive    bool
	// mouseDownInViewport tracks a left-button press that
	// started inside the transcript viewport. We only
	// update the selection while this is true; a release
	// outside the viewport (e.g. on the input box) ends
	// the drag naturally.
	mouseDownInViewport bool
	// lastSelectionCopy is the most recent OSC 52 payload
	// that was emitted. The overlay's footer shows a small
	// "copied N chars" line for a few seconds so the
	// operator has feedback that the gesture worked even
	// when their terminal hides OSC 52 echoing.
	lastSelectionCopy   string
	lastSelectionCopyAt time.Time
	copyToastMessage    string
	copyToastShownAt    time.Time
	lastMouseEventTime  time.Time
	mouseEscapeBuffer   string
	// promptHistory is the per-session list of submitted
	// prompts; up/down in composing mode walks it so the
	// operator can recall a prior turn without leaving the
	// input box. historyIndex == -1 means "no history
	// selected" (i.e. the live current draft).
	promptHistory []string
	historyIndex  int
	historySaved  string
	// queuedPrompt is the next prompt the operator submitted
	// while a turn was still running. It is dispatched as soon
	// as the current stream lands a terminal result/error (or an
	// ESC cancellation finishes). The textarea remains editable
	// during m.running so the operator can stage follow-up input
	// without waiting at the terminal.
	queuedPrompt             string
	cancelRequested          bool
	cancelRequestedAt        time.Time
	interruptionPromptActive bool
	// /model multi-step state. The flow is:
	//   1) modeModelPickProvider — pick a provider
	//   2) modeModelPickApiKey  — paste API key (or accept default)
	//   3) modeModelPickBaseURL — confirm or override base URL
	//   4) modeModelPickModel   — pick a model
	// Each mode holds its own scroll / selected state.
	modelPickProviderIdx   int
	modelPickProviderDraft string // pending slash argument / provider seed
	modelPickAPIKeyDraft   string
	modelPickBaseURLDraft  string
	modelPickSelectedID    string
	modelPickSelectedIdx   int
	// modelPickerLive is the latest live-fetched model
	// list for the picked provider, populated on entry to
	// Step 4 by re-fetching /v1/runtime/models and filtering
	// to the chosen provider. While the re-fetch is in
	// flight, modelPickerLoading is true and the picker
	// renders a spinner instead of the list.
	modelPickerLive    []registeredModel
	modelPickerLoading bool
	// modelPickSubmitting is true between the operator
	// pressing Enter in Step 4 and the response landing
	// from POST /v1/runtime/config/select. While it's
	// true the picker locks input (↑/↓/Enter/esc) so a
	// second press can't fire a duplicate POST, and the
	// renderer swaps the list for a "saving…" line.
	modelPickSubmitting bool
	width               int
	height              int
}

// usageSnapshot captures the most recent token usage event from
// the Nexus stream so the footer can render a single transient
// status line (like the `✻ Sautéed for 26s` pattern) instead of
// appending a new transcript row per usage event. Cleared on
// every result / error event so the next turn starts clean.
type usageSnapshot struct {
	InputTokens  int
	OutputTokens int
	CacheRead    int
}

type contextUsageSnapshot struct {
	PercentUsed      int
	TokenEstimate    int
	MaxTokens        int
	WarningThreshold int
	CompactThreshold int
	BlockingLimit    int
	PolicySource     string
}

// softTimeoutSnapshot captures the running state of the
// Nexus-side soft timeout cycle (Phase 4 of
// docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md).
// It is updated on every `timeout_budget_exceeded` and
// `timeout_extension_granted` event so the footer can render a
// transient "soft budget reached / extended" status, and so
// `friendlyNexusError` can rewrite the REQUEST_TIMEOUT message
// to distinguish a watchdog cutoff (the soft cycle had already
// fired one or more times) from a fresh fatal cutoff.
//
// Cleared on `result` / `error` like `usageSnapshot` so the next
// turn starts clean. Hard watchdog cutoff arrives as an `error`
// event AFTER the soft cycle events, so the snapshot is still
// populated when `friendlyNexusError` runs for the error.
type softTimeoutSnapshot struct {
	// BudgetExceededAt is the wall-clock time of the most recent
	// `timeout_budget_exceeded` event. Used by the footer for a
	// short transient marker and to detect "soft cycle already
	// fired" when classifying a REQUEST_TIMEOUT.
	BudgetExceededAt time.Time
	// OriginalBudgetMs is the soft budget that fired the first
	// cycle (`timeoutMs` on the first budget_exceeded event).
	OriginalBudgetMs int
	// TotalSoftBudgetMs is the running soft budget after the
	// most recent extension (`totalSoftBudgetMs` on the latest
	// extension_granted event, or OriginalBudgetMs if none).
	TotalSoftBudgetMs int
	// ExtensionCount is the number of extensions granted so far
	// in the current turn. 0 means the soft cycle has fired but
	// not granted (e.g. cap reached or maxSoftTimeoutExtensions
	// set to 0).
	ExtensionCount int
	// MaxExtensions is the configured cap as last seen from the
	// `timeout_extension_granted` event. Lets the footer render
	// "1/1" so the operator sees how much extension head-room
	// remains.
	MaxExtensions int
	// LastElapsedMs is the elapsed time recorded on the most
	// recent soft-cycle event (budget or extension). Useful for
	// human-readable footer / friendly-message output.
	LastElapsedMs int
}

type timeoutDecision struct {
	TimeoutMs int
	Reason    string
	Adaptive  bool
}

func (d timeoutDecision) Label() string {
	if d.TimeoutMs <= 0 {
		return ""
	}
	seconds := d.TimeoutMs / 1000
	if d.Adaptive && d.Reason != "" {
		return fmt.Sprintf("timeout=%ds (%s)", seconds, d.Reason)
	}
	return fmt.Sprintf("timeout=%ds", seconds)
}

func (m *model) setMode(next inputMode) {
	if m.inputMode == next {
		return
	}
	wasFullScreenOverlay := m.usesFullScreenOverlay()
	if next != modeComposing {
		m.clearSelection()
	}
	m.inputMode = next
	if next == modePermission {
		m.permissionOpenedAt = time.Now()
		m.permissionLastInputAt = time.Now()
	}
	// Mode-aware placeholder: the /model and permission-editor
	// overlays render the input box with context-specific hints so
	// the operator doesn't see "Ask BabeL-O" while configuring a
	// provider. The default mode goes back to "Ask BabeL-O".
	m.input.Placeholder = placeholderForMode(next)
	if m.width > 0 && m.height > 0 && (wasFullScreenOverlay || m.usesFullScreenOverlay()) {
		m.resize()
	}
}

// placeholderForMode returns the input placeholder text appropriate
// for the given mode. Most modes share "Ask BabeL-O" (the default);
// the model-pick and permission-editor overlays need their own
// context so the operator sees a hint that matches the active
// configuration step.
func placeholderForMode(mode inputMode) string {
	switch mode {
	case modeModelPickApiKey:
		return "paste API key (or accept default)"
	case modeModelPickBaseURL:
		return "https://api.example.com"
	case modePermissionEditRule:
		return "git:status, bash:*, npm:install"
	case modePermissionEditFeedback:
		return "tell the model what to do instead"
	case modeSessionInput:
		return "session id"
	default:
		return "Ask BabeL-O"
	}
}

// scrollOverlay moves the active overlay's internal scroll or
// selection by `delta` rows. Positive delta walks forward / down,
// negative walks back / up. The keyboard ↑/↓ handlers for each
// overlay call into this same helper so the mouse wheel and the
// keyboard stay in sync. Returns true if the active mode was an
// overlay that consumed the wheel tick, false if the active mode
// has no scroll semantics and the caller should treat the wheel
// as a no-op.
//
// The permission panel is special: it has exactly 5 choices in a
// ring, so a wheel tick of 5 is a full lap and lands back on the
// same option. We treat it modulo 5.
func (m *model) scrollOverlay(delta int) bool {
	if delta == 0 {
		return true
	}
	switch m.inputMode {
	case modeHelpOverlay:
		// help has no max — the overlay renderer already
		// clamps visible rows in `renderHelp` itself.
		if delta < 0 {
			for i := 0; i < -delta && m.helpScroll > 0; i++ {
				m.helpScroll--
			}
		} else {
			m.helpScroll += delta
		}
		return true
	case modeContextOverlay:
		maxScroll := max(0, len(m.contextOverlayLines)-1)
		m.contextOverlayScroll = clamp(m.contextOverlayScroll+delta, 0, maxScroll)
		return true
	case modeInboxOverlay:
		maxScroll := max(0, len(m.inboxMessages)-1)
		m.inboxOverlaySelected = clamp(m.inboxOverlaySelected+delta, 0, maxScroll)
		return true
	case modeAgentOverlay:
		allLines := buildAgentOverlayLines(m.agentJobs)
		maxScroll := max(0, len(allLines)-1)
		m.agentOverlayScroll = clamp(m.agentOverlayScroll+delta, 0, maxScroll)
		return true
	case modeTaskBoard:
		allLines := buildTaskBoardLines(m.taskBoard)
		maxScroll := max(0, len(allLines)-1)
		m.taskBoardScroll = clamp(m.taskBoardScroll+delta, 0, maxScroll)
		return true
	case modeActivityOverlay:
		allLines := buildActivityOverlayLines(m.activityEvents)
		maxScroll := max(0, len(allLines)-1)
		m.activityOverlayScroll = clamp(m.activityOverlayScroll+delta, 0, maxScroll)
		return true
	case modeMemoryOverlay:
		maxScroll := max(0, len(m.memoryOverlayLines)-1)
		m.memoryOverlayScroll = clamp(m.memoryOverlayScroll+delta, 0, maxScroll)
		return true
	case modeToolAuditOverlay:
		allLines := buildToolAuditOverlayLines(m.toolAuditEntries)
		maxScroll := max(0, len(allLines)-1)
		m.toolAuditScroll = clamp(m.toolAuditScroll+delta, 0, maxScroll)
		return true
	case modeModelOverlay:
		allLines := buildModelOverlayLines(m.modelCatalog)
		maxScroll := max(0, len(allLines)-1)
		m.modelOverlayScroll = clamp(m.modelOverlayScroll+delta, 0, maxScroll)
		return true
	case modeModelPickProvider:
		maxScroll := max(0, len(m.modelCatalog.Providers)-1)
		m.modelPickProviderIdx = clamp(m.modelPickProviderIdx+delta, 0, maxScroll)
		return true
	case modeModelPickModel:
		provider := m.currentModelProvider()
		total := 0
		if len(m.modelPickerLive) > 0 {
			total = len(m.modelPickerLive)
		} else if provider != nil {
			total = len(provider.Models)
		}
		maxScroll := max(0, total-1)
		m.modelPickSelectedIdx = clamp(m.modelPickSelectedIdx+delta, 0, maxScroll)
		return true
	case modeSessionOverlay:
		actions := sessionPanelActions()
		if len(actions) == 0 {
			return true
		}
		m.sessionPanelSelected = ((m.sessionPanelSelected+delta)%len(actions) + len(actions)) % len(actions)
		return true
	case modePermission:
		// 5-option ring. Treat the wheel tick modulo 5 so
		// the choice lands predictably.
		m.permissionChoice = ((m.permissionChoice+delta)%5 + 5) % 5
		return true
	}
	// Composing / slash pick / profile confirm / text-entry
	// pickers are no-op for the wheel: composing owns ↑/↓ for
	// prompt history, the others either respond to typed input
	// or have their own short key list. The caller is expected
	// to have already routed the wheel to m.viewport for composing
	// before consulting scrollOverlay.
	return false
}

func (m *model) handleMouseWheel(mouse tea.Mouse) {
	if m.inputMode == modePermission && m.inPermissionGracePeriod() {
		m.permissionLastInputAt = time.Now()
		return
	}
	switch mouse.Button {
	case tea.MouseWheelUp:
		m.scrollByMouseWheelDelta(-mouseWheelStepLines)
	case tea.MouseWheelDown:
		m.scrollByMouseWheelDelta(mouseWheelStepLines)
	}
}

func (m *model) scrollByMouseWheelDelta(delta int) {
	if delta == 0 {
		return
	}
	if m.inputMode == modeComposing {
		if delta < 0 {
			m.viewport.ScrollUp(-delta)
		} else {
			m.viewport.ScrollDown(delta)
		}
		return
	}
	m.scrollOverlay(delta)
}

func inputPrompt(info textarea.PromptInfo) string {
	if info.LineNumber == 0 {
		return "  > "
	}
	return "::: "
}

func desiredInputHeight(input textarea.Model) int {
	return clamp(input.Height(), inputMinHeight, inputMaxHeight)
}

func (m *model) syncInputHeight() {
	m.input.SetHeight(desiredInputHeight(m.input))
}

func (m *model) setInputValue(value string) {
	m.input.SetValue(value)
	m.input.CursorEnd()
	m.syncInputHeight()
	m.resize()
}

func (m *model) updateInput(msg tea.Msg) tea.Cmd {
	switch msg := msg.(type) {
	case tea.MouseWheelMsg:
		if !m.cfg.MouseCapture {
			return nil
		}
		m.handleMouseWheel(msg.Mouse())
		return nil
	case tea.MouseClickMsg, tea.MouseMotionMsg, tea.MouseReleaseMsg:
		return nil
	}
	if raw := fmt.Sprint(msg); m.handleUnknownCSIMessage(raw) {
		return nil
	}
	oldInputHeight := m.input.Height()
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	m.syncInputHeight()
	if m.input.Height() != oldInputHeight {
		m.resize()
	}
	return cmd
}

func (m *model) handlePaste(content string) {
	if m.handleMouseEscapeString(content) {
		return
	}
	if m.inputMode == modeModelPickApiKey {
		m.appendModelAPIKeyDraft(content)
		m.resize()
		return
	}
	if strings.Contains(content, "\n") || strings.Contains(content, "\r") {
		m.pastedTextCounter++
		lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
		lineCount := len(lines)
		placeholder := fmt.Sprintf("[Pasted text #%d +%d lines]", m.pastedTextCounter, lineCount)
		if m.pastedTextReplacements == nil {
			m.pastedTextReplacements = make(map[string]string)
		}
		m.pastedTextReplacements[placeholder] = content
		m.input.InsertString(placeholder)
	} else {
		m.input.InsertString(content)
	}
	m.syncInputHeight()
	m.resize()
}

func sanitizeModelAPIKeyInput(value string) string {
	value = stripANSICodes(value)
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		if r == utf8.RuneError {
			continue
		}
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func (m *model) appendModelAPIKeyDraft(value string) {
	m.modelPickAPIKeyDraft = sanitizeModelAPIKeyInput(m.modelPickAPIKeyDraft + value)
}

func (m *model) deleteModelAPIKeyDraftBackward() {
	if m.modelPickAPIKeyDraft == "" {
		return
	}
	runes := []rune(m.modelPickAPIKeyDraft)
	m.modelPickAPIKeyDraft = string(runes[:len(runes)-1])
}

func (m *model) handleModelAPIKeyInput(msg tea.KeyPressMsg) bool {
	key := msg.String()
	switch key {
	case "backspace", "ctrl+h":
		m.deleteModelAPIKeyDraftBackward()
		return true
	case "ctrl+u":
		m.modelPickAPIKeyDraft = ""
		return true
	}
	text := msg.Key().Text
	if text != "" {
		m.appendModelAPIKeyDraft(text)
		return true
	}
	keyInfo := msg.Key()
	if keyInfo.Mod&(tea.ModCtrl|tea.ModAlt) == 0 &&
		keyInfo.Code >= 0x20 &&
		keyInfo.Code != 0x7f &&
		keyInfo.Code <= utf8.MaxRune {
		m.appendModelAPIKeyDraft(string(keyInfo.Code))
		return true
	}
	return false
}

func isInputNewlineKeyMsg(msg tea.KeyPressMsg) bool {
	key := msg.Key()
	if key.Code == tea.KeyEnter || key.Code == tea.KeyKpEnter {
		if key.Mod&tea.ModShift != 0 || key.Mod&tea.ModAlt != 0 {
			return true
		}
	}
	return isInputNewlineKey(msg.String())
}

func isInputNewlineKey(key string) bool {
	if key == "ctrl+j" || key == "shift+enter" || key == "alt+enter" {
		return true
	}
	raw := key
	switch raw {
	case "\x1b[13;2u", "\x1b[13;2~", "\x1b[27;2;13~", "[13;2u", "[13;2~", "[27;2;13~":
		return true
	default:
		return false
	}
}

func (m *model) insertInputNewline() {
	m.input.InsertRune('\n')
	m.syncInputHeight()
	m.resize()
}

func (m *model) submitPrompt(rawPrompt string, queueIfRunning bool) tea.Cmd {
	if before, ok := strings.CutSuffix(rawPrompt, "\\"); ok {
		m.setInputValue(before)
		m.insertInputNewline()
		return nil
	}
	trimmed := strings.TrimSpace(rawPrompt)
	if trimmed == "" {
		return nil
	}
	if m.running {
		if m.interruptionPromptActive {
			m.queuePrompt(rawPrompt)
			return m.cancelRunningStream(rawPrompt)
		}
		if queueIfRunning {
			m.queuePrompt(rawPrompt)
		}
		return nil
	}
	return m.startPrompt(rawPrompt)
}

func (m *model) queuePrompt(rawPrompt string) {
	trimmed := strings.TrimSpace(rawPrompt)
	if trimmed == "" {
		return
	}
	m.queuedPrompt = rawPrompt
	m.setInputValue("")
	m.appendPromptHistory(rawPrompt)
	m.appendLine("status", "queued next prompt: "+truncatePlain(singleLine(trimmed), 120))
	m.resize()
}

func (m *model) startPrompt(rawPrompt string) tea.Cmd {
	trimmed := strings.TrimSpace(rawPrompt)
	if trimmed == "" || m.running {
		return nil
	}
	m.appendPromptHistory(rawPrompt)
	m.setInputValue("")
	expandedPrompt := m.expandPromptPlaceholders(rawPrompt)
	m.pastedTextReplacements = make(map[string]string)
	m.pastedTextCounter = 0

	if strings.HasPrefix(trimmed, "/") {
		// Note: do NOT m.setMode(modeComposing) here — some
		// slash commands (e.g. /profile <name>) intentionally
		// transition to modeProfileConfirm, and clobbering
		// that would skip the y/n overlay. Other commands
		// stay in composing by default (no setMode call),
		// which matches the previous behavior.
		cmd := m.handleLocalCommand(trimmed)
		m.resize()
		return cmd
	}
	return m.startAgentPrompt(trimmed, expandedPrompt)
}

func (m *model) appendPromptHistory(rawPrompt string) {
	if len(m.promptHistory) == 0 || m.promptHistory[len(m.promptHistory)-1] != rawPrompt {
		m.promptHistory = append(m.promptHistory, rawPrompt)
	}
	m.historyIndex = -1
	m.historySaved = ""
}

func (m *model) startAgentPrompt(displayPrompt string, expandedPrompt string) tea.Cmd {
	if strings.TrimSpace(displayPrompt) == "" || m.running {
		return nil
	}
	m.appendLine("user", displayPrompt)
	timeout := resolveGoTuiTimeout(m.cfg, expandedPrompt, m.latestUsage)
	m.currentTimeout = timeout
	if timeout.Adaptive {
		m.appendLine("status", timeout.Label())
	}
	m.running = true
	m.cancelRequested = false
	m.cancelRequestedAt = time.Time{}
	m.pending = nil
	m.lastEventType = ""
	m.startedAt = time.Now()
	m.resize()
	return tea.Batch(startStream(m.cfg, expandedPrompt, timeout), m.gradientSpinner.Tick)
}

func (m *model) startQueuedPrompt() tea.Cmd {
	rawPrompt := m.queuedPrompt
	m.queuedPrompt = ""
	if strings.TrimSpace(rawPrompt) == "" || m.running {
		return nil
	}
	m.appendLine("status", "starting queued prompt")
	return m.startPrompt(rawPrompt)
}

func (m *model) openInterruptionPrompt() {
	if !m.running || m.cancelRequested {
		return
	}
	m.interruptionPromptActive = true
	m.setMode(modeComposing)
	if strings.TrimSpace(m.input.Value()) == "" {
		m.setInputValue("BabeL-O should ")
	} else {
		m.resize()
	}
	m.appendLine("permission", "What should BabeL-O do instead? Edit the prompt below, then Enter to interrupt; Esc again cancels the current run without extra guidance.")
	m.resize()
}

func (m *model) cancelRunningStream(feedback string) tea.Cmd {
	if !m.running || m.cancelRequested {
		return nil
	}
	m.cancelRequested = true
	m.cancelRequestedAt = time.Now()
	m.interruptionPromptActive = false
	m.pending = nil
	if m.inputMode == modePermission || m.inputMode == modePermissionEditRule || m.inputMode == modePermissionEditFeedback {
		m.setMode(modeComposing)
	}
	if trimmed := strings.TrimSpace(feedback); trimmed != "" {
		m.appendLine("permission", "interrupting current run; next instruction: "+truncatePlain(singleLine(trimmed), 120))
	} else {
		m.appendLine("status", "cancelling current agent run…")
	}
	cancel := m.streamCancel
	m.resize()
	return cancelStream(m.cfg, m.sessionID, cancel)
}

func (m *model) finishRunningStream() tea.Cmd {
	m.running = false
	m.cancelRequested = false
	m.cancelRequestedAt = time.Time{}
	m.interruptionPromptActive = false
	m.pending = nil
	m.events = nil
	m.decisions = nil
	m.streamCancel = nil
	if m.inputMode == modePermission || m.inputMode == modePermissionEditRule || m.inputMode == modePermissionEditFeedback {
		m.setMode(modeComposing)
	}
	m.latestUsage = nil
	m.softTimeoutState = nil
	m.resize()
	return m.startQueuedPrompt()
}

// printableRuneFromKey returns the leading printable rune from a
// tea.KeyMsg, or 0 if the key is a special key (Enter, Esc, arrows,
// etc.) and must NOT be appended to the palette filter.
func printableRuneFromKey(msg tea.KeyMsg) rune {
	key := msg.Key()
	if key.Text != "" {
		for _, r := range key.Text {
			if r >= 0x20 && r != 0x7f {
				return r
			}
		}
	}
	if key.Code == tea.KeySpace {
		return ' '
	}
	return 0
}

var (
	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	mutedStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	statusStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("81"))
	errorStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	toolStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#ff7a18"))
	// toolBulletStyle colours the leading `●` glyph on a tool
	// invocation row. The bullet stays sky blue (the
	// pre-#ff7a18 brand colour for the kind marker) so the
	// operator can scan a transcript for `● ` to count tool
	// runs without the warm orange drowning the glyph; the
	// tool name that follows is the warm orange accent.
	toolBulletStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("75"))
	permissionStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("220")).Bold(true)
	confirmStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("215")).Bold(true)
	contextStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("75"))
	assistantStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("15"))
	userStyle         = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	thinkingStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("141"))
	dividerStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("238"))
	footerStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	inputBlockStyle   = lipgloss.NewStyle()
	topCardFrameStyle = lipgloss.NewStyle().
				Border(lipgloss.NormalBorder()).
				BorderForeground(lipgloss.Color("99")).
				Padding(0, 1)
	topCardAccentStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("99"))
	// overlayFrameStyle wraps every read-only overlay (help,
	// profile confirm, context, inbox, agents, tasks, activity,
	// tools audit) in a muted normal border so they read as
	// distinct panels instead of running into the transcript.
	overlayFrameStyle = lipgloss.NewStyle().
				Border(lipgloss.NormalBorder()).
				BorderForeground(lipgloss.Color("238")).
				Padding(0, 1)
	// permissionFrameStyle is a louder variant of overlayFrame
	// for the live permission_request panel: a yellow border
	// draws the eye to the decision prompt without the operator
	// needing to scan the transcript.
	permissionFrameStyle = lipgloss.NewStyle().
				Border(lipgloss.NormalBorder()).
				BorderForeground(lipgloss.Color("220")).
				Padding(0, 1)
	focusedLineStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("252"))
	inboxStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("33"))
	agentStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("141"))
	taskBoardStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	activityStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("117"))
	toolPaletteStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("117"))
)

func Run(cfg Config) error {
	m := newModel(cfg)
	// Crush-style mouse routing: the program-level filter
	// throttles high-resolution trackpads, while Update consumes
	// MouseWheelMsg before textarea.Update can scroll the composer.
	// The CLI enables MouseCapture by default; --mouse=false keeps
	// the old terminal-owned mode for operators who prefer native
	// selection/scrollback over in-app selection and wheel routing.
	if _, err := tea.NewProgram(m, tea.WithFilter(MouseEventFilter)).Run(); err != nil {
		return err
	}
	return nil
}

func newModel(cfg Config) model {
	input := textarea.New()
	input.Placeholder = "Ask BabeL-O"
	input.Focus()
	input.CharLimit = 4000
	input.Prompt = "  > "
	input.SetPromptFunc(4, inputPrompt)
	input.ShowLineNumbers = false
	input.DynamicHeight = true
	input.MinHeight = inputMinHeight
	input.MaxHeight = inputMaxHeight
	input.KeyMap.InsertNewline.SetKeys("ctrl+j", "shift+enter", "alt+enter")
	input.KeyMap.InsertNewline.SetHelp("shift+enter", "newline")
	// Strip the default background fill from the focused /
	// blurred base style. The bubbles textarea renders a
	// dark fill behind the prompt row by default, which
	// looks like a chrome panel sitting below the
	// transcript. Setting the base style to an empty
	// lipgloss.Style removes the fill so the input box is
	// a clean prefix-cursor-row matching the rest of the
	// transcript.
	inputStyles := input.Styles()
	inputStyles.Focused.Base = lipgloss.NewStyle()
	inputStyles.Blurred.Base = lipgloss.NewStyle()
	inputStyles.Cursor = textarea.CursorStyle{}
	// The bubbles textarea's `CursorLine` style has a default
	// background fill on the row containing the cursor, which
	// read as a chrome panel underneath the typed text. Strip
	// the background so the input line stays a clean
	// `> cursor` row matching the surrounding transcript.
	inputStyles.Focused.CursorLine = lipgloss.NewStyle()
	inputStyles.Blurred.CursorLine = lipgloss.NewStyle()
	inputStyles.Focused.Placeholder = mutedStyle
	inputStyles.Blurred.Placeholder = mutedStyle
	inputStyles.Focused.Prompt = statusStyle
	inputStyles.Blurred.Prompt = mutedStyle
	inputStyles.Focused.Text = focusedLineStyle
	inputStyles.Blurred.Text = mutedStyle
	input.SetStyles(inputStyles)
	input.SetWidth(80)
	input.SetHeight(inputMinHeight)

	vp := viewport.New(viewport.WithWidth(80), viewport.WithHeight(20))
	vp.FillHeight = true
	vp.MouseWheelDelta = mouseWheelStepLines

	spin := spinner.New()
	spin.Spinner = spinner.Dot
	spin.Style = statusStyle

	gSpin := newGradientSpinner()

	graceQuiet := 200 * time.Millisecond
	graceMax := 1500 * time.Millisecond
	if flag.Lookup("test.v") != nil || os.Getenv("BABEL_O_RUN_GO_TUI_SMOKE") != "" {
		graceQuiet = 0
		graceMax = 0
	}

	m := model{
		cfg:                       cfg,
		input:                     input,
		viewport:                  vp,
		spinner:                   spin,
		gradientSpinner:           gSpin,
		inputMode:                 modeComposing,
		transcript:                []*transcriptItem{},
		recentPermissionRules:     map[string]permissionRuleSeen{},
		trustedPermissionSessions: map[string]struct{}{},
		seenInboxCardMessageIDs:   map[string]struct{}{},
		subAgents:                 map[string]subAgentEntry{},
		pastedTextReplacements:    make(map[string]string),
		pastedTextCounter:         0,
		historyIndex:              -1,
		graceQuietPeriod:          graceQuiet,
		graceMaxDelay:             graceMax,
	}
	if width, height, err := term.GetSize(os.Stdout.Fd()); err == nil && width > 0 && height > 0 {
		m.width = width
		m.height = height
		m.resize()
		m.refreshViewport()
	}
	return m
}

func (m model) Init() tea.Cmd {
	return tea.Batch(
		textarea.Blink,
		m.spinner.Tick,
		fetchRuntimeConfig(m.cfg, 0),
		fetchRuntimeProfiles(m.cfg),
		m.schedulePollTick(),
		// Phase 8 PR1: fire a one-shot /v1/runtime/version
		// check at startup. The handler compares our
		// major against the server's supportedMajors list
		// and surfaces a friendly warning when they don't
		// match. Major mismatch on a "dev" build is
		// silently ignored.
		checkRuntimeVersion(m.cfg),
		fetchToolAudit(m.cfg, "auto"),
	)
}

// schedulePollTick arms the next background /v1/runtime/config
// poll, when --poll-interval-ms is non-zero. The returned cmd emits a
// pollTickMsg after the configured interval; the handler then re-arms
// itself so polling continues until the model is destroyed.
func (m model) schedulePollTick() tea.Cmd {
	if m.cfg.PollIntervalMs <= 0 {
		return nil
	}
	d := time.Duration(m.cfg.PollIntervalMs) * time.Millisecond
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

	case tea.KeyboardEnhancementsMsg:
		if msg.SupportsKeyDisambiguation() {
			m.input.KeyMap.InsertNewline.SetHelp("shift+enter", "newline")
		}
		return m, nil

	case tea.PasteMsg:
		if m.inputMode == modeModelPickApiKey {
			m.handlePaste(msg.Content)
		} else if m.inputMode.canReceiveTextInput() {
			m.handlePaste(msg.Content)
		}
		return m, nil

	case tea.MouseClickMsg:
		if !m.cfg.MouseCapture {
			return m, nil
		}
		mouse := msg.Mouse()
		if mouse.Button == tea.MouseLeft {
			return m.handleSelectionMouse(selectionMouseEvent{
				action: selectionMousePress,
				x:      mouse.X,
				y:      mouse.Y,
			})
		}
		return m, nil

	case tea.MouseMotionMsg:
		if !m.cfg.MouseCapture {
			return m, nil
		}
		mouse := msg.Mouse()
		if flag.Lookup("test.v") == nil {
			now := time.Now()
			if now.Sub(m.lastMouseEventTime) < mouseEventThrottle {
				return m, nil
			}
			m.lastMouseEventTime = now
		}
		if mouse.Button == tea.MouseLeft {
			return m.handleSelectionMouse(selectionMouseEvent{
				action: selectionMouseMotion,
				x:      mouse.X,
				y:      mouse.Y,
			})
		}
		return m, nil

	case tea.MouseReleaseMsg:
		if !m.cfg.MouseCapture {
			return m, nil
		}
		mouse := msg.Mouse()
		if mouse.Button == tea.MouseLeft {
			return m.handleSelectionMouse(selectionMouseEvent{
				action: selectionMouseRelease,
				x:      mouse.X,
				y:      mouse.Y,
			})
		}
		return m, nil

	case tea.MouseWheelMsg:
		if !m.cfg.MouseCapture {
			return m, nil
		}
		m.handleMouseWheel(msg.Mouse())
		return m, nil

	case tea.KeyPressMsg:
		if m.inputMode == modePermission && m.inPermissionGracePeriod() {
			m.permissionLastInputAt = time.Now()
			return m, nil
		}

		key := msg.String()
		if handled := m.handleMouseEscapeString(key); handled {
			return m, nil
		}

		if m.running && m.inputMode == modeComposing && key == "esc" {
			if m.interruptionPromptActive {
				return m, m.cancelRunningStream("")
			}
			m.openInterruptionPrompt()
			return m, nil
		}

		if !m.running {
			if cmd, handled := m.dispatchCommandShortcut(msg); handled {
				return m, cmd
			}
		}

		// `ctrl+c` is global: open a confirmation overlay, even
		// from inside another overlay. `q` only quits when the
		// input box is empty AND we're not in an overlay (so q
		// inside permission / help doesn't quit by accident).
		if key == "ctrl+c" {
			m.quitChoice = 1
			m.setMode(modeQuitConfirm)
			m.resize()
			return m, nil
		}
		if key == "ctrl+d" {
			m.topCardOpen = !m.topCardOpen
			m.resize()
			return m, nil
		}
		if key == "q" && m.inputMode == modeComposing && !m.running && strings.TrimSpace(m.input.Value()) == "" {
			return m, tea.Quit
		}

		// Prompt history: when the user is composing and the
		// input is single-line, up/down walks the per-session
		// promptHistory instead of scrolling the viewport
		// (the textarea.Model would otherwise consume the
		// up/down as multi-line cursor moves). Down past
		// the bottom restores the live draft.
		if m.inputMode == modeComposing {
			if key == "ctrl+p" && strings.TrimSpace(m.input.Value()) == "" {
				m.paletteFilter = ""
				m.paletteSelected = 0
				m.setMode(modeSlashPick)
				m.resize()
				return m, nil
			}
			if isInputNewlineKeyMsg(msg) {
				m.insertInputNewline()
				return m, nil
			}
			if key == "up" {
				if len(m.promptHistory) > 0 && m.historyIndex < len(m.promptHistory)-1 {
					if m.historyIndex == -1 {
						m.historySaved = m.input.Value()
					}
					m.historyIndex++
					m.setInputValue(m.promptHistory[len(m.promptHistory)-1-m.historyIndex])
					return m, nil
				}
				return m, nil
			}
			if key == "down" {
				if m.historyIndex > -1 {
					m.historyIndex--
					if m.historyIndex == -1 {
						m.setInputValue(m.historySaved)
					} else {
						m.setInputValue(m.promptHistory[len(m.promptHistory)-1-m.historyIndex])
					}
					return m, nil
				}
				return m, nil
			}
			// Phase 10: PgUp / PgDn page-scroll the transcript
			// viewport in composing mode. They were already
			// handled by the viewport itself via Update, but
			// we intercept them here so the textinput never
			// sees them (single-line input can't really act
			// on them, but we keep the single-input-owner
			// invariant explicit).
			if key == "pgup" {
				m.viewport.PageUp()
				return m, nil
			}
			if key == "pgdown" {
				m.viewport.PageDown()
				return m, nil
			}
		}

		// Phase 3 single-input-owner: dispatch by current mode.
		switch m.inputMode {
		case modePermission:
			// Phase A.1 of the enhanced permission panel: 5-option
			// routing. 1-5 jump straight to the corresponding
			// choice; ↑/↓ move the cursor (0..4, wrapping); enter
			// confirms the current cursor; esc cancels (treated
			// as "Reject" without feedback, matching the prior
			// r/n/esc behaviour for operators who just want out).
			// The legacy a/y/r/n shortcuts are kept as aliases
			// of option 1 (a/y) and option 4 (r/n) so muscle
			// memory from the old single-button panel still works.
			//
			// Round 2: option 3 ("Approve with editable rule")
			// and option 5 ("Reject, tell the model what to do
			// instead") no longer jump-and-confirm — they open
			// an inline textinput so the operator can edit the
			// rule / type feedback before confirming. The text
			// editor is reached via `enter` on the matching
			// cursor position as well as the dedicated number
			// keys 3 and 5.
			switch strings.ToLower(key) {
			case "1":
				m.confirmPermissionChoice()
				return m, nil
			case "2":
				m.permissionChoice = 1
				m.confirmPermissionChoice()
				return m, nil
			case "3":
				// Round 2: open the inline rule editor
				// pre-filled with the runtime-suggested rule.
				m.enterPermissionRuleEditor()
				return m, nil
			case "4":
				m.permissionChoice = 3
				m.confirmPermissionChoice()
				return m, nil
			case "5":
				// Round 2: open the inline feedback editor
				// (textinput starts empty).
				m.enterPermissionFeedbackEditor()
				return m, nil
			case "a", "y":
				// Legacy "approve" shortcut → option 1.
				m.permissionChoice = 0
				m.confirmPermissionChoice()
				return m, nil
			case "r", "n":
				// Legacy "reject" shortcut → option 4.
				m.permissionChoice = 3
				m.confirmPermissionChoice()
				return m, nil
			case "up", "k":
				m.permissionChoice = (m.permissionChoice + 4) % 5
				return m, nil
			case "down", "j":
				m.permissionChoice = (m.permissionChoice + 1) % 5
				return m, nil
			case "enter":
				// Enter on option 2 or 3 opens the rule
				// editor instead of confirming; everything
				// else confirms directly.
				if m.permissionChoice == 2 {
					m.enterPermissionRuleEditor()
					return m, nil
				}
				if m.permissionChoice == 4 {
					m.enterPermissionFeedbackEditor()
					return m, nil
				}
				m.confirmPermissionChoice()
				return m, nil
			case "esc":
				// Cancel = reject without feedback. The legacy
				// "esc rejects" semantics for operators who just
				// want to close the panel are preserved exactly.
				m.sendPermissionDecision(false, "Cancelled from Go TUI", "", "", "")
				return m, nil
			}
			// While the permission panel is up, any other key is
			// swallowed: textinput must NOT receive it, or it would
			// insert characters into the input box under the panel.
			return m, nil

		case modePermissionEditRule, modePermissionEditFeedback:
			// Round 2: the textinput is the focus. Esc returns
			// to the 5-option panel (does NOT reject); Enter
			// confirms with the edited rule / typed feedback.
			// All other keys fall through to the bottom of
			// Update() where m.input.Update(msg) handles them.
			switch strings.ToLower(key) {
			case "esc":
				m.exitPermissionEditor(false)
				return m, nil
			case "enter":
				m.exitPermissionEditor(true)
				return m, nil
			}
			// Let textinput handle the rest (char insert, cursor
			// moves, backspace, word jumps, etc.). We do NOT
			// re-render the panel header here — the overlay
			// renderer in `View` reads `m.inputMode` and draws
			// the editor prompt itself.
			return m, m.updateInput(msg)

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
				m.setInputValue("")
				m.paletteFilter = ""
				m.paletteSelected = 0
				m.setMode(modeComposing)
				m.resize()
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
					m.setInputValue("")
					m.setMode(modeComposing)
					m.resize()
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

		case modeQuitConfirm:
			// Quit confirmation mirrors Crush-style choice panels:
			// up/down toggles the selected action, enter confirms
			// the current row, and esc cancels. y/n remain accepted
			// as compatibility shortcuts.
			switch strings.ToLower(key) {
			case "up", "down", "tab", "shift+tab":
				if m.quitChoice == 0 {
					m.quitChoice = 1
				} else {
					m.quitChoice = 0
				}
			case "y":
				m.quitChoice = 0
				return m, tea.Quit
			case "enter":
				if m.quitChoice == 0 {
					return m, tea.Quit
				}
				m.setMode(modeComposing)
				m.appendLine("status", "quit cancelled")
				m.resize()
				return m, nil
			case "n", "esc":
				m.quitChoice = 1
				m.setMode(modeComposing)
				m.appendLine("status", "quit cancelled")
				m.resize()
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

		case modeTaskBoard:
			// Read-only task board overlay (Phase 6 PR4).
			// up/k scroll back; down/j/tab scroll forward;
			// esc/enter/q close. No per-row actions yet
			// (claim / complete / fail / cancel / retry /
			// worktree-recovery are CLI-only via
			// `bbl sessions tasks <verb> <taskId>`; the Go TUI
			// stays read-only to avoid duplicating the Nexus
			// ownership surface). All other keys are swallowed
			// so they never reach the textinput.
			switch key {
			case "esc", "enter", "q":
				m.setMode(modeComposing)
				m.taskBoardScroll = 0
				m.appendLine("status", "task board closed")
				return m, nil
			case "up", "k":
				if m.taskBoardScroll > 0 {
					m.taskBoardScroll--
				}
				return m, nil
			case "down", "j", "tab":
				allLines := buildTaskBoardLines(m.taskBoard)
				maxScroll := max(0, len(allLines)-1)
				if m.taskBoardScroll < maxScroll {
					m.taskBoardScroll++
				}
				return m, nil
			}
			return m, nil

		case modeActivityOverlay:
			// Read-only recent activity overlay (Phase 6 PR5).
			// up/k scroll back; down/j/tab scroll forward;
			// esc/enter/q close. The activity buffer is
			// append-only from the WebSocket stream, so no
			// per-row actions. All other keys are swallowed
			// so they never reach the textinput.
			switch key {
			case "esc", "enter", "q":
				m.setMode(modeComposing)
				m.activityOverlayScroll = 0
				m.appendLine("status", "activity closed")
				return m, nil
			case "up", "k":
				if m.activityOverlayScroll > 0 {
					m.activityOverlayScroll--
				}
				return m, nil
			case "down", "j", "tab":
				allLines := buildActivityOverlayLines(m.activityEvents)
				maxScroll := max(0, len(allLines)-1)
				if m.activityOverlayScroll < maxScroll {
					m.activityOverlayScroll++
				}
				return m, nil
			}
			return m, nil

		case modeToolAuditOverlay:
			// Read-only /v1/tools/audit overlay (Phase 4
			// wire). up/k scroll back; down/j/tab scroll
			// forward; esc/enter/q close. No per-row actions
			// yet (the Go TUI stays read-only for the tool
			// audit to avoid duplicating the Nexus ownership
			// surface; `bbl tools audit` / `bbl tools
			// policy` are CLI-only). All other keys are
			// swallowed so they never reach the textinput.
			switch key {
			case "esc", "enter", "q":
				m.setMode(modeComposing)
				m.toolAuditScroll = 0
				m.appendLine("status", "tools audit closed")
				return m, nil
			case "up", "k":
				if m.toolAuditScroll > 0 {
					m.toolAuditScroll--
				}
				return m, nil
			case "down", "j", "tab":
				allLines := buildToolAuditOverlayLines(m.toolAuditEntries)
				maxScroll := max(0, len(allLines)-1)
				if m.toolAuditScroll < maxScroll {
					m.toolAuditScroll++
				}
				return m, nil
			}
			return m, nil

		case modeModelOverlay:
			// Read-only model configuration/catalog overlay. The
			// TypeScript TUI's /model command can write the local
			// ConfigManager after prompting for provider secrets; the
			// Go TUI stays remote-client only and shows the active
			// model/profile plus the CLI path for writes.
			switch key {
			case "esc", "enter", "q":
				m.setMode(modeComposing)
				m.modelOverlayScroll = 0
				m.appendLine("status", "model view closed")
				return m, nil
			case "up", "k":
				if m.modelOverlayScroll > 0 {
					m.modelOverlayScroll--
				}
				return m, nil
			case "down", "j", "tab":
				allLines := buildModelOverlayLines(m.modelCatalog)
				maxScroll := max(0, len(allLines)-1)
				if m.modelOverlayScroll < maxScroll {
					m.modelOverlayScroll++
				}
				return m, nil
			}
			return m, nil

		case modeSessionOverlay:
			actions := sessionPanelActions()
			switch key {
			case "esc", "q":
				m.closeSessionPanel("session panel closed")
				m.resize()
				return m, nil
			case "ctrl+p":
				return m, m.copyCurrentSessionID()
			case "up", "k", "shift+tab":
				if len(actions) > 0 {
					m.sessionPanelSelected = (m.sessionPanelSelected + len(actions) - 1) % len(actions)
				}
				return m, nil
			case "down", "j", "tab":
				if len(actions) > 0 {
					m.sessionPanelSelected = (m.sessionPanelSelected + 1) % len(actions)
				}
				return m, nil
			case "enter":
				cmd := m.enterSessionPanelSelection()
				m.resize()
				return m, cmd
			}
			return m, nil

		case modeSessionConfirm:
			switch key {
			case "esc", "q":
				m.closeSessionPanel("session panel closed")
				m.resize()
				return m, nil
			case "ctrl+p":
				return m, m.copyCurrentSessionID()
			case "up", "down", "k", "j", "tab", "shift+tab":
				return m, nil
			case "enter", "y":
				m.confirmSessionNew()
				m.resize()
				return m, nil
			case "n":
				m.closeSessionPanel("session panel closed")
				m.resize()
				return m, nil
			}
			return m, nil

		case modeSessionInput:
			switch key {
			case "esc":
				m.closeSessionPanel("session panel closed")
				m.resize()
				return m, nil
			case "ctrl+p":
				return m, m.copyCurrentSessionID()
			case "enter":
				m.applySessionInput()
				m.resize()
				return m, nil
			}
			return m, m.updateInput(msg)
		}

		// /model multi-step flow (Phase 1: hardcoded model
		// list per provider; Phase 2 will swap the picker for
		// a live API call against the freshly-entered base
		// URL).
		switch m.inputMode {
		case modeModelPickProvider:
			switch key {
			case "esc", "q":
				m.openModelRegistry()
				m.setMode(modeComposing)
				m.appendLine("status", "model registry closed")
				return m, nil
			case "up", "k":
				if m.modelPickProviderIdx > 0 {
					m.modelPickProviderIdx--
				}
				return m, nil
			case "down", "j", "tab":
				if m.modelPickProviderIdx < len(m.modelCatalog.Providers)-1 {
					m.modelPickProviderIdx++
				}
				return m, nil
			case "enter":
				if m.modelPickProviderIdx >= 0 && m.modelPickProviderIdx < len(m.modelCatalog.Providers) {
					p := m.modelCatalog.Providers[m.modelPickProviderIdx]
					m.modelPickSelectedID = p.ID
					// No-auth providers can enter the model picker
					// immediately. API-key / bearer providers always
					// show the credential step so the user can paste
					// or replace a key; if a global provider key is
					// already saved, an empty Enter keeps it.
					if p.AuthMode == "none" {
						return m, m.enterModelPicker()
					}
					m.modelPickProviderDraft = ""
					m.modelPickAPIKeyDraft = ""
					m.modelPickBaseURLDraft = ""
					m.setInputValue("")
					m.setMode(modeModelPickApiKey)
				}
				return m, nil
			}
			return m, nil

		case modeModelPickApiKey:
			switch key {
			case "esc":
				m.setMode(modeModelPickProvider)
				return m, nil
			case "enter":
				m.modelPickAPIKeyDraft = sanitizeModelAPIKeyInput(m.modelPickAPIKeyDraft)
				provider := m.currentModelProvider()
				if m.modelPickAPIKeyDraft == "" && (provider == nil || !provider.Configured) {
					m.appendLine("error", "provider API key is required before selecting this model")
					return m, nil
				}
				m.setInputValue("")
				m.setMode(modeModelPickBaseURL)
				return m, nil
			}
			if m.handleModelAPIKeyInput(msg) {
				return m, nil
			}
			return m, nil

		case modeModelPickBaseURL:
			switch key {
			case "esc":
				m.setMode(modeModelPickApiKey)
				return m, nil
			case "enter":
				// Accept the default base URL when the
				// operator pressed Enter without typing.
				typed := m.input.Value()
				provider := m.currentModelProvider()
				if typed == "" && provider != nil {
					typed = provider.DefaultBaseURL
				}
				m.modelPickBaseURLDraft = typed
				m.setInputValue("")
				m.modelPickSelectedIdx = 0
				if provider == nil {
					return m, nil
				}
				return m, saveRuntimeProviderConfig(m.cfg, provider.ID, m.modelPickAPIKeyDraft, m.modelPickBaseURLDraft)
			}
			return m, m.updateInput(msg)

		case modeModelPickModel:
			provider := m.currentModelProvider()
			total := 0
			if provider != nil {
				total = len(provider.Models)
			}
			// While the POST is in flight, lock the picker so
			// the operator can't fire a second select. Esc is
			// still allowed to abort the visible request —
			// the server-side write is fire-and-forget at that
			// point but it usually lands in <50ms anyway.
			if m.modelPickSubmitting {
				if key == "esc" {
					m.setMode(modeModelPickBaseURL)
				}
				return m, nil
			}
			switch key {
			case "esc":
				m.setMode(modeModelPickBaseURL)
				return m, nil
			case "up", "k":
				if m.modelPickSelectedIdx > 0 {
					m.modelPickSelectedIdx--
				}
				return m, nil
			case "down", "j", "tab":
				if m.modelPickSelectedIdx < total-1 {
					m.modelPickSelectedIdx++
				}
				return m, nil
			case "enter":
				if provider == nil || m.modelPickSelectedIdx < 0 || m.modelPickSelectedIdx >= len(provider.Models) {
					return m, nil
				}
				selectedModel := provider.Models[m.modelPickSelectedIdx]
				// Phase 2: persist via POST
				// /v1/runtime/config/select {model: ...}.
				// selectedModel.ID is already in canonical
				// `provider/model` form (the Go TUI only
				// sees model ids in the catalog response,
				// which are canonical), so we can pass it
				// through without further munging.
				m.modelPickSubmitting = true
				m.appendLine("status", fmt.Sprintf("saving model: %s (provider %s)…", selectedModel.ID, provider.ID))
				return m, selectRuntimeModel(m.cfg, selectedModel.ID)
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
			m.resize()
			return m, nil
		}

		if key == "enter" {
			return m, m.submitPrompt(m.input.Value(), true)
		}

	default:
		if m.inputMode.canReceiveTextInput() && m.handleUnknownCSIMessage(fmt.Sprint(msg)) {
			return m, nil
		}

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	case gradientSpinnerTickMsg:
		if !m.running {
			return m, nil
		}
		var cmd tea.Cmd
		m.gradientSpinner, cmd = m.gradientSpinner.Update(msg)
		return m, cmd

	case streamStartedMsg:
		m.events = msg.events
		m.decisions = msg.decisions
		m.streamCancel = msg.cancel
		if msg.sessionID != "" {
			m.sessionID = msg.sessionID
			m.cfg.SessionID = msg.sessionID
		}
		// Drop the "stream started" status line: the spinning
		// `running` indicator in the header already shows that
		// the WebSocket is up, and an extra transcript row for
		// every turn adds noise without information.
		return m, waitForStreamEvent(msg.events)

	case streamEventMsg:
		if msg.event.err != nil {
			if m.cancelRequested {
				m.appendLine("status", "current agent run cancelled")
				return m, m.finishRunningStream()
			}
			m.appendLine("error", msg.event.err.Error())
			m.queuedPrompt = ""
			return m, m.finishRunningStream()
		}
		eventType := stringField(msg.event.payload, "type")
		eventCmd := m.consumeNexusEvent(msg.event.payload)
		if m.running {
			return m, tea.Batch(waitForStreamEvent(m.events), eventCmd)
		}
		if eventType == "result" || eventType == "error" {
			return m, tea.Batch(eventCmd, m.finishRunningStream())
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
		// Skip the "profiles: none" status line when the catalog
		// is empty: an empty list is the steady state and
		// informing the operator about it on every config poll
		// clutters the chat. The /profile slash command still
		// surfaces the full list (or absence) on demand.
		if rendered := formatRuntimeProfiles(msg.response); rendered != "" && !strings.HasSuffix(rendered, ": none") {
			m.appendLine("status", rendered)
		}
		return m, m.schedulePollTick()

	case runtimeModelsMsg:
		if msg.err != nil {
			m.appendLine("error", "models: "+msg.err.Error())
			// Even on failure, the Step 4 picker can fall
			// back to the hardcoded catalog that was
			// already loaded; clear the loading flag so
			// the picker shows that fallback list instead
			// of a perpetual spinner.
			if msg.trigger == "model-picker" {
				m.modelPickerLoading = false
			}
			return m, nil
		}
		m.modelCatalog = msg.response
		if msg.trigger == "model" {
			// /model flow: open the interactive registry
			// now that the catalog is in hand.
			m.openModelRegistry()
			return m, nil
		}
		if msg.trigger == "model-picker" {
			// Re-fetch landing inside Step 4: filter the
			// refreshed catalog down to the picked
			// provider, store as the live picker list, and
			// clear the loading flag.
			for _, p := range msg.response.Providers {
				if p.ID == m.modelPickSelectedID {
					m.modelPickerLive = p.Models
					break
				}
			}
			m.modelPickerLoading = false
			return m, nil
		}
		for _, line := range formatRuntimeModels(msg.response) {
			m.appendLine("status", line)
		}
		return m, nil

	case runtimeVersionMsg:
		// Phase 8 PR1: startup version-compat sanity check.
		// A failed fetch is NOT a hard error — the Nexus
		// may still be booting, or the user is on a stale
		// build that doesn't know about the endpoint. We
		// silently no-op on error and let the existing
		// runtimeConfigMsg path surface the underlying
		// health. A successful response is compared against
		// our own major; mismatch surfaces a warning line.
		if msg.err != nil {
			return m, nil
		}
		if !isGoTuiMajorCompatible(msg.envelope.GoTuiCompatibility.SupportedMajors) {
			banner := fmt.Sprintf(
				"Go TUI major version mismatch: local=%s, server supports majors %v (latest=%s). "+
					"Upgrade the Go TUI binary or downgrade the Nexus server.",
				Version, msg.envelope.GoTuiCompatibility.SupportedMajors,
				msg.envelope.GoTuiCompatibility.LatestSupported,
			)
			m.appendLine("error", banner)
		}
		return m, nil

	case profileSelectMsg:
		if msg.err != nil {
			m.appendLine("error", msg.err.Error())
			return m, nil
		}
		m.applyRuntimeConfig(msg.config)
		m.appendLine("status", "profile switched: "+firstNonEmpty(msg.config.ActiveProfile, msg.profile))
		return m, fetchRuntimeProfiles(m.cfg)

	case modelSelectMsg:
		// Clear the in-flight flag in both success and
		// failure paths so the picker is operable again.
		m.modelPickSubmitting = false
		if msg.err != nil {
			m.appendLine("error", "model select: "+msg.err.Error())
			// Keep the operator in the picker so they can
			// pick a different model or esc back.
			return m, nil
		}
		m.applyRuntimeConfig(msg.config)
		// Prefer the resolved model's display name when the
		// Nexus side provides one (e.g. "Claude 3.5 Sonnet");
		// fall back to the bare model id we sent.
		display := firstNonEmpty(msg.config.ModelName, msg.modelID)
		m.appendLine("status", fmt.Sprintf("model saved: %s → %s (provider %s)", display, msg.config.ModelID, firstNonEmpty(msg.config.ProviderID, "?")))
		// Return the operator to composing and reset the
		// picker's per-session state so a fresh /model
		// invocation starts from the provider list, not
		// from wherever they left the previous pick.
		m.modelPickSelectedIdx = 0
		m.modelPickSelectedID = ""
		m.modelPickProviderIdx = 0
		m.modelPickProviderDraft = ""
		m.modelPickAPIKeyDraft = ""
		m.modelPickBaseURLDraft = ""
		m.modelPickerLive = nil
		m.setMode(modeComposing)
		return m, nil

	case providerConfigMsg:
		if msg.err != nil {
			m.appendLine("error", "provider config: "+msg.err.Error())
			m.setMode(modeModelPickBaseURL)
			return m, nil
		}
		m.applyRuntimeConfig(msg.config)
		for i := range m.modelCatalog.Providers {
			if m.modelCatalog.Providers[i].ID == msg.providerID {
				m.modelCatalog.Providers[i].Configured = true
				break
			}
		}
		m.appendLine("status", "provider configured: "+msg.providerID)
		return m, m.enterModelPicker()

	case contextAnalysisMsg:
		if msg.err != nil {
			m.appendLine("error", "context: "+msg.err.Error())
			return m, nil
		}
		m.contextOverlayLines = buildContextOverlayLines(msg.raw)
		m.contextOverlayScroll = 0
		m.setMode(modeContextOverlay)
		m.resize()
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

	case tasksListMsg:
		if msg.err != nil {
			m.appendLine("error", "tasks: "+msg.err.Error())
			return m, nil
		}
		m.taskBoard = msg.envelope.Tasks
		if msg.trigger == "auto" {
			// Phase 6 PR4 end-of-turn auto-refresh: update the
			// snapshot silently. Do NOT open the overlay.
			return m, nil
		}
		// User-initiated /tasks: reset scroll + push breadcrumb
		// + open the overlay.
		m.taskBoardScroll = 0
		summary := fmt.Sprintf("tasks: %d task(s)", len(m.taskBoard))
		m.appendLine("status", summary)
		m.setMode(modeTaskBoard)
		return m, nil

	case memoryStatusMsg:
		if msg.err != nil {
			m.appendLine("error", "memory: "+msg.err.Error())
			return m, nil
		}
		m.memoryOverlayLines = buildMemoryOverlayLines(msg.raw)
		m.memoryOverlayScroll = 0
		m.appendLine("status", "memory status loaded")
		m.setMode(modeMemoryOverlay)
		return m, nil

	case toolAuditMsg:
		if msg.err != nil {
			if msg.trigger == "auto" {
				return m, nil
			}
			// Phase 4 wire: on Nexus HTTP failure, fall back
			// to the static catalog so the user still sees a
			// known-good tool list. The error line stays in
			// the transcript so the user can see why the wire
			// failed (and the static catalog gets pushed via
			// the existing renderToolPalette path so the
			// transcript shows BOTH the error + the fallback).
			m.appendLine("error", "tools audit: "+msg.err.Error())
			tools := staticToolDescriptorCatalog()
			m.renderToolPalette(tools)
			return m, nil
		}
		m.toolAuditEntries = msg.envelope.Tools
		if msg.trigger == "auto" {
			// Future: end-of-turn auto-refresh. Currently
			// no caller fires "auto" — /tools is always
			// user-initiated.
			return m, nil
		}
		// User-initiated /tools: reset scroll + push
		// breadcrumb + open the overlay.
		m.toolAuditScroll = 0
		summary := fmt.Sprintf("tools audit: %d tool(s)", len(m.toolAuditEntries))
		m.appendLine("status", summary)
		m.setMode(modeToolAuditOverlay)
		return m, nil

	case pollTickMsg:
		// Background poll. If we've never fetched a Config, defer to the
		// next round rather than blocking the chat loop.
		if m.configVersion <= 0 {
			return m, m.schedulePollTick()
		}
		return m, fetchRuntimeConfig(m.cfg, m.configVersion)

	case streamClosedMsg:
		// Drop the "stream closed" status line to mirror the
		// "stream started" removal above; the running indicator
		// in the header is the canonical source of truth for
		// stream liveness.
		return m, m.finishRunningStream()

	case streamCancelMsg:
		if msg.err != nil {
			m.appendLine("error", "cancel current run: "+msg.err.Error())
			return m, nil
		}
		return m, nil

	case copyToastExpiredMsg:
		if !m.copyToastShownAt.IsZero() && m.copyToastShownAt.Equal(msg.copiedAt) {
			m.copyToastMessage = ""
			m.copyToastShownAt = time.Time{}
		}
		return m, nil

	case selectionHighlightExpiredMsg:
		if !m.lastSelectionCopyAt.IsZero() && m.lastSelectionCopyAt.Equal(msg.copiedAt) &&
			m.selectionActive &&
			m.selectionStartLine == msg.startLine &&
			m.selectionStartCol == msg.startCol &&
			m.selectionEndLine == msg.endLine &&
			m.selectionEndCol == msg.endCol {
			m.clearSelection()
		}
		return m, nil
	}

	if m.inputMode.canReceiveTextInput() {
		if m.inputMode == modeModelPickApiKey {
			return m, nil
		}
		return m, m.updateInput(msg)
	}
	return m, nil
}

func (m *model) resize() {
	width := max(40, m.width)
	m.input.SetWidth(max(20, width-4))
	m.syncInputHeight()
	// Cap at maxTranscriptWidth so very wide terminals (4K) don't
	// stretch the prose to unreadable line lengths; header / footer
	// / input still use the full terminal width because their
	// content is short.
	m.viewport.SetWidth(max(20, min(width, maxTranscriptWidth)))
	if m.height <= 0 {
		return
	}
	if m.usesFullScreenOverlay() {
		m.viewport.SetHeight(0)
		return
	}
	chromeHeight := m.nonTranscriptChromeHeight(width)
	if m.topCardOpen {
		m.viewport.SetHeight(max(0, m.height-chromeHeight))
		return
	}
	m.viewport.SetHeight(max(0, m.height-chromeHeight))
}

func (m model) nonTranscriptChromeHeight(width int) int {
	if m.topCardOpen {
		parts := []string{m.renderHeader(width), m.renderTopCard(width), m.renderFooter(width)}
		height := 0
		for _, part := range parts {
			height += lipgloss.Height(part)
		}
		return height + max(0, len(parts)-1)
	}
	parts := []string{m.renderHeader(width)}
	if topCard := m.renderTopCard(width); topCard != "" {
		parts = append(parts, topCard)
	}
	for _, part := range []string{
		m.renderPermission(width),
		m.renderPermissionEditor(width),
		m.renderHelp(width),
		m.renderProfileConfirm(width),
		m.renderInboxOverlay(width),
		m.renderAgentOverlay(width),
		m.renderTaskBoard(width),
		m.renderActivityOverlay(width),
		m.renderMemoryOverlay(width),
		m.renderToolAuditOverlay(width),
		m.renderModelOverlay(width),
		m.renderModelPickProvider(width),
		m.renderModelPickApiKey(width),
		m.renderModelPickBaseURL(width),
		m.renderModelPickModel(width),
		m.renderQuitConfirm(width),
	} {
		if part != "" {
			parts = append(parts, part)
		}
	}
	parts = append(parts, m.renderComposerStack(width), m.renderFooter(width))
	height := 0
	for _, part := range parts {
		height += lipgloss.Height(part)
	}
	return height
}

func (m model) viewString() string {
	width := max(40, m.width)
	header := m.renderHeader(width)
	topCard := m.renderTopCard(width)
	if topCard != "" {
		return strings.Join([]string{header, topCard, m.renderFooter(width)}, "\n")
	}
	if m.usesFullScreenOverlay() {
		overlay := m.renderFullScreenOverlay(width)
		if overlay == "" {
			return header
		}
		return padViewHeight(strings.Join([]string{header, overlay}, "\n"), m.height)
	}
	transcript := m.highlightedViewportView()
	permission := m.renderPermission(width)
	permissionEditor := m.renderPermissionEditor(width)
	composer := m.renderComposerStack(width)
	footer := m.renderFooter(width)
	help := m.renderHelp(width)
	profileConfirm := m.renderProfileConfirm(width)
	inboxOverlay := m.renderInboxOverlay(width)
	agentOverlay := m.renderAgentOverlay(width)
	taskBoard := m.renderTaskBoard(width)
	activityOverlay := m.renderActivityOverlay(width)
	memoryOverlay := m.renderMemoryOverlay(width)
	toolAuditOverlay := m.renderToolAuditOverlay(width)
	modelOverlay := m.renderModelOverlay(width)
	modelPickProvider := m.renderModelPickProvider(width)
	modelPickApiKey := m.renderModelPickApiKey(width)
	modelPickBaseURL := m.renderModelPickBaseURL(width)
	modelPickModel := m.renderModelPickModel(width)
	quitConfirm := m.renderQuitConfirm(width)

	parts := []string{header, transcript}
	if permission != "" {
		parts = append(parts, permission)
	}
	if permissionEditor != "" {
		parts = append(parts, permissionEditor)
	}
	if help != "" {
		parts = append(parts, help)
	}
	if profileConfirm != "" {
		parts = append(parts, profileConfirm)
	}
	if inboxOverlay != "" {
		parts = append(parts, inboxOverlay)
	}
	if agentOverlay != "" {
		parts = append(parts, agentOverlay)
	}
	if taskBoard != "" {
		parts = append(parts, taskBoard)
	}
	if activityOverlay != "" {
		parts = append(parts, activityOverlay)
	}
	if memoryOverlay != "" {
		parts = append(parts, memoryOverlay)
	}
	if toolAuditOverlay != "" {
		parts = append(parts, toolAuditOverlay)
	}
	if modelOverlay != "" {
		parts = append(parts, modelOverlay)
	}
	if modelPickProvider != "" {
		parts = append(parts, modelPickProvider)
	}
	if modelPickApiKey != "" {
		parts = append(parts, modelPickApiKey)
	}
	if modelPickBaseURL != "" {
		parts = append(parts, modelPickBaseURL)
	}
	if modelPickModel != "" {
		parts = append(parts, modelPickModel)
	}
	if quitConfirm != "" {
		parts = append(parts, quitConfirm)
	}
	parts = append(parts, composer, footer)
	return strings.Join(parts, "\n")
}

func (m model) usesFullScreenOverlay() bool {
	switch m.inputMode {
	case modeHelpOverlay,
		modeContextOverlay,
		modeInboxOverlay,
		modeAgentOverlay,
		modeTaskBoard,
		modeActivityOverlay,
		modeMemoryOverlay,
		modeToolAuditOverlay,
		modeModelOverlay,
		modeModelPickProvider,
		modeModelPickApiKey,
		modeModelPickBaseURL,
		modeModelPickModel:
		return true
	default:
		return false
	}
}

func (m model) renderFullScreenOverlay(width int) string {
	for _, part := range []string{
		m.renderHelp(width),
		m.renderContextOverlay(width),
		m.renderInboxOverlay(width),
		m.renderAgentOverlay(width),
		m.renderTaskBoard(width),
		m.renderActivityOverlay(width),
		m.renderMemoryOverlay(width),
		m.renderToolAuditOverlay(width),
		m.renderModelOverlay(width),
		m.renderModelPickProvider(width),
		m.renderModelPickApiKey(width),
		m.renderModelPickBaseURL(width),
		m.renderModelPickModel(width),
	} {
		if part != "" {
			return part
		}
	}
	return ""
}

func padViewHeight(view string, height int) string {
	if height <= 0 {
		return view
	}
	missing := height - lipgloss.Height(view)
	if missing <= 0 {
		return view
	}
	lines := make([]string, missing)
	for i := range lines {
		lines[i] = " "
	}
	return view + "\n" + strings.Join(lines, "\n")
}

func (m model) View() tea.View {
	view := tea.NewView(m.viewString())
	if m.cfg.AltScreen {
		view.AltScreen = true
	}
	if m.cfg.MouseCapture {
		view.MouseMode = tea.MouseModeCellMotion
	}
	view.KeyboardEnhancements.ReportAlternateKeys = true
	view.KeyboardEnhancements.ReportAllKeysAsEscapeCodes = false
	return view
}

var helpOverlayLines = []string{
	"BabeL-O Go TUI · Local key reference",
	"",
	"Composing:",
	"  enter            submit the current prompt",
	"  /                (followed by command) open slash palette (one-shot)",
	"  ?  (empty input) toggle this help overlay",
	"  ctrl+d           toggle the top context card",
	"  ctrl+c           open quit confirmation",
	"  q                quit when input is empty",
	"  up / down        walk per-session prompt history (single-line input)",
	"  pgup / pgdown    page-scroll the transcript viewport",
	"  mouse wheel      smooth-scroll the transcript viewport in",
	"                   composing, or the active overlay's internal",
	"                   scroll/selection (help / context / inbox /",
	"                   agents / tasks / activity / tools / model /",
	"                   permission ring)",
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
	"  /model [id]      open model config view, or show CLI set hint",
	"  /models          print model capability matrix",
	"",
	"Profile confirm overlay:",
	"  y / enter        confirm the pending profile switch",
	"  n / esc          cancel and stay on the current profile",
	"",
	"Context overlay:",
	"  up / down / tab  scroll through the context analysis",
	"  esc / enter / q  close the overlay",
	"",
	"Inbox overlay:",
	"  /inbox           open SessionChannel inbox (unread-only)",
	"  /inbox all       include acknowledged messages",
	"  /inbox ack <id>  acknowledge a single message",
	"  up / down / tab  move selection through the message list",
	"  a                ack the selected message",
	"  q / c            quote the selected message into the prompt",
	"  esc / enter      close the overlay",
	"",
	"Agent status overlay:",
	"  /agents          open multi-agent status for the current session",
	"  up / down / tab  scroll through the agent jobs list",
	"  esc / enter / q  close the overlay",
	"",
	"Task board overlay:",
	"  /tasks           open task board for the current session",
	"  up / down / tab  scroll through the task list",
	"  esc / enter / q  close the overlay",
	"",
	"Recent activity overlay:",
	"  /activity        open recent activity (tool runs, permission,",
	"                   agent job events, context warnings)",
	"  up / down / tab  scroll through the recent events",
	"  esc / enter / q  close the overlay",
	"",
	"Tool audit overlay:",
	"  /tool, /tools    open /v1/tools/audit (real Nexus wire;",
	"                   static fallback if the endpoint is down)",
	"  up / down / tab  scroll through the tool entries",
	"  esc / enter / q  close the overlay",
	"",
	"Model config overlay:",
	"  /model           open the shared Nexus model/config view",
	"  /model <id>      show the CLI-only set-model command",
	"  up / down / tab  scroll through provider/model rows",
	"  esc / enter / q  close the overlay",
	"",
	"Session control overlay:",
	"  /session         open session operations",
	"  /session new     create a fresh session on the next prompt",
	"  /session use <id> switch directly to an existing session",
	"  up / down / tab  move through session operations",
	"  enter            open or confirm the selected operation",
	"  esc              close the overlay",
	"",
	"Press esc / enter / q to close.",
}

func (m model) renderHelp(width int) string {
	if m.inputMode != modeHelpOverlay {
		return ""
	}
	// Phase C.2: structure migration to the Dialog system.
	// helpDialog.View produces the same layout as the pre-migration
	// inline rendering (title + divider + visible window, all
	// wrapped in overlayFrameStyle). Existing key handling stays in
	// the modeHelpOverlay case of Update — see help_dialog.go for
	// the migration rationale.
	return newHelpDialog(m.helpScroll, m.height).View(width)
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
	return renderOverlayFrame(width, confirmStyle.Render(wrapPlain(body, max(0, width-2))))
}

// renderQuitConfirm paints the confirmation overlay shown during quit.
func (m model) renderQuitConfirm(width int) string {
	if m.inputMode != modeQuitConfirm {
		return ""
	}
	return newQuitDialog(m.quitChoice).View(width)
}

func (m *model) applyRuntimeConfig(config runtimeConfig) {
	if config.ModelID != "" {
		m.modelID = config.ModelID
	}
	if config.ContextWindow > 0 {
		m.contextWindow = config.ContextWindow
	}
	m.providerID = config.ProviderID
	m.authMode = config.AuthMode
	m.hasAPIKey = config.HasAPIKey
	m.activeProfile = config.ActiveProfile
	if config.Version > 0 {
		m.configVersion = config.Version
	}
	m.tombstoneCount = len(config.Tombstones)
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
	m.setInputValue(quote)
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

// fetchSessionTasksWithSession is the gated entry point the
// /tasks slash command uses. Mirrors fetchSessionAgentsWithSession
// — active session required, "user" trigger so the overlay
// opens on response.
func (m *model) fetchSessionTasksWithSession() tea.Cmd {
	if m.sessionID == "" {
		m.appendLine("status", "tasks: no active session yet — submit a prompt first")
		return nil
	}
	m.appendLine("status", "loading shared Nexus tasks: "+shortID(m.sessionID))
	return fetchSessionTasks(m.cfg, m.sessionID, "user")
}

// consumeNexusEvent applies a single Nexus event to the model and
// optionally returns a follow-up tea.Cmd. The Phase 6 PR2
// auto-refresh hook uses this return value to fire an inbox
// re-fetch at the end of every turn (the cmd is nil for events
// that don't need a follow-up).
func (m *model) consumeNexusEvent(event map[string]any) tea.Cmd {
	eventType := stringField(event, "type")
	if shouldSuppressTranscriptEvent(eventType) {
		m.recordSuppressedNexusEvent(event)
		m.lastEventType = eventType
		return nil
	}
	if shouldSuppressInternalStatusEvent(event) {
		m.recordSuppressedNexusEvent(event)
		m.lastEventType = eventType
		return nil
	}
	switch eventType {
	case "session_started":
		m.sessionID = stringField(event, "sessionId")
		m.modelID = stringField(event, "model")
		// Mark the Go TUI as connected to Nexus so the header
		// can render a `✓` indicator next to the title; the old
		// status lines lived in the initial transcript but
		// cluttered the chat log without adding information the
		// operator can't already see from the header chrome.
		// session_started is intentionally NOT appended to the
		// transcript anymore: the header slimmed line already
		// shows `session=sess_...` and the model is visible
		// in the title state, so the standalone row is noise.
		m.connected = true
	case "permission_request":
		sessionID := stringField(event, "sessionId")
		scopeRisk := strings.TrimSpace(stringField(event, "scopeRisk"))
		if scopeRisk == "none" {
			scopeRisk = ""
		}
		if scopeRisk == "" && m.isPermissionSessionTrusted(sessionID) {
			m.pending = &pendingPermission{
				sessionID: sessionID,
				toolUseID: stringField(event, "toolUseId"),
				name:      stringField(event, "name"),
				risk:      stringField(event, "risk"),
				input:     formatToolInput(stringField(event, "name"), event["input"]),
				message:   stringField(event, "message"),
			}
			if m.sendPermissionDecision(true, "Approved from trusted Go TUI session", "session", strings.TrimSpace(stringField(event, "suggestedRule")), "") {
				return nil
			}
			m.pending = nil
		}
		suggestedRule := strings.TrimSpace(stringField(event, "suggestedRule"))
		repeatedRuleCount := m.recordPermissionRuleSeen(suggestedRule, time.Now())
		m.pending = &pendingPermission{
			sessionID:         sessionID,
			toolUseID:         stringField(event, "toolUseId"),
			name:              stringField(event, "name"),
			risk:              stringField(event, "risk"),
			input:             formatToolInput(stringField(event, "name"), event["input"]),
			message:           stringField(event, "message"),
			scopeRisk:         scopeRisk,
			targetRoot:        stringField(event, "targetRoot"),
			taskPrimaryRoot:   stringField(event, "taskPrimaryRoot"),
			scopeReason:       stringField(event, "scopeReason"),
			suggestedRule:     suggestedRule,
			repeatedRuleCount: repeatedRuleCount,
		}
		// Reset the cursor to the safe default ("Approve once")
		// on every fresh permission request so a stale cursor
		// from the previous prompt can't accidentally confirm
		// the wrong option (e.g. session scope on a destructive
		// command).
		m.permissionChoice = 0
		m.resize()
		m.appendLine("permission", formatNexusEvent(event))
		// Phase 3: enter the dedicated input mode so the textinput
		// stops receiving keys while the panel is up.
		m.setMode(modePermission)
	case "result", "error":
		// Suppress the success-time `done` transcript row: the
		// header has already flipped from `running` back to
		// `idle`, and the streaming assistant_delta events
		// already produced the full reply. Re-emitting `done`
		// was a redundant noise line. The body still shows on
		// failure (`failed: <message>`) and on raw `error`
		// events so the operator can see why a turn ended in
		// failure.
		//
		// Phase 4 of docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md:
		// when an `error` event carries REQUEST_TIMEOUT but
		// the soft cycle had already fired during this turn,
		// the watchdog (not the soft budget) ended the turn.
		// Use `formatErrorEventWithSoftContext()` for error
		// events so the operator sees a watchdog-flavoured
		// message instead of a stale "raise --execute-timeout-ms"
		// recommendation. Result events still go through
		// `formatNexusEvent` unchanged.
		var body string
		if eventType == "error" {
			body = m.formatErrorEventWithSoftContext(event)
		} else {
			body = formatNexusEvent(event)
		}
		if body != "" {
			m.appendLine(eventType, body)
		}
		m.running = false
		m.pending = nil
		// Phase C of
		// docs/nexus/reference/go-tui-permission-policy-governance-plan.md:
		// exit `modePermission` so the next turn enters via the
		// composing flow (not stuck in the permission panel with
		// a stale `pending`). Without this, after a
		// `tool_denied` / `result` sequence the model stays in
		// `modePermission` and the textinput swallows
		// non-a/y/n/r/esc keys.
		m.setMode(modeComposing)
		// Clear the transient usage snapshot so the footer
		// drops the in-flight token counter when the turn ends.
		m.latestUsage = nil
		// Phase 4: clear the soft cycle snapshot AFTER the
		// friendly message has been built (so a watchdog
		// REQUEST_TIMEOUT still sees the snapshot above). The
		// next turn starts with a fresh budget anyway.
		m.softTimeoutState = nil
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
		// Phase 6 PR4 adds a parallel fetchSessionTasks so the
		// /tasks board overlay stays current across turns.
		if m.sessionID != "" {
			return tea.Batch(
				fetchInbox(m.cfg, m.sessionID, false, "auto"),
				fetchSessionAgents(m.cfg, m.sessionID, "auto"),
				fetchSessionTasks(m.cfg, m.sessionID, "auto"),
			)
		}
	case "assistant_delta":
		m.appendStreamingLine("assistant", stringField(event, "text"))
	case "thinking_delta":
		m.appendStreamingLine("thinking", stringField(event, "text"))
	case "tool_started":
		m.appendToolStarted(event)
		m.recordActivityEvent(activityKindToolStarted, formatToolInput(stringField(event, "name"), event["input"]), stringField(event, "timestamp"))
	case "permission_response":
		// Keep permission acknowledgements out of the main
		// transcript. They are still useful in the activity panel,
		// but inline rows like "permit approved=true ..." read like
		// internal bookkeeping during normal chat.
		m.recordActivityEvent(activityKindPermission, formatNexusEvent(event), stringField(event, "timestamp"))
	case "tool_denied", "context_warning", "context_blocking":
		m.appendLine(eventType, formatNexusEvent(event))
		// Phase 6 PR5: record high-signal events into the
		// in-memory activity buffer for the /activity overlay.
		// tool_denied and hook_* are intentionally NOT recorded
		// — the TS TUI's activityOverlay only surfaces tool runs,
		// permission decisions, agent job events, and context
		// warnings.
		switch eventType {
		case "context_warning":
			m.recordActivityEvent(activityKindContextWarning, formatNexusEvent(event), stringField(event, "timestamp"))
		case "context_blocking":
			m.recordActivityEvent(activityKindContextBlocking, formatNexusEvent(event), stringField(event, "timestamp"))
		}
	case "context_microcompact", "context_compact_boundary", "context_recovery_attempted", "context_grounding_required", "context_grounding_confirmed", "workspace_dirty_detected", "task_scope_declared", "scope_boundary_detected", "scope_boundary_confirmed":
		m.appendLine(eventType, formatNexusEvent(event))
	case "context_usage":
		m.contextUsage = contextUsageSnapshotFromContextUsageEvent(event)
	case "execution_metrics":
		if snapshot := contextUsageSnapshotFromExecutionMetrics(event); snapshot != nil {
			m.contextUsage = snapshot
		}
	case "usage":
		// `usage` events arrive several times per turn (often
		// once after every tool call). Appending each one as a
		// transcript row fills the chat log with a stream of
		// one-liners the operator doesn't act on. Mirror the
		// `✻ Sautéed for 26s` pattern: keep the most recent
		// snapshot on the model and render it as a single
		// transient line in the footer; result / error events
		// clear it so the next turn starts clean.
		m.latestUsage = &usageSnapshot{
			InputTokens:  anyInt(event["inputTokens"]),
			OutputTokens: anyInt(event["outputTokens"]),
			CacheRead:    anyInt(event["cacheReadInputTokens"]),
		}
		if m.latestUsage.InputTokens > 0 {
			m.lastUsage = m.latestUsage
		}
	case "user_intake_guidance":
		// Intake classifier metadata (intent / requiresTools /
		// reason) is useful for audit but the operator doesn't
		// need to see it inline. Skip the transcript append.
		// The /activity overlay and the prompt triage flow keep
		// the same surface; tests still call formatNexusEvent
		// directly to verify the formatter.
	case "tool_completed":
		// Compact transcript: skip tool completion lines so the
		// transcript shows one row per tool call (the started
		// row stays). The activity overlay still records the
		// completion so /activity remains useful for triage.
		m.updateToolCompleted(event)
		m.recordActivityEvent(activityKindToolCompleted, formatToolInput(stringField(event, "name"), event["input"]), stringField(event, "timestamp"))
		m.lastEventType = eventType
		return nil
	case "hook_started", "hook_completed", "hook_failed":
		// Hook events are intentionally NOT rendered in the
		// transcript: InvocationDiagnosticsHook fires before /
		// after every tool call and clutters the chat log
		// without informing the operator. Activity overlay
		// and tool audit ignore them too.
		m.lastEventType = eventType
		return nil
	case "agent_job_event":
		m.appendLine("agent_job", formatNexusEvent(event))
		m.recordActivityEvent(activityKindAgentJob, formatNexusEvent(event), stringField(event, "timestamp"))
	case "task_session_event":
		m.appendLine("task_session_event", formatNexusEvent(event))
		// Phase 6 PR6: aggregate subagent lifecycle events into
		// the in-memory subAgents tracker. Mirrors the TS TUI
		// formatAgentLoopRows path in src/cli/renderEvents.ts
		// (subagent_started / subagent_completed / subagent_failed
		// / subagent_cancelled are the canonical lifecycle set;
		// the `sub_agent_session_*` aliases are accepted for
		// back-compat with older Nexus events).
		if subAgentStatus, ok := subAgentStatusFromTaskSessionEvent(event); ok {
			m.recordSubAgentEvent(event, subAgentStatus)
		}
	case "near_timeout_warning":
		// Runtime timeout hints are operational telemetry. Do not
		// render them in the chat transcript; the footer/soft-timeout
		// state is the right surface for transient budget pressure.
	case "timeout_budget_exceeded":
		m.recordSuppressedNexusEvent(event)
	case "timeout_extension_granted":
		m.recordSuppressedNexusEvent(event)
	default:
		if body := formatNexusEvent(event); body != "" && !looksLikeInternalStatusLine(eventType, body) {
			m.appendLine(eventType, body)
		}
	}
	m.lastEventType = eventType
	return nil
}

func shouldSuppressTranscriptEvent(eventType string) bool {
	eventType = strings.TrimSpace(eventType)
	if eventType == "" {
		return true
	}
	if strings.HasPrefix(eventType, "permission_") && eventType != "permission_request" {
		return true
	}
	switch eventType {
	case "permit",
		"near_timeout_warning",
		"timeout_budget_exceeded",
		"timeout_extension_granted",
		"execute_summary",
		"execution_metrics",
		"usage",
		"user_intake_guidance",
		"hook_started",
		"hook_completed",
		"hook_failed":
		return true
	default:
		return false
	}
}

func shouldSuppressInternalStatusEvent(event map[string]any) bool {
	eventType := strings.ToLower(strings.TrimSpace(stringField(event, "type")))
	if eventType == "" {
		return true
	}
	if eventType != "status" && !strings.Contains(eventType, "runtime_status") {
		return false
	}
	return looksLikeInternalStatusLine(eventType, internalStatusEventText(event))
}

func internalStatusEventText(event map[string]any) string {
	parts := make([]string, 0, 6)
	for _, key := range []string{"status", "message", "text", "reason", "summary", "detail"} {
		if value := strings.TrimSpace(stringAnyField(event, key)); value != "" {
			parts = append(parts, value)
		}
	}
	if len(parts) == 0 {
		parts = append(parts, compactJSON(event))
	}
	return strings.Join(parts, " ")
}

func (m *model) recordSuppressedNexusEvent(event map[string]any) {
	eventType := stringField(event, "type")
	switch eventType {
	case "permission_response", "permit":
		m.recordActivityEvent(activityKindPermission, formatNexusEvent(event), stringField(event, "timestamp"))
	case "timeout_budget_exceeded":
		elapsedMs := anyInt(event["elapsedMs"])
		budgetMs := anyInt(event["timeoutMs"])
		if m.softTimeoutState == nil {
			m.softTimeoutState = &softTimeoutSnapshot{
				OriginalBudgetMs:  budgetMs,
				TotalSoftBudgetMs: budgetMs,
			}
		}
		m.softTimeoutState.BudgetExceededAt = time.Now()
		m.softTimeoutState.LastElapsedMs = elapsedMs
		if budgetMs > m.softTimeoutState.TotalSoftBudgetMs {
			m.softTimeoutState.TotalSoftBudgetMs = budgetMs
		}
	case "timeout_extension_granted":
		if m.softTimeoutState == nil {
			m.softTimeoutState = &softTimeoutSnapshot{}
		}
		m.softTimeoutState.ExtensionCount = anyInt(event["extensionCount"])
		m.softTimeoutState.MaxExtensions = anyInt(event["maxExtensions"])
		m.softTimeoutState.TotalSoftBudgetMs = anyInt(event["totalSoftBudgetMs"])
		m.softTimeoutState.LastElapsedMs = anyInt(event["elapsedMs"])
	case "execution_metrics":
		if snapshot := contextUsageSnapshotFromExecutionMetrics(event); snapshot != nil {
			m.contextUsage = snapshot
		}
	case "usage":
		m.latestUsage = &usageSnapshot{
			InputTokens:  anyInt(event["inputTokens"]),
			OutputTokens: anyInt(event["outputTokens"]),
			CacheRead:    anyInt(event["cacheReadInputTokens"]),
		}
		if m.latestUsage.InputTokens > 0 {
			m.lastUsage = m.latestUsage
		}
	}
}

func looksLikeInternalStatusLine(eventType string, body string) bool {
	text := strings.ToLower(strings.TrimSpace(eventType + " " + body))
	if text == "" {
		return true
	}
	return strings.Contains(text, "near timeout elapsed=") ||
		strings.Contains(text, "execution is near its timeout budget") ||
		strings.Contains(text, "preserve a concise partial answer now") ||
		strings.Contains(text, "approved=true reason=approved from trusted go tui") ||
		strings.Contains(text, "approved (session)") ||
		strings.Contains(text, "approved from trusted go tui sessi") ||
		strings.Contains(text, "slash cancelled")
}

func (m *model) appendStreamingLine(kind string, text string) {
	if text == "" {
		return
	}
	if len(m.transcript) > 0 {
		last := m.transcript[len(m.transcript)-1]
		if last.kind == kind {
			last.text += text
			last.Bump()
			m.refreshViewport()
			return
		}
	}
	m.appendLine(kind, text)
}

func (m *model) appendLine(kind string, text string) {
	// Phase B: each transcript row is a *transcriptItem so its
	// Versioned counter survives slice reallocations and the
	// render cache can key on the stable item pointer. A
	// freshly-appended row starts at version 0; nothing in the
	// render path mutates it after creation, so the cache entry
	// computed on first render is reused on every subsequent
	// frame.
	m.transcript = append(m.transcript, &transcriptItem{
		kind:      kind,
		text:      text,
		Versioned: NewVersioned(),
	})
	m.refreshViewport()
}

func (m *model) appendToolStarted(event map[string]any) {
	name := stringField(event, "name")
	input := formatToolInput(name, event["input"])
	item := &transcriptItem{
		kind:       "tool_started",
		text:       formatToolStartedText(name, input),
		toolUseID:  stringField(event, "toolUseId"),
		toolName:   name,
		toolInput:  input,
		toolStatus: "running",
		Versioned:  NewVersioned(),
	}
	m.transcript = append(m.transcript, item)
	m.refreshViewport()
}

func (m *model) updateToolCompleted(event map[string]any) bool {
	toolUseID := stringField(event, "toolUseId")
	name := stringField(event, "name")
	input := formatToolInput(name, event["input"])
	for i := len(m.transcript) - 1; i >= 0; i-- {
		item := m.transcript[i]
		if item == nil || item.kind != "tool_started" {
			continue
		}
		if toolUseID != "" && item.toolUseID != "" && item.toolUseID != toolUseID {
			continue
		}
		if name != "" && item.toolName != "" && item.toolName != name {
			continue
		}
		if item.toolName == "" {
			item.toolName = name
		}
		if item.toolInput == "" {
			item.toolInput = input
		}
		item.toolStatus = ternary(event["success"] == false, "error", "success")
		item.toolOutput = extractToolOutputText(event["output"])
		item.text = formatToolStartedText(item.toolName, item.toolInput)
		item.Bump()
		m.refreshViewport()
		return true
	}
	return false
}

func (m *model) refreshViewport() {
	welcome := m.renderWelcomeCard(max(40, m.viewport.Width()))
	transcript := renderTranscript(m.transcript, max(40, m.viewport.Width()))
	// Capture whether the operator had scrolled up before
	// the new content arrived. We only auto-scroll to the
	// bottom when they were already at the bottom — otherwise
	// we'd yank them out of whatever they were inspecting
	// every time a new tool call or streaming delta lands.
	wasAtBottom := m.viewport.AtBottom()
	if transcript != "" {
		m.viewport.SetContent(welcome + "\n\n" + transcript)
	} else {
		m.viewport.SetContent(welcome)
	}
	if wasAtBottom {
		m.viewport.GotoBottom()
	}
}
