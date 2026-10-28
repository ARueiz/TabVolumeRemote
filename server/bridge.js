import { randomUUID } from "node:crypto";
import sitePolicy from "../extension/sites.js";

let LEASE_MS = 20000;
let COMMAND_MS = 8000;
let RESULT_MS = 60000;
let MAX_RECORDS = 512;
let MAX_PENDING = 64;
let TARGET_FIELDS = ["extensionSessionId", "tabId", "pageId", "url"];

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function text(value, max) { return typeof value === "string" && value.length > 0 && value.length <= max; }

export function validPage(value) {
  if (!value || !Number.isSafeInteger(value.tabId) || value.tabId < 0
      || !text(value.pageId, 128) || !text(value.url, 2048)) return false;
  return sitePolicy.isSupportedUrl(value.url);
}

function validState(value, target) {
  return validPage(value) && value.tabId === target.tabId && value.pageId === target.pageId && value.url === target.url
    && text(value.title, 300) && Number.isInteger(value.volume) && value.volume >= 0 && value.volume <= 100
    && typeof value.muted === "boolean" && typeof value.browserMuted === "boolean"
    && typeof value.mixed === "boolean" && typeof value.mixedMuted === "boolean"
    && Number.isInteger(value.mediaCount) && value.mediaCount > 0 && value.mediaCount <= 1000;
}

function pageState(value) {
  let { tabId, pageId, url, title, volume, muted, browserMuted, mixed, mixedMuted, mediaCount } = value;
  return { tabId, pageId, url, title, volume, muted, browserMuted, mixed, mixedMuted, mediaCount };
}

function sameTarget(a, b) { return TARGET_FIELDS.every(field => a[field] === b[field]); }

