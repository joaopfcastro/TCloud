(function () {
    const state = {
        session: null,
        waiters: [],
        refreshPromise: null,
        refreshWaiters: [],
        lastFocusSignalAt: 0,
    };

    function flushWaiters() {
        while (state.waiters.length) {
            const waiter = state.waiters.shift();
            if (waiter) waiter(state.session);
        }
    }

    function setSession(session) {
        state.session = session || null;
        flushWaiters();
        if (state.session) {
            flushRefreshWaiters(null, state.session);
        }
        window.dispatchEvent(new CustomEvent('tcloud-app-session-changed', { detail: state.session }));
    }

    function waitForSession() {
        if (state.session) {
            return Promise.resolve(state.session);
        }
        return new Promise((resolve) => state.waiters.push(resolve));
    }

    function shellAction(action, payload) {
        window.parent.postMessage(
            {
                type: 'tcloud-shell-action',
                action,
                payload: payload || {},
            },
            window.location.origin
        );
    }

    function notifyWindowFocus(reason) {
        const now = Date.now();
        if (now - state.lastFocusSignalAt < 120) return;
        state.lastFocusSignalAt = now;
        shellAction('shell.focusWindow', { reason: reason || 'app-interaction' });
    }

    function wireWindowFocusSignals() {
        ['pointerdown', 'mousedown', 'touchstart', 'focusin'].forEach((eventName) => {
            window.addEventListener(eventName, () => notifyWindowFocus(eventName), { capture: true, passive: true });
        });
    }

    function flushRefreshWaiters(error, session) {
        state.refreshPromise = null;
        while (state.refreshWaiters.length) {
            const waiter = state.refreshWaiters.shift();
            if (!waiter) continue;
            window.clearTimeout(waiter.timeout);
            if (error) {
                waiter.reject(error);
            } else {
                waiter.resolve(session);
            }
        }
    }

    function getSessionAppId() {
        return String(state.session?.app?.id || state.session?.app_id || '').trim();
    }

    function requestSessionRefresh(reason) {
        if (!state.session) {
            return waitForSession();
        }
        if (state.refreshPromise) {
            return state.refreshPromise;
        }

        state.refreshPromise = new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => {
                flushRefreshWaiters(new Error('Tempo esgotado ao renovar sessao do app.'));
            }, 10000);

            state.refreshWaiters.push({ resolve, reject, timeout });
            window.parent.postMessage(
                {
                    type: 'tcloud-app-runtime-refresh',
                    appId: getSessionAppId(),
                    reason: reason || 'runtime-token-expired',
                },
                window.location.origin
            );
        });

        return state.refreshPromise;
    }

    async function readJsonResponse(response) {
        try {
            return await response.json();
        } catch (error) {
            return {};
        }
    }

    function isRuntimeTokenError(response, data) {
        const message = String(data?.error || data?.message || '').toLowerCase();
        return response.status === 401 && message.includes('runtime token');
    }

    async function executeRuntimeCall(session, functionName, payload) {
        const response = await fetch('/api/apps/runtime/execute', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.runtime_token}`,
            },
            body: JSON.stringify({
                function: functionName,
                payload: payload || {},
            }),
        });
        const data = await readJsonResponse(response);
        return { response, data };
    }

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        if (!event.data) return;
        if (event.data.type === 'tcloud-app-session') {
            setSession(event.data.session || null);
            return;
        }
        if (event.data.type === 'tcloud-app-session-error') {
            flushRefreshWaiters(new Error(event.data.error || 'Nao foi possivel renovar sessao do app.'));
        }
    });

    window.TCloudApp = {
        ready() {
            return waitForSession();
        },

        async getContext() {
            return waitForSession();
        },

        async call(functionName, payload) {
            let session = await waitForSession();
            let { response, data } = await executeRuntimeCall(session, functionName, payload);
            if (!response.ok && isRuntimeTokenError(response, data)) {
                session = await requestSessionRefresh(`execute:${functionName}`);
                ({ response, data } = await executeRuntimeCall(session, functionName, payload));
            }
            if (!response.ok) {
                const error = new Error(data.error || 'Falha ao executar funcao do runtime.');
                error.payload = data;
                throw error;
            }
            return data.result;
        },

        openApp(appId) {
            shellAction('shell.openApp', { appId });
        },

        closeApp() {
            shellAction('shell.closeApp', {});
        },

        openPath(path) {
            shellAction('shell.openPath', { path });
        },

        showToast(message, kind, duration) {
            shellAction('shell.showToast', { message, kind, duration });
        },

        focusWindow() {
            notifyWindowFocus('api');
        },
    };
    wireWindowFocusSignals();
})();
