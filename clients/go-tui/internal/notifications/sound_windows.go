//go:build windows
// +build windows

// internal/notifications/sound_windows.go
//
// Windows stub SoundPlayer. Returns nil for every Play so
// the TUI never errors out on Windows, where a proper
// notification hook (MessageBeep, win toast) requires more
// infrastructure than the Phase 4b slice warrants. Phase 5
// or later can wire MessageBeep without changing the
// SoundPlayer interface.

package notifications

// NewSoundPlayerForPlatform returns the Windows SoundPlayer.
func NewSoundPlayerForPlatform() SoundPlayer {
	return NewWindowsSoundPlayer()
}

// WindowsSoundPlayer is the no-op SoundPlayer for Windows.
type WindowsSoundPlayer struct{}

func NewWindowsSoundPlayer() *WindowsSoundPlayer { return &WindowsSoundPlayer{} }

func (p *WindowsSoundPlayer) Play(name SoundName) error { return nil }
