# windyforecast v3 — Node + CWA QPE + WRF 3 km + Railway

## 架構

```text
瀏覽器
  ├─ /api/cwa  -> Node -> CWA O-A0002-001
  ├─ Open-Meteo (MSM / ECMWF / GFS / ICON)
  └─ /api/wrf  -> data/wrf-renwu.json
                         ↑
                  Node 背景更新器
                         ↓
                  查 CWA WRF InitialTime
                         ↓
                 只有新批次才啟動
                         ↓
                 Python + ECMWF ecCodes
                         ↓
           +006 / +012 / +018 GRIB2
```

GitHub Actions 已不需要。

## 1. 本機開發（不用 Docker）

### Node

```bash
npm install
copy .env.example .env
npm run dev
```

macOS/Linux：

```bash
cp .env.example .env
npm run dev
```

瀏覽器：

```text
http://localhost:8080
http://localhost:8080/api/health
http://localhost:8080/api/wrf/status
```

把真正的 CWA key 填在 `.env`：

```env
CWA_API_KEY=你的_CWA_KEY
```

`.env` 已加入 `.gitignore`，不要 commit。

### WRF 的本機 Python

Node 網站即使沒有 pygrib 仍可以啟動；只有 WRF 背景更新會失敗並顯示在 `/api/wrf/status`。

若要在本機一起測 WRF，需要 Python + ECMWF ecCodes：

```bash
python -m pip install -r requirements.txt
npm run wrf:check
```

Windows 原生環境直接使用 `eccodes` PyPI wheel；不再依賴 pygrib。

## 2. WRF 自動更新

Node 啟動後：

1. 約 2.5 秒後立即檢查一次 `M-A0064-006` metadata。
2. 讀取最新 `InitialTime`。
3. 和 `data/wrf-renwu.json` 的 `cwa_initial_time` 比較。
4. 相同：不下載 GRIB2。
5. 不同：呼叫 `scripts/extract_wrf.py`。
6. Python 下載 +006 / +012 / +018。
7. 驗證三個檔案是同一個 WRF cycle。
8. 找仁武最近 3 km 格點。
9. 檢查 GRIB 的 `startStep/endStep`，判斷 Total precipitation 是：
   - 從起報累積；或
   - 各 6 小時區間。
10. 無法確定累積定義時直接失敗，不猜數字。
11. 成功後以 atomic replace 更新 `wrf-renwu.json`。

之後每 `WRF_REFRESH_MINUTES` 分鐘重複「metadata 檢查」，預設 60 分鐘。

## 3. API

### GET /api/health
Node、CWA key、WRF updater 狀態。

### GET /api/cwa
Node 代替瀏覽器呼叫 CWA，因此 API key 不會出現在 HTML。

### GET /api/wrf
快速回傳目前已算好的 WRF JSON，不會在 request 當下下載大型 GRIB2。

### GET /api/wrf/status
背景更新狀態、上次成功/失敗時間。

### POST /api/wrf/refresh
只有設定 `ADMIN_TOKEN` 才能使用。

Header：

```text
x-admin-token: 你的 ADMIN_TOKEN
```

## 4. 發佈 GitHub

建議先使用開發分支：

```bash
git add .
git commit -m "Migrate weather dashboard to Node Railway backend"
git push -u origin railway-dev
```

## 5. Railway

Railway 直接連 GitHub repository，使用本專案根目錄的 `Dockerfile`。

Variables：

```env
CWA_API_KEY=你的_CWA_KEY
TARGET_LAT=22.705864872692686
TARGET_LON=120.33468473266137
WRF_REFRESH_MINUTES=60
CWA_PROXY_CACHE_MS=120000
```

### Railway Volume（建議）

Mount Path：

```text
/data
```

再加入：

```env
DATA_DIR=/data
```

沒有 Volume 也能運作，但每次 container 被重建時會重新抓一次 WRF。

## 6. Dockerfile

Dockerfile 依照 MLB 專案的部署習慣：

