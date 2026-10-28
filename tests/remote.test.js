import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import vm from "node:vm";
import { readConfig, isPrivateIPv4 } from "../server/config.js";
import { startServer } from "../server/server.js";

let read = name => readFileSync(new URL(`../extension/${name}`, import.meta.url), "utf8");
let extensionId = "a".repeat(32);
let host = Object.values(networkInterfaces()).flat().find(item => item.family === "IPv4" && !item.internal && isPrivateIPv4(item.address))?.address;

async function waitUntil(check) {
  let deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    let result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("等待串接狀態逾時。");
}

async function setup(t, overrides = {}) {
  let phoneToken = randomBytes(32).toString("base64url");
  let extensionToken = randomBytes(32).toString("base64url");
  let config = { ...readConfig({ TVR_HOST: host, TVR_PAIRING_TOKEN: phoneToken, TVR_EXTENSION_TOKEN: extensionToken, TVR_EXTENSION_ID: extensionId, ...overrides }), port: 0 };
  let server = await startServer(config);
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  let origin = `http://${host}:${server.address().port}`;
  let cookie;
  async function http(path, body, headers) {
    let response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function phone(path, body, headers = {}) {
    return http(path, body, { Origin: origin, "X-TVR-Client": "mobile", ...(cookie ? { Cookie: cookie } : {}), ...headers });
  }
  let paired = await phone("/api/pair", { token: phoneToken });
  cookie = paired.headers.get("set-cookie").split(";")[0];
  return { origin, phone, http, extensionToken, phoneToken, config };
}

function createPage(url = "https://www.youtube.com/watch?v=a") {
  let listener;
  let events = new Map();
  let media = [{ volume: 0.8, muted: false }];
  let location = { href: url, origin: new URL(url).origin };
  let document = { title: "影片 A", querySelectorAll: () => media, addEventListener: (type, fn) => events.set(type, fn) };
  vm.runInNewContext(read("sites.js") + read("content.js"), {
    URL,
    chrome: { runtime: { id: extensionId, onMessage: { addListener(fn) { listener = fn; } } } },
    crypto: { randomUUID }, location, document, window: { addEventListener: (type, fn) => events.set(type, fn) }
  });
  return { media, location, document, emit(type) { events.get(type)?.(); },
    send(message) { return new Promise(resolve => listener(message, { id: extensionId }, resolve)); } };
}

function createWorker(settings, pages, storage = { remoteSettings: settings }, transport = fetch, localStorage = {}) {
  let alive = true;
  let timers = new Set();
  let controllers = new Set();
  let events = {};
  let accessLevel = null;
  let alarm = null;
  let event = name => ({ addListener(fn) { (events[name] ??= []).push(fn); } });
  let chrome = {
    runtime: { id: extensionId, getManifest: () => ({ manifest_version: 3 }), getURL: path => `chrome-extension://${extensionId}/${path}`, onMessage: event("message"), onStartup: event("startup"), onInstalled: event("installed") },
    storage: { local: {
      async setAccessLevel(options) { accessLevel = options.accessLevel; },
      async get() { assert.equal(accessLevel, "TRUSTED_CONTEXTS"); return { ...localStorage }; },
      async set(values) { assert.equal(accessLevel, "TRUSTED_CONTEXTS"); Object.assign(localStorage, values); },
      async remove(name) { delete localStorage[name]; }
    }, session: {
      async get() { return { ...storage }; }, async set(values) { Object.assign(storage, values); }, async remove(name) { delete storage[name]; }
    } },
    permissions: { async contains() { return true; } },
    webNavigation: { onHistoryStateUpdated: event("history") },
    alarms: {
      onAlarm: event("alarm"), async get() { return alarm; },
      async create(name, settings) { alarm = { name, ...settings }; }, async clear() { alarm = null; }
    },
    tabs: {
      onUpdated: event("updated"), onRemoved: event("removed"),
      async query() { return [...pages].map(([id, page]) => ({ id, url: page.location.href, title: page.document.title })); },
      async get(id) { if (!pages.has(id)) throw new Error("Closed"); let page = pages.get(id); return { id, url: page.location.href, title: page.document.title, status: "complete" }; },
      async sendMessage(id, message) { if (!pages.has(id)) throw new Error("Closed"); return pages.get(id).send(message); }
    }
  };
  let context = vm.createContext({
    chrome, URL, crypto: { randomUUID }, fetch: transport, Date,
    AbortController: class extends AbortController { constructor() { super(); controllers.add(this); } },
    setTimeout(fn, delay) { if (!alive) return 0; let timer = setTimeout(() => { timers.delete(timer); fn(); }, delay); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); }
  });
  context.importScripts = name => vm.runInContext(read(name), context);
  vm.runInContext(read("background.js"), context);
  return {
    storage, localStorage, events,
    request(message, url = "options.html") {
      return new Promise(resolve => events.message[0](message, { id: extensionId, url: `chrome-extension://${extensionId}/${url}` }, resolve));
    },
    status: () => vm.runInContext("remoteClient.status()", context),
    update(id, changes) { events.updated?.forEach(fn => fn(id, changes)); },
    history(details) { events.history?.forEach(fn => fn(details)); },
    terminate() {
      alive = false;
      for (let controller of controllers) controller.abort();
      for (let timer of timers) clearTimeout(timer);
    }
  };
}

