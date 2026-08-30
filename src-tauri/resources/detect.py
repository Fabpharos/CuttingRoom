"""Bulk object detection for Cutting Room's Detection tab.

Only detects — does not write any pixelated images. Emits progress on
stdout as `PROGRESS <done> <total>` lines, and writes the full detection
manifest (boxes + class names) to the file given by --json-out. The Rust
side applies the actual pixelation afterward, once the user has reviewed
and confirmed which boxes to obscure.
"""

import argparse
import json
import sys
from pathlib import Path

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_folder")
    parser.add_argument("--model", required=True)
    parser.add_argument("--conf", type=float, default=0.3)
    parser.add_argument("--classes", type=str, default=None, help="comma-separated class ids")
    parser.add_argument("--json-out", required=True)
    args = parser.parse_args()

    classes = None
    if args.classes:
        classes = [int(c) for c in args.classes.split(",") if c.strip() != ""]

    try:
        from ultralytics import YOLO
    except ImportError as exc:
        print(f"ERROR ultralytics is not installed: {exc}", file=sys.stderr)
        return 1

    try:
        model = YOLO(args.model)
    except Exception as exc:  # model file missing/invalid, etc.
        print(f"ERROR failed to load model '{args.model}': {exc}", file=sys.stderr)
        return 1

    print("MODEL_LOADED", flush=True)

    paths = sorted(
        p for p in Path(args.input_folder).iterdir() if p.suffix.lower() in IMAGE_EXTENSIONS
    )
    total = len(paths)
    results_out = []

    for i, p in enumerate(paths):
        try:
            r = model.predict(source=str(p), conf=args.conf, classes=classes, verbose=False)[0]
            boxes = []
            for b in r.boxes:
                xyxy = b.xyxy[0].tolist()
                boxes.append(
                    {
                        "x1": xyxy[0],
                        "y1": xyxy[1],
                        "x2": xyxy[2],
                        "y2": xyxy[3],
                        "cls": int(b.cls[0]),
                        "conf": float(b.conf[0]),
                    }
                )
            height, width = r.orig_shape
            results_out.append(
                {"path": str(p), "width": width, "height": height, "boxes": boxes}
            )
        except Exception as exc:
            print(f"WARN failed on {p}: {exc}", file=sys.stderr)
            results_out.append({"path": str(p), "width": 0, "height": 0, "boxes": []})

        print(f"PROGRESS {i + 1} {total}", flush=True)

    class_names = {str(k): v for k, v in model.names.items()}
    with open(args.json_out, "w", encoding="utf-8") as f:
        json.dump({"classNames": class_names, "results": results_out}, f)

    return 0


if __name__ == "__main__":
    sys.exit(main())
