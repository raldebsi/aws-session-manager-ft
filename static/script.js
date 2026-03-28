// Sidebar collapse logic
const sidebar = document.querySelector('.sidebar');
const hamburgerBtn = document.getElementById('hamburgerBtn');
const sidebarHeader = document.querySelector('.sidebar-header');

function updateHamburgerPosition() {
    if (sidebar.classList.contains('collapsed')) {
        sidebarHeader.insertBefore(hamburgerBtn, sidebarHeader.firstChild);
    } else {
        sidebarHeader.appendChild(hamburgerBtn);
    }
}

hamburgerBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    sidebar.classList.toggle('expanded');
    updateHamburgerPosition();
});

updateHamburgerPosition();

// --- Toast system ---

const toastContainer = (() => {
    const el = document.createElement('div');
    el.className = 'toast-container';
    document.querySelector('.main-content').appendChild(el);
    return el;
})();

function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return String(hash);
}

function showToast(message, type = 'info', duration = 3500) {
    const contentHash = hashString(type + ':' + message);

    // Remove existing toast with same hash
    const existing = toastContainer.querySelector(`[data-hash="${contentHash}"]`);
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.dataset.hash = contentHash;

    const icons = {
        success: 'fa-circle-check',
        error: 'fa-circle-exclamation',
        warning: 'fa-triangle-exclamation',
        info: 'fa-circle-info'
    };

    toast.innerHTML = `
        <i class="fa-solid ${icons[type] || icons.info}"></i>
        <span class="toast-message">${message}</span>
        <button class="toast-close"><i class="fa-solid fa-xmark"></i></button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 200);
    });

    toastContainer.appendChild(toast);

    // Auto-dismiss
    setTimeout(() => {
        if (toast.parentNode) {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 200);
        }
    }, duration);
}

// --- Constants (fetched from server on startup) ---

let CONSTS = null;

async function loadConsts() {
    const res = await fetch('/api/consts');
    CONSTS = await res.json();
    return CONSTS;
}

// --- Page template loader ---

const pageCache = {};

async function fetchPage(pageName) {
    if (pageCache[pageName]) return pageCache[pageName];
    const res = await fetch(`/api/pages/${pageName}`);
    if (!res.ok) throw new Error(`Failed to load page: ${pageName}`);
    const html = await res.text();
    pageCache[pageName] = html;
    return html;
}

// --- Pane rendering system ---

const mainTopbarTitle = document.getElementById('mainTopbarTitle');
const mainContentBody = document.getElementById('mainContentBody');

let currentPane = null;

const paneRenderers = {
    dashboardPane: renderDashboard,
    configPane: renderConnections,
    settingsPane: renderSettings,
};

function switchPane(paneId) {
    if (currentPane === paneId) return;
    currentPane = paneId;

    document.querySelectorAll('.sidebar-pane').forEach(p => p.classList.remove('active'));
    const paneEl = document.getElementById(paneId);
    if (paneEl) {
        paneEl.classList.add('active');
        mainTopbarTitle.textContent = paneEl.textContent.trim();
    }

    mainContentBody.innerHTML = '';
    const renderer = paneRenderers[paneId];
    if (renderer) renderer();
}

document.querySelectorAll('.sidebar-pane').forEach(pane => {
    pane.addEventListener('click', () => switchPane(pane.id));
});

// --- Dashboard pane ---

let dashboardView = 'grouped'; // 'grouped' or 'all'
let dashboardQuery = '';

// Build a single search string per session for fast matching
function buildSearchIndex(session) {
    return Object.values(session).join('\x00').toLowerCase();
}

const sessionSearchIndex = new WeakMap();

function getSearchIndex(session) {
    let idx = sessionSearchIndex.get(session);
    if (!idx) {
        idx = buildSearchIndex(session);
        sessionSearchIndex.set(session, idx);
    }
    return idx;
}

function filterSessions(query) {
    if (!query) return sessions;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return sessions.filter(s => {
        const idx = getSearchIndex(s);
        return terms.every(t => idx.includes(t));
    });
}

async function renderDashboard() {
    const html = await fetchPage('dashboard');
    mainContentBody.innerHTML = html;

    const searchInput = document.getElementById('dashboardSearch');
    const viewBtns = document.querySelectorAll('.dashboard-view-toggle .view-btn');

    // Restore state
    searchInput.value = dashboardQuery;
    viewBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === dashboardView);
    });

    function refresh() {
        const filtered = filterSessions(dashboardQuery);
        const container = document.getElementById('dashboardContent');
        container.innerHTML = '';

        if (filtered.length === 0) {
            container.innerHTML = '<div class="dashboard-no-results"><i class="fa-solid fa-magnifying-glass"></i> No sessions match your search</div>';
            return;
        }

        if (dashboardView === 'all') {
            renderFlatView(container, filtered);
        } else {
            const groupKey = dashboardView === 'region' ? 'region' : 'connectionId';
            renderGroupedView(container, filtered, groupKey);
        }
    }

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            dashboardQuery = searchInput.value.trim();
            refresh();
        }, 80);
    });

    viewBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            dashboardView = btn.dataset.view;
            viewBtns.forEach(b => b.classList.toggle('active', b === btn));
            refresh();
        });
    });

    refresh();
}

function renderGroupedView(container, filtered, groupKey) {
    const groups = {};
    filtered.forEach(s => {
        const gid = s[groupKey] || 'ungrouped';
        if (!groups[gid]) groups[gid] = [];
        groups[gid].push(s);
    });

    for (const [groupId, groupSessions] of Object.entries(groups)) {
        const first = groupSessions[0];
        const group = document.createElement('div');
        group.className = 'dashboard-group';

        // For connection grouping show region; for region grouping no badge needed
        const badgeHtml = groupKey !== 'region'
            ? `<span class="dashboard-group-badge">${first.region}</span>`
            : '';

        const header = document.createElement('div');
        header.className = 'dashboard-group-header';
        header.innerHTML = `
            <i class="fa-solid fa-chevron-down dashboard-group-chevron"></i>
            <span class="dashboard-group-name">${groupId}</span>
            ${badgeHtml}
            <span class="dashboard-group-count">${groupSessions.length}</span>
        `;

        const cards = document.createElement('div');
        cards.className = 'dashboard-group-cards';
        groupSessions.forEach(s => cards.appendChild(createDashboardCard(s)));

        header.addEventListener('click', () => {
            header.classList.toggle('collapsed');
            cards.style.display = header.classList.contains('collapsed') ? 'none' : '';
        });

        group.appendChild(header);
        group.appendChild(cards);
        container.appendChild(group);
    }
}

function renderFlatView(container, filtered) {
    const grid = document.createElement('div');
    grid.className = 'dashboard-sessions';
    filtered.forEach(s => grid.appendChild(createDashboardCard(s)));
    container.appendChild(grid);
}

function createDashboardCard(session) {
    const el = document.createElement('div');
    el.className = 'session-item';
    el.dataset.sessionId = session.id;
    if (isActive(session)) el.classList.add('active');
    if (session.status === 'error') el.classList.add('error');
    if (session.status === 'inactive') el.classList.add('inactive');

    const btnClass = isActive(session) ? 'on' : 'off';

    el.innerHTML = `
        <div class="session-top">
            <div class="session-info">
                <div class="session-name-row">
                    <span class="session-name">${session.name}</span>
                </div>
                <div class="session-desc-row">
                    <span class="session-subtext">${session.description}</span>
                    <span class="session-type-badge">${session.type}</span>
                </div>
            </div>
            <button class="session-btn session-shutdown ${btnClass}" title="Shutdown">
                <span class="shutdown-icon">
                    <i class="fa-solid fa-power-off"></i>
                </span>
            </button>
        </div>
        <div class="session-bottom">
            <span class="session-ports">${session.localPort} &rarr; <span class="session-region">${session.region}</span>:${session.remotePort}</span>
        </div>
    `;

    const btn = el.querySelector('.session-shutdown');
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSession(session);
    });

    return el;
}

// --- Connections pane ---

let connectionsCache = null;
let userConnectionsCache = null;
let usedPortsCache = null;

async function fetchConnections() {
    const res = await fetch('/api/configs');
    connectionsCache = await res.json();
    return connectionsCache;
}

async function fetchUserConnections() {
    const res = await fetch('/api/configs/user');
    userConnectionsCache = await res.json();
    return userConnectionsCache;
}

async function fetchUsedPorts() {
    const res = await fetch('/api/configs/user/ports');
    usedPortsCache = await res.json();
    return usedPortsCache;
}

function invalidateCaches() {
    connectionsCache = null;
    userConnectionsCache = null;
    usedPortsCache = null;
}

function goBackToConnections() {
    mainTopbarTitle.textContent = 'Connections';
    currentPane = null;
    switchPane('configPane');
}

function connectionFingerprint(conn) {
    const bastionStr = JSON.stringify(conn.bastions || {}, Object.keys(conn.bastions || {}).sort());
    return `${conn.type}|${conn.cluster}|${conn.region}|${conn.endpoint}|${conn.document}|${conn.remote_port}|${bastionStr}`;
}

function findDuplicateConnections(connections) {
    const fingerprints = {};
    const duplicates = {};

    for (const [key, conn] of Object.entries(connections)) {
        const fp = connectionFingerprint(conn);
        if (!fingerprints[fp]) fingerprints[fp] = [];
        fingerprints[fp].push(key);
    }

    for (const keys of Object.values(fingerprints)) {
        if (keys.length > 1) {
            for (const key of keys) {
                duplicates[key] = keys.filter(k => k !== key);
            }
        }
    }
    return duplicates;
}

async function renderConnections() {
    mainContentBody.innerHTML = '<div class="conn-empty"><i class="fa-solid fa-spinner fa-spin"></i>&nbsp; Loading...</div>';

    try {
        const [html, connections, userConnections, usedPorts] = await Promise.all([
            fetchPage('connections'), fetchConnections(), fetchUserConnections(), fetchUsedPorts()
        ]);

        mainContentBody.innerHTML = html;

        const referencedIds = new Set();
        Object.values(userConnections).forEach(uc => referencedIds.add(uc.connection_id));

        const clashingPorts = new Set();
        for (const [port, users] of Object.entries(usedPorts)) {
            if (users.length > 1) clashingPorts.add(port);
        }

        const duplicates = findDuplicateConnections(connections);

        const connListEl = document.getElementById('connectionsList');
        const connKeys = Object.keys(connections);
        if (connKeys.length === 0) {
            connListEl.innerHTML = '<div class="conn-empty">No connections configured</div>';
        } else {
            connKeys.forEach(key => {
                connListEl.appendChild(createConnCard(connections[key], 'connection', key, {
                    unreferenced: !referencedIds.has(key),
                    duplicateOf: duplicates[key]
                }));
            });
        }

        const userListEl = document.getElementById('userConnectionsList');
        const userKeys = Object.keys(userConnections);
        if (userKeys.length === 0) {
            userListEl.innerHTML = '<div class="conn-empty">No user connections configured</div>';
        } else {
            userKeys.forEach(key => {
                const uc = userConnections[key];
                userListEl.appendChild(createConnCard({
                    name: uc.connection_name || key,
                    type: connections[uc.connection_id]?.type || 'unknown',
                    detail: `Port ${uc.local_port} \u2192 ${uc.connection_id}`,
                    local_port: uc.local_port,
                    _raw: uc
                }, 'user', key, { portClash: clashingPorts.has(String(uc.local_port)) }));
            });
        }

        document.getElementById('createConnBtn').addEventListener('click', () => renderCreateConnectionForm());
        document.getElementById('createUserConnBtn').addEventListener('click', () => renderCreateUserConnectionForm());
        document.getElementById('importConnBtn').addEventListener('click', () => renderImportForm());

    } catch (err) {
        mainContentBody.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Failed to load connections: ${err.message}</div>`;
    }
}

