import logging
import os
import subprocess
import signal
import sys

import psutil

logger = logging.getLogger("managed_process")

class ManagedProcess:
    def __init__(self, cmd):
        self.cmd = cmd
        self.process = None

    def __enter__(self):
        self.process = subprocess.Popen(
            self.cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            text=True,
            preexec_fn=os.setsid if sys.platform != 'win32' else None,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == 'win32' else 0
        )
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.process and self.process.poll() is None:
            self.terminate()
        # As fallback, call kill
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
        
    def _iter_stream(self, stream_name):
        """Yield stripped lines from the named stream as they become available."""
        if not self.process:
            logger.error("Process not started or not registered.")
            return
        stream_handle = getattr(self.process, stream_name, None)
        if not stream_handle:
            logger.error(f"Stream {stream_name} not found in process.")
            return
        for line in iter(stream_handle.readline, ''):
            yield line.strip()

    def iter_stdout(self):
        return self._iter_stream('stdout')

    def iter_stderr(self):
        return self._iter_stream('stderr')

    def kill(self): # Kills process and children
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

    @property
    def pid(self):
        return self.process.pid if self.process else None

    @property
    def is_running(self):
        return self.process and self.process.poll() is None