export function createBridge(now = Date.now) {
  let extension = null;
  let records = new Map();

  function finish(record, status, message) {
    record.status = status;
    record.message = message;
    record.finishedAt = now();
  }

  function dropConnection() {
    if (!extension) return;
    for (let record of records.values()) {
      if (record.extensionSessionId !== extension.id) continue;
      if (record.status === "queued") finish(record, "expired", "瀏覽器連線已失效，指令未執行。");
      if (record.status === "delivered") finish(record, "unknown", "瀏覽器連線中斷，執行結果未確認。");
    }
    extension.waiter?.();
    extension = null;
  }

  function prune() {
    if (extension && now() - extension.lastSeen >= LEASE_MS) dropConnection();
    for (let [id, record] of records) {
      if (["queued", "delivered"].includes(record.status) && now() >= record.expiresAt) {
        finish(record, record.status === "queued" ? "expired" : "unknown", "指令逾時，未取得套用確認。");
      }
      if (record.finishedAt !== undefined && now() - record.finishedAt >= RESULT_MS) records.delete(id);
    }
  }

  function requireExtension(id, browserId) {
    prune();
    if (!extension || extension.id !== id || (browserId !== undefined && extension.browserId !== browserId)) fail(409, "EXTENSION_SESSION_EXPIRED", "擴充功能連線已失效或不屬於此瀏覽器，請重新註冊。");
    extension.lastSeen = now();
    return extension;
  }

  function register(clientId, browserId) {
    prune();
    if (!text(clientId, 128)) fail(400, "INVALID_CLIENT", "擴充功能識別資料無效。");
    if (extension && (extension.clientId !== clientId || extension.browserId !== browserId)) fail(409, "EXTENSION_IN_USE", "已有其他擴充功能連線，請先中斷或等待連線到期。");
    dropConnection();
    extension = { id: randomUUID(), clientId, browserId, lastSeen: now(), tabs: [], waiter: null };
    return { extensionSessionId: extension.id, leaseMs: LEASE_MS };
  }

  function reportTabs(id, tabs) {
    let current = requireExtension(id);
    if (!Array.isArray(tabs) || tabs.length > 50 || tabs.some(tab => !validState(tab, tab))
        || new Set(tabs.map(tab => tab.tabId)).size !== tabs.length) {
      fail(400, "INVALID_TABS", "分頁回報無效，最多允許 50 個已驗證的媒體分頁。");
    }
    current.tabs = tabs.map(pageState);
    for (let record of records.values()) {
      if (record.status === "queued" && !current.tabs.some(tab => sameTarget({ ...tab, extensionSessionId: id }, record))) {
        finish(record, "failed", "目標頁面已變更或關閉，請重新選取。");
      }
    }
    current.waiter?.();
  }

  function listTabs() {
    prune();
    return {
      extensionConnected: Boolean(extension),
      tabs: extension ? extension.tabs.map(tab => ({ ...tab, extensionSessionId: extension.id })) : [],
      message: extension ? "已連接瀏覽器" : "尚未連接瀏覽器"
    };
  }

  function enqueue(owner, type, target) {
    prune();
    if (!["get-state", "set-volume", "set-mute"].includes(type)) fail(400, "INVALID_COMMAND", "不支援的指令。");
    if (!extension) fail(503, "BROWSER_DISCONNECTED", "尚未連接瀏覽器，無法執行控制。");
    if (!validPage(target) || !text(target.extensionSessionId, 128)) fail(400, "INVALID_TARGET", "請提供完整的頁面識別資料。");
    if (target.extensionSessionId !== extension.id) fail(409, "STALE_TARGET", "瀏覽器已重新連線，請重新選取分頁。");
    let tab = extension.tabs.find(tab => tab.tabId === target.tabId);
    if (!tab) fail(404, "TAB_NOT_FOUND", "找不到目標分頁，請重新整理清單。");
    if (!sameTarget({ ...tab, extensionSessionId: extension.id }, target)) fail(409, "STALE_TARGET", "目標頁面已變更，請重新選取。");
    if (records.size >= MAX_RECORDS) fail(429, "COMMAND_LIMIT", "指令紀錄已達上限，請稍後再試。");
    // Only commands not yet handed to the extension may be superseded, even across phone sessions.
    if (type === "set-volume") {
      for (let record of records.values()) {
        if (record.type === type && record.status === "queued" && sameTarget(record, target)) {
          finish(record, "superseded", "已由較新的音量值取代，舊值未執行。");
        }
      }
    }
    if ([...records.values()].filter(record => ["queued", "delivered"].includes(record.status)).length >= MAX_PENDING) {
      fail(429, "QUEUE_FULL", "待處理指令已達上限，請稍後再試。");
    }
    let commandId = randomUUID();
    let record = { commandId, owner, type, status: "queued", createdAt: now(), expiresAt: now() + COMMAND_MS };
    for (let field of TARGET_FIELDS) record[field] = target[field];
    if (type === "set-volume") record.volume = target.volume;
    if (type === "set-mute") record.muted = target.muted;
    records.set(commandId, record);
    extension.waiter?.();
    return { commandId, status: "queued" };
  }

  function take(id) {
    requireExtension(id);
    if ([...records.values()].some(record => record.status === "delivered" && record.extensionSessionId === id)) return null;
    let record = [...records.values()].find(record => record.status === "queued" && record.extensionSessionId === id);
    if (!record) return null;
    record.status = "delivered";
    record.deliveredAt = now();
    let { owner, status, ...command } = record;
    return command;
  }

  async function poll(id, signal, waitMs = 8000) {
    let current = requireExtension(id);
    if (current.waiter) fail(409, "POLL_IN_PROGRESS", "已存在等待中的長輪詢。");
    let command = take(id);
    if (command || signal.aborted) return command;
    await new Promise(resolve => {
      let timer;
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (current.waiter === done) current.waiter = null;
        resolve();
      }
      current.waiter = done;
      signal.addEventListener("abort", done, { once: true });
      timer = setTimeout(done, waitMs);
    });
    if (signal.aborted) return null;
    return take(id);
  }

  function reportResult(id, body) {
    let current = requireExtension(id);
    let record = records.get(body.commandId);
    if (!record || record.extensionSessionId !== id) fail(404, "COMMAND_NOT_FOUND", "找不到此指令。");
    if (["applied", "failed"].includes(record.status)) return;
    if (record.status !== "delivered") fail(409, "COMMAND_FINISHED", "指令已結束或尚未交付，不能修改結果。");
    if (body.status === "failed" && text(body.message, 300)) {
      finish(record, "failed", body.message);
    } else if (body.status === "applied" && validState(body.result, record)
        && (record.type === "get-state" || body.result.applied === true)
        && (record.type !== "set-volume" || body.result.volume === record.volume)
        && (record.type !== "set-mute" || (body.result.muted === record.muted && !body.result.mixedMuted))) {
      record.result = { ...pageState(body.result), applied: body.result.applied === true };
      finish(record, "applied", record.type === "get-state" ? "已確認頁面狀態。" : "頁面已確認套用。");
      let index = current.tabs.findIndex(tab => sameTarget({ ...tab, extensionSessionId: id }, record));
      if (index >= 0) current.tabs[index] = pageState(body.result);
    } else {
      fail(400, "INVALID_RESULT", "執行結果與目標或要求值不符。");
    }
  }

  function result(owner, id) {
    prune();
    let record = records.get(id);
    if (!record || record.owner !== owner) fail(404, "COMMAND_NOT_FOUND", "找不到此工作階段的指令。");
    let { commandId, status, message, result, createdAt, deliveredAt, finishedAt } = record;
    return { commandId, status, message, result, timings: { queuedAt: createdAt, deliveredAt, finishedAt, confirmedAt: status === "applied" ? finishedAt : undefined } };
  }

  function cancelOwner(owner) {
    for (let record of records.values()) if (record.owner === owner && record.status === "queued") finish(record, "expired", "手機工作階段已失效。");
  }

  return { register, reportTabs, listTabs, enqueue, poll, reportResult, result, cancelOwner,
    authenticate: requireExtension,
    disconnect(id) { requireExtension(id); dropConnection(); },
    close() { dropConnection(); records.clear(); }
  };
}
