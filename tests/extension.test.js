import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import sitePolicy from "../extension/sites.js";
import { validPage } from "../server/bridge.js";

let read = name => readFileSync(new URL(`../extension/${name}`, import.meta.url), "utf8");
let copy = value => JSON.parse(JSON.stringify(value));
let extensionId = "test-extension";
let popupUrl = `chrome-extension://${extensionId}/popup.html`;
let pageUrl = "https://www.youtube.com/watch?v=example";
let internalSender = { id: extensionId };
let popupSender = { id: extensionId, url: popupUrl };
let settle = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

function createClock() {
  let now = 0;
  let nextId = 0;
  let tasks = new Map();
  return {
    performance: { now: () => now },
    setTimeout(callback, delay) {
      let id = ++nextId;
      tasks.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    async tick(duration) {
      let end = now + duration;
      await settle();
      while (true) {
        let next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        tasks.delete(next[0]);
        next[1].callback();
        await settle();
      }
      now = end;
      await settle();
    }
  };
}

function createPage(media = [{ volume: 0.8, muted: false }], url = pageUrl) {
  let listener;
  let location = { href: url, origin: new URL(url).origin };
  let document = { title: "目前影片", querySelectorAll: () => media, addEventListener() {} };
  vm.runInNewContext(read("sites.js") + read("content.js"), {
    URL,
    chrome: { runtime: { id: extensionId, onMessage: { addListener(fn) { listener = fn; } } } },
    document, window: { addEventListener() {} }, location, crypto: { randomUUID }
  });
  return {
    media, location, document,
    send(message, sender = internalSender) {
      let result;
      listener({ url: location.href, expiresAt: Date.now() + 4000, ...message }, sender, value => { result = copy(value); });
      return result;
    }
  };
}

function createBackground(tabs, pages, clock = createClock()) {
  let listener;
  let deliveries = [];
  let historyListeners = [];
  let context = vm.createContext({
    URL, ...clock,
    chrome: {
      runtime: { id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener(fn) { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
      storage: { session: { async get() { return {}; } } },
      alarms: { onAlarm: { addListener() {} } },
      webNavigation: { onHistoryStateUpdated: { addListener(fn) { historyListeners.push(fn); } } },
      tabs: {
        onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
        async query() { return [...tabs.values()]; },
        async get(id) { if (!tabs.has(id)) throw new Error("No tab"); return tabs.get(id); },
        async sendMessage(id, message, options) {
          deliveries.push({ id, message, options });
          if (!pages.has(id)) throw new Error("No receiver");
          return pages.get(id).send(message);
        }
      }
    }
  });
  context.importScripts = name => vm.runInContext(read(name), context);
  vm.runInContext(read("background.js"), context);
  return {
    deliveries, clock,
    history(details) { historyListeners.forEach(fn => fn(details)); },
    request(message, sender = popupSender) {
      return new Promise(resolve => listener(message, sender, result => resolve(copy(result))));
    }
  };
}

function setup() {
  let a = createPage();
  let b = createPage();
  let tabs = new Map([1, 2].map(id => [id, { id, title: `Video ${id}`, url: pageUrl, status: "complete" }]));
  let pages = new Map([[1, a], [2, b]]);
  return { a, b, tabs, pages, background: createBackground(tabs, pages) };
}

test("manifest restricts website access and all referenced files exist", () => {
  let manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, sitePolicy.matches);
  assert.deepEqual(manifest.permissions, ["storage", "alarms", "webNavigation"]);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*"]);
  assert.equal(manifest.minimum_chrome_version, "120");
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.deepEqual(manifest.options_ui, { page: "options.html", open_in_tab: true });
  for (let file of [manifest.options_ui.page, manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts[0].js]) {
    assert.ok(read(file).length);
  }
});

test("discovery excludes unsupported pages and keeps separate tab IDs", async () => {
  let { background, tabs } = setup();
  tabs.set(3, { id: 3, url: "chrome://settings" });
  tabs.set(4, { id: 4, url: "https://www.youtube.com.evil.example/" });
  tabs.set(5, { id: 5 });
  let result = await background.request({ type: "list-tabs" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tabs.map(tab => tab.id), [1, 2]);
});

test("site policy is exact and is shared by the extension, manifest and server validation", () => {
  assert.deepEqual(sitePolicy.matches, ["https://www.youtube.com/*", "https://www.twitch.tv/*", "https://hamivideo.hinet.net/*"]);
  for (let pattern of sitePolicy.matches) {
    let url = pattern.replace("*", "watch");
    assert.equal(sitePolicy.isSupportedUrl(url), true);
    assert.equal(validPage({ tabId: 1, pageId: "page", url }), true);
  }
  for (let url of ["http://www.twitch.tv/a", "https://www.twitch.tv.evil.example/a", "https://player.twitch.tv/",
    "https://other.hamivideo.hinet.net/", "https://hamivideo.hinet.net:444/", "https://evil@www.twitch.tv/a", "https://example.com/"]) {
    assert.equal(sitePolicy.isSupportedUrl(url), false);
    assert.equal(validPage({ tabId: 1, pageId: "page", url }), false);
    let page = createPage(undefined, url);
    assert.equal(page.send({ type: "get-state" }).ok, false);
  }
});

test("discovery includes only the three allowed website origins", async () => {
  let urls = [pageUrl, "https://www.twitch.tv/channel", "https://hamivideo.hinet.net/channel/test.do", "https://www.twitch.tv.evil.example/", "https://player.twitch.tv/"];
  let tabs = new Map(urls.map((url, index) => [index + 1, { id: index + 1, url }]));
  let background = createBackground(tabs, new Map());
  assert.deepEqual((await background.request({ type: "list-tabs" })).tabs.map(tab => tab.id), [1, 2, 3]);
});

test("all three sites share media volume and muted controls without changing another tab", async () => {
  let urls = [pageUrl, "https://www.twitch.tv/channel", "https://hamivideo.hinet.net/channel/test.do"];
  let pages = new Map(urls.map((url, index) => [index + 1, createPage([{ volume: 0.8, muted: false }, { volume: 0.2, muted: false }], url)]));
  let tabs = new Map(urls.map((url, index) => [index + 1, { id: index + 1, url }]));
  let background = createBackground(tabs, pages);
  for (let id of pages.keys()) {
    let state = await background.request({ type: "get-state", tabId: id, url: tabs.get(id).url });
    let target = { tabId: id, url: state.url, pageId: state.pageId };
    for (let volume of [0, 50, 100, 37]) {
      let otherVolumes = [...pages].filter(([other]) => other !== id).map(([, page]) => page.media.map(element => element.volume));
      let result = await background.request({ ...target, type: "set-volume", volume });
      assert.equal(result.applied, true);
      assert.deepEqual(pages.get(id).media.map(element => element.volume), [volume / 100, volume / 100]);
      assert.deepEqual([...pages].filter(([other]) => other !== id).map(([, page]) => page.media.map(element => element.volume)), otherVolumes);
    }
    for (let muted of [true, false]) {
      let result = await background.request({ ...target, type: "set-mute", muted });
      assert.equal(result.applied, true);
      assert.equal(result.muted, muted);
      assert.deepEqual(pages.get(id).media.map(element => element.volume), [0.37, 0.37]);
      assert.deepEqual(pages.get(id).media.map(element => element.muted), [muted, muted]);
    }
  }
  assert.ok(background.deliveries.every(item => item.options.frameId === 0));
});

test("Twitch and Hami SPA history events, refresh and closure invalidate old targets", async () => {
  for (let url of ["https://www.twitch.tv/channel-a", "https://hamivideo.hinet.net/channel/a.do"]) {
    let page = createPage(undefined, url);
    let tabs = new Map([[1, { id: 1, url }]]);
    let pages = new Map([[1, page]]);
    let background = createBackground(tabs, pages);
    let state = await background.request({ type: "get-state", tabId: 1, url });
    let command = { type: "set-volume", tabId: 1, url, pageId: state.pageId, volume: 10 };
    background.history({ tabId: 1, frameId: 2, url });
    await settle();
    assert.equal((await background.request(command)).ok, true); // Child frame changes do not retarget the top frame.
    background.history({ tabId: 1, frameId: 0, url });
    await settle();
    assert.equal((await background.request(command)).ok, false); // Same-URL replaceState is still a new target.
    state = await background.request({ type: "get-state", tabId: 1, url });
    page.location.href = url + "-b";
    tabs.get(1).url = page.location.href;
    background.history({ tabId: 1, frameId: 0, url: page.location.href });
    page.location.href = url;
    tabs.get(1).url = url;
    background.history({ tabId: 1, frameId: 0, url });
    await settle();
    assert.equal((await background.request({ ...command, pageId: state.pageId })).ok, false);
    let fresh = await background.request({ type: "get-state", tabId: 1, url });
    pages.set(1, createPage(undefined, url));
    assert.equal((await background.request({ ...command, pageId: fresh.pageId })).ok, false);
    tabs.delete(1);
    assert.match((await background.request(command)).error, /關閉/);
  }
});

test("missing top-frame media gives an iframe diagnostic and never claims applied", async () => {
  let url = "https://hamivideo.hinet.net/channel/test.do";
  let page = createPage([], url);
  let result = page.send({ type: "get-state" });
  assert.equal(result.ok, false);
  assert.equal(result.applied, undefined);
  assert.match(result.error, /iframe/);
  page.media.push({ volume: 0.6, muted: false });
  let state = page.send({ type: "get-state" });
  page.media.splice(0, 1, { volume: 0.9, muted: true });
  assert.equal(page.send({ type: "set-volume", pageId: state.pageId, volume: 37 }).applied, true);
  assert.equal(page.media[0].volume, 0.37);
  assert.equal(page.media[0].muted, true);
});

test("routes 0/50/100 to all media in exactly one tab and preserves muted", async () => {
  let { a, b, background } = setup();
  a.media.push({ volume: 0.2, muted: true });
  let state = await background.request({ type: "get-state", tabId: 1, url: pageUrl });
  assert.equal(state.mixed, true);
  for (let volume of [0, 50, 100]) {
    let result = await background.request({ type: "set-volume", tabId: 1, pageId: state.pageId, url: state.url, volume });
    assert.equal(result.ok, true);
    assert.equal(result.volume, volume);
    assert.equal(result.mediaCount, 2);
    assert.deepEqual(a.media.map(element => element.volume), [volume / 100, volume / 100]);
    assert.equal(b.media[0].volume, 0.8);
    assert.deepEqual(a.media.map(element => element.muted), [false, true]);
  }
  assert.ok(background.deliveries.every(item => item.id === 1 && item.options.frameId === 0));
});

test("rejects invalid commands, volumes, tab IDs and untrusted senders before delivery", async () => {
  let { background } = setup();
  let state = { type: "set-volume", tabId: 1, url: pageUrl, pageId: "page", volume: 50 };
  for (let volume of [-1, 101, 1.5, "50", null, NaN, Infinity]) {
    assert.equal((await background.request({ ...state, volume })).ok, false);
  }
  for (let tabId of [-1, "1", null, 1.5]) {
    assert.equal((await background.request({ ...state, tabId })).ok, false);
  }
  for (let message of [null, {}, { type: "execute-script" }, { ...state, pageId: "" },
    { type: "get-state", tabId: 1 }, { type: "get-state", tabId: 1, url: "chrome://settings" }]) {
    assert.equal((await background.request(message)).ok, false);
  }
  for (let sender of [{}, { id: "other", url: popupUrl }, { ...popupSender, tab: { id: 1 } }, internalSender]) {
    assert.equal((await background.request({ type: "list-tabs" }, sender)).ok, false);
  }
  assert.equal(background.deliveries.length, 0);
});

test("closed, navigating, unsupported and unconnected tabs return readable failures", async () => {
  let { background, tabs, pages } = setup();
  let request = () => background.request({ type: "get-state", tabId: 1, url: pageUrl });
  tabs.delete(1);
  assert.match((await request()).error, /關閉/);
  tabs.set(1, { id: 1, url: "chrome://settings" });
  assert.match((await request()).error, /不在支援/);
  tabs.set(1, { id: 1, url: pageUrl, pendingUrl: pageUrl + "2" });
  assert.equal((await request()).ok, false);
  tabs.set(1, { id: 1, url: pageUrl, status: "loading" });
  assert.equal((await request()).ok, false);
  tabs.set(1, { id: 1, url: pageUrl });
  pages.delete(1);
  assert.match((await request()).error, /網站存取權/);
});

test("refresh at the same URL, changed URL and expired commands never modify media", async () => {
  let { background, pages, tabs } = setup();
  let state = await background.request({ type: "get-state", tabId: 1, url: pageUrl });
  let reloaded = createPage();
  pages.set(1, reloaded);
  let command = { type: "set-volume", tabId: 1, pageId: state.pageId, url: state.url, volume: 20 };
  assert.match((await background.request(command)).error, /頁面已變更/);
  assert.equal(reloaded.media[0].volume, 0.8);
  let fresh = reloaded.send({ type: "get-state" });
  command.pageId = fresh.pageId;
  assert.equal(reloaded.send({ ...command, expiresAt: Date.now() - 1 }).ok, false);
  reloaded.location.href += "2";
  assert.equal(reloaded.send(command).ok, false);
  tabs.get(1).url += "2";
  assert.equal((await background.request(command)).ok, false);
  assert.equal(reloaded.media[0].volume, 0.8);
});

test("content independently validates inputs and reports absent media or setter failure", () => {
  let page = createPage();
  let state = page.send({ type: "get-state" });
  let command = { type: "set-volume", pageId: state.pageId, volume: 30 };
  assert.equal(page.send({ ...command, volume: "30" }).ok, false);
  assert.equal(page.send(command, { id: "other" }).ok, false);
  assert.equal(page.send({ type: "unknown" }).ok, false);
  assert.equal(page.media[0].volume, 0.8);
  assert.match(createPage([]).send({ type: "get-state" }).error, /沒有可控制/);
  let locked = createPage([{ get volume() { return 0.8; }, set volume(value) {}, muted: false }]);
  let lockedState = locked.send({ type: "get-state" });
  assert.equal(locked.send({ ...command, pageId: lockedState.pageId }).ok, false);
  let throwing = createPage([{ get volume() { return 0.8; }, set volume(value) { throw new Error("blocked"); } }]);
  assert.equal(throwing.send({ ...command, pageId: throwing.send({ type: "get-state" }).pageId }).ok, false);
});

test("each command rescans media and a restarted background needs no saved state", async () => {
  let { background, tabs, pages, a } = setup();
  let state = await background.request({ type: "get-state", tabId: 1, url: pageUrl });
  a.media.splice(0, 1, { volume: 0.9, muted: false });
  let restarted = createBackground(tabs, pages);
  assert.equal((await restarted.request({ ...state, type: "set-volume", tabId: 1, volume: 35 })).ok, true);
  assert.equal(a.media[0].volume, 0.35);
});

test("state reads never reapply the last commanded YouTube volume or alter a replacement element", async () => {
  let { a, background } = setup();
  let volume = 0.5;
  let writes = 0;
  Object.defineProperty(a.media[0], "volume", { get: () => volume, set(value) { volume = value; writes += 1; } });
  let target = await background.request({ type: "get-state", tabId: 1, url: pageUrl });
  await background.request({ type: "set-volume", tabId: 1, pageId: target.pageId, url: pageUrl, volume: 20 });
  assert.equal(writes, 1);
  volume = 0.5; // Simulate the website changing its own state without an extension command.
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await background.request({ type: "get-state", tabId: 1, url: pageUrl })).volume, 50);
  }
  assert.equal(writes, 1);
  a.media.splice(0, 1, { volume: 0.5, muted: true });
  assert.equal((await background.request({ type: "get-state", tabId: 1, url: pageUrl })).volume, 50);
  assert.equal(a.media[0].muted, true);
});

