#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { createAppRequestHandler } from "./app-handler.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const certDir = join(rootDir, ".certs");
const host = process.env.HOST || "0.0.0.0";
const httpPort = Number(process.env.HTTP_PORT || 8839);
const port = Number(process.env.HTTPS_PORT || process.env.PORT || 8843);
const certPort = Number(process.env.CERT_PORT || 8844);

const rootKeyPath = join(certDir, "visual-fm-dev-root.key");
const rootCertPath = join(certDir, "visual-fm-dev-root.crt");
const rootSerialPath = join(certDir, "visual-fm-dev-root.srl");
const serverKeyPath = join(certDir, "visual-fm-dev-server.key");
const serverCsrPath = join(certDir, "visual-fm-dev-server.csr");
const serverCertPath = join(certDir, "visual-fm-dev-server.crt");
const serverReqConfigPath = join(certDir, "server-req.conf");
const serverExtConfigPath = join(certDir, "server-ext.conf");
const rootConfigPath = join(certDir, "root.conf");

function localIPv4Addresses() {
  const interfaces = Object.entries(networkInterfaces());
  const addresses = interfaces.flatMap(([name, entries]) => {
    const priority = /^(en0|wl|wlan|wifi|ath)|wi-?fi|wireless/i.test(name) ? 0 : 1;
    return (entries || [])
      .filter((address) => address?.family === "IPv4" && !address.internal)
      .map((address) => ({ address: address.address, priority }));
  });

  return addresses
    .sort((left, right) => left.priority - right.priority)
    .map((entry) => entry.address)
    .filter(Boolean);
}

function uniqueAddresses(addresses) {
  return [...new Set(addresses.filter(Boolean))];
}

function runOpenSsl(args) {
  try {
    execFileSync("openssl", args, { stdio: "pipe" });
  } catch (error) {
    const stderr = error.stderr?.toString?.().trim();
    const detail = stderr ? `\n${stderr}` : "";
    throw new Error(`openssl ${args.join(" ")} failed.${detail}`);
  }
}

function altNamesConfig(addresses) {
  const dnsNames = ["localhost", "visual-fm.local"];
  const ipAddresses = ["127.0.0.1", ...addresses];
  const dnsLines = dnsNames.map((name, index) => `DNS.${index + 1} = ${name}`);
  const ipLines = [...new Set(ipAddresses)].map((address, index) => `IP.${index + 1} = ${address}`);
  return [...dnsLines, ...ipLines].join("\n");
}

function ensureRootCertificate() {
  if (existsSync(rootKeyPath) && existsSync(rootCertPath)) return;

  writeFileSync(rootConfigPath, `
[ req ]
prompt = no
distinguished_name = dn
x509_extensions = v3_ca

[ dn ]
CN = Visual FM Dev Root CA

[ v3_ca ]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
`.trimStart());

  runOpenSsl(["genrsa", "-out", rootKeyPath, "2048"]);
  chmodSync(rootKeyPath, 0o600);
  runOpenSsl([
    "req",
    "-x509",
    "-new",
    "-nodes",
    "-key",
    rootKeyPath,
    "-sha256",
    "-days",
    "3650",
    "-out",
    rootCertPath,
    "-config",
    rootConfigPath,
    "-extensions",
    "v3_ca",
  ]);
}

function generateServerCertificate(addresses) {
  const altNames = altNamesConfig(addresses);

  writeFileSync(serverReqConfigPath, `
[ req ]
prompt = no
distinguished_name = dn
req_extensions = v3_req

[ dn ]
CN = Visual FM Dev Server

[ v3_req ]
subjectAltName = @alt_names

[ alt_names ]
${altNames}
`.trimStart());

  writeFileSync(serverExtConfigPath, `
[ server_cert ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[ alt_names ]
${altNames}
`.trimStart());

  runOpenSsl(["genrsa", "-out", serverKeyPath, "2048"]);
  chmodSync(serverKeyPath, 0o600);
  runOpenSsl(["req", "-new", "-key", serverKeyPath, "-out", serverCsrPath, "-config", serverReqConfigPath]);
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    serverCsrPath,
    "-CA",
    rootCertPath,
    "-CAkey",
    rootKeyPath,
    "-CAserial",
    rootSerialPath,
    "-CAcreateserial",
    "-out",
    serverCertPath,
    "-days",
    "397",
    "-sha256",
    "-extfile",
    serverExtConfigPath,
    "-extensions",
    "server_cert",
  ]);
}

function ensureCertificates(addresses) {
  mkdirSync(certDir, { recursive: true });
  ensureRootCertificate();
  generateServerCertificate(addresses);
}

function handleCertificateRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (url.pathname === "/" || url.pathname === "/visual-fm-dev-root.crt") {
    response.writeHead(200, {
      "content-type": url.pathname === "/" ? "text/plain; charset=utf-8" : "application/x-x509-ca-cert",
      "cache-control": "no-store",
    });
    if (url.pathname === "/") {
      response.end("Download /visual-fm-dev-root.crt on iOS, install it, then enable full trust.\n");
    } else {
      createReadStream(rootCertPath).pipe(response);
    }
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
}

function listen(server, serverHost, serverPort) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(serverPort, serverHost, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

const publicHost = process.env.PUBLIC_HOST || "";
const lanAddresses = publicHost ? [publicHost] : uniqueAddresses(localIPv4Addresses());
ensureCertificates(lanAddresses);

const appHandler = createAppRequestHandler(rootDir);
const httpServer = createHttpServer(appHandler);
const httpsServer = createHttpsServer({
  key: readFileSync(serverKeyPath),
  cert: readFileSync(serverCertPath),
}, appHandler);

const certServer = createHttpServer(handleCertificateRequest);

try {
  await listen(httpServer, host, httpPort);
  await listen(httpsServer, host, port);
  await listen(certServer, host, certPort);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const appUrls = [
  `http://localhost:${httpPort}/`,
  `https://localhost:${port}/`,
  ...lanAddresses.map((address) => `https://${address}:${port}/`),
];
const certUrls = lanAddresses.map((address) => `http://${address}:${certPort}/visual-fm-dev-root.crt`);

console.log("Visual FM dev server");
console.log("");
console.log("App URLs:");
for (const url of appUrls) console.log(`  ${url}`);
console.log("");
console.log("iOS certificate install URLs:");
for (const url of certUrls) console.log(`  ${url}`);
console.log("");
console.log("On iOS: install the root certificate, enable full trust in Certificate Trust Settings, then open the HTTPS app URL.");
console.log(`Root certificate: ${rootCertPath}`);
if (existsSync(rootSerialPath)) chmodSync(rootSerialPath, 0o600);
