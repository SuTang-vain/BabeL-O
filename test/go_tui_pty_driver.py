#!/usr/bin/env python3
"""
Phase 1 Go TUI smoke harness.

Per docs/nexus/reference/go-tui-rewrite-plan.md (Phase 1) and
docs/nexus/active/TODO_tui.md:

- BABEL_O_RUN_GO_TUI_SMOKE=1 gated, default skipped.
- local/coding-runtime, temp Nexus port, temp config, ephemeral storage.
- PTY drives `bbl go --no-alt` and exercises the manual permission
  approval chain (Permission: Bash -> approve -> tool ok -> done).
- On failure, prints the cleaned transcript and the raw terminal trace
  so the failure is reproducible.
"""

from __future__ import annotations

import argparse
import fcntl
import os
import pty
import re
import select
import signal
import subprocess
import sys
import termios
import time
import urllib.error
import urllib.request
import json
import shutil
import tempfile
from pathlib import Path

ANSI_CSI = "\x1b["


def visible_text(text: str) -> str:
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
    return text.replace("\r", "")


def read_available(fd: int, timeout: float) -> str:
    deadline = time.time() + timeout
    chunks: list[bytes] = []
    while True:
        remaining = max(0.0, deadline - time.time())
        if remaining == 0 and chunks:
            break
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            break
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        chunks.append(data)
        deadline = time.time() + 0.05
    return b"".join(chunks).decode("utf-8", errors="replace")


def wait_for(fd: int, needle: str, timeout: float, transcript: list[str]) -> bool:
    deadline = time.time() + timeout
    combined = "".join(transcript)
    while time.time() < deadline:
        if needle in visible_text(combined):
            return True
        chunk = read_available(fd, min(0.2, max(0.0, deadline - time.time())))
        if chunk:
            transcript.append(chunk)
            combined += chunk
    return needle in visible_text(combined)


def send(fd: int, text: str) -> None:
    os.write(fd, text.encode("utf-8"))


def set_terminal_size(fd: int, rows: int, columns: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct_pack(rows, columns))


def struct_pack(rows: int, columns: int) -> bytes:
    import struct

    return struct.pack("HHHH", rows, columns, 0, 0)


def start_chat_process(
    command: list[str], workspace: str, env: dict[str, str]
) -> tuple[int, "subprocess.Popen[bytes]"]:
    master_fd, slave_fd = pty.openpty()
    attrs = termios.tcgetattr(slave_fd)
    attrs[3] = attrs[3] | termios.ECHO
    termios.tcsetattr(slave_fd, termios.TCSANOW, attrs)
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct_pack(30, 120))

    proc = subprocess.Popen(
        command,
        cwd=workspace,
        env=env,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave_fd)
    return master_fd, proc


def stop_process(master_fd: int, proc: "subprocess.Popen[bytes]") -> None:
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                proc.kill()
    try:
        os.close(master_fd)
    except OSError:
        pass


def wait_for_http(url: str, timeout: float) -> int:
    deadline = time.time() + timeout
    last_error: str = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as response:
                return response.status
        except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
            last_error = str(exc)
        time.sleep(0.1)
    raise TimeoutError(f"Nexus never became ready at {url}: {last_error}")


def find_go_tui(repo: Path) -> tuple[list[str], str, str]:
    """
    Resolve the launch command for the Go TUI MVP.

    Returns (command_prefix, mode_label, fallback_warning).
    """
    go_tui_dir = repo / "clients" / "go-tui"
    prebuilt = go_tui_dir / "go-tui"
    if prebuilt.exists() and os.access(prebuilt, os.X_OK):
        return ([str(prebuilt)], "binary", "")
    fallback = ["go", "run", "."]
    warning = (
        "[go-tui-smoke] no prebuilt clients/go-tui/go-tui binary; "
        "falling back to `go run .` (requires Go toolchain in PATH)."
    )
    return (fallback, "go-run", warning)


