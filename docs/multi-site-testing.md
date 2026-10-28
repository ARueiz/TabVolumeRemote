# 多網站控制：架構、結構檢查與驗收

> 2026-10-28 更新：專案擁有者回報 Chrome／Edge 正常使用、Twitch／Hami 音量正常；YouTube 可調但有恢復舊值的 Y1。以下保留 0.4.0 的交付紀錄；0.5.0 的 `.env`、Options 與調查方法見 [新文件](settings-and-youtube.md)。舊的 session-only 保存及切換瀏覽器須改單一 ID 的說明，已由新版設定方式取代；不將本次音量回報擴張為靜音、導航或長時間休眠的詳細驗收結果。

版本 `0.4.0`。主要開發瀏覽器改為 Chrome，驗收使用 Windows 11 的 Chrome 與 Microsoft Edge。專案擁有者已回報兩者基本功能通過；以下新增多網站功能與長時間休眠仍須分別驗收，不能由基本測試通過推論完成。

## 檢查後採用的最小修改

原架構為手機 → Node 指令佇列 → background → 指定 `tabId` 的 `frameId: 0` → content script → HTMLMediaElement → applied 回報。音量、靜音、Token／Origin、完整頁面識別、過期與結果確認均重用，沒有新增框架、套件或通訊協定。

1. 新增 `extension/sites.js`：extension 與 Server 共用三個精確 HTTPS origin，避免只更新 manifest 卻被 Server 擋掉，或兩端政策不同。classic extension 腳本取得共用物件；Node 透過 CommonJS 匯入同一檔案，不載入遠端程式。
2. manifest、查詢與 content script 納入三站；`all_frames` 仍為 `false`，指令仍明確指定 `frameId: 0`，沒有新增 iframe 或任意子網域授權。
3. 新增 `webNavigation` 權限，只使用 `onHistoryStateUpdated` 處理允許網站主框架的 SPA History 更新。換頻道、換影片、A → B → A，甚至同 URL 的 pushState／replaceState 都撤銷舊 pageId，popup 清除舊選取；子框架事件不變更主框架控制目標。只靠 URL／tabs.onUpdated 可能漏掉同 URL 更新，因此採用瀏覽器事件，不覆寫網頁的 History 方法。撤銷訊息完成後再同步一次，避免讀取快照與 pageId 變更的競爭。
4. 保留 YouTube 導航開始／完成事件，以及三站共用的返回、hash、URL 檢查、重新整理／關頁防護。每次執行重新尋找當前 DOM 的 `video, audio`，不依賴網站自訂播放器變數。
5. 靜音只設定 `muted`，不把 volume 改為 0；解除靜音不改 volume。所有可存取的主框架媒體套用後讀回確認，有錯誤則不回報 applied。

API 本文不變，目標仍為 `extensionSessionId + tabId + pageId + url`，不增加由手機任選 frame 的入口。手機仍等待真正的 applied，queued／delivered 不代表成功；最新待交付音量與 100ms 節流保留。

## 播放器結構證據

下列兩筆由專案擁有者在實際播放頁執行唯讀 DevTools 檢查後提供，日期為 2026-10-25。未提供確切瀏覽器版本與頁面路徑，不補造資料；結論只適用當次頁面，不推論全站所有內容型態。

| 網站 | 已知主框架／iframe 結果 | 本輪處理 |
| --- | --- | --- |
| YouTube | 既有主框架控制已由專案擁有者驗收；保留原路由及回歸測試 | 維持主框架 |
| Twitch | `origin=https://www.twitch.tv`、`isTop=true`、`mediaCount=1`；另有 2 個 `supervisor.ext-twitch.tv` 與 3 個 `s.amazon-adsystem.com` iframe | 控制主框架媒體，不授權這些 iframe；不能僅憑 iframe 名稱判定其內容或播放器用途 |
| Hami Video | `origin=https://hamivideo.hinet.net`、`isTop=true`、`mediaCount=1`、`iframeOrigins=[]` | 該頁不需要 all_frames、其他 frameId 或額外 iframe host_permissions |

