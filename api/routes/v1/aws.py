from flask import Blueprint, jsonify

from src.utils.utils import get_aws_profiles_by_cli, get_aws_profiles_by_file, verify_ssm_plugin

aws_bp = Blueprint("aws", __name__, url_prefix="/aws")


@aws_bp.route("/profiles", methods=["GET"])
def aws_profiles():
    """Get AWS profiles from credentials file and CLI. Returns deduplicated merged list."""
    file_profiles = get_aws_profiles_by_file()
    cli_profiles = get_aws_profiles_by_cli()
    seen = set()
    merged = []
    for p in file_profiles + cli_profiles:
        if p not in seen:
            seen.add(p)
            merged.append(p)
    return jsonify({"profiles": merged, "sources": {"file": file_profiles, "cli": cli_profiles}})


@aws_bp.route("/profiles/file", methods=["GET"])
def aws_profiles_file():
    """Get AWS profiles from ~/.aws/credentials file."""
    return jsonify({"profiles": get_aws_profiles_by_file()})


@aws_bp.route("/profiles/cli", methods=["GET"])
def aws_profiles_cli():
    """Get AWS profiles using AWS CLI."""
    return jsonify({"profiles": get_aws_profiles_by_cli()})


@aws_bp.route("/ssm/verify", methods=["GET"])
def ssm_verify():
    """Check if the SSM session-manager-plugin is installed and return its version."""
    version = verify_ssm_plugin()
    if version == "-1":
        return jsonify({"installed": False, "version": None}), 200
    return jsonify({"installed": True, "version": version}), 200
