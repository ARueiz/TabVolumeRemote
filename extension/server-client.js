function privateServerOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Server 位址格式無效。"); }
  let parts = url.hostname.split(".");
  let [first, second] = parts.map(Number);
  if (url.protocol !== "http:" || parts.length !== 4 || parts.some(part => !/^\d+$/.test(part) || Number(part) > 255)
      || !(first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Server 必須是明確的私人 IPv4 HTTP 位址，可包含 Port，不可包含路徑或 Token。");
  }
  if (url.port === "0") throw new Error("Server Port 必須介於 1～65535。");
  return url.origin;
}

function createServerClient({ execute, listTabs }) {
  let current = null;
  let configurationVersion = 0;
  let state = { connected: false, message: "尚未設定 Server" };
  let alarmName = "remote-reconnect";
  let compatibility = {
    manifestV3: chrome.runtime.getManifest?.().manifest_version === 3,
    storageSession: Boolean(chrome.storage?.session?.get && chrome.storage.session.set && chrome.storage.session.remove),
    storageLocal: Boolean(chrome.storage?.local?.get && chrome.storage.local.set && chrome.storage.local.remove && chrome.storage.local.setAccessLevel),
    alarms: Boolean(chrome.alarms?.get && chrome.alarms.create && chrome.alarms.clear && chrome.alarms.onAlarm?.addListener),
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent
  };

  function requireCapabilities() {
    if (!compatibility.storageLocal || !compatibility.alarms) {
      throw new Error(`此瀏覽器缺少遠端連線所需 API：${!compatibility.storageLocal ? "chrome.storage.local " : ""}${!compatibility.alarms ? "chrome.alarms" : ""}。本機 popup 音量控制仍可使用。`);
    }
  }

  async function readSettings() {
    // storage.local defaults to content-script access. Restrict it before any secret read/write.
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    let { remoteSettings } = await chrome.storage.local.get("remoteSettings");
    if (remoteSettings) return remoteSettings;
    let legacy = compatibility.storageSession ? (await chrome.storage.session.get("remoteSettings")).remoteSettings : null;
    if (!legacy) return null;
    let serverUrl = privateServerOrigin(legacy.serverUrl);
    if (!/^[A-Za-z0-9_-]{43}$/.test(legacy.token || "") || typeof legacy.clientId !== "string" || !legacy.clientId) throw new Error("舊連線設定無效，請重新設定。");
    remoteSettings = { serverUrl, token: legacy.token, clientId: legacy.clientId, enabled: true, authFailed: Boolean(legacy.authFailed) };
    await chrome.storage.local.set({ remoteSettings });
    // Only remove the original after persistent storage succeeded.
    await chrome.storage.session.remove("remoteSettings");
    return remoteSettings;
  }

  async function prepare(settings) {
    requireCapabilities();
    let serverUrl = privateServerOrigin(settings?.serverUrl);
    let saved = await readSettings();
    let token = settings?.token || (saved?.serverUrl === serverUrl ? saved.token : "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || "")) throw new Error("請輸入 43 字元的擴充功能專用 Token；更換 Server 位址時需重新輸入。");
    if (!await chrome.permissions.contains({ origins: [`http://${new URL(serverUrl).hostname}/*`] })) throw new Error("尚未授權指定 Server 位址。");
    return { serverUrl, token, clientId: saved?.clientId || crypto.randomUUID(), enabled: true, authFailed: false };
  }

  async function api(run, path, body, session = true) {
    let controller = new AbortController();
    run.controller = controller;
    let timer = setTimeout(() => controller.abort(), 10000);
    try {
      let response = await fetch(run.settings.serverUrl + path, {
        method: body === undefined ? "GET" : "POST", credentials: "omit", redirect: "error", cache: "no-store",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${run.settings.token}`, "X-TVR-Client": "extension", "X-TVR-Extension-Id": chrome.runtime.id,
          ...(session ? { "X-TVR-Extension-Session": run.sessionId } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      let result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error?.message || "Server 請求失敗。"), { status: response.status });
      return result;
    } finally {
      clearTimeout(timer);
      if (run.controller === controller) run.controller = null;
    }
  }

  function update(run, changes) {
    if (current === run && !run.stopped) state = { ...state, ...changes };
  }

  async function synchronize(run) {
    let version = run.version;
    let tabs = await listTabs();
    if (run.stopped || version !== run.version) return false;
    await api(run, "/api/extension/tabs", { tabs: tabs.map(tab => ({
      tabId: tab.tabId, pageId: tab.pageId, url: tab.url, title: tab.title.slice(0, 300),
      volume: tab.volume, muted: tab.muted, browserMuted: tab.browserMuted,
      mixed: tab.mixed, mixedMuted: tab.mixedMuted, mediaCount: tab.mediaCount
    })) });
    if (version !== run.version) return false;
    run.dirty = false;
    run.lastSync = Date.now();
    return true;
  }

  async function report(run, body) {
    // Retrying the acknowledgement is safe; replaying the media command is not.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (run.stopped) return;
      try { await api(run, "/api/extension/results", body); return; } catch (error) {
        if (error.status === 409 || error.status === 404) return;
        if (error.status === 400 || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  }

  async function loop(run) {
    let retryMs = 1000;
    while (!run.stopped) {
      try {
        if (!run.sessionId) {
          let result = await api(run, "/api/extension/register", { clientId: run.settings.clientId }, false);
          if (run.stopped) return;
          run.sessionId = result.extensionSessionId;
          run.dirty = true;
        }
        if (run.dirty || Date.now() - run.lastSync >= 8000) {
          if (!await synchronize(run)) continue;
        }
        update(run, { connected: true, message: "已連接 Server", lastPollAt: Date.now() });
        run.polling = true;
        let envelope;
        try { envelope = await api(run, "/api/extension/commands"); } catch (error) {
          if (run.dirty && error.name === "AbortError") continue;
          throw error;
        } finally { run.polling = false; }
        if (run.stopped) return;
        let command = envelope.command;
        if (command) {
          if (command.extensionSessionId !== run.sessionId || !["get-state", "set-volume", "set-mute"].includes(command.type)
              || !Number.isFinite(command.expiresAt) || Date.now() >= command.expiresAt) {
            throw new Error("Server 傳回失效或不支援的指令。");
          }
          let body;
          try {
            let result = await execute(command);
            if (!result.ok || (command.type !== "get-state" && result.applied !== true)) throw new Error("頁面沒有確認套用。");
            body = { commandId: command.commandId, status: "applied", result };
          } catch (error) {
            body = { commandId: command.commandId, status: "failed", message: (error.message || "頁面執行失敗。").slice(0, 300) };
          }
          await report(run, body);
        }
        retryMs = 1000;
      } catch (error) {
        if (run.stopped) return;
        update(run, { connected: false, message: error.status ? error.message : "Server 連線中斷，正在重試。" });
        run.sessionId = null;
        if ([401, 403, 429].includes(error.status)) {
          run.stopped = true;
          await chrome.storage.local.set({ remoteSettings: { ...run.settings, authFailed: true } });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, retryMs));
        retryMs = Math.min(retryMs * 2, 30000);
      }
    }
  }

  async function restore() {
    try { requireCapabilities(); } catch (error) { state = { connected: false, message: error.message }; return; }
    if (current && !current.stopped) return;
    let expectedVersion = configurationVersion;
    let remoteSettings;
    try { remoteSettings = await readSettings(); } catch {
      state = { connected: false, message: "無法安全讀取或遷移連線設定，請開啟設定頁檢查。" };
      return;
    }
    if (!remoteSettings) return;
    if (!remoteSettings.enabled || remoteSettings.authFailed) {
      state = { connected: false, serverUrl: remoteSettings.serverUrl, message: remoteSettings.authFailed ? "認證或來源驗證失敗，請在設定頁測試並重新儲存。" : "已中斷 Server 連線，設定仍保留。" };
      return;
    }
    let settings = { ...remoteSettings, serverUrl: privateServerOrigin(remoteSettings.serverUrl) };
    if (!await chrome.permissions.contains({ origins: [`http://${new URL(settings.serverUrl).hostname}/*`] })) {
      state = { connected: false, message: "Server 網站權限已撤銷，請重新連線。" };
      return;
    }
    if (!await chrome.alarms.get(alarmName)) await chrome.alarms.create(alarmName, { periodInMinutes: 0.5 });
    let alarm = await chrome.alarms.get(alarmName);
    compatibility.alarmPeriodMinutes = alarm?.periodInMinutes ?? null;
    // Recheck after async setup: simultaneous wake events must not launch duplicate loops.
    if (expectedVersion !== configurationVersion || (current && !current.stopped)) return;
    let run = { settings, sessionId: null, stopped: false, dirty: true, version: 0, lastSync: 0, controller: null };
    current = run;
    state = { connected: false, serverUrl: settings.serverUrl, message: "正在連接 Server…", workerStartedAt: Date.now() };
    loop(run).catch(() => update(run, { connected: false, message: "連線處理失敗，請重新設定。" }));
  }

  async function stop() {
    configurationVersion += 1;
    let run = current;
    if (run) { run.stopped = true; run.controller?.abort(); }
    current = null;
    if (compatibility.alarms) await chrome.alarms.clear(alarmName);
    state = { connected: false, message: "已中斷 Server 連線" };
    if (run?.sessionId) {
      try { await api(run, "/api/extension/disconnect", {}); } catch { /* Lease expiry also revokes the session. */ }
    }
  }

  async function disconnect() {
    let settings = await readSettings();
    if (settings) await chrome.storage.local.set({ remoteSettings: { ...settings, enabled: false } });
    await stop();
  }

  return {
    restore,
    disconnect,
    async settingsInfo() {
      requireCapabilities();
      let settings = await readSettings();
      return { serverUrl: settings?.serverUrl || "", hasToken: Boolean(settings?.token), enabled: Boolean(settings?.enabled), extensionId: chrome.runtime.id };
    },
    async test(settings) {
      let candidate = await prepare(settings);
      return api({ settings: candidate }, "/api/extension/check", {}, false);
    },
    async forget() {
      requireCapabilities();
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      await chrome.storage.local.remove("remoteSettings");
      if (compatibility.storageSession) await chrome.storage.session.remove("remoteSettings");
      await stop();
      state = { connected: false, message: "已清除連線設定" };
    },
    async connect(settings) {
      let candidate = await prepare(settings);
      await disconnect();
      await chrome.storage.local.set({ remoteSettings: candidate });
      await restore();
      return { configured: true };
    },
    invalidate() {
      if (!current || current.stopped) return;
      current.version += 1;
      current.dirty = true;
      if (current.polling) current.controller?.abort();
    },
    status() { return { ...state, extensionId: chrome.runtime.id, compatibility: { ...compatibility } }; }
  };
}
