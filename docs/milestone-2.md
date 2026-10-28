# TabVolumeRemote — Milestone 2 歷史說明

> 本文件的 Samsung 環境為歷史紀錄。目前已改以 Chrome／Edge 驗收；Samsung 的來源拒絕問題見 [S1](known-issues.md)，本階段不修復。

本文件保留 Milestone 2 的交付說明；目前版本請參考 [主 README](../README.md)。專案擁有者已確認本階段及 Milestone 1 的實機環境為 Windows 11 的 Samsung Internet（三星瀏覽器），Google Chrome 不是必要軟體。

**Milestone 2 已實作：Node.js HTTP server、手機控制頁面及配對認證。尚未串接擴充功能。** 手機會顯示「尚未連接瀏覽器」，分頁、音量及靜音控制保持停用；沒有假分頁或假的控制成功。

Milestone 1 擴充功能可獨立使用，安裝與雙分頁測試請見 [Milestone 1 說明](milestone-1.md)。Milestone 2 未修改擴充功能；其後 P2 已另行完成程式修正、自動回歸及專案擁有者的 Samsung Internet 實機驗收。

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `server/package.json` | 零第三方依賴的啟動與測試指令 |
| `server/config.js` | 環境變數、私人 IP、本機介面與安全參數驗證 |
| `server/server.js` | `node:http` server、靜態白名單、配對、工作階段及 API |
| `server/public/index.html` | Android 控制頁面、配對表單、連線狀態 |
| `server/public/style.css` | 響應式版面及觸控操作尺寸 |
| `server/public/app.js` | 配對、解除配對、狀態刷新、斷線及錯誤顯示 |
| `tests/server.test.js` | 真正開啟 HTTP socket 的 server 整合測試 |
| `tests/mobile.test.js` | 模擬 DOM／fetch 的手機頁面邏輯測試 |
| `tests/extension.test.js` | 既有 Milestone 1 自動測試，保留不變 |
| `docs/milestone-1.md` | 保留原 README 的擴充功能使用與驗收說明 |
| `docs/known-issues.md` | P2 問題及 Milestone 3 的前置修正與回歸要求 |
| `.gitignore` | 排除環境秘密、日誌及 `node_modules` |

## Windows 啟動步驟

使用 Node.js LTS（建議 Node.js 24 LTS；程式支援 Node.js 22 以上）。不需要 `npm install`。

### 1. 查詢內網 IP

在 PowerShell 執行：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress
```

也可以執行 `ipconfig`，查看連接同一台路由器的 Wi-Fi 或乙太網路介面之 IPv4 與預設閘道。不要選 WSL、Hyper-V、Docker、VPN 或其他虛擬介面的位址。

只接受本機已配置的 RFC1918 私人 IPv4：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`。不接受主機名稱、loopback、link-local、IPv6、公網 IP、`0.0.0.0` 或 `::`；沒有指定 IP 就拒絕啟動。使用多張網卡時不會自動選取。

### 2. 設定 IP、Port 與隨機 Token

以下 IP 是範例，**必須換成上一個步驟取得的實際 LAN IP**：

```powershell
Set-Location C:\Projects\TabVolumeRemote
$env:TVR_HOST = '192.168.1.10'
$env:TVR_PORT = '3210'
$env:TVR_PAIRING_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

這會產生 256-bit 隨機 Token，只指定到當前 PowerShell 環境變數，不輸出至 server 日誌、不寫入原始碼或檔案。Token 格式必須是 32 個隨機位元組的 base64url（43 個字元）；格式驗證不能代替隨機產生，請勿自訂易猜的字串。

若要取得 Token 供手機輸入，可先將它複製至 Windows 剪貼簿：

```powershell
Set-Clipboard -Value $env:TVR_PAIRING_TOKEN
```

在可信任的環境查看剪貼簿內容，將 Token 輸入手機配對欄；不要放進網址、原始碼、公開訊息或日誌。server 不會顯示 Token，也不會自動建立配對連結。

### 3. 啟動

```powershell
node server/server.js
```

也可在 `server` 資料夾使用 `npm start`。環境設定在啟動時讀取，不自動載入 `.env`。看到 `http://你的IP:3210` 即表示已啟動；按 Ctrl+C 關閉服務及連線。

**IP 或 Port 被占用／未配置時會啟動失敗，不會退回萬用位址。** 變更 IP、Port 或 Token 後需重新啟動。所有手機工作階段及配對失敗計數都在記憶體，重啟後失效。

### 4. Windows 防火牆

只在受信任的家庭／私人網路使用。若手機無法連線，確認 Windows 網路設定為「私人」，並只允許所需的私人網路入站流量；不要勾選公用網路或關閉防火牆。

需要時可在系統管理員 PowerShell 建立限定範圍的規則，將 IP／Port 換成實際設定（本專案不會自動修改防火牆）：

```powershell
New-NetFirewallRule -DisplayName 'TabVolumeRemote LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 192.168.1.10 -LocalPort 3210 -RemoteAddress LocalSubnet -Profile Private -Program (Get-Command node).Source
```

不使用時可移除這條規則：

