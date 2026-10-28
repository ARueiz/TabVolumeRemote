import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("YouTube diagnostic observes volume, initialization and replacements without ever writing media", () => {
  let writes = 0;
  function element(initial) {
    return { get volume() { return initial; }, set volume(value) { writes += 1; },
      get muted() { return false; }, set muted(value) { writes += 1; }, readyState: 4, events: {},
      addEventListener(type, handler) { this.events[type] = handler; }, removeEventListener(type) { delete this.events[type]; } };
  }
  let media = [element(0.5)];
  let changed;
  let disconnected = false;
  let events = {};
  let context = vm.createContext({
    location: { origin: "https://www.youtube.com", href: "https://www.youtube.com/watch?v=private" },
    performance: { now: () => 100 },
    document: { documentElement: {}, querySelectorAll: () => media, getElementById: () => ({ getVolume: () => 50 }) },
    window: { addEventListener(type, fn) { events[type] = fn; }, removeEventListener(type) { delete events[type]; } },
    MutationObserver: class { constructor(fn) { changed = fn; } observe() {} disconnect() { disconnected = true; } }
  });
  vm.runInContext(readFileSync(new URL("../tools/youtube-volume-diagnostic.js", import.meta.url), "utf8"), context);
  media[0].events.volumechange({ type: "volumechange", isTrusted: true });
  media[0].events.loadstart({ type: "loadstart", isTrusted: true });
  let previous = media[0];
  media = [element(0.2)];
  changed();
  events["yt-navigate-finish"]({ type: "yt-navigate-finish" });
  context.tabVolumeDiagnostic.mark();
  let records = context.tabVolumeDiagnostic.report();
  assert.ok(records.some(row => row.type === "volumechange"));
  assert.ok(records.some(row => row.type === "loadstart"));
  assert.notEqual(records[0].media[0].id, records.at(-1).media[0].id);
  assert.equal(records.at(-1).media[0].volume, 20);
  assert.equal(records.at(-1).playerVolume, 50);
  assert.equal(JSON.stringify(records).includes("private"), false);
  assert.equal(Object.keys(previous.events).length, 0);
  for (let index = 0; index < 250; index += 1) context.tabVolumeDiagnostic.mark();
  assert.equal(context.tabVolumeDiagnostic.report().length, 200);
  context.tabVolumeDiagnostic.stop();
  assert.equal(disconnected, true);
  assert.equal(Object.keys(media[0].events).length, 0);
  assert.equal(writes, 0);
});
