import os
import sys

# Ensure project root is on the path so src.* imports work
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api import create_app
from src.common import tunnel_manager

tunnel_manager.register_shutdown_handler()

app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
