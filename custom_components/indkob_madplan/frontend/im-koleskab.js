/* Indkøb & Madplan – Køleskabet (0.12.5): madvarer I har tilbage.
 *
 * Bruges to steder: som noten "Køleskab" i panelet og øverst i ugeplanlæggeren (attributten
 * `planner`). Listen er fælles og ligger i HA (state.koleskab); ændringer går via websocket
 * (koleskab/tilfoej, /saet, /fjern), og panelets abonnement sender den nye liste tilbage.
 *
 * Hver rest er "Nok" (købes ikke: fjernes fra indkøbslisten og fravælges i "Varer til ugen")
 * eller "Lidt" (planlæggeren bruger den stadig først, men den købes som normalt – fx lidt skyr).
 * Faste varer fra basislisten starter som "Lidt", alt andet som "Nok".
 *
 * Hændelse `koleskab-aendret` (bubbles, composed) efter hver ændring – planlæggeren laver så
 * et nyt bud på de dage, I ikke selv har valgt.
 */
import { esc } from "./im-common.js?v=0.13.0";

const KORT = { Mandag: "man.", Tirsdag: "tirs.", Onsdag: "ons.", Torsdag: "tors.", Fredag: "fre.", "Lørdag": "lør.", "Søndag": "søn." };
const lf = (s) => (s && !/^[A-ZÆØÅ]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s || "");
const opremsning = (a) => (a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " og " + a.at(-1));

