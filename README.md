# TabVolumeRemote

Android 手機透過私人 LAN 的 Node.js Server，控制 Windows 11 上指定 YouTube、Twitch、Hami Video 分頁主框架的 HTML 媒體音量與靜音。

第一次接觸 Chrome 擴充功能，或想了解手機、Server 與播放器如何連動，可先讀 [架構與 Chrome 擴充功能學習指南](docs/architecture-and-learning-guide.md)：包含架構圖、指令時序、技術／檔案對照與官方文件閱讀順序。

**主要開發環境：Google Chrome；驗收瀏覽器：Chrome、Microsoft Edge。** 專案擁有者已安裝 Chrome，並回報兩者基本功能通過。兩種瀏覽器使用相同的擴充功能程式。

Samsung Internet（Windows 版）的舊 M1／M2／P2 成果保留；遠端連線目前有「無法存取／不允許的請求來源」問題，根因未確認，暫停作為驗收環境。本階段不修復、不放寬安全限制，見 [Known Issue S1](docs/known-issues.md)。

專案擁有者於 2026-10-28 回報 Chrome／Edge 正常使用，Twitch／Hami 音量控制正常；YouTube 音量可調，但可能稍後恢復舊值。本版 `0.5.0` 新增 `.env`、獨立 Options Page 與持久連線設定；YouTube 先調查與提供唯讀診斷，未宣稱恢復問題已修復。見 [本輪設計、調查及驗收](docs/settings-and-youtube.md)。

## 功能與資料流

`Android → Node.js 指令佇列 → 擴充功能 worker → 指定分頁主框架 content script → 媒體屬性讀值確認 → Server → Android`

- Node.js 內建 `node:http`、原生 HTML／CSS／JavaScript，沒有第三方套件、資料庫、雲端或 Docker。
- 真實分頁選擇、0～100 音量、靜音／解除靜音、連線狀態與錯誤訊息。
- popup 提供本機音量、靜音與連線狀態，不需要 Server 也可控制本機分頁；「連線設定」按鈕開啟獨立 Options 分頁，切換視窗複製 Token 不會關閉設定表單。
- 手機約 100ms 節流並送出最終值，等待確認時僅保留最新待送值。Server 對同一完整目標尚未交付的音量也採最新值取代，舊值標記 `superseded`；已交付指令不覆寫。
- 只有 content script 已執行並回傳符合目標的 `applied` 結果，手機才顯示音量／靜音成功。`202 queued` 和 `delivered` 均不是執行成功。
- 靜音只改 `muted`，音量只改 `volume`。不控制 Windows 主音量，也不自動解除瀏覽器自身的分頁靜音。

## Windows 與 Chrome／Edge 設定

1. 使用 Node.js LTS（建議 24 LTS，程式支援 22 以上），不需要 `npm install`。
2. Chrome 開啟 `chrome://extensions`；Edge 開啟 `edge://extensions`。重新載入已安裝的 TabVolumeRemote；首次安裝才需啟用開發人員模式並載入 `C:\Projects\TabVolumeRemote\extension`。
3. 重新整理三站的影片分頁。點擊 TabVolumeRemote →「連線設定」，從獨立 Options 分頁取得 Extension ID。亦可右鍵擴充圖示 → 選項。
4. Options 顯示 MV3、`storage.local`、`alarms` 檢查；介面存在不等於休眠驗收通過。設定頁預設不顯示儲存的 Token。

manifest 以 Chromium 120 以上為基準。Chrome 與 Edge 的 Extension ID 可能不同；可在 `.env` 明確列出兩者，不必每次改 ID。仍只允許一個活躍擴充實例，切換時先從舊瀏覽器 Options「中斷連線」，或關閉它並等待 20 秒期限。

### 查詢 Windows LAN IP

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress
```

或使用 `ipconfig`，選與手機同路由器的實體 Wi-Fi／乙太網路 IPv4，不要選 WSL、Hyper-V 或 VPN 介面。

### 第一次建立 .env

在專案根目錄建立 `.env`，已有檔案時不要覆蓋：

```powershell
Set-Location C:\Projects\TabVolumeRemote
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

只允許本機已配置的 RFC1918 私人 IPv4，不接受 `0.0.0.0`、`::`、公網、主機名稱、loopback 或自動選介面。未配置 IP 或 Port 被占用就拒絕啟動，不會改綁其他位址。按 Ctrl+C 停止；更改設定後需重啟。