```powershell
Remove-NetFirewallRule -DisplayName 'TabVolumeRemote LAN'
```

不要設定路由器 port forwarding、公開隧道或反向代理。不支援透過公網位址、DNS 主機名稱或其他 Host 存取。

## Android 連線與配對

1. 手機連接與電腦相同的可信任 LAN／Wi-Fi；不要使用行動數據或會隔離用戶端的訪客 Wi-Fi。
2. 在 Android 手機瀏覽器輸入 server 顯示的 **`http://內網IP:Port`**，不附加 Token 或其他 query string。不要改成 HTTPS，此版本沒有 TLS。
3. 頁面會顯示「已連接伺服器，尚未配對」。輸入剛才產生的 Token，點擊「配對」。
4. 配對成功後顯示「已連接伺服器」及「尚未連接瀏覽器」。此時**無法控制音量是預期行為**。
5. 可點「重新連線」刷新狀態；配對後每 10 秒刷新一次，分頁在背景時不輪詢，也不重疊發送請求。
6. 點「解除這支手機的配對」即刪除該工作階段。預設 8 小時到期，或 server 重啟後需重新配對。

Token 輸入欄在每次配對嘗試後清空。配對 Token 不存入 localStorage／sessionStorage，也不在 URL 傳遞。瀏覽器使用 HttpOnly Cookie 保存短期工作階段；允許 Cookie 才能維持登入。

如果手機看不到頁面，依序確認實際 IP、server 是否仍執行、防火牆規則、同一 LAN、訪客 Wi-Fi／AP isolation、VPN 及路由器隔離設定。電腦本機也必須用同一個 LAN URL，`localhost` 不在允許範圍內。

## API 與認證

所有回應均不快取。錯誤格式：

```json
{"ok": false, "error": {"code": "BROWSER_DISCONNECTED", "message": "尚未連接瀏覽器，無法執行控制。"}}
```

所有 API 均需 `X-TVR-Client: mobile`，並通過來源驗證。除了配對之外，都需要有效的 `tvr_session` Cookie。

| 方法／路徑 | JSON 本文 | 結果 |
| --- | --- | --- |
| `POST /api/pair` | `{"token":"<配對Token>"}` | 成功 `200`，設定獨立的隨機工作階段 Cookie；不回傳 Token |
| `GET /api/tabs` | 無 | `200`，`{"ok":true,"extensionConnected":false,"tabs":[],"message":"尚未連接瀏覽器"}` |
| `POST /api/volume` | `{"tabId":123,"volume":45}` | 有效但瀏覽器未連接：`503 BROWSER_DISCONNECTED` |
| `POST /api/mute` | `{"tabId":123,"muted":true}` | 有效但瀏覽器未連接：`503 BROWSER_DISCONNECTED` |
| `POST /api/logout` | `{}` | `200`，撤銷這個工作階段並清除 Cookie |

- 配對使用 `node:crypto.randomBytes` 產生工作階段秘密，配對 Token 比對使用 SHA-256 與 `timingSafeEqual`。伺服器的工作階段 Map 僅保存 Cookie 的雜湊與到期時間。
- Cookie 採 `HttpOnly; SameSite=Strict; Path=/api`，沒有 Domain；HTTP 版本不能使用 `Secure`。登出立即撤銷 server 端紀錄，到期時間不隨輪詢延長。
- API 的 `Origin` 必須與 server 的精確 `http://IP:Port` 相同；不接受 `null` 或其他來源。POST 沒有 Origin 一律 `403`。同源 GET 可能省略 Origin，只有這種情況允許以同源 Referer 驗證；缺少或錯誤時也 `403`。自訂標頭及 Cookie 認證仍是必要條件。
- 若有 `Sec-Fetch-Site`，只接受 `same-origin`。每個 HTTP 請求還檢查 Host 必須為指定 IP／Port，且遠端地址為 RFC1918；不信任 `X-Forwarded-For` 等代理標頭。
- 不傳回任何 CORS 允許標頭，不接受跨來源 preflight。Origin／Referer 只能防範瀏覽器跨站請求，原生程式可偽造，因此絕不取代 Token／Cookie 認證。
- 只接受 `application/json` 物件與指定欄位。`tabId` 是非負安全整數、`volume` 是 0～100 整數、`muted` 是布林值。JSON 本文上限 4096 bytes，不接受壓縮本文。
- 預設每個直接來源 IP 在 5 分鐘內最多允許 5 次配對失敗，第 6 次起回傳 `429` 與 `Retry-After`；無效 JSON 亦計入失敗。達限時正確 Token 也須等待，固定視窗不因重試延長。此限制包含並行請求，且不信任代理 IP。
- 工作階段最多 64 個、失敗來源紀錄最多 256 個，過期紀錄於 API 請求時清除。另設連線數、header 大小、本文及連線逾時限制。
- `400`：JSON、欄位、參數或 URL 不合法；`401`：未配對、錯誤 Token 或工作階段無效；`403`：來源或 Host 不允許；`404`：資源／API 不存在；`405`：方法不符；`413`：本文過大；`415`：格式不支援；`429`：配對限流；`503`：未連接瀏覽器或工作階段容量已滿。
- 來源／身分檢查先於控制參數驗證。尚未有分頁資料，無法判定特定合法 `tabId` 是否存在，因此有效控制參數一律回報未連接，沒有排隊或自動重試。

