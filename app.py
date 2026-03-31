import atexit
import os


from api import create_app
from src.common import BIND_ALL, DEBUG_MODE, tunnel_manager

shutdown_handler = tunnel_manager.get_shutdown_handler()
atexit.register(shutdown_handler) # Reregister the handler to avoid using the handler's signal calls in werkzeug

app = create_app()

if __name__ == "__main__":
    app_config = {
        "host": "0.0.0.0" if BIND_ALL else "127.0.0.1",
        "port": 8000,
        "debug": DEBUG_MODE,
        "use_reloader": False,
    }
    if DEBUG_MODE:
        app_config.update({
            # "debug": True,
            "host": "0.0.0.0",  # Allow external access in debug mode only
        })

    app.run(host=app_config["host"], port=app_config["port"], debug=app_config["debug"], use_reloader=app_config["use_reloader"])
