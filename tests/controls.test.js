import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

let target = { extensionSessionId: "session", tabId: 1, pageId: "page", url: "https://www.youtube.com/watch?v=a", title: "影片 A" };
let state = { ...target, volume: 80, muted: false, mixed: false, browserMuted: false, mediaCount: 1, applied: true };
let settle = async () => { for (let index = 0; index < 25; index += 1) await Promise.resolve(); };

function setup(api) {
  let now = 0;
  let nextId = 0;
  let timers = new Map();
  let elements = new Map(["tabs", "volume", "mute", "percentage", "selected", "latency", "browser-status"].map(id => ["#" + id, {
    value: "", textContent: "", disabled: true, options: [], listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    replaceChildren(...options) { this.options = options; this.value = ""; },
    add(option) { this.options.push(option); }
  }]));
  let messages = [];
  let context = vm.createContext({
    document: { querySelector: id => elements.get(id) },
    Option: function(text, value) { this.textContent = text; this.value = value; },
    performance: { now: () => now },
    setTimeout(fn, delay) { let id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(readFileSync(new URL("../extension/volume-sender.js", import.meta.url), "utf8"), context);
  vm.runInContext(readFileSync(new URL("../server/public/controls.js", import.meta.url), "utf8"), context);
  let controls = context.createRemoteControls(api, (text, error) => messages.push({ text, error }));
  controls.update({ extensionConnected: true, tabs: [target] });
  return {
    controls, elements, messages,
    async tick(ms) {
      await settle();
      let end = now + ms;
      while (true) {
        let next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
    select() { let select = elements.get("#tabs"); select.value = "session:1"; return select.listeners.change(); }
  };
}

test("phone shows control success only for content-applied, never queued or delivered", async () => {
  let controlStatus = "delivered";
  let phase = "state";
  let { elements, messages, tick, select } = setup(async (path, body) => {
    if (body) { phase = path === "/api/state" ? "state" : "volume"; return { commandId: "command", status: "queued" }; }
    return phase === "state" ? { status: "applied", result: state } : { status: controlStatus, result: { ...state, volume: 37 } };
  });
  let selecting = select();
  await tick(150);
  await selecting;
  let slider = elements.get("#volume");
  assert.equal(slider.disabled, false);
  slider.value = "37";
  slider.listeners.input();
  slider.listeners.change();
  await tick(150);
  assert.doesNotMatch(messages.at(-1).text, /已套用/);
  controlStatus = "applied";
  await tick(150);
  assert.match(messages.at(-1).text, /已套用 37%/);
  assert.match(elements.get("#latency").textContent, /ms/);
});

test("phone rejects an applied label without content proof and never retries the POST", async () => {
  let posts = [];
  let phase;
  let { elements, messages, tick, select } = setup(async (path, body) => {
    if (body) { posts.push(path); phase = path; return { commandId: "command", status: "queued" }; }
    return { status: "applied", result: { ...state, applied: phase === "/api/state" } };
  });
  let selecting = select();
  await tick(150);
  await selecting;
  let slider = elements.get("#volume");
  slider.value = "37";
  slider.listeners.change();
  await tick(300);
  assert.equal(slider.disabled, true);
  assert.equal(posts.filter(path => path === "/api/volume").length, 1);
  assert.match(messages.at(-1).text, /沒有回傳/);
});

test("phone navigation invalidation cancels pending values and ignores late acknowledgements", async () => {
  let phase;
  let finish;
  let posts = [];
  let { elements, controls, messages, tick, select } = setup(async (path, body) => {
    if (body) { posts.push(path); phase = path; return { commandId: "command", status: "queued" }; }
    if (phase === "/api/state") return { status: "applied", result: state };
    return new Promise(resolve => { finish = resolve; });
  });
  let selecting = select();
  await tick(150);
  await selecting;
  let slider = elements.get("#volume");
  slider.value = "30";
  slider.listeners.input();
  await tick(150);
  slider.value = "40";
  slider.listeners.change();
  controls.update({ extensionConnected: true, tabs: [{ ...target, pageId: "new-page" }] });
  finish({ status: "applied", result: { ...state, volume: 30 } });
  await tick(1000);
  assert.equal(slider.disabled, true);
  assert.equal(posts.filter(path => path === "/api/volume").length, 1);
  assert.match(messages.at(-1).text, /已變更/);
  assert.doesNotMatch(messages.at(-1).text, /已套用/);
});

test("unknown or superseded command results never display a successful adjustment", async () => {
  for (let status of ["unknown", "expired", "superseded", "failed"]) {
    let phase;
    let { elements, messages, tick, select } = setup(async (path, body) => {
      if (body) { phase = path; return { commandId: "command", status: "queued" }; }
      return phase === "/api/state" ? { status: "applied", result: state } : { status, message: "結果未確認" };
    });
    let selecting = select();
    await tick(150);
    await selecting;
    elements.get("#volume").value = "30";
    elements.get("#volume").listeners.change();
    await tick(300);
    assert.equal(elements.get("#volume").disabled, true);
    assert.doesNotMatch(messages.at(-1).text, /已套用/);
  }
});
