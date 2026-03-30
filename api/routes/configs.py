import base64
import json
import os
import platform
import re
import subprocess
import zlib

from flask import Blueprint, jsonify, request

from src.common import CONNECTIONS_CONFIG_PATH, USER_CONFIG_PATH
from src.models.config import SSMConnection, SSMConnectionConfig, SSMUserConfig, SSMUserConnection
from src.utils.data_loaders import load_connections, load_user_config
from src.utils.utils import resolve_absolute_path, save_json

configs_bp = Blueprint("configs", __name__, url_prefix="/api/configs")


def _load_configs():
    user_config: SSMUserConfig = load_user_config(USER_CONFIG_PATH)
    connections: SSMConnectionConfig = load_connections(CONNECTIONS_CONFIG_PATH)
    return user_config, connections


def _slugify(name):
    """Convert a connection name to a URL-safe key."""
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def _check_duplicate_name(user_config, connection_name, exclude_key=None):
    """Check if a connection_name already exists (case-insensitive)."""
    for key, conn in user_config.connections.items():
        if key == exclude_key:
            continue
        if conn.connection_name and conn.connection_name.lower() == connection_name.lower():
            return key
    return None


def _collect_port_warnings(user_config, local_port, exclude_key=None):
    """Collect port conflict warnings (non-fatal)."""
    warnings = []
    for key, conn in user_config.connections.items():
        if key == exclude_key:
            continue
        if conn.local_port == local_port:
            warnings.append(f"Port {local_port} is also used by '{conn.connection_name or key}'")
    return warnings


# ── GET ──────────────────────────────────────────────────────────────────

@configs_bp.route("", methods=["GET"])
def list_connections():
    """List all connections with their details."""
    _, connections = _load_configs()
    return jsonify({k: v.to_dict() for k, v in connections.items()})


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
    """List all user-configured connections."""
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


@configs_bp.route("/user/ports", methods=["GET"])
def list_used_ports():
    """List all local ports currently used by user connections."""
    user_config, _ = _load_configs()
    ports = {}
    for key, conn in user_config.connections.items():
        port_str = str(conn.local_port)
        if port_str not in ports:
            ports[port_str] = []
        ports[port_str].append({
            "connection_key": key,
            "connection_name": conn.connection_name or key
        })
    return jsonify(ports)


# ── CREATE ───────────────────────────────────────────────────────────────

@configs_bp.route("", methods=["POST"])
def create_connection():
    """Create a new connection definition."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body is required"}), 400

    required = ["id", "type", "name", "region", "endpoint"]
    if data.get("type", "").lower() == "eks":
        required.append("cluster")
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400

    # Sanitize ID: lowercase, spaces/underscores to dashes, strip non-alphanumeric
    raw_id = data["id"]
    sanitized_id = re.sub(r'[^a-z0-9-]', '', re.sub(r'[\s_]+', '-', raw_id.lower())).strip('-')
    sanitized_id = re.sub(r'-+', '-', sanitized_id)
    if not sanitized_id:
        return jsonify({"error": "ID must contain at least one alphanumeric character"}), 400
    data["id"] = sanitized_id

    connections_path = resolve_absolute_path(CONNECTIONS_CONFIG_PATH)
    file_path = os.path.join(connections_path, f"{data['id']}.json")

    if os.path.exists(file_path):
        return jsonify({"error": f"Connection '{data['id']}' already exists"}), 409

    connection = SSMConnection(
        id=data["id"],
        type=data["type"],
        name=data["name"],
        cluster=data.get("cluster"),
        region=data["region"],
        endpoint=data["endpoint"],
        document=data.get("document", "AWS-StartPortForwardingSessionToRemoteHost"),
        remote_port=int(data.get("remote_port", 0)),
        bastions=data.get("bastions", {})
    )

    save_json(connection.to_dict(), file_path)
    return jsonify(connection.to_dict()), 201


@configs_bp.route("/user", methods=["POST"])
def create_user_connection():
    """Create a new user connection. Key is derived from connection_name."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body is required"}), 400

    required = ["connection_id", "bastion_id", "local_port", "connection_name"]
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400

    user_config, connections = _load_configs()

    # Validate connection_id exists
    if data["connection_id"] not in connections:
        return jsonify({"error": f"Connection '{data['connection_id']}' not found"}), 404

    # Validate bastion_id exists in the connection
    connection = connections[data["connection_id"]]
    if data["bastion_id"] not in connection.bastions:
        return jsonify({"error": f"Bastion '{data['bastion_id']}' not found in connection '{data['connection_id']}'"}), 404

    # Duplicate name check (fatal)
    conn_key = _slugify(data["connection_name"])
    if not conn_key:
        return jsonify({"error": "Connection name produces an empty key. Use alphanumeric characters."}), 400

    dup = _check_duplicate_name(user_config, data["connection_name"])
    if dup or conn_key in user_config.connections:
        return jsonify({"error": f"A user connection named '{data['connection_name']}' already exists"}), 409

    # Port warnings (non-fatal)
    local_port = int(data["local_port"])
    warnings = _collect_port_warnings(user_config, local_port)

    new_conn = SSMUserConnection(
        connection_id=data["connection_id"],
        bastion_id=data["bastion_id"],
        local_port=local_port,
        profile=data.get("profile", "default"),
        connection_name=data["connection_name"],
        description=data.get("description"),
        kubeconfig_path=data.get("kubeconfig_path", user_config.kubeconfig_path)
    )
    user_config.connections[conn_key] = new_conn

    config_path = resolve_absolute_path(USER_CONFIG_PATH)
    save_json(user_config.to_dict(), config_path)

    result = {"key": conn_key, **new_conn.to_dict()}
    if warnings:
        result["warnings"] = warnings
    return jsonify(result), 201