function createConnCard(data, type, key, flags = {}) {
    const el = document.createElement('div');
    el.className = 'conn-card';
    if (flags.unreferenced) el.classList.add('unreferenced');

    const icon = type === 'connection' ? 'fa-server' : 'fa-user';
    const badge = data.type ? data.type.toUpperCase() : '';
    const detail = type === 'connection'
        ? `${data.region} \u00b7 ${data.cluster}`
        : data.detail;

    const clashIcon = flags.portClash
        ? '<i class="fa-solid fa-triangle-exclamation conn-port-clash" title="Port conflict"></i>'
        : '';

    let dupIcon = '';
    if (flags.duplicateOf && flags.duplicateOf.length > 0) {
        const dupNames = flags.duplicateOf.join(', ');
        dupIcon = `<i class="fa-solid fa-triangle-exclamation conn-duplicate-warn" title="Duplicate of: ${dupNames}"></i>`;
    }

    el.innerHTML = `
        <div class="conn-card-icon"><i class="fa-solid ${icon}"></i></div>
        <div class="conn-card-info">
            <div class="conn-card-name">${data.name}${dupIcon}</div>
            <div class="conn-card-detail">
                ${detail}${clashIcon}
                ${badge ? `<span class="conn-card-badge">${badge}</span>` : ''}
            </div>
        </div>
        <div class="conn-card-actions">
            <button class="conn-action-btn" data-action="duplicate" title="Duplicate"><i class="fa-solid fa-clone"></i></button>
            <button class="conn-action-btn" data-action="share" title="Share"><i class="fa-solid fa-share-nodes"></i></button>
            <button class="conn-action-btn" data-action="browse" title="Open in explorer"><i class="fa-solid fa-folder-open"></i></button>
            <button class="conn-action-btn delete" data-action="delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
    `;

    el.addEventListener('click', (e) => {
        if (e.target.closest('.conn-action-btn')) return;
        if (type === 'connection') {
            renderCreateConnectionForm(data, key);
        } else {
            renderCreateUserConnectionForm(data._raw || data, key);
        }
    });

    el.querySelectorAll('.conn-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            if (action === 'delete') handleDelete(type, key, data.name);
            if (action === 'duplicate') handleDuplicate(type, data);
            if (action === 'share') handleShare(type, key);
            if (action === 'browse') handleBrowse(type, key);
        });
    });

    return el;
}

