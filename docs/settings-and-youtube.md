# 0.5.0：設定管理、Options 與 YouTube 調查

日期：2026-10-28。驗收瀏覽器為 Windows 11 的 Chrome／Edge。專案擁有者回報兩者可正常使用，Twitch／Hami 音量正常；YouTube 可調整但可能稍後恢復原值。Samsung 的 S1 保留，未嘗試修復。

## A：.env 設計與原因

原本 `readConfig()` 只讀 `process.env`，PowerShell 視窗關閉後設定不保留。現在 `loadConfig()` 固定讀取**專案根目錄** `.env`，使用 Node 內建 `util.parseEnv`，合併系統環境變數後沿用原有驗證。沒有第三方 dotenv，也不將整份檔案寫入 process.env，不會因檔案中出現 NODE_OPTIONS 就修改執行環境。

優先序為系統環境變數 > `.env` > 預設值。Windows 的環境變數名稱不分大小寫；檔案範本仍使用明確的大寫名稱。不存在 `.env` 時可繼續使用原本環境變數方式，但必填的 IP／手機 Token 仍需提供。缺少、格式錯誤、無法讀取、未知 TVR 名稱均用固定訊息回報，不輸出設定值或秘密。

沿用 `TVR_HOST`、`TVR_PORT`、`TVR_PAIRING_TOKEN`（手機）、`TVR_EXTENSION_TOKEN`、`TVR_EXTENSION_ID` 與原有期限／限流變數；新增可選的 `TVR_EXTENSION_IDS`。

Chrome／Edge 的 ID 可能不同，因此單一 ID 或明確清單擇一：

```dotenv
# Use your actual IDs. These labels are placeholders, not valid IDs.
TVR_EXTENSION_ID=
TVR_EXTENSION_IDS=實際Chrome的32字元ID,實際Edge的32字元ID
```

最多 8 個、不重複、不含萬用字元。若 Chrome／Edge 實際 ID 相同，沿用單一 ID 即可。兩者同時非空就拒絕啟動。多 ID 共用設定的 extension Token，手機 Token 另行產生；這個清單代表操作者明確信任的本機擴充實例，不是多使用者權限系統。

有 Origin 時，必須符合**這次請求所宣告的已允許 ID**，不能讓 Edge 的 ID 配上 Chrome 的 Origin。extensionSessionId 另外綁定註冊的 ID，另一個已允許 ID 也不能接管既有 session。仍只允許一個活躍擴充連線；切換瀏覽器需中斷原連線或等其到期，不必每次改 Server 設定。

私有 IP 綁定、Host、Token、Cookie、手機 Origin／Referer、限流及靜態檔案白名單均保留；沒有改成 0.0.0.0 或開放 CORS。`.env` 已在 `.gitignore`，新增的 `.env.example` Token 欄位為空，不含實際秘密。

## B：Options、儲存與遷移

原問題有兩層：popup 失焦會關閉而失去草稿；storage.session 在瀏覽器重啟或擴充重新載入／更新後會被清空。改為 `options_ui.open_in_tab: true`，由 popup 的「連線設定」呼叫 `chrome.runtime.openOptionsPage()`。

Options 顯示 Server 位址、隱藏的 Token 欄位、測試連線、儲存並連線、中斷、清除。切換其他視窗或複製 Token 不會自動關閉設定分頁；狀態更新不覆寫表單草稿。重新整理或關閉整個 Options 分頁仍會失去尚未儲存的草稿。

