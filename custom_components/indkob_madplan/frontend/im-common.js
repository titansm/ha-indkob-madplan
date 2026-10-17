/* Fælles kode for panel og kort: forbindelse, tjekliste, madplan-visning, statistik. */
export const VERSION = "0.10.1";
export const PANEL_PATH = "/indkob-madplan";
const KORT_DAGE = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];
export const UGEDAGE = ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"];

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const lsGet = (k, d) => {
  try {
    const v = localStorage.getItem("indkob_madplan:" + k);
    return v === null ? d : JSON.parse(v);
  } catch (e) {
    return d;
  }
};
export const lsSet = (k, v) => {
  try {
    localStorage.setItem("indkob_madplan:" + k, JSON.stringify(v));
  } catch (e) {}
};

export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

export function relTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return `i dag ${hm}`;
  if (days === 1) return `i går ${hm}`;
  return d.toLocaleDateString("da-DK", { day: "numeric", month: "short" });
}

export function prettyHeader(s) {
  const t = (s || "").trim().replace(/:$/, "");
  const m = t.match(/^([^\p{L}]*)(.*)$/u);
  const lead = m ? m[1] : "";
  const rest = m ? m[2] : t;
  if (rest && rest === rest.toUpperCase()) {
    const low = rest.toLowerCase();
    return lead + low.charAt(0).toUpperCase() + low.slice(1);
  }
  return t;
}

/* ------------------------------------------------------------------ genoptag indkøbslisten
 * Lukker iOS appen i baggrunden, mens indkøbslisten er åben, starter HA-appen bagefter
 * på sin forside. Panelet gemmer derfor et "jeg stod i listen"-mærke, når siden skjules,
 * og ved næste opstart sender vi brugeren tilbage til listen (inden for RESUME_MAX). */
const RESUME_KEY = "resume";
const RESUME_MAX = 2 * 60 * 60 * 1000; // 2 timer

export function markResume() {
  lsSet(RESUME_KEY, { t: Date.now() });
}
export function clearResume() {
  lsSet(RESUME_KEY, null);
}

export function scrollerOf(el) {
  if (el && el.scrollHeight > el.clientHeight + 1) return el;
  return document.scrollingElement || document.documentElement;
}

let _resumeTried = false;
export function resumeIfShopping() {
  if (_resumeTried) return;
  _resumeTried = true;
  // Navigerer man selv væk fra panelet, mens appen er synlig, droppes genoptagelsen.
  const onNav = () => {
    if (document.visibilityState === "visible" && !location.pathname.startsWith(PANEL_PATH)) clearResume();
  };
  window.addEventListener("location-changed", () => setTimeout(onNav, 0));
  window.addEventListener("popstate", () => setTimeout(onNav, 0));
  const r = lsGet(RESUME_KEY, null);
  if (!r || !r.t || Date.now() - r.t > RESUME_MAX) return;
  const started = Date.now();
  const tick = () => {
    const ha = document.querySelector("home-assistant");
    if (!ha?.hass) {
      if (Date.now() - started < 15000) setTimeout(tick, 150);
      return;
    }
    if (location.pathname.startsWith(PANEL_PATH)) return;
    history.replaceState(null, "", PANEL_PATH);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: true } }));
  };
  tick();
}

/* ------------------------------------------------------------------ store
 * Én delt forbindelse pr. side, så panel og kort ikke abonnerer dobbelt. */
class ImStore {
  constructor(conn) {
    this.conn = conn;
    this.state = null;
    this.error = null;
    this.listeners = new Set();
    this._unsub = null;
    this._start();
  }
  async _start() {
    try {
      this._unsub = await this.conn.subscribeMessage(
        (s) => {
          this.state = s;
          this.error = null;
          this._emit();
        },
        { type: "indkob_madplan/subscribe" }
      );
    } catch (e) {
      this.error = "Integrationen Indkøb & Madplan er ikke sat op.";
      this._emit();
    }
  }
  _emit() {
    for (const l of this.listeners) l(this.state);
  }
  listen(fn) {
    this.listeners.add(fn);
    if (this.state || this.error) fn(this.state);
    return () => this.listeners.delete(fn);
  }
  send(type, data = {}) {
    return this.conn.sendMessagePromise({ type: "indkob_madplan/" + type, ...data });
  }
  add(text, opts = {}) {
    return this.send("indkob/add", { text, ...opts });
  }
  update(id, changes) {
    return this.send("indkob/update", { line_id: id, ...changes });
  }
  remove(ids) {
    return this.send("indkob/delete", { line_ids: ids });
  }
  clearChecked() {
    return this.send("indkob/clear_checked");
  }
  uncheckAll() {
    return this.send("indkob/uncheck_all");
  }
  move(id, after_id) {
    return this.send("indkob/move", { line_id: id, after_id });
  }
  setMadplan(text, base_version) {
    return this.send("madplan/set", { text, base_version });
  }
  /* Retter fra hele madplan-historikken (til inspiration); hentes først når der er brug for det. */
  retter() {
    return this.send("madplan/retter");
  }
  /* Gendan en slettet linje på sin gamle plads (fortryd) */
  restore(ln, prevId) {
    return this.send("indkob/add", {
      text: ln.text, after_id: prevId || "__top__", line_type: ln.type, checked: !!ln.checked, restore: true,
    });
  }
  setSettings(changes) {
    return this.send("settings/set", changes);
  }
  updateTrip(trip_id, betalinger) {
    return this.send("trip/update", { trip_id, betalinger });
  }
  addTrip(dato, betalinger) {
    return this.send("trip/add", { dato, betalinger });
  }
  deleteTrip(trip_id) {
    return this.send("trip/delete", { trip_id });
  }
  clearStats() {
    return this.send("stats/clear", { bekraeft: true });
  }
  /* Gør en vare på indkøbslisten fast (sæt i basislisten) eller engangs */
  setFast(line_id, fast) {
    return this.send("indkob/fast", { line_id, fast });
  }
  /* Samme kommandoer, men rettet mod basislisten (note: "basis") */
  forNote(note) {
    if (!note || note === "indkob") return this;
    const s = this;
    return {
      note,
      add: (text, opts = {}) => s.add(text, { ...opts, note }),
      update: (id, changes) => s.update(id, { ...changes, note }),
      remove: (ids) => s.send("indkob/delete", { line_ids: ids, note }),
      move: (id, after_id) => s.send("indkob/move", { line_id: id, after_id, note }),
      restore: (ln, prevId) => s.send("indkob/add", {
        text: ln.text, after_id: prevId || "__top__", line_type: ln.type, checked: false, restore: true, note,
      }),
      send: (type, data = {}) => s.send(type, { ...data, note }),
    };
  }
}

