/* Indkøb & Madplan – dashboard-kort
 * type: custom:indkob-madplan-card
 * valgfrit: vis_madplan (true), vis_liste (true), vis_statistik (true), skjul_koebte (true),
 *           kun_i_dag (false) – vis kun dagens ret; tryk på retten åbner noterne
 *           hurtig_tilfoej (true) – med kun_i_dag: felt til at tilføje varer til indkøbslisten
 *           forslag (true) – med kun_i_dag: "plejer I at købe"-knapper under feltet
 *           vis_i_morgen (false) – med kun_i_dag: også morgendagens ret
 */
import * as C from "./im-common.js?v=0.7.0";

// Kortets modul indlæses ved hver opstart af HA's frontend – herfra genoptages indkøbslisten.
C.resumeIfShopping();

class IndkobMadplanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "liste";
    this._weekOpen = false;
    this._built = false;
  }

  setConfig(config) {
    this._config = {
      vis_madplan: true, vis_liste: true, vis_statistik: true, skjul_koebte: true, kun_i_dag: false,
      hurtig_tilfoej: true, forslag: true, vis_i_morgen: false, ...config,
    };
    if (this._built) this._renderAll();
  }
  static getStubConfig() {
    return {};
  }
  getCardSize() {
    return this._config?.kun_i_dag ? (this._config.hurtig_tilfoej ? 3 : 2) : 8;
  }
  getGridOptions() {
    return this._config?.kun_i_dag ? { columns: 12, min_columns: 3, rows: "auto" } : { columns: 12, min_columns: 6, rows: "auto" };
  }

  set hass(hass) {
    this._hass = hass;
    this.toggleAttribute("dark", !!hass.themes?.darkMode);
    if (!this._built) this._build();
    if (!this._unlisten) this._listen();
  }

  connectedCallback() {
    if (this._hass && !this._unlisten) this._listen();
  }
  disconnectedCallback() {
    this._unlisten?.();
    this._unlisten = null;
  }

  _listen() {
    this._store = C.getStore(this._hass);
    this._cl.store = this._store;
    this._unlisten = this._store.listen((s) => {
      this._state = s;
      this._renderAll();
    });
  }

  _build() {
    this._built = true;
    const r = this.shadowRoot;
    r.innerHTML = `<style>${C.BASE_CSS}${CARD_CSS}</style>
      <ha-card>
        <section class="aften" id="aften"></section>
        <section class="hurtig" id="hurtig" hidden>
          <form class="tilfoej" id="tilfoej-kun" autocomplete="off">
            <input id="ny-kun" type="text" enterkeyhint="done" placeholder="Tilføj til indkøbslisten …" aria-label="Tilføj til indkøbslisten" autocapitalize="sentences" />
            <button type="submit" aria-label="Tilføj">+</button>
          </form>
          <div class="forslag" id="af-kun"></div>
          <div class="hurtig-fod"><span class="kvit" id="kvit" aria-live="polite"></span><div class="forslag" id="forslag-kun"></div></div>
        </section>
        <nav class="faner" id="faner" role="tablist">
          <button role="tab" data-tab="liste">Indkøbsliste</button>
          <button role="tab" data-tab="statistik">Statistik</button>
          <a class="aaben" href="${C.PANEL_PATH}" data-act="aaben">Åbn noter</a>
        </nav>
        <section id="liste" class="pane">
          <form class="tilfoej" id="tilfoej" autocomplete="off">
            <input id="ny" type="text" enterkeyhint="done" placeholder="Tilføj vare …" aria-label="Tilføj vare" />
            <button type="submit" aria-label="Tilføj">+</button>
          </form>
          <div class="forslag" id="forslag"></div>
          <div id="cl"></div>
          <div class="kurv" id="kurv"></div>
        </section>
        <section id="stats" class="pane stats"></section>
      </ha-card>`;
    this._cl = new C.Checklist(r.getElementById("cl"), this._store, { editable: false, hideChecked: true });
    for (const [formId, inpId] of [["tilfoej", "ny"], ["tilfoej-kun", "ny-kun"]]) {
      const inp = r.getElementById(inpId);
      r.getElementById(formId).addEventListener("submit", (e) => {
        e.preventDefault();
        const v = inp.value.trim();
        if (!v) return;
        this._quickAdd(v, inp);
      });
      inp.addEventListener("input", () => this._renderAutofill());
    }
    r.addEventListener("click", (e) => this._click(e));
    r.getElementById("aften").addEventListener("keydown", (e) => {
      if (this._config.kun_i_dag && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        this._openPanel();
      }
    });
    this._renderAll();
  }

  _renderAll() {
    if (!this._built) return;
    const r = this.shadowRoot;
    const c = this._config;
    const s = this._state;
    if (this._store?.error && !s) {
      r.getElementById("aften").innerHTML = `<p class="fejl">${C.esc(this._store.error)}</p>`;
      return;
    }
    const kun = !!c.kun_i_dag;
    this.toggleAttribute("kun", kun);
    if (kun) {
      const a = r.getElementById("aften");
      a.hidden = false;
      a.setAttribute("role", "link");
      a.setAttribute("tabindex", "0");
      a.setAttribute("aria-label", "Åbn Indkøb & Madplan");
      r.getElementById("faner").hidden = true;
      r.getElementById("liste").hidden = true;
      r.getElementById("stats").hidden = true;
      r.getElementById("hurtig").hidden = !c.hurtig_tilfoej;
      if (s) {
        a.innerHTML = C.aftenHTML(s.madplan, { onlyToday: true, showTomorrow: !!c.vis_i_morgen });
        if (c.hurtig_tilfoej) {
          const open = s.indkob.lines.filter((l) => l.type === "item" && !l.checked).map((l) => l.text);
          r.getElementById("forslag-kun").innerHTML = c.forslag ? C.forslagHTML(s.stats, open).replace(/^<span class="flabel">[^<]*<\/span>/, "") : "";
          this._renderAutofill();
        }
      }
      return;
    }
    r.getElementById("hurtig").hidden = true;
    r.getElementById("faner").hidden = false;
    r.getElementById("aften").removeAttribute("role");
    r.getElementById("aften").removeAttribute("tabindex");
    if (!c.vis_liste) this._tab = "statistik";
    if (!c.vis_statistik) this._tab = "liste";
    r.getElementById("aften").hidden = !c.vis_madplan;
    r.getElementById("faner").querySelectorAll("[data-tab]").forEach((b) => {
      b.hidden = !(c.vis_liste && c.vis_statistik);
      b.setAttribute("aria-selected", String(b.dataset.tab === this._tab));
    });
    r.getElementById("liste").hidden = !(c.vis_liste && this._tab === "liste");
    r.getElementById("stats").hidden = !(c.vis_statistik && this._tab === "statistik");
    if (!s) return;
    if (c.vis_madplan) r.getElementById("aften").innerHTML = C.aftenHTML(s.madplan, { weekOpen: this._weekOpen });
    this._cl.hideChecked = c.skjul_koebte;
    this._cl.setLines(s.indkob.lines);
    this._renderAutofill();
    const done = s.indkob.lines.filter((l) => l.type === "item" && l.checked).length;
    r.getElementById("kurv").innerHTML = done && c.skjul_koebte
      ? `<span class="dim">${done} ${done === 1 ? "vare" : "varer"} i kurven</span><button class="link" data-act="vis-kurv">Vis</button>`
      : done ? `<button class="link" data-act="skjul-kurv">Skjul købte</button>` : "";
    if (this._tab === "statistik") r.getElementById("stats").innerHTML = C.statsHTML(s.stats);
  }

  _renderAutofill() {
    const r = this.shadowRoot;
    const s = this._state;
    if (!s) return;
    const kun = this._config.kun_i_dag;
    const inp = r.getElementById(kun ? "ny-kun" : "ny");
    const box = r.getElementById(kun ? "af-kun" : "forslag");
    if (kun) box.innerHTML = C.autofillHTML(s.indkob.kendte, inp.value, s.indkob.lines, 4);
    else {
      const open = s.indkob.lines.filter((l) => l.type === "item" && !l.checked).map((l) => l.text);
      box.innerHTML = C.autofillHTML(s.indkob.kendte, inp.value, s.indkob.lines, 4) || C.forslagHTML(s.stats, open);
    }
  }

  async _quickAdd(text, inp) {
    if (inp) inp.value = "";
    this._renderAutofill();
    const kvit = this.shadowRoot.getElementById("kvit");
    try {
      const ln = await this._store.add(text, { auto_place: true, line_type: "item" });
      const kat = ln.kategori ? " · " + C.prettyHeader(ln.kategori) : "";
      this._kvit(ln.fandtes ? `"${ln.text}" står allerede på listen${kat}` : `✓ ${ln.text} er tilføjet${kat}`);
    } catch (err) {
      this._kvit("Kunne ikke tilføje");
    }
  }

  _kvit(text) {
    const el = this.shadowRoot.getElementById("kvit");
    el.textContent = text;
    el.classList.add("vis");
    clearTimeout(this._kvitTimer);
    this._kvitTimer = setTimeout(() => el.classList.remove("vis"), 3500);
  }

  _openPanel() {
    history.pushState(null, "", C.PANEL_PATH);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  _click(e) {
    if (this._config.kun_i_dag && e.target.closest("#aften")) {
      this._openPanel();
      return;
    }
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      this._tab = tab.dataset.tab;
      this._renderAll();
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "aaben") {
      e.preventDefault();
      this._openPanel();
    } else if (act === "uge") {
      this._weekOpen = !this._weekOpen;
      this._renderAll();
    } else if (act === "forslag" || act === "autofill") {
      b.disabled = true;
      this._quickAdd(b.dataset.navn, this.shadowRoot.getElementById(this._config.kun_i_dag ? "ny-kun" : "ny"));
    } else if (act === "vis-kurv") {
      this._config = { ...this._config, skjul_koebte: false };
      this._renderAll();
    } else if (act === "skjul-kurv") {
      this._config = { ...this._config, skjul_koebte: true };
      this._renderAll();
    }
  }
}

