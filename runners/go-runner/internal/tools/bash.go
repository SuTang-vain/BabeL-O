package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"

	"github.com/babel-o/go-runner/internal/protocol"
)

type bashInput struct {
	Command   string `json:"command"`
	TimeoutMs int64  `json:"timeoutMs,omitempty"`
}

type bashOutput struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	Signal     string `json:"signal,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Message    string `json:"message,omitempty"`
}

func executeBash(ctx context.Context, request protocol.ExecuteRequest) (Result, *protocol.RunnerResult) {
	input := bashInput{TimeoutMs: request.DeadlineMs}
	if err := decodeToolInput(request.ToolInput, &input); err != nil {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Bash tool input must be an object.", map[string]string{"error": err.Error()})
		return Result{}, &invalid
	}
	if input.Command == "" {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Bash requires command.", nil)
		return Result{}, &invalid
	}
	if input.TimeoutMs <= 0 || input.TimeoutMs > request.DeadlineMs {
		input.TimeoutMs = request.DeadlineMs
	}
	if input.TimeoutMs <= 0 {
		input.TimeoutMs = 120_000
	}

	if _, errResult := resolveInsideAllowedRoots(request.Cwd, ".", request.AllowedPaths); errResult != nil {
		return Result{}, errResult
	}

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(input.TimeoutMs)*time.Millisecond)
	defer cancel()

	startedAt := time.Now()
	cmd := exec.CommandContext(runCtx, "/bin/sh", "-c", input.Command)
	cmd.Dir = request.Cwd
	cmd.Env = allowedBashEnv()
	configureProcessGroup(cmd)

	var stdout, stderr budgetBuffer
	stdout.maxBytes = request.BashMaxBufferBytes
	stderr.maxBytes = request.BashMaxBufferBytes
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Start()
	if err != nil {
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	var timedOut bool
	var cancelled bool
	select {
	case err = <-done:
	case <-runCtx.Done():
		timedOut = errors.Is(runCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil
		cancelled = !timedOut
		terminateProcess(cmd)
		err = <-done
	}

	durationMs := time.Since(startedAt).Milliseconds()
	output := bashOutput{Stdout: stdout.String(), Stderr: stderr.String(), DurationMs: durationMs}
	truncated := stdout.truncated || stderr.truncated
	originalBytes := stdout.originalBytes + stderr.originalBytes
	if err == nil {
		return applyOutputBudget(Result{Success: true, Output: output, Truncated: truncated, OriginalBytes: originalBytes}, request.MaxOutputBytes), nil
	}
	if cancelled {
		cancelledResult := protocol.ErrorResult("REQUEST_CANCELLED", "Remote runner request was cancelled.", map[string]any{"durationMs": durationMs, "stdout": output.Stdout, "stderr": output.Stderr})
		return Result{}, &cancelledResult
	}
	if timedOut {
		timeoutResult := protocol.ErrorResult("REQUEST_TIMEOUT", "Remote runner request exceeded deadline.", map[string]any{"durationMs": durationMs, "stdout": output.Stdout, "stderr": output.Stderr})
		return Result{}, &timeoutResult
	}

	output.Message = err.Error()
	if exitError, ok := err.(*exec.ExitError); ok {
		if status, ok := exitError.Sys().(syscall.WaitStatus); ok {
			if status.Signaled() {
				output.Signal = status.Signal().String()
			} else {
				exitCode := status.ExitStatus()
				output.ExitCode = &exitCode
			}
		}
	}
	return applyOutputBudget(Result{Success: false, Output: output, Truncated: truncated, OriginalBytes: originalBytes}, request.MaxOutputBytes), nil
}

type budgetBuffer struct {
	maxBytes      int64
	buf           bytes.Buffer
	originalBytes int64
	truncated     bool
}

func (b *budgetBuffer) Write(p []byte) (int, error) {
	b.originalBytes += int64(len(p))
	if b.maxBytes <= 0 {
		return len(p), nil
	}
	remaining := b.maxBytes - int64(b.buf.Len())
	if remaining <= 0 {
		b.truncated = true
		return len(p), nil
	}
	if int64(len(p)) > remaining {
		_, _ = b.buf.Write(p[:remaining])
		b.truncated = true
		return len(p), nil
	}
	_, _ = b.buf.Write(p)
	return len(p), nil
}

func (b *budgetBuffer) String() string {
	if b.truncated {
		return b.buf.String() + fmt.Sprintf("\n... (remote runner stream truncated to %d bytes)", b.maxBytes)
	}
	return b.buf.String()
}

func configureProcessGroup(cmd *exec.Cmd) {
	if runtime.GOOS == "windows" {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateProcess(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if runtime.GOOS != "windows" {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		return
	}
	_ = cmd.Process.Kill()
}

func allowedBashEnv() []string {
	allowedNames := []string{"PATH", "HOME", "SHELL", "TMPDIR", "LANG", "LC_ALL"}
	env := make([]string, 0, len(allowedNames))
	for _, name := range allowedNames {
		if value := os.Getenv(name); value != "" {
			env = append(env, name+"="+value)
		}
	}
	return env
}

var _ io.Writer = (*budgetBuffer)(nil)
