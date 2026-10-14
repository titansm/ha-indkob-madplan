/* Fælles kode for panel og kort: forbindelse, tjekliste, madplan-visning, statistik. */
export const VERSION = "0.2.0";
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
  setMadplan(text, base_version) {
    return this.send("madplan/set", { text, base_version });
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
  constructor(container, store, { editable = true, hideChecked = false, onFocusLine = null } = {}) {
    this.el = container;
    this.store = store;
    this.editable = editable;
    this.hideChecked = hideChecked;
    this.onFocusLine = onFocusLine;
    this.lines = [];
    this.rows = new Map();
    this.dirty = new Map(); // id -> timer
    this.focusId = null;
    this.el.classList.add("cl");
    this.el.addEventListener("click", (e) => this._click(e));
    if (editable) {
      this.el.addEventListener("input", (e) => this._input(e));
      this.el.addEventListener("keydown", (e) => this._key(e));
      this.el.addEventListener("focusin", (e) => {
        const row = e.target.closest("[data-id]");
        this.focusId = row?.dataset.id || null;
        this.onFocusLine?.(this.focusId);
      });
      this.el.addEventListener("focusout", (e) => {
        const row = e.target.closest("[data-id]");
        if (row) this._flush(row.dataset.id);
      });
    }
  }

  setLines(lines) {
    this.lines = lines || [];
    this.render();
  }

  render() {
    const seen = new Set();
    let prev = null;
    let visibleItems = 0;
    for (const ln of this.lines) {
      seen.add(ln.id);
      let row = this.rows.get(ln.id);
      if (!row || row.dataset.type !== ln.type) {
        row?.remove();
        row = this._makeRow(ln);
        this.rows.set(ln.id, row);
      }
      this._fillRow(row, ln);
      const hidden = ln.type === "item" && ln.checked && this.hideChecked;
      row.hidden = hidden || (!this.editable && ln.type === "blank");
      if (ln.type === "item" && !hidden) visibleItems++;
      // placér i rækkefølge
      const want = prev ? prev.nextSibling : this.el.firstChild;
      if (want !== row) this.el.insertBefore(row, want);
      prev = row;
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.remove();
        this.rows.delete(id);
      }
    }
    // Skjul overskrifter uden synlige varer i kompakt visning
    if (!this.editable) {
      let header = null;
      let count = 0;
      const close = () => header && (header.hidden = count === 0);
      for (const ln of this.lines) {
        const row = this.rows.get(ln.id);
        if (ln.type === "header") {
          close();
          header = row;
          count = 0;
        } else if (ln.type === "item" && !row.hidden) count++;
      }
      close();
    }
    this.el.toggleAttribute("data-empty", visibleItems === 0);
  }

  _makeRow(ln) {
    const row = document.createElement("div");
    row.className = "ln " + ln.type;
    row.dataset.id = ln.id;
    row.dataset.type = ln.type;
    if (ln.type === "item") {
      row.innerHTML = `<button class="chk" type="button" role="checkbox" aria-label="Afkryds"></button>` +
        (this.editable
          ? `<input class="tx" type="text" enterkeyhint="next" aria-label="Vare" />`
          : `<span class="tx"></span>`);
    } else if (ln.type === "header") {
      row.innerHTML = this.editable
        ? `<input class="tx" type="text" enterkeyhint="next" aria-label="Overskrift" />`
        : `<span class="tx"></span>`;
    } else {
      row.innerHTML = this.editable ? `<input class="tx" type="text" enterkeyhint="next" aria-label="Tom linje" />` : "";
    }
    return row;
  }

  _fillRow(row, ln) {
    row.classList.toggle("done", !!ln.checked);
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
    const chk = e.target.closest(".chk");
    if (!chk) return;
    const id = chk.closest("[data-id]").dataset.id;
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

/* ------------------------------------------------------------------ madplan-visning */
export function aftenHTML(mp, { compact = false, weekOpen = false } = {}) {
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
    ${imorgen?.ret ? `<p class="imorgen">I morgen: <strong>${esc(imorgen.ret)}</strong></p>` : ""}
    ${frost}
    ${compact ? "" : `<button class="link ugeknap" data-act="uge" aria-expanded="${weekOpen}">${weekOpen ? "Skjul ugen" : "Vis hele ugen"}</button>
    <ol class="uge" ${weekOpen ? "" : "hidden"}>${uge}</ol>`}`;
}

export function nyUgeSkabelon(today = new Date()) {
  const lines = [`Uge ${isoWeek(today)}`];
  for (let i = 0; i < 8; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    lines.push(`${UGEDAGE[(d.getDay() + 6) % 7]}: `);
  }
  return lines.join("\n");
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
    ${s.koebt_denne_uge?.length ? `<h3>Købt i denne uge</h3><p class="tekst">${esc(s.koebt_denne_uge.join(", "))}</p>` : ""}
    ${s.koebt_sidste_uge?.length ? `<h3>Købt i sidste uge</h3><p class="tekst">${esc(s.koebt_sidste_uge.join(", "))}</p>` : ""}
    <p class="dim lille">${s.antal_koeb_i_alt} køb af ${s.antal_varer} forskellige varer${sporet ? " siden " + sporet : ""}.</p>`;
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
  .ln { display: flex; align-items: center; gap: 12px; min-height: 44px; }
  .ln.item { border-bottom: 1px solid var(--im-line); }
  .ln.blank { min-height: 14px; }
  .ln .tx { flex: 1; min-width: 0; font: inherit; font-size: 17px; color: var(--im-text); background: transparent;
            border: 0; padding: 10px 0; outline: none; overflow-wrap: anywhere; }
  .ln.blank input.tx { padding: 0; height: 14px; font-size: 14px; }
  .ln.blank input.tx:focus { height: 40px; }
  .ln.header { margin-top: 14px; }
  .ln.header .tx { font-weight: 700; font-size: 19px; letter-spacing: -.01em; padding: 6px 0; }
  .chk { flex: none; width: 24px; height: 24px; border-radius: 50%; border: 1.6px solid var(--im-dim); position: relative;
         transition: background .15s, border-color .15s; }
  .ln.done .chk { background: var(--im-acc-strong); border-color: var(--im-acc-strong); }
  .ln.done .chk::after { content: ""; position: absolute; left: 7.5px; top: 3px; width: 6px; height: 11px;
         border: solid #fff; border-width: 0 2.2px 2.2px 0; transform: rotate(45deg); }
  .ln.done .tx { color: var(--im-dim); text-decoration: line-through; }

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
