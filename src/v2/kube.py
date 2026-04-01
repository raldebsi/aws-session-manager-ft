"""V2 Kubernetes functions — pure library replacements for kubectl/aws subprocess calls."""

import os
from typing import Optional

import boto3
import yaml
from kubernetes import client, config as k8s_config

from src.common import logger
from src.utils.utils import resolve_absolute_path


# --- Item 4: setup_kubeconfig via boto3 (replaces aws eks update-kubeconfig) ---

def _upsert_by_name(items: list, name: str, entry: dict):
    """Insert or replace a named entry in a kubeconfig list."""
    for i, item in enumerate(items):
        if item.get("name") == name:
            items[i] = entry
            return
    items.append(entry)


def setup_kubeconfig(
    profile: str,
    cluster_name: str,
    region: str,
    context_alias: Optional[str] = None,
    kubeconfig_path: Optional[str] = None,
) -> bool:
    """Fetch EKS cluster info via boto3 and write/update the kubeconfig file.

    Replicates: aws eks update-kubeconfig --name X --region Y --profile Z [--kubeconfig PATH] [--alias ALIAS]
    """
    logger.info(f"Updating kubeconfig for {cluster_name} in {region} as {profile}")

    try:
        session = boto3.Session(profile_name=profile, region_name=region)
        eks = session.client("eks")
        cluster_info = eks.describe_cluster(name=cluster_name)["cluster"]
    except Exception as e:
        logger.error(f"Failed to describe EKS cluster {cluster_name}: {e}")
        return False

    endpoint = cluster_info["endpoint"]
    ca_data = cluster_info["certificateAuthority"]["data"]
    arn = cluster_info["arn"]

    alias = context_alias or arn
    kubeconfig_path = resolve_absolute_path(kubeconfig_path or "~/.kube/config")

    # Load existing or create empty kubeconfig
    if os.path.exists(kubeconfig_path):
        with open(kubeconfig_path, "r") as f:
            kube_config = yaml.safe_load(f) or {}
    else:
        kube_config = {}

    kube_config.setdefault("apiVersion", "v1")
    kube_config.setdefault("kind", "Config")
    kube_config.setdefault("clusters", [])
    kube_config.setdefault("contexts", [])
    kube_config.setdefault("users", [])

    # Upsert cluster entry
    cluster_entry = {
        "name": alias,
        "cluster": {
            "server": endpoint,
            "certificate-authority-data": ca_data,
        },
    }
    _upsert_by_name(kube_config["clusters"], alias, cluster_entry)

    # Upsert user entry (exec-based token via aws eks get-token)
    user_entry = {
        "name": alias,
        "user": {
            "exec": {
                "apiVersion": "client.authentication.k8s.io/v1beta1",
                "command": "aws",
                "args": [
                    "eks", "get-token",
                    "--cluster-name", cluster_name,
                    "--region", region,
                    "--profile", profile,
                ],
                "interactiveMode": "Never",
            }
        },
    }
    _upsert_by_name(kube_config["users"], alias, user_entry)

    # Upsert context entry
    context_entry = {
        "name": alias,
        "context": {"cluster": alias, "user": alias},
    }
    _upsert_by_name(kube_config["contexts"], alias, context_entry)

    kube_config["current-context"] = alias

    os.makedirs(os.path.dirname(kubeconfig_path), exist_ok=True)
    with open(kubeconfig_path, "w") as f:
        yaml.safe_dump(kube_config, f)

    logger.info(f"Finished updating kubeconfig for {cluster_name} successfully.")

    active_context = get_k8s_current_context(kubeconfig_path=kubeconfig_path)
    if active_context:
        logger.info(f"Active Kubernetes context after update: {active_context}")
    else:
        logger.warning("Could not determine active Kubernetes context after update.")

    return True


# --- update_kube_cluster_config (ported from v1, no subprocess, all matching rules preserved) ---

