from flask import Blueprint, jsonify

from src.common import tunnel_manager, USER_CONFIG_PATH, CONNECTIONS_CONFIG_PATH
from src.utils.data_loaders import load_user_config, load_connections

sessions_bp = Blueprint("sessions", __name__, url_prefix="/api/sessions")


def _build_sessions():
    """Build a unified session list from user connections, connections, and tunnel states."""
    user_config = load_user_config(USER_CONFIG_PATH)
    connections = load_connections(CONNECTIONS_CONFIG_PATH)

    active_tunnels = tunnel_manager.list_tunnels()
    tunnel_infos = {}
    for tid in active_tunnels:
        info = tunnel_manager.get_tunnel_info(tid)
        if info:
            tunnel_infos[tid] = info

    def find_tunnel_for_key(connection_key):
        """Find the best tunnel matching a connection key. Prefers active tunnels over dead ones."""
        fallback_tid, fallback_info = None, None
        for tid, info in tunnel_infos.items():
            if not tid.startswith(connection_key):
                continue
            state = info.get("state")
            if state in ("starting", "running"):
                return tid, info
            if state in ("stopping", "app-shutting-down"):
                return tid, info
            # Keep most recent dead tunnel as fallback (last in dict = most recently inserted)
            fallback_tid, fallback_info = tid, info
        return fallback_tid, fallback_info

    sessions = []
    for key, uc in user_config.connections.items():
        conn = connections.get(uc.connection_id)

        tunnel_id, tunnel_info = find_tunnel_for_key(key)

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
            "tunnelId": tunnel_id,
            "tunnelState": tunnel_state,
            "profile": uc.profile,
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
