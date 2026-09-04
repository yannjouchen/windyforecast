#!/usr/bin/env python3
"""
CWA WRF 3 km -> Renwu point rainfall extractor using ECMWF ecCodes Python bindings.

Downloads:
  M-A0064-006.grb2
  M-A0064-012.grb2
  M-A0064-018.grb2

This version intentionally uses `eccodes` instead of `pygrib`:
- Windows pip wheels are available for eccodes.
- Railway/Linux also works from requirements.txt.
- We inspect GRIB startStep/endStep before deciding accumulation semantics.
"""

import json
import math
import os
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
    ch for ch in os.environ.get("CWA_EXPECTED_INITIAL_TIME", "") if ch.isdigit()
)[:12]
OUTPUT_JSON = Path(os.environ.get("OUTPUT_JSON", "data/wrf-renwu.json"))

HOURS = (6, 12, 18)
SOURCE_BASE = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Model"


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin(dp / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


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


def normalize_longitudes(lons):
    arr = np.asarray(lons, dtype=float)
    # Target longitude uses 0..180. Convert any 0..360 longitudes to -180..180.
    return np.where(arr > 180.0, arr - 360.0, arr)


def download(hour, work_dir):
    code = f"{hour:03d}"
    url = f"{SOURCE_BASE}/M-A0064-{code}.grb2"
    path = Path(work_dir) / f"M-A0064-{code}.grb2"

    print(f"download {url}", flush=True)
    with requests.get(
        url,
        stream=True,
        timeout=(30, 300),
        headers={"User-Agent": "windyforecast-renwu/2.0"},
    ) as response:
        response.raise_for_status()
        with path.open("wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)

    size_mb = path.stat().st_size / 1024 / 1024
    if size_mb < 1:
        raise RuntimeError(f"GRIB2 file unexpectedly small: {size_mb:.2f} MB")

    print(f"downloaded {path.name}: {size_mb:.1f} MB", flush=True)
    return path, url


def precipitation_score(gid):
    name = str(safe_get(gid, "name", "")).lower()
    short_name = str(safe_get(gid, "shortName", "")).lower()
    parameter_name = str(safe_get(gid, "parameterName", "")).lower()
    step_type = str(safe_get(gid, "stepType", "")).lower()
    level_type = str(safe_get(gid, "typeOfLevel", "")).lower()

    discipline = to_int(safe_get(gid, "discipline"))
    category = to_int(safe_get(gid, "parameterCategory"))
    number = to_int(safe_get(gid, "parameterNumber"))

    text = " ".join([name, short_name, parameter_name])
    score = 0

    # WMO GRIB2 total precipitation.
    if discipline == 0 and category == 1 and number == 8:
        score += 300

    if "total precipitation" in text:
        score += 250
    elif "precipitation" in text:
        score += 100

    if short_name in {"tp", "apcp"}:
        score += 180

    if step_type in {"accum", "accumulation"}:
        score += 60

    if "surface" in level_type:
        score += 20

    return score


def convert_to_mm(raw_value, units):
    u = str(units or "").strip().lower().replace(" ", "")

    if u == "m":
        return raw_value * 1000.0

    # 1 kg m^-2 liquid-water depth == 1 mm.
    if "kg" in u and ("m-2" in u or "m**-2" in u):
        return raw_value

    if u in {"mm", "millimetres", "millimeters"}:
        return raw_value

    # CWA documentation defines total precipitation in mm. Keep the raw value
    # for other unit labels, but expose the original unit in output for audit.
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
        return d + t


def shift_iso_hours(value, hours):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (dt + timedelta(hours=hours)).isoformat()
    except Exception:
        return None


def extract_point(path, expected_hour):
    best_score = -1
    best = None
    message_number = 0

    with open(path, "rb") as fh:
        while True:
            gid = codes_grib_new_from_file(fh)
            if gid is None:
                break

            message_number += 1
            try:
                score = precipitation_score(gid)
                if score <= best_score:
                    continue

                # Only materialize arrays for a better precipitation candidate.
                values = np.asarray(codes_get_array(gid, "values"), dtype=float)
                lats = np.asarray(codes_get_array(gid, "latitudes"), dtype=float)
                lons = normalize_longitudes(
                    codes_get_array(gid, "longitudes")
                )

                if not (len(values) == len(lats) == len(lons)):
                    continue

                lon_scale = math.cos(math.radians(TARGET_LAT))
                d2 = (
                    (lats - TARGET_LAT) ** 2
                    + ((lons - TARGET_LON) * lon_scale) ** 2
                )

                finite = (
                    np.isfinite(values)
                    & np.isfinite(lats)
                    & np.isfinite(lons)
                )
                d2 = np.where(finite, d2, np.inf)

                flat_index = int(np.argmin(d2))
                if not math.isfinite(float(d2[flat_index])):
                    continue

                raw = float(values[flat_index])
                units = str(safe_get(gid, "units", "") or "")
                mm = convert_to_mm(raw, units)

                if not math.isfinite(mm) or mm < -0.01 or mm > 5000:
                    continue

                start_step = to_int(safe_get(gid, "startStep"))
                end_step = to_int(safe_get(gid, "endStep"))
                forecast_time = to_int(
                    safe_get(gid, "forecastTime"),
                    expected_hour,
                )

                candidate = {
                    "forecast_hour": expected_hour,
                    "message_number": message_number,
                    "name": str(safe_get(gid, "name", "")),
                    "short_name": str(safe_get(gid, "shortName", "")),
                    "units": units,
                    "step_type": str(safe_get(gid, "stepType", "")),
                    "step_range": str(safe_get(gid, "stepRange", "")),
                    "start_step": start_step,
                    "end_step": (
                        end_step
                        if end_step is not None
                        else forecast_time
                    ),
                    "raw_precip_mm": round(max(0.0, mm), 4),
                    "grid_lat": float(lats[flat_index]),
                    "grid_lon": float(lons[flat_index]),
                    "data_date": to_int(safe_get(gid, "dataDate")),
                    "data_time": to_int(safe_get(gid, "dataTime")),
                    "validity_date": to_int(
                        safe_get(gid, "validityDate")
                    ),
                    "validity_time": to_int(
                        safe_get(gid, "validityTime")
                    ),
                }

                best_score = score
                best = candidate
            finally:
                codes_release(gid)

    if best is None:
        raise RuntimeError("GRIB2 找不到可辨識的 Total precipitation 欄位")

    cycle = date_time_to_cycle(best["data_date"], best["data_time"])
    if EXPECTED_INITIAL and cycle and cycle != EXPECTED_INITIAL:
        raise RuntimeError(
            f"GRIB cycle 與 metadata 不一致："
            f"expected={EXPECTED_INITIAL}, actual={cycle}"
        )

    best["cycle"] = cycle or EXPECTED_INITIAL or None
    best["valid_time"] = valid_time_string(
        best["validity_date"],
        best["validity_time"],
    )

    print(
        "precip field "
        f"message={best['message_number']} score={best_score} "
        f"name={best['name']} shortName={best['short_name']} "
        f"units={best['units']} "
        f"stepType={best['step_type']} "
        f"stepRange={best['step_range']} "
        f"grid={best['grid_lat']:.6f},{best['grid_lon']:.6f} "
        f"value={best['raw_precip_mm']:.3f}mm",
        flush=True,
    )

    return best


def derive_periods(rows):
    rows = sorted(rows, key=lambda r: r["forecast_hour"])

    starts = [r["start_step"] for r in rows]
    ends = [r["end_step"] for r in rows]

    # A: accumulated from model initial time.
    if starts == [0, 0, 0] and ends == [6, 12, 18]:
        previous = 0.0
        result = []

        for row in rows:
            cumulative = row["raw_precip_mm"]
            period = cumulative - previous

            if period < -0.2:
                raise RuntimeError(
                    "Total precipitation 隨 forecast hour 明顯下降，"
                    "無法安全視為從起報累積值"
                )

            period = max(0.0, period)
            result.append(
                {
                    "forecast_hour": row["forecast_hour"],
                    "valid_time": row["valid_time"],
                    "period_start_time": shift_iso_hours(row["valid_time"], -6),
                    "period_end_time": row["valid_time"],
                    "period_mm": round(period, 1),
                    "cumulative_mm": round(cumulative, 1),
                }
            )
            previous = cumulative

        return "cumulative_from_initial", result

    # B: each file is one six-hour accumulation interval.
    if starts == [0, 6, 12] and ends == [6, 12, 18]:
        cumulative = 0.0
        result = []

        for row in rows:
            period = row["raw_precip_mm"]
            cumulative += period
            result.append(
                {
                    "forecast_hour": row["forecast_hour"],
                    "valid_time": row["valid_time"],
                    "period_start_time": shift_iso_hours(row["valid_time"], -6),
                    "period_end_time": row["valid_time"],
                    "period_mm": round(period, 1),
                    "cumulative_mm": round(cumulative, 1),
                }
            )

        return "six_hour_intervals", result

    raise RuntimeError(
        "無法判斷 GRIB Total precipitation 累積定義；"
        f"startStep={starts}, endStep={ends}。"
        "為避免錯算，停止更新。"
    )


def write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(tmp, path)


def main():
    with tempfile.TemporaryDirectory(prefix="renwu-wrf-") as work_dir:
        rows = []
        sources = []

        for hour in HOURS:
            path, url = download(hour, work_dir)
            rows.append(extract_point(path, hour))
            sources.append(url)

    cycles = {row["cycle"] for row in rows if row.get("cycle")}
    if len(cycles) > 1:
        raise RuntimeError(
            f"偵測到不同 WRF cycle，稍後重試：{sorted(cycles)}"
        )

    if EXPECTED_INITIAL and cycles and EXPECTED_INITIAL not in cycles:
        raise RuntimeError(
            f"WRF cycle 不符 metadata："
            f"expected={EXPECTED_INITIAL}, actual={sorted(cycles)}"
        )

    grid_points = {
        (round(row["grid_lat"], 6), round(row["grid_lon"], 6))
        for row in rows
    }
    if len(grid_points) != 1:
        raise RuntimeError(
            f"+006/+012/+018 使用不同格點：{sorted(grid_points)}"
        )

    semantics, forecast = derive_periods(rows)

    grid_lat = rows[0]["grid_lat"]
    grid_lon = rows[0]["grid_lon"]

    result = {
        "status": "ok",
        "generated_at": now_iso(),
        "model": "CWA WRF 3 km",
        "schema_version": 2,
        "cwa_initial_time": (
            EXPECTED_INITIAL
            or rows[0].get("cycle")
            or None
        ),
        # Use GRIB validity time minus 6h as the unambiguous model initial
        # timestamp. Keep UTC in the API; the browser renders Asia/Taipei.
        "model_initial_time": (
            forecast[0].get("period_start_time")
            if forecast
            else None
        ),
        "display_timezone": "Asia/Taipei",
        "precipitation_semantics": semantics,
        "target": {
            "lat": TARGET_LAT,
            "lon": TARGET_LON,
        },
        "grid_point": {
            "lat": round(grid_lat, 6),
            "lon": round(grid_lon, 6),
            "distance_km": round(
                haversine_km(
                    TARGET_LAT,
                    TARGET_LON,
                    grid_lat,
                    grid_lon,
                ),
                3,
            ),
        },
        "forecast": forecast,
        "source_files": sources,
        "grib_field": {
            "message_number": rows[0]["message_number"],
            "name": rows[0]["name"],
            "short_name": rows[0]["short_name"],
            "units": rows[0]["units"],
            "step_type": rows[0]["step_type"],
            "step_range_006": rows[0]["step_range"],
            "step_range_012": rows[1]["step_range"],
            "step_range_018": rows[2]["step_range"],
        },
    }

    write_atomic(OUTPUT_JSON, result)
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
