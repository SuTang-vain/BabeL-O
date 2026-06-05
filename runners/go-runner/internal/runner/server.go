package runner

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"sync"
	"time"

	"github.com/babel-o/go-runner/internal/protocol"
	"github.com/babel-o/go-runner/internal/tools"
)

const (
	defaultMaxConcurrentTools = 4
	hardMaxConcurrentTools    = 16
	defaultMaxOutputBytes     = int64(200_000)
	hardMaxOutputBytes        = int64(1_000_000)
	defaultBashMaxBufferBytes = int64(1_000_000)
	hardBashMaxBufferBytes    = int64(2_000_000)
	defaultDeadlineMs         = int64(120_000)
	hardMaxDeadlineMs         = int64(600_000)
)

type ServerOptions struct {
	ID                 string
	EnableBash         bool
	EnableWrite        bool
	MaxConcurrentTools int
	MaxOutputBytes     int64
	BashMaxBufferBytes int64
	DefaultDeadlineMs  int64
	MaxDeadlineMs      int64
}

type Server struct {
	id                 string
	capabilities       protocol.Capabilities
	bashEnabled        bool
	writeEnabled       bool
	maxConcurrentTools int
	maxOutputBytes     int64
	bashMaxBufferBytes int64
	defaultDeadlineMs  int64
	maxDeadlineMs      int64
	active             map[string]context.CancelFunc
	gate               chan struct{}
	mu                 sync.Mutex
}

func NewServer(id string) *Server {
	return NewServerWithOptions(ServerOptions{ID: id})
}

func NewServerWithOptions(options ServerOptions) *Server {
	options = normalizeServerOptions(options)
	return &Server{
		id:                 options.ID,
		capabilities:       capabilitiesForOptions(options),
		bashEnabled:        options.EnableBash,
		writeEnabled:       options.EnableWrite,
		maxConcurrentTools: options.MaxConcurrentTools,
		maxOutputBytes:     options.MaxOutputBytes,
		bashMaxBufferBytes: options.BashMaxBufferBytes,
		defaultDeadlineMs:  options.DefaultDeadlineMs,
		maxDeadlineMs:      options.MaxDeadlineMs,
		active:             map[string]context.CancelFunc{},
		gate:               make(chan struct{}, options.MaxConcurrentTools),
	}
}

func normalizeServerOptions(options ServerOptions) ServerOptions {
	if options.ID == "" {
		options.ID = "go-remote-runner"
	}
	if options.MaxConcurrentTools <= 0 {
		options.MaxConcurrentTools = defaultMaxConcurrentTools
	}
	if options.MaxConcurrentTools > hardMaxConcurrentTools {
		options.MaxConcurrentTools = hardMaxConcurrentTools
	}
	if options.MaxOutputBytes <= 0 {
		options.MaxOutputBytes = defaultMaxOutputBytes
	}
	if options.MaxOutputBytes > hardMaxOutputBytes {
		options.MaxOutputBytes = hardMaxOutputBytes
	}
	if options.BashMaxBufferBytes <= 0 {
		options.BashMaxBufferBytes = defaultBashMaxBufferBytes
	}
	if options.BashMaxBufferBytes > hardBashMaxBufferBytes {
		options.BashMaxBufferBytes = hardBashMaxBufferBytes
	}
	if options.MaxDeadlineMs <= 0 {
		options.MaxDeadlineMs = hardMaxDeadlineMs
	}
	if options.MaxDeadlineMs > hardMaxDeadlineMs {
		options.MaxDeadlineMs = hardMaxDeadlineMs
	}
	if options.DefaultDeadlineMs <= 0 {
		options.DefaultDeadlineMs = defaultDeadlineMs
	}
	if options.DefaultDeadlineMs > options.MaxDeadlineMs {
		options.DefaultDeadlineMs = options.MaxDeadlineMs
	}
	return options
}

