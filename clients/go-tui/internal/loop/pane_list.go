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

import (
	"strings"
	"time"
)

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

// paneRowKind enumerates the three tree levels rendered in
// the sidebar (and the overlay that preceded it). The chrome
// layer dispatches on Kind to pick the right glyph + label
// shape.
type paneRowKind int

const (
	paneRowWorkspace paneRowKind = iota
	paneRowTab
	paneRowPane
)

// paneRow is the structured form of one sidebar / overlay
// row. It carries the IDs, label, status, focus marker, and
// tree depth so the chrome layer can apply styles without
// re-parsing the plain-text rendering produced by
// BuildPaneListLines. Keeping the structured form in the data
// layer (here) and the rendering in the chrome layer
// (chrome.go) preserves the "status is data, chrome is
// presentation" split the rest of the package follows.
type paneRow struct {
	Kind        paneRowKind
	Depth       int
	Marker      string
	Focused     bool
	WorkspaceID string
	TabID       string
	PaneID      string
	SessionID   string
	Label       string
	Status      PaneStatus
	// LastEventAt feeds the sidebar's "5s ago" hint. The
	// chrome layer's formatActivity treats the zero time as
	// "no event yet" and returns "".
	LastEventAt time.Time
}

// BuildPaneListLines returns the per-pane lines for the model
// in tree order. Each pane gets one line; tabs and workspaces
// produce a header line. The line buffer never exceeds the
// number of panes plus the number of containers, so the
// caller can size the overlay viewport predictably.
func BuildPaneListLines(model LoopModel) []string {
	rows := BuildPaneListRows(model)
	lines := make([]string, 0, len(rows))
	for _, r := range rows {
		lines = append(lines, formatPaneRowLine(r))
	}
	return lines
}

// BuildPaneListRows returns the structured sidebar / overlay
// rows. Phase 4 chrome uses this to style each row with the
// matching status color + focus highlight; the legacy
// BuildPaneListLines wrapper preserves the plain-text shape
// for tests and the `--status` smoke output.
func BuildPaneListRows(model LoopModel) []paneRow {
	rows := []paneRow{}
	for wi, ws := range model.Workspaces {
		wsFocused := model.Focus.WorkspaceIdx == wi
		rows = append(rows, paneRow{
			Kind:        paneRowWorkspace,
			Depth:       0,
			Marker:      workspaceMarker(wsFocused),
			Focused:     wsFocused,
			WorkspaceID: ws.ID,
			Label:       ws.Label,
		})
		for ti, tab := range ws.Tabs {
			tabFocused := wsFocused && model.Focus.TabIdx == ti
			rows = append(rows, paneRow{
				Kind:        paneRowTab,
				Depth:       2,
				Marker:      tabMarker(tabFocused),
				Focused:     tabFocused,
				WorkspaceID: ws.ID,
				TabID:       tab.ID,
				Label:       tab.Label,
			})
			for pi, pane := range tab.Panes {
				paneFocused := tabFocused && model.Focus.PaneIdx == pi
				rows = append(rows, paneRow{
					Kind:        paneRowPane,
					Depth:       4,
					Marker:      paneMarker(paneFocused),
					Focused:     paneFocused,
					WorkspaceID: ws.ID,
					TabID:       tab.ID,
					PaneID:      pane.PaneID,
					SessionID:   pane.SessionID,
					Label:       pane.Label,
					Status:      pane.Status,
					LastEventAt: pane.LastEventAt,
				})
			}
		}
	}
	return rows
}

func workspaceMarker(focused bool) string {
	if focused {
		return "▶"
	}
	return " "
}

func tabMarker(focused bool) string {
	if focused {
		return "▾"
	}
	return "▸"
}

func paneMarker(focused bool) string {
	if focused {
		return ">"
	}
	return " "
}

// formatPaneRowLine renders one paneRow as the legacy
// plain-text line (used by tests + `--status` smoke). The
// structured chrome in chrome.go does not depend on this
// helper.
func formatPaneRowLine(r paneRow) string {
	switch r.Kind {
	case paneRowWorkspace:
		return r.Marker + " ws " + r.WorkspaceID + " · " + r.Label
	case paneRowTab:
		return strings.Repeat(" ", r.Depth) + r.Marker + " tab " + r.TabID + " · " + r.Label
	case paneRowPane:
		label := strings.TrimSpace(r.Label)
		if label == "" {
			label = shortSessionID(r.SessionID)
		}
		// Legacy format kept a space after the focus marker
		// (e.g. "    > pane pane-b") so existing tests +
		// `bbl loop --status` smoke output stay byte-stable.
		return strings.Repeat(" ", r.Depth) + r.Marker + " pane " + r.PaneID + " · " + label + " · " + r.Status.String()
	}
	return ""
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
