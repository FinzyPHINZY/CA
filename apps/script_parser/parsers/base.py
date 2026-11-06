"""Abstract base class for all script parsers (task 4.0.5)."""
from abc import ABC, abstractmethod

from models.schema import ParseResult


class BaseParser(ABC):
    """All format parsers implement this single interface."""

    @abstractmethod
    def parse(self, file_bytes: bytes) -> ParseResult:
        """
        Parse raw file bytes into a structured ParseResult.
        Must be deterministic — no LLM calls in parsers.
        Raises ValueError for unrecoverable parse errors.
        """
        ...
