"""Datamodel for de to noter: Indkøbsliste (tjekliste) og Madplan (fri tekst).

Ren Python uden Home Assistant-afhængigheder.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from . import kategorier as K
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

    # ------------------------------------------------------------ opslag på navn
    def find_item(self, text: str) -> dict | None:
        """Samme vare på listen (normaliseret navn, også ental/flertal: "Banan" = "Bananer x3")."""
        key = normalize(text)
        if not key:
            return None
        items = self.items()
        for ln in items:
            if normalize(ln["text"]) == key:
                return ln
        st = K.stamme(key)
        for ln in items:
            if K.stamme(normalize(ln["text"])) == st:
                return ln
        return None

    def copy_structure(self) -> ShoppingNote:
        """Kopi med nye id'er og uden flueben (bruges til at starte basislisten fra listen)."""
        note = ShoppingNote()
        note.lines = [
            {"id": new_id(), "text": ln["text"], "type": ln["type"], "checked": False}
            for ln in self.lines
        ]
        note.categories = dict(self.categories)
        note.learn_categories()
        return note

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

    # ------------------------------------------------------------ kategorier
    def _group_end(self, header_idx: int) -> int:
        """Indsætningssted efter sidste vare i overskriftens gruppe (før tomme linjer)."""
        end = header_idx + 1
        while end < len(self.lines) and self.lines[end]["type"] != TYPE_HEADER:
            end += 1
        while end > header_idx + 1 and self.lines[end - 1]["type"] == TYPE_BLANK:
            end -= 1
        return end

    def _header_index(self, text: str) -> int | None:
        return next(
            (i for i, ln in enumerate(self.lines) if ln["type"] == TYPE_HEADER and ln["text"] == text),
            None,
        )

    def find_category(self, noegle: str) -> int | None:
        """Indeks på overskriften for en fast kategori (første match)."""
        for i, ln in enumerate(self.lines):
            if ln["type"] == TYPE_HEADER and K.header_noegle(ln["text"]) == noegle:
                return i
        return None

    def ensure_category(self, noegle: str) -> int:
        """Find den faste kategori – opret overskriften på butikkens plads, hvis den mangler."""
        idx = self.find_category(noegle)
        if idx is not None:
            return idx
        orden = K.ORDEN[noegle]
        header = {"id": new_id(), "text": K.NAVN[noegle], "type": TYPE_HEADER, "checked": False}
        blank = {"id": new_id(), "text": "", "type": TYPE_BLANK, "checked": False}
        for i, ln in enumerate(self.lines):
            if ln["type"] != TYPE_HEADER:
                continue
            k = K.header_noegle(ln["text"])
            if k is not None and K.ORDEN[k] > orden:
                self.lines[i:i] = [header, blank]
                return i
        pos = self._end_position()
        new = [header] if pos == 0 else [blank, header]
        self.lines[pos:pos] = new
        return pos + len(new) - 1

    def learned_header(self, text: str) -> str | None:
        """Den overskrift varen plejer at stå under (også ved ental/flertal)."""
        key = normalize(text)
        if not key:
            return None
        if (h := self.categories.get(key)) and self._header_index(h) is not None:
            return h
        st = K.stamme(key)
        for k, h in self.categories.items():
            if K.stamme(k) == st and self._header_index(h) is not None:
                return h
        return None

    def place(self, text: str) -> tuple[int, str]:
        """Hvor en ny vare skal stå: (indeks, hvordan kategorien blev fundet).

        1) under overskriften varen plejer at stå under, 2) gæt ud fra ordlisten,
        3) ellers under Ugevarer (eller sidst, hvis listen ikke har kategorier).
        """
        if (h := self.learned_header(text)) is not None:
            return self._group_end(self._header_index(h)), "laert"
        noegle = K.gaet(text)
        kilde = "gaet"
        if noegle is None:
            noegle, kilde = K.FALLBACK, "ukendt"
            if self.find_category(noegle) is None and not any(ln["type"] == TYPE_HEADER for ln in self.lines):
                return self._end_position(), kilde
        return self._group_end(self.ensure_category(noegle)), kilde

    def _auto_position(self, text: str) -> int:
        return self.place(text)[0]

    def add_under(self, text: str, header_text: str | None) -> dict:
        """Tilføj en vare under en bestemt overskrift (tekst fra en anden note).

        Findes overskriften som fast kategori, bruges/oprettes den på butikkens plads;
        en egen overskrift findes på navnet eller oprettes sidst. Uden overskrift
        placeres varen som ved automatisk placering.
        """
        if not header_text:
            return self.add(text, line_type=TYPE_ITEM, auto_place=True)
        idx = self._header_index(header_text)
        if idx is None and (k := K.header_noegle(header_text)) is not None:
            idx = self.ensure_category(k)
        if idx is None:
            pos = self._end_position()
            new = [{"id": new_id(), "text": header_text, "type": TYPE_HEADER, "checked": False}]
            if pos:
                new.insert(0, {"id": new_id(), "text": "", "type": TYPE_BLANK, "checked": False})
            self.lines[pos:pos] = new
            idx = pos + len(new) - 1
        line = {"id": new_id(), "text": text.strip(), "type": TYPE_ITEM, "checked": False}
        self.lines.insert(self._group_end(idx), line)
        return line

    def move_to_category(self, line_id: str, *, header_id: str | None = None, noegle: str | None = None) -> None:
        """Flyt en vare til sidst i en kategori (overskrift efter id eller fast nøgle)."""
        ln = self.lines.pop(self.index(line_id))
        try:
            if header_id:
                idx = self.index(header_id)
                if self.lines[idx]["type"] != TYPE_HEADER:
                    raise KeyError(header_id)
            elif noegle in K.ORDEN:
                idx = self.ensure_category(noegle)
            else:
                raise KeyError(noegle)
        except KeyError:
            self.lines.insert(self._end_position(), ln)
            raise
        self.lines.insert(self._group_end(idx), ln)

    def category_of(self, line_id: str) -> str | None:
        return self.header_of(self.index(line_id))

    def category_overview(self) -> list[dict]:
        """Overskrifter i rækkefølge + faste kategorier der ikke findes endnu (til kategorivælgeren)."""
        out: list[dict] = []
        seen: set[str] = set()
        cur = None
        for ln in self.lines:
            if ln["type"] == TYPE_HEADER:
                k = K.header_noegle(ln["text"])
                cur = {"id": ln["id"], "navn": ln["text"], "fast": k, "varer": 0}
                out.append(cur)
                if k:
                    seen.add(k)
            elif ln["type"] == TYPE_ITEM and cur is not None:
                cur["varer"] += 1
        # Manglende faste kategorier sættes ind på butikkens plads
        for k, navn in K.FASTE:
            if k in seen:
                continue
            pos = next((i for i, c in enumerate(out) if c["fast"] and K.ORDEN[c["fast"]] > K.ORDEN[k]), len(out))
            out.insert(pos, {"id": None, "navn": navn, "fast": k, "varer": 0})
        return out

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
        if ln["type"] == TYPE_ITEM and not ln["text"].strip():
            ln["checked"] = False  # en tom linje kan ikke være "købt"
        return ln

    def sanitize(self) -> bool:
        """Ryd op i gamle data (fx tomme varer med flueben). Returnerer True hvis noget blev rettet."""
        changed = False
        for ln in self.lines:
            ln.setdefault("checked", False)
            if ln["type"] != TYPE_ITEM and ln["checked"]:
                ln["checked"] = False
                changed = True
            if ln["type"] == TYPE_ITEM and ln["checked"] and not (ln.get("text") or "").strip():
                ln["checked"] = False
                changed = True
        return changed

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
