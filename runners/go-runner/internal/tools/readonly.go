package tools

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/babel-o/go-runner/internal/protocol"
)

const (
	defaultMaxBytes          = 200_000
	largeFilePreviewBytes    = 50_000
	defaultListDirMaxEntries = 200
	defaultGlobMaxResults    = 100
	defaultGrepMaxMatches    = 50
)

var dependencyDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	"dist":         true,
	"build":        true,
	"coverage":     true,
	".next":        true,
	".nuxt":        true,
	".turbo":       true,
	".cache":       true,
	"target":       true,
	"vendor":       true,
}

type Result struct {
	Success       bool
	Output        any
	Truncated     bool
	OriginalBytes int64
}

func Execute(ctx context.Context, request protocol.ExecuteRequest) (Result, *protocol.RunnerResult) {
	switch request.ToolName {
	case "ListDir":
		return executeListDir(ctx, request)
	case "Glob":
		return executeGlob(ctx, request)
	case "Grep":
		return executeGrep(ctx, request)
	case "Read":
		return executeRead(ctx, request)
	case "Bash":
		return executeBash(ctx, request)
	case "Write":
		return executeWrite(ctx, request)
	case "Edit":
		return executeEdit(ctx, request)
	default:
		unsupported := protocol.ErrorResult("REMOTE_RUNNER_TOOL_UNSUPPORTED", "Remote runner does not support tool "+request.ToolName+".", nil)
		return Result{}, &unsupported
	}
}

func SupportedTools(bashEnabled bool, writeEnabled bool) []string {
	toolNames := []string{"ListDir", "Glob", "Grep", "Read"}
	if bashEnabled {
		toolNames = append(toolNames, "Bash")
	}
	if writeEnabled {
		toolNames = append(toolNames, "Write", "Edit")
	}
	return toolNames
}

func IsSupportedTool(toolName string, bashEnabled bool, writeEnabled bool) bool {
	return toolName == "ListDir" || toolName == "Glob" || toolName == "Grep" || toolName == "Read" || (bashEnabled && toolName == "Bash") || (writeEnabled && (toolName == "Write" || toolName == "Edit"))
}

type listDirInput struct {
	Path               string `json:"path,omitempty"`
	MaxEntries         int    `json:"maxEntries,omitempty"`
	IncludeHidden      bool   `json:"includeHidden,omitempty"`
	IncludeFiles       *bool  `json:"includeFiles,omitempty"`
	IncludeDirectories *bool  `json:"includeDirectories,omitempty"`
	MaxDepth           int    `json:"maxDepth,omitempty"`
}

type listDirEntry struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Depth int    `json:"depth"`
}

type listDirCounts struct {
	Files              int `json:"files"`
	Directories        int `json:"directories"`
	Symlinks           int `json:"symlinks"`
	Other              int `json:"other"`
	Shown              int `json:"shown"`
	SkippedHidden      int `json:"skippedHidden"`
	SkippedByType      int `json:"skippedByType"`
	SkippedDirectories int `json:"skippedDirectories"`
}

type listDirOutput struct {
	Path         string         `json:"path"`
	ResolvedPath string         `json:"resolvedPath"`
	MaxDepth     int            `json:"maxDepth"`
	Entries      []listDirEntry `json:"entries"`
	Counts       listDirCounts  `json:"counts"`
	Truncated    bool           `json:"truncated"`
	SkippedDirs  []string       `json:"skippedDirs"`
	Guidance     string         `json:"guidance"`
}

type listDirState struct {
	cwd         string
	input       listDirInput
	entries     []listDirEntry
	counts      listDirCounts
	truncated   bool
	skippedDirs []string
}