async function command(phone, path, target, values = {}) {
  let body = { extensionSessionId: target.extensionSessionId, tabId: target.tabId, pageId: target.pageId, url: target.url, ...values };
  let submitted = await phone(path, body);
  assert.equal(submitted.status, 202);
  return waitUntil(async () => {
    let result = await phone(`/api/commands/${submitted.body.commandId}`);
    return ["queued", "delivered"].includes(result.body.status) ? null : result.body;
  });
}

test("worker long-polls with no popup and relays real content applied acknowledgements over HTTP", async t => {
  let { origin, phone, extensionToken } = await setup(t);
  let a = createPage();
  let b = createPage();
  let worker = createWorker({ serverUrl: origin, token: extensionToken, clientId: randomUUID() }, new Map([[1, a], [2, b]]));
  t.after(() => worker.terminate());
  let target = await waitUntil(async () => (await phone("/api/tabs")).body.tabs[0]);
  assert.equal(worker.events.message.length, 1); // Registered, but no popup messages have been sent.
  let state = await command(phone, "/api/state", target);
  assert.equal(state.status, "applied");
  let result = await command(phone, "/api/volume", target, { volume: 37 });
  assert.equal(result.status, "applied");
  assert.equal(result.result.applied, true);
  assert.equal(a.media[0].volume, 0.37);
  assert.equal(b.media[0].volume, 0.8);
  result = await command(phone, "/api/mute", target, { muted: true });
  assert.equal(result.status, "applied");
  assert.equal(a.media[0].muted, true);
  assert.equal(a.media[0].volume, 0.37);
  result = await command(phone, "/api/mute", target, { muted: false });
  assert.equal(result.status, "applied");
  assert.equal(a.media[0].muted, false);
  assert.equal(a.media[0].volume, 0.37);
  assert.equal(worker.status().connected, true);
  assert.equal(JSON.stringify(worker.status()).includes(extensionToken), false);
});