const CARD_CSS = `
  ha-card { overflow: hidden; color: var(--im-text); }
  .aften { padding: 18px 18px 10px; border-bottom: 1px solid var(--im-line); }
  .faner { display: flex; gap: 4px; align-items: center; padding: 10px 14px 0; }
  .faner button { padding: 8px 12px; border-radius: 8px; color: var(--im-dim); font-weight: 500; }
  .faner button[aria-selected="true"] { color: var(--im-text); background: var(--im-bg2); }
  .aaben { margin-left: auto; color: var(--im-acc); font-weight: 600; text-decoration: none; padding: 8px 4px; }
  .pane { padding: 6px 16px 14px; }
  .tilfoej { display: flex; gap: 8px; margin: 8px 0 10px; }
  .tilfoej input { flex: 1; min-width: 0; font: inherit; font-size: 16px; padding: 11px 14px; border-radius: 12px;
                   border: 0; background: var(--im-bg2); color: var(--im-text); }
  .tilfoej button { width: 46px; border-radius: 12px; background: var(--im-acc-strong); color: #fff; font-size: 1.5rem; line-height: 1; }
  .forslag { margin-bottom: 4px; }
  .ln.header { margin-top: 12px; }
  .ln.header .tx { font-size: 15px; color: var(--im-dim); font-weight: 600; }
  #cl[data-empty]::before { content: "Alt er købt. Tilføj en vare ovenfor."; color: var(--im-dim); padding: 12px 0; }
  .kurv { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-top: 6px; }
  .kurv:empty { display: none; }
  .hurtig { padding: 0 16px 12px; }
  .hurtig .tilfoej { margin: 2px 0 0; }
  .hurtig-fod { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; min-height: 0; }
  .kvit { font-size: 14px; color: var(--im-acc); font-weight: 600; opacity: 0; transition: opacity .25s; min-height: 0; }
  .kvit.vis { opacity: 1; min-height: 1.3em; }
  .kvit:not(.vis):empty { display: none; }
  #af-kun:not(:empty) { margin-top: 8px; }
  :host([kun]) .aften { border-bottom: 0; padding: 16px 18px; cursor: pointer; }
  :host([kun]) .aften + .hurtig:not([hidden]) { border-top: 1px solid var(--im-line); padding-top: 12px; }
  :host([kun]) .aften .ret { font-size: clamp(1.5rem, 5vw, 2.1rem); margin-bottom: 0; }
  :host([kun]) .aften .frost { margin-top: 10px; }
`;

if (!customElements.get("indkob-madplan-card")) {
  customElements.define("indkob-madplan-card", IndkobMadplanCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "indkob-madplan-card",
    name: "Indkøb & Madplan",
    description: "Aftensmad, ugens madplan, indkøbsliste og købsstatistik.",
  });
}
