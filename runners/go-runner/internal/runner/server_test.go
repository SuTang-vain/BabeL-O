package runner

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/babel-o/go-runner/internal/protocol"
)

func TestCapabilities(t *testing.T) {
	server := httptest.NewServer(NewServer("test-runner").Handler())
	defer server.Close()

	response, err := http.Get(server.URL + "/v1/remote-runner/capabilities")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	var body protocol.CapabilitiesResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.ProtocolVersion != protocol.Version {
		t.Fatalf("protocol version = %q", body.ProtocolVersion)
	}
	if body.ID != "test-runner" {
		t.Fatalf("id = %q", body.ID)
	}
	wantTools := []string{"ListDir", "Glob", "Grep", "Read"}
	if len(body.Capabilities.Tools) != len(wantTools) {
		t.Fatalf("capabilities = %#v", body.Capabilities)
	}
	for index, tool := range wantTools {
		if body.Capabilities.Tools[index] != tool {
			t.Fatalf("capabilities = %#v", body.Capabilities)
		}
	}
	if !body.Capabilities.ReadOnly || body.Capabilities.BashEnabled || body.Capabilities.WriteEnabled {
		t.Fatalf("unexpected safety capabilities = %#v", body.Capabilities)
	}
	if body.Capabilities.MaxConcurrentTools != defaultMaxConcurrentTools || body.Capabilities.MaxOutputBytes != defaultMaxOutputBytes || body.Capabilities.DefaultDeadlineMs != defaultDeadlineMs || body.Capabilities.MaxDeadlineMs != hardMaxDeadlineMs {
		t.Fatalf("unexpected limit capabilities = %#v", body.Capabilities)
	}
}

func TestServerOptionsClampCapabilities(t *testing.T) {
	server := httptest.NewServer(NewServerWithOptions(ServerOptions{
		ID:                 "test-runner",
		MaxConcurrentTools: 100,
		MaxOutputBytes:     2_000_000,
		DefaultDeadlineMs:  700_000,
		MaxDeadlineMs:      2_000_000,
	}).Handler())
	defer server.Close()

	response, err := http.Get(server.URL + "/v1/remote-runner/capabilities")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	var body protocol.CapabilitiesResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Capabilities.MaxConcurrentTools != hardMaxConcurrentTools || body.Capabilities.MaxOutputBytes != hardMaxOutputBytes || body.Capabilities.DefaultDeadlineMs != hardMaxDeadlineMs || body.Capabilities.MaxDeadlineMs != hardMaxDeadlineMs {
		t.Fatalf("unexpected clamped capabilities = %#v", body.Capabilities)
	}
}

func TestExecuteAppliesOutputCap(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "large.txt"), strings.Repeat("x", 100))
	server := httptest.NewServer(NewServerWithOptions(ServerOptions{ID: "test-runner", MaxOutputBytes: 8}).Handler())
	defer server.Close()

	result := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion: protocol.Version,
		SessionID:       "session-1",
		RequestID:       "request-cap-output",
		ToolUseID:       "tool-cap-output",
		ToolName:        "Read",
		ToolInput:       json.RawMessage(`{"path":"large.txt","maxBytes":100}`),
		Cwd:             workspace,
		MaxOutputBytes:  1000,
	})
	if result.Kind != "result" || !result.Success || !result.Truncated || !strings.Contains(result.Output.(string), "remote runner output truncated to 8 bytes") {
		t.Fatalf("unexpected capped output result: %#v", result)
	}
}