// --- Card actions ---

async function handleDelete(type, key, name) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

    const kind = type === 'connection' ? '' : '/user';
    const res = await fetch(`/api/configs${kind}/${key}`, { method: 'DELETE' });
    if (!res.ok) {
        const err = await res.json();
        showToast(err.error || 'Failed to delete', 'error');
        return;
    }

    showToast(`Deleted "${name}"`, 'success');
    invalidateCaches();
    goBackToConnections();
}

function handleDuplicate(type, data) {
    if (type === 'connection') {
        renderCreateConnectionForm({ ...data, id: '' }, null);
    } else {
        const raw = data._raw || data;
        renderCreateUserConnectionForm({ ...raw, connection_name: '' }, null);
    }
}

async function handleShare(type, key) {
    const kind = type === 'connection' ? 'connection' : 'user';
    const res = await fetch('/api/configs/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, kind })
    });
    const data = await res.json();
    if (!res.ok) {
        showToast(data.error || 'Failed to generate share string', 'error');
        return;
    }
    showShareModal(data.encoded);
}

function showShareModal(encoded) {
    document.querySelector('.share-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'share-overlay';
    overlay.innerHTML = `
        <div class="share-modal">
            <div class="share-modal-title"><i class="fa-solid fa-share-nodes"></i> Share Connection</div>
            <textarea class="share-string" readonly>${encoded}</textarea>
            <div class="share-actions">
                <button class="conn-btn secondary" id="shareCloseBtn">Close</button>
                <button class="conn-btn primary" id="shareCopyBtn"><i class="fa-solid fa-copy"></i> Copy</button>
            </div>
        </div>
    `;

    const mainContent = document.querySelector('.main-content');
    mainContent.appendChild(overlay);

    overlay.querySelector('#shareCopyBtn').addEventListener('click', async () => {
        try {
            await writeClipboard(encoded);
            showToast('Copied to clipboard', 'success');
        } catch {
            showToast('Failed to copy to clipboard', 'error');
        }
    });

    overlay.querySelector('#shareCloseBtn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

async function handleBrowse(type, key) {
    const kind = type === 'connection' ? 'connection' : 'user';
    const res = await fetch('/api/configs/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, kind })
    });
    if (!res.ok) {
        const data = await res.json();
        showToast(data.error || 'Failed to open explorer', 'error');
    }
}

// --- Helpers: populate selects from consts ---

function populateSelect(selectEl, items, valueKey, labelKey) {
    selectEl.innerHTML = '';
    items.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item[valueKey];
        opt.textContent = item[labelKey];
        selectEl.appendChild(opt);
    });
}