- 設定只寫入 `chrome.storage.local`，不放在原始碼、URL、公開檔案、Console／Log 或 storage.sync。網站 IP 在第一次設定後保存，extension 不讀 Node `.env`。
- 儲存區先限制為 `TRUSTED_CONTEXTS`，失敗就停止，不先讀寫秘密。popup／content script 不會收到 Token；Options 只收到 `hasToken`，留白可保留同一個 Server 的原值。更換 origin／Port 必須重新輸入。
- 仍存在的 session 設定先檢查並寫入 local，成功才移除舊值；失敗保留原值。如果瀏覽器更新／重載已先清空 session，無法找回，需重新輸入一次。
- 「中斷」保存 enabled=false，重啟也不自動連；「儲存並連線」啟用；「清除」刪除 local／舊 session 憑證。已開始但未完成的恢復流程會因設定版本改變而取消，避免中斷後又自行重連。
- local 是瀏覽器本機資料，**不是加密保管庫**；可讀取本機瀏覽器設定檔的人可能取得秘密。這是按本階段需求採用持久化的取捨，沒有增加資料庫或外部認證。

新增 `POST /api/extension/check`，使用與註冊相同的專用 Token、ID、Origin／Host 及失敗限流，本文只能是 `{}`。它不註冊、不輪詢、不更換 session、不控制媒體；測試通過只代表連線／認證通過，草稿需另按儲存。

worker 僅接受自身 Options 頁的設定指令；本機媒體控制仍限自身 popup。網站／content script 不能假冒設定頁，Options 也不提供任意媒體執行入口。popup 新增本機靜音按鈕，沿用 `set-mute` 與 applied 確認，不透過 volume=0 模擬靜音。

## C：YouTube 根因分析的證據界線

目前**沒有取得恢復當下的實機事件紀錄**，以下區分已確認與假設，不把網站常見行為當成這次根因。

| 檢查方向 | 目前結果 |
| --- | --- |
| 擴充定時套用舊值 | 程式檢查及新增測試：定期分頁同步與 get-state 只讀取，沒有 set-volume；連線設定也不保存音量。可排除「正常狀態同步直接重設音量」這條程式路徑，不能據此排除所有實機競爭或其他擴充 |
| 指令重新播放 | 舊 session 失效、未交付最新值取代、已交付只重試結果上報；原有回歸通過，沒有新增自動重送音量 |
| 媒體 vs 播放器內部狀態 | 現在只寫 HTMLMediaElement.volume，不通知 YouTube 私有播放器介面。**狀態可能不同步，但尚未證實**；需比較調整前／後／恢復時的 media 與可讀取的 player 音量 |
| SPA／播放器初始化 | 有可能在換片、廣告或重新初始化後採用網站原本設定。現有導航撤銷目標只防誤控，不會強制讓網站保留 remote 音量；需記錄導航及 loadstart／emptied／loadedmetadata |
| video 元素替換 | 新元素可能帶自己的預設音量；現有核心每次指令重新找元素，但不在無新指令時重新套用。需比較元素識別與事件時間 |
| volumechange 來源 | 只能觀察 volume／muted 已變更，不能僅憑事件斷定誰寫入；isTrusted 也不能可靠區分使用者操作、網站與其他程式造成的媒體屬性變化 |

`volumechange` 同時對 volume 或 muted 的變化觸發，因此不能把靜音事件直接當成音量恢復。[媒體事件文件](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/volumechange_event)、[isTrusted 說明](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted)。