# ── UPDATE ───────────────────────────────────────────────────────────────

@configs_bp.route("/<connection_key>", methods=["PUT"])
def update_connection(connection_key):
    """Update an existing connection definition. ID cannot change."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body is required"}), 400

    connections_path = resolve_absolute_path(CONNECTIONS_CONFIG_PATH)
    file_path = os.path.join(connections_path, f"{connection_key}.json")

    if not os.path.exists(file_path):
        return jsonify({"error": f"Connection '{connection_key}' not found"}), 404

    required = ["type", "name", "region", "endpoint"]
    if data.get("type", "").lower() == "eks":
        required.append("cluster")
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400

    connection = SSMConnection(
        id=connection_key,
        type=data["type"],
        name=data["name"],
        cluster=data.get("cluster"),
        region=data["region"],
        endpoint=data["endpoint"],
        document=data.get("document", "AWS-StartPortForwardingSessionToRemoteHost"),
        remote_port=int(data.get("remote_port", 0)),
        bastions=data.get("bastions", {})
    )

    save_json(connection.to_dict(), file_path)
    return jsonify(connection.to_dict())


@configs_bp.route("/user/<connection_key>", methods=["PUT"])
def update_user_connection(connection_key):
    """Update an existing user connection. Key may change if name changes."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body is required"}), 400

    user_config, connections = _load_configs()

    if connection_key not in user_config.connections:
        return jsonify({"error": f"User connection '{connection_key}' not found"}), 404

    required = ["connection_id", "bastion_id", "local_port", "connection_name"]
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400

    if data["connection_id"] not in connections:
        return jsonify({"error": f"Connection '{data['connection_id']}' not found"}), 404

    connection = connections[data["connection_id"]]
    if data["bastion_id"] not in connection.bastions:
        return jsonify({"error": f"Bastion '{data['bastion_id']}' not found in connection '{data['connection_id']}'"}), 404

    # Compute new key from name
    new_key = _slugify(data["connection_name"])
    if not new_key:
        return jsonify({"error": "Connection name produces an empty key. Use alphanumeric characters."}), 400

    # If the name changed, check that the new key doesn't collide with another entry
    if new_key != connection_key:
        dup = _check_duplicate_name(user_config, data["connection_name"], exclude_key=connection_key)
        if dup or (new_key in user_config.connections and new_key != connection_key):
            return jsonify({"error": f"A user connection named '{data['connection_name']}' already exists"}), 409

    local_port = int(data["local_port"])
    warnings = _collect_port_warnings(user_config, local_port, exclude_key=connection_key)

    updated = SSMUserConnection(
        connection_id=data["connection_id"],
        bastion_id=data["bastion_id"],
        local_port=local_port,
        profile=data.get("profile", "default"),
        connection_name=data["connection_name"],
        description=data.get("description"),
        kubeconfig_path=data.get("kubeconfig_path", user_config.kubeconfig_path)
    )

    # Remove old key if name changed, insert under new key
    if new_key != connection_key:
        del user_config.connections[connection_key]
    user_config.connections[new_key] = updated

    config_path = resolve_absolute_path(USER_CONFIG_PATH)
    save_json(user_config.to_dict(), config_path)

    result = {"key": new_key, **updated.to_dict()}
    if warnings:
        result["warnings"] = warnings
    return jsonify(result)


