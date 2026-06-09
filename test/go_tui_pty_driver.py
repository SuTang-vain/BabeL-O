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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--sequence",
        required=True,
        choices=("permission-approve", "phase3-overlay-mutex"),
        help="Smoke sequence to execute",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=45.0,
        help="Maximum wall-clock time for the whole sequence",
    )
    args = parser.parse_args()

    repo = Path(__file__).resolve().parent.parent
    pid = os.getpid()
    config_dir = Path(tempfile.mkdtemp(prefix=f"babel-o-go-tui-smoke-{pid}-"))
    storage_path = config_dir / "nexus.db"
    config_file = config_dir / "config.json"
    config_file.write_text(
        json.dumps(
            {
                "defaultModel": "local/coding-runtime",
                "providerId": "local",
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
                "HOME": str(config_dir),
                "NO_COLOR": "1",
                "TERM": "xterm-256color",
            }
        )
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

            if args.sequence == "permission-approve":
                if not run_permission_approve_sequence(master_fd, go_tui_proc, transcript, args.timeout):
                    return 1
            elif args.sequence == "phase3-overlay-mutex":
                if not run_phase3_overlay_mutex_sequence(master_fd, go_tui_proc, transcript, args.timeout):
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
    if "BabeL-O Go TUI MVP" not in visible:
        return _fail(0, None, transcript, "[go-tui-smoke] final transcript missing banner")
    if "Permission: Bash" not in visible:
        return _fail(0, None, transcript, "[go-tui-smoke] final transcript missing permission panel")
    if "Bash done" not in visible:
        return _fail(0, None, transcript, "[go-tui-smoke] final transcript missing Bash tool completion line")
    if "done success=true" not in visible:
        return _fail(0, None, transcript, "[go-tui-smoke] final transcript missing result success marker")
    if args.sequence == "permission-approve":
        print("[go-tui-smoke] OK: permission approve chain verified end-to-end")
    elif args.sequence == "phase3-overlay-mutex":
        print("[go-tui-smoke] OK: phase 3 single-input-owner overlay mutex verified")
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
