#!/usr/bin/env python3
"""Find the streamer's face in a time range so the facecam panel can be cropped around it.

Usage: python3 scripts/clips/detect_face.py VIDEO START END
Prints JSON: {"width", "height", "face": {"x", "y", "w", "h"} | null, "samples"}
"""
import json
import statistics
import sys

import cv2


def main():
    path, start, end = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    capture = cv2.VideoCapture(path)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

    faces = []
    samples = 12
    for index in range(samples):
        t = start + (end - start) * (index + 0.5) / samples
        capture.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = capture.read()
        if not ok:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        found = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(60, 60))
        if len(found):
            faces.append(max(found, key=lambda f: f[2] * f[3]))

    face = None
    if faces:
        face = {key: int(statistics.median(f[i] for f in faces)) for i, key in enumerate(["x", "y", "w", "h"])}
    print(json.dumps({"width": width, "height": height, "face": face, "samples": len(faces)}))


if __name__ == "__main__":
    main()