```text
FROM
WORKDIR
COPY package*.json
RUN npm install
COPY requirements
RUN pip install
COPY .
EXPOSE 8080
CMD node server.mjs
```

差別只有天氣專案需要 Python + ECMWF ecCodes，所以 base image 使用 Node 22 Debian slim，再安裝 Python/ecCodes。


## Windows v2：改用官方 eccodes

上一版 `pygrib` 在 Windows 容易因沒有 wheel / ecCodes C library 而進入原始碼編譯。
v2 已改用 ECMWF 官方 `eccodes` Python bindings。

在已啟用的 `.venv`：

```powershell
python -m pip uninstall pygrib -y
python -m pip install -r requirements.txt
python -c "import numpy, requests, eccodes; print('WRF Python OK')"
```

`.env` 建議：

```env
PYTHON_BIN=F:\file\code\windyforecast\.venv\Scripts\python.exe
```

然後重新：

```powershell
npm run dev
```


## v3：新增 QPE O-B0045-001

官方產品：
- Dataset ID: `O-B0045-001`
- 內容：整合雷達與雨量站的「過去 1 小時定量降水估計」
- 更新：約每 10 分鐘
- 用途：現在正在下多少的空間估計，不是未來預報

Node 背景流程：

```text
CWA fileapi O-B0045-001
  ↓ JSON；失敗再嘗試 XML
解析網格 metadata + comma-separated rainfall grid
  ↓
取仁武最近格點
  ↓
data/qpe-renwu.json
  ↓
GET /api/qpe
```

### 本機第一次升級 v3

```powershell
npm install
npm run qpe:check
```

成功後測：

```text
http://localhost:8080/api/qpe
http://localhost:8080/api/qpe/status
```

### QPE 環境變數

```env
QPE_REFRESH_MINUTES=10
```

QPE 與 CWA 實測都使用同一個 `CWA_API_KEY`。

### 資料安全設計

- API key 只留在 `.env` / Railway Variables。
- `/api/qpe` 只輸出仁武附近一個格點，不把 24 萬格原始資料送到瀏覽器。
- QPE 解析若格點數、尺寸或資料內容不合理會失敗，不會填 0。
- QPE 負值（-1/-99/-999）視為缺值。
- 畫面顯示 QPE 與雨量站的絕對差值，不使用低雨量時容易誤導的百分比。

### QPE 與 WRF 分工

```text
現在 / 過去1h：
  CWA 雨量站實測
  + O-B0045-001 QPE

0–3h：
  QPEplus 雷達 / 短延時監測
  + MSM

幾小時～18h：
  MSM + CWA WRF 3 km

1–5天：
  ECMWF / GFS / ICON
```


## v4：QPE 新鮮度防護

QPE API 保留 UTC/ISO 的 observation time；網頁統一用 Asia/Taipei 顯示。

```env
QPE_WARN_MINUTES=30
QPE_EXPIRE_MINUTES=60
```

判讀規則：
- `age <= 30 min`：`fresh`，正常顯示與測站差值。
- `30 < age <= 60 min`：`warning`，黃色「資料偏舊」，仍可參考。
- `age > 60 min`：`expired`，`usable_for_judgement=false`，主數值顯示 `—`，不再計算 QPE − 測站差值。
- 原始 QPE 值仍保留在 `/api/qpe` 供追溯。


## v5：WRF 實際台灣時間對齊

本版修正一個重要判讀問題：CWA WRF 的 `+006/+012/+018` 是相對於模式起報時間的固定 6 小時區段，不是「從現在開始」的未來 0–6 / 6–12 / 12–18 小時。

後端下一個新 WRF cycle 會新增：

```json
{
  "schema_version": 2,
  "model_initial_time": "2026-09-03T06:00:00+00:00",
  "forecast": [
    {
      "forecast_hour": 6,
      "period_start_time": "2026-09-03T06:00:00+00:00",
      "period_end_time": "2026-09-03T12:00:00+00:00"
    }
  ]
}
```