以編輯器開啟 `.env`，填入實際私人 IP、Port、Options 顯示的 ID，以及兩組不同的 Token。沿用既有名稱：手機是 `TVR_PAIRING_TOKEN`，擴充是 `TVR_EXTENSION_TOKEN`。每組以 Node 產生 32 隨機 bytes／43 字元 base64url；以下指令每執行一次會產生並複製一組：

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | Set-Clipboard
```

執行兩次，分別貼入 `.env` 的兩個 Token 欄位；不要共用或放進 URL。`.env.example` 不含真實 Token，`.gitignore` 已排除 `.env`。Server 不輸出 Token、Cookie 或設定本文。

單一 ID 沿用 `TVR_EXTENSION_ID`；若 Chrome／Edge 的 ID 不同，將它留空，改填 `TVR_EXTENSION_IDS=實際ChromeID,實際EdgeID`。若兩者 ID 相同，只填單一 ID 即可。最多 8 個、不得重複或使用萬用字元；兩種變數不能同時非空。這是明確白名單，不會接受任意 extension Origin。

### 日後啟動

```powershell
node server/server.js
```

或 `npm.cmd --prefix server start`。正常啟動自動以 `server/config.js` 的位置定位**專案根目錄 `.env`**，不依賴目前工作目錄。使用 Node 內建 `util.parseEnv`，不需要 dotenv。設定優先序：**系統／PowerShell 環境變數 > .env > 程式預設值**；修改 `.env` 後需重啟 Server。

舊 PowerShell 視窗若仍有 `$env:TVR_*`，會覆寫 `.env`，包含舊 Token；請改用新的 PowerShell 視窗，或只移除你要取消覆寫的變數。缺少 `.env` 時仍支援原本的環境變數方式。錯誤 IP、Port、Token、ID、未知 TVR 名稱或無法讀取檔案會以不含秘密的訊息拒絕啟動。

### Options 連線與保存

1. Server 位址填 `http://實際私人IP:Port`，Token 填 `.env` 的 **`TVR_EXTENSION_TOKEN`**。Extension 無法直接讀 Node 的 `.env`，首次設定需手動填寫。
2. 點「測試連線」，允許該私人 IP 網站權限。成功只代表 Server、Token、ID 與來源檢查通過，不改換現有 session，也不表示已儲存或已控制媒體。
3. 點「儲存並連線」。看到「已連接 Server」後可關閉設定頁；位址與 Token 存 `chrome.storage.local`，重新啟動瀏覽器後仍可恢復。
4. 已儲存 Token 不回填到欄位；留白保留原值。更換 Server origin／Port 時需重新輸入 Token，避免誤將舊憑證送到另一個位址。
5. 「中斷連線」保留設定並停用自動恢復，重啟後仍維持中斷；「儲存並連線」重新啟用；「清除設定」移除保存憑證。

儲存前先設 `storage.local` 為 `TRUSTED_CONTEXTS`，content script 不能讀取這些設定；不使用 sync、不記錄 Token。儲存仍屬本機瀏覽器資料，**不是加密保管庫**，能存取使用者瀏覽器設定檔的人可能取得憑證。卸載擴充或清除其資料會失去設定。

如舊 `storage.session` 設定仍存在，會先安全寫入 local 再移除舊值；寫入失敗保留原值。若重新載入／更新擴充時 session 已被瀏覽器清空，就無法復原，需重新輸入一次；不承諾能找回已清除的 Token。

### 防火牆

僅允許可信任私人網路的指定介面／Port，不關閉防火牆、不開公用網路、不設定路由器 port forwarding、公開隧道或反向代理。如有需要，在系統管理員 PowerShell 建立限定規則，替換實際 IP／Port：

```powershell
New-NetFirewallRule -DisplayName 'TabVolumeRemote LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 192.168.1.10 -LocalPort 3210 -RemoteAddress LocalSubnet -Profile Private -Program (Get-Command node).Source
```

本程式不自動修改防火牆。舊版若未設定擴充 Token／ID，仍可使用 Milestone 2 的配對頁面，控制 API 回報尚未連接瀏覽器。

## Android 連線與操作

