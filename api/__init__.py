from flask import Flask, render_template
import os
import sys

from api.routes.configs import configs_bp
from api.routes.connections import connections_bp
from api.routes.consts import consts_bp
from api.routes.hosts import hosts_bp
from api.routes.kube import kube_bp
from api.routes.pages import pages_bp
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

    app.register_blueprint(configs_bp)
    app.register_blueprint(connections_bp)
    app.register_blueprint(consts_bp)
    app.register_blueprint(hosts_bp)
    app.register_blueprint(kube_bp)
    app.register_blueprint(pages_bp)
    app.register_blueprint(tunnels_bp)
    app.register_blueprint(pipelines_bp)

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/health")
    def health():
        return {"status": "ok"}

    return app
