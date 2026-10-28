importScripts("sites.js");
importScripts("server-client.js");

let REQUEST_TIMEOUT_MS = 4000;

function validateTarget(message) {
  if (!Number.isInteger(message.tabId) || message.tabId < 0) {
    throw new Error("分頁識別值無效，請重新選取。");
  }
  if (!TabVolumeSites.isSupportedUrl(message.url)) {
    throw new Error("頁面網址無效，請重新整理清單後選取。");
  }
  if (message.type === "set-mute" && typeof message.muted !== "boolean") throw new Error("靜音狀態必須是布林值。");
  if (message.type !== "get-state") {
    if (typeof message.pageId !== "string" || !message.pageId || message.pageId.length > 128) throw new Error("頁面識別資料無效，請重新選取。");
  }
  if (message.type === "set-volume") {
    if (!Number.isInteger(message.volume) || message.volume < 0 || message.volume > 100) {
      throw new Error("音量必須是 0～100 的整數。");
    }
  }
}

async function sendToPage(tabId, message) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("指令逾時，請重新選取分頁後再試。")), REQUEST_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function handleRequest(message, sender) {
  let popup = sender.url === chrome.runtime.getURL("popup.html") && !sender.tab;
  let options = sender.url === chrome.runtime.getURL("options.html");
  if (sender.id !== chrome.runtime.id || (!popup && !options)) {
    throw new Error("不允許此訊息來源。");
  }
  if (message?.type === "server-status") return remoteClient.status();
  if (options) {
    if (message?.type === "connection-settings") return remoteClient.settingsInfo();
    if (message?.type === "test-server") return remoteClient.test(message.settings);
    if (message?.type === "connect-server") return remoteClient.connect(message.settings);
    if (message?.type === "disconnect-server") { await remoteClient.disconnect(); return {}; }
    if (message?.type === "forget-server") { await remoteClient.forget(); return {}; }
    throw new Error("設定頁不接受媒體控制指令。");
  }
  return executeCommand(message);
}

async function executeCommand(message) {
  if (!message || !["list-tabs", "get-state", "set-volume", "set-mute"].includes(message.type)) {
    throw new Error("不支援的指令。");
  }
  if (message.type === "list-tabs") {
    let tabs = await chrome.tabs.query({ url: TabVolumeSites.matches });
    return { tabs: tabs.filter(tab => TabVolumeSites.isSupportedUrl(tab.url)).map(tab => ({
      id: tab.id, title: tab.title || TabVolumeSites.siteForUrl(tab.url).name, url: tab.url
    })) };
  }

  validateTarget(message);
  if (message.expiresAt !== undefined && (!Number.isFinite(message.expiresAt) || Date.now() >= message.expiresAt)) throw new Error("指令已逾時。");
  let tab;
  try {
    tab = await chrome.tabs.get(message.tabId);
  } catch {
    throw new Error("目標分頁已關閉或無法存取，請重新整理清單。");
  }
  if (!TabVolumeSites.isSupportedUrl(tab.url) || tab.pendingUrl || tab.status === "loading") {
    throw new Error("目標不在支援的網站，或仍在載入，請稍後重新選取。");
  }
  // Bind the initial read to the URL shown in the list, not whichever page now occupies this tab.
  if (tab.url !== message.url) {
    throw new Error("目標頁面已變更，請重新整理清單後選取。");
  }

  let result;
  try {
    result = await sendToPage(tab.id, {
      type: message.type,
      volume: message.volume,
      muted: message.muted,
      pageId: message.pageId,
      url: tab.url,
      // A delayed delivery must not execute after the UI has timed out.
      expiresAt: Math.min(message.expiresAt ?? Infinity, Date.now() + REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error.message.includes("指令逾時")) throw error;
    throw new Error("無法連接頁面。請允許該網站存取權，並重新整理該分頁。");
  }
  if (!result?.ok) throw new Error(result?.error || "頁面未回傳有效的執行結果。");
  if (result.url !== message.url || (message.pageId !== undefined && result.pageId !== message.pageId)) throw new Error("回傳的頁面與選取目標不一致。");
  return { ...result, title: (result.title || TabVolumeSites.siteForUrl(tab.url).name).slice(0, 300), tabId: tab.id, browserMuted: Boolean(tab.mutedInfo?.muted) };
}

async function listControllableTabs() {
  let { tabs } = await executeCommand({ type: "list-tabs" });
  let states = await Promise.all(tabs.slice(0, 50).map(async tab => {
    try { return await executeCommand({ type: "get-state", tabId: tab.id, url: tab.url }); } catch { return null; }
  }));
  return states.filter(Boolean);
}

let remoteClient = createServerClient({ execute: executeCommand, listTabs: listControllableTabs });
function invalidatePage(tabId, url) {
  remoteClient.invalidate();
  chrome.tabs.sendMessage(tabId, { type: "invalidate-page", url, expiresAt: Date.now() + REQUEST_TIMEOUT_MS }, { frameId: 0 })
    .catch(() => {})
    // A snapshot read can race a delayed content message; collect again after revocation completes.
    .finally(() => remoteClient.invalidate());
}
chrome.alarms?.onAlarm?.addListener(alarm => { if (alarm.name === "remote-reconnect") remoteClient.restore().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => remoteClient.restore().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => remoteClient.restore().catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.url !== undefined || changes.title !== undefined || changes.status === "loading") {
    if (changes.url) invalidatePage(tabId, changes.url);
    else remoteClient.invalidate();
  }
});
chrome.tabs.onRemoved.addListener(() => remoteClient.invalidate());
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0 || !TabVolumeSites.isSupportedUrl(details.url)) return;
  // Also revoke identity when pushState/replaceState keeps the same URL.
  invalidatePage(details.tabId, details.url);
});
remoteClient.restore().catch(() => {});

// Register synchronously on every worker start; local popup routing needs no saved selection.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRequest(message, sender)
    .then(result => sendResponse({ ...result, ok: true }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