func executeListDir(ctx context.Context, request protocol.ExecuteRequest) (Result, *protocol.RunnerResult) {
	input := listDirInput{Path: ".", MaxEntries: defaultListDirMaxEntries, MaxDepth: 1}
	if err := decodeToolInput(request.ToolInput, &input); err != nil {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "ListDir tool input must be an object.", map[string]string{"error": err.Error()})
		return Result{}, &invalid
	}
	if input.Path == "" {
		input.Path = "."
	}
	if input.MaxEntries == 0 {
		input.MaxEntries = defaultListDirMaxEntries
	}
	if input.MaxDepth == 0 {
		input.MaxDepth = 1
	}
	if input.MaxEntries <= 0 || input.MaxEntries > 1_000 {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "ListDir maxEntries must be between 1 and 1000.", nil)
		return Result{}, &invalid
	}
	if input.MaxDepth != 1 && input.MaxDepth != 2 {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "ListDir maxDepth must be 1 or 2.", nil)
		return Result{}, &invalid
	}
	includeFiles := true
	if input.IncludeFiles != nil {
		includeFiles = *input.IncludeFiles
	}
	includeDirectories := true
	if input.IncludeDirectories != nil {
		includeDirectories = *input.IncludeDirectories
	}
	if !includeFiles && !includeDirectories {
		return Result{Success: false, Output: "ListDir requires at least one of includeFiles or includeDirectories to be true."}, nil
	}

	path, errResult := resolveInsideAllowedRoots(request.Cwd, input.Path, request.AllowedPaths)
	if errResult != nil {
		return Result{}, errResult
	}
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			timedOut := protocol.ErrorResult("REQUEST_TIMEOUT", "Remote runner request exceeded deadline.", nil)
			return Result{}, &timedOut
		}
		cancelled := protocol.ErrorResult("REQUEST_CANCELLED", "Remote runner request was cancelled.", nil)
		return Result{}, &cancelled
	}
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Result{Success: false, Output: fmt.Sprintf("ListDir could not find directory %q. Use ListDir on an existing parent directory or Glob for pattern-based discovery.", input.Path)}, nil
		}
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}
	if !info.IsDir() {
		return Result{Success: false, Output: fmt.Sprintf("ListDir expected a directory but %q is not a directory. Use Read for file contents.", input.Path)}, nil
	}

	cleanCwd, err := canonicalPath(request.Cwd)
	if err != nil {
		cleanCwd = request.Cwd
	}
	state := &listDirState{
		cwd:         cleanCwd,
		input:       input,
		entries:     []listDirEntry{},
		skippedDirs: []string{},
	}
	if err := collectDirectory(ctx, state, path, 1, includeFiles, includeDirectories); err != nil {
		if errors.Is(err, context.Canceled) {
			cancelled := protocol.ErrorResult("REQUEST_CANCELLED", "Remote runner request was cancelled.", nil)
			return Result{}, &cancelled
		}
		if errors.Is(err, context.DeadlineExceeded) {
			timedOut := protocol.ErrorResult("REQUEST_TIMEOUT", "Remote runner request exceeded deadline.", nil)
			return Result{}, &timedOut
		}
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}

	output := listDirOutput{
		Path:         input.Path,
		ResolvedPath: path,
		MaxDepth:     input.MaxDepth,
		Entries:      state.entries,
		Counts:       state.counts,
		Truncated:    state.truncated,
		SkippedDirs:  state.skippedDirs,
		Guidance:     "ListDir only proves directory inventory. Use Glob for pattern discovery, Grep for content matches, and Read before making source-level claims.",
	}
	return Result{Success: true, Output: output}, nil
}

