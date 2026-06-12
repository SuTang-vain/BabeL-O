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
	prerenderedFrames = 48
)

var (
	availableRunes = []rune("0123456789abcdefABCDEF~!@#$£€%^&*()+=_")
)

type runtimeAnimationKind string

const (
	runtimeAnimationDefault    runtimeAnimationKind = "default"
	runtimeAnimationThinking   runtimeAnimationKind = "thinking"
	runtimeAnimationResponding runtimeAnimationKind = "responding"
	runtimeAnimationTool       runtimeAnimationKind = "tool"
	runtimeAnimationPermission runtimeAnimationKind = "permission"
)

type runtimeAnimationCacheKey struct {
	width int
	kind  runtimeAnimationKind
}

type gradientSpinner struct {
	width            int
	step             int
	framesSinceStart int
	birthSteps       []int
	initialized      bool
	initialFrames    [][]string
	cyclingFrames    [][]string
	lightBarFrames   map[runtimeAnimationCacheKey][]string
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
		width:          width,
		birthSteps:     birthSteps,
		initialFrames:  initialFrames,
		cyclingFrames:  cyclingFrames,
		lightBarFrames: map[runtimeAnimationCacheKey][]string{},
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

// LightBar renders a one-line running indicator for the composer
// chrome. Frames are pre-rendered per width so every tick only
// selects a string. The frame itself layers a main sweep, a quieter
// counter-sweep, a breathing anchor point, and sparse sparks so it
// feels less like a single loop while staying cheap to render.
func (s *gradientSpinner) LightBar(width int, kind runtimeAnimationKind) string {
	if width <= 0 {
		return ""
	}
	if kind == "" {
		kind = runtimeAnimationDefault
	}
	key := runtimeAnimationCacheKey{width: width, kind: kind}
	frames := s.lightBarFrames[key]
	if len(frames) == 0 {
		frames = prerenderLightBarFrames(width, kind)
		if s.lightBarFrames == nil {
			s.lightBarFrames = map[runtimeAnimationCacheKey][]string{}
		}
		s.lightBarFrames[key] = frames
	}
	return frames[s.step%len(frames)]
}

func prerenderLightBarFrames(width int, kind runtimeAnimationKind) []string {
	c1, c2, c3 := runtimeAnimationPalette(kind)
	ramp := makeGradientRamp(max(1, width+prerenderedFrames*2), c1, c2, c3, c1)
	track := lipgloss.NewStyle().Foreground(lipgloss.Color("238")).Render("━")
	softTrack := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Render("╍")
	tail := lipgloss.NewStyle().Foreground(lipgloss.Color("241")).Render("╍")
	frames := make([]string, prerenderedFrames)
	bandWidth := runtimeAnimationBandWidth(width, kind)
	for frame := 0; frame < prerenderedFrames; frame++ {
		head := runtimeAnimationHead(frame, width, bandWidth, kind)
		counterHead := runtimeAnimationCounterHead(frame, width, bandWidth, kind)
		pulseCenter := runtimeAnimationPulseCenter(frame, width, kind)
		sparkA := (frame*7 + width/3) % max(1, width)
		sparkB := (frame*11 + width*2/3 + 5) % max(1, width)
		var b strings.Builder
		for i := 0; i < width; i++ {
			distance := i - head + bandWidth
			counterDistance := counterHead - i + bandWidth/2
			switch {
			case distance >= 0 && distance < bandWidth:
				c := ramp[(i+frame)%len(ramp)]
				b.WriteString(lipgloss.NewStyle().
					Foreground(lipgloss.Color(c.Hex())).
					Render("━"))
			case kind != runtimeAnimationResponding && counterDistance >= 0 && counterDistance < max(2, bandWidth/2):
				c := ramp[(i+frame*2+len(ramp)/3)%len(ramp)]
				b.WriteString(lipgloss.NewStyle().
					Foreground(lipgloss.Color(c.BlendHcl(colorful.Color{R: 0.55, G: 0.55, B: 0.55}, 0.45).Hex())).
					Render("─"))
			case runtimeAnimationShowsPulse(kind) && (i == pulseCenter || i == (pulseCenter+1)%max(1, width)):
				c := ramp[(frame*2+i)%len(ramp)]
				b.WriteString(lipgloss.NewStyle().
					Foreground(lipgloss.Color(c.Hex())).
					Render("◆"))
			case runtimeAnimationShowsSpark(kind, frame) && (i == sparkA || i == sparkB):
				c := ramp[(frame*3+i)%len(ramp)]
				b.WriteString(lipgloss.NewStyle().
					Foreground(lipgloss.Color(c.Hex())).
					Render(runtimeAnimationSpark(kind)))
			case distance >= bandWidth && distance < bandWidth+2:
				b.WriteString(tail)
			case (i+frame)%7 == 0:
				b.WriteString(softTrack)
			default:
				b.WriteString(track)
			}
		}
		frames[frame] = b.String()
	}
	return frames
}

func runtimeAnimationPalette(kind runtimeAnimationKind) (colorful.Color, colorful.Color, colorful.Color) {
	switch kind {
	case runtimeAnimationThinking:
		c1, _ := colorful.Hex("#8b5cf6")
		c2, _ := colorful.Hex("#ff5faf")
		c3, _ := colorful.Hex("#5fffff")
		return c1, c2, c3
	case runtimeAnimationResponding:
		c1, _ := colorful.Hex("#5fffff")
		c2, _ := colorful.Hex("#7dd3fc")
		c3, _ := colorful.Hex("#ff5faf")
		return c1, c2, c3
	case runtimeAnimationTool:
		c1, _ := colorful.Hex("#ff7a18")
		c2, _ := colorful.Hex("#ff5faf")
		c3, _ := colorful.Hex("#8b5cf6")
		return c1, c2, c3
	case runtimeAnimationPermission:
		c1, _ := colorful.Hex("#facc15")
		c2, _ := colorful.Hex("#ff7a18")
		c3, _ := colorful.Hex("#ff5faf")
		return c1, c2, c3
	default:
		c1, _ := colorful.Hex("#af87ff")
		c2, _ := colorful.Hex("#ff5faf")
		c3, _ := colorful.Hex("#5fffff")
		return c1, c2, c3
	}
}

func runtimeAnimationBandWidth(width int, kind runtimeAnimationKind) int {
	switch kind {
	case runtimeAnimationThinking:
		return clamp(width/6, 3, 7)
	case runtimeAnimationResponding:
		return clamp(width/4, 6, 12)
	case runtimeAnimationTool:
		return clamp(width/7, 3, 6)
	case runtimeAnimationPermission:
		return clamp(width/5, 4, 8)
	default:
		return clamp(width/5, 4, 9)
	}
}

func runtimeAnimationHead(frame, width, bandWidth int, kind runtimeAnimationKind) int {
	span := max(1, width+bandWidth*2)
	switch kind {
	case runtimeAnimationThinking:
		return (frame * span / (prerenderedFrames + 10)) + (frame%5)/2
	case runtimeAnimationResponding:
		return (frame * span * 2 / prerenderedFrames) % span
	case runtimeAnimationTool:
		return (frame * span * 3 / prerenderedFrames) % span
	default:
		return (frame * span) / prerenderedFrames
	}
}

func runtimeAnimationCounterHead(frame, width, bandWidth int, kind runtimeAnimationKind) int {
	span := max(1, width+bandWidth)
	switch kind {
	case runtimeAnimationTool:
		return width - 1 - ((frame * span * 2) / (prerenderedFrames + 3))
	case runtimeAnimationPermission:
		return width/2 + ((frame % 8) - 4)
	default:
		return width - 1 - ((frame * span) / (prerenderedFrames + 7))
	}
}

func runtimeAnimationPulseCenter(frame, width int, kind runtimeAnimationKind) int {
	if width <= 0 {
		return 0
	}
	switch kind {
	case runtimeAnimationThinking:
		return (width/2 + (frame%9 - 4)) % width
	case runtimeAnimationPermission:
		return width / 2
	default:
		return (frame * 3) % width
	}
}

func runtimeAnimationShowsPulse(kind runtimeAnimationKind) bool {
	return kind == runtimeAnimationThinking || kind == runtimeAnimationPermission || kind == runtimeAnimationDefault
}

func runtimeAnimationShowsSpark(kind runtimeAnimationKind, frame int) bool {
	switch kind {
	case runtimeAnimationTool:
		return frame%3 == 0 || frame%5 == 1
	case runtimeAnimationResponding:
		return frame%11 == 0
	case runtimeAnimationPermission:
		return frame%8 == 0
	default:
		return frame%9 == 0 || frame%13 == 4
	}
}

func runtimeAnimationSpark(kind runtimeAnimationKind) string {
	switch kind {
	case runtimeAnimationTool:
		return "✧"
	case runtimeAnimationResponding:
		return "·"
	case runtimeAnimationPermission:
		return "!"
	default:
		return "✦"
	}
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
