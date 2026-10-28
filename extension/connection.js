document.querySelector("#open-settings").addEventListener("click", async () => {
  try { await chrome.runtime.openOptionsPage(); }
  catch { document.querySelector("#connection-status").textContent = "無法開啟設定頁，請從擴充功能管理頁開啟。"; }
});

async function refreshConnection() {
  let status = document.querySelector("#connection-status");
  try {
    let result = await chrome.runtime.sendMessage({ type: "server-status" });
    status.textContent = result?.ok ? result.message : "無法取得連線狀態。";
  } catch { status.textContent = "無法取得連線狀態。"; }
}
refreshConnection();
setInterval(refreshConnection, 2000);
