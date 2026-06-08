#!/usr/bin/env python3
import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
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


def screen_text(text: str) -> str:
    text = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', text)
    lines = ['']
    row = 0
    col = 0
    saved_row = 0
    saved_col = 0
    index = 0
    while index < len(text):
        char = text[index]
        if char == '\x1b' and text.startswith('[', index + 1):
            match = re.match(r'\x1b\[([0-9;?]*)([ -/]*)([@-~])', text[index:])
            if match:
                params = match.group(1)
                command = match.group(3)
                numbers = [int(part) for part in params.replace('?', '').split(';') if part.isdigit()]
                count = numbers[0] if numbers else 1
                if command == 'A':
                    row = max(0, row - count)
                    col = min(col, len(lines[row]))
                elif command == 'B':
                    row += count
                    while row >= len(lines):
                        lines.append('')
                    col = min(col, len(lines[row]))
                elif command == 'C':
                    col += count
                elif command == 'D':
                    col = max(0, col - count)
                elif command == 'G':
                    col = max(0, count - 1)
                elif command == 'K':
                    if row >= len(lines):
                        lines.append('')
                    lines[row] = lines[row][:col]
                elif command == 'J':
                    if row >= len(lines):
                        lines.append('')
                    lines[row] = lines[row][:col]
                    del lines[row + 1:]
                elif command == 's':
                    saved_row = row
                    saved_col = col
                elif command == 'u':
                    row = max(0, saved_row)
                    while row >= len(lines):
                        lines.append('')
                    col = min(saved_col, len(lines[row]))
                index += len(match.group(0))
                continue
        if char == '\r':
            col = 0
        elif char == '\n':
            row += 1
            while row >= len(lines):
                lines.append('')
            col = 0
        else:
            while row >= len(lines):
                lines.append('')
            line = lines[row]
            if col > len(line):
                line = line + (' ' * (col - len(line)))
            lines[row] = line[:col] + char + line[col + 1:]
            col += 1
        index += 1
    return '\n'.join(lines)


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


def wait_for_count(fd: int, needle: str, count: int, timeout: float, transcript: list[str]) -> bool:
    deadline = time.time() + timeout
    combined = ''.join(transcript)
    while time.time() < deadline:
        if visible_text(combined).count(needle) >= count:
            return True
        chunk = read_available(fd, min(0.2, max(0.0, deadline - time.time())))
        if chunk:
            transcript.append(chunk)
            combined += chunk
    return visible_text(combined).count(needle) >= count


def send(fd: int, text: str) -> None:
    os.write(fd, text.encode('utf-8'))


def assert_single_slash_palette_preview(screen: str):
    lines = screen.split('\n')
    preview_lines = [line for line in lines if re.match(r'^> /[A-Za-z-]*$', line)]
    if len(preview_lines) != 1:
        return 'slash palette left stale preview rows while navigating'
    separator_lines = [line for line in lines if re.fullmatch(r'─{10,}', line)]
    if len(separator_lines) > 2:
        return 'slash palette left stale border rows while navigating'
    return None


def prepare_programming_workspace(config_dir: str) -> str:
    workspace = os.path.join(config_dir, 'workspace')
    os.makedirs(os.path.join(workspace, 'src'), exist_ok=True)
    with open(os.path.join(workspace, 'smoke.txt'), 'w', encoding='utf-8') as fh:
        fh.write('alpha beta\n')
    with open(os.path.join(workspace, 'question.txt'), 'w', encoding='utf-8') as fh:
        fh.write('answer-token: violet-river\n')
    with open(os.path.join(workspace, 'src', 'smoke.ts'), 'w', encoding='utf-8') as fh:
        fh.write('export const token = "beta"\n')
    try:
        subprocess.run(['git', 'init'], cwd=workspace, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except OSError:
        pass
    return workspace


def start_chat_process(command: list[str], workspace: str, env: dict[str, str]) -> tuple[int, subprocess.Popen]:
    master_fd, slave_fd = pty.openpty()
    attrs = termios.tcgetattr(slave_fd)
    attrs[3] = attrs[3] | termios.ECHO
    termios.tcsetattr(slave_fd, termios.TCSANOW, attrs)
    columns = int(env.get('COLUMNS', '100'))
    rows = int(env.get('LINES', '30'))
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))

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


