package protocol

import "encoding/json"

const Version = "2026-06-04.babel-o.remote-runner.v1"

type Capabilities struct {
	Tools              []string `json:"tools,omitempty"`
	ReadOnly           bool     `json:"readOnly"`
	BashEnabled        bool     `json:"bashEnabled"`
	WriteEnabled       bool     `json:"writeEnabled"`
	MaxConcurrentTools int      `json:"maxConcurrentTools,omitempty"`
	MaxOutputBytes     int64    `json:"maxOutputBytes,omitempty"`
	DefaultDeadlineMs  int64    `json:"defaultDeadlineMs,omitempty"`
	MaxDeadlineMs      int64    `json:"maxDeadlineMs,omitempty"`
}

type CapabilitiesResponse struct {
	ProtocolVersion string       `json:"protocolVersion"`
	ID              string       `json:"id"`
	Capabilities    Capabilities `json:"capabilities"`
}

type ExecuteRequest struct {
	ProtocolVersion    string          `json:"protocolVersion"`
	SessionID          string          `json:"sessionId"`
	RequestID          string          `json:"requestId,omitempty"`
	ToolUseID          string          `json:"toolUseId,omitempty"`
	ToolName           string          `json:"toolName"`
	ToolInput          json.RawMessage `json:"toolInput"`
	Cwd                string          `json:"cwd"`
	AllowedPaths       []string        `json:"allowedPaths,omitempty"`
	MaxOutputBytes     int64           `json:"maxOutputBytes"`
	BashMaxBufferBytes int64           `json:"bashMaxBufferBytes"`
	DeadlineMs         int64           `json:"deadlineMs,omitempty"`
}

type CancelRequest struct {
	SessionID string `json:"sessionId"`
	RequestID string `json:"requestId,omitempty"`
	ToolUseID string `json:"toolUseId,omitempty"`
}

type RunnerResultMetrics struct {
	RunnerID        string  `json:"runnerId,omitempty"`
	ProtocolVersion string  `json:"protocolVersion,omitempty"`
	DurationMs      float64 `json:"durationMs,omitempty"`
	Truncated       bool    `json:"truncated,omitempty"`
	OriginalBytes   int64   `json:"originalBytes,omitempty"`
	ExitCode        *int    `json:"exitCode,omitempty"`
	Signal          string  `json:"signal,omitempty"`
	Cancelled       bool    `json:"cancelled,omitempty"`
	TimedOut        bool    `json:"timedOut,omitempty"`
	ErrorCode       string  `json:"errorCode,omitempty"`
}

type RunnerResult struct {
	Kind          string               `json:"kind"`
	Success       bool                 `json:"success,omitempty"`
	Output        any                  `json:"output,omitempty"`
	Truncated     bool                 `json:"truncated,omitempty"`
	OriginalBytes int64                `json:"originalBytes,omitempty"`
	Code          string               `json:"code,omitempty"`
	Message       string               `json:"message,omitempty"`
	Details       any                  `json:"details,omitempty"`
	Metrics       *RunnerResultMetrics `json:"metrics,omitempty"`
}

func ErrorResult(code string, message string, details any) RunnerResult {
	return RunnerResult{
		Kind:    "error",
		Code:    code,
		Message: message,
		Details: details,
	}
}

func RequestKey(sessionID string, requestID string, toolUseID string) string {
	return sessionID + ":" + requestID + ":" + toolUseID
}
