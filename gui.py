import atexit
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(__file__))

import webview

from api import create_app
from src.common import BIND_ALL, DEBUG_MODE, tunnel_manager

shutdown_handler = tunnel_manager.get_shutdown_handler()
atexit.register(shutdown_handler)

app = create_app()
app.config["NATIVE_WINDOW"] = True

PORT = 8000


def start_flask():
    host = "0.0.0.0" if BIND_ALL else "127.0.0.1"
    app.run(host=host, port=PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    flask_thread = threading.Thread(target=start_flask, daemon=True)
    flask_thread.start()

    webview.create_window(
        "AWS Sessions Manager",
        f"http://127.0.0.1:{PORT}",
        width=1200,
        height=800,
        min_size=(800, 600),
    )
    webview.start(debug=DEBUG_MODE)
