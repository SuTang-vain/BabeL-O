// internal/loop/chrome.go
//
// Visual layer for the multi-pane `bbl loop` TUI. The data
// layer (model.go / status.go / pane_list.go / layout.go) stays
// free of lipgloss; this file is the only place that maps
// `ColorName` / `PaneStatus` to actual ANSI styles. Mirrors
// herdr's split between pure-data state and a pure render
// pass: `renderChrome` takes the current LoopModel, returns
// the final string, never mutates state.
//
// The palette is Catppuccin Mocha-inspired (matches herdr's
// default `Palette::catppuccin()`), expressed as 8-bit ANSI
// codes so the result looks the same in any modern terminal
// without pulling a theme detection layer. Operators running
// `bbl loop` over SSH / tmux get the same look as on the
// desktop without env-var gymnastics.

package loop

import (
	"fmt"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// 8-bit ANSI palette tokens. Names match herdr's Palette
// fields so anyone reading both codebases can translate
// intent 1:1.
const (
	colAccent  = "141" // mauve / lavender — title + focused borders
	colBlue    = "111" // working, waiting
	colAmber   = "180" // drift, scope boundary unconfirmed
	colRed     = "167" // blocked
	colGreen   = "114" // done
	colMauve   = "141" // workspace breadcrumb
	colGray    = "245" // subtext (keybind hints)
	colMuted   = "243" // labels, secondary text
	colText    = "252" // soft white body
	colDivider = "238" // dim dividers
	colFrame   = "240" // panel borders
	colSurface = "237" // dim surface highlight
)

var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colAccent))

	accentStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colAccent))

	mutedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colMuted))

	textStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colText))

	subtextStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colGray))

	dividerStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colDivider))

	breadcrumbStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colMauve))

	sectionHeaderStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colMuted))

	frameStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colFrame))

	focusedFrameStyle = lipgloss.NewStyle().
				Border(lipgloss.RoundedBorder()).
				BorderForeground(lipgloss.Color(colAccent))

	sidebarFrameStyle = lipgloss.NewStyle().
				Border(lipgloss.RoundedBorder()).
				BorderForeground(lipgloss.Color(colFrame)).
				Padding(0, 1)

	focusedRowStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colText)).
			Bold(true).
			Background(lipgloss.Color(colSurface))

	footerStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colGray))

	keyStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colText))

	headerDivider = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colFrame))

	versionStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colMuted))
)

// styleForStatus returns a lipgloss.Style for the given
// PaneStatus using the same color mapping the single-pane
// driver uses (status.go: ColorForStatus). Bold is added for
// the attention-requiring states (blocked / drift) so they
// pop in the sidebar even when the operator is scanning fast.
func styleForStatus(s PaneStatus) lipgloss.Style {
	switch s {
	case StatusIdle:
		return subtextStyle
	case StatusWorking:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colBlue)).Bold(true)
	case StatusBlocked:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colRed)).Bold(true)
	case StatusWaiting:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colBlue))
	case StatusDrift:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colAmber)).Bold(true)
	case StatusDone:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colGreen))
	case StatusBehaviorHint:
		// PR-17b (Track B §6.5.2): yellow border for hint state.
		// Bold + amber so the pane stands out without being
		// confused with StatusDrift (which is also amber).
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colAmber)).Bold(true)
	default:
		return mutedStyle
	}
}

// styleForColorName maps the runtime-owned ColorName tokens
// (declared in status.go) to lipgloss styles. Keeping the
// mapping here — and not in status.go — preserves the
// "status is data, chrome is presentation" split the rest of
// the package follows.
func styleForColorName(c ColorName) lipgloss.Style {
	switch c {
	case ColorGray:
		return subtextStyle
	case ColorBlue:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colBlue))
	case ColorGreen:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colGreen))
	case ColorAmber:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colAmber))
	case ColorRed:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colRed))
	case ColorMagenta:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colMauve))
	case ColorNone:
		return mutedStyle
	default:
		return mutedStyle
	}
}

// renderStatusPill renders a single status in the
// `● working` shape used in headers + sidebar rows. The
// symbol is taken from SymbolForStatus; the label is the
// status String(); both inherit the status color so the
// pill reads at a glance.
func renderStatusPill(s PaneStatus) string {
	st := styleForStatus(s)
	return st.Render(SymbolForStatus(s) + " " + s.String())
}

// renderStatusBadgeStyled is the colored equivalent of
// FormatStatusBadgeLine — used by the sidebar where the
// status badge sits inline with a pane row.
func renderStatusBadgeStyled(s PaneStatus) string {
	st := styleForColorName(ColorForStatus(s))
	return st.Render(SymbolForStatus(s) + " " + s.String())
}

// layoutMode enumerates the three responsive geometry paths
// the chrome layer takes. Mirrors herdr's two-tier
// (desktop/mobile) split but adds a third `tooSmall` mode
// below the mobile threshold where we stop trying to render
// the full chrome and show a "resize your terminal" message
// instead. The split is intentionally coarse — a
// conditional `if width < 64` scattered through the render
// path is exactly the kind of leak herdr explicitly
// avoided with its `is_mobile_width()` gate.
type layoutMode int

const (
	// layoutDesktop is the normal multi-column chrome:
	// sidebar on the left, focused pane on the right, header
	// + footer single-line. Active when width >= 64 cols
	// and height >= 12 rows.
	layoutDesktop layoutMode = iota

	// layoutMobile hides the sidebar, expands the focused
	// pane to full width, and wraps the footer keybind hint
	// across two lines so the always-visible controls still
	// fit. Active when 40 <= width < 64.
	layoutMobile

	// layoutTooSmall is the fallback when the terminal
	// can't sensibly host even the mobile chrome. Active
	// when width < 40 or height < 12. The renderer shows a
	// centered "resize to at least 80×24" hint instead of
	// producing a half-rendered chrome that hides state
	// from the operator.
	layoutTooSmall
)

// Layout mode thresholds. Tuned to match herdr's defaults
// (mobile_width_threshold = 64) and the absolute minimum
// that can still show the title + one keybind.
const (
	mobileWidthThreshold  = 64
	tooSmallWidthMin      = 40
	tooSmallHeightMin     = 12
	headerHeight          = 2
	desktopSidebarMin     = 18
	desktopSidebarMax     = 32
	desktopMainMin        = 20
	collapsedSidebarWidth = 4
)