func TestExecuteAppliesDefaultAndMaxDeadline(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "README.md"), "hello")
	server := httptest.NewServer(NewServerWithOptions(ServerOptions{ID: "test-runner", DefaultDeadlineMs: 50, MaxDeadlineMs: 75}).Handler())
	defer server.Close()

	omitted := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion: protocol.Version,
		SessionID:       "session-1",
		RequestID:       "request-default-deadline",
		ToolUseID:       "tool-default-deadline",
		ToolName:        "Read",
		ToolInput:       json.RawMessage(`{"path":"README.md"}`),
		Cwd:             workspace,
	})
	if omitted.Kind != "result" || !omitted.Success || omitted.Output != "hello" {
		t.Fatalf("unexpected default deadline result: %#v", omitted)
	}

	oversized := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion: protocol.Version,
		SessionID:       "session-1",
		RequestID:       "request-max-deadline",
		ToolUseID:       "tool-max-deadline",
		ToolName:        "Read",
		ToolInput:       json.RawMessage(`{"path":"README.md"}`),
		Cwd:             workspace,
		DeadlineMs:      10_000,
	})
	if oversized.Kind != "result" || !oversized.Success || oversized.Output != "hello" {
		t.Fatalf("unexpected max deadline result: %#v", oversized)
	}
}

func TestExecuteRejectsCapacityExhaustion(t *testing.T) {
	server := NewServerWithOptions(ServerOptions{ID: "test-runner", MaxConcurrentTools: 1})
	server.gate <- struct{}{}
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()

	result, status := executeWithStatus(t, httpServer.URL, protocol.ExecuteRequest{
		ProtocolVersion: protocol.Version,
		SessionID:       "session-1",
		RequestID:       "request-capacity",
		ToolUseID:       "tool-capacity",
		ToolName:        "Read",
		ToolInput:       json.RawMessage(`{"path":"README.md"}`),
		Cwd:             t.TempDir(),
	})
	if status != http.StatusTooManyRequests || result.Kind != "error" || result.Code != "REMOTE_RUNNER_CAPACITY_EXCEEDED" {
		t.Fatalf("unexpected capacity result: status=%d result=%#v", status, result)
	}
}

func TestBashCapabilitiesRequireExplicitEnable(t *testing.T) {
	server := httptest.NewServer(NewServerWithOptions(ServerOptions{ID: "test-runner", EnableBash: true}).Handler())
	defer server.Close()

	response, err := http.Get(server.URL + "/v1/remote-runner/capabilities")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	var body protocol.CapabilitiesResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.Capabilities.BashEnabled || body.Capabilities.ReadOnly || body.Capabilities.WriteEnabled {
		t.Fatalf("unexpected bash capabilities = %#v", body.Capabilities)
	}
	if body.Capabilities.Tools[len(body.Capabilities.Tools)-1] != "Bash" {
		t.Fatalf("unexpected bash tools = %#v", body.Capabilities.Tools)
	}
}

func TestWriteCapabilitiesRequireExplicitEnable(t *testing.T) {
	server := httptest.NewServer(NewServerWithOptions(ServerOptions{ID: "test-runner", EnableWrite: true}).Handler())
	defer server.Close()

	response, err := http.Get(server.URL + "/v1/remote-runner/capabilities")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	var body protocol.CapabilitiesResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.Capabilities.WriteEnabled || body.Capabilities.ReadOnly || body.Capabilities.BashEnabled {
		t.Fatalf("unexpected write capabilities = %#v", body.Capabilities)
	}
	if body.Capabilities.Tools[len(body.Capabilities.Tools)-2] != "Write" || body.Capabilities.Tools[len(body.Capabilities.Tools)-1] != "Edit" {
		t.Fatalf("unexpected write tools = %#v", body.Capabilities.Tools)
	}
}