// --- Create/Edit Connection Form ---

async function renderCreateConnectionForm(editData = null, editKey = null) {
    mainContentBody.innerHTML = '';
    const isEdit = editData !== null && editKey !== null;

    mainTopbarTitle.textContent = isEdit ? 'Edit Connection' : 'New Connection';

    const html = await fetchPage('create_connection');
    mainContentBody.innerHTML = html;

    if (isEdit) {
        document.getElementById('formTitleText').textContent = 'Edit Connection';
        document.getElementById('editBadge').style.display = '';
        document.getElementById('saveConnIcon').className = 'fa-solid fa-pen';
        document.getElementById('saveConnLabel').textContent = 'Update';
        document.getElementById('pasteClipboardBtn').style.display = 'none';
    }

    populateSelect(document.getElementById('connType'), CONSTS.connection_types, 'value', 'label');

    document.getElementById('connRemotePort').value = CONSTS.defaults.remote_port;
    document.getElementById('connDocument').value = CONSTS.defaults.ssm_document;

    if (editData) {
        fillConnectionForm(editData);

        if (isEdit) {
            const idInput = document.getElementById('connId');
            idInput.readOnly = true;
            idInput.classList.add('input-readonly');
        }
    }

    document.getElementById('addBastionBtn').addEventListener('click', () => {
        const entries = document.getElementById('bastionEntries');
        const row = document.createElement('div');
        row.className = 'bastion-row';
        row.innerHTML = `
            <input class="form-input" placeholder="Name (e.g. main)" data-bastion="key" />
            <input class="form-input" placeholder="Instance ID (e.g. i-0abc...)" data-bastion="value" />
            <button class="bastion-remove-btn" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        `;
        row.querySelector('.bastion-remove-btn').addEventListener('click', () => row.remove());
        entries.appendChild(row);
    });

    document.querySelectorAll('.bastion-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.bastion-row').remove());
    });

    document.getElementById('cancelConnBtn').addEventListener('click', goBackToConnections);
    document.getElementById('saveConnBtn').addEventListener('click', () => saveConnection(isEdit ? editKey : null));

    if (!isEdit) {
        document.getElementById('pasteClipboardBtn').addEventListener('click', async () => {
            const config = await readClipboardConfig('connection');
            if (config) {
                fillConnectionForm(config);
                showToast('Pre-filled from clipboard', 'success');
            }
        });
    }
}

