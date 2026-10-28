# Milestone 3 測試與 Samsung Internet 驗收紀錄

> 0.5.0 已新增根目錄 `.env` 與獨立 Options，連線設定改存受信任的 storage.local；下方的 session-only 行為是歷史記錄，最新步驟見 [設定與 YouTube 調查](settings-and-youtube.md)。

> 本文件保留 M3 初次交付與尚未量測的歷史記錄。最新決策已改以 **Chrome／Edge** 驗收，專案擁有者已回報兩者基本功能通過；Samsung 存取問題暫不修復，見 [S1](known-issues.md)。新增多網站的最新結果與操作清單見 [多網站測試文件](multi-site-testing.md)。下方 Samsung 的待辦均暫緩，不阻擋本輪 Chrome／Edge 開發，也不表示已有閒置延遲測值。

主要環境為 **Windows 11＋Samsung Internet／Samsung Browser（Windows 版）＋同一 LAN 的 Android 手機**。不要求安裝 Google Chrome，其他 Chromium 瀏覽器的結果不能代替三星驗收。設定及 API 見 [README](../README.md)。

## 已知結果與證據範圍

- 專案擁有者已確認 Milestone 1、Milestone 2 及 P2 修正實機通過；先前文件中的 Chrome 驗收措辭已依這次環境確認更正，沒有要求重做既有功能。
- Milestone 3 已完成程式與自動化測試。自動化使用真正的 Node HTTP socket，以及執行實際 background／content 腳本的 VM；瀏覽器 API、DOM、worker 終止和喚醒由測試模擬。
- 本次曾可讀取現有 Samsung Browser 視窗及 TabVolumeRemote 工具列按鈕，但桌面自動輸入未能切換頁籤，未完成新版擴充功能載入與配對。因此以下新增 API 的三星行為及 Android 延遲 **尚無實機測值**；不能以 API 存在或 VM 通過宣稱實機相容。
- 不安裝其他瀏覽器、不自動修改防火牆，不以開著 DevTools 的測試代表正常休眠行為。

## 自動化執行

在專案根目錄執行 `npm.cmd --prefix server test` 或 `node --test tests/*.test.js`。需要本機具有已配置的私人 IPv4 介面；測試自行產生憑證與隨機 Port，測後關閉 Server。

| 測試檔 | 範圍 |
| --- | --- |
| `tests/extension.test.js` | 原有 20 項，包括 popup、100ms 節流、最終值、頁面識別與 P2 回歸 |
| `tests/server.test.js` | 原有 15 項：設定、啟停、認證、來源、參數、容量、靜態路徑與狀態碼 |
| `tests/mobile.test.js` | 原有 5 項：初始無假分頁、配對、錯誤及恢復 |
| `tests/bridge.test.js` | 6 項：完整目標路由、最新待送值、過期／未知、結果驗證、長輪詢取消及連線期限 |
| `tests/remote.test.js` | 11 項：真正 HTTP 與 worker／content 串接、session／alarm 恢復、斷線、結果重試、SPA、認證、重新配對撤銷及能力缺少提示 |
| `tests/controls.test.js` | 4 項：queued／delivered 不顯示成功、applied 證據、過期選取與失敗狀態 |

2026-10-25 執行環境：Windows，Node.js v24.22.0。`npm.cmd --prefix server test`：**61 項通過，0 失敗、0 跳過**，約 11.84 秒；17 個 JavaScript 檔案全數通過 `node --check`。包含真正 8 秒的空長輪詢返回；VM 測試不量測 Samsung 的真實排程。

## 三星 API 相容性檢查

先記錄三星選單「關於」頁顯示的產品版本；若診斷頁另有 Chromium 版本，也一併記錄，避免把產品版本當成 Chromium 版本。目前尚未記錄本機版本。

| 項目 | 程式處理 | 自動化結果 | 三星實機結果 |
| --- | --- | --- | --- |
| Manifest V3 service worker | 每次啟動同步註冊事件，popup 不負責遠端輪詢 | worker 無 popup 時串接通過；重建可恢復 | 舊版 M1 已驗收；M3 新版待驗證 |
| HTTP／JSON 長輪詢 | Server 等待最多 8 秒，fetch 最多 10 秒，失聯退避重連 | 指令喚醒輪詢、取消及斷線恢復通過 | popup 關閉及閒置 1／5／15 分鐘待驗證 |
| `chrome.alarms` | 能力檢查；設定 0.5 分鐘並讀回實際週期；worker 重啟時補建 | 事件流程由模擬 API 覆蓋 | 介面、實際週期、喚醒及延遲均待驗證 |
| `chrome.storage.session` | 僅存當次瀏覽器 session 的連線設定，worker 重啟後讀回 | 共用 session 儲存的 worker 重建通過 | 實際讀寫、休眠保留及瀏覽器關閉後清除待驗證 |
| 網站權限及 Origin | 只向使用者要求指定私人 IP，程式固定 Port；專用 Token／ID 驗證 | URL、認證、來源及無 CORS 萬用設定通過 | 三星權限提示與真實請求標頭待驗證 |

popup 的「手機遠端連線設定」會顯示 MV3／storage.session／alarms 檢查結果及已讀回的 alarm 週期。API 存在只是第一步；成功連線才能證明相關讀寫／網路流程完成一次，仍需驗證休眠。