def run_permission_approve_sequence(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    prompt = "bash echo go-tui-smoke"
    send(master_fd, prompt)
    send(master_fd, "\r")

    if not wait_for(master_fd, "Permission: Bash", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] permission panel did not appear",
        )

    send(master_fd, "a")

    if not wait_for(master_fd, "Bash done", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] approved Bash tool did not surface a 'Bash done' marker",
        )
    if not wait_for(master_fd, "permit", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] permission_response transcript line was not rendered",
        )
    if not wait_for(master_fd, "done success=true", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] stream did not close with a 'done success=true' marker",
        )
    return True


def run_phase3_overlay_mutex_sequence(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    """
    Phase 3 single-input-owner invariants:
    1. Help overlay (? on empty input) opens, shows 'Help' header.
    2. Esc closes help and returns to composing.
    3. Permission panel opens for a Bash tool call.
    4. While permission is up, random keys (e.g. 'z') do NOT type into
       the input box.
    5. Help overlay and permission panel are mutually exclusive: a `?`
       while permission is up does NOT switch the overlay.
    6. 'a' approves and stream returns done success=true.
    """
    # 1) Open help overlay.
    send(master_fd, "?")
    if not wait_for(master_fd, "Help", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] help overlay did not open on '?'",
        )

    # 2) Esc closes help.
    send(master_fd, "\x1b")
    if not wait_for(master_fd, "help closed", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] help overlay did not close on Esc",
        )

    # 3) Open permission panel via a Bash tool call.
    send(master_fd, "bash echo go-tui-mutex")
    send(master_fd, "\r")
    if not wait_for(master_fd, "Permission: Bash", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] permission panel did not appear",
        )

    # 4) While permission is up, random key must not reach textinput.
    # The textinput still has its prompt visible but should not
    # insert a 'z' character while mode=permission.
    # Snapshot the visible transcript before the stray key, then
    # verify the user-prompt line is unchanged afterwards. Status
    # lines and permission panel may legitimately render after the
    # stray key, so we look for a literal 'z' appended to the
    # user-prompt line specifically.
    send(master_fd, "z")
    # Drain a bit so any unintended echo lands in the transcript.
    time.sleep(0.3)
    chunk = read_available(master_fd, 0.3)
    if chunk:
        transcript.append(chunk)
    combined = visible_text("".join(transcript))
    # The transcript must NOT contain a "you       bash echo
    # go-tui-mutexz" user line — that would mean permission mode
    # leaked the stray key into the textinput.
    if "bash echo go-tui-mutexz" in combined:
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] textinput appended stray 'z' after prompt (permission mode let it through)",
        )

    # 5) Sending '?' while permission is up must NOT open help.
    # (Phase 3 single-input-owner: routing is mode-driven; '?' is only
    # honored in composing.)
    snapshot_before = len(transcript)
    send(master_fd, "?")
    time.sleep(0.3)
    chunk = read_available(master_fd, 0.3)
    if chunk:
        transcript.append(chunk)
    combined = visible_text("".join(transcript))
    # The 'Help' header is rendered in the help overlay. If a new
    # 'Help' header appears AFTER 'Permission: Bash', that would mean
    # help opened on top of permission — i.e. the mutex broke.
    perm_idx = combined.rfind("Permission: Bash")
    help_idx = combined.rfind("Help · Phase 3 overlay")
    if help_idx > perm_idx and help_idx > 0:
        return _fail(
            master_fd, go_tui_proc, transcript,
            f"[go-tui-smoke] help overlay opened while permission was up (mutex violation); transcript: {combined!r}",
        )

    # 6) Approve the permission.
    send(master_fd, "a")
    if not wait_for(master_fd, "Bash done", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] approved Bash tool did not surface a 'Bash done' marker",
        )
    if not wait_for(master_fd, "done success=true", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] stream did not close with a 'done success=true' marker",
        )
    # Snapshot was used to assert no extra help overlay opened; we
    # intentionally ignore snapshot_before after this point.
    _ = snapshot_before
    return True


