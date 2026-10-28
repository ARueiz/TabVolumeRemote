import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { loadConfig, readConfig, isPrivateIPv4 } from "../server/config.js";

let interfaces = { ethernet: [{ family: "IPv4", address: "192.168.1.10", internal: false }] };
let token = randomBytes(32).toString("base64url");
let extensionToken = randomBytes(32).toString("base64url");
let base = { TVR_HOST: "192.168.1.10", TVR_PAIRING_TOKEN: token };
function file(t, text) {
  let filename = join(tmpdir(), `tvr-config-${randomUUID()}.env`);
  writeFileSync(filename, text, "utf8");
  t.after(() => unlinkSync(filename));
  return filename;
}

test("native .env parsing handles BOM, quotes and comments while environment values take precedence", t => {
  let filename = file(t, `\uFEFF# no production secrets\nTVR_HOST="192.168.1.10"\nTVR_PORT=3210 # comment\nTVR_PAIRING_TOKEN='${token}'\n`);
  let originalPort = process.env.TVR_PORT;
  let config = loadConfig({ TVR_PORT: "4321" }, filename, interfaces);
  assert.equal(config.host, "192.168.1.10");
  assert.equal(config.port, 4321);
  assert.equal(config.pairingHash.length, 32);
  assert.equal(process.env.TVR_PORT, originalPort);
  if (process.platform === "win32") assert.equal(loadConfig({ tvr_port: "4322" }, filename, interfaces).port, 4322);
});

test("missing .env remains compatible with environment-only startup and read failures are fixed messages", t => {
  assert.equal(loadConfig(base, join(tmpdir(), `absent-${randomUUID()}.env`), interfaces).port, 3210);
  assert.throws(() => loadConfig({}, new URL("../server", import.meta.url), interfaces), /無法讀取或解析/);
  for (let source of ["TVR_HOST: secret-value", "TVR_HOTS=secret-value", "TVR_HOST=0.0.0.0", "TVR_PORT=secret-value"]) {
    let filename = file(t, source);
    assert.throws(() => loadConfig({ TVR_PAIRING_TOKEN: token }, filename, interfaces), error => {
      assert.equal(error.message.includes("secret-value"), false);
      return /格式|未知|整數|私人/.test(error.message);
    });
  }
});

test("extension ID allowlist accepts explicit Chrome and Edge IDs and rejects ambiguity or wildcards", () => {
  let env = { ...base, TVR_EXTENSION_TOKEN: extensionToken, TVR_EXTENSION_IDS: `${"a".repeat(32)}, ${"b".repeat(32)}` };
  assert.deepEqual(readConfig(env, interfaces).extensionIds, ["a".repeat(32), "b".repeat(32)]);
  assert.deepEqual(readConfig({ ...base, TVR_EXTENSION_TOKEN: extensionToken, TVR_EXTENSION_ID: "a".repeat(32) }, interfaces).extensionIds, ["a".repeat(32)]);
  for (let value of ["*", ",", `${"a".repeat(32)},`, `${"a".repeat(32)},${"a".repeat(32)}`, Array.from({ length: 9 }, (_, index) => String.fromCharCode(97 + index).repeat(32)).join(",")]) {
    assert.throws(() => readConfig({ ...env, TVR_EXTENSION_IDS: value }, interfaces));
  }
  assert.throws(() => readConfig({ ...env, TVR_EXTENSION_ID: "a".repeat(32) }, interfaces), /擇一/);
  assert.throws(() => readConfig({ ...env, TVR_EXTENSION_TOKEN: token }, interfaces), /不同 Token/);
});

test("normal CLI startup locates root .env from server cwd and honors an environment Port override", async t => {
  let host = Object.values(networkInterfaces()).flat().find(item => item.family === "IPv4" && !item.internal && isPrivateIPv4(item.address))?.address;
  assert.ok(host, "啟動測試需要已配置的私人 IPv4。");
  let root = mkdtempSync(join(tmpdir(), "tvr-startup-"));
  let child;
  let exited;
  t.after(async () => {
    if (child?.exitCode === null) child.kill();
    if (exited) await exited;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("tvr-startup-"));
    rmSync(root, { recursive: true });
  });
  mkdirSync(join(root, "server/public"), { recursive: true });
  mkdirSync(join(root, "extension"));
  let files = ["server/server.js", "server/config.js", "server/bridge.js", "server/package.json", "extension/sites.js", "extension/volume-sender.js",
    ...["index.html", "style.css", "app.js", "controls.js"].map(name => `server/public/${name}`)];
  for (let name of files) copyFileSync(new URL(`../${name}`, import.meta.url), join(root, name));
  writeFileSync(join(root, ".env"), `TVR_HOST=${host}\nTVR_PAIRING_TOKEN=${token}\nTVR_PORT=1\n`);
  writeFileSync(join(root, "server/.env"), "TVR_HOST=0.0.0.0\n");
  let reservation = createTcpServer();
  await new Promise(resolve => reservation.listen(0, host, resolve));
  let port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TVR_") && key !== "NODE_OPTIONS"));
  child = spawn(process.execPath, [join(root, "server/server.js")], { cwd: join(root, "server"), env: { ...env, TVR_PORT: String(port) }, windowsHide: true });
  exited = new Promise(resolve => child.once("close", resolve));
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  await new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error("Server 啟動逾時。")), 4000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", () => { if (output.includes(`http://${host}:${port}`)) { clearTimeout(timer); resolve(); } });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("測試 Server 未正常啟動。")); });
  });
  assert.equal(output.includes(token), false);
  assert.equal((await fetch(`http://${host}:${port}/`)).status, 200);
  child.kill();
  await exited;
});