func collectDirectory(ctx context.Context, state *listDirState, dir string, depth int, includeFiles bool, includeDirectories bool) error {
	if state.truncated {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	sort.Slice(entries, func(left int, right int) bool {
		leftDir := entries[left].IsDir()
		rightDir := entries[right].IsDir()
		if leftDir != rightDir {
			return leftDir
		}
		return entries[left].Name() < entries[right].Name()
	})

	for _, entry := range entries {
		if len(state.entries) >= state.input.MaxEntries {
			state.truncated = true
			return nil
		}
		if !state.input.IncludeHidden && strings.HasPrefix(entry.Name(), ".") {
			state.counts.SkippedHidden += 1
			continue
		}

		fullPath := filepath.Join(dir, entry.Name())
		typeName := listDirEntryType(entry)
		incrementListDirCount(state, typeName)
		if typeName == "directory" && dependencyDirs[entry.Name()] {
			state.counts.SkippedDirectories += 1
			state.skippedDirs = append(state.skippedDirs, formatRelativePath(state.cwd, fullPath))
			continue
		}

		typeAllowed := includeFiles
		if typeName == "directory" {
			typeAllowed = includeDirectories
		}
		if !typeAllowed {
			state.counts.SkippedByType += 1
		} else {
			state.entries = append(state.entries, listDirEntry{
				Path:  formatRelativePath(state.cwd, fullPath),
				Name:  entry.Name(),
				Type:  typeName,
				Depth: depth,
			})
			state.counts.Shown = len(state.entries)
		}

		if typeName == "directory" && depth < state.input.MaxDepth {
			if err := collectDirectory(ctx, state, fullPath, 2, includeFiles, includeDirectories); err != nil {
				return err
			}
		}
	}
	return nil
}

func listDirEntryType(entry os.DirEntry) string {
	if entry.IsDir() {
		return "directory"
	}
	if entry.Type()&os.ModeSymlink != 0 {
		return "symlink"
	}
	if entry.Type().IsRegular() {
		return "file"
	}
	info, err := entry.Info()
	if err == nil && info.Mode().IsRegular() {
		return "file"
	}
	return "other"
}

func incrementListDirCount(state *listDirState, typeName string) {
	switch typeName {
	case "file":
		state.counts.Files += 1
	case "directory":
		state.counts.Directories += 1
	case "symlink":
		state.counts.Symlinks += 1
	default:
		state.counts.Other += 1
	}
}

func formatRelativePath(cwd string, path string) string {
	rel, err := filepath.Rel(cwd, path)
	if err != nil || rel == "" {
		return "."
	}
	return filepath.ToSlash(rel)
}

type readInput struct {
	Path     string `json:"path"`
	MaxBytes int64  `json:"maxBytes,omitempty"`
	Offset   *int64 `json:"offset,omitempty"`
	Limit    *int64 `json:"limit,omitempty"`
	Mode     string `json:"mode,omitempty"`
}

func executeRead(ctx context.Context, request protocol.ExecuteRequest) (Result, *protocol.RunnerResult) {
	input := readInput{MaxBytes: defaultMaxBytes, Mode: "auto"}
	if err := decodeToolInput(request.ToolInput, &input); err != nil {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Read tool input must be an object.", map[string]string{"error": err.Error()})
		return Result{}, &invalid
	}
	if input.Path == "" {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Read requires path.", nil)
		return Result{}, &invalid
	}
	if input.MaxBytes <= 0 || input.MaxBytes > 1_000_000 {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Read maxBytes must be between 1 and 1000000.", nil)
		return Result{}, &invalid
	}
	if input.Offset != nil && *input.Offset < 0 {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Read offset must be non-negative.", nil)
		return Result{}, &invalid
	}
	if input.Limit != nil && (*input.Limit <= 0 || *input.Limit > 1_000_000) {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Read limit must be between 1 and 1000000.", nil)
		return Result{}, &invalid
	}
	if input.Mode == "" {
		input.Mode = "auto"
	}
	if input.Mode != "auto" && input.Mode != "full" && input.Mode != "preview" {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Read mode must be auto, full, or preview.", nil)
		return Result{}, &invalid
	}

	path, errResult := resolveInsideAllowedRoots(request.Cwd, input.Path, request.AllowedPaths)
	if errResult != nil {
		return Result{}, errResult
	}
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			timedOut := protocol.ErrorResult("REQUEST_TIMEOUT", "Remote runner request exceeded deadline.", nil)
			return Result{}, &timedOut
		}
		cancelled := protocol.ErrorResult("REQUEST_CANCELLED", "Remote runner request was cancelled.", nil)
		return Result{}, &cancelled
	}
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Result{Success: false, Output: fmt.Sprintf("Read could not find %q. Check the path or use Glob to discover available files.", input.Path)}, nil
		}
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}
	if info.IsDir() {
		return Result{Success: false, Output: fmt.Sprintf("Read expected a file but %q is a directory. Use ListDir for directory inventory or Read a specific file path inside it.", input.Path)}, nil
	}
	if !info.Mode().IsRegular() {
		return Result{Success: false, Output: fmt.Sprintf("Read expected a regular file but %q is not a file.", input.Path)}, nil
	}
	file, err := os.ReadFile(path)
	if err != nil {
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}

	start := int64(0)
	if input.Offset != nil {
		start = *input.Offset
	}
	if start > int64(len(file)) {
		start = int64(len(file))
	}
	requestedBytes := input.MaxBytes
	if input.Limit != nil {
		requestedBytes = *input.Limit
	}
	shouldPreview := input.Mode == "preview" || (input.Mode == "auto" && input.Offset == nil && input.Limit == nil && int64(len(file)) > input.MaxBytes)
	readBytes := minInt64(requestedBytes, input.MaxBytes, int64(len(file))-start)
	if shouldPreview {
		readBytes = minInt64(largeFilePreviewBytes, input.MaxBytes, int64(len(file)))
	} else if input.Mode == "full" && input.Offset == nil && input.Limit == nil {
		readBytes = minInt64(int64(len(file)), input.MaxBytes)
	}
	if readBytes < 0 {
		readBytes = 0
	}
	end := minInt64(int64(len(file)), start+readBytes)
	output := string(file[int(start):int(end)])

	if shouldPreview {
		remainingBytes := int64(len(file)) - end
		return applyOutputBudget(Result{Success: true, Output: strings.Join([]string{
			fmt.Sprintf("<read-preview path=%q bytes=%d shown=%d remaining=%d>", input.Path, len(file), end-start, remainingBytes),
			output,
			"</read-preview>",
			fmt.Sprintf("Use Read with offset=%d and limit=%d for the next range, or use Grep/Glob to target symbols before reading more.", end, minInt64(input.MaxBytes, largeFilePreviewBytes)),
		}, "\n")}, request.MaxOutputBytes), nil
	}
	if end < int64(len(file)) {
		return applyOutputBudget(Result{Success: true, Output: output + fmt.Sprintf("\n<read-truncated path=%q bytes=%d shownRange=%q>Use Read with offset=%d and limit=%d to continue.</read-truncated>", input.Path, len(file), fmt.Sprintf("%d-%d", start, end), end, minInt64(input.MaxBytes, requestedBytes))}, request.MaxOutputBytes), nil
	}
	return applyOutputBudget(Result{Success: true, Output: output}, request.MaxOutputBytes), nil
}