test("timeout reports failure without an execution acknowledgement", async () => {
  let { background, pages } = setup();
  pages.set(1, { send: () => new Promise(() => {}) });
  let pending = background.request({ type: "get-state", tabId: 1, url: pageUrl });
  await background.clock.tick(4000);
  let result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /逾時/);
});

function createSender(send, onError = error => { throw error; }) {
  let clock = createClock();
  let context = vm.createContext({ ...clock });
  vm.runInContext(read("volume-sender.js"), context);
  return { clock, sender: context.createVolumeSender(send, onError) };
}

test("slider throttle sends at ~100ms and keeps the latest pending value", async () => {
  let sent = [];
  let { sender, clock } = createSender(async value => { sent.push([clock.performance.now(), value]); });
  sender.push(10);
  await clock.tick(0);
  sender.push(20);
  await clock.tick(30);
  sender.push(30);
  await clock.tick(69);
  assert.deepEqual(sent, [[0, 10]]);
  await clock.tick(1);
  assert.deepEqual(sent, [[0, 10], [100, 30]]);
});

test("final value bypasses throttle wait, is serialized and remains last", async () => {
  let sent = [];
  let release;
  let { sender, clock } = createSender(value => {
    sent.push(value);
    if (sent.length === 1) return new Promise(resolve => { release = resolve; });
  });
  sender.push(10);
  await clock.tick(0);
  sender.push(20);
  sender.flush(27);
  await clock.tick(20);
  assert.deepEqual(sent, [10]);
  release();
  await clock.tick(0);
  assert.deepEqual(sent, [10, 27]);
  await clock.tick(500);
  assert.deepEqual(sent, [10, 27]);
});

