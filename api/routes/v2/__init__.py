from flask import Blueprint

from api.routes.v2.aws import aws_v2_bp
from api.routes.v2.kube import kube_v2_bp

v2_bp = Blueprint("v2", __name__, url_prefix="/api/v2")

v2_bp.register_blueprint(aws_v2_bp)
v2_bp.register_blueprint(kube_v2_bp)
