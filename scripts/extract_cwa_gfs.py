#!/usr/bin/env python3
"""
CWA official GFS 0.25° -> Renwu point rainfall extractor.

Experimental/direct source:
  M-A0060-024.grb2
  M-A0060-048.grb2
  M-A0060-072.grb2
  M-A0060-096.grb2
  M-A0060-120.grb2

Why only 24-hour steps?
- The website already has hourly/near-term GFS through Open-Meteo.
- For the CWA direct experiment, five cumulative files are enough to derive
  five fixed 24-hour rainfall blocks if Total precipitation is cumulative
  from model initialization.
- This substantially reduces downloads compared with fetching every 6-hour
  forecast file through day 5.

Safety rule:
- Full mode ONLY accepts Total precipitation with startStep=0 and
  endStep=24/48/72/96/120.
- If the selected field is merely "previous 6h accumulation", the updater
  fails instead of pretending it is a daily total.
"""

import json
import math
import os
import re
import sys
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

import numpy as np
import requests
from eccodes import (
    codes_get,
    codes_get_array,
    codes_grib_new_from_file,
    codes_release,
)

TARGET_LAT = float(os.environ.get("TARGET_LAT", "22.705864872692686"))
TARGET_LON = float(os.environ.get("TARGET_LON", "120.33468473266137"))
EXPECTED_INITIAL = "".join(
    c for c in os.environ.get("CWA_EXPECTED_INITIAL_TIME", "") if c.isdigit()
)[:12]
OUTPUT_JSON = Path(os.environ.get("OUTPUT_JSON", "data/cwa-gfs-renwu.json"))
MODE = os.environ.get("CWA_GFS_MODE", "full").strip().lower()

try:
    SOURCE_MAP = {
        int(k): str(v)
        for k, v in json.loads(
            os.environ.get("CWA_GFS_SOURCES_JSON", "{}")
        ).items()
    }
except Exception as exc:
    raise RuntimeError(f"CWA_GFS_SOURCES_JSON 無法解析：{exc}")

FULL_HOURS = (24, 48, 72, 96, 120)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_get(gid, key, default=None):
    try:
        return codes_get(gid, key)
    except Exception:
        return default


def to_int(value, default=None):
    try:
        return int(value)
    except Exception:
        try:
            return int(float(value))
        except Exception:
            return default


def parse_step_range(text):
    m = re.search(r"(-?\d+)\s*-\s*(-?\d+)", str(text or ""))
    if not m:
        return None, None
    return int(m.group(1)), int(m.group(2))


def normalize_longitudes(lons):
    arr = np.asarray(lons, dtype=float)
    return np.where(arr > 180.0, arr - 360.0, arr)


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin(dp / 2.0) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
    )
    return 2.0 * r * math.asin(math.sqrt(a))


def convert_to_mm(raw_value, units):
    u = str(units or "").strip().lower().replace(" ", "")
    if u == "m":
        return raw_value * 1000.0
    if "kg" in u and ("m-2" in u or "m**-2" in u):
        return raw_value
    if u in {"mm", "millimetres", "millimeters"}:
        return raw_value
    # CWA GFS documentation states precipitation in mm. Preserve raw numerical
    # value for an unknown textual unit, but expose the unit in JSON.
    return raw_value


def date_time_to_cycle(data_date, data_time):
    if data_date is None:
        return ""
    d = str(to_int(data_date, 0)).zfill(8)
    t = str(to_int(data_time, 0)).zfill(4)
    if len(d) != 8:
        return ""
    return (d + t)[:12]


def valid_time_string(validity_date, validity_time):
    d = str(to_int(validity_date, 0)).zfill(8)
    t = str(to_int(validity_time, 0)).zfill(4)
    if len(d) != 8:
        return None
    try:
        dt = datetime.strptime(d + t, "%Y%m%d%H%M")
        return dt.replace(tzinfo=timezone.utc).isoformat()
    except Exception:
        return None


def shift_iso_hours(value, hours):
    if not value:
        return None
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return (dt + timedelta(hours=hours)).isoformat()


