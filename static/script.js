// === SYSTEM LOG — intercept console early, buffer until console panel is ready ===

const SYSTEM_LOG_KEY = '__system__';
const _systemLogBuffer = [];
let _systemLogReady = false;

const _origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

function _captureConsole(level, args) {
    const text = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const entry = { stream: level === 'error' ? 'stderr' : (level === 'warn' ? 'frontend' : 'stdout'), text: `[${level}] ${text}` };
    if (_systemLogReady) {
        const tab = ensureConsoleTab(SYSTEM_LOG_KEY);
        appendLog(tab, entry);
        if (activeConsoleKey === SYSTEM_LOG_KEY) refreshConsoleBody();
    } else {
        _systemLogBuffer.push(entry);
    }
}

console.log = (...args) => { _origConsole.log(...args); _captureConsole('log', args); };
console.warn = (...args) => { _origConsole.warn(...args); _captureConsole('warn', args); };
console.error = (...args) => { _origConsole.error(...args); _captureConsole('error', args); };

function syslog(...args) {
    _origConsole.log(...args);
    _captureConsole('log', args);
}

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
    const existing = toastContainer.querySelector(`[data-hash="${contentHash}"]`);
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.dataset.hash = contentHash;

    const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
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
    setTimeout(() => {
        if (toast.parentNode) {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 200);
        }
    }, duration);
}

// --- Constants ---

let CONSTS = null;
let SETTINGS = null;

async function loadConsts() {
    const res = await fetch('/api/consts');
    CONSTS = await res.json();
    return CONSTS;
}

async function loadSettings() {
    const res = await fetch('/api/settings');
    SETTINGS = await res.json();
    return SETTINGS;
}

