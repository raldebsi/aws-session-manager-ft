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
    const stream = level === 'error' ? 'stderr' : (level === 'warn' ? 'console' : 'console');
    const entry = { stream, text: `[${level}] ${text}` };
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
    console.log('[init] Loading consts...');
    const res = await fetch('/api/consts');
    CONSTS = await res.json();
    console.log('[init] Consts loaded:', Object.keys(CONSTS).join(', '));
    return CONSTS;
}

async function loadSettings() {
    console.log('[init] Loading settings...');
    const res = await fetch('/api/settings');
    SETTINGS = await res.json();
    console.log('[init] Settings loaded:', JSON.stringify(SETTINGS));
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
    const res = await fetch(`/api/pages/${pageName}?v=${document.querySelector('script[src*="script.js"]').src.split('v=')[1] || ''}`);
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

let _formDirty = false;

function markFormDirty() { _formDirty = true; }
function clearFormDirty() { _formDirty = false; }

function confirmIfDirty() {
    if (!_formDirty) return true;
    if (confirm('You have unsaved changes. Discard them?')) {
        clearFormDirty();
        return true;
    }
    return false;
}

function switchPane(paneId) {
    if (currentPane === paneId) return;
    if (!confirmIfDirty()) return;
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

const tunnelBusyPorts = new Set(); // UI lock: set of ports currently starting/stopping
const clientStatusOverrides = {};  // key → 'starting'|'stopping' while client pipeline is running
let ssmPluginVerified = false;     // true once SSM plugin availability is confirmed

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
    console.log(`[health] Checking ${check || 'all'} for ${key}...`);
    sessionChecking[key] = true;
    renderAll();

    // Safety release: if the check hangs, unlock after 20s
    const safetyTimer = setTimeout(() => {
        if (sessionChecking[key]) {
            console.warn(`[health] ${key}: safety timeout — releasing lock after 20s`);
            delete sessionChecking[key];
            renderAll();
        }
    }, 20000);

    const query = new URLSearchParams();
    if (check) query.set('check', check);
    const hcTimeout = getSetting('healthcheck_timeout');
    if (hcTimeout) query.set('timeout', hcTimeout);
    const params = query.toString() ? `?${query}` : '';
    try {
        const res = await fetch(`/api/sessions/${key}/health${params}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (!sessionHealth[key]) sessionHealth[key] = {};
        Object.assign(sessionHealth[key], data);
        console.log(`[health] ${key} result:`, JSON.stringify(data));
        return data;
    } catch (err) { console.warn(`[health] ${key} check failed:`, err); return null; }
    finally {
        clearTimeout(safetyTimer);
        delete sessionChecking[key];
    }
}

async function refreshAllHealth() {
    const btn = document.getElementById('refreshAllBtn');
    if (btn) btn.classList.add('spinning');
    await fetchSessions();
    const active = sessions.filter(s => isActive(s));
    console.log(`[health] Refreshing all — ${active.length} active session(s)`);
    await Promise.all(active.map(s => checkSessionHealth(s.key)));
    renderAll();
    if (btn) btn.classList.remove('spinning');
}

async function fetchSessions() {
    const res = await fetch('/api/sessions');
    sessions = await res.json();
    sessions.forEach(s => sessionSearchIndex.delete(s));
    const active = sessions.filter(s => s.status === 'active').length;
    const errored = sessions.filter(s => s.status === 'error').length;
    const conflicts = sessions.filter(s => s.status === 'port_conflict').length;
    console.log(`[sessions] Fetched ${sessions.length} sessions (${active} active, ${errored} errored, ${conflicts} port conflicts)`);
    return sessions;
}

/** Return the effective UI status for a session, considering client-side pipeline overrides. */
function effectiveStatus(session) {
    return clientStatusOverrides[session.key] || session.status;
}

function isActive(session) {
    return effectiveStatus(session) === 'active';
}

function isBusy(session) {
    const s = effectiveStatus(session);
    return s === 'starting' || s === 'stopping';
}

function isPortConflict(session) {
    return effectiveStatus(session) === 'port_conflict';
}

function isPortBusy(port) {
    return tunnelBusyPorts.has(port);
}

let appVersion = null;

async function startupHealthCheck() {
    try {
        const res = await fetch('/health');
        const data = await res.json();
        appVersion = data.app_version || null;
        ssmPluginVerified = !!data.ssm_installed;
        if (ssmPluginVerified) {
            console.log(`[init] App v${appVersion}, SSM Plugin v${data.ssm_version}`);
            showToast(`SSM Manager v${appVersion} — SSM Plugin v${data.ssm_version}`, 'success', 4000);
        } else {
            console.warn(`[init] App v${appVersion}, SSM Plugin not found`);
        }
    } catch (err) {
        console.error('[init] Health check failed:', err);
        ssmPluginVerified = false;
    }
}

async function toggleSession(session) {
    const port = session.localPort;
    if (isPortBusy(port)) { console.log(`[toggle] ${session.key}: blocked — port ${port} busy`); return; }

    if (!ssmPluginVerified) {
        showToast('SSM Plugin not found. Install it from Advanced > Verify SSM Plugin.', 'error', 6000);
        return;
    }

    if (isPortConflict(session)) {
        showToast(`Port ${port} is in use by another process (PID ${session.portPid}). Use the kill button to free it.`, 'warning');
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

    tunnelBusyPorts.add(port);
    const action = isActive(session) ? 'disconnecting' : 'connecting';
    clientStatusOverrides[session.key] = action === 'connecting' ? 'starting' : 'stopping';
    console.log(`[toggle] ${session.key}: ${action}... (port ${port} locked)`);

    try {
        if (action === 'disconnecting') {
            await disconnectSession(session);
        } else {
            await connectSession(session);
        }
        refreshDashboardStats();
    } finally {
        delete clientStatusOverrides[session.key];
        tunnelBusyPorts.delete(port);
        renderAll();
    }
}

// --- Disconnect pipeline ---

async function disconnectSession(session) {
    const key = session.key;
    const name = session.name;
    const tunnelId = session.tunnelId;
    console.log(`[disconnect] ${key}: starting disconnect (tunnelId=${tunnelId})`);

    if (!tunnelId) {
        showToast('No tunnel ID found for this session', 'error');
        return;
    }

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

        console.log(`[disconnect] ${key}: backend confirmed stopped=${data.stopped}, tunnel_state=${data.tunnel_state}`);
        logFrontend(key, 'Tunnel stopped');

        // Fetch final logs from the killed tunnel process
        await fetchAndAppendLogs(key);

        logSystem(key, '\u2014 Connection shut down \u2014');
        showToast(`Disconnected "${name}"`, 'success');
    } catch (err) {
        logFrontend(key, `ERROR: ${err.message}`);
        showToast(err.message, 'error');
    }

    const prevStatus = session.status;
    await fetchSessions();
    const updated = sessions.find(s => s.key === key);
    if (updated && updated.status === 'error' && prevStatus === 'stopping') {
        console.warn(`[disconnect] ${key}: fetchSessions overrode stopping → error (tunnel_state: ${updated.tunnelState})`);
    }
    refreshConsoleBody();
}

// --- Force kill port ---

async function forceKillPort(session) {
    const port = session.localPort;
    console.log(`[nuke] Checking port ${port} for ${session.key}...`);

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
            console.log(`[nuke] Killed PID ${pid} on port ${port}`);
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
    console.log(`[connect] ${key}: starting connect pipeline`);
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
        console.log(`[connect] ${key}: resolved — type=${conn.type}, region=${conn.region}, port=${mapped.local_port}→${conn.remote_port}`);
        logFrontend(key, `Resolved: ${conn.cluster || conn.name} @ ${conn.region} (${conn.type})`);

        // Step 2: Start tunnel
        const connType = (conn.type || 'eks').toLowerCase();
        const isEks = connType === 'eks';
        logFrontend(key, `[2/3] Starting ${connType.toUpperCase()} tunnel...`);
        renderAll();

        const startBody = {
            type: connType,
            profile: mapped.profile,
            endpoint: conn.endpoint,
            bastion: mapped.bastion,
            region: conn.region,
            tunnel_connection_id: key,
            document_name: conn.document,
            local_port: mapped.local_port,
            remote_port: conn.remote_port,
        };
        if (isEks) {
            startBody.cluster_name = conn.cluster;
            startBody.kubeconfig_path = mapped.kubeconfig_path;
        }

        const tunnelRes = await fetch('/api/tunnels/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(startBody)
        });
        const tunnelData = await tunnelRes.json();

        if (tunnelData.warning) {
            console.log(`[connect] ${key}: tunnel already running`);
            logFrontend(key, 'Tunnel already running');
            await fetchSessions();
            return;
        }
        if (!tunnelRes.ok) {
            throw new Error(tunnelData.error || 'Failed to start tunnel');
        }

        const tunnelId = tunnelData.tunnel_id;
        session.tunnelId = tunnelId;
        console.log(`[connect] ${key}: tunnel started (id=${tunnelId})`);
        logFrontend(key, `Tunnel started: ${tunnelId}`);

        // Step 3: Wait for readiness (poll stdout)
        logFrontend(key, '[3/3] Waiting for tunnel readiness...');
        renderAll();

        let ready = false;
        const pollMs = getSetting('polling_interval') * 1000;
        const timeoutMs = getSetting('readiness_timeout') * 1000;
        const maxAttempts = Math.ceil(timeoutMs / pollMs);
        console.log(`[connect] ${key}: polling readiness (interval=${pollMs}ms, timeout=${timeoutMs}ms, maxAttempts=${maxAttempts})`);
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
            console.warn(`[connect] ${key}: readiness timeout — checking tunnel state`);
            // Check if the tunnel process already died
            const stateRes = await fetch(`/api/tunnels/${tunnelId}`);
            if (stateRes.ok) {
                const stateData = await stateRes.json();
                const st = stateData.state;
                if (st && st !== 'starting' && st !== 'running') {
                    throw new Error(`Tunnel process exited (${st})`);
                }
            }
            logFrontend(key, 'WARNING: Readiness not confirmed (timeout) — tunnel may still be starting');
            showToast(`"${session.name}" started but readiness not confirmed`, 'warning');
        } else {
            console.log(`[connect] ${key}: tunnel ready`);
            logFrontend(key, 'Tunnel is ready');
        }

        // Service health check — type-aware
        if (isEks) {
            logFrontend(key, 'Verifying Kubernetes connectivity...');
            try {
                const healthQuery = new URLSearchParams();
                if (mapped.kubeconfig_path) healthQuery.set('kubeconfig_path', mapped.kubeconfig_path);
                healthQuery.set('context', key);
                const hcto = getSetting('healthcheck_timeout');
                if (hcto) healthQuery.set('timeout', hcto);
                const healthRes = await fetch(`/api/kube/health?${healthQuery}`);
                const healthData = await healthRes.json();
                if (healthData.status === 'ok') {
                    logFrontend(key, 'Kubernetes health check passed');
                    setHealth(key, 'service', 'green', 'K8s health check passed');
                } else {
                    logFrontend(key, `WARNING: K8s health: ${healthData.message || 'unhealthy'}`);
                    setHealth(key, 'service', 'red', healthData.message || 'Unhealthy');
                }
            } catch {
                logFrontend(key, 'WARNING: K8s health check failed (non-critical)');
                setHealth(key, 'service', 'red', 'Health check failed');
            }
        } else {
            logFrontend(key, 'Verifying service connectivity...');
            // TCP health check handled by the service health endpoint
        }

        logSystem(key, '\u2014 Connected successfully \u2014');
        showToast(`Connected "${session.name}"`, 'success');

        // Auto-check port, service (for non-EKS), and tunnel health (non-blocking)
        const autoChecks = ['port', 'tunnel'];
        if (!isEks) autoChecks.push('service');
        console.log(`[connect] ${key}: auto-checking health — ${autoChecks.join(', ')}`);
        Promise.all(autoChecks.map(c => checkSessionHealth(key, c))).then(() => renderAll());

    } catch (err) {
        console.error(`[connect] ${key}: pipeline failed —`, err.message);
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
        const tunnelId = session?.tunnelId || key;

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

let dashboardView = 'region';
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
    console.log('[dashboard] Rendering dashboard');
    const [html] = await Promise.all([fetchPage('dashboard'), fetchSessions(), fetchGroups()]);
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
        renderAllView(container, filtered);
    } else if (dashboardView === 'group') {
        renderGroupView(container, filtered);
    } else {
        const groupKeys = { grouped: 'connectionId', region: 'region', type: 'type' };
        renderGroupedView(container, filtered, groupKeys[dashboardView] || 'connectionId');
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

        let badgeHtml = '';
        if (groupKey === 'type') {
            const regions = new Set(groupSessions.map(s => s.region).filter(Boolean));
            badgeHtml = `<span class="dashboard-group-badge">${regions.size} region${regions.size !== 1 ? 's' : ''}</span>`;
        } else if (groupKey !== 'region') {
            badgeHtml = `<span class="dashboard-group-badge">${groupSessions[0].region}</span>`;
        }

        const header = document.createElement('div');
        header.className = 'dashboard-group-header';
        header.innerHTML = `
            <i class="fa-solid fa-chevron-down dashboard-group-chevron"></i>
            <span class="dashboard-group-name">${groupKey === 'type' ? groupId.toUpperCase() : groupId}</span>
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

function renderAllView(container, filtered) {
    const regions = new Set(filtered.map(s => s.region).filter(Boolean));
    const types = new Set(filtered.map(s => s.type).filter(Boolean));

    const group = document.createElement('div');
    group.className = 'dashboard-group';

    const header = document.createElement('div');
    header.className = 'dashboard-group-header';
    header.innerHTML = `
        <i class="fa-solid fa-chevron-down dashboard-group-chevron"></i>
        <span class="dashboard-group-name">All</span>
        <span class="dashboard-group-badge">${filtered.length} sessions</span>
        <span class="dashboard-group-badge">${regions.size} region${regions.size !== 1 ? 's' : ''}</span>
        <span class="dashboard-group-badge">${types.size} type${types.size !== 1 ? 's' : ''}</span>
    `;

    const cards = document.createElement('div');
    cards.className = 'dashboard-group-cards';
    filtered.forEach(s => cards.appendChild(createDashboardCard(s)));

    header.addEventListener('click', () => {
        header.classList.toggle('collapsed');
        cards.style.display = header.classList.contains('collapsed') ? 'none' : '';
    });

    group.appendChild(header);
    group.appendChild(cards);
    container.appendChild(group);
}

function renderGroupView(container, filtered) {
    const groups = groupsCache || {};
    const groupKeys = Object.keys(groups);

    if (groupKeys.length === 0) {
        container.innerHTML = '<div class="dashboard-no-results"><i class="fa-solid fa-object-group"></i> No groups defined. Create groups in the Connections page.</div>';
        return;
    }

    // Sessions keyed by their key for fast lookup
    const sessionMap = {};
    filtered.forEach(s => { sessionMap[s.key] = s; });

    // "Ungrouped" — sessions not in any group
    const groupedKeys = new Set();
    groupKeys.forEach(gk => (groups[gk].connections || []).forEach(k => groupedKeys.add(k)));

    groupKeys.forEach(gk => {
        const g = groups[gk];
        const memberSessions = (g.connections || []).map(k => sessionMap[k]).filter(Boolean);
        if (memberSessions.length === 0) return;

        const groupEl = document.createElement('div');
        groupEl.className = 'dashboard-group';

        const activeCount = memberSessions.filter(s => isActive(s)).length;
        const header = document.createElement('div');
        header.className = 'dashboard-group-header';
        header.innerHTML = `
            <i class="fa-solid fa-chevron-down dashboard-group-chevron"></i>
            <span class="dashboard-group-name">${g.name}</span>
            <span class="dashboard-group-badge">${activeCount}/${memberSessions.length} active</span>
            <button class="dashboard-group-activate" title="Activate all in group"><i class="fa-solid fa-bolt"></i></button>
        `;

        const cards = document.createElement('div');
        cards.className = 'dashboard-group-cards';
        memberSessions.forEach(s => cards.appendChild(createDashboardCard(s)));

        header.querySelector('.dashboard-group-activate').addEventListener('click', (e) => {
            e.stopPropagation();
            activateGroup(g);
        });
        header.addEventListener('click', () => {
            header.classList.toggle('collapsed');
            cards.style.display = header.classList.contains('collapsed') ? 'none' : '';
        });

        groupEl.appendChild(header);
        groupEl.appendChild(cards);
        container.appendChild(groupEl);
    });

    // Ungrouped
    const ungrouped = filtered.filter(s => !groupedKeys.has(s.key));
    if (ungrouped.length > 0) {
        const groupEl = document.createElement('div');
        groupEl.className = 'dashboard-group';
        const header = document.createElement('div');
        header.className = 'dashboard-group-header';
        header.innerHTML = `
            <i class="fa-solid fa-chevron-down dashboard-group-chevron"></i>
            <span class="dashboard-group-name">Ungrouped</span>
            <span class="dashboard-group-badge">${ungrouped.length}</span>
        `;
        const cards = document.createElement('div');
        cards.className = 'dashboard-group-cards';
        ungrouped.forEach(s => cards.appendChild(createDashboardCard(s)));
        header.addEventListener('click', () => {
            header.classList.toggle('collapsed');
            cards.style.display = header.classList.contains('collapsed') ? 'none' : '';
        });
        groupEl.appendChild(header);
        groupEl.appendChild(cards);
        container.appendChild(groupEl);
    }
}

function healthIndicatorsHtml(session) {
    const h = getHealth(session.key);
    const items = [
        { key: 'service', icon: 'fa-layer-group',  label: 'Service' },
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
    const s = effectiveStatus(session);
    if (s === 'starting') return 'fa-spinner fa-spin';
    if (s === 'stopping') return 'fa-spinner fa-spin';
    if (s === 'port_conflict') return 'fa-triangle-exclamation';
    return 'fa-power-off';
}

function sessionBtnClass(session) {
    const s = effectiveStatus(session);
    if (s === 'active' || s === 'stopping') return 'on';
    if (s === 'port_conflict') return 'conflict';
    return 'off';
}

function createDashboardCard(session) {
    const el = document.createElement('div');
    el.className = 'session-item';
    el.dataset.sessionKey = session.key;
    const eStatus = effectiveStatus(session);
    if (isActive(session)) el.classList.add('active');
    if (eStatus === 'error') el.classList.add('error');
    if (eStatus === 'starting') el.classList.add('starting');
    if (eStatus === 'stopping') el.classList.add('stopping');
    if (isPortConflict(session)) el.classList.add('port-conflict');
    if (isPortBusy(session.localPort) && !isBusy(session)) {
        el.classList.add('tunnel-lock');
        el.title = `Port ${session.localPort} is busy — another tunnel on this port is starting or stopping`;
    }
    if (eStatus === 'error') {
        el.title = el.title || `Last connection attempt failed — click to view logs`;
    }

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

    // Gather keys that have backend logs (try all sessions — tunnel may persist from previous run)
    const tunnelKeys = [];
    const logFetches = sessions.map(async (s) => {
        try {
            const res = await fetch(`/api/tunnels/${s.key}/logs`);
            if (res.ok) {
                const data = await res.json();
                if (data.logs && data.logs.length > 0) {
                    return { key: s.key, name: s.name, ci: data.connection_index, logs: data.logs };
                }
            }
        } catch {}
        return null;
    });
    const results = await Promise.all(logFetches);
    results.forEach(r => { if (r) tunnelKeys.push(r); });

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
        <button class="conn-action-btn logs-page-refresh-btn" title="Refresh this tab"><i class="fa-solid fa-arrows-rotate"></i></button>
        <button class="conn-action-btn logs-page-copy-btn" title="Copy logs"><i class="fa-solid fa-copy"></i></button>
        <button class="conn-action-btn logs-page-save-btn" title="Save logs"><i class="fa-solid fa-floppy-disk"></i></button>
    `;
    tabsBar.appendChild(actionsBar);

    container.appendChild(tabsBar);

    const body = document.createElement('div');
    body.className = 'logs-page-body';
    container.appendChild(body);
    mainContentBody.appendChild(container);

    // Refresh button — re-fetch logs for the active tab and re-render
    actionsBar.querySelector('.logs-page-refresh-btn').addEventListener('click', async () => {
        const btn = actionsBar.querySelector('.logs-page-refresh-btn');
        btn.classList.add('spinning');
        const activeTab = allTabs.find(t => t.key === logsPageActiveKey);
        if (activeTab && activeTab.key !== SYSTEM_LOG_KEY) {
            try {
                const session = sessions.find(s => s.key === activeTab.key);
                const tunnelId = session?.tunnelId || activeTab.key;
                const res = await fetch(`/api/tunnels/${tunnelId}/logs`);
                if (res.ok) {
                    const data = await res.json();
                    activeTab.logs = data.logs || [];
                    activeTab.ci = data.connection_index;
                }
            } catch { /* non-critical */ }
        }
        refreshLogsPageBody(container, allTabs);
        btn.classList.remove('spinning');
        showToast('Logs refreshed', 'info');
    });

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
                const folderRes = await fetch('/api/consts/browse-folder', { method: 'POST' });
                const folderData = await folderRes.json();
                if (folderData.status === 'cancelled') return;
                if (!folderData.folder) { showToast(folderData.error || 'Failed', 'error'); return; }
                const folder = folderData.folder;

                // Save backend logs
                const res = await fetch(`/api/tunnels/${tunnelId}/logs/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folder }),
                });
                const data = await res.json();
                const prefix = data.prefix || `${tunnelId}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

                if (data.status === 'saved') {
                    showToast(`Saved in ${folder} (${prefix})`, 'success');
                } else {
                    // Tunnel not found — save client logs only
                    const cTab = consoleTabs[activeTab.key];
                    if (!cTab || !cTab.logs.length) { showToast('No logs to save', 'warning'); return; }
                    await fetch('/api/consts/save-file', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ folder, filename: `${prefix}_client.log`, content: formatConsoleLogs(cTab) }),
                    });
                    showToast(`Saved in ${folder} (${prefix})`, 'success');
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
        console:  '[system] ',
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
    // Fire-and-forget push to backend tunnel log
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
    console.log(`[console] Opening tab: ${key}`);
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
        const status = session ? effectiveStatus(session) : 'inactive';

        const tabEl = document.createElement('button');
        tabEl.className = `console-tab${key === activeConsoleKey ? ' active' : ''}`;
        tabEl.innerHTML = `
            <span class="console-tab-dot ${status}"></span>
            ${name}
            <span class="console-tab-close" title="Close"><i class="fa-solid fa-xmark"></i></span>
        `;

        tabEl.querySelector('.console-tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            closeConsoleTab(key);
        });
        tabEl.addEventListener('click', () => {
            activeConsoleKey = key;
            renderConsoleTabs();
            refreshConsoleBody();
        });

        tabsEl.appendChild(tabEl);
    }

    updateConsolePanelVisibility();
}

const STREAM_PREFIXES = {
    stdout:   '[tunnel] ',
    stderr:   '[error]  ',
    frontend: '[client] ',
    console:  '[system] ',
    system:   '',
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

let groupsCache = null;

async function fetchGroups() {
    const res = await fetch('/api/groups');
    groupsCache = await res.json();
    return groupsCache;
}

function invalidateCaches() {
    connectionsCache = null;
    userConnectionsCache = null;
    usedPortsCache = null;
    groupsCache = null;
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
    return `${conn.type}|${conn.cluster || ''}|${conn.region}|${conn.endpoint}|${conn.document}|${conn.remote_port}|${bastionStr}`;
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
        const [html, connections, userConnections, usedPorts, groups] = await Promise.all([
            fetchPage('connections'), fetchConnections(), fetchUserConnections(), fetchUsedPorts(), fetchGroups()
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

        // Groups list
        const groupsListEl = document.getElementById('groupsList');
        const groupKeys = Object.keys(groups);
        if (groupKeys.length === 0) {
            groupsListEl.innerHTML = '<div class="conn-empty">No groups yet</div>';
        } else {
            groupKeys.forEach(key => {
                const group = groups[key];
                const memberCount = (group.connections || []).length;
                const card = document.createElement('div');
                card.className = 'conn-card group-card';
                card.innerHTML = `
                    <div class="conn-card-icon"><i class="fa-solid fa-object-group"></i></div>
                    <div class="conn-card-info">
                        <div class="conn-card-name">${group.name}</div>
                        <div class="conn-card-detail">${memberCount} connection${memberCount !== 1 ? 's' : ''}</div>
                    </div>
                    <div class="conn-card-actions">
                        <button class="conn-action-btn" data-action="activate" title="Activate all"><i class="fa-solid fa-bolt"></i></button>
                        <button class="conn-action-btn delete" data-action="delete" title="Delete group"><i class="fa-solid fa-trash"></i></button>
                    </div>
                `;
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.conn-action-btn')) return;
                    renderEditGroupForm(group, key);
                });
                card.querySelector('[data-action="activate"]').addEventListener('click', (e) => {
                    e.stopPropagation();
                    activateGroup(group);
                });
                card.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
                    e.stopPropagation();
                    handleDeleteGroup(key, group.name);
                });
                groupsListEl.appendChild(card);
            });
        }

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
        document.getElementById('createGroupBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            renderEditGroupForm();
        });

        // Collapsible section titles
        document.querySelectorAll('.conn-list-collapsible').forEach(title => {
            title.addEventListener('click', () => {
                const targetId = title.dataset.target;
                const target = document.getElementById(targetId);
                title.classList.toggle('collapsed');
                target.style.display = title.classList.contains('collapsed') ? 'none' : '';
            });
        });

    } catch (err) {
        mainContentBody.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Failed to load connections: ${err.message}</div>`;
    }
}