1. 手機與 Windows 電腦連接同一個可信任 LAN，用 Android 瀏覽器開啟 `http://Windows內網IP:Port`；不限定手機必須安裝 Chrome。
2. 用 `.env` 中的 **`TVR_PAIRING_TOKEN`** 配對手機，與 Options 的 `TVR_EXTENSION_TOKEN` 不同。從本機編輯器複製該欄位，不要把 Token 放進網址。
3. 擴充功能連線後，手機會列出允許清單中可存取且主框架含有 HTML 媒體的分頁。沒有資料就顯示未連接／空清單，沒有假分頁。若手機未列出某頁，可用 popup 選取該分頁讀取具體錯誤。
4. 選取目標並等待頁面狀態確認後，才能拖曳滑桿或靜音。核對標題、URL 與 tabId。
5. 拖曳後等待「已套用」；「等待套用」只代表尚未確認。畫面會顯示這次從送出至取得確認的耗時，供延遲驗收使用。
6. 換片、重新整理、關頁、worker 重建或重連後，舊識別失效時要重新選取。已送出的指令無法撤回，但不會轉送新目標。
7. 手機每 2 秒更新分頁／連線狀態，背景頁面暫停輪詢；登出、到期（預設 8 小時）或 Server 重啟後需重新配對。

## 指令與故障處理

完整目標為 `extensionSessionId + tabId + pageId + url`，每個指令由 Server 產生唯一 commandId 及期限。初次讀取也驗證頁面身分；保留 P2 的顯示／目標一致性檢查。

YouTube 保留 `yt-navigate-start`／`yt-navigate-finish` 防護；三站共用返回／hash、執行當下 URL 檢查及 `tabs.onUpdated` 失效機制。新增 `webNavigation.onHistoryStateUpdated` 撤銷主框架 SPA 導航的 pageId，涵蓋同 URL 的 pushState／replaceState 與 A → B → A；popup 也取消舊選取，子框架事件不改送主框架指令。YouTube 導航進行中拒絕媒體指令。

| 狀態 | 意義 |
| --- | --- |
| `queued` | Server 已收件，未執行 |
| `delivered` | 已交付 worker，尚未確認 |
| `applied` | 已取得符合目標與要求值的 content script 回應；讀取狀態指令表示讀取完成 |
| `failed` | 有明確的執行失敗或目標失效結果 |
| `superseded` | 尚未交付的音量被更新值取代，舊值未執行 |
| `expired` | 未交付前過期或連線／手機工作階段失效 |
| `unknown` | 已交付但期限內沒有確認，可能執行過，不假裝完全沒變更 |

HTTP 長輪詢最多 8 秒、每個網路請求最多 10 秒、指令期限 8 秒、單次 content script 等待最多 4 秒、連線有效期 20 秒。Server 一次只交付一個指令，手機結果查詢間隔 150ms。

worker 每約 8 秒或分頁變更時重新同步，這是實際分頁同步，不額外呼叫無功能 API 來保活。worker 隨時可能被終止；`alarms` 設定 0.5 分鐘恢復檢查，每次啟動確認 alarm 是否存在。Chrome／Edge 的實際排程仍須量測，不能宣稱必定在 30 秒內恢復。失聯時以 1／2／4 秒等退避，最多 30 秒重連；認證／來源失敗或限流時停止自動重試，需重新設定。

命令不自動重送。只有結果上報會以相同 commandId 最多嘗試三次，Server 冪等處理。Server 或 worker session 更換後，舊指令及選取會失效。結果在記憶體保留 60 秒，最多 512 筆、64 筆待處理；分頁最多 50 筆、回報本文最多 64KiB，超限明確拒絕，不把 URL 截斷成另一個目標。

## API 與安全

| API | 用途 |
| --- | --- |
| `POST /api/pair`、`POST /api/logout` | 手機配對／登出 |
| `GET /api/tabs` | 真實分頁及連線資訊 |
| `POST /api/state` | 驗證選取頁面並讀取最新狀態 |
| `POST /api/volume`、`POST /api/mute` | 提交指令，成功收件回 `202 queued` |
| `GET /api/commands/{commandId}` | 只允許提交該指令的手機工作階段查詢 |
| `POST /api/extension/register` | 擴充註冊，取得新的 session |
| `POST /api/extension/check` | 驗證專用 Token／ID／來源，不建立或取代 session |
| `POST /api/extension/tabs` | 回報分頁快照 |
| `GET /api/extension/commands` | 8 秒長輪詢 |
| `POST /api/extension/results` | 回報 content script 執行結果 |
| `POST /api/extension/disconnect` | 中斷擴充 session |

