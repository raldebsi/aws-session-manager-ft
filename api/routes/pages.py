from flask import Blueprint, render_template, abort

pages_bp = Blueprint("pages", __name__, url_prefix="/api/pages")

ALLOWED_PAGES = {
    "advanced",
    "connections",
    "create_connection",
    "create_user_connection",
    "dashboard",
    "edit_group",
    "import_connection",
    "settings",
}


@pages_bp.route("/<page_name>", methods=["GET"])
def get_page(page_name):
    if page_name not in ALLOWED_PAGES:
        abort(404)
    return render_template(f"pages/{page_name}.html")
