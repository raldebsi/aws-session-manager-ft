import time

from flask import Blueprint, jsonify, request

from src.common import tunnel_manager, USER_CONFIG_PATH, CONNECTIONS_CONFIG_PATH
from src.models.config import SSMConnectionConfig, SSMUserConfig
from src.utils.data_loaders import load_user_config, load_connections
from src.utils.kube import k8s_health_check, start_eks_tunnel, start_ssm_tunnel
from src.utils.utils import get_pid_on_port, kill_pid, tcp_health_check

pipelines_bp = Blueprint("pipelines", __name__, url_prefix="/pipelines")


@pipelines_bp.route("/connect", methods=["POST"])
def full_connect():
    """Full connection pipeline: resolve connection -> start tunnel -> wait for readiness -> verify service.

    Body: {"connection_key": "my-connection-key", "timeout": 15}
    Works for all connection types (EKS, RDS, EC2, custom).
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

    conn = mapped.connection
    conn_type = (conn.type or "eks").lower()
    is_eks = conn_type == "eks"

    steps.append({"step": "resolve_connection", "status": "ok", "type": conn_type})

    # --- Step 2: Start tunnel (type-aware) ---
    if is_eks:
        tunnel_id = start_eks_tunnel(
            profile=mapped.profile,
            endpoint=conn.endpoint,
            bastion=mapped.bastion,
            cluster_name=conn.cluster,
            region=conn.region,
            tunnel_connection_id=connection_key,
            document_name=conn.document,
            local_port=mapped.local_port,
            remote_port=conn.remote_port,
            kubeconfig_path=mapped.kubeconfig_path,
        )
    else:
        tunnel_id = start_ssm_tunnel(
            profile=mapped.profile,
            endpoint=conn.endpoint,
            bastion=mapped.bastion,
            region=conn.region,
            tunnel_connection_id=connection_key,
            document_name=conn.document,
            local_port=mapped.local_port,
            remote_port=conn.remote_port,
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
        logs, ci = tunnel_manager.get_logs(tunnel_id)
        if logs:
            for entry in reversed(logs):
                if entry.get("ci") != ci:
                    break
                if entry.get("type") == "stdout" and "Waiting for connections" in entry.get("text", ""):
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

    # --- Step 4: Verify service connectivity (type-aware) ---
    if is_eks:
        try:
            health, health_output = k8s_health_check(
                context=connection_key,
                kubeconfig_path=mapped.kubeconfig_path,
            )
            if health:
                steps.append({"step": "verify_service", "status": "ok"})
            else:
                steps.append({"step": "verify_service", "status": "warning", "message": "K8s health check failed", "output": health_output})
        except Exception as e:
            steps.append({"step": "verify_service", "status": "error", "message": str(e)})
    else:
        try:
            healthy, detail = tcp_health_check(port=mapped.local_port, timeout=5)
            if healthy:
                steps.append({"step": "verify_service", "status": "ok", "detail": detail})
            else:
                steps.append({"step": "verify_service", "status": "warning", "detail": detail})
        except Exception as e:
            steps.append({"step": "verify_service", "status": "error", "message": str(e)})

    return jsonify({
        "tunnel_id": tunnel_id,
        "connection_key": connection_key,
        "type": conn_type,
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
