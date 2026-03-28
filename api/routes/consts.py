import pyperclip
from flask import Blueprint, jsonify, request

consts_bp = Blueprint("consts", __name__, url_prefix="/api/consts")

CONSTS = {
    "connection_types": [
        {"value": "eks", "label": "EKS"},
        {"value": "rds", "label": "RDS"},
        {"value": "ec2", "label": "EC2"},
        {"value": "custom", "label": "Custom"},
    ],
    "defaults": {
        "ssm_document": "AWS-StartPortForwardingSessionToRemoteHost",
        "remote_port": 443,
        "profile": "default",
        "kubeconfig_path": "~/.kube/config",
    },
}


@consts_bp.route("", methods=["GET"])
def get_consts():
    return jsonify(CONSTS)


@consts_bp.route("/clipboard", methods=["GET"])
def paste_clipboard():
    """Read the system clipboard and return its contents."""
    try:
        text = pyperclip.paste()
        return jsonify({"text": text})
    except pyperclip.PyperclipException as e:
        return jsonify({"error": str(e)}), 500


@consts_bp.route("/clipboard", methods=["POST"])
def copy_clipboard():
    """Write text to the system clipboard."""
    data = request.get_json()
    if not data or "text" not in data:
        return jsonify({"error": "Required: text"}), 400
    try:
        pyperclip.copy(data["text"])
        return jsonify({"ok": True})
    except pyperclip.PyperclipException as e:
        return jsonify({"error": str(e)}), 500
