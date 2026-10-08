"""The local speech models NEXUS AI can install, pinned to exact revisions.

Every file is verified against its size and SHA-256 after download, so an
install is either exactly these bytes or nothing.
"""

from __future__ import annotations

from dataclasses import dataclass

HF = "https://huggingface.co"


@dataclass(frozen=True)
class ModelFile:
    path: str  # path inside the repository
    size: int
    sha256: str

    @property
    def name(self) -> str:
        return self.path.rsplit("/", 1)[-1]


@dataclass(frozen=True)
class SpeechModel:
    id: str
    kind: str  # "stt" | "tts"
    label: str
    languages: tuple[str, ...]
    repo: str
    revision: str
    files: tuple[ModelFile, ...]
    license: str
    source: str
    description: str
    speakers: int = 1

    @property
    def size(self) -> int:
        return sum(f.size for f in self.files)

    def url(self, file: ModelFile) -> str:
        return f"{HF}/{self.repo}/resolve/{self.revision}/{file.path}"


_WHISPER_TOKENIZER = ModelFile(
    "tokenizer.json", 2_203_239, "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"
)
_WHISPER_VOCAB = ModelFile(
    "vocabulary.txt", 459_861, "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"
)
_PIPER = ("rhasspy/piper-voices", "c10ece1aade47bb51c153c893d14e5bf8e5b7117")

MODELS: dict[str, SpeechModel] = {
    m.id: m
    for m in (
        SpeechModel(
            id="whisper-base",
            kind="stt",
            label="Whisper base (faster-whisper)",
            languages=("multilingual",),
            repo="Systran/faster-whisper-base",
            revision="ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
            files=(
                ModelFile(
                    "config.json",
                    2_309,
                    "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a",
                ),
                ModelFile(
                    "model.bin",
                    145_217_532,
                    "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9",
                ),
                _WHISPER_TOKENIZER,
                _WHISPER_VOCAB,
            ),
            license="MIT",
            source=f"{HF}/Systran/faster-whisper-base",
            description="Fast speech recognition for English, Arabic and ~95 other languages. "
            "About 1-2 s per short message on this computer's CPU.",
        ),
        SpeechModel(
            id="whisper-small",
            kind="stt",
            label="Whisper small (faster-whisper)",
            languages=("multilingual",),
            repo="Systran/faster-whisper-small",
            revision="536b0662742c02347bc0e980a01041f333bce120",
            files=(
                ModelFile(
                    "config.json",
                    2_370,
                    "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828",
                ),
                ModelFile(
                    "model.bin",
                    483_546_902,
                    "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
                ),
                _WHISPER_TOKENIZER,
                _WHISPER_VOCAB,
            ),
            license="MIT",
            source=f"{HF}/Systran/faster-whisper-small",
            description="More accurate, especially for accents and Arabic, but about 3 times slower "
            "than base on CPU.",
        ),
        SpeechModel(
            id="piper-en_US-libritts_r-medium",
            kind="tts",
            label="Piper English (LibriTTS-R, 904 voices)",
            languages=("en",),
            repo=_PIPER[0],
            revision=_PIPER[1],
            files=(
                ModelFile(
                    "en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx",
                    78_580_914,
                    "10bb85e071d616fcf4071f369f1799d0491492ab3c5d552ec19fb548fac13195",
                ),
                ModelFile(
                    "en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx.json",
                    20_123,
                    "b471dc60d2d8335e819c393d196d6fbf792817f40051257b269878505bc9afb3",
                ),
            ),
            license="Voice data CC BY 4.0 (LibriTTS-R); Piper engine GPL-3.0",
            source=f"{HF}/rhasspy/piper-voices/tree/main/en/en_US/libritts_r/medium",
            description="Natural English speech; each employee gets their own voice "
            "from the 904 speakers.",
            speakers=904,
        ),
        SpeechModel(
            id="piper-ar_JO-kareem-medium",
            kind="tts",
            label="Piper Arabic (Kareem)",
            languages=("ar",),
            repo=_PIPER[0],
            revision=_PIPER[1],
            files=(
                ModelFile(
                    "ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx",
                    63_201_294,
                    "9e95cab07b679da603bba17c4dec7ab3111320571964ee95c0379603c086491e",
                ),
                ModelFile(
                    "ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx.json",
                    5_024,
                    "ea6d9b9d9076dbdb6bf5c98c6a141ef154959d2359709b37855727964e7d6c4d",
                ),
            ),
            license="See dataset terms (github.com/AliMokhammad/arabicttstrain); "
            "Piper engine GPL-3.0",
            source=f"{HF}/rhasspy/piper-voices/tree/main/ar/ar_JO/kareem/medium",
            description="Arabic speech (one male voice, used for every employee).",
        ),
    )
}

STT_MODELS = [m.id for m in MODELS.values() if m.kind == "stt"]
DEFAULT_STT = "whisper-base"
EN_VOICE = "piper-en_US-libritts_r-medium"
AR_VOICE = "piper-ar_JO-kareem-medium"