function getSetting(key) {
    if (SETTINGS && SETTINGS[key] !== undefined) return SETTINGS[key];
    if (CONSTS && CONSTS.settings_schema && CONSTS.settings_schema[key]) return CONSTS.settings_schema[key].default;
    return null;
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
    advancedPane: renderAdvanced,
    logsPane: renderLogsPage,
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

// === SESSION DATA ===

let tunnelBusy = false; // UI lock: true while any tunnel is starting

// Health state per session key: { port: {status, detail}, k8s: {status, detail}, tunnel: {status, detail} }
const sessionHealth = {};
const sessionChecking = {}; // per-key lock: true while a health check is in flight

function getHealth(key) {
    return sessionHealth[key] || null;
}

function isChecking(key) {
    return !!sessionChecking[key];
}

function resetHealth(key) {
    delete sessionHealth[key];
}

function setHealth(key, indicator, status, detail) {
    if (!sessionHealth[key]) sessionHealth[key] = {};
    sessionHealth[key][indicator] = { status, detail };
}

function indicatorStatus(health, indicator) {
    if (!health || !health[indicator]) return 'neutral';
    return health[indicator].status;
}

function indicatorDetail(health, indicator) {
    if (!health || !health[indicator]) return 'Not checked';
    return health[indicator].detail;
}

async function checkSessionHealth(key, check = null) {
    sessionChecking[key] = true;
    renderAll();
    const params = check ? `?check=${check}` : '';
    try {
        const res = await fetch(`/api/sessions/${key}/health${params}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (!sessionHealth[key]) sessionHealth[key] = {};
        Object.assign(sessionHealth[key], data);
        return data;
    } catch { return null; }
    finally {
        delete sessionChecking[key];
    }
}

async function refreshAllHealth() {
    const btn = document.getElementById('refreshAllBtn');
    if (btn) btn.classList.add('spinning');
    await fetchSessions();
    const active = sessions.filter(s => isActive(s));
    await Promise.all(active.map(s => checkSessionHealth(s.key)));
    renderAll();
    if (btn) btn.classList.remove('spinning');
}

async function fetchSessions() {
    const res = await fetch('/api/sessions');
    sessions = await res.json();
    sessions.forEach(s => sessionSearchIndex.delete(s));
    return sessions;
}

function isActive(session) {
    return session.status === 'active';
}

function isBusy(session) {
    return session.status === 'starting' || session.status === 'stopping';
}

function isPortConflict(session) {
    return session.status === 'port_conflict';
}

async function toggleSession(session) {
    if (tunnelBusy) return;

    if (isPortConflict(session)) {
        showToast(`Port ${session.localPort} is in use by another process (PID ${session.portPid}). Use the kill button to free it.`, 'warning');
        return;
    }

    if (!isActive(session)) {
        // Check max tunnels before connecting
        const maxTunnels = getSetting('max_tunnels');
        if (maxTunnels > 0) {
            const activeCount = sessions.filter(s => isActive(s) || s.status === 'starting').length;
            if (activeCount >= maxTunnels) {
                showToast(`Max tunnels reached (${maxTunnels}). Disconnect one first.`, 'warning');
                return;
            }
        }
    }

    tunnelBusy = true;

    try {
        if (isActive(session)) {
            await disconnectSession(session);
        } else {
            await connectSession(session);
        }
        refreshDashboardStats();
    } finally {
        tunnelBusy = false;
        renderAll();
    }
}

// --- Disconnect pipeline ---

async function disconnectSession(session) {
    const key = session.key;
    const name = session.name;
    const tunnelId = session.tunnelId;

    if (!tunnelId) {
        showToast('No tunnel ID found for this session', 'error');
        return;
    }

    session.status = 'stopping';
    resetHealth(key);
    renderAll();
    openConsoleTab(key);

    logFrontend(key, 'Disconnecting...');

    try {
        const res = await fetch(`/api/tunnels/${tunnelId}/stop`, {
            method: 'POST',
        });
        const data = await res.json();
        if (!res.ok) {
            logFrontend(key, `ERROR: ${data.error || 'Failed to disconnect'}`);
            showToast(data.error || 'Failed to disconnect', 'error');
            await fetchSessions();
            renderAll();
            return;
        }

        logFrontend(key, 'Tunnel stopped');

        // Fetch final logs from the killed tunnel process
        await fetchAndAppendLogs(key);

        logSystem(key, '\u2014 Connection shut down \u2014');
        showToast(`Disconnected "${name}"`, 'success');
    } catch (err) {
        logFrontend(key, `ERROR: ${err.message}`);
        showToast(err.message, 'error');
    }

    await fetchSessions();
    refreshConsoleBody();
}

// --- Force kill port ---

async function forceKillPort(session) {
    const port = session.localPort;

    // First check what's on the port
    let pid;
    try {
        const checkRes = await fetch(`/api/consts/port/${port}/pid`);
        const checkData = await checkRes.json();
        pid = checkData.pid;
    } catch {
        showToast(`Failed to check port ${port}`, 'error');
        return;
    }

    if (pid === -1) {
        showToast(`Nothing is listening on port ${port}`, 'info');
        return;
    }

    if (!confirm(`PID ${pid} is listening on port ${port}.\n\nKill it?`)) return;

    try {
        const res = await fetch('/api/pipelines/kill-port', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port })
        });
        const data = await res.json();
        if (data.killed) {
            showToast(`Killed PID ${pid} on port ${port}`, 'success');
            openConsoleTab(session.key);
            logFrontend(session.key, `Force killed PID ${pid} on port ${port}`);
        } else {
            showToast(data.error || `Failed to kill PID ${pid}`, 'error');
        }
    } catch (err) {
        showToast(err.message, 'error');
    }

    await fetchSessions();
    renderAll();
}

// --- Connect pipeline (step-by-step, calling existing endpoints) ---

async function connectSession(session) {
    const key = session.key;
    session.status = 'starting';
    renderAll();
    openConsoleTab(key);

    logFrontend(key, `Starting connection pipeline for "${session.name}"`);

    try {
        // Step 1: Resolve connection (validates config before starting anything)
        logFrontend(key, '[1/3] Resolving connection...');
        renderAll();

        const resolveRes = await fetch(`/api/connections/${key}`);
        const mapped = await resolveRes.json();
        if (!resolveRes.ok) {
            throw new Error(mapped.error || 'Failed to resolve connection');
        }

        const conn = mapped.connection;
        logFrontend(key, `Resolved: ${conn.cluster} @ ${conn.region} (${conn.type})`);

        // Step 2: Start tunnel (handles kubeconfig setup + hosts/cluster config + SSM spawn)
        logFrontend(key, '[2/3] Starting tunnel (kubeconfig + SSM)...');
        renderAll();

        const tunnelRes = await fetch('/api/tunnels/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profile: mapped.profile,
                endpoint: conn.endpoint,
                bastion: mapped.bastion,
                cluster_name: conn.cluster,
                region: conn.region,
                tunnel_connection_id: key,
                document_name: conn.document,
                local_port: mapped.local_port,
                remote_port: conn.remote_port,
                kubeconfig_path: mapped.kubeconfig_path
            })
        });
        const tunnelData = await tunnelRes.json();

        if (tunnelData.warning) {
            logFrontend(key, 'Tunnel already running');
            await fetchSessions();
            return;
        }
        if (!tunnelRes.ok) {
            throw new Error(tunnelData.error || 'Failed to start tunnel');
        }

        const tunnelId = tunnelData.tunnel_id;
        session.tunnelId = tunnelId;
        logFrontend(key, `Tunnel started: ${tunnelId}`);

        // Step 3: Wait for readiness (poll stdout)
        logFrontend(key, '[3/3] Waiting for tunnel readiness...');
        renderAll();

        let ready = false;
        const pollMs = getSetting('polling_interval') * 1000;
        const timeoutMs = getSetting('readiness_timeout') * 1000;
        const maxAttempts = Math.ceil(timeoutMs / pollMs);
        for (let i = 0; i < maxAttempts; i++) {
            await sleep(pollMs);
            await fetchAndAppendLogs(key);

            const logsRes = await fetch(`/api/tunnels/${tunnelId}/logs`);
            if (logsRes.ok) {
                const logsData = await logsRes.json();
                const ci = logsData.connection_index;
                // Search from the end — "Waiting for connections" is always near the tail
                const logs = logsData.logs || [];
                for (let j = logs.length - 1; j >= 0; j--) {
                    const entry = logs[j];
                    if (entry.ci !== ci) break; // hit older connection's entries, stop
                    if (entry.type === 'stdout' && entry.text.includes('Waiting for connections')) {
                        ready = true;
                        break;
                    }
                }
            }
            if (ready) break;
        }

        if (!ready) {
            logFrontend(key, 'WARNING: Readiness not confirmed (timeout) — tunnel may still be starting');
            showToast(`"${session.name}" started but readiness not confirmed`, 'warning');
        } else {
            logFrontend(key, 'Tunnel is ready');
        }

        // K8s health check — capture result into health indicators
        logFrontend(key, 'Verifying Kubernetes connectivity...');
        try {
            const healthQuery = new URLSearchParams();
            if (mapped.kubeconfig_path) healthQuery.set('kubeconfig_path', mapped.kubeconfig_path);
            healthQuery.set('context', key);
            console.log(`Checking K8s health with query: ${healthQuery.toString()}`);
            const healthRes = await fetch(`/api/kube/health?${healthQuery}`);
            const healthData = await healthRes.json();
            if (healthData.status === 'ok') {
                logFrontend(key, 'Kubernetes health check passed');
                setHealth(key, 'k8s', 'green', 'Health check passed');
            } else {
                logFrontend(key, `WARNING: K8s health: ${healthData.message || 'unhealthy'}`);
                setHealth(key, 'k8s', 'red', healthData.message || 'Unhealthy');
            }
        } catch {
            logFrontend(key, 'WARNING: K8s health check failed (non-critical)');
            setHealth(key, 'k8s', 'red', 'Health check failed');
        }

        logSystem(key, '\u2014 Connected successfully \u2014');
        showToast(`Connected "${session.name}"`, 'success');

        // Auto-check port + tunnel health (non-blocking)
        Promise.all([
            checkSessionHealth(key, 'port'),
            checkSessionHealth(key, 'tunnel'),
        ]).then(() => renderAll());

    } catch (err) {
        logFrontend(key, `FAILED: ${err.message}`);
        logSystem(key, '\u2014 Connection failed \u2014');
        showToast(err.message, 'error');
    }

    await fetchSessions();
    refreshConsoleBody();
}

async function fetchAndAppendLogs(key) {
    try {
        const session = sessions.find(s => s.key === key);
        const tunnelId = session?.tunnelId;
        if (!tunnelId) return;

        const tab = consoleTabs[key];
        if (!tab) return;

        if (!tab._lastLogCount) tab._lastLogCount = 0;

        const res = await fetch(`/api/tunnels/${tunnelId}/logs`);
        if (!res.ok) return;
        const data = await res.json();
        const allLogs = data.logs || [];
        const newEntries = allLogs.slice(tab._lastLogCount);
        tab._lastLogCount = allLogs.length;

        newEntries.forEach(entry => appendLog(tab, { stream: entry.type, text: entry.text }));

        if (newEntries.length && activeConsoleKey === key) {
            refreshConsoleBody();
        }
    } catch { /* non-critical */ }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Render both sidebar and dashboard content
function renderAll() {
    renderSidebar();
    refreshDashboardContent();
}

// === DASHBOARD PANE ===

let dashboardView = 'grouped';
let dashboardQuery = '';

const sessionSearchIndex = new WeakMap();

function buildSearchIndex(session) {
    return Object.values(session).join('\x00').toLowerCase();
}

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
    const [html] = await Promise.all([fetchPage('dashboard'), fetchSessions()]);
    mainContentBody.innerHTML = html;

    const searchInput = document.getElementById('dashboardSearch');
    const viewBtns = document.querySelectorAll('.dashboard-view-toggle .view-btn');

    searchInput.value = dashboardQuery;
    viewBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.view === dashboardView));

    refreshDashboardContent();
    refreshDashboardStats();
    renderConsoleTabs();

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            dashboardQuery = searchInput.value.trim();
            refreshDashboardContent();
        }, 80);
    });

    viewBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            dashboardView = btn.dataset.view;
            viewBtns.forEach(b => b.classList.toggle('active', b === btn));
            refreshDashboardContent();
        });
    });
}

function refreshDashboardContent() {
    if (currentPane !== 'dashboardPane') return;
    const container = document.getElementById('dashboardContent');
    if (!container) return;

    const filtered = filterSessions(dashboardQuery);
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

async function refreshDashboardStats() {
    if (currentPane !== 'dashboardPane') return;
    try {
        const res = await fetch('/api/sessions/stats');
        const stats = await res.json();
        const el = (id) => document.getElementById(id);
        if (el('statActive')) el('statActive').textContent = stats.active_sessions;
        if (el('statTotal')) el('statTotal').textContent = stats.total_sessions;
        if (el('statConnections')) el('statConnections').textContent = stats.total_connections;
        if (el('statErrors')) el('statErrors').textContent = stats.errored_sessions;
        if (el('statRegions')) el('statRegions').textContent = stats.regions;
    } catch { /* non-critical */ }
}

function renderGroupedView(container, filtered, groupKey) {
    const groups = {};
    filtered.forEach(s => {
        const gid = s[groupKey] || 'ungrouped';
        if (!groups[gid]) groups[gid] = [];
        groups[gid].push(s);
    });

    for (const [groupId, groupSessions] of Object.entries(groups)) {
        const group = document.createElement('div');
        group.className = 'dashboard-group';

        const badgeHtml = groupKey !== 'region'
            ? `<span class="dashboard-group-badge">${groupSessions[0].region}</span>`
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

function healthIndicatorsHtml(session) {
    const h = getHealth(session.key);
    const items = [
        { key: 'k8s',    icon: 'fa-dharmachakra', label: 'K8s' },
        { key: 'port',   icon: 'fa-plug',         label: 'Port' },
        { key: 'tunnel', icon: 'fa-link',          label: 'Tunnel' },
    ];
    return items.map(i => {
        const st = indicatorStatus(h, i.key);
        const detail = indicatorDetail(h, i.key);
        return `<span class="health-dot health-${st}" data-check="${i.key}" data-key="${session.key}" title="${i.label}: ${detail}">
            <i class="fa-solid ${i.icon}"></i>
        </span>`;
    }).join('');
}

function sessionIcon(session) {
    if (session.status === 'starting') return 'fa-spinner fa-spin';
    if (session.status === 'stopping') return 'fa-spinner fa-spin';
    if (session.status === 'port_conflict') return 'fa-triangle-exclamation';
    return 'fa-power-off';
}

function sessionBtnClass(session) {
    if (session.status === 'active' || session.status === 'stopping') return 'on';
    if (session.status === 'port_conflict') return 'conflict';
    return 'off';
}

function createDashboardCard(session) {
    const el = document.createElement('div');
    el.className = 'session-item';
    el.dataset.sessionKey = session.key;
    if (isActive(session)) el.classList.add('active');
    if (session.status === 'error') el.classList.add('error');
    if (session.status === 'starting') el.classList.add('starting');
    if (session.status === 'stopping') el.classList.add('stopping');
    if (isPortConflict(session)) el.classList.add('port-conflict');
    if (tunnelBusy && !isBusy(session)) el.classList.add('tunnel-lock');

    const btnClass = sessionBtnClass(session);
    const btnIcon = sessionIcon(session);
    const isOn = btnClass === 'on';
    const isConflict = isPortConflict(session);

    const checking = isChecking(session.key);
    const locked = isConflict || checking || isBusy(session);
    const btnTitle = isConflict ? `Port ${session.localPort} in use by PID ${session.portPid}` : (isOn ? 'Disconnect' : 'Connect');
    const btnDisabled = locked ? 'disabled' : '';
    const conflictWarning = isConflict
        ? `<div class="session-conflict-warning"><i class="fa-solid fa-triangle-exclamation"></i> Port in use by external process (PID ${session.portPid})</div>`
        : '';

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
            <div class="session-actions">
                <button class="session-btn session-refresh-btn ${checking ? 'spinning' : ''}" title="Refresh health" ${checking ? 'disabled' : ''}>
                    <i class="fa-solid fa-arrows-rotate"></i>
                </button>
                <button class="session-btn port-kill-btn" title="Force kill process on port ${session.localPort}">
                    <i class="fa-solid fa-skull-crossbones"></i>
                </button>
                <button class="session-btn session-shutdown ${btnClass}" title="${btnTitle}" ${btnDisabled}>
                    <span class="shutdown-icon">
                        <i class="fa-solid ${btnIcon}"></i>
                    </span>
                </button>
            </div>
        </div>
        ${conflictWarning}
        <div class="session-bottom">
            <span class="session-ports">${session.localPort} &rarr; <span class="session-region">${session.region}</span>:${session.remotePort}</span>
            <div class="session-health">${healthIndicatorsHtml(session)}</div>
        </div>
    `;

    el.querySelector('.session-shutdown').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSession(session);
    });

    el.querySelector('.session-refresh-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isChecking(session.key)) return;
        await checkSessionHealth(session.key);
        renderAll();
    });

    el.querySelectorAll('.health-dot').forEach(dot => {
        dot.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (isChecking(session.key)) return;
            await checkSessionHealth(session.key, dot.dataset.check);
            renderAll();
        });
    });

    el.querySelector('.port-kill-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        forceKillPort(session);
    });

    // Click card body to open console
    el.addEventListener('click', () => openConsoleTab(session.key));

    return el;
}