def stop_chat_process(master_fd: int, proc: subprocess.Popen) -> None:
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


def run_chat_smoke(sequence: str, timeout: float) -> tuple[int, str]:
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    config_dir = os.path.join('/tmp', f'babel-o-pty-{os.getpid()}')
    os.makedirs(config_dir, exist_ok=True)
    config_file = os.path.join(config_dir, 'config.json')
    with open(config_file, 'w', encoding='utf-8') as fh:
        fh.write('{"defaultModel":"local/coding-runtime"}\n')

    workspace = prepare_programming_workspace(config_dir) if sequence in ('programming-workflow', 'resume-session', 'coding-question-files', 'task-update-status') else repo

    env = os.environ.copy()
    columns = '84' if sequence == 'slash-palette-narrow' else '100'
    env.update({
        'BABEL_O_CONFIG_FILE': config_file,
        'BABEL_O_LAUNCH_CWD': workspace,
        'HOME': config_dir,
        'NO_COLOR': '1',
        'TERM': 'xterm-256color',
        'COLUMNS': columns,
        'LINES': '30',
    })

    command_mode = os.environ.get('BABEL_O_PTY_COMMAND', 'source')
    if command_mode in ('installed', 'bbl'):
        base_command = [
            os.environ.get('BABEL_O_BBL_BIN', 'bbl'),
            'chat',
            '--cwd',
            workspace,
        ]
    else:
        base_command = [
            os.path.join(repo, 'node_modules', '.bin', 'tsx'),
            os.path.join(repo, 'src', 'cli', 'program.ts'),
            'chat',
            '--cwd',
            workspace,
        ]
    session_id = None
    command = [*base_command]
    if session_id:
        command.extend(['--session', session_id])
    master_fd, proc = start_chat_process(command, workspace, env)
    transcript: list[str] = []

    try:
        if not wait_for(master_fd, '? for shortcuts', timeout, transcript):
            return 1, ''.join(transcript) + '\n[pty-smoke] prompt did not appear\n'

        if sequence == 'idle-stays-open':
            time.sleep(1.0)
            if proc.poll() is not None:
                return proc.returncode or 0, ''.join(transcript) + '\n[pty-smoke] chat exited while idle\n'
            send(master_fd, '/exit\r')
        elif sequence == 'slash-palette':
            send(master_fd, '/')
            if not wait_for(master_fd, 'Insert bash prompt prefix', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] slash palette did not render\n'
            send(master_fd, '\x1b[B')
            send(master_fd, '\x1b[B')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            palette_screen = screen_text(''.join(transcript))
            residue = assert_single_slash_palette_preview(palette_screen)
            if residue:
                return 1, ''.join(transcript) + f'\n[pty-smoke] {residue}\n'
            send(master_fd, '\x1b')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            send(master_fd, '\x7f')
            time.sleep(0.05)
            send(master_fd, '/exit\r')
        elif sequence == 'slash-palette-narrow':
            send(master_fd, '/')
            if not wait_for(master_fd, 'Insert bash prompt prefix', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] narrow slash palette did not render\n'
            for _ in range(11):
                send(master_fd, '\x1b[B')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            palette_screen = screen_text(''.join(transcript))
            residue = assert_single_slash_palette_preview(palette_screen)
            if residue:
                return 1, ''.join(transcript) + f'\n[pty-smoke] narrow {residue}\n'
            if '> /grep' not in palette_screen:
                return 1, ''.join(transcript) + '\n[pty-smoke] narrow slash palette did not navigate to grep\n'
            lines = palette_screen.split('\n')
            up_index = next((index for index, line in enumerate(lines) if '↑' in line and 'more' in line), -1)
            command_index = next((index for index, line in enumerate(lines) if re.match(r'^(?:> |  )/[A-Za-z-]+\s{2,}\S', line)), -1)
            if up_index == -1 or command_index == -1 or up_index > command_index:
                return 1, ''.join(transcript) + '\n[pty-smoke] narrow slash palette placed upward indicator below command rows\n'
            send(master_fd, '\x1b')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            send(master_fd, '\x7f')
            time.sleep(0.05)
            send(master_fd, '/exit\r')
        elif sequence == 'unique-input-keyboard-routing':
            send(master_fd, '/')
            if not wait_for(master_fd, 'Insert bash prompt prefix', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] slash palette did not render for keyboard routing\n'
            send(master_fd, '\x1b[B')
            send(master_fd, '\x1b[A')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            palette_screen = screen_text(''.join(transcript))
            if palette_screen.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] slash palette rendered duplicate input shortcut rows\n'
            send(master_fd, '\x1b')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            after_escape = screen_text(''.join(transcript))
            if 'Navigate · tab' in after_escape or after_escape.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] slash palette did not close back to a single input box\n'
            send(master_fd, '\x7f')
            time.sleep(0.05)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)

            send(master_fd, '/')
            if not wait_for(master_fd, 'Insert bash prompt prefix', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] slash palette did not reopen for tab routing\n'
            send(master_fd, '\t')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            tab_screen = screen_text(''.join(transcript))
            if tab_screen.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] tab selection rendered duplicate input shortcut rows\n'
            send(master_fd, '\r')
            if not wait_for(master_fd, 'AgentLoop sub-agent TUI smoke completed', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] tab-selected slash command did not execute once\n'
            if visible_text(''.join(transcript)).count('AgentLoop sub-agent TUI smoke completed') != 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] tab-selected slash command executed more than once\n'

            long_prompt = '当前用户生产的作品可能会在实际上线后发现批量化的问题，然后这些批量存在的问题需要统一回收进行再修改后才能上线；我这边考量的是依据实际项目设计一个分层机制，审核发现批量化的问题后说明原因并提交驳回。'
            send(master_fd, long_prompt)
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            long_screen = screen_text(''.join(transcript))
            if long_prompt[:20] not in long_screen:
                return 1, ''.join(transcript) + '\n[pty-smoke] long input did not render in input box\n'
            if long_screen.count('? for shortcuts') != 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] long input rendered duplicate shortcut rows\n'
            send(master_fd, '\r')
            if not wait_for(master_fd, 'BabeL-O local runtime is active.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] long input did not submit cleanly\n'

            send(master_fd, 'bash node -v\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] permission panel did not render in keyboard routing\n'
            send(master_fd, '\x1b[B')
            send(master_fd, '\x1b[A')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            permission_screen = screen_text(''.join(transcript))
            if permission_screen.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] permission panel rendered duplicate input shortcut rows\n'
            send(master_fd, '\x7f')
            if not wait_for(master_fd, 'Permission denied', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] permission backspace did not route to panel reject\n'
            screen = screen_text(''.join(transcript))
            if 'Bash(node -v)' not in screen or 'Permission denied' not in screen:
                return 1, ''.join(transcript) + '\n[pty-smoke] permission panel final state missing denied tool row\n'
            if screen.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] keyboard routing final screen has duplicate input boxes\n'
            send(master_fd, '/exit\r')
        elif sequence == 'tool-model-overlay-routing':
            send(master_fd, '/tool\r')
            if not wait_for(master_fd, 'Read a file inside the workspace', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] tool palette did not render\n'
            send(master_fd, '\x1b[B')
            send(master_fd, '\x1b[A')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            tool_screen = screen_text(''.join(transcript))
            if tool_screen.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] tool palette rendered duplicate input shortcut rows\n'
            send(master_fd, '\x1b')
            time.sleep(0.2)
            chunk = read_available(master_fd, 0.3)
            if chunk:
                transcript.append(chunk)
            after_tool = screen_text(''.join(transcript))
            if 'Read a file inside the workspace' in after_tool or after_tool.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] tool palette did not close back to a single input owner\n'

            send(master_fd, '/model\r')
            if not wait_for(master_fd, 'Select provider:', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] model wizard provider picker did not render\n'
            send(master_fd, '\x1b[B')
            send(master_fd, '\x1b[A')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            model_screen = screen_text(''.join(transcript))
            if model_screen.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] model wizard rendered duplicate input shortcut rows\n'
            send(master_fd, '\x1b')
            if not wait_for(master_fd, 'Wizard cancelled.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] model wizard escape did not cancel cleanly\n'
            after_model = screen_text(''.join(transcript))
            if 'Select provider:' in after_model or after_model.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] model wizard did not close back to a single input owner\n'
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
            if not wait_for(master_fd, 'Bash completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] approved command did not complete\n'
            send(master_fd, '/exit\r')
        elif sequence == 'permission-approve-session':
            send(master_fd, 'bash node -v\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] permission panel did not render\n'
            send(master_fd, '2')
            if not wait_for(master_fd, 'Bash completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] session approval command did not complete\n'
            send(master_fd, 'bash node -p 1\r')
            if not wait_for_count(master_fd, 'Bash completed.', 2, timeout, transcript):
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
            if not wait_for(master_fd, 'Bash completed.', timeout, transcript):
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
            if not wait_for(master_fd, 'Read completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] read tool did not complete\n'
            visible = visible_text(''.join(transcript))
            if 'maxBytes' in visible or 'running' in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] compact tool row leaked raw parameters/state\n'
            send(master_fd, '/exit\r')
        elif sequence == 'bash-output-preview':
            send(master_fd, 'bash for i in 0 1 2 3 4; do echo line-$i; done\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] bash preview permission panel did not render\n'
            send(master_fd, '1')
            if not wait_for(master_fd, 'Bash completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] bash preview command did not complete\n'
            visible = visible_text(''.join(transcript))
            if 'Bash(for i in 0 1 2 3 4; do echo line-$i; done)' not in visible or '⎿  line-0' not in visible or '⎿  line-2' not in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] bash preview did not render first output lines\n'
            if '⎿  line-3' in visible or '⎿  line-4' in visible or '… +2 lines (ctrl+o to expand)' not in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] bash preview did not fold extra output lines\n'
            screen = screen_text(''.join(transcript))
            after_tool = screen.rsplit('Bash(for i in 0 1 2 3 4; do echo line-$i; done)', 1)[-1]
            if 'Generating...' in after_tool or 'Waiting for permission...' in after_tool or '◉' in after_tool:
                return 1, ''.join(transcript) + '\n[pty-smoke] live status leaked after completed bash row\n'
            send(master_fd, '/exit\r')
        elif sequence == 'compact-progress':
            send(master_fd, 'hello\r')
            if not wait_for(master_fd, 'BabeL-O local runtime is active.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] compact setup prompt did not complete\n'
            send(master_fd, '/compact\r')
            if not wait_for(master_fd, 'Compacting conversation...', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] compact progress did not render\n'
            if not wait_for(master_fd, '✓ Context compacted', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] compact completion did not render\n'
            screen = screen_text(''.join(transcript))
            if 'compact_boundary' in screen or 'summaryChars' in screen or 'Compacted session' in screen:
                return 1, ''.join(transcript) + '\n[pty-smoke] compact leaked internal result details\n'
            send(master_fd, '/exit\r')
        elif sequence == 'context-visualization':
            send(master_fd, 'hello\r')
            if not wait_for(master_fd, 'BabeL-O local runtime is active.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] context setup prompt did not complete\n'
            send(master_fd, '/context\r')
            if not wait_for(master_fd, 'BABEL Context', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] context panel did not render\n'
            visible = visible_text(''.join(transcript))
            for expected in ('current context', 'Current context by source', 'System prompt', 'System tools', 'Skills · /skills', 'Autocompact buffer', 'Free space'):
                if expected not in visible:
                    return 1, ''.join(transcript) + f'\n[pty-smoke] context panel missing {expected}\n'
            send(master_fd, '/exit\r')
        elif sequence == 'agentloop-subagent-smoke':
            send(master_fd, '/agentloop-smoke\r')
            if not wait_for(master_fd, 'subagent started', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] sub-agent start event did not render\n'
            if not wait_for(master_fd, 'AgentLoop sub-agent TUI smoke completed', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] AgentLoop smoke did not complete\n'
            visible = visible_text(''.join(transcript))
            for expected in ('task blocked', 'subtasks delegated', 'subagent completed', 'Parent blocked by delegated sub-agent', 'Child implementation via sub-agent', 'depth=1', 'parentTaskId=1', 'parent #1', 'transcript=nexus://sessions/'):
                if expected not in visible:
                    return 1, ''.join(transcript) + f'\n[pty-smoke] AgentLoop smoke missing {expected}\n'
            screen = screen_text(''.join(transcript))
            if 'Running sub-agent' in screen or 'Working...' in screen:
                return 1, ''.join(transcript) + '\n[pty-smoke] AgentLoop live running status leaked after completion\n'
            if screen.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] AgentLoop smoke rendered multiple input shortcut rows\n'
            send(master_fd, '/exit\r')
        elif sequence == 'live-waiting-status':
            send(master_fd, 'read package.json\r')
            if not wait_for(master_fd, 'Working...', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] initial working status did not render\n'
            if not wait_for(master_fd, 'Read completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] live status read did not complete\n'
            visible = visible_text(''.join(transcript))
            if 'Generating...' not in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] generating status did not render\n'
            send(master_fd, '/exit\r')
        elif sequence == 'agent-running-terminal-states':
            send(master_fd, 'bash node -v\r')
            if not wait_for(master_fd, 'Waiting for permission...', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] permission waiting status did not render\n'
            send(master_fd, '1')
            if not wait_for(master_fd, 'Bash completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] successful bash did not complete\n'
            send(master_fd, 'bash node -e "process.exit(7)"\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] failing bash permission panel did not render\n'
            send(master_fd, '1')
            if not wait_for(master_fd, 'Bash failed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] failing bash did not render failed terminal state\n'
            screen = screen_text(''.join(transcript))
            for leaked in ('Working...', 'Generating...', 'Running Bash...', 'Waiting for permission...'):
                if leaked in screen:
                    return 1, ''.join(transcript) + f'\n[pty-smoke] terminal agent status leaked after done/failed: {leaked}\n'
            if 'Bash(node -v)' not in screen or 'Bash(node -e process.exit(7)) failed' not in screen:
                return 1, ''.join(transcript) + '\n[pty-smoke] done/failed tool rows missing from final screen\n'
            if screen.count('? for shortcuts') > 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] terminal state smoke rendered duplicate input boxes\n'
            send(master_fd, '/exit\r')
        elif sequence == 'input-placeholder':
            send(master_fd, '\r')
            time.sleep(0.1)
            send(master_fd, '什么我可以帮你的吗？\r')
            if not wait_for(master_fd, '什么我可以帮你的吗？', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] typed prompt did not render\n'
            if not wait_for(master_fd, 'BabeL-O local runtime is active.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] typed prompt did not complete\n'
            visible = visible_text(''.join(transcript))
            if '什么我可以帮你的吗？edit, / for commands' in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] placeholder tail remained after typing\n'
            if visible.count('BabeL-O local runtime is active.') != 1:
                return 1, ''.join(transcript) + '\n[pty-smoke] blank enter submitted unexpectedly\n'
            send(master_fd, '/exit\r')
        elif sequence == 'shift-enter-multiline-input':
            send(master_fd, '第一行业务场景\x1b[13;2u第二行风险分层')
            time.sleep(0.1)
            chunk = read_available(master_fd, 0.2)
            if chunk:
                transcript.append(chunk)
            visible = visible_text(''.join(transcript))
            if 'BabeL-O local runtime is active.' in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] shift-enter submitted unexpectedly\n'
            if '第一行业务场景' not in visible or '第二行风险分层' not in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] shift-enter multiline prompt did not render\n'
            send(master_fd, '\r')
            if not wait_for(master_fd, 'BabeL-O local runtime is active.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] shift-enter multiline prompt did not submit after enter\n'
            visible = visible_text(''.join(transcript))
            if '第一行业务场景' not in visible or '第二行风险分层' not in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] shift-enter multiline prompt was not preserved\n'
            send(master_fd, '/exit\r')
        elif sequence == 'multiline-paste-placeholder':
            send(master_fd, '\x1b[200~alpha\nbeta\ngamma\x1b[201~')
            if not wait_for(master_fd, '[Pasted text #1 +3 lines]', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] pasted text placeholder did not render\n'
            visible = visible_text(''.join(transcript))
            if 'Multiline Paste Buffer' in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] old paste buffer panel rendered unexpectedly\n'
            send(master_fd, ' analyze\r')
            if not wait_for(master_fd, 'BabeL-O local runtime is active.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] pasted placeholder prompt did not submit\n'
            visible = visible_text(''.join(transcript))
            if 'beta' not in visible or '[Pasted text #1 +3 lines] analyze' not in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] pasted text was not expanded for execution or compressed for display\n'
            send(master_fd, '/exit\r')
        elif sequence == 'coding-question-files':
            send(master_fd, 'What does question.txt say?\r')
            if not wait_for(master_fd, 'violet-river', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] file question answer did not include fixture token\n'
            visible = visible_text(''.join(transcript))
            if 'What does question.txt say?' not in visible:
                return 1, ''.join(transcript) + '\n[pty-smoke] file question prompt did not render\n'
            send(master_fd, '/exit\r')
        elif sequence == 'task-update-status':
            send(master_fd, 'task "Verify task update smoke"\r')
            if not wait_for(master_fd, 'TaskCreate completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] task create did not complete\n'
            send(master_fd, 'task status\r')
            if not wait_for(master_fd, 'Verify task update smoke', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] task status did not include created task\n'
            if not wait_for(master_fd, 'pending', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] task status did not include pending state\n'
            send(master_fd, 'task update "Verify task update smoke" completed done\r')
            if not wait_for(master_fd, 'task updated', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] task update event did not render\n'
            if not wait_for(master_fd, 'Task updated:', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] task update assistant message did not render\n'
            if not wait_for(master_fd, 'completed Verify task update smoke', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] task update did not render completed state\n'
            send(master_fd, '/exit\r')
        elif sequence == 'programming-workflow':
            send(master_fd, 'read smoke.txt\r')
            if not wait_for(master_fd, 'Read completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] read did not complete in programming workflow\n'

            send(master_fd, 'edit smoke.txt beta gamma\r')
            if not wait_for(master_fd, 'approval', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] edit permission panel did not render\n'
            send(master_fd, '1')
            if not wait_for(master_fd, 'Edit completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] edit did not complete\n'
            send(master_fd, '\x0f')
            if not wait_for(master_fd, 'Diff for Edit in smoke.txt', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] edit diff did not render after expand\n'
            if not wait_for(master_fd, '+ gamma', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] edit diff added line did not render\n'

            send(master_fd, 'grep gamma\r')
            if not wait_for(master_fd, 'smoke.txt:1:alpha gamma', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] grep output did not include edited file\n'
            send(master_fd, 'glob **/*.ts\r')
            if not wait_for(master_fd, 'src/smoke.ts', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] glob output did not include fixture file\n'
            send(master_fd, 'task Verify smoke workflow\r')
            if not wait_for(master_fd, 'TaskCreate completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] task create did not complete\n'
            send(master_fd, '/exit\r')
        elif sequence == 'resume-session':
            send(master_fd, 'read smoke.txt\r')
            if not wait_for(master_fd, 'Read completed.', timeout, transcript):
                return 1, ''.join(transcript) + '\n[pty-smoke] initial read did not complete before resume\n'
            send(master_fd, '/exit\r')
            wait_for(master_fd, 'Exiting chat', 0.5, transcript)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.terminate()
                proc.wait(timeout=3)
            transcript.append(read_available(master_fd, 0.1))
            first_run = ''.join(transcript)
            if proc.returncode != 0:
                return proc.returncode, first_run
            match = re.search(r'session (session_[A-Za-z0-9_-]+)', visible_text(first_run))
            if not match:
                return 1, first_run + '\n[pty-smoke] initial session id was not rendered\n'
            resumed_session_id = match.group(1)
            stop_chat_process(master_fd, proc)

            resume_command = [*base_command, '--session', resumed_session_id]
            master_fd, proc = start_chat_process(resume_command, workspace, env)
            resumed: list[str] = []
            if not wait_for(master_fd, f'resume {resumed_session_id}', timeout, resumed):
                return 1, first_run + ''.join(resumed) + '\n[pty-smoke] resume banner did not render\n'
            if not wait_for(master_fd, 'Read(smoke.txt)', timeout, resumed):
                return 1, first_run + ''.join(resumed) + '\n[pty-smoke] resumed history did not render prior read\n'
            send(master_fd, '/exit\r')
            wait_for(master_fd, 'Exiting chat', 0.5, resumed)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.terminate()
                proc.wait(timeout=3)
            resumed.append(read_available(master_fd, 0.1))
            return 0 if proc.returncode == 0 else proc.returncode, first_run + ''.join(resumed)
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
        stop_chat_process(master_fd, proc)


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
