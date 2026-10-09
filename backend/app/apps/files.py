"""Putting an app's files on disk (to check or run them) and into a zip (to download).

A running app can write anything inside its own folder, including symbolic links that
point outside it. Everything here therefore refuses to write or delete *through* a
link: each folder on the way is checked, and a link in the way is removed, not followed.
"""

from __future__ import annotations

import io
import os
import shutil
import stat
import zipfile
from pathlib import Path

from app.apps.stacks import clean_path


def remove_path(path: Path) -> None:
    """Deletes a file, a link or a folder — never what a link points to."""
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return
    if stat.S_ISDIR(mode):
        shutil.rmtree(path, ignore_errors=True)
    else:
        os.unlink(path)


def real_dir(path: Path) -> None:
    """Makes sure `path` is a real folder (replacing a file or link that is in the way)."""
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        os.mkdir(path)
        return
    if not stat.S_ISDIR(mode):
        os.unlink(path)
        os.mkdir(path)


def safe_write(root: Path, relative: str, content: str) -> None:
    parts = clean_path(relative).split("/")
    current = root
    for part in parts[:-1]:
        current = current / part
        real_dir(current)
    target = current / parts[-1]
    remove_path(target)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(target, flags, 0o644)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
        handle.write(content)


def write_tree(root: Path, files: dict[str, str], previous: list[str] | None = None) -> None:
    """Writes `files` under `root`. Paths written last time (`previous`) that are no
    longer part of the app are removed; anything else in the folder is left alone."""
    root.mkdir(parents=True, exist_ok=True)
    for old in previous or []:
        if old in files:
            continue
        try:
            parts = clean_path(old).split("/")
        except ValueError:
            continue
        current = root
        reachable = True
        for part in parts[:-1]:
            current = current / part
            if not current.is_dir() or current.is_symlink():
                reachable = False
                break
        if reachable:
            remove_path(current / parts[-1])
    for path, content in files.items():
        safe_write(root, path, content)


def folder_bytes(root: Path, skip: tuple[str, ...] = ()) -> int:
    """Size of everything under `root` (links are counted, not followed)."""
    total = 0
    for folder, names, files in os.walk(root, followlinks=False):
        if folder == str(root):
            names[:] = [n for n in names if n not in skip]
        for name in files:
            try:
                total += os.lstat(os.path.join(folder, name)).st_size
            except OSError:
                continue
    return total


def is_socket(path: Path) -> bool:
    try:
        return stat.S_ISSOCK(os.lstat(path).st_mode)
    except OSError:
        return False


def is_regular(path: Path) -> bool:
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def zip_bytes(files: dict[str, str], folder: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(files):
            archive.writestr(f"{folder}/{clean_path(path)}", files[path])
    return buffer.getvalue()
