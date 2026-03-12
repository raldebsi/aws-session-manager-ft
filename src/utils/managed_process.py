import logging
import os
import subprocess
import signal
import sys

import psutil

logger = logging.getLogger("managed_process")

class ManagedProcess:
    def __init__(self, cmd, output_limit=1000):
        self.cmd = cmd
        self.process = None
        self.pid = None
        self.output = []
        self.output_limit = output_limit

    def __enter__(self):
        self.process = subprocess.Popen(
            self.cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            text=True,
            preexec_fn=os.setsid if sys.platform != 'win32' else None,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == 'win32' else 0
        )
        self.pid = self.process.pid
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.process and self.process.poll() is None:
            self.terminate()
        # Optionally, suppress KeyboardInterrupt if desired
        return False

    def terminate(self):
        if self.process and self.process.poll() is None:
            try:
                if sys.platform == 'win32':
                    self.process.terminate()
                else:
                    self.process.send_signal(signal.SIGINT)
            except Exception:
                self.process.kill()

    def wait(self):
        if self.process:
            return self.process.wait()

    def communicate(self, *args, **kwargs):
        if self.process:
            return self.process.communicate(*args, **kwargs)

    def iter_stdout(self):
        """Yield lines from process stdout as they become available."""
        if self.process and self.process.stdout:
            for line in iter(self.process.stdout.readline, ''):
                self.output.append(line.strip())
                if len(self.output) > self.output_limit:  # Keep only the last 1000 lines to prevent memory issues
                    self.output.pop(0)
                yield line

    def kill(self):
        logger.info(f"Kill Requested for PID {self.pid}")
        if self.process:
            logger.info("Kill by process group...")
            try:
                if sys.platform != 'win32':
                    os.killpg(os.getpgid(self.process.pid), signal.SIGKILL)
                else:
                    self.process.send_signal(signal.CTRL_BREAK_EVENT)
                logger.info(f"Process group for {self.pid} killed.")
            except Exception as e:
                logger.error(f"Error killing process group for {self.pid}: {e}")

            
            try:
                logger.info("Kill by process tree...")
                process = psutil.Process(self.pid)
                for child in process.children(recursive=True):
                    logger.info(f"Killing child process {child.pid}...")
                    child.kill()
                process.kill()
                logger.info(f"Process tree for {self.pid} killed.")
            except psutil.NoSuchProcess:
                logger.info(f"Process {self.pid} already terminated.")
            except Exception as e:
                logger.error(f"Error killing process tree for {self.pid}: {e} ({type(e).__name__})")

            try:
                logger.info("Kill by process...")
                self.process.kill()
                logger.info(f"Process {self.pid} killed.")
            except Exception as e:
                logger.error(f"Error killing process {self.pid}: {e} ({type(e).__name__})")
        else:
            logger.info("No process to kill.")

    @property
    def stdout(self):
        return self.process.stdout if self.process else None

    @property
    def stderr(self):
        return self.process.stderr if self.process else None

    @property
    def returncode(self):
        return self.process.returncode if self.process else None
