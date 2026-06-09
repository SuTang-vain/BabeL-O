package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
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
	baseURL   string
	cwd       string
	sessionID string
	apiKey    string
	altScreen bool
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
}

type transcriptLine struct {
	kind string
	text string
}

type model struct {
	cfg           config
	input         textinput.Model
	viewport      viewport.Model
	spinner       spinner.Model
	transcript    []transcriptLine
	running       bool
	events        <-chan streamEvent
	decisions     chan<- permissionDecision
	pending       *pendingPermission
	lastEventType string
	sessionID     string
	modelID       string
	startedAt     time.Time
	width         int
	height        int
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
		cfg:      cfg,
		input:    input,
		viewport: vp,
		spinner:  spin,
		transcript: []transcriptLine{
			{kind: "status", text: "Go TUI MVP connected to the Nexus stream API."},
			{kind: "status", text: "Runtime, tools, permissions and context stay owned by BabeL-O Nexus."},
		},
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(textinput.Blink, m.spinner.Tick)
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
		if key == "ctrl+c" || (key == "q" && !m.running && strings.TrimSpace(m.input.Value()) == "") {
			return m, tea.Quit
		}

		if m.pending != nil {
			switch strings.ToLower(key) {
			case "a", "y":
				m.sendPermissionDecision(true, "Approved from Go TUI MVP")
				return m, nil
			case "r", "n", "esc":
				m.sendPermissionDecision(false, "Rejected from Go TUI MVP")
				return m, nil
			}
		}

		if key == "enter" {
			prompt := strings.TrimSpace(m.input.Value())
			if prompt == "" || m.running {
				return m, nil
			}
			m.input.SetValue("")
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

	parts := []string{header, transcript}
	if permission != "" {
		parts = append(parts, permission)
	}
	parts = append(parts, input, footer)
	return strings.Join(parts, "\n")
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
	top := joinColumns(width, title, statusStyle.Render(state))
	meta := fmt.Sprintf("url=%s  cwd=%s  session=%s  model=%s", m.cfg.baseURL, m.cfg.cwd, session, model)
	return strings.Join([]string{
		top,
		mutedStyle.Render(truncatePlain(meta, width)),
		divider(width),
	}, "\n")
}

func (m model) renderPermission(width int) string {
	if m.pending == nil {
		return ""
	}
	line := fmt.Sprintf(
		"Permission: %s (%s risk)  a/y approve  r/n/esc reject",
		firstNonEmpty(m.pending.name, "tool"),
		firstNonEmpty(m.pending.risk, "unknown"),
	)
	return strings.Join([]string{
		divider(width),
		permissionStyle.Render(truncatePlain(line, width)),
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
		}
		m.resize()
		m.appendLine("permission", formatNexusEvent(event))
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
