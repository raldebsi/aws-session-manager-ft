from flask import Blueprint, jsonify

from src.common import USER_CONFIG_PATH, CONNECTIONS_CONFIG_PATH
from src.utils.data_loaders import load_user_config, load_connections
from src.models.config import SSMUserConfig, SSMConnectionConfig

connections_bp = Blueprint("connections", __name__, url_prefix="/connections")


def _load_configs():
    user_config: SSMUserConfig = load_user_config(USER_CONFIG_PATH)
    connections: SSMConnectionConfig = load_connections(CONNECTIONS_CONFIG_PATH)
    return user_config, connections


@connections_bp.route("", methods=["GET"])
def list_connections():
    """List all user-configured connections with their details."""
    user_config, _ = _load_configs()

    result = {}
    for key in user_config.connections:
        response = get_connection(key)
        if isinstance(response, tuple):
            result[key] = response[0].get_json()
        else:
            result[key] = response.get_json()

    return jsonify(result)


@connections_bp.route("/<connection_key>", methods=["GET"])
def get_connection(connection_key):
    """Get full details for a single connection by its key."""
    user_config, connections = _load_configs()

    user_conn = user_config.connections.get(connection_key)
    if not user_conn:
        return jsonify({"error": f"Connection '{connection_key}' not found"}), 404

    try:
        mapped = user_conn.map_to_connection(connections)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    if not mapped or not mapped.connection:
        return jsonify({"error": f"Mapped connection for '{connection_key}' is invalid"}), 404

    return jsonify(mapped.to_dict())