function createConnCard(data, type, key, flags = {}) {
    const el = document.createElement('div');
    el.className = 'conn-card';
    if (flags.unreferenced) {
        el.classList.add('unreferenced');
        el.title = 'This connection is not used by any session — create a session that references it, or delete it';
    }

    const icon = type === 'connection' ? 'fa-server' : 'fa-user';
    const badge = data.type ? data.type.toUpperCase() : '';
    const detail = type === 'connection'
        ? `${data.region}${data.cluster ? ` \u00b7 ${data.cluster}` : ''}`
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
    // Build dependency warnings
    const warnings = [];

    if (type === 'connection') {
        // Check if user connections reference this connection
        const ucs = userConnectionsCache || await fetchUserConnections();
        const dependents = Object.entries(ucs).filter(([, uc]) => uc.connection_id === key);
        if (dependents.length > 0) {
            const names = dependents.map(([, uc]) => uc.connection_name || 'unnamed').join(', ');
            warnings.push(`${dependents.length} user connection(s) reference this: ${names}`);
        }
    }

    if (type === 'user') {
        // Check if any groups reference this user connection
        const groups = groupsCache || await fetchGroups();
        const inGroups = Object.entries(groups).filter(([, g]) => (g.connections || []).includes(key));
        if (inGroups.length > 0) {
            const groupNames = inGroups.map(([, g]) => g.name).join(', ');
            warnings.push(`Used in ${inGroups.length} group(s): ${groupNames}`);
        }
    }

    let msg = `Delete "${name}"? This cannot be undone.`;
    if (warnings.length > 0) {
        msg += `\n\nWarning:\n- ${warnings.join('\n- ')}`;
    }

    if (!confirm(msg)) return;
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

    clearFormDirty();
    populateSelect(document.getElementById('connType'), CONSTS.connection_types, 'value', 'label');
    document.getElementById('connRemotePort').value = CONSTS.defaults.remote_port;
    document.getElementById('connDocument').value = CONSTS.defaults.ssm_document;

    const fieldMap = {
        remote_port: document.getElementById('connRemotePort'),
    };

    function applyFieldOverrides() {
        const type = document.getElementById('connType').value.toLowerCase();
        const overrides = CONSTS.field_overrides?.type || {};
        const values = overrides[type] || overrides['default'] || {};

        // Apply overrides, falling back to defaults for fields not in the override
        for (const [field, el] of Object.entries(fieldMap)) {
            if (field in values) {
                el.value = values[field];
            } else if (CONSTS.defaults[field] !== undefined) {
                el.value = CONSTS.defaults[field];
            }
        }

        // Cluster visibility
        const isEks = type === 'eks';
        document.getElementById('clusterGroup').style.display = isEks ? '' : 'none';
        document.getElementById('clusterRequired').style.display = isEks ? '' : 'none';
        if (!isEks) document.getElementById('connCluster').value = '';
    }
    document.getElementById('connType').addEventListener('change', applyFieldOverrides);
    applyFieldOverrides();

    // --- Auto-format ID field ---
    const idInput = document.getElementById('connId');
    const nameInput = document.getElementById('connName');
    const regionInput = document.getElementById('connRegion');
    const remotePortInput = document.getElementById('connRemotePort');
    const typeSelect = document.getElementById('connType');
    let idManuallyEdited = false;

    function slugify(text) {
        return text.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }

    function autoGenerateId() {
        if (idManuallyEdited) return;
        const name = nameInput.value.trim();
        const region = regionInput.value.trim();
        const port = remotePortInput.value.trim();
        if (!name) { idInput.value = ''; return; }
        let parts = [name];
        if (region) parts.push(region);
        if (port) parts.push(port);
        idInput.value = slugify(parts.join('-'));
    }

    function sanitizeWhileTyping(text) {
        // Allow lowercase alphanumeric, spaces, underscores, dashes while typing
        return text.toLowerCase().replace(/[^a-z0-9 _-]/g, '');
    }

    idInput.addEventListener('input', () => {
        const pos = idInput.selectionStart;
        const original = idInput.value;
        idInput.value = sanitizeWhileTyping(original);
        idInput.selectionStart = idInput.selectionEnd = Math.min(pos, idInput.value.length);
        idManuallyEdited = idInput.value.trim().length > 0;
    });

    // On blur: convert spaces/underscores to dashes (full slugify)
    idInput.addEventListener('blur', () => {
        if (idInput.value.trim()) {
            idInput.value = slugify(idInput.value);
        } else {
            idManuallyEdited = false;
            autoGenerateId();
        }
    });

    nameInput.addEventListener('input', autoGenerateId);
    regionInput.addEventListener('input', autoGenerateId);
    remotePortInput.addEventListener('input', autoGenerateId);
    typeSelect.addEventListener('change', () => {
        // Type change updates remote port via applyFieldOverrides, then re-derive ID
        setTimeout(autoGenerateId, 0);
    });

    if (editData) {
        fillConnectionForm(editData);
        if (isEdit) {
            idInput.readOnly = true;
            idInput.classList.add('input-readonly');
            idManuallyEdited = true; // Don't auto-generate for edits
        } else {
            // Duplicating — allow auto-generation if ID was cleared
            idManuallyEdited = idInput.value.trim().length > 0;
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

    document.getElementById('cancelConnBtn').addEventListener('click', () => {
        if (confirmIfDirty()) goBackToConnections();
    });
    document.getElementById('saveConnBtn').addEventListener('click', () => saveConnection(isEdit ? editKey : null));

    // Track changes on all form inputs
    mainContentBody.querySelectorAll('input, select').forEach(el => el.addEventListener('input', markFormDirty));
    mainContentBody.querySelectorAll('select').forEach(el => el.addEventListener('change', markFormDirty));

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

    const isEksType = type.toLowerCase() === 'eks';
    if (!id || !type || !name || !region || !endpoint || (isEksType && !cluster)) {
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
            body: JSON.stringify({ id, type, name, region, endpoint, document: ssmDocument, remote_port: remotePort, bastions, ...(cluster ? { cluster } : {}) })
        });
        const data = await res.json();
        if (!res.ok) {
            msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${data.error}</div>`;
            return;
        }
        clearFormDirty();
        console.log(`[config] Connection "${name}" ${isEdit ? 'updated' : 'created'} (id=${id}, type=${type})`);
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

    // AWS Profile combo: fetch profiles, populate dropdown + custom input
    const profileSelect = document.getElementById('ucProfileSelect');
    const profileCustom = document.getElementById('ucProfileCustom');
    const profileHidden = document.getElementById('ucProfile');

    function syncProfile() {
        const val = profileSelect.value;
        if (val === '__custom__') {
            profileCustom.style.display = '';
            profileHidden.value = profileCustom.value;
        } else {
            profileCustom.style.display = 'none';
            profileHidden.value = val;
        }
    }
    profileSelect.addEventListener('change', syncProfile);
    profileCustom.addEventListener('input', () => { profileHidden.value = profileCustom.value; });

    function setProfileValue(value) {
        // If value exists in the dropdown, select it; otherwise switch to custom
        const option = [...profileSelect.options].find(o => o.value === value);
        if (option) {
            profileSelect.value = value;
        } else {
            profileSelect.value = '__custom__';
            profileCustom.value = value;
        }
        syncProfile();
    }

    (async () => {
        try {
            const res = await fetch('/api/aws/profiles/file');
            const data = await res.json();
            const profiles = data.profiles || [];
            profileSelect.innerHTML = '';
            profiles.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p;
                opt.textContent = p;
                profileSelect.appendChild(opt);
            });
            const customOpt = document.createElement('option');
            customOpt.value = '__custom__';
            customOpt.textContent = '— Custom —';
            profileSelect.appendChild(customOpt);
        } catch {
            profileSelect.innerHTML = '<option value="__custom__">— Custom —</option>';
            profileCustom.style.display = '';
        }
        // Set initial value after dropdown is populated
        if (editData && editData.profile) {
            setProfileValue(editData.profile);
        } else {
            setProfileValue(CONSTS.defaults.profile);
        }
    })();

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

    document.getElementById('cancelUcBtn').addEventListener('click', () => {
        if (confirmIfDirty()) goBackToConnections();
    });
    document.getElementById('saveUcBtn').addEventListener('click', () => saveUserConnection(isEdit ? editKey : null));

    // Track changes on all form inputs
    clearFormDirty();
    mainContentBody.querySelectorAll('input, select').forEach(el => el.addEventListener('input', markFormDirty));
    mainContentBody.querySelectorAll('select').forEach(el => el.addEventListener('change', markFormDirty));

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
        clearFormDirty();
        console.log(`[config] User connection "${connectionName}" ${isEdit ? 'updated' : 'created'}`);
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
    if (data.region && data.endpoint && data.type) return 'connection';
    if (data.connection_id && data.bastion_id) return 'user';
    return null;
}

// === GROUPS ===

async function handleDeleteGroup(key, name) {
    if (!confirm(`Delete group "${name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/groups/${key}`, { method: 'DELETE' });
    if (!res.ok) {
        const data = await res.json();
        showToast(data.error || 'Failed to delete group', 'error');
        return;
    }
    showToast(`Deleted group "${name}"`, 'success');
    invalidateCaches();
    goBackToConnections();
}

async function activateGroup(group) {
    const keys = group.connections || [];
    if (keys.length === 0) {
        showToast('Group has no connections', 'warning');
        return;
    }
    const toActivate = keys.filter(k => {
        const s = sessions.find(s => s.key === k);
        return s && !isActive(s) && !isBusy(s);
    });
    if (toActivate.length === 0) {
        showToast('All connections in this group are already active or busy', 'info');
        return;
    }
    showToast(`Activating ${toActivate.length} connection(s)...`, 'info');
    for (const key of toActivate) {
        const s = sessions.find(s => s.key === key);
        if (s) toggleSession(s);
    }
}

async function renderEditGroupForm(editData = null, editKey = null) {
    mainContentBody.innerHTML = '';
    const isEdit = editData !== null && editKey !== null;
    mainTopbarTitle.textContent = isEdit ? 'Edit Group' : 'New Group';

    const [html, userConnections] = await Promise.all([
        fetchPage('edit_group'), fetchUserConnections()
    ]);
    mainContentBody.innerHTML = html;

    if (isEdit) {
        document.getElementById('formTitleText').textContent = 'Edit Group';
        document.getElementById('editBadge').style.display = '';
        document.getElementById('saveGroupIcon').className = 'fa-solid fa-pen';
        document.getElementById('saveGroupLabel').textContent = 'Update';
    }

    const nameInput = document.getElementById('groupName');
    let memberKeys = [];

    if (editData) {
        nameInput.value = editData.name || '';
        memberKeys = [...(editData.connections || [])];
    }

    clearFormDirty();

    function renderMembers() {
        const list = document.getElementById('groupMembersList');
        list.innerHTML = '';
        if (memberKeys.length === 0) {
            list.innerHTML = '<div class="conn-empty">No connections added yet</div>';
            return;
        }
        memberKeys.forEach((key, idx) => {
            const uc = userConnections[key];
            const name = uc ? (uc.connection_name || key) : key;
            const port = uc ? uc.local_port : '?';
            const item = document.createElement('div');
            item.className = 'group-member-item';
            item.innerHTML = `
                <span class="group-member-name">${name}</span>
                <span class="group-member-port">:${port}</span>
                <button class="conn-action-btn delete group-member-remove" title="Remove"><i class="fa-solid fa-xmark"></i></button>
            `;
            item.querySelector('.group-member-remove').addEventListener('click', () => {
                memberKeys.splice(idx, 1);
                markFormDirty();
                renderMembers();
            });
            list.appendChild(item);
        });
    }
    renderMembers();

    document.getElementById('addToGroupBtn').addEventListener('click', () => {
        showConnectionPicker(userConnections, memberKeys, (selectedKey) => {
            memberKeys.push(selectedKey);
            markFormDirty();
            renderMembers();
        });
    });

    nameInput.addEventListener('input', markFormDirty);
    document.getElementById('cancelGroupBtn').addEventListener('click', () => {
        if (confirmIfDirty()) goBackToConnections();
    });
    document.getElementById('saveGroupBtn').addEventListener('click', async () => {
        const msgEl = document.getElementById('formMessage');
        msgEl.innerHTML = '';
        const name = nameInput.value.trim();
        if (!name) {
            msgEl.innerHTML = '<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> Name is required</div>';
            return;
        }
        const body = { name, connections: memberKeys };
        const url = isEdit ? `/api/groups/${editKey}` : '/api/groups';
        const method = isEdit ? 'PUT' : 'POST';
        try {
            const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const data = await res.json();
            if (!res.ok) {
                msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${data.error}</div>`;
                return;
            }
            clearFormDirty();
            showToast(`Group "${name}" ${isEdit ? 'updated' : 'created'}`, 'success');
            invalidateCaches();
            setTimeout(goBackToConnections, 600);
        } catch (err) {
            msgEl.innerHTML = `<div class="form-error"><i class="fa-solid fa-circle-exclamation"></i> ${err.message}</div>`;
        }
    });
}

function showConnectionPicker(userConnections, existingKeys, onSelect) {
    document.querySelector('.picker-overlay')?.remove();

    // Build list of ports already in the group
    const usedPorts = new Set();
    existingKeys.forEach(k => {
        const uc = userConnections[k];
        if (uc) usedPorts.add(uc.local_port);
    });

    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    const modal = document.createElement('div');
    modal.className = 'picker-modal';
    modal.innerHTML = `
        <div class="picker-title"><i class="fa-solid fa-plus"></i> Add Connection to Group</div>
        <div class="picker-list"></div>
        <div class="picker-actions">
            <button class="conn-btn secondary" id="pickerCloseBtn">Cancel</button>
        </div>
    `;

    const list = modal.querySelector('.picker-list');

    // Sort: available first, clashing/already-added at bottom
    const allKeys = Object.keys(userConnections);
    const sortedKeys = allKeys.sort((a, b) => {
        const aDisabled = existingKeys.includes(a) || usedPorts.has(userConnections[a].local_port);
        const bDisabled = existingKeys.includes(b) || usedPorts.has(userConnections[b].local_port);
        if (aDisabled && !bDisabled) return 1;
        if (!aDisabled && bDisabled) return -1;
        return 0;
    });

    sortedKeys.forEach(key => {
        const uc = userConnections[key];
        const name = uc.connection_name || key;
        const port = uc.local_port;
        const alreadyAdded = existingKeys.includes(key);
        const portClash = !alreadyAdded && usedPorts.has(port);
        const disabled = alreadyAdded || portClash;

        const item = document.createElement('div');
        item.className = `picker-item${disabled ? ' disabled' : ''}`;
        let reason = '';
        if (alreadyAdded) reason = '<span class="picker-reason">Already in group</span>';
        else if (portClash) reason = `<span class="picker-reason">Port ${port} clashes</span>`;

        item.innerHTML = `
            <span class="picker-item-name">${name}</span>
            <span class="picker-item-port">:${port}</span>
            ${reason}
        `;

        if (!disabled) {
            item.addEventListener('click', () => {
                onSelect(key);
                overlay.remove();
            });
        }
        list.appendChild(item);
    });

    overlay.appendChild(modal);
    document.querySelector('.main-content').appendChild(overlay);
    modal.querySelector('#pickerCloseBtn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
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
    // Trigger cluster field visibility based on type
    const typeEl = document.getElementById('connType');
    if (typeEl) typeEl.dispatchEvent(new Event('change'));
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
    // Profile is handled by the async profile combo loader in renderCreateUserConnectionForm
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

    // SSM Plugin verify button
    document.getElementById('verifySsmBtn').addEventListener('click', async () => {
        const btn = document.getElementById('verifySsmBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
        try {
            const res = await fetch('/api/aws/ssm/verify');
            const data = await res.json();
            ssmPluginVerified = !!data.installed;
            if (data.installed) {
                showToast(`SSM Plugin installed (v${data.version}) — connections enabled`, 'success');
            } else {
                showToast('SSM Plugin not found — click for setup guide', 'error', 8000);
                window.open('https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html', '_blank');
            }
        } catch (err) {
            showToast(`SSM check failed: ${err.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-stethoscope"></i> Verify SSM Plugin';
        }
    });

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
    console.log('[settings] Rendering settings page');
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

    // Track changes
    clearFormDirty();
    grid.querySelectorAll('input').forEach(input => input.addEventListener('input', markFormDirty));

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
            clearFormDirty();
            console.log('[settings] Saved:', JSON.stringify(SETTINGS));
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
    const eStatus = effectiveStatus(session);
    if (isActive(session)) el.classList.add('active');
    if (eStatus === 'error') {
        el.classList.add('error');
        el.title = 'Last connection attempt failed — click to view logs';
    }
    if (eStatus === 'starting') el.classList.add('starting');
    if (eStatus === 'stopping') el.classList.add('stopping');
    if (isPortConflict(session)) {
        el.classList.add('port-conflict');
        el.title = `Port ${session.localPort} is in use by another process (PID ${session.portPid})`;
    }
    if (!isActive(session) && !isBusy(session) && !isPortConflict(session) && eStatus !== 'error') {
        el.title = 'Inactive — click the power button to connect';
    }

    const isOn = isActive(session) || eStatus === 'stopping';
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
    console.log(`[console] Refreshing logs for ${activeConsoleKey}`);
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
    console.log(`[save] Saving logs for ${activeConsoleKey}`);

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

            const folderRes = await fetch('/api/consts/browse-folder', { method: 'POST' });
            const folderData = await folderRes.json();
            if (folderData.status === 'cancelled') return;
            if (!folderData.folder) { showToast(folderData.error || 'Failed', 'error'); return; }
            folder = folderData.folder;

            // Save backend logs
            const res = await fetch(`/api/tunnels/${tunnelId}/logs/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder }),
            });
            const data = await res.json();
            if (data.status === 'saved') {
                prefix = data.prefix;
            } else {
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

async function rehydrateSessions() {
    // Try to rehydrate logs for ALL sessions — tunnels may persist from previous app run
    console.log(`[init] Rehydrating logs for ${sessions.length} session(s)...`);
    for (const session of sessions) {
        try {
            const res = await fetch(`/api/tunnels/${session.key}/logs`);
            if (res.ok) {
                const data = await res.json();
                if (data.logs && data.logs.length > 0) {
                    console.log(`[init] Found ${data.logs.length} log(s) for ${session.key}`);
                    const tab = ensureConsoleTab(session.key);
                    tab._lastLogCount = 0;
                    data.logs.forEach(entry => appendLog(tab, { stream: entry.type, text: entry.text }));
                    tab._lastLogCount = data.logs.length;
                }
            }
        } catch { /* non-critical */ }
    }
    console.log('[init] Rehydration complete');
}

async function init() {
    console.log('[init] Starting SSM Manager...');
    await Promise.all([loadConsts(), loadSettings(), startupHealthCheck()]);
    await fetchSessions();
    renderSidebar();
    activeConsoleKey = SYSTEM_LOG_KEY;
    switchPane('dashboardPane');
    rehydrateSessions(); // non-blocking: populate logs for all sessions with tunnel data
    if (!ssmPluginVerified) {
        showToast('SSM Plugin not found — connections disabled. Go to Advanced to verify.', 'warning', 8000);
    }
    console.log('[init] SSM Manager ready');
}

init();
