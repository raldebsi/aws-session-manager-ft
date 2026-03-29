import time

from flask import Blueprint, jsonify, request

from src.common import tunnel_manager, USER_CONFIG_PATH, CONNECTIONS_CONFIG_PATH
from src.utils.kube import k8s_health_check, start_eks_tunnel
from src.utils.data_loaders import load_user_config, load_connections
from src.utils.utils import get_pid_on_port, kill_pid
from src.models.config import SSMUserConfig, SSMConnectionConfig

pipelines_bp = Blueprint("pipelines", __name__, url_prefix="/api/pipelines")


@pipelines_bp.route("/connect", methods=["POST"])
def full_connect():
    """Full connection pipeline: resolve connection -> setup kubeconfig -> update hosts
    -> update kube cluster config -> start tunnel -> wait for readiness -> verify K8s.

    Body: {"connection_key": "my-connection-key"}
    """
    data = request.get_json(force=True)
    connection_key = data.get("connection_key")
    if not connection_key:
        return jsonify({"error": "connection_key is required"}), 400

    steps = []

    # --- Step 1: Load config & resolve connection ---
    try:
        user_config: SSMUserConfig = load_user_config(USER_CONFIG_PATH)
        connections: SSMConnectionConfig = load_connections(CONNECTIONS_CONFIG_PATH)
    except Exception as e:
        return jsonify({"error": f"Failed to load configuration: {e}"}), 500

    user_conn = user_config.connections.get(connection_key)
    if not user_conn:
        return jsonify({"error": f"Connection '{connection_key}' not found in user config"}), 404

    try:
        mapped = user_conn.map_to_connection(connections)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404

    if not mapped or not mapped.connection:
        return jsonify({"error": "Mapped connection is invalid"}), 400

    steps.append({"step": "resolve_connection", "status": "ok"})

    # --- Step 2: Start EKS tunnel (includes kubeconfig setup + hosts update + cluster config) ---
    tunnel_id = start_eks_tunnel(
        profile=mapped.profile,
        endpoint=mapped.connection.endpoint,
        bastion=mapped.bastion,
        cluster_name=mapped.connection.cluster,
        region=mapped.connection.region,
        tunnel_connection_id=connection_key,
        document_name=mapped.connection.document,
        local_port=mapped.local_port,
        remote_port=mapped.connection.remote_port,
        kubeconfig_path=mapped.kubeconfig_path,
    )

    if tunnel_id is None:
        steps.append({"step": "start_tunnel", "status": "failed"})
        return jsonify({"error": "Failed to start tunnel", "steps": steps}), 500

    if tunnel_id == "":
        steps.append({"step": "start_tunnel", "status": "exists"})
        return jsonify({"warning": "Tunnel for this connection is already running", "steps": steps}), 200

    steps.append({"step": "start_tunnel", "status": "ok", "tunnel_id": tunnel_id})

    # --- Step 3: Wait for tunnel readiness ---
    timeout = int(data.get("timeout", 15))
    start_time = time.time()
    ready = False
    while not ready and (time.time() - start_time) < timeout:
        output = tunnel_manager.get_output(tunnel_id)
        for line in output or []:
            if "Waiting for connections" in line:
                ready = True
                break
        if not ready:
            time.sleep(1)

    if not ready:
        steps.append({"step": "wait_ready", "status": "timeout"})
        return jsonify({
            "warning": "Tunnel started but readiness not confirmed within timeout",
            "tunnel_id": tunnel_id,
            "steps": steps,
        }), 202

    steps.append({"step": "wait_ready", "status": "ok"})

    # --- Step 4: Verify Kubernetes connectivity ---
    try:
        health = k8s_health_check(kubeconfig_path=mapped.kubeconfig_path)
        if health:
            steps.append({"step": "verify_k8s", "status": "ok"})
        else:
            steps.append({"step": "verify_k8s", "status": "warning", "message": "Kubernetes health check failed"})
    except Exception as e:
        steps.append({"step": "verify_k8s", "status": "error", "message": str(e)})

    return jsonify({
        "tunnel_id": tunnel_id,
        "connection_key": connection_key,
        "steps": steps,
    })


@pipelines_bp.route("/disconnect", methods=["POST"])
def full_disconnect():
    """Stop a tunnel by connection key or tunnel ID.

    Body: {"tunnel_id": "..."} or {"connection_key": "..."}
    """
    data = request.get_json(force=True)
    tunnel_id = data.get("tunnel_id")

    if not tunnel_id:
        # Try to find by connection_key prefix
        connection_key = data.get("connection_key")
        if not connection_key:
            return jsonify({"error": "tunnel_id or connection_key is required"}), 400

        active = tunnel_manager.list_tunnels()
        matches = [tid for tid in active if tid.startswith(connection_key)]
        if not matches:
            return jsonify({"error": f"No active tunnel found for '{connection_key}'"}), 404
        tunnel_id = matches[0]

    if tunnel_id not in tunnel_manager.list_tunnels():
        return jsonify({"error": f"Tunnel '{tunnel_id}' not found"}), 404

    tunnel_manager.stop_tunnel(tunnel_id)
    return jsonify({"tunnel_id": tunnel_id, "status": "stop_requested"})


@pipelines_bp.route("/kill-port", methods=["POST"])
def kill_by_port():
    """Detect what's running on 127.0.0.1:port and kill it.

    Body: {"port": 9444}
    """
    data = request.get_json(force=True)
    port = data.get("port")
    if not port:
        return jsonify({"error": "port is required"}), 400

    port = int(port)
    pid = get_pid_on_port(port)
    if pid == -1:
        return jsonify({"port": port, "pid": -1, "message": "Nothing listening on this port"})

    killed = kill_pid(pid)
    if killed:
        return jsonify({"port": port, "pid": pid, "killed": True})
    return jsonify({"port": port, "pid": pid, "killed": False, "error": "Failed to kill process"}), 500
