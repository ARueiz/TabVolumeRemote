import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let html = readFileSync(new URL("../server/public/index.html", import.meta.url), "utf8");
let script = readFileSync(new URL("../server/public/app.js", import.meta.url), "utf8");
let settle = async () => { for (let index = 0; index < 25; index += 1) await Promise.resolve(); };

function response(status, result, retryAfter = null) {
  return { ok: status >= 200 && status < 300, status, async json() { return result; }, headers: { get: () => retryAfter } };
}

function createMobile(fetch) {
  let elements = new Map();
  for (let tag of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements.set(`#${tag[1]}`, {
      value: "", textContent: "", dataset: {}, disabled: /\bdisabled\b/.test(tag[0]), hidden: /\bhidden\b/.test(tag[0]), listeners: {},
      options: [],
      add(option) { this.options.push(option); },
      replaceChildren(...options) { this.options = options; this.value = ""; },
      addEventListener(type, fn) { this.listeners[type] = fn; }
    });
  }
  let intervals = [];
  let context = vm.createContext({
    document: { hidden: false, querySelector: selector => elements.get(selector), addEventListener() {} },
    fetch, AbortController, setTimeout: () => 1, clearTimeout() {}, setInterval(fn) { intervals.push(fn); },
    Option: function(text, value) { this.textContent = text; this.value = value; }
  });
  vm.runInContext(readFileSync(new URL("../server/public/controls.js", import.meta.url), "utf8"), context);
  vm.runInContext(script, context);
  return { elements, intervals };
}

test("mobile page has responsive controls, initially disabled, without fake tabs or percentages", async () => {
  let requests = [];
  let { elements } = createMobile(async (path, options) => {
    requests.push({ path, options });
    return response(200, { ok: true, extensionConnected: false, tabs: [] });
  });
  await settle();
  assert.match(html, /name="viewport"/);
  assert.match(html, /尚未連接瀏覽器/);
  assert.match(html, /id="percentage"[^>]*>—/);
  assert.equal((html.match(/<option /g) || []).length, 1);
  for (let id of ["#tabs", "#volume", "#mute"]) assert.equal(elements.get(id).disabled, true);
  assert.equal(elements.get("#pair-form").hidden, true);
  assert.match(elements.get("#message").textContent, /無法執行控制/);
  assert.deepEqual(requests.map(item => item.path), ["/api/tabs"]);
  assert.equal(requests[0].options.credentials, "same-origin");
  assert.equal(requests[0].options.headers["X-TVR-Client"], "mobile");
});

test("pairing sends the token only in JSON and clears the input", async () => {
  let requests = [];
  let { elements } = createMobile(async (path, options) => {
    requests.push({ path, options });
    return path === "/api/tabs" ? response(401, { error: { message: "請先配對" } }) : response(200, { ok: true });
  });
  await settle();
  assert.equal(elements.get("#pair-form").hidden, false);
  elements.get("#token").value = "test-only-input";
  await elements.get("#pair-form").listeners.submit({ preventDefault() {} });
  let paired = requests.find(item => item.path === "/api/pair");
  assert.equal(paired.options.method, "POST");
  assert.deepEqual(JSON.parse(paired.options.body), { token: "test-only-input" });
  assert.equal(elements.get("#token").value, "");
  assert.equal(elements.get("#pair-form").hidden, true);
  assert.equal(elements.get("#logout").hidden, false);
  assert.match(elements.get("#message").textContent, /尚未連接瀏覽器/);
  assert.ok(requests.every(item => !item.path.includes("?")));
});

test("pairing failure and rate limit are visible without exposing the submitted token", async () => {
  let { elements } = createMobile(async path => path === "/api/tabs"
    ? response(401, { error: { message: "請先配對" } })
    : response(429, { error: { message: "配對失敗次數過多" } }, "300"));
  await settle();
  elements.get("#token").value = "private-input";
  await elements.get("#pair-form").listeners.submit({ preventDefault() {} });
  assert.equal(elements.get("#token").value, "");
  assert.equal(elements.get("#pair-form").hidden, false);
  assert.match(elements.get("#message").textContent, /300 秒/);
  assert.equal(elements.get("#message").textContent.includes("private-input"), false);
  assert.equal(elements.get("#message").dataset.error, "true");
});

test("network failures are visible and the next refresh can recover", async () => {
  let available = false;
  let { elements } = createMobile(async () => {
    if (!available) throw new Error("offline");
    return response(200, { ok: true, extensionConnected: false, tabs: [] });
  });
  await settle();
  assert.match(elements.get("#connection").textContent, /連線失敗/);
  available = true;
  await elements.get("#refresh").listeners.click();
  assert.equal(elements.get("#connection").textContent, "已連接伺服器");
  assert.equal(elements.get("#volume").disabled, true);
});

test("expired sessions show the pairing form and successful logout clears paired UI", async () => {
  let expired = false;
  let { elements, intervals } = createMobile(async path => path === "/api/tabs" && expired
    ? response(401, { error: { message: "失效" } }) : response(200, { ok: true, tabs: [] }));
  await settle();
  expired = true;
  intervals[0]();
  await settle();
  assert.equal(elements.get("#pair-form").hidden, false);
  assert.match(elements.get("#message").textContent, /已失效/);
  expired = false;
  await elements.get("#refresh").listeners.click();
  await elements.get("#logout").listeners.click();
  assert.equal(elements.get("#pair-form").hidden, false);
  assert.equal(elements.get("#logout").hidden, true);
});