test("selection cancellation and errors discard pending slider values", async () => {
  let sent = [];
  let { sender, clock } = createSender(async value => sent.push(value));
  sender.push(10);
  await clock.tick(0);
  sender.push(20);
  sender.cancel();
  sender.flush(30);
  await clock.tick(500);
  assert.deepEqual(sent, [10]);
  let errors = [];
  let failed = createSender(async () => { throw new Error("disconnected"); }, error => errors.push(error.message));
  failed.sender.push(10);
  await failed.clock.tick(0);
  failed.sender.flush(20);
  await failed.clock.tick(500);
  assert.deepEqual(errors, ["disconnected"]);
});

test("cancelling during an in-flight request prevents its queued final value", async () => {
  let sent = [];
  let release;
  let { sender, clock } = createSender(value => {
    sent.push(value);
    return new Promise(resolve => { release = resolve; });
  });
  sender.push(10);
  await clock.tick(0);
  sender.flush(90);
  sender.cancel();
  release();
  await clock.tick(500);
  assert.deepEqual(sent, [10]);
});

function createPopup(sendMessage) {
  let elements = new Map();
  let updates = [];
  let removals = [];
  let historyListeners = [];
  for (let id of ["tabs", "refresh", "selected", "volume", "percentage", "status", "mute"]) {
    elements.set(`#${id}`, {
      value: "", textContent: "", dataset: {}, disabled: false, options: [], listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      add(option) { this.options.push(option); },
      replaceChildren(...options) { this.options = options; this.value = ""; },
      get selectedOptions() { return this.options.filter(option => option.value === this.value); }
    });
  }
  let clock = createClock();
  let context = vm.createContext({
    ...clock,
    document: { querySelector: id => elements.get(id) },
    window: { addEventListener() {} },
    Option: function(text, value) { this.textContent = text; this.value = value; },
    chrome: {
      runtime: { sendMessage },
      webNavigation: { onHistoryStateUpdated: { addListener(fn) { historyListeners.push(fn); } } },
      tabs: {
        onUpdated: { addListener(fn) { updates.push(fn); } },
        onRemoved: { addListener(fn) { removals.push(fn); } }
      }
    }
  });
  vm.runInContext(read("volume-sender.js"), context);
  vm.runInContext(read("popup.js"), context);
  return {
    elements, clock,
    history(details) { historyListeners.forEach(fn => fn(details)); },
    updateTab(id, changes) { updates.forEach(fn => fn(id, changes)); },
    removeTab(id) { removals.forEach(fn => fn(id)); }
  };
}