test("worker recreation uses migrated persistent storage but revokes the previous routing session", async t => {
  let { origin, phone, extensionToken } = await setup(t);
  let pages = new Map([[1, createPage()]]);
  let settings = { serverUrl: origin, token: extensionToken, clientId: randomUUID() };
  let first = createWorker(settings, pages);
  t.after(() => first.terminate());
  let oldTarget = await waitUntil(async () => (await phone("/api/tabs")).body.tabs[0]);
  first.terminate();
  assert.equal(first.storage.remoteSettings, undefined);
  assert.equal(first.localStorage.remoteSettings.token, extensionToken);
  let second = createWorker(null, pages, {}, fetch, first.localStorage);
  t.after(() => second.terminate());
  let target = await waitUntil(async () => {
    let tab = (await phone("/api/tabs")).body.tabs[0];
    return tab && tab.extensionSessionId !== oldTarget.extensionSessionId ? tab : null;
  });
  let stale = await phone("/api/volume", { extensionSessionId: oldTarget.extensionSessionId, tabId: 1, pageId: oldTarget.pageId, url: oldTarget.url, volume: 20 });
  assert.equal(stale.status, 409);
  assert.equal((await command(phone, "/api/volume", target, { volume: 65 })).status, "applied");
});

test("Options tests do not rotate sessions, saved tokens stay private and disconnect survives restart", async t => {
  let { origin, phone, extensionToken } = await setup(t);
  let worker = createWorker({ serverUrl: origin, token: extensionToken, clientId: randomUUID() }, new Map([[1, createPage()]]));
  t.after(() => worker.terminate());
  let target = await waitUntil(async () => (await phone("/api/tabs")).body.tabs[0]);
  let info = await worker.request({ type: "connection-settings" });
  assert.equal(info.hasToken, true);
  assert.equal(JSON.stringify(info).includes(extensionToken), false);
  let tested = await worker.request({ type: "test-server", settings: { serverUrl: origin, token: "" } });
  assert.equal(tested.ok, true);
  assert.equal((await phone("/api/tabs")).body.tabs[0].extensionSessionId, target.extensionSessionId);
  let wrong = await worker.request({ type: "test-server", settings: { serverUrl: origin, token: "z".repeat(43) } });
  assert.equal(wrong.ok, false);
  assert.equal(worker.localStorage.remoteSettings.token, extensionToken);
  assert.equal((await worker.request({ type: "set-volume", tabId: 1 }, "options.html")).ok, false);
  assert.equal((await worker.request({ type: "connection-settings" }, "popup.html")).ok, false);
  assert.equal((await worker.request({ type: "disconnect-server" })).ok, true);
  assert.equal(worker.localStorage.remoteSettings.enabled, false);
  assert.equal(worker.localStorage.remoteSettings.token, extensionToken);
  worker.terminate();
  let next = createWorker(null, new Map([[1, createPage()]]), {}, fetch, worker.localStorage);
  t.after(() => next.terminate());
  await waitUntil(() => /設定仍保留/.test(next.status().message));
  assert.equal((await phone("/api/tabs")).body.extensionConnected, false);
  assert.equal((await next.request({ type: "connect-server", settings: { serverUrl: origin, token: "" } })).ok, true);
  await waitUntil(async () => (await phone("/api/tabs")).body.extensionConnected);
  assert.equal((await next.request({ type: "forget-server" })).ok, true);
  assert.equal(next.localStorage.remoteSettings, undefined);
});

test("failed persistent migration keeps the original session credential", async t => {
  let settings = { serverUrl: "http://192.168.1.10:3210", token: randomBytes(32).toString("base64url"), clientId: randomUUID() };
  let local = {};
  Object.defineProperty(local, "remoteSettings", { set() { throw new Error("Storage failure"); } });
  let worker = createWorker(settings, new Map(), { remoteSettings: settings }, fetch, local);
  t.after(() => worker.terminate());
  await waitUntil(() => /遷移/.test(worker.status().message));
  assert.equal(worker.storage.remoteSettings.token, settings.token);
  assert.equal(worker.status().connected, false);
});

test("failure to restrict local storage blocks all credential reads, writes and migration", async () => {
  let reads = 0;
  let writes = 0;
  let chrome = {
    runtime: { id: extensionId, getManifest: () => ({ manifest_version: 3 }) },
    storage: { local: {
      async setAccessLevel() { throw new Error("Access restriction unavailable"); },
      async get() { reads += 1; }, async set() { writes += 1; }, async remove() {}
    } },
    alarms: { async get() {}, async create() {}, async clear() {}, onAlarm: { addListener() {} } }
  };
  let context = vm.createContext({ chrome, URL });
  vm.runInContext(read("server-client.js"), context);
  let client = context.createServerClient({ execute() {}, listTabs() {} });
  await client.restore();
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(client.status().connected, false);
  assert.match(client.status().message, /無法安全讀取/);
});

