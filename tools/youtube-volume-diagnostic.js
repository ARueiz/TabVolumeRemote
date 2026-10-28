// Paste into YouTube's main-frame DevTools Console. No media writes or network requests.
(() => {
  if (location.origin !== "https://www.youtube.com") throw new Error("請在 YouTube 主框架執行此診斷。");
  globalThis.tabVolumeDiagnostic?.stop();
  let started = performance.now();
  let rows = [];
  let identities = new WeakMap();
  let nextId = 0;
  let media = new Set();
  let handlers = new Map();
  let previousUrl = location.href;
  let mediaEvents = ["volumechange", "loadstart", "loadedmetadata", "emptied"];
  let navigationEvents = ["yt-navigate-start", "yt-navigate-finish", "popstate", "hashchange"];

  function id(element) {
    if (!identities.has(element)) identities.set(element, ++nextId);
    return identities.get(element);
  }
  function sample(type, element, event) {
    let playerVolume = null;
    try {
      let player = document.getElementById("movie_player");
      if (typeof player?.getVolume === "function") playerVolume = player.getVolume();
    } catch { /* Main-site player methods are not a documented stable API. */ }
    rows.push({ elapsedMs: Math.round(performance.now() - started), type,
      eventMediaId: element ? id(element) : null, isTrusted: event ? event.isTrusted : null,
      urlChanged: location.href !== previousUrl, playerVolume,
      media: [...media].map(item => ({ id: id(item), volume: Math.round(item.volume * 100), muted: item.muted, readyState: item.readyState })) });
    previousUrl = location.href;
    if (rows.length > 200) rows.shift();
  }
  function refresh() {
    let next = new Set(document.querySelectorAll("video,audio"));
    if (next.size === media.size && [...next].every(element => media.has(element))) return;
    for (let element of media) {
      if (next.has(element)) continue;
      for (let type of mediaEvents) element.removeEventListener(type, handlers.get(element));
      handlers.delete(element);
    }
    for (let element of next) {
      if (media.has(element)) continue;
      let handler = event => sample(event.type, element, event);
      handlers.set(element, handler);
      for (let type of mediaEvents) element.addEventListener(type, handler);
    }
    media = next;
    sample("media-set-changed");
  }
  function navigation(event) { refresh(); sample(event.type, null, event); }
  let observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  for (let type of navigationEvents) window.addEventListener(type, navigation, true);
  refresh();
  sample("start");
  globalThis.tabVolumeDiagnostic = {
    mark() { refresh(); sample("manual"); },
    report() { return JSON.parse(JSON.stringify(rows)); },
    stop() {
      observer.disconnect();
      for (let type of navigationEvents) window.removeEventListener(type, navigation, true);
      for (let [element, handler] of handlers) for (let type of mediaEvents) element.removeEventListener(type, handler);
      handlers.clear();
      sample("stop");
    }
  };
  return "唯讀診斷已啟動；tabVolumeDiagnostic.mark() 標記、report() 讀取、stop() 停止。";
})();