type grepInput struct {
	Pattern    string `json:"pattern"`
	Path       string `json:"path,omitempty"`
	MaxMatches int    `json:"maxMatches,omitempty"`
}

func executeGrep(ctx context.Context, request protocol.ExecuteRequest) (Result, *protocol.RunnerResult) {
	input := grepInput{Path: ".", MaxMatches: defaultGrepMaxMatches}
	if err := decodeToolInput(request.ToolInput, &input); err != nil {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Grep tool input must be an object.", map[string]string{"error": err.Error()})
		return Result{}, &invalid
	}
	if input.Pattern == "" {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Grep requires pattern.", nil)
		return Result{}, &invalid
	}
	if input.Path == "" {
		input.Path = "."
	}
	if input.MaxMatches <= 0 || input.MaxMatches > 200 {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Grep maxMatches must be between 1 and 200.", nil)
		return Result{}, &invalid
	}
	root, errResult := resolveInsideAllowedRoots(request.Cwd, input.Path, request.AllowedPaths)
	if errResult != nil {
		return Result{}, errResult
	}
	pattern, err := regexp.Compile(input.Pattern)
	if err != nil {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Grep pattern must be a valid Go regular expression.", map[string]string{"error": err.Error()})
		return Result{}, &invalid
	}
	probeLimit := input.MaxMatches + 1
	matches := make([]string, 0, probeLimit)
	var originalBytes int64
	truncated := false

	err = walkFiles(ctx, root, request.Cwd, request.AllowedPaths, func(path string) error {
		if len(matches) >= probeLimit {
			return stopWalk
		}
		fileMatches, bytesRead, err := grepFile(ctx, path, pattern, probeLimit-len(matches), request.Cwd)
		originalBytes += bytesRead
		if err != nil {
			return nil
		}
		matches = append(matches, fileMatches...)
		return nil
	})
	if err != nil {
		if errors.Is(err, context.Canceled) {
			cancelled := protocol.ErrorResult("REQUEST_CANCELLED", "Remote runner request was cancelled.", nil)
			return Result{}, &cancelled
		}
		if errors.Is(err, context.DeadlineExceeded) {
			timedOut := protocol.ErrorResult("REQUEST_TIMEOUT", "Remote runner request exceeded deadline.", nil)
			return Result{}, &timedOut
		}
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}
	if len(matches) > input.MaxMatches {
		truncated = true
		matches = matches[:input.MaxMatches]
		matches = append(matches, targetedGrepTruncationHint(input.MaxMatches))
	}
	output := strings.Join(matches, "\n")
	if output != "" && !strings.HasSuffix(output, "\n") && !truncated {
		output += "\n"
	}
	return applyOutputBudget(Result{Success: true, Output: output, Truncated: truncated, OriginalBytes: originalBytes}, request.MaxOutputBytes), nil
}

