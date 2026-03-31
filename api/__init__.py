import logging
import os
import sys
import time

from flask import Flask, jsonify, render_template, request as flask_request

from api.routes.aws import aws_bp
from api.routes.configs import configs_bp
from api.routes.connections import connections_bp
from api.routes.groups import groups_bp
from api.routes.consts import consts_bp
from api.routes.hosts import hosts_bp
from api.routes.kube import kube_bp
from api.routes.pages import pages_bp
from api.routes.sessions import sessions_bp
from api.routes.settings import settings_bp
from api.routes.tunnels import tunnels_bp
from api.routes.pipelines import pipelines_bp

def create_app():
    if hasattr(sys, '_MEIPASS'):
        MEI_PASS_DIR = getattr(sys, '_MEIPASS')
        template_dir = os.path.join(MEI_PASS_DIR, 'templates')
        static_dir = os.path.join(MEI_PASS_DIR, 'static')
    else:
        workspace_root = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
        template_dir = os.path.join(workspace_root, 'templates')
        static_dir = os.path.join(workspace_root, 'static')
    app = Flask(__name__, template_folder=template_dir, static_folder=static_dir)
    app.jinja_env.cache = None  # Disable Jinja template caching

    app.register_blueprint(aws_bp)
    app.register_blueprint(configs_bp)
    app.register_blueprint(groups_bp)
    app.register_blueprint(connections_bp)
    app.register_blueprint(consts_bp)
    app.register_blueprint(hosts_bp)
    app.register_blueprint(kube_bp)
    app.register_blueprint(pages_bp)
    app.register_blueprint(sessions_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(tunnels_bp)
    app.register_blueprint(pipelines_bp)

    _api_logger = logging.getLogger("api")

    @app.before_request
    def log_request():
        path = flask_request.path
        # Skip static files and noisy polling endpoints
        if path.startswith("/static") or path == "/health":
            return
        qs = flask_request.query_string.decode()
        method = flask_request.method
        url = f"{path}?{qs}" if qs else path
        _api_logger.info(f"{method} {url}")

    _cache_version = str(int(time.time()))

    @app.route("/")
    def index():
        return render_template("index.html", cache_version=_cache_version, native=app.config.get("NATIVE_WINDOW", False))

    @app.route("/health")
    def health():
        from src.common import APP_VERSION
        from src.utils.utils import verify_ssm_plugin
        ssm_version = verify_ssm_plugin()
        return jsonify({
            "status": "ok",
            "app_version": APP_VERSION,
            "ssm_installed": ssm_version != "-1",
            "ssm_version": ssm_version if ssm_version != "-1" else None,
        })

    return app
