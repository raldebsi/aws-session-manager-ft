import subprocess
import signal
import sys

import psutil

class ManagedProcess:
    def __init__(self, cmd):
        self.cmd = cmd
        self.process = None
        self.pid = None

    def __enter__(self):
        self.process = subprocess.Popen(self.cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
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
            for line in self.process.stdout:
                yield line

    def kill(self):
        if self.process:
            try:
                self.process.kill()
            except Exception:
                pass
            try:
                process = psutil.Process(self.pid)
                for child in process.children(recursive=True):
                    child.kill()
                process.kill()
            except Exception:
                pass

    @property
    def stdout(self):
        return self.process.stdout if self.process else None

    @property
    def stderr(self):
        return self.process.stderr if self.process else None

    @property
    def returncode(self):
        return self.process.returncode if self.process else None