# ── DELETE ───────────────────────────────────────────────────────────────

@configs_bp.route("/<connection_key>", methods=["DELETE"])
def delete_connection(connection_key):
    """Delete a connection definition file."""
    connections_path = resolve_absolute_path(CONNECTIONS_CONFIG_PATH)
    file_path = os.path.join(connections_path, f"{connection_key}.json")

    if not os.path.exists(file_path):
        return jsonify({"error": f"Connection '{connection_key}' not found"}), 404

    os.remove(file_path)
    return jsonify({"deleted": connection_key})


@configs_bp.route("/user/<connection_key>", methods=["DELETE"])
def delete_user_connection(connection_key):
    """Delete a user connection from user.json."""
    user_config, _ = _load_configs()

    if connection_key not in user_config.connections:
        return jsonify({"error": f"User connection '{connection_key}' not found"}), 404

    del user_config.connections[connection_key]

    config_path = resolve_absolute_path(USER_CONFIG_PATH)
    save_json(user_config.to_dict(), config_path)

    return jsonify({"deleted": connection_key})


# ── SHARE / IMPORT ───────────────────────────────────────────────────────

@configs_bp.route("/share", methods=["POST"])
def share_config():
    """Encode a config as base64(zlib(json)) for sharing."""
    data = request.get_json()
    if not data or "key" not in data or "kind" not in data:
        return jsonify({"error": "Required: key, kind (connection|user)"}), 400

    kind = data["kind"]
    key = data["key"]

    if kind == "connection":
        _, connections = _load_configs()
        conn = connections.get(key)
        if not conn:
            return jsonify({"error": f"Connection '{key}' not found"}), 404
        config_data = conn.to_dict()
    elif kind == "user":
        user_config, _ = _load_configs()
        user_conn = user_config.connections.get(key)
        if not user_conn:
            return jsonify({"error": f"User connection '{key}' not found"}), 404
        config_data = user_conn.to_dict()
    else:
        return jsonify({"error": "kind must be 'connection' or 'user'"}), 400

    payload = {"kind": kind, "config": config_data}
    raw = json.dumps(payload, separators=(',', ':'))
    compressed = zlib.compress(raw.encode('utf-8'))
    encoded = base64.urlsafe_b64encode(compressed).decode('ascii')

    return jsonify({"encoded": encoded})


@configs_bp.route("/share/decode", methods=["POST"])
def decode_share_string():
    """Decode a base64(zlib(json)) share string without importing."""
    data = request.get_json()
    if not data or "encoded" not in data:
        return jsonify({"error": "Required: encoded"}), 400

    try:
        compressed = base64.urlsafe_b64decode(data["encoded"])
        raw = zlib.decompress(compressed).decode('utf-8')
        payload = json.loads(raw)
    except Exception as e:
        return jsonify({"error": f"Failed to decode: {e}"}), 400

    kind = payload.get("kind")
    config_data = payload.get("config")
    if not kind or not config_data:
        return jsonify({"error": "Encoded data must contain 'kind' and 'config'"}), 400

    return jsonify({"kind": kind, "config": config_data})


