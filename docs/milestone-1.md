# TabVolumeRemote — Milestone 1（擴充功能原型）

> 以下保留 M1／P2 的 Samsung 歷史驗收環境。目前已改以 Chrome／Edge 開發與驗收，Samsung 來源拒絕問題暫緩處理；最新安裝與多網站操作請見 [README](../README.md)。

透過 Manifest V3 擴充功能，在 Windows 11 的 Samsung Internet 選取一個 YouTube 分頁並調整該頁的 HTML 媒體音量。不需要安裝 Google Chrome；`chrome.*` 是 Chromium API 名稱。

本文件說明 Milestone 1 的電腦端擴充功能原型；其本身不需要 server 或第三方依賴。後續 server 與手機頁面請參考 [主 README](../README.md)。

專案擁有者已確認 Milestone 1 及 P2 修正的實測環境是 Windows 11 的 Samsung Internet，均驗收成功，詳見 [問題結案紀錄](known-issues.md)。Milestone 2 沒有修改 extension；P2 修正另行處理。以下保留原型操作與回歸步驟，Milestone 3 的新增權限、手機靜音與連線設定以主 README 為準。

## 功能

- 列出 `https://www.youtube.com/*` 分頁，顯示標題、URL 與選取的分頁 ID。
- 音量範圍 0～100，每次套用到指定頁面主框架內所有可存取的 `video`、`audio`。
- 拖曳時約每 100ms 傳送一次最新值；放開滑桿時確保送出最終值。鍵盤操作也會送出最終值。
- 同一時間最多一個音量請求；等待回應時只保留最新待送值。最終值不等待剩餘節流時間，但會等待進行中的請求完成，因此可能與上次傳送相隔少於 100ms。
- 成功訊息必須等頁面確認套用後才顯示；數字百分比則立即反映滑桿位置。
- 保留媒體原本的 `muted` 狀態，不控制 Windows 系統音量。
- 初次選取時驗證清單 URL，並顯示同一份已驗證的標題、URL 及 tabId；分頁 URL／標題變更、重新載入或關閉時取消選取，請重新整理清單後再選取。
- 支援分頁失效、沒有媒體、權限不足、未載入 content script、指令逾時等錯誤提示。

Milestone 1 的 popup 僅提供本機音量控制；Milestone 3 已新增手機端靜音／解除靜音與遠端控制，請見主 README。

## 檔案用途

| 檔案 | 用途 |
| --- | --- |
| `AGENTS.md` | 專案需求與開發規範 |
| `extension/manifest.json` | Manifest V3 設定、popup、service worker、YouTube 網站授權及 content script 宣告 |
| `extension/popup.html` | 分頁清單、音量滑桿與狀態訊息 |
| `extension/popup.css` | popup 樣式 |
| `extension/popup.js` | 清單、選取狀態、滑桿事件及確認／錯誤顯示 |
| `extension/volume-sender.js` | 100ms 節流、最終值傳送、請求依序處理與取消待送值 |
| `extension/background.js` | 驗證 popup 指令、查詢分頁、確認目標及轉送指令 |
| `extension/content.js` | 頁面實例識別、驗證指令及讀取／修改媒體音量 |
| `tests/extension.test.js` | 使用 Node.js 內建 test runner、VM、模擬 Chromium `chrome.*` API／DOM／時鐘的自動測試 |
| `README.md` | 安裝、操作、測試與限制 |

## 安裝至 Samsung Internet（Windows 版）

1. 在 Samsung Internet 開啟附加元件／擴充功能管理頁。若支援 Chromium 內部網址，也可在三星瀏覽器中開啟 `chrome://extensions`。
2. 開啟右上角「開發人員模式」。
3. 點擊「載入未封裝項目」（Load unpacked）。
4. 選擇本專案的 **`extension` 資料夾**：`C:\Projects\TabVolumeRemote\extension`，不要選專案根目錄。
5. 在三星瀏覽器的擴充功能選單中將 TabVolumeRemote 固定到工具列，方便操作。
6. 確認擴充功能的網站存取設定允許 `https://www.youtube.com`，不要只限點擊時存取；需要操作其他 YouTube 分頁。
7. **重新整理所有已開啟的 YouTube 分頁**。安裝或重新載入擴充功能後，既有頁面需要重新載入 content script。

