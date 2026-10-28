let tabsSelect = document.querySelector("#tabs");
let refreshButton = document.querySelector("#refresh");
let selectedText = document.querySelector("#selected");
let volumeSlider = document.querySelector("#volume");
let percentage = document.querySelector("#percentage");
let statusText = document.querySelector("#status");
let muteButton = document.querySelector("#mute");
let muted = false;
let muting = false;
let muteVersion = 0;
let selected = null;
let volumeSender = null;
let selectionVersion = 0;

function showStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.dataset.error = String(isError);
}

async function request(message) {
  let result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "擴充功能未回應，請關閉後重新開啟。");
  return result;
}

function resetSelection() {
  selectionVersion += 1;
  volumeSender?.cancel();
  volumeSender = null;
  selected = null;
  volumeSlider.disabled = true;
  muteButton.disabled = true;
  muteButton.textContent = "靜音";
  muting = false;
  muteVersion += 1;
  percentage.textContent = "—";
  selectedText.textContent = "尚未選取分頁";
}

function invalidateSelection(message) {
  resetSelection();
  tabsSelect.value = "";
  showStatus(message, true);
}

function tabLabel(tab) {
  return `${tab.title || "媒體頁面"} — ${tab.url}（ID：${tab.id}）`;
}

async function loadTabs() {
  resetSelection();
  tabsSelect.disabled = true;
  refreshButton.disabled = true;
  tabsSelect.replaceChildren(new Option("請選取分頁", ""));
  showStatus("正在取得分頁…");
  try {
    let { tabs } = await request({ type: "list-tabs" });
    for (let tab of tabs) {
      let option = new Option(tabLabel(tab), String(tab.id));
      option.title = tab.url;
      tabsSelect.add(option);
    }
    tabsSelect.disabled = tabs.length === 0;
    showStatus(tabs.length ? "請選取要控制的網站分頁。" : "沒有支援的網站分頁，請先開啟 YouTube、Twitch 或 Hami Video。");
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
}

function mutedNote(state) {
  return state.mediaMuted || state.browserMuted ? " 目標目前含有靜音狀態，本操作不解除靜音。" : "";
}

function renderMute(state) {
  muted = Boolean(state.muted ?? state.mediaMuted);
  muteButton.textContent = muted ? "解除靜音" : "靜音";
  muteButton.disabled = muting || !selected;
}

async function selectTab() {
  resetSelection();
  if (!tabsSelect.value) {
    showStatus("請選取要控制的網站分頁。");
    return;
  }
  let version = selectionVersion;
  let tabId = Number(tabsSelect.value);
  let option = tabsSelect.selectedOptions[0];
  let url = option.title;
  showStatus("正在讀取媒體音量…");
  try {
    let state = await request({ type: "get-state", tabId, url });
    if (version !== selectionVersion) return;
    if (state.tabId !== tabId || state.url !== url) {
      throw new Error("回傳的頁面與選取目標不一致，請重新整理清單後選取。");
    }
    let target = { tabId, pageId: state.pageId, url: state.url };
    selected = target;
    // Display the same verified snapshot used for routing, never the stale list text.
    option.textContent = tabLabel({ id: tabId, title: state.title, url: state.url });
    selectedText.textContent = `${state.title || "媒體頁面"}\n${state.url}\n分頁 ID：${tabId}`;
    volumeSlider.value = state.volume;
    percentage.textContent = `${state.volume}%`;
    volumeSlider.disabled = false;
    renderMute(state);
    showStatus(`已連接，找到 ${state.mediaCount} 個媒體。${state.mixed ? " 音量不同，滑桿顯示第一個媒體；調整時會全部套用。" : ""}${mutedNote(state)}`);
    volumeSender = createVolumeSender(async volume => {
      let expectedMuteVersion = muteVersion;
      let result = await request({ type: "set-volume", ...target, volume });
      if (selected !== target) return;
      if (expectedMuteVersion === muteVersion) renderMute(result);
      showStatus(`已確認套用 ${result.volume}%（${result.mediaCount} 個媒體）。${mutedNote(result)}`);
    }, error => {
      if (selected !== target) return;
      invalidateSelection(error.message);
    });
  } catch (error) {
    if (version !== selectionVersion) return;
    invalidateSelection(error.message);
  }
}

// Events also invalidate an unfinished state read and discard queued slider values.
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (String(tabId) !== tabsSelect.value) return;
  if (changes.url !== undefined || changes.title !== undefined || changes.status === "loading") {
    invalidateSelection("目標頁面已變更，請重新整理清單後選取。");
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (String(tabId) === tabsSelect.value) {
    invalidateSelection("目標分頁已關閉，請重新整理清單後選取。");
  }
});
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId === 0 && String(details.tabId) === tabsSelect.value) {
    invalidateSelection("目標頁面已切換內容，請重新整理清單後選取。");
  }
});

tabsSelect.addEventListener("change", selectTab);
refreshButton.addEventListener("click", loadTabs);
volumeSlider.addEventListener("input", () => {
  percentage.textContent = `${volumeSlider.value}%`;
  showStatus(`正在套用 ${volumeSlider.value}%…`);
  volumeSender?.push(Number(volumeSlider.value));
});
// A native range emits change on committed pointer and keyboard changes, including the final drag value.
volumeSlider.addEventListener("change", () => volumeSender?.flush(Number(volumeSlider.value)));
window.addEventListener("pagehide", () => volumeSender?.cancel());
muteButton.addEventListener("click", async () => {
  if (!selected || muting) return;
  let target = selected;
  muteVersion += 1;
  muting = true;
  muteButton.disabled = true;
  showStatus("等待頁面確認靜音狀態…");
  try {
    let result = await request({ type: "set-mute", ...target, muted: !muted });
    if (selected !== target) return;
    renderMute(result);
    showStatus(result.muted ? "已確認媒體靜音。" : "已確認媒體解除靜音。");
  } catch (error) { if (selected === target) invalidateSelection(error.message); }
  finally { if (selected === target) { muting = false; muteButton.disabled = false; } }
});
loadTabs();