func capabilitiesForOptions(options ServerOptions) protocol.Capabilities {
	return protocol.Capabilities{
		Tools:              tools.SupportedTools(options.EnableBash, options.EnableWrite),
		ReadOnly:           !options.EnableBash && !options.EnableWrite,
		BashEnabled:        options.EnableBash,
		WriteEnabled:       options.EnableWrite,
		MaxConcurrentTools: options.MaxConcurrentTools,
		MaxOutputBytes:     options.MaxOutputBytes,
		DefaultDeadlineMs:  options.DefaultDeadlineMs,
		MaxDeadlineMs:      options.MaxDeadlineMs,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/remote-runner/capabilities", s.handleCapabilities)
	mux.HandleFunc("/v1/remote-runner/execute", s.handleExecute)
	mux.HandleFunc("/v1/remote-runner/cancel", s.handleCancel)
	return mux
}

func (s *Server) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, protocol.ErrorResult("METHOD_NOT_ALLOWED", "Method not allowed.", nil))
		return
	}
	writeJSON(w, http.StatusOK, protocol.CapabilitiesResponse{
		ProtocolVersion: protocol.Version,
		ID:              s.id,
		Capabilities:    s.capabilities,
	})
}

func (s *Server) handleExecute(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, protocol.ErrorResult("METHOD_NOT_ALLOWED", "Method not allowed.", nil))
		return
	}

	var request protocol.ExecuteRequest
	if err := decodeJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorResult("REMOTE_RUNNER_MALFORMED_REQUEST", "Malformed execute request.", map[string]string{"error": err.Error()}))
		return
	}
	if request.ProtocolVersion != protocol.Version {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorResult("REMOTE_RUNNER_PROTOCOL_MISMATCH", "Unsupported remote runner protocol version.", map[string]string{"received": request.ProtocolVersion, "expected": protocol.Version}))
		return
	}
	if request.SessionID == "" || request.ToolName == "" || request.Cwd == "" {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorResult("REMOTE_RUNNER_MALFORMED_REQUEST", "Execute request requires sessionId, toolName, and cwd.", nil))
		return
	}
	if !tools.IsSupportedTool(request.ToolName, s.bashEnabled, s.writeEnabled) {
		writeJSON(w, http.StatusNotFound, protocol.ErrorResult("REMOTE_RUNNER_TOOL_UNSUPPORTED", "Remote runner does not support tool "+request.ToolName+".", nil))
		return
	}

	request.MaxOutputBytes = clampMaxOutputBytes(request.MaxOutputBytes, s.maxOutputBytes)
	request.BashMaxBufferBytes = clampMaxOutputBytes(request.BashMaxBufferBytes, s.bashMaxBufferBytes)
	deadlineMs := s.deadlineDurationMs(request.DeadlineMs)
	request.DeadlineMs = deadlineMs

	select {
	case s.gate <- struct{}{}:
		defer func() { <-s.gate }()
	default:
		writeJSON(w, http.StatusTooManyRequests, protocol.ErrorResult("REMOTE_RUNNER_CAPACITY_EXCEEDED", "Remote runner concurrent tool limit is exhausted.", map[string]int{"maxConcurrentTools": s.maxConcurrentTools}))
		return
	}

	var ctx context.Context
	var cancel context.CancelFunc
	if request.ToolName == "Bash" {
		ctx, cancel = context.WithCancel(r.Context())
	} else {
		ctx, cancel = context.WithTimeout(r.Context(), time.Duration(deadlineMs)*time.Millisecond)
	}
	key := protocol.RequestKey(request.SessionID, request.RequestID, request.ToolUseID)
	s.register(key, cancel)
	defer s.unregister(key)
	defer cancel()

	toolResult, errorResult := tools.Execute(ctx, request)
	if errorResult != nil {
		withMetrics := *errorResult
		withMetrics.Metrics = s.resultMetrics(startedAt, request.ToolName, withMetrics.Code, false, 0, withMetrics.Details)
		writeJSON(w, httpStatusForError(withMetrics.Code), withMetrics)
		return
	}
	writeJSON(w, http.StatusOK, protocol.RunnerResult{
		Kind:          "result",
		Success:       toolResult.Success,
		Output:        toolResult.Output,
		Truncated:     toolResult.Truncated,
		OriginalBytes: toolResult.OriginalBytes,
		Metrics:       s.resultMetrics(startedAt, request.ToolName, "", toolResult.Truncated, toolResult.OriginalBytes, toolResult.Output),
	})
}