手機提交本文範例（識別值從分頁 API 取得，不手動沿用舊值）：

```json
{"extensionSessionId":"當次連線","tabId":123,"pageId":"當前頁面","url":"https://www.youtube.com/watch?v=...","volume":37}
```

`/api/mute` 使用布林 `muted`，`/api/state` 不帶 volume／muted。錯誤回應沿用 `{"ok":false,"error":{"code":"...","message":"..."}}`。

- 手機沿用 Token 配對、HttpOnly／SameSite=Strict Cookie、`X-TVR-Client: mobile`、精確 Origin，以及同源 GET 缺 Origin 時的 Referer 檢查。POST 缺 Origin 仍拒絕。
- 擴充 API 使用專用 Bearer Token、`X-TVR-Client: extension`、允許清單中的 ID 及 session 標頭；有 Origin 時必須精確匹配**本次請求 ID** 的 `chrome-extension://ID`，不是任選另一個已允許的 ID。session 也綁定該 ID。缺 Origin 的規則與手機驗證保持原樣。
- 擴充請求不攜帶手機 Cookie、不開萬用 CORS，非預期來源不能因為帶了某個 Cookie 就控制擴充功能。
- 保留 Host／私人遠端 IP 驗證、配對失敗限流、固定靜態白名單、CSP、no-store、大小／連線／逾時限制；不記錄 Token、Cookie 或請求本文。
- `400` 無效參數，`401` 認證失敗，`403` 來源／Host 不符，`404` 不存在或無權查詢，`409` 目標／session 失效或重疊輪詢，`413／415` 本文大小／格式，`429` 限流／容量，`503` 尚未連接。

純 HTTP 沒有傳輸加密，網路攻擊者仍可能竊取憑證或竄改頁面。只能在可信任私人網路使用；Origin、Cookie 與 Token 不能代替 HTTPS，也不代表允許公網存取。

## 環境變數

| 名稱 | 要求／預設 |
| --- | --- |
| `TVR_HOST` | 必填，本機已配置的 RFC1918 IPv4 |
| `TVR_PORT` | `3210`；1～65535 |
| `TVR_PAIRING_TOKEN` | 必填，32 隨機 bytes 的 43 字元 base64url |
| `TVR_EXTENSION_TOKEN` | 啟用串接時必填，必須與手機 Token 不同 |
| `TVR_EXTENSION_ID` | 與擴充 Token 同時設定，Options 顯示的 32 字元 ID |
| `TVR_EXTENSION_IDS` | 多 ID 白名單，逗號分隔、最多 8 個；與上列擇一非空 |
| `TVR_SESSION_SECONDS` | `28800`；60～86400 秒 |
| `TVR_PAIR_MAX_FAILURES` | `5`；1～10 |
| `TVR_PAIR_WINDOW_SECONDS` | `300`；30～3600 秒 |

## 檔案與自動測試

| 檔案 | 用途 |
| --- | --- |
| `server/server.js`、`config.js` | HTTP、安全檢查與設定 |
| `server/bridge.js` | 記憶體分頁、指令、結果與連線期限 |
| `server/public/app.js`、`controls.js` | 配對及手機控制／確認流程 |
| `server/public/index.html`、`style.css` | 響應式介面 |
| `extension/background.js`、`content.js` | 共用路由與媒體／SPA 控制 |
| `extension/sites.js` | extension 與 Server 共用的三站精確來源允許清單 |
| `extension/server-client.js` | 能力檢查、註冊、長輪詢、回報、恢復 |
| `extension/popup.*`、`connection.js` | 本機音量／靜音、連線狀態與開啟設定頁 |
| `extension/options.*` | 獨立設定、測試連線、保存及清除 |
| `.env.example` | 不含秘密的根目錄設定範本 |
| `tools/youtube-volume-diagnostic.js` | 手動執行的 YouTube 唯讀事件診斷，不會隨擴充注入 |
| `extension/volume-sender.js` | 本機及手機共用節流；Server 以固定路徑提供 |
| `tests/*.test.js` | 原有測試及 broker／HTTP／worker／手機回歸 |

在專案根目錄執行：

```powershell
node --test tests/*.test.js
```