const STORES = new WeakMap();
export function getStore(hass) {
  const conn = hass.connection;
  let s = STORES.get(conn);
  if (!s) {
    s = new ImStore(conn);
    STORES.set(conn, s);
  }
  return s;
}

/* ------------------------------------------------------------------ tjekliste
 * Nøglede rækker, så et felt man skriver i ikke overskrives af fjernopdateringer. */
export class Checklist {
  constructor(container, store, {
    editable = true, hideChecked = false, onFocusLine = null, scroller = null,
    onDelete = null, tapToggle = false, swipe = null, plus = false, onPlusAdded = null,
    checkbox = true, onFast = null,
  } = {}) {
    this.el = container;
    this.store = store;
    this.editable = editable;
    this.hideChecked = hideChecked;
    this.onFocusLine = onFocusLine;
    this.onDelete = onDelete; // (linje, forrigeId) -> kaldes efter swipe-slet, fx til "Fortryd"
    this.tapToggle = tapToggle; // tryk hvor som helst på rækken krydser af (indkøbstilstand)
    this.swipeEnabled = swipe ?? editable; // swipe til siden for at slette
    this.lines = [];
    this.rows = new Map();
    this.plus = plus; // "+" under hver kategori (kun i redigering)
    this.onPlusAdded = onPlusAdded; // (svar fra indkob/add, tekst)
    this.checkbox = checkbox; // false = ingen flueben (basislisten)
    this.onFast = onFast; // (linje) -> tryk på "Engangs"-mærket (gør varen fast)
    this.plusRows = new Map(); // overskrift-id -> række
    this.fixed = new Set(); // id'er på faste kategorier (skjules når de er tomme)
    this.bought = new Map(); // linje-id -> butik (købt i en butik, der er afsluttet på turen)
    this._plusQueue = Promise.resolve();
    this._plusLast = null; // {header, id}: seneste vare tilføjet via "+"
    this.dirty = new Map(); // id -> timer
    this.focusId = null;
    this.scroller = scroller;
    this.drag = null;
    this.swipe = null;
    this.openRow = null;
    this._pending = null;
    this._suppressClick = 0;
    this.el.classList.add("cl");
    this.el.classList.toggle("tap", tapToggle);
    this.el.classList.toggle("nocheck", !checkbox);
    // Klik lige efter et swipe/træk må ikke blive til et tryk på rækken
    this.el.addEventListener("click", (e) => {
      if (Date.now() < this._suppressClick) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    this.el.addEventListener("click", (e) => this._click(e));
    this.el.addEventListener("pointerdown", (e) => this._pointerDown(e));
    this.el.addEventListener("contextmenu", (e) => e.target.closest(".grip") && e.preventDefault());
    this.el.addEventListener("input", (e) => this._input(e));
    this.el.addEventListener("keydown", (e) => (e.target.closest("[data-plus]") ? this._plusKey(e) : this._key(e)));
    this.el.addEventListener("focusin", (e) => {
      const row = e.target.closest("[data-id]");
      this.focusId = row?.dataset.id || null;
      this.onFocusLine?.(this.focusId);
    });
    this.el.addEventListener("focusout", (e) => {
      const plus = e.target.closest("[data-plus]");
      if (plus) return this._plusBlur(e.target, plus.dataset.plus);
      const row = e.target.closest("[data-id]");
      if (row) this._flush(row.dataset.id);
    });
  }

  /* Skift mellem redigering og indkøbstilstand (rækkerne bygges om). */
  setMode({ editable, tapToggle = false, swipe = null }) {
    for (const id of [...this.dirty.keys()]) this._flush(id);
    this._closeOpen();
    this.editable = editable;
    this.tapToggle = tapToggle;
    this.swipeEnabled = swipe ?? editable;
    this.el.classList.toggle("tap", tapToggle);
    for (const row of this.rows.values()) row.remove();
    this.rows.clear();
    for (const row of this.plusRows.values()) row.remove();
    this.plusRows.clear();
    this.render();
  }

  /* Varer købt i en afsluttet butik (state.indkob.tur.koebt) – skjules i indkøbstilstand. */
  setBought(map) {
    this.bought = new Map(Object.entries(map || {}));
  }

  /* Faste kategorier (fra state.indkob.kategorier) – tomme skjules. */
  setCategories(list) {
    this.fixed = new Set((list || []).filter((c) => c.fast && c.id).map((c) => c.id));
  }

  setLines(lines) {
    if (this.drag || this.swipe) {
      this._pending = lines || [];
      return;
    }
    this.lines = lines || [];
    this.render();
  }

  _pointerDown(e) {
    if (e.button !== 0 && e.button !== undefined) return;
    const grip = e.target.closest(".grip");
    if (grip && this.editable) return this._dragStart(e, grip);
    const row = e.target.closest("[data-id]");
    if (this.openRow && this.openRow !== row) this._closeOpen();
    if (!this.swipeEnabled || !row || this.drag || this.swipe) return;
    if (e.pointerType === "mouse") return; // mus: markér tekst som normalt; slet med Backspace
    if (row.dataset.type === "blank" || e.target.closest(".slet")) return;
    this._swipeStart(e, row);
  }

  /* ------------------------------------------------------------ swipe for at slette
   * Som i Noter: træk rækken mod venstre. Et kort træk viser "Slet", et langt træk
   * sletter med det samme. Lodret bevægelse = almindelig scroll. */
  _swipeStart(e, row) {
    const inner = row.querySelector(".inner");
    const slet = row.querySelector(".slet");
    if (!inner || !slet) return;
    const sw = this.swipe = {
      row, inner, slet, id: row.dataset.id, pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY, dx: 0, decided: false, dead: false,
      width: row.getBoundingClientRect().width, open: this.openRow === row,
    };
    this._swMove = (ev) => {
      if (this.swipe !== sw || sw.dead) return;
      if (ev.pointerId !== undefined && ev.pointerId !== sw.pointerId) return;
      const x = ev.clientX ?? ev.touches?.[0]?.clientX;
      const y = ev.clientY ?? ev.touches?.[0]?.clientY;
      if (x === undefined) return;
      let dx = x - sw.x0 + (sw.open ? -REVEAL : 0);
      const dy = y - sw.y0;
      if (!sw.decided) {
        if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(x - sw.x0)) { sw.dead = true; return; } // scroll
        if (x - sw.x0 > 10 && !sw.open) { sw.dead = true; return; } // mod højre: ingenting
        if (Math.abs(x - sw.x0) < 10) return;
        sw.decided = true;
        this._flush(sw.id);
        const ae = this.el.getRootNode().activeElement;
        if (ae && this.el.contains(ae)) ae.blur();
        row.classList.add("swiping");
        try { row.setPointerCapture?.(sw.pointerId); } catch (err) {}
      }
      ev.preventDefault?.();
      if (dx > 0) dx = dx * 0.2; // lidt modstand mod højre
      sw.dx = dx;
      this._swipeDraw(sw, dx, false);
    };
    this._swUp = (ev) => {
      if (this.swipe !== sw) return;
      if (ev.pointerId !== undefined && ev.pointerId !== sw.pointerId) return;
      this._swipeEnd(ev.type === "pointercancel" || ev.type === "touchcancel");
    };
    window.addEventListener("pointermove", this._swMove, { passive: false });
    window.addEventListener("pointerup", this._swUp);
    window.addEventListener("pointercancel", this._swUp);
    window.addEventListener("touchmove", this._swMove, { passive: false });
    window.addEventListener("touchend", this._swUp);
    window.addEventListener("touchcancel", this._swUp);
  }

  _swipeDraw(sw, dx, animate) {
    const t = animate ? "transform .2s ease-out" : "none";
    sw.inner.style.transition = t;
    sw.slet.style.transition = animate ? "width .2s ease-out" : "none";
    sw.inner.style.transform = dx ? `translateX(${dx}px)` : "";
    sw.slet.style.width = dx < 0 ? `${-dx}px` : "0px";
    sw.row.classList.toggle("far", -dx > sw.width * FULL);
  }

  _swipeEnd(cancel) {
    const sw = this.swipe;
    if (!sw) return;
    this.swipe = null;
    for (const [t, f] of [["pointermove", this._swMove], ["pointerup", this._swUp], ["pointercancel", this._swUp],
      ["touchmove", this._swMove], ["touchend", this._swUp], ["touchcancel", this._swUp]]) {
      window.removeEventListener(t, f);
    }
    const pending = this._pending;
    this._pending = null;
    if (!sw.decided) {
      if (pending) this.setLines(pending);
      return;
    }
    this._suppressClick = Date.now() + 400;
    const far = !cancel && -sw.dx > sw.width * FULL;
    if (far) {
      this._swipeDraw(sw, -sw.width, true);
      if (navigator.vibrate) navigator.vibrate(12);
      setTimeout(() => this._delete(sw.row, pending), 160);
      return;
    }
    if (!cancel && -sw.dx > 44) {
      this.openRow = sw.row;
      this._swipeDraw(sw, -REVEAL, true);
    } else {
      this.openRow = null;
      this._swipeDraw(sw, 0, true);
      setTimeout(() => sw.row.classList.remove("swiping"), 220);
    }
    if (pending) this.setLines(pending);
  }

  _closeOpen() {
    const row = this.openRow;
    if (!row) return;
    this.openRow = null;
    const sw = { row, inner: row.querySelector(".inner"), slet: row.querySelector(".slet"), width: 1 };
    if (sw.inner && sw.slet) this._swipeDraw(sw, 0, true);
    setTimeout(() => row.classList.remove("swiping"), 220);
  }

  _delete(row, pending = null) {
    const id = row.dataset.id;
    const base = pending || this.lines;
    const idx = base.findIndex((l) => l.id === id);
    if (idx < 0) return this.setLines(base);
    const ln = base[idx];
    const prevId = idx > 0 ? base[idx - 1].id : null;
    this.dirty.delete(id);
    if (this.openRow === row) this.openRow = null;
    this.setLines(base.filter((l) => l.id !== id));
    this.store.remove([id]).catch(() => this.setLines(base));
    this.onDelete?.(ln, prevId);
  }

  /* ------------------------------------------------------------ træk og slip
   * Rækken bliver liggende i DOM'en under trækket (flyttes den, mister iOS Safari
   * fingeren og trækket "hænger"). Den tegnes forskudt med translateY, og en
   * markeringslinje viser, hvor den lander. Lyttere sidder på window. */
  _dragStart(e, grip) {
    const row = grip.closest("[data-id]");
    if (!row || this.drag || this.swipe) return;
    e.preventDefault();
    this._closeOpen();
    this._flush(row.dataset.id);
    const ae = this.el.getRootNode().activeElement;
    if (ae && this.el.contains(ae)) ae.blur();
    try { grip.setPointerCapture?.(e.pointerId); } catch (err) {}
    const sc = this._scrollEl();
    const scroll0 = sc.scrollTop;
    const r0 = row.getBoundingClientRect();
    // Midtpunkter i "indholds-koordinater" (uafhængige af scroll)
    const targets = [...this.el.children]
      .filter((el) => el !== row && el.dataset?.id && !el.hidden)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, mid: r.top + r.height / 2 + scroll0 };
      });
    const line = document.createElement("div");
    line.className = "drop";
    line.hidden = true;
    this.el.appendChild(line);
    this.drag = {
      id: row.dataset.id, row, line, targets, sc, pointerId: e.pointerId,
      startY: e.clientY, y: e.clientY, scroll0, center0: r0.top + r0.height / 2 + scroll0,
      before: undefined, raf: 0,
    };
    row.classList.add("dragging");
    this.el.classList.add("sorting");
    if (navigator.vibrate) navigator.vibrate(10);
    this._onMove = (ev) => {
      if (!this.drag || (ev.pointerId !== undefined && ev.pointerId !== this.drag.pointerId)) return;
      ev.preventDefault?.();
      this.drag.y = ev.clientY ?? ev.touches?.[0]?.clientY ?? this.drag.y;
      this._reposition();
    };
    this._onUp = (ev) => {
      if (!this.drag || (ev.pointerId !== undefined && ev.pointerId !== this.drag.pointerId)) return;
      this._dragEnd(ev.type === "pointercancel" || ev.type === "touchcancel" || ev.type === "blur");
    };
    window.addEventListener("pointermove", this._onMove, { passive: false });
    window.addEventListener("pointerup", this._onUp);
    window.addEventListener("pointercancel", this._onUp);
    window.addEventListener("touchmove", this._onMove, { passive: false });
    window.addEventListener("touchend", this._onUp);
    window.addEventListener("touchcancel", this._onUp);
    window.addEventListener("blur", this._onUp);
    this._reposition();
    this._autoScroll();
  }

  _reposition() {
    const d = this.drag;
    if (!d) return;
    const scroll = d.sc.scrollTop;
    const dy = d.y - d.startY + (scroll - d.scroll0);
    d.row.style.transform = `translateY(${dy}px)`;
    const center = d.center0 + dy;
    // Første synlige række (i rækkefølge), hvis midte ligger under rækkens midte
    const hit = d.targets.find((t) => t.mid > center);
    const before = hit ? hit.el : null; // null = sidst
    if (before === d.before) return;
    d.before = before;
    // Ingen linje, hvis rækken ville lande, hvor den allerede står
    const next = this._visibleSibling(d.row, 1);
    if (before === (next || null)) {
      d.line.hidden = true;
      return;
    }
    d.line.hidden = false;
    if (before) before.before(d.line);
    else this.el.appendChild(d.line);
  }

  /* Det element, der faktisk scroller: panelets ark, ellers hele siden. */
  _scrollEl() {
    return scrollerOf(typeof this.scroller === "function" ? this.scroller() : this.scroller);
  }

  _visibleSibling(row, dir) {
    let r = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
    while (r && (r.hidden || r.classList.contains("drop") || r.classList.contains("plus"))) r = dir < 0 ? r.previousElementSibling : r.nextElementSibling;
    return r;
  }

  _autoScroll() {
    const d = this.drag;
    if (!d) return;
    const sc = d.sc;
    {
      const r = sc === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : sc.getBoundingClientRect();
      const edge = 70;
      let v = 0;
      if (d.y < r.top + edge) v = -Math.ceil((r.top + edge - d.y) / 6);
      else if (d.y > r.bottom - edge) v = Math.ceil((d.y - (r.bottom - edge)) / 6);
      if (v) {
        const before = sc.scrollTop;
        sc.scrollTop += v;
        if (sc.scrollTop !== before) this._reposition();
      }
    }
    d.raf = requestAnimationFrame(() => this._autoScroll());
  }

  _dragEnd(cancel) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    cancelAnimationFrame(d.raf);
    for (const [t, f] of [["pointermove", this._onMove], ["pointerup", this._onUp], ["pointercancel", this._onUp],
      ["touchmove", this._onMove], ["touchend", this._onUp], ["touchcancel", this._onUp], ["blur", this._onUp]]) {
      window.removeEventListener(t, f);
    }
    this._suppressClick = Date.now() + 400;
    const moved = !d.line.hidden;
    const before = d.before;
    d.line.remove();
    d.row.classList.remove("dragging");
    d.row.style.transform = "";
    this.el.classList.remove("sorting");
    const pending = this._pending;
    this._pending = null;
    const base = pending || this.lines;
    if (cancel || !moved) {
      this.setLines(base);
      return;
    }
    // Ny placering: efter linjen, der står lige før `before` (eller sidst)
    const lines = base.filter((l) => l.id !== d.id);
    const ln = base.find((l) => l.id === d.id);
    if (!ln) return this.setLines(base);
    const j = before ? lines.findIndex((l) => l.id === before.dataset.id) : lines.length;
    const pos = j < 0 ? lines.length : j;
    const afterId = pos > 0 ? lines[pos - 1].id : null;
    lines.splice(pos, 0, ln);
    this.setLines(lines);
    if (navigator.vibrate) navigator.vibrate(8);
    this.store.move(d.id, afterId).catch(() => this.setLines(base));
  }

  render() {
    const seen = new Set();
    let visibleItems = 0;
    // 1) rækker for alle linjer
    for (const ln of this.lines) {
      seen.add(ln.id);
      let row = this.rows.get(ln.id);
      if (!row || row.dataset.type !== ln.type) {
        row?.remove();
        row = this._makeRow(ln);
        this.rows.set(ln.id, row);
      }
      this._fillRow(row, ln);
      const koebt = ln.type === "item" && ln.checked && this.bought.has(ln.id);
      const hidden = (ln.type === "item" && ln.checked && this.hideChecked) || (koebt && !this.editable);
      row.hidden = hidden || (!this.editable && ln.type === "blank");
      if (ln.type === "item" && !hidden) visibleItems++;
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        if (this.openRow === row) this.openRow = null;
        row.remove();
        this.rows.delete(id);
      }
    }
    // 2) grupper: overskrift + linjerne under den
    const groups = [];
    let g = null;
    for (const ln of this.lines) {
      if (ln.type === "header") {
        g = { header: ln, lines: [], items: 0, visible: 0, lastItem: null };
        groups.push(g);
      } else if (g) {
        g.lines.push(ln);
        if (ln.type === "item") {
          g.items++;
          g.lastItem = ln;
          if (!this.rows.get(ln.id).hidden) g.visible++;
        }
      }
    }
    const plusAfter = new Map(); // linje-id -> overskrift-id ("+" sættes efter linjen)
    for (const gr of groups) {
      // Kategorier uden varer vises ikke (faste altid; i visning/indkøb alle)
      const empty = this.editable ? (this.fixed.has(gr.header.id) && gr.items === 0) : gr.visible === 0;
      if (empty) {
        this.rows.get(gr.header.id).hidden = true;
        for (const ln of gr.lines) this.rows.get(ln.id).hidden = true;
      } else if (this.editable && this.plus) {
        plusAfter.set((gr.lastItem || gr.header).id, gr.header.id);
      }
    }
    // 3) "+"-rækker
    const wantPlus = new Set(plusAfter.values());
    for (const [hid, row] of this.plusRows) {
      if (!wantPlus.has(hid)) {
        row.remove();
        this.plusRows.delete(hid);
      }
    }
    for (const hid of wantPlus) {
      if (!this.plusRows.has(hid)) this.plusRows.set(hid, this._makePlus(hid));
      const h = this.lines.find((l) => l.id === hid);
      this.plusRows.get(hid).querySelector("input").setAttribute("aria-label", `Tilføj vare under ${prettyHeader(h?.text || "")}`);
    }
    // 4) placér i rækkefølge (en række, der allerede står rigtigt, flyttes ikke – så fokus bevares)
    let prev = null;
    const place = (row) => {
      const want = prev ? prev.nextSibling : this.el.firstChild;
      if (want !== row) this.el.insertBefore(row, want);
      prev = row;
    };
    for (const ln of this.lines) {
      place(this.rows.get(ln.id));
      const hid = plusAfter.get(ln.id);
      if (hid) place(this.plusRows.get(hid));
    }
    this.el.toggleAttribute("data-empty", visibleItems === 0);
  }

  _makePlus(headerId) {
    const row = document.createElement("div");
    row.className = "ln plus";
    row.dataset.plus = headerId;
    row.innerHTML = `<div class="inner"><span class="pl" aria-hidden="true">${PLUS}</span>` +
      `<input class="tx" type="text" enterkeyhint="next" autocapitalize="sentences" autocomplete="off" placeholder="Ny vare" /></div>`;
    return row;
  }

  _plusKey(e) {
    if (e.isComposing) return;
    if (e.key === "Escape") return e.target.blur();
    if (e.key !== "Enter") return;
    e.preventDefault();
    const tx = e.target;
    const text = tx.value.trim();
    if (!text) return tx.blur();
    tx.value = "";
    this._plusAdd(tx.closest("[data-plus]").dataset.plus, text);
  }

  _plusBlur(tx, headerId) {
    const text = tx.value.trim();
    tx.value = "";
    if (text) this._plusAdd(headerId, text);
    this._plusLast = null;
  }

  /* Tilføj som sidste vare i kategorien – i kø, så hurtige Enter-tryk bevarer rækkefølgen. */
  _plusAdd(headerId, text) {
    this._plusQueue = this._plusQueue.then(async () => {
      const ids = new Set(this.lines.map((l) => l.id));
      let after = this._plusLast?.header === headerId ? this._plusLast.id : null;
      if (!after) {
        const i = this.lines.findIndex((l) => l.id === headerId);
        if (i < 0) return;
        after = headerId;
        for (let j = i + 1; j < this.lines.length && this.lines[j].type !== "header"; j++) {
          if (this.lines[j].type === "item") after = this.lines[j].id;
        }
      }
      if (!ids.has(after) && after !== this._plusLast?.id) after = headerId;
      try {
        const res = await this.store.add(text, { after_id: after, line_type: "item", dedupe: true });
        if (!res.fandtes) this._plusLast = { header: headerId, id: res.id };
        else this.flash(res.id);
        this.onPlusAdded?.(res, text);
      } catch (err) {
        this.onPlusAdded?.(null, text);
      }
    });
  }

  /* Fremhæv en række kort (fx en vare der allerede stod på listen). */
  flash(id) {
    const tick = (n) => {
      const row = this.rows.get(id);
      if (!row) return n < 10 && setTimeout(() => tick(n + 1), 60);
      row.classList.remove("flash");
      void row.offsetWidth;
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 1300);
    };
    tick(0);
  }

  _makeRow(ln) {
    const row = document.createElement("div");
    row.className = "ln " + ln.type;
    row.dataset.id = ln.id;
    row.dataset.type = ln.type;
    let inner;
    if (ln.type === "item") {
      // Engangsvarer (ikke i basislisten) får et lille mærke – de forsvinder efter indkøb
      const pin = this.onFast
        ? `<button class="pin" type="button" aria-label="Engangsvare – forsvinder efter indkøb. Tryk for at gøre den fast" title="Engangsvare – tryk for at gøre den fast">Engangs</button>`
        : `<span class="pin" aria-hidden="true" title="Engangsvare – forsvinder efter indkøb">Engangs</span>`;
      inner = (this.checkbox ? `<button class="chk" type="button" role="checkbox" aria-label="Afkryds"></button>` : "") +
        (this.editable
          ? `<input class="tx" type="text" enterkeyhint="next" aria-label="Vare" />${pin}` +
            `<span class="grip" role="button" aria-label="Træk for at flytte varen" title="Træk for at flytte">${GRIP}</span>`
          : `<span class="tx"></span>${pin}`);
    } else if (ln.type === "header") {
      inner = this.editable
        ? `<input class="tx" type="text" enterkeyhint="next" aria-label="Overskrift" />`
        : `<span class="tx"></span>`;
    } else {
      inner = this.editable ? `<input class="tx" type="text" enterkeyhint="next" aria-label="Tom linje" />` : "";
    }
    row.innerHTML = `<div class="inner">${inner}</div>` +
      (this.swipeEnabled && ln.type !== "blank" ? `<button class="slet" type="button" tabindex="-1" aria-label="Slet"><span>Slet</span></button>` : "");
    return row;
  }

  _fillRow(row, ln) {
    row.classList.toggle("done", !!ln.checked);
    row.classList.toggle("fast", !!ln.fast);
    row.classList.toggle("engangs", ln.type === "item" && ln.fast === false && !!(ln.text || "").trim());
    const butik = ln.checked ? this.bought.get(ln.id) : null;
    row.classList.toggle("koebt", !!butik);
    if (butik) row.firstElementChild.dataset.butik = butik;
    else delete row.firstElementChild.dataset.butik;
    const chk = row.querySelector(".chk");
    if (chk) chk.setAttribute("aria-checked", String(!!ln.checked));
    const tx = row.querySelector(".tx");
    if (!tx) return;
    const text = ln.type === "header" && !this.editable ? prettyHeader(ln.text) : ln.text;
    if (tx.tagName === "INPUT") {
      const focused = this.el.getRootNode().activeElement === tx;
      if (!(focused && this.dirty.has(ln.id)) && tx.value !== text) tx.value = text;
    } else if (tx.textContent !== text) tx.textContent = text;
  }

  _line(id) {
    return this.lines.find((l) => l.id === id);
  }

  _click(e) {
    const slet = e.target.closest(".slet");
    if (slet) {
      e.preventDefault();
      return this._delete(slet.closest("[data-id]"));
    }
    const row = e.target.closest("[data-id]");
    if (!row) return;
    if (this.openRow) return this._closeOpen();
    const pin = e.target.closest("button.pin");
    if (pin) {
      e.preventDefault();
      const ln = this._line(row.dataset.id);
      if (ln) this.onFast?.(ln);
      return;
    }
    const chk = e.target.closest(".chk");
    if (!chk && !(this.tapToggle && !this.editable && row.dataset.type === "item")) return;
    const id = row.dataset.id;
    const ln = this._line(id);
    if (!ln) return;
    ln.checked = !ln.checked; // optimistisk
    this.render();
    if (ln.checked && navigator.vibrate) navigator.vibrate(8);
    this.store.update(id, { checked: ln.checked }).catch(() => {});
  }

  _input(e) {
    const row = e.target.closest("[data-id]");
    if (!row) return;
    const id = row.dataset.id;
    const ln = this._line(id);
    if (ln) ln.text = e.target.value;
    clearTimeout(this.dirty.get(id));
    this.dirty.set(id, setTimeout(() => this._flush(id), 600));
  }

  _flush(id) {
    if (!this.dirty.has(id)) return;
    clearTimeout(this.dirty.get(id));
    this.dirty.delete(id);
    const row = this.rows.get(id);
    const tx = row?.querySelector("input");
    const ln = this._line(id);
    if (!tx || !ln) return;
    let changes = { text: tx.value };
    // En tom linje der får tekst bliver en vare
    if (ln.type === "blank" && tx.value.trim()) changes.line_type = "item";
    this.store.update(id, changes).catch(() => {});
  }

  async _key(e) {
    const row = e.target.closest("[data-id]");
    if (!row || e.isComposing) return;
    const id = row.dataset.id;
    const ln = this._line(id);
    if (!ln) return;
    if (e.key === "Enter") {
      e.preventDefault();
      this._flush(id);
      const value = e.target.value;
      // Enter på tom vare: ud af listen (som i Noter) -> tom linje
      if (ln.type === "item" && !value.trim()) {
        this.store.update(id, { line_type: "blank", text: "" }).catch(() => {});
        return;
      }
      try {
        const nl = await this.store.add("", { after_id: id, line_type: "item" });
        this._focusSoon(nl.id, 0);
      } catch (err) {}
    } else if (e.key === "Backspace" && e.target.value === "" && e.target.selectionStart === 0) {
      e.preventDefault();
      const idx = this.lines.findIndex((l) => l.id === id);
      const prev = this.lines.slice(0, idx).reverse().find((l) => l.type !== "blank" || this.editable);
      this.dirty.delete(id);
      this.store.remove([id]).catch(() => {});
      if (prev) this._focusSoon(prev.id, "end");
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const idx = this.lines.findIndex((l) => l.id === id);
      const next = this.lines[idx + (e.key === "ArrowUp" ? -1 : 1)];
      if (next) {
        e.preventDefault();
        this._focusSoon(next.id, "end");
      }
    }
  }

  _focusSoon(id, pos) {
    let tries = 0;
    const tick = () => {
      const tx = this.rows.get(id)?.querySelector("input");
      if (tx) {
        tx.focus();
        const p = pos === "end" ? tx.value.length : 0;
        try {
          tx.setSelectionRange(p, p);
        } catch (e) {}
      } else if (tries++ < 20) setTimeout(tick, 50);
    };
    tick();
  }
}

