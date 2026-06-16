//go:build !darwin && !linux && !windows

// internal/notifications/sound_other.go
//
// Fallback SoundPlayer for any platform that isn't macOS,
// Linux, or Windows (FreeBSD, OpenBSD, etc). Returns nil for
// every Play; the runtime never errors out on an unknown
// host. Phase 5 or later can add per-OS backends behind the
// same SoundPlayer interface.

package notifications

// NewSoundPlayerForPlatform returns the stub SoundPlayer
// for unsupported platforms.
func NewSoundPlayerForPlatform() SoundPlayer {
	return NewStubSoundPlayer()
}

// StubSoundPlayer is the no-op SoundPlayer for unsupported
// platforms.
type StubSoundPlayer struct{}

func NewStubSoundPlayer() *StubSoundPlayer { return &StubSoundPlayer{} }

func (p *StubSoundPlayer) Play(name SoundName) error { return nil }