func TestExecuteWriteEdit(t *testing.T) {
	workspace := t.TempDir()
	server := httptest.NewServer(NewServerWithOptions(ServerOptions{ID: "test-runner", EnableWrite: true}).Handler())
	defer server.Close()

	writeResult := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-write",
		ToolUseID:          "tool-write",
		ToolName:           "Write",
		ToolInput:          json.RawMessage(`{"path":"src/new.txt","content":"hello world"}`),
		Cwd:                workspace,
		AllowedPaths:       []string{workspace},
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if writeResult.Kind != "result" || !writeResult.Success || writeResult.Output != "Wrote src/new.txt" {
		t.Fatalf("unexpected write result: %#v", writeResult)
	}

	editResult := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-edit",
		ToolUseID:          "tool-edit",
		ToolName:           "Edit",
		ToolInput:          json.RawMessage(`{"path":"src/new.txt","oldString":"world","newString":"runner"}`),
		Cwd:                workspace,
		AllowedPaths:       []string{workspace},
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if editResult.Kind != "result" || !editResult.Success || editResult.Output != "Edited src/new.txt" {
		t.Fatalf("unexpected edit result: %#v", editResult)
	}
	content, err := os.ReadFile(filepath.Join(workspace, "src", "new.txt"))
	if err != nil || string(content) != "hello runner" {
		t.Fatalf("unexpected edited content: %q %v", string(content), err)
	}
}

func TestExecuteBashSuccessAndFailure(t *testing.T) {
	workspace := t.TempDir()
	server := httptest.NewServer(NewServerWithOptions(ServerOptions{ID: "test-runner", EnableBash: true}).Handler())
	defer server.Close()

	success := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-bash-success",
		ToolUseID:          "tool-bash-success",
		ToolName:           "Bash",
		ToolInput:          json.RawMessage(`{"command":"printf hello"}`),
		Cwd:                workspace,
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if success.Kind != "result" || !success.Success {
		t.Fatalf("unexpected bash success result: %#v", success)
	}
	successOutput := success.Output.(map[string]any)
	if successOutput["stdout"] != "hello" || successOutput["stderr"] != "" {
		t.Fatalf("unexpected bash success output: %#v", successOutput)
	}

	failure := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-bash-failure",
		ToolUseID:          "tool-bash-failure",
		ToolName:           "Bash",
		ToolInput:          json.RawMessage(`{"command":"printf nope; exit 7"}`),
		Cwd:                workspace,
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if failure.Kind != "result" || failure.Success {
		t.Fatalf("unexpected bash failure result: %#v", failure)
	}
	failureOutput := failure.Output.(map[string]any)
	if failureOutput["stdout"] != "nope" || int(failureOutput["exitCode"].(float64)) != 7 {
		t.Fatalf("unexpected bash failure output: %#v", failureOutput)
	}
	if failure.Metrics == nil || failure.Metrics.ExitCode == nil || *failure.Metrics.ExitCode != 7 {
		t.Fatalf("unexpected bash failure metrics: %#v", failure.Metrics)
	}
}

func TestExecuteBashEnvAllowlistAndOutputBudget(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("BABEL_O_PROVIDER_API_KEY", "secret-token")
	server := httptest.NewServer(NewServerWithOptions(ServerOptions{ID: "test-runner", EnableBash: true, BashMaxBufferBytes: 6}).Handler())
	defer server.Close()

	envResult := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-bash-env",
		ToolUseID:          "tool-bash-env",
		ToolName:           "Bash",
		ToolInput:          json.RawMessage(`{"command":"printf ${BABEL_O_PROVIDER_API_KEY:-unset}"}`),
		Cwd:                workspace,
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if envResult.Kind != "result" || !envResult.Success || envResult.Output.(map[string]any)["stdout"] != "unset" {
		t.Fatalf("unexpected env result: %#v", envResult)
	}

	truncated := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-bash-buffer",
		ToolUseID:          "tool-bash-buffer",
		ToolName:           "Bash",
		ToolInput:          json.RawMessage(`{"command":"printf 123456789"}`),
		Cwd:                workspace,
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if truncated.Kind != "result" || !truncated.Success || !truncated.Truncated || !strings.Contains(truncated.Output.(map[string]any)["stdout"].(string), "stream truncated to 6 bytes") {
		t.Fatalf("unexpected bash truncated result: %#v", truncated)
	}
}

