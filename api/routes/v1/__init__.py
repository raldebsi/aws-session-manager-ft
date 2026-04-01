from flask import Blueprint

from api.routes.v1.aws import aws_bp
from api.routes.v1.configs import configs_bp
from api.routes.v1.connections import connections_bp
from api.routes.v1.groups import groups_bp
from api.routes.v1.consts import consts_bp
from api.routes.v1.hosts import hosts_bp
from api.routes.v1.kube import kube_bp
from api.routes.v1.pages import pages_bp
from api.routes.v1.sessions import sessions_bp
from api.routes.v1.settings import settings_bp
from api.routes.v1.tunnels import tunnels_bp
from api.routes.v1.pipelines import pipelines_bp

v1_bp = Blueprint("v1", __name__, url_prefix="/api/v1")

v1_bp.register_blueprint(aws_bp)
v1_bp.register_blueprint(configs_bp)
v1_bp.register_blueprint(connections_bp)
v1_bp.register_blueprint(groups_bp)
v1_bp.register_blueprint(consts_bp)
v1_bp.register_blueprint(hosts_bp)
v1_bp.register_blueprint(kube_bp)
v1_bp.register_blueprint(pages_bp)
v1_bp.register_blueprint(sessions_bp)
v1_bp.register_blueprint(settings_bp)
v1_bp.register_blueprint(tunnels_bp)
v1_bp.register_blueprint(pipelines_bp)
