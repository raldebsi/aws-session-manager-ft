from enum import Enum
import signal
import threading
from typing import Literal, Optional, TypedDict, Union
from uuid import uuid4
from src.utils.managed_process import ManagedProcess
import logging

logger = logging.getLogger("tunnel_manager")

class TunnelState(Enum):
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    APP_SHUTTING_DOWN = "app-shutting-down"
    STOPPED_SHUTDOWN = "stopped-shutdown"
    STOPPED_ENDED = "stopped-ended"
    KILLED = "killed"
    ERROR = "error"

class Tunnel(TypedDict):
    thread: threading.Thread
    connection_id: str
    process: Optional[ManagedProcess]
    state: TunnelState

class SSMTunnelManager:
    """
        This class is specifically for SSM Tunnels. It contains logic with lots of assumptions about how SSM tunnels work.
        It is not intended to be a generic tunnel manager, as it overrides lots of thread behaviors, states, and exits.
        It also generates content tailored specifically for SSM.
    """
    def __init__(self):
        self.tunnels: dict[str, Tunnel] = {}
        self._lock = threading.RLock()
        self._shutdown_flag = threading.Event()

    def update_tunnel_state(self, tunnel_id, new_state: Union[TunnelState, str]):
        if isinstance(new_state, str):
            try:
                new_state = TunnelState(new_state)
            except ValueError:
                logger.error(f"[{tunnel_id}] Invalid tunnel state '{new_state}' provided.")
                return
        with self._lock:
            if tunnel_id in self.tunnels:
                self.tunnels[tunnel_id]['state'] = new_state
                logger.info(f"[{tunnel_id}] Tunnel state updated to '{new_state}'.")
            else:
                logger.warning(f"[{tunnel_id}] Attempted to update state for non-existent tunnel.")

    def start_tunnel(self, connection_id, *cmd):
        def tunnel_thread(): # Define new function internally to utilize local variables
            try:
                with ManagedProcess(cmd) as mp:
                    logger.info(f"[{tunnel_id}] Tunnel process started with PID {mp.pid}")
                    self.register_process(tunnel_id, mp)

                    def log_stream(stream_iter, stream_name):
                        self.update_tunnel_state(tunnel_id, 'running')
                        for line in stream_iter:
                            line = line.strip()
                            logger.info(f"[{tunnel_id}][{stream_name}] {line}")
                            if self._shutdown_flag.is_set() and mp.returncode is None:
                                self.update_tunnel_state(tunnel_id, "app-shutting-down")
                                logger.info(f"[{tunnel_id}] Terminating process due to app shutdown flag.")
                                mp.terminate()

                    stdout_thread = threading.Thread(target=log_stream, args=(mp.iter_stdout(), 'stdout'), daemon=True)
                    stderr_thread = threading.Thread(target=log_stream, args=(mp.iter_stderr(), 'stderr'), daemon=True)
                    stdout_thread.start()
                    stderr_thread.start()

                    stdout_thread.join()
                    stderr_thread.join()
                    logger.info(f"[{tunnel_id}] Tunnel process output threads ended.")
                    mp.wait()
                    if mp.returncode != 0:
                        self.update_tunnel_state(tunnel_id, 'error')
                    logger.info(f"[{tunnel_id}] Tunnel finished with code {mp.returncode}")
            except Exception as e:
                logger.error(f"[{tunnel_id}] Tunnel error: {e}")
            finally:
                with self._lock:
                    self.update_tunnel_state(tunnel_id, 'stopped-shutdown' if self._shutdown_flag.is_set() else 'stopped-ended')

        thread = threading.Thread(target=tunnel_thread, daemon=True)
        tunnel_suffix = thread.ident if thread.ident else uuid4().hex[:8] # Flask disables ident in threads
        tunnel_id = f"{connection_id}-{tunnel_suffix}" # Prevent ID collision even though it must not happen, since only one tunnel per connection_id is allowed, but if somehow the code allows for it, we need to allow killing the correct tunnel
        with self._lock:
            self.tunnels[tunnel_id] = {'thread': thread, 'connection_id': connection_id, 'process': None, 'state': TunnelState.STARTING}
        thread.start()
        return tunnel_id

    def has_tunnel_for_connection(self, connection_id):
        """Return True if a tunnel exists for the given connection_id."""
        with self._lock:
            return any(t.get('connection_id') == connection_id for t in self.tunnels.values())

    def stop_tunnel(self, tunnel_id):
        with self._lock:
            tunnel = self.tunnels.get(tunnel_id)
            if not tunnel:
                logger.warning(f"[{tunnel_id}] Attempted to stop non-existent tunnel.")
                return
            process = tunnel['process'] if tunnel else None
            if process:
                logger.info(f"[{tunnel_id}] Terminating process...")
                process.terminate()
                logger.info(f"[{tunnel_id}] Termination signal sent.")
            else:
                logger.warning(f"[{tunnel_id}] No process found to terminate.")
            
            self.update_tunnel_state(tunnel_id, 'stopping')

    def kill_tunnel(self, tunnel_id):
        with self._lock:
            tunnel = self.tunnels.get(tunnel_id)
            if not tunnel:
                logger.warning(f"[{tunnel_id}] Attempted to kill non-existent tunnel.")
                return
            process = tunnel['process'] if tunnel else None
            if process:
                logger.info(f"[{tunnel_id}] Killing process...")
                process.kill()
                logger.info(f"[{tunnel_id}] Kill signal sent.")
            else:
                logger.warning(f"[{tunnel_id}] No process found to kill.")
            
            self.update_tunnel_state(tunnel_id, 'killed')

    def register_process(self, tunnel_id, process):
        with self._lock:
            if tunnel_id in self.tunnels:
                self.tunnels[tunnel_id]['process'] = process
                logger.info(f"[{tunnel_id}] Process {process.pid} registered.")
            else:
                logger.warning(f"[{tunnel_id}] Attempted to register process for non-existent tunnel.")

    def list_tunnels(self):
        with self._lock:
            return list(self.tunnels.keys())
        
    def get_tunnel_info(self, tunnel_id):
        with self._lock:
            tunnel = self.tunnels.get(tunnel_id)
            if not tunnel:
                logger.warning(f"[{tunnel_id}] Attempted to get info for non-existent tunnel.")
                return {}
            return {
                "connection_id": tunnel['connection_id'],
                "process_id": tunnel['process'].pid if tunnel['process'] else None,
                "thread_id": tunnel['thread'].ident if tunnel['thread'] else None,
                "thread_alive": tunnel['thread'].is_alive() if tunnel['thread'] else None,
                "state": tunnel['state'].value if tunnel['state'] else None,
            }

    def shutdown_all_tunnels(self, sig=None, frame=None):
        if sig:
            logger.info(f"Received Signal: {sig}.")
            if sig not in [signal.SIGINT, signal.SIGTERM]:
                logger.info("Signal not intended for shutdown. Ignoring.")
                return
        
        self._shutdown_flag.set()
        logger.info("Shutting down all tunnels...")
        with self._lock:
            tunnels = self.list_tunnels()
            for tunnel_id in tunnels:
                self.stop_tunnel(tunnel_id)
        logger.info("Detecting remaining tunnels after shutdown signal...")
        self.handle_dangling_tunnels()
        logger.info("All tunnels have been shut down.")

    def register_shutdown_handler(self):
        import atexit, signal
        atexit.register(self.shutdown_all_tunnels)
        signal.signal(signal.SIGINT, self.shutdown_all_tunnels)
        signal.signal(signal.SIGTERM, self.shutdown_all_tunnels)

    def get_shutdown_handler(self):
        return self.shutdown_all_tunnels

    def handle_dangling_tunnels(self):
        """Attempt to join all tunnel threads and log any that are still alive or missing a process."""
        with self._lock:
            for tunnel_id, tunnel in list(self.tunnels.items()):
                thread = tunnel.get("thread")
                process = tunnel.get("process")
                if process is None:
                    logger.warning(
                        f"[{tunnel_id}] No process registered for tunnel. Possible dangling thread."
                    )
                if thread is not None:
                    logger.info(f"[{tunnel_id}] Attempting to join tunnel thread...")
                    # thread.join(timeout=3) No need to wait since the thread is not writing
                    if thread.is_alive():
                        if process:
                            logger.warning(f"[{tunnel_id}] Tunnel thread still active. Terminating forcefully.")
                            process.kill()
                            thread.join(timeout=1) # Wait a moment for thread to exit after kill
                            # It is possible that stdout and stderr flush after kill so we need to let them join in case
                            if thread.is_alive():
                                logger.warning(f"[{tunnel_id}] Tunnel did not terminate. Terminate the app.")
                            else:
                                logger.info(f"[{tunnel_id}] Tunnel was forcefully terminated.")
                        else:
                            logger.warning(f"[{tunnel_id}] Tunnel not linked to a process. Dangling thread! Terminate the app.")
                    else:
                        logger.info(f"[{tunnel_id}] Tunnel thread joined successfully.")

    def get_output(self, tunnel_id):
        return self.get_output_stream(tunnel_id, 'stdout')

    def get_errors(self, tunnel_id):
        return self.get_output_stream(tunnel_id, 'stderr')
        
    def get_output_stream(self, tunnel_id, stream_name):
        with self._lock:
            tunnel = self.tunnels.get(tunnel_id)
            if not tunnel:
                logger.warning(f"[{tunnel_id}] Attempted to get output stream for non-existent tunnel.")
                return None
            process = tunnel.get('process')
            if not process:
                logger.warning(f"[{tunnel_id}] No process registered for tunnel when getting output stream.")
                return None
            
            if stream_name == 'stdout':
                return process.output
            elif stream_name == 'stderr':
                return process.errors
            else:
                logger.error(f"[{tunnel_id}] Invalid stream name '{stream_name}' requested.")
                return None