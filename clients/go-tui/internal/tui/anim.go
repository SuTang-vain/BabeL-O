package tui

import (
	"math/rand"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/lucasb-eyer/go-colorful"
)

const (
	animFPS           = 12
	maxBirthSteps     = 10
	prerenderedFrames = 24
)

var (
	availableRunes = []rune("0123456789abcdefABCDEF~!@#$£€%^&*()+=_")
)

type gradientSpinner struct {
	width            int
	step             int
	framesSinceStart int
	birthSteps       []int
	initialized      bool
	initialFrames    [][]string
	cyclingFrames    [][]string
}

func newGradientSpinner() gradientSpinner {
	width := 24

	// Neon purple (#af87ff) to neon pink (#ff5faf) to cyan (#5fffff)
	c1, _ := colorful.Hex("#af87ff")
	c2, _ := colorful.Hex("#ff5faf")
	c3, _ := colorful.Hex("#5fffff")

	ramp := makeGradientRamp(width*4, c1, c2, c3, c1)

	// Pre-render initial frames (dots/initial chars)
	initialFrames := make([][]string, prerenderedFrames)
	for i := range initialFrames {
		initialFrames[i] = make([]string, width)
		for j := range initialFrames[i] {
			c := ramp[(j+i)%len(ramp)]
			hex := c.Hex()
			initialFrames[i][j] = lipgloss.NewStyle().
				Foreground(lipgloss.Color(hex)).
				Render(".")
		}
	}

	// Pre-render cycling frames (matrix runes)
	// We use a local PRNG for deterministic glyph generation so it's stable.
	rng := rand.New(rand.NewSource(42))
	cyclingFrames := make([][]string, prerenderedFrames)
	for i := range cyclingFrames {
		cyclingFrames[i] = make([]string, width)
		for j := range cyclingFrames[i] {
			c := ramp[(j+i)%len(ramp)]
			hex := c.Hex()
			r := availableRunes[rng.Intn(len(availableRunes))]
			cyclingFrames[i][j] = lipgloss.NewStyle().
				Foreground(lipgloss.Color(hex)).
				Render(string(r))
		}
	}

	// Staggered birth steps for smooth fade-in
	birthSteps := make([]int, width)
	for i := range birthSteps {
		birthSteps[i] = rng.Intn(maxBirthSteps)
	}

	return gradientSpinner{
		width:         width,
		birthSteps:    birthSteps,
		initialFrames: initialFrames,
		cyclingFrames: cyclingFrames,
	}
}

type gradientSpinnerTickMsg struct {
	Time time.Time
}

// Tick returns a tea.Msg to conform with the bubbles spinner interface
// so method values like m.spinner.Tick have type func() tea.Msg (which is tea.Cmd).
func (s gradientSpinner) Tick() tea.Msg {
	return gradientSpinnerTickMsg{Time: time.Now()}
}

func (s gradientSpinner) Update(msg tea.Msg) (gradientSpinner, tea.Cmd) {
	switch msg.(type) {
	case gradientSpinnerTickMsg:
		s.step = (s.step + 1) % prerenderedFrames
		s.framesSinceStart++
		if !s.initialized && s.framesSinceStart >= maxBirthSteps {
			s.initialized = true
		}
		return s, tea.Tick(time.Second/time.Duration(animFPS), func(t time.Time) tea.Msg {
			return gradientSpinnerTickMsg{Time: t}
		})
	default:
		return s, nil
	}
}

func (s gradientSpinner) View() string {
	var b strings.Builder
	for i := 0; i < s.width; i++ {
		if !s.initialized && s.framesSinceStart < s.birthSteps[i] {
			b.WriteString(s.initialFrames[s.step][i])
		} else {
			b.WriteString(s.cyclingFrames[s.step][i])
		}
	}
	return b.String()
}

func makeGradientRamp(size int, stops ...colorful.Color) []colorful.Color {
	if len(stops) < 2 {
		return nil
	}
	numSegments := len(stops) - 1
	blended := make([]colorful.Color, 0, size)
	segmentSizes := make([]int, numSegments)
	baseSize := size / numSegments
	remainder := size % numSegments

	for i := 0; i < numSegments; i++ {
		segmentSizes[i] = baseSize
		if i < remainder {
			segmentSizes[i]++
		}
	}

	for i := 0; i < numSegments; i++ {
		c1 := stops[i]
		c2 := stops[i+1]
		segmentSize := segmentSizes[i]
		for j := 0; j < segmentSize; j++ {
			if segmentSize == 0 {
				continue
			}
			t := float64(j) / float64(segmentSize)
			c := c1.BlendHcl(c2, t)
			blended = append(blended, c)
		}
	}
	return blended
}