async function saveConnection(editKey) {
    const msgEl = document.getElementById('formMessage');
    msgEl.innerHTML = '';

    const id = document.getElementById('connId').value.trim();
    const type = document.getElementById('connType').value;
    const name = document.getElementById('connName').value.trim();
    const cluster = document.getElementById('connCluster').value.trim();
    const region = document.getElementById('connRegion').value.trim();
    const endpoint = document.getElementById('connEndpoint').value.trim();
    const ssmDocument = document.getElementById('connDocument').value.trim();
    const remotePort = parseInt(document.getElementById('connRemotePort').value) || CONSTS.defaults.remote_port;

    if (!id || !type || !name || !cluster || !region || !endpoint) {
        msgEl.innerHTML = '<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Please fill in all required fields.</div>';
        return;
    }

    const bastions = {};
    document.querySelectorAll('.bastion-row').forEach(row => {
        const key = row.querySelector('[data-bastion="key"]').value.trim();
        const val = row.querySelector('[data-bastion="value"]').value.trim();
        if (key && val) bastions[key] = val;
    });

    const isEdit = editKey !== null;
    const url = isEdit ? `/api/configs/${editKey}` : '/api/configs';
    const method = isEdit ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, type, name, cluster, region, endpoint, document: ssmDocument, remote_port: remotePort, bastions })
        });
        const data = await res.json();

        if (!res.ok) {
            msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${data.error}</div>`;
            return;
        }

        const verb = isEdit ? 'updated' : 'created';
        showToast(`Connection "${name}" ${verb}`, 'success');
        invalidateCaches();
        setTimeout(goBackToConnections, 600);
    } catch (err) {
        msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${err.message}</div>`;
    }
}

// --- Create/Edit User Connection Form ---

async function renderCreateUserConnectionForm(editData = null, editKey = null) {
    mainContentBody.innerHTML = '';
    const isEdit = editData !== null && editKey !== null;

    mainTopbarTitle.textContent = isEdit ? 'Edit User Connection' : 'New User Connection';

    const [html, connections, usedPorts] = await Promise.all([
        fetchPage('create_user_connection'), fetchConnections(), fetchUsedPorts()
    ]);

    const connKeys = Object.keys(connections);
    if (connKeys.length === 0) {
        mainContentBody.innerHTML = `
            <div class="form-container">
                <div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> No connections available. Create a connection first.</div>
                <div class="form-actions">
                    <button class="conn-btn secondary" id="backBtn">Back</button>
                </div>
            </div>
        `;
        document.getElementById('backBtn').addEventListener('click', goBackToConnections);
        return;
    }

    mainContentBody.innerHTML = html;

    if (isEdit) {
        document.getElementById('formTitleText').textContent = 'Edit User Connection';
        document.getElementById('editBadge').style.display = '';
        document.getElementById('saveUcIcon').className = 'fa-solid fa-pen';
        document.getElementById('saveUcLabel').textContent = 'Update';
        document.getElementById('pasteClipboardBtn').style.display = 'none';
    }

    const connSelect = document.getElementById('ucConnection');
    connKeys.forEach(k => {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = `${connections[k].name} (${k})`;
        connSelect.appendChild(opt);
    });

    const bastionSelect = document.getElementById('ucBastion');
    function updateBastions() {
        const conn = connections[connSelect.value];
        bastionSelect.innerHTML = '';
        if (conn && conn.bastions) {
            Object.keys(conn.bastions).forEach(b => {
                const opt = document.createElement('option');
                opt.value = b;
                opt.textContent = `${b} \u2014 ${conn.bastions[b]}`;
                bastionSelect.appendChild(opt);
            });
        }
    }
    updateBastions();
    connSelect.addEventListener('change', updateBastions);

    document.getElementById('ucProfile').value = CONSTS.defaults.profile;
    document.getElementById('ucKubeconfig').placeholder = CONSTS.defaults.kubeconfig_path;

    if (editData) {
        fillUserConnectionForm(editData, connections);
    }

    const portInput = document.getElementById('ucLocalPort');
    const portWarning = document.getElementById('portWarning');

    portInput.addEventListener('input', () => {
        const port = portInput.value.trim();
        portWarning.innerHTML = '';
        if (port && usedPorts[port]) {
            const others = usedPorts[port].filter(u => u.connection_key !== editKey);
            if (others.length > 0) {
                const names = others.map(u => u.connection_name).join(', ');
                portWarning.innerHTML = `<div class="port-warning"><i class="fa-solid fa-triangle-exclamation"></i> Port ${port} is already used by <strong>${names}</strong></div>`;
            }
        }
    });

    if (editData && editData.local_port) portInput.dispatchEvent(new Event('input'));

    document.getElementById('cancelUcBtn').addEventListener('click', goBackToConnections);
    document.getElementById('saveUcBtn').addEventListener('click', () => saveUserConnection(isEdit ? editKey : null));

    if (!isEdit) {
        document.getElementById('pasteClipboardBtn').addEventListener('click', async () => {
            const config = await readClipboardConfig('user');
            if (config) {
                fillUserConnectionForm(config, connections);
                showToast('Pre-filled from clipboard', 'success');
            }
        });
    }
}

