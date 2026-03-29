import os
import sys
import time
from src.utils.utils import ensure_elevated_privileges
from src.utils.data_loaders import load_user_config, load_connections
from src.models.config import SSMUserConfig, SSMConnectionConfig
from src.utils.kube import k8s_health_check, start_eks_tunnel
from src.common import tunnel_manager, logger, USER_CONFIG_PATH, CONNECTIONS_CONFIG_PATH

tunnel_manager.register_shutdown_handler()

def main():
    # ensure_elevated_privileges() # No longer using hosts -> not need
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

        logger.info(f"Starting tunnel for {mapped.connection_name or mapped.connection_id}")
        tunnel_id = start_eks_tunnel(
            profile=mapped.profile,
            endpoint=mapped.connection.endpoint,
            bastion=mapped.bastion,
            cluster_name=mapped.connection.cluster,
            region=mapped.connection.region,
            tunnel_connection_id=connection_tunnel_name,
            document_name=mapped.connection.document,
            local_port=mapped.local_port,
            remote_port=mapped.connection.remote_port,
            kubeconfig_path=mapped.kubeconfig_path,
        )

        if tunnel_id is None:
            print("Failed to start tunnel. Check logs for details.")
            continue

        if tunnel_id == "":
            print("Tunnel for this connection is already running.")
            continue

        timeout = 15
        time_now = time.time()
        found = False
        while not found:
            output = tunnel_manager.get_output(tunnel_id)
            for line in output or []:
                if "Waiting for connections" in line:
                    found = True
                    break
            if time.time() - time_now > timeout:
                logger.error("Timeout waiting for tunnel to start.")
                break
            time.sleep(1)
        print("Tunnel started successfully. Verifying Kubernetes connection...")
        if tunnel_id:
            try:
                healthcheck, healthcheck_output = k8s_health_check()
                if not healthcheck:
                    print("Kubernetes health check failed.")
                    continue
                print("Kubernetes Connection Verified.")
            except Exception as e:
                print(f"Error verifying Kubernetes connection: {e}")
        else:
            print("Failed to start tunnel.")

if __name__ == "__main__":
    main()
