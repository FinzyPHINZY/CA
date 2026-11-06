"""Tests for the smart-turn inference module."""
import numpy as np
import pytest

from smart_turn import SmartTurn, pcm16_to_float32


@pytest.fixture(scope="module")
def model() -> SmartTurn:
    return SmartTurn()


def test_predict_returns_probability(model: SmartTurn):
    p = model.predict(np.zeros(16000 * 2, dtype=np.float32))
    assert isinstance(p, float)
    assert 0.0 <= p <= 1.0


def test_check_shape(model: SmartTurn):
    out = model.check(np.zeros(16000, dtype=np.float32))
    assert set(out.keys()) == {"probability", "complete"}
    assert isinstance(out["probability"], float)
    assert isinstance(out["complete"], bool)
    assert out["complete"] == (out["probability"] > 0.5)


def test_runs_on_real_ish_signal(model: SmartTurn):
    # a tone+noise signal produces real (non-floor) features — just confirm it
    # runs and stays in range (discrimination quality is inherited from pipecat).
    t = np.linspace(0, 2, 16000 * 2, dtype=np.float32)
    sig = (0.3 * np.sin(2 * np.pi * 200 * t) + 0.05 * np.random.randn(len(t))).astype(
        np.float32
    )
    p = model.predict(sig)
    assert 0.0 <= p <= 1.0


def test_truncates_to_last_8s(model: SmartTurn):
    # >8s input must not crash (it's truncated to the last 8s internally).
    p = model.predict(np.zeros(16000 * 20, dtype=np.float32))
    assert 0.0 <= p <= 1.0


def test_pcm16_to_float32_roundtrip():
    raw = np.array([0, 16384, -16384, 32767], dtype="<i2").tobytes()
    f = pcm16_to_float32(raw)
    assert f.dtype == np.float32
    assert len(f) == 4
    assert f[0] == 0.0
    assert abs(f[1] - 0.5) < 0.001  # 16384 / 32768


def test_pcm16_empty():
    f = pcm16_to_float32(b"")
    assert f.shape[0] == 0