// chromeLayout is the result of measuring how the chrome
// pieces should fit into the available terminal area. The
// renderer dispatches on Mode to pick the right geometry
// path; the other fields carry the per-mode measurements.
type chromeLayout struct {
	Mode             layoutMode
	HeaderH          int
	BodyH            int
	FooterH          int
	FooterLines      int
	SidebarW         int
	SidebarCollapsed bool
	MainW            int
	TotalW           int
	TotalH           int
}

// computeChromeLayout picks the layout mode and sizes the
// chrome pieces for the current terminal. A zero or
// negative dimension falls back to the 80×24 default so
// smoke tests + early renders (before WindowSizeMsg) still
// produce a sane shape. `sidebarCollapsed` is forwarded
// from the runtime so the layout honors a Ctrl+B toggle
// without re-computing the threshold.
func computeChromeLayout(width, height int, sidebarCollapsed bool) chromeLayout {
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 24
	}
	if width < tooSmallWidthMin || height < tooSmallHeightMin {
		return chromeLayout{
			Mode:    layoutTooSmall,
			TotalW:  width,
			TotalH:  height,
			HeaderH: 0,
			BodyH:   height,
			FooterH: 0,
		}
	}
	if width < mobileWidthThreshold {
		return chromeLayout{
			Mode:        layoutMobile,
			HeaderH:     headerHeight,
			BodyH:       max(1, height-headerHeight-2), // framed header + 2 footer lines
			FooterH:     2,
			FooterLines: 2,
			SidebarW:    0,
			MainW:       width,
			TotalW:      width,
			TotalH:      height,
		}
	}
	// Desktop: sidebar (or collapsed 4-col gutter) on the
	// left, focused pane on the right.
	sidebarW := 0
	if sidebarCollapsed {
		sidebarW = collapsedSidebarWidth
	} else {
		sidebarW = width / 4
		if sidebarW < desktopSidebarMin {
			sidebarW = desktopSidebarMin
		}
		if sidebarW > desktopSidebarMax {
			sidebarW = desktopSidebarMax
		}
		if sidebarW >= width-desktopMainMin {
			// Main column needs at least 20 cols to be
			// useful; prefer dropping the sidebar over
			// squeezing the focused pane.
			sidebarW = max(0, width-desktopMainMin)
		}
	}
	mainW := max(0, width-sidebarW)
	return chromeLayout{
		Mode:             layoutDesktop,
		HeaderH:          headerHeight,
		BodyH:            max(1, height-headerHeight-1),
		FooterH:          1,
		FooterLines:      1,
		SidebarW:         sidebarW,
		SidebarCollapsed: sidebarCollapsed,
		MainW:            mainW,
		TotalW:           width,
		TotalH:           height,
	}
}

// renderChrome is the top-level View. It returns the full
// terminal string for the current model. Pure function — no
// state mutation, no I/O. The Bubble Tea adapter calls this
// directly from its View().
//
// `state` carries the runtime-only chrome flags (help
// overlay open, transient toast) that the data layer
// (model.go) intentionally doesn't know about. Passing them
// in as a separate bundle keeps the LoopModel pure data and
// the InteractiveModel a thin dispatcher.
func renderChrome(model LoopModel, state chromeViewState) string {
	layout := computeChromeLayout(model.Width, model.Height, state.Layout.SidebarCollapsed)
	switch layout.Mode {
	case layoutTooSmall:
		return renderTooSmall(layout.TotalW, layout.TotalH)
	}
	// Zoom suppresses the header / sidebar / summary pill —
	// the focused pane gets the full body so its content
	// is the only thing on screen.
	if state.Layout.ZoomFocused {
		return renderZoomedChrome(model, layout, state)
	}
	header := renderHeader(model, layout.TotalW)
	footer := renderFooter(model, layout.TotalW, state.Reconcile, layout)
	bodyLayout := layout
	toastLine := renderToastLine(state.Toast, layout.TotalW)
	if toastLine != "" && bodyLayout.BodyH > 1 {
		bodyLayout.BodyH--
	}
	body := renderBody(model, bodyLayout)
	if layout.Mode == layoutMobile {
		body = renderMobileBody(model, bodyLayout)
	}
	if toastLine != "" {
		body = body + "\n" + toastLine
	}
	var out string
	if layout.Mode == layoutMobile {
		out = header + "\n" + body + "\n" + footer
	} else {
		out = strings.Join([]string{header, body, footer}, "\n")
	}
	if state.HelpOpen {
		out = overlayHelp(out, model.Width, model.Height)
	}
	return out
}

// renderHeader builds the title bar: bold title + version on
// the left, breadcrumb (workspace › tab › pane) in the
// middle, and a status summary pill on the right. The right
// column is right-padded so terminals that clip ANSI still
// keep the visual alignment.
//
// On narrow terminals the columns are dropped in a fixed
// priority order — least useful / largest first — so the
// header always degrades gracefully:
//  1. version (left, ~17 chars)    — first to go; it's the
//     largest non-title column
//     and the least critical
//  2. summary pill (right)         — second; "nice to have"
//  3. breadcrumb (middle)          — third; the title is
//     always kept last
func renderHeader(model LoopModel, width int) string {
	title := titleStyle.Render("bbl loop")
	version := versionStyle.Render(" " + Version)
	breadcrumb := renderBreadcrumb(model)
	summary := renderStatusSummaryPill(model)

	// Trim columns in priority order. The `kept` flags make
	// the intent obvious in tests + log output; we
	// re-measure on each iteration so the loop terminates
	// as soon as the content fits.
	keepVersion := true
	keepSummary := true
	keepBreadcrumb := true
	for {
		leftWidth := lipgloss.Width(title)
		if keepVersion {
			leftWidth += lipgloss.Width(version) + 1
		}
		midWidth := 0
		if keepBreadcrumb {
			midWidth = lipgloss.Width(breadcrumb)
		}
		rightWidth := 0
		if keepSummary {
			rightWidth = lipgloss.Width(summary)
		}
		total := leftWidth + midWidth + rightWidth
		if total <= width-2 || (!keepVersion && !keepSummary && !keepBreadcrumb) {
			break
		}
		// Drop in priority order: version → summary → breadcrumb.
		switch {
		case keepVersion:
			keepVersion = false
		case keepSummary:
			keepSummary = false
		case keepBreadcrumb:
			keepBreadcrumb = false
		default:
			break
		}
	}
	if !keepVersion {
		version = ""
	}
	if !keepBreadcrumb {
		breadcrumb = ""
	}
	if !keepSummary {
		summary = ""
	}

	midWidth := lipgloss.Width(breadcrumb)
	rightWidth := lipgloss.Width(summary)

	contentWidth := max(0, width-4)
	line := title + version
	if breadcrumb != "" {
		gap := max(1, contentWidth-lipgloss.Width(line)-midWidth-rightWidth)
		line += strings.Repeat(" ", gap) + breadcrumb
	}
	if summary != "" {
		gap := max(1, contentWidth-lipgloss.Width(line)-rightWidth)
		line += strings.Repeat(" ", gap) + summary
	}
	line = padOrTruncate(line, contentWidth)

	inner := padOrTruncate(" "+strings.TrimRight(line, " ")+" ", max(0, width-2))
	header := headerDivider.Render("╭") +
		headerDivider.Render(strings.Repeat("─", max(0, width-2))) +
		headerDivider.Render("╮\n") +
		"│" + inner + "│"
	return clampBlock(header, width, headerHeight)
}

