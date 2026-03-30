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
    """Update settings. Only persists values that differ from defaults."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body is required"}), 400

    # Only persist keys whose value differs from the default
    user_overrides = {}
    for key in SETTINGS_DEFAULTS:
        if key in data and data[key] != SETTINGS_DEFAULTS[key]:
            user_overrides[key] = data[key]

    save_settings(user_overrides)
    # Return the merged view (overrides + defaults) so the UI sees full settings
    return jsonify(load_settings())


@settings_bp.route("/defaults", methods=["GET"])
def get_defaults():
    """Get the default settings values."""
    return jsonify(SETTINGS_DEFAULTS)