test("popup cancels selection on a top-frame same-URL SPA event but ignores child frames", async () => {
  let { background } = setup();
  let popup = createPopup(message => background.request(message));
  await settle();
  let select = popup.elements.get("#tabs");
  select.value = "1";
  await select.listeners.change();
  popup.history({ tabId: 1, frameId: 2, url: pageUrl });
  assert.equal(popup.elements.get("#volume").disabled, false);
  popup.history({ tabId: 1, frameId: 0, url: pageUrl });
  assert.equal(popup.elements.get("#volume").disabled, true);
  assert.equal(select.value, "");
  assert.match(popup.elements.get("#status").textContent, /切換內容/);
});

test("popup mute and unmute wait for content confirmation and preserve the current volume", async () => {
  let { a, background } = setup();
  let popup = createPopup(message => background.request(message));
  await settle();
  popup.elements.get("#tabs").value = "1";
  await popup.elements.get("#tabs").listeners.change();
  let button = popup.elements.get("#mute");
  await button.listeners.click();
  assert.equal(a.media[0].muted, true);
  assert.equal(a.media[0].volume, 0.8);
  assert.equal(button.textContent, "解除靜音");
  await button.listeners.click();
  assert.equal(a.media[0].muted, false);
  assert.equal(a.media[0].volume, 0.8);
  assert.match(popup.elements.get("#status").textContent, /已確認/);
});

