/* Indkøb & Madplan – dashboard-kort
 * type: custom:indkob-madplan-card
 * valgfrit: vis_madplan (true), vis_liste (true), vis_statistik (true), skjul_koebte (true),
 *           kun_i_dag (false) – kompakt række med dagens ret; tryk åbner noterne
 *           hurtig_tilfoej (true) – med kun_i_dag: ＋-knap der folder et felt ud til indkøbslisten
 *           forslag (true) – med kun_i_dag: "plejer I at købe"-knapper i det udfoldede felt
 *           vis_i_morgen (false) – med kun_i_dag: også morgendagens ret
 *           (fra kl. 18 viser den kompakte række morgendagens ret – "I morgen")
 */
import * as C from "./im-common.js?v=0.12.3";

// Kortets modul indlæses ved hver opstart af HA's frontend – herfra genoptages indkøbslisten.
C.resumeIfShopping();

// Familien spiser 17–18; herefter viser den kompakte række morgendagens ret (= const.FROST_SKIFT_TIME).
const AFTEN_SLUT_TIME = 18;

class IndkobMadplanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "liste";
    this._weekOpen = false;
    this._addOpen = false;
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
    return this._config?.kun_i_dag ? 1 : 8;
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
        <section class="kompakt" id="kompakt" hidden>
          <div class="rk" id="rk" role="link" tabindex="0" aria-label="Åbn Indkøb & Madplan">
            <span class="ik" id="ik"><ha-icon icon="mdi:silverware-fork-knife"></ha-icon></span>
            <span class="tk">
              <span class="over" id="over"></span>
              <span class="titel" id="titel"></span>
              <span class="ekstra" id="ekstra"></span>
            </span>
            <button class="plus" id="plus" data-act="plus" aria-label="Tilføj til indkøbslisten" aria-expanded="false">
              <ha-icon icon="mdi:plus"></ha-icon></button>
          </div>
          <div class="hurtig" id="hurtig" hidden>
            <form class="felt" id="tilfoej-kun" autocomplete="off">
              <input id="ny-kun" type="text" enterkeyhint="done" placeholder="Tilføj til indkøbslisten" aria-label="Tilføj til indkøbslisten" autocapitalize="sentences" />
              <button type="submit" aria-label="Tilføj"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
            </form>
            <div class="chips" id="af-kun"></div>
            <span class="kvit" id="kvit" aria-live="polite"></span>
          </div>
        </section>
        <section class="aften" id="aften"></section>
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
    r.getElementById("rk").addEventListener("keydown", (e) => {
      if (e.target.closest("[data-act]")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this._openPanel();
      }
    });
    r.getElementById("ny-kun").addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._toggleAdd(false);
    });
    this._renderAll();
  }

  _renderAll() {
    if (!this._built) return;
    const r = this.shadowRoot;
    const c = this._config;
    const s = this._state;
    const kun = !!c.kun_i_dag;
    this.toggleAttribute("kun", kun);
    if (this._store?.error && !s) {
      r.getElementById("kompakt").hidden = true;
      r.getElementById("aften").hidden = false;
      r.getElementById("aften").innerHTML = `<p class="fejl">${C.esc(this._store.error)}</p>`;
      return;
    }
    r.getElementById("kompakt").hidden = !kun;
    if (kun) {
      r.getElementById("aften").hidden = true;
      r.getElementById("faner").hidden = true;
      r.getElementById("liste").hidden = true;
      r.getElementById("stats").hidden = true;
      r.getElementById("plus").hidden = !c.hurtig_tilfoej;
      if (!c.hurtig_tilfoej) this._addOpen = false;
      r.getElementById("hurtig").hidden = !this._addOpen;
      this._renderKompakt();
      if (this._addOpen) this._renderAutofill();
      return;
    }
    r.getElementById("faner").hidden = false;
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
    const open = s.indkob.lines.filter((l) => l.type === "item" && !l.checked).map((l) => l.text);
    if (kun) {
      box.innerHTML = C.autofillHTML(s.indkob.kendte, inp.value, s.indkob.lines, 4)
        || (this._config.forslag ? C.forslagHTML(s.stats, open).replace(/^<span class="flabel">[^<]*<\/span>/, "") : "");
      return;
    }
    box.innerHTML = C.autofillHTML(s.indkob.kendte, inp.value, s.indkob.lines, 4) || C.forslagHTML(s.stats, open);
  }

  /* Kompakt visning: én række med dagens ret (+ evt. optøning / i morgen). */
  _renderKompakt() {
    const r = this.shadowRoot;
    const mp = this._state?.madplan;
    const over = r.getElementById("over");
    const titel = r.getElementById("titel");
    const ekstra = r.getElementById("ekstra");
    const rk = r.getElementById("rk");
    if (!mp) {
      over.textContent = "I aften";
      titel.textContent = "Henter madplan …";
      ekstra.innerHTML = "";
      rk.classList.add("tom");
      return;
    }
    const dage = mp.dage || [];
    const idag = dage.find((d) => d.offset === 0);
    const imorgen = dage.find((d) => d.offset === 1);
    // Fra kl. 18 er aftensmaden spist → rækken viser morgendagens ret (samme skift som optøningen;
    // backenden sender ny tilstand kl. 18:00 og ved midnat, så kortet tegnes om af sig selv).
    const visImorgen = new Date().getHours() >= AFTEN_SLUT_TIME;
    const dag = visImorgen ? imorgen : idag;
    const ret = dag?.ret || "";
    const noter = [...(dag?.noter || []), dag?.stor_portion ? "stor portion" : ""].filter(Boolean);
    over.innerHTML = `${visImorgen ? "I morgen" : "I aften"}${noter.length ? `<span class="not"> · ${C.esc(noter.join(" · "))}</span>` : ""}`;
    titel.textContent = ret || "Intet på madplanen";
    titel.title = ret;
    rk.classList.toggle("tom", !ret);
    const linjer = [];
    const frostDag = mp.frost_dag === "i morgen" ? imorgen : idag;
    if (frostDag?.kraever_optoening) {
      const koed = (frostDag.koed || [])[0] || "kød";
      linjer.push(`<span class="frost-l"><ha-icon icon="mdi:snowflake"></ha-icon>Tag ${C.esc(koed)}${mp.frost_dag === "i morgen" ? " op til i morgen" : " op af fryseren"}</span>`);
    }
    if (this._config.vis_i_morgen && !visImorgen && imorgen?.ret)
      linjer.push(`<span class="imorgen-l">I morgen: <b>${C.esc(imorgen.ret)}</b></span>`);
    ekstra.innerHTML = linjer.join("");
    rk.classList.toggle("koldt", !!frostDag?.kraever_optoening);
  }

  _toggleAdd(open = !this._addOpen) {
    const r = this.shadowRoot;
    this._addOpen = open;
    r.getElementById("hurtig").hidden = !open;
    const plus = r.getElementById("plus");
    plus.setAttribute("aria-expanded", String(open));
    plus.setAttribute("aria-label", open ? "Luk" : "Tilføj til indkøbslisten");
    plus.classList.toggle("aaben", open);
    const inp = r.getElementById("ny-kun");
    if (open) {
      this._renderAutofill();
      inp.focus({ preventScroll: true });
    } else {
      inp.value = "";
      inp.blur();
      r.getElementById("kvit").classList.remove("vis");
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
    if (this._config.kun_i_dag) {
      if (e.target.closest("[data-act='plus']")) {
        this._toggleAdd();
        return;
      }
      if (e.target.closest("#rk")) {
        this._openPanel();
        return;
      }
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

  /* kompakt (kun_i_dag): én række i bubble-stil */
  :host([kun]) ha-card { overflow: visible; }
  .kompakt { padding: 6px 8px 6px 6px; }
  .rk { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 2px 2px 2px 2px; border-radius: 16px;
        cursor: pointer; -webkit-tap-highlight-color: transparent; outline-offset: 2px; }
  .rk:active { background: color-mix(in srgb, var(--im-text) 6%, transparent); }
  .ik { flex: none; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center;
        background: color-mix(in srgb, var(--im-acc-strong) 22%, transparent); color: var(--im-acc);
        --mdc-icon-size: 22px; transition: background .2s, color .2s; }
  .rk.tom .ik { background: color-mix(in srgb, var(--im-text) 8%, transparent); color: var(--im-dim); }
  .rk.koldt .ik { background: var(--im-frost-bg); color: var(--im-frost); }
  .tk { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .over { font-size: 12.5px; line-height: 1.25; color: var(--im-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .titel { font-size: 16px; line-height: 1.25; font-weight: 600; letter-spacing: -.005em; color: var(--im-text);
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rk.tom .titel { font-weight: 500; color: var(--im-dim); }
  .ekstra { display: flex; flex-direction: column; gap: 1px; }
  .ekstra:empty { display: none; }
  .frost-l, .imorgen-l { font-size: 12.5px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .frost-l { color: var(--im-frost); font-weight: 600; display: flex; align-items: center; gap: 4px; --mdc-icon-size: 14px; }
  .frost-l ha-icon { flex: none; }
  .imorgen-l { color: var(--im-dim); }
  .imorgen-l b { color: var(--im-text); font-weight: 500; }
  .plus { flex: none; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
          background: color-mix(in srgb, var(--im-text) 8%, transparent); color: var(--im-text); --mdc-icon-size: 22px; }
  .plus ha-icon { transition: transform .2s ease; }
  .plus.aaben { background: color-mix(in srgb, var(--im-acc-strong) 22%, transparent); color: var(--im-acc); }
  .plus.aaben ha-icon { transform: rotate(45deg); }
  .hurtig { padding: 8px 2px 2px; display: flex; flex-direction: column; gap: 8px; }
  .felt { position: relative; display: flex; }
  .felt input { flex: 1; min-width: 0; font: inherit; font-size: 16px; height: 42px; box-sizing: border-box; padding: 0 50px 0 16px;
                border-radius: 21px; border: 0; color: var(--im-text); background: color-mix(in srgb, var(--im-text) 8%, transparent); }
  .felt input::placeholder { color: var(--im-dim); }
  .felt input:focus-visible { outline: none; box-shadow: inset 0 0 0 1.5px var(--im-acc); }
  .felt button { position: absolute; right: 4px; top: 4px; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center;
                 background: var(--im-acc-strong); color: #fff; --mdc-icon-size: 20px; }
  .chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; padding: 1px 0; }
  .chips::-webkit-scrollbar { display: none; }
  .chips:empty { display: none; }
  .chips .chip { flex: none; white-space: nowrap; }
  .kvit { font-size: 13px; color: var(--im-acc); font-weight: 600; padding: 0 6px; }
  .kvit:not(.vis) { display: none; }
  @media (prefers-reduced-motion: reduce) { .plus ha-icon, .ik { transition: none; } }
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
