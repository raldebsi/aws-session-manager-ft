import ctypes
import json
import logging
import os
import sys
import subprocess
from typing import Optional

from src.common import DEBUG_MODE, logger

def resolve_absolute_path(path: str) -> str:
    return os.path.abspath(os.path.expanduser(path))

def load_json(json_path: str) -> dict:
    try:
        with open(json_path, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        logger.error(f"{json_path} not found.")
        return {}
    except json.JSONDecodeError:
        logger.error(f"Invalid JSON format in {json_path}.")
        return {}


def save_json(data: dict, json_path: str):
    try:
        with open(json_path, "w") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Failed to save JSON to {json_path}: {e}")
        return

def get_hosts_path() -> str:
    if DEBUG_MODE:
        logger.warning("Running in debug mode, using mock hosts path.")
        return "mock_hosts.txt"
    
    import platform
    if platform.system() == "Windows":
        return r"C:\Windows\System32\drivers\etc\hosts"
    return "/etc/hosts"


def get_is_client_privileged() -> bool:
    if DEBUG_MODE:
        logger.warning("Running in debug mode, skipping privilege check.")
        return True
    if os.name == "nt":  # Windows
        try:
            return ctypes.windll.shell32.IsUserAnAdmin() != 0
        except Exception:
            return False

    if sys.platform == "darwin":  # macOS
        return os.geteuid() == 0

    if os.name == "posix":  # Linux and other Unix
        return os.geteuid() == 0

    return False

def relaunch_with_elevated_privileges():
    if os.name == "nt":  # Windows
        try:
            ctypes.windll.shell32.ShellExecuteW(
                None, "runas", sys.executable, " ".join(sys.argv), None, 1)
            sys.exit(0)
        except Exception as e:
            logger.error(f"Failed to relaunch with elevated privileges: {e}")
            sys.exit(1)

    if sys.platform == "darwin":  # macOS
        try:
            os.execvp("sudo", ["sudo"] + [sys.executable] + sys.argv)
        except Exception as e:
            logger.error(f"Failed to relaunch with elevated privileges: {e}")
            sys.exit(1)

    if os.name == "posix":  # Linux and other Unix
        try:
            os.execvp("sudo", ["sudo"] + [sys.executable] + sys.argv)
        except Exception as e:
            logger.error(f"Failed to relaunch with elevated privileges: {e}")
            sys.exit(1)

def check_hosts_entry(endpoint: str) -> Optional[str]:
    hosts_path = get_hosts_path()

    endpoint = endpoint.strip().lower()

    with open(hosts_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    # check if entry already exists then check if it is localhost or 127.0.0.1
    for line in lines:
        line = line.strip()
        if line.startswith("#") or not line:
            continue
        line_split = line.split()
        if len(line_split) < 2:
            continue
        if len(line_split) > 2:
            line_split = line_split[:2]
        con1, con2 = line_split
        con2 = con2.strip().lower()
        if con2 == endpoint.lower():
            if con1 in ["localhost", "127.0.0.1"]:
                logger.info(f"Hosts file already contains entry for {endpoint} → {con1}")
                return con1
            raise ValueError(f"Hosts file contains entry for {endpoint} but it is not localhost or 127.0.0.1")

    return None

def update_hosts(endpoint: str):
    hosts_path = get_hosts_path()

    if check_hosts_entry(endpoint):
        return

    entry = f"127.0.0.1 {endpoint}\n"

    if not get_is_client_privileged():
        raise PermissionError("Insufficient permissions to modify hosts file. Please run with elevated privileges.")

    with open(hosts_path, "a+", encoding="utf-8") as f:
        f.seek(0)
        content = f.read()

        if content and not content.endswith("\n"):
            f.write("\n")
        
        f.write(entry)


def run_cmd(cmd: list):
    # uses POpen to run command and yield output line by line in real time
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return process


def ensure_elevated_privileges():
    """Ensure the script is running with elevated privileges, relaunch if not."""
    if not get_is_client_privileged():
        relaunch_with_elevated_privileges()
        sys.exit(0)  # exit current instance after relaunching with elevated privileges
