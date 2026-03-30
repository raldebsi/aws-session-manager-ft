import logging
import os
import sys

import yaml

from src.utils.tunnel_manager import SSMTunnelManager

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

APP_VERSION = "0.1.0"

tunnel_manager = SSMTunnelManager()

CONFIG_PATH = "config"
USER_CONFIG_FILE = "user.json"
CONNECTIONS_FILE = "connections"
SETTINGS_FILE = "settings.yaml"

GROUPS_FILE = "user_groups.json"

USER_CONFIG_PATH = os.path.join(CONFIG_PATH, USER_CONFIG_FILE)
CONNECTIONS_CONFIG_PATH = os.path.join(CONFIG_PATH, CONNECTIONS_FILE)
SETTINGS_PATH = os.path.join(CONFIG_PATH, SETTINGS_FILE)
GROUPS_PATH = os.path.join(CONFIG_PATH, GROUPS_FILE)
DEBUG_MODE = os.getenv("DEBUG_MODE", "0").lower() in ("1", "true", "yes")
DEBUG_MODE = DEBUG_MODE or sys.gettrace() is not None or any('pydevd' in str(f) for f in sys.modules) # Force debug mode if a debugger is attached

# --- Settings ---

SETTINGS_DEFAULTS = {
    "default_kubeconfig_path": "~/.kube/config",
    "max_log_size": 1000,
    "max_tunnels": 5,
    "polling_interval": 1,
    "readiness_timeout": 20,
    "healthcheck_timeout": 5,
}


def load_settings() -> dict:
    """Load settings from YAML file, creating it with defaults if missing."""
    if not os.path.exists(SETTINGS_PATH):
        save_settings(SETTINGS_DEFAULTS)
        return dict(SETTINGS_DEFAULTS)

    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception:
        data = {}

    # Merge with defaults (fill any missing keys)
    merged = {**SETTINGS_DEFAULTS, **data}
    return merged


def save_settings(settings: dict):
    """Save settings to YAML file."""
    os.makedirs(CONFIG_PATH, exist_ok=True)
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump(settings, f, default_flow_style=False)

format = "[%(levelname)s] [%(name)s] %(message)s"
format_dbg = "[%(levelname)s] [%(name)s] [%(asctime)s] %(filename)s:%(lineno)d - %(message)s"


logging.basicConfig(
    level=logging.INFO,
    format=format_dbg if DEBUG_MODE else format,
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)
