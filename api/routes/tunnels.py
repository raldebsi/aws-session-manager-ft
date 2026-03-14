import time

from flask import Blueprint, jsonify, request

from src.common import tunnel_manager
from src.utils.kube import k8s_health_check, start_eks_tunnel

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
    
    status = k8s_health_check(connection_id)
    
    return jsonify({"tunnel_id": tunnel_id, "stopped": not status, "tunnel_state": tunnel_state})


@tunnels_bp.route("/<path:tunnel_id>/output", methods=["GET"])
def tunnel_output(tunnel_id):
    """Get stdout output from a tunnel."""
    output = tunnel_manager.get_output(tunnel_id)
    if output is None:
        return jsonify({"error": f"Tunnel '{tunnel_id}' not found or no output"}), 404
    return jsonify({"tunnel_id": tunnel_id, "output": output})


@tunnels_bp.route("/<path:tunnel_id>/errors", methods=["GET"])
def tunnel_errors(tunnel_id):
    """Get stderr output from a tunnel."""
    errors = tunnel_manager.get_errors(tunnel_id)
    if errors is None:
        return jsonify({"error": f"Tunnel '{tunnel_id}' not found or no errors"}), 404
    return jsonify({"tunnel_id": tunnel_id, "errors": errors})
