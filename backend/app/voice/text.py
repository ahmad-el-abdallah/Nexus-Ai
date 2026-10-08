"""Turning a chat reply (Markdown) into something worth listening to."""

from __future__ import annotations

import re

ARABIC = re.compile("[\\u0600-\\u06ff\\u0750-\\u077f\\u08a0-\\u08ff\\ufb50-\\ufdff\\ufe70-\\ufeff]")
LATIN = re.compile(r"[A-Za-z]")
CHUNK_CHARS = 280


def language_of(text: str) -> str:
    """'ar' when Arabic letters outnumber Latin ones, otherwise 'en'."""
    arabic = len(ARABIC.findall(text))
    latin = len(LATIN.findall(text))
    return "ar" if arabic > latin else "en"


def speakable(markdown: str) -> str:
    """Strips formatting that sounds wrong when read aloud."""
    text = re.sub(r"```.*?```", " (code omitted) ", markdown, flags=re.DOTALL)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)  # images
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)  # links → their text
    text = re.sub(r"https?://\S+", " (link) ", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.MULTILINE)  # headings
    text = re.sub(r"^\s*>\s?", "", text, flags=re.MULTILINE)  # quotes
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)  # bullets
    text = re.sub(r"^\s*\|?[\s:-]+\|[\s|:-]*$", "", text, flags=re.MULTILINE)  # table rules
    text = text.replace("|", ", ")
    text = re.sub(r"(\*\*|__|\*|_|~~)", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    lines = [ln.strip() for ln in text.splitlines()]
    # Each line (list item, heading) becomes its own sentence.
    out = []
    for ln in lines:
        if not ln:
            continue
        out.append(ln if re.search(r"[.!?؟:;،]$", ln) else ln + ".")
    return " ".join(out).strip()


def chunks(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """Splits speech into sentence groups so playback can start quickly."""
    sentences = re.split(r"(?<=[.!?؟])\s+", text)
    out: list[str] = []
    current = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        while len(sentence) > limit:  # very long sentence: cut at a space
            cut = sentence.rfind(" ", 0, limit)
            cut = cut if cut > limit // 2 else limit
            if current:
                out.append(current)
                current = ""
            out.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if current and len(current) + 1 + len(sentence) > limit:
            out.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        out.append(current)
    return out
