import { createServer as createHttpServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isPrivateIPv4, loadConfig } from "./config.js";
import { createBridge, validPage } from "./bridge.js";

let MAX_BODY_BYTES = 4096;
let MAX_SESSIONS = 64;
let MAX_FAILURE_CLIENTS = 256;
let COOKIE_NAME = "tvr_session";
let staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]]
].map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL(`public/${file}`, import.meta.url)) }]));
staticFiles.set("/volume-sender.js", { type: "text/javascript; charset=utf-8", body: readFileSync(new URL("../extension/volume-sender.js", import.meta.url)) });
staticFiles.set("/controls.js", { type: "text/javascript; charset=utf-8", body: readFileSync(new URL("public/controls.js", import.meta.url)) });
let apiMethods = new Map([
  ["/api/pair", "POST"], ["/api/tabs", "GET"], ["/api/volume", "POST"],
  ["/api/mute", "POST"], ["/api/logout", "POST"]
]);
apiMethods.set("/api/state", "POST");
let extensionMethods = new Map([
  ["/api/extension/register", "POST"], ["/api/extension/tabs", "POST"],
  ["/api/extension/check", "POST"],
  ["/api/extension/commands", "GET"], ["/api/extension/results", "POST"], ["/api/extension/disconnect", "POST"]
]);

function fail(status, code, message) {
  let error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function sessionKey(request) {
  let cookies = (request.headers.cookie || "").split(";").map(value => value.trim());
  let matches = cookies.filter(value => value.startsWith(`${COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  let token = matches[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token).toString("hex") : null;
}

function setCookie(response, token, seconds) {
  // Secure cookies cannot be used over LAN HTTP; HTTPS is required on untrusted networks.
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${seconds}`);
}

function validateSource(request, origin) {
  if (request.headers["x-tvr-client"] !== "mobile"
      || (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")) {
    fail(403, "FORBIDDEN_SOURCE", "不允許的請求來源。");
  }
  if (request.headers.origin !== undefined) {
    if (request.headers.origin === origin) return;
  } else if (request.method === "GET") {
    // Browsers may omit Origin on same-origin GET. Never accept a Referer fallback for POST.
    try {
      if (new URL(request.headers.referer).origin === origin) return;
    } catch { /* Missing/malformed Referer is denied below. */ }
  }
  fail(403, "FORBIDDEN_ORIGIN", "請從伺服器提供的同源頁面發送請求。");
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    fail(415, "JSON_REQUIRED", "請使用 application/json。");
  }
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
    fail(415, "ENCODING_UNSUPPORTED", "不支援壓縮請求本文。");
  }
  if (Number(request.headers["content-length"]) > maxBytes) {
    fail(413, "BODY_TOO_LARGE", "請求本文過大。");
  }
  let body = await new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    function cleanup() {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    }
    function onError(error) { cleanup(); reject(error); }
    function onAborted() { onError(new Error("Request aborted")); }
    function onEnd() { cleanup(); resolve(Buffer.concat(chunks)); }
    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes) {
        let error = Object.assign(new Error("請求本文過大。"), { status: 413, code: "BODY_TOO_LARGE" });
        onError(error);
        return;
      }
      chunks.push(chunk);
    }
    request.on("data", onData).on("end", onEnd).on("error", onError).on("aborted", onAborted);
  });
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    fail(400, "INVALID_JSON", "JSON 格式無效。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, "INVALID_BODY", "請提供 JSON 物件。");
  }
  return value;
}

function validateFields(body, names) {
  if (Object.keys(body).length !== names.length || names.some(name => !Object.hasOwn(body, name))) {
    fail(400, "INVALID_FIELDS", "請求欄位不正確。");
  }
}

function validateControl(body, path, remoteEnabled) {
  let field = path === "/api/state" ? null : path === "/api/volume" ? "volume" : "muted";
  validateFields(body, ["tabId", ...(field ? [field] : []), ...(remoteEnabled ? ["extensionSessionId", "pageId", "url"] : [])]);
  if (!Number.isSafeInteger(body.tabId) || body.tabId < 0) {
    fail(400, "INVALID_TAB_ID", "tabId 必須是非負安全整數。");
  }
  if (field === "volume" && (!Number.isInteger(body.volume) || body.volume < 0 || body.volume > 100)) {
    fail(400, "INVALID_VOLUME", "音量必須是 0～100 的整數。");
  }
  if (field === "muted" && typeof body.muted !== "boolean") {
    fail(400, "INVALID_MUTED", "muted 必須是布林值。");
  }
  if (remoteEnabled && (!validPage(body) || typeof body.extensionSessionId !== "string"
      || !body.extensionSessionId || body.extensionSessionId.length > 128)) {
    fail(400, "INVALID_TARGET", "請提供完整且有效的頁面識別資料。");
  }
}

