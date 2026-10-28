function createRemoteControls(api, showMessage) {
  let select = document.querySelector("#tabs");
  let slider = document.querySelector("#volume");
  let percentage = document.querySelector("#percentage");
  let mute = document.querySelector("#mute");
  let description = document.querySelector("#selected");
  let latency = document.querySelector("#latency");
  let browser = document.querySelector("#browser-status");
  let tabs = new Map();
  let selected = null;
  let candidate = null;
  let sender = null;
  let version = 0;
  let muting = false;
  let key = tab => `${tab.extensionSessionId}:${tab.tabId}`;
  let same = (a, b) => ["extensionSessionId", "tabId", "pageId", "url", "title"].every(field => a[field] === b[field]);

  function reset() {
    version += 1;
    sender?.cancel();
    sender = null;
    selected = null;
    candidate = null;
    muting = false;
    slider.disabled = true;
    mute.disabled = true;
    mute.textContent = "靜音";
    percentage.textContent = "—";
    description.textContent = "尚未選取分頁";
    latency.textContent = "";
    select.value = "";
  }

  function fail(error) {
    reset();
    showMessage(error.message, true);
  }

  function renderMute(result) {
    mute.textContent = result.muted ? "解除靜音" : "靜音";
    mute.disabled = muting || !selected;
  }

  async function perform(path, target, values, expectedVersion) {
    let started = performance.now();
    let { extensionSessionId, tabId, pageId, url } = target;
    let ticket = await api(path, { extensionSessionId, tabId, pageId, url, ...values });
    if (ticket.status !== "queued" || typeof ticket.commandId !== "string") throw new Error("Server 未接受指令。");
    while (expectedVersion === version && performance.now() - started < 12000) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (expectedVersion !== version) break;
      let result = await api(`/api/commands/${ticket.commandId}`);
      if (["queued", "delivered"].includes(result.status)) continue;
      if (result.status !== "applied") throw new Error(result.message || `指令未確認套用（${result.status}）。`);
      let state = result.result;
      if (!state || state.tabId !== tabId || state.pageId !== pageId || state.url !== url
          || (path !== "/api/state" && state.applied !== true)) throw new Error("頁面沒有回傳符合目標的套用確認。");
      return { state, elapsed: Math.round(performance.now() - started) };
    }
    throw new Error("指令已取消或逾時，結果未確認；不會自動重送。");
  }

  function confirmed(result, text) {
    renderMute(result.state);
    latency.textContent = `上次確認耗時：${result.elapsed} ms`;
    showMessage(text + (result.state.browserMuted ? " 瀏覽器分頁本身仍為靜音。" : ""));
  }

  select.addEventListener("change", async () => {
    let target = tabs.get(select.value);
    reset();
    if (!target) return;
    candidate = target;
    select.value = key(target);
    let expectedVersion = version;
    showMessage("正在確認目標頁面…");
    try {
      let result = await perform("/api/state", target, {}, expectedVersion);
      if (expectedVersion !== version) return;
      selected = target;
      candidate = null;
      description.textContent = `${result.state.title}\n${result.state.url}\n分頁 ID：${target.tabId}`;
      slider.value = result.state.volume;
      percentage.textContent = `${result.state.volume}%`;
      slider.disabled = false;
      renderMute(result.state);
      showMessage(`已確認目標，找到 ${result.state.mediaCount} 個媒體。${result.state.mixed ? " 目前音量不同，顯示第一個媒體的值。" : ""}`);
      sender = createVolumeSender(async volume => {
        let result = await perform("/api/volume", target, { volume }, expectedVersion);
        if (selected === target && expectedVersion === version) confirmed(result, `已套用 ${result.state.volume}%。`);
      }, error => { if (selected === target && expectedVersion === version) fail(error); });
    } catch (error) { if (expectedVersion === version) fail(error); }
  });

  slider.addEventListener("input", () => {
    if (!selected || slider.disabled) return;
    percentage.textContent = `${slider.value}%`;
    showMessage(`等待套用 ${slider.value}%…`);
    sender.push(Number(slider.value));
  });
  slider.addEventListener("change", () => {
    if (selected && !slider.disabled) sender.flush(Number(slider.value));
  });
  mute.addEventListener("click", async () => {
    if (!selected || muting) return;
    let target = selected;
    let expectedVersion = version;
    let muted = mute.textContent === "靜音";
    muting = true;
    mute.disabled = true;
    showMessage("等待頁面確認靜音狀態…");
    try {
      let result = await perform("/api/mute", target, { muted }, expectedVersion);
      if (selected === target && expectedVersion === version) confirmed(result, result.state.muted ? "媒體已靜音。" : "媒體已解除靜音。");
    } catch (error) { if (selected === target && expectedVersion === version) fail(error); }
    finally { if (expectedVersion === version) { muting = false; mute.disabled = !selected; } }
  });

  return {
    reset,
    active: () => Boolean(selected || candidate),
    update(snapshot) {
      let next = new Map((snapshot.tabs || []).map(tab => [key(tab), tab]));
      let target = selected || candidate;
      let invalidated = Boolean(target && (!snapshot.extensionConnected || !next.has(key(target)) || !same(target, next.get(key(target)))));
      if (invalidated) { reset(); showMessage("目標頁面或瀏覽器連線已變更，請重新選取。", true); }
      tabs = next;
      let value = select.value;
      select.replaceChildren(new Option(snapshot.extensionConnected ? "請選取分頁" : "尚未連接瀏覽器", ""));
      for (let tab of tabs.values()) select.add(new Option(`${tab.title}（ID：${tab.tabId}） — ${tab.url}`, key(tab)));
      select.value = value;
      select.disabled = !snapshot.extensionConnected || !tabs.size;
      browser.textContent = snapshot.extensionConnected ? "已連接瀏覽器" : "尚未連接瀏覽器";
      return invalidated;
    }
  };
}