test("a pending restore cannot reconnect after the user disconnects", async () => {
  let stored = { remoteSettings: { serverUrl: "http://192.168.1.10:3210", token: randomBytes(32).toString("base64url"), clientId: randomUUID(), enabled: true } };
  let release;
  let requests = 0;
  let chrome = {
    runtime: { id: extensionId, getManifest: () => ({ manifest_version: 3 }) },
    storage: { local: { async setAccessLevel() {}, async get() { return { ...stored }; }, async set(value) { Object.assign(stored, value); }, async remove() {} } },
    permissions: { contains: () => new Promise(resolve => { release = resolve; }) },
    alarms: { async get() {}, async create() {}, async clear() {}, onAlarm: { addListener() {} } }
  };
  let context = vm.createContext({ chrome, URL, AbortController, setTimeout, clearTimeout, fetch: async () => {
    requests += 1;
    return { ok: false, status: 401, async json() { return { error: { message: "Test authentication failure" } }; } };
  } });
  vm.runInContext(read("server-client.js"), context);
  let client = context.createServerClient({ execute() {}, listTabs() {} });
  let pending = client.restore();
  await waitUntil(() => release);
  await client.disconnect();
  release(true);
  await pending;
  assert.equal(requests, 0);
  assert.equal(stored.remoteSettings.enabled, false);
  assert.equal(client.status().connected, false);
});

test("multiple allowed IDs require the matching Origin and cannot share an extension session", async t => {
  let edgeId = "b".repeat(32);
  let { http, extensionToken } = await setup(t, { TVR_EXTENSION_ID: "", TVR_EXTENSION_IDS: `${extensionId},${edgeId}` });
  let headers = { "X-TVR-Client": "extension", "X-TVR-Extension-Id": extensionId, Origin: `chrome-extension://${extensionId}`, Authorization: `Bearer ${extensionToken}` };
  let edge = { ...headers, "X-TVR-Extension-Id": edgeId, Origin: `chrome-extension://${edgeId}` };
  let registered = await http("/api/extension/register", { clientId: "same-client" }, headers);
  assert.equal(registered.status, 200);
  assert.equal((await http("/api/extension/check", {}, edge)).status, 200);
  assert.equal((await http("/api/extension/check", {}, { ...edge, Origin: headers.Origin })).status, 403);
  assert.equal((await http("/api/extension/check", {}, { ...edge, "X-TVR-Extension-Id": "c".repeat(32) })).status, 403);
  assert.equal((await http("/api/extension/register", { clientId: "same-client" }, edge)).status, 409);
  assert.equal((await http("/api/extension/tabs", { tabs: [] }, { ...edge, "X-TVR-Extension-Session": registered.body.extensionSessionId })).status, 409);
  assert.equal((await http("/api/extension/tabs", { tabs: [] }, { ...headers, "X-TVR-Extension-Session": registered.body.extensionSessionId })).status, 200);
});

