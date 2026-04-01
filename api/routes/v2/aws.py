from flask import Blueprint, jsonify

from src.v2.utils import get_aws_profiles

aws_v2_bp = Blueprint("aws_v2", __name__, url_prefix="/aws")


@aws_v2_bp.route("/profiles", methods=["GET"])
def aws_profiles():
    """Get AWS profiles via boto3 (reads both ~/.aws/credentials and ~/.aws/config)."""
    profiles = get_aws_profiles()
    return jsonify({"profiles": profiles})


@aws_v2_bp.route("/ssm/verify", methods=["GET"])
def ssm_verify():
    """Proxy to v1 — no pure-library replacement exists yet."""
    from api.routes.v1.aws import ssm_verify as v1_ssm_verify
    return v1_ssm_verify()
