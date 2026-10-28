# 已知問題與 Milestone 3 前置條件

## S1：Samsung Internet（Windows 版）無法存取／來源遭拒

- 狀態：**已記錄，暫不修復；Samsung 不列入目前驗收環境**。
- 來源：專案擁有者回報 Samsung 出現「不允許的請求來源」或「無法存取」。目前 Chrome 與 Edge 基本功能已由專案擁有者確認通過，後續以兩者驗收。
- 根因：**尚未確認**。同源政策、Origin／Fetch Metadata 或其他來源標頭差異只是待查方向，不能把懷疑當作結論；尚未確認實際被拒的 API 路徑及請求標頭。
- 處理界線：本輪不變更手機／extension 的 Token、Origin、請求標記、Host、Cookie 或 CORS 規則，不接受任意來源、不移除認證、不改用代理規避來源限制。
- 後續若另行授權調查，只收集已遮蔽憑證的 API 路徑、HTTP 狀態／錯誤代碼、瀏覽器版本及相關來源標頭；不記錄 Authorization、Token、Cookie 或完整本文。
- 舊版 M1／M2 及 P2 的 Samsung 驗收紀錄保留，不能由舊版成功推論本次遠端串接相容。

## Y1：YouTube 稍後恢復原本音量

- 狀態：**調查中，未宣稱修復**。專案擁有者於 2026-10-28 回報 Chrome／Edge 可用，Twitch／Hami 音量正常，但 YouTube 由原先 50% 調至 20% 後可能又恢復 50%。
- 已確認的程式行為：定期分頁同步及 get-state 只讀取，不自動寫回舊音量；設定保存也不保存媒體音量。新增回歸確認讀取與媒體替換不會觸發舊值重套。
- 未確認的根因：YouTube 內部狀態／保存機制、SPA／廣告／播放器初始化、video 元素替換或其他實機寫入來源，需依實際事件與讀值判斷，不能僅憑現象斷定。
- 本輪提供手動執行的唯讀診斷，記錄 volumechange、初始化、媒體識別與導航；不使用 setInterval、不持續覆寫、不寫 YouTube localStorage、不新增未驗證的私有播放器 API。
- YouTube adapter 僅列為待證據確認的最小方案；共用 HTMLMediaElement 核心、Twitch／Hami 與 muted 控制保持原樣。詳細判讀與驗收見 [設定與 YouTube 調查](settings-and-youtube.md)。

## P2：顯示頁面與實際控制頁面不一致


- 狀態：**已修正並通過自動回歸與 Samsung Internet 實機驗收，P2 已結案**。此項 Milestone 3 前置條件已解除。
- 手動驗收來源：專案擁有者先前回報實機通過，當時使用 Windows 11 的 Samsung Internet、尚未安裝 Chrome。後續已安裝 Chrome 並改以 Chrome／Edge 驗收；歷史結果保留。
- 範圍：Milestone 1 extension 的選取／顯示與實際控制目標一致性。
- 來源：專案擁有者在 Milestone 2 需求中指定的已知問題。
- 影響：顯示的頁面可能與實際套用音量的頁面不一致，會使使用者誤判控制目標。
- 已重現的根因：popup 使用載入清單時的舊標題／URL 顯示目標，但 `get-state` 只傳 tabId，會讀取該 tab 現在的頁面。分頁在清單載入後換片，會顯示舊影片卻控制新影片；同一 URL 更新標題時也會顯示舊資訊。
- 原版重現方式：開啟 popup 載入影片 A 的清單，讓該 tab 導向影片 B，再於舊清單選取它。原版仍顯示 A，控制指令卻帶 B 的 URL。此情境已用 popup → background → content script 的模擬整合測試重現。
- 修正：初次讀取也必須符合清單 URL；確認後用 content script 回傳的頁面標題、URL 及 background 指定的 tabId 顯示。清單加入 tabId 以區分同名同 URL 分頁。popup 監聽 `tabs.onUpdated`／`onRemoved`，目標的 URL、標題、載入狀態變更或關閉時清除選取、取消待送值，並忽略過期回應。
- 權限／架構：沿用既有 YouTube 授權，沒有增加套件、權限或持久化狀態，也沒有開始 server／extension 串接。
- 自動回歸：新增 5 項 P2 測試，涵蓋舊清單換片、同 URL 標題、同名同 URL／不同視窗分頁、頁面事件與延遲回應、回傳目標不符。前 4 項已確認在舊程式失敗、修正後通過。

專案擁有者已確認 Samsung Internet 實機驗收通過。以下保留作為日後回歸清單；重跑時先在三星瀏覽器的擴充功能管理頁重新載入擴充功能，再重新整理兩個 YouTube 分頁、重新開啟 popup：

1. 兩個不同 YouTube 頁面：選取、標題／URL／tabId、實際媒體變更必須一致。
2. 相同標題、相同 URL 的不同分頁及不同三星瀏覽器視窗：仍以 tabId 正確區分。
3. 快速切換 A → B，模擬 A 的讀取／控制回應較晚到達：B 的顯示與控制目標不能被 A 覆蓋。
4. 音量指令進行中切換分頁：未送出的舊值應取消，已送出的指令不得轉送新目標。
5. 目標重新整理、導向、YouTube 換片、標題變更或關閉：立即清除選取並停用控制；重新整理清單、重新選取後恢復一致。尚未選取時清單中的舊 URL，也不能直接用來控制已換片的 tab。
6. 快速拖曳與鍵盤操作的最終值，必須作用於畫面所示目標；其他分頁與 Windows 主音量不變。

自動回歸與專案擁有者的 Samsung Internet 實機驗收均已通過，此 P2 不再阻擋 Milestone 3。Milestone 3 新增通訊及休眠行為的待驗收項目，另見 [測試紀錄](milestone-3-testing.md)。