test("HTTP controls route Twitch and Hami media, preserve mute volume and reject old SPA identities", async t => {
  let { origin, phone, extensionToken } = await setup(t);
  let twitch = createPage("https://www.twitch.tv/channel-a");
  let hami = createPage("https://hamivideo.hinet.net/channel/a.do");
  let youtube = createPage();
  let worker = createWorker({ serverUrl: origin, token: extensionToken, clientId: randomUUID() }, new Map([[1, twitch], [2, hami], [3, youtube]]));
  t.after(() => worker.terminate());
  let targets = await waitUntil(async () => {
    let tabs = (await phone("/api/tabs")).body.tabs;
    return tabs.length === 3 ? tabs : null;
  });
  for (let target of targets.filter(tab => tab.tabId !== 3)) {
    let page = target.tabId === 1 ? twitch : hami;
    assert.equal((await command(phone, "/api/volume", target, { volume: 37 })).result.applied, true);
    assert.equal((await command(phone, "/api/mute", target, { muted: true })).result.muted, true);
    assert.equal((await command(phone, "/api/mute", target, { muted: false })).result.muted, false);
    assert.equal(page.media[0].volume, 0.37);
    assert.equal(youtube.media[0].volume, 0.8);
    worker.history({ tabId: target.tabId, frameId: 0, url: page.location.href });
    let fresh = await waitUntil(async () => {
      let tab = (await phone("/api/tabs")).body.tabs.find(tab => tab.tabId === target.tabId);
      return tab && tab.pageId !== target.pageId ? tab : null;
    });
    assert.equal((await phone("/api/volume", { extensionSessionId: target.extensionSessionId, tabId: target.tabId, pageId: target.pageId, url: target.url, volume: 10 })).status, 409);
    assert.equal((await command(phone, "/api/volume", fresh, { volume: 65 })).status, "applied");
  }
});

test("a delayed same-URL SPA revocation triggers a fresh snapshot after content confirms it", async t => {
  let { origin, phone, extensionToken } = await setup(t);
  let page = createPage("https://www.twitch.tv/channel-a");
  let send = page.send;
  let release;
  page.send = message => message.type === "invalidate-page"
    ? new Promise(resolve => { release = async () => resolve(await send(message)); })
    : send(message);
  let worker = createWorker({ serverUrl: origin, token: extensionToken, clientId: randomUUID() }, new Map([[1, page]]));
  t.after(() => worker.terminate());
  let old = await waitUntil(async () => (await phone("/api/tabs")).body.tabs[0]);
  worker.history({ tabId: 1, frameId: 0, url: page.location.href });
  await waitUntil(() => release);
  // Allow the first collection to observe the old identity while revocation is still in flight.
  await new Promise(resolve => setTimeout(resolve, 50));
  await release();
  let fresh = await waitUntil(async () => {
    let tab = (await phone("/api/tabs")).body.tabs[0];
    return tab && tab.pageId !== old.pageId ? tab : null;
  });
  assert.equal((await command(phone, "/api/volume", fresh, { volume: 37 })).status, "applied");
});

test("alarm events restore stored settings without a popup and report the configured period", async t => {
  let { origin, phone, extensionToken } = await setup(t);
  let storage = {};
  let worker = createWorker(null, new Map([[1, createPage()]]), storage);
  t.after(() => worker.terminate());
  assert.equal(worker.status().connected, false);
  storage.remoteSettings = { serverUrl: origin, token: extensionToken, clientId: randomUUID() };
  await Promise.all(worker.events.alarm.map(handler => handler({ name: "remote-reconnect" })));
  let target = await waitUntil(async () => (await phone("/api/tabs")).body.tabs[0]);
  assert.equal(worker.status().compatibility.alarmPeriodMinutes, 0.5);
  assert.equal((await command(phone, "/api/volume", target, { volume: 25 })).status, "applied");
});

