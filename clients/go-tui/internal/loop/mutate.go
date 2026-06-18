// internal/loop/mutate.go
//
// Phase 3d: pure LoopModel mutators. The router classifies
// events into RouteActions; this file applies them to the
// model. Keeping the mutators pure (return a new LoopModel)
// preserves the "state is pure data" invariant from the
// LoopModel section of the plan and matches herdr's
// immutable-update style.

package loop

import "time"

// NewPaneSeed is the metadata required to spawn a fresh pane.
// The Bubble Tea adapter fills in Cwd / Label / SessionID
// before calling ApplyNewPane.
type NewPaneSeed struct {
	PaneID      string
	WorkspaceID string
	TabID       string
	SessionID   string
	Agent       string
	Cwd         string
	Label       string
}

// ApplyClosePane removes the focused pane from its tab. If the
// tab becomes empty, PaneIdx collapses to -1. The WorkspaceIdx
// is preserved; the runtime may then choose to drop the whole
// workspace separately.
func ApplyClosePane(model LoopModel) LoopModel {
	if model.Focus.WorkspaceIdx < 0 || model.Focus.WorkspaceIdx >= len(model.Workspaces) {
		return model
	}
	ws := model.Workspaces[model.Focus.WorkspaceIdx]
	if model.Focus.TabIdx < 0 || model.Focus.TabIdx >= len(ws.Tabs) {
		return model
	}
	tab := ws.Tabs[model.Focus.TabIdx]
	if model.Focus.PaneIdx < 0 || model.Focus.PaneIdx >= len(tab.Panes) {
		return model
	}
	tab.Panes = append(append([]PaneModel(nil), tab.Panes[:model.Focus.PaneIdx]...), tab.Panes[model.Focus.PaneIdx+1:]...)
	ws.Tabs[model.Focus.TabIdx] = tab
	model.Workspaces[model.Focus.WorkspaceIdx] = ws
	if len(tab.Panes) == 0 {
		model.Focus.PaneIdx = -1
	} else if model.Focus.PaneIdx >= len(tab.Panes) {
		model.Focus.PaneIdx = len(tab.Panes) - 1
	}
	return model
}

// ApplyNewPane appends a new pane to the focused tab and
// focuses it. When WorkspaceID / TabID are empty, the function
// infers them from the focused path.
func ApplyNewPane(model LoopModel, seed NewPaneSeed) (LoopModel, error) {
	if seed.PaneID == "" {
		return model, errEmpty("paneId")
	}
	if seed.SessionID == "" {
		return model, errEmpty("sessionId")
	}
	if seed.WorkspaceID == "" {
		if model.Focus.WorkspaceIdx < 0 || model.Focus.WorkspaceIdx >= len(model.Workspaces) {
			return model, errEmpty("workspaceId (no focused workspace)")
		}
		seed.WorkspaceID = model.Workspaces[model.Focus.WorkspaceIdx].ID
	}
	if seed.TabID == "" {
		if model.Focus.TabIdx < 0 || model.Focus.TabIdx >= len(model.Workspaces[model.Focus.WorkspaceIdx].Tabs) {
			return model, errEmpty("tabId (no focused tab)")
		}
		seed.TabID = model.Workspaces[model.Focus.WorkspaceIdx].Tabs[model.Focus.TabIdx].ID
	}
	if model.Focus.WorkspaceIdx < 0 {
		// First-time use: build a default workspace + tab.
		ws := NewWorkspace(seed.WorkspaceID, "default")
		// Replace auto-generated tab id with the seed's expected id.
		ws.Tabs[0] = Tab{ID: seed.TabID, Label: "main"}
		model.Workspaces = []Workspace{ws}
		model.Focus = FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: -1}
	}
	if model.Focus.TabIdx < 0 {
		ws := model.Workspaces[model.Focus.WorkspaceIdx]
		ws.Tabs = append(ws.Tabs, Tab{ID: seed.TabID, Label: "main"})
		model.Workspaces[model.Focus.WorkspaceIdx] = ws
		model.Focus.TabIdx = len(ws.Tabs) - 1
	}
	pane := PaneModel{
		PaneID:      seed.PaneID,
		WorkspaceID: seed.WorkspaceID,
		TabID:       seed.TabID,
		SessionID:   seed.SessionID,
		Agent:       seed.Agent,
		Cwd:         seed.Cwd,
		Label:       seed.Label,
		Status:      StatusIdle,
		LastEventAt: time.Now().UTC(),
	}
	ws := model.Workspaces[model.Focus.WorkspaceIdx]
	tab := ws.Tabs[model.Focus.TabIdx]
	updated, err := tab.AddPane(pane)
	if err != nil {
		return model, err
	}
	ws.Tabs[model.Focus.TabIdx] = updated
	model.Workspaces[model.Focus.WorkspaceIdx] = ws
	model.Focus.PaneIdx = len(updated.Panes) - 1
	return model, nil
}