export function createServer(config, now = Date.now) {
  let sessions = new Map();
  let failures = new Map();
  let bridge = createBridge(now);

  function prune() {
    for (let [key, expiry] of sessions) if (expiry <= now()) { sessions.delete(key); bridge.cancelOwner(key); }
    for (let [ip, entry] of failures) if (entry.expiresAt <= now()) failures.delete(ip);
  }

  async function extensionApi(request, response, path) {
    let extensionId = request.headers["x-tvr-extension-id"];
    if (request.headers["x-tvr-client"] !== "extension" || !config.extensionIds.includes(extensionId)
        || (request.headers.origin !== undefined && request.headers.origin !== `chrome-extension://${extensionId}`)) {
      fail(403, "FORBIDDEN_EXTENSION", "不允許的擴充功能來源。");
    }
    let ip = `extension:${request.socket.remoteAddress}`;
    checkPairLimit(ip, response);
    let authorization = request.headers.authorization || "";
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)
        || !timingSafeEqual(digest(authorization.slice(7)), config.extensionHash)) {
      let entry = failures.get(ip) || { count: 0, expiresAt: now() + config.pairWindowSeconds * 1000 };
      if (failures.has(ip) || failures.size < MAX_FAILURE_CLIENTS) { entry.count += 1; failures.set(ip, entry); }
      fail(401, "EXTENSION_AUTH_REQUIRED", "擴充功能憑證無效。");
    }
    failures.delete(ip);
    let method = extensionMethods.get(path);
    if (!method) fail(404, "NOT_FOUND", "找不到擴充功能 API。");
    if (method !== request.method) { response.setHeader("Allow", method); fail(405, "METHOD_NOT_ALLOWED", "不支援此 HTTP 方法。"); }
    if (path === "/api/extension/check") {
      validateFields(await readJson(request), []);
      return json(response, 200, { ok: true, message: "Server 憑證與來源驗證通過。" });
    }
    if (path === "/api/extension/register") {
      let body = await readJson(request);
      validateFields(body, ["clientId"]);
      return json(response, 200, { ok: true, ...bridge.register(body.clientId, extensionId) });
    }
    let id = request.headers["x-tvr-extension-session"];
    bridge.authenticate(id, extensionId);
    if (path === "/api/extension/commands") {
      let controller = new AbortController();
      let abort = () => controller.abort();
      response.once("close", abort);
      try {
        let command = await bridge.poll(id, controller.signal);
        if (!controller.signal.aborted) json(response, 200, { ok: true, command });
      } finally { response.off("close", abort); }
      return;
    }
    let body = await readJson(request, path === "/api/extension/tabs" ? 65536 : MAX_BODY_BYTES);
    if (path === "/api/extension/tabs") { validateFields(body, ["tabs"]); bridge.reportTabs(id, body.tabs); }
    if (path === "/api/extension/results") {
      validateFields(body, body.status === "applied" ? ["commandId", "status", "result"] : ["commandId", "status", "message"]);
      bridge.reportResult(id, body);
    }
    if (path === "/api/extension/disconnect") { validateFields(body, []); bridge.disconnect(id); }
    json(response, 200, { ok: true });
  }

  function checkPairLimit(ip, response) {
    let entry = failures.get(ip);
    if ((entry && entry.count >= config.pairMaxFailures) || (!entry && failures.size >= MAX_FAILURE_CLIENTS)) {
      let seconds = entry ? Math.ceil((entry.expiresAt - now()) / 1000) : config.pairWindowSeconds;
      response.setHeader("Retry-After", String(seconds));
      fail(429, "PAIR_RATE_LIMIT", "配對失敗次數過多，請稍後再試。");
    }
  }

  async function pair(request, response) {
    let ip = request.socket.remoteAddress;
    checkPairLimit(ip, response);
    try {
      let body = await readJson(request);
      // Recheck after reading: concurrent uploads must not bypass the failure limit.
      checkPairLimit(ip, response);
      validateFields(body, ["token"]);
      if (typeof body.token !== "string" || body.token.length > 128 || !body.token) {
        fail(400, "INVALID_TOKEN", "請提供配對 Token。");
      }
      if (!timingSafeEqual(digest(body.token), config.pairingHash)) {
        fail(401, "PAIR_FAILED", "配對 Token 不正確。");
      }
    } catch (error) {
      if (error.status !== 429 && (failures.has(ip) || failures.size < MAX_FAILURE_CLIENTS)) {
        let entry = failures.get(ip) || { count: 0, expiresAt: now() + config.pairWindowSeconds * 1000 };
        entry.count += 1;
        failures.set(ip, entry);
      }
      throw error;
    }
    let oldKey = sessionKey(request);
    if (!sessions.has(oldKey) && sessions.size >= MAX_SESSIONS) {
      fail(503, "SESSION_LIMIT", "工作階段已達上限，請稍後再試或重啟伺服器。");
    }
    sessions.delete(oldKey);
    bridge.cancelOwner(oldKey);
    let token = randomBytes(32).toString("base64url");
    sessions.set(digest(token).toString("hex"), now() + config.sessionSeconds * 1000);
    failures.delete(ip);
    setCookie(response, token, config.sessionSeconds);
    json(response, 200, { ok: true, expiresIn: config.sessionSeconds, ...bridge.listTabs() });
  }

  async function handle(request, response) {
    let expected = new URL(`http://${config.host}:${request.socket.localPort}`);
    if (!isPrivateIPv4(request.socket.remoteAddress) || request.socket.localAddress !== config.host
        || request.headers.host !== expected.host) {
      fail(403, "FORBIDDEN_HOST", "只允許指定內網介面的直接連線。");
    }
    // Fixed file allowlist, without joining request paths to the filesystem or normalizing traversal.
    let path = request.url;
    if (!path.startsWith("/") || path.startsWith("//") || /[?#]/.test(path)) {
      fail(400, "INVALID_URL", "不接受查詢字串或非標準路徑；Token 不得放在 URL。");
    }
    try { decodeURIComponent(path); } catch { fail(400, "INVALID_URL", "路徑編碼無效。"); }
    if (!path.startsWith("/api/")) {
      let file = staticFiles.get(path);
      if (!file) fail(404, "NOT_FOUND", "找不到資源。");
      if (!["GET", "HEAD"].includes(request.method)) {
        response.setHeader("Allow", "GET, HEAD");
        fail(405, "METHOD_NOT_ALLOWED", "不支援此 HTTP 方法。");
      }
      response.writeHead(200, { "Content-Type": file.type, "Content-Length": file.body.length });
      response.end(request.method === "HEAD" ? undefined : file.body);
      return;
    }

    prune();
    if (path.startsWith("/api/extension/") && config.extensionHash) return extensionApi(request, response, path);
    validateSource(request, expected.origin);
    let commandMatch = /^\/api\/commands\/([0-9a-f-]{36})$/.exec(path);
    let method = commandMatch ? "GET" : apiMethods.get(path);
    if (!method) fail(404, "NOT_FOUND", "找不到 API。");
    if (request.method !== method) {
      response.setHeader("Allow", method);
      fail(405, "METHOD_NOT_ALLOWED", "不支援此 HTTP 方法。");
    }
    if (path === "/api/pair") return pair(request, response);
    let key = sessionKey(request);
    if (!sessions.has(key)) fail(401, "AUTH_REQUIRED", "請先配對，或工作階段已失效。");
    if (commandMatch) return json(response, 200, { ok: true, ...bridge.result(key, commandMatch[1]) });
    if (path === "/api/tabs") {
      json(response, 200, { ok: true, ...bridge.listTabs() });
      return;
    }
    let body = await readJson(request);
    if (path === "/api/logout") {
      validateFields(body, []);
      sessions.delete(key);
      bridge.cancelOwner(key);
      setCookie(response, "", 0);
      json(response, 200, { ok: true });
      return;
    }
    validateControl(body, path, Boolean(config.extensionHash));
    let type = path === "/api/state" ? "get-state" : path === "/api/volume" ? "set-volume" : "set-mute";
    json(response, 202, { ok: true, ...bridge.enqueue(key, type, body) });
  }

  let server = createHttpServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (request, response) => {
    // A client disconnect can emit a later stream error after the body reader has cleaned up.
    request.on("error", () => {});
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    handle(request, response).catch(error => {
      if (response.destroyed || response.writableEnded) return;
      // Never log request bodies, cookies or raw error messages containing client input.
      response.shouldKeepAlive = false;
      request.resume();
      json(response, error.status || 500, {
        ok: false,
        error: { code: error.code && error.status ? error.code : "INTERNAL_ERROR", message: error.status ? error.message : "伺服器發生錯誤。" }
      });
    });
  });
  server.maxHeadersCount = 50;
  server.maxConnections = 32;
  server.setTimeout(10000, socket => socket.destroy());
  server.on("close", () => { sessions.clear(); failures.clear(); bridge.close(); });
  return server;
}

export async function startServer(config = loadConfig()) {
  let server = createServer(config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let config = loadConfig();
    let server = await startServer(config);
    console.log(`TabVolumeRemote：http://${config.host}:${server.address().port}（${config.extensionHash ? "等待擴充功能連線" : "擴充串接未設定"}）`);
    function shutdown() {
      server.close();
      server.closeAllConnections();
    }
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    // Configuration messages are fixed strings, never the secret or a raw environment value.
    console.error(error.syscall ? "伺服器啟動失敗，請檢查指定 IP 與連接埠是否可用。" : error.message);
    process.exitCode = 1;
  }
}