API 保留 UTC；前端固定轉換成 `Asia/Taipei`。舊 Volume 中的 v4 JSON 即使沒有 `period_start_time`，前端也會用 `valid_time - 6h` 安全推導，所以不必為了 UI 升級強迫重新下載約 500 MB GRIB2。

WRF 卡片會標示：
- `已結束`
- `目前時段`
- `未來`

MSM 的「未來 6h」只在瀏覽器現在時間距離 WRF 固定區段起點不超過 1 小時時才做數值差比較；否則明確顯示「時間窗未對齊，不做直接數值比較」。


## v6：同時段 MSM / WRF 比較 + 民眾版判讀

- MSM 與 WRF 只在完全相同的 valid-time 6 小時窗比較。
- Open-Meteo hourly precipitation 是「前一小時累積」；08:00–14:00 會加總 09:00...14:00 六筆。
- Open-Meteo request 新增 `past_hours=12`，讓 WRF 當前 6h 區段開始後仍能取得完整 MSM 同時段資料。
- 新增「一般人先看這裡」：現在附近 / 接下來 0–3h / 模型是否一致。
- 模型分歧時不取平均；分歧視為降雨位置、時機或強度不確定性較高。
- WRF 當前 6h 整段累積包含已經過去的部分，不解讀成「從現在起還會下多少」。

介面中的「雨量訊號低/較明顯」是易懂提示，不是 CWA 警特報分級。


## v7：CWA 官方 GFS 0.25° GRIB2 直讀實驗

官方資料系列：`M-A0060-*`。

本版**不取代**既有 Open-Meteo GFS。先確認 CWA 原始 GRIB2 的 precipitation 欄位與累積語意，再決定是否長期啟用。

### 為什麼只抓 +024 / +048 / +072 / +096 / +120？

如果 `Total precipitation` 是從模式起報累積：

```text
+024 cumulative -> Day1
+048 cumulative - +024 -> Day2
+072 cumulative - +048 -> Day3
+096 cumulative - +072 -> Day4
+120 cumulative - +096 -> Day5
```

只需 5 個 forecast-hour 檔，比把 0–120h 每 6 小時全部下載省很多。

### 第一步：probe，只下載 +024

```powershell
npm install
npm run gfs:cwa:probe
```

成功時重點看：

```json
{
  "status": "ok",
  "mode": "probe",
  "usable_for_5day": true,
  "selected_field": {
    "step_type": "accum",
    "start_step": 0,
    "end_step": 24
  }
}
```

只有 `usable_for_5day=true` 才進下一步。

如果看到：

```text
start_step = 18
end_step = 24
```

代表選到「前 6 小時累積」，不能拿它當 0–24h；程式不會硬算。

### 第二步：完整 1–5 天

```powershell
npm run gfs:cwa:check
```

成功後：

```text
data/cwa-gfs-renwu.json
GET /api/cwa-gfs
GET /api/cwa-gfs/status
```

### 第三步：確認後才啟用背景更新

`.env` / Railway Variables：

```env
CWA_GFS_ENABLED=true
CWA_GFS_REFRESH_MINUTES=360
```

背景 updater 每 6 小時檢查一次 `M-A0060-024` cycle；cycle 沒變就沿用 `/data/cwa-gfs-renwu.json`，不重新下載五個 GRIB2。

### Railway Volume

沿用既有：

```env
DATA_DIR=/data
```

CWA GFS 最後只留下：

```text
/data/cwa-gfs-renwu.json
```

GRIB2 使用 Python temporary directory，解析後刪除，不會長期佔用 Volume。

### 前端

新增「CWA 官方 GFS 0.25° GRIB2 直讀」實驗卡。

如果 Open-Meteo GFS 也可用，前端會把其 hourly precipitation 加總成與 CWA GFS **完全相同的固定 24h valid-time window** 再比較，不會拿「從現在往後 24h」直接對「模式起報 +0–24h」。

