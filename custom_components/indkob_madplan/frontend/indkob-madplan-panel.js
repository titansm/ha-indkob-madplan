/* Indkøb & Madplan – sidepanel i Home Assistant (noter à la iOS Noter). */
import {
  BASE_CSS, Checklist, aftenHTML, clearResume, esc, forslagHTML, getStore, lsGet, lsSet, markResume, nyUgeSkabelon,
  relTime, scrollerOf, statsHTML,
} from "./im-common.js?v=0.3.3";

const NOTES = [
  { id: "indkob", title: "Indkøbsliste" },
  { id: "madplan", title: "Madplan" },
  { id: "historik", title: "Indkøbshistorik" },
  { id: "stats", title: "Statistik" },
  { id: "log", title: "Redigeringslog" },
  { id: "indstillinger", title: "Indstillinger" },
];

const MDR = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];
const kr = (v) => {
  v = Number(v) || 0;
  const d = Number.isInteger(v) ? 0 : 2;
  return v.toLocaleString("da-DK", { minimumFractionDigits: d, maximumFractionDigits: d }) + " kr";
};
const parseKr = (t) => {
  t = String(t || "").replace(/kr\.?/i, "").replace(/\s/g, "");
  if (/,/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  const v = parseFloat(t);
  return isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
};
const mdNavn = (ym) => { const [y, m] = ym.split("-"); return MDR[+m - 1] + (y == new Date().getFullYear() ? "" : " " + y); };
const dagTid = (iso) => {
  const t = new Date(iso).toLocaleString("da-DK", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return t[0].toUpperCase() + t.slice(1);
};
const iDag = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

/* "1,5 timer", "½ time", "3 timer" */
const fmtTimer = (h) => {
  h = Number(h) || 0;
  if (h === 0.5) return "en halv time";
  if (h === 1) return "1 time";
  return String(h).replace(".", ",") + " timer";
};

class IndkobMadplanPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._open = lsGet("open", null); // null = notelisten (smal skærm)
    // ?note=indkob / madplan / stats (fx fra en genvej på hjemmeskærmen)
    const want = new URLSearchParams(location.search).get("note");
    if (want && NOTES.some((n) => n.id === want)) {
      this._open = want;
      lsSet("open", want);
    }
    this._scrollRestored = false;
    this._onHide = () => {
      if (document.visibilityState === "hidden") this._saveScroll();
      if (document.visibilityState === "hidden" && this._open === "indkob" && location.pathname.startsWith("/indkob-madplan")) markResume();
    };
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

  connectedCallback() {
    document.addEventListener("visibilitychange", this._onHide);
    window.addEventListener("pagehide", this._onHide);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onHide);
    window.removeEventListener("pagehide", this._onHide);
    this._saveScroll();
    // Forlader man panellet med vilje (appen er synlig), skal det ikke genoptages.
    if (document.visibilityState === "visible") clearResume();
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
              <details class="hjaelp" id="hjaelp">
                <summary>ⓘ Sådan virker indkøbslisten</summary>
                <div id="hjaelp-body"></div>
              </details>
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
            <section id="v-historik" class="pane hist">
              <h2 class="titel">Indkøbshistorik</h2>
              <p class="meta">Hvornår I har handlet – tryk på et indkøb for at skrive butik og pris.</p>
              <div id="hist-sum"></div>
              <button class="ny-tur" data-act="ny-tur">+ Tilføj indkøb uden listen</button>
              <div id="hist-ny"></div>
              <div id="hist-liste"></div>
              <datalist id="butikker"></datalist>
            </section>
            <section id="v-log" class="pane logpane">
              <h2 class="titel">Redigeringslog</h2>
              <p class="meta">Hvem har ændret hvad – de seneste 150 ændringer.</p>
              <div id="log-liste"></div>
            </section>
            <section id="v-stats" class="pane stats">
              <h2 class="titel">Statistik</h2>
              <div id="stats-body"></div>
            </section>
            <section id="v-indstillinger" class="pane indst">
              <h2 class="titel">Indstillinger</h2>
              <p class="meta">Gælder for hele familien. Ændringer gemmes med det samme.</p>

              <h3 class="gruppe">Handlet ind</h3>
              <div class="kort">
                <label class="felt">
                  <span class="fl">Regn det som handlet ind ved</span>
                  <span class="fv"><select id="s-taerskel" data-set="handlet_taerskel"></select></span>
                </label>
                <label class="felt">
                  <span class="fl">Fjern fluebenene efter</span>
                  <span class="fv"><select id="s-timer" data-set="handlet_timer"></select></span>
                </label>
              </div>
              <p class="fod">Når den valgte andel af varerne er krydset af, registreres en indkøbstur. Fluebenene fjernes automatisk, når tiden er gået efter <b>sidste</b> flueben, og turen gemmes i statistikken.</p>

              <h3 class="gruppe">Optøning</h3>
              <div class="kort">
                <label class="felt radio"><span class="fl">Retten i dag<small>Påmindelsen gælder dagens aftensmad</small></span>
                  <input type="radio" name="frost" value="i_dag" data-set="frost_day" /></label>
                <label class="felt radio"><span class="fl">Retten i morgen<small>Påmindelsen kommer dagen før</small></span>
                  <input type="radio" name="frost" value="i_morgen" data-set="frost_day" /></label>
              </div>
              <p class="fod">Styrer "Tag kød op af fryseren" og ❄-linjen. Notifikationen kl. 10 sendes af en automation i Home Assistant.</p>

              <h3 class="gruppe">Kød-ord</h3>
              <div class="kort">
                <label class="felt lodret"><span class="fl">Ekstra ord, der kræver optøning</span>
                  <input type="text" id="s-ekstra" data-set="extra_koed_ord" placeholder="fx tacos, nasi goreng" autocomplete="off" /></label>
                <label class="felt lodret"><span class="fl">Ord, der IKKE kræver optøning</span>
                  <input type="text" id="s-ignorer" data-set="ignorer_ord" placeholder="fx bacon" autocomplete="off" /></label>
              </div>
              <details class="fod std"><summary>Standard-ord</summary><p id="s-std"></p></details>

              <h3 class="gruppe">Statistik</h3>
              <div class="kort">
                <button class="felt knap fare" data-act="nulstil-stats">Nulstil statistik …</button>
              </div>
              <p class="fod">Sletter alle registrerede køb og indkøbsture. Selve listen og madplanen røres ikke.</p>

              <p class="fod version" id="s-version"></p>
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
    r.getElementById("v-indstillinger").addEventListener("change", (e) => this._settingChanged(e));
    r.getElementById("v-indstillinger").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches("input[type=text]")) e.target.blur();
    });
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
    this._renderHelp();
    this._renderSettings();
    this._renderHistorik();
    this._renderLog();
    if (!this._scrollRestored) {
      this._scrollRestored = true;
      const y = lsGet("scroll_" + (this._open || ""), 0);
      if (y) requestAnimationFrame(() => requestAnimationFrame(() => (scrollerOf(this.shadowRoot.getElementById("ark")).scrollTop = y)));
    }
  }

  _saveScroll() {
    const ark = this.shadowRoot?.getElementById("ark");
    if (ark && this._open) lsSet("scroll_" + this._open, Math.round(scrollerOf(ark).scrollTop));
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
      if (id === "historik") {
        const h = s.historik;
        const m = h?.maaneder?.[0];
        if (!h?.ture?.length) return "Ingen indkøb endnu";
        return `Sidst ${relTime(h.ture[0].t)}` + (m && m.beloeb ? ` · ${mdNavn(m.maaned)}: ${kr(m.beloeb)}` : "");
      }
      if (id === "log") {
        const l = s.log?.[0];
        return l ? `${relTime(l.t)} · ${esc(l.bruger)} ${esc(l.tekst)}` : "Ingen ændringer endnu";
      }
      if (id === "indstillinger") {
        const i = s.indstillinger;
        return i ? `Handlet ind ved ${i.handlet_taerskel} % · flueben fjernes efter ${fmtTimer(i.handlet_timer)}` : "";
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

  /* ------------------------------------------------------------ hjælp */
  _renderHelp() {
    const s = this._state;
    const t = s.indkob.tur || {};
    const pct = t.taerskel ?? 50;
    const tim = fmtTimer(t.timer ?? 3);
    this.shadowRoot.getElementById("hjaelp-body").innerHTML = `
      <p><b>En fast liste.</b> Varerne bliver stående efter indkøb – det er kun fluebenene, der fjernes. Varer I ikke længere køber, sletter I bare.</p>
      <p><b>Kryds af, når varen ryger i kurven.</b> Hvert flueben tæller som et køb i statistikken. Fjerner du et flueben igen inden for 12 timer, regnes det som fortrudt.</p>
      <p><b>Handlet ind.</b> Når mindst ${pct} % af varerne er krydset af, registreres en indkøbstur. ${tim[0].toUpperCase() + tim.slice(1)} efter <i>sidste</i> flueben fjernes alle flueben automatisk, og turen gemmes under Statistik → Seneste indkøb. Kommer listen under ${pct} % igen, annulleres turen.</p>
      <p><b>Færdig før tid?</b> ⋯ → "Færdig med at handle" fjerner fluebenene med det samme. "Slet afkrydsede varer" fjerner varerne helt fra listen.</p>
      <p><b>Nye varer</b> skrives i feltet øverst og lander under den overskrift, de plejer at stå under. Træk i ≡ for at flytte en vare – placeringen huskes til næste gang.</p>
      <p><b>Overskrifter:</b> Aa gør linjen til overskrift. Enter giver en ny linje, Backspace på en tom linje sletter den.</p>
      <p><b>Forslag</b> over listen er varer, I plejer at købe, som mangler nu. Tryk for at tilføje.</p>
      <p><b>Indkøbshistorik:</b> hver indkøbstur gemmes med dato og varer. Tryk på turen for at skrive butik og pris – flere butikker pr. tur går fint. Handler I uden listen, kan I tilføje indkøbet selv.</p>
      <p><b>Redigeringslog:</b> viser hvem der har tilføjet, rettet, krydset af eller slettet hvad.</p>
      <p><b>Stemme:</b> Assist og Claude kan tilføje varer, fx "tilføj mælk til indkøbslisten".</p>
      <p class="dim">Andel og tid ændres under Noter → <button class="link" data-note="indstillinger">Indstillinger</button>.</p>`;
  }

  /* ------------------------------------------------------------ indkøbshistorik */
  _renderHistorik(force = false) {
    const h = this._state?.historik;
    const r = this.shadowRoot;
    if (!h) return;
    // Er man i gang med at skrive en pris, må listen ikke tegnes om under fingrene.
    const ed = !force && (this._openTrip || r.getElementById("hist-ny").innerHTML || r.activeElement?.closest?.(".tur-edit"));
    r.getElementById("butikker").innerHTML = (h.butikker || []).map((b) => `<option value="${esc(b.navn)}"></option>`).join("");
    const md = (h.maaneder || []).slice(0, 6);
    r.getElementById("hist-sum").innerHTML = md.length ? `<div class="mdr">${md.map((m) => `
        <div class="md"><span class="mn">${mdNavn(m.maaned)}</span>
          <span class="mb">${m.beloeb ? kr(m.beloeb) : "–"}</span>
          <span class="mt">${m.ture} ${m.ture === 1 ? "tur" : "ture"}${m.med_pris < m.ture ? ` · ${m.ture - m.med_pris} uden pris` : ""}</span></div>`).join("")}</div>
      ${(h.butikker || []).length ? `<p class="fod">Butikker: ${h.butikker.slice(0, 6).map((b) => `${esc(b.navn)} ${b.gange}×`).join(" · ")}</p>` : ""}` : "";
    if (ed) return;
    let lastM = "";
    r.getElementById("hist-liste").innerHTML = (h.ture || []).length
      ? h.ture.map((t) => {
          const m = t.t.slice(0, 7);
          const head = m !== lastM ? `<h3 class="gruppe">${mdNavn(m)}</h3>` : "";
          lastM = m;
          const open = this._openTrip === t.id;
          const butik = t.betalinger.map((b) => esc(b.butik || "ukendt butik")).join(" + ");
          return `${head}<div class="tur ${open ? "aaben" : ""}" data-tur="${t.id}">
            <button class="tur-top" data-act="tur" data-id="${t.id}">
              <span class="tt">${dagTid(t.t)}<small>${t.manuel ? "Tilføjet manuelt" : t.varer.length + (t.varer.length === 1 ? " vare" : " varer") + (t.auto ? "" : " · afsluttet manuelt")}${butik ? " · " + butik : ""}</small></span>
              <span class="tp ${t.total ? "" : "mangler"}">${t.total ? kr(t.total) : "+ pris"}</span>
            </button>
            ${open ? this._turEditHTML(t) : ""}
          </div>`;
        }).join("")
      : `<p class="tom-tekst">Når I handler ind efter listen, dukker indkøbet op her automatisk.</p>`;
  }

  _betRaekke(b = {}) {
    return `<div class="bet">
      <input class="b-butik" list="butikker" placeholder="Butik" value="${esc(b.butik || "")}" autocomplete="off" />
      <input class="b-beloeb" inputmode="decimal" placeholder="Beløb" value="${b.beloeb ? String(b.beloeb).replace(".", ",") : ""}" autocomplete="off" />
      <span class="b-kr">kr</span>
      <button class="b-fjern" data-act="bet-fjern" aria-label="Fjern butik">×</button>
    </div>`;
  }

  _turEditHTML(t) {
    const bet = t.betalinger.length ? t.betalinger : [{}];
    return `<div class="tur-edit">
      <div class="bets">${bet.map((b) => this._betRaekke(b)).join("")}</div>
      <button class="link" data-act="bet-ny">+ Endnu en butik</button>
      ${t.varer.length ? `<p class="fod">Købt: ${esc(t.varer.join(", "))}</p>` : ""}
      <div class="tur-knapper">
        <button class="fare" data-act="tur-slet" data-id="${t.id}">Slet indkøb</button>
        <button class="gem" data-act="tur-gem" data-id="${t.id}">Gem</button>
      </div>
    </div>`;
  }

  _laesBetalinger(box) {
    const out = [];
    let fejl = false;
    for (const row of box.querySelectorAll(".bet")) {
      const butik = row.querySelector(".b-butik").value.trim();
      const raw = row.querySelector(".b-beloeb").value.trim();
      const beloeb = raw ? parseKr(raw) : 0;
      row.querySelector(".b-beloeb").classList.toggle("fejl", beloeb === null);
      if (beloeb === null) fejl = true;
      if (butik || beloeb) out.push({ butik, beloeb: beloeb || 0 });
    }
    return fejl ? null : out;
  }

  /* ------------------------------------------------------------ redigeringslog */
  _renderLog() {
    const log = this._state?.log || [];
    const el = this.shadowRoot.getElementById("log-liste");
    let lastDay = "";
    const dag = (iso) => new Date(iso).toLocaleDateString("da-DK", { weekday: "long", day: "numeric", month: "long" });
    const NOTE = { indkob: "🛒", madplan: "🍽", historik: "🧾", indstillinger: "⚙︎", statistik: "📊" };
    el.innerHTML = log.length
      ? log.map((l) => {
          const d = dag(l.t);
          const head = d !== lastDay ? `<h3 class="gruppe">${d}</h3>` : "";
          lastDay = d;
          const kl = new Date(l.t).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
          return `${head}<div class="lg"><span class="lk">${kl}</span><span class="li">${NOTE[l.note] || "•"}</span>
            <span class="lt"><b>${esc(l.bruger)}</b> ${esc(l.tekst)}</span></div>`;
        }).join("")
      : `<p class="tom-tekst">Ændringer fra nu af vises her.</p>`;
  }

  /* ------------------------------------------------------------ indstillinger */
  _renderSettings() {
    const i = this._state?.indstillinger;
    if (!i) return;
    const r = this.shadowRoot;
    const focus = r.activeElement;
    const fill = (sel, values, cur, label) => {
      if (focus === sel) return;
      const vals = values.includes(cur) ? values : [...values, cur].sort((a, b) => a - b);
      sel.innerHTML = vals.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${label(v)}</option>`).join("");
    };
    fill(r.getElementById("s-taerskel"), [25, 30, 40, 50, 60, 70, 75, 80, 90, 100], i.handlet_taerskel, (v) => `${v} % afkrydset`);
    fill(r.getElementById("s-timer"), [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 12, 24], i.handlet_timer, fmtTimer);
    for (const rb of r.querySelectorAll("input[name=frost]")) rb.checked = rb.value === i.frost_day;
    for (const [id, key] of [["s-ekstra", "extra_koed_ord"], ["s-ignorer", "ignorer_ord"]]) {
      const el = r.getElementById(id);
      if (focus !== el && el.value !== i[key]) el.value = i[key];
    }
    r.getElementById("s-std").textContent = i.standard_koed_ord.join(", ") +
      `. Retter med "${i.rest_ord.join('", "')}" kræver aldrig optøning; "fra fryser" gør altid.`;
    r.getElementById("s-version").textContent = `Indkøb & Madplan ${i.version}`;
  }

  async _settingChanged(e) {
    const el = e.target.closest("[data-set]");
    if (!el) return;
    const key = el.dataset.set;
    let v = el.value;
    if (key === "handlet_taerskel") v = parseInt(v, 10);
    if (key === "handlet_timer") v = parseFloat(v);
    if (el.type === "text") v = v.split(",").map((x) => x.trim()).filter(Boolean).join(", ");
    this._setStatus("Gemmer …");
    try {
      await this._store.setSettings({ [key]: v });
      this._setStatus("Gemt");
    } catch (err) {
      this._setStatus("Kunne ikke gemme");
      this._renderSettings();
    }
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
    if (t !== "Gemmer …") this._statusTimer = setTimeout(() => (el.textContent = ""), 1500);
  }

  /* ------------------------------------------------------------ klik */
  async _click(e) {
    const r = this.shadowRoot;
    const note = e.target.closest("[data-note]");
    if (note) {
      this._flushMadplan();
      this._saveScroll();
      this._open = note.dataset.note;
      lsSet("open", this._open);
      lsSet("scroll_" + this._open, 0);
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
      this._saveScroll();
      this._open = null;
      lsSet("open", null);
      clearResume();
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
    } else if (act === "tur") {
      this._openTrip = this._openTrip === b.dataset.id ? null : b.dataset.id;
      this._renderHistorik(true);
    } else if (act === "bet-ny") {
      b.previousElementSibling.insertAdjacentHTML("beforeend", this._betRaekke());
      b.previousElementSibling.lastElementChild.querySelector(".b-butik").focus();
    } else if (act === "bet-fjern") {
      const bets = b.closest(".bets");
      b.closest(".bet").remove();
      if (!bets.children.length) bets.insertAdjacentHTML("beforeend", this._betRaekke());
    } else if (act === "tur-gem") {
      const box = b.closest(".tur-edit");
      const bet = this._laesBetalinger(box);
      if (!bet) return this._setStatus("Tjek beløbet");
      try {
        await this._store.updateTrip(b.dataset.id, bet);
        this._openTrip = null;
        r.activeElement?.blur?.();
        this._setStatus("Gemt");
        this._renderHistorik(true);
      } catch (err) {
        this._setStatus("Kunne ikke gemme");
      }
    } else if (act === "tur-slet") {
      if (!confirm("Slet dette indkøb fra historikken?")) return;
      this._openTrip = null;
      await this._store.deleteTrip(b.dataset.id).catch(() => this._setStatus("Kunne ikke slette"));
      this._renderHistorik(true);
    } else if (act === "ny-tur") {
      const ny = r.getElementById("hist-ny");
      if (ny.innerHTML) { ny.innerHTML = ""; this._renderHistorik(true); return; }
      ny.innerHTML = `<div class="tur aaben"><div class="tur-edit">
        <label class="dato">Dato <input type="date" id="ny-dato" value="${iDag()}" max="${iDag()}" /></label>
        <div class="bets">${this._betRaekke()}</div>
        <button class="link" data-act="bet-ny">+ Endnu en butik</button>
        <div class="tur-knapper"><button data-act="ny-tur">Annullér</button><button class="gem" data-act="ny-tur-gem">Tilføj</button></div>
      </div></div>`;
      ny.querySelector(".b-butik").focus();
    } else if (act === "ny-tur-gem") {
      const ny = r.getElementById("hist-ny");
      const bet = this._laesBetalinger(ny);
      const dato = r.getElementById("ny-dato").value;
      if (!bet || !dato) return this._setStatus(!dato ? "Vælg en dato" : "Tjek beløbet");
      try {
        await this._store.addTrip(dato, bet);
        ny.innerHTML = "";
        this._setStatus("Tilføjet");
        this._renderHistorik(true);
      } catch (err) {
        this._setStatus("Kunne ikke tilføje");
      }
    } else if (act === "nulstil-stats") {
      if (!confirm("Nulstil statistikken?\n\nAlle registrerede køb og indkøbsture slettes. Det kan ikke fortrydes.")) return;
      try {
        await this._store.clearStats();
        this._setStatus("Statistik nulstillet");
      } catch (err) {
        this._setStatus("Kunne ikke nulstille");
      }
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
  .app { display: grid; grid-template-columns: 300px 1fr; grid-template-rows: minmax(0, 1fr); height: 100%; box-sizing: border-box;
         padding-left: var(--safe-area-content-inset-left, 0px); padding-right: var(--safe-area-content-inset-right, 0px); }
  .liste { border-right: 1px solid var(--im-line); background: var(--im-bg2); overflow-y: auto; }
  .note { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--im-bg); height: 100%; }
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

  .hjaelp { margin-top: 28px; padding: 12px 16px; background: var(--im-bg2); border-radius: 14px; font-size: 15px; line-height: 1.45; }
  .hjaelp summary { cursor: pointer; font-weight: 600; color: var(--im-acc); list-style: none; min-height: 28px; display: flex; align-items: center; }
  .hjaelp summary::-webkit-details-marker { display: none; }
  .hjaelp p { margin: 10px 0 0; }
  .hjaelp .dim { color: var(--im-dim); }
  .link { color: var(--im-acc); font: inherit; padding: 0; }

  .hist .gruppe, .logpane .gruppe, .indst .gruppe { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--im-dim); margin: 22px 4px 6px; }
  .indst .kort { background: var(--im-bg2); border-radius: 12px; overflow: hidden; }
  .indst .felt { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 16px; min-height: 28px; font-size: 17px; }
  .indst .felt + .felt { border-top: 1px solid var(--im-line); }
  .indst .felt.lodret { flex-direction: column; align-items: stretch; gap: 6px; }
  .indst .fl { display: flex; flex-direction: column; }
  .indst .fl small { font-size: 13px; color: var(--im-dim); margin-top: 2px; }
  .indst select { font: inherit; font-size: 16px; color: var(--im-acc); background: transparent; border: 0; text-align: right; padding: 4px 0; max-width: 55vw; }
  .indst input[type=text] { font: inherit; font-size: 16px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--im-line);
                            background: var(--im-bg); color: var(--im-text); width: 100%; box-sizing: border-box; }
  .indst input[type=radio] { width: 22px; height: 22px; accent-color: var(--im-acc); flex: none; }
  .indst .knap { width: 100%; text-align: left; font: inherit; font-size: 17px; }
  .indst .fare { color: var(--error-color, #d93025); }
  .hist .fod, .indst .fod { font-size: 13px; color: var(--im-dim); margin: 6px 4px 0; line-height: 1.4; }
  .indst .std summary { cursor: pointer; color: var(--im-acc); }
  .mdr { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; -webkit-overflow-scrolling: touch; }
  .md { flex: none; min-width: 112px; background: var(--im-bg2); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
  .md:first-child { background: color-mix(in srgb, var(--im-acc-strong) 22%, var(--im-bg2)); }
  .mn { font-size: 13px; color: var(--im-dim); text-transform: capitalize; }
  .mb { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .mt { font-size: 12px; color: var(--im-dim); }
  .ny-tur { color: var(--im-acc); font-weight: 600; padding: 14px 0 4px; font-size: 16px; }
  .tur { background: var(--im-bg2); border-radius: 12px; margin-bottom: 8px; overflow: hidden; }
  .tur-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; text-align: left; padding: 11px 14px; font: inherit; }
  .tt { display: flex; flex-direction: column; font-size: 16px; }
  .tt small { font-size: 13px; color: var(--im-dim); margin-top: 2px; }
  .tp { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tp.mangler { color: var(--im-acc); font-weight: 600; }
  .tur-edit { padding: 4px 14px 12px; border-top: 1px solid var(--im-line); }
  .bets { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; }
  .bet { display: grid; grid-template-columns: 1fr 96px auto 36px; gap: 6px; align-items: center; }
  .bet input, .dato input { font: inherit; font-size: 16px; padding: 9px 10px; border-radius: 8px; border: 1px solid var(--im-line);
                            background: var(--im-bg); color: var(--im-text); min-width: 0; box-sizing: border-box; }
  .b-beloeb { text-align: right; font-variant-numeric: tabular-nums; }
  .bet input.fejl { border-color: var(--error-color, #d93025); }
  .b-kr { color: var(--im-dim); font-size: 14px; }
  .b-fjern { font-size: 22px; color: var(--im-dim); min-height: 40px; }
  .dato { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 10px; font-size: 16px; }
  .tur-edit .link { padding: 10px 0 2px; font-size: 15px; font-weight: 600; }
  .tur-knapper { display: flex; justify-content: space-between; margin-top: 12px; }
  .tur-knapper button { font: inherit; font-size: 16px; padding: 8px 4px; min-height: 40px; color: var(--im-acc); }
  .tur-knapper .gem { font-weight: 700; padding: 8px 18px; border-radius: 10px; background: var(--im-acc); color: #fff; }
  .tur-knapper .fare { color: var(--error-color, #d93025); }
  .tom-tekst { color: var(--im-dim); }
  .lg { display: grid; grid-template-columns: 46px 22px 1fr; gap: 6px; padding: 7px 0; border-bottom: 1px solid var(--im-line); font-size: 15px; line-height: 1.35; }
  .lk { color: var(--im-dim); font-variant-numeric: tabular-nums; }
  .li { text-align: center; }
  .lt { overflow-wrap: anywhere; }
  .logpane .gruppe { text-transform: none; }
  .indst .version { margin-top: 28px; text-align: center; }

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