const REVEAL = 84; // bredde på "Slet" når rækken er swipet halvt
const FULL = 0.55; // andel af rækkens bredde, der sletter med det samme

const PLUS = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>`;
export const PIN = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2Z"/></svg>`;
const GRIP = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 8h16v1.8H4zm0 6.2h16V16H4z"/></svg>`;

/* ------------------------------------------------------------------ madplan-visning */
export function aftenHTML(mp, { compact = false, weekOpen = false, onlyToday = false, showTomorrow = false } = {}) {
  if (!mp) return `<p class="dim">Henter madplan …</p>`;
  const dage = mp.dage || [];
  const idag = dage.find((d) => d.offset === 0);
  const imorgen = dage.find((d) => d.offset === 1);
  const frostDag = mp.frost_dag === "i morgen" ? imorgen : idag;
  const ret = idag?.ret || "";
  const noter = [...(idag?.noter || []).map((n) => `<span class="pill">${esc(n)}</span>`),
    idag?.stor_portion ? `<span class="pill acc">Stor portion</span>` : ""].join("");
  const frost = frostDag?.kraever_optoening
    ? `<div class="frost"><span class="snow" aria-hidden="true">❄</span>Tag ${esc((frostDag.koed || [])[0] || "kød")} op af fryseren${mp.frost_dag === "i morgen" ? " til i morgen" : ""}</div>`
    : "";
  const uge = dage
    .filter((d) => d.offset >= 0)
    .slice(0, 7)
    .map((d) => {
      const dd = new Date(d.dato + "T12:00:00");
      const label = d.offset === 0 ? "I dag" : d.offset === 1 ? "I morgen" : `${KORT_DAGE[(dd.getDay() + 6) % 7]} ${dd.getDate()}/${dd.getMonth() + 1}`;
      return `<li class="${d.offset === 0 ? "nu" : ""}"><span class="ud">${label}</span>
        <span class="ur">${d.ret ? esc(d.ret) : '<span class="dim">Ikke planlagt</span>'}${d.kraever_optoening ? ' <span class="snow-s" title="Kød op af fryseren">❄</span>' : ""}</span>
        ${d.noter?.length ? `<span class="un">${esc(d.noter.join(", "))}</span>` : ""}</li>`;
    })
    .join("");
  return `
    <div class="aften-top"><span class="hvornaar">I aften</span>${noter}</div>
    <div class="ret ${ret ? "" : "tom"}">${ret ? esc(ret) : "Ingen ret på madplanen"}</div>
    ${imorgen?.ret && (!onlyToday || showTomorrow) ? `<p class="imorgen">I morgen: <strong>${esc(imorgen.ret)}</strong>${imorgen.kraever_optoening ? ' <span class="snow-s" title="Kød op af fryseren">❄</span>' : ""}</p>` : ""}
    ${onlyToday && mp.frost_dag === "i morgen" ? "" : frost}
    ${compact || onlyToday ? "" : `<button class="link ugeknap" data-act="uge" aria-expanded="${weekOpen}">${weekOpen ? "Skjul ugen" : "Vis hele ugen"}</button>
    <ol class="uge" ${weekOpen ? "" : "hidden"}>${uge}</ol>`}`;
}

