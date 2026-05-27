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

function blockIndentPrefix(data = {}) {
  const raw = data?.tcloudIndent;
  const value = typeof raw === "object" && raw !== null ? raw.level : raw;
  const level = Math.max(0, Math.min(Number(value || 0), 6));
  return "  ".repeat(Number.isFinite(level) ? level : 0);
}

function prefixMultiline(text, prefix) {
  if (!prefix || !text) return text;
  return String(text).split("\n").map((line) => line ? `${prefix}${line}` : line).join("\n");
}

export function blocksToMarkdownPreview(blocks = []) {
  return blocks
    .map((block) => {
      const type = String(block?.type || "");
      const data = block?.data && typeof block.data === "object" ? block.data : {};
      const indent = blockIndentPrefix(data);
      if (type === "header") {
        const level = Math.max(1, Math.min(Number(data.level || 2), 6));
        return `${indent}${"#".repeat(level)} ${stripHtml(data.text)}`.trimEnd();
      }
      if (type === "list") {
        return prefixMultiline(listItemsToMarkdown(data.items, 0, String(data.style || "") === "ordered").join("\n"), indent);
      }
      if (type === "todo") {
        return `${indent}- [${data.checked ? "x" : " "}] ${blockText(data.text)}`.trimEnd();
      }
      if (type === "quote") {
        return `${indent}> ${blockText(data.text)}`.trimEnd();
      }
      if (type === "codeBlock") {
        return blockText(data.code) ? `${indent}\`\`\`` : "";
      }
      if (type === "divider") {
        return `${indent}---`;
      }
      if (String(type).startsWith("tcloud")) {
        return `${indent}[${blockText(data.name || data.path) || "Arquivo do TCloud"}](${String(data.path || "").trim()})`;
      }
      return `${indent}${blockText(data.text || data.code || data)}`.trimEnd();
    })
    .filter(Boolean)
    .join("\n\n");
}