test("P2: a stale list URL cannot silently select and control the navigated page", async () => {
  let { a, b, tabs, background } = setup();
  let { elements, clock } = createPopup(message => background.request(message));
  await settle();
  let select = elements.get("#tabs");
  let nextUrl = "https://www.youtube.com/watch?v=next";
  a.location.href = nextUrl;
  a.document.title = "換片後的影片";
  tabs.get(1).url = nextUrl;
  tabs.get(1).title = a.document.title;
  select.value = "1";
  await select.listeners.change();
  assert.equal(elements.get("#volume").disabled, true);
  assert.match(elements.get("#status").textContent, /頁面已變更/);
  assert.equal(a.media[0].volume, 0.8);
  await elements.get("#refresh").listeners.click();
  select.value = "1";
  await select.listeners.change();
  assert.equal(elements.get("#volume").disabled, false);
  assert.match(elements.get("#selected").textContent, /換片後的影片/);
  assert.ok(elements.get("#selected").textContent.includes(nextUrl));
  let slider = elements.get("#volume");
  slider.value = "37";
  slider.listeners.change();
  await clock.tick(0);
  assert.equal(a.media[0].volume, 0.37);
  assert.equal(b.media[0].volume, 0.8);
});

test("P2: display uses the verified page title and distinguishes equal-title equal-URL tabs", async () => {
  let { a, b, tabs, background } = setup();
  tabs.get(1).title = "舊標題";
  tabs.get(2).title = "舊標題";
  tabs.get(1).windowId = 10;
  tabs.get(2).windowId = 20;
  let { elements, clock } = createPopup(message => background.request(message));
  await settle();
  let select = elements.get("#tabs");
  a.document.title = "已驗證標題";
  b.document.title = "已驗證標題";
  select.value = "2";
  await select.listeners.change();
  assert.match(elements.get("#selected").textContent, /已驗證標題/);
  assert.doesNotMatch(elements.get("#selected").textContent, /舊標題/);
  assert.match(select.selectedOptions[0].textContent, /已驗證標題/);
  assert.match(select.options[1].textContent, /ID：1/);
  assert.match(select.options[2].textContent, /ID：2/);
  let slider = elements.get("#volume");
  slider.value = "65";
  slider.listeners.change();
  await clock.tick(0);
  assert.equal(a.media[0].volume, 0.8);
  assert.equal(b.media[0].volume, 0.65);
});