async function saveUserConnection(editKey) {
    const msgEl = document.getElementById('formMessage');
    msgEl.innerHTML = '';

    const connectionId = document.getElementById('ucConnection').value;
    const bastionId = document.getElementById('ucBastion').value;
    const localPort = document.getElementById('ucLocalPort').value.trim();
    const profile = document.getElementById('ucProfile').value.trim() || CONSTS.defaults.profile;
    const connectionName = document.getElementById('ucName').value.trim();
    const description = document.getElementById('ucDescription').value.trim();
    const kubeconfigPath = document.getElementById('ucKubeconfig').value.trim();

    if (!connectionId || !bastionId || !localPort || !connectionName) {
        msgEl.innerHTML = '<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Please fill in all required fields.</div>';
        return;
    }

    const body = {
        connection_id: connectionId,
        bastion_id: bastionId,
        local_port: parseInt(localPort),
        profile,
        connection_name: connectionName
    };
    if (description) body.description = description;
    if (kubeconfigPath) body.kubeconfig_path = kubeconfigPath;

    const isEdit = editKey !== null;
    const url = isEdit ? `/api/configs/user/${editKey}` : '/api/configs/user';
    const method = isEdit ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();

        if (!res.ok) {
            msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${data.error}</div>`;
            return;
        }

        if (data.warnings && data.warnings.length > 0) {
            data.warnings.forEach(w => showToast(w, 'warning', 5000));
        }

        const verb = isEdit ? 'updated' : 'created';
        showToast(`User connection "${connectionName}" ${verb}`, 'success');
        invalidateCaches();
        setTimeout(goBackToConnections, 600);
    } catch (err) {
        msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${err.message}</div>`;
    }
}

// --- Import Form (pre-fills create form, does NOT create directly) ---

