from flask import Flask

from api.routes.configs import configs_bp
from api.routes.connections import connections_bp
from api.routes.hosts import hosts_bp
from api.routes.kube import kube_bp
from api.routes.tunnels import tunnels_bp
from api.routes.pipelines import pipelines_bp

def create_app():
    app = Flask(__name__)

    app.register_blueprint(configs_bp)
    app.register_blueprint(connections_bp)
    app.register_blueprint(hosts_bp)
    app.register_blueprint(kube_bp)
    app.register_blueprint(tunnels_bp)
    app.register_blueprint(pipelines_bp)

    @app.route("/health")
    def health():
        return {"status": "ok"}

    return app
