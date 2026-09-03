import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

function isoNow() {
  return new Date().toISOString();
}

function normalizeInitialTime(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 12 ? digits.slice(0, 12) : "";
}

async function fetchJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "windyforecast-renwu/1.0" }
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`upstream 非 JSON（HTTP ${response.status}）`);
    }

    if (!response.ok) {
      throw new Error(
        data?.message ||
          data?.error ||
          `upstream HTTP ${response.status}`
      );
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function extractDatasetInfo(payload) {
  const root =
    payload?.cwaopendata ||
    payload?.["cwaopendata"] ||
    payload;

  const dataset = root?.dataset || payload?.dataset;
  const info = dataset?.datasetInfo;
  const resource = dataset?.resource;

  if (!info) {
    throw new Error("CWA WRF metadata 缺少 datasetInfo");
  }

  const initialTime = normalizeInitialTime(
    info.InitialTime ?? info.initialTime
  );

  if (!initialTime) {
    throw new Error("CWA WRF metadata 缺少 InitialTime");
  }

  return {
    initialTime,
    forecastHour: Number(info.ForecastHour ?? info.forecastHour),
    gridResolution: String(
      info.GridResolution ?? info.gridResolution ?? ""
    ),
    resourceUri: String(resource?.uri || "")
  };
}

async function readCurrentJson(jsonPath) {
  try {
    const raw = await fs.readFile(jsonPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function runPython({
  pythonBin,
  scriptPath,
  env
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      const s = chunk.toString();
      stdout += s;
      process.stdout.write(`[wrf:python] ${s}`);
    });

    child.stderr.on("data", chunk => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(`[wrf:python] ${s}`);
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        reject(
          new Error(
            `Python WRF extractor 結束碼 ${code}` +
              (stderr.trim() ? `：${stderr.trim().slice(-1200)}` : "")
          )
        );
      }
    });
  });
}

export function createWrfUpdater({
  cwaApiKey,
  targetLat,
  targetLon,
  dataDir,
  refreshMinutes = 60,
  pythonBin = "python3"
}) {
  const jsonPath = path.join(dataDir, "wrf-renwu.json");
  const scriptPath = path.join(
    PROJECT_ROOT,
    "scripts",
    "extract_wrf.py"
  );

  let timer = null;
  let running = false;

  const status = {
    enabled: Boolean(cwaApiKey),
    running: false,
    refresh_minutes: refreshMinutes,
    last_check_at: null,
    last_success_at: null,
    last_error_at: null,
    last_error: null,
    latest_cwa_initial_time: null,
    local_initial_time: null,
    last_action: "尚未檢查"
  };

  async function getLatestMetadata() {
    if (!cwaApiKey) {
      throw new Error("CWA_API_KEY 尚未設定");
    }

    const url = new URL(
      "https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/M-A0064-006"
    );
    url.searchParams.set("Authorization", cwaApiKey);
    url.searchParams.set("format", "JSON");

    const payload = await fetchJson(url, 20000);
    return extractDatasetInfo(payload);
  }

  async function checkAndUpdate({
    reason = "interval",
    force = false
  } = {}) {
    if (running) {
      return {
        ok: true,
        skipped: true,
        reason: "already-running",
        status: { ...status }
      };
    }

    running = true;
    status.running = true;
    status.last_check_at = isoNow();
    status.last_action = `檢查中（${reason}）`;

    try {
      await fs.mkdir(dataDir, { recursive: true });

      const meta = await getLatestMetadata();
      status.latest_cwa_initial_time = meta.initialTime;

      const current = await readCurrentJson(jsonPath);
      const localInitial = normalizeInitialTime(
        current?.cwa_initial_time
      );
      status.local_initial_time = localInitial || null;

      if (
        !force &&
        current?.status === "ok" &&
        localInitial &&
        localInitial === meta.initialTime
      ) {
        status.last_error = null;
        status.last_action =
          `無新批次：${meta.initialTime}，沿用現有 WRF JSON`;
        return {
          ok: true,
          updated: false,
          initial_time: meta.initialTime,
          status: { ...status }
        };
      }

      status.last_action =
        `發現 WRF ${meta.initialTime}，啟動 Python 解析`;

      await runPython({
        pythonBin,
        scriptPath,
        env: {
          CWA_EXPECTED_INITIAL_TIME: meta.initialTime,
          TARGET_LAT: String(targetLat),
          TARGET_LON: String(targetLon),
          OUTPUT_JSON: jsonPath
        }
      });

      const updated = await readCurrentJson(jsonPath);
      if (!updated || updated.status !== "ok") {
        throw new Error("Python 執行完成，但 wrf-renwu.json 不是有效資料");
      }

      if (
        normalizeInitialTime(updated.cwa_initial_time) !== meta.initialTime
      ) {
        throw new Error(
          `WRF JSON cycle 不一致：expected=${meta.initialTime} actual=${updated.cwa_initial_time}`
        );
      }

      status.last_success_at = isoNow();
      status.last_error = null;
      status.local_initial_time = meta.initialTime;
      status.last_action = `更新成功：${meta.initialTime}`;

      return {
        ok: true,
        updated: true,
        initial_time: meta.initialTime,
        status: { ...status }
      };
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "WRF metadata timeout"
          : error instanceof Error
            ? error.message
            : String(error);

      status.last_error_at = isoNow();
      status.last_error = message;
      status.last_action = `更新失敗：${message}`;

      console.error(`[wrf] ${message}`);

      return {
        ok: false,
        updated: false,
        error: message,
        status: { ...status }
      };
    } finally {
      running = false;
      status.running = false;
    }
  }

  function start() {
    if (timer) return;

    // Startup check after the HTTP server is already available.
    const startup = setTimeout(() => {
      void checkAndUpdate({ reason: "startup" });
    }, 2500);
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
    return { ...status };
  }

  return {
    start,
    stop,
    checkAndUpdate,
    getStatus
  };
}
