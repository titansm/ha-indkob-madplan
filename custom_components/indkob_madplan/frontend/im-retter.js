/* Indkøb & Madplan – "Retter": alle retter ét sted (opskrifter fra ReciMe + jeres egne retter fra madplanen).
 *
 * Hver ret kan have en indkøbsliste (varer i familiens portion). Opskrifter får den fra ingredienserne
 * (omregnet til metrisk – se Indstillinger → Omregning), egne retter får den, når I skriver den ind
 * eller kobler retten til en opskrift. "Læg på listen" sætter varerne på indkøbslisten.
 *
 * Elementerne har ingen egen shadow-root: de tegnes inde i panelets, så panelets typografi og
 * Indstillinger-kortene (.kort/.felt) gælder. Derfor bruges ingen data-act/data-set/data-note her.
 */
import { esc, lsGet, lsSet } from "./im-common.js?v=0.13.0";

const ENHEDER = ["", "g", "kg", "ml", "dl", "l", "stk", "tsk", "spsk", "fed", "dåse", "pakke", "bundt", "glas", "flaske", "knivspids"];
const MDR = ["jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec."];
const kortDato = (iso) => {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? iso + "T12:00:00" : iso);
  return `${d.getDate()}. ${MDR[d.getMonth()]}${d.getFullYear() === new Date().getFullYear() ? "" : " " + d.getFullYear()}`;
};
const sortNavn = (s) => (s || "").replace(/^[^\p{L}\p{N}]+/u, "").toLocaleLowerCase("da");
const cmpNavn = (a, b) => sortNavn(a.navn).localeCompare(sortNavn(b.navn), "da");
const talTekst = (v) => (v === null || v === undefined || v === "" ? "" : String(Math.round(Number(v) * 100) / 100).replace(".", ","));
const parseTal = (t) => {
  t = String(t ?? "").trim().replace(",", ".");
  if (!t) return null;
  const brk = { "½": 0.5, "¼": 0.25, "¾": 0.75 };
  if (brk[t] !== undefined) return brk[t];
  const v = parseFloat(t);
  return isFinite(v) && v > 0 ? v : NaN;
};
const gangeTekst = (n) => `${n} ${n === 1 ? "gang" : "gange"}`;
// Sæson (0.12.6): samme nøgler som saeson.py
const SAESONER = [["foraar", "Forår", "mar–maj"], ["sommer", "Sommer", "jun–aug"], ["efteraar", "Efterår", "sep–nov"], ["vinter", "Vinter", "dec–feb"]];
const saesonNavn = (k) => (SAESONER.find((x) => x[0] === k) || [k, k])[1];
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const emit = (el, name, detail) => el.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));

/* ====================================================================== Retter */
class ImRetter extends HTMLElement {
  constructor() {
    super();
    this._data = null; // retter/liste
    this._version = null;
    this._seg = lsGet("retter_seg", "alle");
    this._kb = null; // valgt kogebog
    this._q = "";
    this._sheet = null; // {id, d, mode: "vis"|"ret"|"vaelg"|"ny", rows, q}
    this._built = false;
    this._loading = false;
  }

  setup(store) {
    this._store = store;
  }

  set state(s) {
    this._state = s;
    if (!this._built) this._build();
    const v = s?.retter?.version;
    if (v && v !== this._version && !this._loading) this._load();
  }

  async _load() {
    if (!this._store) return;
    this._loading = true;
    try {
      this._data = await this._store.send("retter/liste");
      this._version = this._data.version;
      this._fejl = null;
    } catch (e) {
      this._fejl = e.message || "Kunne ikke hente retterne";
    }
    this._loading = false;
    this._render();
    const nu = this._state?.retter?.version;
    if (nu && this._version && nu !== this._version) return this._load();
    // Er en ret åben, så hent den igen (fx ændret på en anden enhed) – men ikke midt i en redigering
    if (this._sheet && this._sheet.mode === "vis" && this._sheet.id) this._aabn(this._sheet.id, { stille: true });
  }

