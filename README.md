# AWS Sessions Manager

A web-based and CLI tool for managing AWS SSM (Systems Manager) port-forwarding tunnels. Supports EKS, RDS, EC2, and custom tunnel types through bastion hosts.

## What it does

- Start/stop AWS SSM tunnels that forward local ports to remote AWS resources through bastion hosts
- Manage multiple connections to different AWS environments
- Automatically configure kubeconfig for EKS clusters to point through the tunnel
- Monitor tunnel status, health checks, and logs in real-time
- Group and organize connections
- Share/import connection configs via encoded strings or clipboard

## Prerequisites

- Python 3.10+
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [Session Manager Plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
- `kubectl` (for EKS connections)
- AWS credentials configured (`~/.aws/credentials` or `~/.aws/config`)

## Setup

Install only what you need:

| File | For | Installs |
|---|---|---|
| `requirements-cli.txt` | CLI only (`main.py`) | psutil, PyYAML |
| `requirements-web.txt` | Web UI (`api/app.py`) | CLI deps + Flask, pyperclip |
| `requirements-gui.txt` | Desktop app (`gui.py`) | Web deps + pywebview |
| `requirements.txt` | Everything | All of the above |

```bash
# Pick one:
pip install -r requirements-cli.txt   # CLI only
pip install -r requirements-web.txt   # Web UI
pip install -r requirements-gui.txt   # Desktop app
pip install -r requirements.txt       # All
```

### Configuration

All configuration lives in the `config/` directory:

| File | Purpose |
|---|---|
| `config/connections/*.json` | Connection definitions (endpoint, cluster, bastions, region) |
| `config/user.json` | Per-user connection preferences (profile, local_port, kubeconfig_path) |
| `config/settings.yaml` | App settings (polling interval, timeouts, limits) |
| `config/user_groups.json` | Connection groups |


### Running the Web UI

```bash
python api/app.py
```

Opens a web UI at `http://127.0.0.1:8000`. Use the sidebar to navigate between Dashboard, Connections, Logs, Advanced, and Settings.

### Running the CLI

```bash
python main.py
```

Presents an interactive menu to select a connection, starts the tunnel, and verifies connectivity.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DEBUG_MODE` | `0` | Enable debug logging |
| `BIND_ALL` | `0` | Listen on `0.0.0.0` instead of `127.0.0.1` |

### Docker

```bash
# Linux / macOS
./run.sh

# Windows
run.cmd
```

Runs the web UI in a container with AWS CLI, session-manager-plugin, and kubectl pre-installed. Mounts `~/.aws` (read-only), `~/.kube` (read-write), and `./config` for persistence. Sets `BIND_ALL=1` so the Flask server is accessible from the host.

## Quirks and notes

- **Clipboard and file dialogs**: The app uses `pyperclip` for clipboard access and `tkinter` for native file/folder dialogs. These require a desktop environment -- they won't work in headless or containerized setups.
- **Kubeconfig modification**: When starting an EKS tunnel, the app modifies your kubeconfig to point the cluster's server at `127.0.0.1:<local_port>` with an SNI extension. This is reverted conceptually when the tunnel stops, but the kubeconfig change persists on disk.
- **Port exclusivity**: Each tunnel binds to a specific local port. If the port is already in use, the tunnel will fail to start. The app can detect and kill processes occupying a port.
- **Platform differences**: Process management uses `os.setsid()` / `SIGINT` on Unix and `CREATE_NEW_PROCESS_GROUP` / `CTRL_BREAK_EVENT` on Windows. The port-detection utility uses `netstat` on Windows and `lsof` on macOS/Linux (with `ss` as a fallback).
- **Hosts file**: For certain connection types, the app can add `127.0.0.1` entries to your system hosts file. This requires elevated privileges.

## API Routes

### AWS (`/api/aws`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/aws/profiles` | List AWS profiles (merged from credentials file and CLI) |
| GET | `/api/aws/profiles/file` | List AWS profiles from `~/.aws/credentials` only |
| GET | `/api/aws/profiles/cli` | List AWS profiles from AWS CLI only |
| GET | `/api/aws/ssm/verify` | Check if session-manager-plugin is installed |

### Connections (`/api/connections`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/connections` | List all user connections with full details |
| GET | `/api/connections/<key>` | Get a single connection's full details |

### Configs (`/api/configs`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/configs` | List all connection definitions |
| GET | `/api/configs/<key>` | Get a single connection definition |
| POST | `/api/configs` | Create a new connection definition |
| PUT | `/api/configs/<key>` | Update a connection definition |
| DELETE | `/api/configs/<key>` | Delete a connection definition |
| GET | `/api/configs/user` | List all user connections |
| GET | `/api/configs/user/<key>` | Get a single user connection |
| GET | `/api/configs/user/ports` | List all local ports in use |
| POST | `/api/configs/user` | Create a new user connection |
| PUT | `/api/configs/user/<key>` | Update a user connection |
| DELETE | `/api/configs/user/<key>` | Delete a user connection |
| POST | `/api/configs/share` | Encode a config for sharing (base64/zlib) |
| POST | `/api/configs/share/decode` | Decode a shared config string |
| POST | `/api/configs/import` | Import a config from encoded string or raw JSON |
| POST | `/api/configs/browse` | Open OS file explorer at the config file |
| POST | `/api/configs/user/replace-kubeconfig` | Bulk-replace kubeconfig_path on all user connections |

### Groups (`/api/groups`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/groups` | List all groups |
| POST | `/api/groups` | Create a new group |
| GET | `/api/groups/<key>` | Get a single group |
| PUT | `/api/groups/<key>` | Update a group |
| DELETE | `/api/groups/<key>` | Delete a group |
| POST | `/api/groups/<key>/add` | Add a connection to a group |
| POST | `/api/groups/<key>/remove` | Remove a connection from a group |

### Tunnels (`/api/tunnels`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/tunnels` | List all active tunnel IDs |
| POST | `/api/tunnels/start` | Start an SSM tunnel (EKS, RDS, EC2, or custom) |
| GET | `/api/tunnels/<id>` | Get tunnel info |
| POST | `/api/tunnels/<id>/stop` | Stop a tunnel and verify it's down |
| GET | `/api/tunnels/<id>/logs` | Get tunnel log entries |
| POST | `/api/tunnels/<id>/logs` | Append a log entry |
| POST | `/api/tunnels/<id>/logs/save` | Save logs to a folder (pass `{folder}` in body) |

### Pipelines (`/api/pipelines`)

High-level orchestration endpoints that combine multiple steps.

| Method | Path | Description |
|---|---|---|
| POST | `/api/pipelines/connect` | Full connect flow: resolve config, start tunnel, wait for readiness, verify |
| POST | `/api/pipelines/disconnect` | Stop a tunnel by connection key or tunnel ID |
| POST | `/api/pipelines/kill-port` | Find and kill whatever is listening on a port |

### Sessions (`/api/sessions`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/sessions` | List all sessions with tunnel status and connection details |
| GET | `/api/sessions/stats` | Dashboard statistics (active sessions, regions, ports, etc.) |
| GET | `/api/sessions/<key>/health` | Health check a session (port, service, or tunnel check) |

### Kubernetes (`/api/kube`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/kube/context` | Get current kubectl context |
| GET | `/api/kube/nodes` | List node names from current context |
| GET | `/api/kube/health` | Kubernetes health check |
| POST | `/api/kube/setup` | Run `aws eks update-kubeconfig` |
| POST | `/api/kube/update-cluster-config` | Point a kubeconfig cluster at a local tunnel port |

### Hosts (`/api/hosts`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/hosts/check` | Check if an endpoint has a hosts file entry |
| POST | `/api/hosts/update` | Add a `127.0.0.1` hosts entry for an endpoint |

### Settings (`/api/settings`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Get current settings |
| PUT | `/api/settings` | Update settings |
| GET | `/api/settings/defaults` | Get default settings values |

### Constants (`/api/consts`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/consts` | Get UI constants (connection types, defaults, settings schema) |
| GET | `/api/consts/clipboard` | Read system clipboard |
| POST | `/api/consts/clipboard` | Write to system clipboard |
| GET | `/api/consts/port/<port>/pid` | Get PID listening on a port |
| POST | `/api/consts/pid/<pid>/kill` | Kill a process by PID |
| POST | `/api/consts/browse-save` | Native save-as file dialog |
| POST | `/api/consts/browse-folder` | Native folder picker dialog |
| POST | `/api/consts/save-file` | Write content to a file |

### Pages (`/api/pages`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/pages/<name>` | Render a page template (dashboard, connections, settings, etc.) |
