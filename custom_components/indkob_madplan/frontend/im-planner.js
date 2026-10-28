/* Indkøb & Madplan – ugeplanlæggeren: forslag til næste uges madplan ud fra jeres egne uger.
 *
 * Telefon først: ét ark med en kort pr. dag. Tryk på retten for andre forslag, ↻ for næste bud,
 * mærk travle aftener (nattevagt, fodbold …), lås det I vil beholde, og bland resten om.
 * "Gem i madplanen" skriver ugen øverst i madplan-noten i jeres eget format.
 *
 * Portion (0.12.2): portionen hører til dagen, ikke retten. En dag kan laves dobbelt uden at
 * resterne står på en bestemt dag (fryser/frokost), eller med rester på én eller flere af de
 * næste dage. Byttes retten på dagen, følger resterne med; vælges "Normal", får rester-dagene
 * et nyt bud.
 *
 * Kladde (0.12.3): ugen gemmes løbende i HA (madplan/kladde/gem) – et halvt sekund efter hver
 * ændring og straks ved luk – og hentes igen, næste gang planlæggeren åbnes (også på en anden
 * enhed). Kladden slettes, når ugen gemmes i madplanen, eller med "Start forfra".
 *
 * Kød fra fryseren (0.12.4): har retten flere muligheder under "Fra fryseren" (fx burger: hakket
 * oksekød eller kyllingebryst), spørger dagen "Hvilket kød?". Valget skrives i madplanen som
 * "burger (❄ kyllingebryst)", så påmindelsen om at tage kød op siger det rigtige.
 *
 * Køleskabet (0.12.5): øverst står resterne i køleskabet (<im-koleskab planner>). Retter, der bruger
 * dem, foreslås først og lægges på de første dage. Ændres køleskabet, får de dage, I ikke selv har
 * valgt, et nyt bud (som "Bland").
 *
 * Fra madplan til madplan (0.15.1): når planlæggeren åbnes, tager backenden de rester ud, der kom i
 * køleskabet før forrige "Gem i madplanen" (koleskab/ny_planlaegning); er køleskabet tomt, står der
 * en påmindelse om at skrive resterne.
 */
import { esc, lsGet, lsSet, UGEDAGE } from "./im-common.js?v=0.15.1";
import "./im-koleskab.js?v=0.15.1";

const KORT = ["man", "tir", "ons", "tor", "fre", "lør", "søn"];
const MDR = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const PROTEIN = { kylling: "🐔", okse: "🐄", svin: "🐖", fisk: "🐟", vegetar: "🥕", blandet: "🥪", andet: "🍽️" };
const PROTEIN_NAVN = { kylling: "kylling", okse: "okse", svin: "svin", fisk: "fisk", vegetar: "vegetar", blandet: "blandet", andet: "andet" };
const BASE_NAVN = { pasta: "pasta", ris: "ris", kartofler: "kartofler", "brød": "brød", suppe: "suppe", nudler: "nudler" };
const TAG_ORDEN = ["nat", "dag", "alene", "fodbold", "travl", "tid", "gaester", "ude"];

const ICON_LOCK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z"/></svg>`;
const ICON_UNLOCK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5h2a3 3 0 1 1 6 0v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-6 10h12v8H6v-8Z"/></svg>`;
const ICON_SHUFFLE = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M14.6 4H20v5.4l-2-2-3.3 3.3-1.4-1.4L16.6 6l-2-2ZM4 5.4 5.4 4 20 18.6 18.6 20 4 5.4ZM14.6 20l2-2-2.6-2.6 1.4-1.4 2.6 2.6 2-2V20h-5.4ZM4 18.6l5.6-5.6 1.4 1.4L5.4 20 4 18.6Z"/></svg>`;
const ICON_NEXT = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 4a8 8 0 1 0 7.75 10h-2.1A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35A7.95 7.95 0 0 0 12 4Z"/></svg>`;

const INTET = "intet"; // "intet fra fryseren" – samme ord som backenden
const koedNavn = (a) => (a === INTET ? "Intet fra fryseren" : a);
const lowerFirst = (s) => (s && !/^[A-ZÆØÅ]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s || "");
const kortDato = (iso) => {
  const d = new Date(iso + "T12:00:00");
  return `${d.getDate()}/${d.getMonth() + 1}`;
};
const ugedagIdx = (iso) => (new Date(iso + "T12:00:00").getDay() + 6) % 7;
const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const idagIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const kladdeTid = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const kl = `kl. ${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`;
  const dag = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (dag === idagIso()) return `i dag ${kl}`;
  if (dag === addDays(idagIso(), -1)) return `i går ${kl}`;
  return `${KORT[(d.getDay() + 6) % 7]} ${d.getDate()}/${d.getMonth() + 1} ${kl}`;
};
const periode = (start, dage) => {
  const a = new Date(start + "T12:00:00");
  const b = new Date(addDays(start, dage - 1) + "T12:00:00");
  const f = (d) => `${KORT[(d.getDay() + 6) % 7]} ${d.getDate()}. ${MDR[d.getMonth()]}`;
  return `${f(a)} – ${f(b)}`;
};

