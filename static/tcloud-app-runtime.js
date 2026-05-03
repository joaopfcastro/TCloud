(function () {
    const state = {
        session: null,
        waiters: [],
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

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        if (!event.data || event.data.type !== 'tcloud-app-session') return;
        setSession(event.data.session || null);
    });

    window.TCloudApp = {
        ready() {
            return waitForSession();
        },

        async getContext() {
            return waitForSession();
        },

        async call(functionName, payload) {
            const session = await waitForSession();
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

            const data = await response.json();
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
    };
})();
