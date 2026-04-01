from flask import Blueprint, jsonify

from src.v2.utils import get_aws_profiles

aws_v2_bp = Blueprint("aws_v2", __name__, url_prefix="/aws")


@aws_v2_bp.route("/profiles", methods=["GET"])
def aws_profiles():
    """Get AWS profiles via boto3 (reads both ~/.aws/credentials and ~/.aws/config)."""
    profiles = get_aws_profiles()
    return jsonify({"profiles": profiles})