class ImKoleskab extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._liste = [];
    this._planBrug = null; // planlæggerens dage: {restnavn: "fre.: kylling i karry"}
    this._busy = false;
    this._fortryd = null;
    this.shadowRoot.innerHTML = `<style>${CSS}</style>
      <div class="kol">
        <div class="hoved" id="hoved"></div>
        <form class="tilf" id="tilf" autocomplete="off">
          <input id="ny" type="text" enterkeyhint="done" autocapitalize="sentences" maxlength="200"
            placeholder="Fx fløde, champignon" aria-label="Tilføj rest i køleskabet" />
          <button type="submit" class="plus" aria-label="Tilføj">＋</button>
        </form>
        <ul class="rester" id="rester"></ul>
        <p class="tom" id="tom"></p>
        <p class="hint" id="hint">Nok = købes ikke · Lidt = købes stadig</p>
        <div class="besked" id="besked" hidden role="status"><span id="besked-t"></span><button type="button" data-a="fortryd" id="besked-k">Fortryd</button></div>
      </div>`;
    this.shadowRoot.getElementById("tilf").addEventListener("submit", (e) => {
      e.preventDefault();
      this._tilfoej();
    });
    this.shadowRoot.addEventListener("click", (e) => this._click(e));
  }

  connectedCallback() {
    this._render();
  }

  setup(store) {
    this.store = store;
  }

  set state(s) {
    this._liste = s?.koleskab || [];
    this._render();
  }

  /* Planlæggeren: hvilken dag i forslaget bruger resten */
  set planBrug(m) {
    this._planBrug = m || null;
    this._render();
  }

  get antal() {
    return this._liste.length;
  }

  /* ------------------------------------------------------------ render */
  _render() {
    const r = this.shadowRoot;
    const planner = this.hasAttribute("planner");
    const n = this._liste.length;
    r.getElementById("hoved").innerHTML = planner
      ? `<b>🧊 Rester i køleskabet</b><small>${n ? "Bruges først – tidligt i ugen" : "Skriv det, I har tilbage – så bruger forslagene det først"}</small>`
      : "";
    r.getElementById("hoved").hidden = !planner;
    r.getElementById("tom").textContent = n ? "" : planner ? "" : "Intet i køleskabet. Skriv det, I har tilbage – fx en halv pakke fløde eller lidt champignon.";
    r.getElementById("tom").hidden = !!n || planner;
    r.getElementById("hint").hidden = !n;
    r.getElementById("rester").innerHTML = this._liste.map((x) => this._raekke(x)).join("");
  }

  _brugTekst(x) {
    const p = this._planBrug?.[x.navn];
    if (p) return `Bruges ${esc(p)}`;
    const b = x.bruges;
    if (b) return `Bruges ${esc(KORT[b.ugedag] || b.ugedag.toLowerCase())}: ${esc(lf(b.ret))}`;
    return this._planBrug ? "Ingen af ugens retter bruger den" : "Ikke i madplanen endnu";
  }

  _erBrugt(x) {
    return !!(this._planBrug?.[x.navn] || x.bruges);
  }

  _raekke(x) {
    const nok = !!x.nok;
    return `
      <li data-id="${esc(x.id)}">
        <div class="rt">
          <span class="rn">${esc(x.navn)}</span>
          <small class="${this._erBrugt(x) ? "brugt" : ""}">${this._brugTekst(x)}</small>
        </div>
        <div class="seg" role="group" aria-label="Har I nok af ${esc(x.navn)}?">
          <button type="button" data-a="nok" aria-pressed="${nok}" ${this._busy ? "disabled" : ""}>Nok</button>
          <button type="button" data-a="lidt" aria-pressed="${!nok}" ${this._busy ? "disabled" : ""}>Lidt</button>
        </div>
        <button type="button" class="x" data-a="fjern" aria-label="Tag ${esc(x.navn)} ud af køleskabet" ${this._busy ? "disabled" : ""}>×</button>
      </li>`;
  }

  _besked(tekst, fortryd = null, ms = 8000) {
    const r = this.shadowRoot;
    r.getElementById("besked-t").textContent = tekst;
    r.getElementById("besked-k").hidden = !fortryd;
    r.getElementById("besked").hidden = false;
    this._fortryd = fortryd;
    clearTimeout(this._beskedTimer);
    this._beskedTimer = setTimeout(() => {
      r.getElementById("besked").hidden = true;
      this._fortryd = null;
    }, ms);
  }

  _aendret() {
    this.dispatchEvent(new CustomEvent("koleskab-aendret", { bubbles: true, composed: true }));
  }

  async _send(type, data) {
    this._busy = true;
    this._render();
    try {
      return await this.store.send(type, data);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  /* Fjernet fra indkøbslisten: besked + Fortryd (sæt linjerne tilbage på deres plads) */
  _fjernetBesked(fjernet, foran = "") {
    const navne = fjernet.map((f) => f.text);
    const tekst = `${foran}Fjernet fra indkøbslisten: ${opremsning(navne)}`;
    this._besked(tekst, async () => {
      // Baglæns, så linjer der stod lige efter hinanden, kommer tilbage i samme rækkefølge
      for (const f of [...fjernet].reverse()) {
        await this.store.send("indkob/add", {
          text: f.text, after_id: f.prev || "__top__", line_type: f.type || "item", checked: false, restore: true,
        });
      }
      this._besked(`${opremsning(navne)} står på indkøbslisten igen`);
    }, 10000);
  }

  /* ------------------------------------------------------------ handlinger */
  async _tilfoej() {
    const inp = this.shadowRoot.getElementById("ny");
    const v = inp.value.trim();
    if (!v || this._busy || !this.store) return;
    try {
      const res = await this._send("koleskab/tilfoej", { navne: [v] });
      inp.value = "";
      inp.focus();
      const nye = res.tilfoejet || [];
      if (res.fjernet?.length) this._fjernetBesked(res.fjernet, nye.length ? `${opremsning(nye.map((x) => x.navn))} er i køleskabet. ` : "");
      else if (nye.length) {
        const lidt = nye.filter((x) => !x.nok).map((x) => x.navn);
        this._besked(`${opremsning(nye.map((x) => x.navn))} er i køleskabet${lidt.length ? ` · ${opremsning(lidt)} købes stadig (Lidt)` : ""}`, null, 5000);
      } else if (res.fandtes?.length) this._besked(`${opremsning(res.fandtes.map((x) => x.navn))} står allerede i køleskabet`, null, 4000);
      if (nye.length) this._aendret();
    } catch (e) {
      this._besked(e?.message || "Kunne ikke tilføje", null, 5000);
    }
  }

  async _click(e) {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const a = b.dataset.a;
    if (a === "fortryd") {
      const f = this._fortryd;
      this._fortryd = null;
      this.shadowRoot.getElementById("besked").hidden = true;
      if (f) {
        try {
          await f();
        } catch (err) {
          this._besked(err?.message || "Kunne ikke fortryde", null, 5000);
        }
      }
      return;
    }
    if (this._busy || !this.store) return;
    const id = b.closest("li")?.dataset.id;
    const x = this._liste.find((y) => y.id === id);
    if (!x) return;
    try {
      if (a === "nok" || a === "lidt") {
        const nok = a === "nok";
        if (!!x.nok === nok) return;
        x.nok = nok; // vis med det samme – state kommer bagefter
        let res;
        try {
          res = await this._send("koleskab/saet", { rest_id: id, nok });
        } catch (err) {
          x.nok = !nok;
          this._render();
          throw err;
        }
        if (res.fjernet?.length) this._fjernetBesked(res.fjernet);
        else this._besked(nok ? `${x.navn}: I har nok – købes ikke` : `${x.navn}: lidt – købes stadig`, null, 3500);
        this._aendret();
      } else if (a === "fjern") {
        const res = await this._send("koleskab/fjern", { rest_ids: [id] });
        const ud = res.fjernet || [];
        this._liste = this._liste.filter((y) => y.id !== id);
        this._render();
        if (ud.length) {
          this._besked(`Tog ${lf(ud[0].navn)} ud af køleskabet`, async () => {
            await this.store.send("koleskab/tilfoej", { navne: [ud[0].navn], nok: !!ud[0].nok, liste: false });
            this._aendret();
          });
        }
        this._aendret();
      }
    } catch (err) {
      this._besked(err?.message || "Det lykkedes ikke", null, 5000);
    }
  }
}

const CSS = `
  :host { display: block; color: var(--im-text); }
  [hidden] { display: none !important; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--im-acc); outline-offset: 2px; }
  .kol { display: flex; flex-direction: column; gap: 8px; }
  :host([planner]) .kol { background: var(--im-bg); border-radius: 16px; padding: 10px 12px 12px 14px; }
  .hoved { display: flex; flex-direction: column; gap: 1px; }
  .hoved b { font-size: 15px; }
  .hoved small { font-size: 13px; color: var(--im-dim); }
  .tilf { display: flex; gap: 8px; align-items: center; }
  #ny { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; font-size: 16px; padding: 10px 12px; border-radius: 10px;
        border: 0; background: var(--im-bg2); color: var(--im-text); -webkit-appearance: none; }
  .plus { flex: none; width: 40px; height: 40px; border-radius: 50%; background: var(--im-acc); color: #fff; font-size: 22px;
          font-weight: 600; display: inline-flex; align-items: center; justify-content: center; }
  .rester { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .rester li { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 6px 0; border-bottom: 1px solid var(--im-line); }
  .rester li:last-child { border-bottom: 0; }
  .rt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .rn { font-size: 16.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt small { font-size: 12.5px; color: var(--im-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt small.brugt { color: var(--im-frost); }
  .seg { flex: none; display: inline-flex; background: var(--im-bg2); border-radius: 9px; padding: 2px; }
  .seg button { padding: 6px 10px; border-radius: 7px; font-size: 13.5px; color: var(--im-dim); min-height: 32px; }
  .seg button[aria-pressed="true"] { background: var(--im-acc); color: #fff; font-weight: 600; }
  .x { flex: none; width: 36px; height: 36px; border-radius: 50%; color: var(--im-dim); font-size: 22px; line-height: 1; }
  .x:active { background: var(--im-bg2); }
  .tom { margin: 2px 0; font-size: 14.5px; color: var(--im-dim); line-height: 1.4; }
  .hint { margin: 0; font-size: 12.5px; color: var(--im-dim); }
  .besked { display: flex; align-items: center; gap: 10px; justify-content: space-between; padding: 8px 12px; border-radius: 12px;
            background: var(--im-frost-bg, rgba(109,182,230,.14)); font-size: 14px; line-height: 1.35; }
  .besked button { color: var(--im-acc); font-weight: 700; white-space: nowrap; min-height: 32px; }
`;

if (!customElements.get("im-koleskab")) customElements.define("im-koleskab", ImKoleskab);