### 安全限制

- 官方直讀預設 `CWA_GFS_ENABLED=false`。
- Full mode 只接受 `startStep=0`、`endStep=24/48/72/96/120` 的累積 precipitation。
- 不符合累積語意就停止，不猜。
- CWA GFS 0.25° 是全球模式；仁武最近格點會比 WRF 3 km 遠很多，這是解析度差異，不是程式錯誤。


## v8：仁武 5 / 10 km 面積降雨判讀

單一格點不能直接回答「整個仁武會不會廣泛積水」。

v8 把短時資料拆成：

```text
中心點
5 km 平均 / 最大
10 km 平均 / 最大
10 km ≥20 mm 覆蓋率
10 km ≥40 mm 覆蓋率
```

### QPE

`O-B0045-001` 原始網格本來就是完整二維格點，因此 Node 在解析時直接計算目標周圍所有 QPE 格點中心：

```json
"area": {
  "radius_5km": {
    "valid_cells": 40,
    "mean_mm": 1.2,
    "max_mm": 8.0,
    "coverage_pct": {
      "ge_20": 0.0,
      "ge_40": 0.0
    }
  },
  "radius_10km": {}
}
```

QPE 面積統計仍然是「過去 1 小時已發生雨量」。

### CWA WRF 3 km

Python 不再只取最近一格。它會保留 10 km 內所有 WRF 格點的累積 precipitation，
並在 `0-6 / 6-12 / 12-18h` 差分後，對**每一個格點的 period rain**計算面積統計。

WRF JSON schema 更新為：

```text
schema_version = 3
```

每一個 forecast block 都會有：

```json
"area": {
  "radius_5km": {},
  "radius_10km": {}
}
```

### MSM

Open-Meteo 官方 API 支援一次要求多組 latitude / longitude。
v8 在仁武中心建立約 5 km 間距、10 km 半徑內共 13 個取樣點，一次取得 MSM hourly precipitation。

當 WRF 目前區段是：

```text
08:00–14:00
```

每一個 MSM 取樣點都先加總成相同 `08:00–14:00`，
再對 5 km / 10 km 範圍計算平均、最大與覆蓋率。

因此現在可以區分：

```text
單點差很大，但 10 km 平均接近
→ 比較像雨胞位置偏移

單點差很大，而且 10 km 平均 / 覆蓋率也差很多
→ 模式對整體雨區情境真的分歧
```

### 民眾版文字

介面把面積型態翻譯成：

- 周邊整體雨量訊號偏低
- 零星至局部降雨型
- 局部強雨型
- 分散至較廣泛降雨型
- 廣泛較強降雨型

這些是本站為了易懂而做的**空間型態描述**，不是中央氣象署警特報等級。

### 重要限制

「面積降雨」比單點更適合判斷區域影響，但仍不等於真正的淹水模型。

道路是否積水還需要：

- 地勢與低窪點
- 側溝、箱涵、下水道容量
- 排水分區 / 集水區
- 河川與區排水位
- 前期土壤含水量
- 潮位、抽水站等條件

下一階段若要做真正的「積水風險」，應從圓形 5/10 km 統計升級為**排水集水區平均雨量**。

### v7 → v8 WRF 一次性資料升級

舊 `/data/wrf-renwu.json` 沒有 area 欄位。v8 updater 發現：

```text
同一 cycle
但 schema_version < 3
```

時會重新跑一次 WRF +006/+012/+018，建立面積統計 JSON。

因此 v8 第一次部署可能會重新下載約 500 MB WRF GRIB2；完成後仍沿用 Railway Volume，
同一 cycle 不會一直重抓。


### Git 注意

`data/*.json` 是 runtime state，不應簽入 Git。v8 的 `.gitignore` 已忽略：

```text
data/*.json
```

完整 ZIP 也不再包含 placeholder JSON，避免覆蓋你目前本機或 Railway Volume 已經產生的 WRF / QPE / GFS 資料。
