(() => {
  // A new document gets a new identity; nothing is persisted across refreshes.
  let pageId = crypto.randomUUID();
  let pageUrl = location.href;
  let navigating = false;
  function invalidate() { pageId = crypto.randomUUID(); pageUrl = location.href; }
  // YouTube changes documents in place. Revoke identity even for A → B → A navigation.
  document.addEventListener("yt-navigate-start", () => { navigating = true; invalidate(); });
  document.addEventListener("yt-navigate-finish", () => { navigating = false; invalidate(); });
  window.addEventListener("popstate", invalidate);
  window.addEventListener("hashchange", invalidate);

  function handleMessage(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.tab) {
      throw new Error("不允許此訊息來源。");
    }
    if (!message || !["get-state", "set-volume", "set-mute", "invalidate-page"].includes(message.type)) {
      throw new Error("不支援的指令。");
    }
    if (!Number.isFinite(message.expiresAt) || Date.now() >= message.expiresAt) {
      throw new Error("指令已逾時，請重新操作。");
    }
    if (pageUrl !== location.href) invalidate();
    if (message.type === "invalidate-page" && message.url === location.href) { invalidate(); return { ok: true }; }
    if (navigating || !TabVolumeSites.isSupportedUrl(location.href) || message.url !== location.href
        || (message.pageId !== undefined && message.pageId !== pageId)
        || (message.type !== "get-state" && message.pageId !== pageId)) {
      throw new Error("目標頁面已變更，請重新選取。");
    }
    if (message.type === "set-volume"
        && (!Number.isInteger(message.volume) || message.volume < 0 || message.volume > 100)) {
      throw new Error("音量必須是 0～100 的整數。");
    }
    if (message.type === "set-mute" && typeof message.muted !== "boolean") throw new Error("靜音狀態必須是布林值。");

    let media = [...document.querySelectorAll("video, audio")];
    if (!media.length) throw new Error("頁面主框架沒有可控制的媒體。請先播放影片；若播放器位於 iframe，需先確認其來源與路由支援。");
    if (message.type === "set-volume") {
      let volume = message.volume / 100;
      try {
        for (let element of media) element.volume = volume;
      } catch {
        throw new Error("媒體拒絕套用音量，部分元素可能已變更。");
      }
      if (media.some(element => Math.abs(element.volume - volume) > 0.000001)) {
        throw new Error("部分媒體未能套用音量，請重試。");
      }
    }
    if (message.type === "set-mute") {
      try { for (let element of media) element.muted = message.muted; } catch { throw new Error("媒體拒絕套用靜音。"); }
      if (media.some(element => element.muted !== message.muted)) throw new Error("部分媒體未能套用靜音。");
    }
    return {
      ok: true,
      applied: message.type !== "get-state",
      pageId,
      url: location.href,
      title: document.title || TabVolumeSites.siteForUrl(location.href).name,
      volume: Math.round(media[0].volume * 100),
      mixed: media.some(element => element.volume !== media[0].volume),
      mediaMuted: media.some(element => element.muted),
      muted: media.some(element => element.muted),
      mixedMuted: media.some(element => element.muted !== media[0].muted),
      mediaCount: media.length
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      sendResponse(handleMessage(message, sender));
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "無法套用媒體音量。" });
    }
  });
})();
