import os
import re

from flask import Blueprint, jsonify, request

from src.common import GROUPS_PATH, USER_CONFIG_PATH, CONNECTIONS_CONFIG_PATH
from src.utils.data_loaders import load_user_config, load_connections
from src.utils.utils import load_json, save_json, resolve_absolute_path

groups_bp = Blueprint("groups", __name__, url_prefix="/api/groups")


def _load_groups() -> dict:
    """Load groups from user_groups.json. Returns {group_key: {name, connections: [keys]}}."""
    path = resolve_absolute_path(GROUPS_PATH)
    data = load_json(path)
    return data if data else {}


def _save_groups(groups: dict):
    path = resolve_absolute_path(GROUPS_PATH)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    save_json(groups, path)


def _slugify(name: str) -> str:
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9-]', '', re.sub(r'[\s_]+', '-', name.lower()))).strip('-')


@groups_bp.route("", methods=["GET"])
def list_groups():
    """List all groups."""
    return jsonify(_load_groups())


@groups_bp.route("", methods=["POST"])
def create_group():
    """Create a new group. Body: {name, connections?: [user_connection_keys]}"""
    data = request.get_json()
    if not data or not data.get("name"):
        return jsonify({"error": "name is required"}), 400

    groups = _load_groups()
    key = _slugify(data["name"])
    if not key:
        return jsonify({"error": "Name must contain alphanumeric characters"}), 400
    if key in groups:
        return jsonify({"error": f"Group '{data['name']}' already exists"}), 409

    connections = data.get("connections", [])

    # Validate connection keys exist
    if connections:
        user_config = load_user_config(USER_CONFIG_PATH)
        invalid = [k for k in connections if k not in user_config.connections]
        if invalid:
            return jsonify({"error": f"Unknown user connections: {', '.join(invalid)}"}), 404

    groups[key] = {
        "name": data["name"],
        "connections": connections,
    }
    _save_groups(groups)
    return jsonify({"key": key, **groups[key]}), 201


@groups_bp.route("/<group_key>", methods=["GET"])
def get_group(group_key):
    """Get a single group."""
    groups = _load_groups()
    if group_key not in groups:
        return jsonify({"error": f"Group '{group_key}' not found"}), 404
    return jsonify({"key": group_key, **groups[group_key]})


@groups_bp.route("/<group_key>", methods=["PUT"])
def update_group(group_key):
    """Update a group. Body: {name?, connections?}"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body is required"}), 400

    groups = _load_groups()
    if group_key not in groups:
        return jsonify({"error": f"Group '{group_key}' not found"}), 404

    if "name" in data:
        groups[group_key]["name"] = data["name"]

    if "connections" in data:
        connections = data["connections"]
        if connections:
            user_config = load_user_config(USER_CONFIG_PATH)
            invalid = [k for k in connections if k not in user_config.connections]
            if invalid:
                return jsonify({"error": f"Unknown user connections: {', '.join(invalid)}"}), 404
        groups[group_key]["connections"] = connections

    _save_groups(groups)
    return jsonify({"key": group_key, **groups[group_key]})


@groups_bp.route("/<group_key>", methods=["DELETE"])
def delete_group(group_key):
    """Delete a group."""
    groups = _load_groups()
    if group_key not in groups:
        return jsonify({"error": f"Group '{group_key}' not found"}), 404
    del groups[group_key]
    _save_groups(groups)
    return jsonify({"deleted": group_key})


@groups_bp.route("/<group_key>/add", methods=["POST"])
def add_to_group(group_key):
    """Add a user connection to a group. Body: {connection_key}"""
    data = request.get_json()
    if not data or not data.get("connection_key"):
        return jsonify({"error": "connection_key is required"}), 400

    groups = _load_groups()
    if group_key not in groups:
        return jsonify({"error": f"Group '{group_key}' not found"}), 404

    conn_key = data["connection_key"]
    user_config = load_user_config(USER_CONFIG_PATH)
    if conn_key not in user_config.connections:
        return jsonify({"error": f"User connection '{conn_key}' not found"}), 404

    if conn_key in groups[group_key]["connections"]:
        return jsonify({"error": f"'{conn_key}' is already in this group"}), 409

    # Check port clashes within the group
    new_port = user_config.connections[conn_key].local_port
    for existing_key in groups[group_key]["connections"]:
        existing_conn = user_config.connections.get(existing_key)
        if existing_conn and existing_conn.local_port == new_port:
            existing_name = existing_conn.connection_name or existing_key
            return jsonify({
                "error": f"Port {new_port} clashes with '{existing_name}' already in this group"
            }), 409

    groups[group_key]["connections"].append(conn_key)
    _save_groups(groups)
    return jsonify({"key": group_key, **groups[group_key]})


@groups_bp.route("/<group_key>/remove", methods=["POST"])
def remove_from_group(group_key):
    """Remove a user connection from a group. Body: {connection_key}"""
    data = request.get_json()
    if not data or not data.get("connection_key"):
        return jsonify({"error": "connection_key is required"}), 400

    groups = _load_groups()
    if group_key not in groups:
        return jsonify({"error": f"Group '{group_key}' not found"}), 404

    conn_key = data["connection_key"]
    if conn_key not in groups[group_key]["connections"]:
        return jsonify({"error": f"'{conn_key}' is not in this group"}), 404

    groups[group_key]["connections"].remove(conn_key)
    _save_groups(groups)
    return jsonify({"key": group_key, **groups[group_key]})
