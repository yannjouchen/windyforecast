import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCwaGfsUpdater } from "../lib/cwa-gfs-updater.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const isProbe = process.argv.includes("--probe");

const updater = createCwaGfsUpdater({
  enabled: true,
  cwaApiKey: String(process.env.CWA_API_KEY || "").trim(),
  targetLat: Number(process.env.TARGET_LAT || 22.705864872692686),
  targetLon: Number(process.env.TARGET_LON || 120.33468473266137),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, "data")),
  refreshMinutes: Number(process.env.CWA_GFS_REFRESH_MINUTES || 360),
  pythonBin: process.env.PYTHON_BIN || "python3"
});

const result = isProbe
  ? await updater.probe()
  : await updater.checkAndUpdate({
      reason: "npm-gfs-cwa-check",
      force: true
    });

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