// renderBreadcrumb returns the `ws › tab › pane` middle column
// of the header. Uses `›` as the separator glyph (single
// character so monospace columns line up) and the workspace
// / tab / focused-pane ids as labels. Empty pieces are
// collapsed so a partially-hydrated model still renders
// gracefully.
func renderBreadcrumb(model LoopModel) string {
	parts := []string{}
	if len(model.Workspaces) > 0 {
		ws := model.Workspaces[0]
		if model.Focus.WorkspaceIdx >= 0 && model.Focus.WorkspaceIdx < len(model.Workspaces) {
			ws = model.Workspaces[model.Focus.WorkspaceIdx]
		}
		parts = append(parts, ws.ID)
		if len(ws.Tabs) > 0 && model.Focus.TabIdx >= 0 && model.Focus.TabIdx < len(ws.Tabs) {
			parts = append(parts, ws.Tabs[model.Focus.TabIdx].Label)
		}
	}
	focused, ok := model.FocusedPane()
	if ok && focused.PaneID != "" {
		parts = append(parts, focused.PaneID)
	}
	if len(parts) == 0 {
		return ""
	}
	return breadcrumbStyle.Render(strings.Join(parts, " › "))
}

// renderStatusSummaryPill renders the right side of the
// header: a one-line aggregate of pane counts + attention
// counts, color-coded so a `blocked` or `drift` shows up in
// the header even when the operator isn't looking at the
// sidebar.
func renderStatusSummaryPill(model LoopModel) string {
	summary := SummarizePaneList(model)
	panes := summary.TotalPanes
	panesLabel := fmt.Sprintf("%d panes", panes)
	if panes == 1 {
		panesLabel = "1 pane"
	}

	attention := []string{}
	if n := summary.ByStatus[StatusBlocked]; n > 0 {
		attention = append(attention, styleForColorName(ColorRed).Render(fmt.Sprintf("%d blocked", n)))
	}
	if n := summary.ByStatus[StatusDrift]; n > 0 {
		attention = append(attention, styleForColorName(ColorAmber).Render(fmt.Sprintf("%d drift", n)))
	}
	if n := summary.ByStatus[StatusWaiting]; n > 0 {
		attention = append(attention, styleForColorName(ColorBlue).Render(fmt.Sprintf("%d waiting", n)))
	}
	// PR-17b: highlight hint state in the sidebar summary. Per
	// doc §6.5.2 hint panes warrant operator attention (they
	// may need follow-up), so we surface the count in amber.
	if n := summary.ByStatus[StatusBehaviorHint]; n > 0 {
		attention = append(attention, styleForColorName(ColorAmber).Render(fmt.Sprintf("%d hint", n)))
	}

	focusLabel := "(none)"
	focused, ok := model.FocusedPane()
	if ok && focused.PaneID != "" {
		focusLabel = "focused=" + focused.PaneID
	}

	parts := []string{panesLabel}
	if len(attention) == 0 {
		parts = append(parts, mutedStyle.Render("no attention"))
	} else {
		parts = append(parts, strings.Join(attention, "/"))
	}
	parts = append(parts, mutedStyle.Render(focusLabel))
	return mutedStyle.Render(strings.Join(parts, " · "))
}

// renderBody joins the sidebar + main column horizontally.
// Three sidebar shapes are possible:
//   - SidebarW == 0          → suppress the sidebar entirely
//     (mobile mode / very narrow desktop)
//   - SidebarCollapsed == true → render a 4-col gutter
//     showing a `▾` / `▸` toggle glyph
//   - otherwise              → render the full sidebar panel
func renderBody(model LoopModel, layout chromeLayout) string {
	var sidebar string
	switch {
	case layout.SidebarW <= 0:
		sidebar = ""
	case layout.SidebarCollapsed:
		sidebar = renderCollapsedSidebar(model, layout.SidebarW, layout.BodyH)
	default:
		sidebar = renderSidebar(model, layout.SidebarW, layout.BodyH)
	}
	main := renderFocusedPane(model, layout.MainW, layout.BodyH)

	if sidebar == "" {
		return joinVertical(0, layout.TotalW, layout.BodyH, main)
	}

	sidebarLines := strings.Split(sidebar, "\n")
	mainLines := strings.Split(main, "\n")
	lines := make([]string, 0, max(len(sidebarLines), len(mainLines)))
	for i := 0; i < layout.BodyH; i++ {
		left := ""
		if i < len(sidebarLines) {
			left = sidebarLines[i]
		}
		right := ""
		if i < len(mainLines) {
			right = mainLines[i]
		}
		lines = append(lines, left+right)
	}
	return strings.Join(lines, "\n")
}

// renderCollapsedSidebar returns the 4-col-wide gutter shown
// when the operator has collapsed the sidebar via Ctrl+B. A
// single `▾` glyph (accent color) sits in the middle of the
// gutter so the operator can see the toggle is available;
// pressing Ctrl+B again expands it. We don't render a
// bordered frame here — the gutter is intentionally thin so
// the focused pane gets as much width as possible.
func renderCollapsedSidebar(model LoopModel, width, height int) string {
	if width <= 0 || height <= 0 {
		return ""
	}
	glyph := accentStyle.Render("▾")
	pad := strings.Repeat(" ", max(0, (width-1)/2))
	centered := pad + glyph + pad
	if width%2 == 0 {
		// Keep the column count exact so the focused pane
		// still lines up against the right edge.
		centered = centered + " "
	}
	lines := []string{centered}
	for len(lines) < height {
		lines = append(lines, strings.Repeat(" ", width))
	}
	return strings.Join(lines, "\n")
}

