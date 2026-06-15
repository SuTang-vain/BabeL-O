// internal/loop/loop_test.go
//
// Phase 2a: smoke tests for cmd/bbl-loop's entry-point skeleton.
// Pure white-box coverage of the package-level plumbing; the
// full LoopModel / API client land in Phase 2b / 2c.

package loop

import (
	"bytes"
	"strings"
	"testing"
)

func TestVersionString(t *testing.T) {
	got := VersionString()
	if !strings.HasPrefix(got, "bbl loop ") {
		t.Fatalf("VersionString() = %q, want prefix %q", got, "bbl loop ")
	}
}

func TestRunSmokePrintsConfigAndDoesNotError(t *testing.T) {
	var buf bytes.Buffer
	cfg := Config{
		BaseURL:        "http://127.0.0.1:3000",
		Cwd:            "/tmp",
		WorkspaceID:    "ws-test",
		StatePath:      "/tmp/bbl-loop-state.json",
		PollIntervalMs: 1000,
		WaitTimeoutMs:  500,
		AltScreen:      true,
		MouseCapture:   true,
	}
	if err := runSmoke(cfg, &buf); err != nil {
		t.Fatalf("runSmoke: %v", err)
	}
	out := buf.String()
	wantSubstrings := []string{
		"bbl loop " + Version,
		"url=http://127.0.0.1:3000",
		"cwd=/tmp",
		"workspace=ws-test",
		"state=/tmp/bbl-loop-state.json",
		"pollIntervalMs=1000",
		"waitTimeoutMs=500",
		"altScreen=true",
		"mouse=true",
	}
	for _, want := range wantSubstrings {
		if !strings.Contains(out, want) {
			t.Fatalf("runSmoke output missing %q\nfull:\n%s", want, out)
		}
	}
}

func TestRunSmokeFallsBackWhenHomeUnset(t *testing.T) {
	t.Setenv("HOME", "")
	got := defaultStatePath()
	if got == "" {
		t.Fatalf("defaultStatePath() = empty when HOME is unset")
	}
	if !strings.Contains(got, "bbl-loop-state.json") {
		t.Fatalf("defaultStatePath() = %q, want path containing bbl-loop-state.json", got)
	}
}

func TestRunSmokeUsesStatePathOverride(t *testing.T) {
	var buf bytes.Buffer
	cfg := Config{
		BaseURL:     "http://127.0.0.1:3000",
		Cwd:         "/tmp",
		WorkspaceID: "ws-test",
		StatePath:   "/custom/state.json",
	}
	if err := runSmoke(cfg, &buf); err != nil {
		t.Fatalf("runSmoke: %v", err)
	}
	if !strings.Contains(buf.String(), "state=/custom/state.json") {
		t.Fatalf("expected override path in output, got:\n%s", buf.String())
	}
}
