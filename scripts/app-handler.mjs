import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, relative, sep } from "node:path";

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wav", "audio/wav"],
]);

export function createAppRequestHandler(rootDir) {
  const savedDir = join(rootDir, "patches");
  const recordingsDir = join(rootDir, "recordings");

  function jsonResponse(response, status, body) {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
  }

  function timestampForFile(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
    ].join("_");
  }

  function safePatchFolderName(name) {
    return String(name || "Untitled Patch")
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 96)
      || "Untitled Patch";
  }

  function safeTimestampName(name) {
    const timestamp = String(name || "").trim();
    return /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}(?:-[0-9]+)?$/.test(timestamp)
      ? timestamp
      : null;
  }

  function safeRecordingFileName(name) {
    const fileName = String(name || "")
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 96);
    const wavName = fileName.toLowerCase().endsWith(".wav") ? fileName : `${fileName}.wav`;
    return /^[^/\\]+\.wav$/i.test(wavName) ? wavName : null;
  }

  function readRequestBody(request, maxBytes = 5 * 1024 * 1024) {
    return new Promise((resolveBody, rejectBody) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > maxBytes) {
          rejectBody(new Error("Request body is too large."));
          request.destroy();
        }
      });
      request.on("end", () => resolveBody(body));
      request.on("error", rejectBody);
    });
  }

  function readRequestBuffer(request, maxBytes = 100 * 1024 * 1024) {
    return new Promise((resolveBody, rejectBody) => {
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          rejectBody(new Error("Request body is too large."));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolveBody(Buffer.concat(chunks)));
      request.on("error", rejectBody);
    });
  }

  function savedPatchDirectory(patchName) {
    const folderName = safePatchFolderName(patchName);
    const directory = join(savedDir, folderName);
    const relativePath = relative(savedDir, directory);
    if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) return null;
    return { folderName, directory };
  }

  function savedPatchPath(patchName, timestamp) {
    const patchDirectory = savedPatchDirectory(patchName);
    const timestampName = safeTimestampName(timestamp);
    if (!patchDirectory || !timestampName) return null;
    const filePath = join(patchDirectory.directory, `${timestampName}.yaml`);
    const relativePath = relative(patchDirectory.directory, filePath);
    if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) return null;
    return { ...patchDirectory, timestampName, filePath };
  }

  function listSavedPatches() {
    if (!existsSync(savedDir)) return [];
    return readdirSync(savedDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && safePatchFolderName(entry.name) === entry.name)
      .map((entry) => {
        const directory = join(savedDir, entry.name);
        const timestamps = readdirSync(directory, { withFileTypes: true })
          .filter((file) => file.isFile() && file.name.endsWith(".yaml"))
          .map((file) => file.name.slice(0, -5))
          .filter((timestamp) => safeTimestampName(timestamp))
          .sort()
          .reverse();
        return { name: entry.name, timestamps };
      })
      .filter((patch) => patch.timestamps.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  function safeFilePath(pathname) {
    const requestedPath = pathname === "/" ? "/index.html" : pathname;
    const decodedPath = decodeURIComponent(requestedPath);
    const normalizedPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(rootDir, normalizedPath);
    const relativePath = relative(rootDir, filePath);
    const pathParts = relativePath.split(sep);

    if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`) || pathParts.some((part) => part.startsWith("."))) {
      return null;
    }
    return filePath;
  }

  async function handlePatchesRequest(request, response) {
    if (request.method === "GET") {
      jsonResponse(response, 200, { patches: listSavedPatches() });
      return;
    }

    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "Method not allowed." });
      return;
    }

    const body = await readRequestBody(request);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      jsonResponse(response, 400, { error: "Invalid JSON body." });
      return;
    }

    const patchName = safePatchFolderName(payload.patchName);
    const content = typeof payload.content === "string" ? payload.content : "";
    if (!content.trim()) {
      jsonResponse(response, 400, { error: "Patch content is required." });
      return;
    }

    const patchDirectory = savedPatchDirectory(patchName);
    if (!patchDirectory) {
      jsonResponse(response, 400, { error: "Invalid patch name." });
      return;
    }

    mkdirSync(patchDirectory.directory, { recursive: true });
    const baseTimestamp = timestampForFile();
    let timestamp = baseTimestamp;
    let filePath = join(patchDirectory.directory, `${timestamp}.yaml`);
    let counter = 1;
    while (existsSync(filePath)) {
      timestamp = `${baseTimestamp}-${counter}`;
      filePath = join(patchDirectory.directory, `${timestamp}.yaml`);
      counter += 1;
    }

    writeFileSync(filePath, content, "utf8");
    jsonResponse(response, 201, {
      patchName: patchDirectory.folderName,
      timestamp,
    });
  }

  async function handleSavedPatchRequest(request, response, url) {
    const segments = url.pathname.split("/").map((segment) => decodeURIComponent(segment));
    if (request.method !== "GET") {
      jsonResponse(response, 405, { error: "Method not allowed." });
      return;
    }

    const patchName = segments[3];
    const timestamp = segments[4];
    if (segments.length !== 5 || !patchName || !timestamp) {
      jsonResponse(response, 404, { error: "Saved patch not found." });
      return;
    }

    const patchPath = savedPatchPath(patchName, timestamp);
    if (!patchPath || !existsSync(patchPath.filePath) || !statSync(patchPath.filePath).isFile()) {
      jsonResponse(response, 404, { error: "Saved patch not found." });
      return;
    }

    response.writeHead(200, {
      "content-type": "application/x-yaml; charset=utf-8",
      "cache-control": "no-store",
    });
    createReadStream(patchPath.filePath).pipe(response);
  }

  async function handleRecordingRequest(request, response) {
    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "Method not allowed." });
      return;
    }

    const recording = await readRequestBuffer(request);
    if (!recording.length) {
      jsonResponse(response, 400, { error: "Recording content is required." });
      return;
    }

    const startedAt = new Date(request.headers["x-recording-started-at"] || Date.now());
    const baseTimestamp = timestampForFile(Number.isNaN(startedAt.valueOf()) ? new Date() : startedAt);
    mkdirSync(recordingsDir, { recursive: true });

    const exportTimestamp = safeTimestampName(request.headers["x-recording-export-id"]);
    const exportFileName = safeRecordingFileName(request.headers["x-recording-file-name"]);
    if (exportTimestamp && exportFileName) {
      const exportDirectory = join(recordingsDir, exportTimestamp);
      const relativeDirectory = relative(recordingsDir, exportDirectory);
      const filePath = join(exportDirectory, exportFileName);
      const relativeFile = relative(exportDirectory, filePath);
      if (
        relativeDirectory.startsWith("..")
        || relativeDirectory.includes(`..${sep}`)
        || relativeFile.startsWith("..")
        || relativeFile.includes(`..${sep}`)
      ) {
        jsonResponse(response, 400, { error: "Invalid recording export path." });
        return;
      }
      mkdirSync(exportDirectory, { recursive: true });
      writeFileSync(filePath, recording);
      jsonResponse(response, 201, {
        timestamp: exportTimestamp,
        fileName: exportFileName,
      });
      return;
    }

    let timestamp = baseTimestamp;
    let filePath = join(recordingsDir, `${timestamp}.wav`);
    let counter = 1;
    while (existsSync(filePath)) {
      timestamp = `${baseTimestamp}-${counter}`;
      filePath = join(recordingsDir, `${timestamp}.wav`);
      counter += 1;
    }

    writeFileSync(filePath, recording);
    jsonResponse(response, 201, {
      timestamp,
    });
  }

  return function handleAppRequest(request, response) {
    const url = new URL(request.url, `${request.socket.encrypted ? "https" : "http"}://${request.headers.host || "localhost"}`);

    if (url.pathname === "/api/patches") {
      handlePatchesRequest(request, response).catch((error) => {
        jsonResponse(response, 500, { error: error.message || "Patch request failed." });
      });
      return;
    }

    if (url.pathname === "/api/recordings") {
      handleRecordingRequest(request, response).catch((error) => {
        jsonResponse(response, 500, { error: error.message || "Recording request failed." });
      });
      return;
    }

    if (url.pathname.startsWith("/api/patches/")) {
      handleSavedPatchRequest(request, response, url).catch((error) => {
        jsonResponse(response, 500, { error: error.message || "Patch request failed." });
      });
      return;
    }

    const filePath = safeFilePath(url.pathname);

    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }

    response.writeHead(200, {
      "content-type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  };
}