test("P2: page-change events cancel pending values and late acknowledgements cannot restore selection", async () => {
  let writes = [];
  let acknowledge;
  let { elements, clock, updateTab } = createPopup(message => {
    if (message.type === "list-tabs") return Promise.resolve({ ok: true, tabs: [{ id: 1, title: "影片", url: pageUrl }] });
    if (message.type === "get-state") return Promise.resolve({ ok: true, tabId: 1, title: "影片", pageId: "page", url: pageUrl, volume: 80, mediaCount: 1 });
    writes.push(message);
    return new Promise(resolve => { acknowledge = resolve; });
  });
  await settle();
  let select = elements.get("#tabs");
  select.value = "1";
  await select.listeners.change();
  updateTab(2, { url: pageUrl + "other" });
  assert.equal(elements.get("#volume").disabled, false);
  let slider = elements.get("#volume");
  slider.value = "30";
  slider.listeners.input();
  await clock.tick(0);
  slider.value = "40";
  slider.listeners.change();
  updateTab(1, { url: pageUrl + "next" });
  assert.equal(slider.disabled, true);
  assert.equal(select.value, "");
  acknowledge({ ok: true, volume: 30, mediaCount: 1 });
  await clock.tick(500);
  assert.equal(writes.length, 1);
  assert.match(elements.get("#status").textContent, /頁面已變更/);
  assert.doesNotMatch(elements.get("#status").textContent, /已確認/);
});

test("P2: refresh, title change and closure invalidate even a pending state read", async () => {
  for (let event of ["refresh", "title", "close"]) {
    let finish;
    let { elements, updateTab, removeTab } = createPopup(message => {
      if (message.type === "list-tabs") return Promise.resolve({ ok: true, tabs: [{ id: 1, title: "影片", url: pageUrl }] });
      return new Promise(resolve => { finish = resolve; });
    });
    await settle();
    let select = elements.get("#tabs");
    select.value = "1";
    let reading = select.listeners.change();
    if (event === "close") removeTab(1);
    else updateTab(1, event === "refresh" ? { status: "loading" } : { title: "新標題" });
    finish({ ok: true, tabId: 1, title: "舊標題", pageId: "page", url: pageUrl, volume: 80, mediaCount: 1 });
    await reading;
    assert.equal(elements.get("#volume").disabled, true, event);
    assert.equal(select.value, "", event);
    assert.equal(elements.get("#selected").textContent, "尚未選取分頁", event);
  }
});