type globInput struct {
	Pattern    string `json:"pattern"`
	Path       string `json:"path,omitempty"`
	MaxResults int    `json:"maxResults,omitempty"`
}

func executeGlob(ctx context.Context, request protocol.ExecuteRequest) (Result, *protocol.RunnerResult) {
	input := globInput{MaxResults: defaultGlobMaxResults}
	if err := decodeToolInput(request.ToolInput, &input); err != nil {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Glob tool input must be an object.", map[string]string{"error": err.Error()})
		return Result{}, &invalid
	}
	if input.Pattern == "" {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Glob requires pattern.", nil)
		return Result{}, &invalid
	}
	if input.MaxResults <= 0 || input.MaxResults > 500 {
		invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Glob maxResults must be between 1 and 500.", nil)
		return Result{}, &invalid
	}
	rootPath := "."
	if input.Path != "" {
		rootPath = input.Path
	}
	root, errResult := resolveInsideAllowedRoots(request.Cwd, rootPath, request.AllowedPaths)
	if errResult != nil {
		return Result{}, errResult
	}
	globPattern := normalizeGlobPattern(input.Pattern, root, request.Cwd)
	probeLimit := input.MaxResults + 1
	files := make([]string, 0, probeLimit)
	err := walkFiles(ctx, root, request.Cwd, request.AllowedPaths, func(path string) error {
		if len(files) >= probeLimit {
			return stopWalk
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		matched, err := pathMatch(globPattern, rel)
		if err != nil {
			invalid := protocol.ErrorResult("INVALID_TOOL_INPUT", "Glob pattern is invalid.", map[string]string{"error": err.Error()})
			return runnerError{result: invalid}
		}
		if matched {
			files = append(files, rel)
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, context.Canceled) {
			cancelled := protocol.ErrorResult("REQUEST_CANCELLED", "Remote runner request was cancelled.", nil)
			return Result{}, &cancelled
		}
		if errors.Is(err, context.DeadlineExceeded) {
			timedOut := protocol.ErrorResult("REQUEST_TIMEOUT", "Remote runner request exceeded deadline.", nil)
			return Result{}, &timedOut
		}
		var runErr runnerError
		if errors.As(err, &runErr) {
			return Result{}, &runErr.result
		}
		failure := protocol.ErrorResult("REMOTE_RUNNER_TOOL_ERROR", err.Error(), nil)
		return Result{}, &failure
	}
	sort.Strings(files)
	truncated := len(files) > input.MaxResults
	if truncated {
		files = files[:input.MaxResults]
		files = append(files, fmt.Sprintf("... (%d more results truncated; narrow the pattern/path, then use Grep or targeted Read on the most relevant files)", 1))
	}
	return applyOutputBudget(Result{Success: true, Output: files, Truncated: truncated}, request.MaxOutputBytes), nil
}

func decodeToolInput(raw json.RawMessage, target any) error {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	return decoder.Decode(target)
}

func resolveInsideAllowedRoots(cwd string, inputPath string, allowedPaths []string) (string, *protocol.RunnerResult) {
	if cwd == "" {
		result := protocol.ErrorResult("REMOTE_RUNNER_MALFORMED_REQUEST", "Execute request requires cwd.", nil)
		return "", &result
	}
	cleanCwd, err := canonicalPath(cwd)
	if err != nil {
		result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Invalid cwd.", map[string]string{"cwd": cwd, "error": err.Error()})
		return "", &result
	}
	requested := inputPath
	if requested == "" {
		requested = "."
	}
	candidate := requested
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(cleanCwd, requested)
	}
	resolved, err := canonicalPath(candidate)
	if err != nil {
		result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Requested path is outside the allowed workspace.", map[string]string{"requestedPath": inputPath, "cwd": cleanCwd, "error": err.Error()})
		return "", &result
	}
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
		cleanRoot, err = canonicalPath(cleanRoot)
		if err != nil {
			continue
		}
		cleanRoots = append(cleanRoots, cleanRoot)
	}
	for _, cleanRoot := range cleanRoots {
		if pathInside(resolved, cleanRoot) {
			if evaluated, err := filepath.EvalSymlinks(resolved); err == nil {
				evaluated, err = canonicalPath(evaluated)
				if err == nil && !insideAnyRoot(evaluated, cleanRoots) {
					result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Requested path is outside the allowed workspace.", map[string]string{"requestedPath": inputPath, "cwd": cleanCwd, "resolvedPath": evaluated})
					return "", &result
				}
			}
			return resolved, nil
		}
	}
	result := protocol.ErrorResult("WORKSPACE_PATH_DENIED", "Requested path is outside the allowed workspace.", map[string]string{"requestedPath": inputPath, "cwd": cleanCwd, "resolvedPath": resolved})
	return "", &result
}

