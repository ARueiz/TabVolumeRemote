let form = document.querySelector("#connection-form");
let serverUrlInput = document.querySelector("#server-url");
let tokenInput = document.querySelector("#server-token");
let tokenHint = document.querySelector("#token-hint");
let actionStatus = document.querySelector("#action-status");
let connectionStatus = document.querySelector("#connection-status");
let buttons = [...document.querySelectorAll("button")];
document.querySelector("#extension-id").textContent = chrome.runtime.id;
let busy = false;

async function settingsRequest(message) {
  let result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "擴充功能未回應。");
  return result;
}
function showAction(text, error = false) {
  actionStatus.textContent = text;
  actionStatus.dataset.error = String(error);
}
async function loadSettings() {
  let settings = await settingsRequest({ type: "connection-settings" });
  if (!serverUrlInput.value) serverUrlInput.value = settings.serverUrl;
  tokenHint.textContent = settings.hasToken ? "Token 已儲存；留白會保留原值，更換 Server 位址時須重新輸入。" : "第一次設定請填入 Token。";
  tokenInput.placeholder = settings.hasToken ? "已儲存（不顯示）" : "43 字元的擴充功能 Token";
}
async function refreshStatus() {
  try {
    let state = await settingsRequest({ type: "server-status" });
    connectionStatus.textContent = state.message;
    let c = state.compatibility;
    if (c) document.querySelector("#compatibility").textContent = `MV3：${c.manifestV3 ? "可用" : "待確認"}；storage.local：${c.storageLocal ? "可用" : "缺少"}；alarms：${c.alarms ? "可用" : "缺少"}`;
  } catch { connectionStatus.textContent = "無法取得連線狀態。"; }
}
async function act(type) {
  if (busy) return;
  busy = true;
  buttons.forEach(button => { button.disabled = true; });
  try {
    let settings;
    if (["test-server", "connect-server"].includes(type)) {
      let serverUrl = privateServerOrigin(serverUrlInput.value.trim());
      let token = tokenInput.value.trim();
      if (token && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Token 格式無效，應為 43 字元。");
      // Request optional permission directly from this button's user gesture.
      if (!await chrome.permissions.request({ origins: [`http://${new URL(serverUrl).hostname}/*`] })) throw new Error("未取得指定 Server 的網站權限。");
      settings = { serverUrl, token };
    }
    let result = await settingsRequest({ type, settings });
    if (type === "test-server") showAction(`${result.message} 尚未儲存本次變更。`);
    else {
      tokenInput.value = "";
      if (type === "forget-server") serverUrlInput.value = "";
      await loadSettings();
      showAction(type === "connect-server" ? "設定已儲存，正在確認背景連線。" : type === "forget-server" ? "已清除設定。" : "已中斷連線，設定仍保留。");
    }
    await refreshStatus();
  } catch (error) { showAction(error.message, true); }
  finally { busy = false; buttons.forEach(button => { button.disabled = false; }); }
}
form.addEventListener("submit", event => { event.preventDefault(); act("connect-server"); });
document.querySelector("#test-server").addEventListener("click", () => act("test-server"));
document.querySelector("#disconnect-server").addEventListener("click", () => act("disconnect-server"));
document.querySelector("#forget-server").addEventListener("click", () => act("forget-server"));
loadSettings().catch(error => showAction(error.message, true));
refreshStatus();
setInterval(refreshStatus, 2000);
