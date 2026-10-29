from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Transcript:
    text: str
    confidence: float | None


class Provider(ABC):
    name: str

    @abstractmethod
    async def transcribe(
        self, audio: bytes, mime: str, language: str = "te"
    ) -> Transcript:
        raise NotImplementedError

    async def translate(self, text: str, from_language: str, to_language: str) -> str:
        raise NotImplementedError
