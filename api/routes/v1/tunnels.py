import os
import time

from flask import Blueprint, jsonify, request

from src.common import CONNECTIONS_CONFIG_PATH, USER_CONFIG_PATH, tunnel_manager
from src.utils.data_loaders import load_connections, load_user_config
from src.utils.kube import k8s_health_check, start_eks_tunnel, start_ssm_tunnel
from src.utils.utils import logger, tcp_health_check

tunnels_bp = Blueprint("tunnels", __name__, url_prefix="/tunnels")

DEFAULT_PORTS = {"eks": 443, "rds": 5432}

def _resolve_tunnel_type(connection_key):
    """Look up the connection type from config. Falls back to 'eks'."""
    try:
        user_config = load_user_config(USER_CONFIG_PATH)
        uc = user_config.connections.get(connection_key)
        if not uc:
            return "eks"
        connections = load_connections(CONNECTIONS_CONFIG_PATH)
        conn = connections.get(uc.connection_id)
        return conn.type.lower() if conn else "eks"
    except Exception:
        return "eks"


@tunnels_bp.route("", methods=["GET"])
def list_tunnels():
    """List all active tunnel IDs."""
    return jsonify({"tunnels": tunnel_manager.list_tunnels()})


@tunnels_bp.route("/start", methods=["POST"])
def start_tunnel():
    """Start an SSM tunnel (EKS or RDS).

    Body: {
        "type": "eks" or "rds",
        "profile": "default",
        "endpoint": "some.endpoint.com",
        "bastion": "i-0abc123",
        "region": "us-east-1",
        "tunnel_connection_id": "my-conn",
        "document_name": "AWS-StartPortForwardingSessionToRemoteHost",  (optional)
        "local_port": 443,   (optional)
        "remote_port": 443,  (optional)
        --- EKS only ---
        "cluster_name": "my-cluster",
        "kubeconfig_path": "~/.kube/config"  (optional)
    }
    """
    data = request.get_json(force=True)
    tunnel_type = data.get("type", "eks").lower()
    default_port = DEFAULT_PORTS.get(tunnel_type, 443)

    required = ["profile", "endpoint", "bastion", "region", "tunnel_connection_id"]
    if tunnel_type == "eks":
        required.append("cluster_name")
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400

    if tunnel_type == "eks":
        tunnel_id = start_eks_tunnel(
            profile=data["profile"],
            endpoint=data["endpoint"],
            bastion=data["bastion"],
            cluster_name=data["cluster_name"],
            region=data["region"],
            tunnel_connection_id=data["tunnel_connection_id"],
            document_name=data.get("document_name", "AWS-StartPortForwardingSessionToRemoteHost"),
            local_port=int(data.get("local_port", default_port)),
            remote_port=int(data.get("remote_port", default_port)),
            kubeconfig_path=data.get("kubeconfig_path"),
        )
    else:
        # RDS and other types: just start the SSM tunnel directly (no kubeconfig/hosts setup)
        tunnel_id = start_ssm_tunnel(
            profile=data["profile"],
            endpoint=data["endpoint"],
            bastion=data["bastion"],
            region=data["region"],
            tunnel_connection_id=data["tunnel_connection_id"],
            document_name=data.get("document_name", "AWS-StartPortForwardingSessionToRemoteHost"),
            local_port=int(data.get("local_port", default_port)),
            remote_port=int(data.get("remote_port", default_port)),
        )

    if tunnel_id is None:
        return jsonify({"error": "Failed to start tunnel"}), 500

    if tunnel_id == "":
        return jsonify({"warning": "Tunnel for this connection is already running"}), 200

    return jsonify({"tunnel_id": tunnel_id, "status": "started"})

@tunnels_bp.route("/<path:tunnel_id>", methods=["GET"])
def get_tunnel_info(tunnel_id):
    """Get information about a specific tunnel."""
    tunnel_info = tunnel_manager.get_tunnel_info(tunnel_id)
    if not tunnel_info:
        return jsonify({"error": f"Tunnel '{tunnel_id}' not found"}), 404
    return jsonify(tunnel_info)

