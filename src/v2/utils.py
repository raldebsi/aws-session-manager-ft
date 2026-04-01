"""V2 utility functions — pure library replacements for subprocess-based utils."""

import boto3
import psutil

from src.common import logger


# --- Item 1: get_pid_on_port via psutil (replaces netstat/lsof/ss) ---

def get_pid_on_port(port: int) -> int:
    """Find the PID of the process listening on 127.0.0.1:port. Returns -1 if none."""
    port = int(port)
    try:
        for conn in psutil.net_connections(kind="tcp"):
            if conn.status != psutil.CONN_LISTEN:
                continue
            addr = conn.laddr
            if not addr or not isinstance(addr, tuple) or len(addr) < 2:
                continue
            conn_ip: str = addr[0]
            conn_port: int = addr[1]
            if conn_port == port and conn_ip in ("127.0.0.1", "0.0.0.0", "::", "::1"):
                return conn.pid if conn.pid else -1
    except (psutil.AccessDenied, psutil.NoSuchProcess) as e:
        logger.error(f"Failed to detect PID on port {port}: {e}")
    except Exception as e:
        logger.error(f"Failed to detect PID on port {port}: {e}")
    return -1


# --- Item 2: get_aws_profiles via boto3 (replaces aws configure list-profiles) ---

def get_aws_profiles() -> list[str]:
    """Get all AWS profile names from ~/.aws/credentials and ~/.aws/config via boto3."""
    try:
        return list(boto3.Session().available_profiles)
    except Exception as e:
        logger.warning(f"Failed to list AWS profiles via boto3: {e}")
        return []
