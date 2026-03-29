import time
import threading

from flask import Blueprint, jsonify, request

from src.common import tunnel_manager
from src.utils.kube import k8s_health_check, start_eks_tunnel
from src.utils.utils import logger

tunnels_bp = Blueprint("tunnels", __name__, url_prefix="/api/tunnels")


@tunnels_bp.route("", methods=["GET"])
def list_tunnels():
    """List all active tunnel IDs."""
    return jsonify({"tunnels": tunnel_manager.list_tunnels()})


@tunnels_bp.route("/start", methods=["POST"])
def start_tunnel():
    """Start an SSM EKS tunnel.

    Body: {
        "profile": "default",
        "endpoint": "some.endpoint.com",
        "bastion": "i-0abc123",
        "cluster_name": "my-cluster",
        "region": "us-east-1",
        "tunnel_connection_id": "my-conn",
        "document_name": "AWS-StartPortForwardingSessionToRemoteHost",  (optional)
        "local_port": 443,   (optional)
        "remote_port": 443,  (optional)
        "kubeconfig_path": "~/.kube/config"  (optional)
    }
    """
    data = request.get_json(force=True)

    required = ["profile", "endpoint", "bastion", "cluster_name", "region", "tunnel_connection_id"]
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400

    tunnel_id = start_eks_tunnel(
        profile=data["profile"],
        endpoint=data["endpoint"],
        bastion=data["bastion"],
        cluster_name=data["cluster_name"],
        region=data["region"],
        tunnel_connection_id=data["tunnel_connection_id"],
        document_name=data.get("document_name", "AWS-StartPortForwardingSessionToRemoteHost"),
        local_port=int(data.get("local_port", 443)),
        remote_port=int(data.get("remote_port", 443)),
        kubeconfig_path=data.get("kubeconfig_path"),
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
    
    status, status_out = k8s_health_check(connection_id)
    
    return jsonify({"tunnel_id": tunnel_id, "stopped": not status, "tunnel_state": tunnel_state})


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
    """Save backend tunnel logs via native folder picker. Returns folder + prefix for client to save its own file."""
    from datetime import datetime

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

    # Run folder dialog on a separate thread to avoid blocking Flask
    result = {}
    def open_dialog():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            folder = filedialog.askdirectory(
                title=f"Select folder to save logs — {tunnel_id}",
            )
            root.destroy()
            if folder:
                import os
                filepath = os.path.join(folder, filename)
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(content)
                result["folder"] = folder
                result["prefix"] = prefix
            else:
                result["cancelled"] = True
        except Exception as e:
            result["error"] = str(e)

    dialog_thread = threading.Thread(target=open_dialog)
    dialog_thread.start()
    dialog_thread.join(timeout=60)

    if "error" in result:
        logger.error(f"Failed to save logs for {tunnel_id}: {result['error']}")
        return jsonify({"error": result["error"]}), 500
    if result.get("cancelled"):
        return jsonify({"status": "cancelled"}), 200
    return jsonify({"status": "saved", "folder": result["folder"], "prefix": result["prefix"]})


@tunnels_bp.route("/save-file", methods=["POST"])
def save_file():
    """Generic file save: write content to folder/filename. Body: {folder, filename, content}."""
    import os
    data = request.get_json(force=True)
    folder = data.get("folder")
    filename = data.get("filename")
    content = data.get("content")

    if not folder or not filename or content is None:
        return jsonify({"error": "Required: folder, filename, content"}), 400

    filepath = os.path.join(folder, filename)
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        return jsonify({"status": "saved", "path": filepath})
    except Exception as e:
        logger.error(f"Failed to save file {filepath}: {e}")
        return jsonify({"error": str(e)}), 500
