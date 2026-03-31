"""Active API routes — the public-facing /api blueprint.

Swap an import from v1 to v2 to upgrade a route; the frontend never changes.
"""

from flask import Blueprint

# ── Routes currently served by v1 ──
from api.routes.v1.configs import configs_bp
from api.routes.v1.connections import connections_bp
from api.routes.v1.consts import consts_bp
from api.routes.v1.groups import groups_bp
from api.routes.v1.hosts import hosts_bp
from api.routes.v1.pages import pages_bp
from api.routes.v1.pipelines import pipelines_bp
from api.routes.v1.sessions import sessions_bp
from api.routes.v1.settings import settings_bp
from api.routes.v1.tunnels import tunnels_bp
from api.routes.v1.aws import aws_bp
from api.routes.v1.kube import kube_bp

active_bp = Blueprint("active", __name__, url_prefix="/api")

active_bp.register_blueprint(aws_bp, name="active.aws")
active_bp.register_blueprint(configs_bp, name="active.configs")
active_bp.register_blueprint(connections_bp, name="active.connections")
active_bp.register_blueprint(consts_bp, name="active.consts")
active_bp.register_blueprint(groups_bp, name="active.groups")
active_bp.register_blueprint(hosts_bp, name="active.hosts")
active_bp.register_blueprint(kube_bp, name="active.kube")
active_bp.register_blueprint(pages_bp, name="active.pages")
active_bp.register_blueprint(pipelines_bp, name="active.pipelines")
active_bp.register_blueprint(sessions_bp, name="active.sessions")
active_bp.register_blueprint(settings_bp, name="active.settings")
active_bp.register_blueprint(tunnels_bp, name="active.tunnels")