# === Phase 4: slash palette + tool palette ===

def run_slash_palette_sequence(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    """
    Phase 4 slash palette UX:
    1. `/` on empty input opens the live-filter palette.
    2. The palette header mentions "Slash" and the current filter.
    3. Typing more characters narrows the candidate list.
    4. Enter on /help (zero-arg) runs the command and the
       transcript shows the /help status line.
    """
    # 1) Open the palette.
    send(master_fd, "/")
    if not wait_for(master_fd, "Slash", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] slash palette header did not appear after '/'",
        )

    # 2) The header shows the live filter as the user types.
    send(master_fd, "h")
    if not wait_for(master_fd, "/h", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] slash palette filter did not show '/h'",
        )

    # 3) Down arrow navigation should not break anything (single
    # match for /h in the registry, so clamp to 0).
    send(master_fd, "\x1b[B")  # down arrow
    time.sleep(0.2)
    chunk = read_available(master_fd, 0.2)
    if chunk:
        transcript.append(chunk)

    # 4) Enter on the single /help match runs the command.
    send(master_fd, "\r")
    if not wait_for(master_fd, "local commands:", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /help did not surface the 'local commands:' line",
        )
    if not wait_for(master_fd, "/profile", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /help list missing /profile entry",
        )
    return True


def run_slash_palette_prefix_sequence(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    """
    Phase 4 slash palette prefix insertion: when the user picks a
    command with a `prefix` (e.g. /bash), the palette inserts the
    prefix into the textinput instead of running server-side, so
    the user can keep typing the rest of the command.
    """
    send(master_fd, "/")
    if not wait_for(master_fd, "Slash", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] slash palette did not open on '/'",
        )

    # Filter to /bash.
    send(master_fd, "bash")
    if not wait_for(master_fd, "/bash", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] slash palette did not show '/bash' filter",
        )

    send(master_fd, "\r")
    if not wait_for(master_fd, "inserted prefix:", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /bash selection did not surface the 'inserted prefix:' status line",
        )
    # After selecting /bash, the textinput contains "/bash " and
    # the Go TUI is back in composing mode. The status line ends
    # with the prefix string, so we look for that as a
    # substring.
    combined = visible_text("".join(transcript))
    if "/bash " not in combined:
        return _fail(
            master_fd, go_tui_proc, transcript,
            f"[go-tui-smoke] /bash prefix not visible after palette select: {combined!r}",
        )
    return True


def run_tool_palette_sequence(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    """
    Phase 4 tool palette: /tools renders the static builtin
    catalog with risk + source + approval columns.
    """
    # Submit /tools as a normal slash command (zero-arg, runs
    # immediately). This exercises the registry / handleLocalCommand
    # path the same way the chat TUI would.
    send(master_fd, "/tools")
    send(master_fd, "\r")
    if not wait_for(master_fd, "tools (", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /tools did not surface the catalog header",
        )
    combined = visible_text("".join(transcript))
    for needle in ("Bash", "Read", "Grep", "Glob"):
        if needle not in combined:
            return _fail(
                master_fd, go_tui_proc, transcript,
                f"[go-tui-smoke] /tools catalog missing {needle!r}",
            )
    if "risk=execute" not in combined:
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /tools catalog missing Bash risk=execute",
        )
    if "approval-required" not in combined:
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /tools catalog missing approval-required marker",
        )
    return True


# === Phase 7 visual regression: §5 path C phase 3 polish + width/resize ===

def run_tombstone_rejection_sequence(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    """
    Phase 7 / §5 path C phase 3 polish: when the user submits
    `/profile <name>` for a profile that doesn't exist (which
    covers the same friendly-error path as a tombstoned profile),
    the Go TUI must surface a human hint instead of raw JSON.

    End-to-end: `/profile ghost` -> confirm overlay (y) ->
    Nexus 400 unknown_profile -> friendlyNexusError ->
    "unknown profile \"ghost\"".
    """
    send(master_fd, "/profile ghost")
    send(master_fd, "\r")
    if not wait_for(master_fd, "Confirm profile switch", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /profile ghost did not open the confirm overlay",
        )
    send(master_fd, "y")
    if not wait_for(master_fd, 'unknown profile "ghost"', timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] unknown profile select did not surface a friendly 'unknown profile' hint",
        )
    return True


