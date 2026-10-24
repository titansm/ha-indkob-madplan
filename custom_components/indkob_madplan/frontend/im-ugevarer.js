/* Indkøb & Madplan – "Varer til ugen": samler varerne til ugens retter fra madplanen.
 *
 * Ét ark (telefon først): øverst ugens retter dag for dag, derunder varerne i butikkens
 * rækkefølge. Kød fra fryseren, varer der allerede står på listen og varer der er købt i
 * denne uge er fravalgt – ét tryk vælger dem til. Retter uden varer kan få dem skrevet ind
 * her; de huskes, så retten fremover fylder listen selv. "Tilføj N varer" lægger dem på
 * indkøbslisten med retmærke (retnavnet står med småt under varen).
 */
import { esc } from "./im-common.js?v=0.15.0";

const KORT = ["man", "tir", "ons", "tor", "fre", "lør", "søn"];
const MDR = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const dagKort = (iso) => {
  const d = new Date(iso + "T12:00:00");
  return `${KORT[(d.getDay() + 6) % 7]} ${d.getDate()}. ${MDR[d.getMonth()]}`;
};
const kat = (navn) => (navn || "").replace(/^[^A-Za-zÆØÅæøå]+/, "").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const lowerFirst = (s) => (s && !/^[A-ZÆØÅ]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s || "");

