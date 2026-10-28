import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../server/bridge.js";

let page = { tabId: 1, pageId: "page-a", url: "https://www.youtube.com/watch?v=a", title: "影片 A",
  volume: 80, muted: false, browserMuted: false, mixed: false, mixedMuted: false, mediaCount: 1 };

function setup() {
  let time = 100000;
  let bridge = createBridge(() => time);
  let { extensionSessionId } = bridge.register("browser-a");
  bridge.reportTabs(extensionSessionId, [page]);
  return { bridge, target: { ...page, extensionSessionId }, advance(ms) { time += ms; } };
}

test("bridge supersedes only undelivered volume commands for the exact target", async () => {
  let { bridge, target } = setup();
  let first = bridge.enqueue("phone-a", "set-volume", { ...target, volume: 10 });
  let latest = bridge.enqueue("phone-b", "set-volume", { ...target, volume: 37 });
  assert.equal(bridge.result("phone-a", first.commandId).status, "superseded");
  let command = await bridge.poll(target.extensionSessionId, new AbortController().signal, 1);
  assert.equal(command.commandId, latest.commandId);
  assert.equal(command.volume, 37);
  let afterDelivery = bridge.enqueue("phone-b", "set-volume", { ...target, volume: 65 });
  assert.equal(bridge.result("phone-b", latest.commandId).status, "delivered");
  assert.equal(bridge.result("phone-b", afterDelivery.commandId).status, "queued");
  assert.equal(await bridge.poll(target.extensionSessionId, new AbortController().signal, 1), null);
  bridge.close();
});

test("bridge accepts applied only with matching page identity, proof and actual value", async () => {
  let { bridge, target } = setup();
  let { commandId } = bridge.enqueue("phone", "set-volume", { ...target, volume: 37 });
  let body = { commandId, status: "applied", result: { ...page, volume: 37, applied: true } };
  assert.throws(() => bridge.reportResult(target.extensionSessionId, body), { code: "COMMAND_FINISHED" });
  await bridge.poll(target.extensionSessionId, new AbortController().signal, 1);
  for (let difference of [{ pageId: "other" }, { volume: 38 }, { applied: false }, { url: page.url + "other" }]) {
    assert.throws(() => bridge.reportResult(target.extensionSessionId, { ...body, result: { ...body.result, ...difference } }), { code: "INVALID_RESULT" });
  }
  bridge.reportResult(target.extensionSessionId, body);
  bridge.reportResult(target.extensionSessionId, body);
  assert.equal(bridge.result("phone", commandId).status, "applied");
  assert.throws(() => bridge.result("other-phone", commandId), { status: 404 });
  bridge.close();
});

test("queued expiry and missing acknowledgements have distinct outcomes and cannot be overwritten", async () => {
  let { bridge, target, advance } = setup();
  let queued = bridge.enqueue("phone", "get-state", target);
  advance(8001);
  assert.equal(bridge.result("phone", queued.commandId).status, "expired");
  let delivered = bridge.enqueue("phone", "set-mute", { ...target, muted: true });
  await bridge.poll(target.extensionSessionId, new AbortController().signal, 1);
  advance(8001);
  assert.equal(bridge.result("phone", delivered.commandId).status, "unknown");
  assert.throws(() => bridge.reportResult(target.extensionSessionId, { commandId: delivered.commandId, status: "failed", message: "late" }), { status: 409 });
  advance(60001);
  assert.throws(() => bridge.result("phone", delivered.commandId), { status: 404 });
  bridge.close();
});

test("navigation, closure, session replacement and phone logout revoke queued commands", () => {
  let { bridge, target } = setup();
  let command = bridge.enqueue("phone", "set-volume", { ...target, volume: 30 });
  bridge.reportTabs(target.extensionSessionId, [{ ...page, pageId: "page-b" }]);
  assert.equal(bridge.result("phone", command.commandId).status, "failed");
  assert.throws(() => bridge.enqueue("phone", "get-state", target), { status: 409 });
  bridge.reportTabs(target.extensionSessionId, []);
  assert.throws(() => bridge.enqueue("phone", "get-state", target), { status: 404 });
  bridge.reportTabs(target.extensionSessionId, [page]);
  command = bridge.enqueue("phone", "get-state", target);
  bridge.cancelOwner("phone");
  assert.equal(bridge.result("phone", command.commandId).status, "expired");
  command = bridge.enqueue("phone", "get-state", target);
  assert.throws(() => bridge.register("other-browser"), { status: 409 });
  bridge.register("browser-a");
  assert.equal(bridge.result("phone", command.commandId).status, "expired");
  assert.throws(() => bridge.authenticate(target.extensionSessionId), { status: 409 });
  bridge.close();
});

test("long polls wake on commands, reject overlaps and clean up on abort", async () => {
  let { bridge, target } = setup();
  let controller = new AbortController();
  let waiting = bridge.poll(target.extensionSessionId, controller.signal, 1000);
  await assert.rejects(bridge.poll(target.extensionSessionId, controller.signal, 1), { code: "POLL_IN_PROGRESS" });
  let queued = bridge.enqueue("phone", "get-state", target);
  assert.equal((await waiting).commandId, queued.commandId);
  bridge.reportResult(target.extensionSessionId, { commandId: queued.commandId, status: "applied", result: page });
  let aborting = bridge.poll(target.extensionSessionId, controller.signal, 1000);
  controller.abort();
  assert.equal(await aborting, null);
  assert.equal(await bridge.poll(target.extensionSessionId, new AbortController().signal, 1), null);
  bridge.close();
});

test("bridge limits metadata and forgets expired extension leases", () => {
  let { bridge, target, advance } = setup();
  assert.throws(() => bridge.reportTabs(target.extensionSessionId, Array(51).fill(page)), { status: 400 });
  assert.throws(() => bridge.reportTabs(target.extensionSessionId, [page, page]), { status: 400 });
  advance(20000);
  assert.deepEqual(bridge.listTabs().tabs, []);
  assert.equal(bridge.listTabs().extensionConnected, false);
  assert.throws(() => bridge.enqueue("phone", "get-state", target), { status: 503 });
  bridge.close();
});
