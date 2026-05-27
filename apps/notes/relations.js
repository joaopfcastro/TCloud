export function installWikiLinkAutocomplete({ root, api }) {
  if (!root) return;
  const menu = document.createElement("div");
  menu.className = "wiki-link-menu hidden";
  document.body.appendChild(menu);

  function close() {
    menu.classList.add("hidden");
  }

  function positionMenu(rect) {
    const width = menu.offsetWidth || 260;
    const height = menu.offsetHeight || 160;
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
    const top = Math.min(Math.max(12, rect.bottom + 8), Math.max(12, window.innerHeight - height - 12));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  root.addEventListener("keyup", async () => {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return close();
    const node = selection.anchorNode;
    const text = String(node?.textContent || "").slice(0, selection.anchorOffset || 0);
    const match = text.match(/\[\[([^\]\n]{0,80})$/);
    if (!match) return close();
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const response = await api.searchRelations(match[1] || "", 8);
    menu.innerHTML = "";
    (response.notes || []).forEach((note) => {
      const button = document.createElement("button");
      button.type = "button";
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
    if (!menu.classList.contains("hidden")) positionMenu(rect);
  });

  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close, { passive: true });
}
