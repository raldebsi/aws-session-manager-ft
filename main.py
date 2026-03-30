import sys
import time

from src.common import tunnel_manager, logger, USER_CONFIG_PATH, CONNECTIONS_CONFIG_PATH
from src.models.config import SSMUserConfig, SSMConnectionConfig
from src.utils.data_loaders import load_user_config, load_connections
from src.utils.kube import k8s_health_check, start_eks_tunnel, start_ssm_tunnel
from src.utils.utils import tcp_health_check

tunnel_manager.register_shutdown_handler()

def main():
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

        conn = mapped.connection
        conn_type = (conn.type or "eks").lower()
        is_eks = conn_type == "eks"

        logger.info(f"Starting {conn_type.upper()} tunnel for {mapped.connection_name or mapped.connection_id}")

        if is_eks:
            tunnel_id = start_eks_tunnel(
                profile=mapped.profile,
                endpoint=conn.endpoint,
                bastion=mapped.bastion,
                cluster_name=conn.cluster,
                region=conn.region,
                tunnel_connection_id=connection_tunnel_name,
                document_name=conn.document,
                local_port=mapped.local_port,
                remote_port=conn.remote_port,
                kubeconfig_path=mapped.kubeconfig_path,
            )
        else:
            tunnel_id = start_ssm_tunnel(
                profile=mapped.profile,
                endpoint=conn.endpoint,
                bastion=mapped.bastion,
                region=conn.region,
                tunnel_connection_id=connection_tunnel_name,
                document_name=conn.document,
                local_port=mapped.local_port,
                remote_port=conn.remote_port,
            )

        if tunnel_id is None:
            print("Failed to start tunnel. Check logs for details.")
            continue

        if tunnel_id == "":
            print("Tunnel for this connection is already running.")
            continue

        # Wait for readiness
        timeout = 15
        start_time = time.time()
        ready = False
        while not ready and (time.time() - start_time) < timeout:
            logs, ci = tunnel_manager.get_logs(tunnel_id)
            if logs:
                for entry in reversed(logs):
                    if entry.get("ci") != ci:
                        break
                    if entry.get("type") == "stdout" and "Waiting for connections" in entry.get("text", ""):
                        ready = True
                        break
            if not ready:
                time.sleep(1)

        if not ready:
            logger.error("Timeout waiting for tunnel to start.")
            continue

        print("Tunnel started successfully.")

        # Type-aware health check
        if is_eks:
            print("Verifying Kubernetes connection...")
            try:
                healthcheck, healthcheck_output = k8s_health_check(
                    context=connection_tunnel_name,
                    kubeconfig_path=mapped.kubeconfig_path,
                )
                if healthcheck:
                    print("Kubernetes Connection Verified.")
                else:
                    print(f"Kubernetes health check failed: {healthcheck_output}")
            except Exception as e:
                print(f"Error verifying Kubernetes connection: {e}")
        else:
            print(f"Verifying {conn_type.upper()} connectivity on port {mapped.local_port}...")
            try:
                healthy, detail = tcp_health_check(port=mapped.local_port, timeout=5)
                if healthy:
                    print(f"Service connectivity verified: {detail}")
                else:
                    print(f"Service connectivity check failed: {detail}")
            except Exception as e:
                print(f"Error verifying service connectivity: {e}")

if __name__ == "__main__":
    main()