class UgeVarer extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.data = null;
    this._valg = new Map(); // tekst -> bool (brugerens valg; ellers serverens standard)
    this._aaben = null; // dato for ret, hvis varer skrives
    this._kladde = {};
    this._busy = false;
    this.shadowRoot.addEventListener("click", (e) => this._click(e));
    this.shadowRoot.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._luk();
    });
  }

  /* ------------------------------------------------------------ åbn/luk */
  async open(store, state, { start = null, dage = null } = {}) {
    this.store = store;
    this.state = state;
    this._render();
    requestAnimationFrame(() => this.shadowRoot.querySelector(".ark")?.classList.add("inde"));
    this._aendret = null;
    await this._hent(start ? { start, dage } : {});
  }

  set hassState(s) {
    const før = this.state;
    this.state = s;
    // Ændres madplanen eller listen imens, hentes ugens varer igen (men ikke midt i en redigering)
    if (this.data && !this._busy && this._aaben === null &&
        (før?.madplan?.version !== s?.madplan?.version || før?.indkob?.version !== s?.indkob?.version)) {
      clearTimeout(this._t);
      this._t = setTimeout(() => this._hent({ start: this.data.start, dage: this.data.dage }, { stille: true }), 600);
    }
  }

  _luk() {
    const ark = this.shadowRoot.querySelector(".ark");
    if (ark) ark.classList.remove("inde");
    setTimeout(() => this.dispatchEvent(new CustomEvent("luk", { bubbles: true, composed: true })), 220);
  }

  /* ------------------------------------------------------------ data */
  async _hent(payload, { stille = false } = {}) {
    if (!stille) {
      this._busy = true;
      this._fejl = null;
      this._renderBody();
    }
    try {
      this.data = await this.store.send("madplan/varer", payload);
    } catch (e) {
      if (!stille) this._fejl = e?.message || "Kunne ikke hente ugens varer.";
    }
    this._busy = false;
    this._render();
  }

  _valgt(v) {
    if (v.paa_listen) return false;
    return this._valg.has(v.tekst) ? this._valg.get(v.tekst) : v.valgt;
  }

  _antal() {
    return (this.data?.varer || []).filter((v) => this._valgt(v)).length;
  }

  /* ------------------------------------------------------------ tegning */
  _render() {
    const r = this.shadowRoot;
    if (!r.querySelector(".ark")) {
      r.innerHTML = `<style>${CSS}</style>
        <div class="bg" data-a="luk"></div>
        <section class="ark" role="dialog" aria-modal="true" aria-labelledby="titel">
          <header class="top">
            <button class="tl" data-a="luk">Luk</button>
            <div class="tt"><b id="titel">Varer til ugen</b><small id="sub"></small></div>
            <span></span>
          </header>
          <div class="krop" id="krop"></div>
          <footer class="bund" id="bund"></footer>
        </section>`;
    }
    this._renderBody();
  }

  _renderBody() {
    const r = this.shadowRoot;
    const krop = r.getElementById("krop");
    const bund = r.getElementById("bund");
    if (!krop) return;
    const d = this.data;
    r.getElementById("sub").textContent = d ? `${dagKort(d.start)} – ${dagKort(d.slut)}` : "";
    if (this._fejl) {
      krop.innerHTML = `<div class="fejlboks"><p class="fejl">${esc(this._fejl)}</p><button class="knap" data-a="igen">Prøv igen</button></div>`;
      bund.innerHTML = "";
      return;
    }
    if (!d) {
      krop.innerHTML = `<p class="laeser">Samler varerne til ugens retter …</p>${'<div class="skel"></div>'.repeat(4)}`;
      bund.innerHTML = "";
      return;
    }
    const seg = (d.perioder || []).map((p) =>
      `<button data-a="periode" data-start="${p.start}" data-dage="${p.dage}" aria-pressed="${p.start === d.start && p.dage === d.dage}">${esc(p.titel)}</button>`).join("");
    krop.innerHTML = `
      ${this._aendret ? `<p class="aendret" role="alert">${esc(this._aendret)}</p>` : ""}
      <div class="seg" role="group" aria-label="Hvilken uge">${seg}</div>
      <h3 class="vh">Ugens retter</h3>
      <div class="dage ${this._busy ? "travl" : ""}">${d.dage_liste.map((x) => this._dagHTML(x)).join("")}</div>
      ${this._varerHTML(d)}
      ${d.har_vi_altid?.length ? `<p class="fod">Har vi altid (kommer ikke med): ${esc(d.har_vi_altid.join(", "))}.</p>` : ""}
      <details class="hvordan"><summary>ⓘ Sådan virker det</summary>
        <p>Varerne kommer fra jeres retter (Noter → Retter). <b>Kød fra fryseren</b> er fravalgt – tryk på varen, hvis I skal købe det. Varer, der allerede står på listen, eller som I har købt i denne uge, er også fravalgt.</p>
        <p><b>Køleskabet</b> (Noter → Køleskab): rester mærket <i>Nok</i> er fravalgt (🧊 i køleskabet); rester mærket <i>Lidt</i> købes stadig, men er mærket.</p>
        <p>Retter uden varer: tryk <i>Skriv varerne</i>. Listen huskes, så retten næste gang fylder indkøbslisten selv.</p>
        <p>Varerne lægges på listen som engangsvarer med retten skrevet med småt under – så kan I se i butikken, hvad den skal bruges til.</p>
      </details>`;
    const n = this._antal();
    bund.innerHTML = `
      <button class="sek" data-a="luk">${n ? "Ikke nu" : "Luk"}</button>
      <button class="prim" data-a="tilfoej" ${n && !this._busy ? "" : "disabled"}>${n ? `Tilføj ${n} ${n === 1 ? "vare" : "varer"}` : "Intet at tilføje"}</button>`;
  }

  _dagHTML(x) {
    const navn = x.slags === "ret" || x.slags === "rest" ? x.navn : x.tekst || "";
    let hoejre = "";
    let cls = "";
    if (x.slags === "tom") {
      hoejre = `<span class="dim">Intet planlagt</span>`;
      cls = "tom";
    } else if (x.slags === "rest") hoejre = `<span class="dim">Rester</span>`;
    else if (x.slags === "begivenhed") hoejre = `<span class="dim">Ingen madlavning</span>`;
    else if (x.antal) hoejre = `<span class="ok">🛒 ${x.antal}</span>${x.gange > 1 ? `<span class="x2">×2</span>` : ""}`;
    else hoejre = `<button class="link" data-a="skriv" data-dato="${x.dato}">＋ Skriv varerne</button>`;
    const aaben = this._aaben === x.dato;
    return `
      <div class="dag ${cls} ${aaben ? "aaben" : ""}">
        <div class="dr">
          <span class="dn">${esc(x.ugedag.slice(0, 3))}</span>
          <span class="rn">${esc(cap(navn))}</span>
          <span class="dh">${hoejre}</span>
        </div>
        ${aaben ? this._skrivHTML(x) : ""}
      </div>`;
  }

  _skrivHTML(x) {
    const k = this._kladde[x.dato] ?? "";
    const valgte = new Set(k.split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean));
    const chips = (x.forslag_varer || []).map((v) =>
      `<button class="chip" data-a="chip" data-dato="${x.dato}" data-v="${esc(v)}" aria-pressed="${valgte.has(v.toLowerCase())}">${esc(v)}</button>`).join("");
    const ops = (x.forslag_opskrifter || []).map((o) =>
      `<button class="link op" data-a="brug-op" data-dato="${x.dato}" data-id="${esc(o.id)}">Brug opskriften "${esc(o.navn)}"</button>`).join("");
    return `
      <div class="skriv">
        <p class="hj">Varer til ${esc(lowerFirst(x.navn))} – huskes til næste gang.</p>
        ${chips ? `<div class="chips">${chips}</div>` : ""}
        <textarea id="ta-${x.dato}" data-dato="${x.dato}" rows="4" placeholder="Én vare pr. linje, fx&#10;Hakket oksekød 400 g&#10;Tortillas&#10;Revet ost" autocapitalize="sentences">${esc(k)}</textarea>
        ${ops ? `<div class="ops">${ops}</div>` : ""}
        <div class="sk">
          <button class="sek lille" data-a="annuller">Annullér</button>
          <button class="knap" data-a="gem-ret" data-dato="${x.dato}">Gem varerne</button>
        </div>
      </div>`;
  }

  _varerHTML(d) {
    const varer = d.varer || [];
    if (!varer.length) {
      const mangler = (d.mangler || []).length;
      return `<p class="tomtekst">${mangler ? "Ugens retter har ingen varer endnu – skriv dem ind ovenfor." : "Ingen retter med varer i perioden."}</p>`;
    }
    let sidst = null;
    const rows = varer.map((v, i) => {
      const head = v.kategori !== sidst ? `<div class="kat">${esc(kat(v.kategori))}</div>` : "";
      sidst = v.kategori;
      const on = this._valgt(v);
      const kol = !v.paa_listen && v.koleskab && /køleskab/.test(v.grund || ""); // 0.12.5
      const frost = !v.paa_listen && v.koed && !kol;
      const grund = v.grund ? `<span class="grund ${frost || kol ? "frost" : ""}">${kol ? "🧊 " : frost ? "❄ " : ""}${esc(v.grund)}</span>` : "";
      return `${head}<button class="vare ${v.paa_listen ? "paa" : ""}" data-a="vare" data-i="${i}" role="checkbox" aria-checked="${on}" ${v.paa_listen ? "disabled" : ""}>
          <span class="chk" aria-hidden="true"></span>
          <span class="vt"><span class="vn">${esc(v.tekst)}</span><small>${esc(v.retter.join(" · "))}${v.erstatter?.length ? ` · i stedet for ${esc(v.erstatter.join(", ").toLowerCase())}` : ""}</small></span>
          ${grund}
        </button>`;
    }).join("");
    return `<h3 class="vh">Varer <button class="link alle" data-a="alle">${varer.every((v) => v.paa_listen || this._valgt(v)) ? "Fravælg alle" : "Vælg alle"}</button></h3>
      <div class="varer">${rows}</div>`;
  }

  /* ------------------------------------------------------------ handlinger */
  async _click(e) {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const a = b.dataset.a;
    if (a === "luk") return this._luk();
    if (a === "igen") return this._hent({});
    if (!this.data) return;
    if (a === "periode") {
      if (this._busy) return;
      this._aaben = null;
      this._valg.clear();
      this._aendret = null;
      return this._hent({ start: b.dataset.start, dage: Number(b.dataset.dage) });
    }
    if (a === "vare") {
      const v = this.data.varer[Number(b.dataset.i)];
      if (!v || v.paa_listen) return;
      this._valg.set(v.tekst, !this._valgt(v));
      return this._renderBody();
    }
    if (a === "alle") {
      const alle = this.data.varer.every((v) => v.paa_listen || this._valgt(v));
      this.data.varer.forEach((v) => !v.paa_listen && this._valg.set(v.tekst, !alle));
      return this._renderBody();
    }
    if (a === "skriv") {
      this._aaben = b.dataset.dato;
      this._renderBody();
      const ta = this.shadowRoot.getElementById("ta-" + b.dataset.dato);
      if (ta) {
        ta.addEventListener("input", () => (this._kladde[ta.dataset.dato] = ta.value));
        ta.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      return;
    }
    if (a === "annuller") {
      this._aaben = null;
      return this._renderBody();
    }
    if (a === "chip") {
      const dato = b.dataset.dato;
      const v = b.dataset.v;
      const linjer = (this._kladde[dato] ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
      const i = linjer.findIndex((s) => s.toLowerCase() === v.toLowerCase());
      if (i >= 0) linjer.splice(i, 1);
      else linjer.push(v);
      this._kladde[dato] = linjer.join("\n");
      this._renderBody();
      return;
    }
    if (a === "gem-ret") return this._gemRet(b.dataset.dato);
    if (a === "brug-op") return this._gemRet(b.dataset.dato, b.dataset.id);
    if (a === "tilfoej") return this._tilfoej();
  }

  async _gemRet(dato, opskrift = null) {
    const x = this.data.dage_liste.find((d) => d.dato === dato);
    if (!x || !x.ret) return;
    const payload = { ret: x.ret, navn: x.navn };
    if (opskrift) payload.opskrift = opskrift;
    else {
      const varer = (this._kladde[dato] || "").split("\n").map((s) => s.trim()).filter(Boolean).map(parseVare);
      if (!varer.length) return;
      payload.varer = varer;
    }
    this._busy = true;
    this._renderBody();
    try {
      await this.store.send("retter/gem", payload);
      this._aaben = null;
      delete this._kladde[dato];
      this._toast(opskrift ? `${x.navn} bruger nu opskriftens varer` : `Varerne til ${lowerFirst(x.navn)} er gemt til næste gang`);
    } catch (e) {
      this._busy = false;
      this._fejlToast(e?.message || "Kunne ikke gemme varerne");
      return this._renderBody();
    }
    await this._hent({ start: this.data.start, dage: this.data.dage }, { stille: true });
  }

  async _tilfoej() {
    const valgte = this.data.varer.filter((v) => this._valgt(v));
    if (!valgte.length || this._busy) return;
    this._busy = true;
    this._renderBody();
    try {
      // 0.13.0: arkets version sendes med – er madplanen ændret siden, lægges intet på listen
      const res = await this.store.send("indkob/tilfoej_retter", {
        varer: valgte.map((v) => ({ tekst: v.tekst, retter: v.retter })),
        madplan_version: this.data.madplan_version,
      });
      const n = res.tilfoejet.length;
      const ids = res.ids || [];
      this.dispatchEvent(new CustomEvent("im-toast", {
        bubbles: true, composed: true,
        detail: {
          text: `${n} ${n === 1 ? "vare" : "varer"} til ugens retter er sat på listen` + (res.fandtes.length ? ` (${res.fandtes.length} stod der)` : ""),
          actions: ids.length ? [{ label: "Fortryd", action: () => this.store.send("indkob/delete", { line_ids: ids }) }] : [],
          ms: 7000,
        },
      }));
      this._luk();
    } catch (e) {
      this._busy = false;
      if (e?.code === "conflict") {
        // Madplanen er ændret, mens arket var åbent: regn varerne ud igen, og lad brugeren se dem først
        this._valg = new Map();
        this._aendret = "Madplanen er ændret imens – varerne er regnet ud igen. Tjek dem, og tryk Tilføj igen.";
        await this._hent({ start: this.data.start, dage: this.data.dage }, { stille: true });
        return;
      }
      this._fejlToast(e?.message || "Kunne ikke tilføje varerne");
      this._renderBody();
    }
  }

  _toast(text) {
    this.dispatchEvent(new CustomEvent("im-toast", { bubbles: true, composed: true, detail: { text, ms: 3500 } }));
  }

  _fejlToast(text) {
    this._toast(text);
  }
}

/* "Hakket oksekød 400 g" -> {navn, maengde, enhed}; "Løg 2" -> 2 stk; ellers kun navnet */
const ENHEDER = { g: "g", gram: "g", kg: "kg", ml: "ml", dl: "dl", l: "l", liter: "l", stk: "stk", "dåse": "dåse", "dåser": "dåse",
  pakke: "pakke", pakker: "pakke", bundt: "bundt", bundter: "bundt", glas: "glas", flaske: "flaske", flasker: "flaske" };
export function parseVare(linje) {
  const m = linje.match(/^(.*?)[\s,]+(\d+(?:[.,]\d+)?)\s*([a-zæøå]+)?\.?$/i);
  if (m && m[1].trim()) {
    const enhed = m[3] ? ENHEDER[m[3].toLowerCase()] : "stk";
    if (enhed) return { navn: m[1].trim(), maengde: Number(m[2].replace(",", ".")), enhed };
  }
  const m2 = linje.match(/^(\d+(?:[.,]\d+)?)\s*([a-zæøå]+)?\s+(.+)$/i);
  if (m2) {
    const enhed = m2[2] ? ENHEDER[m2[2].toLowerCase()] : "stk";
    if (enhed) return { navn: m2[3].trim(), maengde: Number(m2[1].replace(",", ".")), enhed };
  }
  return { navn: linje.trim(), maengde: null, enhed: "" };
}

const CSS = `
  :host { position: fixed; inset: 0; z-index: 50; display: block; font-family: inherit; color: var(--im-text);
          -webkit-tap-highlight-color: transparent; }
  [hidden] { display: none !important; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, textarea:focus-visible { outline: 2px solid var(--im-acc); outline-offset: 2px; }
  .bg { position: absolute; inset: 0; background: rgba(0,0,0,.35); }
  .ark { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--primary-background-color, var(--im-bg2));
         transform: translateY(100%); transition: transform .24s cubic-bezier(.2,.8,.2,1); }
  .ark.inde { transform: none; }
  @media (min-width: 700px) {
    .ark { inset: 24px auto 24px 50%; width: 560px; margin-left: -280px; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
  }
  .top { flex: none; display: grid; grid-template-columns: 72px 1fr 72px; align-items: center; min-height: 52px; padding: 0 8px;
         padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px)); background: var(--im-bg); border-bottom: 1px solid var(--im-line); }
  .tl { color: var(--im-acc); font-size: 17px; min-height: 44px; padding: 0 8px; text-align: left; }
  .tt { display: flex; flex-direction: column; align-items: center; line-height: 1.2; min-width: 0; }
  .tt b { font-size: 17px; }
  .tt small { font-size: 12.5px; color: var(--im-dim); white-space: nowrap; }
  .krop { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 12px 14px 24px; }
  .bund { flex: none; display: flex; gap: 10px; padding: 10px 14px calc(10px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
          background: var(--im-bg); border-top: 1px solid var(--im-line); }
  .bund:empty { display: none; }
  .prim { flex: 1; min-height: 50px; border-radius: 14px; background: var(--im-acc); color: #fff; font-weight: 700; font-size: 17px; }
  .sek { flex: none; min-height: 50px; padding: 0 18px; border-radius: 14px; background: var(--im-bg2); color: var(--im-acc);
         font-weight: 600; font-size: 16px; }
  .sek.lille { min-height: 40px; padding: 0 14px; border-radius: 12px; font-size: 15px; }
  .knap { min-height: 40px; padding: 0 16px; border-radius: 12px; background: var(--im-acc); color: #fff; font-weight: 600; font-size: 15px; }
  .link { color: var(--im-acc); font-weight: 600; }
  .laeser { color: var(--im-dim); font-size: 14px; margin: 6px 2px 12px; }
  .skel { height: 48px; border-radius: 14px; margin-bottom: 8px;
          background: linear-gradient(90deg, var(--im-bg) 30%, var(--im-bg2) 50%, var(--im-bg) 70%); background-size: 300% 100%;
          animation: sk 1.2s infinite linear; }
  @keyframes sk { from { background-position: 100% 0; } to { background-position: 0 0; } }
  .fejl { color: var(--error-color, #d93025); font-size: 14px; }
  .fejlboks { padding: 40px 12px; text-align: center; }
  .aendret { margin: 0 0 10px; padding: 10px 12px; border-radius: 12px; background: rgba(255, 152, 0, .14);
             color: var(--im-text); font-size: 14px; line-height: 1.4; }

  .seg { display: flex; background: var(--im-bg); border-radius: 10px; padding: 2px; }
  .seg button { flex: 1; padding: 7px 9px; border-radius: 8px; font-size: 14px; color: var(--im-dim); min-height: 34px; white-space: nowrap; }
  .seg button[aria-pressed="true"] { background: var(--im-acc); color: #fff; font-weight: 600; }
  .vh { display: flex; align-items: baseline; justify-content: space-between; margin: 18px 4px 6px; font-size: 13px; font-weight: 700;
        color: var(--im-dim); text-transform: uppercase; letter-spacing: .04em; }
  .vh .alle { text-transform: none; letter-spacing: 0; font-size: 14px; }

  .dage { background: var(--im-bg); border-radius: 14px; overflow: hidden; transition: opacity .15s; }
  .dage.travl { opacity: .55; pointer-events: none; }
  .dag + .dag { border-top: 1px solid var(--im-line); }
  .dr { display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 0 14px; }
  .dn { flex: none; width: 34px; font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--im-dim); }
  .rn { flex: 1; min-width: 0; font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dag.tom .rn { font-weight: 400; }
  .dh { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 14px; }
  .dh .link { min-height: 40px; }
  .dim { color: var(--im-dim); }
  .ok { color: var(--im-ok, #1f9d55); font-weight: 600; }
  .x2 { font-size: 11.5px; font-weight: 700; padding: 1px 6px; border-radius: 999px; background: var(--im-bg2); color: var(--im-dim); }
  .skriv { padding: 0 14px 12px 58px; }
  .hj { margin: 0 0 8px; font-size: 13.5px; color: var(--im-dim); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip { padding: 6px 12px; border-radius: 999px; font-size: 14px; background: var(--im-bg2); min-height: 34px; }
  .chip[aria-pressed="true"] { background: var(--im-acc); color: #fff; font-weight: 600; }
  textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; line-height: 1.4; padding: 10px 12px; border-radius: 10px;
             border: 0; background: var(--im-bg2); color: var(--im-text); resize: vertical; -webkit-appearance: none; }
  .ops { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; margin-top: 6px; }
  .op { font-size: 14px; min-height: 36px; text-align: left; }
  .sk { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }

  .varer { background: var(--im-bg); border-radius: 14px; overflow: hidden; }
  .kat { font-size: 12px; font-weight: 700; color: var(--im-dim); text-transform: uppercase; letter-spacing: .04em; padding: 12px 14px 2px; }
  .vare { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; min-height: 52px; padding: 6px 14px; }
  .kat + .vare { border-top: 0; }
  .vare + .vare { border-top: 1px solid var(--im-line); }
  .vare:active { background: var(--im-bg2); }
  .vare:disabled { opacity: 1; }
  .chk { flex: none; width: 24px; height: 24px; border-radius: 50%; border: 1.6px solid var(--im-dim); position: relative; }
  .vare[aria-checked="true"] .chk { background: var(--im-acc-strong, var(--im-acc)); border-color: var(--im-acc-strong, var(--im-acc)); }
  .vare[aria-checked="true"] .chk::after { content: ""; position: absolute; left: 7.5px; top: 3px; width: 6px; height: 11px;
         border: solid #fff; border-width: 0 2.2px 2.2px 0; transform: rotate(45deg); }
  .vare.paa .chk { border-style: dashed; opacity: .5; }
  .vt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .vn { font-size: 16.5px; }
  .vare[aria-checked="false"] .vn { color: var(--im-dim); }
  .vt small { font-size: 12px; color: var(--im-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .grund { flex: none; max-width: 42%; font-size: 12px; color: var(--im-dim); padding: 2px 8px; border-radius: 10px; background: var(--im-bg2);
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .grund.frost { color: var(--im-frost, #2b7bd6); background: color-mix(in srgb, var(--im-frost, #2b7bd6) 14%, transparent); }
  .tomtekst { color: var(--im-dim); font-size: 14px; margin: 14px 4px; }
  .fod { color: var(--im-dim); font-size: 13px; margin: 12px 4px 0; line-height: 1.4; }
  .hvordan { margin: 14px 4px 0; font-size: 14px; line-height: 1.45; color: var(--im-dim); }
  .hvordan summary { color: var(--im-acc); font-weight: 600; cursor: pointer; list-style: none; min-height: 32px; display: flex; align-items: center; }
  .hvordan summary::-webkit-details-marker { display: none; }
  .hvordan p { margin: 6px 0 0; }
  @media (prefers-reduced-motion: reduce) { .ark { transition: none; } .skel { animation: none; } }
`;

if (!customElements.get("im-ugevarer")) customElements.define("im-ugevarer", UgeVarer);