// === FULL-SCREEN LOGS PAGE ===

let logsPageActiveKey = null;

async function renderLogsPage() {
    mainContentBody.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'logs-page';

    // Tabs bar — all tunnels that have logs + System
    const tabsBar = document.createElement('div');
    tabsBar.className = 'logs-page-tabs';

    // Gather keys that have backend logs
    const tunnelKeys = [];
    for (const s of sessions) {
        try {
            const res = await fetch(`/api/tunnels/${s.tunnelId || s.key}/logs`);
            if (res.ok) {
                const data = await res.json();
                if (data.logs && data.logs.length > 0) {
                    tunnelKeys.push({ key: s.key, name: s.name, ci: data.connection_index, logs: data.logs });
                }
            }
        } catch {}
    }

    // System tab always first
    const allTabs = [{ key: SYSTEM_LOG_KEY, name: 'System', ci: null, logs: null }, ...tunnelKeys];
    if (!logsPageActiveKey || !allTabs.find(t => t.key === logsPageActiveKey)) {
        logsPageActiveKey = allTabs.length > 1 ? allTabs[1].key : SYSTEM_LOG_KEY;
    }

    allTabs.forEach(t => {
        const btn = document.createElement('button');
        btn.className = `logs-page-tab${t.key === logsPageActiveKey ? ' active' : ''}`;
        btn.textContent = t.name;
        btn.addEventListener('click', () => {
            logsPageActiveKey = t.key;
            refreshLogsPageBody(container, allTabs);
        });
        tabsBar.appendChild(btn);
    });

    // Action buttons
    const actionsBar = document.createElement('div');
    actionsBar.className = 'logs-page-actions';
    actionsBar.innerHTML = `
        <button class="conn-action-btn logs-page-copy-btn" title="Copy logs"><i class="fa-solid fa-copy"></i></button>
        <button class="conn-action-btn logs-page-save-btn" title="Save logs"><i class="fa-solid fa-floppy-disk"></i></button>
    `;
    tabsBar.appendChild(actionsBar);

    container.appendChild(tabsBar);

    const body = document.createElement('div');
    body.className = 'logs-page-body';
    container.appendChild(body);
    mainContentBody.appendChild(container);

    // Copy button
    actionsBar.querySelector('.logs-page-copy-btn').addEventListener('click', async () => {
        const bodyEl = container.querySelector('.logs-page-body');
        if (!bodyEl) return;
        const text = bodyEl.innerText;
        if (!text.trim()) { showToast('Nothing to copy', 'warning'); return; }
        try { await writeClipboard(text); showToast('Logs copied', 'success'); }
        catch { showToast('Failed to copy', 'error'); }
    });

    // Save button
    actionsBar.querySelector('.logs-page-save-btn').addEventListener('click', async () => {
        const activeTab = allTabs.find(t => t.key === logsPageActiveKey);
        if (!activeTab) return;

        try {
            if (activeTab.key === SYSTEM_LOG_KEY) {
                const tab = consoleTabs[SYSTEM_LOG_KEY];
                if (!tab || !tab.logs.length) { showToast('No logs to save', 'warning'); return; }
                const res = await fetch('/api/consts/browse-folder', { method: 'POST' });
                const data = await res.json();
                if (data.status === 'cancelled') return;
                if (!data.folder) { showToast(data.error || 'Failed', 'error'); return; }
                const prefix = `system_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
                await fetch('/api/consts/save-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folder: data.folder, filename: `${prefix}.log`, content: formatConsoleLogs(tab) }),
                });
                showToast(`Saved in ${data.folder}`, 'success');
            } else {
                const tunnelId = activeTab.key;
                const res = await fetch(`/api/tunnels/${tunnelId}/logs/save`, { method: 'POST' });
                const data = await res.json();
                if (data.status === 'cancelled') return;
                if (data.status === 'saved') {
                    showToast(`Saved in ${data.folder} (${data.prefix})`, 'success');
                } else {
                    // Tunnel not found — fall back to folder picker for client logs
                    const cTab = consoleTabs[activeTab.key];
                    if (!cTab || !cTab.logs.length) { showToast('No logs to save', 'warning'); return; }
                    const folderRes = await fetch('/api/consts/browse-folder', { method: 'POST' });
                    const folderData = await folderRes.json();
                    if (folderData.status === 'cancelled') return;
                    if (!folderData.folder) { showToast(folderData.error || 'Failed', 'error'); return; }
                    const prefix = `${activeTab.key}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
                    await fetch('/api/consts/save-file', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ folder: folderData.folder, filename: `${prefix}_client.log`, content: formatConsoleLogs(cTab) }),
                    });
                    showToast(`Saved in ${folderData.folder} (${prefix})`, 'success');
                }
            }
        } catch (err) { showToast(err.message, 'error'); }
    });

    refreshLogsPageBody(container, allTabs);
}