  _build() {
    this._built = true;
    this.innerHTML = `<style>${RETTER_CSS}</style>
      <div class="rt-tom" id="rt-tom" hidden></div>
      <div class="rt-top" id="rt-top" hidden>
        <div class="rt-frem" id="rt-frem"></div>
        <input class="rt-sog" id="rt-sog" type="search" placeholder="Søg i retter og varer" aria-label="Søg i retter og varer" autocomplete="off" />
        <div class="rt-seg" role="tablist" id="rt-seg">
          <button type="button" data-seg="alle">Alle</button>
          <button type="button" data-seg="mangler">Mangler varer</button>
          <button type="button" data-seg="opskrifter">Opskrifter</button>
          <button type="button" data-seg="egne">Egne</button>
        </div>
        <div class="rt-kb" id="rt-kb"></div>
      </div>
      <div class="rt-liste" id="rt-liste"></div>
      <p class="rt-fod" id="rt-fod"></p>
      <input type="file" id="rt-fil" accept=".txt,text/plain" hidden />
      <div class="rt-scrim" id="rt-scrim" hidden><div class="rt-ark" id="rt-ark" role="dialog" aria-modal="true"></div></div>`;
    this.addEventListener("click", (e) => this._click(e));
    this.querySelector("#rt-sog").addEventListener("input", (e) => {
      this._q = e.target.value;
      this._renderListe();
    });
    this.querySelector("#rt-fil").addEventListener("change", (e) => this._importFil(e.target.files?.[0]));
    this.addEventListener("input", (e) => {
      if (e.target.id === "rt-vsog" && this._sheet) {
        this._sheet.q = e.target.value;
        this._renderVaelg();
      }
    });
    this.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._sheet) this._luk();
      if (e.key === "Enter" && e.target.matches(".rt-vr input")) {
        e.preventDefault();
        const row = e.target.closest(".rt-vr");
        if (e.target.classList.contains("rt-vn") && !row.nextElementSibling?.matches(".rt-vr")) this._nyRaekke(true);
        else row.nextElementSibling?.querySelector(".rt-vn")?.focus();
      }
    });
  }

  /* ---------------------------------------------------------------- liste */
  _render() {
    if (!this._built) return;
    const d = this._data;
    const tom = this.querySelector("#rt-tom");
    const top = this.querySelector("#rt-top");
    if (this._fejl && !d) {
      tom.hidden = false;
      tom.innerHTML = `<p class="fejl">${esc(this._fejl)}</p>`;
      top.hidden = true;
      return;
    }
    if (!d) return;
    const a = d.antal;
    tom.hidden = a.opskrifter > 0;
    tom.innerHTML = a.opskrifter ? "" : `<div class="rt-kort">
        <b>Ingen opskrifter endnu</b>
        <p>Importér jeres opskrifter fra ReciMe (en eksportfil), så får hver opskrift en indkøbsliste i jeres portion. Jeres egne retter fra madplanen står herunder – tryk på en ret for at skrive dens varer.</p>
        <button type="button" class="rt-knap" data-r="import">Importér opskrifter …</button></div>`;
    top.hidden = false;
    const pct = a.alle ? Math.round((a.med_varer / a.alle) * 100) : 0;
    this.querySelector("#rt-frem").innerHTML = `<div class="rt-bar"><i style="width:${pct}%"></i></div>
      <span><b>${a.med_varer}</b> af ${a.alle} retter har indkøbsliste${a.egne > a.egne_med_varer ? ` · ${a.egne - a.egne_med_varer} af jeres egne mangler` : ""}</span>`;
    for (const b of this.querySelectorAll("[data-seg]")) b.setAttribute("aria-pressed", String(b.dataset.seg === this._seg));
    const kbEl = this.querySelector("#rt-kb");
    const visKb = (this._seg === "alle" || this._seg === "opskrifter") && d.kogeboger.length > 1;
    kbEl.hidden = !visKb;
    if (this._kb && !d.kogeboger.some((k) => k.navn === this._kb)) this._kb = null;
    kbEl.innerHTML = visKb
      ? d.kogeboger.map((k) => `<button type="button" class="rt-chip" data-kb="${esc(k.navn)}" aria-pressed="${k.navn === this._kb}">${esc(k.navn)} <small>${k.antal}</small></button>`).join("")
      : "";
    this.querySelector("#rt-fod").innerHTML = a.opskrifter
      ? `${a.opskrifter} opskrifter fra ${esc(d.kilde || "ReciMe")}${d.importeret ? ", importeret " + kortDato(d.importeret) : ""} · <button type="button" class="link" data-r="import">Importér igen …</button>`
      : "";
    this._renderListe();
  }

  _filtrer() {
    const d = this._data;
    let l = d.retter;
    const seg = this._seg;
    if (seg === "mangler") l = l.filter((r) => !r.har_varer);
    else if (seg === "opskrifter") l = l.filter((r) => r.type === "opskrift");
    else if (seg === "egne") l = l.filter((r) => r.type === "egen");
    if (this._kb && (seg === "alle" || seg === "opskrifter")) l = l.filter((r) => r.kogeboger.includes(this._kb));
    const q = this._q.trim().toLocaleLowerCase("da");
    if (q) {
      const navn = l.filter((r) => r.navn.toLocaleLowerCase("da").includes(q));
      const varer = l.filter((r) => !r.navn.toLocaleLowerCase("da").includes(q) && r.soeg.includes(q));
      return { liste: [...navn.sort(cmpNavn), ...varer.sort(cmpNavn)], vareTreff: new Set(varer.map((r) => r.id)) };
    }
    if (seg === "mangler" || seg === "egne") {
      l = [...l].sort((a, b) => (a.type === b.type ? 0 : a.type === "egen" ? -1 : 1) || b.gange - a.gange || cmpNavn(a, b));
    } else l = [...l].sort(cmpNavn);
    return { liste: l, vareTreff: new Set() };
  }

  _renderListe() {
    const d = this._data;
    const el = this.querySelector("#rt-liste");
    if (!d || !el) return;
    const { liste, vareTreff } = this._filtrer();
    const q = this._q.trim();
    if (!liste.length) {
      el.innerHTML = `<p class="rt-ingen">${q ? `Ingen retter med "${esc(q)}"` : this._seg === "mangler" ? "Alle retter har en indkøbsliste 🎉" : "Ingen retter her endnu"}</p>`;
      return;
    }
    const MAX = 400;
    el.innerHTML = liste.slice(0, MAX).map((r) => this._raekke(r, vareTreff.has(r.id))).join("") +
      (liste.length > MAX ? `<p class="rt-ingen">… og ${liste.length - MAX} mere – søg for at finde dem</p>` : "");
  }

  _raekke(r, vareTreff) {
    const meta = [];
    if (r.type === "egen") {
      meta.push(r.gange ? `Spist ${gangeTekst(r.gange)}${r.sidst ? ", sidst " + kortDato(r.sidst) : ""}` : "Egen ret");
      if (r.opskrift) meta.push("med opskrift");
    } else {
      if (r.kogeboger.length) meta.push(esc(r.kogeboger.join(", ")));
      if (r.tid) meta.push(`${r.tid} min`);
    }
    if (vareTreff) {
      const q = this._q.trim().toLocaleLowerCase("da");
      const hit = r.soeg.split(" ").find((w) => w.includes(q));
      if (hit) meta.push(`indeholder ${esc(q)}`);
    }
    const th = r.billede
      ? `<img src="${esc(r.billede)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />`
      : `<span aria-hidden="true">${r.type === "egen" ? "🍽" : "📖"}</span>`;
    const badge = r.har_varer
      ? `<span class="rt-b ok" title="Har indkøbsliste – kan lægges på listen">🛒 ${r.antal_varer}</span>`
      : `<span class="rt-b mangler">＋ varer</span>`;
    return `<button type="button" class="rt-r" data-ret="${esc(r.id)}">
      <span class="rt-th">${th}</span>
      <span class="rt-rt"><b>${esc(r.navn)}</b><small>${meta.join(" · ")}</small></span>
      ${badge}<span class="rt-chev" aria-hidden="true">›</span></button>`;
  }

  /* ---------------------------------------------------------------- klik */
  async _click(e) {
    const t = e.target;
    if (t.id === "rt-scrim") return this._luk();
    const seg = t.closest("[data-seg]");
    if (seg) {
      this._seg = seg.dataset.seg;
      lsSet("retter_seg", this._seg);
      this._render();
      return;
    }
    const kb = t.closest("[data-kb]");
    if (kb) {
      this._kb = this._kb === kb.dataset.kb ? null : kb.dataset.kb;
      this._render();
      return;
    }
    const ret = t.closest("[data-ret]");
    if (ret && !t.closest("#rt-ark")) return this._aabn(ret.dataset.ret);
    const b = t.closest("[data-r]");
    if (!b) return;
    const act = b.dataset.r;
    const s = this._sheet;
    if (act === "import") return this.querySelector("#rt-fil").click();
    if (act === "luk") return this._luk();
    if (act === "rediger") return this._redigerStart();
    if (act === "annuller") {
      if (s.mode === "ny") return this._luk();
      s.mode = "vis";
      return this._renderArk();
    }
    if (act === "gem") return this._gem();
    if (act === "ny-vare") return this._nyRaekke(true);
    if (act === "slet-vare") {
      this._laesRaekker();
      s.rows.splice(+b.dataset.i, 1);
      return this._renderArk();
    }
    if (act === "forslag-vare") {
      this._laesRaekker();
      const navn = b.dataset.navn;
      const tomme = s.rows.findIndex((r) => !r.navn.trim());
      if (tomme >= 0) s.rows[tomme].navn = navn;
      else s.rows.push({ navn, maengde: "", enhed: "" });
      s.brugteForslag = new Set([...(s.brugteForslag || []), navn]);
      return this._renderArk();
    }
    if (act === "paa-listen") return this._paaListen(+(b.dataset.gange || 1));
    if (act === "gendan") return this._gemRaw({ ret: s.id, varer: null }, "Indkøbslisten er gendannet");
    if (act === "fjern-kobling") return this._gemRaw({ ret: s.id, opskrift: null }, "Koblingen er fjernet");
    if (act === "kobl") {
      const data = { ret: s.id, opskrift: b.dataset.id };
      if (s.d?.egne_varer) data.varer = null; // koblingen erstatter jeres egen liste
      return this._gemRaw(data, "Retten bruger nu opskriftens varer");
    }
    if (act === "vaelg") {
      s.mode = "vaelg";
      s.q = "";
      this._renderArk();
      requestAnimationFrame(() => this.querySelector("#rt-vsog")?.focus());
      return;
    }
    if (act === "vaelg-tilbage") {
      s.mode = "vis";
      return this._renderArk();
    }
    if (act === "vis-opskrift") return this._aabn(b.dataset.id);
    if (act === "fryser") {
      s.mode = "fryser";
      s.fz = [...(s.d?.fryser || [])];
      this._renderArk();
      requestAnimationFrame(() => this.querySelector("#rt-fzny")?.focus());
      return;
    }
    if (act === "fz-slet") {
      s.fz.splice(+b.dataset.i, 1);
      return this._renderArk();
    }
    if (act === "fz-tilfoej") return this._fzTilfoej();
    if (act === "fz-intet") {
      s.fz = s.fz.includes("intet") ? s.fz.filter((x) => x !== "intet") : [...s.fz, "intet"];
      return this._renderArk();
    }
    if (act === "fz-gem") {
      this._fzTilfoej(false);
      return this._gemRaw({ ret: s.id, fryser: s.fz }, s.fz.length ? "Kød fra fryseren er gemt" : "Gemt: intet fra fryseren");
    }
    if (act === "fz-ryd") return this._gemRaw({ ret: s.id, fryser: null }, "Kød fra fryseren er fjernet");
    if (act === "fz-annuller") {
      s.mode = "vis";
      return this._renderArk();
    }
    // sæson (0.12.6): s.se = null (standard) | [] (hele året) | ["efteraar", …]
    if (act === "saeson") {
      s.mode = "saeson";
      s.se = s.d?.saeson == null ? null : [...s.d.saeson];
      return this._renderArk();
    }
    if (act === "se-hele") {
      s.se = [];
      return this._renderArk();
    }
    if (act === "se-k") {
      const k = b.dataset.k;
      const cur = s.se || [];
      const ny = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      s.se = ny.length ? SAESONER.map((x) => x[0]).filter((x) => ny.includes(x)) : null;
      if (s.se && s.se.length === SAESONER.length) s.se = []; // alle fire = hele året
      return this._renderArk();
    }
    if (act === "se-std") {
      s.se = null;
      return this._renderArk();
    }
    if (act === "se-gem") {
      const se = s.se;
      return this._gemRaw({ ret: s.id, saeson: se }, se == null ? "Sæsonen følger standard" : !se.length ? "Gemt: hele året" : "Sæsonen er gemt");
    }
    if (act === "se-annuller") {
      s.mode = "vis";
      return this._renderArk();
    }
  }

  /* ---------------------------------------------------------------- ark: vis */
  async _aabn(id, { stille = false } = {}) {
    if (!stille) {
      this._sheet = { id, d: null, mode: "vis" };
      this._visArk();
      this._renderArk();
    }
    try {
      const d = await this._store.send("retter/hent", { ret: id });
      if (!this._sheet || this._sheet.id !== id) return;
      this._sheet.d = d;
      if (this._sheet.mode === "vis") this._renderArk();
    } catch (e) {
      if (!this._sheet || this._sheet.id !== id) return;
      if (stille) return this._luk();
      this._sheet.fejl = e.message || "Kunne ikke hente retten";
      this._renderArk();
    }
  }

  /** Ny egen ret (fra værktøjslinjen) */
  nyRet() {
    this._sheet = { id: null, d: { navn: "", varer: [] }, mode: "ny", rows: [{ navn: "", maengde: "", enhed: "" }] };
    this._visArk();
    this._renderArk();
    requestAnimationFrame(() => this.querySelector("#rt-nynavn")?.focus());
  }

  _visArk() {
    const scrim = this.querySelector("#rt-scrim");
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add("inde"));
  }

  _luk() {
    const scrim = this.querySelector("#rt-scrim");
    scrim.classList.remove("inde");
    this._sheet = null;
    setTimeout(() => { if (!this._sheet) scrim.hidden = true; }, 220);
  }

  _renderArk() {
    const s = this._sheet;
    const ark = this.querySelector("#rt-ark");
    if (!s || !ark) return;
    if (s.mode === "ret" || s.mode === "ny") return this._renderRet();
    if (s.mode === "fryser") return this._renderFryser();
    if (s.mode === "saeson") return this._renderSaeson();
    if (s.mode === "vaelg") return this._renderVaelgArk();
    const d = s.d;
    const kanRette = !!d;
    const head = `<header class="rt-ah">
        <button type="button" class="rt-hk" data-r="luk">Luk</button>
        <span class="rt-at">${d ? esc(d.navn) : ""}</span>
        <button type="button" class="rt-hk fed" data-r="rediger" ${kanRette ? "" : "disabled"}>Rediger</button>
      </header>`;
    if (s.fejl) {
      ark.innerHTML = head + `<div class="rt-ab"><p class="fejl">${esc(s.fejl)}</p></div>`;
      return;
    }
    if (!d) {
      ark.innerHTML = head + `<div class="rt-ab"><p class="rt-ingen">Henter …</p></div>`;
      return;
    }
    const varer = d.varer || [];
    let body = "";
    if (d.billede) body += `<img class="rt-hero" src="${esc(d.billede)}" alt="" onerror="this.remove()" />`;
    body += `<h2 class="rt-titel">${esc(d.navn)}</h2>`;
    const meta = [];
    if (d.type === "opskrift") {
      if (d.kogeboger?.length) meta.push(esc(d.kogeboger.join(", ")));
      if (d.tid?.total) meta.push(`${d.tid.total} min`);
      if (d.portioner) meta.push(`opskriften er til ${d.portioner}`);
      if (d.kokken) meta.push(esc(d.kokken));
    } else {
      meta.push(d.gange ? `Spist ${gangeTekst(d.gange)}${d.sidst ? ", sidst " + kortDato(d.sidst) : ""}` : "Egen ret");
    }
    body += `<p class="rt-meta">${meta.join(" · ")}</p>`;
    if (varer.length) {
      body += `<div class="rt-handl">
          <button type="button" class="rt-knap" data-r="paa-listen" data-gange="1">🛒 Læg på indkøbslisten</button>
          <button type="button" class="rt-knap sek" data-r="paa-listen" data-gange="2" title="Dobbelt portion – rester til dagen efter">×2</button>
        </div>`;
    }
    // indkøbslisten
    body += `<h3 class="rt-gr">Indkøbsliste${varer.length ? ` (${varer.length})` : ""}</h3>`;
    if (varer.length) {
      body += `<ul class="rt-varer">${varer.map((v) => `<li><span>${esc(v.navn)}</span><span class="rt-m">${esc(v.tekst)}</span></li>`).join("")}</ul>`;
      const noter = [];
      if (d.type === "opskrift" && !d.rettet) {
        const f = String(d.faktor).replace(".", ",");
        noter.push(d.grundlag === "opskriftens mængde" ? "Opskriftens mængder (ikke skaleret)" : `Skaleret til ${esc(d.grundlag)} (×${f})`);
      }
      if (d.rettet) noter.push(`Jeres egen liste${d.rettet_af ? " – rettet af " + esc(d.rettet_af) : ""}${d.rettet_t ? " " + kortDato(d.rettet_t) : ""}`);
      if (d.opskrift && !d.egne_varer) noter.push(`Varerne kommer fra opskriften <b>${esc(d.opskrift.navn)}</b>`);
      if (noter.length) body += `<p class="rt-note">${noter.join(" · ")}</p>`;
    } else {
      body += `<div class="rt-kort">
          <b>Ingen indkøbsliste endnu</b>
          <p>Skriv varerne én gang, så kan retten fremover lægges på indkøbslisten med ét tryk.</p>
          <button type="button" class="rt-knap" data-r="rediger">＋ Skriv varerne</button>
        </div>`;
    }
    if (d.type === "opskrift") {
      if (d.har_vi_altid?.length) body += `<p class="rt-note">Har vi altid (kommer ikke på listen): ${esc(d.har_vi_altid.join(", "))}</p>`;
      if (d.ikke_tolket?.length && !d.rettet) {
        body += `<p class="rt-note adv">Ikke med på listen – tilføj selv under Rediger, hvis de skal købes: ${d.ikke_tolket.map((x) => `"${esc(x)}"`).join(", ")}</p>`;
      }
      if (d.rettet) body += `<button type="button" class="link" data-r="gendan">Gendan opskriftens liste</button>`;
      const links = [`<a class="rt-link" href="${esc(d.recime)}" target="_blank" rel="noopener">Åbn opskriften i ReciMe ↗</a>`];
      if (d.kilde) links.push(`<a class="rt-link" href="${esc(d.kilde)}" target="_blank" rel="noopener">${/instagram/.test(d.kilde) ? "Original på Instagram" : "Original opskrift"} ↗</a>`);
      body += `<div class="rt-links">${links.join("")}</div>`;
      if (d.original?.length) {
        body += `<details class="rt-orig"><summary>Opskriftens ingredienser (${d.original.length})</summary>
          <ul>${d.original.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          <p class="rt-note">Som de står i opskriften, før omregning – fremgangsmåden står i ReciMe.</p></details>`;
      }
    } else {
      // egen ret: kød fra fryseren (0.12.4)
      const f = d.fryser;
      body += `<h3 class="rt-gr">❄ Fra fryseren</h3>`;
      body += f == null
        ? `<p class="rt-note">Ikke angivet – påmindelsen gætter ud fra navnet.</p>`
        : !f.length
          ? `<p class="rt-note">Intet skal op af fryseren.</p>`
          : `<div class="rt-fz">${f.map((a) => `<span class="rt-fzc">${esc(a === "intet" ? "Intet fra fryseren" : a)}</span>`).join("")}</div>
             ${f.length > 1 ? `<p class="rt-note">Planlæggeren spørger, hvilket kød det bliver.</p>` : ""}`;
      body += `<div class="rt-links"><button type="button" class="link" data-r="fryser">${f == null ? "Angiv kød fra fryseren …" : "Ret kød fra fryseren …"}</button></div>`;
      // egen ret: sæson (0.12.6)
      const se = d.saeson;
      const nu = d.saeson_tekst ? (d.saeson_nu > 0 ? " · i sæson nu" : " · uden for sæson nu") : "";
      body += `<h3 class="rt-gr">🗓 Sæson</h3>`;
      body += se == null
        ? `<p class="rt-note rt-se-tekst">${d.saeson_standard ? `${esc(cap(d.saeson_standard))} (standard)${nu} – foreslås ikke uden for sæsonen.` : "Hele året (standard)."}</p>`
        : !se.length
          ? `<p class="rt-note rt-se-tekst">Hele året (sat af jer).</p>`
          : `<div class="rt-se">${se.map((k) => `<span class="rt-chip" aria-pressed="true">${esc(saesonNavn(k))}</span>`).join("")}</div>
             <p class="rt-note rt-se-tekst">Foreslås kun i ${esc(d.saeson_tekst || "")}${nu}.</p>`;
      body += `<div class="rt-links"><button type="button" class="link" data-r="saeson">${se == null ? "Angiv sæson …" : "Ret sæson …"}</button></div>`;
      // egen ret: kobling til en opskrift
      if (d.opskrift) {
        body += `<div class="rt-kobl">
            ${d.opskrift.billede ? `<img src="${esc(d.opskrift.billede)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}
            <span><small>Opskrift</small><b>${esc(d.opskrift.navn)}</b></span>
            <button type="button" class="link" data-r="vis-opskrift" data-id="${esc(d.opskrift.id)}">Vis</button>
          </div>
          <div class="rt-links"><button type="button" class="link" data-r="fjern-kobling">Fjern koblingen til opskriften</button>`;
        if (d.egne_varer) body += `<button type="button" class="link" data-r="gendan">Brug opskriftens varer igen</button>`;
        body += `</div>`;
      } else {
        const fo = d.egne_varer ? [] : d.forslag_opskrifter || [];
        if (fo.length || !d.egne_varer) body += `<h3 class="rt-gr">${fo.length ? "Er det en af jeres opskrifter?" : "Opskrift"}</h3>`;
        if (fo.length) {
          body += fo.map((o) => `<div class="rt-kobl">
              ${o.billede ? `<img src="${esc(o.billede)}" alt="" loading="lazy" onerror="this.remove()" />` : `<span class="rt-th0">📖</span>`}
              <span><b>${esc(o.navn)}</b></span>
              <button type="button" class="rt-knap lille" data-r="kobl" data-id="${esc(o.id)}">Brug</button>
            </div>`).join("");
        }
        body += `<div class="rt-links"><button type="button" class="link" data-r="vaelg">${fo.length ? "Vælg en anden opskrift …" : d.egne_varer ? "Brug varerne fra en opskrift i stedet …" : "Brug varerne fra en opskrift …"}</button>`;
        if (d.egne_varer) body += `<button type="button" class="link" data-r="gendan">Slet indkøbslisten</button>`;
        body += `</div>`;
      }
    }
    ark.innerHTML = head + `<div class="rt-ab">${body}</div>`;
  }

  /* ---------------------------------------------------------------- ark: kød fra fryseren (0.12.4) */
  _fzTilfoej(render = true) {
    const s = this._sheet;
    const inp = this.querySelector("#rt-fzny");
    const v = (inp?.value || "").trim().toLowerCase();
    if (v) for (const x of v.split(",").map((y) => y.trim()).filter(Boolean)) if (!s.fz.includes(x)) s.fz.push(x);
    if (inp) inp.value = "";
    if (render) {
      this._renderArk();
      requestAnimationFrame(() => this.querySelector("#rt-fzny")?.focus());
    }
  }

  _renderFryser() {
    const s = this._sheet;
    const ark = this.querySelector("#rt-ark");
    const koed = s.fz.filter((x) => x !== "intet");
    const intet = s.fz.includes("intet");
    ark.innerHTML = `<header class="rt-ah">
        <button type="button" class="rt-hk" data-r="fz-annuller">Annullér</button>
        <span class="rt-at">${esc(s.d.navn)}</span>
        <button type="button" class="rt-hk fed" data-r="fz-gem">Gem</button>
      </header>
      <div class="rt-ab">
        <h2 class="rt-titel">❄ Fra fryseren</h2>
        <p class="rt-meta">Det kød, der skal op af fryseren til retten. Har den flere muligheder (fx hakket oksekød eller kyllingebryst), spørger planlæggeren, hvilket det bliver.</p>
        <div class="rt-fz">${koed.length
          ? koed.map((a) => `<span class="rt-fzc">${esc(a)}<button type="button" data-r="fz-slet" data-i="${s.fz.indexOf(a)}" aria-label="Fjern ${esc(a)}">×</button></span>`).join("")
          : `<span class="rt-note">${intet ? "Intet skal op af fryseren." : "Intet kød endnu – tilføj nedenfor."}</span>`}</div>
        <div class="rt-fzadd">
          <input id="rt-fzny" type="text" placeholder="Fx hakket oksekød" enterkeyhint="done" autocapitalize="none" aria-label="Kød fra fryseren" />
          <button type="button" class="rt-knap lille" data-r="fz-tilfoej">Tilføj</button>
        </div>
        <label class="rt-fzi"><input type="checkbox" data-r="fz-intet" ${intet ? "checked" : ""} /> ${koed.length ? "Kan også være uden kød fra fryseren" : "Intet fra fryseren"}</label>
        <div class="rt-links"><button type="button" class="link" data-r="fz-ryd">Ryd – lad påmindelsen gætte ud fra navnet</button></div>
        <p class="rt-fejl fejl" id="rt-fejl" hidden></p>
      </div>`;
    this.querySelector("#rt-fzny").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this._fzTilfoej();
      }
    });
  }

  /* ---------------------------------------------------------------- ark: sæson (0.12.6) */
  _renderSaeson() {
    const s = this._sheet;
    const ark = this.querySelector("#rt-ark");
    const se = s.se;
    const std = s.d.saeson_standard;
    let note;
    if (se == null) note = std ? `Standard: ${esc(std)} – foreslås ikke uden for sæsonen.` : "Standard: hele året.";
    else if (!se.length) note = "Foreslås hele året.";
    else note = `Foreslås kun i ${esc(se.map((k) => saesonNavn(k).toLowerCase()).join(" og ").replace(/ og (?=.* og )/g, ", "))}.`;
    ark.innerHTML = `<header class="rt-ah">
        <button type="button" class="rt-hk" data-r="se-annuller">Annullér</button>
        <span class="rt-at">${esc(s.d.navn)}</span>
        <button type="button" class="rt-hk fed" data-r="se-gem">Gem</button>
      </header>
      <div class="rt-ab">
        <h2 class="rt-titel">🗓 Sæson</h2>
        <p class="rt-meta">Hvornår planlæggeren må foreslå retten. Uden for sæsonen foreslås den ikke – I kan stadig vælge den selv. I sæsonen kommer den lidt oftere.</p>
        <div class="rt-se">
          <button type="button" class="rt-chip" data-r="se-hele" aria-pressed="${se != null && !se.length}">Hele året</button>
          ${SAESONER.map(([k, navn, mdr]) => `<button type="button" class="rt-chip" data-r="se-k" data-k="${k}" aria-pressed="${!!se?.includes(k)}">${navn} <small>${mdr}</small></button>`).join("")}
        </div>
        <p class="rt-note rt-se-note">${note}</p>
        ${se != null ? `<div class="rt-links"><button type="button" class="link" data-r="se-std">Brug standard (${esc(std || "hele året")})</button></div>` : ""}
        <p class="rt-fejl fejl" id="rt-fejl" hidden></p>
      </div>`;
  }

  /* ---------------------------------------------------------------- ark: rediger */
  _redigerStart() {
    const s = this._sheet;
    if (!s?.d) return;
    s.mode = "ret";
    s.rows = (s.d.varer || []).map((v) => ({ navn: v.navn, maengde: talTekst(v.maengde), enhed: v.enhed || "" }));
    if (!s.rows.length) s.rows.push({ navn: "", maengde: "", enhed: "" });
    s.brugteForslag = new Set();
    this._renderArk();
    if (!(s.d.varer || []).length) requestAnimationFrame(() => this.querySelector(".rt-vn")?.focus());
  }

  _laesRaekker() {
    const s = this._sheet;
    if (!s || !(s.mode === "ret" || s.mode === "ny")) return;
    s.rows = [...this.querySelectorAll(".rt-vr")].map((row) => ({
      navn: row.querySelector(".rt-vn").value,
      maengde: row.querySelector(".rt-vm").value,
      enhed: row.querySelector(".rt-ve").value,
    }));
    const nn = this.querySelector("#rt-nynavn");
    if (nn) s.d.navn = nn.value;
  }

  _nyRaekke(fokus) {
    this._laesRaekker();
    this._sheet.rows.push({ navn: "", maengde: "", enhed: "" });
    this._renderArk();
    if (fokus) requestAnimationFrame(() => [...this.querySelectorAll(".rt-vn")].pop()?.focus());
  }

  _renderRet() {
    const s = this._sheet;
    const ark = this.querySelector("#rt-ark");
    const ny = s.mode === "ny";
    const kendte = this._state?.indkob?.kendte || [];
    const navne = new Set(kendte);
    for (const r of s.rows) if (r.navn) navne.add(r.navn);
    const forslag = (s.d.forslag_varer || []).filter((n) => !s.brugteForslag?.has(n) && !s.rows.some((r) => r.navn.toLowerCase() === n.toLowerCase()));
    const opt = (cur) => {
      const list = ENHEDER.includes(cur) ? ENHEDER : [...ENHEDER, cur];
      return list.map((u) => `<option value="${esc(u)}" ${u === cur ? "selected" : ""}>${u || "–"}</option>`).join("");
    };
    ark.innerHTML = `<header class="rt-ah">
        <button type="button" class="rt-hk" data-r="annuller">Annullér</button>
        <span class="rt-at">${ny ? "Ny ret" : esc(s.d.navn)}</span>
        <button type="button" class="rt-hk fed" data-r="gem">Gem</button>
      </header>
      <div class="rt-ab">
        ${ny ? `<input class="rt-nynavn" id="rt-nynavn" type="text" placeholder="Rettens navn, fx Tacos" value="${esc(s.d.navn || "")}" autocapitalize="sentences" enterkeyhint="next" />` : `<h2 class="rt-titel">${esc(s.d.navn)}</h2>`}
        <p class="rt-meta">${s.d.type === "opskrift" ? "Mængderne er til jeres portion. Rettelserne gemmes som jeres egen liste til opskriften." : "Én vare pr. linje – mængde er valgfri. Listen huskes til næste gang."}</p>
        ${forslag.length ? `<div class="rt-fl"><span>Forslag:</span>${forslag.map((n) => `<button type="button" class="rt-chip" data-r="forslag-vare" data-navn="${esc(n)}">＋ ${esc(n)}</button>`).join("")}</div>` : ""}
        <div class="rt-vh"><span>Vare</span><span>Mængde</span><span>Enhed</span><span></span></div>
        <div class="rt-vl">${s.rows.map((r, i) => `<div class="rt-vr">
            <input class="rt-vn" type="text" value="${esc(r.navn)}" placeholder="Vare" list="rt-dl" autocapitalize="sentences" enterkeyhint="next" aria-label="Vare" />
            <input class="rt-vm" type="text" inputmode="decimal" value="${esc(r.maengde)}" placeholder="–" aria-label="Mængde" enterkeyhint="next" />
            <select class="rt-ve" aria-label="Enhed">${opt(r.enhed)}</select>
            <button type="button" class="rt-x" data-r="slet-vare" data-i="${i}" aria-label="Fjern ${esc(r.navn || "linjen")}">−</button>
          </div>`).join("")}</div>
        <button type="button" class="link" data-r="ny-vare">＋ Tilføj vare</button>
        <datalist id="rt-dl">${[...navne].slice(0, 600).map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        <p class="rt-fejl fejl" id="rt-fejl" hidden></p>
      </div>`;
  }

  async _gem() {
    const s = this._sheet;
    this._laesRaekker();
    const fejl = this.querySelector("#rt-fejl");
    const varer = [];
    for (const r of s.rows) {
      if (!r.navn.trim()) continue;
      const m = parseTal(r.maengde);
      if (Number.isNaN(m)) {
        fejl.textContent = `"${r.navn}": mængden skal være et tal (fx 400 eller 1,5)`;
        fejl.hidden = false;
        return;
      }
      varer.push({ navn: r.navn.trim(), maengde: m, enhed: m === null ? "" : r.enhed });
    }
    if (s.mode === "ny") {
      const navn = (s.d.navn || "").trim();
      if (!navn) {
        fejl.textContent = "Skriv rettens navn";
        fejl.hidden = false;
        this.querySelector("#rt-nynavn")?.focus();
        return;
      }
      return this._gemRaw({ ret: null, navn, varer }, `"${navn}" er gemt`);
    }
    return this._gemRaw({ ret: s.id, varer }, varer.length ? "Indkøbslisten er gemt" : "Gemt");
  }

  async _gemRaw(data, ok) {
    const s = this._sheet;
    emit(this, "im-status", "Gemmer …");
    try {
      const d = await this._store.send("retter/gem", data);
      emit(this, "im-status", "Gemt");
      if (!this._sheet) return;
      s.id = d.id;
      s.d = d;
      s.mode = "vis";
      this._renderArk();
      emit(this, "im-toast", { text: ok });
    } catch (e) {
      emit(this, "im-status", "Kunne ikke gemme");
      const fejl = this.querySelector("#rt-fejl");
      if (fejl) {
        fejl.textContent = e.message || "Kunne ikke gemme";
        fejl.hidden = false;
      } else emit(this, "im-toast", { text: e.message || "Kunne ikke gemme" });
    }
  }

  async _paaListen(gange) {
    const s = this._sheet;
    try {
      const res = await this._store.send("retter/paa_listen", { ret: s.id, gange });
      const n = res.tilfoejet.length;
      const tekst = n
        ? `${n} ${n === 1 ? "vare" : "varer"} fra ${res.ret} på listen${res.fandtes.length ? ` (${res.fandtes.length} stod der)` : ""}`
        : `Alle varer fra ${res.ret} stod allerede på listen`;
      emit(this, "im-toast", {
        text: tekst,
        actions: n ? [{ label: "Fortryd", action: () => this._store.remove(res.ids) }] : [],
      });
    } catch (e) {
      emit(this, "im-toast", { text: e.message || "Kunne ikke lægge varerne på listen" });
    }
  }

  /* ---------------------------------------------------------------- ark: vælg opskrift */
  _renderVaelgArk() {
    const ark = this.querySelector("#rt-ark");
    ark.innerHTML = `<header class="rt-ah">
        <button type="button" class="rt-hk" data-r="vaelg-tilbage">‹ Tilbage</button>
        <span class="rt-at">Vælg opskrift</span><span class="rt-hk"></span>
      </header>
      <div class="rt-ab">
        <p class="rt-meta">"${esc(this._sheet.d?.navn || "")}" bruger derefter opskriftens varer (i jeres portion).</p>
        <input class="rt-sog" id="rt-vsog" type="search" placeholder="Søg i opskrifterne" autocomplete="off" value="${esc(this._sheet.q || "")}" />
        <div id="rt-vl" class="rt-liste"></div>
      </div>`;
    this._renderVaelg();
  }

  _renderVaelg() {
    const el = this.querySelector("#rt-vl");
    if (!el || !this._data) return;
    const q = (this._sheet.q || "").trim().toLocaleLowerCase("da");
    const l = this._data.retter.filter((r) => r.type === "opskrift" && r.har_varer && (!q || r.navn.toLocaleLowerCase("da").includes(q) || r.soeg.includes(q))).sort(cmpNavn);
    el.innerHTML = l.length
      ? l.slice(0, 200).map((r) => `<button type="button" class="rt-r" data-r="kobl" data-id="${esc(r.id)}">
          <span class="rt-th">${r.billede ? `<img src="${esc(r.billede)}" alt="" loading="lazy" onerror="this.remove()" />` : "📖"}</span>
          <span class="rt-rt"><b>${esc(r.navn)}</b><small>🛒 ${r.antal_varer} varer${r.kogeboger.length ? " · " + esc(r.kogeboger.join(", ")) : ""}</small></span></button>`).join("")
      : `<p class="rt-ingen">Ingen opskrifter${q ? ` med "${esc(q)}"` : ""}</p>`;
  }

  /* ---------------------------------------------------------------- import */
  async _importFil(fil) {
    const inp = this.querySelector("#rt-fil");
    if (!fil) return;
    try {
      const tekst = await fil.text();
      inp.value = "";
      if (!/^R\|/m.test(tekst)) {
        emit(this, "im-toast", { text: "Filen ligner ikke en opskriftseksport (R|…-linjer)" });
        return;
      }
      emit(this, "im-status", "Importerer …");
      const res = await this._store.send("opskrifter/importer", { tekst, erstat: true });
      emit(this, "im-status", "Importeret");
      emit(this, "im-toast", { text: `${res.antal} opskrifter importeret (${res.nye} nye, ${res.opdaterede} opdaterede${res.fjernede ? `, ${res.fjernede} fjernet` : ""})`, ms: 6000 });
    } catch (e) {
      emit(this, "im-status", "Import fejlede");
      emit(this, "im-toast", { text: e.message || "Importen fejlede" });
    }
  }
}

/* ====================================================================== Omregning (Indstillinger) */
const SKALER_KOED = [250, 300, 350, 400, 450, 500, 600, 700, 800, 1000];
const SKALER_PORT = [2, 3, 4, 5, 6, 8];
const SKALER_TAERSKEL = [50, 60, 75, 100, 125, 150];
const SKALER_MIN = [0.25, 0.5, 0.75, 1];
const SKALER_MAX = [1, 1.5, 2, 3, 4, 5];
const ENH_FELTER = [
  ["cup_dl", "1 cup", "dl"], ["lb_g", "1 pound (lb)", "g"], ["oz_g", "1 ounce (oz)", "g"], ["floz_ml", "1 ounce væske (fl oz)", "ml"],
  ["pint_dl", "1 pint", "dl"], ["inch_cm", "1 inch", "cm"], ["stick_g", "1 stick smør", "g"],
];
const brok = (v) => ({ 0.25: "¼", 0.5: "½", 0.75: "¾" }[v] || String(v).replace(".", ","));

class ImOmregning extends HTMLElement {
  constructor() {
    super();
    this._data = null;
    this._version = null;
    this._eks = lsGet("omr_eks", null); // eksempel-opskrift
    this._built = false;
    this._nulstilKlar = false;
  }

  setup(store) {
    this._store = store;
  }

  set state(s) {
    this._state = s;
    if (!this._built) this._build();
    const v = s?.retter?.version;
    if (v && v !== this._version) {
      this._version = v;
      this._load();
    }
  }

  async _load() {
    if (!this._store) return;
    try {
      [this._data, this._liste] = await Promise.all([this._store.send("omregning/hent"), this._store.send("retter/liste")]);
    } catch (e) {
      this._fejl = e.message;
    }
    this._render();
    this._renderEksempel();
  }

  _build() {
    this._built = true;
    this.innerHTML = `<style>${OMR_CSS}</style><div id="om-indhold"><p class="fod">Henter …</p></div>`;
    this.addEventListener("change", (e) => this._changed(e));
    this.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches("input[type=text]")) e.target.blur();
    });
    this.addEventListener("click", (e) => {
      const b = e.target.closest("[data-om]");
      if (!b) return;
      if (b.dataset.om === "nulstil") this._nulstil(b);
      if (b.dataset.om === "skeer") this._gem({ skeer: b.dataset.v });
    });
  }

  _render() {
    const el = this.querySelector("#om-indhold");
    if (!el) return;
    const d = this._data;
    if (!d) {
      el.innerHTML = `<p class="fod ${this._fejl ? "fejl" : ""}">${esc(this._fejl || "Henter …")}</p>`;
      return;
    }
    const focus = this.ownerDocument && this.getRootNode().activeElement;
    if (focus && this.contains(focus) && focus.matches("input[type=text], textarea")) {
      // skriv ikke henover et felt, man står i – opdatér kun opsummering og eksempel
      this._renderOpsummering();
      return;
    }
    const o = d.omregning;
    const std = d.standard;
    const sel = (key, vals, fmt) => {
      const cur = o[key];
      const list = vals.includes(cur) ? vals : [...vals, cur].sort((a, b) => a - b);
      return `<select data-om-set="${key}">${list.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${fmt(v)}</option>`).join("")}</select>`;
    };
    const skaler = o.skaler;
    const std2 = (key, fmt) => (o[key] !== std[key] ? ` · standard ${fmt(std[key])}` : "");
    const par = (obj, enh) => Object.entries(obj || {}).map(([k, v]) => `${k} = ${v}${enh}`).join("\n");
    el.innerHTML = `
      <div class="kort">
        <label class="felt"><span class="fl">Skalér til familien<small>Ellers bruges opskriftens egne mængder</small></span>
          <input type="checkbox" class="om-sw" data-om-set="skaler" ${skaler ? "checked" : ""} /></label>
        <label class="felt ${skaler ? "" : "om-dim"}"><span class="fl">Kød pr. aftensmad<small>Når kød/fisk er hovedingrediensen${std2("koed_g", (v) => v + " g")}</small></span>
          <span class="fv">${sel("koed_g", SKALER_KOED, (v) => `${v} g`)}</span></label>
        <label class="felt ${skaler ? "" : "om-dim"}"><span class="fl">Portioner<small>Retter uden (meget) kød${std2("portioner", (v) => v + " portioner")}</small></span>
          <span class="fv">${sel("portioner", SKALER_PORT, (v) => `${v} portioner`)}</span></label>
        <label class="felt ${skaler ? "" : "om-dim"}"><span class="fl">Kød styrer fra<small>Kød pr. portion i opskriften${std2("koed_taerskel", (v) => v + " g")}</small></span>
          <span class="fv">${sel("koed_taerskel", SKALER_TAERSKEL, (v) => `${v} g/portion`)}</span></label>
        <label class="felt ${skaler ? "" : "om-dim"}"><span class="fl">Skalér mindst<small>${std2("faktor_min", (v) => "×" + brok(v)).replace(" · ", "")}</small></span>
          <span class="fv">${sel("faktor_min", SKALER_MIN, (v) => `×${brok(v)}`)}</span></label>
        <label class="felt ${skaler ? "" : "om-dim"}"><span class="fl">Skalér højst<small>${std2("faktor_max", (v) => "×" + brok(v)).replace(" · ", "")}</small></span>
          <span class="fv">${sel("faktor_max", SKALER_MAX, (v) => `×${brok(v)}`)}</span></label>
      </div>
      <p class="fod">En opskrift med 4 × 150 g kød skaleres til ${o.koed_g} g kød (×${brok(Math.round((o.koed_g / 600) * 100) / 100)}). Uden meget kød skaleres den til ${o.portioner} portioner. Lav dobbelt (×2) vælges, når retten lægges på listen.</p>

      <h3 class="gruppe om-sub">Enheder</h3>
      <div class="kort">
        ${ENH_FELTER.map(([k, l, e]) => `<label class="felt"><span class="fl">${l}${o[k] !== std[k] ? `<small>Standard: ${talTekst(std[k])} ${e}</small>` : ""}</span>
          <span class="fv om-tal"><input type="text" inputmode="decimal" data-om-set="${k}" value="${talTekst(o[k])}" aria-label="${l} i ${e}" /><span>${e}</span></span></label>`).join("")}
        <div class="felt"><span class="fl">Teske og spiseske<small>${o.skeer === "ml" ? "tsk = 5 ml, spsk = 15 ml" : "Står som tsk og spsk"}</small></span>
          <span class="om-seg"><button type="button" data-om="skeer" data-v="tsk_spsk" aria-pressed="${o.skeer !== "ml"}">tsk/spsk</button><button type="button" data-om="skeer" data-v="ml" aria-pressed="${o.skeer === "ml"}">ml</button></span></div>
        <label class="felt"><span class="fl">Afrund mængder<small>Til noget man kan købe og måle (fx 425 g, ½ dl)</small></span>
          <input type="checkbox" class="om-sw" data-om-set="afrund" ${o.afrund ? "checked" : ""} /></label>
      </div>
      <p class="fod">Gram, kilo, liter og ml står som de er. Cups bliver til dl, pounds og ounces til gram (væsker til ml), inch til cm.</p>

      <h3 class="gruppe om-sub">Har vi altid</h3>
      <div class="kort">
        <label class="felt lodret"><span class="fl">Kommer ikke på indkøbslisten<small>Adskil med komma</small></span>
          <textarea data-om-set="har_vi_altid" rows="4" autocapitalize="sentences">${esc((o.har_vi_altid || []).join(", "))}</textarea></label>
      </div>
      <details class="fod std om-det"><summary>Vægt pr. stk og egne varenavne</summary>
        <div class="kort">
          <label class="felt lodret"><span class="fl">Kød i stk – gram pr. stk<small>Bruges til skaleringen, fx "Kyllingebryst = 150"</small></span>
            <textarea data-om-set="stk_vaegt" rows="5">${esc(par(o.stk_vaegt, ""))}</textarea></label>
          <label class="felt lodret"><span class="fl">Egne varenavne<small>Ét pr. linje, fx "Piskefløde = Madlavningsfløde"</small></span>
            <textarea data-om-set="navne" rows="3" placeholder="Piskefløde = Madlavningsfløde">${esc(par(o.navne, ""))}</textarea></label>
        </div>
      </details>
      <p class="fod om-ops" id="om-ops"></p>
      <h3 class="gruppe om-sub">Eksempel</h3>
      <div class="kort om-eks">
        <label class="felt"><span class="fl">Opskrift</span><span class="fv"><select id="om-eks-valg" aria-label="Eksempel-opskrift"></select></span></label>
        <div class="felt lodret" id="om-eks"></div>
      </div>
      <div class="kort om-nulstil">
        <button type="button" class="felt knap fare" data-om="nulstil" ${d.aendret.length ? "" : "disabled"}>${this._nulstilKlar ? "Tryk igen for at gendanne standard" : "Gendan standard-omregning …"}</button>
      </div>
      <p class="fod">Ændringer gælder alle opskrifter med det samme. Jeres egne rettelser af en rets indkøbsliste røres ikke.</p>
      <p class="fod om-fejl fejl" id="om-fejl" hidden></p>`;
    this._renderOpsummering();
    this._fyldEksValg();
  }

  _renderOpsummering() {
    const el = this.querySelector("#om-ops");
    const p = this._data?.opsummering;
    if (!el || !p) return;
    el.textContent = p.opskrifter
      ? `${p.opskrifter} opskrifter: ${p.koed || 0} skaleres efter kød, ${p.portioner || 0} efter portioner${p.uaendret ? `, ${p.uaendret} uændret` : ""} · ${p.varer} varer i alt · ${p.ikke_tolket} ingredienslinjer kunne ikke tolkes (de står under opskriften).`
      : "Ingen opskrifter importeret endnu – omregningen bruges, når de kommer.";
  }

  _fyldEksValg() {
    const sel = this.querySelector("#om-eks-valg");
    const l = (this._liste?.retter || []).filter((r) => r.type === "opskrift").sort(cmpNavn);
    if (!sel) return;
    if (!l.length) {
      sel.closest(".om-eks").hidden = true;
      return;
    }
    if (!this._eks || !l.some((r) => r.id === this._eks)) {
      const carb = l.find((r) => /carbonara/i.test(r.navn)) || l.find((r) => /bolognese|lasagne/i.test(r.navn)) || l[0];
      this._eks = carb.id;
    }
    sel.innerHTML = l.map((r) => `<option value="${esc(r.id)}" ${r.id === this._eks ? "selected" : ""}>${esc(r.navn)}</option>`).join("");
    sel.onchange = () => {
      this._eks = sel.value;
      lsSet("omr_eks", this._eks);
      this._renderEksempel();
    };
  }

  async _renderEksempel() {
    const el = this.querySelector("#om-eks");
    if (!el || !this._eks) return;
    try {
      const d = await this._store.send("retter/hent", { ret: this._eks });
      const f = String(d.faktor).replace(".", ",");
      el.innerHTML = `<span class="fl"><small>${d.portioner ? `Opskriften er til ${d.portioner}` : "Opskrift"} → ${esc(d.grundlag)} (×${f})${d.rettet ? " · har jeres egen liste – vises her med omregningen" : ""}</small></span>
        <ul class="om-varer">${d.standard_varer.map((v) => `<li><span>${esc(v.navn)}</span><span>${esc(v.tekst)}</span></li>`).join("")}</ul>
        ${d.har_vi_altid.length ? `<small class="om-dimt">Har vi altid: ${esc(d.har_vi_altid.join(", "))}</small>` : ""}`;
    } catch (e) {
      el.innerHTML = `<small class="fejl">${esc(e.message || "Kunne ikke vise eksemplet")}</small>`;
    }
  }

  async _changed(e) {
    const el = e.target.closest("[data-om-set]");
    if (!el) return;
    const key = el.dataset.omSet;
    let v;
    if (el.type === "checkbox") v = el.checked;
    else if (el.tagName === "SELECT") v = parseFloat(el.value);
    else v = el.value;
    await this._gem({ [key]: v });
  }

  async _gem(aendringer) {
    const fejl = this.querySelector("#om-fejl");
    emit(this, "im-status", "Gemmer …");
    try {
      this._data = await this._store.send("omregning/saet", { aendringer });
      if (fejl) fejl.hidden = true;
      emit(this, "im-status", "Gemt");
      this._nulstilKlar = false;
      this._render();
      this._renderEksempel();
    } catch (err) {
      emit(this, "im-status", "Kunne ikke gemme");
      if (fejl) {
        fejl.textContent = err.message || "Kunne ikke gemme";
        fejl.hidden = false;
      }
    }
  }

  async _nulstil(btn) {
    if (!this._nulstilKlar) {
      this._nulstilKlar = true;
      btn.textContent = "Tryk igen for at gendanne standard";
      clearTimeout(this._nt);
      this._nt = setTimeout(() => {
        this._nulstilKlar = false;
        btn.textContent = "Gendan standard-omregning …";
      }, 4000);
      return;
    }
    this._nulstilKlar = false;
    try {
      this._data = await this._store.send("omregning/saet", { nulstil: true });
      emit(this, "im-status", "Standard gendannet");
      this._render();
      this._renderEksempel();
    } catch (err) {
      emit(this, "im-status", "Kunne ikke gendanne");
    }
  }
}

/* ====================================================================== CSS */
const RETTER_CSS = `
  im-retter { display: block; }
  .rt-frem { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 12px; font-size: 14px; color: var(--im-dim); }
  .rt-frem b { color: var(--im-text); }
  .rt-bar { height: 6px; border-radius: 3px; background: var(--im-bg2); overflow: hidden; }
  .rt-bar i { display: block; height: 100%; border-radius: 3px; background: var(--rt-ok, #34a853); }
  .rt-sog { width: 100%; box-sizing: border-box; font: inherit; font-size: 17px; padding: 10px 14px; border-radius: 12px;
            border: 0; background: var(--im-bg2); color: var(--im-text); -webkit-appearance: none; appearance: none; }
  .rt-seg { display: flex; margin: 12px 0 8px; padding: 2px; border-radius: 9px; background: var(--im-bg2); }
  .rt-seg button { flex: 1; min-height: 32px; border-radius: 7px; font-size: 13px; font-weight: 600; color: var(--im-text); white-space: nowrap; padding: 0 4px; }
  .rt-seg button[aria-pressed=true] { background: var(--im-bg); box-shadow: 0 1px 4px rgba(0,0,0,.14); }
  .rt-kb { display: flex; gap: 6px; overflow-x: auto; padding: 2px 0 8px; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
  .rt-kb::-webkit-scrollbar { display: none; }
  .rt-chip { flex: none; padding: 6px 12px; border-radius: 999px; font-size: 14px; background: var(--im-bg2); color: var(--im-text); white-space: nowrap; }
  .rt-chip small { color: var(--im-dim); margin-left: 2px; }
  .rt-chip[aria-pressed=true] { background: var(--im-acc); color: #fff; }
  .rt-chip[aria-pressed=true] small { color: rgba(255,255,255,.8); }
  .rt-liste { display: flex; flex-direction: column; }
  .rt-r { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 60px; padding: 6px 0; text-align: left;
          border-bottom: 1px solid var(--im-line); }
  .rt-r:active { background: var(--im-bg2); }
  .rt-th { flex: none; width: 46px; height: 46px; border-radius: 10px; overflow: hidden; background: var(--im-bg2);
           display: inline-flex; align-items: center; justify-content: center; font-size: 22px; }
  .rt-th img { width: 100%; height: 100%; object-fit: cover; }
  .rt-rt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .rt-rt b { font-weight: 600; font-size: 16px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .rt-rt small { font-size: 13px; color: var(--im-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt-b { flex: none; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 10px; white-space: nowrap; }
  .rt-b.ok { color: var(--rt-ok, #1e8e3e); background: color-mix(in srgb, var(--rt-ok, #34a853) 14%, transparent); }
  .rt-b.mangler { color: var(--im-dim); border: 1px dashed var(--im-dim); opacity: .85; }
  .rt-chev { flex: none; color: var(--im-dim); font-size: 22px; opacity: .6; margin-left: -4px; }
  .rt-ingen { color: var(--im-dim); margin: 18px 4px; }
  .rt-fod { font-size: 13px; color: var(--im-dim); margin: 14px 4px 0; }
  .rt-kort { background: var(--im-bg2); border-radius: 12px; padding: 14px 16px; margin: 6px 0 14px; }
  .rt-kort p { margin: 6px 0 10px; color: var(--im-dim); line-height: 1.4; font-size: 15px; }
  .rt-knap { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 18px;
             border-radius: 12px; background: var(--im-acc); color: #fff; font-weight: 600; font-size: 16px; }
  .rt-knap.sek { background: var(--im-bg2); color: var(--im-acc); }
  .rt-knap.lille { min-height: 34px; padding: 0 14px; font-size: 14px; }
  .rt-knap:disabled { opacity: .45; }
  /* ark */
  .rt-scrim { position: fixed; inset: 0; z-index: 45; background: rgba(0,0,0,0); display: flex; align-items: flex-end; justify-content: center;
              transition: background .22s; }
  .rt-scrim.inde { background: rgba(0,0,0,.35); }
  .rt-ark { width: 100%; max-width: 620px; height: calc(100% - 28px - var(--safe-area-inset-top, 0px)); box-sizing: border-box;
            background: var(--im-bg); border-radius: 14px 14px 0 0; display: flex; flex-direction: column;
            transform: translateY(100%); transition: transform .22s ease-out; box-shadow: 0 -8px 30px rgba(0,0,0,.25); }
  .rt-scrim.inde .rt-ark { transform: none; }
  .rt-ah { display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 0 8px; border-bottom: 1px solid var(--im-line); flex: none; }
  .rt-hk { min-width: 76px; min-height: 44px; color: var(--im-acc); font-size: 17px; text-align: left; padding: 0 8px; }
  .rt-hk.fed { font-weight: 700; text-align: right; }
  .rt-hk:disabled { opacity: .35; }
  .rt-at { flex: 1; min-width: 0; text-align: center; font-weight: 600; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt-ab { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0 18px calc(28px + var(--safe-area-inset-bottom, 0px)); }
  .rt-hero { display: block; width: calc(100% + 36px); margin: 0 -18px; max-height: 240px; object-fit: cover; }
  .rt-titel { font-size: 24px; font-weight: 800; letter-spacing: -.02em; margin: 14px 0 2px; line-height: 1.15; }
  .rt-meta { color: var(--im-dim); font-size: 14px; margin: 2px 0 12px; line-height: 1.4; }
  .rt-handl { display: flex; gap: 8px; margin: 4px 0 6px; }
  .rt-handl .rt-knap:first-child { flex: 1; }
  .rt-gr { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--im-dim); margin: 20px 0 4px; }
  .rt-varer { list-style: none; margin: 0; padding: 0; }
  .rt-varer li { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--im-line); font-size: 16px; }
  .rt-m { color: var(--im-dim); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .rt-note { font-size: 13px; color: var(--im-dim); margin: 8px 0; line-height: 1.4; }
  .rt-note.adv { color: var(--warning-color, #b26b00); }
  .rt-links { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; margin: 14px 0 4px; }
  .rt-link { color: var(--im-acc); font-weight: 600; text-decoration: none; padding: 8px 0; }
  .rt-orig { margin: 10px 0; font-size: 14px; }
  .rt-orig summary { color: var(--im-acc); cursor: pointer; padding: 6px 0; }
  .rt-orig ul { margin: 6px 0; padding-left: 18px; color: var(--im-dim); line-height: 1.5; }
  .rt-kobl { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--im-line); }
  .rt-kobl img, .rt-th0 { width: 44px; height: 44px; border-radius: 10px; object-fit: cover; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--im-bg2); }
  .rt-kobl span { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .rt-kobl small { color: var(--im-dim); font-size: 12px; }
  /* rediger */
  .rt-nynavn { width: 100%; box-sizing: border-box; font: inherit; font-size: 22px; font-weight: 700; margin: 14px 0 4px; padding: 8px 0;
               border: 0; border-bottom: 1px solid var(--im-line); background: transparent; color: var(--im-text); outline: none; }
  .rt-fz { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 4px; }
  .rt-fzc { display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 999px; font-size: 14px;
            background: var(--im-frost-bg, var(--im-bg2)); color: var(--im-frost, var(--im-text)); font-weight: 600; }
  .rt-fzc button { font-size: 17px; line-height: 1; padding: 0 2px 0 4px; color: inherit; min-width: 24px; min-height: 24px; }
  .rt-fzadd { display: flex; gap: 8px; align-items: center; margin: 10px 0 6px; }
  .rt-fzadd input { flex: 1; min-width: 0; font: inherit; font-size: 16px; box-sizing: border-box; padding: 10px 12px; border-radius: 10px;
                    border: 0; background: var(--im-bg2); color: var(--im-text); -webkit-appearance: none; }
  .rt-fzi { display: flex; align-items: center; gap: 8px; font-size: 15px; margin: 8px 0; }
  .rt-fzi input { width: 20px; height: 20px; accent-color: var(--im-acc); margin: 0; }
  .rt-fl { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 6px 0 10px; font-size: 14px; color: var(--im-dim); }
  .rt-se { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
  .rt-se .rt-chip { min-height: 36px; display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; }
  .rt-se span.rt-chip { min-height: 30px; padding: 4px 12px; font-weight: 600; }
  .rt-fl .rt-chip { border: 1px dashed var(--im-acc); background: none; color: var(--im-acc); }
  .rt-vh, .rt-vr { display: grid; grid-template-columns: 1fr 64px 76px 36px; gap: 6px; align-items: center; }
  .rt-vh { font-size: 12px; color: var(--im-dim); padding: 4px 0; }
  .rt-vr { border-bottom: 1px solid var(--im-line); padding: 4px 0; }
  .rt-vr input, .rt-vr select { font: inherit; font-size: 16px; min-width: 0; box-sizing: border-box; padding: 8px 6px; border-radius: 8px;
                                border: 1px solid transparent; background: transparent; color: var(--im-text); }
  .rt-vr input:focus, .rt-vr select:focus { border-color: var(--im-line); background: var(--im-bg2); outline: none; }
  .rt-vr .rt-vm { text-align: right; }
  .rt-vr select { -webkit-appearance: none; appearance: none; color: var(--im-acc); }
  .rt-x { width: 26px; height: 26px; border-radius: 50%; background: var(--error-color, #e5484d); color: #fff; font-weight: 700; font-size: 18px; line-height: 1; justify-self: end; }
  .rt-fejl { margin: 10px 0; }
  @media (max-width: 380px) { .rt-vh, .rt-vr { grid-template-columns: 1fr 52px 66px 30px; } .rt-seg button { font-size: 12px; } }
  @media (prefers-reduced-motion: reduce) { .rt-ark, .rt-scrim { transition: none; } }
`;

const OMR_CSS = `
  im-omregning { display: block; }
  .om-sub { margin-top: 18px !important; }
  .om-dim { opacity: .45; }
  .om-tal { display: inline-flex; align-items: center; gap: 6px; flex: none; }
  .indst .om-tal input { width: 76px; flex: none; text-align: right; font: inherit; font-size: 16px; padding: 6px 8px; border-radius: 8px;
                  border: 1px solid var(--im-line); background: var(--im-bg); color: var(--im-text); }
  .om-tal span { color: var(--im-dim); min-width: 22px; }
  .om-sw { width: 46px; height: 28px; flex: none; -webkit-appearance: none; appearance: none; border-radius: 14px; background: var(--im-line);
           position: relative; cursor: pointer; transition: background .15s; margin: 0; }
  .om-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 24px; height: 24px; border-radius: 50%; background: #fff;
                  box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .15s; }
  .om-sw:checked { background: var(--rt-ok, #34c759); }
  .om-sw:checked::after { transform: translateX(18px); }
  .om-seg { display: inline-flex; padding: 2px; border-radius: 9px; background: var(--im-bg); flex: none; }
  .om-seg button { min-height: 30px; padding: 0 12px; border-radius: 7px; font-size: 14px; font-weight: 600; }
  .om-seg button[aria-pressed=true] { background: var(--im-acc); color: #fff; }
  .indst textarea { font: inherit; font-size: 15px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--im-line);
                    background: var(--im-bg); color: var(--im-text); resize: vertical; line-height: 1.4; }
  .om-det { margin-top: 14px !important; }
  .om-det .kort { margin-top: 8px; }
  .om-ops { margin-top: 10px !important; }
  .om-varer { list-style: none; margin: 4px 0; padding: 0; font-size: 15px; }
  .om-varer li { display: flex; justify-content: space-between; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--im-line); }
  .om-varer li span:last-child { color: var(--im-dim); white-space: nowrap; }
  .om-dimt { color: var(--im-dim); font-size: 13px; }
  .om-nulstil { margin-top: 18px; }
  .indst .om-fejl { color: var(--error-color, #d93025); font-weight: 600; }
  .om-nulstil .knap:disabled { opacity: .4; }
`;

if (!customElements.get("im-retter")) customElements.define("im-retter", ImRetter);
if (!customElements.get("im-omregning")) customElements.define("im-omregning", ImOmregning);
