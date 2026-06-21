export function installWikiLinkAutocomplete({ root, api }) {
  if (!root) return;
  const menu = document.createElement("div");
  menu.className = "wiki-link-menu hidden";
  menu.setAttribute("role", "listbox");
  document.body.appendChild(menu);

  let activeIndex = -1;
  let currentNotes = [];

  function close() {
    menu.classList.add("hidden");
    activeIndex = -1;
    currentNotes = [];
  }

  function setActiveIndex(index) {
    const buttons = Array.from(menu.querySelectorAll("button"));
    if (!buttons.length) return;
    activeIndex = Math.max(0, Math.min(index, buttons.length - 1));
    buttons.forEach((btn, i) => {
      btn.classList.toggle("is-active", i === activeIndex);
      btn.setAttribute("aria-selected", i === activeIndex ? "true" : "false");
    });
    buttons[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }

  function applyActive() {
    const note = currentNotes[activeIndex];
    if (!note) return close();
    const title = note.title || "Sem título";
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return close();
    const range = selection.getRangeAt(0);
    const node = selection.anchorNode;
    const text = String(node?.textContent || "").slice(0, selection.anchorOffset || 0);
    const match = text.match(/\[\[([^\]\n]{0,80})$/);
    const typed = match ? match[1] || "" : "";
    const suffix = title.toLowerCase().startsWith(typed.toLowerCase()) ? title.slice(typed.length) : title;
    const insertText = `${suffix}]]`;
    try {
      const textNode = document.createTextNode(insertText);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);
      node?.normalize?.();
    } catch (error) {
      document.execCommand("insertText", false, insertText);
    }
    close();
  }

  function positionMenu(rect) {
    const width = menu.offsetWidth || 260;
    const height = menu.offsetHeight || 160;
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
    const top = Math.min(Math.max(12, rect.bottom + 8), Math.max(12, window.innerHeight - height - 12));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  root.addEventListener("keyup", async (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") return;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return close();
    const node = selection.anchorNode;
    const text = String(node?.textContent || "").slice(0, selection.anchorOffset || 0);
    const match = text.match(/\[\[([^\]\n]{0,80})$/);
    if (!match) return close();
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const response = await api.searchRelations(match[1] || "", 8);
    currentNotes = response.notes || [];
    menu.innerHTML = "";
    currentNotes.forEach((note) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.textContent = note.title || "Sem título";
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const title = note.title || "Sem título";
        const typed = match[1] || "";
        const suffix = title.toLowerCase().startsWith(typed.toLowerCase()) ? title.slice(typed.length) : title;
        document.execCommand("insertText", false, `${suffix}]]`);
        close();
      });
      menu.appendChild(button);
    });
    menu.classList.toggle("hidden", !menu.children.length);
    if (!menu.classList.contains("hidden")) {
      positionMenu(rect);
      setActiveIndex(0);
    }
  });

  root.addEventListener("keydown", (event) => {
    if (menu.classList.contains("hidden")) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(activeIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      applyActive();
    } else if (event.key === "Escape") {
      close();
    }
  }, true);

  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target)) close();
  });
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close, { passive: true });
}
