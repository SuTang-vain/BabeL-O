//go:build darwin
// +build darwin

// internal/notifications/sound_darwin.go
//
// macOS SoundPlayer: shells out to `osascript -e "beep"` for
// the alert sound and `afplay /System/Library/Sounds/<name>.aiff`
// for the others. /System/Library/Sounds ships on every macOS
// install so the path is stable. The osascript / afplay
// binaries are part of the system; the worst case when
// they're missing is a single ignored error from exec.

package notifications

import (
	"fmt"
	"os/exec"
	"sync"
)

// NewSoundPlayerForPlatform returns the macOS SoundPlayer.
// Defined here (not in a separate dispatch file) so the
// build tag constrains the function to darwin only —
// Linux / Windows / fallback builds have their own copy
// in sound_linux.go / sound_windows.go / sound_other.go.
func NewSoundPlayerForPlatform() SoundPlayer {
	return NewOsascriptSoundPlayer()
}

// osxSoundPath maps a SoundName to the system-shipped
// .aiff under /System/Library/Sounds. These paths exist on
// every supported macOS version and are read-only system
// files, so we don't try to bundle or download anything.
func osxSoundPath(name SoundName) string {
	switch name {
	case SoundChime:
		return "/System/Library/Sounds/Glass.aiff"
	case SoundWarn:
		return "/System/Library/Sounds/Sosumi.aiff"
	case SoundAlert:
		return "/System/Library/Sounds/Basso.aiff"
	case SoundNotify:
		return "/System/Library/Sounds/Pop.aiff"
	}
	return ""
}

// OsascriptSoundPlayer is the macOS-specific SoundPlayer
// implementation. Play spawns a one-shot osascript / afplay
// process. Errors from the OS tool are swallowed silently —
// audio failure should never bubble up to the TUI layer.
type OsascriptSoundPlayer struct {
	mu    sync.Mutex
	useOSAScript bool
}

func NewOsascriptSoundPlayer() *OsascriptSoundPlayer {
	// osascript is the universal entry point on every macOS
	// install. We could probe afplay too, but osascript gives
	// us a single fallback that works for any built-in sound
	// (and lets the user customize later via osascript hooks).
	_, err := exec.LookPath("osascript")
	return &OsascriptSoundPlayer{useOSAScript: err == nil}
}

func (p *OsascriptSoundPlayer) Play(name SoundName) error {
	if name == SoundNone {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	// osascript beep works for the alert sound without
	// touching the filesystem. For other sounds we try
	// afplay against the system .aiff first; if afplay is
	// missing we fall back to osascript beep.
	if p.useOSAScript {
		if name == SoundAlert {
			return runQuiet("osascript", "-e", "beep")
		}
		path := osxSoundPath(name)
		if path != "" {
			if _, err := exec.LookPath("afplay"); err == nil {
				return runQuiet("afplay", path)
			}
		}
		return runQuiet("osascript", "-e", "beep")
	}
	return fmt.Errorf("notifications: no audio backend available on darwin")
}

// runQuiet runs `name args...` and swallows the error. We
// deliberately don't surface audio failures — the operator
// should never see "afplay not found" interrupt a status
// toast.
func runQuiet(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		_ = out
		return err
	}
	return nil
}
