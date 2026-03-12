import os
import logging
import sys

from src.utils.tunnel_manager import TunnelManager

tunnel_manager = TunnelManager()

CONFIG_PATH = "config"
USER_CONFIG_FILE = "user_config.json"
CONNECTIONS_FILE = "connections.json"

USER_CONFIG_PATH = os.path.join(CONFIG_PATH, USER_CONFIG_FILE)
CONNECTIONS_CONFIG_PATH = os.path.join(CONFIG_PATH, CONNECTIONS_FILE)

logging.basicConfig(
    level=logging.INFO,
    format="[%(levelname)s] [%(name)s] [%(asctime)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

DEBUG_MODE = os.getenv("DEBUG_MODE", "0").lower() in ("1", "true", "yes")
DEBUG_MODE = DEBUG_MODE or sys.gettrace() is not None or any('pydevd' in str(f) for f in sys.modules) # Force debug mode if a debugger is attached