function refreshLogsPageBody(container, allTabs) {
    // Update tab active states
    container.querySelectorAll('.logs-page-tab').forEach((btn, i) => {
        btn.classList.toggle('active', allTabs[i].key === logsPageActiveKey);
    });

    const body = container.querySelector('.logs-page-body');
    body.innerHTML = '';

    const activeTab = allTabs.find(t => t.key === logsPageActiveKey);
    if (!activeTab) return;

    let entries;
    if (activeTab.key === SYSTEM_LOG_KEY) {
        const tab = consoleTabs[SYSTEM_LOG_KEY];
        entries = (tab ? tab.logs : []).map(e => ({ ts: null, ci: null, type: e.stream, text: e.text }));
    } else {
        entries = activeTab.logs || [];
    }

    if (entries.length === 0) {
        body.innerHTML = '<div class="logs-page-empty">No logs</div>';
        return;
    }

    const LOGS_TYPE_PREFIXES = {
        stdout:   '[tunnel] ',
        stderr:   '[error]  ',
        frontend: '[client] ',
        system:   '[system] ',
    };

    entries.forEach(entry => {
        const line = document.createElement('div');
        line.className = `console-line ${entry.type}`;

        // Timestamp
        const tsSpan = document.createElement('span');
        tsSpan.className = 'logs-page-ts';
        if (entry.ts) {
            const d = new Date(entry.ts * 1000);
            tsSpan.textContent = d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }) + ' ';
        }
        line.appendChild(tsSpan);

        // Connection index
        if (entry.ci != null) {
            const ciSpan = document.createElement('span');
            ciSpan.className = 'logs-page-ci';
            ciSpan.textContent = `#${entry.ci} `;
            line.appendChild(ciSpan);
        }

        // Prefix + text
        const prefix = document.createElement('span');
        prefix.className = 'console-prefix';
        prefix.textContent = LOGS_TYPE_PREFIXES[entry.type] || '';
        line.appendChild(prefix);
        line.appendChild(document.createTextNode(entry.text));

        body.appendChild(line);
    });

    body.scrollTop = body.scrollHeight;
}

// === CONSOLE PANEL ===

// Each tab: { open, logs: [{stream, text}], _lastLogCount }
const consoleTabs = {};
let activeConsoleKey = null;

function ensureConsoleTab(key) {
    if (!consoleTabs[key]) {
        consoleTabs[key] = { open: false, logs: [], _lastLogCount: 0 };
    }
    return consoleTabs[key];
}

// Flush buffered system logs now that ensureConsoleTab/appendLog are available
(() => {
    const tab = ensureConsoleTab(SYSTEM_LOG_KEY);
    _systemLogBuffer.forEach(entry => tab.logs.push(entry));
    _systemLogBuffer.length = 0;
    _systemLogReady = true;
})();

function appendLog(tab, entry) {
    tab.logs.push(entry);
    const maxSize = getSetting('max_log_size');
    if (maxSize > 0 && tab.logs.length > maxSize) {
        const trimCount = tab.logs.length - maxSize;
        tab.logs.splice(0, trimCount);
        // Reset rendered count so console re-renders correctly
        _consoleRenderedCount = Math.max(0, _consoleRenderedCount - trimCount);
    }
}

