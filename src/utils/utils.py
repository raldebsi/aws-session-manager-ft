import configparser
import ctypes
import json
import os
import platform
import re
import signal
import socket
import subprocess
import sys
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


def get_pid_on_port(port: int) -> int:
    """Find the PID of the process listening on 127.0.0.1:port. Returns -1 if none."""
    port = int(port)
    system = platform.system()

    try:
        if system == "Windows":
            result = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True, text=True, timeout=5
            )
            listen_addrs = {f"127.0.0.1:{port}", f"0.0.0.0:{port}"}
            for line in result.stdout.splitlines():
                # Match lines like:  TCP    127.0.0.1:9444    0.0.0.0:0    LISTENING    12345
                parts = line.split()
                if len(parts) >= 5 and parts[0] == "TCP" and "LISTENING" in parts:
                    if parts[1] in listen_addrs:
                        pid = int(parts[-1])
                        return pid
        else:
            # Linux / macOS: use lsof — check both localhost and wildcard
            for addr in [f"TCP@127.0.0.1:{port}", f"TCP@0.0.0.0:{port}"]:
                result = subprocess.run(
                    ["lsof", "-i", addr, "-t", "-sTCP:LISTEN"],
                    capture_output=True, text=True, timeout=5
                )
                pids = result.stdout.strip().splitlines()
                if pids:
                    return int(pids[0])
    except Exception as e:
        logger.error(f"Failed to detect PID on port {port}: {e}")

    return -1


def kill_pid(pid: int) -> bool:
    """Kill a process by PID. Returns True if successful."""
    pid = int(pid)
    if pid <= 0:
        return False

    try:
        os.kill(pid, signal.SIGTERM)
        logger.info(f"Sent SIGTERM to PID {pid}")
        return True
    except ProcessLookupError:
        logger.warning(f"PID {pid} not found (already dead)")
        return True
    except PermissionError:
        logger.error(f"Permission denied killing PID {pid}")
        return False
    except Exception as e:
        logger.error(f"Failed to kill PID {pid}: {e}")
        return False


def tcp_health_check(host: str = "127.0.0.1", port: int = 5432, timeout: float = 3.0) -> tuple[bool, str]:
    """Check if a TCP port is accepting connections. Returns (healthy, detail)."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True, f"Port {port} accepting connections"
    except ConnectionRefusedError:
        return False, f"Port {port} connection refused"
    except TimeoutError:
        return False, f"Port {port} connection timed out"
    except Exception as e:
        return False, f"Port {port}: {e}"


def run_cmd(cmd: list):
    # uses POpen to run command and yield output line by line in real time
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return process



def verify_ssm_plugin() -> str:
    """Check if the SSM session-manager-plugin is installed.
    Returns the version string (e.g. '1.2.497.0') on success, or '-1' on failure."""
    try:
        process = run_cmd(["session-manager-plugin", "--version"])
        output = process.stdout.read().strip() if process.stdout else ""
        process.wait()
        # Version output is typically just a version number like "1.2.497.0"
        # with possibly some empty lines
        for line in output.splitlines():
            line = line.strip()
            if line and re.match(r'^[\d.]+$', line):
                return line
        return "-1"
    except Exception as e:
        logger.warning(f"SSM plugin check failed: {e}")
        return "-1"


def get_aws_profiles_by_file(credentials_path: Optional[str] = None) -> list[str]:
    """Read AWS profile names from ~/.aws/credentials (INI section headers)."""
    if not credentials_path:
        credentials_path = resolve_absolute_path("~/.aws/credentials")
    else:
        credentials_path = resolve_absolute_path(credentials_path)
    if not os.path.exists(credentials_path):
        logger.warning(f"AWS credentials file not found: {credentials_path}")
        return []
    try:
        config = configparser.ConfigParser()
        config.read(credentials_path)
        return config.sections()
    except Exception as e:
        logger.error(f"Failed to read AWS credentials file: {e}")
        return []


def get_aws_profiles_by_cli() -> list[str]:
    """Get AWS profile names using `aws configure list-profiles` (falls back to `aws configure list`)."""
    try:
        process = run_cmd(["aws", "configure", "list-profiles"])
        output = process.stdout.read().strip() if process.stdout else ""
        process.wait()
        if process.returncode == 0 and output:
            return [p.strip() for p in output.splitlines() if p.strip()]
    except Exception as e:
        logger.warning(f"aws configure list-profiles failed: {e}")

    # Fallback for older AWS CLI versions
    try:
        process = run_cmd(["aws", "configure", "list"])
        output = process.stdout.read().strip() if process.stdout else ""
        process.wait()
        if process.returncode == 0 and output:
            # Parse the "profile" line from the table output
            for line in output.splitlines():
                parts = line.split()
                if parts and parts[0] == "profile":
                    profile = parts[1] if len(parts) > 1 else ""
                    if profile and profile != "<not":
                        return [profile]
    except Exception as e:
        logger.warning(f"aws configure list fallback also failed: {e}")

    return []


def ensure_elevated_privileges():
    """Ensure the script is running with elevated privileges, relaunch if not."""
    if not get_is_client_privileged():
        relaunch_with_elevated_privileges()
        sys.exit(0)  # exit current instance after relaunching with elevated privileges