// renderMobileBody is the mobile-layout body. There's no
// sidebar to compete for width, so the focused pane gets
// the full terminal width. The header is a single row
// (handled by the caller) and the footer is two rows
// (handled by the caller), so BodyH is height minus 3.
func renderMobileBody(model LoopModel, layout chromeLayout) string {
	return renderFocusedPane(model, layout.TotalW, layout.BodyH)
}

// renderTooSmall returns a centered "terminal too small"
// message for the layoutTooSmall mode. We don't try to
// render any of the real chrome here — a half-rendered
// chrome that hides the live state is worse than a clear
// "resize your terminal" prompt. The hint mentions the
// recommended minimum (80×24) so the operator has a
// concrete target.
func renderTooSmall(width, height int) string {
	if width <= 0 {
		width = 40
	}
	if height <= 0 {
		height = 12
	}
	hint := "bbl loop — terminal too small"
	subhint := "resize to at least 80x24 (current: " +
		fmt.Sprintf("%dx%d", width, height) + ")"
	top := strings.Repeat("\n", max(0, (height-2)/2))
	return top + footerStyle.Render(centerLine(hint, width)) + "\n" +
		mutedStyle.Render(centerLine(subhint, width))
}

// renderZoomedChrome is the chrome for the Ctrl+Z zoom mode.
// The focused pane gets the entire body; the header is just
// a centered title and the footer is the minimal keybind
// hint (q to quit, ? for help, ctrl+z to unzoom). The
// reconcile indicator stays visible so the operator can
// still see sync state while zoomed.
func renderZoomedChrome(model LoopModel, layout chromeLayout, state chromeViewState) string {
	title := titleStyle.Render("bbl loop")
	centered := centerLine(title, layout.TotalW)
	body := renderFocusedPane(model, layout.TotalW, layout.BodyH)
	footerBinds := []footerKeybind{
		{Keys: []string{"ctrl+z"}, Desc: "unzoom"},
		{Keys: []string{"ctrl+b"}, Desc: "sidebar"},
		{Keys: []string{"?"}, Desc: "help"},
		{Keys: []string{"q"}, Desc: "quit"},
	}
	footer := renderFooterLine(layout.TotalW, footerBinds, state.Reconcile)
	out := centered + "\n" + body + "\n" + footerStyle.Render(footer)
	if state.HelpOpen {
		out = overlayHelp(out, model.Width, model.Height)
	}
	return out
}

// centerLine returns s padded with leading/trailing spaces
// so it sits in the middle of a `width`-column row. Used by
// the too-small + zoom renderers to keep their messages
// visually centered.
func centerLine(s string, width int) string {
	w := lipgloss.Width(s)
	if w >= width {
		return s
	}
	pad := (width - w) / 2
	return strings.Repeat(" ", pad) + s
}

// joinVertical centers `content` vertically inside a
// `height × width` box. Used for the narrow-terminal fallback
// where the sidebar is suppressed.
func joinVertical(top, width, height int, content string) string {
	lines := strings.Split(content, "\n")
	out := make([]string, 0, height)
	for i := 0; i < top && len(out) < height; i++ {
		out = append(out, strings.Repeat(" ", max(0, width)))
	}
	for _, line := range lines {
		if len(out) >= height {
			break
		}
		out = append(out, line)
	}
	for len(out) < height {
		out = append(out, strings.Repeat(" ", max(0, width)))
	}
	return strings.Join(out, "\n")
}

// renderSidebar renders the bordered "spaces / tabs / panes"
// panel on the left side of the body. Each row is one
// workspace / tab / pane; the focused row gets a dim surface
// background + bold text. Status is shown as a colored dot +
// label on the right of the row.
func renderSidebar(model LoopModel, width, height int) string {
	if width <= 0 || height <= 0 {
		return ""
	}
	rows := BuildPaneListRows(model)

	innerWidth := max(1, width-4) // border + horizontal padding
	innerHeight := max(1, height-2)

	content := renderSidebarContent(rows, model, innerWidth, innerHeight)
	return clampBlock(sidebarFrameStyle.Width(width).Height(height).Render(content), width, height)
}

// renderSidebarContent builds the unframed list of rows that
// goes inside the sidebar panel. Each row is rendered as
// `marker indent label · status`; the focused row uses a
// different background.
func renderSidebarContent(rows []paneRow, model LoopModel, innerWidth, innerHeight int) string {
	if len(rows) == 0 {
		return sectionHeaderStyle.Render("spaces") + "\n" +
			mutedStyle.Render("  (no workspaces yet)")
	}
	lines := []string{sectionHeaderStyle.Render("spaces")}
	for _, r := range rows {
		lines = append(lines, renderSidebarRow(r, model, innerWidth))
	}
	if len(lines) > innerHeight {
		lines = lines[:innerHeight]
	}
	for i := range lines {
		lines[i] = padOrTruncate(lines[i], innerWidth)
	}
	for len(lines) < innerHeight {
		lines = append(lines, strings.Repeat(" ", innerWidth))
	}
	return strings.Join(lines, "\n")
}

// renderSidebarRow renders one workspace / tab / pane row
// inside the sidebar. The leading glyph encodes the tree
// level (workspace / tab / pane) and the focus state (▶ / ▾
// / > vs. · / ▸ /  ) — it carries both signals in one
// column, matching herdr's `state_icon` / `state_dot` shape.
// Status is shown on the right with the status color.
// Pane rows also get a "5s ago" last-activity hint between
// the label and the status, using the pane's LastEventAt.
func renderSidebarRow(r paneRow, model LoopModel, width int) string {
	if width <= 0 {
		return ""
	}
	indent := strings.Repeat(" ", r.Depth)
	glyph, glyphStyle := sidebarGlyphForRow(r)
	kindLabel := sidebarKindLabel(r)
	statusPart := ""
	activityPart := ""
	if r.Kind == paneRowPane {
		statusPart = styleForStatus(r.Status).Render(SymbolForStatus(r.Status) + " " + r.Status.String())
		activityPart = mutedStyle.Render(formatActivity(r.LastEventAt))
	}

	left := indent + glyph + "  " + kindLabel
	middle := activityPart
	if statusPart != "" {
		var gap int
		if middle != "" {
			gap = max(1, width-lipgloss.Width(left)-lipgloss.Width(middle)-lipgloss.Width(statusPart))
		} else {
			gap = max(1, width-lipgloss.Width(left)-lipgloss.Width(statusPart))
		}
		return padOrTruncate(glyphStyle.Render(left)+middle+strings.Repeat(" ", gap)+statusPart, width)
	}
	return padOrTruncate(glyphStyle.Render(left)+middle, width)
}

