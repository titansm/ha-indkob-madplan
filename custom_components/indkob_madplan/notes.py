"""Datamodel for de to noter: Indkøbsliste (tjekliste) og Madplan (fri tekst).

Ren Python uden Home Assistant-afhængigheder.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from .stats import is_header, normalize

TYPE_ITEM = "item"
TYPE_HEADER = "header"
TYPE_BLANK = "blank"
LINE_TYPES = (TYPE_ITEM, TYPE_HEADER, TYPE_BLANK)

_CHECK_RE = re.compile(r"^\s*(?:[-*]\s*)?(\[( |x|X)\]|☐|☑|✅|✓|✔)\s*")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def guess_type(text: str) -> str:
    if not text.strip():
        return TYPE_BLANK
    return TYPE_HEADER if is_header(text) else TYPE_ITEM


class ShoppingNote:
    """Tjekliste med overskrifter og mellemrum, i rækkefølge."""

    def __init__(self, data: dict | None = None) -> None:
        data = data or {}
        self.lines: list[dict[str, Any]] = data.get("lines", [])
        self.version: int = data.get("version", 0)
        self.updated: str | None = data.get("updated")
        self.updated_by: str | None = data.get("updated_by")
        # nøgle -> overskrift (læres af listen, bruges når varer tilføjes udefra)
        self.categories: dict[str, str] = data.get("categories", {})

    def as_dict(self) -> dict:
        return {
            "lines": self.lines,
            "version": self.version,
            "updated": self.updated,
            "updated_by": self.updated_by,
            "categories": self.categories,
        }

    # ------------------------------------------------------------ helpers
    def index(self, line_id: str) -> int:
        for i, ln in enumerate(self.lines):
            if ln["id"] == line_id:
                return i
        raise KeyError(line_id)

    def get(self, line_id: str) -> dict:
        return self.lines[self.index(line_id)]

    def items(self) -> list[dict]:
        return [ln for ln in self.lines if ln["type"] == TYPE_ITEM and ln["text"].strip()]

    def header_of(self, idx: int) -> str | None:
        for j in range(idx, -1, -1):
            if self.lines[j]["type"] == TYPE_HEADER:
                return self.lines[j]["text"]
        return None

    def learn_categories(self) -> None:
        current = None
        for ln in self.lines:
            if ln["type"] == TYPE_HEADER:
                current = ln["text"]
            elif ln["type"] == TYPE_ITEM and current:
                key = normalize(ln["text"])
                if key:
                    self.categories[key] = current

    # ------------------------------------------------------------ ops
    def add(
        self,
        text: str,
        *,
        after_id: str | None = None,
        line_type: str | None = None,
        checked: bool = False,
        auto_place: bool = False,
    ) -> dict:
        line_type = line_type or guess_type(text)
        line = {"id": new_id(), "text": text.strip() if line_type != TYPE_BLANK else "", "type": line_type, "checked": checked}
        if after_id == "__top__":
            pos = 0
        elif after_id:
            pos = self.index(after_id) + 1
        elif auto_place and line_type == TYPE_ITEM:
            pos = self._auto_position(text)
        else:
            pos = self._end_position()
        self.lines.insert(pos, line)
        return line

    def _end_position(self) -> int:
        pos = len(self.lines)
        while pos > 0 and self.lines[pos - 1]["type"] == TYPE_BLANK:
            pos -= 1
        return pos

    def _auto_position(self, text: str) -> int:
        """Placér under den overskrift varen plejer at stå under."""
        header = self.categories.get(normalize(text))
        if not header:
            return self._end_position()
        start = next(
            (i for i, ln in enumerate(self.lines) if ln["type"] == TYPE_HEADER and ln["text"] == header),
            None,
        )
        if start is None:
            return self._end_position()
        pos = start + 1
        while pos < len(self.lines) and self.lines[pos]["type"] == TYPE_ITEM:
            pos += 1
        return pos

    def update(self, line_id: str, *, text: str | None = None, checked: bool | None = None, line_type: str | None = None) -> dict:
        ln = self.get(line_id)
        if text is not None:
            ln["text"] = text
        if line_type is not None:
            ln["type"] = line_type
            if line_type != TYPE_ITEM:
                ln["checked"] = False
        if checked is not None and ln["type"] == TYPE_ITEM:
            ln["checked"] = checked
        return ln

    def delete(self, line_ids: list[str]) -> None:
        ids = set(line_ids)
        self.lines = [ln for ln in self.lines if ln["id"] not in ids]

    def move(self, line_id: str, after_id: str | None) -> None:
        ln = self.lines.pop(self.index(line_id))
        pos = 0 if not after_id else self.index(after_id) + 1
        self.lines.insert(pos, ln)

    def clear_checked(self) -> int:
        before = len(self.lines)
        self.lines = [ln for ln in self.lines if not (ln["type"] == TYPE_ITEM and ln["checked"])]
        return before - len(self.lines)

    def uncheck_all(self) -> None:
        for ln in self.lines:
            ln["checked"] = False

    def import_text(self, text: str) -> None:
        """Erstat listen med tekst: én linje pr. punkt; [x]/☑ = afkrydset, CAPS = overskrift."""
        lines = []
        for raw in (text or "").splitlines():
            checked = False
            m = _CHECK_RE.match(raw)
            if m:
                mark = m.group(1)
                checked = mark in ("[x]", "[X]", "☑", "✅", "✓", "✔")
                raw = raw[m.end():]
            t = raw.strip()
            typ = guess_type(t)
            lines.append({"id": new_id(), "text": t if typ != TYPE_BLANK else "", "type": typ, "checked": checked and typ == TYPE_ITEM})
        while lines and lines[-1]["type"] == TYPE_BLANK:
            lines.pop()
        self.lines = lines

    def as_text(self) -> str:
        out = []
        for ln in self.lines:
            if ln["type"] == TYPE_ITEM:
                out.append(f"[{'x' if ln['checked'] else ' '}] {ln['text']}")
            else:
                out.append(ln["text"])
        return "\n".join(out)


class TextNote:
    """Madplanen: fri tekst."""

    def __init__(self, data: dict | None = None) -> None:
        data = data or {}
        self.text: str = data.get("text", "")
        self.version: int = data.get("version", 0)
        self.updated: str | None = data.get("updated")
        self.updated_by: str | None = data.get("updated_by")

    def as_dict(self) -> dict:
        return {
            "text": self.text,
            "version": self.version,
            "updated": self.updated,
            "updated_by": self.updated_by,
        }
