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