// sidebarGlyphForRow returns the leading glyph + style for a
// sidebar row, mirroring herdr's state_icon / state_dot
// pattern: workspaces get a `▶` (focused) / `▾` (expanded
// group) / `▸` (collapsed) indicator, tabs get a `›` head,
// panes get the status symbol.
func sidebarGlyphForRow(r paneRow) (string, lipgloss.Style) {
	switch r.Kind {
	case paneRowWorkspace:
		if r.Focused {
			return "▶", accentStyle
		}
		return "·", mutedStyle
	case paneRowTab:
		if r.Focused {
			return "▾", accentStyle
		}
		return "▸", mutedStyle
	case paneRowPane:
		return SymbolForStatus(r.Status), styleForStatus(r.Status)
	}
	return "·", mutedStyle
}

// sidebarKindLabel returns the short label that follows the
// glyph on a sidebar row: workspace id + label, tab id +
// label, or pane id + label.
func sidebarKindLabel(r paneRow) string {
	switch r.Kind {
	case paneRowWorkspace:
		return r.WorkspaceID + "  " + r.Label
	case paneRowTab:
		return r.TabID + "  " + r.Label
	case paneRowPane:
		label := strings.TrimSpace(r.Label)
		if label == "" {
			label = shortSessionID(r.SessionID)
		}
		return r.PaneID + "  " + label
	}
	return ""
}

// renderFocusedPane renders the framed box on the right
// side of the body. The header line shows the focused pane
// id, label, and a status pill. The body is a placeholder
// until Phase 3f' wires the real transcript.
func renderFocusedPane(model LoopModel, width, height int) string {
	if width <= 0 || height <= 0 {
		return ""
	}
	innerW := max(1, width-2)
	innerH := max(1, height-2)

	headerLine := renderFocusedPaneHeader(model, innerW)
	divider := dividerStyle.Render(strings.Repeat("─", innerW))
	body := renderFocusedPaneBody(model, innerW, innerH-2)

	frame := frameStyle
	if model.Focus.WorkspaceIdx >= 0 {
		frame = focusedFrameStyle
	}
	return clampBlock(frame.Width(width).Height(height).Render(strings.Join([]string{headerLine, divider, body}, "\n")), width, height)
}

// renderFocusedPaneHeader is the top line of the focused
// pane box: pane id + label on the left, status pill on the
// right.
func renderFocusedPaneHeader(model LoopModel, width int) string {
	focused, ok := model.FocusedPane()
	if !ok {
		return padOrTruncate(mutedStyle.Render("(no pane focused)"), width)
	}
	left := accentStyle.Render(focused.PaneID) + "  " + textStyle.Render(strings.TrimSpace(focused.Label))
	pill := renderStatusPill(focused.Status)
	// PR-17b (Track B §6.5.2): when the focused pane is in
	// StatusBehaviorHint, append the runtime-provided pattern
	// as "[hint] pattern: <pattern>". We truncate gracefully
	// when the line is too narrow.
	if focused.Status == StatusBehaviorHint && focused.LastHintPattern != "" {
		hintText := "[hint] pattern: " + focused.LastHintPattern
		hintLine := styleForStatus(StatusBehaviorHint).Render(hintText)
		// Replace the gap with a newline + hint line. Use a
		// simple concatenation; the focused body below keeps
		// the rest of the chrome aligned.
		header := padOrTruncate(left+strings.Repeat(" ", max(1, width-lipgloss.Width(left)-lipgloss.Width(pill)))+pill, width)
		// Truncate the hint line to width.
		hintLine = padOrTruncate(hintLine, width)
		return header + "\n" + hintLine
	}
	gap := max(1, width-lipgloss.Width(left)-lipgloss.Width(pill))
	return padOrTruncate(left+strings.Repeat(" ", gap)+pill, width)
}

// renderFocusedPaneBody is the body shown below the focused
// pane header. It always renders the session meta line first
// (so operators can copy/paste a session id from the body);
// the rest of the body is filled by either the pane's
// transcript (Phase 6b) or, when Transcript is empty, the
// historical "waiting for stream" placeholder. The placeholder
// branch is what the live TUI falls into today — 6c will start
// filling transcripts; the placeholder still applies to panes
// that exist but haven't been attached to a stream yet (e.g.
// a pane the user just opened with Ctrl+N before any events
// have arrived).
func renderFocusedPaneBody(model LoopModel, width, height int) string {
	focused, ok := model.FocusedPane()
	if !ok {
		return padOrTruncate(mutedStyle.Render("  (no pane focused)"), width)
	}
	if focused.SessionID == "" {
		return padOrTruncate(
			mutedStyle.Render("  no session yet — press ")+
				keyStyle.Render("ctrl+n")+
				mutedStyle.Render(" to start one"),
			width,
		)
	}
	// The full session id is shown so the legacy test
	// contract (substring "session-1") keeps passing and
	// operators can copy/paste a session id from the body.
	// For very long ids (> 24 chars) the placeholder falls
	// back to the abbreviated form so the body still fits.
	sessionLabel := focused.SessionID
	if len(sessionLabel) > 24 {
		sessionLabel = shortSessionID(focused.SessionID)
	}
	meta := fmt.Sprintf("  session=%s  ·  rev=%d  ·  agent=%s",
		sessionLabel, focused.LastEventRev, fallback(focused.Agent, "bbl"))
	lines := []string{padOrTruncate(subtextStyle.Render(meta), width)}
	if len(focused.Transcript) > 0 {
		// Reserve the first row for the meta line; the rest
		// of the body is transcript. This is the "user can
		// finally see the active session" moment of 6b.
		transcriptBody := renderTranscriptLines(focused, width, height-1)
		lines = append(lines, splitLines(transcriptBody, width, height-1)...)
	} else {
		placeholder := mutedStyle.Render("  (waiting for stream — Phase 3f')")
		lines = append(lines, padOrTruncate(placeholder, width))
	}
	for len(lines) < height {
		lines = append(lines, strings.Repeat(" ", width))
	}
	if len(lines) > height {
		lines = lines[:height]
	}
	return strings.Join(lines, "\n")
}

