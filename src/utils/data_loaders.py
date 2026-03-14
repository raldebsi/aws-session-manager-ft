import logging
import os
from src.models.config import SSMConnection, SSMConnectionConfig, SSMUserConfig
from src.utils.utils import load_json, resolve_absolute_path

logger = logging.getLogger("Data Loader")


def load_user_config(config_path: str) -> SSMUserConfig:
    config_path = resolve_absolute_path(config_path)
    config = load_json(config_path)
    logger.info(f"User configuration loaded from {config_path}")
    return SSMUserConfig(**config)


def load_connections(connections_path: str) -> SSMConnectionConfig:
    connections_path = resolve_absolute_path(connections_path)
    output_dict = {}
    for connection_file in os.listdir(connections_path):
        if connection_file.endswith(".json"):
            logger.info(f"Loading Connection: {connection_file}")
            connection = load_json(os.path.join(connections_path, connection_file))
            output_dict[connection['id']] = SSMConnection(**connection)
    logger.info(f"Connections loaded from {connections_path}")
    return output_dict
