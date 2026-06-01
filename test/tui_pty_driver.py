#!/usr/bin/env python3
import argparse
import os
import pty
import re
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
    env.update({
        'BABEL_O_CONFIG_FILE': config_file,
        'BABEL_O_LAUNCH_CWD': workspace,
        'HOME': config_dir,
        'NO_COLOR': '1',
        'TERM': 'xterm-256color',
        'COLUMNS': '100',
        'LINES': '30',
    })

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