// renderTranscriptLines turns a pane's Transcript into styled
// lines for the focused body. The role prefix is colored to
// match the rest of the chrome (user / assistant / tool /
// system). Lines are then padded / truncated to `width` columns
// so the body joins cleanly.
func renderTranscriptLines(pane PaneModel, width, height int) string {
	raw := BuildTranscriptLines(pane, width, height)
	if len(raw) == 0 {
		return ""
	}
	out := make([]string, 0, len(raw))
	for _, line := range raw {
		// The line is "<role label> <padded text>". Re-color
		// the role prefix; the rest of the line is textStyle
		// body content. We split on the first space so the
		// padding between prefix and body stays intact.
		role, body, found := strings.Cut(line, " ")
		if !found {
			out = append(out, padOrTruncate(textStyle.Render(line), width))
			continue
		}
		out = append(out, padOrTruncate(styleForTranscriptRole(parseTranscriptRole(role))+" "+body, width))
	}
	return strings.Join(out, "\n")
}

// splitLines splits a multi-line block into at most `height`
// rows, each padded to `width`. Used so renderTranscriptLines
// (which already returns joined text) can be appended into the
// body's line list without losing the line structure.
func splitLines(block string, width, height int) []string {
	if block == "" || height <= 0 {
		return nil
	}
	parts := strings.Split(block, "\n")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if len(out) >= height {
			break
		}
		out = append(out, padOrTruncate(p, width))
	}
	return out
}

// parseTranscriptRole maps the role label rendered by
// TranscriptRole.String() back to the enum so the chrome can
// pick a color. Returns RoleSystem for unknown labels so the
// fallback never crashes the renderer.
func parseTranscriptRole(label string) TranscriptRole {
	switch label {
	case "you":
		return RoleUser
	case "ai":
		return RoleAssistant
	case "tool":
		return RoleTool
	case "sys":
		return RoleSystem
	default:
		return RoleSystem
	}
}

// styleForTranscriptRole picks the chrome color for a
// transcript line's role. Reuses the palette: user→accent
// (so the operator sees their own input pop), assistant→text
// (default body color), tool→blue (matches working status),
// system→muted (so system messages don't compete with content).
func styleForTranscriptRole(r TranscriptRole) string {
	switch r {
	case RoleUser:
		return accentStyle.Render("you")
	case RoleAssistant:
		return textStyle.Render("ai")
	case RoleTool:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colBlue)).Render("tool")
	case RoleSystem:
		return mutedStyle.Render("sys")
	default:
		return mutedStyle.Render("?")
	}
}

// fallback returns s if non-empty, otherwise dflt. Used to
// keep the placeholder body stable when optional fields like
// Agent are still empty.
func fallback(s, dflt string) string {
	if strings.TrimSpace(s) == "" {
		return dflt
	}
	return s
}

// footerKeybind is one row in the footer keybind list.
// Keys is a list of styled glyphs (e.g. "ctrl+n" + " " +
// "ctrl+b"); Desc is the human label. We render the full
// hint by joining the keys with " / " and appending the
// description in muted style.
type footerKeybind struct {
	Keys []string
	Desc string
}

// keyStyle + descStyle are split so callers can override
// per group; for now they're the package-level styles.
func (k footerKeybind) Render() string {
	keyPart := strings.Join(k.Keys, keyStyle.Render(" / "))
	return keyPart + mutedStyle.Render(" "+k.Desc)
}

// footerKeybinds is the full footer keybind list, split
// into the two priority groups the responsive footer
// renders. Group 1 ("critical") is always shown — these
// are the keys the operator needs to keep the TUI alive
// no matter how narrow the terminal. Group 2 ("workflow")
// is shown only when there's room (desktop mode) or on a
// second line (mobile mode).
func footerKeybinds() (critical, workflow []footerKeybind) {
	critical = []footerKeybind{
		{Keys: []string{"ctrl+n"}, Desc: "new"},
		{Keys: []string{"ctrl+b"}, Desc: "sidebar"},
		{Keys: []string{"ctrl+z"}, Desc: "zoom"},
		{Keys: []string{"?"}, Desc: "help"},
		{Keys: []string{"q"}, Desc: "quit"},
	}
	workflow = []footerKeybind{
		{Keys: []string{"ctrl+w"}, Desc: "close"},
		{Keys: []string{"ctrl+h", "ctrl+l"}, Desc: "move"},
		{Keys: []string{"ctrl+pgup", "ctrl+pgdn"}, Desc: "tab"},
		{Keys: []string{"ctrl+t"}, Desc: "workspace"},
	}
	return critical, workflow
}

// renderFooterLine renders a single line of the footer:
// the keybind list on the left, the reconcile indicator
// (when present) right-aligned. Returns "" if the line
// is empty.
func renderFooterLine(width int, binds []footerKeybind, info reconcileFooterInfo) string {
	if width <= 0 {
		return ""
	}
	parts := make([]string, 0, len(binds))
	for _, b := range binds {
		parts = append(parts, b.Render())
	}
	hint := strings.Join(parts, dividerStyle.Render(" · "))
	indicator := renderReconcileIndicator(info)
	if indicator == "" {
		return padOrTruncate(hint, width)
	}
	maxHintWidth := max(0, width-lipgloss.Width(indicator)-1)
	hint = truncatePlain(hint, maxHintWidth)
	hintW := lipgloss.Width(hint)
	indW := lipgloss.Width(indicator)
	gap := max(1, width-hintW-indW-1)
	if gap+hintW+indW > width {
		// Terminal too narrow for both columns; the
		// indicator wins (it carries the live state), and
		// the keybind hint gets truncated by truncatePlain.
		return padOrTruncate(indicator, width)
	}
	return padOrTruncate(hint+strings.Repeat(" ", gap)+indicator, width)
}

