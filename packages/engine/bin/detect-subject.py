#!/usr/bin/env python3
"""
detect-subject.py — track the speaker's position across a video clip range.

Replaces the previous static-per-clip approach (5 samples → 1 median x_pct) with
dense sampling and a smoothed trajectory. Output is a list of control points
{t, x_pct} that the Node renderer turns into an ffmpeg piecewise lerp expression,
so the crop window pans smoothly with the speaker as they walk across the frame.

Pipeline:
  1. Sample frames every --interval seconds across [start, end].
  2. Run YuNet (cv2.FaceDetectorYN) on each frame. Fall back to Haar cascade if the
     YuNet model file is missing (still works, less accurate).
  3. Per frame, pick the dominant face = max(area × confidence). Handles "real person
     plus a projected face on a screen behind them" — the real person is bigger.
  4. Linearly interpolate missing detections (face occluded/turned away briefly).
     If > 3s of sustained miss, hold the last position (don't snap to center).
  5. Smooth the x trajectory with a 5-point moving average to kill jitter.
  6. Downsample to ~1 control point per 1.5s for a compact piecewise expression.

Schema (v2):
{
  "version": 2,
  "frame_dims": [1920, 1080],
  "control_points": [
    { "t": 0.0, "x_pct": 0.42, "confidence": 0.91 },
    ...
  ] | null,
  "samples_total": 75,
  "samples_with_face": 71,
  "detector": "yunet" | "haar",
  "fallback": null | "insufficient_detections"
}

Failure modes (exit non-zero so Node falls back to center crop):
  2 = input missing
  3 = deps missing
  4 = invalid range
  5 = insufficient detections (< MIN_DETECTION_RATE of samples)
"""

import argparse
import json
import os
import sys

MIN_DETECTION_RATE = 0.30  # need ≥ 30% of samples to have a confident face
SUSTAINED_MISS_SEC = 3.0   # hold last position rather than drifting if missing > 3s
SMOOTHING_WINDOW = 5       # moving average window size (must be odd)
DOWNSAMPLE_TARGET_SEC = 1.5  # one control point per ~1.5s after smoothing
YUNET_MIN_CONF = 0.5
HAAR_MIN_NEIGHBORS = 5


def _import_deps():
    import cv2
    import numpy as np
    return cv2, np


def sample_timestamps(start: float, end: float, interval: float):
    duration = end - start
    if duration <= 0 or interval <= 0:
        return []
    pad = min(0.15, duration * 0.05)
    a = start + pad
    b = end - pad
    if b <= a:
        return [start + duration / 2.0]
    ts = []
    t = a
    while t <= b:
        ts.append(round(t, 3))
        t += interval
    return ts


def extract_frame(cv2, video_path: str, timestamp: float):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            return None
        return frame
    finally:
        cap.release()


def make_yunet(cv2, model_path: str, frame_w: int, frame_h: int):
    """Create a YuNet face detector configured for the source frame size."""
    detector = cv2.FaceDetectorYN.create(
        model_path,
        "",
        (frame_w, frame_h),
        score_threshold=YUNET_MIN_CONF,
        nms_threshold=0.3,
        top_k=10,
    )
    return detector


def detect_yunet(detector, frame):
    """Returns (cx_pct, cy_pct, conf, w_pct, h_pct) for the dominant face or None."""
    h, w = frame.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(frame)
    if faces is None or len(faces) == 0:
        return None
    best = None
    best_score = -1.0
    for f in faces:
        # YuNet returns [x, y, w, h, lmk x5, lmk y5, ..., conf] (all numpy.float32).
        # Cast to Python float so the JSON serializer doesn't choke downstream.
        x, y, fw, fh = float(f[0]), float(f[1]), float(f[2]), float(f[3])
        conf = float(f[-1])
        if fw <= 0 or fh <= 0 or conf < YUNET_MIN_CONF:
            continue
        area = (fw / w) * (fh / h)
        score = area * (0.4 + 0.6 * conf)
        if score > best_score:
            best_score = score
            cx = max(0.0, min(1.0, (x + fw / 2.0) / w))
            cy = max(0.0, min(1.0, (y + fh / 2.0) / h))
            best = (cx, cy, conf, fw / w, fh / h)
    return best


