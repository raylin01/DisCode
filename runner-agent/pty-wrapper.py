#!/usr/bin/env python3
"""
Simple PTY wrapper for CLI processes.
Spawns a process in a pseudo-terminal and forwards stdin/stdout.
"""

import sys
import os
import pty
import select
import subprocess
import tty
import termios

def main():
    if len(sys.argv) < 2:
        print("Usage: pty-wrapper.py <command> <args...>", file=sys.stderr)
        sys.exit(1)

    command = sys.argv[1]
    args = sys.argv[2:]

    # Save current terminal settings
    old_settings = None
    try:
        old_settings = termios.tcgetattr(sys.stdin.fileno())
    except:
        pass

    # Create pseudo-terminal
    master_fd, slave_fd = pty.openpty()

    # Start the process
    proc = subprocess.Popen(
        [command] + args,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        preexec_fn=os.setsid,
        env=os.environ
    )

    os.close(slave_fd)

    def cleanup(signum=None, frame=None):
        try:
            os.close(master_fd)
        except:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=1)
        except:
            try:
                proc.kill()
            except:
                pass
        if old_settings:
            try:
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old_settings)
            except:
                pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    try:
        while True:
            # Use select to wait for data
            rlist, _, _ = select.select([master_fd, sys.stdin.fileno()], [], [], 0.1)

            # Forward output from PTY to stdout
            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 4096)
                    if data:
                        os.write(sys.stdout.fileno(), data)
                except OSError:
                    pass

            # Forward input from stdin to PTY
            if sys.stdin.fileno() in rlist:
                try:
                    data = os.read(sys.stdin.fileno(), 1024)
                    if data:
                        os.write(master_fd, data)
                    else:
                        # EOF on stdin, close PTY
                        cleanup()
                except OSError:
                    pass

            # Check if process exited
            if proc.poll() is not None:
                cleanup()

    except Exception as e:
        cleanup()

if __name__ == '__main__':
    import signal
    main()