@tunnels_bp.route("/<path:tunnel_id>/stop", methods=["POST"])
def stop_tunnel(tunnel_id):
    """Stop a running tunnel by its ID."""
    if tunnel_id not in tunnel_manager.list_tunnels():
        return jsonify({"error": f"Tunnel '{tunnel_id}' not found"}), 404

    stage = "stop_requested"
    try:
        tunnel_manager.stop_tunnel(tunnel_id)
        stage = "stop_request_sent"
    except Exception as e:
        return jsonify(tunnel_id=tunnel_id, status=stage, error=str(e)), 500
    stage = "kill_requested"
    try:
        tunnel_manager.kill_tunnel(tunnel_id)
        stage = "kill_request_sent"
    except Exception as e:
        return jsonify(tunnel_id=tunnel_id, status=stage, error=str(e)), 500
    
    tunnel_info = tunnel_manager.get_tunnel_info(tunnel_id)
    connection_id = tunnel_info.get("connection_id")
    tunnel_state = tunnel_info.get("state")
    for _ in range(3):
        if tunnel_state not in ["stopped-shutdown", "stopped-ended", "killed", "error"]:
            time.sleep(1) # Give it a moment to update state after stop/kill
            tunnel_info = tunnel_manager.get_tunnel_info(tunnel_id)
            tunnel_state = tunnel_info.get("state")
        else:
            break
    
    # Type-aware health check to confirm the tunnel is actually down
    tunnel_type = _resolve_tunnel_type(tunnel_id)
    if tunnel_type == "eks":
        healthy, _ = k8s_health_check(connection_id)
        stopped = not healthy
    else:
        # For RDS/other: check if the port is still accepting connections
        user_config = load_user_config(USER_CONFIG_PATH)
        uc = user_config.connections.get(tunnel_id)
        port = uc.local_port if uc else 5432
        healthy, _ = tcp_health_check(port=port)
        stopped = not healthy

    return jsonify({"tunnel_id": tunnel_id, "stopped": stopped, "tunnel_state": tunnel_state})


@tunnels_bp.route("/<path:tunnel_id>/logs", methods=["GET"])
def tunnel_logs(tunnel_id):
    """Get unified log entries from a tunnel. Each entry: {ts, type, text, ci}."""
    logs, connection_index = tunnel_manager.get_logs(tunnel_id)
    if logs is None:
        return jsonify({"error": f"Tunnel '{tunnel_id}' not found"}), 404
    return jsonify({"tunnel_id": tunnel_id, "logs": logs, "connection_index": connection_index})


@tunnels_bp.route("/<path:tunnel_id>/logs", methods=["POST"])
def append_tunnel_log(tunnel_id):
    """Append a log entry to a tunnel. Body: {type, text, ts?}. ts fallback is in tunnel_manager."""
    if tunnel_id not in tunnel_manager.list_tunnels():
        return jsonify({"error": f"Tunnel '{tunnel_id}' not found"}), 404

    data = request.get_json(force=True)
    log_type = data.get("type")
    text = data.get("text")
    if not log_type or text is None:
        return jsonify({"error": "Required: type, text"}), 400

    tunnel_manager.append_log(tunnel_id, log_type, text, ts=data.get("ts"))
    return jsonify({"status": "ok"}), 201


@tunnels_bp.route("/<path:tunnel_id>/logs/save", methods=["POST"])
def save_tunnel_logs(tunnel_id):
    """Save backend tunnel logs to a given folder.

    Body: {"folder": "/path/to/dir"}
    The frontend should call /api/consts/browse-folder first to get the folder.
    """
    from datetime import datetime

    data = request.get_json(force=True)
    folder = data.get("folder")
    if not folder:
        return jsonify({"error": "Required: folder (use /api/consts/browse-folder first)"}), 400
    if not os.path.isdir(folder):
        return jsonify({"error": f"Directory not found: {folder}"}), 400

    logs, _ = tunnel_manager.get_logs(tunnel_id)
    if logs is None:
        return jsonify({"error": f"Tunnel '{tunnel_id}' not found"}), 404

    # Format logs for saving
    lines = []
    for entry in logs or []:
        ts = datetime.fromtimestamp(entry["ts"]).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        lines.append(f"[{ts}] [{entry['type']}] {entry['text']}")
    content = "\n".join(lines)

    prefix = f"{tunnel_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    filename = f"{prefix}_system.log"

    try:
        filepath = os.path.join(folder, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        return jsonify({"status": "saved", "folder": folder, "prefix": prefix})
    except Exception as e:
        logger.error(f"Failed to save logs for {tunnel_id}: {e}")
        return jsonify({"error": str(e)}), 500