test("P2: a state response with another tab ID or URL cannot enable controls", async () => {
  for (let mismatch of [{ tabId: 2 }, { url: pageUrl + "other" }]) {
    let { elements } = createPopup(async message => {
      if (message.type === "list-tabs") return { ok: true, tabs: [{ id: 1, title: "影片", url: pageUrl }] };
      return { ok: true, tabId: 1, title: "影片", url: pageUrl, pageId: "page", volume: 80, mediaCount: 1, ...mismatch };
    });
    await settle();
    let select = elements.get("#tabs");
    select.value = "1";
    await select.listeners.change();
    assert.equal(elements.get("#volume").disabled, true);
    assert.match(elements.get("#status").textContent, /不一致/);
    assert.equal(select.value, "");
  }
});

test("popup ignores late selection responses and only shows success after acknowledgement", async () => {
  let reads = new Map();
  let writes = [];
  let acknowledge;
  let { elements, clock } = createPopup(message => {
    if (message.type === "list-tabs") return Promise.resolve({ ok: true, tabs: [1, 2].map(id => ({ id, title: `Video ${id}`, url: pageUrl })) });
    if (message.type === "get-state") return new Promise(resolve => reads.set(message.tabId, resolve));
    writes.push(message);
    return new Promise(resolve => { acknowledge = resolve; });
  });
  await settle();
  let tabs = elements.get("#tabs");
  tabs.value = "1";
  let first = tabs.listeners.change();
  tabs.value = "2";
  let second = tabs.listeners.change();
  let state = { ok: true, tabId: 2, title: "影片 2", pageId: "page-2", url: pageUrl, volume: 80, mediaCount: 1 };
  reads.get(2)(state);
  await second;
  reads.get(1)({ ...state, tabId: 1, pageId: "page-1", volume: 10 });
  await first;
  let slider = elements.get("#volume");
  assert.equal(slider.value, 80);
  assert.match(elements.get("#selected").textContent, /ID：2/);
  slider.value = "42";
  slider.listeners.input();
  await clock.tick(0);
  assert.equal(writes[0].tabId, 2);
  assert.doesNotMatch(elements.get("#status").textContent, /已確認/);
  acknowledge({ ...state, volume: 42 });
  await settle();
  assert.match(elements.get("#status").textContent, /已確認套用 42%/);
  slider.value = "43";
  slider.listeners.change();
  await clock.tick(0);
  assert.equal(writes.at(-1).volume, 43);
  tabs.value = "";
  await tabs.listeners.change();
  acknowledge({ ...state, volume: 43 });
  await settle();
  assert.equal(slider.disabled, true);
  assert.doesNotMatch(elements.get("#status").textContent, /已確認/);
});

test("popup disables control and discards the pending final value after a command fails", async () => {
  let writes = [];
  let rejectCommand;
  let { elements, clock } = createPopup(message => {
    if (message.type === "list-tabs") return Promise.resolve({ ok: true, tabs: [{ id: 1, title: "Video", url: pageUrl }] });
    if (message.type === "get-state") return Promise.resolve({ ok: true, tabId: 1, title: "影片", pageId: "page", url: pageUrl, volume: 80, mediaCount: 1 });
    writes.push(message);
    return new Promise(resolve => { rejectCommand = () => resolve({ ok: false, error: "目標頁面已變更，請重新選取。" }); });
  });
  await settle();
  let tabs = elements.get("#tabs");
  tabs.value = "1";
  await tabs.listeners.change();
  let slider = elements.get("#volume");
  slider.value = "30";
  slider.listeners.input();
  await clock.tick(0);
  slider.value = "40";
  slider.listeners.change();
  rejectCommand();
  await clock.tick(500);
  assert.equal(writes.length, 1);
  assert.equal(slider.disabled, true);
  assert.equal(tabs.value, "");
  assert.equal(elements.get("#status").dataset.error, "true");
  assert.match(elements.get("#status").textContent, /重新選取/);
});