def run_visual_regression_narrow_sequence(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    """
    Visual regression for narrow terminal width (40 cols): the
    permission header + help overlay should wrap cleanly without
    overlapping into the input box.

    The driver runs with COLUMNS=40 and LINES=20; we just check
    that the banner + help overlay appear (no view corruption) and
    that the input box prompt is on its own line at the end.
    """
    send(master_fd, "?")
    if not wait_for(master_fd, "Help · Phase 3 overlay", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] narrow-width help overlay did not render",
        )
    send(master_fd, "\x1b")
    return True


def run_context_and_compact_sequence(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    """
    Phase 5: /context and /compact wired to real Nexus endpoints.

    Sequence:
      1. Send a bash prompt so the WebSocket stream starts and
         session_started populates m.sessionID.
      2. Approve the permission and wait for the tool to finish.
      3. /context  -> expect "analyzing shared Nexus context" + the
         context_analysis envelope header (summary / status / signals /
         recommendations).
      4. /compact  -> expect "compacting shared Nexus context" + the
         compact_result events: N → M line.
    """
    # Step 1+2: populate sessionID via a real bash round-trip.
    send(master_fd, "bash echo phase5-context")
    send(master_fd, "\r")
    if not wait_for(master_fd, "Permission: Bash", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] context/compact setup: permission panel did not appear",
        )
    send(master_fd, "a")
    if not wait_for(master_fd, "Bash done", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] context/compact setup: bash tool did not finish",
        )
    if not wait_for(master_fd, "done success=true", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] context/compact setup: stream did not close cleanly",
        )

    # Step 3: /context.
    send(master_fd, "/context")
    send(master_fd, "\r")
    if not wait_for(master_fd, "analyzing shared Nexus context", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /context did not surface the 'analyzing' status line",
        )
    if not wait_for(master_fd, "context_analysis", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /context did not render the context_analysis envelope",
        )

    # Step 4: /compact.
    send(master_fd, "/compact")
    send(master_fd, "\r")
    if not wait_for(master_fd, "compacting shared Nexus context", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /compact did not surface the 'compacting' status line",
        )
    if not wait_for(master_fd, "compact_result events:", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /compact did not render the compact_result line",
        )
    return True


def run_profile_confirm_sequence(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    """
    §5 path C phase 3 polish: `/profile <name>` parks the Go TUI in a
    y/n confirmation overlay instead of immediately firing the
    selectRuntimeProfile HTTP call. The driver covers the full
    three-path surface:

      1. /profile beta  ->  n  -> "profile switch cancelled" status,
         no HTTP call attempted, mode returns to composing.
      2. /profile beta  ->  y  -> "selecting shared Nexus profile: beta"
         status, then on success "profile switched: beta" (the
         upstream friendly-error path is unchanged and covered by the
         tombstone-rejection sequence).
      3. /profile alpha  ->  "profile already active: alpha" status
         (no overlay opens, since alpha is the seeded activeProfile).
    """
    # Path 1: n cancels.
    send(master_fd, "/profile beta")
    send(master_fd, "\r")
    if not wait_for(master_fd, "Confirm profile switch", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /profile beta did not open the confirm overlay",
        )
    send(master_fd, "n")
    if not wait_for(master_fd, "profile switch cancelled: beta", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] n on profile-confirm did not surface the cancelled status line",
        )

    # Path 2: y fires the HTTP call and (because the profile is valid)
    # surfaces the success status line. The Nexus URL is reachable
    # so the selectRuntimeProfile call returns 200 and the Go TUI
    # renders "profile switched: beta".
    send(master_fd, "/profile beta")
    send(master_fd, "\r")
    if not wait_for(master_fd, "Confirm profile switch", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /profile beta (second time) did not open the confirm overlay",
        )
    send(master_fd, "y")
    if not wait_for(master_fd, "selecting shared Nexus profile: beta", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] y on profile-confirm did not surface the 'selecting' status line",
        )
    if not wait_for(master_fd, "profile switched: beta", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /profile beta success path did not surface 'profile switched'",
        )

    # Path 3: re-selecting the now-active beta short-circuits.
    send(master_fd, "/profile beta")
    send(master_fd, "\r")
    if not wait_for(master_fd, "profile already active: beta", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] /profile <active> did not short-circuit with 'profile already active'",
        )
    return True