/* Skabelon til en ny uge. Den fortsætter dagen efter den sidste planlagte dag (jeres uger
 * starter ikke nødvendigvis mandag), dog aldrig før i dag, og får ugenummeret for den dag. */
export function nyUgeSkabelon(today = new Date(), sidsteDato = null, days = 7) {
  let start = new Date(today);
  start.setHours(12, 0, 0, 0);
  if (sidsteDato) {
    const d = new Date(sidsteDato + "T12:00:00");
    d.setDate(d.getDate() + 1);
    if (d > start) start = d;
  }
  const lines = [`Uge ${isoWeek(start)}`];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    lines.push(`${UGEDAGE[(d.getDay() + 6) % 7]}: `);
  }
  return lines.join("\n");
}

/* "for 3 uger siden", "i går", "for 4 dage siden" */
export function sidenTekst(days) {
  if (days == null) return "";
  if (days === 0) return "i dag";
  if (days === 1) return "i går";
  if (days < 14) return `for ${days} dage siden`;
  if (days < 56) return `for ${Math.round(days / 7)} uger siden`;
  return `for ${Math.round(days / 30)} måneder siden`;
}

/* ------------------------------------------------------------------ statistik */
export function statsHTML(s) {
  if (!s || !s.antal_koeb_i_alt)
    return `<p class="tom-tekst">Statistikken bygger sig op, når I krydser varer af på indkøbslisten. Kom tilbage efter et par indkøb.</p>`;
  const uger = s.uger || [];
  const max = Math.max(1, ...uger.map((u) => u.antal));
  const bars = uger
    .map((u, i) => {
      const nr = +u.uge.split("-W")[1];
      const h = Math.round((u.antal / max) * 92);
      return `<div class="sbar ${i === uger.length - 1 ? "nu" : ""}" title="Uge ${nr}: ${u.antal} varer">
        <span class="bv">${u.antal || ""}</span><span class="bf" style="height:${Math.max(h, u.antal ? 3 : 1)}px"></span><span class="bl">${nr}</span></div>`;
    })
    .join("");
  const top = (s.top || [])
    .slice(0, 12)
    .map((t) => `<li><span class="tn">${esc(t.navn)}</span><span class="tc">${t.antal}×</span>
      <span class="ti">${t.interval_dage ? "ca. hver " + Math.round(t.interval_dage) + ". dag" : "købt " + relTime(t.sidst)}</span></li>`)
    .join("");
  const sporet = s.sporet_siden ? new Date(s.sporet_siden).toLocaleDateString("da-DK", { day: "numeric", month: "long" }) : "";
  return `
    <h3>Varer købt pr. uge</h3>
    <div class="sbars" role="img" aria-label="Antal købte varer pr. uge">${bars}</div>
    <h3>Det køber I oftest</h3><ol class="top">${top}</ol>
    ${turHTML(s)}
    ${s.koebt_denne_uge?.length ? `<h3>Købt i denne uge</h3><p class="tekst">${esc(s.koebt_denne_uge.join(", "))}</p>` : ""}
    ${s.koebt_sidste_uge?.length ? `<h3>Købt i sidste uge</h3><p class="tekst">${esc(s.koebt_sidste_uge.join(", "))}</p>` : ""}
    <p class="dim lille">${s.antal_koeb_i_alt} køb af ${s.antal_varer} forskellige varer${sporet ? " siden " + sporet : ""}.</p>`;
}

