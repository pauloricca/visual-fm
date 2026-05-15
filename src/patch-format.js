import { downloadBlob, slugifyPatchName, timestampForFile } from "./utils.js";

export function patchFileName(patchName, date = new Date()) {
  const name = slugifyPatchName(patchName || "visual-fm-patch");
  return `${name}-${timestampForFile(date)}.yaml`;
}

export function downloadPatchFile(patch) {
  const blob = new Blob([patchFileText(patch)], { type: "application/x-yaml" });
  downloadBlob(blob, patchFileName(patch.patchName));
}

export function patchFileText(patch) {
  return `# Visual FM patch\n# visual-fm-json: ${encodePatchJson(patch)}\n${toYaml(patch)}\n`;
}

export function parsePatchFile(text) {
  const encoded = /^# visual-fm-json: (.+)$/m.exec(text)?.[1];
  if (encoded) {
    return JSON.parse(decodePatchJson(encoded.trim()));
  }

  try {
    return JSON.parse(text);
  } catch {
    return parseSimpleYaml(text);
  }
}

function encodePatchJson(patch) {
  const bytes = new TextEncoder().encode(JSON.stringify(patch));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodePatchJson(encoded) {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function toYaml(value, indent = 0) {
  const space = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${space}[]`;
    return value.map((item) => `${space}-\n${toYaml(item, indent + 2)}`).join("\n");
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${space}{}`;
    return entries.map(([key, item]) => {
      if (Array.isArray(item) && item.length === 0) return `${space}${key}: []`;
      if (item && typeof item === "object" && Object.keys(item).length === 0) return `${space}${key}: {}`;
      if (item && typeof item === "object") {
        return `${space}${key}:\n${toYaml(item, indent + 2)}`;
      }
      return `${space}${key}: ${yamlScalar(item)}`;
    }).join("\n");
  }

  return `${space}${yamlScalar(value)}`;
}

function yamlScalar(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function parseSimpleYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => ({ indent: raw.match(/^ */)?.[0].length || 0, text: raw.trim() }))
    .filter((line) => line.text && !line.text.startsWith("#"));

  const [value, index] = parseYamlBlock(lines, 0, 0);
  if (index < lines.length) throw new Error("Unsupported YAML structure");
  return value;
}

function parseYamlBlock(lines, index, indent) {
  if (!lines[index]) return [{}, index];
  if (lines[index].indent < indent) return [{}, index];
  return lines[index].text.startsWith("-")
    ? parseYamlArray(lines, index, indent)
    : parseYamlObject(lines, index, indent);
}

function parseYamlArray(lines, index, indent) {
  const array = [];
  while (lines[index] && lines[index].indent === indent && lines[index].text.startsWith("-")) {
    const inline = lines[index].text.slice(1).trim();
    index += 1;
    if (inline) {
      array.push(parseYamlScalar(inline));
    } else {
      const [item, nextIndex] = parseYamlBlock(lines, index, indent + 2);
      array.push(item);
      index = nextIndex;
    }
  }
  return [array, index];
}

function parseYamlObject(lines, index, indent) {
  const object = {};
  while (lines[index] && lines[index].indent === indent && !lines[index].text.startsWith("-")) {
    const separator = lines[index].text.indexOf(":");
    if (separator === -1) throw new Error("Invalid YAML line");
    const key = lines[index].text.slice(0, separator).trim();
    const inline = lines[index].text.slice(separator + 1).trim();
    index += 1;
    if (inline) {
      object[key] = parseYamlScalar(inline);
    } else {
      const [item, nextIndex] = parseYamlBlock(lines, index, indent + 2);
      object[key] = item;
      index = nextIndex;
    }
  }
  return [object, index];
}

function parseYamlScalar(value) {
  if (value === "[]") return [];
  if (value === "{}") return {};
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) return JSON.parse(value);
  return value;
}
