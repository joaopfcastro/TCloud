(function () {
    const DEFAULTS = {
        minWidth: 360,
        minHeight: 240,
        snapThreshold: 24,
        viewportPadding: 8,
        visibleMargin: 96,
        titlebarHeight: 52,
    };

    const state = {
        windows: new Map(),
        zSeed: 900,
        zMax: 1800,
        activeId: null,
        rafId: 0,
        pending: new Map(),
        layoutMenu: null,
        layoutMenuRecordId: null,
        layoutMenuTrigger: null,
        layoutMenuPointerInside: false,
        layoutMenuOpenTimer: 0,
        layoutMenuCloseTimer: 0,
        layoutMenuWatchTimer: 0,
        iframeFocusDocs: new WeakMap(),
        deviceId: `web:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
        persistence: {
            provider: null,
            layouts: new Map(),
            loadPromise: null,
            hydrated: false,
            saveTimers: new Map(),
            pendingSaves: new Map(),
        },
    };

    const RESIZE_CURSORS = {
        n: 'ns-resize',
        s: 'ns-resize',
        e: 'ew-resize',
        w: 'ew-resize',
        ne: 'nesw-resize',
        sw: 'nesw-resize',
        nw: 'nwse-resize',
        se: 'nwse-resize',
    };

    function getViewportRect() {
        return {
            x: 0,
            y: 0,
            width: window.innerWidth || document.documentElement.clientWidth || 1024,
            height: window.innerHeight || document.documentElement.clientHeight || 768,
        };
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function cloneRect(rect) {
        return {
            x: Number(rect?.x || 0),
            y: Number(rect?.y || 0),
            width: Number(rect?.width || DEFAULTS.minWidth),
            height: Number(rect?.height || DEFAULTS.minHeight),
        };
    }

    function isValidRect(rect) {
        return rect
            && Number.isFinite(Number(rect.x))
            && Number.isFinite(Number(rect.y))
            && Number.isFinite(Number(rect.width))
            && Number.isFinite(Number(rect.height))
            && Number(rect.width) > 0
            && Number(rect.height) > 0;
    }

    function normalizeWindowStatus(status) {
        const normalized = String(status || '').trim();
        return ['normal', 'maximized', 'snapped'].includes(normalized) ? normalized : 'normal';
    }

    function normalizeSnapSide(side) {
        const normalized = String(side || '').trim();
        return ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(normalized)
            ? normalized
            : null;
    }

    function normalizeRect(record, rect) {
        const viewport = getViewportRect();
        const minWidth = Number(record.minWidth || DEFAULTS.minWidth);
        const minHeight = Number(record.minHeight || DEFAULTS.minHeight);
        const next = cloneRect(rect);
        next.width = clamp(next.width, minWidth, Math.max(minWidth, viewport.width));
        next.height = clamp(next.height, minHeight, Math.max(minHeight, viewport.height));
        next.x = clamp(next.x, -next.width + DEFAULTS.visibleMargin, viewport.width - DEFAULTS.visibleMargin);
        next.y = clamp(next.y, 0, Math.max(0, viewport.height - DEFAULTS.titlebarHeight));
        return next;
    }

    function rebaseZIndexes() {
        const visibleWindows = Array.from(state.windows.values())
            .filter((record) => record.status !== 'closed')
            .sort((a, b) => a.zIndex - b.zIndex);
        state.zSeed = 900;
        visibleWindows.forEach((record) => {
            record.zIndex = ++state.zSeed;
            scheduleApply(record);
        });
    }

    function nextZIndex() {
        state.zSeed += 1;
        if (state.zSeed >= state.zMax) {
            rebaseZIndexes();
            state.zSeed += 1;
        }
        return state.zSeed;
    }

    function notifyStateChange(record, reason) {
        record.element.dispatchEvent(new CustomEvent('tcloud-window-state-change', {
            detail: {
                id: record.id,
                reason,
                status: record.status,
                rect: cloneRect(record.rect),
                snapSide: record.snapSide,
                minimized: record.minimized,
                zIndex: record.zIndex,
            },
        }));
        if (typeof record.onStateChange === 'function') {
            record.onStateChange(record, reason);
        }
        if (window.TCloudDesktopWindows?.handleWindowStateChange) {
            window.TCloudDesktopWindows.handleWindowStateChange({
                id: record.id,
                reason,
                status: record.status,
                snapSide: record.snapSide,
                minimized: record.minimized,
                zIndex: record.zIndex,
            });
        }
        schedulePersist(record, reason);
    }

    function applyWindowRect(record) {
        const { element, rect } = record;
        element.style.width = `${Math.round(rect.width)}px`;
        element.style.height = `${Math.round(rect.height)}px`;
        element.style.transform = `translate3d(${Math.round(rect.x)}px, ${Math.round(rect.y)}px, 0)`;
        element.style.zIndex = String(record.zIndex);
        element.dataset.windowStatus = record.status;
        element.dataset.windowSnapSide = record.snapSide || '';
        element.classList.toggle('is-window-maximized', record.status === 'maximized');
        element.classList.toggle('is-window-snapped', record.status === 'snapped');
        element.classList.toggle('is-window-minimized', record.status === 'minimized');
    }

    function scheduleApply(record) {
        state.pending.set(record.id, record);
        if (state.rafId) return;
        state.rafId = window.requestAnimationFrame(() => {
            state.rafId = 0;
            state.pending.forEach(applyWindowRect);
            state.pending.clear();
        });
    }

    function shouldPersistReason(reason) {
        const normalized = String(reason || '');
        return normalized === 'drag-end'
            || normalized === 'resize-end'
            || normalized === 'maximize'
            || normalized === 'restore'
            || normalized === 'minimize'
            || normalized === 'close'
            || normalized.startsWith('layout:');
    }

    function buildPersistencePayload(record, reason) {
        const sourceStatus = record.status === 'closed'
            ? (record.lastUsableStatus || record.restoreStatus || 'normal')
            : (record.status === 'minimized' ? (record.restoreStatus || 'normal') : record.status);
        const status = normalizeWindowStatus(sourceStatus);
        const snapSide = status === 'snapped'
            ? normalizeSnapSide(record.lastUsableSnapSide || record.snapSide || record.restoreSnapSide)
            : null;
        const rect = isValidRect(record.lastUsableRect) ? record.lastUsableRect : record.rect;
        const restoreRect = isValidRect(record.restoreRect)
            ? record.restoreRect
            : (isValidRect(record.lastUsableRestoreRect) ? record.lastUsableRestoreRect : rect);
        return {
            app_id: record.appId || record.element.dataset.appId || '',
            status,
            snapSide,
            rect: cloneRect(rect),
            restoreRect: cloneRect(restoreRect),
            viewport: {
                width: getViewportRect().width,
                height: getViewportRect().height,
                devicePixelRatio: window.devicePixelRatio || 1,
            },
            last_reason: String(reason || '').slice(0, 64),
            last_device_id: state.deviceId,
            updated_at: new Date().toISOString(),
        };
    }

    function normalizeLayoutsPayload(payload) {
        const rawLayouts = payload?.layouts || payload || {};
        const next = new Map();
        if (Array.isArray(rawLayouts)) {
            rawLayouts.forEach((layout) => {
                const id = String(layout?.window_id || layout?.windowId || '').trim();
                if (id) next.set(id, layout);
            });
        } else if (rawLayouts && typeof rawLayouts === 'object') {
            Object.entries(rawLayouts).forEach(([id, layout]) => {
                const windowId = String(layout?.window_id || layout?.windowId || id || '').trim();
                if (windowId) next.set(windowId, layout);
            });
        }
        return next;
    }

    function hydrateLayouts(payload) {
        const layouts = normalizeLayoutsPayload(payload);
        layouts.forEach((layout, id) => state.persistence.layouts.set(id, layout));
        state.persistence.hydrated = true;
        state.windows.forEach((record) => {
            if (record.userInteracted || record.restoredFromPersistence) return;
            const layout = state.persistence.layouts.get(record.id);
            if (layout) applyPersistedLayout(record, layout, 'hydrate');
        });
    }

    function configurePersistence(provider = {}) {
        state.persistence.provider = provider && typeof provider === 'object' ? provider : null;
        state.persistence.loadPromise = null;
        if (state.persistence.provider?.loadAll && !state.persistence.loadPromise) {
            state.persistence.loadPromise = Promise.resolve()
                .then(() => state.persistence.provider.loadAll())
                .then((payload) => {
                    hydrateLayouts(payload);
                    return payload;
                })
                .catch((error) => {
                    state.persistence.hydrated = true;
                    console.warn('Nao foi possivel carregar layouts de janelas', error);
                    return { layouts: {} };
                });
        }
        return state.persistence.loadPromise;
    }

    function applyPersistedLayout(record, layout, reason = 'register') {
        if (!record || !layout) return false;
        const status = normalizeWindowStatus(layout.status);
        const snapSide = normalizeSnapSide(layout.snapSide || layout.snap_side);
        const persistedRect = isValidRect(layout.rect) ? normalizeRect(record, layout.rect) : null;
        if (!persistedRect) return false;
        const persistedRestoreRect = isValidRect(layout.restoreRect || layout.restore_rect)
            ? normalizeRect(record, layout.restoreRect || layout.restore_rect)
            : persistedRect;

        record.restoredFromPersistence = true;
        record.restoreRect = cloneRect(persistedRestoreRect);
        record.minimized = false;
        record.element.hidden = false;
        if (status === 'maximized') {
            record.status = 'maximized';
            record.snapSide = null;
            record.rect = getLayoutRect('maximize');
        } else if (status === 'snapped' && snapSide) {
            record.status = 'snapped';
            record.snapSide = snapSide;
            record.rect = getLayoutRect(snapSide);
        } else {
            record.status = 'normal';
            record.snapSide = null;
            record.rect = cloneRect(persistedRect);
        }
        scheduleApply(record);
        if (reason !== 'register') notifyStateChange(record, 'cloud-restore');
        return true;
    }

    function flushPendingSave(id) {
        const provider = state.persistence.provider;
        const payload = state.persistence.pendingSaves.get(id);
        if (!provider?.save || !payload) return Promise.resolve(null);
        state.persistence.pendingSaves.delete(id);
        return Promise.resolve()
            .then(() => provider.save(id, payload))
            .then((result) => {
                if (result?.layout) state.persistence.layouts.set(id, result.layout);
                return result;
            })
            .catch((error) => {
                state.persistence.pendingSaves.set(id, payload);
                console.warn('Nao foi possivel salvar layout da janela', id, error);
                return null;
            });
    }

    function schedulePersist(record, reason) {
        if (!record || !record.persist || !shouldPersistReason(reason)) return;
        const provider = state.persistence.provider;
        if (!provider?.save) return;
        const payload = buildPersistencePayload(record, reason);
        state.persistence.pendingSaves.set(record.id, payload);
        const existingTimer = state.persistence.saveTimers.get(record.id);
        if (existingTimer) window.clearTimeout(existingTimer);
        const delay = reason === 'close' || reason === 'minimize' ? 0 : 320;
        const timer = window.setTimeout(() => {
            state.persistence.saveTimers.delete(record.id);
            flushPendingSave(record.id);
        }, delay);
        state.persistence.saveTimers.set(record.id, timer);
    }

    function resetWindowState(id) {
        const record = state.windows.get(id);
        state.persistence.layouts.delete(id);
        state.persistence.pendingSaves.delete(id);
        const timer = state.persistence.saveTimers.get(id);
        if (timer) window.clearTimeout(timer);
        state.persistence.saveTimers.delete(id);
        const removePromise = state.persistence.provider?.remove
            ? Promise.resolve().then(() => state.persistence.provider.remove(id)).catch((error) => {
                console.warn('Nao foi possivel redefinir layout da janela', id, error);
                return null;
            })
            : Promise.resolve(null);
        if (record) {
            record.status = 'normal';
            record.snapSide = null;
            record.minimized = false;
            record.element.hidden = false;
            record.rect = normalizeRect(record, record.defaultRect || record.initialRect);
            record.restoreRect = cloneRect(record.rect);
            record.restoreStatus = null;
            record.restoreSnapSide = null;
            record.restoredFromPersistence = false;
            beginWindowTransition(record);
            scheduleApply(record);
            notifyStateChange(record, 'reset');
            updateDock();
        }
        return removePromise;
    }

    function setIframeShield(record, enabled) {
        let shield = record.element.querySelector('.tcloud-window-iframe-shield');
        if (!shield && enabled) {
            shield = document.createElement('div');
            shield.className = 'tcloud-window-iframe-shield';
            record.element.appendChild(shield);
        }
        if (shield) {
            shield.hidden = !enabled;
        }
    }

    function saveRestoreRect(record) {
        if (record.status === 'normal' || record.status === 'snapped') {
            record.restoreRect = cloneRect(record.rect);
        }
    }

    function getSafeRestoreRect(record) {
        const viewport = getViewportRect();
        const candidate = normalizeRect(record, record.restoreRect || record.initialRect);
        const looksLikeViewport = candidate.x <= 4
            && candidate.y <= 4
            && candidate.width >= viewport.width - 8
            && candidate.height >= viewport.height - 8;
        if (looksLikeViewport && record.initialRect) {
            return normalizeRect(record, record.initialRect);
        }
        return candidate;
    }

    function clearTransitionTimer(record) {
        if (record.transitionTimer) {
            window.clearTimeout(record.transitionTimer);
            record.transitionTimer = 0;
        }
    }

    function beginWindowTransition(record) {
        clearTransitionTimer(record);
        record.element.classList.add('is-window-transitioning');
        record.transitionTimer = window.setTimeout(() => {
            record.transitionTimer = 0;
            record.element.classList.remove('is-window-transitioning');
        }, 190);
    }

    function getLayoutRect(layoutName) {
        const viewport = getViewportRect();
        const halfWidth = viewport.width / 2;
        const halfHeight = viewport.height / 2;
        const layouts = {
            left: { x: 0, y: 0, width: halfWidth, height: viewport.height },
            right: { x: halfWidth, y: 0, width: halfWidth, height: viewport.height },
            top: { x: 0, y: 0, width: viewport.width, height: halfHeight },
            bottom: { x: 0, y: halfHeight, width: viewport.width, height: halfHeight },
            'top-left': { x: 0, y: 0, width: halfWidth, height: halfHeight },
            'top-right': { x: halfWidth, y: 0, width: halfWidth, height: halfHeight },
            'bottom-left': { x: 0, y: halfHeight, width: halfWidth, height: halfHeight },
            'bottom-right': { x: halfWidth, y: halfHeight, width: halfWidth, height: halfHeight },
            maximize: { x: 0, y: 0, width: viewport.width, height: viewport.height },
        };
        return cloneRect(layouts[layoutName] || layouts.maximize);
    }

    function applyManagedRect(record, rect, status, reason, snapSide = null) {
        record.status = status;
        record.snapSide = snapSide;
        record.minimized = false;
        record.element.hidden = false;
        record.rect = cloneRect(rect);
        beginWindowTransition(record);
        scheduleApply(record);
        notifyStateChange(record, reason);
        updateDock();
    }

    function updateDock() {
        const dock = document.getElementById('tcloud-window-dock');
        if (!dock) return;

        const minimized = Array.from(state.windows.values())
            .filter((record) => record.minimized && record.status !== 'closed');

        dock.innerHTML = minimized.map((record) => {
            const title = record.element.dataset.windowTitle || record.title || record.id;
            const icon = record.element.dataset.windowIcon || record.icon || 'ph ph-app-window';
            return `
                <button class="tcloud-dock-item" type="button" data-dock-window="${escapeAttr(record.id)}" title="${escapeAttr(title)}" aria-label="Restaurar ${escapeAttr(title)}">
                    <i class="${escapeAttr(icon)}"></i>
                </button>
            `;
        }).join('');

        dock.querySelectorAll('[data-dock-window]').forEach((button) => {
            button.addEventListener('click', () => restore(button.dataset.dockWindow));
        });
    }

    function escapeAttr(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function focus(id) {
        const record = state.windows.get(id);
        if (!record || record.status === 'closed') return;
        if (state.activeId === id && record.element.classList.contains('is-focused')) return;
        if (state.layoutMenuRecordId && state.layoutMenuRecordId !== id) {
            hideLayoutMenu();
        }
        record.zIndex = nextZIndex();
        state.activeId = id;
        state.windows.forEach((item, itemId) => {
            item.element.classList.toggle('is-focused', itemId === id);
        });
        scheduleApply(record);
        notifyStateChange(record, 'focus');
    }

    function maximize(id) {
        const record = state.windows.get(id);
        if (!record) return;
        hideLayoutMenu();
        focus(id);
        record.userInteracted = true;
        if (record.status === 'maximized') {
            restore(id);
            return;
        }
        saveRestoreRect(record);
        record.restoreStatus = record.status;
        record.restoreSnapSide = record.snapSide;
        applyManagedRect(record, getLayoutRect('maximize'), 'maximized', 'maximize', null);
    }

    function restore(id) {
        const record = state.windows.get(id);
        if (!record) return;
        hideLayoutMenu();
        const previousStatus = record.restoreStatus || null;
        const previousSnapSide = record.restoreSnapSide || null;
        focus(id);
        record.userInteracted = true;
        record.minimized = false;
        record.element.hidden = false;

        if (previousStatus === 'maximized') {
            record.status = 'maximized';
            record.snapSide = null;
            record.rect = getLayoutRect('maximize');
        } else if (previousStatus === 'snapped' && previousSnapSide) {
            record.status = 'snapped';
            record.snapSide = previousSnapSide;
            record.rect = getLayoutRect(previousSnapSide);
        } else {
            record.status = 'normal';
            record.snapSide = null;
            record.rect = getSafeRestoreRect(record);
        }

        record.restoreStatus = null;
        record.restoreSnapSide = null;
        beginWindowTransition(record);
        scheduleApply(record);
        notifyStateChange(record, 'restore');
        updateDock();
    }

    function minimize(id) {
        const record = state.windows.get(id);
        if (!record) return;
        hideLayoutMenu();
        record.userInteracted = true;
        if (record.status !== 'minimized') {
            record.restoreStatus = record.status;
            record.restoreSnapSide = record.snapSide;
            if (record.status === 'normal') {
                saveRestoreRect(record);
            }
        }
        record.status = 'minimized';
        record.minimized = true;
        record.element.hidden = true;
        notifyStateChange(record, 'minimize');
        updateDock();
    }

    function close(id) {
        const record = state.windows.get(id);
        if (!record) return;
        hideLayoutMenu();
        record.lastUsableStatus = record.status;
        record.lastUsableSnapSide = record.snapSide;
        record.lastUsableRect = cloneRect(record.rect);
        record.lastUsableRestoreRect = cloneRect(record.restoreRect || record.rect);
        record.status = 'closed';
        record.minimized = false;
        record.element.hidden = true;
        notifyStateChange(record, 'close');
        state.windows.delete(id);
        updateDock();
        if (typeof record.onClose === 'function') {
            record.onClose(record);
        }
    }

    function snap(id, side) {
        layout(id, side);
    }

    function layout(id, layoutName) {
        const record = state.windows.get(id);
        const normalizedLayout = String(layoutName || '').trim();
        if (!record || record.status === 'closed') return;
        if (normalizedLayout === 'restore') {
            hideLayoutMenu();
            restore(id);
            return;
        }
        if (normalizedLayout === 'reset') {
            hideLayoutMenu();
            resetWindowState(id);
            return;
        }
        if (normalizedLayout === 'maximize' || normalizedLayout === 'full') {
            hideLayoutMenu();
            maximize(id);
            return;
        }
        if (!['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(normalizedLayout)) {
            return;
        }
        focus(id);
        record.userInteracted = true;
        saveRestoreRect(record);
        hideLayoutMenu();
        applyManagedRect(record, getLayoutRect(normalizedLayout), 'snapped', `layout:${normalizedLayout}`, normalizedLayout);
    }

    function maybeSnapFromPointer(record) {
        const pointerX = record.lastPointer?.x;
        if (!Number.isFinite(pointerX)) return;
        if (pointerX <= (record.snapThreshold || DEFAULTS.snapThreshold)) {
            snap(record.id, 'left');
            return;
        }
        if (pointerX >= getViewportRect().width - (record.snapThreshold || DEFAULTS.snapThreshold)) {
            snap(record.id, 'right');
        }
    }

    function setResizeHover(record, dir) {
        if (!record || record.status === 'maximized') return;
        const cursor = RESIZE_CURSORS[dir] || '';
        record.resizeHoverDir = dir;
        record.element.classList.add('is-resize-hover');
        record.element.dataset.resizeHover = dir;
        if (cursor) document.documentElement.style.cursor = cursor;
    }

    function clearResizeHover(record) {
        if (!record) return;
        record.resizeHoverDir = '';
        record.element.classList.remove('is-resize-hover');
        delete record.element.dataset.resizeHover;
        if (!document.querySelector('.tcloud-window.is-resizing')) {
            document.documentElement.style.cursor = '';
        }
    }

    function clearAllResizeHover() {
        state.windows.forEach((record) => clearResizeHover(record));
        document.documentElement.style.cursor = '';
    }

    function resolveWindowIdFromTarget(target) {
        const node = target?.closest?.('.tcloud-window[data-window-id], [data-window-id].tcloud-window');
        return node?.dataset?.windowId || '';
    }

    function focusFromEvent(event) {
        const target = event?.target;
        if (!target?.closest) return;
        if (target.closest('.tcloud-window-layout-menu, .tcloud-window-dock')) return;
        const id = resolveWindowIdFromTarget(target);
        if (!id) return;
        const record = state.windows.get(id);
        if (!record || record.status === 'closed' || record.minimized) return;
        focus(id);
    }

    function wireGlobalFocusCapture() {
        ['pointerdown', 'mousedown', 'touchstart', 'focusin'].forEach((eventName) => {
            document.addEventListener(eventName, focusFromEvent, true);
        });
    }

    function wireIframeContentFocusBridge(record, iframe) {
        let frameDocument = null;
        try {
            frameDocument = iframe.contentDocument || iframe.contentWindow?.document || null;
        } catch (error) {
            return;
        }
        if (!frameDocument || state.iframeFocusDocs.get(iframe) === frameDocument) return;
        state.iframeFocusDocs.set(iframe, frameDocument);
        ['pointerdown', 'mousedown', 'touchstart', 'focusin'].forEach((eventName) => {
            frameDocument.addEventListener(eventName, () => focus(record.id), { capture: true, passive: eventName === 'touchstart' });
        });
    }

    function wireIframeFocusBridge(record) {
        record.element.querySelectorAll('iframe').forEach((iframe) => {
            if (iframe.dataset.windowFocusBridgeWired !== '1') {
                iframe.dataset.windowFocusBridgeWired = '1';
                const focusRecord = () => focus(record.id);
                iframe.addEventListener('focus', focusRecord, true);
                iframe.addEventListener('pointerdown', focusRecord, true);
                iframe.addEventListener('mousedown', focusRecord, true);
                iframe.addEventListener('touchstart', focusRecord, { capture: true, passive: true });
                iframe.addEventListener('load', () => wireIframeContentFocusBridge(record, iframe));
            }
            wireIframeContentFocusBridge(record, iframe);
        });
    }

    function wireWindow(record) {
        if (record.wired) return;
        record.wired = true;
        const titlebar = record.titlebar;

        record.element.addEventListener('pointerdown', () => focus(record.id));

        if (titlebar) {
            titlebar.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                if (event.target.closest('[data-window-action], button, a, input, textarea, select, [contenteditable="true"]')) return;
                event.preventDefault();
                hideLayoutMenu();
                focus(record.id);

                if (record.status === 'maximized') {
                    restore(record.id);
                }

                const startRect = cloneRect(record.rect);
                const start = {
                    pointerId: event.pointerId,
                    pointerX: event.clientX,
                    pointerY: event.clientY,
                    rect: startRect,
                };
                titlebar.setPointerCapture(event.pointerId);
                record.element.classList.add('is-dragging');
                record.element.classList.remove('is-window-transitioning');
                setIframeShield(record, true);

                const onMove = (moveEvent) => {
                    if (moveEvent.pointerId !== start.pointerId) return;
                    const viewport = getViewportRect();
                    const nextX = start.rect.x + (moveEvent.clientX - start.pointerX);
                    const nextY = start.rect.y + (moveEvent.clientY - start.pointerY);
                    record.status = 'normal';
                    record.snapSide = null;
                    record.minimized = false;
                    record.rect = normalizeRect(record, {
                        ...record.rect,
                        x: clamp(nextX, -record.rect.width + DEFAULTS.visibleMargin, viewport.width - DEFAULTS.visibleMargin),
                        y: clamp(nextY, 0, viewport.height - DEFAULTS.titlebarHeight),
                    });
                    record.lastPointer = { x: moveEvent.clientX, y: moveEvent.clientY };
                    scheduleApply(record);
                    notifyStateChange(record, 'drag');
                };

                const onEnd = () => {
                    try {
                        titlebar.releasePointerCapture(start.pointerId);
                    } catch (error) {
                        // Pointer capture can already be released after tab switches.
                    }
                    titlebar.removeEventListener('pointermove', onMove);
                    titlebar.removeEventListener('pointerup', onEnd);
                    titlebar.removeEventListener('pointercancel', onEnd);
                    record.element.classList.remove('is-dragging');
                    setIframeShield(record, false);
                    record.userInteracted = true;
                    record.restoreRect = cloneRect(record.rect);
                    maybeSnapFromPointer(record);
                    notifyStateChange(record, 'drag-end');
                };

                titlebar.addEventListener('pointermove', onMove);
                titlebar.addEventListener('pointerup', onEnd);
                titlebar.addEventListener('pointercancel', onEnd);
            });
        }

        wireResizeHandles(record);
        wireWindowControls(record);
        wireIframeFocusBridge(record);
    }

    function wireResizeHandles(record) {
        record.element.querySelectorAll('[data-resize-handle]').forEach((handle) => {
            const dirForHandle = handle.dataset.resizeHandle || '';
            handle.addEventListener('pointerenter', () => setResizeHover(record, dirForHandle));
            handle.addEventListener('pointerleave', () => {
                if (!record.element.classList.contains('is-resizing')) clearResizeHover(record);
            });
            handle.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || record.status === 'maximized') return;
                event.preventDefault();
                event.stopPropagation();
                hideLayoutMenu();
                focus(record.id);

                const dir = handle.dataset.resizeHandle || '';
                setResizeHover(record, dir);
                const start = {
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    rect: cloneRect(record.rect),
                };
                handle.setPointerCapture(event.pointerId);
                record.element.classList.add('is-resizing');
                record.element.classList.remove('is-window-transitioning');
                setIframeShield(record, true);

                const onMove = (moveEvent) => {
                    if (moveEvent.pointerId !== start.pointerId) return;
                    const dx = moveEvent.clientX - start.x;
                    const dy = moveEvent.clientY - start.y;
                    const next = cloneRect(start.rect);

                    if (dir.includes('e')) next.width = start.rect.width + dx;
                    if (dir.includes('s')) next.height = start.rect.height + dy;
                    if (dir.includes('w')) {
                        next.width = start.rect.width - dx;
                        next.x = start.rect.x + dx;
                    }
                    if (dir.includes('n')) {
                        next.height = start.rect.height - dy;
                        next.y = start.rect.y + dy;
                    }

                    const minWidth = Number(record.minWidth || DEFAULTS.minWidth);
                    const minHeight = Number(record.minHeight || DEFAULTS.minHeight);
                    if (next.width < minWidth) {
                        if (dir.includes('w')) next.x -= minWidth - next.width;
                        next.width = minWidth;
                    }
                    if (next.height < minHeight) {
                        if (dir.includes('n')) next.y -= minHeight - next.height;
                        next.height = minHeight;
                    }

                    record.status = 'normal';
                    record.snapSide = null;
                    record.minimized = false;
                    record.rect = normalizeRect(record, next);
                    scheduleApply(record);
                    notifyStateChange(record, 'resize');
                };

                const onEnd = () => {
                    try {
                        handle.releasePointerCapture(start.pointerId);
                    } catch (error) {
                        // Pointer capture can already be released after tab switches.
                    }
                    handle.removeEventListener('pointermove', onMove);
                    handle.removeEventListener('pointerup', onEnd);
                    handle.removeEventListener('pointercancel', onEnd);
                    record.element.classList.remove('is-resizing');
                    clearResizeHover(record);
                    setIframeShield(record, false);
                    record.userInteracted = true;
                    record.restoreRect = cloneRect(record.rect);
                    notifyStateChange(record, 'resize-end');
                };

                handle.addEventListener('pointermove', onMove);
                handle.addEventListener('pointerup', onEnd);
                handle.addEventListener('pointercancel', onEnd);
            });
        });
    }

    function wireWindowControls(record) {
        record.element.querySelectorAll('[data-window-action]').forEach((button) => {
            button.addEventListener('pointerdown', (event) => event.stopPropagation());
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const action = button.dataset.windowAction;
                hideLayoutMenu();
                if (action === 'close') close(record.id);
                if (action === 'minimize') minimize(record.id);
                if (action === 'maximize') maximize(record.id);
                if (action === 'restore') restore(record.id);
            });
            if (button.dataset.windowAction === 'maximize') {
                wireLayoutMenuTrigger(record, button);
            }
        });
    }

    function ensureLayoutMenu() {
        if (state.layoutMenu) return state.layoutMenu;
        const menu = document.createElement('div');
        menu.className = 'tcloud-window-layout-menu';
        menu.id = 'tcloud-window-layout-menu';
        menu.hidden = true;
        menu.innerHTML = `
            <div class="tcloud-window-layout-head">
                <div class="tcloud-window-layout-orb" aria-hidden="true"><span></span></div>
                <div>
                    <div class="tcloud-window-layout-kicker">Janela</div>
                    <div class="tcloud-window-layout-title" data-layout-window-title>Organizar</div>
                </div>
            </div>
            <div class="tcloud-window-layout-section">Mover e redimensionar</div>
            <div class="tcloud-window-layout-grid">
                <button type="button" class="tcloud-window-layout-option" data-window-layout="left" title="Metade esquerda" aria-label="Colocar na metade esquerda"><span class="layout-icon half-left"></span><span>Esquerda</span></button>
                <button type="button" class="tcloud-window-layout-option" data-window-layout="right" title="Metade direita" aria-label="Colocar na metade direita"><span class="layout-icon half-right"></span><span>Direita</span></button>
                <button type="button" class="tcloud-window-layout-option" data-window-layout="top" title="Metade superior" aria-label="Colocar na metade superior"><span class="layout-icon half-top"></span><span>Topo</span></button>
                <button type="button" class="tcloud-window-layout-option" data-window-layout="bottom" title="Metade inferior" aria-label="Colocar na metade inferior"><span class="layout-icon half-bottom"></span><span>Base</span></button>
            </div>
            <div class="tcloud-window-layout-divider"></div>
            <div class="tcloud-window-layout-section">Preencher e organizar</div>
            <div class="tcloud-window-layout-grid">
                <button type="button" class="tcloud-window-layout-option" data-window-layout="maximize" title="Tela cheia" aria-label="Maximizar"><span class="layout-icon full"></span><span>Tela</span></button>
                <button type="button" class="tcloud-window-layout-option" data-window-layout="restore" title="Restaurar" aria-label="Restaurar"><span class="layout-icon restore"></span><span>Restaurar</span></button>
                <button type="button" class="tcloud-window-layout-option" data-window-layout="reset" title="Redefinir tamanho" aria-label="Redefinir tamanho"><span class="layout-icon restore"></span><span>Redefinir</span></button>
                <button type="button" class="tcloud-window-layout-option" data-window-layout="top-left" title="Quadrante superior esquerdo" aria-label="Quadrante superior esquerdo"><span class="layout-icon quadrant top-left"></span><span>Sup. esq.</span></button>
                <button type="button" class="tcloud-window-layout-option" data-window-layout="top-right" title="Quadrante superior direito" aria-label="Quadrante superior direito"><span class="layout-icon quadrant top-right"></span><span>Sup. dir.</span></button>
                <button type="button" class="tcloud-window-layout-option" data-window-layout="bottom-left" title="Quadrante inferior esquerdo" aria-label="Quadrante inferior esquerdo"><span class="layout-icon quadrant bottom-left"></span><span>Inf. esq.</span></button>
                <button type="button" class="tcloud-window-layout-option" data-window-layout="bottom-right" title="Quadrante inferior direito" aria-label="Quadrante inferior direito"><span class="layout-icon quadrant bottom-right"></span><span>Inf. dir.</span></button>
            </div>
        `;

        menu.addEventListener('pointerenter', () => {
            state.layoutMenuPointerInside = true;
            if (state.layoutMenuCloseTimer) {
                window.clearTimeout(state.layoutMenuCloseTimer);
                state.layoutMenuCloseTimer = 0;
            }
        });
        menu.addEventListener('pointerleave', () => {
            state.layoutMenuPointerInside = false;
            scheduleHideLayoutMenu();
        });
        menu.addEventListener('click', (event) => {
            const button = event.target.closest('[data-window-layout]');
            if (!button || !state.layoutMenuRecordId) return;
            event.preventDefault();
            event.stopPropagation();
            layout(state.layoutMenuRecordId, button.dataset.windowLayout);
            hideLayoutMenu();
        });
        document.addEventListener('pointerdown', (event) => {
            if (menu.hidden) return;
            const activeRecord = state.windows.get(state.layoutMenuRecordId);
            const trigger = activeRecord?.element.querySelector('[data-window-action="maximize"]');
            if (menu.contains(event.target) || trigger?.contains(event.target)) return;
            hideLayoutMenu();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') hideLayoutMenu();
        });
        document.addEventListener('pointermove', trackLayoutMenuPointer, { passive: true });
        window.addEventListener('resize', hideLayoutMenu, { passive: true });
        window.addEventListener('scroll', hideLayoutMenu, true);
        document.body.appendChild(menu);
        state.layoutMenu = menu;
        return menu;
    }

    function positionLayoutMenu(button, menu) {
        const rect = button.getBoundingClientRect();
        const menuWidth = 374;
        const x = clamp(rect.left - 34, DEFAULTS.viewportPadding, getViewportRect().width - menuWidth - DEFAULTS.viewportPadding);
        const y = Math.min(rect.bottom + 12, getViewportRect().height - 252);
        menu.style.left = `${Math.round(x)}px`;
        menu.style.top = `${Math.max(DEFAULTS.viewportPadding, Math.round(y))}px`;
    }

    function showLayoutMenu(record, button) {
        if (!record || record.status === 'closed') return;
        const menu = ensureLayoutMenu();
        if (state.layoutMenuCloseTimer) {
            window.clearTimeout(state.layoutMenuCloseTimer);
            state.layoutMenuCloseTimer = 0;
        }
        state.layoutMenuRecordId = record.id;
        state.layoutMenuTrigger = button;
        state.layoutMenuPointerInside = false;
        positionLayoutMenu(button, menu);
        const titleNode = menu.querySelector('[data-layout-window-title]');
        if (titleNode) titleNode.textContent = record.title || record.element.dataset.windowTitle || 'Organizar';
        menu.hidden = false;
        menu.dataset.windowId = record.id;
        startLayoutMenuWatchdog();
    }

    function scheduleShowLayoutMenu(record, button) {
        if (state.layoutMenuOpenTimer) window.clearTimeout(state.layoutMenuOpenTimer);
        state.layoutMenuOpenTimer = window.setTimeout(() => {
            state.layoutMenuOpenTimer = 0;
            showLayoutMenu(record, button);
        }, 240);
    }

    function scheduleHideLayoutMenu(delay = 180) {
        if (state.layoutMenuCloseTimer) window.clearTimeout(state.layoutMenuCloseTimer);
        state.layoutMenuCloseTimer = window.setTimeout(hideLayoutMenu, delay);
    }

    function hideLayoutMenu() {
        if (state.layoutMenuOpenTimer) {
            window.clearTimeout(state.layoutMenuOpenTimer);
            state.layoutMenuOpenTimer = 0;
        }
        if (state.layoutMenuCloseTimer) {
            window.clearTimeout(state.layoutMenuCloseTimer);
            state.layoutMenuCloseTimer = 0;
        }
        if (state.layoutMenuWatchTimer) {
            window.clearInterval(state.layoutMenuWatchTimer);
            state.layoutMenuWatchTimer = 0;
        }
        if (state.layoutMenu) {
            state.layoutMenu.hidden = true;
            delete state.layoutMenu.dataset.windowId;
        }
        state.layoutMenuRecordId = null;
        state.layoutMenuTrigger = null;
        state.layoutMenuPointerInside = false;
    }

    function isPointInExpandedRect(x, y, rect, padding = 8) {
        return x >= rect.left - padding
            && x <= rect.right + padding
            && y >= rect.top - padding
            && y <= rect.bottom + padding;
    }

    function trackLayoutMenuPointer(event) {
        const menu = state.layoutMenu;
        if (!menu || menu.hidden || !state.layoutMenuTrigger) return;
        const x = event.clientX;
        const y = event.clientY;
        const menuRect = menu.getBoundingClientRect();
        const triggerRect = state.layoutMenuTrigger.getBoundingClientRect();
        const isNearMenu = isPointInExpandedRect(x, y, menuRect, 10);
        const isNearTrigger = isPointInExpandedRect(x, y, triggerRect, 12);
        state.layoutMenuPointerInside = isNearMenu;
        if (isNearMenu || isNearTrigger) {
            if (state.layoutMenuCloseTimer) {
                window.clearTimeout(state.layoutMenuCloseTimer);
                state.layoutMenuCloseTimer = 0;
            }
            return;
        }
        scheduleHideLayoutMenu(90);
    }

    function startLayoutMenuWatchdog() {
        if (state.layoutMenuWatchTimer) window.clearInterval(state.layoutMenuWatchTimer);
        state.layoutMenuWatchTimer = window.setInterval(() => {
            const menu = state.layoutMenu;
            const trigger = state.layoutMenuTrigger;
            if (!menu || menu.hidden || !trigger) {
                hideLayoutMenu();
                return;
            }
            const focused = document.activeElement;
            const hasFocus = Boolean(focused && menu.contains(focused));
            const hasHover = menu.matches(':hover') || trigger.matches(':hover');
            if (!hasFocus && !hasHover) {
                scheduleHideLayoutMenu(120);
            }
        }, 320);
    }

    function wireLayoutMenuTrigger(record, button) {
        if (button.dataset.layoutMenuWired === '1') return;
        button.dataset.layoutMenuWired = '1';
        button.addEventListener('mouseenter', () => scheduleShowLayoutMenu(record, button));
        button.addEventListener('mouseleave', () => scheduleHideLayoutMenu(140));
        button.addEventListener('focus', () => scheduleShowLayoutMenu(record, button));
        button.addEventListener('blur', () => scheduleHideLayoutMenu(140));
        button.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            showLayoutMenu(record, button);
        });
        button.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown' || event.key === ' ') {
                event.preventDefault();
                showLayoutMenu(record, button);
            }
        });
    }

    function register(options) {
        const element = document.getElementById(options.id);
        if (!element) throw new Error(`Window element not found: ${options.id}`);

        const existing = state.windows.get(options.id);
        if (existing) {
            focus(existing.id);
            return existing;
        }

        const width = Math.min(options.width || 900, getViewportRect().width - (DEFAULTS.viewportPadding * 2));
        const height = Math.min(options.height || 620, getViewportRect().height - (DEFAULTS.viewportPadding * 2));
        const defaultRect = normalizeRect({ minWidth: options.minWidth, minHeight: options.minHeight }, options.initialRect || {
            x: Math.max(DEFAULTS.viewportPadding, (getViewportRect().width - width) / 2),
            y: Math.max(DEFAULTS.viewportPadding, (getViewportRect().height - height) / 2),
            width,
            height,
        });
        const persistedLayout = options.persist === false ? null : state.persistence.layouts.get(options.id);
        const rect = persistedLayout?.rect && isValidRect(persistedLayout.rect)
            ? normalizeRect({ minWidth: options.minWidth, minHeight: options.minHeight }, persistedLayout.rect)
            : defaultRect;

        element.dataset.windowId = options.id;
        if (options.title) element.dataset.windowTitle = options.title;
        if (options.icon) element.dataset.windowIcon = options.icon;
        element.classList.add('tcloud-window');

        const record = {
            id: options.id,
            element,
            title: options.title || element.dataset.windowTitle || options.id,
            icon: options.icon || element.dataset.windowIcon || 'ph ph-app-window',
            appId: options.appId || element.dataset.appId || '',
            titlebar: element.querySelector(options.titlebarSelector || '[data-window-titlebar]'),
            minWidth: options.minWidth || DEFAULTS.minWidth,
            minHeight: options.minHeight || DEFAULTS.minHeight,
            snapThreshold: options.snapThreshold || DEFAULTS.snapThreshold,
            rect: cloneRect(rect),
            initialRect: cloneRect(rect),
            defaultRect: cloneRect(defaultRect),
            restoreRect: cloneRect(rect),
            zIndex: nextZIndex(),
            status: 'normal',
            snapSide: null,
            minimized: false,
            persist: options.persist !== false,
            restoredFromPersistence: false,
            userInteracted: false,
            onClose: options.onClose,
            onStateChange: options.onStateChange,
            transitionTimer: 0,
            wired: false,
        };
        if (persistedLayout) applyPersistedLayout(record, persistedLayout, 'register');

        state.windows.set(record.id, record);
        element.hidden = false;
        wireWindow(record);
        scheduleApply(record);
        focus(record.id);
        updateDock();
        notifyStateChange(record, 'register');
        return record;
    }

    function getWindow(id) {
        return state.windows.get(id) || null;
    }

    function getActiveWindow() {
        const record = state.activeId ? state.windows.get(state.activeId) : null;
        if (!record) return null;
        return {
            id: record.id,
            appId: record.appId || record.element?.dataset?.appId || '',
            status: record.status,
            minimized: Boolean(record.minimized),
            zIndex: record.zIndex,
        };
    }

    function reflowAll() {
        state.windows.forEach((record) => {
            if (record.status === 'closed') return;
            if (record.status === 'maximized') {
                const viewport = getViewportRect();
                record.rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
            } else if (record.status === 'snapped' && record.snapSide) {
                record.rect = getLayoutRect(record.snapSide);
            } else {
                record.rect = normalizeRect(record, record.rect);
            }
            scheduleApply(record);
            notifyStateChange(record, 'viewport-resize');
        });
    }

    window.addEventListener('resize', () => {
        window.requestAnimationFrame(reflowAll);
    });
    window.addEventListener('blur', clearAllResizeHover);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') clearAllResizeHover();
    });
    wireGlobalFocusCapture();

    window.TCloudWindowManager = {
        register,
        focus,
        minimize,
        maximize,
        restore,
        close,
        snap,
        layout,
        getWindow,
        getActiveWindow,
        getState: () => state,
        configurePersistence,
        hydrateLayouts,
        resetWindowState,
        scheduleApply,
        reflowAll,
    };
})();