function turHTML(s) {
  const ture = s.ture || [];
  if (!ture.length) return "";
  const fmt = (iso) => new Date(iso).toLocaleDateString("da-DK", { weekday: "short", day: "numeric", month: "short" });
  const li = ture
    .slice(0, 6)
    .map((t) => `<li><span class="tn">${fmt(t.t)}</span><span class="tc">${t.antal} varer</span>
      <span class="ti">${esc(t.varer.slice(0, 8).join(", "))}${t.varer.length > 8 ? " …" : ""}</span></li>`)
    .join("");
  const extra = [
    s.dage_mellem_ture ? `I handler ind ca. hver ${String(s.dage_mellem_ture).replace(".", ",")}. dag` : "",
    s.varer_pr_tur ? `${String(s.varer_pr_tur).replace(".", ",")} varer pr. tur` : "",
  ].filter(Boolean).join(" · ");
  return `<h3>Seneste indkøb</h3><ol class="top">${li}</ol>${extra ? `<p class="dim lille">${extra}</p>` : ""}`;
}

/* Autofuldførelse: kendte varer der matcher det, man er ved at skrive. */
export function autofill(kendte, query, limit = 5) {
  const q = (query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const starts = [], contains = [];
  for (const n of kendte || []) {
    const l = n.toLowerCase();
    if (l === q) continue;
    if (l.startsWith(q)) starts.push(n);
    else if (l.includes(q)) contains.push(n);
  }
  return [...starts, ...contains].slice(0, limit);
}

export function autofillHTML(kendte, query, lines = [], limit = 5) {
  const names = autofill(kendte, query, limit);
  if (!names.length) return "";
  const open = new Set(lines.filter((l) => l.type === "item" && !l.checked).map((l) => l.text.trim().toLowerCase()));
  return names.map((n) => `<button type="button" class="chip af" data-act="autofill" data-navn="${esc(n)}">${esc(n)}${open.has(n.toLowerCase()) ? ' <small>· på listen</small>' : ""}</button>`).join("");
}

export function forslagHTML(stats, openTexts = []) {
  const open = new Set(openTexts.map((t) => t.toLowerCase()));
  const f = (stats?.forslag || []).filter((x) => !open.has(x.navn.toLowerCase())).slice(0, 8);
  if (!f.length) return "";
  return `<span class="flabel">Plejer I at købe:</span>${f
    .map((x) => `<button class="chip" data-act="forslag" data-navn="${esc(x.navn)}" title="Købt ${x.antal} gange, ca. hver ${Math.round(x.interval_dage)}. dag">+ ${esc(x.navn)}</button>`)
    .join("")}`;
}

/* ------------------------------------------------------------------ CSS */
export const BASE_CSS = `
  :host {
    --im-acc: #b07800;
    --im-acc-strong: #e0a800;
    --im-frost: #2f7fb5;
    --im-frost-bg: rgba(63,143,196,.13);
    --im-text: var(--primary-text-color, #1c1c1e);
    --im-dim: var(--secondary-text-color, #8a8a8e);
    --im-line: var(--divider-color, rgba(60,60,67,.18));
    --im-bg: var(--card-background-color, #fff);
    --im-bg2: var(--secondary-background-color, #f2f2f7);
  }
  :host([dark]) { --im-acc: #f0b90b; --im-frost: #6db6e6; --im-frost-bg: rgba(109,182,230,.14); }
  [hidden] { display: none !important; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
  button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--im-acc); outline-offset: 2px; }
  .dim { color: var(--im-dim); }
  .lille { font-size: .82rem; }
  .link { color: var(--im-acc); font-weight: 600; padding: 8px 2px; }
  .fejl { color: var(--error-color, #d93025); }

  /* tjekliste */
  .cl { display: flex; flex-direction: column; }
  .ln { position: relative; overflow: hidden; touch-action: pan-y; }
  .ln .inner { display: flex; align-items: center; gap: 12px; min-height: 44px; background: var(--im-bg); position: relative; z-index: 1; }
  .ln.item { border-bottom: 1px solid var(--im-line); }
  .ln.blank .inner { min-height: 14px; }
  .slet { position: absolute; top: 0; right: 0; bottom: 0; width: 0; overflow: hidden; background: var(--im-slet, #e5484d);
          color: #fff; font-weight: 600; font-size: 16px; display: flex; align-items: center; justify-content: flex-start; }
  .slet span { flex: none; width: 84px; text-align: center; }
  .ln.far .slet { justify-content: flex-end; }
  .ln.swiping .inner { z-index: 2; }
  .cl.tap .ln.item .inner { cursor: pointer; min-height: 50px; }
  .cl.tap .ln.item .tx { font-size: 18px; }
  .cl.tap .ln.item:active .inner { background: var(--im-bg2); }
  .ln .tx { flex: 1; min-width: 0; font: inherit; font-size: 17px; color: var(--im-text); background: transparent;
            border: 0; padding: 10px 0; outline: none; overflow-wrap: anywhere; }
  .ln.blank input.tx { padding: 0; height: 14px; font-size: 14px; }
  .ln.blank input.tx:focus { height: 40px; }
  .ln.plus .inner { min-height: 40px; cursor: text; }
  .ln.plus .pl { flex: none; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
         color: var(--im-dim); opacity: .55; }
  .ln.plus .tx { padding: 8px 0; font-size: 16px; }
  .ln.plus .tx::placeholder { color: transparent; }
  .ln.plus .tx:focus::placeholder { color: var(--im-dim); }
  .ln.plus:focus-within .pl { opacity: 1; color: var(--im-acc-strong); }
  .ln.plus:focus-within .inner { border-bottom: 1px solid var(--im-line); }
  .ln.flash .inner { animation: im-flash 1.2s ease-out; }
  @keyframes im-flash { 0%, 30% { background: var(--im-acc-soft, rgba(255, 196, 0, .28)); } 100% { background: var(--im-bg); } }
  .ln.header { margin-top: 14px; }
  .ln.header .tx { font-weight: 700; font-size: 19px; letter-spacing: -.01em; padding: 6px 0; }
  .chk { flex: none; width: 24px; height: 24px; border-radius: 50%; border: 1.6px solid var(--im-dim); position: relative;
         transition: background .15s, border-color .15s; }
  .ln.done .chk { background: var(--im-acc-strong); border-color: var(--im-acc-strong); }
  .ln.done .chk::after { content: ""; position: absolute; left: 7.5px; top: 3px; width: 6px; height: 11px;
         border: solid #fff; border-width: 0 2.2px 2.2px 0; transform: rotate(45deg); }
  .ln.done .tx { color: var(--im-dim); text-decoration: line-through; }
  .ln .pin { display: none; flex: none; align-items: center; font-size: 11px; font-weight: 600; letter-spacing: .02em;
             padding: 3px 8px; border-radius: 10px; color: var(--im-dim); border: 1px dashed var(--im-dim); opacity: .8; }
  .ln.engangs .pin { display: inline-flex; }
  .ln.done .pin { opacity: .45; }
  button.pin { cursor: pointer; }
  button.pin:active { background: var(--im-bg2); }
  .cl.nocheck .ln.item .inner { padding-left: 2px; }
  .ln.koebt .inner::after { content: attr(data-butik); order: 2; flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis;
                            white-space: nowrap; font-size: 12px; color: var(--im-dim); padding: 2px 8px; border-radius: 10px; background: var(--im-bg2); }
  .ln.koebt .grip { order: 3; }
  .grip { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px;
          margin-right: -10px; color: var(--im-dim); opacity: .45; touch-action: none; cursor: grab;
          -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  .grip:hover { opacity: .9; }
  .ln.dragging { z-index: 3; background: var(--im-bg); border-radius: 10px; overflow: visible;
                 box-shadow: 0 6px 22px rgba(0,0,0,.22); cursor: grabbing; opacity: .88; }
  .ln.dragging .grip { opacity: 1; color: var(--im-acc); cursor: grabbing; }
  .cl.sorting { -webkit-user-select: none; user-select: none; }
  .drop { position: relative; height: 0; pointer-events: none; }
  .drop::before { content: ""; position: absolute; left: 0; right: 0; top: -2px; height: 4px; border-radius: 2px;
                  background: var(--im-acc-strong); }
  .cl.sorting .ln:not(.dragging) { transition: none; }

  /* aften */
  .aften-top { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .hvornaar { color: var(--im-dim); margin-right: 4px; }
  .pill { font-size: .8rem; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--im-line); color: var(--im-dim); }
  .pill.acc { border-color: var(--im-acc); color: var(--im-acc); }
  .ret { font-size: clamp(1.8rem, 6vw, 2.5rem); line-height: 1.06; font-weight: 800; letter-spacing: -.028em;
         margin: 6px 0 4px; text-wrap: balance; }
  .ret.tom { font-weight: 500; color: var(--im-dim); font-size: 1.35rem; }
  .imorgen { margin: 2px 0 0; color: var(--im-dim); }
  .imorgen strong { color: var(--im-text); font-weight: 600; }
  .frost { display: flex; align-items: center; gap: 10px; margin: 12px 0 2px; padding: 10px 12px;
           background: var(--im-frost-bg); color: var(--im-frost); border-left: 3px solid var(--im-frost);
           border-radius: 4px 10px 10px 4px; font-weight: 600; }
  .snow { font-size: 1.3rem; line-height: 1; }
  .snow-s { color: var(--im-frost); }
  .ugeknap { margin-top: 8px; }
  .uge { list-style: none; margin: 2px 0 4px; padding: 0; }
  .uge li { display: grid; grid-template-columns: 5.6em 1fr; column-gap: 10px; padding: 8px 0; border-top: 1px solid var(--im-line); }
  .uge li.nu .ud, .uge li.nu .ur { font-weight: 700; }
  .ud { color: var(--im-dim); }
  .un { grid-column: 2; font-size: .8rem; color: var(--im-dim); }

  /* forslag */
  .forslag { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .forslag:empty { display: none; }
  .flabel { font-size: .85rem; color: var(--im-dim); margin-right: 2px; }
  .chip { padding: 5px 11px; border-radius: 999px; border: 1px dashed var(--im-acc); color: var(--im-acc); font-size: .88rem; }
  .chip:disabled { opacity: .35; }
  .chip.af { border-style: solid; }
  .chip small { color: var(--im-dim); font-size: .78rem; }

  /* statistik */
  .stats h3 { font-size: .9rem; font-weight: 600; color: var(--im-dim); margin: 18px 0 4px; }
  .sbars { display: flex; align-items: flex-end; gap: 4px; height: 120px; margin: 8px 0 4px; }
  .sbar { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; min-width: 0; }
  .bf { flex: none; width: 100%; max-width: 26px; background: color-mix(in srgb, var(--im-acc-strong) 40%, transparent); border-radius: 4px 4px 0 0; }
  .sbar.nu .bf { background: var(--im-acc-strong); }
  .bv, .bl { font-size: .7rem; color: var(--im-dim); }
  .bl { margin-top: 3px; }
  .top { list-style: none; margin: 0; padding: 0; }
  .top li { display: grid; grid-template-columns: 1fr auto; column-gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--im-line); }
  .tn { font-weight: 500; }
  .tc { font-variant-numeric: tabular-nums; font-weight: 700; }
  .ti { grid-column: 1 / -1; font-size: .8rem; color: var(--im-dim); }
  .tekst { margin: 4px 0; line-height: 1.45; }
  .tom-tekst { color: var(--im-dim); margin: 16px 0; line-height: 1.45; }
  @media (prefers-reduced-motion: reduce) { .chk { transition: none; } }
`;
