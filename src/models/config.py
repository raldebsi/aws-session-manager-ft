from dataclasses import dataclass, field
from typing import Dict, Optional
import json

@dataclass
class SSMUserConnection:
    connection_id: str
    bastion_id: str
    local_port: int = 443
    profile: str = "default"
    connection_name: Optional[str] = None
    description: Optional[str] = None
    kubeconfig_path: Optional[str] = None

    def get_connection(self, connections: Dict[str, "SSMConnection"]) -> "SSMConnection":
        if self.connection_id not in connections:
            raise KeyError(f"Connection ID {self.connection_id} not found in connections config")
        
        return connections[self.connection_id]
    
    def get_bastion(self, connections: Dict[str, "SSMConnection"]) -> str:
        connection = self.get_connection(connections)
        bastion = connection.bastions.get(self.bastion_id)
        if not bastion:
            raise KeyError(f"Bastion ID {self.bastion_id} for connection {self.connection_id} not found in connections config")
        
        return bastion


    def map_to_connection(self, connections: Dict[str, "SSMConnection"]) -> Optional["SSMMappedUserConnection"]:
        if self.connection_id not in connections:
            raise KeyError(f"Connection ID {self.connection_id} not found in connections config")

        connection = self.get_connection(connections)
        bastion = self.get_bastion(connections)

        return SSMMappedUserConnection.from_dict({
            **self.to_dict(),
            'connection': connection.to_dict() if hasattr(connection, 'to_dict') else connection,
            'bastion': bastion
        })

    def to_dict(self) -> dict:
        return {
            'connection_id': self.connection_id,
            'bastion_id': self.bastion_id,
            'local_port': self.local_port,
            'profile': self.profile,
            'connection_name': self.connection_name,
            'description': self.description,
            'kubeconfig_path': self.kubeconfig_path
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SSMUserConnection":
        return cls(**data)

    def to_json(self) -> str:
        return json.dumps(self.to_dict())

    @classmethod
    def from_json(cls, json_str: str) -> "SSMUserConnection":
        return cls.from_dict(json.loads(json_str))

@dataclass
class SSMMappedUserConnection(SSMUserConnection):
    connection: Optional["SSMConnection"] = None
    bastion: Optional[str] = None

    def to_dict(self) -> dict:
        d = super().to_dict()
        d['connection'] = self.connection.to_dict() if self.connection else None
        d['bastion'] = self.bastion
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "SSMMappedUserConnection":
        connection = data.get('connection')
        if isinstance(connection, dict):
            # Use SSMConnection.from_dict if available
            from .config import SSMConnection
            connection = SSMConnection.from_dict(connection)
        return cls(
            connection_id=str(data.get('connection_id', '')),
            bastion_id=str(data.get('bastion_id', '')),
            local_port=data.get('local_port', 443),
            profile=data.get('profile', 'default'),
            connection_name=data.get('connection_name'),
            description=data.get('description'),
            kubeconfig_path=data.get('kubeconfig_path'),
            connection=connection,
            bastion=data.get('bastion')
        )

    def to_json(self) -> str:
        return json.dumps(self.to_dict())

    @classmethod
    def from_json(cls, json_str: str) -> "SSMMappedUserConnection":
        return cls.from_dict(json.loads(json_str))

@dataclass
class SSMUserConfig:

    kubeconfig_path: str = "~/.kube/config"
    last_used_connection: Optional[str] = None
    connections: Dict[str, SSMUserConnection] = field(default_factory=dict)

    def __post_init__(self):
        # Convert any dicts in connections to SSMUserConnection objects
        if self.connections:
            for k, v in list(self.connections.items()):
                if isinstance(v, dict):
                    self.connections[k] = SSMUserConnection(**v)

    def to_dict(self) -> dict:
        return {
            'kubeconfig_path': self.kubeconfig_path,
            'last_used_connection': self.last_used_connection,
            'connections': {k: v.to_dict() for k, v in self.connections.items()}
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SSMUserConfig":
        connections = data.get('connections', {})
        connections = {k: SSMUserConnection.from_dict(v) if isinstance(v, dict) else v for k, v in connections.items()}
        return cls(
            kubeconfig_path=data.get('kubeconfig_path', '~/.kube/config'),
            last_used_connection=data.get('last_used_connection'),
            connections=connections
        )

    def to_json(self) -> str:
        return json.dumps(self.to_dict())

    @classmethod
    def from_json(cls, json_str: str) -> "SSMUserConfig":
        return cls.from_dict(json.loads(json_str))


@dataclass
class SSMConnection:
    id: str
    type: str
    name: str
    cluster: str
    region: str
    endpoint: str
    document: str = "AWS-StartPortForwardingSessionToRemoteHost"
    remote_port: int = 443
    bastions: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'type': self.type,
            'name': self.name,
            'cluster': self.cluster,
            'region': self.region,
            'endpoint': self.endpoint,
            'document': self.document,
            'remote_port': self.remote_port,
            'bastions': self.bastions
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SSMConnection":
        return cls(**data)

    def to_json(self) -> str:
        return json.dumps(self.to_dict())

    @classmethod
    def from_json(cls, json_str: str) -> "SSMConnection":
        return cls.from_dict(json.loads(json_str))


SSMConnectionConfig = Dict[str, SSMConnection]