class UgePlan extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.data = null;
    this.days = [];
    // 0.14.0: nye retter fra ReciMe – standard 2 pr. uge (ny nøgle, så alle enheder starter på 2)
    this.opts = { nye: lsGet("plan_nye2", 2), rester: lsGet("plan_rester", true) };
    this._busy = false;
    this._sheet = null; // åben dag i bund-arket
    this._kladde = null; // {tid, af} når en gemt kladde er hentet
    this._igen = false; // køleskabet blev ændret mens et bud blev hentet: bland igen bagefter
    this._skjult = () => document.visibilityState === "hidden" && this._kladdeNu();
    this.shadowRoot.addEventListener("click", (e) => this._click(e));
    this.shadowRoot.addEventListener("input", (e) => this._input(e));
    this.shadowRoot.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.id === "sog") this._brugSoegning();
    });
    // Esc på hele siden (PC) – også når fokus ikke står i planlæggeren
    this._esc = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      this._sheet !== null ? this._lukSheet() : this._luk();
    };
  }

  connectedCallback() {
    document.addEventListener("visibilitychange", this._skjult);
    window.addEventListener("pagehide", this._skjult);
    document.addEventListener("keydown", this._esc);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._skjult);
    window.removeEventListener("pagehide", this._skjult);
    document.removeEventListener("keydown", this._esc);
    this._kladdeNu();
  }

  /* ------------------------------------------------------------ åbn/luk */
  async open(store, state) {
    this.store = store;
    this.state = state;
    this._sheet = null;
    this.data = null;
    this.days = [];
    this._fejl = null;
    this._kladde = null;
    this._gemt = false;
    this._sidstGemt = null;
    this._mpVersion = null;
    this._overskriv = false;
    this._render();
    const kol = this.shadowRoot.getElementById("kol");
    kol.setup(store);
    kol.state = state;
    requestAnimationFrame(() => this.shadowRoot.querySelector(".ark")?.classList.add("inde"));
    // 0.15.1: køleskabet nulstilles fra madplan til madplan – rester fra forrige planlægning tages ud,
    // før forslagene laves (med besked + Fortryd i køleskabet)
    try {
      const nul = await store.send("koleskab/ny_planlaegning", {});
      if (nul?.fjernet?.length) kol.nulstillet(nul);
    } catch (e) {
      /* ældre backend eller ingen forbindelse: planlæg med køleskabet som det er */
    }
    let k = null;
    try {
      k = await store.send("madplan/kladde/hent", {});
    } catch (e) {
      k = null; // ældre backend eller ingen forbindelse: start bare forfra
    }
    if (this._brugKladde(k)) return this._render();
    await this._hent({});
  }

  /* ------------------------------------------------------------ kladde (0.12.3) */
  _brugKladde(k) {
    const kd = k?.kladde;
    if (!kd) return false;
    const ok = kd.v === 1 && kd.data?.start && Array.isArray(kd.days) && kd.days.length
      && addDays(kd.data.start, kd.days.length - 1) >= idagIso();
    if (!ok) {
      this.store.send("madplan/kladde/slet", {}).catch(() => {}); // ugen er forbi
      return false;
    }
    this.data = kd.data;
    this.days = kd.days.map((d) => ({ ...d, visTags: false }));
    // 0.13.0: madplanens version, ugen blev planlagt ud fra (ældre kladder: den nuværende)
    this._mpVersion = kd.mpv ?? this.store.state?.madplan?.version ?? null;
    if (kd.opts) this.opts = { nye: kd.opts.nye ?? this.opts.nye, rester: kd.opts.rester ?? this.opts.rester };
    this._kladde = { tid: k.tid, af: k.af };
    this._sidstGemt = JSON.stringify({ v: 1, data: this.data, days: this.days, opts: this.opts, mpv: this._mpVersion ?? null });
    return true;
  }

  /* Gem kladden et øjeblik efter sidste ændring (og aldrig midt i et kald til serveren) */
  _kladdeSenere() {
    if (!this.data || this._gemt || this._busy) return;
    clearTimeout(this._kladdeTimer);
    this._kladdeTimer = setTimeout(() => this._kladdeNu(), 500);
  }

  _kladdeNu() {
    clearTimeout(this._kladdeTimer);
    this._kladdeTimer = null;
    if (!this.data || this._gemt || !this.store) return;
    const json = JSON.stringify({ v: 1, data: this.data, days: this.days, opts: this.opts, mpv: this._mpVersion ?? null });
    if (json === this._sidstGemt) return;
    this._sidstGemt = json;
    this.store.send("madplan/kladde/gem", { kladde: JSON.parse(json) }).catch(() => {
      this._sidstGemt = null; // prøv igen ved næste ændring
    });
  }

  async _startForfra() {
    clearTimeout(this._kladdeTimer);
    this._kladde = null;
    this._sidstGemt = null;
    this.data = null;
    this.days = [];
    try {
      await this.store.send("madplan/kladde/slet", {});
    } catch (e) {
      /* ingen kladde at slette */
    }
    this._render();
    await this._hent({});
  }

  set hassState(s) {
    this.state = s;
    const kol = this.shadowRoot.getElementById("kol");
    if (kol) kol.state = s;
  }

  /* Køleskabet er ændret: nyt bud på de dage, I ikke selv har valgt */
  async _kolAendret() {
    if (!this.data) return;
    if (this._busy) {
      this._igen = true;
      return;
    }
    await this._bland();
  }

  _luk() {
    this._kladdeNu(); // et fejlklik må ikke koste ugen
    const ark = this.shadowRoot.querySelector(".ark");
    if (ark) ark.classList.remove("inde");
    setTimeout(() => this.dispatchEvent(new CustomEvent("luk", { bubbles: true, composed: true })), 220);
  }

  /* ------------------------------------------------------------ data */
  async _hent(extra, { kunDag = null } = {}) {
    this._busy = true;
    this._fejl = null;
    this._renderBody();
    const base = this.data ? { start: this.data.start, dage: this.data.dage } : {};
    const payload = { ...base, nye: this.opts.nye, rester: this.opts.rester, seed: Math.floor(Math.random() * 1e9), ...extra };
    try {
      const res = await this.store.send("madplan/planlaeg", payload);
      const nye = res.plan.map((p) => this._fraServer(p));
      if (kunDag !== null && this.days.length === nye.length) {
        // Kun én dag er planlagt om – resten bevarer deres forslag (og grunde)
        this.days[kunDag] = nye[kunDag];
        nye.forEach((d, i) => {
          if (i !== kunDag) this.days[i].alts = d.alts.length ? d.alts : this.days[i].alts;
        });
      } else {
        // Bevar dagene I selv har valgt
        const gamle = new Map(this.days.map((d) => [d.dato, d]));
        this.days = nye.map((d) => {
          const g = gamle.get(d.dato);
          if (g && g.laast && !g.eksisterende) return { ...g, alts: d.alts, kalender: d.kalender };
          return d;
        });
      }
      // 0.14.0: planen er nu i this.days – uden en kopi i data bliver kladden halvt så stor (30 bud pr. dag)
      const { plan: _plan, ...data } = res;
      this.data = data;
      if (kunDag === null) this._mpVersion = this.store.state?.madplan?.version ?? null; // 0.13.0: planens grundlag
      if (kunDag === null) await this._afstem();
    } catch (e) {
      this._fejl = e?.message || "Kunne ikke lave forslag.";
    }
    this._busy = false;
    this._render();
    if (this._igen) {
      this._igen = false;
      setTimeout(() => this._kolAendret(), 0);
    }
  }

  /* Efter et nyt bud på hele ugen: rester I selv har sat, følger dagens nye ret */
  async _afstem() {
    for (let j = 0; j < this.days.length; j++) {
      const d = this.days[j];
      if (!d.restFra || !d.valg?.rest_af) continue;
      const k = this.days.findIndex((x) => x.dato === d.restFra);
      if (k >= 0 && k < j && this._lavesMad(k)) {
        if (this.days[k].valg.navn !== d.valg.rest_af) this._saetRest(k, j);
      } else {
        await this._fjernRest(j);
      }
    }
  }

  _fraServer(p) {
    return {
      dato: p.dato,
      ugedag: p.ugedag,
      tags: p.tags,
      auto: p.auto_tags,
      kalender: p.kalender || [],
      laast: !!p.laast,
      eksisterende: !!p.eksisterende,
      aendret: false,
      tekst: p.tekst,
      valg: p.valg || (p.tekst ? { navn: p.tekst, tekst: lowerFirst(p.tekst), grunde: ["Står allerede i madplanen"], varer: [] } : null),
      alts: (p.alternativer || []).filter(Boolean),
      idx: 0,
      udeTekst: p.tags.includes("ude") ? (p.kalender[0] || "") : "",
      visTags: false,
      dobbelt: !!p.stor_portion, // dobbelt portion uden (eller ud over) en rester-dag
      restFra: null, // dato for den dag, resterne kommer fra (sat når I selv vælger det)
      koed: p.fryser_valg || null, // valgt kød fra fryseren, når retten har flere muligheder
    };
  }

  _laaste(undtagen = null) {
    const out = {};
    this.days.forEach((d, i) => {
      if (i === undtagen || !d.valg || d.tags.includes("ude")) return;
      if (undtagen !== null || d.laast) out[d.dato] = d.valg.rest_af ? `${d.valg.rest_af} rest` : d.valg.navn;
    });
    return out;
  }

  _tagsMap() {
    return Object.fromEntries(this.days.map((d) => [d.dato, d.tags]));
  }

  async _replanDag(i, extra = {}) {
    const rd = this._restDage(i);
    await this._hent({ tags: this._tagsMap(), laaste: this._laaste(i), ...extra }, { kunDag: i });
    await this._kildeSkift(i, rd);
  }

  _bland() {
    return this._hent({ tags: this._tagsMap(), laaste: this._laaste() });
  }

  /* ------------------------------------------------------------ portion og rester */
  _lavesMad(i) {
    const d = this.days[i];
    return !!(d && d.valg && !d.valg.rest_af && !d.tags.includes("ude"));
  }

  /* Den dag resterne på dag j kommer fra (-1 = ukendt/før planen) */
  _kildeIdx(j) {
    const d = this.days[j];
    const r = d?.valg?.rest_af;
    if (!r || d.tags.includes("ude")) return -1;
    if (d.restFra) {
      const k = this.days.findIndex((x) => x.dato === d.restFra);
      if (k >= 0 && k < j && this._lavesMad(k)) return k;
    }
    for (let k = j - 1; k >= 0 && k >= j - 4; k--) {
      if (this._lavesMad(k) && this.days[k].valg.navn.toLowerCase() === r.toLowerCase()) return k;
    }
    return -1;
  }

  /* Dagene der spiser rester af dag i */
  _restDage(i) {
    const out = [];
    for (let j = i + 1; j < this.days.length; j++) if (this._kildeIdx(j) === i) out.push(j);
    return out;
  }

  _erDobbelt(i) {
    return this._lavesMad(i) && (this.days[i].dobbelt || this._restDage(i).length > 0);
  }

  /* Kød fra fryseren: mulighederne for dagens ret, når der skal vælges (mindst to) */
  _koedValg(i) {
    if (!this._lavesMad(i)) return null;
    const v = this.days[i].valg;
    const alts = v.fryser ?? this.data?.fryser?.[v.navn] ?? null;
    return Array.isArray(alts) && alts.length > 1 ? alts : null;
  }

  /* Dage der mangler et kødvalg og bliver skrevet ved Gem */
  _manglerKoed() {
    return this.days
      .map((d, i) => i)
      .filter((i) => this._koedValg(i) && !this.days[i].koed && !(this.days[i].eksisterende && !this.days[i].aendret));
  }

  _restValg(i) {
    const src = this.days[i];
    return {
      navn: `${src.valg.navn} rest`,
      tekst: `${lowerFirst(src.valg.navn)} rest`,
      rest_af: src.valg.navn,
      protein: src.valg.protein,
      base: src.valg.base,
      effort: 1,
      grunde: [`Rester fra ${src.ugedag.toLowerCase()}`, "Ingen madlavning"],
      varer: [],
    };
  }

  _saetRest(i, j) {
    const d = this.days[j];
    d.valg = this._restValg(i);
    d.restFra = this.days[i].dato;
    d.tags = d.tags.filter((t) => t !== "ude");
    d.laast = true;
    d.aendret = true;
  }

  /* Rester-dag j skal ikke længere have rester: få et nyt bud (uden rester) */
  async _fjernRest(j) {
    const d = this.days[j];
    d.restFra = null;
    d.valg = null;
    d.laast = false;
    d.aendret = true;
    await this._replanDag(j, { rester: false });
    this.days[j].aendret = true;
  }

  /* Retten på dag i er skiftet: rester-dagene (rd) følger med, eller får nyt bud */
  async _kildeSkift(i, rd) {
    for (const j of rd) {
      if (!this.days[j]) continue;
      if (this._lavesMad(i)) this._saetRest(i, j);
      else await this._fjernRest(j);
    }
  }

  /* Grunde under retten – med jeres portion i stedet for planlæggerens "Lav dobbelt …" */
  _grunde(i) {
    const v = this.days[i].valg;
    let g = (v?.grunde || []).filter((x) => !x.startsWith("Lav dobbelt"));
    if (this._lavesMad(i)) {
      const rd = this._restDage(i);
      if (rd.length) g = [`Rester til ${rd.map((j) => this.days[j].ugedag.toLowerCase()).join(" og ")}`, ...g];
      else if (this.days[i].dobbelt) g = ["Rester til fryseren eller frokost", ...g];
    }
    return g.slice(0, 3);
  }

  /* ------------------------------------------------------------ render */
  _render() {
    const r = this.shadowRoot;
    if (!r.querySelector(".ark")) {
      r.innerHTML = `<style>${CSS}</style>
        <div class="bg" data-a="luk"></div>
        <section class="ark" role="dialog" aria-modal="true" aria-labelledby="pl-titel">
          <header class="top">
            <button class="tl" data-a="luk">Luk</button>
            <div class="tt"><b id="pl-titel">Planlæg ugen</b><small id="pl-periode"></small></div>
            <span class="tr"></span>
          </header>
          <div class="krop" id="krop"><div id="kb1"></div><im-koleskab planner id="kol" hidden></im-koleskab><div id="kb2"></div></div>
          <footer class="bund" id="bund"></footer>
          <div class="sheet-bg" id="sheet-bg" hidden data-a="luk-sheet"></div>
          <div class="sheet" id="sheet" hidden role="dialog" aria-modal="true"></div>
        </section>`;
      r.getElementById("kol").addEventListener("koleskab-aendret", () => this._kolAendret());
    }
    this._renderBody();
  }

  _renderBody() {
    const r = this.shadowRoot;
    const krop = r.getElementById("krop");
    if (!krop) return;
    const kb1 = r.getElementById("kb1");
    const kb2 = r.getElementById("kb2");
    const kol = r.getElementById("kol");
    const d = this.data;
    r.getElementById("pl-titel").textContent = d ? `Planlæg uge ${d.uge}` : "Planlæg ugen";
    r.getElementById("pl-periode").textContent = d ? periode(d.start, d.dage) : "";
    kol.hidden = !d;
    if (this._fejl && !d) {
      kb1.innerHTML = `<div class="fejlboks"><p>${esc(this._fejl)}</p><button class="knap" data-a="igen">Prøv igen</button></div>`;
      kb2.innerHTML = "";
      r.getElementById("bund").innerHTML = "";
      return;
    }
    if (!d) {
      kb1.innerHTML = `<p class="laeser">Læser jeres tidligere uger …</p>` +
        Array.from({ length: 7 }, () => `<div class="dag skel"><span></span><span></span></div>`).join("");
      kb2.innerHTML = "";
      r.getElementById("bund").innerHTML = "";
      return;
    }
    kol.planBrug = this._kolBrug();
    kb1.innerHTML = `
      ${this._introHTML()}
      ${this._fejl ? `<p class="fejl">${esc(this._fejl)}</p>` : ""}
      ${this._koedBesked ? `<p class="koedbesked">❄ ${esc(this._koedBesked)}</p>` : ""}`;
    kb2.innerHTML = `
      <ol class="dage ${this._busy ? "travl" : ""}">${this.days.map((day, i) => this._dagHTML(day, i)).join("")}</ol>
      ${this._balanceHTML()}
      <details class="hvordan">
        <summary>Sådan finder den forslagene</summary>
        <p>Forslagene bygger på ${d.grundlag.aftener} aftener fra jeres madplan. Retter I spiser tit, vægter mest – men kun når det er ved at være tid igen: hver ret har sin egen rytme (pita ca. hver 10. aften, lasagne sjældnere), og en ret I lige har haft, venter.</p>
        <p>Vaner på ugedage tæller med (burger om fredagen), og på travle aftener – nattevagt, fodbold, én voksen – vælges nemme retter, eller rester fra en dobbelt portion dagen før. Der er variation i kød og tilbehør, og der er lidt tilfældighed, så ugerne ikke bliver ens.</p>
        <p>Nye retter kommer fra jeres opskrifter i ReciMe – kun aftensmad, der ligner noget, I allerede kan lide, og som er børnevenlig (ikke for stærk, ikke for meget grønt). Vælges en, kommer opskriftens varer med i "Varer til ugen".</p>
        <p>"Andet bud" giver op til 30 forskellige bud pr. dag – de bedste oftest først, en ReciMe-ret ca. hvert 4. bud, og ikke de samme forrest hver dag. Tryk på en ret for at se alle bud eller søge i jeres retter og ReciMe, og vælg "Foreslå ikke igen" for retter, I er færdige med.</p>
        <p>Portion: tryk på retten og vælg Normal eller Dobbelt. Dobbelt kan være uden en bestemt dag (fryser/frokost) eller med rester på en af de næste dage.</p>
        <p>Kød fra fryseren: kan en ret laves med flere slags kød (fx burger), vælger I under retten, hvilket det bliver – så siger påmindelsen om at tage kød op det rigtige.</p>
        <p>Køleskabet: retter, der bruger det, I har tilbage, foreslås først og lægges på de første dage, så intet bliver dårligt. Retten skal have en indkøbsliste (Noter → Retter) eller være en af planlæggerens kendte retter. Ændrer I køleskabet, får de dage, I ikke selv har valgt, et nyt bud. Køleskabet gælder én madplan ad gangen: når planlæggeren åbnes til en ny uge, tages resterne fra forrige planlægning ud (Fortryd i beskeden), så I skriver det, I har tilbage nu.</p>
      </details>`;
    this._kladdeSenere();
    r.getElementById("bund").innerHTML = `
      <button class="sek" data-a="bland" ${this._busy ? "disabled" : ""}>${ICON_SHUFFLE}<span>Bland</span></button>
      <button class="prim" data-a="gem" ${this._busy ? "disabled" : ""}>Gem i madplanen</button>`;
  }

  /* Hvilken dag i forslaget bruger hver rest ("fre.: kylling i karry") */
  _kolBrug() {
    const out = {};
    for (const d of this.days) {
      const v = d.valg;
      if (!v || v.rest_af || d.tags.includes("ude")) continue;
      for (const n of v.koleskab || []) {
        if (!out[n]) out[n] = `${KORT[ugedagIdx(d.dato)]}.: ${lowerFirst(v.navn)}`;
      }
    }
    return out;
  }

  _introHTML() {
    const d = this.data;
    const top = d.grundlag.top.slice(0, 3).map((t) => `${esc(lowerFirst(t.navn))} (${t.antal})`).join(", ");
    const kal = this.state?.indstillinger?.kalendere?.find((k) => k.entity_id === d.kalender);
    const kl = this._kladde
      ? `<p class="kladde"><span>Fortsætter kladden fra ${esc(kladdeTid(this._kladde.tid))}${this._kladde.af ? ` (${esc(this._kladde.af)})` : ""}</span><button data-a="forfra" ${this._busy ? "disabled" : ""}>Start forfra</button></p>`
      : "";
    return `
      ${kl}
      <div class="intro">
        <p class="grund">Ud fra ${d.grundlag.aftener} aftener i jeres madplan. Mest populært: ${top}.</p>
        <div class="valg">
          <div class="stepper" role="group" aria-label="Antal dage">
            <button data-a="dage-" aria-label="Færre dage" ${d.dage <= 3 ? "disabled" : ""}>−</button>
            <span>${d.dage} dage</span>
            <button data-a="dage+" aria-label="Flere dage" ${d.dage >= 14 ? "disabled" : ""}>+</button>
          </div>
          <div class="seg" role="group" aria-label="Nye retter">
            ${[0, 1, 2].map((n) => `<button data-a="nye" data-n="${n}" aria-pressed="${this.opts.nye === n}">${n === 0 ? "Kun kendte" : n === 1 ? "+1 ny" : "+2 nye"}</button>`).join("")}
          </div>
        </div>
        <div class="valg2">
          <label class="tgl"><input type="checkbox" data-a="rester" ${this.opts.rester ? "checked" : ""}/> Rester på travle dage</label>
          <span class="kal">${kal ? `📅 ${esc(kal.navn)}` : `📅 Ingen kalender`}</span>
        </div>
      </div>`;
  }

  _dagHTML(day, i) {
    const v = day.valg;
    const ude = day.tags.includes("ude");
    const tags = this.data.tags;
    const aktive = TAG_ORDEN.filter((t) => day.tags.includes(t) && t !== "ude");
    const erStor = this._erDobbelt(i);
    const badges = [];
    if (v?.nyt) badges.push(`<span class="badge nyt">${v.opskrift ? "Ny fra ReciMe" : "Nyt"}</span>`);
    else if (v?.opskrift && !v.rest_af) badges.push(`<span class="badge op">ReciMe</span>`);
    if (v?.rest_af) badges.push(`<span class="badge rest">Rester</span>`);
    if (v?.koleskab?.length && !ude) badges.push(`<span class="badge kol">🧊 Køleskab</span>`);
    if (erStor) badges.push(`<span class="badge stor">Lav dobbelt portion</span>`);
    if (day.eksisterende && !day.aendret) badges.push(`<span class="badge ek">Står i madplanen</span>`);
    const grunde = this._grunde(i).join(" · ");
    const ikon = v && !v.rest_af && v.protein ? `<span class="pi" title="${esc(PROTEIN_NAVN[v.protein] || "")}">${PROTEIN[v.protein] || ""}</span>` : "";
    return `
      <li class="dag ${day.laast ? "laast" : ""} ${ude ? "ude" : ""} ${v?.rest_af ? "rester" : ""}" data-i="${i}">
        <div class="dh">
          <span class="dn">${esc(day.ugedag)} <small>${kortDato(day.dato)}</small></span>
          <span class="chips">${aktive.map((t) => `<span class="chip ${tags[t]?.travl ? "varm" : ""}">${esc(tags[t]?.label || t)}</span>`).join("")}</span>
          <button class="ib tagb" data-a="tags" aria-expanded="${day.visTags}" aria-label="Hvordan ser ${esc(day.ugedag.toLowerCase())}en ud?">${day.visTags ? "Færdig" : aktive.length ? "Ændr" : "Travlt?"}</button>
          <button class="ib las" data-a="las" aria-pressed="${day.laast}" aria-label="${day.laast ? "Lås op" : "Lås retten"}">${day.laast ? ICON_LOCK : ICON_UNLOCK}</button>
        </div>
        ${day.visTags ? `<div class="tagvalg">${TAG_ORDEN.map((t) => `<button class="tv ${tags[t]?.travl ? "varm" : ""}" data-a="tag" data-t="${t}" aria-pressed="${day.tags.includes(t)}">${esc(tags[t]?.label || t)}</button>`).join("")}</div>` : ""}
        ${ude
          ? `<button class="ret" data-a="vaelg"><span class="rn tom">Ingen madlavning</span><span class="rg">${esc(day.udeTekst || "Ude, besøg eller andet – tryk for at vælge en ret alligevel")}</span></button>`
          : v
            ? `<button class="ret" data-a="vaelg">
                 <span class="rn">${ikon}${esc(v.rest_af ? `${v.rest_af} – rester` : v.navn)}</span>
                 ${badges.length ? `<span class="badges">${badges.join("")}</span>` : ""}
                 ${grunde ? `<span class="rg">${esc(grunde)}</span>` : ""}
                 ${v.varianter?.length ? `<span class="rv">Fx ${v.varianter.slice(0, 2).map((x) => esc(lowerFirst(x))).join(" eller ")}</span>` : ""}
               </button>`
            : `<button class="ret" data-a="vaelg"><span class="rn tom">Vælg en ret</span></button>`}
        ${this._koedHTML(i)}
        ${!ude && day.alts.length ? `<button class="naeste" data-a="naeste">${ICON_NEXT}<span>Andet bud</span></button>` : ""}
        ${day.kalender.length ? `<div class="kal-l">${day.kalender.map((k) => `<span>📅 ${esc(k)}</span>`).join("")}</div>` : ""}
      </li>`;
  }

  _koedHTML(i) {
    const alts = this._koedValg(i);
    const day = this.days[i];
    if (!alts || (day.eksisterende && !day.aendret && !day.koed)) return "";
    const mangler = !day.koed;
    return `
      <div class="koed ${mangler ? "mangler" : ""}" role="group" aria-label="Kød fra fryseren">
        <span class="kl">❄ ${mangler ? "Hvilket kød?" : "Fra fryseren"}</span>
        <span class="kchips">${alts.map((a) => `<button class="kc" data-a="koed" data-v="${esc(a)}" aria-pressed="${day.koed === a}">${esc(koedNavn(a))}</button>`).join("")}</span>
      </div>`;
  }

  _balanceHTML() {
    const kogt = this.days.filter((d) => d.valg && !d.valg.rest_af && !d.tags.includes("ude"));
    if (!kogt.length) return "";
    const p = {};
    const b = {};
    for (const d of kogt) {
      if (d.valg.protein) p[d.valg.protein] = (p[d.valg.protein] || 0) + 1;
      if (d.valg.base && BASE_NAVN[d.valg.base]) b[d.valg.base] = (b[d.valg.base] || 0) + 1;
    }
    const rester = this.days.filter((d) => d.valg?.rest_af && !d.tags.includes("ude")).length;
    const nemme = kogt.filter((d) => d.valg.effort === 1).length;
    const chips = Object.entries(p).sort((a, c) => c[1] - a[1])
      .map(([k, n]) => `<span>${PROTEIN[k] || ""} ${n} ${esc(PROTEIN_NAVN[k] || k)}</span>`);
    const bchips = Object.entries(b).sort((a, c) => c[1] - a[1]).map(([k, n]) => `<span>${n} ${esc(BASE_NAVN[k])}</span>`);
    return `
      <div class="balance" aria-label="Ugens balance">
        <div class="brow">${chips.join("")}</div>
        <div class="brow dim">${bchips.join("")}${rester ? `<span>${rester} med rester</span>` : ""}${nemme ? `<span>${nemme} nemme</span>` : ""}</div>
      </div>`;
  }

  /* ------------------------------------------------------------ bund-ark med forslag */
  _aabnSheet(i) {
    clearTimeout(this._skjulTimer); // et netop lukket ark må ikke skjule det nye
    this._sheet = i;
    this._sog = "";
    this._renderSheet();
    const r = this.shadowRoot;
    r.getElementById("sheet").hidden = false;
    r.getElementById("sheet-bg").hidden = false;
    requestAnimationFrame(() => r.getElementById("sheet").classList.add("inde"));
  }

  _lukSheet() {
    const r = this.shadowRoot;
    const s = r.getElementById("sheet");
    s.classList.remove("inde");
    r.getElementById("sheet-bg").hidden = true;
    this._skjulTimer = setTimeout(() => (s.hidden = true), 200);
    this._sheet = null;
  }

  _renderSheet() {
    const i = this._sheet;
    const day = this.days[i];
    if (!day) return;
    const s = this.shadowRoot.getElementById("sheet");
    const v = day.valg;
    const brugt = new Set(this.days.filter((d, j) => j !== i && d.valg).map((d) => d.valg.navn.toLowerCase()));
    s.innerHTML = `
      <div class="greb" aria-hidden="true"></div>
      <div class="sh-top">
        <h3>${esc(day.ugedag)} ${kortDato(day.dato)}</h3>
        <button class="tl" data-a="luk-sheet">Færdig</button>
      </div>
      <input id="sog" type="search" placeholder="Søg i jeres retter og ReciMe – eller skriv en ny …" autocomplete="off" enterkeyhint="done" aria-label="Søg eller skriv en ret" />
      <div class="alts" id="alts">${this._altsHTML(day, brugt)}</div>
      ${this._portionHTML(i)}
      <div class="ekstra">
        <button data-a="ude">${day.tags.includes("ude") ? "Lav mad alligevel" : "Ingen madlavning (ude, besøg …)"}</button>
        ${v && !v.rest_af && !day.tags.includes("ude") ? `<button class="fare" data-a="skjul">Foreslå ikke "${esc(lowerFirst(v.navn))}" igen</button>` : ""}
      </div>`;
  }

  _portionHTML(i) {
    if (!this._lavesMad(i)) return "";
    const day = this.days[i];
    const dobbelt = this._erDobbelt(i);
    const rd = new Set(this._restDage(i));
    const tags = this.data.tags;
    const senere = [];
    for (let j = i + 1; j < this.days.length && j <= i + 3; j++) {
      const d = this.days[j];
      if (d.tags.includes("ude")) continue;
      const travl = TAG_ORDEN.find((t) => d.tags.includes(t) && tags[t]?.travl);
      senere.push(`<button class="pc" data-a="rest-dag" data-j="${j}" aria-pressed="${rd.has(j)}">${esc(KORT[ugedagIdx(d.dato)])} ${kortDato(d.dato)}${travl ? ` <small>${esc(tags[travl].label)}</small>` : ""}</button>`);
    }
    return `
      <div class="portion" role="group" aria-label="Portion">
        <div class="p-top">
          <span class="pl">Portion</span>
          <div class="seg">
            <button data-a="portion" data-p="normal" aria-pressed="${!dobbelt}">Normal</button>
            <button data-a="portion" data-p="dobbelt" aria-pressed="${dobbelt}">Dobbelt</button>
          </div>
        </div>
        ${dobbelt ? `
          <div class="p-rest">
            <span class="pl">Rester</span>
            <div class="pchips">
              <button class="pc" data-a="rest-dag" data-j="-1" aria-pressed="${rd.size === 0}">Ingen dag</button>
              ${senere.join("")}
            </div>
          </div>
          <p class="phint">${rd.size ? `Rester af ${esc(lowerFirst(day.valg.navn))} står på ${[...rd].map((j) => esc(this.days[j].ugedag.toLowerCase())).join(" og ")}.` : "Fryser eller frokost – ingen dag får rester."}</p>` : ""}
      </div>`;
  }

  _altsHTML(day, brugt) {
    const q = (this._sog || "").trim().toLowerCase();
    if (q) {
      const navne = (this.data.retter || []).filter((n) => n.toLowerCase().includes(q)).slice(0, 8);
      const rows = navne.map((n) => `<button class="alt" data-a="valg-navn" data-navn="${esc(n)}"><span class="an">${esc(n)}</span>${brugt.has(n.toLowerCase()) ? `<span class="ag">Er allerede med i ugen</span>` : ""}</button>`);
      // 0.14.0: også jeres ReciMe-opskrifter
      const egne = new Set(navne.map((n) => n.toLowerCase()));
      const ops = (this.data.opskrifter || []).filter((o) => o.navn.toLowerCase().includes(q) && !egne.has(o.navn.toLowerCase())).slice(0, 8);
      for (const o of ops) {
        rows.push(`<button class="alt" data-a="valg-navn" data-navn="${esc(o.navn)}" data-op="${esc(o.id)}"><span class="an">${o.protein ? `${PROTEIN[o.protein] || ""} ` : ""}${esc(o.navn)}<span class="badge op">ReciMe</span></span>${brugt.has(o.navn.toLowerCase()) ? `<span class="ag">Er allerede med i ugen</span>` : ""}</button>`);
      }
      if (!navne.some((n) => n.toLowerCase() === q) && !ops.some((o) => o.navn.toLowerCase() === q)) {
        rows.push(`<button class="alt fri" data-a="valg-fri"><span class="an">Brug "${esc(this._sog.trim())}"</span><span class="ag">Skriv retten ind som den er</span></button>`);
      }
      return rows.join("");
    }
    const cur = day.valg;
    const list = [];
    if (cur && !day.tags.includes("ude")) list.push({ ...cur, _cur: true });
    for (const a of day.alts) if (!cur || a.navn !== cur.navn) list.push(a);
    if (!list.length) return `<p class="tom">Ingen bud – skriv selv en ret ovenfor.</p>`;
    return list.map((a, k) => `
      <button class="alt ${a._cur ? "cur" : ""}" data-a="valg-alt" data-k="${a._cur ? -1 : day.alts.indexOf(a)}">
        <span class="an">${a.protein && !a.rest_af ? `${PROTEIN[a.protein] || ""} ` : ""}${esc(a.rest_af ? `${a.rest_af} – rester` : a.navn)}
          ${a.nyt ? `<span class="badge nyt">${a.opskrift ? "Ny fra ReciMe" : "Nyt"}</span>` : a.opskrift && !a.rest_af ? `<span class="badge op">ReciMe</span>` : ""}${a.rest_af ? `<span class="badge rest">Rester</span>` : ""}${a._cur ? `<span class="flueben" aria-label="valgt">✓</span>` : ""}</span>
        ${a.grunde?.length ? `<span class="ag">${esc(a.grunde.join(" · "))}</span>` : ""}
      </button>`).join("");
  }

  async _vaelg(i, valg) {
    const day = this.days[i];
    const rd = this._restDage(i);
    if (!valg || valg.navn !== day.valg?.navn) day.koed = null;
    day.valg = valg;
    day.laast = true;
    day.aendret = true;
    day.tags = day.tags.filter((t) => t !== "ude");
    day.restFra = null;
    if (valg?.rest_af) {
      // Rester valgt fra listen: husk hvilken dag de kommer fra
      for (let k = i - 1; k >= 0 && k >= i - 4; k--) {
        if (this._lavesMad(k) && this.days[k].valg.navn.toLowerCase() === valg.rest_af.toLowerCase()) {
          day.restFra = this.days[k].dato;
          break;
        }
      }
    }
    // Er retten skiftet, følger resterne med (eller får nyt bud, hvis der ikke laves mad)
    await this._kildeSkift(i, rd);
    this._render();
  }

  _brugSoegning() {
    const t = (this._sog || "").trim();
    if (!t || this._sheet === null) return;
    const kendt = (this.data.retter || []).find((n) => n.toLowerCase() === t.toLowerCase());
    const k = this._sheet;
    const o = !kendt && (this.data.opskrifter || []).find((x) => x.navn.toLowerCase() === t.toLowerCase());
    if (o) {
      this._lukSheet();
      return this._vaelg(k, this._opskriftValg(o));
    }
    this._lukSheet();
    return this._vaelg(k, { navn: kendt || t, tekst: lowerFirst(kendt || t), grunde: kendt ? ["Valgt af jer"] : ["Skrevet ind af jer"], varer: [] });
  }

  /* 0.14.0: en ReciMe-opskrift valgt i søgningen – skrives i madplanen med opskriftens navn */
  _opskriftValg(o) {
    return { navn: o.navn, tekst: lowerFirst(o.navn), grunde: ["Fra ReciMe · valgt af jer"], varer: [],
      opskrift: o.id, protein: o.protein, base: o.base, effort: o.effort };
  }

  /* ------------------------------------------------------------ gem */
  _linje(day, i) {
    const ugedag = UGEDAGE[ugedagIdx(day.dato)];
    if (day.tags.includes("ude")) return `${ugedag}: ${day.udeTekst || "ude"}`;
    const v = day.valg;
    if (!v) return `${ugedag}: `;
    const noter = TAG_ORDEN.filter((t) => day.tags.includes(t)).map((t) => this.data.tags[t]?.note).filter(Boolean);
    const ret = v.rest_af ? `${lowerFirst(v.rest_af)} rest` : v.tekst || lowerFirst(v.navn);
    let s = [...noter, ret].join(" - ");
    if (day.koed && this._koedValg(i)?.includes(day.koed)) s += ` (❄ ${day.koed})`;
    if (this._erDobbelt(i)) s += " (stor portion)";
    return `${ugedag}: ${s}`;
  }

  async _gem() {
    if (this._busy) return;
    const mangler = this._manglerKoed();
    if (mangler.length && !this._koedSpurgt) {
      // Spørg én gang: hvilket kød skal op? (Gem igen gemmer uden)
      this._koedSpurgt = true;
      const navne = mangler.map((i) => `${lowerFirst(this.days[i].valg.navn)} (${this.days[i].ugedag.toLowerCase()})`);
      this._koedBesked = `Hvilket kød skal op af fryseren til ${navne.join(" og ")}? Vælg under retten – eller tryk Gem igen for at gemme uden.`;
      this._renderBody();
      this.shadowRoot.querySelector(`.dag[data-i="${mangler[0]}"] .koed`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const linjer = this.days
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => !(d.eksisterende && !d.aendret))
      .map(({ d, i }) => ({ dato: d.dato, linje: this._linje(d, i) }));
    if (!linjer.length) {
      // Intet nyt at skrive (alt står allerede i madplanen) – kladden er overflødig
      this._gemt = true;
      clearTimeout(this._kladdeTimer);
      this.store.send("madplan/kladde/slet", {}).catch(() => {});
      return this._luk();
    }
    this._busy = true;
    this._renderBody();
    try {
      // 0.13.0: versionen, ugen blev planlagt ud fra. Har nogen ændret de samme dage imens, gemmes
      // intet – andet tryk på Gem overskriver dagene (bevidst valg); kladden bevares hele tiden.
      const nu = this.store.state?.madplan?.version ?? null;
      const base = this._overskriv ? nu : (this._mpVersion ?? nu);
      try {
        await this.store.send("madplan/indsaet", { linjer, base_version: base });
      } catch (e) {
        if (e?.code !== "conflict") throw e;
        this._busy = false;
        this._overskriv = true;
        const hvem = this.store.state?.madplan?.updated_by;
        this._fejl = `${hvem || "Nogen"} har ændret de samme dage i madplanen imens. Ugen er gemt som kladde – tryk Gem igen for at overskrive dagene, eller luk og se madplanen først.`;
        this._renderBody();
        return;
      }
      this._busy = false;
      // Ugen står nu i madplanen – kladden er brugt
      this._gemt = true;
      clearTimeout(this._kladdeTimer);
      this.store.send("madplan/kladde/slet", {}).catch(() => {});
      // Videre til "Varer til ugen" (panelet åbner arket for de gemte dage)
      this.dispatchEvent(new CustomEvent("toast", { detail: `Uge ${this.data.uge} er gemt i madplanen` }));
      this.dispatchEvent(new CustomEvent("gemt", { detail: { start: this.data.start, dage: this.data.dage } }));
      this._luk();
    } catch (e) {
      this._busy = false;
      this._fejl = "Kunne ikke gemme: " + (e?.message || "ukendt fejl");
      this._renderBody();
    }
  }

  /* ------------------------------------------------------------ input */
  _input(e) {
    const t = e.target;
    if (t.id === "sog") {
      this._sog = t.value;
      const day = this.days[this._sheet];
      const brugt = new Set(this.days.filter((d, j) => j !== this._sheet && d.valg).map((d) => d.valg.navn.toLowerCase()));
      this.shadowRoot.getElementById("alts").innerHTML = this._altsHTML(day, brugt);
    }
  }

  async _click(e) {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const a = b.dataset.a;
    const li = b.closest(".dag");
    const i = li ? Number(li.dataset.i) : null;
    // Klik på baggrunden (PC) mens forslagsarket er åbent: luk kun arket
    if (a === "luk") return this._sheet !== null && b.classList.contains("bg") ? this._lukSheet() : this._luk();
    if (a === "luk-sheet") return this._lukSheet();
    if (a === "igen") return this._hent({});
    if (this._busy) return;
    switch (a) {
      case "forfra":
        return this._startForfra();
      case "bland":
        return this._bland();
      case "gem":
        return this._gem();
      case "dage-":
      case "dage+": {
        const n = Math.max(3, Math.min(14, this.data.dage + (a === "dage+" ? 1 : -1)));
        this.days = this.days.slice(0, n);
        return this._hent({ dage: n, tags: this._tagsMap(), laaste: this._laaste() });
      }
      case "nye":
        this.opts.nye = Number(b.dataset.n);
        lsSet("plan_nye2", this.opts.nye);
        return this._bland();
      case "rester":
        this.opts.rester = b.checked;
        lsSet("plan_rester", this.opts.rester);
        return this._bland();
      case "tags":
        this.days[i].visTags = !this.days[i].visTags;
        return this._renderBody();
      case "tag": {
        const day = this.days[i];
        const t = b.dataset.t;
        const rd = this._restDage(i);
        day.tags = day.tags.includes(t) ? day.tags.filter((x) => x !== t) : [...day.tags, t];
        if (t === "ude" && day.tags.includes("ude")) {
          day.udeTekst = day.udeTekst || day.kalender[0] || "";
          day.aendret = true;
          await this._kildeSkift(i, rd);
          return this._renderBody();
        }
        day.aendret = true;
        if (day.laast) return this._renderBody(); // låst ret: mærket gemmes kun i noten
        day.visTags = true;
        await this._replanDag(i);
        this.days[i].visTags = true;
        this.days[i].aendret = true;
        return this._renderBody();
      }
      case "las": {
        const day = this.days[i];
        day.laast = !day.laast;
        if (day.eksisterende && !day.laast) day.aendret = true;
        return this._renderBody();
      }
      case "naeste": {
        const day = this.days[i];
        if (!day.alts.length) return;
        const used = new Set(this.days.filter((d, j) => j !== i && d.valg).map((d) => d.valg.navn.toLowerCase()));
        let k = day.idx % day.alts.length;
        for (let n = 0; n < day.alts.length && used.has(day.alts[k].navn.toLowerCase()); n++) k = (k + 1) % day.alts.length;
        const prev = day.valg;
        const ny = day.alts[k];
        day.alts = day.alts.filter((_, j) => j !== k);
        if (prev && !prev.grunde?.includes("Står allerede i madplanen")) day.alts.push(prev);
        day.idx = k;
        this._busy = true;
        try {
          await this._vaelg(i, ny);
        } finally {
          this._busy = false;
        }
        return this._renderBody();
      }
      case "vaelg":
        return this._aabnSheet(i);
      case "koed": {
        const day = this.days[i];
        const v = b.dataset.v;
        day.koed = day.koed === v ? null : v;
        day.aendret = true;
        if (!this._manglerKoed().length) this._koedBesked = null;
        return this._renderBody();
      }
      case "valg-alt": {
        const day = this.days[this._sheet];
        const k = Number(b.dataset.k);
        if (k >= 0) {
          const prev = day.valg;
          const valgt = day.alts[k];
          day.alts = day.alts.filter((_, j) => j !== k);
          if (prev && !day.tags.includes("ude")) day.alts.unshift(prev);
          const k2 = this._sheet;
          this._lukSheet();
          return this._vaelg(k2, valgt);
        } else {
          day.laast = true;
          day.tags = day.tags.filter((t) => t !== "ude");
          this._render();
        }
        return this._lukSheet();
      }
      case "valg-navn": {
        const navn = b.dataset.navn;
        const k2 = this._sheet;
        const alt = this.days[k2].alts.find((x) => x.navn === navn);
        const o = !alt && b.dataset.op ? (this.data.opskrifter || []).find((x) => x.id === b.dataset.op) : null;
        this._lukSheet();
        return this._vaelg(k2, alt || (o ? this._opskriftValg(o) : { navn, tekst: lowerFirst(navn), grunde: ["Valgt af jer"], varer: [] }));
      }
      case "valg-fri":
        return this._brugSoegning();
      case "portion":
      case "rest-dag": {
        const k = this._sheet;
        const day = this.days[k];
        if (!this._lavesMad(k)) return;
        const rd = this._restDage(k);
        day.laast = true;
        day.aendret = true;
        this._busy = true;
        try {
          if (a === "portion" && b.dataset.p === "normal") {
            day.dobbelt = false;
            for (const j of rd) await this._fjernRest(j);
          } else if (a === "portion") {
            day.dobbelt = true;
          } else {
            const j = Number(b.dataset.j);
            day.dobbelt = true;
            if (j < 0) {
              for (const x of rd) await this._fjernRest(x);
            } else if (rd.includes(j)) {
              await this._fjernRest(j);
            } else {
              const hans = this._lavesMad(j) ? this._restDage(j) : [];
              this._saetRest(k, j);
              for (const x of hans) await this._fjernRest(x); // dag j laver ikke mad længere
            }
          }
        } finally {
          this._busy = false;
        }
        this._renderBody();
        if (this._sheet === k) this._renderSheet();
        return;
      }
      case "ude": {
        const k = this._sheet;
        const day = this.days[k];
        if (day.tags.includes("ude")) {
          day.tags = day.tags.filter((t) => t !== "ude");
          day.aendret = true;
          this._lukSheet();
          if (!day.valg) await this._replanDag(k);
          return this._renderBody();
        }
        const rd = this._restDage(k);
        day.tags = [...day.tags, "ude"];
        day.udeTekst = day.udeTekst || day.kalender[0] || "";
        day.aendret = true;
        this._lukSheet();
        await this._kildeSkift(k, rd);
        return this._renderBody();
      }
      case "skjul": {
        const k = this._sheet;
        const navn = this.days[k].valg?.navn;
        if (!navn) return;
        this._lukSheet();
        await this.store.send("madplan/skjul", { navn, skjul: true });
        this.days[k].laast = false;
        await this._replanDag(k);
        this.dispatchEvent(new CustomEvent("toast", { detail: `"${navn}" foreslås ikke igen (kan fortrydes under Indstillinger)`, bubbles: true, composed: true }));
        return;
      }
    }
  }
}

