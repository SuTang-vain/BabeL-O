//go:build linux
// +build linux

// internal/notifications/sound_linux.go
//
// Linux SoundPlayer: probes for a working audio backend at
// startup (paplay / aplay / canberra-gtk-play) and shells
// out to the first one found. The probe runs once in
// NewLinuxSoundPlayer; the resulting player reuses that
// backend for every Play call.

package notifications

import (
	"fmt"
	"os/exec"
	"sync"
)

// NewSoundPlayerForPlatform returns the Linux SoundPlayer.
func NewSoundPlayerForPlatform() SoundPlayer {
	return NewLinuxSoundPlayer()
}

// linuxBackend is the resolved audio tool the Linux player
// will shell out to. Empty means no backend was found.
type linuxBackend struct {
	binary string
	args   []string // optional args that prefix the sound arg
}

// LinuxSoundPlayer is the Linux-specific SoundPlayer. It
// holds a probe-resolved backend; falls back to a no-op
// player when no backend is available so the TUI never
// errors out from a missing sound tool.
type LinuxSoundPlayer struct {
	mu      sync.Mutex
	backend linuxBackend
}

func NewLinuxSoundPlayer() *LinuxSoundPlayer {
	return &LinuxSoundPlayer{backend: probeLinuxBackend()}
}

// probeLinuxBackend returns the first available audio
// binary. Precedence: paplay (PulseAudio) > aplay (ALSA) >
// canberra-gtk-play (libcanberra) > empty (no audio).
func probeLinuxBackend() linuxBackend {
	for _, candidate := range []linuxBackend{
		{binary: "paplay"},
		{binary: "aplay", args: []string{"-q"}},
		{binary: "canberra-gtk-play", args: []string{"--id="}},
	} {
		if _, err := exec.LookPath(candidate.binary); err == nil {
			return candidate
		}
	}
	return linuxBackend{}
}

func (p *LinuxSoundPlayer) Play(name SoundName) error {
	if name == SoundNone {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.backend.binary == "" {
		return nil // silent no-op
	}
	// Map our SoundName to a system theme token. PulseAudio
	// and canberra-gtk-play both accept freedesktop sound
	// names; aplay needs a WAV file path which we don't
	// ship, so aplay's role here is the alert (it always
	// produces a tone on the default device).
	var soundArg string
	switch name {
	case SoundAlert:
		soundArg = "alarm-clock"
	case SoundWarn:
		soundArg = "dialog-warning"
	case SoundChime:
		soundArg = "complete"
	case SoundNotify:
		soundArg = "message"
	}
	if soundArg == "" {
		return nil
	}
	args := append([]string{}, p.backend.args...)
	if p.backend.binary == "canberra-gtk-play" {
		args = append(args, soundArg)
	} else {
		args = append(args, soundArg)
	}
	cmd := exec.Command(p.backend.binary, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		_ = out
		return fmt.Errorf("notifications: %s failed: %w", p.backend.binary, err)
	}
	return nil
}