def candidate_meta(gid, message_number, expected_hour):
    name = str(safe_get(gid, "name", "") or "")
    short_name = str(safe_get(gid, "shortName", "") or "")
    parameter_name = str(safe_get(gid, "parameterName", "") or "")
    units = str(safe_get(gid, "units", "") or "")
    step_type = str(safe_get(gid, "stepType", "") or "")
    level_type = str(safe_get(gid, "typeOfLevel", "") or "")
    step_range = str(safe_get(gid, "stepRange", "") or "")

    discipline = to_int(safe_get(gid, "discipline"))
    category = to_int(safe_get(gid, "parameterCategory"))
    number = to_int(safe_get(gid, "parameterNumber"))

    start_step = to_int(safe_get(gid, "startStep"))
    end_step = to_int(safe_get(gid, "endStep"))

    if start_step is None or end_step is None:
        parsed_start, parsed_end = parse_step_range(step_range)
        if start_step is None:
            start_step = parsed_start
        if end_step is None:
            end_step = parsed_end

    forecast_time = to_int(safe_get(gid, "forecastTime"))
    if end_step is None:
        end_step = forecast_time

    text = " ".join([name, short_name, parameter_name]).lower()
    score = 0

    # WMO GRIB2 total precipitation.
    if discipline == 0 and category == 1 and number == 8:
        score += 500

    if "total precipitation" in text:
        score += 450
    elif "precipitation" in text:
        score += 160

    if short_name.lower() in {"tp", "apcp"}:
        score += 300

    if step_type.lower() in {"accum", "accumulation"}:
        score += 140
    else:
        score -= 300

    if end_step == expected_hour:
        score += 140
    else:
        score -= 120

    # For this experiment we WANT the accumulation from model initialization.
    if start_step == 0:
        score += 180
    elif start_step == expected_hour - 6:
        # CWA docs also mention "previous 6h accumulation"; keep it visible
        # diagnostically but do not prefer it over total accumulation.
        score += 30

    if "surface" in level_type.lower():
        score += 20

    return {
        "message_number": message_number,
        "score": score,
        "name": name,
        "short_name": short_name,
        "parameter_name": parameter_name,
        "units": units,
        "step_type": step_type,
        "type_of_level": level_type,
        "discipline": discipline,
        "parameter_category": category,
        "parameter_number": number,
        "step_range": step_range,
        "start_step": start_step,
        "end_step": end_step,
        "data_date": to_int(safe_get(gid, "dataDate")),
        "data_time": to_int(safe_get(gid, "dataTime")),
        "validity_date": to_int(safe_get(gid, "validityDate")),
        "validity_time": to_int(safe_get(gid, "validityTime")),
    }


def scan_candidates(path, expected_hour):
    candidates = []
    message_number = 0

    with open(path, "rb") as fh:
        while True:
            gid = codes_grib_new_from_file(fh)
            if gid is None:
                break

            message_number += 1
            try:
                meta = candidate_meta(gid, message_number, expected_hour)
                if meta["score"] > 0:
                    candidates.append(meta)
            finally:
                codes_release(gid)

    candidates.sort(key=lambda x: x["score"], reverse=True)
    if not candidates:
        raise RuntimeError(
            f"+{expected_hour:03d} 找不到 precipitation accumulation candidate"
        )
    return candidates


def read_selected_point(path, selected):
    wanted = selected["message_number"]
    message_number = 0

    with open(path, "rb") as fh:
        while True:
            gid = codes_grib_new_from_file(fh)
            if gid is None:
                break

            message_number += 1
            try:
                if message_number != wanted:
                    continue

                values = np.asarray(codes_get_array(gid, "values"), dtype=float)
                lats = np.asarray(codes_get_array(gid, "latitudes"), dtype=float)
                lons = normalize_longitudes(codes_get_array(gid, "longitudes"))

                if not (len(values) == len(lats) == len(lons)):
                    raise RuntimeError("GRIB values/latitudes/longitudes 長度不一致")

                lon_scale = math.cos(math.radians(TARGET_LAT))
                finite = (
                    np.isfinite(values)
                    & np.isfinite(lats)
                    & np.isfinite(lons)
                )
                d2 = (
                    (lats - TARGET_LAT) ** 2
                    + ((lons - TARGET_LON) * lon_scale) ** 2
                )
                d2 = np.where(finite, d2, np.inf)

                idx = int(np.argmin(d2))
                if not math.isfinite(float(d2[idx])):
                    raise RuntimeError("找不到有效 GFS 格點")

                raw = float(values[idx])
                mm = convert_to_mm(raw, selected["units"])

                if not math.isfinite(mm) or mm < -0.01 or mm > 10000:
                    raise RuntimeError(f"GFS precipitation 值不合理：{mm}")

                return {
                    **selected,
                    "raw_precip_mm": round(max(0.0, mm), 4),
                    "grid_lat": float(lats[idx]),
                    "grid_lon": float(lons[idx]),
                }
            finally:
                codes_release(gid)

    raise RuntimeError(f"找不到已選定的 GRIB message #{wanted}")