`/api/extension/*` 尚未實作，回傳 `404`。本階段的配對 Cookie 只供手機端，不能當成未來擴充功能的憑證；Milestone 3 需另行設計其授權範圍。

## 環境變數

| 名稱 | 預設值／要求 |
| --- | --- |
| `TVR_HOST` | 必填，本機已配置的 RFC1918 IPv4 |
| `TVR_PORT` | `3210`；1～65535 |
| `TVR_PAIRING_TOKEN` | 必填，以 32 隨機 bytes 產生的 43 字元 base64url Token |
| `TVR_SESSION_SECONDS` | `28800`；60～86400 秒 |
| `TVR_PAIR_MAX_FAILURES` | `5`；1～10 次 |
| `TVR_PAIR_WINDOW_SECONDS` | `300`；30～3600 秒 |

來源允許範圍直接由指定 IP／Port 推導，沒有放寬為任意 Origin 的環境選項。

## HTTP 的安全限制

純 HTTP **沒有傳輸加密或伺服器身分驗證**。同網路可攔截／竄改流量的攻擊者可能取得配對 Token、工作階段 Cookie，甚至替換前端 JavaScript。HttpOnly、SameSite、CSP、Origin 檢查與隨機 Token 均無法防止網路中間人。

僅在可信任的私人網路使用。指定私人 IP 與來源檢查不是對路由器 NAT／隧道／代理的完整防護，不得設定公網轉發。若需在不受信任網路使用，應先另外規劃具可信任憑證的 HTTPS；本階段沒有實作 TLS 或遠端公開存取。

## 自動測試

在專案根目錄執行：

```powershell
node --test tests/extension.test.js tests/server.test.js tests/mobile.test.js
```

只執行 Milestone 2：

```powershell
npm --prefix server test
```

HTTP 整合測試會選取一個本機已配置的私人 IPv4、綁定隨機連接埠並於測試後關閉；沒有私人 IPv4 時會明確失敗，不會改用萬用位址。測試使用當次產生的隨機秘密，不需要正式環境變數。手機邏輯測試使用模擬 DOM／fetch，不能取代真實 Android 驗證。

測試涵蓋：啟動／關閉、IP 與設定驗證、認證／錯誤 Token、來源／Host、JSON／本文限制、音量與 tabId、靜音參數、未連接瀏覽器、配對限流及並行請求、到期／登出／新 server、靜態路徑穿越、404／405、手機配對與斷線恢復。

Milestone 2 交付時使用 Node.js v24.22.0，20 項 server／手機測試及原有 15 項 extension 測試全部通過。專案擁有者已確認 Android 實機連線與配對成功；其餘手動驗收清單仍適用。P2 修正另新增 5 項 extension 回歸測試。

P2 修正後重跑完整測試：**40 項全部通過**（extension 20 項、server／手機 20 項），擴充功能 JavaScript 全數通過 `node --check`。專案擁有者其後確認 Samsung Internet 的 P2 實機驗收通過。

## 手動驗收

- Windows 使用實際 LAN IP 啟動；省略 IP、使用萬用／公網／未配置 IP 時拒絕啟動。
- Android 同 LAN 可開頁，直向／橫向、窄螢幕及觸控操作可正常使用。
- 錯誤 Token 顯示失敗，連續達上限後顯示等待秒數；期限過後可重新配對。
- 正確 Token 可配對，重載頁面仍可透過 Cookie 維持工作階段；登出後需重新配對。
- 分頁清單不含假資料、百分比為「—」，音量／靜音控制一直停用，顯示「尚未連接瀏覽器」。
- 停止 server 後，配對手機在下一次刷新時顯示連線失敗；重啟後恢復連線並要求重新配對，不顯示假的控制成功。
- 真實 Samsung Internet／Android 中驗證 Origin、Referer 與 Cookie 行為；自動 HTTP 用戶端不等於瀏覽器來源限制。
- 防火牆僅開私人網路與指定介面／Port，未配置任何 router forwarding。

## Milestone 3 前置問題

**P2 已修正，並通過自動回歸及專案擁有者的 Samsung Internet 實機驗收，已結案。** 清單 URL 過期時拒絕選取，顯示資訊取自已驗證的頁面，分頁變更／關閉時取消選取及待送指令。[結案紀錄與回歸清單](known-issues.md) 已更新，此項串接前置條件已解除。

Milestone 2 剩餘手動驗收項目仍保留供確認；後續可規劃擴充功能註冊、獨立憑證、分頁同步、頁面身分、命令到期與執行確認等 Milestone 3 設計。本階段沒有實作這些項目。

## 官方參考

[Node.js HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html)、[Node.js Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)、[Origin 行為](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin)、[Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)、[Get-NetIPAddress](https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-netipaddress)、[New-NetFirewallRule](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule)。
