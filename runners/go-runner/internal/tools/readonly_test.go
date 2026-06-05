package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/babel-o/go-runner/internal/protocol"
)

func TestReadGrepGlobExecute(t *testing.T) {
	workspace := t.TempDir()
	writeFixtureFile(t, filepath.Join(workspace, "README.md"), "hello\nneedle one\n")
	writeFixtureFile(t, filepath.Join(workspace, "src", "main.go"), "package main\n// needle two\n")

	read, errResult := Execute(context.Background(), request(workspace, "Read", `{"path":"README.md","offset":0,"limit":5}`))
	if errResult != nil || !read.Success || !strings.HasPrefix(read.Output.(string), "hello") {
		t.Fatalf("unexpected read result: %#v %#v", read, errResult)
	}

	grep, errResult := Execute(context.Background(), request(workspace, "Grep", `{"pattern":"needle","path":".","maxMatches":10}`))
	if errResult != nil || !grep.Success || !strings.Contains(grep.Output.(string), "README.md:2:needle one") || !strings.Contains(grep.Output.(string), "src/main.go:2:// needle two") {
		t.Fatalf("unexpected grep result: %#v %#v", grep, errResult)
	}

	glob, errResult := Execute(context.Background(), request(workspace, "Glob", `{"pattern":"**/*.go","maxResults":10}`))
	if errResult != nil || !glob.Success {
		t.Fatalf("unexpected glob result: %#v %#v", glob, errResult)
	}
	files := glob.Output.([]string)
	if len(files) != 1 || files[0] != "src/main.go" {
		t.Fatalf("unexpected glob files: %#v", files)
	}
}

func TestWriteEditExecute(t *testing.T) {
	workspace := t.TempDir()

	writeResult, errResult := Execute(context.Background(), request(workspace, "Write", `{"path":"src/new.txt","content":"hello world"}`))
	if errResult != nil || !writeResult.Success || writeResult.Output.(string) != "Wrote src/new.txt" {
		t.Fatalf("unexpected write result: %#v %#v", writeResult, errResult)
	}
	written, err := os.ReadFile(filepath.Join(workspace, "src", "new.txt"))
	if err != nil || string(written) != "hello world" {
		t.Fatalf("unexpected written file: %q %v", string(written), err)
	}

	editResult, errResult := Execute(context.Background(), request(workspace, "Edit", `{"path":"src/new.txt","oldString":"world","newString":"runner"}`))
	if errResult != nil || !editResult.Success || editResult.Output.(string) != "Edited src/new.txt" {
		t.Fatalf("unexpected edit result: %#v %#v", editResult, errResult)
	}
	edited, err := os.ReadFile(filepath.Join(workspace, "src", "new.txt"))
	if err != nil || string(edited) != "hello runner" {
		t.Fatalf("unexpected edited file: %q %v", string(edited), err)
	}

	missing, errResult := Execute(context.Background(), request(workspace, "Edit", `{"path":"src/new.txt","oldString":"absent","newString":"x"}`))
	if errResult != nil || missing.Success || missing.Output.(string) != "String not found in src/new.txt" {
		t.Fatalf("unexpected missing edit result: %#v %#v", missing, errResult)
	}

	writeFixtureFile(t, filepath.Join(workspace, "dupe.txt"), "same same")
	dupe, errResult := Execute(context.Background(), request(workspace, "Edit", `{"path":"dupe.txt","oldString":"same","newString":"x"}`))
	if errResult != nil || dupe.Success || !strings.Contains(dupe.Output.(string), "String is not unique in dupe.txt") {
		t.Fatalf("unexpected duplicate edit result: %#v %#v", dupe, errResult)
	}
}

