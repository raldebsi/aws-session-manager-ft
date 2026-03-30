import os
import tkinter as tk
from tkinter import filedialog

import pyperclip
from flask import Blueprint, jsonify, request

from src.common import SETTINGS_DEFAULTS
from src.utils.utils import get_pid_on_port, kill_pid, resolve_absolute_path

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
    "field_overrides": {
        "type": {
            "eks": {"remote_port": 443},
            "rds": {"remote_port": 5432},
            "ec2": {"remote_port": 22},
        }
    },
    "settings_schema": {
        "max_log_size": {
            "label": "Max Log Size",
            "hint": "0 = unlimited",
            "type": "number",
            "min": 0,
            "default": SETTINGS_DEFAULTS["max_log_size"],
            "order": 1,
            "group": "Limits",
        },
        "max_tunnels": {
            "label": "Max Tunnels Allowed",
            "hint": "0 = unlimited",
            "type": "number",
            "min": 0,
            "default": SETTINGS_DEFAULTS["max_tunnels"],
            "order": 2,
            "group": "Limits",
        },
        "polling_interval": {
            "label": "Polling Interval (seconds)",
            "type": "number",
            "min": 1,
            "default": SETTINGS_DEFAULTS["polling_interval"],
            "order": 3,
            "group": "Intervals",
        },
        "readiness_timeout": {
            "label": "Tunnel Readiness Timeout (seconds)",
            "type": "number",
            "min": 5,
            "default": SETTINGS_DEFAULTS["readiness_timeout"],
            "order": 4,
            "group": "Intervals",
        },
        "healthcheck_timeout": {
            "label": "Health Check Timeout (seconds)",
            "type": "number",
            "min": 3,
            "default": SETTINGS_DEFAULTS["healthcheck_timeout"],
            "order": 5,
            "group": "Intervals",
        },
        "default_kubeconfig_path": {
            "label": "Default Kube Config Path",
            "hint": "Only for new connections",
            "type": "path",
            "default": SETTINGS_DEFAULTS["default_kubeconfig_path"],
            "order": 6,
            "solo": True,
        },
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


@consts_bp.route("/port/<int:port>/pid", methods=["GET"])
def port_pid(port):
    """Get the PID of the process listening on 127.0.0.1:port."""
    pid = get_pid_on_port(port)
    return jsonify({"port": port, "pid": pid})


@consts_bp.route("/pid/<int:pid>/kill", methods=["POST"])
def pid_kill(pid):
    """Send SIGTERM to a process by PID."""
    if pid <= 0:
        return jsonify({"error": "Invalid PID"}), 400
    success = kill_pid(pid)
    if success:
        return jsonify({"pid": pid, "killed": True})
    return jsonify({"pid": pid, "killed": False, "error": "Failed to kill process"}), 500


@consts_bp.route("/browse-save", methods=["POST"])
def browse_save():
    """Open a native save-as dialog. User picks a folder and names the file.

    Body: {"initial_dir": ".", "default_name": "config", "filetypes": [["YAML", "*.yaml"]]}
    """
    data = request.get_json() or {}
    initial_dir = data.get("initial_dir", ".")
    default_name = data.get("default_name", "config")

    initial_dir = resolve_absolute_path(initial_dir)
    if not os.path.isdir(initial_dir):
        initial_dir = os.getcwd()

    filetypes = data.get("filetypes", [["All files", "*.*"]])

    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        path = filedialog.asksaveasfilename(
            initialdir=initial_dir,
            initialfile=default_name,
            filetypes=filetypes,
        )
        root.destroy()
        return jsonify({"path": path if path else None})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@consts_bp.route("/browse-folder", methods=["POST"])
def browse_folder():
    """Open a native folder picker dialog and return the selected path.

    Body (optional): {"initial_dir": ".", "title": "Select folder"}
    """
    data = request.get_json(silent=True) or {}
    title = data.get("title", "Select folder")
    initial_dir = data.get("initial_dir", ".")

    initial_dir = resolve_absolute_path(initial_dir)
    if not os.path.isdir(initial_dir):
        initial_dir = os.getcwd()

    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        folder = filedialog.askdirectory(title=title, initialdir=initial_dir)
        root.destroy()
        if folder:
            return jsonify({"status": "ok", "folder": folder})
        return jsonify({"status": "cancelled"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@consts_bp.route("/save-file", methods=["POST"])
def save_file():
    """Write content to folder/filename. Body: {folder, filename, content}."""
    data = request.get_json(force=True)
    folder = data.get("folder")
    filename = data.get("filename")
    content = data.get("content")

    if not folder or not filename or content is None:
        return jsonify({"error": "Required: folder, filename, content"}), 400

    filepath = os.path.join(folder, filename)
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        return jsonify({"status": "saved", "path": filepath})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
