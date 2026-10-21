"""Deterministic backend regressions: fake capture/network, no microphone/model download."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "backend"))
MODULES = [
    "test_api_engine", "test_capture_switch", "test_mf_capture",
    "test_native_subtitles", "test_loopback_capture", "test_recording_regression",
]

if __name__ == "__main__":
    suite = unittest.TestLoader().loadTestsFromNames(MODULES)
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
