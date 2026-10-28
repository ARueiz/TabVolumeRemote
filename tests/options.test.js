import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let read = name => readFileSync(new URL(`../extension/${name}`, import.meta.url), "utf8");
let settle = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };
function setup(respond, permission = true) {
  let ids = ["connection-form", "server-url", "server-token", "token-hint", "action-status", "connection-status", "extension-id", "compatibility", "test-server", "save-server", "disconnect-server", "forget-server"];
  let elements = new Map(ids.map(id => ["#" + id, { value: "", textContent: "", dataset: {}, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } }]));
  let calls = [];
  let permissions = [];
  let intervals = [];
  let context = vm.createContext({
    URL,
    document: { querySelector: selector => elements.get(selector), querySelectorAll: () => ["test-server", "save-server", "disconnect-server", "forget-server"].map(id => elements.get("#" + id)) },
    chrome: { runtime: { id: "a".repeat(32), async sendMessage(message) {
      calls.push(message);
      if (message.type === "connection-settings") return { ok: true, hasToken: true, serverUrl: "http://192.168.1.10:3210" };
      if (message.type === "server-status") return { ok: true, message: "已連接 Server" };
      return respond(message);
    } }, permissions: { async request(value) { permissions.push(value); return permission; } } },
    setInterval(fn) { intervals.push(fn); }
  });
  vm.runInContext(read("server-client.js"), context);
  vm.runInContext(read("options.js"), context);
  return { elements, calls, permissions, intervals };
}

test("options is a standalone page, never fills a saved token and status refresh preserves drafts", async () => {
  let manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.options_ui.open_in_tab, true);
  assert.match(read("options.html"), /type="password"/);
  assert.doesNotMatch(read("popup.html"), /id="server-token"|<details>/);
  let { elements, intervals } = setup(() => ({ ok: true }));
  await settle();
  assert.equal(elements.get("#server-token").value, "");
  assert.match(elements.get("#token-hint").textContent, /留白/);
  elements.get("#server-url").value = "http://192.168.1.20:3210";
  elements.get("#server-token").value = "draft";
  await intervals[0]();
  assert.equal(elements.get("#server-token").value, "draft");
  assert.equal(elements.get("#server-url").value, "http://192.168.1.20:3210");
});

test("test connection reports actual failure, requests only the private host and does not save drafts", async () => {
  let { elements, calls, permissions } = setup(() => ({ ok: false, error: "擴充功能憑證無效。" }));
  await settle();
  let token = "a".repeat(43);
  elements.get("#server-token").value = token;
  await elements.get("#test-server").listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(permissions)), [{ origins: ["http://192.168.1.10/*"] }]);
  assert.equal(calls.filter(call => call.type === "connect-server").length, 0);
  assert.equal(elements.get("#action-status").dataset.error, "true");
  assert.match(elements.get("#action-status").textContent, /憑證無效/);
  assert.equal(elements.get("#action-status").textContent.includes(token), false);
  assert.equal(elements.get("#server-token").value, token);
});

test("options rejects public URLs and denied permission, then clears typed token only after saving", async () => {
  let denied = setup(() => ({ ok: true }), false);
  await settle();
  denied.elements.get("#server-url").value = "http://8.8.8.8:3210";
  await denied.elements.get("#test-server").listeners.click();
  assert.equal(denied.permissions.length, 0);
  denied.elements.get("#server-url").value = "http://192.168.1.10:3210";
  await denied.elements.get("#test-server").listeners.click();
  assert.equal(denied.calls.some(call => call.type === "test-server"), false);
  let saved = setup(() => ({ ok: true }));
  await settle();
  saved.elements.get("#server-token").value = "a".repeat(43);
  saved.elements.get("#connection-form").listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(saved.calls.filter(call => call.type === "connect-server").length, 1);
  assert.equal(saved.elements.get("#server-token").value, "");
  assert.match(saved.elements.get("#action-status").textContent, /已儲存/);
});