test("remote HTTP routes validate target fields and revoke pending controls on phone re-pairing", async t => {
  let { http, phone, extensionToken, phoneToken } = await setup(t);
  let headers = { "X-TVR-Client": "extension", "X-TVR-Extension-Id": extensionId, Authorization: `Bearer ${extensionToken}` };
  let registered = await http("/api/extension/register", { clientId: "test" }, headers);
  headers["X-TVR-Extension-Session"] = registered.body.extensionSessionId;
  let page = { tabId: 1, pageId: "page-a", url: "https://www.youtube.com/watch?v=a", title: "影片 A",
    volume: 80, muted: false, browserMuted: false, mixed: false, mixedMuted: false, mediaCount: 1 };
  assert.equal((await http("/api/extension/tabs", { tabs: [page] }, headers)).status, 200);
  let target = { extensionSessionId: registered.body.extensionSessionId, tabId: 1, pageId: page.pageId, url: page.url };
  for (let difference of [{ pageId: "" }, { url: "https://example.com" }, { extensionSessionId: 123 }, { volume: 101 }, { tabId: -1 }]) {
    assert.equal((await phone("/api/volume", { ...target, volume: 37, ...difference })).status, 400);
  }
  assert.equal((await phone("/api/state", { ...target, tabId: 999 })).status, 404);
  let queued = await phone("/api/volume", { ...target, volume: 37 });
  assert.equal(queued.status, 202);
  let paired = await phone("/api/pair", { token: phoneToken });
  assert.equal(paired.status, 200);
  assert.equal((await phone(`/api/commands/${queued.body.commandId}`)).status, 401);
  assert.equal((await http("/api/extension/commands", undefined, headers)).body.command, null);
});

test("lost result responses retry only the acknowledgement, never the media command", async t => {
  let { origin, phone, extensionToken } = await setup(t);
  let page = createPage();
  let volume = 0.8;
  let applications = 0;
  Object.defineProperty(page.media[0], "volume", { get: () => volume, set(value) { volume = value; applications += 1; } });
  let reports = 0;
  let settings = { serverUrl: origin, token: extensionToken, clientId: randomUUID() };
  let worker = createWorker(settings, new Map([[1, page]]), { remoteSettings: settings }, async (url, options) => {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    let result = await fetch(url, options);
    if (url.endsWith("/results")) {
      reports += 1;
      if (reports === 1) { await result.text(); throw new TypeError("Simulated lost acknowledgement response"); }
    }
    return result;
  });
  t.after(() => worker.terminate());
  let target = await waitUntil(async () => (await phone("/api/tabs")).body.tabs[0]);
  assert.equal((await command(phone, "/api/volume", target, { volume: 37 })).status, "applied");
  await waitUntil(() => reports >= 2);
  assert.equal(applications, 1);
});

test("network polling failure reconnects with a new session and resumes without replaying", async t => {
  let { origin, phone, extensionToken } = await setup(t);
  let registrations = 0;
  let failed = false;
  let settings = { serverUrl: origin, token: extensionToken, clientId: randomUUID() };
  let worker = createWorker(settings, new Map([[1, createPage()]]), { remoteSettings: settings }, async (url, options) => {
    if (url.endsWith("/register")) registrations += 1;
    if (url.endsWith("/commands") && !failed) { failed = true; throw new TypeError("Simulated network failure"); }
    return fetch(url, options);
  });
  t.after(() => worker.terminate());
  let target = await waitUntil(async () => registrations >= 2 && (await phone("/api/tabs")).body.tabs[0]);
  assert.equal((await command(phone, "/api/volume", target, { volume: 42 })).status, "applied");
});

test("SPA URL events re-synchronize the worker and old phone targets are rejected", async t => {
  let { origin, phone, extensionToken } = await setup(t);
  let page = createPage();
  let worker = createWorker({ serverUrl: origin, token: extensionToken, clientId: randomUUID() }, new Map([[1, page]]));
  t.after(() => worker.terminate());
  let old = await waitUntil(async () => (await phone("/api/tabs")).body.tabs[0]);
  page.emit("yt-navigate-start");
  page.location.href = "https://www.youtube.com/watch?v=b";
  page.document.title = "影片 B";
  page.emit("yt-navigate-finish");
  worker.update(1, { url: page.location.href });
  let fresh = await waitUntil(async () => {
    let tab = (await phone("/api/tabs")).body.tabs[0];
    return tab?.url === page.location.href && tab.pageId !== old.pageId ? tab : null;
  });
  assert.equal((await phone("/api/volume", { extensionSessionId: old.extensionSessionId, tabId: 1, pageId: old.pageId, url: old.url, volume: 10 })).status, 409);
  assert.equal(page.media[0].volume, 0.8);
  assert.equal((await command(phone, "/api/volume", fresh, { volume: 37 })).status, "applied");
});