Twitch [官方嵌入播放器文件](https://dev.twitch.tv/docs/embed/video-and-clips) 描述 `player.twitch.tv` iframe，但嵌入用法不能替代 Twitch 主站 DOM 檢查；本次主站已有主框架媒體，不新增 `player.twitch.tv` 授權。

沒有因 Hami 可能使用 DRM 就判定無法控制。此功能只寫入 HTMLMediaElement 的 volume／muted，是否成功由實際 setter 與讀回結果決定，不處理解密、授權或串流下載。

## 權限與安全界線

- 網站精確允許清單：`https://www.youtube.com/*`、`https://www.twitch.tv/*`、`https://hamivideo.hinet.net/*`。不包含 HTTP、任意 Port、相似惡意網域、其他子網域或 `<all_urls>`。
- 權限為 `storage`、`alarms` 與新增的 `webNavigation`；不新增 `tabs`、`scripting`、`tabCapture`。
- 原有 optional HTTP host 宣告只用於使用者指定的私人 Server IP 授權；fetch 另固定設定的 origin／Port，禁止 redirect。這不代表可控制任意網站。
- 本輪沒有變更 Server 的 Origin、請求來源標記、Host、Cookie、Token 或 CORS 檢查；新增的是三站 URL 政策。
- Samsung 的「無法存取／不允許的請求來源」列為 [S1](known-issues.md)，根因未確認，暫不修復，不為此放寬來源規則。

## 如果另一個內容頁真的使用跨來源 iframe

以下僅是待證據確認的最小方案，**本版未實作、不預先申請權限**：

1. 先以 DevTools 確認實際含有 video／audio 的 frame origin、主框架來源與導航方式。CDN 媒體檔案網址不等於播放器 iframe origin，不因影片來自某 CDN 就授權整個 CDN。
2. 只把已確認的精確播放器 HTTPS origin 加入 host_permissions 與 content_scripts.matches，再評估 `all_frames: true`；不開 `match_origin_as_fallback` 或任意萬用來源。
3. 可利用已有的 webNavigation 權限取得 frame 清單，依允許來源向明確 `frameId` 發送唯讀狀態要求；不使用無 frameId 的廣播來猜哪個回應是播放器。
4. 在原有主頁 `tabId／pageId／url／extensionSessionId` 外，綁定已探測的 `frameId + framePageId + frameUrl`（必要時 documentId）。frame ID 不能單獨當成永久身分；frame 導航／重建需重新選取。Server、worker 與結果驗證必須同步擴充，不能只把 `{frameId: 0}` 刪掉。
5. 每次先驗證主頁與實際目標 frame，再套用媒體；applied 需包含符合目標的回應。其他 iframe 不碰觸，部分失敗不假裝全部成功，也不以跨來源 DOM 存取或網頁 postMessage 規避權限。

frame 注入行為參考 [Chrome content scripts 文件](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)，導航事件參考 [webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)。

## 可重複使用的 DevTools 唯讀檢查

在實際播放頁開啟 F12 → Console，先選 `top` 執行環境，執行：

```javascript
({
  origin: location.origin,
  isTop: window === top,
  mediaCount: document.querySelectorAll('video,audio').length,
  iframeOrigins: [...document.querySelectorAll('iframe')].map(frame => {
    try {
      return new URL(frame.getAttribute('src') || 'about:blank', location.href).origin;
    } catch { return 'invalid'; }
  })
})
```

若主框架是 0，從 Console 的執行環境選單選取疑似播放器 iframe，再執行同一段。若結果為 `null`、about:blank 或仍無法辨識，可在 Elements 選取實際 iframe，查看來源的 origin；不要猜測 srcdoc／動態 frame 的來源。這段只讀取當前 DOM 與來源，不更改播放狀態、不抓取 Cookie、Token 或包含查詢參數的影片網址。

確認控制結果可另讀取：

```javascript
[...document.querySelectorAll('video,audio')].map(element => ({
  volume: element.volume,
  muted: element.muted,
  paused: element.paused,
  readyState: element.readyState
}))
```

若要回報檢查資料，只需來源、數量、屬性結果與瀏覽器版本，不需要影片 URL、Authorization、Cookie 或帳號資料。

## 新增及修改檔案

| 檔案 | 修改目的 |
| --- | --- |
| `extension/sites.js`（新增） | 共用網站政策 |
| `extension/manifest.json` | 三站明確授權、載入 sites.js、webNavigation、版本 0.4.0 |
| `extension/background.js` | 三站探索／驗證、主框架 SPA 失效事件，保留定向路由 |
| `extension/content.js` | 共用網站驗證、媒體屬性控制與沒有主框架媒體時的明確錯誤 |
| `extension/popup.html`、`popup.js` | 三站文案及 SPA 清除選取；原有本機音量功能保留 |
| `server/bridge.js` | 引用同一份網站政策，不改 HTTP 來源驗證 |
| `server/package.json` | 版本與 extension 同步，無新增套件 |
| `tests/extension.test.js`、`remote.test.js` | 網站政策、音量／靜音、導航及 HTTP 串接回歸 |
| `AGENTS.md`、`README.md`、`docs/*.md` | 更新驗收瀏覽器、Known Issue、歷史環境與新測試步驟 |

## 自動化測試結果

2026-10-25，Windows／Node.js v24.22.0，執行 `npm.cmd --prefix server test`：**69 項全部通過，0 失敗、0 跳過**，約 12.14 秒。保留原有 61 項，新增 8 項；18 個 JavaScript 檔案通過 `node --check`。新網站測試以實際腳本＋模擬媒體／瀏覽器 API 執行，HTTP 案例使用真正 Node socket；24 個本機 Markdown 連結目標存在。

新增涵蓋：

- extension／manifest／Server 三站政策一致，拒絕非 HTTPS、相似網域、未授權 iframe origin、其他 Port 與含帳密 URL。
- 三站探索及正確 tabId；所有媒體的 0／50／100／37% 音量、靜音／解除靜音保留 37%，其他分頁不變。
- Twitch／Hami 的同 URL History 更新、A → B → A、重新整理及關頁，舊 pageId 不能控制新內容；子框架事件不改送主框架。
- popup 對主框架 SPA 取消選取；沒有主框架媒體時不回 applied，能指出 iframe 尚未支援；媒體元素替換後重新掃描。
- 真正 HTTP 的 Twitch／Hami 指令及 applied 結果、靜音音量保留、YouTube 不變、舊目標拒絕及新目標恢復。
- 刻意延遲同 URL SPA 的 content script 撤銷訊息，確認訊息完成後重新收集新 pageId，不長時間發布舊快照。

原有 Origin／Token／Cookie／Host、參數、逾時、長輪詢、重新連線、結果證據、節流與 P2 測試仍通過。這不等同本輪對真實 Twitch／Hami 媒體寫入的驗收。

## Chrome 與 Edge 各自驗收

先在相應擴充管理頁重新載入版本 0.4.0，確認新網站與 webNavigation 權限並刷新三站播放頁。切換 Chrome／Edge 時更新 Server 的 `TVR_EXTENSION_ID`、重啟 Server 並重新連線／配對；不要同時連兩個 extension 實例。

| 項目 | Chrome | Edge |
| --- | --- | --- |
| 舊版基本功能 | 專案擁有者已回報通過 | 專案擁有者已回報通過 |
| 新版 YouTube 回歸、P2、跨站隔離 | 待驗收 | 待驗收 |
| Twitch 音量、靜音及換直播頻道 | 待驗收 | 待驗收 |
| Hami 音量、靜音及換影片／頻道 | 待驗收 | 待驗收 |
| SPA、同 URL History、刷新、關頁 | 待驗收 | 待驗收 |
| popup 關閉後控制、斷線恢復 | 待驗收 | 待驗收 |
| 閒置 1／5／15 分鐘第一個音量延遲 | 未量測 | 未量測 |

操作順序：

1. 同時開啟 YouTube A、Twitch B、Hami C 並穩定播放，記下各自 volume／muted 與 Windows 主音量。
2. 手機依完整 URL／標題／tabId 選 A，設定 0／50／100／37%，等 applied 訊息，確認 B、C 與 Windows 不變；再對 B、C 各自重跑。避免只依聽感判斷。
3. 各站在 37% 靜音再解除，確認 muted 改變而 volume 保留 0.37；音量設 0 不應自動設 muted。瀏覽器自己的分頁靜音需另行處理。
4. 快速拖曳最後停在 37%，等最終確認，觀察舊值不覆蓋新值。檢查 popup 本機音量與手機控制都能操作正確目標。
5. 各站換影片／直播頻道、返回、A → B → A，再刷新與關頁；舊選取要失效，重新選取後才能控制，不能把舊指令轉送新內容。測相同 URL 不同 tabId 的分頁與不同視窗。
6. 關閉 popup 和 worker DevTools，從手機操作；停 Server／斷網後不能顯示假成功，恢復後不重播舊指令。按 M3 文件方法量測閒置 1／5／15 分鐘，保留第一次操作失敗或需重選的紀錄，不拿第二次成功替代。

如果切換內容不更新 URL、不觸發 History 或既有 YouTube 事件，通用邏輯不能保證辨識其影片語意；需提供該頁的實際訊號再討論最小修正，不猜測網站內部 DOM。網站主動重設音量、廣告、內容型態與 iframe 結構也可能不同，不能由這兩份主框架結果宣稱全站通用。
