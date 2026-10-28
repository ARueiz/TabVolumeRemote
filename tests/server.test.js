import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { readConfig, isPrivateIPv4 } from "../server/config.js";
import { createServer, startServer } from "../server/server.js";

let host = Object.values(networkInterfaces()).flat().find(item => item.family === "IPv4" && !item.internal && isPrivateIPv4(item.address))?.address;
let token = randomBytes(32).toString("base64url");
let env = { TVR_HOST: host, TVR_PAIRING_TOKEN: token };

async function fixture(t) {
  assert.ok(host, "HTTP 整合測試需要本機已配置的 RFC1918 IPv4 介面。");
  let config = readConfig(env);
  // Port zero is only passed programmatically by tests, never accepted from TVR_PORT.
  config.port = 0;
  let time = Date.now();
  let server = createServer(config, () => time);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, config.host, resolve);
  });
  t.after(async () => {
    if (!server.listening) return;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  let port = server.address().port;
  let origin = `http://${host}:${port}`;
  function request(path, { method = "GET", body, headers = {}, source = true, chunks } = {}) {
    let payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    let requestHeaders = { ...(source ? { Origin: origin, "X-TVR-Client": "mobile" } : {}), ...headers };
    if (payload !== undefined || chunks) requestHeaders["Content-Type"] ??= "application/json";
    return new Promise((resolve, reject) => {
      let req = httpRequest({ host, port, path, method, headers: requestHeaders, agent: false }, res => {
        let data = [];
        res.on("data", chunk => data.push(chunk));
        res.on("end", () => {
          let text = Buffer.concat(data).toString("utf8");
          let json;
          if (res.headers["content-type"]?.includes("application/json") && text) json = JSON.parse(text);
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      if (chunks) for (let chunk of chunks) req.write(chunk);
      req.end(payload);
    });
  }
  async function pair() {
    let response = await request("/api/pair", { method: "POST", body: { token } });
    assert.equal(response.status, 200);
    return response.headers["set-cookie"][0].split(";")[0];
  }
  return { server, config, origin, request, pair, advance(seconds) { time += seconds * 1000; } };
}

test("configuration requires an assigned private IPv4 and valid security settings", () => {
  let interfaces = { ethernet: [{ family: "IPv4", address: "192.168.1.10", internal: false }] };
  let base = { TVR_HOST: "192.168.1.10", TVR_PAIRING_TOKEN: token };
  let config = readConfig(base, interfaces);
  assert.equal(config.port, 3210);
  assert.equal(config.sessionSeconds, 28800);
  assert.equal(Object.hasOwn(config, "pairingToken"), false);
  for (let address of [undefined, "", "0.0.0.0", "::", "::1", "127.0.0.1", "8.8.8.8", "localhost", "169.254.1.1", "192.168.1.11"]) {
    assert.throws(() => readConfig({ ...base, TVR_HOST: address }, interfaces));
  }
  for (let address of ["10.2.3.4", "172.16.1.2", "172.31.1.2", "192.168.1.2"]) assert.equal(isPrivateIPv4(address), true);
  for (let address of ["172.15.1.2", "172.32.1.2", "192.169.1.2", "10.0.0.999"]) assert.equal(isPrivateIPv4(address), false);
  for (let [name, value] of [["TVR_PORT", "0"], ["TVR_PORT", "65536"], ["TVR_PORT", "3.5"], ["TVR_PORT", ""], ["TVR_PAIRING_TOKEN", "short"], ["TVR_SESSION_SECONDS", "-1"], ["TVR_PAIR_MAX_FAILURES", "0"], ["TVR_PAIR_WINDOW_SECONDS", "0"]]) {
    assert.throws(() => readConfig({ ...base, [name]: value }, interfaces));
  }
});

test("server starts on the specified interface and closes cleanly", async () => {
  let config = { ...readConfig(env), port: 0 };
  let server = await startServer(config);
  try {
    assert.equal(server.listening, true);
    assert.equal(server.address().address, host);
    assert.equal(server.address().family, "IPv4");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(server.listening, false);
});

test("an occupied port rejects startup rather than falling back to another address", async t => {
  let { server, config } = await fixture(t);
  await assert.rejects(startServer({ ...config, port: server.address().port }), { code: "EADDRINUSE" });
});

test("protected APIs reject missing, forged and duplicate session cookies", async t => {
  let { request } = await fixture(t);
  for (let path of ["/api/tabs", "/api/volume", "/api/mute", "/api/logout"]) {
    let response = await request(path, { method: path === "/api/tabs" ? "GET" : "POST", body: path === "/api/tabs" ? undefined : {} });
    assert.equal(response.status, 401);
    assert.equal(response.json.ok, false);
  }
  let cookie = `tvr_session=${randomBytes(32).toString("base64url")}`;
  assert.equal((await request("/api/tabs", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request("/api/tabs", { headers: { Cookie: `${cookie}; ${cookie}` } })).status, 401);
});

test("pairing issues a scoped HttpOnly session and never reports a connected browser", async t => {
  let { request } = await fixture(t);
  let wrong = await request("/api/pair", { method: "POST", body: { token: randomBytes(32).toString("base64url") } });
  assert.equal(wrong.status, 401);
  let paired = await request("/api/pair", { method: "POST", body: { token } });
  assert.equal(paired.status, 200);
  let cookie = paired.headers["set-cookie"][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/api/);
  assert.match(cookie, /Max-Age=28800/);
  assert.equal(paired.text.includes(token), false);
  let result = await request("/api/tabs", { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.tabs, []);
  assert.equal(result.json.extensionConnected, false);
  assert.equal(result.json.message, "尚未連接瀏覽器");
  assert.equal(result.headers["access-control-allow-origin"], undefined);
});

test("origin, request marker, Fetch Metadata and Host are checked independently of credentials", async t => {
  let { request, pair, origin } = await fixture(t);
  let cookie = await pair();
  for (let badOrigin of ["http://evil.example", "null", origin + "/", origin.replace("http:", "https:")]) {
    assert.equal((await request("/api/tabs", { headers: { Cookie: cookie, Origin: badOrigin } })).status, 403);
    assert.equal((await request("/api/pair", { method: "POST", body: { token }, headers: { Origin: badOrigin } })).status, 403);
  }
  assert.equal((await request("/api/tabs", { source: false, headers: { Cookie: cookie, Origin: origin } })).status, 403);
  assert.equal((await request("/api/tabs", { headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await request("/", { headers: { Host: "evil.example" } })).status, 403);
  assert.equal((await request("/api/tabs", { source: false, headers: { Cookie: cookie, "X-TVR-Client": "mobile" } })).status, 403);
  let headers = { Cookie: cookie, "X-TVR-Client": "mobile", Referer: origin + "/" };
  assert.equal((await request("/api/tabs", { source: false, headers })).status, 200);
  assert.equal((await request("/api/logout", { method: "POST", body: {}, source: false, headers })).status, 403);
  assert.equal((await request("/api/tabs", { source: false, headers: { ...headers, Referer: "http://evil.example/" } })).status, 403);
  assert.equal((await request("/api/volume", { method: "OPTIONS", headers: { Origin: "http://evil.example" } })).status, 403);
});

test("JSON parsing rejects malformed, non-object, oversized and compressed bodies", async t => {
  let { request, pair } = await fixture(t);
  let headers = { Cookie: await pair() };
  for (let body of ["{", "", "null", "[]", '"text"', "3"]) {
    assert.equal((await request("/api/volume", { method: "POST", body, headers })).status, 400);
  }
  assert.equal((await request("/api/volume", { method: "POST", body: "{}", headers: { ...headers, "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await request("/api/volume", { method: "POST", body: "{}", headers: { ...headers, "Content-Encoding": "gzip" } })).status, 415);
  let large = JSON.stringify({ value: "x".repeat(5000) });
  assert.equal((await request("/api/volume", { method: "POST", body: large, headers: { ...headers, "Content-Length": Buffer.byteLength(large) } })).status, 413);
  assert.equal((await request("/api/volume", { method: "POST", chunks: [large.slice(0, 3000), large.slice(3000)], headers })).status, 413);
  assert.equal((await request("/api/volume", { method: "POST", chunks: [Buffer.from([0xff])], headers })).status, 400);
});

test("volume and tab IDs are strictly validated before disconnected-browser failures", async t => {
  let { request, pair } = await fixture(t);
  let headers = { Cookie: await pair() };
  let command = body => request("/api/volume", { method: "POST", body, headers });
  for (let volume of [-1, 101, 1.5, "50", null]) {
    let response = await command({ tabId: 1, volume });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "INVALID_VOLUME");
  }
  for (let tabId of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    let response = await command({ tabId, volume: 50 });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "INVALID_TAB_ID");
  }
  for (let body of [{}, { tabId: 1 }, { tabId: 1, volume: 50, script: "evil" }]) assert.equal((await command(body)).status, 400);
  for (let volume of [0, 50, 100]) {
    let response = await command({ tabId: 123456, volume });
    assert.equal(response.status, 503);
    assert.equal(response.json.error.code, "BROWSER_DISCONNECTED");
    assert.equal(response.json.ok, false);
  }
});

test("mute accepts only booleans and never pretends to execute a valid command", async t => {
  let { request, pair } = await fixture(t);
  let headers = { Cookie: await pair() };
  for (let muted of ["true", 1, 0, null]) assert.equal((await request("/api/mute", { method: "POST", body: { tabId: 1, muted }, headers })).status, 400);
  for (let muted of [true, false]) {
    let response = await request("/api/mute", { method: "POST", body: { tabId: 1, muted }, headers });
    assert.equal(response.status, 503);
    assert.equal(response.json.error.code, "BROWSER_DISCONNECTED");
  }
});

test("pair failure limits include malformed requests and expire after the fixed window", async t => {
  let { request, advance, config } = await fixture(t);
  for (let index = 0; index < config.pairMaxFailures; index += 1) {
    let response = await request("/api/pair", { method: "POST", body: index === 0 ? "{" : { token: "wrong" } });
    assert.equal(response.status, index === 0 ? 400 : 401);
  }
  let blocked = await request("/api/pair", { method: "POST", body: { token } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers["retry-after"], String(config.pairWindowSeconds));
  advance(config.pairWindowSeconds);
  assert.equal((await request("/api/pair", { method: "POST", body: { token } })).status, 200);
});

test("concurrent pairing requests cannot bypass the failure limit", async t => {
  let { request, config } = await fixture(t);
  let responses = await Promise.all(Array.from({ length: 10 }, () => request("/api/pair", { method: "POST", body: { token: "wrong" } })));
  assert.equal(responses.filter(result => result.status === 401).length, config.pairMaxFailures);
  assert.equal(responses.filter(result => result.status === 429).length, 10 - config.pairMaxFailures);
});

test("logout, expiration and a new server invalidate the old session", async t => {
  let { request, pair, advance, config } = await fixture(t);
  let cookie = await pair();
  let logout = await request("/api/logout", { method: "POST", body: {}, headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers["set-cookie"][0], /Max-Age=0/);
  assert.equal((await request("/api/tabs", { headers: { Cookie: cookie } })).status, 401);
  cookie = await pair();
  advance(config.sessionSeconds);
  assert.equal((await request("/api/tabs", { headers: { Cookie: cookie } })).status, 401);
  cookie = await pair();
  let restarted = await fixture(t);
  assert.equal((await restarted.request("/api/tabs", { headers: { Cookie: cookie } })).status, 401);
});

test("session capacity is bounded and an existing session can be rotated without growing it", async t => {
  let { request, pair } = await fixture(t);
  let cookie = await pair();
  for (let index = 1; index < 64; index += 1) await pair();
  let full = await request("/api/pair", { method: "POST", body: { token } });
  assert.equal(full.status, 503);
  assert.equal(full.json.error.code, "SESSION_LIMIT");
  let rotated = await request("/api/pair", { method: "POST", body: { token }, headers: { Cookie: cookie } });
  assert.equal(rotated.status, 200);
  assert.equal((await request("/api/tabs", { headers: { Cookie: cookie } })).status, 401);
  let newCookie = rotated.headers["set-cookie"][0].split(";")[0];
  assert.equal((await request("/api/tabs", { headers: { Cookie: newCookie } })).status, 200);
});

test("static allowlist denies traversal, source files, secrets and query-string tokens", async t => {
  let { request } = await fixture(t);
  for (let path of ["/", "/index.html", "/style.css", "/app.js"]) {
    let response = await request(path, { source: false });
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
  }
  for (let path of ["/../AGENTS.md", "/%2e%2e/AGENTS.md", "/..%5cAGENTS.md", "/%2f..%2fAGENTS.md", "/server.js", "/config.js", "/package.json", "/.env", "/README.md", "/C:/Windows/win.ini", "/app.js/../server.js", "/%00"]) {
    assert.equal((await request(path)).status, 404);
  }
  assert.equal((await request("/%ZZ")).status, 400);
  assert.equal((await request("/?token=must-not-be-accepted")).status, 400);
  assert.equal((await request("/api/tabs?token=must-not-be-accepted")).status, 400);
  let head = await request("/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
});

test("unknown APIs return 404 and known routes reject unsupported methods", async t => {
  let { request, pair } = await fixture(t);
  let headers = { Cookie: await pair() };
  for (let path of ["/api/unknown", "/api/extension/register", "/api/extension/commands"]) assert.equal((await request(path, { headers })).status, 404);
  let response = await request("/api/tabs", { method: "POST", body: {}, headers });
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "GET");
});