func TestWriteRejectsWorkspaceEscapeAndSymlinkParentEscape(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()

	_, errResult := Execute(context.Background(), request(workspace, "Write", `{"path":"../secret.txt","content":"secret"}`))
	if errResult == nil || errResult.Code != "WORKSPACE_PATH_DENIED" {
		t.Fatalf("unexpected write escape result: %#v", errResult)
	}

	if err := os.Symlink(outside, filepath.Join(workspace, "outside-link")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	_, errResult = Execute(context.Background(), request(workspace, "Write", `{"path":"outside-link/secret.txt","content":"secret"}`))
	if errResult == nil || errResult.Code != "WORKSPACE_PATH_DENIED" {
		t.Fatalf("unexpected symlink parent escape result: %#v", errResult)
	}
}

func TestWorkspaceEscapeAndSymlinkEscape(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	writeFixtureFile(t, filepath.Join(outside, "secret.txt"), "secret")
	_, errResult := Execute(context.Background(), protocol.ExecuteRequest{
		ProtocolVersion: protocol.Version,
		SessionID:       "session-1",
		ToolName:        "Read",
		ToolInput:       json.RawMessage(`{"path":"../secret.txt"}`),
		Cwd:             workspace,
		AllowedPaths:    []string{workspace},
		MaxOutputBytes:  1000,
	})
	if errResult == nil || errResult.Code != "WORKSPACE_PATH_DENIED" {
		t.Fatalf("unexpected escape result: %#v", errResult)
	}

	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(workspace, "link.txt")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	_, errResult = Execute(context.Background(), request(workspace, "Read", `{"path":"link.txt"}`))
	if errResult == nil || errResult.Code != "WORKSPACE_PATH_DENIED" {
		t.Fatalf("unexpected symlink result: %#v", errResult)
	}
}

func TestSymlinkToSecondAllowedRootIsAccepted(t *testing.T) {
	workspace := t.TempDir()
	shared := t.TempDir()
	writeFixtureFile(t, filepath.Join(shared, "shared.txt"), "shared")
	if err := os.Symlink(filepath.Join(shared, "shared.txt"), filepath.Join(workspace, "shared-link.txt")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	read, errResult := Execute(context.Background(), protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		ToolName:           "Read",
		ToolInput:          json.RawMessage(`{"path":"shared-link.txt"}`),
		Cwd:                workspace,
		AllowedPaths:       []string{workspace, shared},
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if errResult != nil || !read.Success || read.Output.(string) != "shared" {
		t.Fatalf("unexpected multi-root symlink result: %#v %#v", read, errResult)
	}
}

func TestGlobRequiresCwd(t *testing.T) {
	_, errResult := Execute(context.Background(), protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		ToolName:           "Glob",
		ToolInput:          json.RawMessage(`{"pattern":"**/*.go"}`),
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	})
	if errResult == nil || errResult.Code != "REMOTE_RUNNER_MALFORMED_REQUEST" {
		t.Fatalf("unexpected missing cwd result: %#v", errResult)
	}
}

func TestContextCancellationAndTimeout(t *testing.T) {
	workspace := t.TempDir()
	writeFixtureFile(t, filepath.Join(workspace, "file.txt"), "hello")

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, errResult := Execute(cancelled, request(workspace, "Read", `{"path":"file.txt"}`))
	if errResult == nil || errResult.Code != "REQUEST_CANCELLED" {
		t.Fatalf("unexpected cancel result: %#v", errResult)
	}

	timedOut, cancelTimeout := context.WithDeadline(context.Background(), time.Now().Add(-time.Millisecond))
	defer cancelTimeout()
	_, errResult = Execute(timedOut, request(workspace, "Read", `{"path":"file.txt"}`))
	if errResult == nil || errResult.Code != "REQUEST_TIMEOUT" {
		t.Fatalf("unexpected timeout result: %#v", errResult)
	}
}

func request(workspace string, toolName string, input string) protocol.ExecuteRequest {
	return protocol.ExecuteRequest{
		ProtocolVersion:    protocol.Version,
		SessionID:          "session-1",
		ToolName:           toolName,
		ToolInput:          json.RawMessage(input),
		Cwd:                workspace,
		AllowedPaths:       []string{workspace},
		MaxOutputBytes:     1000,
		BashMaxBufferBytes: 1000,
	}
}

func writeFixtureFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}
