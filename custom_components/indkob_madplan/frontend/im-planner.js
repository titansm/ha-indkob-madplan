/* Indkøb & Madplan – ugeplanlæggeren: forslag til næste uges madplan ud fra jeres egne uger.
 *
 * Telefon først: ét ark med en kort pr. dag. Tryk på retten for andre forslag, ↻ for næste bud,
 * mærk travle aftener (nattevagt, fodbold …), lås det I vil beholde, og bland resten om.
 * "Gem i madplanen" skriver ugen øverst i madplan-noten i jeres eget format.
 */
import { esc, lsGet, lsSet, UGEDAGE } from "./im-common.js?v=0.12.0";

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
    this.opts = { nye: lsGet("plan_nye", 1), rester: lsGet("plan_rester", true) };
    this._busy = false;
    this._sheet = null; // åben dag i bund-arket
    this.shadowRoot.addEventListener("click", (e) => this._click(e));
    this.shadowRoot.addEventListener("input", (e) => this._input(e));
    this.shadowRoot.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._sheet !== null ? this._lukSheet() : this._luk();
      if (e.key === "Enter" && e.target.id === "sog") this._brugSoegning();
    });
  }

  /* ------------------------------------------------------------ åbn/luk */
  async open(store, state) {
    this.store = store;
    this.state = state;
    this._sheet = null;
    this.data = null;
    this.days = [];
    this._fejl = null;
    this._render();
    requestAnimationFrame(() => this.shadowRoot.querySelector(".ark")?.classList.add("inde"));
    await this._hent({});
  }

  set hassState(s) {
    this.state = s;
  }

  _luk() {
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
      this.data = res;
    } catch (e) {
      this._fejl = e?.message || "Kunne ikke lave forslag.";
    }
    this._busy = false;
    this._render();
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

  _replanDag(i) {
    return this._hent({ tags: this._tagsMap(), laaste: this._laaste(i) }, { kunDag: i });
  }

  _bland() {
    return this._hent({ tags: this._tagsMap(), laaste: this._laaste() });
  }

  /* Dobbelt portion: en dag hvis ret spises som rester senere i ugen */
  _storDage() {
    const s = new Set();
    this.days.forEach((d) => {
      if (d.valg?.rest_af && !d.tags.includes("ude")) s.add(d.valg.rest_af.toLowerCase());
    });
    return s;
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
          <div class="krop" id="krop"></div>
          <footer class="bund" id="bund"></footer>
          <div class="sheet-bg" id="sheet-bg" hidden data-a="luk-sheet"></div>
          <div class="sheet" id="sheet" hidden role="dialog" aria-modal="true"></div>
        </section>`;
    }
    this._renderBody();
  }

  _renderBody() {
    const r = this.shadowRoot;
    const krop = r.getElementById("krop");
    if (!krop) return;
    const d = this.data;
    r.getElementById("pl-titel").textContent = d ? `Planlæg uge ${d.uge}` : "Planlæg ugen";
    r.getElementById("pl-periode").textContent = d ? periode(d.start, d.dage) : "";
    if (this._fejl && !d) {
      krop.innerHTML = `<div class="fejlboks"><p>${esc(this._fejl)}</p><button class="knap" data-a="igen">Prøv igen</button></div>`;
      r.getElementById("bund").innerHTML = "";
      return;
    }
    if (!d) {
      krop.innerHTML = `<p class="laeser">Læser jeres tidligere uger …</p>` +
        Array.from({ length: 7 }, () => `<div class="dag skel"><span></span><span></span></div>`).join("");
      r.getElementById("bund").innerHTML = "";
      return;
    }
    const stor = this._storDage();
    krop.innerHTML = `
      ${this._introHTML()}
      ${this._fejl ? `<p class="fejl">${esc(this._fejl)}</p>` : ""}
      <ol class="dage ${this._busy ? "travl" : ""}">${this.days.map((day, i) => this._dagHTML(day, i, stor)).join("")}</ol>
      ${this._balanceHTML()}
      <details class="hvordan">
        <summary>Sådan finder den forslagene</summary>
        <p>Forslagene bygger på ${d.grundlag.aftener} aftener fra jeres madplan. Retter I spiser tit, vægter mest – men kun når det er ved at være tid igen: hver ret har sin egen rytme (pita ca. hver 10. aften, lasagne sjældnere), og en ret I lige har haft, venter.</p>
        <p>Vaner på ugedage tæller med (burger om fredagen), og på travle aftener – nattevagt, fodbold, én voksen – vælges nemme retter, eller rester fra en dobbelt portion dagen før. Der er variation i kød og tilbehør, og der er lidt tilfældighed, så ugerne ikke bliver ens.</p>
        <p>Nye retter ligner altid noget, I allerede kan lide. Tryk på en ret for flere bud, og vælg "Vis ikke igen" for retter, I er færdige med.</p>
      </details>`;
    r.getElementById("bund").innerHTML = `
      <button class="sek" data-a="bland" ${this._busy ? "disabled" : ""}>${ICON_SHUFFLE}<span>Bland</span></button>
      <button class="prim" data-a="gem" ${this._busy ? "disabled" : ""}>Gem i madplanen</button>`;
  }

  _introHTML() {
    const d = this.data;
    const top = d.grundlag.top.slice(0, 3).map((t) => `${esc(lowerFirst(t.navn))} (${t.antal})`).join(", ");
    const kal = this.state?.indstillinger?.kalendere?.find((k) => k.entity_id === d.kalender);
    return `
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

  _dagHTML(day, i, stor) {
    const v = day.valg;
    const ude = day.tags.includes("ude");
    const tags = this.data.tags;
    const aktive = TAG_ORDEN.filter((t) => day.tags.includes(t) && t !== "ude");
    const erStor = v && !v.rest_af && stor.has(v.navn.toLowerCase());
    const badges = [];
    if (v?.nyt) badges.push(`<span class="badge nyt">Nyt</span>`);
    if (v?.rest_af) badges.push(`<span class="badge rest">Rester</span>`);
    if (erStor) badges.push(`<span class="badge stor">Lav dobbelt portion</span>`);
    if (day.eksisterende && !day.aendret) badges.push(`<span class="badge ek">Står i madplanen</span>`);
    const grunde = v?.grunde?.length ? v.grunde.join(" · ") : "";
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
        ${!ude && day.alts.length ? `<button class="naeste" data-a="naeste">${ICON_NEXT}<span>Andet bud</span></button>` : ""}
        ${day.kalender.length ? `<div class="kal-l">${day.kalender.map((k) => `<span>📅 ${esc(k)}</span>`).join("")}</div>` : ""}
      </li>`;
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
    setTimeout(() => (s.hidden = true), 200);
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
      <input id="sog" type="search" placeholder="Søg i jeres retter eller skriv en ny …" autocomplete="off" enterkeyhint="done" aria-label="Søg eller skriv en ret" />
      <div class="alts" id="alts">${this._altsHTML(day, brugt)}</div>
      <div class="ekstra">
        <button data-a="ude">${day.tags.includes("ude") ? "Lav mad alligevel" : "Ingen madlavning (ude, besøg …)"}</button>
        ${v && !v.rest_af && !day.tags.includes("ude") ? `<button class="fare" data-a="skjul">Foreslå ikke "${esc(lowerFirst(v.navn))}" igen</button>` : ""}
      </div>`;
  }

  _altsHTML(day, brugt) {
    const q = (this._sog || "").trim().toLowerCase();
    if (q) {
      const navne = (this.data.retter || []).filter((n) => n.toLowerCase().includes(q)).slice(0, 8);
      const rows = navne.map((n) => `<button class="alt" data-a="valg-navn" data-navn="${esc(n)}"><span class="an">${esc(n)}</span>${brugt.has(n.toLowerCase()) ? `<span class="ag">Er allerede med i ugen</span>` : ""}</button>`);
      if (!navne.some((n) => n.toLowerCase() === q)) {
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
          ${a.nyt ? `<span class="badge nyt">Nyt</span>` : ""}${a.rest_af ? `<span class="badge rest">Rester</span>` : ""}${a._cur ? `<span class="flueben" aria-label="valgt">✓</span>` : ""}</span>
        ${a.grunde?.length ? `<span class="ag">${esc(a.grunde.join(" · "))}</span>` : ""}
      </button>`).join("");
  }

  _vaelg(i, valg) {
    const day = this.days[i];
    day.valg = valg;
    day.laast = true;
    day.aendret = true;
    day.tags = day.tags.filter((t) => t !== "ude");
    // Er en ret med rester udskiftet, så skal resterne heller ikke stå der
    this._render();
  }

  _brugSoegning() {
    const t = (this._sog || "").trim();
    if (!t || this._sheet === null) return;
    const kendt = (this.data.retter || []).find((n) => n.toLowerCase() === t.toLowerCase());
    this._vaelg(this._sheet, { navn: kendt || t, tekst: lowerFirst(kendt || t), grunde: kendt ? ["Valgt af jer"] : ["Skrevet ind af jer"], varer: [] });
    this._lukSheet();
  }

  /* ------------------------------------------------------------ gem */
  _linje(day, stor) {
    const ugedag = UGEDAGE[ugedagIdx(day.dato)];
    if (day.tags.includes("ude")) return `${ugedag}: ${day.udeTekst || "ude"}`;
    const v = day.valg;
    if (!v) return `${ugedag}: `;
    const noter = TAG_ORDEN.filter((t) => day.tags.includes(t)).map((t) => this.data.tags[t]?.note).filter(Boolean);
    const ret = v.rest_af ? `${lowerFirst(v.rest_af)} rest` : v.tekst || lowerFirst(v.navn);
    let s = [...noter, ret].join(" - ");
    if (!v.rest_af && stor.has(v.navn.toLowerCase())) s += " (stor portion)";
    return `${ugedag}: ${s}`;
  }

  async _gem() {
    if (this._busy) return;
    const stor = this._storDage();
    const linjer = this.days
      .filter((d) => !(d.eksisterende && !d.aendret))
      .map((d) => ({ dato: d.dato, linje: this._linje(d, stor) }));
    if (!linjer.length) return this._luk();
    this._busy = true;
    this._renderBody();
    try {
      try {
        await this.store.send("madplan/indsaet", { linjer, base_version: this.store.state?.madplan?.version ?? null });
      } catch (e) {
        if (e?.code !== "conflict") throw e;
        await this.store.send("madplan/indsaet", { linjer, base_version: null });
      }
      this._busy = false;
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
    if (a === "luk") return this._luk();
    if (a === "luk-sheet") return this._lukSheet();
    if (a === "igen") return this._hent({});
    if (this._busy) return;
    switch (a) {
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
        lsSet("plan_nye", this.opts.nye);
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
        day.tags = day.tags.includes(t) ? day.tags.filter((x) => x !== t) : [...day.tags, t];
        if (t === "ude" && day.tags.includes("ude")) {
          day.udeTekst = day.udeTekst || day.kalender[0] || "";
          day.aendret = true;
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
        day.valg = day.alts[k];
        day.alts = day.alts.filter((_, j) => j !== k);
        if (prev && !prev.grunde?.includes("Står allerede i madplanen")) day.alts.push(prev);
        day.idx = k;
        day.laast = true;
        day.aendret = true;
        return this._renderBody();
      }
      case "vaelg":
        return this._aabnSheet(i);
      case "valg-alt": {
        const day = this.days[this._sheet];
        const k = Number(b.dataset.k);
        if (k >= 0) {
          const prev = day.valg;
          const valgt = day.alts[k];
          day.alts = day.alts.filter((_, j) => j !== k);
          if (prev && !day.tags.includes("ude")) day.alts.unshift(prev);
          this._vaelg(this._sheet, valgt);
        } else {
          day.laast = true;
          day.tags = day.tags.filter((t) => t !== "ude");
          this._render();
        }
        return this._lukSheet();
      }
      case "valg-navn": {
        const navn = b.dataset.navn;
        const alt = this.days[this._sheet].alts.find((x) => x.navn === navn);
        this._vaelg(this._sheet, alt || { navn, tekst: lowerFirst(navn), grunde: ["Valgt af jer"], varer: [] });
        return this._lukSheet();
      }
      case "valg-fri":
        return this._brugSoegning();
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
        day.tags = [...day.tags, "ude"];
        day.udeTekst = day.udeTekst || day.kalender[0] || "";
        day.aendret = true;
        this._lukSheet();
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
  .ekstra { flex: none; display: flex; flex-direction: column; gap: 0; padding-top: 6px; }
  .ekstra button { text-align: left; padding: 12px 2px; font-size: 16px; color: var(--im-acc); min-height: 44px; }
  .ekstra .fare { color: var(--error-color, #d93025); font-size: 15px; }

  @media (prefers-reduced-motion: reduce) { .ark, .sheet { transition: none; } .dag.skel { animation: none; } }
`;

if (!customElements.get("im-ugeplan")) customElements.define("im-ugeplan", UgePlan);
