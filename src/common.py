import os
import logging
import sys

from src.utils.tunnel_manager import TunnelManager

tunnel_manager = TunnelManager()

CONFIG_PATH = "config"
USER_CONFIG_FILE = "user.json"
CONNECTIONS_FILE = "connections"

USER_CONFIG_PATH = os.path.join(CONFIG_PATH, USER_CONFIG_FILE)
CONNECTIONS_CONFIG_PATH = os.path.join(CONFIG_PATH, CONNECTIONS_FILE)
DEBUG_MODE = os.getenv("DEBUG_MODE", "0").lower() in ("1", "true", "yes")
DEBUG_MODE = DEBUG_MODE or sys.gettrace() is not None or any('pydevd' in str(f) for f in sys.modules) # Force debug mode if a debugger is attached

format = "[%(levelname)s] [%(name)s] %(message)s"
format_dbg = "[%(levelname)s] [%(name)s] [%(asctime)s] %(filename)s:%(lineno)d - %(message)s"


logging.basicConfig(
    level=logging.INFO,
    format=format_dbg if DEBUG_MODE else format,
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)
