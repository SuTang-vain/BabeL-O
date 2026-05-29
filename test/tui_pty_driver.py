#!/usr/bin/env python3
import argparse
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time
import tty

ANSI_CSI = '\x1b['


def visible_text(text: str) -> str:
    import re
    text = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', text)
    return text.replace('\r', '')


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
    return b''.join(chunks).decode('utf-8', errors='replace')


def wait_for(fd: int, needle: str, timeout: float, transcript: list[str]) -> bool:
    deadline = time.time() + timeout
    combined = ''.join(transcript)
    while time.time() < deadline:
        if needle in visible_text(combined):
            return True
        chunk = read_available(fd, min(0.2, max(0.0, deadline - time.time())))
        if chunk:
            transcript.append(chunk)
            combined += chunk
    return needle in visible_text(combined)


def send(fd: int, text: str) -> None:
    os.write(fd, text.encode('utf-8'))


def run_chat_smoke(sequence: str, timeout: float) -> tuple[int, str]:
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    config_dir = os.path.join('/tmp', f'babel-o-pty-{os.getpid()}')
    os.makedirs(config_dir, exist_ok=True)
    config_file = os.path.join(config_dir, 'config.json')
    with open(config_file, 'w', encoding='utf-8') as fh:
        fh.write('{"defaultModel":"local/coding-runtime"}\n')

    env = os.environ.copy()
    env.update({
        'BABEL_O_CONFIG_FILE': config_file,
        'BABEL_O_LAUNCH_CWD': repo,
        'NO_COLOR': '1',
        'TERM': 'xterm-256color',
        'COLUMNS': '100',
        'LINES': '30',
    })

    master_fd, slave_fd = pty.openpty()
    attrs = termios.tcgetattr(slave_fd)
    attrs[3] = attrs[3] | termios.ECHO
    termios.tcsetattr(slave_fd, termios.TCSANOW, attrs)

    command = [
        os.path.join(repo, 'node_modules', '.bin', 'tsx'),
        os.path.join(repo, 'src', 'cli', 'program.ts'),
        'chat',
        '--cwd',
        repo,
    ]
    proc = subprocess.Popen(
        command,
        cwd=repo,
        env=env,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave_fd)
    transcript: list[str] = []

    try:
        if not wait_for(master_fd, 'BabeL-O', timeout, transcript):
            return 1, ''.join(transcript) + '\n[pty-smoke] prompt did not appear\n'

        if sequence == 'slash-palette':
            send(master_fd, '/')
            if not wait_for(master_fd, 'Insert bash prompt prefix', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] slash palette did not render\n'
            send(master_fd, '\x1b')
            time.sleep(0.1)
            send(master_fd, '/exit\r')
        elif sequence == 'permission-reject-escape':
            send(master_fd, 'bash node -v\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] permission panel did not render\n'
            send(master_fd, '\x1b')
            if not wait_for(master_fd, 'Permission denied', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] escape did not reject permission\n'
            if 'Permission approved' in visible_text(''.join(transcript)):
                return 1, ''.join(transcript) + '\n[pty-smoke] escape approved unexpectedly\n'
            send(master_fd, '/exit\r')
        elif sequence == 'permission-reject-backspace':
            send(master_fd, 'bash node -v\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] permission panel did not render\n'
            send(master_fd, '\x7f')
            if not wait_for(master_fd, 'Permission denied', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] backspace did not reject permission\n'
            if 'Permission approved' in visible_text(''.join(transcript)):
                return 1, ''.join(transcript) + '\n[pty-smoke] backspace approved unexpectedly\n'
            send(master_fd, '/exit\r')
        elif sequence == 'permission-approve-once':
            send(master_fd, 'bash node -v\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] permission panel did not render\n'
            send(master_fd, '1')
            if not wait_for(master_fd, 'Permission approved', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] numeric approve once did not approve\n'
            if not wait_for(master_fd, 'Bash node -v done', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] approved command did not complete\n'
            send(master_fd, '/exit\r')
        elif sequence == 'permission-approve-session':
            send(master_fd, 'bash node -v\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] permission panel did not render\n'
            send(master_fd, '2')
            if not wait_for(master_fd, 'Bash node -v done', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] session approval command did not complete\n'
            send(master_fd, 'bash node -p 1\r')
            if not wait_for(master_fd, 'Bash node -p 1 done', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] session approval cache did not complete second command\n'
            if visible_text(''.join(transcript)).count('Bash is requesting approval') != 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] session approval did not cache permission\n'
            send(master_fd, '/exit\r')
        elif sequence == 'permission-editable-rule':
            send(master_fd, 'bash node -v\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] permission panel did not render\n'
            send(master_fd, '3')
            if not wait_for(master_fd, 'Enter allow rule prefix', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] editable rule prompt did not render\n'
            send(master_fd, 'node:*\r')
            if not wait_for(master_fd, 'Bash node -v done', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] editable rule approval did not complete command\n'
            send(master_fd, '/exit\r')
        elif sequence == 'permission-reject-instruction':
            send(master_fd, 'bash node -v\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] permission panel did not render\n'
            send(master_fd, '5')
            if not wait_for(master_fd, 'Tell the model what to do instead', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] reject instruction prompt did not render\n'
            send(master_fd, 'Use Read instead\r')
            if not wait_for(master_fd, 'Permission denied: Use Read instead', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] reject instruction reason did not render\n'
            send(master_fd, '/exit\r')
        elif sequence == 'tool-rendering-read':
            send(master_fd, 'read package.json\r')
            if not wait_for(master_fd, 'Read package.json done', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] read tool did not render compact completion\n'
            visible = visible_text(''.join(transcript))
            if 'maxBytes' in visible or 'running' in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] compact tool row leaked raw parameters/state\n'
            send(master_fd, '/exit\r')
        else:
            return 1, f'Unknown sequence: {sequence}\n'

        wait_for(master_fd, 'Exiting chat', 0.5, transcript)
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.terminate()
            proc.wait(timeout=3)
        transcript.append(read_available(master_fd, 0.1))
        return 0 if proc.returncode == 0 else proc.returncode, ''.join(transcript)
    finally:
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--sequence', required=True)
    parser.add_argument('--timeout', type=float, default=8.0)
    args = parser.parse_args()
    code, transcript = run_chat_smoke(args.sequence, args.timeout)
    sys.stdout.write(transcript)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
