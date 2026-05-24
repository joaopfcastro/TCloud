function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
        return (Array.isArray(data.items) ? data.items : [])
          .map((item) => `- ${stripHtml(item)}`.trim())
          .join("\n");
      }
      if (type === "todo") {
        return `- [${data.checked ? "x" : " "}] ${stripHtml(data.text)}`.trim();
      }
      if (type === "quote") {
        return `> ${stripHtml(data.text)}`.trim();
      }
      if (type === "codeBlock") {
        return "```";
      }
      if (type === "divider") {
        return "---";
      }
      if (String(type).startsWith("tcloud")) {
        return `[${stripHtml(data.name || data.path)}](${String(data.path || "").trim()})`;
      }
      return stripHtml(data.text || data.code || "");
    })
    .filter(Boolean)
    .join("\n\n");
}