function pushLogToBackend(key, type, text) {
    const session = sessions.find(s => s.key === key);
    const tunnelId = session?.tunnelId || key;
    // Fire-and-forget — don't await, don't block UI
    fetch(`/api/tunnels/${tunnelId}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, text, ts: Date.now() / 1000 }),
    }).catch(() => {});
}

function logFrontend(key, msg) {
    const tab = ensureConsoleTab(key);
    appendLog(tab, { stream: 'frontend', text: msg });
    pushLogToBackend(key, 'frontend', msg);
    if (activeConsoleKey === key) refreshConsoleBody();
}

function logSystem(key, msg) {
    const tab = ensureConsoleTab(key);
    appendLog(tab, { stream: 'system', text: msg });
    pushLogToBackend(key, 'system', msg);
    if (activeConsoleKey === key) refreshConsoleBody();
}

function openConsoleTab(key) {
    const tab = ensureConsoleTab(key);
    tab.open = true;
    activeConsoleKey = key;
    renderConsoleTabs();
    refreshConsoleBody();
}

function closeConsoleTab(key) {
    if (key === SYSTEM_LOG_KEY) return; // System tab is non-dismissable
    if (consoleTabs[key]) {
        consoleTabs[key].open = false;
    }
    if (activeConsoleKey === key) {
        const openKeys = Object.keys(consoleTabs).filter(k => consoleTabs[k].open || k === SYSTEM_LOG_KEY);
        activeConsoleKey = openKeys.length > 0 ? openKeys[openKeys.length - 1] : null;
    }
    renderConsoleTabs();
    refreshConsoleBody();
}

function updateConsolePanelVisibility() {
    const panel = document.getElementById('consolePanel');
    if (!panel) return;
    // Always visible — System tab is always present
    panel.style.display = '';
}

function renderConsoleTabs() {
    const tabsEl = document.getElementById('consoleTabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = '';

    // System tab is always first and non-dismissable
    ensureConsoleTab(SYSTEM_LOG_KEY);
    const sysEl = document.createElement('button');
    sysEl.className = `console-tab console-tab-system${SYSTEM_LOG_KEY === activeConsoleKey ? ' active' : ''}`;
    sysEl.innerHTML = `<span class="console-tab-dot system-dot"></span>System`;
    sysEl.addEventListener('click', () => {
        activeConsoleKey = SYSTEM_LOG_KEY;
        renderConsoleTabs();
        refreshConsoleBody();
    });
    tabsEl.appendChild(sysEl);

    for (const [key, tab] of Object.entries(consoleTabs)) {
        if (key === SYSTEM_LOG_KEY) continue; // already rendered above
        if (!tab.open) continue;
        const session = sessions.find(s => s.key === key);
        const name = session ? session.name : key;
        const status = session ? session.status : 'inactive';

        const tabEl = document.createElement('button');
        tabEl.className = `console-tab${key === activeConsoleKey ? ' active' : ''}`;
        tabEl.innerHTML = `
            <span class="console-tab-dot ${status}"></span>
            ${name}
            <span class="console-tab-close" title="Close"><i class="fa-solid fa-xmark"></i></span>
        `;

        tabEl.addEventListener('click', (e) => {
            if (e.target.closest('.console-tab-close')) {
                closeConsoleTab(key);
            } else {
                activeConsoleKey = key;
                renderConsoleTabs();
                refreshConsoleBody();
            }
        });

        tabsEl.appendChild(tabEl);
    }

    updateConsolePanelVisibility();
}

const STREAM_PREFIXES = {
    stdout:   '[tunnel] ',
    stderr:   '[error]  ',
    frontend: '[client] ',
    system:   '         ',
};

let _consoleRenderedKey = null;
let _consoleRenderedCount = 0;

function refreshConsoleBody() {
    const bodyEl = document.getElementById('consoleBody');
    if (!bodyEl) return;

    if (!activeConsoleKey) {
        bodyEl.innerHTML = '<div class="console-empty">No session selected</div>';
        _consoleRenderedKey = null;
        _consoleRenderedCount = 0;
        return;
    }

    const tab = consoleTabs[activeConsoleKey];
    if (!tab || tab.logs.length === 0) {
        bodyEl.innerHTML = '<div class="console-empty">No output yet</div>';
        _consoleRenderedKey = null;
        _consoleRenderedCount = 0;
        return;
    }

    // If switching tabs, full re-render
    if (_consoleRenderedKey !== activeConsoleKey) {
        bodyEl.innerHTML = '';
        _consoleRenderedCount = 0;
        _consoleRenderedKey = activeConsoleKey;
    }

    // Only append new lines
    const newEntries = tab.logs.slice(_consoleRenderedCount);
    if (newEntries.length === 0) return;

    // Check if user has scrolled up (not at bottom)
    const wasAtBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 20;

    newEntries.forEach(entry => {
        const div = document.createElement('div');
        div.className = `console-line ${entry.stream}`;

        const prefix = document.createElement('span');
        prefix.className = 'console-prefix';
        prefix.textContent = STREAM_PREFIXES[entry.stream] || '';

        div.appendChild(prefix);
        div.appendChild(document.createTextNode(entry.text));
        bodyEl.appendChild(div);
    });

    _consoleRenderedCount = tab.logs.length;

    // Only auto-scroll if user was already at the bottom
    if (wasAtBottom) {
        bodyEl.scrollTop = bodyEl.scrollHeight;
    }
}

// === HEALTH CHECKER (polls every 5s) ===


// === CONNECTIONS PANE ===

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

async function goBackToConnections() {
    await fetchSessions();
    renderSidebar();
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

        // Build set of referenced connection IDs
        const referencedIds = new Set();
        Object.values(userConnections).forEach(uc => referencedIds.add(uc.connection_id));

        // Build set of clashing ports
        const clashingPorts = new Set();
        for (const [port, users] of Object.entries(usedPorts)) {
            if (users.length > 1) clashingPorts.add(port);
        }

        const duplicates = findDuplicateConnections(connections);

        // Connections list
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

        // User connections list
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

    let dupIcon = '';
    if (flags.duplicateOf && flags.duplicateOf.length > 0) {
        const dupNames = flags.duplicateOf.join(', ');
        dupIcon = `<i class="fa-solid fa-triangle-exclamation conn-duplicate-warn" title="Duplicate of: ${dupNames}"></i>`;
    }

    const clashIcon = flags.portClash
        ? '<i class="fa-solid fa-triangle-exclamation conn-port-clash" title="Port conflict"></i>'
        : '';

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
            if (action === 'duplicate') {
                if (type === 'connection') {
                    renderCreateConnectionForm({ ...data, id: '' }, null);
                } else {
                    renderCreateUserConnectionForm({ ...(data._raw || data), connection_name: '' }, null);
                }
            }
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
    document.querySelector('.main-content').appendChild(overlay);
    overlay.querySelector('#shareCopyBtn').addEventListener('click', async () => {
        try { await writeClipboard(encoded); showToast('Copied to clipboard', 'success'); }
        catch { showToast('Failed to copy', 'error'); }
    });
    overlay.querySelector('#shareCloseBtn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
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

// --- Helpers ---

function populateSelect(selectEl, items, valueKey, labelKey) {
    selectEl.innerHTML = '';
    items.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item[valueKey];
        opt.textContent = item[labelKey];
        selectEl.appendChild(opt);
    });
}

// === CREATE/EDIT CONNECTION FORM ===

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
            if (config) { fillConnectionForm(config); showToast('Pre-filled from clipboard', 'success'); }
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
        showToast(`Connection "${name}" ${isEdit ? 'updated' : 'created'}`, 'success');
        invalidateCaches();
        setTimeout(goBackToConnections, 600);
    } catch (err) {
        msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${err.message}</div>`;
    }
}

// === CREATE/EDIT USER CONNECTION (SESSION) FORM ===

