import path from "node:path";
import { promises as fs } from "node:fs";

const DEFAULT_ENDPOINT = "https://web.fpcitc.com.tw/PIWebAPI/streams/Recorded";

function isoNow() {
  return new Date().toISOString();
}

function parseTaipeiTimestamp(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}+08:00`;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return { iso, ms };
  }

  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return { iso: new Date(ms).toISOString(), ms };
  return null;
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function aggregateByMinutes(points, bucketMinutes) {
  const bucketMs = bucketMinutes * 60 * 1000;
  const buckets = new Map();

  for (const p of points) {
    const bucket = Math.floor(p.ms / bucketMs) * bucketMs;
    const arr = buckets.get(bucket) || [];
    arr.push(p.value);
    buckets.set(bucket, arr);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, values]) => ({
      time: new Date(ms).toISOString(),
      value: Number(median(values).toFixed(4)),
      samples: values.length
    }));
}

function nearestAtOrBefore(series, targetMs, maxAgeMs) {
  let best = null;
  for (const p of series) {
    const ms = Date.parse(p.time);
    if (!Number.isFinite(ms) || ms > targetMs) continue;
    if (!best || ms > best.ms) best = { ...p, ms };
  }
  if (!best || targetMs - best.ms > maxAgeMs) return null;
  return best;
}

function signedDelta(current, reference) {
  if (!current || !reference) return null;
  const delta = Number(current.value) - Number(reference.value);
  return Number.isFinite(delta) ? Number(delta.toFixed(4)) : null;
}

function trendLabel(delta) {
  if (!Number.isFinite(delta)) return "unknown";
  if (delta > 0) return "rising";
  if (delta < 0) return "falling";
  return "steady";
}

function warningState(value, level3, level2, level1) {
  const v = Number(value);
  const l3 = Number(level3);
  const l2 = Number(level2);
  const l1 = Number(level1);

  if (![v, l3, l2, l1].every(Number.isFinite)) {
    return {
      code: "unknown",
      label: "警戒基準未設定",
      severity: 0,
      next_warning_value: null,
      distance_to_next_warning: null
    };
  }

  if (v >= l1) {
    return {
      code: "level1",
      label: "一級警戒",
      severity: 3,
      next_warning_value: null,
      distance_to_next_warning: null
    };
  }
  if (v >= l2) {
    return {
      code: "level2",
      label: "二級警戒",
      severity: 2,
      next_warning_value: l1,
      distance_to_next_warning: Number((l1 - v).toFixed(3))
    };
  }
  if (v >= l3) {
    return {
      code: "level3",
      label: "三級警戒",
      severity: 1,
      next_warning_value: l2,
      distance_to_next_warning: Number((l2 - v).toFixed(3))
    };
  }

  return {
    code: "normal",
    label: "低於三級警戒",
    severity: 0,
    next_warning_value: l3,
    distance_to_next_warning: Number((l3 - v).toFixed(3))
  };
}

async function writeAtomic(pathname, data) {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  const tmp = `${pathname}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, pathname);
}