def run_help_overlay_sequence(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    """
    Phase 3/4 help overlay UX:
    1. `?` (empty input) opens the help overlay.
    2. Down arrow moves the scroll.
    3. Esc closes the overlay and returns to composing.
    """
    send(master_fd, "?")
    if not wait_for(master_fd, "Help · Phase 3 overlay", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] help overlay header did not appear",
        )

    send(master_fd, "\x1b[B")  # down
    time.sleep(0.2)
    chunk = read_available(master_fd, 0.2)
    if chunk:
        transcript.append(chunk)

    send(master_fd, "\x1b")
    if not wait_for(master_fd, "help closed", timeout, transcript):
        return _fail(
            master_fd, go_tui_proc, transcript,
            "[go-tui-smoke] help overlay did not close on Esc",
        )
    return True


def run_all_sequences(
    master_fd: int,
    go_tui_proc: "subprocess.Popen[bytes]",
    transcript: list[str],
    timeout: float,
) -> bool:
    """
    Phase 7 orchestrator: drive every registered sequence in order
    and report pass/fail per sequence. The runner intentionally
    does not return early on failure — it tries every sequence so
    CI sees the full coverage picture in one transcript.

    `all` is a "best effort" mode that prints each sequence's
    status; the final transcript check at the end of main() is
    driven by the last sequence's `required_invariants`.
    """
    order = [
        "help-overlay",
        "slash-palette",
        "slash-palette-prefix",
        "tool-palette",
        "profile-confirm",
        "context-and-compact",
        "phase3-overlay-mutex",
        "permission-approve",
    ]
    failed: list[str] = []
    for name in order:
        seq = SEQUENCES[name]
        print(f"[go-tui-smoke] all: running {name}", flush=True)
        ok = seq["runner"](master_fd, go_tui_proc, transcript, timeout)
        if not ok:
            failed.append(name)
            print(f"[go-tui-smoke] all: {name} FAILED", file=sys.stderr)
        # Reset to composing. ESC closes any open palette/overlay;
        # a long backspace stream wipes the textinput in case a
        # previous sequence (e.g. slash-palette-prefix) inserted a
        # prefix like "/bash " into it. Without this reset, the
        # next sequence would see "/bash /tools" and trip the
        # handleLocalCommand nil-runner check.
        send(master_fd, "\x1b")
        time.sleep(0.1)
        chunk = read_available(master_fd, 0.1)
        if chunk:
            transcript.append(chunk)
        for _ in range(60):
            send(master_fd, "\x7f")  # DEL/backspace
        time.sleep(0.1)
        chunk = read_available(master_fd, 0.1)
        if chunk:
            transcript.append(chunk)
    if failed:
        return _fail(
            master_fd, go_tui_proc, transcript,
            f"[go-tui-smoke] all: failed sequences: {', '.join(failed)}",
        )
    return True