async function renderCreateUserConnectionForm(editData = null, editKey = null) {
    mainContentBody.innerHTML = '';
    const isEdit = editData !== null && editKey !== null;
    mainTopbarTitle.textContent = isEdit ? 'Edit Session' : 'New Session';

    const [html, connections, usedPorts] = await Promise.all([
        fetchPage('create_user_connection'), fetchConnections(), fetchUsedPorts()
    ]);

    const connKeys = Object.keys(connections);
    if (connKeys.length === 0) {
        mainContentBody.innerHTML = `
            <div class="form-container">
                <div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> No connections available. Create a connection first.</div>
                <div class="form-actions"><button class="conn-btn secondary" id="backBtn">Back</button></div>
            </div>
        `;
        document.getElementById('backBtn').addEventListener('click', goBackToConnections);
        return;
    }

    mainContentBody.innerHTML = html;

    if (isEdit) {
        document.getElementById('formTitleText').textContent = 'Edit Session';
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
    const kubeconfigDefault = getSetting('default_kubeconfig_path') || CONSTS.defaults.kubeconfig_path;
    document.getElementById('ucKubeconfig').value = kubeconfigDefault;
    document.getElementById('ucKubeconfig').placeholder = kubeconfigDefault;

    if (editData) fillUserConnectionForm(editData, connections);

    const portInput = document.getElementById('ucLocalPort');
    const portWarning = document.getElementById('portWarning');
    portInput.addEventListener('input', () => {
        const port = portInput.value.trim();
        portWarning.innerHTML = '';
        if (port && usedPorts && usedPorts[port]) {
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
            if (config) { fillUserConnectionForm(config, connections); showToast('Pre-filled from clipboard', 'success'); }
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

    const body = { connection_id: connectionId, bastion_id: bastionId, local_port: parseInt(localPort), profile, connection_name: connectionName };
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
        if (data.warnings) data.warnings.forEach(w => showToast(w, 'warning', 5000));
        showToast(`Session "${connectionName}" ${isEdit ? 'updated' : 'created'}`, 'success');
        invalidateCaches();
        setTimeout(goBackToConnections, 600);
    } catch (err) {
        msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${err.message}</div>`;
    }
}

// === IMPORT FORM ===

async function renderImportForm() {
    mainContentBody.innerHTML = '';
    mainTopbarTitle.textContent = 'Import Connection';

    const html = await fetchPage('import_connection');
    mainContentBody.innerHTML = html;

    let activeTab = 'encoded';
    let parsedFileData = null;
    let detectedFileKind = null;

    document.getElementById('tabEncoded').addEventListener('click', () => {
        activeTab = 'encoded';
        document.getElementById('tabEncoded').classList.add('active');
        document.getElementById('tabFile').classList.remove('active');
        document.getElementById('importEncodedSection').style.display = '';
        document.getElementById('importFileSection').style.display = 'none';
    });

    document.getElementById('tabFile').addEventListener('click', () => {
        activeTab = 'file';
        document.getElementById('tabFile').classList.add('active');
        document.getElementById('tabEncoded').classList.remove('active');
        document.getElementById('importEncodedSection').style.display = 'none';
        document.getElementById('importFileSection').style.display = '';
    });

    document.getElementById('importFile').addEventListener('change', () => {
        const file = document.getElementById('importFile').files[0];
        if (!file) return;
        document.getElementById('importFileName').textContent = file.name;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                parsedFileData = JSON.parse(e.target.result);
                detectedFileKind = detectKind(parsedFileData);
                document.getElementById('importFilePreview').style.display = '';
                document.getElementById('importDetectedKind').textContent = detectedFileKind ? detectedFileKind.toUpperCase() : 'UNKNOWN';
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
            let configData = null, kind = null;
            if (activeTab === 'encoded') {
                const encoded = document.getElementById('importEncoded').value.trim();
                if (!encoded) { msgEl.innerHTML = '<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Please paste an encoded string.</div>'; return; }
                const res = await fetch('/api/configs/share/decode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ encoded }) });
                const decoded = await res.json();
                if (!res.ok) { msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${decoded.error}</div>`; return; }
                kind = decoded.kind;
                configData = decoded.config;
            } else {
                if (!parsedFileData) { msgEl.innerHTML = '<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Please select a valid JSON file.</div>'; return; }
                kind = detectedFileKind;
                configData = parsedFileData;
            }
            if (!kind || !configData) { msgEl.innerHTML = '<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Could not detect config type.</div>'; return; }
            showToast(`Imported ${kind} config \u2014 review and save`, 'info');
            if (kind === 'connection') renderCreateConnectionForm(configData, null);
            else renderCreateUserConnectionForm(configData, null);
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

// === CLIPBOARD ===

async function readClipboard() {
    const res = await fetch('/api/consts/clipboard');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to read clipboard');
    return data.text;
}

async function writeClipboard(text) {
    const res = await fetch('/api/consts/clipboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Failed to write clipboard'); }
}

async function readClipboardConfig(expectedKind) {
    let text;
    try { text = await readClipboard(); } catch { showToast('Cannot read clipboard', 'error'); return null; }
    if (!text || !text.trim()) { showToast('Clipboard is empty', 'warning'); return null; }
    text = text.trim();

    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* try encoded */ }

    if (parsed) {
        if (parsed.kind && parsed.config) {
            if (parsed.kind !== expectedKind) { showToast(`Clipboard has ${parsed.kind}, need ${expectedKind}`, 'error'); return null; }
            return parsed.config;
        }
        const kind = detectKind(parsed);
        if (kind === expectedKind) return parsed;
        if (kind) { showToast(`Clipboard has ${kind}, need ${expectedKind}`, 'error'); return null; }
        showToast('Clipboard JSON not a known config', 'error');
        return null;
    }

    try {
        const res = await fetch('/api/configs/share/decode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ encoded: text }) });
        if (res.ok) {
            const decoded = await res.json();
            if (decoded.kind !== expectedKind) { showToast(`Encoded has ${decoded.kind}, need ${expectedKind}`, 'error'); return null; }
            return decoded.config;
        }
    } catch { /* ignore */ }

    showToast('Clipboard not valid JSON or encoded string', 'error');
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
            row.innerHTML = `<input class="form-input" placeholder="Name" data-bastion="key" value="${bKey}" /><input class="form-input" placeholder="Instance ID" data-bastion="value" value="${bVal}" /><button class="bastion-remove-btn" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
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

// === ADVANCED ===

async function renderAdvanced() {
    const [html, userConnections] = await Promise.all([
        fetchPage('advanced'),
        fetch('/api/configs/user').then(r => r.json())
    ]);

    mainContentBody.innerHTML = html;

    // Nuke port chips from user connection ports
    const chipsEl = document.getElementById('nukePortChips');
    const ports = new Set();
    for (const uc of Object.values(userConnections)) {
        ports.add(uc.local_port);
    }

    for (const port of ports) {
        const chip = document.createElement('button');
        chip.className = 'nuke-chip';
        chip.innerHTML = `<i class="fa-solid fa-skull-crossbones"></i> ${port}`;
        chip.addEventListener('click', () => nukePort(port));
        chipsEl.appendChild(chip);
    }

    // Nuke custom port
    document.getElementById('nukePortBtn').addEventListener('click', () => {
        const port = parseInt(document.getElementById('nukePortInput').value);
        if (!port || port < 1 || port > 65535) {
            showToast('Enter a valid port (1-65535)', 'warning');
            return;
        }
        nukePort(port);
    });

    // Replace all configs
    const configPathInput = document.getElementById('replaceConfigPath');
    configPathInput.value = getSetting('default_kubeconfig_path') || '~/.kube/config';

    document.getElementById('replaceConfigBrowse').addEventListener('click', async () => {
        const current = configPathInput.value || '~';
        const dir = current.includes('/') || current.includes('\\')
            ? current.substring(0, Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\')))
            : current;
        try {
            const res = await fetch('/api/consts/browse-save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initial_dir: dir, default_name: 'config', filetypes: [["All files", "*.*"]] })
            });
            const data = await res.json();
            if (data.path) configPathInput.value = data.path;
        } catch {
            showToast('Failed to open file picker', 'error');
        }
    });

    document.getElementById('replaceConfigBtn').addEventListener('click', async () => {
        const newPath = configPathInput.value.trim();
        if (!newPath) {
            showToast('Enter a kubeconfig path', 'warning');
            return;
        }

        if (!confirm(`Replace kubeconfig path on ALL user connections with:\n\n${newPath}\n\nThis cannot be undone.`)) return;

        try {
            const res = await fetch('/api/configs/user/replace-kubeconfig', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kubeconfig_path: newPath })
            });
            const data = await res.json();
            if (res.ok) {
                showToast(`Updated ${data.updated} connections`, 'success');
            } else {
                showToast(data.error || 'Failed to replace configs', 'error');
            }
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
}

async function nukePort(port) {
    // Check what's on the port first
    let pid;
    try {
        const checkRes = await fetch(`/api/consts/port/${port}/pid`);
        const checkData = await checkRes.json();
        pid = checkData.pid;
    } catch {
        showToast(`Failed to check port ${port}`, 'error');
        return;
    }

    if (pid === -1) {
        showToast(`Nothing listening on port ${port}`, 'info');
        return;
    }

    if (!confirm(`PID ${pid} is listening on port ${port}.\n\nKill it?`)) return;

    try {
        const res = await fetch('/api/pipelines/kill-port', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port })
        });
        const data = await res.json();
        if (data.killed) {
            showToast(`Killed PID ${pid} on port ${port}`, 'success');
        } else {
            showToast(data.error || `Failed to kill PID ${pid}`, 'error');
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// === SETTINGS ===

async function renderSettings() {
    const [html, settings] = await Promise.all([
        fetchPage('settings'),
        fetch('/api/settings').then(r => r.json())
    ]);

    mainContentBody.innerHTML = html;

    const schema = CONSTS.settings_schema;
    const grid = document.getElementById('settingsGrid');

    // Sort by order, then group by group name
    const sorted = Object.entries(schema).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

    let currentGroup = null;
    for (const [key, meta] of sorted) {
        // Render group heading when group changes, divider after previous group
        if (meta.group !== currentGroup) {
            if (currentGroup) {
                const divider = document.createElement('div');
                divider.className = 'settings-group-divider';
                grid.appendChild(divider);
            }
            currentGroup = meta.group || null;
            if (meta.group) {
                const heading = document.createElement('div');
                heading.className = 'settings-group-heading';
                heading.textContent = currentGroup;
                grid.appendChild(heading);
            }
        }

        const formGroup = document.createElement('div');
        formGroup.className = 'form-group';
        if (meta.solo) formGroup.classList.add('full-width');

        const value = settings[key] !== undefined ? settings[key] : meta.default;
        const hintHtml = meta.hint ? `<span class="form-hint">${meta.hint}</span>` : '';

        if (meta.type === 'path') {
            formGroup.innerHTML = `
                <label class="form-label">${meta.label}</label>
                <div class="setting-path-row">
                    <input class="form-input" id="setting_${key}" type="text" value="${value}" />
                    <button class="conn-action-btn setting-browse-btn" data-key="${key}" title="Browse">
                        <i class="fa-solid fa-folder-open"></i>
                    </button>
                </div>
                ${hintHtml}
            `;
        } else {
            const minAttr = meta.min !== undefined ? `min="${meta.min}"` : '';
            formGroup.innerHTML = `
                <label class="form-label">${meta.label}</label>
                <input class="form-input" id="setting_${key}" type="number" ${minAttr} value="${value}" />
                ${hintHtml}
            `;
        }

        grid.appendChild(formGroup);
    }

    // Browse buttons
    grid.querySelectorAll('.setting-browse-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const settingKey = btn.dataset.key;
            const input = document.getElementById(`setting_${settingKey}`);
            try {
                const current = input.value || '~';
                const dir = current.includes('/') || current.includes('\\')
                    ? current.substring(0, Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\')))
                    : current;
                const res = await fetch('/api/consts/browse-save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ initial_dir: dir, default_name: 'config', filetypes: [["All files", "*.*"]] })
                });
                const data = await res.json();
                if (data.path) input.value = data.path;
            } catch {
                showToast('Failed to open folder picker', 'error');
            }
        });
    });

    document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
        const body = {};
        let valid = true;

        for (const [key, meta] of Object.entries(schema)) {
            const input = document.getElementById(`setting_${key}`);
            if (meta.type === 'number') {
                const val = Number(input.value);
                if (meta.min !== undefined && val < meta.min) {
                    showToast(`${meta.label}: minimum is ${meta.min}`, 'error');
                    input.focus();
                    valid = false;
                    break;
                }
                body[key] = val;
            } else {
                body[key] = input.value;
            }
        }

        if (!valid) return;

        const res = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (res.ok) {
            SETTINGS = await res.json();
            showToast('Settings saved', 'success');
        } else {
            const data = await res.json();
            showToast(data.error || 'Failed to save settings', 'error');
        }
    });

    document.getElementById('resetSettingsBtn').addEventListener('click', async () => {
        const res = await fetch('/api/settings/defaults');
        const defaults = await res.json();

        for (const [key, meta] of Object.entries(schema)) {
            const input = document.getElementById(`setting_${key}`);
            input.value = defaults[key] !== undefined ? defaults[key] : meta.default;
        }
        showToast('Reset to defaults (not saved yet)', 'info');
    });
}

// === SIDEBAR ===

function renderSidebar() {
    const activeList = document.getElementById('activeSessions');
    const availableList = document.getElementById('availableSessions');
    const activeCount = document.getElementById('activeCount');

    activeList.innerHTML = '';
    availableList.innerHTML = '';
    let numActive = 0;

    sessions.forEach(session => {
        const item = createSidebarItem(session);
        if (isActive(session) || isBusy(session)) {
            activeList.appendChild(item);
            numActive++;
        } else {
            availableList.appendChild(item);
        }
    });

    activeCount.textContent = numActive;
}

function createSidebarItem(session) {
    const el = document.createElement('div');
    el.className = 'sidebar-session-item';
    el.dataset.sessionKey = session.key;
    if (isActive(session)) el.classList.add('active');
    if (session.status === 'error') el.classList.add('error');
    if (session.status === 'starting') el.classList.add('starting');
    if (session.status === 'stopping') el.classList.add('stopping');
    if (isPortConflict(session)) el.classList.add('port-conflict');

    const isOn = isActive(session) || session.status === 'stopping';
    const conflict = isPortConflict(session);
    const checking = isChecking(session.key);
    const locked = conflict || checking || isBusy(session);
    const btnIcon = isBusy(session) ? 'fa-spinner fa-spin' : (conflict ? 'fa-triangle-exclamation' : 'fa-power-off');
    const btnClass = isOn ? 'on' : (conflict ? 'conflict' : 'off');
    const btnDisabled = locked ? 'disabled' : '';

    el.innerHTML = `
        <div class="sidebar-session-top">
            <span class="sidebar-session-name" title="${session.name}">${session.name}</span>
            <div class="sidebar-session-actions">
                <button class="sidebar-action-btn sidebar-refresh-btn ${checking ? 'spinning' : ''}" title="Refresh health" ${checking ? 'disabled' : ''}>
                    <i class="fa-solid fa-arrows-rotate"></i>
                </button>
                <button class="sidebar-action-btn sidebar-nuke-btn" title="Force kill port ${session.localPort}">
                    <i class="fa-solid fa-skull-crossbones"></i>
                </button>
                <button class="sidebar-action-btn sidebar-power-btn ${btnClass}" title="${conflict ? `Port in use (PID ${session.portPid})` : (isOn ? 'Disconnect' : 'Connect')}" ${btnDisabled}>
                    <i class="fa-solid ${btnIcon}"></i>
                </button>
            </div>
        </div>
        <div class="sidebar-session-detail">
            <span class="sidebar-session-desc">${session.description}</span>
            <span class="session-type-badge">${session.type}</span>
        </div>
        <div class="sidebar-session-bottom">
            <span class="sidebar-session-port">${session.localPort} &rarr; ${session.region}:${session.remotePort}</span>
            <div class="session-health">${healthIndicatorsHtml(session)}</div>
        </div>
    `;

    el.querySelector('.sidebar-power-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSession(session);
    });

    el.querySelector('.sidebar-refresh-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isChecking(session.key)) return;
        await checkSessionHealth(session.key);
        renderAll();
    });

    el.querySelectorAll('.health-dot').forEach(dot => {
        dot.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (isChecking(session.key)) return;
            await checkSessionHealth(session.key, dot.dataset.check);
            renderAll();
        });
    });

    el.querySelector('.sidebar-nuke-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        forceKillPort(session);
    });

    // Click the item body to open its console
    el.addEventListener('click', () => {
        if (currentPane !== 'dashboardPane') {
            currentPane = null;
            switchPane('dashboardPane');
        }
        openConsoleTab(session.key);
    });

    return el;
}

// New Connection button
document.getElementById('newConnectionBtn').addEventListener('click', () => {
    switchPane('configPane');
});

// Refresh all active sessions
document.getElementById('refreshAllBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    refreshAllHealth();
});

document.getElementById('consoleCopyBtn').addEventListener('click', async () => {
    const bodyEl = document.getElementById('consoleBody');
    if (!bodyEl) return;
    const text = bodyEl.innerText;
    if (!text.trim()) { showToast('Nothing to copy', 'warning'); return; }
    try { await writeClipboard(text); showToast('Logs copied', 'success'); }
    catch { showToast('Failed to copy', 'error'); }
});

document.getElementById('consoleRefreshBtn').addEventListener('click', async () => {
    if (!activeConsoleKey) return;
    const tab = consoleTabs[activeConsoleKey];
    if (!tab) return;
    // Reset counter and re-render from scratch
    tab._lastLogCount = 0;
    tab.logs = [];
    _consoleRenderedKey = null;
    _consoleRenderedCount = 0;
    await fetchAndAppendLogs(activeConsoleKey);
    refreshConsoleBody();
    showToast('Logs refreshed', 'info');
});

function formatConsoleLogs(tab) {
    return tab.logs.map(entry => {
        const d = new Date();
        const ts = d.toISOString().replace('T', ' ').replace('Z', '').slice(0, -1);
        const prefix = STREAM_PREFIXES[entry.stream] || '';
        return `[${ts}] ${prefix.trim()} ${entry.text}`;
    }).join('\n');
}

document.getElementById('consoleSaveBtn').addEventListener('click', async () => {
    if (!activeConsoleKey) return;

    const isSystem = activeConsoleKey === SYSTEM_LOG_KEY;
    const tab = consoleTabs[activeConsoleKey];

    try {
        if (isSystem) {
            // System tab — no tunnel, just save client logs via folder picker
            if (!tab || !tab.logs.length) {
                showToast('No logs to save', 'warning');
                return;
            }
            const res = await fetch('/api/consts/browse-folder', { method: 'POST' });
            const data = await res.json();
            if (data.status === 'cancelled') return;
            if (!data.folder) {
                showToast(data.error || 'Failed to pick folder', 'error');
                return;
            }
            const prefix = `system_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
            await fetch('/api/consts/save-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    folder: data.folder,
                    filename: `${prefix}.log`,
                    content: formatConsoleLogs(tab),
                }),
            });
            showToast(`Saved in ${data.folder}`, 'success');
        } else {
            // Tunnel tab — try saving backend logs first, fall back to folder picker if tunnel not found
            const session = sessions.find(s => s.key === activeConsoleKey);
            const tunnelId = session?.tunnelId || activeConsoleKey;
            let folder, prefix;

            const res = await fetch(`/api/tunnels/${tunnelId}/logs/save`, { method: 'POST' });
            const data = await res.json();
            if (data.status === 'cancelled') return;
            if (data.status === 'saved') {
                folder = data.folder;
                prefix = data.prefix;
            } else {
                // Tunnel not found or no backend logs — pick folder for client logs only
                const folderRes = await fetch('/api/consts/browse-folder', { method: 'POST' });
                const folderData = await folderRes.json();
                if (folderData.status === 'cancelled') return;
                if (!folderData.folder) { showToast(folderData.error || 'Failed', 'error'); return; }
                folder = folderData.folder;
                prefix = `${activeConsoleKey}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
            }

            // Save client logs
            if (tab && tab.logs.length) {
                await fetch('/api/consts/save-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        folder: folder,
                        filename: `${prefix}_client.log`,
                        content: formatConsoleLogs(tab),
                    }),
                });
            }

            showToast(`Saved in ${folder} (${prefix})`, 'success');
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
});

// === STARTUP ===

async function rehydrateActiveSessions() {
    const activeSessions = sessions.filter(s => s.status === 'active' && s.tunnelId);
    for (const session of activeSessions) {
        ensureConsoleTab(session.key);
        await fetchAndAppendLogs(session.key);
    }
}

async function init() {
    await Promise.all([loadConsts(), loadSettings()]);
    await fetchSessions();
    renderSidebar();
    switchPane('dashboardPane');
    rehydrateActiveSessions(); // non-blocking: populate logs for active tunnels
}

init();
