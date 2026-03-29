import logging
import yaml

from typing import Optional

from src.common import tunnel_manager
from src.utils.utils import get_is_client_privileged, logger, resolve_absolute_path, run_cmd, update_hosts

cmd_logger = logging.getLogger("cmd_logger")


def _add_optional_args(**kwargs) -> list:
    """Build optional CLI args from kwargs. Each becomes --key value. Skips falsy values."""
    args = []
    for key, value in kwargs.items():
        if not value:
            continue
        if key in ["kubeconfig_path", "kubeconfig"]:
            value = resolve_absolute_path(value)
            key = "kubeconfig"
        args += [f"--{key.replace('_', '-').replace(' ', '-')}", str(value)]
    return args


def update_kube_cluster_config(config_path, local_server, local_port, cluster_alias: Optional[str] = None):
    """Modify the kubeconfig file to replace the endpoint port with the local port."""
    # Name is optional, when provided it will select only matching name
    config_path = resolve_absolute_path(config_path)
    with open(config_path, 'r') as f:
        config = yaml.safe_load(f)

    cluster_table = {}
    edited = None
    edit_candidate_indices = {
        "no_port": [],
        "same_port": [],
        "same_name": [],
    }

    for idx, cluster in enumerate(config.get('clusters', [])):
        cluster_name = cluster.get("name")
        cluster_server = cluster.get("cluster", {}).get("server")
        if "://" in cluster_server:
            cluster_protocol, cluster_host = cluster_server.split("://", 1)
        else:
            cluster_protocol = None
            cluster_host = cluster_server

        if ":" in cluster_host:
            cluster_host, cluster_port = cluster_host.rsplit(":", 1)
            if not cluster_port.isdigit():
                logger.warning(f"Unexpected server format (port is not a number): {cluster_host}. Skipping.")
                continue
        else:
            cluster_port = None

        is_aws_default_name = cluster_name and cluster_name.startswith("arn:aws:eks:") and ":cluster/" in cluster_name
        has_same_port = int(cluster_port) == int(local_port) if cluster_port else False
        has_same_name = cluster_name == cluster_alias if cluster_alias else False
        tls_server_name = cluster["cluster"].get("tls-server-name")
        if tls_server_name:
            has_same_server = tls_server_name.lower() == local_server.lower()
            has_same_server = has_same_server and cluster_host in [
                "localhost", "127.0.0.1", "0.0.0.0"
            ]
            # In order for it to be eligible it needs to be a tsl server with the same name connected to localhost,
            # Otherwise it is probably a proxy server that should not be overwritten unless the `name` is the same.
        else:
            has_same_server = cluster_host.lower() == local_server.lower()


        new_server_name = f"{local_server}:{local_port}"
        if cluster_protocol:
            new_server_name = f"{cluster_protocol}://{new_server_name}"

        cluster_table[idx] = {
            "name": cluster_name,
            "server": cluster_server,
            "protocol": cluster_protocol,
            "host": cluster_host,
            "port": cluster_port,
            "tls_server_name": tls_server_name,
            "is_aws_default_name": is_aws_default_name,
            "has_same_port": has_same_port,
            "has_same_name": has_same_name,
            "has_same_server": has_same_server,
            "new_server_name": new_server_name,
        }

        if not has_same_server:
            continue

        # if has same name then overwrite
        if has_same_name:
            edit_candidate_indices["same_name"].append(idx)
            continue
        elif not is_aws_default_name:
            # Do not edit ones with custom names
            continue

        # if has same port, then overwrite name, if different port but port is not 443, leave it as it is
        if has_same_server:
            if has_same_port:
                edit_candidate_indices["same_port"].append(idx)
                continue
            else:
                if cluster_port:
                    if int(cluster_port) != 443:
                        continue  # Different port, leave it
                else:
                    edit_candidate_indices["same_port"].append(idx)
                    # Do not edit it now, wait until other higher priority target is found, else edit
                    continue

    # Priority: Same Name, Same Port, No Port
    edit_indices = (
        edit_candidate_indices["same_name"] +
        edit_candidate_indices["same_port"] +
        edit_candidate_indices["no_port"]
    )
    if not edit_indices:
        logger.error("No matching clusters found or all clusters are edited")
        return False

    next_idx = edit_indices[0]
    cluster_info = cluster_table[next_idx]
    cluster = config["clusters"][next_idx]

    new_server_name = cluster_info["new_server_name"]
    cluster["cluster"]["server"] = f"https://127.0.0.1:{local_port}" # tls local mode
    cluster["cluster"]["tls-server-name"] = local_server # SNI passthrough to ensure certs work
    if cluster_alias:
        cluster["name"] = cluster_alias
        edited = cluster_alias

    # rename contexts that match the cluster name if cluster_alias is provided
    if edited:
        for context in config.get('contexts', []):
            context_name = context.get('name')
            if context_name == edited:
                old_name = context['context']['cluster']
                context['context']['cluster'] = cluster_alias
                logger.info(f"Renamed cluster in '{context_name}' from '{old_name}' to '{cluster_alias}'")

    logger.info("Saving updated kubeconfig with local port changes.")
    with open(config_path, 'w') as f:
        yaml.safe_dump(config, f)

    return True

