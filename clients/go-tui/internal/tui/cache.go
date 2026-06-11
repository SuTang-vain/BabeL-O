package tui

// Versioned is a tiny embeddable helper that satisfies a
// "this item's render output is at version N" contract. Items
// that participate in the transcript render cache (crush's
// `Versioned` pattern, see crush/internal/ui/list/item.go:50)
// embed `*Versioned` and call Bump() on every state change that
// would alter their rendered output.
//
// Bump is intentionally cheap: a single counter increment, no
// allocation. The version alone is used as the cache key, so
// a forgotten Bump() simply shows stale content rather than
// panicking.
type Versioned struct {
	v uint64
}

// NewVersioned returns a fresh *Versioned at version 0.
func NewVersioned() *Versioned { return &Versioned{} }

// Version returns the current version counter.
func (vc *Versioned) Version() uint64 { return vc.v }

// Bump advances the version counter by one. Callers should
// invoke Bump after any mutation that affects the item's
// rendered output (text change, kind change, formatting flag
// flip, etc.).
func (vc *Versioned) Bump() { vc.v++ }

// renderCache is a per-item memo for the rendered transcript
// row. The cache hit condition is:
//   - cachedWidth matches the requested width
//   - cachedVersion matches the item's current Version()
//
// The width check handles terminal resizes; the version check
// handles content mutations. Either one changing forces a
// re-render. The cache is one tiny struct per transcript row;
// no global state, no map lookup, no allocation on the hot
// path.
//
// embed-in-struct pattern: transcriptItem has a `cache
// renderCache` field, and renderTranscript's loop calls
// `item.cache.GetOrCompute(width, item.Version(), render)`.
type renderCache struct {
	cachedWidth   int
	cachedVersion uint64
	view          string
}

// GetOrCompute returns the cached view if (width, version)
// match the last successful render, otherwise calls render()
// to produce a new view, stores it, and returns it.
//
// A zero-value renderCache (the field default for a freshly
// constructed transcriptItem) will always miss on the first
// call because cachedVersion starts at 0 and the first render
// stores the computed string + the version that was current at
// that time. Subsequent calls with the same (item, width)
// pair will hit until either width changes or the item's
// version is bumped.
func (c *renderCache) GetOrCompute(width int, version uint64, render func() string) string {
	if c.cachedWidth == width && c.cachedVersion == version && c.view != "" {
		return c.view
	}
	c.view = render()
	c.cachedWidth = width
	c.cachedVersion = version
	return c.view
}

// Invalidate drops the cached entry so the next GetOrCompute
// forces a re-render. Useful for tests and for paths that
// mutate the item without going through Bump (which would
// already invalidate the cache via the version check).
func (c *renderCache) Invalidate() {
	c.cachedWidth = 0
	c.cachedVersion = 0
	c.view = ""
}
