from flask import Blueprint, jsonify, request

from src.common import tunnel_manager
from src.utils.kube import start_eks_tunnel

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

    if tunnel_id:
        return jsonify({"tunnel_id": tunnel_id, "status": "started"})
    return jsonify({"error": "Failed to start tunnel"}), 500


@tunnels_bp.route("/<path:tunnel_id>/stop", methods=["POST"])
def stop_tunnel(tunnel_id):
    """Stop a running tunnel by its ID."""
    if tunnel_id not in tunnel_manager.list_tunnels():
        return jsonify({"error": f"Tunnel '{tunnel_id}' not found"}), 404

    tunnel_manager.stop_tunnel(tunnel_id)
    return jsonify({"tunnel_id": tunnel_id, "status": "stop_requested"})


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