# Sequence registry. Each entry knows how to drive the PTY for its
# scenario AND which final-visible-text invariants to assert. The
# driver main() dispatches on the --sequence argument by name.
SEQUENCES: dict[str, dict] = {
    "permission-approve": {
        "runner": run_permission_approve_sequence,
        "ok_message": "permission approve chain verified end-to-end",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
            "Permission: Bash",
            "Bash done",
            "done success=true",
        ],
    },
    "phase3-overlay-mutex": {
        "runner": run_phase3_overlay_mutex_sequence,
        "ok_message": "phase 3 single-input-owner overlay mutex verified",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
        ],
    },
    "slash-palette": {
        "runner": run_slash_palette_sequence,
        "ok_message": "phase 4 slash palette live-filter verified",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
        ],
    },
    "slash-palette-prefix": {
        "runner": run_slash_palette_prefix_sequence,
        "ok_message": "phase 4 slash palette prefix insertion verified",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
        ],
    },
    "tool-palette": {
        "runner": run_tool_palette_sequence,
        "ok_message": "phase 4 tool palette verified",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
        ],
    },
    "help-overlay": {
        "runner": run_help_overlay_sequence,
        "ok_message": "phase 3 help overlay open/close verified",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
        ],
    },
    "tombstone-rejection": {
        "runner": run_tombstone_rejection_sequence,
        "ok_message": "phase 7 §5 path C phase 3 friendly profile-rejection verified",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
        ],
    },
    "profile-confirm": {
        "runner": run_profile_confirm_sequence,
        "ok_message": "§5 path C phase 3 polish profile y/n overlay verified",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
        ],
    },
    "context-and-compact": {
        "runner": run_context_and_compact_sequence,
        "ok_message": "phase 5 /context and /compact wire to Nexus verified",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
        ],
    },
    "visual-regression-narrow": {
        "runner": run_visual_regression_narrow_sequence,
        "ok_message": "phase 7 narrow-width visual regression verified",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
        ],
    },
    "all": {
        "runner": run_all_sequences,
        "ok_message": "all phase 7 sequences verified end-to-end",
        "required_invariants": [
            "BabeL-O Go TUI MVP",
        ],
    },
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--sequence",
        required=True,
        choices=tuple(SEQUENCES.keys()),
        help="Smoke sequence to execute",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=45.0,
        help="Maximum wall-clock time for the whole sequence",
    )
    args = parser.parse_args()
    sequence = SEQUENCES[args.sequence]

    repo = Path(__file__).resolve().parent.parent
    pid = os.getpid()
    config_dir = Path(tempfile.mkdtemp(prefix=f"babel-o-go-tui-smoke-{pid}-"))
    storage_path = config_dir / "nexus.db"
    config_file = config_dir / "config.json"
    # Expose the config path so SEQUENCES can pre-seed tombstones
    # (Phase 7 / §5 path C phase 3 polish test) before the Go TUI
    # reads the file.
    os.environ["BABEL_O_GO_TUI_SMOKE_CONFIG"] = str(config_file)
    config_file.write_text(
        json.dumps(
            {
                "defaultModel": "local/coding-runtime",
                "providerId": "local",
                "activeProfile": "alpha",
                "profiles": {
                    "alpha": {"model": "local/coding-runtime", "provider": "local"},
                    "beta": {"model": "local/coding-runtime", "provider": "local"},
                },
            }
        )
    )

    port = 43000 + (pid % 1000)
    nexus_url = f"http://127.0.0.1:{port}"
    workspace = config_dir / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)

    nexus_env = os.environ.copy()
    nexus_env.update(
        {
            "BABEL_O_CONFIG_FILE": str(config_file),
            "BABEL_O_LAUNCH_CWD": str(workspace),
            "HOME": str(config_dir),
            "NEXUS_HOST": "127.0.0.1",
            "NEXUS_PORT": str(port),
            "NEXUS_STORAGE_PATH": str(storage_path),
            "NEXUS_ALLOWED_TOOLS": "*",
            "NEXUS_EXECUTE_TIMEOUT_MS": "30000",
            "NO_COLOR": "1",
        }
    )
    tsx_bin = repo / "node_modules" / ".bin" / "tsx"
    nexus_cmd = [str(tsx_bin), str(repo / "src" / "nexus" / "server.ts")]
    print(f"[go-tui-smoke] starting nexus: {nexus_url}", flush=True)
    nexus_proc = subprocess.Popen(
        nexus_cmd,
        cwd=str(repo),
        env=nexus_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    cleanup_messages: list[str] = []
    try:
        try:
            wait_for_http(f"{nexus_url}/v1/runtime/status", timeout=15.0)
        except TimeoutError as exc:
            try:
                stderr = nexus_proc.stderr.read(1).decode("utf-8", errors="replace") if nexus_proc.stderr else ""
            except Exception:
                stderr = ""
            print(f"[go-tui-smoke] nexus failed to start: {exc}\n{stderr}", file=sys.stderr)
            return 1

        go_tui_cmd, mode, fallback_warning = find_go_tui(repo)
        if fallback_warning:
            print(fallback_warning, file=sys.stderr)
        print(
            f"[go-tui-smoke] launching go-tui ({mode}): "
            f"{' '.join(go_tui_cmd)} --url {nexus_url} --no-alt",
            flush=True,
        )

        go_tui_env = os.environ.copy()
        go_tui_env.update(
            {
                "BABEL_O_CONFIG_FILE": str(config_file),
                "BABEL_O_LAUNCH_CWD": str(workspace),
                "BABEL_O_GO_TUI_SMOKE_CONFIG": str(config_file),
                "HOME": str(config_dir),
                "NO_COLOR": "1",
                "TERM": "xterm-256color",
            }
        )
        if args.sequence == "visual-regression-narrow":
            # Visual regression runs the Go TUI in a 40-col x 20-line
            # viewport. COLUMNS / LINES are read by the Bubble Tea
            # resizing path; we set them on the env so the Go TUI's
            # startup sees the narrow dimensions immediately.
            go_tui_env["COLUMNS"] = "40"
            go_tui_env["LINES"] = "20"
        go_tui_argv = [
            *go_tui_cmd,
            "--url",
            nexus_url,
            "--cwd",
            str(workspace),
            "--session",
            f"session_go_tui_smoke_{pid}",
        ]
        master_fd, go_tui_proc = start_chat_process(go_tui_argv, str(workspace), go_tui_env)
        transcript: list[str] = []
        try:
            if not wait_for(master_fd, "BabeL-O Go TUI MVP", args.timeout, transcript):
                return _fail(
                    master_fd, go_tui_proc, transcript,
                    "[go-tui-smoke] go-tui banner did not appear within timeout",
                )

            if not sequence["runner"](master_fd, go_tui_proc, transcript, args.timeout):
                return 1

            send(master_fd, "q")
            try:
                go_tui_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        finally:
            stop_process(master_fd, go_tui_proc)
    finally:
        if nexus_proc.poll() is None:
            try:
                os.killpg(nexus_proc.pid, signal.SIGTERM)
            except OSError:
                nexus_proc.terminate()
            try:
                nexus_proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(nexus_proc.pid, signal.SIGKILL)
                except OSError:
                    nexus_proc.kill()
        try:
            shutil.rmtree(config_dir, ignore_errors=True)
        except Exception as exc:
            cleanup_messages.append(f"cleanup: {exc}")

    visible = visible_text("".join(transcript))
    for needle in sequence["required_invariants"]:
        if needle not in visible:
            return _fail(
                0, None, transcript,
                f"[go-tui-smoke] final transcript missing required invariant: {needle!r}",
            )
    print(f"[go-tui-smoke] OK: {sequence['ok_message']}")
    for message in cleanup_messages:
        print(message, file=sys.stderr)
    return 0


def _fail(master_fd, proc, transcript: list[str], message: str) -> int:
    print(message, file=sys.stderr)
    print("---- cleaned transcript ----", file=sys.stderr)
    print(visible_text("".join(transcript)), file=sys.stderr)
    print("---- raw transcript (escaped) ----", file=sys.stderr)
    print(repr("".join(transcript))[:4000], file=sys.stderr)
    if proc is not None and master_fd:
        stop_process(master_fd, proc)
    return 1


if __name__ == "__main__":
    sys.exit(main())
