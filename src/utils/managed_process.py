import logging
import os
import subprocess
import signal
import sys
from typing import IO, Optional, Union

import psutil

logger = logging.getLogger("managed_process")

class ManagedProcess:
    def __init__(self, cmd, output_limit=1000):
        self.cmd = cmd
        self.process = None
        self.output = []
        self.errors = []
        self.output_limit = output_limit

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
        
    def iter_out(self, stream: Union[str, IO[str]], output_logger: Optional[list] = None, output_limit: Optional[int] = None):
        """Yield lines from the specified stream (stdout or stderr) as they become available."""
        output_logger = output_logger if output_logger is not None else []
        output_limit = output_limit or self.output_limit

        if not self.process:
            logger.error("Process not started or not registered.")
            return

        if isinstance(stream, str):
            stream = stream.lower()
            stream_handle: Optional[IO[str]] = getattr(self.process, stream, None)
            if not stream_handle:
                logger.error(f"Stream {stream} not found in process. Available streams: 'stdout', 'stderr'.")
                return
        elif stream not in [self.stdout, self.stderr]:
            logger.error("Invalid stream handle provided.")
            return
        else:
            stream_handle = stream
        
        for line in iter(stream_handle.readline, ''):
            output_logger.append(line.strip())
            if len(output_logger) > output_limit:  # Keep only the last `output_limit` lines to prevent memory issues
                output_logger.pop(0)
            yield line.strip()

    def iter_stdout(self, output_logger: Optional[list] = None, output_limit: Optional[int] = None):
        """Yield lines from process stdout as they become available."""
        output_logger = output_logger or self.output
        output_limit = output_limit or self.output_limit
        return self.iter_out('stdout', output_logger, output_limit)
    
    def iter_stderr(self, output_logger: Optional[list] = None, output_limit: Optional[int] = None):
        """Yield lines from process stderr as they become available."""
        output_logger = output_logger or self.errors
        output_limit = output_limit or self.output_limit
        return self.iter_out('stderr', output_logger, output_limit)

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

    @property
    def pid(self):
        return self.process.pid if self.process else None

    @property
    def is_running(self):
        return self.process and self.process.poll() is None