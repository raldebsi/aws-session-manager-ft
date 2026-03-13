import os
import logging
import yaml

from typing import Optional

from src.utils import logger, run_cmd, update_hosts
from src.common import tunnel_manager

cmd_logger = logging.getLogger("cmd_logger")

def update_kube_cluster_config(config_path, local_server, local_port, cluster_alias: Optional[str] = None):
    """Modify the kubeconfig file to replace the endpoint port with the local port."""
    # Name is optional, when provided it will select only matching name
    config_path = os.path.abspath(os.path.expanduser(config_path))
    with open(config_path, 'r') as f:
        config = yaml.safe_load(f)

    edits = 0
    maps = []

    # Scan clusters to see if any has the same name as the cluster_alias and save its index
    existing_idx = None
    if cluster_alias:
        for idx, cluster in enumerate(config.get('clusters', [])):
            if cluster.get('name') == cluster_alias:
                existing_idx = idx
                break

    for idx, cluster in enumerate(config.get('clusters', [])):
        if existing_idx and idx != existing_idx:
            continue # If cluster_alias is provided, only edit the cluster that matches the alias, if it exists, otherwise edit all clusters that match the server
        if 'cluster' in cluster and 'server' in cluster['cluster']:
            connection_name = cluster.get('name')
            if not connection_name:
                logger.warning(f"Cluster entry missing 'name': {cluster}. Skipping.")
            original_server = cluster['cluster']['server']
            protocol, server = original_server.split("://", 1) if "://" in original_server else ("", original_server)
            if ':' in server:
                host, existing_port = server.rsplit(':', 1)
                if host.lower() != local_server.lower():
                    continue
                if not existing_port.isdigit():
                    logger.warning(f"Unexpected server format (port is not a number): {server}. Skipping.")
                    continue
                if int(existing_port) == int(local_port):
                    logger.info(f"Server {server} already uses local port {local_port}.")
                    # Continue anyway to allow name remapping in context
                logger.info(f"Updating kubeconfig server port from {existing_port} to {local_port}")
                server = host
            else:
                if server.lower() != local_server.lower():
                    continue

            if connection_name and ('aws:eks:' not in connection_name or ':cluster/' not in connection_name):
                # Only allow clusters that use default name
                if existing_idx and connection_name != cluster_alias:
                    logger.info("Skipping cluster with custom name")
                    continue

            new_server = f"{server}:{local_port}"
            if protocol:
                new_server = f"{protocol}://{new_server}"
            
            logger.info(f"Updating kubeconfig server from {original_server} to {new_server}")

            cluster['cluster']['server'] = new_server
            if cluster_alias: # To rename if alias mismatch
                cluster['name'] = cluster_alias
                maps.append(connection_name)
            edits += 1

    # rename contexts that match the cluster name if cluster_alias is provided
    if maps:
        for context in config.get('contexts', []):
            context_name = context.get('name')
            if context_name in maps:
                old_name = context['context']['cluster']
                context['context']['cluster'] = cluster_alias
                logger.info(f"Renamed cluster in '{context_name}' from '{old_name}' to '{cluster_alias}'")
                edits += 1

    if edits or maps:
        logger.info("Saving updated kubeconfig with local port changes.")
        with open(config_path, 'w') as f:
            yaml.safe_dump(config, f)

    return edits

def setup_kubeconfig(profile, cluster_name, region, context_alias = None):
    logger.info(f"Updating kubeconfig for {cluster_name} in {region} as {profile}")
    cmd = [
        "aws", "eks", "update-kubeconfig",
        "--name", cluster_name,
        "--region", region,
        "--profile", profile,
    ]
    if context_alias:
        cmd += ["--alias", context_alias]

    process = run_cmd(cmd)

    for line in process.stdout or []:
        cmd_logger.info(line.strip())

    process.wait()
    return_code = process.returncode
    if return_code == 0:
        logger.info(f"Finished updating kubeconfig for {cluster_name} successfully.")
    else:
        output = process.stdout.read() if process.stdout else ""
        error_output = process.stderr.read() if process.stderr else ""
        logger.error(f"Error updating kubeconfig for {cluster_name}. Return code: {return_code}.\nOutput: {output}.\nError Output: {error_output}")
        return return_code == 0

    active_context = get_k8s_current_context()
    if active_context:
        logger.info(f"Active Kubernetes context after update: {active_context}")
    else:
        logger.warning("Could not determine active Kubernetes context after update.")
    
    return return_code == 0

def get_k8s_current_context():
    """Get the current Kubernetes context using kubectl."""
    process = run_cmd(["kubectl", "config", "current-context"])
    if not process.stdout:
        return None
    context = process.stdout.read().strip()
    process.wait()
    return context

def get_k8s_nodes():
    """Get the list of Kubernetes nodes using kubectl."""
    process = run_cmd(["kubectl", "get", "nodes", "-o", "name"])
    if not process.stdout:
        return []
    nodes = [line.strip() for line in process.stdout if line.strip()]
    process.wait()
    return nodes


def start_eks_tunnel(
        profile,
        endpoint, bastion,
        cluster_name, region, tunnel_connection_id: str, connection_id: Optional[str] = None,
        document_name: str = "AWS-StartPortForwardingSessionToRemoteHost",
        local_port: int = 443, remote_port: int = 443,
        kubeconfig_path: Optional[str] = None,
    ):
    logger.info(f"Starting EKS Tunnel for {cluster_name}")

    if not setup_kubeconfig(profile, cluster_name, region, context_alias=tunnel_connection_id):
        logger.error(f"Failed to update kubeconfig for {cluster_name}. Aborting tunnel setup.")
        return None

    # Update hosts if necessary
    update_hosts(endpoint)

    if kubeconfig_path: # Update the config file
        if update_kube_cluster_config(
            kubeconfig_path,
            local_server=endpoint,
            local_port=local_port,
            cluster_alias=tunnel_connection_id,
        ):
            logger.info(f"Kubeconfig updated to point to local port {local_port} for cluster {cluster_name}")
        else:
            logger.info(f"No changes made to kubeconfig for {cluster_name}.")
    else:
        if local_port != 443:
            logger.warning("No kubeconfig path provided, but local port is not default 443. Ensure your kubeconfig is configured to point to the correct local port.")

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

    tunnel_id = tunnel_manager.start_tunnel(tunnel_connection_id, *cmd)
    logger.info(f"Tunnel started with id: {tunnel_id}")
    return tunnel_id
