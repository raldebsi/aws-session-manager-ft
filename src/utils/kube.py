import logging
import threading
from src.utils import logger, run_cmd, update_hosts
from src.utils.managed_process import ManagedProcess
from src.common import tunnel_manager

cmd_logger = logging.getLogger("cmd_logger")

def setup_kubeconfig(profile, cluster_name, region):
    logger.info(f"Updating kubeconfig for {cluster_name}")

    cmd = [
        "aws", "eks", "update-kubeconfig",
        "--name", cluster_name,
        "--region", region,
        "--profile", profile
    ]

    process = run_cmd(cmd)

    for line in process.stdout or []:
        cmd_logger.info(line.strip())

    process.wait()
    return_code = process.returncode
    logger.info(f"Finished updating kubeconfig for {cluster_name} with return code {return_code}")

    k_process = run_cmd(["kubectl", "config", "current-context"])
    if k_process.stdout:
        out = k_process.stdout.read().strip()
        cmd_logger.info(f"Active kubectl context: {out}")
    else:
        cmd_logger.warning("Failed to get active kubectl context")

    k_process.wait()

    return return_code == 0

def get_k8s_nodes():
    """Get the list of Kubernetes nodes using kubectl."""
    process = run_cmd(["kubectl", "get", "nodes", "-o", "name"])
    if not process.stdout:
        return []
    nodes = [line.strip() for line in process.stdout if line.strip()]
    process.wait()
    return nodes


def start_eks_tunnel_shell(
        profile,
        endpoint, bastion,
        cluster_name, region, connection_id: str,
        document_name: str = "AWS-StartPortForwardingSessionToRemoteHost",
        local_port: int = 443, remote_port: int = 443
    ):
    logger.info(f"Starting EKS Tunnel for {cluster_name}")

    logger.info(f"Updating kubeconfig for {cluster_name} as {profile} in {region}")
    if not setup_kubeconfig(profile, cluster_name, region):
        logger.error(f"Failed to update kubeconfig for {cluster_name}. Aborting tunnel setup.")
        return None

    # Update hosts if necessary
    update_hosts(endpoint)

    cmd = [
        "aws",
        "ssm",
        "start-session",
        "--profile",
        profile,
        "--region",
        region,
        "--target",
        bastion,
        "--document-name",
        document_name,
        "--parameters",
        f'{{"host":["{endpoint}"],"portNumber":["{remote_port}"],"localPortNumber":["{local_port}"]}}',
    ]

    random_suffix = threading.get_ident()  # Using thread ID as a simple unique suffix
    tunnel_id = f"{connection_id}-{random_suffix}"
    tunnel_manager.start_tunnel(tunnel_id, connection_id, *cmd)
    logger.info(f"Tunnel started with id: {tunnel_id}")
    return tunnel_id