test("YouTube SPA A-to-B-to-A navigation revokes old page identity without document reload", async () => {
  let page = createPage();
  let old = await page.send({ type: "get-state", url: page.location.href, expiresAt: Date.now() + 4000 });
  page.emit("yt-navigate-start");
  assert.equal((await page.send({ type: "get-state", url: page.location.href, expiresAt: Date.now() + 4000 })).ok, false);
  page.location.href = "https://www.youtube.com/watch?v=b";
  page.emit("yt-navigate-finish");
  page.emit("yt-navigate-start");
  page.location.href = old.url;
  page.emit("yt-navigate-finish");
  let stale = await page.send({ type: "set-volume", url: old.url, pageId: old.pageId, volume: 10, expiresAt: Date.now() + 4000 });
  assert.equal(stale.ok, false);
  assert.equal(page.media[0].volume, 0.8);
  let fresh = await page.send({ type: "get-state", url: old.url, expiresAt: Date.now() + 4000 });
  assert.notEqual(fresh.pageId, old.pageId);
});

test("extension auth stays separate from phone cookies, with exact ID and Origin checks", async t => {
  let { http, phone, phoneToken, extensionToken, config } = await setup(t);
  let headers = { "X-TVR-Client": "extension", "X-TVR-Extension-Id": extensionId, Authorization: `Bearer ${extensionToken}` };
  assert.equal((await http("/api/extension/register", { clientId: "test" }, { ...headers, Authorization: `Bearer ${phoneToken}` })).status, 401);
  assert.equal((await http("/api/extension/register", { clientId: "test" }, { ...headers, Origin: "http://evil.example" })).status, 403);
  assert.equal((await http("/api/extension/register", { clientId: "test" }, { ...headers, "X-TVR-Extension-Id": "b".repeat(32) })).status, 403);
  assert.equal((await phone("/api/extension/register", { clientId: "test" })).status, 403);
  let registered = await http("/api/extension/register", { clientId: "test" }, { ...headers, Origin: `chrome-extension://${extensionId}` });
  assert.equal(registered.status, 200);
  assert.equal(registered.headers.get("access-control-allow-origin"), null);
  assert.throws(() => readConfig({ TVR_HOST: config.host, TVR_PAIRING_TOKEN: phoneToken, TVR_EXTENSION_TOKEN: phoneToken, TVR_EXTENSION_ID: extensionId }));
});

test("private Server URL validation rejects public hosts, embedded secrets and redirects", () => {
  let context = vm.createContext({ URL });
  vm.runInContext(read("server-client.js"), context);
  for (let url of ["http://8.8.8.8:3210", "http://localhost:3210", "https://192.168.1.2", "http://secret@192.168.1.2", "http://192.168.1.2/?token=secret", "http://192.168.1.2/path"]) {
    assert.throws(() => context.privateServerOrigin(url));
  }
  assert.equal(context.privateServerOrigin("http://192.168.1.2:3210/"), "http://192.168.1.2:3210");
});

test("missing Samsung extension APIs produce a clear diagnostic instead of breaking local control", async () => {
  for (let missing of ["storage", "alarms"]) {
    let chrome = {
      runtime: { id: extensionId, getManifest: () => ({ manifest_version: 3 }) },
      storage: { session: { async get() { return {}; }, async set() {}, async remove() {} } },
      alarms: { async get() {}, async create() {}, onAlarm: {} }
    };
    delete chrome[missing];
    let context = vm.createContext({ chrome, URL });
    vm.runInContext(read("server-client.js"), context);
    let client = context.createServerClient({ execute() {}, listTabs() {} });
    await client.restore();
    assert.equal(client.status().connected, false);
    assert.match(client.status().message, /本機 popup 音量控制仍可使用/);
    await assert.rejects(client.connect({}), /缺少遠端連線所需 API/);
  }
});