或 `npm.cmd --prefix server test`（Windows PowerShell）。HTTP 測試會使用本機私人介面與隨機 Port，測後關閉，不使用正式 Token。worker／content script 使用 VM＋模擬 Chromium `chrome.*` API；手機使用模擬 DOM。測試保留原有行為，並更新新增腳本的測試環境與 manifest 權限斷言，沒有刪除舊案例。

2026-10-28，Windows／Node.js v24.22.0：**84 項全部通過，0 失敗、0 跳過**，23 個 JavaScript 檔案通過語法檢查。新增案例見 [設定與 YouTube 調查紀錄](docs/settings-and-youtube.md)。原有 69 項保留，worker 重建測試改驗證 session 遷移至持久 local，再建立全新 worker；沒有刪除既有案例。歷史結果見 [多網站紀錄](docs/multi-site-testing.md)。

**自動測試不能代替 Chrome／Edge 的真實 MV3 排程、網站權限或 Android 操作驗證。** 閒置 1／5／15 分鐘量測方法仍適用，見 [Milestone 3 歷史測試紀錄](docs/milestone-3-testing.md)；目前沒有新增實測延遲數字。

## Android／Chrome／Edge 實機驗收

本輪 `.env`、Options、瀏覽器重啟與 YouTube 的詳細驗收見 [新版驗收清單](docs/settings-and-youtube.md)。以下三站控制與故障回歸仍需保留。

1. 分別在 Chrome、Edge 依上述流程連接擴充功能並配對 Android，確認真實分頁出現。
2. 同時播放 YouTube A、B；手機控制 A 的 0／50／100%，確認 B、Windows 及其他應用程式不變。
3. 測試快速拖曳最終 37%、靜音／解除靜音。百分比即時反映操作意圖；成功訊息必須等 content script 確認。
4. 於 popup 使用本機滑桿，確認 Milestone 1 及 P2 保留；接著關閉 popup，讓手機繼續控制。
5. 在 Twitch／Hami 重跑音量、靜音、快速拖曳與分頁獨立性；三站分別測換片／換直播頻道、A → B → A、返回、同 URL SPA 更新、重新整理及關頁。舊目標必須拒絕，重新選取後恢復。
6. 停止／重啟 Server、暫時斷網，確認失聯提示、重新配對／選取，且不重播舊音量。
7. 關閉 worker DevTools，以 [延遲量測表](docs/milestone-3-testing.md) 記錄閒置 1／5／15 分鐘後第一個音量操作。閒置期間不開 popup、不用 DevTools 觀察 worker，以免改變排程。

Samsung 存取問題先記錄，不列入本輪修復。若 Chrome／Edge 閒置延遲不可接受，先分析並提出最小修改，不自行改用 WebSocket 或大幅重構。

## 目前限制

網站允許清單僅為 `https://www.youtube.com`、`https://www.twitch.tv`、`https://hamivideo.hinet.net`；extension 與 Server 共用同一份政策，manifest 以測試確保一致。未使用 `<all_urls>`，也沒有授權任意子網域或 `player.twitch.tv`。

只控制主框架可存取的 `video`／`audio`，`all_frames: false`、`frameId: 0`。不控制跨來源 iframe／Web Audio，也不持續覆寫網站之後重設的音量。DRM 本身不是判定音量不可控的依據；仍以媒體屬性實際寫入／讀回為準。Hami 結構檢查及跨來源 iframe 的最小權限方案見 [多網站文件](docs/multi-site-testing.md)。

最多一個活躍擴充實例；Server 記憶體清空即失去工作階段與指令結果。結果確認只證明執行當下的屬性讀值，不代表網站之後不變。未確認／已交付指令不能保證撤回；失聯不自動重播。

YouTube 稍後恢復舊音量仍是 [Y1](docs/known-issues.md)。目前只確認擴充的讀取／同步流程不會自動寫回舊音量，網站內部狀態、媒體替換或初始化的實機根因尚待診斷，沒有加入定時覆寫、網站 localStorage 寫入或未驗證的 MAIN-world adapter。

[Milestone 1 本機說明](docs/milestone-1.md)、[Milestone 2 歷史說明](docs/milestone-2.md)、[P2 結案紀錄](docs/known-issues.md)。

API 參考：[MV3 生命週期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)、[Content scripts 與 frame](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[Twitch 官方嵌入播放器文件](https://dev.twitch.tv/docs/embed/video-and-clips)。
