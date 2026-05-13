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
        focus(id);
        if (record.status === 'maximized') {
            restore(id);
            return;
        }
        saveRestoreRect(record);
        const viewport = getViewportRect();
        record.status = 'maximized';
        record.snapSide = null;
        record.minimized = false;
        record.rect = {
            x: 0,
            y: 0,
            width: viewport.width,
            height: viewport.height,
        };
        record.element.hidden = false;
        record.element.classList.add('is-window-transitioning');
        scheduleApply(record);
        notifyStateChange(record, 'maximize');
        updateDock();
        window.setTimeout(() => record.element.classList.remove('is-window-transitioning'), 190);
    }

    function restore(id) {
        const record = state.windows.get(id);
        if (!record) return;
        const minimizedStatus = record.status === 'minimized' ? record.restoreStatus : null;
        const minimizedSnapSide = record.status === 'minimized' ? record.restoreSnapSide : null;
        focus(id);
        record.minimized = false;
        record.element.hidden = false;

        if (minimizedStatus === 'maximized') {
            const viewport = getViewportRect();
            record.status = 'maximized';
            record.snapSide = null;
            record.rect = {
                x: 0,
                y: 0,
                width: viewport.width,
                height: viewport.height,
            };
        } else if (minimizedStatus === 'snapped' && minimizedSnapSide) {
            const viewport = getViewportRect();
            record.status = 'snapped';
            record.snapSide = minimizedSnapSide;
            record.rect = {
                x: minimizedSnapSide === 'left' ? 0 : viewport.width / 2,
                y: 0,
                width: viewport.width / 2,
                height: viewport.height,
            };
        } else {
            record.status = 'normal';
            record.snapSide = null;
            record.rect = normalizeRect(record, record.restoreRect || record.initialRect);
        }

        record.restoreStatus = null;
        record.restoreSnapSide = null;
        record.element.classList.add('is-window-transitioning');
        scheduleApply(record);
        notifyStateChange(record, 'restore');
        updateDock();
        window.setTimeout(() => record.element.classList.remove('is-window-transitioning'), 190);
    }

    function minimize(id) {
        const record = state.windows.get(id);
        if (!record) return;
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
        const record = state.windows.get(id);
        if (!record || !['left', 'right'].includes(side)) return;
        focus(id);
        saveRestoreRect(record);
        const viewport = getViewportRect();
        record.status = 'snapped';
        record.snapSide = side;
        record.minimized = false;
        record.rect = {
            x: side === 'left' ? 0 : viewport.width / 2,
            y: 0,
            width: viewport.width / 2,
            height: viewport.height,
        };
        record.element.hidden = false;
        record.element.classList.add('is-window-transitioning');
        scheduleApply(record);
        notifyStateChange(record, `snap:${side}`);
        updateDock();
        window.setTimeout(() => record.element.classList.remove('is-window-transitioning'), 190);
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
    }

    function wireResizeHandles(record) {
        record.element.querySelectorAll('[data-resize-handle]').forEach((handle) => {
            handle.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || record.status === 'maximized') return;
                event.preventDefault();
                event.stopPropagation();
                focus(record.id);

                const dir = handle.dataset.resizeHandle || '';
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
                    setIframeShield(record, false);
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
                if (action === 'close') close(record.id);
                if (action === 'minimize') minimize(record.id);
                if (action === 'maximize') maximize(record.id);
                if (action === 'restore') restore(record.id);
            });
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
        const rect = normalizeRect({ minWidth: options.minWidth, minHeight: options.minHeight }, options.initialRect || {
            x: Math.max(DEFAULTS.viewportPadding, (getViewportRect().width - width) / 2),
            y: Math.max(DEFAULTS.viewportPadding, (getViewportRect().height - height) / 2),
            width,
            height,
        });

        element.dataset.windowId = options.id;
        if (options.title) element.dataset.windowTitle = options.title;
        if (options.icon) element.dataset.windowIcon = options.icon;
        element.classList.add('tcloud-window');

        const record = {
            id: options.id,
            element,
            title: options.title || element.dataset.windowTitle || options.id,
            icon: options.icon || element.dataset.windowIcon || 'ph ph-app-window',
            titlebar: element.querySelector(options.titlebarSelector || '[data-window-titlebar]'),
            minWidth: options.minWidth || DEFAULTS.minWidth,
            minHeight: options.minHeight || DEFAULTS.minHeight,
            snapThreshold: options.snapThreshold || DEFAULTS.snapThreshold,
            rect: cloneRect(rect),
            initialRect: cloneRect(rect),
            restoreRect: cloneRect(rect),
            zIndex: nextZIndex(),
            status: 'normal',
            snapSide: null,
            minimized: false,
            onClose: options.onClose,
            onStateChange: options.onStateChange,
            wired: false,
        };

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

    function reflowAll() {
        state.windows.forEach((record) => {
            if (record.status === 'closed') return;
            if (record.status === 'maximized') {
                const viewport = getViewportRect();
                record.rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
            } else if (record.status === 'snapped' && record.snapSide) {
                const viewport = getViewportRect();
                record.rect = {
                    x: record.snapSide === 'left' ? 0 : viewport.width / 2,
                    y: 0,
                    width: viewport.width / 2,
                    height: viewport.height,
                };
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

    window.TCloudWindowManager = {
        register,
        focus,
        minimize,
        maximize,
        restore,
        close,
        snap,
        getWindow,
        getState: () => state,
        scheduleApply,
        reflowAll,
    };
})();
