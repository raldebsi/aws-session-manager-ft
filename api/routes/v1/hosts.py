from flask import Blueprint, jsonify, request

from src.utils.utils import check_hosts_entry, update_hosts

hosts_bp = Blueprint("hosts", __name__, url_prefix="/hosts")


@hosts_bp.route("/check", methods=["POST"])
def check_host():
    """Check if an endpoint already has a hosts file entry.

    Body: {"endpoint": "some.endpoint.com"}
    """
    data = request.get_json(force=True)
    endpoint = data.get("endpoint")
    if not endpoint:
        return jsonify({"error": "endpoint is required"}), 400

    try:
        result = check_hosts_entry(endpoint)
        return jsonify({
            "endpoint": endpoint,
            "exists": result is not None,
            "resolved_to": result,
        })
    except ValueError as e:
        return jsonify({"error": str(e)}), 409
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@hosts_bp.route("/update", methods=["POST"])
def update_host():
    """Add a 127.0.0.1 hosts entry for the given endpoint if missing.

    Body: {"endpoint": "some.endpoint.com"}
    """
    data = request.get_json(force=True)
    endpoint = data.get("endpoint")
    if not endpoint:
        return jsonify({"error": "endpoint is required"}), 400

    try:
        update_hosts(endpoint)
        return jsonify({"endpoint": endpoint, "status": "ok"})
    except PermissionError as e:
        return jsonify({"error": str(e)}), 403
    except ValueError as e:
        return jsonify({"error": str(e)}), 409
    except Exception as e:
        return jsonify({"error": str(e)}), 500
