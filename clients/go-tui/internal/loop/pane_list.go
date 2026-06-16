// internal/loop/pane_list.go
//
// Phase 3e: pane list overlay renderer. Pure function that
// walks the LoopModel and returns one formatted line per
// workspace / tab / pane, with a focus marker on the currently
// focused pane. The Bubble Tea adapter (Phase 3f / 4) splices
// the result into the `pane_list` overlay. Until then the line
// buffer can be rendered by tests or dumped via `bbl loop
// --status` for smoke verification.

package loop

import "strings"

// PaneListLine captures the components of one rendered line so
// callers can apply their own styling without re-parsing text.
// `Marker` is the leading focus marker (">" when focused, " "
// otherwise). `Indent` is the leading whitespace count.
type PaneListLine struct {
	Depth  int
	Marker string
	Label  string
	Status PaneStatus
}

// BuildPaneListLines returns the per-pane lines for the model
// in tree order. Each pane gets one line; tabs and workspaces
// produce a header line. The line buffer never exceeds the
// number of panes plus the number of containers, so the
// caller can size the overlay viewport predictably.
func BuildPaneListLines(model LoopModel) []string {
	lines := []string{}
	for wi, ws := range model.Workspaces {
		lines = append(lines, formatWorkspaceLine(ws, model.Focus.WorkspaceIdx == wi))
		for ti, tab := range ws.Tabs {
			lines = append(lines, formatTabLine(ws.ID, tab, model.Focus.WorkspaceIdx == wi && model.Focus.TabIdx == ti))
			for pi, pane := range tab.Panes {
				focused := model.Focus.WorkspaceIdx == wi &&
					model.Focus.TabIdx == ti &&
					model.Focus.PaneIdx == pi
				lines = append(lines, formatPaneLine(pane, focused))
			}
		}
	}
	return lines
}

// PaneListSummary is a compact aggregate useful for the
// sidebar status badge (e.g. "3 panes · 1 blocked · 1 drift").
type PaneListSummary struct {
	TotalPanes      int
	ByStatus        map[PaneStatus]int
	PendingBoundary int
	HasDrift        bool
}

func SummarizePaneList(model LoopModel) PaneListSummary {
	summary := PaneListSummary{ByStatus: make(map[PaneStatus]int, 6)}
	for _, ws := range model.Workspaces {
		for _, tab := range ws.Tabs {
			for _, pane := range tab.Panes {
				summary.TotalPanes++
				summary.ByStatus[pane.Status]++
				if pane.Status == StatusDrift {
					summary.HasDrift = true
					summary.PendingBoundary++
				}
			}
		}
	}
	return summary
}

func formatWorkspaceLine(ws Workspace, focused bool) string {
	marker := "  "
	if focused {
		marker = "> "
	}
	return marker + "ws " + ws.ID + " · " + ws.Label
}

func formatTabLine(workspaceID string, tab Tab, focused bool) string {
	marker := "    "
	if focused {
		marker = "  > "
	}
	return marker + "tab " + tab.ID + " · " + tab.Label
}

func formatPaneLine(pane PaneModel, focused bool) string {
	marker := "      "
	if focused {
		marker = "    > "
	}
	label := strings.TrimSpace(pane.Label)
	if label == "" {
		label = shortSessionID(pane.SessionID)
	}
	return marker + "pane " + pane.PaneID + " · " + label + " · " + pane.Status.String()
}

// shortSessionID returns the last 8 chars of the session id so
// the overlay stays one line wide.
func shortSessionID(sessionID string) string {
	const keep = 8
	if len(sessionID) <= keep {
		return sessionID
	}
	return sessionID[len(sessionID)-keep:]
}
