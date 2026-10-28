let pairForm = document.querySelector("#pair-form");
let tokenInput = document.querySelector("#token");
let pairButton = document.querySelector("#pair");
let logoutButton = document.querySelector("#logout");
let refreshButton = document.querySelector("#refresh");
let connection = document.querySelector("#connection");
let message = document.querySelector("#message");
let paired = false;
let busy = false;
let controls = createRemoteControls(api, showMessage);

function showMessage(text, isError = false) {
  message.textContent = text;
  message.dataset.error = String(isError);
}

function setPaired(value) {
  paired = value;
  pairForm.hidden = value;
  logoutButton.hidden = !value;
  if (!value) { controls.reset(); controls.update({ extensionConnected: false, tabs: [] }); }
}

async function api(path, body) {
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), 5000);
  try {
    let response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "same-origin",
      signal: controller.signal,
      headers: { "X-TVR-Client": "mobile", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let result = await response.json();
    if (!response.ok) {
      let error = new Error(result.error?.message || "請求失敗。");
      error.status = response.status;
      if (response.status === 429) error.message += ` 約 ${response.headers.get("Retry-After") || "數十"} 秒後再試。`;
      throw error;
    }
    return result;
  } catch (error) {
    if (error.status) throw error;
    throw new Error("無法連接伺服器，請確認電腦已啟動服務，且手機與電腦位於同一內網。");
  } finally {
    clearTimeout(timer);
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  refreshButton.disabled = true;
  pairButton.disabled = true;
  logoutButton.disabled = true;
  try {
    let snapshot = await api("/api/tabs");
    setPaired(true);
    connection.textContent = "已連接伺服器";
    let invalidated = controls.update(snapshot);
    if (!controls.active() && !invalidated) showMessage(snapshot.extensionConnected ? "請選取要控制的分頁。" : "尚未連接瀏覽器，目前無法執行控制。");
  } catch (error) {
    if (error.status === 401) {
      let wasPaired = paired;
      setPaired(false);
      connection.textContent = "已連接伺服器，尚未配對";
      showMessage(wasPaired ? "工作階段已失效，請重新配對。" : "請輸入 Token 完成配對。");
    } else {
      controls.reset();
      controls.update({ extensionConnected: false, tabs: [] });
      connection.textContent = "連線失敗";
      showMessage(error.message, true);
    }
  } finally {
    busy = false;
    refreshButton.disabled = false;
    pairButton.disabled = false;
    logoutButton.disabled = false;
  }
}

pairForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  pairButton.disabled = true;
  refreshButton.disabled = true;
  try {
    let snapshot = await api("/api/pair", { token: tokenInput.value.trim() });
    setPaired(true);
    controls.update(snapshot);
    connection.textContent = "已連接伺服器";
    showMessage(snapshot.extensionConnected ? "手機已配對，請選取分頁。" : "手機已配對。尚未連接瀏覽器，目前無法執行控制。");
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    tokenInput.value = "";
    busy = false;
    pairButton.disabled = false;
    refreshButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  logoutButton.disabled = true;
  refreshButton.disabled = true;
  try {
    await api("/api/logout", {});
    setPaired(false);
    connection.textContent = "已連接伺服器，尚未配對";
    showMessage("已解除這支手機的配對。");
  } catch (error) {
    if (error.status === 401) setPaired(false);
    showMessage(error.message, true);
  } finally {
    busy = false;
    logoutButton.disabled = false;
    refreshButton.disabled = false;
  }
});

refreshButton.addEventListener("click", refresh);
// Status checks do not overlap and pause while the mobile page is hidden.
setInterval(() => { if (!document.hidden && paired) refresh(); }, 2000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
refresh();