// ApplyMoveFocus shifts FocusPath by `direction` (-1 left,
// +1 right). Returns the model unchanged when no neighbour
// exists (edge pane, single-pane tab, or up/down on a flat
// layout).
func ApplyMoveFocus(model LoopModel, direction int) LoopModel {
	neighborID, ok := NeighborPane(model, direction)
	if !ok {
		return model
	}
	tab, tabOK := focusedTab(model)
	if !tabOK {
		return model
	}
	for i, p := range tab.Panes {
		if p.PaneID == neighborID {
			model.Focus.PaneIdx = i
			return model
		}
	}
	return model
}

// ApplyFocusPath sets FocusPath to point at the given
// (workspaceIdx, tabIdx, paneIdx) with bounds checking. If
// any index is out of range the function returns the model
// unchanged — the caller (6d-f pane_list Enter handler)
// falls back to "do nothing" rather than panic. This is
// the cross-tab / cross-workspace focus jump the
// pane_list overlay's row-highlight Enter key needs;
// ApplyMoveFocus only handles intra-tab horizontal shifts.
//
// 6d-f adds this for the ctrl+j overlay's Enter handler:
// the operator navigates rows with up/down, presses Enter
// on a non-focused pane, and focus jumps. When the
// selected row is a workspace or tab (not a pane), the
// operator can still tab-cycling in/out of the tab group
// by pressing Enter — for now we treat workspace/tab rows
// as "no jump" (the row would have no pane to focus) and
// let the caller decide whether to close the overlay.
func ApplyFocusPath(model LoopModel, workspaceIdx, tabIdx, paneIdx int) LoopModel {
	if workspaceIdx < 0 || workspaceIdx >= len(model.Workspaces) {
		return model
	}
	ws := model.Workspaces[workspaceIdx]
	if tabIdx < 0 || tabIdx >= len(ws.Tabs) {
		return model
	}
	tab := ws.Tabs[tabIdx]
	if paneIdx < 0 || paneIdx >= len(tab.Panes) {
		return model
	}
	model.Focus = FocusPath{
		WorkspaceIdx: workspaceIdx,
		TabIdx:       tabIdx,
		PaneIdx:      paneIdx,
	}
	return model
}

// ApplyNextTab / ApplyPrevTab cycle TabIdx within the focused
// workspace, wrapping around. They noop when the workspace
// has zero or one tabs.
func ApplyNextTab(model LoopModel) LoopModel {
	return applyTabDelta(model, +1)
}

func ApplyPrevTab(model LoopModel) LoopModel {
	return applyTabDelta(model, -1)
}

func applyTabDelta(model LoopModel, delta int) LoopModel {
	if model.Focus.WorkspaceIdx < 0 || model.Focus.WorkspaceIdx >= len(model.Workspaces) {
		return model
	}
	ws := model.Workspaces[model.Focus.WorkspaceIdx]
	if len(ws.Tabs) < 2 {
		return model
	}
	next := model.Focus.TabIdx + delta
	if next < 0 {
		next = len(ws.Tabs) - 1
	} else if next >= len(ws.Tabs) {
		next = 0
	}
	model.Focus.TabIdx = next
	// PaneIdx resets to the first pane in the new tab, or -1
	// if the tab is empty.
	if len(ws.Tabs[next].Panes) > 0 {
		model.Focus.PaneIdx = 0
	} else {
		model.Focus.PaneIdx = -1
	}
	return model
}

// errEmpty returns a typed sentinel error so callers can
// distinguish missing-metadata from infrastructure failures.
type errEmpty string

func (e errEmpty) Error() string { return "loop mutate: " + string(e) + " is required" }