def make_haar(cv2):
    cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    cascade = cv2.CascadeClassifier(cascade_path)
    if cascade.empty():
        raise RuntimeError(f"Could not load Haar cascade from {cascade_path}")
    return cascade


def detect_haar(cv2, cascade, frame):
    h, w = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    cv2.equalizeHist(gray, gray)
    min_face_px = max(60, h // 16)
    detections, _r, weights = cascade.detectMultiScale3(
        gray, scaleFactor=1.1, minNeighbors=HAAR_MIN_NEIGHBORS,
        minSize=(min_face_px, min_face_px), outputRejectLevels=True,
    )
    if len(detections) == 0:
        return None
    best = None
    best_score = -1.0
    for (x, y, fw, fh), weight in zip(detections, weights):
        if fw <= 0 or fh <= 0:
            continue
        conf = float(min(1.0, max(0.0, weight / 8.0)))
        area = (fw / w) * (fh / h)
        score = area * (0.4 + 0.6 * conf)
        if score > best_score:
            best_score = score
            cx = max(0.0, min(1.0, (x + fw / 2.0) / w))
            cy = max(0.0, min(1.0, (y + fh / 2.0) / h))
            best = (cx, cy, conf, fw / w, fh / h)
    return best


def fill_missing(samples, sustained_miss_sec: float):
    """Linearly interpolate missing detections. If a gap exceeds sustained_miss_sec,
    hold the last known position rather than interpolating (no info about the middle).
    samples is a list of {t, x, y, conf} or {t, x: None}."""
    n = len(samples)
    if n == 0:
        return samples
    # Forward pass: find segments of consecutive Nones bounded by known values.
    out = [dict(s) for s in samples]
    i = 0
    while i < n:
        if out[i]["x"] is not None:
            i += 1
            continue
        # find end of missing run
        j = i
        while j < n and out[j]["x"] is None:
            j += 1
        # neighbors: prev (i-1) and next (j)
        prev_i = i - 1 if i > 0 else -1
        next_j = j if j < n else -1
        if prev_i < 0 and next_j < 0:
            return out  # everything missing
        if prev_i < 0:
            # leading gap → copy next known
            for k in range(i, j):
                out[k]["x"] = out[next_j]["x"]
                out[k]["y"] = out[next_j]["y"]
                out[k]["conf"] = 0.0
            i = j
            continue
        if next_j < 0:
            # trailing gap → hold prev
            for k in range(i, j):
                out[k]["x"] = out[prev_i]["x"]
                out[k]["y"] = out[prev_i]["y"]
                out[k]["conf"] = 0.0
            i = j
            continue
        gap_dur = out[next_j]["t"] - out[prev_i]["t"]
        if gap_dur > sustained_miss_sec:
            # too long to trust — split: hold prev for the first half, then next for the rest
            mid = (out[prev_i]["t"] + out[next_j]["t"]) / 2.0
            for k in range(i, j):
                if out[k]["t"] < mid:
                    out[k]["x"] = out[prev_i]["x"]
                    out[k]["y"] = out[prev_i]["y"]
                else:
                    out[k]["x"] = out[next_j]["x"]
                    out[k]["y"] = out[next_j]["y"]
                out[k]["conf"] = 0.0
        else:
            # linear interp
            x0, x1 = out[prev_i]["x"], out[next_j]["x"]
            y0, y1 = out[prev_i]["y"], out[next_j]["y"]
            t0, t1 = out[prev_i]["t"], out[next_j]["t"]
            for k in range(i, j):
                frac = (out[k]["t"] - t0) / (t1 - t0)
                out[k]["x"] = x0 + frac * (x1 - x0)
                out[k]["y"] = y0 + frac * (y1 - y0)
                out[k]["conf"] = 0.0
        i = j
    return out


def moving_average(values, window):
    if window <= 1 or len(values) < 2:
        return list(values)
    half = window // 2
    n = len(values)
    out = []
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def downsample(samples, target_interval_sec: float):
    """Pick samples at roughly target_interval intervals, always including first + last."""
    if not samples:
        return []
    out = [samples[0]]
    for s in samples[1:]:
        if s["t"] - out[-1]["t"] >= target_interval_sec:
            out.append(s)
    if out[-1]["t"] < samples[-1]["t"]:
        out.append(samples[-1])
    return out


def main():
    parser = argparse.ArgumentParser(description="Track speaker position across a video clip range.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--interval", type=float, default=0.4, help="Seconds between samples.")
    parser.add_argument("--out", default="-")
    parser.add_argument("--yunet-model", default=None, help="Path to YuNet ONNX. Defaults to bin/models/.")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"[detect-subject] input not found: {args.input}", file=sys.stderr)
        sys.exit(2)

    try:
        cv2, np = _import_deps()
    except ImportError as e:
        print(f"[detect-subject] missing dependency ({e}). Run bash bin/setup.sh.", file=sys.stderr)
        sys.exit(3)

    timestamps = sample_timestamps(args.start, args.end, args.interval)
    if not timestamps:
        print("[detect-subject] invalid range", file=sys.stderr)
        sys.exit(4)

    # Locate YuNet model — prefer arg, else default to bin/models/.
    yunet_model_path = args.yunet_model
    if yunet_model_path is None:
        default_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "face_detection_yunet_2023mar.onnx")
        if os.path.exists(default_path):
            yunet_model_path = default_path

    detector = None
    detector_name = "haar"
    haar_cascade = None
    if yunet_model_path and os.path.exists(yunet_model_path):
        # YuNet needs to know the frame size up front; we'll create it after we've grabbed the first frame.
        detector_name = "yunet"
    else:
        haar_cascade = make_haar(cv2)
        print(f"[detect-subject] YuNet model not found, falling back to Haar cascade.", file=sys.stderr)

    yunet_detector = None
    samples = []
    frame_dims = None

    for ts in timestamps:
        frame = extract_frame(cv2, args.input, ts)
        if frame is None:
            samples.append({"t": ts - args.start, "x": None, "y": None, "conf": None})
            continue
        h, w = frame.shape[:2]
        if frame_dims is None:
            frame_dims = [w, h]
            if detector_name == "yunet":
                yunet_detector = make_yunet(cv2, yunet_model_path, w, h)

        if detector_name == "yunet":
            det = detect_yunet(yunet_detector, frame)
        else:
            det = detect_haar(cv2, haar_cascade, frame)

        if det is None:
            samples.append({"t": ts - args.start, "x": None, "y": None, "conf": None})
        else:
            cx, cy, conf, _w, _h = det
            samples.append({"t": ts - args.start, "x": cx, "y": cy, "conf": conf})

    samples_with_face = sum(1 for s in samples if s["x"] is not None)
    detection_rate = samples_with_face / len(samples) if samples else 0

    if detection_rate < MIN_DETECTION_RATE:
        print(
            f"[detect-subject] only {samples_with_face}/{len(samples)} samples had a confident face "
            f"(rate {detection_rate:.2f} < {MIN_DETECTION_RATE}) — falling back.",
            file=sys.stderr,
        )
        sys.exit(5)

    # Fill missing detections, smooth, then downsample to control points.
    filled = fill_missing(samples, SUSTAINED_MISS_SEC)
    xs = [s["x"] for s in filled]
    smoothed_x = moving_average(xs, SMOOTHING_WINDOW)
    smoothed = [
        {"t": filled[i]["t"], "x": smoothed_x[i], "conf": filled[i]["conf"] if filled[i]["conf"] is not None else 0.0}
        for i in range(len(filled))
    ]
    control_points = downsample(smoothed, DOWNSAMPLE_TARGET_SEC)

    result = {
        "version": 2,
        "frame_dims": frame_dims,
        "control_points": [
            {"t": round(p["t"], 3), "x_pct": round(p["x"], 4), "confidence": round(p["conf"], 3)}
            for p in control_points
        ],
        "samples_total": len(samples),
        "samples_with_face": samples_with_face,
        "detector": detector_name,
        "fallback": None,
    }

    payload = json.dumps(result, indent=2)
    if args.out == "-":
        print(payload)
    else:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w") as f:
            f.write(payload)

    sys.exit(0)


if __name__ == "__main__":
    main()