func TestExecuteBashTimeout(t *testing.T) {
	workspace := t.TempDir()
	server := httptest.NewServer(NewServerWithOptions(ServerOptions{ID: "test-runner", EnableBash: true, DefaultDeadlineMs: 50, MaxDeadlineMs: 50}).Handler())
	defer server.Close()

	result := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-bash-timeout",
		ToolUseID:          "tool-bash-timeout",
		ToolName:           "Bash",
		ToolInput:          json.RawMessage(`{"command":"sleep 1"}`),
		Cwd:                workspace,
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if result.Kind != "error" || result.Code != "REQUEST_TIMEOUT" {
		t.Fatalf("unexpected bash timeout result: %#v", result)
	}
}

func TestExecuteListDirReadGrepGlob(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "README.md"), "hello\nneedle one\n")
	writeFile(t, filepath.Join(workspace, "src", "main.go"), "package main\n// needle two\n")
	server := httptest.NewServer(NewServer("test-runner").Handler())
	defer server.Close()

	listDirResult := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-list-dir",
		ToolUseID:          "tool-list-dir",
		ToolName:           "ListDir",
		ToolInput:          json.RawMessage(`{"path":".","maxEntries":20,"includeFiles":true,"includeDirectories":true,"maxDepth":1}`),
		Cwd:                workspace,
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if listDirResult.Kind != "result" || !listDirResult.Success {
		t.Fatalf("unexpected ListDir result: %#v", listDirResult)
	}
	listDirOutput := listDirResult.Output.(map[string]any)
	listDirEntries := listDirOutput["entries"].([]any)
	if len(listDirEntries) != 2 || listDirEntries[0].(map[string]any)["path"] != "src" || listDirEntries[1].(map[string]any)["path"] != "README.md" {
		t.Fatalf("unexpected ListDir output: %#v", listDirOutput)
	}

	readResult := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-read",
		ToolUseID:          "tool-read",
		ToolName:           "Read",
		ToolInput:          json.RawMessage(`{"path":"README.md","offset":0,"limit":5}`),
		Cwd:                workspace,
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if readResult.Kind != "result" || !readResult.Success || readResult.Output != "hello\n<read-truncated path=\"README.md\" bytes=17 shownRange=\"0-5\">Use Read with offset=5 and limit=5 to continue.</read-truncated>" {
		t.Fatalf("unexpected read result: %#v", readResult)
	}
	if readResult.Metrics == nil || readResult.Metrics.RunnerID != "test-runner" || readResult.Metrics.ProtocolVersion != protocol.Version || readResult.Metrics.DurationMs < 0 {
		t.Fatalf("unexpected read metrics: %#v", readResult.Metrics)
	}

	grepResult := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-grep",
		ToolUseID:          "tool-grep",
		ToolName:           "Grep",
		ToolInput:          json.RawMessage(`{"pattern":"needle","path":".","maxMatches":10}`),
		Cwd:                workspace,
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if grepResult.Kind != "result" || !grepResult.Success || !strings.Contains(grepResult.Output.(string), "README.md:2:needle one") || !strings.Contains(grepResult.Output.(string), "src/main.go:2:// needle two") {
		t.Fatalf("unexpected grep result: %#v", grepResult)
	}

	globResult := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-glob",
		ToolUseID:          "tool-glob",
		ToolName:           "Glob",
		ToolInput:          json.RawMessage(`{"pattern":"**/*.go","maxResults":10}`),
		Cwd:                workspace,
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if globResult.Kind != "result" || !globResult.Success {
		t.Fatalf("unexpected glob result: %#v", globResult)
	}
	files := toStringSlice(t, globResult.Output)
	if len(files) != 1 || files[0] != "src/main.go" {
		t.Fatalf("unexpected glob files: %#v", files)
	}
}