若缺少 API，遠端設定回報明確錯誤，本機 popup 音量功能保留。不自動改存 `storage.local` 或改用另一種通訊。若 API 存在但操作失敗，記錄固定錯誤訊息與版本，勿附 Token、Cookie 或請求本文。

## Android 實機驗收步驟

1. 依 README 重新載入三星擴充功能、刷新 YouTube，設定 Server 專用 Token／ID、手機配對 Token。確認 popup API 檢查，並等手機列出真實分頁。
2. 選 A，核對標題／完整 URL／tabId；操作 0／50／100%，快速拖曳最後停在 37%。必須等「已套用」才算成功，B 及 Windows 主音量不變。
3. 靜音／解除靜音 A，確認原音量保留。瀏覽器本身的分頁靜音需另外解除。
4. 關閉 popup 與所有 worker DevTools，直接從手機繼續操作。M1 popup 本機控制及 P2 清單一致性仍按 [原回歸清單](known-issues.md) 抽驗。
5. 選取後換片、A → B → A、返回、同 URL 重新整理及關閉分頁：舊目標須拒絕／失效，重新選取後才能操作；不得轉送其他分頁。
6. 斷開網路、停止／重啟 Server：不得顯示假的成功或重播過期音量。恢復後等待重連，必要時重新配對與選取。
7. 需要獨立測 worker 恢復時，可在三星擴充功能管理頁使用可用的 worker 停止操作，再關閉檢查視窗；**不要重新載入整個擴充功能**，因為後者可能清除 session 儲存。等待 alarm／事件恢復後核對新的 extensionSessionId，舊選取不可沿用。
8. 關閉整個三星瀏覽器後重開：預期需要重新輸入擴充 Token；不應把只有 worker 被停止與整個瀏覽器重開混為同一測項。

## 閒置 1／5／15 分鐘的第一個音量指令

測試條件：Windows 保持喚醒、Server 持續運作、同一可信任 Wi-Fi、YouTube 穩定播放；記錄電源／省電模式及手機瀏覽器版本。popup、worker DevTools、除錯器均關閉。手機控制頁保持前景，預先選好 A；閒置期間不送音量／靜音、不開 popup、不重新選取。手機正常狀態更新及 worker 的分頁同步仍運作，符合一般已連線使用情境。

每個間隔從上次控制完成重新計時；1 分鐘測完後，5 分鐘須再完整等 5 分鐘，15 分鐘亦同。到時只做一次音量變更（例如按滑桿一次），記錄「本次確認耗時」。建議每種間隔至少做三次，但先取得各一次真實數字即可發現重大問題。

| 閒置時間 | popup／DevTools | 第一個音量操作至 applied | 結果與失效提示 | 狀態 |
| --- | --- | --- | --- | --- |
| 1 分鐘 | 須關閉 | 未量測 | 未知 | 待 Samsung／Android 實機驗收 |
| 5 分鐘 | 須關閉 | 未量測 | 未知 | 待 Samsung／Android 實機驗收 |
| 15 分鐘 | 須關閉 | 未量測 | 未知 | 待 Samsung／Android 實機驗收 |

手機顯示的毫秒數使用 `performance.now()`，從提交控制 API 至收到 applied，包括手機 HTTP 往返及每 150ms 查詢結果的等待。百分比在拖曳時立即顯示意圖，只有「已套用」代表執行確認。不要用百分比變化當作成功延遲。

結果 API 的 `timings.queuedAt`、`deliveredAt`、`confirmedAt` 均來自同一 Server 時鐘，可區分排隊交付與回報延遲；只有 applied 才有 confirmedAt。不要直接把手機與 Windows 的絕對時間相減。不確定／逾時時填「失敗／unknown」，不要填 0ms，也不要重新選取後的第二次操作替代第一次失敗結果。

建議觀察目標為穩定 LAN 通常在約 1 秒內確認；這是待驗收目標，非已驗證保證。若第一個操作持續超過 2 秒、要開 popup 才恢復、因休眠需重選、或未確認就過期，記錄為待分析問題，暫不認定遠端可用性通過。

## 相容性失敗時的處理順序

1. 先區分權限／Token／Origin、YouTube 目標失效、Server 不可達及 worker 排程；查版本、popup 固定錯誤與 command 結果，避免誤把所有失敗歸為休眠。
2. 缺少 `storage.session`：先回報 API／版本證據，再討論只在當次記憶體使用、每次 worker 喚醒需重新設定等最小取捨；不暗中將秘密永久保存。
3. alarm 不接受或調整 0.5 分鐘：記錄讀回週期及喚醒測值，再討論 1 分鐘相容設定是否能接受；不能承諾其足以達成即時控制。
4. 長輪詢即使成功註冊仍在閒置後中斷：保留第一個操作結果，先檢查最小的重啟／事件恢復修正。若排程機制無法滿足延遲，提出 WebSocket 等替代方案及生命週期、連線與安全取捨，**先由專案擁有者確認，不自行切換**。

本階段尚無三星不相容的實機證據，也沒有變更到 WebSocket。Milestone 3 的實機完成條件仍是上述 API 行為與三個閒置間隔全部取得真實結果。
