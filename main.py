import os
import sys
from src.utils import ensure_elevated_privileges
from src.utils.data_loaders import load_user_config, load_connections
from src.models.config import SSMUserConfig, SSMConnectionConfig
from src.utils.kube import start_eks_tunnel_shell, get_k8s_nodes
from src.common import tunnel_manager, logger

CONFIG_DIR = os.path.join(os.path.dirname(__file__), "config")
USER_CONFIG_PATH = os.path.join(CONFIG_DIR, "user.json")
CONNECTIONS_CONFIG_PATH = os.path.join(CONFIG_DIR, "connections")

tunnel_manager.register_shutdown_handler()

def main():
    ensure_elevated_privileges()
    try:
        user_config: SSMUserConfig = load_user_config(USER_CONFIG_PATH)
        connections: SSMConnectionConfig = load_connections(CONNECTIONS_CONFIG_PATH)
    except Exception as e:
        logger.error(f"Failed to load configuration: {e}")
        sys.exit(1)

    if not user_config.connections:
        logger.error("No connections found in user config.")
        sys.exit(1)

    print("\nAvailable Connections:")
    conn_keys = list(user_config.connections.keys())
    for idx, key in enumerate(conn_keys, 1):
        conn = user_config.connections[key]
        print(f"{idx}) {conn.connection_name or key} - {conn.description or ''}")

    print("q) Quit")

    while True:
        choice = input("Select a connection to start tunnel: ").strip().lower()
        if choice == "q":
            print("Exiting.")
            break
        try:
            idx = int(choice) - 1
            if idx < 0 or idx >= len(conn_keys):
                raise ValueError
        except ValueError:
            print("Invalid selection. Try again.")
            continue

        connection_tunnel_name = conn_keys[idx]
        user_conn = user_config.connections[connection_tunnel_name]

        try:
            mapped = user_conn.map_to_connection(connections)
        except Exception as e:
            logger.error(f"Failed to map user connection: {e}")
            continue

        if not mapped or not mapped.connection:
            logger.error("Mapped connection is invalid.")
            continue

        logger.info(f"Starting tunnel for {getattr(mapped, 'connection_name', None) or getattr(mapped, 'connection_id', None)}")
        tunnel_id = start_eks_tunnel_shell(
            profile=mapped.profile,
            endpoint=mapped.connection.endpoint,
            bastion=mapped.bastion,
            cluster_name=mapped.connection.cluster,
            region=mapped.connection.region,
            connection_id=connection_tunnel_name,
            document_name=mapped.connection.document,
            local_port=mapped.local_port,
            remote_port=mapped.connection.remote_port
        )
        if tunnel_id:
            try:
                nodes = get_k8s_nodes()
                if nodes:
                    print(f"Kubernetes connection verified. Nodes: {', '.join(nodes)}")
                else:
                    print("Kubernetes connection failed: No nodes found.")
            except Exception as e:
                print(f"Error verifying Kubernetes connection: {e}")
        else:
            print("Failed to start tunnel.")

if __name__ == "__main__":
    main()