const CSS = `
  :host { position: fixed; inset: 0; z-index: 50; display: block; font-family: inherit; color: var(--im-text);
          -webkit-tap-highlight-color: transparent; }
  [hidden] { display: none !important; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--im-acc); outline-offset: 2px; }
  .bg { position: absolute; inset: 0; background: rgba(0,0,0,.35); }
  .kladde { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 10px;
            padding: 8px 12px; border-radius: 12px; background: var(--im-bg); font-size: 13.5px; color: var(--im-dim); }
  .kladde button { color: var(--im-acc); font-size: 14px; min-height: 32px; white-space: nowrap; }
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
         font-weight: 600; font-size: 16px; display: inline-flex; align-items: center; gap: 6px; }
  .knap { padding: 10px 18px; border-radius: 12px; background: var(--im-acc); color: #fff; font-weight: 600; }
  .link { color: var(--im-acc); font-weight: 600; }

  .intro { margin: 2px 2px 12px; }
  .grund { margin: 0 0 10px; font-size: 14px; color: var(--im-dim); line-height: 1.4; }
  .valg { display: flex; flex-wrap: nowrap; gap: 8px; align-items: center; }
  .valg2 { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
  .stepper { display: inline-flex; align-items: center; background: var(--im-bg); border-radius: 10px; }
  .stepper button { width: 40px; height: 36px; font-size: 20px; color: var(--im-acc); }
  .stepper button { width: 36px; }
  .stepper span { font-size: 14px; font-weight: 600; min-width: 52px; text-align: center; font-variant-numeric: tabular-nums; }
  .seg { display: inline-flex; background: var(--im-bg); border-radius: 10px; padding: 2px; }
  .seg button { padding: 7px 9px; border-radius: 8px; font-size: 13.5px; color: var(--im-dim); min-height: 32px; white-space: nowrap; }
  .seg button[aria-pressed="true"] { background: var(--im-acc); color: #fff; font-weight: 600; }
  .tgl { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--im-dim); min-height: 36px; }
  .tgl input { width: 20px; height: 20px; accent-color: var(--im-acc); margin: 0; }
  .kal { font-size: 12.5px; color: var(--im-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .laeser { color: var(--im-dim); font-size: 14px; margin: 6px 2px 12px; }

  .dage { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; transition: opacity .15s; }
  .dage.travl { opacity: .55; pointer-events: none; }
  .dag { background: var(--im-bg); border-radius: 16px; padding: 10px 12px 10px 14px; position: relative;
         box-shadow: 0 1px 0 rgba(0,0,0,.03); border: 1.5px solid transparent; }
  .dag.laast { border-color: color-mix(in srgb, var(--im-acc) 55%, transparent); }
  .dag.ude { background: color-mix(in srgb, var(--im-bg) 60%, transparent); }
  .dh { display: flex; align-items: center; gap: 6px; min-height: 32px; }
  .dn { font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--im-dim); white-space: nowrap; }
  .dn small { font-weight: 500; letter-spacing: 0; text-transform: none; margin-left: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; min-width: 0; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--im-bg2); color: var(--im-dim); white-space: nowrap; }
  .chip.varm { background: color-mix(in srgb, var(--im-acc-strong) 22%, transparent); color: var(--im-text); }
  .ib { min-height: 36px; min-width: 36px; display: inline-flex; align-items: center; justify-content: center; color: var(--im-dim); border-radius: 10px; }
  .tagb { font-size: 13px; color: var(--im-acc); font-weight: 600; padding: 0 8px; margin-left: auto; }
  .chips + .tagb { margin-left: 0; }
  .las[aria-pressed="true"] { color: var(--im-acc); }
  .tagvalg { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0 8px; }
  .tv { padding: 8px 12px; border-radius: 999px; font-size: 14px; background: var(--im-bg2); color: var(--im-text); min-height: 36px; }
  .tv[aria-pressed="true"] { background: var(--im-acc); color: #fff; font-weight: 600; }
  .ret { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; width: 100%; text-align: left; padding: 4px 0 6px; }
  .rn { font-size: 21px; font-weight: 750; letter-spacing: -.015em; line-height: 1.2; text-wrap: balance; }
  .rn.tom { font-weight: 500; color: var(--im-dim); font-size: 18px; }
  .pi { margin-right: 6px; font-size: 18px; }
  .rg { font-size: 13.5px; color: var(--im-dim); line-height: 1.35; }
  .rv { font-size: 12.5px; color: var(--im-dim); font-style: italic; }
  .badges { display: flex; flex-wrap: wrap; gap: 4px; }
  .badge { font-size: 11.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: .03em; }
  .badge.nyt { background: var(--im-acc); color: #fff; }
  .badge.rest { background: color-mix(in srgb, var(--im-frost) 18%, transparent); color: var(--im-frost); }
  .badge.stor { background: color-mix(in srgb, var(--im-acc-strong) 22%, transparent); color: var(--im-text); }
  .badge.ek { background: var(--im-bg2); color: var(--im-dim); }
  .badge.kol { background: var(--im-frost-bg, rgba(109,182,230,.14)); color: var(--im-frost); }
  .badge.op { background: color-mix(in srgb, var(--im-acc) 16%, transparent); color: var(--im-acc); margin-left: 6px; vertical-align: 1px; }
  .badges .badge.op { margin-left: 0; }
  #kol { margin: 0 0 12px; }
  .koedbesked { margin: 4px 2px 12px; padding: 10px 12px; border-radius: 12px; font-size: 14.5px; line-height: 1.4;
                background: var(--im-frost-bg, rgba(109,182,230,.14)); color: var(--im-text); }
  .koed { display: flex; align-items: flex-start; gap: 8px; padding: 2px 0 6px; }
  .kl { flex: none; font-size: 12.5px; font-weight: 700; color: var(--im-frost); padding-top: 8px; white-space: nowrap; }
  .koed.mangler .kl { color: var(--im-acc-strong, var(--im-acc)); }
  .kchips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .kc { padding: 6px 11px; border-radius: 999px; font-size: 14px; background: var(--im-bg2); color: var(--im-text); min-height: 36px; }
  .koed.mangler .kc { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--im-acc-strong, var(--im-acc)) 55%, transparent); }
  .kc[aria-pressed="true"] { background: var(--im-frost); color: #fff; font-weight: 600; box-shadow: none; }
  .naeste { display: inline-flex; align-items: center; gap: 6px; color: var(--im-acc); font-weight: 600; font-size: 14px; min-height: 36px; padding-right: 8px; }
  .kal-l { display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; color: var(--im-dim); padding-top: 2px; }
  .dag.skel { height: 92px; background: linear-gradient(90deg, var(--im-bg) 30%, var(--im-bg2) 50%, var(--im-bg) 70%); background-size: 300% 100%;
              animation: sk 1.2s infinite linear; margin-bottom: 10px; }
  @keyframes sk { from { background-position: 100% 0; } to { background-position: 0 0; } }

  .balance { margin: 14px 2px 4px; display: flex; flex-direction: column; gap: 6px; }
  .brow { display: flex; flex-wrap: wrap; gap: 6px; font-size: 13.5px; }
  .brow span { padding: 4px 10px; border-radius: 999px; background: var(--im-bg); }
  .brow.dim span { color: var(--im-dim); background: transparent; border: 1px solid var(--im-line); }
  .hvordan { margin: 16px 2px 0; font-size: 14px; line-height: 1.45; color: var(--im-dim); }
  .hvordan summary { color: var(--im-acc); font-weight: 600; cursor: pointer; list-style: none; min-height: 32px; display: flex; align-items: center; }
  .hvordan summary::-webkit-details-marker { display: none; }
  .hvordan p { margin: 6px 0 0; }
  .fejl { color: var(--error-color, #d93025); font-size: 14px; }
  .fejlboks { padding: 40px 12px; text-align: center; }

  .sheet-bg { position: absolute; inset: 0; background: rgba(0,0,0,.3); z-index: 5; }
  .sheet { position: absolute; left: 0; right: 0; bottom: 0; height: 80%; display: flex; flex-direction: column; z-index: 6;
           background: var(--im-bg); border-radius: 18px 18px 0 0; box-shadow: 0 -10px 40px rgba(0,0,0,.25);
           padding: 6px 14px calc(12px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
           transform: translateY(100%); transition: transform .22s cubic-bezier(.2,.8,.2,1); }
  .sheet.inde { transform: none; }
  .greb { width: 38px; height: 5px; border-radius: 3px; background: var(--im-line); margin: 4px auto 6px; flex: none; }
  .sh-top { display: flex; align-items: center; justify-content: space-between; flex: none; }
  .sh-top h3 { margin: 0; font-size: 17px; }
  .sh-top .tl { text-align: right; font-weight: 600; }
  #sog { flex: none; width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; padding: 10px 12px; margin: 6px 0 4px;
         border-radius: 10px; border: 0; background: var(--im-bg2); color: var(--im-text); -webkit-appearance: none; }
  .alts { overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; flex: 1; min-height: 120px; }
  .alt { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left; padding: 11px 2px;
         border-bottom: 1px solid var(--im-line); min-height: 48px; }
  .alt:active { background: var(--im-bg2); }
  .alt.cur .an { color: var(--im-acc); }
  .an { font-size: 17px; font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .ag { font-size: 13px; color: var(--im-dim); }
  .alt.fri .an { color: var(--im-acc); }
  .flueben { color: var(--im-acc); font-weight: 800; }
  .tom { color: var(--im-dim); padding: 16px 2px; }
  .portion { flex: none; padding: 8px 0 2px; border-top: 1px solid var(--im-line); margin-top: 4px; }
  .p-top, .p-rest { display: flex; align-items: center; gap: 10px; }
  .p-rest { align-items: flex-start; margin-top: 8px; }
  .pl { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--im-dim); flex: none; width: 58px; padding-top: 8px; }
  .p-top .pl { padding-top: 0; }
  .p-top .seg { background: var(--im-bg2); }
  .p-top .seg button { padding: 7px 16px; font-size: 15px; }
  .pchips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; min-width: 0; }
  .pc { padding: 6px 10px; border-radius: 999px; font-size: 14px; background: var(--im-bg2); color: var(--im-text); min-height: 36px; }
  .pc small { font-size: 11.5px; color: var(--im-dim); }
  .pc[aria-pressed="true"] { background: var(--im-acc); color: #fff; font-weight: 600; }
  .pc[aria-pressed="true"] small { color: rgba(255,255,255,.85); }
  .phint { margin: 6px 0 0 68px; font-size: 13px; color: var(--im-dim); }
  .ekstra { flex: none; display: flex; flex-direction: column; gap: 0; padding-top: 6px; }
  .ekstra button { text-align: left; padding: 12px 2px; font-size: 16px; color: var(--im-acc); min-height: 44px; }
  .ekstra .fare { color: var(--error-color, #d93025); font-size: 15px; }

  @media (prefers-reduced-motion: reduce) { .ark, .sheet { transition: none; } .dag.skel { animation: none; } }
`;

if (!customElements.get("im-ugeplan")) customElements.define("im-ugeplan", UgePlan);
