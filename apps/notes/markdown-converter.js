function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function blockText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return stripHtml(value);
  }
  if (Array.isArray(value)) {
    return value.map(blockText).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    return blockText(value.content ?? value.text ?? value.name ?? value.path ?? value.title ?? "");
  }
  return "";
}

function listItemsToMarkdown(items = [], level = 0, ordered = false) {
  return (Array.isArray(items) ? items : [])
    .flatMap((item, index) => {
      const content = blockText(item);
      const children = Array.isArray(item?.items) ? listItemsToMarkdown(item.items, level + 1, ordered) : [];
      const indent = "  ".repeat(level);
      const prefix = ordered ? `${index + 1}.` : "-";
      const lines = content ? [`${indent}${prefix} ${content}`] : [];
      return [...lines, ...children];
    })
    .filter(Boolean);
}

export function blocksToMarkdownPreview(blocks = []) {
  return blocks
    .map((block) => {
      const type = String(block?.type || "");
      const data = block?.data && typeof block.data === "object" ? block.data : {};
      if (type === "header") {
        const level = Math.max(1, Math.min(Number(data.level || 2), 6));
        return `${"#".repeat(level)} ${stripHtml(data.text)}`.trim();
      }
      if (type === "list") {
        return listItemsToMarkdown(data.items, 0, String(data.style || "") === "ordered").join("\n");
      }
      if (type === "todo") {
        return `- [${data.checked ? "x" : " "}] ${blockText(data.text)}`.trim();
      }
      if (type === "quote") {
        return `> ${blockText(data.text)}`.trim();
      }
      if (type === "codeBlock") {
        return blockText(data.code) ? "```" : "";
      }
      if (type === "divider") {
        return "---";
      }
      if (String(type).startsWith("tcloud")) {
        return `[${blockText(data.name || data.path) || "Arquivo do TCloud"}](${String(data.path || "").trim()})`;
      }
      return blockText(data.text || data.code || data);
    })
    .filter(Boolean)
    .join("\n\n");
}
