const EDITORJS_POPOVER_TRIGGER_SELECTOR = ".ce-toolbar__plus, .ce-toolbar__settings-btn";
const EDITORJS_POPOVER_SELECTOR = ".ce-popover:not(.ce-popover--inline), .ce-settings, .ce-conversion-toolbar";
const POSITIONED_CLASS = "tcloud-editor-popover-positioned";
const VIEWPORT_MARGIN = 10;
const POPOVER_GAP = 8;
const MIN_POPOVER_HEIGHT = 120;
const DEFAULT_POPOVER_WIDTH = 260;
const DEFAULT_POPOVER_HEIGHT = 240;

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function elementIsUsable(element) {
  if (!element || !element.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  if (element.classList?.contains("hidden") || element.classList?.contains("ce-popover--closed")) return false;
  return true;
}

function rectArea(rect) {
  return Math.max(rect.width, 0) * Math.max(rect.height, 0);
}

function visualBounds(viewportRoot) {
  const visualViewport = window.visualViewport;
  const viewportRect = {
    left: visualViewport?.offsetLeft || 0,
    top: visualViewport?.offsetTop || 0,
    right: (visualViewport?.offsetLeft || 0) + (visualViewport?.width || window.innerWidth),
    bottom: (visualViewport?.offsetTop || 0) + (visualViewport?.height || window.innerHeight),
  };
  const rootRect = viewportRoot?.getBoundingClientRect?.();
  if (!rootRect || rootRect.width <= 0 || rootRect.height <= 0) return viewportRect;
  return {
    left: Math.max(viewportRect.left, rootRect.left),
    top: Math.max(viewportRect.top, rootRect.top),
    right: Math.min(viewportRect.right, rootRect.right),
    bottom: Math.min(viewportRect.bottom, rootRect.bottom),
  };
}

export class EditorJsPopoverController {
  constructor({ root, viewportRoot = null, onOpen = null, onClose = null } = {}) {
    this.root = root || document.body;
    this.viewportRoot = viewportRoot || this.root?.closest?.(".notes-app") || document.body;
    this.onOpen = typeof onOpen === "function" ? onOpen : null;
    this.onClose = typeof onClose === "function" ? onClose : null;
    this.ownerDocument = this.root?.ownerDocument || document;
    this.anchor = null;
    this.menu = null;
    this.surface = null;
    this.isOpen = false;
    this.positionFrame = null;
    this.verifyFrame = null;
    this.viewportListenersAttached = false;
    this.connected = false;
    this.portedInfo = null;

    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleViewportChange = this.handleViewportChange.bind(this);
  }

  connect() {
    if (this.connected) return;
    this.connected = true;
    this.ownerDocument.addEventListener("pointerdown", this.handlePointerDown, true);
    this.ownerDocument.addEventListener("click", this.handleClick, true);
    this.ownerDocument.addEventListener("keydown", this.handleKeyDown, true);

    if (this.root && typeof this.root.contains === "function") {
      const originalContains = this.root.contains;
      const portal = this.getPortal();
      this.root.contains = function(other) {
        if (portal && portal.contains(other)) return true;
        return originalContains.call(this, other);
      };
      this.originalContains = originalContains;
    }
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.ownerDocument.removeEventListener("pointerdown", this.handlePointerDown, true);
    this.ownerDocument.removeEventListener("click", this.handleClick, true);
    this.ownerDocument.removeEventListener("keydown", this.handleKeyDown, true);
    if (this.root && this.originalContains) {
      this.root.contains = this.originalContains;
      this.originalContains = null;
    }
    this.clear("disconnect");
  }

  handlePointerDown(event) {
    const trigger = event.target?.closest?.(EDITORJS_POPOVER_TRIGGER_SELECTOR);
    if (trigger && this.rootContains(trigger)) {
      this.anchor = trigger;
      this.setOpenState(true, "trigger");
      return;
    }

    if (!this.isOpen) return;
    const target = event.target;
    if (this.surface?.contains?.(target) || this.menu?.contains?.(target) || this.anchor?.contains?.(target)) return;
    this.clear("outside");
  }

  handleClick(event) {
    const trigger = event.target?.closest?.(EDITORJS_POPOVER_TRIGGER_SELECTOR);
    if (trigger && this.rootContains(trigger)) {
      this.anchor = trigger;
      this.setOpenState(true, "trigger-click");
      this.scheduleAttachAndPosition();
      return;
    }

    if (this.isOpen) this.scheduleVerify();
  }

  handleKeyDown(event) {
    const el = document.activeElement;
    this.prevEl = el;
    if (event.key === "Escape") {
      this.clear("escape");
      return;
    }
    if (this.isOpen) this.scheduleVerify();
  }

  handleViewportChange() {
    if (!this.isOpen || this.positionFrame) return;
    this.positionFrame = requestAnimationFrame(() => {
      this.positionFrame = null;
      if (!this.anchor?.isConnected || !this.surface?.isConnected) {
        this.clear("lost-anchor");
        return;
      }
      this.positionActiveMenu();
    });
  }

  scheduleAttachAndPosition() {
    if (this.positionFrame) cancelAnimationFrame(this.positionFrame);
    this.positionFrame = requestAnimationFrame(() => {
      this.positionFrame = null;
      const active = this.findActiveMenu();
      if (!active) {
        this.scheduleVerify();
        return;
      }
      this.attachMenu(active.menu, active.surface);
      this.positionActiveMenu(active.rect);
    });
  }

  scheduleVerify() {
    if (this.verifyFrame) cancelAnimationFrame(this.verifyFrame);
    this.verifyFrame = requestAnimationFrame(() => {
      this.verifyFrame = null;
      const active = this.findActiveMenu();
      if (!active) {
        this.clear("menu-closed");
        return;
      }
      if (active.menu !== this.menu || active.surface !== this.surface) {
        this.attachMenu(active.menu, active.surface);
      }
      this.positionActiveMenu(active.rect);
    });
  }

  findActiveMenu() {
    const scopedCandidates = Array.from(this.root?.querySelectorAll?.(EDITORJS_POPOVER_SELECTOR) || []);
    const scopedMatch = this.findVisibleCandidate(scopedCandidates);
    if (scopedMatch) return scopedMatch;
    return this.findVisibleCandidate(Array.from(this.ownerDocument.querySelectorAll(EDITORJS_POPOVER_SELECTOR)));
  }

  findVisibleCandidate(candidates) {
    return candidates
      .map((menu) => {
        const surface = this.surfaceFor(menu);
        if (!elementIsUsable(menu) || !elementIsUsable(surface)) return null;
        const rect = surface.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return null;
        return { menu, surface, rect, area: rectArea(rect) };
      })
      .filter(Boolean)
      .sort((a, b) => b.area - a.area)[0] || null;
  }

  getPortal() {
    let portal = this.ownerDocument.getElementById("tcloud-notes-editor-popover-portal");
    if (!portal) {
      portal = this.ownerDocument.createElement("div");
      portal.id = "tcloud-notes-editor-popover-portal";
      portal.className = "codex-editor";
      this.ownerDocument.body.appendChild(portal);
    }
    return portal;
  }

  portElement(element) {
    const portal = this.getPortal();
    if (!element || element.parentNode === portal) return;

    this.restorePortedElement();

    const parent = element.parentNode;
    if (!parent) return;

    const placeholder = this.ownerDocument.createComment("tcloud-notes-popover-placeholder");
    parent.insertBefore(placeholder, element);

    portal.appendChild(element);
    element.classList.add("tcloud-editor-popover-ported");

    this.portedInfo = {
      element,
      parent,
      placeholder
    };
  }

  restorePortedElement() {
    if (!this.portedInfo) return;
    const { element, parent, placeholder } = this.portedInfo;
    const portal = this.getPortal();

    if (element && element.parentNode === portal) {
      if (placeholder && placeholder.parentNode === parent) {
        parent.insertBefore(element, placeholder);
      } else if (parent) {
        parent.appendChild(element);
      }
    }

    if (placeholder && placeholder.parentNode) {
      placeholder.parentNode.removeChild(placeholder);
    }

    if (element) {
      element.classList.remove("tcloud-editor-popover-ported");
    }

    this.portedInfo = null;
  }

  attachMenu(menu, surface) {
    if (this.menu && this.menu !== menu) {
      this.resetElement(this.menu);
      this.restorePortedElement();
    }
    if (this.surface && this.surface !== surface) {
      this.resetElement(this.surface);
    }

    this.menu = menu;
    this.surface = surface;

    this.portElement(this.menu);

    this.menu.classList.add(POSITIONED_CLASS);
    this.surface.classList.add(POSITIONED_CLASS);
    this.attachViewportListeners();
    this.setOpenState(true, "menu-attached");
  }

  positionActiveMenu(measuredRect = null) {
    if (!this.anchor?.isConnected || !this.surface?.isConnected) {
      this.clear("detached");
      return;
    }

    const bounds = visualBounds(this.viewportRoot);
    const anchorRect = this.anchor.getBoundingClientRect();
    const gap = POPOVER_GAP;
    const margin = VIEWPORT_MARGIN;

    // READ phase
    const rect = measuredRect || this.surface.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width || DEFAULT_POPOVER_WIDTH, 180), bounds.right - bounds.left - margin * 2);
    const height = Math.max(rect.height || DEFAULT_POPOVER_HEIGHT, MIN_POPOVER_HEIGHT);

    const availableBelow = bounds.bottom - anchorRect.bottom - gap - margin;
    const availableAbove = anchorRect.top - bounds.top - gap - margin;
    const shouldOpenAbove = availableBelow < Math.min(height, 220) && availableAbove > availableBelow;

    const maxHeight = Math.max(160, Math.min(420, shouldOpenAbove ? availableAbove : availableBelow));
    const top = shouldOpenAbove
      ? Math.max(bounds.top + margin, anchorRect.top - Math.min(height, maxHeight) - gap)
      : Math.min(bounds.bottom - margin - Math.min(height, maxHeight), anchorRect.bottom + gap);

    const rawLeft = this.anchor.matches(".ce-toolbar__settings-btn") ? anchorRect.right - width : anchorRect.left;
    const left = clamp(
      rawLeft,
      bounds.left + margin,
      bounds.right - margin - width
    );

    // WRITE phase
    this.applyPosition(left, top, maxHeight, width);

    // Apply max-height to internal list for scrolling if needed
    const list = this.menu?.querySelector?.(".ce-popover__items, .ce-settings__items, .ce-settings, .ce-conversion-toolbar");
    if (list && list !== this.menu) {
      list.style.setProperty("max-height", `calc(${Math.round(maxHeight)}px - 16px)`, "important");
      list.style.setProperty("overflow-y", "auto", "important");
    }
  }

  applyPosition(left, top, maxHeight, width) {
    const roundedLeft = Math.round(left);
    const roundedTop = Math.round(top);
    this.surface.style.setProperty("position", "fixed", "important");
    this.surface.style.setProperty("left", `${roundedLeft}px`, "important");
    this.surface.style.setProperty("top", `${roundedTop}px`, "important");
    this.surface.style.setProperty("right", "auto", "important");
    this.surface.style.setProperty("bottom", "auto", "important");
    this.surface.style.setProperty("transform", "none", "important");
    this.surface.style.setProperty("max-height", `${Math.round(maxHeight)}px`, "important");
    this.surface.style.setProperty("max-width", `${Math.round(width)}px`, "important");
    this.surface.style.setProperty("--tcloud-editor-popover-max-height", `${Math.round(maxHeight)}px`);
    this.menu?.style?.setProperty("--tcloud-editor-popover-max-height", `${Math.round(maxHeight)}px`);
  }

  clear(reason = "clear") {
    if (this.positionFrame) cancelAnimationFrame(this.positionFrame);
    if (this.verifyFrame) cancelAnimationFrame(this.verifyFrame);
    this.positionFrame = null;
    this.verifyFrame = null;

    this.restorePortedElement();

    this.resetElement(this.surface);
    if (this.menu !== this.surface) this.resetElement(this.menu);
    this.surface = null;
    this.menu = null;
    this.anchor = null;
    this.detachViewportListeners();
    this.setOpenState(false, reason);
  }

  setOpenState(isOpen, reason) {
    if (this.isOpen === isOpen) return;
    this.isOpen = isOpen;
    const eventName = isOpen ? "tcloud-editor-popover-open" : "tcloud-editor-popover-close";
    this.ownerDocument.dispatchEvent(new CustomEvent(eventName, { detail: { reason } }));
    if (isOpen) this.onOpen?.(reason);
    else this.onClose?.(reason);
  }

  attachViewportListeners() {
    if (this.viewportListenersAttached) return;
    this.viewportListenersAttached = true;
    window.addEventListener("resize", this.handleViewportChange, { passive: true });
    this.ownerDocument.addEventListener("scroll", this.handleViewportChange, true);
    window.visualViewport?.addEventListener("resize", this.handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener("scroll", this.handleViewportChange, { passive: true });
  }

  detachViewportListeners() {
    if (!this.viewportListenersAttached) return;
    this.viewportListenersAttached = false;
    window.removeEventListener("resize", this.handleViewportChange);
    this.ownerDocument.removeEventListener("scroll", this.handleViewportChange, true);
    window.visualViewport?.removeEventListener("resize", this.handleViewportChange);
    window.visualViewport?.removeEventListener("scroll", this.handleViewportChange);
  }

  resetElement(element) {
    if (!element) return;
    element.classList.remove(POSITIONED_CLASS);
    [
      "position",
      "left",
      "top",
      "right",
      "bottom",
      "transform",
      "max-height",
      "max-width",
      "--tcloud-editor-popover-max-height",
    ].forEach((property) => element.style.removeProperty(property));

    const list = element.querySelector?.(".ce-popover__items, .ce-settings__items, .ce-settings, .ce-conversion-toolbar");
    if (list && list !== element) {
      list.style.removeProperty("max-height");
      list.style.removeProperty("overflow-y");
    }
  }

  surfaceFor(menu) {
    return menu?.matches?.(".ce-popover")
      ? (menu.querySelector(":scope > .ce-popover__container") || menu)
      : menu;
  }

  rootContains(node) {
    if (!node) return false;
    if (this.root === this.ownerDocument || this.root === this.ownerDocument.body) {
      return this.ownerDocument.documentElement.contains(node);
    }
    return Boolean(this.root?.contains?.(node));
  }
}
