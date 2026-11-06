"""
Smart-turn (semantic turn-detection) inference.

Runs the pipecat smart-turn-v3 ONNX model: given an audio segment of the actor's
current utterance, returns the probability that the speaker has FINISHED their
turn. The frontend calls this at each detected pause; a high probability means
"the actor is done, advance the rehearsal".

Featurization mirrors pipecat's reference (`pipecat-ai/smart-turn` inference.py):
  - 16 kHz mono, last 8 seconds of audio
  - WhisperFeatureExtractor(chunk_length=8) -> log-mel [1, 80, 800]
  - ONNX forward -> a single value that is ALREADY a sigmoid probability
    (do NOT apply sigmoid again); threshold 0.5 = turn complete.

The model is loaded once at process start (see main.py). Inference is CPU-bound
and synchronous; callers should run `predict` in a threadpool.
"""
from __future__ import annotations

import os

import numpy as np
import onnxruntime as ort
import structlog
from transformers import WhisperFeatureExtractor

log = structlog.get_logger()

SAMPLE_RATE = 16000
MAX_SECONDS = 8
MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS  # 128000
COMPLETE_THRESHOLD = 0.5

_DEFAULT_MODEL_PATH = os.path.join(
    os.path.dirname(__file__), "assets", "smart-turn-v3.2-cpu.onnx"
)


class SmartTurn:
    """Loads the smart-turn ONNX model + Whisper feature extractor once."""

    def __init__(self, model_path: str | None = None):
        self.model_path = model_path or os.getenv(
            "SMART_TURN_MODEL_PATH", _DEFAULT_MODEL_PATH
        )
        if not os.path.exists(self.model_path):
            raise FileNotFoundError(f"smart-turn model not found: {self.model_path}")

        # CPU is plenty for an ~8M-param model; keep it single, deterministic.
        self.session = ort.InferenceSession(
            self.model_path, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name

        # chunk_length=8 -> n_samples=128000, nb_max_frames=800 (matches the
        # model's [1, 80, 800] input). feature_size defaults to 80 mel bins.
        self.feature_extractor = WhisperFeatureExtractor(chunk_length=MAX_SECONDS)

        log.info(
            "smart_turn_loaded",
            model_path=self.model_path,
            input_name=self.input_name,
        )

    def predict(self, audio: np.ndarray) -> float:
        """Return P(turn complete) in [0, 1] for a mono 16kHz float32 waveform.

        `audio` values are expected in [-1, 1]. Only the last 8 seconds are used.
        """
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        # keep the last 8 seconds (the pause + the tail of the utterance carry
        # the turn-completion signal).
        if audio.shape[0] > MAX_SAMPLES:
            audio = audio[-MAX_SAMPLES:]

        features = self.feature_extractor(
            audio,
            sampling_rate=SAMPLE_RATE,
            return_tensors="np",
            padding="max_length",
            max_length=MAX_SAMPLES,
            truncation=True,
            do_normalize=True,
        )
        input_features = features["input_features"].astype(np.float32)  # (1, 80, 800)

        outputs = self.session.run(None, {self.input_name: input_features})
        # output is already a sigmoid probability; take the scalar.
        probability = float(np.asarray(outputs[0]).reshape(-1)[0])
        return probability

    def check(self, audio: np.ndarray) -> dict:
        """Convenience wrapper returning the API shape."""
        probability = self.predict(audio)
        return {
            "probability": probability,
            "complete": probability > COMPLETE_THRESHOLD,
        }


def pcm16_to_float32(raw: bytes) -> np.ndarray:
    """Decode little-endian Int16 PCM bytes to a float32 [-1, 1] mono waveform."""
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    return samples / 32768.0