修改程式後，在三星瀏覽器的擴充功能管理頁點擊重新載入，再重新整理 YouTube 分頁並重新開啟 popup。

其他 Chromium 瀏覽器的相容性未納入本次驗收，不需要為此安裝其他瀏覽器。

## 使用

1. 開啟 YouTube 影片並等待頁面完成載入。
2. 點擊 TabVolumeRemote 圖示。
3. 從清單明確選取目標；清單可包含不同三星瀏覽器視窗中的 YouTube 分頁。
4. 拖曳音量滑桿。介面顯示「已確認套用」才代表頁面已回傳成功。
5. 放開後等待最終音量確認，再關閉 popup。
6. 新增或關閉分頁後，點擊 popup 的「重新整理」更新清單並重新選取。

如果頁面已重新整理、導向另一部影片或回報錯誤，請重新選取分頁。若沒有媒體，先開啟並播放影片，再重新選取。若無法連接，檢查網站存取設定並重新整理 YouTube 頁面。

音量設為 0 不會將 `muted` 設為 `true`，調高音量也不會自動解除既有靜音；若目標原本靜音，請在 YouTube 或三星瀏覽器手動解除。

## 兩個 YouTube 分頁的獨立控制驗收

1. 開啟兩個不同影片的分頁 A、B，各自播放並解除 YouTube 及三星瀏覽器分頁靜音。先將電腦音量調至舒適範圍。
2. 記下 Windows 主音量，以及 A、B 各自的音量。可在兩頁各自開啟 DevTools Console 讀取下面的媒體屬性，作為比單純聽感更明確的比較。
3. 開啟 popup，依標題／URL 選取 A，連續拖曳滑桿，依序確認 0%、50%、100%。確認 A 改變、B 的媒體屬性不變，Windows 主音量也不變。
4. 快速拖曳 A 並放在容易辨識的值（例如 37%），等待「已確認套用 37%」。確認最後沒有被較舊值覆蓋。
5. 改選 B，調成 65%，確認 A 保留 37%。即使兩頁 URL 一樣，也應依不同 `tabId` 獨立操作。
6. 手動靜音 A，再操作 A 的音量；確認 `muted` 仍維持原值。

讀取媒體屬性（在各分頁 DevTools Console 執行，只讀不修改）：

```javascript
[...document.querySelectorAll("video, audio")].map(element => ({
  volume: element.volume,
  muted: element.muted
}))
```

影片廣告、換片或 YouTube 自己調整音量可能改變測試條件，請在影片穩定播放時比較。

## 自動測試

安裝 Node.js 22 或以上版本，在專案根目錄執行；不需要 `npm install`：

```powershell
node --test tests/extension.test.js
```

已自動驗證的範圍：

- Manifest V3、YouTube 限定授權及 manifest 引用檔案存在。
- 清單排除不支援或無法取得 URL 的分頁。
- 將 0%、50%、100% 套用到指定分頁的所有媒體，另一個模擬分頁不變，保留 `muted`。
- 拒絕無效音量／分頁 ID、未知指令與非 popup 來源。
- 分頁關閉、載入中、導向不支援網站、content script 無法連線的錯誤。
- 重新整理後即使 URL 相同，舊頁面識別值也不能控制新頁面。
- URL 變更、過期指令、沒有媒體、媒體 setter 失敗及套用後讀值不符。
- 每次指令重新查找媒體；建立新的 background 執行環境後仍能路由。
- 未收到頁面確認時的指令逾時。
- 約 100ms 節流、保留最新待送值、最終值傳送順序、取消及錯誤後停止待送指令。
- popup 忽略舊選取的延遲回應，且收到媒體確認後才顯示成功。

這些是模擬 API／DOM 的邏輯測試，不等同真實 Samsung Internet 或 YouTube 的端到端測試。