// renderFooter is the bottom keybind hint bar. The base
// hint is the always-visible key list; the right side
// carries a transient reconcile indicator ("synced 3s
// ago" / "syncing..." / "sync failed: <err>") sourced
// from the `info` bundle.
//
// In desktop mode the footer is one line with all
// keybinds; the right side gets the reconcile indicator.
// In mobile mode it's two lines — the critical keybinds
// on line 1, the workflow keybinds on line 2 — so the
// always-visible controls still fit on a 40-col terminal.
// In tooSmall mode the caller skips the footer entirely.
//
// The previous transient rows (queued prompts, permission
// prompts, elapsed time) are intentionally NOT wired here
// yet — those are Phase 6b status sidebar work and would
// be misleading to add before the data layer supports them.
func renderFooter(model LoopModel, width int, info reconcileFooterInfo, layout chromeLayout) string {
	critical, workflow := footerKeybinds()
	if layout.Mode == layoutMobile {
		line1 := renderFooterLine(width, critical, info)
		line2 := renderFooterLine(width, workflow, reconcileFooterInfo{})
		return footerStyle.Render(line1 + "\n" + line2)
	}
	// Desktop: show as many as fit. Start with the critical
	// group, then append workflow groups while there's room.
	all := append([]footerKeybind{}, critical...)
	all = append(all, workflow...)
	// Probe: does the full list fit on one line? If not,
	// fall back to critical-only (still one line) and let
	// the operator see `?` for the rest.
	fullHint := renderFooterHint(all)
	fullIndicator := renderReconcileIndicator(info)
	fullWidth := lipgloss.Width(fullHint)
	if fullIndicator != "" {
		fullWidth += lipgloss.Width(fullIndicator) + 1
	}
	if fullWidth <= width || (width >= 96 && fullIndicator == "") {
		return footerStyle.Render(renderFooterLine(width, all, info))
	}
	short := renderFooterLine(width, critical, info)
	return footerStyle.Render(short)
}

func renderFooterHint(binds []footerKeybind) string {
	parts := make([]string, 0, len(binds))
	for _, b := range binds {
		parts = append(parts, b.Render())
	}
	return strings.Join(parts, dividerStyle.Render(" · "))
}

// renderReconcileIndicator returns the right-aligned footer
// segment that surfaces the latest reconcile pass state.
// Returns "" for the zero-value bundle so a freshly-launched
// (or reconciler-less) TUI doesn't get a noisy empty dot.
//
// Precedence (most specific → least):
//   - InFlight == true             → "● syncing..." (blue)
//     appends " (last Ns ago)" if a prior result is known
//   - Err != nil                   → "● sync failed: <err> Ns ago" (red)
//   - At != zero and no Err        → "● synced Ns ago · N pushed · M pulled" (green)
//   - otherwise (no reconcile yet) → ""
func renderReconcileIndicator(info reconcileFooterInfo) string {
	dotStyle := func(c string) lipgloss.Style {
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(c))
	}
	switch {
	case info.InFlight:
		left := dotStyle(colBlue).Render("●") + " " + textStyle.Render("syncing...")
		if !info.At.IsZero() {
			left += " " + mutedStyle.Render("(last "+formatActivity(info.At)+")")
		}
		return left
	case info.Err != nil && !info.At.IsZero():
		err := info.Err.Error()
		// Clip verbose errors so the footer stays one line.
		if len(err) > 40 {
			err = err[:37] + "…"
		}
		left := dotStyle(colRed).Render("●") + " " + textStyle.Render("sync failed: "+err)
		left += " " + mutedStyle.Render(formatActivity(info.At))
		return left
	case !info.At.IsZero():
		counts := []string{}
		if info.Result.Pushed > 0 {
			counts = append(counts, fmt.Sprintf("%d pushed", info.Result.Pushed))
		}
		if info.Result.Pulled > 0 {
			counts = append(counts, fmt.Sprintf("%d pulled", info.Result.Pulled))
		}
		body := "synced " + formatActivity(info.At)
		if len(counts) > 0 {
			body += " · " + strings.Join(counts, " · ")
		}
		left := dotStyle(colGreen).Render("●") + " " + textStyle.Render(body)
		return left
	}
	return ""
}

// truncatePlain clamps a string to `width` runes by adding
// an ellipsis when the input is too long. Counts runes (not
// bytes) so multi-byte characters don't desync the layout.
// ANSI sequences are counted as zero width to keep styled
// output aligned with plain output.
func truncatePlain(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= width {
		return s
	}
	const ellipsis = "…"
	return ansi.Truncate(s, width, ellipsis)
}

func padOrTruncate(s string, width int) string {
	if width <= 0 {
		return ""
	}
	s = truncatePlain(s, width)
	w := lipgloss.Width(s)
	if w >= width {
		return s
	}
	return s + strings.Repeat(" ", width-w)
}

func clampBlock(block string, width, height int) string {
	if width <= 0 || height <= 0 {
		return ""
	}
	lines := strings.Split(block, "\n")
	out := make([]string, 0, height)
	for _, line := range lines {
		if len(out) >= height {
			break
		}
		out = append(out, padOrTruncate(line, width))
	}
	for len(out) < height {
		out = append(out, strings.Repeat(" ", width))
	}
	return strings.Join(out, "\n")
}

// renderToastLine returns the transient one-line banner that
// sits between the body and the footer, or "" when there is
// no active toast. The banner uses a soft background and a
// bullet so the operator notices it without it being loud
// enough to compete with the focused pane body. Mirrors
// herdr's CopyFeedback shape (single line, accent color,
// fades after a couple of seconds).
func renderToastLine(toast string, width int) string {
	if strings.TrimSpace(toast) == "" {
		return ""
	}
	if width <= 0 {
		width = 80
	}
	dotColor := accentStyle
	if strings.HasPrefix(toast, "✗") {
		dotColor = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colRed))
	} else if strings.HasPrefix(toast, "✓") {
		dotColor = lipgloss.NewStyle().Foreground(lipgloss.Color(colGreen))
	}
	left := dotColor.Render("●") + " " + textStyle.Render(strings.TrimSpace(toast))
	right := mutedStyle.Render("esc dismiss")
	gap := max(1, width-lipgloss.Width(left)-lipgloss.Width(right)-2)
	return padOrTruncate(left+strings.Repeat(" ", gap)+right, width)
}