def update_kube_cluster_config(
    config_path: str,
    local_server: str,
    local_port: int,
    cluster_alias: Optional[str] = None,
) -> bool:
    """Modify a kubeconfig file to point a matching cluster entry at a local tunnel port.

    Matching rules (evaluated per cluster entry, in order):
    1. Parse server URL into protocol, host, port.
    2. If port is not a digit, skip the entry.
    3. Determine server match:
       - If tls-server-name exists: match when tls-server-name == local_server AND
         host is localhost/127.0.0.1/0.0.0.0.
       - Otherwise: match when host == local_server.
    4. Skip entries that don't match the server.
    5. Bucket candidates by priority:
       a. same_name: cluster name == cluster_alias (if alias provided). Always eligible.
       b. same_port: AWS default ARN name AND (port matches OR port is absent).
       c. Entries with custom (non-ARN) names that don't match the alias are skipped.
       d. AWS default ARN entries with a different non-443 port are skipped.

    First entry from same_name, then same_port is selected.
    The selected entry is rewritten to https://127.0.0.1:<local_port> with tls-server-name
    set for SNI passthrough.
    """
    config_path = resolve_absolute_path(config_path)
    with open(config_path, "r") as f:
        config = yaml.safe_load(f)

    cluster_table: dict[int, dict] = {}
    edit_candidate_indices: dict[str, list[int]] = {
        "no_port": [],
        "same_port": [],
        "same_name": [],
    }

    for idx, cluster in enumerate(config.get("clusters", [])):
        cluster_name = cluster.get("name")
        cluster_server = cluster.get("cluster", {}).get("server")
        if "://" in cluster_server:
            cluster_protocol, cluster_host = cluster_server.split("://", 1)
        else:
            cluster_protocol = None
            cluster_host = cluster_server

        if ":" in cluster_host:
            cluster_host, cluster_port_str = cluster_host.rsplit(":", 1)
            if not cluster_port_str.isdigit():
                logger.warning(
                    f"Unexpected server format (port is not a number): {cluster_host}. Skipping."
                )
                continue
            cluster_port: Optional[str] = cluster_port_str
        else:
            cluster_port = None

        is_aws_default_name = bool(
            cluster_name
            and cluster_name.startswith("arn:aws:eks:")
            and ":cluster/" in cluster_name
        )
        has_same_port = int(cluster_port) == int(local_port) if cluster_port else False
        has_same_name = cluster_name == cluster_alias if cluster_alias else False
        tls_server_name = cluster["cluster"].get("tls-server-name")
        if tls_server_name:
            has_same_server = tls_server_name.lower() == local_server.lower()
            has_same_server = has_same_server and cluster_host in [
                "localhost", "127.0.0.1", "0.0.0.0",
            ]
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

        # Same name always wins
        if has_same_name:
            edit_candidate_indices["same_name"].append(idx)
            continue
        elif not is_aws_default_name:
            # Do not edit entries with custom names
            continue

        # AWS default name: check port eligibility
        if has_same_port:
            edit_candidate_indices["same_port"].append(idx)
            continue
        else:
            if cluster_port:
                if int(cluster_port) != 443:
                    # Different non-443 port — skip even for TLS SNI localhost entries.
                    # Another tool (e.g. Lens) may have its own tunnel on a different port
                    # pointing at the same endpoint; overwriting it would break their setup.
                    continue
                # Port is 443 but local_port differs — falls through (not added)
            else:
                edit_candidate_indices["same_port"].append(idx)
                continue

    # Priority: Same Name > Same Port > No Port
    edit_indices = (
        edit_candidate_indices["same_name"]
        + edit_candidate_indices["same_port"]
        + edit_candidate_indices["no_port"]
    )
    if not edit_indices:
        logger.error("No matching clusters found or all clusters are edited")
        return False

    next_idx = edit_indices[0]
    cluster = config["clusters"][next_idx]

    cluster["cluster"]["server"] = f"https://127.0.0.1:{local_port}"  # tls local mode
    cluster["cluster"]["tls-server-name"] = local_server  # SNI passthrough
    edited = None
    if cluster_alias:
        cluster["name"] = cluster_alias
        edited = cluster_alias

    # Rename contexts that reference the renamed cluster
    if edited:
        for context in config.get("contexts", []):
            context_name = context.get("name")
            if context_name == edited:
                old_name = context["context"]["cluster"]
                context["context"]["cluster"] = cluster_alias
                logger.info(
                    f"Renamed cluster in '{context_name}' from '{old_name}' to '{cluster_alias}'"
                )

    logger.info("Saving updated kubeconfig with local port changes.")
    with open(config_path, "w") as f:
        yaml.safe_dump(config, f)

    return True