async function renderImportForm() {
    mainContentBody.innerHTML = '';
    mainTopbarTitle.textContent = 'Import Connection';

    const html = await fetchPage('import_connection');
    mainContentBody.innerHTML = html;

    const tabEncoded = document.getElementById('tabEncoded');
    const tabFile = document.getElementById('tabFile');
    const sectionEncoded = document.getElementById('importEncodedSection');
    const sectionFile = document.getElementById('importFileSection');

    let activeTab = 'encoded';
    let parsedFileData = null;
    let detectedFileKind = null;

    tabEncoded.addEventListener('click', () => {
        activeTab = 'encoded';
        tabEncoded.classList.add('active');
        tabFile.classList.remove('active');
        sectionEncoded.style.display = '';
        sectionFile.style.display = 'none';
    });

    tabFile.addEventListener('click', () => {
        activeTab = 'file';
        tabFile.classList.add('active');
        tabEncoded.classList.remove('active');
        sectionEncoded.style.display = 'none';
        sectionFile.style.display = '';
    });

    const fileInput = document.getElementById('importFile');
    const fileNameEl = document.getElementById('importFileName');

    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        fileNameEl.textContent = file.name;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                parsedFileData = JSON.parse(e.target.result);
                detectedFileKind = detectKind(parsedFileData);
                const preview = document.getElementById('importFilePreview');
                const kindEl = document.getElementById('importDetectedKind');
                preview.style.display = '';
                kindEl.textContent = detectedFileKind ? detectedFileKind.toUpperCase() : 'UNKNOWN';
            } catch {
                parsedFileData = null;
                detectedFileKind = null;
                showToast('Invalid JSON file', 'error');
            }
        };
        reader.readAsText(file);
    });

    document.getElementById('cancelImportBtn').addEventListener('click', goBackToConnections);
    document.getElementById('submitImportBtn').addEventListener('click', async () => {
        const msgEl = document.getElementById('formMessage');
        msgEl.innerHTML = '';

        try {
            let configData = null;
            let kind = null;

            if (activeTab === 'encoded') {
                const encoded = document.getElementById('importEncoded').value.trim();
                if (!encoded) {
                    msgEl.innerHTML = '<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Please paste an encoded string.</div>';
                    return;
                }
                // Decode server-side
                const res = await fetch('/api/configs/share/decode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ encoded })
                });
                const decoded = await res.json();
                if (!res.ok) {
                    msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${decoded.error}</div>`;
                    return;
                }
                kind = decoded.kind;
                configData = decoded.config;
            } else {
                if (!parsedFileData) {
                    msgEl.innerHTML = '<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Please select a valid JSON file.</div>';
                    return;
                }
                kind = detectedFileKind;
                configData = parsedFileData;
            }

            if (!kind || !configData) {
                msgEl.innerHTML = '<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Could not detect config type.</div>';
                return;
            }

            // Pre-fill on the appropriate create form
            showToast(`Imported ${kind} config — review and save`, 'info');
            if (kind === 'connection') {
                renderCreateConnectionForm(configData, null);
            } else {
                renderCreateUserConnectionForm(configData, null);
            }
        } catch (err) {
            msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${err.message}</div>`;
        }
    });
}

function detectKind(data) {
    if (data.cluster && data.region && data.endpoint) return 'connection';
    if (data.connection_id && data.bastion_id) return 'user';
    return null;
}

// --- Clipboard helpers (via server-side pyperclip) ---

async function readClipboard() {
    const res = await fetch('/api/consts/clipboard');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to read clipboard');
    return data.text;
}

async function writeClipboard(text) {
    const res = await fetch('/api/consts/clipboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to write clipboard');
    }
}

async function readClipboardConfig(expectedKind) {
    let text;
    try {
        text = await readClipboard();
    } catch (err) {
        showToast('Cannot read clipboard. Try pasting manually.', 'error');
        return null;
    }

    if (!text || !text.trim()) {
        showToast('Clipboard is empty', 'warning');
        return null;
    }

    text = text.trim();

    // Try parsing as JSON first
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch { /* not JSON, try as encoded string below */ }

    if (parsed) {
        // Wrapped {kind, config} object
        if (parsed.kind && parsed.config) {
            if (parsed.kind !== expectedKind) {
                showToast(`Clipboard has a ${parsed.kind} config, but this form is for ${expectedKind}`, 'error');
                return null;
            }
            return parsed.config;
        }

        // Direct config object
        const kind = detectKind(parsed);
        if (kind === expectedKind) return parsed;
        if (kind) {
            showToast(`Clipboard has a ${kind} config, but this form is for ${expectedKind}`, 'error');
            return null;
        }

        showToast('Clipboard JSON does not match a known config format', 'error');
        return null;
    }

    // Try decoding as encoded share string
    try {
        const res = await fetch('/api/configs/share/decode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ encoded: text })
        });
        if (res.ok) {
            const decoded = await res.json();
            if (decoded.kind !== expectedKind) {
                showToast(`Encoded string has a ${decoded.kind} config, but this form is for ${expectedKind}`, 'error');
                return null;
            }
            return decoded.config;
        }
    } catch { /* ignore */ }

    showToast('Clipboard content is not valid JSON or an encoded share string', 'error');
    return null;
}