// overlayHelp paints the help keybind cheat sheet on top of
// the existing chrome. We don't try to "render around" the
// chrome — we just splice the framed box into the middle
// row so the operator can still see the focused pane id
// above and the footer hints below. The frame uses the
// accent border (matching herdr's `render_modal_shell`) so
// the overlay reads as a focusable surface.
func overlayHelp(content string, width, height int) string {
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 24
	}
	helpW := min(60, width-4)
	helpH := min(16, height-4)
	if helpW < 30 || helpH < 8 {
		// Terminal too small for a real overlay; fall back
		// to an inline hint line so the operator still
		// knows which keys do what.
		return content + "\n" + mutedStyle.Render(
			truncatePlain("? help: ctrl+n new · ctrl+w close · ctrl+h/l move · ctrl+pgup/dn tab · ctrl+t workspace · q quit", width))
	}

	panel := renderHelpPanel(helpW, helpH)
	startY := (height - helpH) / 2
	if startY < 0 {
		startY = 0
	}
	startX := (width - helpW) / 2
	if startX < 0 {
		startX = 0
	}
	lines := strings.Split(content, "\n")
	panelLines := strings.Split(panel, "\n")
	for i, line := range panelLines {
		row := startY + i
		if row < 0 || row >= len(lines) {
			continue
		}
		lines[row] = spliceLine(lines[row], startX, line, width)
	}
	for len(lines) < height {
		lines = append(lines, strings.Repeat(" ", max(0, width)))
	}
	return strings.Join(lines, "\n")
}

// renderHelpPanel builds the centered help panel's
// content: a header line, the keybind list grouped by
// intent, and a footer hint. Returns the unbordered block;
// the overlayHelp caller handles frame placement.
func renderHelpPanel(width, height int) string {
	rows := []struct{ key, desc string }{
		{"ctrl+n", "open a new pane"},
		{"ctrl+w", "close the focused pane"},
		{"ctrl+h / ctrl+l", "move focus left / right"},
		{"ctrl+pgup / ctrl+pgdn", "cycle tabs in the workspace"},
		{"ctrl+t", "new workspace"},
		{"ctrl+b", "toggle sidebar (collapse / expand)"},
		{"ctrl+z", "zoom focused pane (hide chrome)"},
		{"?", "toggle this help overlay"},
		{"q / esc / ctrl+c", "quit bbl loop"},
	}
	innerW := max(10, width-2)
	var b strings.Builder
	b.WriteString(sectionHeaderStyle.Render("bbl loop · keyboard shortcuts"))
	b.WriteString("\n")
	b.WriteString(mutedStyle.Render(strings.Repeat("─", innerW)))
	b.WriteString("\n")
	for _, r := range rows {
		key := keyStyle.Render(padRightPlain(r.key, 24))
		b.WriteString("  " + key + mutedStyle.Render(r.desc))
		b.WriteString("\n")
	}
	b.WriteString("\n")
	b.WriteString(mutedStyle.Render(truncatePlain(
		"press ? or esc to close", innerW)))
	// Don't apply truncatePlain to the full multi-line
	// panel — the function is rune-based and would chop
	// horizontally across rows, hiding row text. Each row
	// is already padRightPlain'd to 24 cols + desc, which
	// fits in innerW for any reasonable width.
	return b.String()
}

// spliceLine replaces `width` characters of `line` starting
// at `col` with `replacement`. Used by overlayHelp to draw
// the framed help panel on top of the existing chrome. If
// the replacement is shorter than the line it's overwriting
// we keep the right-side padding so column alignment stays
// correct.
func spliceLine(line string, col int, replacement string, width int) string {
	runes := []rune(line)
	repRunes := []rune(replacement)
	if col < 0 {
		col = 0
	}
	if col >= len(runes) {
		// Pad line out to col so the replacement fits.
		for len(runes) < col {
			runes = append(runes, ' ')
		}
		runes = append(runes, repRunes...)
		return string(runes)
	}
	// Overwrite `col..col+len(repRunes)` then keep the tail.
	tailStart := col + len(repRunes)
	tail := ""
	if tailStart < len(runes) {
		tail = string(runes[tailStart:])
	}
	out := string(runes[:col]) + replacement + tail
	// Pad back to `width` columns.
	if rlen := len([]rune(out)); rlen < width {
		out += strings.Repeat(" ", width-rlen)
	}
	return out
}

// padRightPlain pads `s` with spaces to `width` runes (not
// styled). Used to align the key + desc columns in the
// help overlay.
func padRightPlain(s string, width int) string {
	rn := len([]rune(s))
	if rn >= width {
		return s
	}
	return s + strings.Repeat(" ", width-rn)
}

// reconcileFooterInfo is the bundle the chrome layer reads
// to render the footer's reconcile status indicator. It's
// constructed by InteractiveModel.View() from the
// reconcileDoneMsg / reconcileInFlight / lastReconcileAt
// fields, then passed through chromeViewState so the data
// layer (model.go) stays free of any chrome-shaped concern.
//
//   - InFlight == true takes precedence: the footer shows
//     "● syncing..." (and appends "last 3s ago" if At is
//     non-zero, so the operator knows the previous pass's
//     age while the current one is in flight).
//   - Err != nil shows "● sync failed: <err> Ns ago" in red.
//   - At != zero and Err == nil shows "● synced Ns ago · 1p
//     · 2u" in green.
//   - Zero-value (never run) renders "" so the footer stays
//     just the keybind hints.
type reconcileFooterInfo struct {
	InFlight bool
	At       time.Time
	Result   RunOnceResult
	Err      error
}

// layoutChromeState is the runtime-only chrome flags that
// affect geometry rather than transient content. Held
// separately from the data layer's LoopModel so the model
// stays free of "is the sidebar collapsed?" or "are we
// zoomed in on a pane?" concerns — those are properties of
// the interactive driver.
//
// SidebarCollapsed is the Ctrl+B toggle: when true the
// sidebar shrinks to a 4-col gutter so the focused pane
// gets more width without losing the workspace/tab
// navigation affordance.
//
// ZoomFocused is the Ctrl+Z toggle: when true the focused
// pane fills the entire body (sidebar is hidden) so the
// operator can read pane content at maximum size. Distinct
// from collapse: collapse preserves the chrome, zoom
// suppresses it.
type layoutChromeState struct {
	SidebarCollapsed bool
	ZoomFocused      bool
}

// formatActivity returns a compact "just now" / "5s ago" /
// "2m ago" / "1h ago" / "3d ago" label for a LastEventAt
// timestamp. Returns "" for the zero time so the sidebar
// can skip the field cleanly when the reconciler hasn't
// reported yet.
func formatActivity(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := time.Since(t)
	if d < 0 {
		// Clock skew between the loop driver and the
		// reconciler; show the timestamp as fresh.
		return "just now"
	}
	// Sub-second: surface as "just now" rather than "0s ago"
	// so a freshly-stamped pane doesn't read as ancient.
	if d < time.Second {
		return "just now"
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}
