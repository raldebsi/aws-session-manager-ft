import signal
import threading
from typing import Optional, TypedDict
from src.utils.managed_process import ManagedProcess
import logging

logger = logging.getLogger("tunnel_manager")

class Tunnel(TypedDict):
    thread: threading.Thread
    connection_id: str
    process: Optional[ManagedProcess]

class TunnelManager:
    def __init__(self):
        self.tunnels: dict[str, Tunnel] = {}
        self._lock = threading.RLock()
        self._shutdown_flag = threading.Event()

    def start_tunnel(self, connection_id, *cmd):
        def tunnel_thread():
            try:
                with ManagedProcess(cmd) as mp:
                    logger.info(f"[{tunnel_id}] Tunnel process started with PID {mp.pid}")
                    self.register_process(tunnel_id, mp)
                    for line in mp.iter_stdout():
                        line = line.strip()
                        logger.info(f"[{tunnel_id}] {line}")
                        if self._shutdown_flag.is_set() and mp.returncode is None:
                            logger.info(f"[{tunnel_id}] Terminating process due to shutdown flag.")
                            mp.terminate()
                    logger.info(f"[{tunnel_id}] Tunnel process stdout loop ended.")
                    mp.wait()
                    logger.info(f"[{tunnel_id}] Tunnel finished with code {mp.returncode}")
            except Exception as e:
                logger.error(f"[{tunnel_id}] Tunnel error: {e}")
            finally:
                with self._lock:
                    self.tunnels.pop(tunnel_id, None)

        thread = threading.Thread(target=tunnel_thread, daemon=True)
        tunnel_id = f"{connection_id}-{thread.ident}" # Prevent ID collision even though it must not happen, since only one tunnel per connection_id is allowed, but if somehow the code allows for it, we need to allow killing the correct tunnel
        with self._lock:
            self.tunnels[tunnel_id] = {'thread': thread, 'connection_id': connection_id, 'process': None}
        thread.start()

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
                            if thread.is_alive():
                                logger.warning(f"[{tunnel_id}] Tunnel did not terminate. Terminate the app.")
                            else:
                                logger.info(f"[{tunnel_id}] Tunnel was forcefully terminated.")
                        else:
                            logger.warning(f"[{tunnel_id}] Tunnel not linked to a process. Dangling thread! Terminate the app.")
                    else:
                        logger.info(f"[{tunnel_id}] Tunnel thread joined successfully.")

    def get_output(self, tunnel_id):
        with self._lock:
            tunnel = self.tunnels.get(tunnel_id)
            if not tunnel:
                logger.warning(f"[{tunnel_id}] Attempted to get output for non-existent tunnel.")
                return None
            process = tunnel.get('process')
            if not process:
                logger.warning(f"[{tunnel_id}] No process registered for tunnel when getting output.")
                return None
            
            return process.output or []