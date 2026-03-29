import psutil
from flask import Blueprint, jsonify, request

from src.common import tunnel_manager, USER_CONFIG_PATH, CONNECTIONS_CONFIG_PATH
from src.utils.data_loaders import load_user_config, load_connections
from src.utils.kube import k8s_health_check, get_k8s_nodes
from src.utils.utils import get_pid_on_port

sessions_bp = Blueprint("sessions", __name__, url_prefix="/api/sessions")


def _is_owned_pid(our_pid, port_pid):
    """Check if port_pid is our process or any of its descendants."""
    if our_pid == port_pid:
        return True
    try:
        parent = psutil.Process(our_pid)
        children_pids = {c.pid for c in parent.children(recursive=True)}
        return port_pid in children_pids
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


def _build_sessions():
    """Build a unified session list from user connections, connections, and tunnel states."""
    user_config = load_user_config(USER_CONFIG_PATH)
    connections = load_connections(CONNECTIONS_CONFIG_PATH)

    tunnel_infos = {}
    for tid in tunnel_manager.list_tunnels():
        info = tunnel_manager.get_tunnel_info(tid)
        if info:
            tunnel_infos[tid] = info

    sessions = []
    for key, uc in user_config.connections.items():
        conn = connections.get(uc.connection_id)

        # Direct lookup — tunnel_id is now the connection key
        tunnel_info = tunnel_infos.get(key)

        # Map tunnel state to UI status
        status = "inactive"
        tunnel_state = None
        if tunnel_info:
            tunnel_state = tunnel_info.get("state")
            if tunnel_state in ("starting", "running"):
                status = "active"
            elif tunnel_state in ("error",):
                status = "error"
            elif tunnel_state in ("stopping", "app-shutting-down"):
                status = "stopping"
            else:
                status = "inactive"

        # Detect external port usage (port occupied but not by our tunnel)
        port_pid = None
        if status != "active":
            pid = get_pid_on_port(uc.local_port)
            if pid > 0:
                # Check if this PID belongs to our tunnel's process
                our_pid = tunnel_info.get("process_id") if tunnel_info else None
                if our_pid and _is_owned_pid(our_pid, pid):
                    pass  # Stale state — our process is still alive but tunnel state is wrong
                else:
                    status = "port_conflict"
                    port_pid = pid

        sessions.append({
            "key": key,
            "name": uc.connection_name or key,
            "type": conn.type.upper() if conn else "UNKNOWN",
            "description": uc.description or "",
            "localPort": uc.local_port,
            "region": conn.region if conn else "",
            "remotePort": conn.remote_port if conn else 443,
            "connectionId": uc.connection_id,
            "status": status,
            "tunnelId": key,
            "tunnelState": tunnel_state,
            "profile": uc.profile,
            "portPid": port_pid,
        })

    return sessions, user_config, connections


@sessions_bp.route("", methods=["GET"])
def list_sessions():
    """Get all sessions with their current tunnel status."""
    sessions, _, _ = _build_sessions()
    return jsonify(sessions)


@sessions_bp.route("/stats", methods=["GET"])
def get_stats():
    """Get dashboard statistics."""
    sessions, user_config, connections = _build_sessions()

    active = sum(1 for s in sessions if s["status"] == "active")
    errored = sum(1 for s in sessions if s["status"] == "error")
    total_sessions = len(sessions)
    total_connections = len(connections)
    total_user_connections = len(user_config.connections)

    # Unique regions and ports
    regions = set(s["region"] for s in sessions if s["region"])
    ports_in_use = set(s["localPort"] for s in sessions if s["status"] == "active")

    return jsonify({
        "active_sessions": active,
        "total_sessions": total_sessions,
        "total_connections": total_connections,
        "total_user_connections": total_user_connections,
        "errored_sessions": errored,
        "regions": len(regions),
        "ports_in_use": len(ports_in_use),
    })


@sessions_bp.route("/<connection_key>/health", methods=["GET"])
def check_health(connection_key):
    """Check health of a session's port, k8s, and/or tunnel.
    Query param ?check=port|k8s|tunnel to check a single indicator, omit for all."""
    check = request.args.get("check")

    user_config = load_user_config(USER_CONFIG_PATH)
    uc = user_config.connections.get(connection_key)
    if not uc:
        return jsonify({"error": "Session not found"}), 404

    tunnel_info = tunnel_manager.get_tunnel_info(connection_key)
    our_pid = tunnel_info.get("process_id") if tunnel_info else None
    tunnel_state = tunnel_info.get("state") if tunnel_info else None

    result = {}

    # --- Port health ---
    if not check or check == "port":
        pid = get_pid_on_port(uc.local_port)
        if pid <= 0:
            if tunnel_state in ("starting", "running"):
                result["port"] = {"status": "red", "detail": "Port not listening but tunnel reports active"}
            else:
                result["port"] = {"status": "blue", "detail": "Port available"}
        elif our_pid and _is_owned_pid(our_pid, pid):
            result["port"] = {"status": "green", "detail": f"Owned by tunnel (PID {pid})"}
        else:
            result["port"] = {"status": "orange", "detail": f"External process (PID {pid})"}

    # --- K8s health ---
    if not check or check == "k8s":
        connections = load_connections(CONNECTIONS_CONFIG_PATH)
        try:
            mapped = uc.map_to_connection(connections)
        except KeyError:
            mapped = None
        kubeconfig_path = mapped.kubeconfig_path if mapped else None
        context = connection_key  # connection key is used as kubeconfig context alias

        try:
            healthy, health_output = k8s_health_check(context=context, kubeconfig_path=kubeconfig_path)
        except Exception:
            healthy = False
            health_output = ""

        if healthy:
            result["k8s"] = {"status": "green", "detail": "Health check passed"}
        else:
            try:
                nodes = get_k8s_nodes(context=context, kubeconfig_path=kubeconfig_path)
                if nodes:
                    result["k8s"] = {"status": "orange", "detail": f"Healthz failed but {len(nodes)} node(s) reachable", "output": health_output}
                else:
                    result["k8s"] = {"status": "red", "detail": "Unreachable"}
            except Exception:
                result["k8s"] = {"status": "red", "detail": "Unreachable"}

    # --- Tunnel health ---
    if not check or check == "tunnel":
        if not tunnel_info or not tunnel_state:
            result["tunnel"] = {"status": "blue", "detail": "No tunnel"}
        elif tunnel_state in ("starting", "running"):
            result["tunnel"] = {"status": "green", "detail": tunnel_state.capitalize()}
        elif tunnel_state == "error":
            result["tunnel"] = {"status": "red", "detail": "Tunnel error"}
        else:
            result["tunnel"] = {"status": "red", "detail": tunnel_state}

    return jsonify(result)