func canonicalPath(path string) (string, error) {
	clean, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	evaluated, err := filepath.EvalSymlinks(clean)
	if err == nil {
		return filepath.Abs(filepath.Clean(evaluated))
	}
	return clean, nil
}

func insideAnyRoot(path string, roots []string) bool {
	for _, root := range roots {
		if pathInside(path, root) {
			return true
		}
	}
	return false
}

func pathInside(path string, root string) bool {
	if path == root {
		return true
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

var stopWalk = errors.New("stop walk")

type runnerError struct {
	result protocol.RunnerResult
}

func (e runnerError) Error() string {
	return e.result.Message
}

func walkFiles(ctx context.Context, root string, cwd string, allowedPaths []string, visit func(path string) error) error {
	rootInfo, err := os.Stat(root)
	if err != nil {
		return nil
	}
	if rootInfo.Mode().IsRegular() {
		return visit(root)
	}
	if !rootInfo.IsDir() {
		return nil
	}
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if entry.IsDir() {
			if path != root && dependencyDirs[entry.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		if _, errResult := resolveInsideAllowedRoots(cwd, path, allowedPaths); errResult != nil {
			return nil
		}
		if err := visit(path); err != nil {
			if errors.Is(err, stopWalk) {
				return stopWalk
			}
			return err
		}
		return nil
	})
	if errors.Is(err, stopWalk) {
		return nil
	}
	return err
}

func grepFile(ctx context.Context, path string, pattern *regexp.Regexp, maxMatches int, cwd string) ([]string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	info, _ := file.Stat()
	var bytesRead int64
	if info != nil {
		bytesRead = info.Size()
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	matches := make([]string, 0, maxMatches)
	lineNumber := 0
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil, bytesRead, ctx.Err()
		}
		lineNumber++
		line := scanner.Text()
		if pattern.MatchString(line) {
			rel, err := filepath.Rel(cwd, path)
			if err != nil {
				rel = path
			}
			matches = append(matches, fmt.Sprintf("%s:%d:%s", filepath.ToSlash(rel), lineNumber, line))
			if len(matches) >= maxMatches {
				break
			}
		}
	}
	return matches, bytesRead, scanner.Err()
}

func targetedGrepTruncationHint(maxMatches int) string {
	return fmt.Sprintf("... (%d matches shown; more matches truncated for context budget. Narrow the pattern/path, then use Read with offset/limit around the relevant file lines.)", maxMatches)
}

func normalizeGlobPattern(pattern string, root string, cwd string) string {
	if hasGlobMeta(pattern) {
		return filepath.ToSlash(pattern)
	}
	if filepath.IsAbs(pattern) {
		rel, err := filepath.Rel(root, pattern)
		if err != nil || strings.HasPrefix(rel, "..") {
			return "**/*"
		}
		if rel == "." || rel == "" {
			return "**/*"
		}
		return filepath.ToSlash(filepath.Join(rel, "**", "*"))
	}
	return "**/*" + filepath.ToSlash(pattern) + "*"
}

func hasGlobMeta(pattern string) bool {
	return strings.ContainsAny(pattern, "*?[]{}")
}

func pathMatch(pattern string, rel string) (bool, error) {
	pattern = filepath.ToSlash(pattern)
	rel = filepath.ToSlash(rel)
	if strings.HasPrefix(pattern, "**/*") && strings.HasSuffix(pattern, "*") && !strings.ContainsAny(strings.TrimSuffix(strings.TrimPrefix(pattern, "**/*"), "*"), "*?[]{}") {
		needle := strings.TrimSuffix(strings.TrimPrefix(pattern, "**/*"), "*")
		return strings.Contains(rel, needle), nil
	}
	return matchSegments(strings.Split(pattern, "/"), strings.Split(rel, "/"))
}

func matchSegments(pattern []string, parts []string) (bool, error) {
	if len(pattern) == 0 {
		return len(parts) == 0, nil
	}
	if pattern[0] == "**" {
		for index := 0; index <= len(parts); index++ {
			matched, err := matchSegments(pattern[1:], parts[index:])
			if err != nil || matched {
				return matched, err
			}
		}
		return false, nil
	}
	if len(parts) == 0 {
		return false, nil
	}
	matched, err := filepath.Match(pattern[0], parts[0])
	if err != nil || !matched {
		return matched, err
	}
	return matchSegments(pattern[1:], parts[1:])
}

func applyOutputBudget(result Result, maxOutputBytes int64) Result {
	if maxOutputBytes <= 0 {
		return result
	}
	switch output := result.Output.(type) {
	case string:
		if int64(len(output)) <= maxOutputBytes {
			if result.OriginalBytes == 0 {
				result.OriginalBytes = int64(len(output))
			}
			return result
		}
		result.Output = output[:int(maxOutputBytes)] + fmt.Sprintf("\n... (remote runner output truncated to %d bytes)", maxOutputBytes)
		result.Truncated = true
		if result.OriginalBytes == 0 {
			result.OriginalBytes = int64(len(output))
		}
	case []string:
		var total int64
		truncated := make([]string, 0, len(output))
		for _, item := range output {
			itemBytes := int64(len(item))
			if total+itemBytes > maxOutputBytes {
				result.Truncated = true
				truncated = append(truncated, fmt.Sprintf("... (remote runner output truncated to %d bytes)", maxOutputBytes))
				break
			}
			truncated = append(truncated, item)
			total += itemBytes
		}
		result.Output = truncated
		if result.OriginalBytes == 0 {
			var original int64
			for _, item := range output {
				original += int64(len(item))
			}
			result.OriginalBytes = original
		}
	}
	return result
}

func minInt64(values ...int64) int64 {
	if len(values) == 0 {
		return 0
	}
	min := values[0]
	for _, value := range values[1:] {
		if value < min {
			min = value
		}
	}
	return min
}
