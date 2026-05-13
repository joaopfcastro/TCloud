(function () {
    const state = {
        apiFetch: null,
        authTokenProvider: null,
        deviceIdProvider: null,
        finderSerializer: null,
        appSerializer: null,
        saveTimer: 0,
        pendingReason: '',
        lastSession: null,
    };

    function nowIso() {
        return new Date().toISOString();
    }

    function cloneRect(rect) {
        return {
            x: Number(rect?.x || 0),
            y: Number(rect?.y || 0),
            width: Number(rect?.width || 0),
            height: Number(rect?.height || 0),
        };
    }

    function getViewportPayload() {
        return {
            width: window.innerWidth || document.documentElement.clientWidth || 0,
            height: window.innerHeight || document.documentElement.clientHeight || 0,
            devicePixelRatio: window.devicePixelRatio || 1,
        };
    }

    function inferWindowKind(record) {
        const appId = String(record?.appId || record?.element?.dataset?.appId || '').trim();
        const id = String(record?.id || '').trim();
        if (appId === 'finder' || id.startsWith('finder-')) return 'finder';
        if (appId === 'pdf-tools' || id === 'app-viewer') return 'pdf-tools';
        return 'generic';
    }

    function buildWindowPayload(record) {
        const kind = inferWindowKind(record);
        const appId = String(record?.appId || record?.element?.dataset?.appId || '').trim();
        if (kind === 'finder') {
            return {
                path: record?.element?.dataset?.finderPath || '/',
                mode: record?.element?.dataset?.finderMode || 'cloud',
            };
        }
        return {
            app_id: appId,
            kind,
        };
    }

    function serializeManagedWindows() {
        const managerState = window.TCloudWindowManager?.getState?.();
        if (!managerState?.windows) return [];
        return Array.from(managerState.windows.values())
            .filter((record) => record && record.status !== 'closed')
            .sort((a, b) => Number(a.zIndex || 0) - Number(b.zIndex || 0))
            .map((record, index) => {
                const kind = inferWindowKind(record);
                const sourceStatus = record.status === 'minimized'
                    ? (record.restoreStatus || 'normal')
                    : (record.status || 'normal');
                return {
                    window_id: record.id,
                    kind,
                    app_id: record.appId || record.element?.dataset?.appId || '',
                    title: record.title || record.element?.dataset?.windowTitle || record.id,
                    status: sourceStatus,
                    snapSide: record.snapSide || record.restoreSnapSide || null,
                    minimized: Boolean(record.minimized || record.status === 'minimized'),
                    rect: cloneRect(record.rect),
                    restoreRect: cloneRect(record.restoreRect || record.rect),
                    viewport: getViewportPayload(),
                    z_order: index,
                    payload: buildWindowPayload(record),
                    updated_at: nowIso(),
                };
            });
    }

    function serialize() {
        const activeWindow = window.TCloudWindowManager?.getActiveWindow?.();
        const session = {
            schema_version: 2,
            active_window_id: activeWindow?.id || '',
            windows: serializeManagedWindows(),
            updated_at: nowIso(),
            last_device_id: state.deviceIdProvider?.() || '',
        };
        const finder = state.finderSerializer?.();
        if (finder) session.finder_session = finder;
        const apps = state.appSerializer?.();
        if (apps) session.app_session = apps;
        state.lastSession = session;
        return session;
    }

    function canSave() {
        return Boolean(state.apiFetch && (!state.authTokenProvider || state.authTokenProvider()));
    }

    async function saveSession(session, options = {}) {
        if (!canSave()) return null;
        const res = await state.apiFetch('/api/desktop_windows/session', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(session),
            keepalive: Boolean(options.keepalive),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao salvar sessão das janelas');
        return data;
    }

    function scheduleSave(reason = 'state-change') {
        state.pendingReason = reason;
        if (state.saveTimer) window.clearTimeout(state.saveTimer);
        state.saveTimer = window.setTimeout(async () => {
            state.saveTimer = 0;
            const session = serialize();
            session.last_reason = state.pendingReason;
            try {
                await saveSession(session);
            } catch (error) {
                console.warn('Nao foi possivel persistir sessao unificada das janelas', error);
            }
        }, 900);
    }

    async function flushSession(options = {}) {
        if (state.saveTimer) {
            window.clearTimeout(state.saveTimer);
            state.saveTimer = 0;
        }
        const session = serialize();
        session.last_reason = options.reason || state.pendingReason || 'flush';
        return saveSession(session, options).catch((error) => {
            console.warn('Nao foi possivel finalizar sessao unificada das janelas', error);
            return null;
        });
    }

    async function loadSession() {
        if (!canSave()) return null;
        const res = await state.apiFetch('/api/desktop_windows/session');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao carregar sessão das janelas');
        state.lastSession = data.session || null;
        return state.lastSession;
    }

    function configure(options = {}) {
        state.apiFetch = options.apiFetch || state.apiFetch;
        state.authTokenProvider = options.authTokenProvider || state.authTokenProvider;
        state.deviceIdProvider = options.deviceIdProvider || state.deviceIdProvider;
        state.finderSerializer = options.finderSerializer || state.finderSerializer;
        state.appSerializer = options.appSerializer || state.appSerializer;
        return window.TCloudDesktopWindows;
    }

    function handleWindowStateChange(detail) {
        const reason = String(detail?.reason || '');
        if (!reason || reason === 'focus' || reason === 'register' || reason === 'drag' || reason === 'resize') return;
        scheduleSave(`window:${reason}`);
    }

    window.addEventListener('pagehide', () => {
        if (state.saveTimer) flushSession({ keepalive: true, reason: 'pagehide' });
    });

    window.TCloudDesktopWindows = {
        configure,
        serialize,
        loadSession,
        scheduleSave,
        flushSession,
        handleWindowStateChange,
        getLastSession: () => state.lastSession,
    };
})();