@configs_bp.route("/import", methods=["POST"])
def import_config():
    """Import a config from an encoded string or raw JSON."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body is required"}), 400

    # Path 1: encoded string
    if "encoded" in data:
        try:
            compressed = base64.urlsafe_b64decode(data["encoded"])
            raw = zlib.decompress(compressed).decode('utf-8')
            payload = json.loads(raw)
        except Exception as e:
            return jsonify({"error": f"Failed to decode: {e}"}), 400

        kind = payload.get("kind")
        config_data = payload.get("config")
        if not kind or not config_data:
            return jsonify({"error": "Encoded data must contain 'kind' and 'config'"}), 400

    # Path 2: raw JSON with auto-detection
    elif "config" in data:
        config_data = data["config"]
        kind = data.get("kind")
        if not kind:
            kind = _detect_kind(config_data)
            if not kind:
                return jsonify({"error": "Could not detect config kind. Provide 'kind' explicitly."}), 400
    else:
        return jsonify({"error": "Provide 'encoded' string or 'config' object"}), 400

    # Forward to the appropriate create logic
    if kind == "connection":
        required = ["id", "type", "name", "region", "endpoint"]
        if config_data.get("type", "").lower() == "eks":
            required.append("cluster")
        missing = [f for f in required if not config_data.get(f)]
        if missing:
            return jsonify({"error": f"Missing required fields for connection: {', '.join(missing)}"}), 400

        connections_path = resolve_absolute_path(CONNECTIONS_CONFIG_PATH)
        file_path = os.path.join(connections_path, f"{config_data['id']}.json")
        if os.path.exists(file_path):
            return jsonify({"error": f"Connection '{config_data['id']}' already exists"}), 409

        connection = SSMConnection(
            id=config_data["id"],
            type=config_data["type"],
            name=config_data["name"],
            cluster=config_data.get("cluster"),
            region=config_data["region"],
            endpoint=config_data["endpoint"],
            document=config_data.get("document", "AWS-StartPortForwardingSessionToRemoteHost"),
            remote_port=int(config_data.get("remote_port", 0)),
            bastions=config_data.get("bastions", {})
        )
        save_json(connection.to_dict(), file_path)
        return jsonify({"kind": "connection", "created": connection.to_dict()}), 201

    elif kind == "user":
        required = ["connection_id", "bastion_id", "local_port", "connection_name"]
        missing = [f for f in required if not config_data.get(f)]
        if missing:
            return jsonify({"error": f"Missing required fields for user connection: {', '.join(missing)}"}), 400

        user_config, connections = _load_configs()

        if config_data["connection_id"] not in connections:
            return jsonify({"error": f"Connection '{config_data['connection_id']}' not found"}), 404

        conn_key = _slugify(config_data["connection_name"])
        if not conn_key:
            return jsonify({"error": "Connection name produces an empty key"}), 400

        dup = _check_duplicate_name(user_config, config_data["connection_name"])
        if dup or conn_key in user_config.connections:
            return jsonify({"error": f"A user connection named '{config_data['connection_name']}' already exists"}), 409

        new_conn = SSMUserConnection(
            connection_id=config_data["connection_id"],
            bastion_id=config_data["bastion_id"],
            local_port=int(config_data["local_port"]),
            profile=config_data.get("profile", "default"),
            connection_name=config_data["connection_name"],
            description=config_data.get("description"),
            kubeconfig_path=config_data.get("kubeconfig_path", user_config.kubeconfig_path)
        )
        user_config.connections[conn_key] = new_conn

        config_path = resolve_absolute_path(USER_CONFIG_PATH)
        save_json(user_config.to_dict(), config_path)

        return jsonify({"kind": "user", "created": {"key": conn_key, **new_conn.to_dict()}}), 201

    return jsonify({"error": "kind must be 'connection' or 'user'"}), 400


def _detect_kind(config_data):
    """Auto-detect whether a config dict is a connection or user connection."""
    if all(k in config_data for k in ("cluster", "region", "endpoint")):
        return "connection"
    if all(k in config_data for k in ("connection_id", "bastion_id")):
        return "user"
    return None


# ── BROWSE (open in file explorer) ───────────────────────────────────────

@configs_bp.route("/browse", methods=["POST"])
def browse_config():
    """Open the OS file explorer highlighting the config file."""
    data = request.get_json()
    if not data or "key" not in data or "kind" not in data:
        return jsonify({"error": "Required: key, kind (connection|user)"}), 400

    kind = data["kind"]
    key = data["key"]

    if kind == "connection":
        connections_path = resolve_absolute_path(CONNECTIONS_CONFIG_PATH)
        file_path = os.path.join(connections_path, f"{key}.json")
    elif kind == "user":
        file_path = resolve_absolute_path(USER_CONFIG_PATH)
    else:
        return jsonify({"error": "kind must be 'connection' or 'user'"}), 400

    file_path = os.path.abspath(file_path)
    if not os.path.exists(file_path):
        return jsonify({"error": f"File not found: {file_path}"}), 404

    system = platform.system()
    if system == "Windows":
        subprocess.Popen(['explorer', '/select,', os.path.normpath(file_path)])
    elif system == "Darwin":
        subprocess.Popen(['open', '-R', file_path])
    else:
        subprocess.Popen(['xdg-open', os.path.dirname(file_path)])

    return jsonify({"opened": file_path})


@configs_bp.route("/user/replace-kubeconfig", methods=["POST"])
def replace_all_kubeconfig():
    """Replace kubeconfig_path on all user connections."""
    data = request.get_json()
    if not data or "kubeconfig_path" not in data:
        return jsonify({"error": "Required: kubeconfig_path"}), 400

    new_path = data["kubeconfig_path"]
    user_config, _ = _load_configs()

    count = 0
    for conn in user_config.connections.values():
        conn.kubeconfig_path = new_path
        count += 1

    config_path = resolve_absolute_path(USER_CONFIG_PATH)
    save_json(user_config.to_dict(), config_path)

    return jsonify({"updated": count, "kubeconfig_path": new_path})
