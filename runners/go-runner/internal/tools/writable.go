package tools

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/babel-o/go-runner/internal/protocol"
)

type writeInput struct {
	Path    string  `json:"path"`
	Content *string `json:"content"`
}

type editInput struct {
	Path      string  `json:"path"`
	OldString *string `json:"oldString"`
	NewString *string `json:"newString"`
}

func executeWrite(ctx context.Context, request protocol.ExecuteRequest) (Result, *protocol.RunnerResult) {
	var input writeInput
	if err := decodeToolInput(request.ToolInput, &input); err != nil {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Write tool input must be an object.", map[string]string{"error": err.Error()})
		return Result{}, &invalid
	}
	if input.Path == "" {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Write requires path.", nil)
		return Result{}, &invalid
	}
	if input.Content == nil {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Write requires content.", nil)
		return Result{}, &invalid
	}

	path, errResult := resolveWritablePathInsideAllowedRoots(request.Cwd, input.Path, request.AllowedPaths)
	if errResult != nil {
		return Result{}, errResult
	}
	if errResult := contextErrorResult(ctx); errResult != nil {
		return Result{}, errResult
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}
	if err := os.WriteFile(path, []byte(*input.Content), 0644); err != nil {
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}
	return applyOutputBudget(Result{Success: true, Output: fmt.Sprintf("Wrote %s", input.Path)}, request.MaxOutputBytes), nil
}

func executeEdit(ctx context.Context, request protocol.ExecuteRequest) (Result, *protocol.RunnerResult) {
	var input editInput
	if err := decodeToolInput(request.ToolInput, &input); err != nil {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Edit tool input must be an object.", map[string]string{"error": err.Error()})
		return Result{}, &invalid
	}
	if input.Path == "" {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Edit requires path.", nil)
		return Result{}, &invalid
	}
	if input.OldString == nil || input.NewString == nil {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Edit requires oldString and newString.", nil)
		return Result{}, &invalid
	}

	path, errResult := resolveWritablePathInsideAllowedRoots(request.Cwd, input.Path, request.AllowedPaths)
	if errResult != nil {
		return Result{}, errResult
	}
	if errResult := contextErrorResult(ctx); errResult != nil {
		return Result{}, errResult
	}
	beforeBytes, err := os.ReadFile(path)
	if err != nil {
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}
	before := string(beforeBytes)
	occurrences := strings.Count(before, *input.OldString)
	if occurrences == 0 {
		return Result{Success: false, Output: fmt.Sprintf("String not found in %s", input.Path)}, nil
	}
	if occurrences > 1 {
		return Result{Success: false, Output: fmt.Sprintf("String is not unique in %s (found %d occurrences). Provide more context to make it unique.", input.Path, occurrences)}, nil
	}
	after := strings.Replace(before, *input.OldString, *input.NewString, 1)
	if err := os.WriteFile(path, []byte(after), 0644); err != nil {
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}
	return applyOutputBudget(Result{Success: true, Output: fmt.Sprintf("Edited %s", input.Path)}, request.MaxOutputBytes), nil
}

func resolveWritablePathInsideAllowedRoots(cwd string, inputPath string, allowedPaths []string) (string, *protocol.RunnerResult) {
	if cwd == "" {
		result := protocol.ErrorResult("REMOTE_RUNNER_MALFORMED_REQUEST", "Execute request requires cwd.", nil)
		return "", &result
	}
	cleanCwd, err := canonicalPath(cwd)
	if err != nil {
		result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Invalid cwd.", map[string]string{"cwd": cwd, "error": err.Error()})
		return "", &result
	}
	candidate := inputPath
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(cleanCwd, inputPath)
	}
	candidate, err = filepath.Abs(filepath.Clean(candidate))
	if err != nil {
		result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Requested path is outside the allowed workspace.", map[string]string{"requestedPath": inputPath, "cwd": cleanCwd, "error": err.Error()})
		return "", &result
	}

	cleanRoots := writableAllowedRoots(cleanCwd, allowedPaths)
	if !insideAnyRoot(candidate, cleanRoots) {
		result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Requested path is outside the allowed workspace.", map[string]string{"requestedPath": inputPath, "cwd": cleanCwd, "resolvedPath": candidate})
		return "", &result
	}
	if evaluated, err := filepath.EvalSymlinks(candidate); err == nil {
		evaluated, err = canonicalPath(evaluated)
		if err == nil && !insideAnyRoot(evaluated, cleanRoots) {
			result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Requested path is outside the allowed workspace.", map[string]string{"requestedPath": inputPath, "cwd": cleanCwd, "resolvedPath": evaluated})
			return "", &result
		}
		return candidate, nil
	}

	ancestor := filepath.Dir(candidate)
	for {
		if info, statErr := os.Stat(ancestor); statErr == nil {
			if info.IsDir() {
				evaluated, evalErr := filepath.EvalSymlinks(ancestor)
				if evalErr != nil {
					result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Requested path is outside the allowed workspace.", map[string]string{"requestedPath": inputPath, "cwd": cleanCwd, "error": evalErr.Error()})
					return "", &result
				}
				evaluated, evalErr = canonicalPath(evaluated)
				if evalErr != nil || !insideAnyRoot(evaluated, cleanRoots) {
					result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Requested path is outside the allowed workspace.", map[string]string{"requestedPath": inputPath, "cwd": cleanCwd, "resolvedPath": evaluated})
					return "", &result
				}
			}
			return candidate, nil
		} else if !errors.Is(statErr, os.ErrNotExist) {
			result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Requested path is outside the allowed workspace.", map[string]string{"requestedPath": inputPath, "cwd": cleanCwd, "error": statErr.Error()})
			return "", &result
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			break
		}
		ancestor = parent
	}

	result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Requested path is outside the allowed workspace.", map[string]string{"requestedPath": inputPath, "cwd": cleanCwd, "resolvedPath": candidate})
	return "", &result
}

func writableAllowedRoots(cleanCwd string, allowedPaths []string) []string {
	roots := allowedPaths
	if len(roots) == 0 {
		roots = []string{cleanCwd}
	}
	cleanRoots := make([]string, 0, len(roots))
	for _, root := range roots {
		cleanRoot := root
		if !filepath.IsAbs(cleanRoot) {
			cleanRoot = filepath.Join(cleanCwd, cleanRoot)
		}
		var err error
		cleanRoot, err = canonicalPath(cleanRoot)
		if err != nil {
			continue
		}
		cleanRoots = append(cleanRoots, cleanRoot)
	}
	return cleanRoots
}

func contextErrorResult(ctx context.Context) *protocol.RunnerResult {
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			result := protocol.ErrorResult("REQUEST_TIMEOUT", "Remote runner request exceeded deadline.", nil)
			return &result
		}
		result := protocol.ErrorResult("REQUEST_CANCELLED", "Remote runner request was cancelled.", nil)
		return &result
	}
	return nil
}