Milestone 1 原有 15 項測試；P2 修正另新增 5 項回歸測試，20 項均通過。專案擁有者已確認原版及 P2 修正後的 Samsung Internet 實機驗收通過。

## 仍需手動驗證

- Windows 11 + Samsung Internet 安裝、popup 排版、滑鼠拖曳、觸控板及鍵盤操作。
- 上述雙分頁測試：真實聲音、媒體屬性及 Windows 主音量相互獨立。
- popup 開啟時，目標分頁關閉／重新整理／換片後再次操作，不誤控其他分頁；發生失效提示後重新選取可恢復。
- 開啟無影片的 YouTube 頁面，確認沒有媒體時的提示；開啟影片後重新選取可恢復。
- 將網站存取權撤銷後重新整理頁面，確認錯誤處理；恢復權限並重新整理後可繼續使用。
- 更新擴充功能但不重載 YouTube 頁面時，能看到無法連接的提示。
- 真正的 service worker 休眠／恢復：關閉 popup 及 worker DevTools，等待至少約 30 秒，重開 popup、重新選取並操作。開著 worker DevTools 可能影響休眠，請勿以此狀態驗收。
- 關閉三星瀏覽器後重開，重新選取頁面並操作。

## 設計與權限

操作路徑：`popup → background service worker → 指定 tabId 的主框架 content script → HTMLMediaElement`。

原型的 `host_permissions` 只包含 `https://www.youtube.com/*`，讓 background 查詢對應分頁的 URL／標題；`content_scripts.matches` 在同一範圍自動載入頁面腳本。不需要 `tabs`、`scripting`、`activeTab` 或 `<all_urls>` 權限。Milestone 3 額外使用 `storage`、`alarms` 及使用者明確授予的私人 Server IP 網站權限；沒有開放外部 extension 訊息控制介面。

content script 在預設 isolated world 執行，可操作頁面 DOM，不需存取 YouTube 內部 JavaScript 變數。以 `crypto.randomUUID()` 建立頁面識別，重新整理及 Milestone 3 的 SPA 導航會撤銷舊識別；後續音量指令必須同時符合選取的 `tabId`、完整 URL 與頁面識別。URL 也會在執行當下再驗證。

單次頁面指令期限為 4 秒。指令若在到達頁面前過期，不會執行；如果已執行但回應未送達，則可能顯示逾時，不能據此認定音量完全沒有改變。錯誤後取消尚未送出的值，不自動重試。

background 每次啟動都同步註冊監聽器，不保存選取資訊，不嘗試常駐；popup 的選取狀態及節流佇列都只在當次 popup 記憶體中。

Chromium API 官方參考：[Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)、[Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。API 參考文件不代表必須安裝 Google Chrome，三星新增 API 的實機驗證見 [Milestone 3 測試紀錄](milestone-3-testing.md)。

## 技術限制

- 支援範圍為桌面版 `www.youtube.com` 主框架中的 HTML 媒體；不包含其他網站的嵌入播放器、跨來源 iframe、Shadow DOM 深層搜尋或 Web Audio 音訊。
- 只驗證指令執行當下的媒體 `volume` 讀值。沒有持續監控或強制覆寫，不處理 YouTube 之後主動重設音量、換片、廣告及媒體替換後的自動恢復。
- 不保證 YouTube 自己的滑桿或持久偏好設定同步，也不宣稱普遍支援所有網站或 DRM 內容。
- 同頁多個媒體一律套用；初始音量不同時顯示第一個媒體的值並提示。若部分元素套用時失敗，先前元素可能已改變，不做回滾。
- popup 關閉後不保留選取，也不保證尚未送出／尚未確認的最終值繼續傳送；請等最終成功確認再關閉。已送出的指令無法撤回，但不會改送至新選取的分頁。
- 分頁清單只在開啟 popup 或手動重新整理時更新，沒有輪詢或自動刷新。
- Milestone 1 原型沒有網路服務；目前版本的 LAN server、手機介面及配對認證已在後續階段加入，詳見主 README。

P2 已通過修正後的 Samsung Internet 實機驗收，此項 Milestone 3 前置條件已解除。