def download(hour, work_dir):
    if hour not in SOURCE_MAP:
        raise RuntimeError(f"缺少 +{hour:03d} resource.uri")

    url = SOURCE_MAP[hour]
    path = Path(work_dir) / f"M-A0060-{hour:03d}.grb2"

    print(f"download +{hour:03d} {url}", flush=True)
    with requests.get(
        url,
        stream=True,
        timeout=(30, 600),
        headers={"User-Agent": "windyforecast-renwu/1.6"},
    ) as response:
        response.raise_for_status()
        with path.open("wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)

    size_mb = path.stat().st_size / 1024 / 1024
    if size_mb < 1:
        raise RuntimeError(
            f"M-A0060-{hour:03d}.grb2 檔案異常小：{size_mb:.2f} MB"
        )

    print(
        f"downloaded M-A0060-{hour:03d}.grb2: {size_mb:.1f} MB",
        flush=True,
    )
    return path, url, round(size_mb, 1)


def extract_hour(path, hour):
    candidates = scan_candidates(path, hour)
    selected = candidates[0]
    row = read_selected_point(path, selected)

    cycle = date_time_to_cycle(row["data_date"], row["data_time"])
    if EXPECTED_INITIAL and cycle and cycle != EXPECTED_INITIAL:
        raise RuntimeError(
            f"+{hour:03d} GRIB cycle 不符：expected={EXPECTED_INITIAL}, actual={cycle}"
        )

    row["cycle"] = cycle or EXPECTED_INITIAL or None
    row["valid_time"] = valid_time_string(
        row["validity_date"], row["validity_time"]
    )
    row["top_candidates"] = [
        {
            "message_number": x["message_number"],
            "score": x["score"],
            "name": x["name"],
            "short_name": x["short_name"],
            "units": x["units"],
            "step_type": x["step_type"],
            "step_range": x["step_range"],
            "start_step": x["start_step"],
            "end_step": x["end_step"],
        }
        for x in candidates[:5]
    ]

    print(
        "selected precip "
        f"+{hour:03d} message={row['message_number']} "
        f"score={row['score']} "
        f"name={row['name']} shortName={row['short_name']} "
        f"units={row['units']} stepType={row['step_type']} "
        f"stepRange={row['step_range']} "
        f"start={row['start_step']} end={row['end_step']} "
        f"grid={row['grid_lat']:.6f},{row['grid_lon']:.6f} "
        f"value={row['raw_precip_mm']:.3f}mm",
        flush=True,
    )

    return row


def build_probe(row, source_url, size_mb):
    usable = (
        row["start_step"] == 0
        and row["end_step"] == 24
        and str(row["step_type"]).lower() in {"accum", "accumulation"}
    )

    return {
        "status": "ok",
        "mode": "probe",
        "generated_at": now_iso(),
        "model": "CWA GFS 0.25° official direct",
        "cwa_initial_time": row.get("cycle"),
        "forecast_hour": 24,
        "usable_for_5day": usable,
        "target": {"lat": TARGET_LAT, "lon": TARGET_LON},
        "grid_point": {
            "lat": round(row["grid_lat"], 6),
            "lon": round(row["grid_lon"], 6),
            "distance_km": round(
                haversine_km(
                    TARGET_LAT, TARGET_LON,
                    row["grid_lat"], row["grid_lon"]
                ),
                3,
            ),
        },
        "selected_field": {
            "message_number": row["message_number"],
            "name": row["name"],
            "short_name": row["short_name"],
            "units": row["units"],
            "step_type": row["step_type"],
            "step_range": row["step_range"],
            "start_step": row["start_step"],
            "end_step": row["end_step"],
            "raw_precip_mm": row["raw_precip_mm"],
            "valid_time": row["valid_time"],
        },
        "top_candidates": row["top_candidates"],
        "source_file": source_url,
        "source_file_mb": size_mb,
        "note": (
            "usable_for_5day=true 才代表 +024 找到的是從模式起報累積到 +24h 的 Total precipitation。"
            "若為 false，完整 1–5 天更新不應啟用。"
        ),
    }


def build_full(rows, sources, sizes):
    rows = sorted(rows, key=lambda x: x["end_step"])
    hours = [x["end_step"] for x in rows]
    starts = [x["start_step"] for x in rows]

    if hours != list(FULL_HOURS) or starts != [0, 0, 0, 0, 0]:
        raise RuntimeError(
            "CWA GFS 直讀目前只接受從模式起報累積的 Total precipitation；"
            f"startStep={starts}, endStep={hours}。"
            "若看到 18-24 / 42-48 等，代表選到前6小時累積，不可拿來算日雨量。"
        )

    cycles = {x["cycle"] for x in rows if x.get("cycle")}
    if len(cycles) > 1:
        raise RuntimeError(f"GFS 檔案 cycle 不一致：{sorted(cycles)}")

    if EXPECTED_INITIAL and cycles and EXPECTED_INITIAL not in cycles:
        raise RuntimeError(
            f"GFS cycle 不符 metadata：expected={EXPECTED_INITIAL}, actual={sorted(cycles)}"
        )

    grid_points = {
        (round(x["grid_lat"], 6), round(x["grid_lon"], 6))
        for x in rows
    }
    if len(grid_points) != 1:
        raise RuntimeError(f"GFS 各 forecast hour 格點不一致：{sorted(grid_points)}")

    forecast = []
    previous = 0.0

    for index, row in enumerate(rows, start=1):
        cumulative = row["raw_precip_mm"]
        period = cumulative - previous
        if period < -0.2:
            raise RuntimeError(
                f"GFS 累積 precipitation 在 +{row['end_step']}h 下降："
                f"previous={previous}, current={cumulative}"
            )

        period = max(0.0, period)
        valid = row["valid_time"]
        forecast.append({
            "day": index,
            "forecast_hour": row["end_step"],
            "period_start_time": shift_iso_hours(valid, -24),
            "period_end_time": valid,
            "valid_time": valid,
            "period_mm": round(period, 1),
            "cumulative_mm": round(cumulative, 1),
        })
        previous = cumulative

    first = rows[0]
    model_initial = shift_iso_hours(first["valid_time"], -24)

    return {
        "status": "ok",
        "mode": "full",
        "schema_version": 1,
        "generated_at": now_iso(),
        "model": "CWA GFS 0.25° official direct",
        "cwa_initial_time": EXPECTED_INITIAL or first.get("cycle"),
        "model_initial_time": model_initial,
        "display_timezone": "Asia/Taipei",
        "precipitation_semantics": "cumulative_from_initial",
        "target": {"lat": TARGET_LAT, "lon": TARGET_LON},
        "grid_point": {
            "lat": round(first["grid_lat"], 6),
            "lon": round(first["grid_lon"], 6),
            "distance_km": round(
                haversine_km(
                    TARGET_LAT, TARGET_LON,
                    first["grid_lat"], first["grid_lon"]
                ),
                3,
            ),
        },
        "forecast": forecast,
        "source_files": [
            {
                "forecast_hour": hour,
                "url": sources[hour],
                "size_mb": sizes[hour],
            }
            for hour in FULL_HOURS
        ],
        "grib_fields": [
            {
                "forecast_hour": row["end_step"],
                "message_number": row["message_number"],
                "name": row["name"],
                "short_name": row["short_name"],
                "units": row["units"],
                "step_type": row["step_type"],
                "step_range": row["step_range"],
                "start_step": row["start_step"],
                "end_step": row["end_step"],
            }
            for row in rows
        ],
        "note": (
            "這是 CWA 開放平台提供的 GFS 原始 GRIB2 直讀實驗。"
            "每格為模式固定 24h 時段，不等於從瀏覽器現在時間開始的未來24h。"
        ),
    }


def write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(tmp, path)


def main():
    if MODE not in {"probe", "full"}:
        raise RuntimeError(f"未知 CWA_GFS_MODE：{MODE}")

    hours = (24,) if MODE == "probe" else FULL_HOURS

    for hour in hours:
        if hour not in SOURCE_MAP:
            raise RuntimeError(f"source map 缺少 +{hour:03d}")

    rows = []
    sources = {}
    sizes = {}

    with tempfile.TemporaryDirectory(prefix="renwu-cwa-gfs-") as work_dir:
        for hour in hours:
            path, url, size_mb = download(hour, work_dir)
            row = extract_hour(path, hour)
            rows.append(row)
            sources[hour] = url
            sizes[hour] = size_mb

    if MODE == "probe":
        result = build_probe(rows[0], sources[24], sizes[24])
    else:
        result = build_full(rows, sources, sizes)

    write_atomic(OUTPUT_JSON, result)
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