def setup_kubeconfig(profile, cluster_name, region, context_alias=None, kubeconfig_path=None):
    logger.info(f"Updating kubeconfig for {cluster_name} in {region} as {profile}")
    cmd = [
        "aws", "eks", "update-kubeconfig",
        "--name", cluster_name,
        "--region", region,
        "--profile", profile,
    ]
    cmd += _add_optional_args(kubeconfig_path=kubeconfig_path, alias=context_alias)

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

    active_context = get_k8s_current_context(kubeconfig_path=kubeconfig_path)
    if active_context:
        logger.info(f"Active Kubernetes context after update: {active_context}")
    else:
        logger.warning("Could not determine active Kubernetes context after update.")

    return return_code == 0

def get_k8s_current_context(kubeconfig_path=None):
    """Get the current Kubernetes context using kubectl."""
    cmd = ["kubectl", "config", "current-context"] + _add_optional_args(kubeconfig_path=kubeconfig_path)
    process = run_cmd(cmd)
    output = process.stdout.read().strip() if process.stdout else ""
    if not output:
        logger.error(process.stderr.read() if process.stderr else "No output from kubectl current-context")
        return None
    context = output
    process.wait()
    return context

def k8s_health_check(context=None, kubeconfig_path=None):
    """Check if Kubernetes cluster is reachable by getting the healthz endpoint."""
    cmd = ["kubectl", "get", "--raw", "/healthz"]
    cmd += _add_optional_args(context=context, kubeconfig_path=kubeconfig_path)
    process = run_cmd(cmd)
    output = process.stdout.read().strip() if process.stdout else ""
    if not output:
        logger.error(process.stderr.read() if process.stderr else "No output from kubectl health check")
        return (False, "")

    process.wait()
    logger.info(f"Kubernetes health check output: {output}")
    return (output == "ok", output)


def get_k8s_nodes(context=None, kubeconfig_path=None):
    """Get the list of Kubernetes nodes using kubectl."""
    cmd = ["kubectl", "get", "nodes", "-o", "name"]

    cmd += _add_optional_args(context=context, kubeconfig_path=kubeconfig_path)

    process = run_cmd(cmd)

    output = [line.strip() for line in process.stdout] if process.stdout else []
    if not output:
        logger.error(process.stderr.read() if process.stderr else "No output from kubectl get nodes")
        return []

    nodes = output
    process.wait()
    return nodes


def start_eks_tunnel(
        profile,
        endpoint, bastion,
        cluster_name, region, tunnel_connection_id: str,
        document_name: str = "AWS-StartPortForwardingSessionToRemoteHost",
        local_port: int = 443, remote_port: int = 443,
        kubeconfig_path: Optional[str] = None,
    ):
    logger.info(f"Starting EKS Tunnel for {cluster_name}")

    if tunnel_manager.has_tunnel_for_connection(tunnel_connection_id):
        logger.warning(f"Tunnel already exists for connection_id {tunnel_connection_id}. Cannot start another.")
        return ""

    if not setup_kubeconfig(profile, cluster_name, region, context_alias=tunnel_connection_id, kubeconfig_path=kubeconfig_path):
        logger.error(f"Failed to update kubeconfig for {cluster_name}. Aborting tunnel setup.")
        return None

    # Update hosts if necessary
    if not kubeconfig_path:
        if not get_is_client_privileged():
            raise PermissionError("No kubeconfig path provided and insufficient permissions to modify hosts file. Please run with elevated privileges or provide a kubeconfig path that can be modified.")
        update_hosts(endpoint) # Replace hosts when no control over kubeconfig (requires admin)

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

    tunnel_id = start_ssm_tunnel(
        profile=profile,
        endpoint=endpoint,
        bastion=bastion,
        region=region,
        tunnel_connection_id=tunnel_connection_id,
        document_name=document_name,
        local_port=local_port,
        remote_port=remote_port,
    )

    return tunnel_id

def start_ssm_tunnel(
        profile,
        endpoint, bastion,
        region, tunnel_connection_id: str,
        document_name: str = "AWS-StartPortForwardingSessionToRemoteHost",
        local_port: int = 443, remote_port: int = 443,
):
    if tunnel_manager.has_tunnel_for_connection(tunnel_connection_id):
        logger.warning(f"Tunnel already exists for connection_id {tunnel_connection_id}. Cannot start another.")
        return ""

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
