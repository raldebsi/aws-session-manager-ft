from flask import Blueprint, jsonify, request

from src.common import load_settings, save_settings, SETTINGS_DEFAULTS

settings_bp = Blueprint("settings", __name__, url_prefix="/api/settings")


@settings_bp.route("", methods=["GET"])
def get_settings():
    """Get current settings (merged with defaults)."""
    settings = load_settings()
    return jsonify(settings)


@settings_bp.route("", methods=["PUT"])
def update_settings():
    """Update settings. Only saves known keys."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body is required"}), 400

    current = load_settings()

    # Only update known keys
    for key in SETTINGS_DEFAULTS:
        if key in data:
            current[key] = data[key]

    save_settings(current)
    return jsonify(current)


@settings_bp.route("/defaults", methods=["GET"])
def get_defaults():
    """Get the default settings values."""
    return jsonify(SETTINGS_DEFAULTS)