Google 的公開 `setVolume`／`getVolume` 文件針對 **IFrame Player API**，不能推論 YouTube 主站 `movie_player` 具有同樣穩定契約。本輪只在方法實際存在時唯讀取樣，沒有把未確認的私有方法加入控制路徑。[YouTube 官方 API 文件](https://developers.google.com/youtube/iframe_api_reference)。

### 唯讀診斷方法

1. 在 YouTube 穩定播放時，開啟主框架 DevTools Console，執行 [tools/youtube-volume-diagnostic.js](../tools/youtube-volume-diagnostic.js) 全部內容。它不會隨擴充自動載入。
2. 先用 YouTube 原生控制設為 50%，執行 `tabVolumeDiagnostic.mark()`。
3. 用 TabVolumeRemote 調到 20%，等待 applied 後再執行 `tabVolumeDiagnostic.mark()`；等一小段時間確認讀值穩定，避免只取到同一個事件回合尚未同步的暫時值。
4. 若恢復 50%，先不要再次拖曳，執行 `tabVolumeDiagnostic.mark()`，再取得 `tabVolumeDiagnostic.report()`。
5. 結束時執行 `tabVolumeDiagnostic.stop()`，或重新整理頁面。要再測可重新執行腳本。

工具只使用事件監聽與 MutationObserver，保留最多 200 筆記憶體紀錄，不使用 setInterval、不設定 volume／muted、不抓 Cookie／Token、完整 URL、媒體 src 或影片資料，也不發送網路請求。記錄元素的臨時數字 ID、音量／靜音、播放器可讀值、初始化及導航事件、網址是否改變。大量事件可能讓最早的紀錄被淘汰，請在重現後儘快取出。

判讀方式：

- 同一元素一直是 media=20、player=50，而稍後又回 50：支持內部狀態不同步的假設，但還不是實際寫入者的證明。
- 恢復同時出現新的 media ID：支持元素替換；若 ID 不變但有 loadstart／emptied，較符合原元素重用／重新初始化。
- `yt-navigate-*` 或 urlChanged 同時出現：先關聯換片與 SPA；不要把新影片的初始音量當成舊指令又被執行。
- 屬性仍是 20% 而只有聽感變大：需另查音訊內容等因素，不能認定 volume 被寫回 50%。
- isTrusted 或時間先後無法單獨證明是哪個函式呼叫 volume setter；本工具刻意不覆寫原生 setter，避免改變重現條件。必要時再討論更具侵入性的短期追蹤。

請只回報這些數值、事件與瀏覽器版本，不貼 Token、Cookie、完整 HAR 或帳號資料。DevTools 開啟可能影響 worker 存活，**此診斷不能同時當作休眠延遲驗收**。

### 是否加入 YouTube adapter

目前決定：**先不加入控制 adapter**，共用核心保持不變，Y1 仍未結案。若實機紀錄證實內部狀態不同步，再採最小的 YouTube 專用路徑：

1. 僅限已驗證的 YouTube 主框架／pageId／期限，透過固定、隨附的函式呼叫已確認存在的方法；可能需要 `chrome.scripting` 與 MAIN world，應說明新增權限，不載入遠端程式。
2. 一次性同步「明確使用者指令」與播放器狀態，之後仍回到 content script 逐一讀回媒體，符合目標且實際成功才 applied。Twitch／Hami 仍走原核心。
3. 測試方法是否改動 muted，確保原本靜音不被解除、解除靜音保留 volume。方法不存在或拒絕時明確失敗，不能假裝持久保存已成功。
4. 若是新媒體初始化問題，需另外確認新舊目標與使用者操作優先序；不因任何 volumechange 就強制回寫，也不跨 pageId 重播舊值。

本輪沒有寫入 YouTube localStorage、模擬原生滑桿、猴補 History／volume setter、MAIN-world bridge 或任何持續覆寫。

## 修改檔案

| 檔案 | 用途 |
| --- | --- |
| `.env.example`（新增） | 空秘密欄位的設定範本；既有 .gitignore 已排除 .env，保留不變 |
| `server/config.js` | 原生 .env 載入、環境覆寫、明確多 ID 白名單 |
| `server/server.js`、`bridge.js` | 正常啟動載入設定、測試 API、Origin 與 session 的 ID 綁定 |
| `extension/options.html`、`options.css`、`options.js`（新增） | 獨立設定頁與測試／儲存流程 |
| `extension/server-client.js` | local 受信任存取、遷移、保存／恢復／中斷／清除與測試 |
| `extension/background.js` | Options／popup 的訊息來源與職責限制 |
| `extension/popup.*`、`connection.js` | 日常音量／靜音、連線狀態與開啟設定按鈕 |
| `extension/manifest.json`、`server/package.json` | Options 宣告及版本 0.5.0，沒有新增套件或權限 |
| `tools/youtube-volume-diagnostic.js`（新增） | 可停止、有限筆數、不寫媒體的手動診斷 |
| `tests/config.test.js`、`options.test.js`、`diagnostic.test.js`（新增） | 設定、表單、診斷的必要測試 |
| `tests/extension.test.js`、`remote.test.js` | 既有回歸、mute、持久化／遷移、驗證、session 隔離與恢復競爭 |
| `README.md`、`docs/*.md` | 操作、調查、已知問題與驗收結果 |

## 自動化與手動驗收

2026-10-28，Windows／Node.js v24.22.0，執行 `npm.cmd --prefix server test`：**84 項通過、0 失敗、0 跳過**，約 12.26 秒；保留原有 69 項並新增 15 項。23 個 JavaScript 檔案通過 `node --check`，31 個本機 Markdown 連結目標存在。

本輪涵蓋 `.env` 原生格式／BOM／註解、環境覆寫、錯誤訊息不洩密、Windows 名稱大小寫、單／多 ID；另以複製的測試專案實際啟動 CLI，從 server 工作目錄仍讀取根目錄 `.env`，環境 Port 覆寫並能提供 HTTP，測後關閉。

其餘測試驗證：Options 草稿不被狀態更新覆蓋、隱藏／不回填 Token、拒絕公開 Server、權限遭拒、測試失敗不顯示成功、不自動儲存；session 安全遷移、ACL 失敗不讀寫憑證、遷移失敗保留原值、瀏覽器重建保留設定、中斷／清除、恢復競爭與跨 ID session 隔離；popup mute 保留音量，以及唯讀診斷不寫入媒體。所有原有控制、安全、SPA、節流、故障與 P2 案例仍保留。

Chrome、Edge **各自**驗收以下項目：

1. 首次依 README 複製 `.env.example`、填入實際 IP／兩組 Token／對應 ID。僅執行 `node server/server.js`，不先設定 `$env:`，確認啟動。也從 server 資料夾以 `npm.cmd start` 驗證定位相同根目錄檔案。
2. 新 PowerShell 視窗以 `$env:TVR_PORT` 改用另一個可用 Port，重啟後應採覆寫值；移除該覆寫或換新視窗重啟，應回到 `.env`。錯誤／公網 IP、無效 Token 或重複 ID 需拒絕啟動且不輸出秘密。
3. popup → 連線設定，輸入位址後切到編輯器複製 Token，再回 Options，位址與草稿仍在。先測錯誤 Token，再測正確 Token；只有真實驗證通過才顯示成功，測試不影響手機既有選取。
4. 儲存並連線，關閉 Options／popup，手機仍能操作。完全關閉並重新開啟瀏覽器後，Options 應保留位址、Token 欄位為空但標示已儲存，能自動重連；不必重新輸入 Token。仍需等待 worker 恢復並重新選取新 session 的目標。
5. 中斷後重啟，不應自動連線；留白 Token 儲存重新啟用；清除後不應再恢復。若升級已清空舊 session，重新設定一次並確認之後 local 保留。
6. 多 ID 時先在一個瀏覽器連線，另一個測試連線可通過但不能接管活躍實例；中斷前者後連後者，不改 `.env`、不重啟 Server。確認手機舊選取不能繼續用。
7. 三站重跑音量 0／50／100／37%、popup 與手機靜音／解除靜音，其他分頁與 Windows 主音量不變，音量不被靜音操作改寫。Twitch／Hami 換片、返回、重新整理與 SPA 回歸照舊。
8. YouTube 先依上方工具記錄 50 → 20 → 恢復的數值／元素／初始化事件，判定 Y1 分支；不要先加入持續覆寫掩蓋問題。

本輪自動測試不代表新版 Options 的真實瀏覽器互動或 YouTube 根因已實機確認。閒置 1／5／15 分鐘延遲仍需按 [M3 方法](milestone-3-testing.md) 量測；Samsung S1 與 YouTube Y1 都尚未結案。

參考：[Node 原生 parseEnv](https://nodejs.org/api/util.html#utilparseenvcontent)、[Chrome Options Page](https://developer.chrome.com/docs/extensions/develop/ui/options-page)、[storage 與存取限制](https://developer.chrome.com/docs/extensions/reference/api/storage)。
