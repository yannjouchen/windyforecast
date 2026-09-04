import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWaterLevelUpdater } from "../lib/waterlevel-updater.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));

const updater = createWaterLevelUpdater({
  enabled: true,
  endpoint: process.env.WATERLEVEL_ENDPOINT || "https://web.fpcitc.com.tw/PIWebAPI/streams/Recorded",
  server: process.env.WATERLEVEL_SERVER || "JWRTPMS",
  tag: process.env.WATERLEVEL_TAG || "JW_waterlevelmeter",
  stationName: process.env.WATERLEVEL_NAME || "JW_waterlevelmeter",
  unit: process.env.WATERLEVEL_UNIT || "",
  dataDir,
  refreshMinutes: Number(process.env.WATERLEVEL_REFRESH_MINUTES || 5)
});

const result = await updater.checkAndUpdate({ reason: "cli-check" });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