function fillConnectionForm(data) {
    if (data.id !== undefined) document.getElementById('connId').value = data.id;
    if (data.type) document.getElementById('connType').value = data.type;
    if (data.name) document.getElementById('connName').value = data.name;
    if (data.cluster) document.getElementById('connCluster').value = data.cluster;
    if (data.region) document.getElementById('connRegion').value = data.region;
    if (data.endpoint) document.getElementById('connEndpoint').value = data.endpoint;
    if (data.document) document.getElementById('connDocument').value = data.document;
    if (data.remote_port) document.getElementById('connRemotePort').value = data.remote_port;

    if (data.bastions && Object.keys(data.bastions).length > 0) {
        const entries = document.getElementById('bastionEntries');
        entries.innerHTML = '';
        Object.entries(data.bastions).forEach(([bKey, bVal]) => {
            const row = document.createElement('div');
            row.className = 'bastion-row';
            row.innerHTML = `
                <input class="form-input" placeholder="Name (e.g. main)" data-bastion="key" value="${bKey}" />
                <input class="form-input" placeholder="Instance ID (e.g. i-0abc...)" data-bastion="value" value="${bVal}" />
                <button class="bastion-remove-btn" title="Remove"><i class="fa-solid fa-xmark"></i></button>
            `;
            row.querySelector('.bastion-remove-btn').addEventListener('click', () => row.remove());
            entries.appendChild(row);
        });
    }
}

function fillUserConnectionForm(data, connections) {
    const connSelect = document.getElementById('ucConnection');
    const bastionSelect = document.getElementById('ucBastion');

    if (data.connection_id) {
        connSelect.value = data.connection_id;
        const conn = connections[data.connection_id];
        bastionSelect.innerHTML = '';
        if (conn && conn.bastions) {
            Object.keys(conn.bastions).forEach(b => {
                const opt = document.createElement('option');
                opt.value = b;
                opt.textContent = `${b} \u2014 ${conn.bastions[b]}`;
                bastionSelect.appendChild(opt);
            });
        }
    }
    if (data.bastion_id) bastionSelect.value = data.bastion_id;
    if (data.connection_name !== undefined) document.getElementById('ucName').value = data.connection_name;
    if (data.description) document.getElementById('ucDescription').value = data.description;
    if (data.local_port) document.getElementById('ucLocalPort').value = data.local_port;
    if (data.profile) document.getElementById('ucProfile').value = data.profile;
    if (data.kubeconfig_path) document.getElementById('ucKubeconfig').value = data.kubeconfig_path;

    document.getElementById('ucLocalPort').dispatchEvent(new Event('input'));
}

// --- Settings pane ---

function renderSettings() {
    const container = document.createElement('div');
    container.className = 'pane-placeholder';
    container.innerHTML = `
        <i class="fa-solid fa-gear pane-placeholder-icon"></i>
        <span class="pane-placeholder-text">Settings</span>
    `;
    mainContentBody.appendChild(container);
}

// --- Session helpers ---

function isActive(session) {
    return session.status === 'active';
}

function toggleSession(session) {
    if (session.status === 'active') {
        session.status = 'inactive';
    } else if (session.status === 'inactive' || session.status === 'error') {
        session.status = 'active';
    }
    sessionSearchIndex.delete(session); // invalidate search cache
    renderSidebar();
    if (currentPane === 'dashboardPane') {
        mainContentBody.innerHTML = '';
        renderDashboard();
    }
}

// --- Sidebar session list ---

function renderSidebar() {
    const activeList = document.getElementById('activeSessions');
    const availableList = document.getElementById('availableSessions');
    const activeCount = document.getElementById('activeCount');

    activeList.innerHTML = '';
    availableList.innerHTML = '';

    let numActive = 0;

    sessions.forEach(session => {
        const sidebarItem = createSidebarItem(session);
        if (isActive(session)) {
            activeList.appendChild(sidebarItem);
            numActive++;
        } else {
            availableList.appendChild(sidebarItem);
        }
    });

    activeCount.textContent = numActive;
}

function createSidebarItem(session) {
    const el = document.createElement('div');
    el.className = 'sidebar-session-item';
    el.dataset.sessionId = session.id;
    if (isActive(session)) el.classList.add('active');
    if (session.status === 'error') el.classList.add('error');

    el.innerHTML = `
        <div class="sidebar-session-name">${session.name}</div>
        <div class="sidebar-session-detail">
            <span class="sidebar-session-desc">${session.description}</span>
            <span class="session-type-badge">${session.type}</span>
        </div>
        <div class="sidebar-session-port">${session.localPort} &rarr; ${session.region}:${session.remotePort}</div>
    `;

    el.addEventListener('click', () => {
        toggleSession(session);
    });

    return el;
}

// New Connection button
document.getElementById('newConnectionBtn').addEventListener('click', () => {
    switchPane('configPane');
});

// --- Startup ---
async function init() {
    await loadConsts();
    renderSidebar();
    switchPane('dashboardPane');
}

init();