async function readJson(pathname) {
  try {
    return JSON.parse(await fs.readFile(pathname, "utf8"));
  } catch {
    return null;
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store"
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`water level HTTP ${response.status}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("water level upstream 回傳非 JSON");
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function createWaterLevelUpdater({
  enabled = true,
  endpoint = DEFAULT_ENDPOINT,
  server = "JWRTPMS",
  tag = "JW_waterlevelmeter",
  stationName = "台塑仁四橋",
  district = "仁武",
  basin = "後勁溪",
  unit = "m",
  warningLevel3 = 11,
  warningLevel2 = 12,
  warningLevel1 = 13,
  dataDir,
  refreshMinutes = 1
}) {
  const jsonPath = path.join(dataDir, "waterlevel-renwu.json");
  let timer = null;
  let running = false;

  const status = {
    enabled: Boolean(enabled),
    configured: Boolean(endpoint && server && tag),
    running: false,
    refresh_minutes: refreshMinutes,
    server,
    tag,
    station_name: stationName,
    district,
    basin,
    unit: unit || null,
    warning_levels: {
      level3: Number(warningLevel3),
      level2: Number(warningLevel2),
      level1: Number(warningLevel1)
    },
    last_check_at: null,
    last_success_at: null,
    last_error_at: null,
    last_error: null,
    latest_timestamp: null,
    latest_value: null,
    last_action: enabled ? "尚未檢查" : "水位整合未啟用"
  };

  async function fetchLatest(existing = null) {
    if (!enabled) throw new Error("WATERLEVEL_ENABLED=false");
    if (!endpoint || !server || !tag) {
      throw new Error("水位 API 設定不完整");
    }

    const l3 = Number(warningLevel3);
    const l2 = Number(warningLevel2);
    const l1 = Number(warningLevel1);
    if (![l3, l2, l1].every(Number.isFinite) || !(l3 < l2 && l2 < l1)) {
      throw new Error("水位警戒值設定錯誤：需符合 三級 < 二級 < 一級");
    }

    const raw = await fetchJsonWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "windyforecast-renwu/10.1"
        },
        body: JSON.stringify({
          server,
          tag,
          // First run backfills the previous day. Once persisted history
          // exists, the updater runs every minute and requests only *-1m.
          starttime: Array.isArray(existing?.series_1min) && existing.series_1min.length
            ? "*-1m"
            : "*-1d",
          endtime: "*"
        })
      },
      30000
    );

    if (!Array.isArray(raw)) {
      throw new Error("水位 API 回傳格式不是陣列");
    }

    const byMs = new Map();
    for (const row of raw) {
      const parsed = parseTaipeiTimestamp(row?.Timestamp);
      const value = Number(row?.Value);
      if (!parsed || !Number.isFinite(value)) continue;
      byMs.set(parsed.ms, {
        ms: parsed.ms,
        time: parsed.iso,
        value
      });
    }

    const points = [...byMs.values()].sort((a, b) => a.ms - b.ms);
    if (!points.length) {
      throw new Error("水位 API 沒有可用的 Timestamp / Value");
    }

    const newMinuteSeries = aggregateByMinutes(points, 1);
    const existingMinuteSeries = Array.isArray(existing?.series_1min)
      ? existing.series_1min
      : [];
    const byMinute = new Map();
    for (const row of existingMinuteSeries) {
      const ms = Date.parse(row?.time || "");
      if (Number.isFinite(ms) && Number.isFinite(Number(row?.value))) {
        byMinute.set(ms, {
          time: new Date(ms).toISOString(),
          value: Number(row.value),
          samples: Number(row.samples || 0)
        });
      }
    }
    for (const row of newMinuteSeries) {
      const ms = Date.parse(row.time);
      if (Number.isFinite(ms)) byMinute.set(ms, row);
    }

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const minuteSeries = [...byMinute.entries()]
      .filter(([ms]) => ms >= cutoff)
      .sort((a, b) => a[0] - b[0])
      .map(([, row]) => row);

    if (!minuteSeries.length) {
      throw new Error("合併後沒有可用的 24h 水位資料");
    }

    const chartInput = minuteSeries.map(row => ({
      ms: Date.parse(row.time),
      value: Number(row.value)
    }));
    const chartSeries = aggregateByMinutes(chartInput, 5);
    const current = minuteSeries.at(-1);
    const currentMs = Date.parse(current.time);
    const maxAge = 15 * 60 * 1000;

    const ref30 = nearestAtOrBefore(minuteSeries, currentMs - 30 * 60 * 1000, maxAge);
    const ref1h = nearestAtOrBefore(minuteSeries, currentMs - 60 * 60 * 1000, maxAge);
    const ref3h = nearestAtOrBefore(minuteSeries, currentMs - 3 * 60 * 60 * 1000, maxAge);

    const change30m = signedDelta(current, ref30);
    const change1h = signedDelta(current, ref1h);
    const change3h = signedDelta(current, ref3h);
    const warning = warningState(
      current.value,
      warningLevel3,
      warningLevel2,
      warningLevel1
    );

    return {
      status: "ok",
      schema_version: 1,
      generated_at: isoNow(),
      source: {
        endpoint,
        server,
        tag,
        station_name: stationName,
        district,
        basin,
        timestamp_timezone: "Asia/Taipei",
        value_unit: unit || null,
        value_unit_confirmed: Boolean(unit),
        warning_levels: {
          level3: Number(warningLevel3),
          level2: Number(warningLevel2),
          level1: Number(warningLevel1)
        },
        fetch_window: Array.isArray(existing?.series_1min) && existing.series_1min.length
          ? "*-1m"
          : "*-1d"
      },
      raw_sample_count: raw.length,
      valid_sample_count: points.length,
      first_timestamp: minuteSeries[0].time,
      latest_timestamp: minuteSeries.at(-1).time,
      current: {
        time: current.time,
        value: Number(current.value),
        unit: unit || null,
        warning
      },
      warning,
      change: {
        minutes_30: change30m,
        hour_1: change1h,
        hours_3: change3h,
        trend_30m: trendLabel(change30m),
        trend_1h: trendLabel(change1h),
        trend_3h: trendLabel(change3h)
      },
      series_1min: minuteSeries,
      series_5min: chartSeries,
      note:
        `水位趨勢由 PI Recorded Timestamp/Value 計算；`+
        `警戒基準：三級 ${Number(warningLevel3)} ${unit || ""}、`+
        `二級 ${Number(warningLevel2)} ${unit || ""}、一級 ${Number(warningLevel1)} ${unit || ""}。`
    };
  }

  async function checkAndUpdate({ reason = "interval" } = {}) {
    if (!enabled) {
      return { ok: true, skipped: true, reason: "disabled", status: { ...status } };
    }
    if (running) {
      return { ok: true, skipped: true, reason: "already-running", status: { ...status } };
    }

    running = true;
    status.running = true;
    status.last_check_at = isoNow();
    status.last_action = `水位檢查中（${reason}）`;

    try {
      const existing = await readJson(jsonPath);
      const latest = await fetchLatest(existing);
      await writeAtomic(jsonPath, latest);
      status.latest_timestamp = latest.latest_timestamp;
      status.latest_value = latest.current?.value ?? null;
      status.last_success_at = isoNow();
      status.last_error = null;
      status.last_action = `水位更新成功：${latest.latest_timestamp}｜${latest.current?.value ?? "?"}${unit ? ` ${unit}` : "（原始值）"}`;
      return { ok: true, updated: true, data: latest, status: { ...status } };
    } catch (error) {
      const message = error?.name === "AbortError"
        ? "water level upstream timeout"
        : error instanceof Error ? error.message : String(error);
      status.last_error_at = isoNow();
      status.last_error = message;
      status.last_action = `水位更新失敗：${message}`;
      console.error(`[waterlevel] ${message}`);
      return { ok: false, updated: false, error: message, status: { ...status } };
    } finally {
      running = false;
      status.running = false;
    }
  }

  function start() {
    if (!enabled || timer) return;
    const startup = setTimeout(() => {
      void checkAndUpdate({ reason: "startup" });
    }, 6000);
    startup.unref?.();

    timer = setInterval(() => {
      void checkAndUpdate({ reason: "interval" });
    }, refreshMinutes * 60 * 1000);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    return { ...status, running };
  }

  return { start, stop, checkAndUpdate, getStatus, fetchLatest };
}