func TestExecuteRejectsProtocolMismatchAndUnsupportedTool(t *testing.T) {
	server := httptest.NewServer(NewServer("test-runner").Handler())
	defer server.Close()

	mismatch := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    "old",
		SessionID:          "session-1",
		ToolName:           "Noop",
		Cwd:                "/workspace/project",
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if mismatch.Kind != "error" || mismatch.Code != "REMOTE_RUNNER_PROTOCOL_MISMATCH" {
		t.Fatalf("unexpected mismatch result: %#v", mismatch)
	}

	for _, toolName := range []string{"Bash", "Write", "Edit"} {
		unsupported := execute(t, server.URL, protocol.ExecuteRequest{
			ProtocolVersion:    protocol.Version,
			SessionID:          "session-1",
			ToolName:           toolName,
			Cwd:                "/workspace/project",
			MaxOutputBytes:     1000,
			BashMaxBufferBytes: 1000,
		})
		if unsupported.Kind != "error" || unsupported.Code != "REMOTE_RUNNER_TOOL_UNSUPPORTED" {
			t.Fatalf("unexpected unsupported %s result: %#v", toolName, unsupported)
		}
	}
}

func TestReadRejectsWorkspaceEscapeAndTruncatesOutput(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	writeFile(t, filepath.Join(workspace, "small.txt"), "hello")
	writeFile(t, filepath.Join(outside, "secret.txt"), "secret")
	server := httptest.NewServer(NewServer("test-runner").Handler())
	defer server.Close()

	escape := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-escape",
		ToolUseID:          "tool-escape",
		ToolName:           "Read",
		ToolInput:          json.RawMessage(`{"path":"../secret.txt"}`),
		Cwd:                workspace,
		AllowedPaths:       []string{workspace},
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if escape.Kind != "error" || escape.Code != "WORKSPACE_PATH_DENIED" {
		t.Fatalf("unexpected escape result: %#v", escape)
	}

	truncated := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-truncate",
		ToolUseID:          "tool-truncate",
		ToolName:           "Read",
		ToolInput:          json.RawMessage(`{"path":"small.txt"}`),
		Cwd:                workspace,
		MaxOutputBytes:     3,
		BashMaxBufferBytes: 1000,
	})
	if truncated.Kind != "result" || !truncated.Success || !truncated.Truncated || !strings.Contains(truncated.Output.(string), "remote runner output truncated") {
		t.Fatalf("unexpected truncated result: %#v", truncated)
	}
}

func TestReadRejectsSymlinkEscape(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secret.txt"), "secret")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(workspace, "link.txt")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	server := httptest.NewServer(NewServer("test-runner").Handler())
	defer server.Close()

	result := execute(t, server.URL, protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		RequestID:          "request-symlink",
		ToolUseID:          "tool-symlink",
		ToolName:           "Read",
		ToolInput:          json.RawMessage(`{"path":"link.txt"}`),
		Cwd:                workspace,
		AllowedPaths:       []string{workspace},
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if result.Kind != "error" || result.Code != "WORKSPACE_PATH_DENIED" {
		t.Fatalf("unexpected symlink result: %#v", result)
	}
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func toStringSlice(t *testing.T, value any) []string {
	t.Helper()
	raw, ok := value.([]any)
	if !ok {
		t.Fatalf("expected []any output, got %#v", value)
	}
	items := make([]string, 0, len(raw))
	for _, item := range raw {
		text, ok := item.(string)
		if !ok {
			t.Fatalf("expected string item, got %#v", item)
		}
		items = append(items, text)
	}
	return items
}

func execute(t *testing.T, baseURL string, request protocol.ExecuteRequest) protocol.RunnerResult {
	t.Helper()
	result, _ := executeWithStatus(t, baseURL, request)
	return result
}

func executeWithStatus(t *testing.T, baseURL string, request protocol.ExecuteRequest) (protocol.RunnerResult, int) {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(baseURL+"/v1/remote-runner/execute", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	var result protocol.RunnerResult
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result, response.StatusCode
}
