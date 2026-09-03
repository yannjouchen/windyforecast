仁武防災雨量儀表板 Final

GitHub repository 放置方式：

/
├─ index.html
├─ wrf-renwu.json
├─ scripts/
│  └─ extract_wrf_renwu.py
└─ .github/
   └─ workflows/
      └─ update-wrf-renwu.yml

使用方式：
1. 將本套件依照上面的路徑上傳到 windyforecast repository。
2. GitHub Pages 繼續使用 main / (root)。
3. 到 GitHub → Actions → Update Renwu WRF 3km → Run workflow。
4. 第一次成功後，wrf-renwu.json 會變成真正的 WRF 仁武格點雨量。
5. 之後 workflow 會定時更新 WRF JSON。

網站判讀順序：
① 現在：CWA 實測 + QPEplus
② 1–6 小時：MSM(日本)
   0–18 小時趨勢：CWA WRF 3 km
③ 1–5 天：ECMWF(歐洲) + GFS(美國) + ICON(德國)
④ 風險確認：集合預報 + CWA 官方雨量門檻

注意：
- WRF 公開產品是 6 小時 forecast-hour GRIB2，因此顯示 0–6 / 6–12 / 12–18h。
- 1–5 天表格的「第1天～第5天」是從目前往後每 24 小時累積，不是日曆日。
- CWA API key 目前仍內建在 index.html；公開 GitHub Pages 可被檢視原始碼。