# --- Item 5: get_k8s_current_context via kubernetes library ---

def get_k8s_current_context(kubeconfig_path: Optional[str] = None) -> Optional[str]:
    """Get the current Kubernetes context from kubeconfig using the kubernetes library.

    Replicates: kubectl config current-context [--kubeconfig PATH]
    """
    config_file = resolve_absolute_path(kubeconfig_path) if kubeconfig_path else None
    try:
        contexts, active_context = k8s_config.list_kube_config_contexts(config_file=config_file)
        if active_context:
            return active_context.get("name")
        return None
    except Exception as e:
        logger.error(f"Failed to get current K8s context: {e}")
        return None


# --- Item 6: k8s_health_check via kubernetes client ---

def _load_k8s_api_client(
    context: Optional[str] = None,
    kubeconfig_path: Optional[str] = None,
) -> client.ApiClient:
    """Load a kubernetes ApiClient from kubeconfig with optional context override."""
    config_file = resolve_absolute_path(kubeconfig_path) if kubeconfig_path else None
    api_client = k8s_config.new_client_from_config(
        config_file=config_file,
        context=context,
    )
    return api_client


def k8s_health_check(
    context: Optional[str] = None,
    kubeconfig_path: Optional[str] = None,
    timeout: int = 10,
) -> tuple[bool, str]:
    """Check if Kubernetes cluster is reachable via /healthz endpoint.

    Replicates: kubectl get --raw /healthz [--context CTX] [--kubeconfig PATH]
    """
    try:
        api_client = _load_k8s_api_client(context=context, kubeconfig_path=kubeconfig_path)
        resp: tuple = api_client.call_api(  # type: ignore[assignment]
            "/healthz", "GET",
            _preload_content=True,
            _request_timeout=timeout,
        )
        # call_api returns (data, status_code, headers) at runtime
        data = resp[0] if resp else b""
        result = data.decode("utf-8").strip() if isinstance(data, bytes) else str(data).strip()
        logger.info(f"Kubernetes health check output: {result}")
        api_client.close()
        return (result == "ok", result)
    except Exception as e:
        logger.error(f"Kubernetes health check failed: {e}")
        return (False, str(e))


# --- Item 7: get_k8s_nodes via kubernetes client ---

def get_k8s_nodes(
    context: Optional[str] = None,
    kubeconfig_path: Optional[str] = None,
    timeout: int = 10,
) -> tuple[list[str], str]:
    """Get the list of Kubernetes nodes.

    Replicates: kubectl get nodes -o name [--context CTX] [--kubeconfig PATH]
    """
    try:
        api_client = _load_k8s_api_client(context=context, kubeconfig_path=kubeconfig_path)
        v1 = client.CoreV1Api(api_client)
        node_list = v1.list_node(_request_timeout=timeout)
        names = [f"node/{n.metadata.name}" for n in node_list.items]
        output = "\n".join(names)
        api_client.close()
        if not names:
            logger.error("No nodes returned from cluster")
            return [], "No nodes found"
        return names, output
    except Exception as e:
        logger.error(f"Failed to get K8s nodes: {e}")
        return [], str(e)
