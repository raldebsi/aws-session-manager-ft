from flask import Blueprint, jsonify, request

from src.utils.kube import (
    k8s_health_check,
    setup_kubeconfig,
    update_kube_cluster_config,
    get_k8s_current_context,
    get_k8s_nodes,
)

kube_bp = Blueprint("kube", __name__, url_prefix="/api/kube")


@kube_bp.route("/context", methods=["GET"])
def current_context():
    """Get the current kubectl context."""
    kubeconfig_path = request.args.get("kubeconfig_path") or None
    ctx = get_k8s_current_context(kubeconfig_path=kubeconfig_path)
    if ctx:
        return jsonify({"context": ctx})
    return jsonify({"context": None, "warning": "Could not determine current context"}), 200


@kube_bp.route("/nodes", methods=["GET"])
def list_nodes():
    """Get Kubernetes node names from the current context."""
    try:
        context = request.args.get("context") or None
        kubeconfig_path = request.args.get("kubeconfig_path") or None
        nodes = get_k8s_nodes(context=context, kubeconfig_path=kubeconfig_path)
        return jsonify({"nodes": nodes})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@kube_bp.route("/health", methods=["GET"])
def health_check():
    """Perform a Kubernetes health check."""
    try:
        context = request.args.get("context") or None
        kubeconfig_path = request.args.get("kubeconfig_path") or None
        healthy = k8s_health_check(context=context, kubeconfig_path=kubeconfig_path)
        if healthy:
            return jsonify({"status": "ok"})
        else:
            return jsonify({"status": "unhealthy", "message": "Kubernetes health check failed"}), 503
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@kube_bp.route("/setup", methods=["POST"])
def setup_kube():
    """Run `aws eks update-kubeconfig` for a cluster.

    Body: {
        "profile": "default",
        "cluster_name": "my-cluster",
        "region": "us-east-1",
        "context_alias": "optional-alias",
        "kubeconfig_path": "optional-path"
    }
    """
    data = request.get_json(force=True)
    profile = data.get("profile")
    cluster_name = data.get("cluster_name")
    region = data.get("region")
    context_alias = data.get("context_alias") or None
    kubeconfig_path = data.get("kubeconfig_path") or None

    if not all([profile, cluster_name, region]):
        return jsonify({"error": "profile, cluster_name, and region are required"}), 400

    success = setup_kubeconfig(profile, cluster_name, region, context_alias=context_alias, kubeconfig_path=kubeconfig_path)
    if success:
        return jsonify({"status": "ok", "cluster_name": cluster_name, "region": region})
    return jsonify({"error": "Failed to update kubeconfig"}), 500


@kube_bp.route("/update-cluster-config", methods=["POST"])
def update_cluster_config():
    """Modify an existing kubeconfig to point a cluster at a local port.

    Body: {
        "config_path": "~/.kube/config",
        "local_server": "some.endpoint.com",
        "local_port": 8443,
        "cluster_alias": "optional-alias"
    }
    """
    data = request.get_json(force=True)
    config_path = data.get("config_path")
    local_server = data.get("local_server")
    local_port = data.get("local_port")
    cluster_alias = data.get("cluster_alias")

    if not all([config_path, local_server, local_port]):
        return jsonify({"error": "config_path, local_server, and local_port are required"}), 400

    success = update_kube_cluster_config(config_path, local_server, local_port, cluster_alias=cluster_alias)
    if success:
        return jsonify({"status": "ok"})
    return jsonify({"error": "No matching cluster found or update failed"}), 400
