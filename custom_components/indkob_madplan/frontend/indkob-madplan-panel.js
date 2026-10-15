/* Indkøb & Madplan – sidepanel i Home Assistant (noter à la iOS Noter). */
import {
  BASE_CSS, Checklist, aftenHTML, esc, forslagHTML, getStore, lsGet, lsSet, nyUgeSkabelon, relTime, statsHTML,
} from "./im-common.js?v=0.3.0";

const NOTES = [
  { id: "indkob", title: "Indkøbsliste" },
  { id: "madplan", title: "Madplan" },
  { id: "stats", title: "Statistik" },
];

class IndkobMadplanPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._open = lsGet("open", null); // null = notelisten (smal skærm)
    this._hideChecked = lsGet("hideChecked", false);
    this._weekOpen = false;
    this._mpDirty = false;
    this._mpTimer = null;
    this._mpBase = null;
    this._built = false;
  }

  set hass(hass) {
    this._hass = hass;
    this.toggleAttribute("dark", !!hass.themes?.darkMode);
    if (!this._built) this._build();
    if (!this._store) {
      this._store = getStore(hass);
      this._unlisten = this._store.listen((s) => this._onState(s));
    }
  }
  set narrow(v) {
    this._narrow = v;
    if (this._built) this._layout();
  }
  set panel(p) {}
  set route(r) {}

  disconnectedCallback() {
    this._flushMadplan();
  }

  /* ------------------------------------------------------------ skelet */
  _build() {
    this._built = true;
    const r = this.shadowRoot;
    r.innerHTML = `<style>${BASE_CSS}${PANEL_CSS}</style>
      <div class="app">
        <aside class="liste" id="liste">
          <header class="bar">
            <button class="menu" data-act="menu" aria-label="Menu">${ICON_MENU}</button>
            <h1>Noter</h1>
          </header>
          <nav id="noter" class="noter"></nav>
        </aside>
        <main class="note" id="note">
          <header class="bar">
            <button class="tilbage" data-act="tilbage" aria-label="Tilbage til noter">${ICON_BACK}<span>Noter</span></button>
            <span class="status" id="status" aria-live="polite"></span>
            <div class="vaerktoej" id="vaerktoej"></div>
          </header>
          <div class="ark" id="ark">
            <section id="v-indkob" class="pane">
              <h2 class="titel">Indkøbsliste</h2>
              <p class="meta" id="meta-indkob"></p>
              <form class="hurtig" id="hurtig" autocomplete="off">
                <input id="ny" type="text" enterkeyhint="done" placeholder="Tilføj vare …" aria-label="Tilføj vare" />
              </form>
              <div class="forslag" id="forslag"></div>
              <div id="cl"></div>
              <button class="ny-linje" data-act="ny-linje">Ny linje</button>
            </section>
            <section id="v-madplan" class="pane">
              <h2 class="titel">Madplan</h2>
              <p class="meta" id="meta-madplan"></p>
              <div class="aften" id="aften"></div>
              <div class="konflikt" id="konflikt" hidden>
                <span id="konflikt-tekst">Madplanen er ændret på en anden enhed.</span>
                <button class="link" data-act="hent-nyeste">Hent nyeste</button>
              </div>
              <textarea id="mp" spellcheck="true" aria-label="Madplan"
                placeholder="Uge 42&#10;Onsdag: kylling i karry&#10;Torsdag: tit nat - pita"></textarea>
            </section>
            <section id="v-stats" class="pane stats">
              <h2 class="titel">Statistik</h2>
              <div id="stats-body"></div>
            </section>
          </div>
        </main>
      </div>`;
    this._cl = new Checklist(r.getElementById("cl"), null, {
      editable: true,
      hideChecked: this._hideChecked,
      onFocusLine: (id) => (this._focusLine = id),
      scroller: r.getElementById("ark"),
    });
    r.addEventListener("click", (e) => this._click(e));
    r.getElementById("hurtig").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = r.getElementById("ny");
      const v = inp.value.trim();
      if (!v) return;
      inp.value = "";
      this._store.add(v, { auto_place: true, line_type: "item" }).catch(() => {});
    });
    const ta = r.getElementById("mp");
    ta.addEventListener("input", () => {
      this._mpDirty = true;
      this._autogrow();
      this._setStatus("Gemmer …");
      clearTimeout(this._mpTimer);
      this._mpTimer = setTimeout(() => this._flushMadplan(), 800);
    });
    ta.addEventListener("blur", () => this._flushMadplan());
    this._layout();
  }

  _onState(s) {
    if (!this._built) return;
    if (this._store.error && !s) {
      this.shadowRoot.getElementById("ark").innerHTML = `<p class="fejl pad">${esc(this._store.error)}</p>`;
      return;
    }
    this._state = s;
    this._cl.store = this._store;
    this._cl.setLines(s.indkob.lines);
    this._renderNoteList();
    this._renderIndkob();
    this._renderMadplan();
    this.shadowRoot.getElementById("stats-body").innerHTML = statsHTML(s.stats);
  }

  _layout() {
    const r = this.shadowRoot;
    const narrow = this._narrow ?? window.innerWidth < 870;
    const app = r.querySelector(".app");
    if (!app) return;
    app.classList.toggle("smal", narrow);
    const open = this._open || (narrow ? null : "indkob");
    app.classList.toggle("vis-note", !!open);
    for (const n of NOTES) r.getElementById("v-" + n.id).hidden = n.id !== open;
    this._renderTools(open);
    this._renderNoteList();
    if (open === "madplan") requestAnimationFrame(() => this._autogrow());
  }

  /* ------------------------------------------------------------ notelisten */
  _renderNoteList() {
    const s = this._state;
    const nav = this.shadowRoot.getElementById("noter");
    if (!nav) return;
    const narrow = this.shadowRoot.querySelector(".app").classList.contains("smal");
    const open = this._open || (narrow ? null : "indkob");
    const preview = (id) => {
      if (!s) return "";
      if (id === "indkob") {
        const left = s.indkob.lines.filter((l) => l.type === "item" && !l.checked && l.text.trim()).length;
        return `${relTime(s.indkob.updated)} · ${left ? left + " varer mangler" : "Alt er købt"}`;
      }
      if (id === "madplan") {
        const d = (s.madplan.dage || []).find((x) => x.offset === 0);
        return `${relTime(s.madplan.updated)} · ${d?.ret ? "I aften: " + esc(d.ret) : "Intet planlagt i aften"}`;
      }
      return `${s.stats?.antal_koeb_i_alt || 0} køb registreret`;
    };
    nav.innerHTML = NOTES.map(
      (n) => `<button class="nr ${open === n.id ? "aktiv" : ""}" data-note="${n.id}">
        <span class="nt">${n.title}</span><span class="np">${preview(n.id)}</span></button>`
    ).join("");
  }

  /* ------------------------------------------------------------ værktøjslinje */
  _renderTools(open) {
    const t = this.shadowRoot.getElementById("vaerktoej");
    if (open === "indkob") {
      t.innerHTML = `
        <button class="vk" data-act="overskrift" title="Gør linjen til overskrift / vare">Aa</button>
        <button class="vk" data-act="skjul" aria-pressed="${this._hideChecked}" title="Skjul afkrydsede">${this._hideChecked ? "Vis alle" : "Skjul købte"}</button>
        <button class="vk" data-act="mere" aria-haspopup="true" aria-label="Flere handlinger">${ICON_MORE}</button>
        <div class="menu-pop" id="pop" hidden>
          <button data-act="fjern-afkrydsede">Slet afkrydsede varer</button>
          <button data-act="fjern-flueben">Færdig med at handle – fjern alle flueben</button>
        </div>`;
    } else if (open === "madplan") {
      t.innerHTML = `<button class="vk" data-act="ny-uge" title="Indsæt ny uge øverst">Ny uge</button>`;
    } else t.innerHTML = "";
  }

  /* ------------------------------------------------------------ indkøb */
  _renderIndkob() {
    const s = this._state;
    const r = this.shadowRoot;
    const tur = s.indkob.tur;
    const kl = (iso) => new Date(iso).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
    r.getElementById("meta-indkob").textContent = tur?.aktiv && tur.nulstilles
      ? `Handlet ind – fluebenene fjernes ca. kl. ${kl(tur.nulstilles)}`
      : s.indkob.updated
        ? `Ændret ${relTime(s.indkob.updated)}${s.indkob.updated_by ? " af " + s.indkob.updated_by : ""}`
        : "";
    const open = s.indkob.lines.filter((l) => l.type === "item" && !l.checked).map((l) => l.text);
    r.getElementById("forslag").innerHTML = forslagHTML(s.stats, open);
  }

  /* ------------------------------------------------------------ madplan */
  _renderMadplan() {
    const s = this._state;
    const r = this.shadowRoot;
    const mp = s.madplan;
    r.getElementById("aften").innerHTML = aftenHTML(mp, { weekOpen: this._weekOpen });
    r.getElementById("meta-madplan").textContent = mp.updated
      ? `Ændret ${relTime(mp.updated)}${mp.updated_by ? " af " + mp.updated_by : ""}`
      : "";
    const ta = r.getElementById("mp");
    if (!this._mpDirty) {
      if (ta.value !== mp.text) ta.value = mp.text;
      this._mpBase = mp.version;
      r.getElementById("konflikt").hidden = true;
      this._autogrow();
    } else if (mp.version !== this._mpBase && mp.text !== ta.value) {
      r.getElementById("konflikt-tekst").textContent =
        `${mp.updated_by || "En anden"} har ændret madplanen imens.`;
      r.getElementById("konflikt").hidden = false;
    }
  }

  async _flushMadplan() {
    clearTimeout(this._mpTimer);
    if (!this._mpDirty || !this._store) return;
    const ta = this.shadowRoot.getElementById("mp");
    const text = ta.value;
    try {
      const res = await this._store.setMadplan(text, this._mpBase);
      this._mpBase = res.version;
      if (ta.value === text) this._mpDirty = false;
      this._setStatus("Gemt");
    } catch (e) {
      if (e?.code === "conflict") {
        this.shadowRoot.getElementById("konflikt").hidden = false;
        this._setStatus("Ikke gemt");
      } else this._setStatus("Kunne ikke gemme – prøver igen");
      if (e?.code !== "conflict") this._mpTimer = setTimeout(() => this._flushMadplan(), 4000);
    }
  }

  _autogrow() {
    const ta = this.shadowRoot.getElementById("mp");
    if (!ta || ta.offsetParent === null) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + 4 + "px";
  }

  _setStatus(t) {
    const el = this.shadowRoot.getElementById("status");
    el.textContent = t;
    clearTimeout(this._statusTimer);
    if (t === "Gemt") this._statusTimer = setTimeout(() => (el.textContent = ""), 1500);
  }

  /* ------------------------------------------------------------ klik */
  async _click(e) {
    const r = this.shadowRoot;
    const note = e.target.closest("[data-note]");
    if (note) {
      this._flushMadplan();
      this._open = note.dataset.note;
      lsSet("open", this._open);
      this._layout();
      r.getElementById("ark").scrollTop = 0;
      return;
    }
    const b = e.target.closest("[data-act]");
    const pop = r.getElementById("pop");
    if (pop && !e.target.closest("#pop") && b?.dataset.act !== "mere") pop.hidden = true;
    if (!b) return;
    const act = b.dataset.act;
    if (act === "menu") {
      this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
    } else if (act === "tilbage") {
      this._flushMadplan();
      this._open = null;
      lsSet("open", null);
      this._layout();
    } else if (act === "skjul") {
      this._hideChecked = !this._hideChecked;
      lsSet("hideChecked", this._hideChecked);
      this._cl.hideChecked = this._hideChecked;
      this._cl.render();
      this._renderTools("indkob");
    } else if (act === "mere") {
      pop.hidden = !pop.hidden;
    } else if (act === "fjern-afkrydsede") {
      pop.hidden = true;
      const n = this._state.indkob.lines.filter((l) => l.type === "item" && l.checked).length;
      if (n) await this._store.clearChecked();
    } else if (act === "fjern-flueben") {
      pop.hidden = true;
      await this._store.uncheckAll();
    } else if (act === "overskrift") {
      const id = this._focusLine;
      const ln = this._state?.indkob.lines.find((l) => l.id === id);
      if (!ln) return;
      await this._store.update(id, { line_type: ln.type === "header" ? "item" : "header" });
      this._cl._focusSoon(id, "end");
    } else if (act === "ny-linje") {
      const last = this._state.indkob.lines.at(-1);
      const nl = await this._store.add("", { after_id: last ? last.id : null, line_type: "item" });
      this._cl._focusSoon(nl.id, 0);
    } else if (act === "forslag") {
      b.disabled = true;
      this._store.add(b.dataset.navn, { auto_place: true, line_type: "item" }).catch(() => {});
    } else if (act === "uge") {
      this._weekOpen = !this._weekOpen;
      this._renderMadplan();
    } else if (act === "ny-uge") {
      const ta = r.getElementById("mp");
      const tpl = nyUgeSkabelon();
      ta.value = tpl + (ta.value.trim() ? "\n\n" + ta.value : "");
      ta.dispatchEvent(new Event("input"));
      ta.focus();
      const pos = tpl.indexOf(": ") + 2;
      ta.setSelectionRange(pos, pos);
    } else if (act === "hent-nyeste") {
      this._mpDirty = false;
      this._renderMadplan();
    }
  }
}

