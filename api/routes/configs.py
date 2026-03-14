from flask import Blueprint, jsonify

from src.common import USER_CONFIG_PATH, CONNECTIONS_CONFIG_PATH
from src.utils.data_loaders import load_user_config, load_connections
from src.models.config import SSMUserConfig, SSMConnectionConfig

configs_bp = Blueprint("configs", __name__, url_prefix="/api/configs")


def _load_configs():
    user_config: SSMUserConfig = load_user_config(USER_CONFIG_PATH)
    connections: SSMConnectionConfig = load_connections(CONNECTIONS_CONFIG_PATH)
    return user_config, connections

@configs_bp.route("", methods=["GET"])
def list_connections():
    """List all user-configured connections with their details."""
    _, connections = _load_configs()

    return jsonify(connections)

@configs_bp.route("/<connection_key>", methods=["GET"])
def get_connection(connection_key):
    """Get full details for a single connection by its key."""
    _, connections = _load_configs()
    conn = connections.get(connection_key)
    if not conn:
        return jsonify({"error": f"Connection '{connection_key}' not found"}), 404
    return jsonify(conn.to_dict())

@configs_bp.route("/user", methods=["GET"])
def list_user_connections():
    """List all user-configured connections"""
    user_config, _ = _load_configs()
    return jsonify(user_config.to_dict()["connections"])


@configs_bp.route("/user/<connection_key>", methods=["GET"])
def get_user_connection(connection_key):
    """Get details for a single user-configured connection by its key."""
    user_config, _ = _load_configs()
    user_conn = user_config.connections.get(connection_key)
    if not user_conn:
        return jsonify({"error": f"Connection '{connection_key}' not found"}), 404
    return jsonify(user_conn.to_dict())