func (s *Server) resultMetrics(startedAt time.Time, toolName string, errorCode string, truncated bool, originalBytes int64, payload any) *protocol.RunnerResultMetrics {
	metrics := &protocol.RunnerResultMetrics{
		RunnerID:        s.id,
		ProtocolVersion: protocol.Version,
		DurationMs:      float64(time.Since(startedAt).Microseconds()) / 1000,
		Truncated:       truncated,
		OriginalBytes:   originalBytes,
		ErrorCode:       errorCode,
		Cancelled:       errorCode == "REQUEST_CANCELLED",
		TimedOut:        errorCode == "REQUEST_TIMEOUT",
	}
	if toolName == "Bash" {
		metrics.ExitCode = extractExitCode(payload)
		metrics.Signal = extractSignal(payload)
	}
	return metrics
}

func extractExitCode(payload any) *int {
	if value, ok := extractStructField(payload, "ExitCode").(*int); ok {
		return value
	}
	if details, ok := payload.(map[string]any); ok {
		if value, ok := details["exitCode"].(int); ok {
			return &value
		}
	}
	return nil
}

func extractSignal(payload any) string {
	if value, ok := extractStructField(payload, "Signal").(string); ok {
		return value
	}
	if details, ok := payload.(map[string]any); ok {
		if value, ok := details["signal"].(string); ok {
			return value
		}
	}
	return ""
}

func extractStructField(payload any, fieldName string) any {
	value := reflect.ValueOf(payload)
	if !value.IsValid() {
		return nil
	}
	if value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return nil
	}
	field := value.FieldByName(fieldName)
	if !field.IsValid() || !field.CanInterface() {
		return nil
	}
	return field.Interface()
}

func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, protocol.ErrorResult("METHOD_NOT_ALLOWED", "Method not allowed.", nil))
		return
	}

	var request protocol.CancelRequest
	if err := decodeJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorResult("REMOTE_RUNNER_MALFORMED_REQUEST", "Malformed cancel request.", map[string]string{"error": err.Error()}))
		return
	}
	key := protocol.RequestKey(request.SessionID, request.RequestID, request.ToolUseID)
	s.mu.Lock()
	cancel := s.active[key]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) register(key string, cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active[key] = cancel
}

func (s *Server) unregister(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.active, key)
}

func decodeJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err != nil {
			return err
		}
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func (s *Server) deadlineDurationMs(requestDeadlineMs int64) int64 {
	if requestDeadlineMs <= 0 {
		return s.defaultDeadlineMs
	}
	nowMs := time.Now().UnixMilli()
	if requestDeadlineMs > nowMs {
		return clampPositiveInt64(requestDeadlineMs-nowMs, s.maxDeadlineMs)
	}
	return clampPositiveInt64(requestDeadlineMs, s.maxDeadlineMs)
}

func clampMaxOutputBytes(value int64, max int64) int64 {
	if value <= 0 || value > max {
		return max
	}
	return value
}

func clampPositiveInt64(value int64, max int64) int64 {
	if value <= 0 {
		return 0
	}
	if value > max {
		return max
	}
	return value
}

func httpStatusForError(code string) int {
	switch code {
	case "INVALID_TOOL_INPUT", "REMOTE_RUNNER_MALFORMED_REQUEST", "REMOTE_RUNNER_PROTOCOL_MISMATCH", "WORKSPACE_PATH_DENIED":
		return http.StatusBadRequest
	case "REMOTE_RUNNER_TOOL_UNSUPPORTED":
		return http.StatusNotFound
	case "REMOTE_RUNNER_CAPACITY_EXCEEDED":
		return http.StatusTooManyRequests
	default:
		return http.StatusOK
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
