package tui

import (
	"strings"

	"github.com/sahilm/fuzzy"
)

// FuzzyItem is the minimal item contract used by FilterableList.
// It follows crush's filterable list shape but is intentionally
// small for go-tui's current slash palette: Filter returns the
// string fuzzy matches against, SetMatch receives the ranked match
// for later rendering/highlighting.
type FuzzyItem interface {
	Filter() string
	SetMatch(fuzzy.Match)
}

// FilterableList holds a static item slice plus the current query.
// SetQuery recomputes fuzzy matches and stores them back into the
// matched items via SetMatch.
type FilterableList[T FuzzyItem] struct {
	items []T
	query string
}

func NewFilterableList[T FuzzyItem](items []T) *FilterableList[T] {
	return &FilterableList[T]{items: items}
}

func (f *FilterableList[T]) SetQuery(query string) {
	f.query = strings.TrimPrefix(query, "/")
}

func (f *FilterableList[T]) Items() []T {
	if f.query == "" {
		out := make([]T, len(f.items))
		copy(out, f.items)
		return out
	}
	filters := make([]string, len(f.items))
	for i, item := range f.items {
		filters[i] = item.Filter()
	}
	matches := fuzzy.Find(f.query, filters)
	out := make([]T, 0, len(matches))
	for _, match := range matches {
		item := f.items[match.Index]
		item.SetMatch(match)
		out = append(out, item)
	}
	return out
}
