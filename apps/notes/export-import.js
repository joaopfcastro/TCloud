export const IMPORT_ACCEPT = ".txt,.md,.markdown,.json,.tcnote.json";

export function formatBytes(value) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = size;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  const digits = current >= 10 || index === 0 ? 0 : 1;
  return `${current.toFixed(digits)} ${units[index]}`;
}

export function isSupportedImportFile(fileName) {
  const name = String(fileName || "").toLowerCase();
  return name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".json") || name.endsWith(".tcnote.json");
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Nao foi possivel ler o arquivo selecionado."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsText(file);
  });
}