const ICON_MENU = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M3 6h18v2H3V6m0 5h18v2H3v-2m0 5h18v2H3v-2Z"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M15.4 4.6 8 12l7.4 7.4-1.4 1.4L5.2 12 14 3.2z"/></svg>`;
const ICON_MORE = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m-6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m12 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3"/></svg>`;

const PANEL_CSS = `
  :host { display: block; height: 100%; background: var(--primary-background-color, var(--im-bg2)); color: var(--im-text);
          font-family: var(--paper-font-body1_-_font-family, -apple-system, system-ui, Roboto, sans-serif); }
  .app { display: grid; grid-template-columns: 300px 1fr; height: 100%; box-sizing: border-box;
         padding-left: var(--safe-area-content-inset-left, 0px); padding-right: var(--safe-area-content-inset-right, 0px); }
  .liste { border-right: 1px solid var(--im-line); background: var(--im-bg2); overflow-y: auto; }
  .note { display: flex; flex-direction: column; min-width: 0; background: var(--im-bg); height: 100%; }
  .bar { display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 0 12px;
         padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px)); position: sticky; top: 0; z-index: 2; background: inherit; }
  .bar h1 { font-size: 1.25rem; margin: 0; font-weight: 700; }
  .menu, .tilbage { display: inline-flex; align-items: center; color: var(--im-acc); min-height: 44px; min-width: 44px; }
  .tilbage span { font-size: 17px; }
  .app:not(.smal) .tilbage { visibility: hidden; }
  .status { font-size: .8rem; color: var(--im-dim); margin-left: auto; }
  .vaerktoej { display: flex; align-items: center; gap: 2px; position: relative; }
  .vk { color: var(--im-acc); font-weight: 600; min-height: 44px; min-width: 44px; padding: 0 8px; border-radius: 8px; }
  .vk[aria-pressed="true"] { background: color-mix(in srgb, var(--im-acc) 14%, transparent); }
  .menu-pop { position: absolute; right: 0; top: 46px; background: var(--im-bg); border: 1px solid var(--im-line);
              border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.18); display: flex; flex-direction: column; min-width: 220px; z-index: 5; overflow: hidden; }
  .menu-pop button { text-align: left; padding: 13px 16px; font-size: 16px; }
  .menu-pop button + button { border-top: 1px solid var(--im-line); }
  .menu-pop button:last-child { color: var(--im-acc); }
  .menu-pop button:first-child { color: var(--error-color, #d93025); }

  .noter { display: flex; flex-direction: column; padding: 4px 12px 24px; gap: 0; }
  .nr { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; padding: 12px 14px;
        border-radius: 12px; }
  .nr + .nr { border-top: 1px solid var(--im-line); border-radius: 0 0 12px 12px; }
  .nr.aktiv { background: color-mix(in srgb, var(--im-acc-strong) 28%, transparent); border-radius: 12px; border-top-color: transparent; }
  .nt { font-weight: 700; font-size: 17px; }
  .np { font-size: 14px; color: var(--im-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

  .ark { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .pane { max-width: 720px; margin: 0 auto; padding: 4px 20px calc(120px + var(--safe-area-inset-bottom, 0px)); }
  .titel { font-size: 30px; font-weight: 800; letter-spacing: -.02em; margin: 4px 0 2px; }
  .meta { font-size: 13px; color: var(--im-dim); margin: 0 0 14px; min-height: 1em; }
  .hurtig input { width: 100%; box-sizing: border-box; font: inherit; font-size: 17px; padding: 11px 14px; border-radius: 12px;
                  border: 0; background: var(--im-bg2); color: var(--im-text); }
  .forslag { margin: 10px 0 4px; }
  #cl { margin-top: 8px; }
  #cl[data-empty]::before { content: "Listen er tom. Skriv en vare ovenfor."; color: var(--im-dim); padding: 12px 0; }
  .ny-linje { color: var(--im-acc); font-weight: 600; padding: 14px 0; }

  .aften { padding: 14px 16px 12px; background: var(--im-bg2); border-radius: 14px; margin-bottom: 16px; }
  #mp { width: 100%; box-sizing: border-box; min-height: 50vh; resize: none; border: 0; outline: none; background: transparent;
        color: var(--im-text); font: inherit; font-size: 17px; line-height: 1.55; padding: 0; overflow: hidden; }
  .konflikt { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 12px; margin-bottom: 10px;
              border-radius: 10px; background: color-mix(in srgb, var(--im-acc-strong) 18%, transparent); }
  .pad { padding: 24px; }

  /* smal skærm: én kolonne, noteliste eller note */
  .app.smal { grid-template-columns: 1fr; }
  .app.smal .liste { border-right: 0; }
  .app.smal.vis-note .liste { display: none; }
  .app.smal:not(.vis-note) .note { display: none; }
  .app.smal .noter { padding: 4px 16px; }
  .app.smal .nr { background: var(--im-bg); border-radius: 0; }
  .app.smal .nr:first-child { border-radius: 12px 12px 0 0; }
  .app.smal .nr:last-child { border-radius: 0 0 12px 12px; }
  .app.smal .nr.aktiv { background: var(--im-bg); }
  .app:not(.smal) .menu { display: none; }
  @media (max-width: 600px) { .pane { padding: 4px 16px calc(120px + var(--safe-area-inset-bottom, 0px)); } .titel { font-size: 28px; } }
`;

if (!customElements.get("indkob-madplan-panel")) customElements.define("indkob-madplan-panel", IndkobMadplanPanel);
