/* Indkøb & Madplan – sidepanel i Home Assistant (noter à la iOS Noter). */
import {
  BASE_CSS, Checklist, PIN, aftenHTML, autofillHTML, clearResume, esc, forslagHTML, getStore, lsGet, lsSet, markResume,
  nyUgeSkabelon, prettyHeader, relTime, scrollerOf, sidenTekst, statsHTML,
} from "./im-common.js?v=0.12.5";
import "./im-planner.js?v=0.12.5";
import "./im-retter.js?v=0.12.5";
import "./im-ugevarer.js?v=0.12.5";
import "./im-koleskab.js?v=0.12.5";

const NOTES = [
  { id: "indkob", title: "Indkøbsliste" },
  { id: "basis", title: "Basisliste" },
  { id: "koleskab", title: "Køleskab" },
  { id: "madplan", title: "Madplan" },
  { id: "retter", title: "Retter" },
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
    // ?pris (fx fra en notifikation efter indkøbet) åbner "Hvad blev indkøbet?"
    this._wantPris = new URLSearchParams(location.search).has("pris");
    this._scrollRestored = false;
    this._onHide = () => {
      if (document.visibilityState === "hidden") this._saveScroll();
      if (document.visibilityState === "hidden" && this._open === "indkob" && location.pathname.startsWith("/indkob-madplan")) markResume();
    };
    this._hideChecked = lsGet("hideChecked", false);
    this._shop = lsGet("shop", false); // indkøbstilstand: tryk på rækken krydser af, intet tastatur
    this._weekOpen = false;
    this._insp = { tab: "oftest", q: "", data: null, version: null };
    this._mpCaret = null;
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
              <div class="plan-cta pris-cta" id="pris-cta" hidden>
                <button type="button" class="pr-hoved" data-act="pris-aabn">
                  <span class="pc-ikon" aria-hidden="true">🧾</span>
                  <span class="pc-tekst"><b>Hvad blev indkøbet?</b><small id="pris-cta-sub"></small></span>
                  <span class="pc-pil" aria-hidden="true">›</span>
                </button>
                <button type="button" class="pr-luk" data-act="pris-spring" aria-label="Ingen pris – spørg ikke igen" title="Ingen pris – spørg ikke igen">×</button>
              </div>
              <div class="plan-cta pris-cta varer-cta" id="varer-cta-i" hidden>
                <button type="button" class="pr-hoved" data-act="ugevarer">
                  <span class="pc-ikon" aria-hidden="true">🛒</span>
                  <span class="pc-tekst"><b>Varer til ugens retter</b><small class="varer-cta-sub"></small></span>
                  <span class="pc-pil" aria-hidden="true">›</span>
                </button>
                <button type="button" class="pr-luk" data-act="ugevarer-skjul" aria-label="Skjul indtil madplanen ændres" title="Skjul indtil madplanen ændres">×</button>
              </div>
              <form class="hurtig" id="hurtig" autocomplete="off">
                <input id="ny" type="text" enterkeyhint="done" placeholder="Tilføj vare …" aria-label="Tilføj vare" autocapitalize="sentences" />
              </form>
              <div class="forslag" id="af"></div>
              <div class="forslag" id="forslag"></div>
              <div id="cl"></div>
              <button class="ny-linje" data-act="ny-linje">Ny linje</button>
              <div class="butik-fod" id="butik-fod" hidden></div>
              <details class="hjaelp" id="hjaelp">
                <summary>ⓘ Sådan virker indkøbslisten</summary>
                <div id="hjaelp-body"></div>
              </details>
            </section>
            <section id="v-basis" class="pane">
              <h2 class="titel">Basisliste</h2>
              <p class="meta" id="meta-basis"></p>
              <p class="basis-intro">De faste varer. Efter hvert indkøb nulstilles indkøbslisten til denne liste: købte engangsvarer forsvinder, og faste varer, der mangler, kommer tilbage.</p>
              <form class="hurtig" id="hurtig-basis" autocomplete="off">
                <input id="ny-basis" type="text" enterkeyhint="done" placeholder="Tilføj fast vare …" aria-label="Tilføj fast vare" autocapitalize="sentences" />
              </form>
              <div class="forslag" id="af-basis"></div>
              <div id="cl-basis"></div>
              <button class="ny-linje" data-act="ny-linje-basis">Ny linje</button>
              <details class="hjaelp" id="hjaelp-basis">
                <summary>ⓘ Sådan virker basislisten</summary>
                <div>
                  <p><b>Basislisten er jeres faste indkøbsliste.</b> Når et indkøb er afsluttet (automatisk nogle timer efter sidste flueben eller med "Færdig med at handle"), nulstilles indkøbslisten til den: alle flueben fjernes, købte engangsvarer slettes, og faste varer, der er blevet slettet undervejs, sættes tilbage i deres kategori. Engangsvarer, der endnu ikke er købt, bliver stående.</p>
                  <p><b>Rediger her</b> som på indkøbslisten: skriv i feltet øverst, brug ＋ under en kategori, træk i ≡, swipe for at slette. Flueben findes ikke her. Overskrifterne bestemmer, hvor varen lander, når den kommer tilbage på indkøbslisten.</p>
                  <p><b>På indkøbslisten</b> er engangsvarer mærket <i>Engangs</i>. Tryk på mærket for at gøre varen fast, eller markér varen og tryk <i>Fast</i> i værktøjslinjen for at skifte. Nye varer (felt, kort, Assist, ugeplanlægger) er engangsvarer, indtil I gør dem faste.</p>
                </div>
              </details>
            </section>
            <section id="v-koleskab" class="pane">
              <h2 class="titel">Køleskab</h2>
              <p class="meta" id="meta-koleskab"></p>
              <p class="basis-intro">Madvarer I har tilbage. Ugeplanlæggeren bruger dem først – i retterne de første dage i ugen – og en rest tages ud dagen efter, at retten er spist.</p>
              <im-koleskab id="koleskab-el"></im-koleskab>
              <details class="hjaelp">
                <summary>ⓘ Sådan virker køleskabet</summary>
                <div>
                  <p><b>Skriv det, I har tilbage</b> – én ad gangen eller flere med komma, fx "fløde, champignon, ½ peberfrugt". Listen er fælles for familien og står også øverst i ugeplanlæggeren.</p>
                  <p><b>Nok</b> = I skal ikke købe varen: den fjernes fra indkøbslisten med det samme (Fortryd i beskeden), og i "Varer til ugen" er den fravalgt. <b>Lidt</b> = der er lidt tilbage, men ikke nok til ugen: planlæggeren bruger den stadig først, men den købes som normalt. Faste varer fra basislisten (fx skyr) starter som Lidt – tryk for at skifte.</p>
                  <p><b>Planlæg ugen:</b> retter, der bruger resterne, foreslås først og lægges på de første dage. Står resten allerede i en ret i madplanen ("Bruges fre.: …"), planlægges den ikke igen.</p>
                  <p><b>Opbrugt:</b> dagen efter retten tages resten automatisk ud. Rester, ingen ret bruger, bliver stående, til I selv trykker ×.</p>
                </div>
              </details>
            </section>
            <section id="v-madplan" class="pane">
              <h2 class="titel">Madplan</h2>
              <p class="meta" id="meta-madplan"></p>
              <div class="aften" id="aften"></div>
              <button class="plan-cta" id="plan-cta" data-act="planlaeg" hidden>
                <span class="pc-ikon" aria-hidden="true">✨</span>
                <span class="pc-tekst"><b id="plan-cta-titel">Planlæg næste uge</b><small id="plan-cta-sub">Forslag ud fra det, I plejer at spise</small></span>
                <span class="pc-pil" aria-hidden="true">›</span>
              </button>
              <div class="plan-cta pris-cta varer-cta" id="varer-cta-m" hidden>
                <button type="button" class="pr-hoved" data-act="ugevarer">
                  <span class="pc-ikon" aria-hidden="true">🛒</span>
                  <span class="pc-tekst"><b>Varer til ugens retter</b><small class="varer-cta-sub"></small></span>
                  <span class="pc-pil" aria-hidden="true">›</span>
                </button>
                <button type="button" class="pr-luk" data-act="ugevarer-skjul" aria-label="Skjul indtil madplanen ændres" title="Skjul indtil madplanen ændres">×</button>
              </div>
              <details class="insp" id="insp">
                <summary>💡 Inspiration fra tidligere uger</summary>
                <input id="insp-sog" type="search" placeholder="Søg i madplanen, fx karry …" aria-label="Søg i madplanen" autocomplete="off" />
                <div class="insp-faner" id="insp-faner">
                  <button type="button" data-insp="oftest" aria-pressed="true">Oftest</button>
                  <button type="button" data-insp="laenge" aria-pressed="false">Længe siden</button>
                  <button type="button" data-insp="sjaeldent" aria-pressed="false">Sjældent</button>
                </div>
                <div id="insp-liste" class="insp-liste"></div>
                <p class="fod">Tryk på en ret for at sætte den ind i madplanen – på den dag, markøren står på.</p>
              </details>
              <div class="konflikt" id="konflikt" hidden>
                <span id="konflikt-tekst">Madplanen er ændret på en anden enhed.</span>
                <button class="link" data-act="hent-nyeste">Hent nyeste</button>
              </div>
              <textarea id="mp" spellcheck="true" aria-label="Madplan"
                placeholder="Uge 42&#10;Onsdag: kylling i karry&#10;Torsdag: tit nat - pita"></textarea>
            </section>
            <section id="v-retter" class="pane">
              <h2 class="titel">Retter</h2>
              <p class="meta">Alle jeres retter – med indkøbsliste, så de kan lægges på listen med ét tryk.</p>
              <im-retter id="retter-el"></im-retter>
              <details class="hjaelp">
                <summary>ⓘ Sådan virker Retter</summary>
                <div>
                  <p><b>Alle retter samlet:</b> opskrifterne fra ReciMe og jeres egne retter fra madplanen. 🛒 betyder, at retten har en indkøbsliste – så kan den lægges på indkøbslisten med ét tryk (×2 = dobbelt portion til rester).</p>
                  <p><b>Mangler varer:</b> egne retter uden indkøbsliste, dem I spiser oftest øverst. Tryk på en ret → <i>Skriv varerne</i>. Listen huskes, så retten fremover fylder indkøbslisten selv. Er retten en af jeres opskrifter, så tryk <i>Brug</i> – så bruger den opskriftens varer.</p>
                  <p><b>Opskrifternes mængder</b> er omregnet til gram, dl og stk og skaleret til jeres portion (Noter → <button class="link" data-note="indstillinger">Indstillinger</button> → Omregning). Varer, I altid har (salt, olie, krydderier …), kommer ikke på listen. Fremgangsmåden står i ReciMe – tryk <i>Åbn opskriften i ReciMe</i>.</p>
                  <p><b>Rediger</b> retter jeres egen udgave af listen; <i>Gendan</i> går tilbage til opskriftens.</p>
                </div>
              </details>
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

              <h3 class="gruppe">Ugeplanlæggeren</h3>
              <div class="kort">
                <label class="felt">
                  <span class="fl">Kalender<small>Nattevagter, fodbold og aftenaftaler</small></span>
                  <span class="fv"><select id="s-kalender" data-set="madplan_kalender"></select></span>
                </label>
                <div class="felt lodret" id="s-skjulte"></div>
              </div>
              <p class="fod">Planlæggeren kigger i kalenderen for at finde travle aftener, hvor den foreslår nemme retter eller rester.</p>

              <h3 class="gruppe">Kød-ord</h3>
              <div class="kort">
                <label class="felt lodret"><span class="fl">Ekstra ord, der kræver optøning</span>
                  <input type="text" id="s-ekstra" data-set="extra_koed_ord" placeholder="fx tacos, nasi goreng" autocomplete="off" /></label>
                <label class="felt lodret"><span class="fl">Ord, der IKKE kræver optøning</span>
                  <input type="text" id="s-ignorer" data-set="ignorer_ord" placeholder="fx bacon" autocomplete="off" /></label>
              </div>
              <details class="fod std"><summary>Standard-ord</summary><p id="s-std"></p></details>

              <h3 class="gruppe">Omregning af opskrifter</h3>
              <im-omregning id="omregning-el"></im-omregning>

              <h3 class="gruppe">Statistik</h3>
              <div class="kort">
                <button class="felt knap fare" data-act="nulstil-stats">Nulstil statistik …</button>
              </div>
              <p class="fod">Sletter alle registrerede køb og indkøbsture. Selve listen og madplanen røres ikke.</p>

              <p class="fod version" id="s-version"></p>
            </section>
          </div>
          <div class="toast" id="toast" hidden></div>
          <div class="katvalg top" id="butikark" hidden>
            <form class="kv-ark ba" role="dialog" aria-modal="true" aria-labelledby="ba-titel" id="ba-form" autocomplete="off">
              <h3 id="ba-titel">Afslut indkøb</h3>
              <p class="ba-sub" id="ba-sub"></p>
              <div id="ba-felter">
                <div class="ba-chips" id="ba-chips"></div>
                <label class="ba-felt"><span>Butik</span>
                  <input id="ba-butik" type="text" autocapitalize="words" enterkeyhint="next" placeholder="Fx Netto" maxlength="60" /></label>
                <label class="ba-felt"><span>Beløb <i id="ba-valgfrit">(valgfrit)</i></span>
                  <span class="ba-kr"><input id="ba-beloeb" type="text" inputmode="decimal" enterkeyhint="done" placeholder="0,00" /><span>kr</span></span></label>
              </div>
              <button class="link ba-flere" type="button" data-act="ba-flere" id="ba-flere" hidden>Handlede I flere steder? Skriv beløbet pr. butik</button>
              <div class="ba-rest" id="ba-rest" hidden></div>
              <p class="ba-fejl" id="ba-fejl" hidden></p>
              <button class="ba-gem" type="submit" id="ba-gem">Afslut indkøb</button>
              <button class="link ba-fortryd" type="button" data-act="ba-spring" id="ba-spring" hidden></button>
              <button class="link ba-fortryd" type="button" data-act="ba-fortryd" id="ba-fortryd" hidden>Fortryd – varerne kommer tilbage i kurven</button>
              <button class="kv-luk" type="button" data-act="ba-luk">Annullér</button>
            </form>
          </div>
          <div class="katvalg" id="katvalg" hidden>
            <div class="kv-ark" role="dialog" aria-modal="true" aria-labelledby="kv-titel">
              <div class="kv-greb"></div>
              <h3 id="kv-titel">Flyt til kategori</h3>
              <div class="kv-liste" id="kv-liste"></div>
              <button class="kv-luk" type="button" data-act="kat-luk">Annullér</button>
            </div>
          </div>
        </main>
      </div>`;
    r.querySelector("[data-act=ny-linje]").hidden = this._shop;
    const plusAdded = (res) => {
      if (!res) this._setStatus("Kunne ikke tilføje");
      else if (res.fandtes) this._toast(`"${res.text}" står allerede på listen`, { ms: 3500 });
      else this._setStatus("Tilføjet");
    };
    this._cl = new Checklist(r.getElementById("cl"), null, {
      editable: !this._shop,
      tapToggle: this._shop,
      hideChecked: this._hideChecked,
      onFocusLine: (id) => { this._focusLine = id; this._focusNote = "indkob"; this._updateFastBtn(); },
      scroller: r.getElementById("ark"),
      onDelete: (ln, prevId) => this._deleted(ln, prevId),
      plus: true,
      onPlusAdded: plusAdded,
      onFast: (ln) => this._setFast(ln, !ln.fast),
    });
    this._clb = new Checklist(r.getElementById("cl-basis"), null, {
      editable: true,
      checkbox: false,
      swipe: true,
      onFocusLine: (id) => { this._focusLine = id; this._focusNote = "basis"; this._updateFastBtn(); },
      scroller: r.getElementById("ark"),
      onDelete: (ln, prevId) => this._deleted(ln, prevId, "basis"),
      plus: true,
      onPlusAdded: plusAdded,
    });
    r.addEventListener("click", (e) => this._click(e));
    r.getElementById("ba-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this._gemButik();
    });
    r.getElementById("ba-butik").addEventListener("input", () => { this._markChip(); r.getElementById("ba-fejl").hidden = true; });
    r.getElementById("ba-beloeb").addEventListener("input", () => (r.getElementById("ba-fejl").hidden = true));
    r.getElementById("ba-butik").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        r.getElementById("ba-beloeb").focus();
      }
    });
    // Tryk uden for listen lukker en række, der står med "Slet" fremme
    r.addEventListener("pointerdown", (e) => {
      const path = e.composedPath();
      if (!path.includes(r.getElementById("cl"))) this._cl._closeOpen();
      if (!path.includes(r.getElementById("cl-basis"))) this._clb._closeOpen();
    });
    const ny = r.getElementById("ny");
    r.getElementById("hurtig").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = ny.value.trim();
      if (!v) return;
      this._quickAdd(v);
    });
    ny.addEventListener("input", () => this._renderAutofill());
    const nyb = r.getElementById("ny-basis");
    r.getElementById("hurtig-basis").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = nyb.value.trim();
      if (!v) return;
      this._quickAdd(v, "basis");
    });
    nyb.addEventListener("input", () => this._renderAutofill());
    const ta = r.getElementById("mp");
    ta.addEventListener("input", () => {
      this._mpDirty = true;
      this._autogrow();
      this._setStatus("Gemmer …");
      clearTimeout(this._mpTimer);
      this._mpTimer = setTimeout(() => this._flushMadplan(), 800);
    });
    const caret = () => (this._mpCaret = ta.selectionStart);
    for (const ev of ["keyup", "click", "select", "input"]) ta.addEventListener(ev, caret);
    ta.addEventListener("blur", () => { caret(); this._flushMadplan(); });
    r.getElementById("insp").addEventListener("toggle", () => this._renderInsp());
    r.getElementById("insp-sog").addEventListener("input", (e) => {
      this._insp.q = e.target.value;
      this._renderInsp();
    });
    r.getElementById("retter-el").setup(this._storeProxy());
    r.getElementById("koleskab-el").setup(this._storeProxy());
    r.getElementById("omregning-el").setup(this._storeProxy());
    r.addEventListener("im-toast", (e) => {
      const d = e.detail || {};
      this._toast(d.text, { actions: d.actions || [], ms: d.ms || (d.actions?.length ? 6000 : 3500) });
    });
    r.addEventListener("im-status", (e) => this._setStatus(e.detail));
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
    this._cl.setCategories(s.indkob.kategorier);
    this._cl.setBought(s.indkob.tur?.koebt);
    this._cl.setLines(s.indkob.lines);
    this._clb.store = this._store.forNote("basis");
    this._clb.setCategories(s.basis?.kategorier);
    this._clb.setLines(s.basis?.lines);
    this._renderBasis();
    this._renderKoleskab();
    this._updateFastBtn();
    if (!this.shadowRoot.getElementById("katvalg").hidden) this._renderKatvalg();
    this._renderNoteList();
    this._renderIndkob();
    this._renderMadplan();
    if (this._planner) this._planner.hassState = s;
    if (this._ugevarer) this._ugevarer.hassState = s;
    this._tjekUgevarer();
    if (this._insp.data && this._insp.version !== s.madplan.version) this._renderInsp();
    this.shadowRoot.getElementById("stats-body").innerHTML = statsHTML(s.stats);
    this._renderHelp();
    this._renderSettings();
    this._renderHistorik();
    this._renderLog();
    this._feedSub();
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
    this._feedSub();
    this._tjekUgevarer();
    if (open === "madplan") requestAnimationFrame(() => this._autogrow());
  }

  /* Retter og Omregning henter først deres data, når noten er åben */
  _feedSub() {
    const s = this._state;
    if (!s) return;
    const narrow = this.shadowRoot.querySelector(".app")?.classList.contains("smal");
    const open = this._open || (narrow ? null : "indkob");
    if (open === "retter") this.shadowRoot.getElementById("retter-el").state = s;
    if (open === "indstillinger") this.shadowRoot.getElementById("omregning-el").state = s;
  }

  /* Store-adgang til under-elementerne (oprettes før abonnementet findes) */
  _storeProxy() {
    return { send: (type, data) => this._store.send(type, data), remove: (ids) => this._store.remove(ids) };
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
      if (id === "basis") {
        const n = s.basis?.antal || 0;
        return `${n} ${n === 1 ? "fast vare" : "faste varer"}${s.basis?.updated ? " · ændret " + relTime(s.basis.updated) : ""}`;
      }
      if (id === "koleskab") {
        const k = s.koleskab || [];
        if (!k.length) return "Tomt – skriv det, I har tilbage";
        const navne = k.slice(0, 3).map((x) => esc(x.navn)).join(", ");
        return `${k.length} ${k.length === 1 ? "rest" : "rester"} · ${navne}${k.length > 3 ? " …" : ""}`;
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
      if (id === "retter") {
        const rt = s.retter;
        if (!rt || rt.alle === undefined) return "";
        return rt.opskrifter || rt.med_varer
          ? `${rt.med_varer} af ${rt.alle} retter har indkøbsliste`
          : `${rt.alle} retter · ingen opskrifter endnu`;
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
        <button class="vk shop" data-act="handl" aria-pressed="${this._shop}" title="Indkøbstilstand: tryk på varen for at krydse af">${this._shop ? "Rediger" : ICON_CART + "<span>Handl</span>"}</button>
        ${this._shop ? "" : `<button class="vk ovs-knap" data-act="overskrift" aria-pressed="false" title="Gør den markerede linje til overskrift (eller tilbage til vare)">${ICON_OVS}<span>Overskrift</span></button>
        <button class="vk fast-knap" data-act="fast" aria-pressed="false" title="Gør den markerede vare fast (i basislisten) eller engangs">${PIN}<span>Fast</span></button>`}
        ${this._shop ? `<button class="vk" data-act="skjul" aria-pressed="${this._hideChecked}" title="Skjul afkrydsede">${this._hideChecked ? "Vis alle" : "Skjul købte"}</button>` : ""}
        <button class="vk" data-act="mere" aria-haspopup="true" aria-label="Flere handlinger">${ICON_MORE}</button>
        <div class="menu-pop" id="pop" hidden>
          <button data-act="fjern-flueben">Færdig med at handle …</button>
          ${this._shop ? "" : `<button data-act="skjul">${this._hideChecked ? "Vis afkrydsede varer" : "Skjul afkrydsede varer"}</button>`}
          <button data-act="fjern-afkrydsede">Slet afkrydsede varer</button>
        </div>`;
      this._updateFastBtn();
    } else if (open === "basis") {
      t.innerHTML = `<button class="vk ovs-knap" data-act="overskrift" aria-pressed="false" title="Gør den markerede linje til overskrift (eller tilbage til vare)">${ICON_OVS}<span>Overskrift</span></button>`;
      this._updateFastBtn();
    } else if (open === "madplan") {
      t.innerHTML = `<button class="vk" data-act="ugevarer" title="Varer til ugens retter">Varer</button>
        <button class="vk" data-act="planlaeg" title="Forslag til næste uges madplan">Planlæg</button>
        <button class="vk" data-act="ny-uge" title="Indsæt en tom uge øverst">Ny uge</button>`;
    } else if (open === "retter") {
      t.innerHTML = `<button class="vk" data-act="ny-ret" title="Ny ret med indkøbsliste">＋ Ny ret</button>`;
    } else t.innerHTML = "";
  }

  /* ------------------------------------------------------------ indkøb */
  _renderIndkob() {
    const s = this._state;
    const r = this.shadowRoot;
    const tur = s.indkob.tur;
    const kl = (iso) => new Date(iso).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
    const items = s.indkob.lines.filter((l) => l.type === "item" && l.text.trim());
    const done = items.filter((l) => l.checked).length;
    const meta = r.getElementById("meta-indkob");
    meta.classList.toggle("shop", this._shop);
    const koebt = tur?.koebt || {};
    const iKurv = items.filter((l) => l.checked && !koebt[l.id]).length;
    const tilbage = items.length - done;
    meta.textContent = this._shop
      ? `Indkøbstilstand · ${tilbage ? tilbage + " tilbage" : "alt er købt"}${iKurv ? ` · ${iKurv} i kurven` : ""} · tryk på en vare for at krydse af`
      : tur?.aktiv && tur.nulstilles
        ? `Handlet ind – fluebenene fjernes ca. kl. ${kl(tur.nulstilles)}`
        : s.indkob.updated
          ? `Ændret ${relTime(s.indkob.updated)}${s.indkob.updated_by ? " af " + s.indkob.updated_by : ""}`
          : "";
    const open = items.filter((l) => !l.checked).map((l) => l.text);
    r.getElementById("forslag").innerHTML = forslagHTML(s.stats, open);
    this._renderAutofill();
    this._renderButikFod(tur, iKurv, tilbage, kl);
    this._renderPrisCta();
    if (!r.getElementById("butikark").hidden) {
      this._renderArkSub();
      this._renderRest();
    }
  }

  /* ------------------------------------------------------------ "Hvad blev indkøbet?" */
  _renderPrisCta() {
    const r = this.shadowRoot;
    const mp = this._state?.historik?.mangler_pris;
    const el = r.getElementById("pris-cta");
    el.hidden = !mp;
    if (mp) {
      const hvor = mp.butikker.filter(Boolean).join(" + ");
      r.getElementById("pris-cta-sub").textContent =
        `${dagTid(mp.t)} · ${mp.antal} ${mp.antal === 1 ? "vare" : "varer"}${hvor ? " · " + hvor : ""}`
        + (mp.butikker.length > 1 ? ` – ${(mp.mangler || []).filter(Boolean).join(", ") || "en butik"} mangler beløb` : " – skriv beløbet");
    }
    if (this._wantPris && this._state) {
      this._wantPris = false;
      if (mp) requestAnimationFrame(() => this._openPris());
    }
  }

  _openPris() {
    const mp = this._state?.historik?.mangler_pris;
    if (!mp) return;
    if (mp.butikker.length > 1) {
      // Flere butikker: skriv beløbet pr. butik i indkøbshistorikken
      this._aabnTur(mp.id);
      return;
    }
    this._openArk("pris");
  }

  /* Åbn indkøbshistorikken med turen foldet ud (beløb pr. butik) */
  _aabnTur(tripId) {
    this._saveScroll();
    this._openTrip = tripId;
    this._open = "historik";
    lsSet("open", "historik");
    this._layout();
    this._renderHistorik(true);
  }

  /* "Handlede I flere steder?" fra beløbs-arket: videre til historikken med
     det, der allerede er skrevet i arket, i første række og en tom række til næste butik */
  _flereButikker() {
    const r = this.shadowRoot;
    const mp = this._baMp;
    if (!mp) return this._closeButik();
    const butik = r.getElementById("ba-butik").value.trim();
    const beloeb = r.getElementById("ba-beloeb").value.trim();
    this._closeButik();
    this._aabnTur(mp.id);
    const box = r.querySelector(`.tur[data-tur="${CSS.escape(mp.id)}"] .tur-edit`);
    if (!box) return;
    const bets = box.querySelector(".bets");
    const foerste = bets.querySelector(".bet");
    if (foerste) {
      const fb = foerste.querySelector(".b-butik");
      const fk = foerste.querySelector(".b-beloeb");
      if (butik && !fb.value) fb.value = butik;
      if (beloeb && !fk.value) fk.value = beloeb;
    }
    while (bets.querySelectorAll(".bet").length < 2) bets.insertAdjacentHTML("beforeend", this._betRaekke());
    const tom = [...bets.querySelectorAll(".bet")].find((row) => !row.querySelector(".b-butik").value.trim());
    const felt = tom ? tom.querySelector(".b-butik") : bets.querySelector(".b-beloeb");
    box.closest(".tur")?.scrollIntoView({ block: "start" });
    felt?.focus();
  }

  /* ------------------------------------------------------------ afslut indkøb i butik (Handl) */
  _renderButikFod(tur, iKurv, tilbage, kl) {
    const el = this.shadowRoot.getElementById("butik-fod");
    el.hidden = !this._shop;
    if (!this._shop) return;
    const stops = tur?.butikker || [];
    const varer = (n) => `${n} ${n === 1 ? "vare" : "varer"}`;
    const liste = stops.map((st) => `<button type="button" class="bf-stop" data-act="ba-ret" data-stop="${esc(st.id)}">
        <span class="bf-ok">✓</span><span class="bf-tx"><b>${esc(st.butik)}</b> · ${varer(st.antal)}</span>
        <span class="bf-pris${st.beloeb ? "" : " mangler"}">${st.beloeb ? kr(st.beloeb) : "+ pris"}</span></button>`).join("");
    const hint = iKurv
      ? ""
      : stops.length
        ? `<p class="bf-hint">${tilbage ? "Handler I videre i en anden butik, så kryds varerne af og afslut igen." : "Alt på listen er købt."}${tur?.nulstilles ? ` Fluebenene fjernes ca. kl. ${kl(tur.nulstilles)}.` : ""}</p>`
        : `<p class="bf-hint">Kryds de varer af, I lægger i kurven – afslut, når I har betalt.</p>`;
    const faerdig = iKurv || stops.length
      ? `<button type="button" class="bf-faerdig" data-act="faerdig">Færdig med at handle – nulstil listen</button>` : "";
    el.innerHTML = `${liste ? `<div class="bf-liste">${liste}</div>` : ""}
      <button type="button" class="bf-knap" data-act="ba-aabn" ${iKurv ? "" : "disabled"}>${ICON_CART}<span>Afslut indkøb i butik${iKurv ? ` (${varer(iKurv)})` : ""}</span></button>
      ${hint}${faerdig}`;
  }

  _butikNavne() {
    const s = this._state;
    const navne = [];
    const add = (n) => n && !navne.some((x) => x.toLowerCase() === n.toLowerCase()) && navne.push(n);
    for (const b of s?.historik?.butikker || []) add(b.navn);
    return navne.slice(0, 8);
  }

  /* Varer i kurven, der endnu ikke er gemt i en butik */
  _iKurv() {
    const s = this._state;
    if (!s) return 0;
    const koebt = s.indkob.tur?.koebt || {};
    return s.indkob.lines.filter((l) => l.type === "item" && l.text.trim() && l.checked && !koebt[l.id]).length;
  }

  _openButik(stopId = null) {
    this._openArk(stopId ? "ret" : "butik", { stopId });
  }

  /* Ét ark til fire trin på rejsen:
     butik   – Afslut indkøb i butik (Handl): butik + beløb for varerne i kurven
     ret     – ret en afsluttet butik på turen
     faerdig – Færdig med at handle: butik + beløb (kan springes over) → listen nulstilles
     pris    – Hvad blev indkøbet? (seneste indkøb uden beløb) */
  _openArk(mode, { stopId = null } = {}) {
    const r = this.shadowRoot;
    const s = this._state;
    if (!s) return;
    const tur = s.indkob.tur || {};
    const st = stopId ? (tur.butikker || []).find((x) => x.id === stopId) : null;
    if (mode === "ret" && !st) return;
    const mp = s.historik?.mangler_pris;
    if (mode === "pris" && !mp) return;
    this._baMode = mode;
    this._baStop = st ? stopId : null;
    this._baMp = mode === "pris" ? mp : null;
    this._baFjern = new Set();
    r.getElementById("ba-titel").textContent = {
      butik: "Afslut indkøb i butik", ret: `Indkøbet i ${st?.butik}`, faerdig: "Færdig med at handle", pris: "Hvad blev indkøbet?",
    }[mode];
    r.getElementById("ba-valgfrit").hidden = mode === "pris";
    let butik = "";
    let beloeb = "";
    if (st) {
      butik = st.butik;
      beloeb = st.beloeb ? String(st.beloeb).replace(".", ",") : "";
    }
    if (mode === "pris" && mp.butikker.length === 1) butik = mp.butikker[0];
    r.getElementById("ba-butik").value = butik;
    r.getElementById("ba-beloeb").value = beloeb;
    r.getElementById("ba-chips").innerHTML = this._butikNavne()
      .map((n) => `<button type="button" class="ba-chip" data-act="ba-chip" data-navn="${esc(n)}">${esc(n)}</button>`).join("");
    this._markChip();
    r.getElementById("ba-fortryd").hidden = mode !== "ret";
    r.getElementById("ba-fejl").hidden = true;
    this._renderArkSub();
    this._renderRest();
    r.getElementById("butikark").hidden = false;
    r.querySelector("#butikark .kv-ark").scrollTop = 0;
  }

  _renderArkSub() {
    const r = this.shadowRoot;
    const s = this._state;
    const mode = this._baMode;
    const tur = s.indkob.tur || {};
    const iKurv = this._iKurv();
    const varer = (n) => `${n} ${n === 1 ? "vare" : "varer"}`;
    const sub = r.getElementById("ba-sub");
    const gem = r.getElementById("ba-gem");
    const spring = r.getElementById("ba-spring");
    let felter = true;
    spring.hidden = true;
    gem.disabled = false;
    if (mode === "ret") {
      const st = (tur.butikker || []).find((x) => x.id === this._baStop);
      if (st) sub.textContent = `${varer(st.antal)} · ret butik eller beløb`;
      gem.textContent = "Gem";
    } else if (mode === "pris") {
      const mp = this._baMp;
      const hvor = mp.butikker.filter(Boolean).join(" + ");
      sub.textContent = `${dagTid(mp.t)} · ${varer(mp.antal)}${hvor ? " · " + hvor : ""}`;
      gem.textContent = "Gem beløbet";
      spring.hidden = false;
      spring.textContent = "Ingen pris – spørg ikke igen";
    } else if (mode === "faerdig") {
      const gemt = (tur.butikker || []).map((st) => st.butik + (st.beloeb ? " " + kr(st.beloeb) : "")).join(" · ");
      felter = iKurv > 0;
      sub.textContent = iKurv
        ? `${varer(iKurv)} i kurven. Hvor handlede I, og hvad blev det?${gemt ? ` (Gemt på turen: ${gemt}.)` : ""}`
        : gemt
          ? `Gemt på turen: ${gemt}.`
          : "Ingen varer er krydset af – listen sættes bare tilbage til basislisten.";
      gem.textContent = iKurv ? "Gem og nulstil listen" : "Nulstil listen";
      spring.hidden = !iKurv;
      spring.textContent = "Spring over – nulstil uden butik og beløb";
    } else {
      sub.textContent = iKurv ? `${varer(iKurv)} i kurven gemmes som købt i butikken.` : "Ingen nye varer i kurven.";
      gem.textContent = "Afslut indkøb";
      gem.disabled = !iKurv;
    }
    r.getElementById("ba-felter").hidden = !felter;
    r.getElementById("ba-flere").hidden = mode !== "pris";
  }

  /* "Færdig med at handle": ukøbte engangsvarer bliver stående – tryk på dem, der ikke skal med igen */
  _renderRest() {
    const r = this.shadowRoot;
    const el = r.getElementById("ba-rest");
    if (this._baMode !== "faerdig") {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const rest = this._state.indkob.lines.filter((l) => l.type === "item" && l.text.trim() && !l.checked && !l.fast);
    const ids = new Set(rest.map((l) => l.id));
    for (const id of [...this._baFjern]) if (!ids.has(id)) this._baFjern.delete(id);
    el.hidden = !rest.length;
    if (!rest.length) {
      el.innerHTML = "";
      return;
    }
    const n = this._baFjern.size;
    const alle = n === rest.length;
    el.innerHTML = `<div class="br-top"><span>Ikke købt – bliver på listen</span>
        <button type="button" class="link" data-act="ba-rest-alle">${alle ? "Behold alle" : "Fjern alle"}</button></div>
      <div class="br-chips">${rest.map((l) => {
        const f = this._baFjern.has(l.id);
        return `<button type="button" class="br-chip${f ? " fjern" : ""}" data-act="ba-rest" data-id="${esc(l.id)}" aria-pressed="${f}">${esc(l.text)}</button>`;
      }).join("")}</div>
      <p class="br-hint">${n ? `${n} ${n === 1 ? "engangsvare fjernes" : "engangsvarer fjernes"} fra listen. Tryk igen for at beholde.` : "Tryk på de engangsvarer, der ikke skal med næste gang."}</p>`;
  }

  _markChip() {
    const r = this.shadowRoot;
    const v = r.getElementById("ba-butik").value.trim().toLowerCase();
    for (const c of r.querySelectorAll(".ba-chip")) c.classList.toggle("valgt", c.dataset.navn.toLowerCase() === v);
  }

  _closeButik() {
    const r = this.shadowRoot;
    r.getElementById("butikark").hidden = true;
    for (const id of ["ba-butik", "ba-beloeb"]) r.getElementById(id).blur();
    this._baStop = null;
    this._baMode = null;
    this._baMp = null;
  }

  _baFejl(t) {
    const el = this.shadowRoot.getElementById("ba-fejl");
    el.textContent = t;
    el.hidden = false;
  }

  async _gemButik(spring = false) {
    const r = this.shadowRoot;
    const mode = this._baMode;
    const felter = !r.getElementById("ba-felter").hidden;
    const butik = spring || !felter ? "" : r.getElementById("ba-butik").value.trim();
    const rå = spring || !felter ? "" : r.getElementById("ba-beloeb").value.trim();
    const beloeb = rå ? parseKr(rå) : null;
    if (rå && beloeb === null) return this._baFejl("Beløbet kan ikke læses – skriv fx 234,50.");
    if (mode === "faerdig") return this._gemFaerdig(butik, beloeb, spring);
    if (mode === "pris") return this._gemPris(butik, beloeb, spring);
    if (!butik) return this._baFejl("Vælg eller skriv butikken.");
    const stopId = this._baStop;
    const data = { butik, ...(beloeb !== null ? { beloeb } : {}) };
    r.getElementById("ba-gem").disabled = true;
    try {
      if (stopId) {
        await this._store.send("indkob/butik_ret", { stop_id: stopId, ...data, beloeb: beloeb ?? 0 });
        this._closeButik();
        this._setStatus(`${butik} er rettet`);
      } else {
        const res = await this._store.send("indkob/butik_afslut", data);
        this._closeButik();
        if (navigator.vibrate) navigator.vibrate(12);
        this._toast(`${res.butik}: ${res.antal} ${res.antal === 1 ? "vare" : "varer"}${res.beloeb ? " · " + kr(res.beloeb) : ""} gemt`, {
          label: "Fortryd",
          action: () => this._store.send("indkob/butik_fortryd", { stop_id: res.stop_id })
            .then(() => this._setStatus("Fortrudt – varerne er tilbage i kurven"))
            .catch(() => this._setStatus("Kunne ikke fortryde")),
        });
      }
    } catch (err) {
      r.getElementById("ba-gem").disabled = false;
      this._baFejl(err?.message || "Kunne ikke gemme – prøv igen.");
    }
  }

  /* Færdig med at handle: (butik + beløb) → listen nulstilles til basislisten */
  async _gemFaerdig(butik, beloeb, spring) {
    const r = this.shadowRoot;
    if (beloeb !== null && !butik) return this._baFejl("Vælg eller skriv butikken – eller tryk Spring over.");
    const fjern = [...this._baFjern];
    const gem = r.getElementById("ba-gem");
    gem.disabled = true;
    try {
      const res = await this._store.send("indkob/uncheck_all", {
        ...(butik ? { butik } : {}),
        ...(beloeb !== null ? { beloeb } : {}),
        ...(fjern.length ? { fjern } : {}),
      });
      if (spring && res?.trip_id) await this._store.send("trip/spring_pris", { trip_id: res.trip_id }).catch(() => {});
      this._closeButik();
      if (navigator.vibrate) navigator.vibrate(12);
      const dele = ["Listen er sat tilbage til basislisten"];
      if (butik) dele.push(`${butik}${beloeb ? " " + kr(beloeb) : ""} gemt`);
      if (fjern.length) dele.push(`${fjern.length} ${fjern.length === 1 ? "engangsvare" : "engangsvarer"} fjernet`);
      this._toast(dele.join(" · "), { ms: 5000 });
    } catch (err) {
      gem.disabled = false;
      this._baFejl(err?.message || "Kunne ikke nulstille listen – prøv igen.");
    }
  }

  /* Hvad blev indkøbet? – beløbet skrives på indkøbet i historikken */
  async _gemPris(butik, beloeb, spring) {
    const r = this.shadowRoot;
    const mp = this._baMp;
    if (!mp) return this._closeButik();
    const gem = r.getElementById("ba-gem");
    try {
      if (spring) {
        await this._store.send("trip/spring_pris", { trip_id: mp.id });
        this._closeButik();
        this._setStatus("OK – indkøbet står uden pris");
        return;
      }
      if (!beloeb) return this._baFejl("Skriv beløbet – eller tryk Ingen pris.");
      gem.disabled = true;
      await this._store.updateTrip(mp.id, [{ butik, beloeb }]);
      this._closeButik();
      if (navigator.vibrate) navigator.vibrate(12);
      this._toast(`${butik || "Indkøbet"}: ${kr(beloeb)} gemt i indkøbshistorikken`, { ms: 4000 });
    } catch (err) {
      gem.disabled = false;
      this._baFejl(err?.message || "Kunne ikke gemme – prøv igen.");
    }
  }

  /* ------------------------------------------------------------ køleskab (0.12.5) */
  _renderKoleskab() {
    const k = this._state?.koleskab || [];
    this.shadowRoot.getElementById("koleskab-el").state = this._state;
    const lidt = k.filter((x) => !x.nok).length;
    this.shadowRoot.getElementById("meta-koleskab").textContent = k.length
      ? `${k.length} ${k.length === 1 ? "rest" : "rester"}${lidt ? ` · ${lidt} købes stadig` : ""}`
      : "";
  }

  /* ------------------------------------------------------------ basisliste */
  _renderBasis() {
    const s = this._state;
    const b = s?.basis;
    if (!b) return;
    const n = b.antal || 0;
    this.shadowRoot.getElementById("meta-basis").textContent =
      `${n} ${n === 1 ? "fast vare" : "faste varer"}` +
      (b.updated ? ` · ændret ${relTime(b.updated)}${b.updated_by ? " af " + b.updated_by : ""}` : "");
  }

  /* Knappen "Fast" i værktøjslinjen viser, om den markerede vare er fast. */
  _updateFastBtn() {
    // Overskrift: trykket ind, når den markerede linje er en overskrift
    const ovs = this.shadowRoot?.querySelector(".ovs-knap");
    if (ovs) {
      const note = this._focusNote === "basis" ? this._state?.basis : this._state?.indkob;
      const sameNote = (this._focusNote === "basis") === (this._open === "basis");
      const l = sameNote ? note?.lines.find((x) => x.id === this._focusLine) : null;
      ovs.disabled = !l;
      ovs.setAttribute("aria-pressed", String(l?.type === "header"));
      ovs.title = !l ? "Markér en linje først" : l.type === "header"
        ? "Overskrift – tryk for at gøre linjen til en almindelig vare igen"
        : "Gør den markerede linje til overskrift";
    }
    const btn = this.shadowRoot?.querySelector(".fast-knap");
    if (!btn) return;
    const ln = this._focusNote === "indkob" ? this._state?.indkob.lines.find((l) => l.id === this._focusLine) : null;
    const ok = !!ln && ln.type === "item" && !!ln.text.trim();
    btn.disabled = !ok;
    btn.setAttribute("aria-pressed", String(!!ln?.fast));
    btn.title = !ok ? "Markér en vare først" : ln.fast ? "Fast vare – tryk for at gøre den til engangsvare" : "Engangsvare – tryk for at gøre den fast";
  }

  async _setFast(ln, fast, { undo = true } = {}) {
    try {
      await this._store.setFast(ln.id, fast);
      const navn = ln.text.trim();
      this._toast(fast ? `"${navn}" er nu en fast vare` : `"${navn}" er nu en engangsvare`,
        undo ? { label: "Fortryd", action: () => this._setFast(ln, !fast, { undo: false }) } : { ms: 3500 });
    } catch (err) {
      this._setStatus(err?.message || "Kunne ikke ændre varen");
    }
  }

  _renderAutofill() {
    const r = this.shadowRoot;
    const s = this._state;
    r.getElementById("af").innerHTML = s ? autofillHTML(s.indkob.kendte, r.getElementById("ny").value, s.indkob.lines) : "";
    r.getElementById("af-basis").innerHTML = s ? autofillHTML(s.indkob.kendte, r.getElementById("ny-basis").value, s.basis?.lines || []) : "";
  }

  async _quickAdd(text, note = "indkob") {
    const r = this.shadowRoot;
    const inp = r.getElementById(note === "basis" ? "ny-basis" : "ny");
    inp.value = "";
    this._renderAutofill();
    try {
      const res = await this._store.forNote(note).add(text, { auto_place: true, line_type: "item" });
      this._added(res, note);
    } catch (err) {
      this._setStatus(err?.message || "Kunne ikke tilføje");
    }
  }

  /* Efter automatisk placering: vis hvor varen landede + "Skift" (+ "Fast" på indkøbslisten) */
  _added(res, note = "indkob") {
    const kat = res.kategori ? prettyHeader(res.kategori) : "";
    const cl = note === "basis" ? this._clb : this._cl;
    if (res.fandtes) {
      cl.flash(res.id);
      this._toast(`"${res.text}" står allerede på ${note === "basis" ? "basislisten" : "listen"}${kat ? " · " + kat : ""}`, { ms: 4000 });
      return;
    }
    const actions = [{ label: "Skift", action: () => this._openKatvalg(res.id, note) }];
    if (note === "indkob" && !res.fast) actions.push({ label: "Fast", action: () => this._setFast(res, true) });
    this._toast(kat ? `${res.text} → ${kat}` : `${res.text} er tilføjet`, { actions, ms: 7000 });
  }

  /* ------------------------------------------------------------ kategorivælger */
  _openKatvalg(lineId, note = "indkob") {
    this._katLine = lineId;
    this._katNote = note;
    const el = this.shadowRoot.getElementById("katvalg");
    this._renderKatvalg();
    el.hidden = false;
  }

  _closeKatvalg() {
    this.shadowRoot.getElementById("katvalg").hidden = true;
    this._katLine = null;
  }

  _renderKatvalg() {
    const s = this._state;
    const src = this._katNote === "basis" ? s?.basis : s?.indkob;
    const lines = src?.lines || [];
    const idx = lines.findIndex((l) => l.id === this._katLine);
    if (idx < 0) return this._closeKatvalg();
    const ln = lines[idx];
    let cur = null;
    for (let j = idx; j >= 0; j--) if (lines[j].type === "header") { cur = lines[j].id; break; }
    this.shadowRoot.getElementById("kv-titel").textContent = `Flyt "${ln.text}" til`;
    this.shadowRoot.getElementById("kv-liste").innerHTML = (src.kategorier || [])
      .map((c) => `<button type="button" class="kv-k${c.id && c.id === cur ? " valgt" : ""}" data-act="kat-valg"
          ${c.id ? `data-id="${esc(c.id)}"` : `data-noegle="${esc(c.fast)}"`}>
          <span>${esc(prettyHeader(c.navn))}</span><span class="kv-n">${c.id === cur ? "✓" : c.varer || ""}</span></button>`)
      .join("");
  }

  async _valgKategori(b) {
    const id = this._katLine;
    const note = this._katNote || "indkob";
    this._closeKatvalg();
    if (!id) return;
    try {
      const res = await this._store.send("indkob/kategori", {
        line_id: id, header_id: b.dataset.id || null, noegle: b.dataset.noegle || null, note,
      });
      this._setStatus(res.kategori ? `Flyttet til ${prettyHeader(res.kategori)}` : "Flyttet");
      (note === "basis" ? this._clb : this._cl).flash(id);
    } catch (err) {
      this._setStatus("Kunne ikke flytte varen");
    }
  }

  _setShop(on) {
    this._shop = on;
    lsSet("shop", on);
    this._cl.setMode({ editable: !on, tapToggle: on });
    this.shadowRoot.querySelector("[data-act=ny-linje]").hidden = on;
    this._renderTools("indkob");
    if (this._state) this._renderIndkob();
    this._renderUgevarerCta();
  }

  /* Swipe-slet: vis "Fortryd" i nogle sekunder */
  _deleted(ln, prevId, note = "indkob") {
    const navn = ln.text.trim();
    const store = this._store.forNote(note);
    this._toast(navn ? `Slettede "${navn}"${note === "basis" ? " fra basislisten" : ""}` : "Linjen blev slettet", {
      label: "Fortryd",
      action: () => store.restore(ln, prevId).catch(() => this._setStatus("Kunne ikke gendanne")),
    });
  }

  /* Besked nederst med 0–2 knapper: { label, action } eller { actions: [{ label, action }] } */
  _toast(text, { label = null, action = null, actions = null, ms = 6000 } = {}) {
    const el = this.shadowRoot.getElementById("toast");
    const list = actions || (label ? [{ label, action }] : []);
    el.innerHTML = `<span>${esc(text)}</span>` +
      list.map((a, i) => `<button type="button" data-act="toast-knap" data-i="${i}">${esc(a.label)}</button>`).join("");
    el.hidden = false;
    this._toastActions = list.map((a) => a.action);
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (el.hidden = true), ms);
  }

  /* ------------------------------------------------------------ hjælp */
  _renderHelp() {
    const s = this._state;
    const t = s.indkob.tur || {};
    const pct = t.taerskel ?? 50;
    const tim = fmtTimer(t.timer ?? 3);
    this.shadowRoot.getElementById("hjaelp-body").innerHTML = `
      <p><b>Basislisten.</b> Efter hvert indkøb nulstilles listen til basislisten (Noter → <button class="link" data-note="basis">Basisliste</button>): fluebenene fjernes, købte engangsvarer forsvinder, og faste varer, der mangler, kommer tilbage. Engangsvarer er mærket <i>Engangs</i> – tryk på mærket for at gøre varen fast; <i>Fast</i> i værktøjslinjen skifter for den markerede vare.</p>
      <p><b>Kryds af, når varen ryger i kurven.</b> Hvert flueben tæller som et køb i statistikken. Fjerner du et flueben igen inden for 12 timer, regnes det som fortrudt.</p>
      <p><b>Handlet ind.</b> Når mindst ${pct} % af varerne er krydset af, registreres en indkøbstur. ${tim[0].toUpperCase() + tim.slice(1)} efter <i>sidste</i> flueben fjernes alle flueben automatisk, og turen gemmes under Statistik → Seneste indkøb. Kommer listen under ${pct} % igen, annulleres turen.</p>
      <p><b>Færdig med at handle</b> (nederst i Handl eller under ⋯): skriv butik og beløb – eller spring over – så sættes listen tilbage til basislisten med det samme. Engangsvarer, der ikke blev købt, bliver stående; tryk på dem i arket, hvis de ikke skal med næste gang. "Slet afkrydsede varer" fjerner de afkrydsede varer – faste varer kommer dog tilbage.</p>
      <p><b>Hvad blev indkøbet?</b> Mangler det seneste indkøb et beløb (fx når listen er nulstillet automatisk), står der et kort øverst på listen. Tryk på det og skriv beløbet, eller × hvis det ikke skal have en pris.</p>
      <p><b>I butikken:</b> tryk på 🛒 Handl. Så krydser ét tryk på varen af, tastaturet holder sig væk, og øverst kan I se hvor langt I er. Tryk på Rediger for at rette i listen igen.</p>
      <p><b>Afslut indkøb i butik:</b> når I har betalt, så tryk på knappen nederst i listen, vælg butikken og skriv evt. beløbet. Varerne gemmes som købt i den butik og forsvinder fra listen, så kun det, der mangler, står tilbage. Handler I videre i en anden butik, gør I bare det samme dér – det er ikke et krav. ${tim[0].toUpperCase() + tim.slice(1)} efter sidste butik fjernes fluebenene. Glemmer I knappen, registreres indkøbet stadig automatisk – så spørger kortet øverst på listen bagefter, hvad det blev.</p>
      <p><b>Nye varer</b> er engangsvarer (tryk <i>Fast</i> i beskeden, hvis de skal blive på listen): skriv i feltet øverst, så finder listen selv kategorien – den overskrift varen plejer at stå under, ellers et gæt ud fra navnet (mælk → Køl – mejeri, kyllingebryst → Køl – kød). Ved ukendte varer bliver det Ugevarer. Tryk på <i>Skift</i> i beskeden nederst, hvis den landede forkert – så huskes det til næste gang.</p>
      <p><b>＋ under en kategori</b> tilføjer en vare lige præcis dér. Enter giver plads til den næste. Kategorier uden varer vises ikke – de dukker op, så snart der kommer en vare i dem.</p>
      <p>Står varen der allerede, får den bare fluebenet fjernet – listen får ingen dubletter. Træk i ≡ for at flytte en vare – placeringen huskes til næste gang.</p>
      <p><b>Slet en linje:</b> swipe den mod venstre (kort = vis Slet, langt = slet med det samme). Fortryd nederst på skærmen i et par sekunder. Backspace på en tom linje sletter den også.</p>
      <p><b>Overskrifter:</b> markér en linje og tryk <i>Overskrift</i> øverst – tryk igen for at gøre den til en vare. Enter giver en ny linje.</p>
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
    const NOTE = { indkob: "🛒", basis: "📌", koleskab: "🧊", madplan: "🍽", retter: "📖", historik: "🧾", indstillinger: "⚙︎", statistik: "📊" };
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
    const kal = r.getElementById("s-kalender");
    if (focus !== kal) {
      kal.innerHTML = `<option value="">Ingen</option>` + (i.kalendere || [])
        .map((k) => `<option value="${esc(k.entity_id)}" ${k.entity_id === i.madplan_kalender ? "selected" : ""}>${esc(k.navn)}</option>`).join("");
    }
    const sk = i.skjulte_retter || [];
    r.getElementById("s-skjulte").innerHTML = `<span class="fl">Retter der ikke foreslås${sk.length ? "" : "<small>Ingen endnu – vælg \"Foreslå ikke igen\" på en ret i planlæggeren</small>"}</span>` +
      sk.map((n) => `<span class="skjult-r"><span>${esc(n)}</span><button class="link" data-act="vis-ret" data-navn="${esc(n)}">Foreslå igen</button></span>`).join("");
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
    this._renderPlanCta(mp);
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

  /* ------------------------------------------------------------ ugeplanlægger */
  _renderPlanCta(mp) {
    const r = this.shadowRoot;
    const cta = r.getElementById("plan-cta");
    // Vis knappen, når der mangler en ret i de næste 3 dage
    const naeste = (mp.dage || []).filter((d) => d.offset >= 0 && d.offset <= 2);
    const mangler = naeste.find((d) => !d.ret);
    cta.hidden = !mangler;
    if (mangler) {
      r.getElementById("plan-cta-titel").textContent = mangler.offset === 0 ? "Planlæg ugen fra i dag" : `Planlæg ugen fra ${mangler.ugedag.toLowerCase()}`;
    }
  }

  _openPlanner() {
    this._flushMadplan();
    if (this._planner) return;
    const el = document.createElement("im-ugeplan");
    this._planner = el;
    el.addEventListener("luk", () => {
      el.remove();
      this._planner = null;
      const ark = this.shadowRoot.getElementById("ark");
      if (this._open === "madplan" && ark) ark.scrollTop = 0;
    });
    el.addEventListener("toast", (e) => this._toast(e.detail, { ms: 4000 }));
    el.addEventListener("gemt", (e) => setTimeout(() => this._openUgevarer(e.detail || {}), 260));
    this.shadowRoot.appendChild(el);
    el.open(this._store, this._state);
  }

  /* ------------------------------------------------------------ varer til ugen (0.12) */
  _openUgevarer(opts = {}) {
    this._flushMadplan();
    if (this._ugevarer) return;
    const el = document.createElement("im-ugevarer");
    this._ugevarer = el;
    el.addEventListener("luk", () => {
      el.remove();
      this._ugevarer = null;
      this._skjulUgevarerCta(); // set – kommer igen, når madplanen ændres
    });
    this.shadowRoot.appendChild(el);
    el.open(this._store, this._state, opts);
  }

  /* Kortet "Varer til ugens retter" på indkøbslisten og i madplanen: vises, når ugens retter
     har varer, der mangler på listen (eller retter uden varer) – indtil madplanen ændres. */
  _tjekUgevarer() {
    const s = this._state;
    if (!s || !this._store) return;
    const narrow = this.shadowRoot.querySelector(".app")?.classList.contains("smal");
    const open = this._open || (narrow ? null : "indkob");
    if (open !== "indkob" && open !== "madplan") return;
    const nøgle = `${s.madplan.version}|${s.indkob.version}|${new Date().toDateString()}`;
    if (this._uvNøgle === nøgle) return this._renderUgevarerCta();
    this._uvNøgle = nøgle;
    clearTimeout(this._uvT);
    this._uvT = setTimeout(async () => {
      try {
        this._uv = await this._store.send("madplan/varer", {});
      } catch (e) {
        this._uv = null;
      }
      this._renderUgevarerCta();
    }, 400);
  }

  _uvSkjulNøgle() {
    const d = this._uv;
    return d ? `${d.start}|${d.madplan_version}` : "";
  }

  _skjulUgevarerCta() {
    if (this._uv) lsSet("varer_cta_skjult", this._uvSkjulNøgle());
    this._renderUgevarerCta();
  }

  _renderUgevarerCta() {
    const r = this.shadowRoot;
    const d = this._uv;
    const n = d ? d.varer.filter((v) => v.valgt).length : 0;
    const m = d ? d.mangler.length : 0;
    // Kun når næste uge er planlagt – eller om fredagen (indkøbsdagen). Midt i ugen er indkøbet
    // allerede gjort; smutture klares med knappen Varer i madplanen.
    const relevant = !!d && (d.start === d.perioder?.[1]?.start || new Date().getDay() === 5);
    const vis = relevant && (n > 0 || m > 0) && lsGet("varer_cta_skjult", "") !== this._uvSkjulNøgle();
    const p = d?.perioder?.find((x) => x.start === d.start);
    const sub = vis ? [
      p ? p.titel : "",
      n ? `${n} ${n === 1 ? "vare mangler" : "varer mangler"} på listen` : "",
      m ? `${m} ${m === 1 ? "ret" : "retter"} uden varer` : "",
    ].filter(Boolean).join(" · ") : "";
    for (const id of ["varer-cta-i", "varer-cta-m"]) {
      const el = r.getElementById(id);
      if (!el) continue;
      el.hidden = !vis || (id === "varer-cta-i" && this._shop);
      el.querySelector(".varer-cta-sub").textContent = sub;
    }
  }

  /* ------------------------------------------------------------ inspiration */
  async _renderInsp() {
    const r = this.shadowRoot;
    const det = r.getElementById("insp");
    if (!det.open || !this._store) return;
    const ver = this._state?.madplan.version;
    if (!this._insp.data || this._insp.version !== ver) {
      try {
        this._insp.data = await this._store.retter();
        this._insp.version = ver;
      } catch (err) {
        r.getElementById("insp-liste").innerHTML = `<p class="tom-tekst">Kunne ikke hente retterne.</p>`;
        return;
      }
    }
    const d = this._insp.data;
    const q = this._insp.q.trim().toLowerCase();
    const tab = this._insp.tab;
    r.getElementById("insp-faner").hidden = !!q;
    for (const b of r.querySelectorAll("[data-insp]")) b.setAttribute("aria-pressed", String(b.dataset.insp === tab));
    const fmtDato = (iso) => { const dd = new Date(iso + "T12:00:00"); return `${dd.getDate()}/${dd.getMonth() + 1}`; };
    let html;
    if (q) {
      const hits = (d.dage || []).filter((x) => x.ret.toLowerCase().includes(q) || (x.noter || []).join(" ").toLowerCase().includes(q)).slice(0, 40);
      html = hits.length
        ? hits.map((x) => `<button type="button" class="ret-r" data-act="ret" data-navn="${esc(x.ret)}">
            <span class="rn">${esc(x.ret)}</span><span class="rc">${x.ugedag.slice(0, 3)} ${fmtDato(x.dato)}${x.uge ? " · uge " + x.uge : ""}</span>
            ${x.noter?.length ? `<span class="ri">${esc(x.noter.join(", "))}</span>` : ""}</button>`).join("")
        : `<p class="tom-tekst">Ingen retter matcher "${esc(this._insp.q.trim())}".</p>`;
    } else {
      let liste = (d.retter || []).filter((x) => x.antal >= 2);
      if (tab === "laenge") liste = [...liste].sort((a, b) => b.dage_siden - a.dage_siden || b.antal - a.antal);
      if (tab === "sjaeldent") liste = (d.retter || []).filter((x) => x.antal === 1).sort((a, b) => b.dage_siden - a.dage_siden);
      liste = liste.slice(0, 30);
      html = liste.length
        ? liste.map((x) => `<button type="button" class="ret-r" data-act="ret" data-navn="${esc(x.navn)}">
            <span class="rn">${esc(x.navn)}</span><span class="rc">${x.antal}×${x.rest_gange ? " +rester" : ""}</span>
            <span class="ri">sidst ${sidenTekst(x.dage_siden)}</span></button>`).join("")
        : `<p class="tom-tekst">Når madplanen har nogle uger bag sig, dukker retterne op her.</p>`;
    }
    r.getElementById("insp-liste").innerHTML = html;
  }

  /* Sæt en ret ind i madplanen: på markørens dag-linje hvis den er tom, ellers ved markøren. */
  _insertRet(navn) {
    const ta = this.shadowRoot.getElementById("mp");
    const v = ta.value;
    let pos = this._mpCaret ?? ta.selectionStart ?? 0;
    pos = Math.max(0, Math.min(pos, v.length));
    const ls = v.lastIndexOf("\n", pos - 1) + 1;
    let le = v.indexOf("\n", pos);
    if (le < 0) le = v.length;
    const line = v.slice(ls, le);
    let out, caret;
    const m = line.match(/^(\s*[\p{L}]+\.?\s*:?)\s*$/u); // "Fredag:" / "Fredag" uden ret
    if (m) {
      const head = m[1].replace(/\s+$/, "");
      const ny = `${head}${head.endsWith(":") ? "" : ":"} ${navn}`;
      out = v.slice(0, ls) + ny + v.slice(le);
      caret = ls + ny.length;
      // Hop videre til næste tomme dag-linje, så næste tryk fylder den
      const nextStart = caret + 1;
      const nextEnd = out.indexOf("\n", nextStart);
      const next = out.slice(nextStart, nextEnd < 0 ? out.length : nextEnd);
      if (nextStart <= out.length && /^\s*[\p{L}]+\.?\s*:?\s*$/u.test(next) && next.trim()) caret = nextStart + next.replace(/\s+$/, "").length;
    } else {
      const before = v.slice(0, pos), after = v.slice(pos);
      const sep = before && !/[\s:]$/.test(before) ? " " : "";
      out = before + sep + navn + after;
      caret = (before + sep + navn).length;
    }
    ta.value = out;
    this._mpCaret = caret;
    try { ta.setSelectionRange(caret, caret); } catch (e) {}
    ta.dispatchEvent(new Event("input"));
    this._setStatus(`Indsat: ${navn}`);
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
    const insp = e.target.closest("[data-insp]");
    if (insp) {
      this._insp.tab = insp.dataset.insp;
      this._renderInsp();
      return;
    }
    if (e.target.id === "katvalg") return this._closeKatvalg();
    if (e.target.id === "butikark") return this._closeButik();
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
    } else if (act === "ny-ret") {
      r.getElementById("retter-el").nyRet();
    } else if (act === "fjern-afkrydsede") {
      pop.hidden = true;
      const n = this._state.indkob.lines.filter((l) => l.type === "item" && l.checked).length;
      if (n) await this._store.clearChecked();
    } else if (act === "fjern-flueben" || act === "faerdig") {
      if (pop) pop.hidden = true;
      this._openArk("faerdig");
    } else if (act === "pris-aabn") {
      this._openPris();
    } else if (act === "pris-spring") {
      const mp = this._state?.historik?.mangler_pris;
      if (mp) this._store.send("trip/spring_pris", { trip_id: mp.id })
        .then(() => this._toast("Indkøbet står uden pris – beløbet kan altid skrives i Indkøbshistorik", { ms: 4500 }))
        .catch(() => this._setStatus("Kunne ikke gemme"));
    } else if (act === "ba-spring") {
      this._gemButik(true);
    } else if (act === "ba-flere") {
      this._flereButikker();
    } else if (act === "ba-rest") {
      const id = b.dataset.id;
      if (this._baFjern.has(id)) this._baFjern.delete(id);
      else this._baFjern.add(id);
      this._renderRest();
    } else if (act === "ba-rest-alle") {
      const rest = this._state.indkob.lines.filter((l) => l.type === "item" && l.text.trim() && !l.checked && !l.fast);
      const alle = rest.length && rest.every((l) => this._baFjern.has(l.id));
      this._baFjern = alle ? new Set() : new Set(rest.map((l) => l.id));
      this._renderRest();
    } else if (act === "overskrift") {
      const id = this._focusLine;
      const note = this._focusNote === "basis" ? "basis" : "indkob";
      const ln = (note === "basis" ? this._state?.basis : this._state?.indkob)?.lines.find((l) => l.id === id);
      if (!ln) return;
      await this._store.forNote(note).update(id, { line_type: ln.type === "header" ? "item" : "header" });
      (note === "basis" ? this._clb : this._cl)._focusSoon(id, "end");
    } else if (act === "fast") {
      const ln = this._focusNote === "indkob" ? this._state?.indkob.lines.find((l) => l.id === this._focusLine) : null;
      if (!ln || ln.type !== "item" || !ln.text.trim()) return this._setStatus("Markér en vare først");
      this._setFast(ln, !ln.fast);
    } else if (act === "ny-linje-basis") {
      const last = this._state.basis.lines.at(-1);
      const nl = await this._store.forNote("basis").add("", { after_id: last ? last.id : null, line_type: "item" });
      this._clb._focusSoon(nl.id, 0);
    } else if (act === "ba-aabn") {
      this._openButik();
    } else if (act === "ba-ret") {
      this._openButik(b.dataset.stop);
    } else if (act === "ba-luk") {
      this._closeButik();
    } else if (act === "ba-chip") {
      this.shadowRoot.getElementById("ba-butik").value = b.dataset.navn;
      this._markChip();
      this.shadowRoot.getElementById("ba-fejl").hidden = true;
    } else if (act === "ba-fortryd") {
      const id = this._baStop;
      this._closeButik();
      if (id) this._store.send("indkob/butik_fortryd", { stop_id: id })
        .then(() => this._setStatus("Fortrudt – varerne er tilbage i kurven"))
        .catch(() => this._setStatus("Kunne ikke fortryde"));
    } else if (act === "ny-linje") {
      const last = this._state.indkob.lines.at(-1);
      const nl = await this._store.add("", { after_id: last ? last.id : null, line_type: "item" });
      this._cl._focusSoon(nl.id, 0);
    } else if (act === "forslag") {
      b.disabled = true;
      this._store.add(b.dataset.navn, { auto_place: true, line_type: "item" }).then((res) => this._added(res)).catch(() => {});
    } else if (act === "kat-valg") {
      this._valgKategori(b);
    } else if (act === "kat-luk") {
      this._closeKatvalg();
    } else if (act === "uge") {
      this._weekOpen = !this._weekOpen;
      this._renderMadplan();
    } else if (act === "ny-uge") {
      const ta = r.getElementById("mp");
      const tpl = nyUgeSkabelon(new Date(), this._state?.madplan.sidste_dato || null);
      ta.value = tpl + (ta.value.trim() ? "\n\n" + ta.value : "");
      ta.dispatchEvent(new Event("input"));
      ta.focus();
      const pos = tpl.indexOf(": ") + 2;
      this._mpCaret = pos;
      ta.setSelectionRange(pos, pos);
      r.getElementById("ark").scrollTop = 0;
    } else if (act === "planlaeg") {
      this._openPlanner();
    } else if (act === "ugevarer") {
      this._openUgevarer();
    } else if (act === "ugevarer-skjul") {
      this._skjulUgevarerCta();
    } else if (act === "stat-slet") {
      const navn = b.dataset.navn;
      if (navn && confirm(`Fjern "${navn}" fra statistikken?\n\nKøbene af varen slettes fra statistikken. Listen og indkøbshistorikken røres ikke.`)) {
        this._store.send("stats/slet_vare", { navn })
          .then((res) => this._toast(res.slettet ? `"${navn}" er fjernet fra statistikken` : `"${navn}" var ikke i statistikken`, { ms: 3500 }))
          .catch(() => this._setStatus("Kunne ikke fjerne varen"));
      }
    } else if (act === "vis-ret") {
      b.disabled = true;
      await this._store.send("madplan/skjul", { navn: b.dataset.navn, skjul: false });
    } else if (act === "ret") {
      this._insertRet(b.dataset.navn);
    } else if (act === "autofill") {
      this._quickAdd(b.dataset.navn);
    } else if (act === "handl") {
      this._setShop(!this._shop);
    } else if (act === "toast-knap") {
      r.getElementById("toast").hidden = true;
      clearTimeout(this._toastTimer);
      const fn = this._toastActions?.[+b.dataset.i];
      this._toastActions = null;
      fn?.();
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
const ICON_CART = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4m10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4M7.2 14.8l.03-.12.9-1.68h7.45c.75 0 1.41-.41 1.75-1.03l3.86-7.01L19.42 4h-.01l-1.1 2-2.76 5H8.53l-.13-.27L6.16 6l-.95-2-.94-2H1v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96a2 2 0 0 0 2 2h12v-2H7.42a.25.25 0 0 1-.22-.2Z"/></svg>`;
const ICON_OVS = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 4h2.4v6.8h6.2V4H14v16h-2.4v-6.9H5.4V20H3V4Zm13 10h5v2h-5v-2Zm0 4h5v2h-5v-2Z"/></svg>`;
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
  .status { font-size: .8rem; color: var(--im-dim); margin-left: auto; min-width: 0; max-width: 38%; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
  .bar .tilbage, .bar .vaerktoej { flex: none; }
  .vaerktoej { display: flex; align-items: center; gap: 2px; position: relative; }
  .vk { color: var(--im-acc); font-weight: 600; min-height: 44px; min-width: 44px; padding: 0 8px; border-radius: 8px; }
  .vk[aria-pressed="true"] { background: color-mix(in srgb, var(--im-acc) 14%, transparent); }
  .smal .vk { padding: 0 6px; }
  .smal .vk[data-act=mere] { min-width: 36px; }
  @media (max-width: 385px) { .smal .tilbage span { display: none; } }
  .menu-pop { position: absolute; right: 0; top: 46px; background: var(--im-bg); border: 1px solid var(--im-line);
              border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.18); display: flex; flex-direction: column; min-width: 220px; z-index: 5; overflow: hidden; }
  .menu-pop button { text-align: left; padding: 13px 16px; font-size: 16px; }
  .menu-pop button + button { border-top: 1px solid var(--im-line); }
  .menu-pop [data-act=fjern-flueben] { color: var(--im-acc); font-weight: 600; }
  .menu-pop [data-act=fjern-afkrydsede] { color: var(--error-color, #d93025); }

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
  #af:not(:empty) { margin: 8px 0 0; }
  #cl { margin-top: 8px; }
  .meta.shop { color: var(--im-acc); font-weight: 600; }
  .vk.shop { display: inline-flex; align-items: center; gap: 4px; }
  .vk.fast-knap { display: inline-flex; align-items: center; gap: 3px; }
  .vk.fast-knap:disabled { opacity: .4; }
  .vk.ovs-knap { display: inline-flex; align-items: center; gap: 3px; }
  .vk.ovs-knap:disabled { opacity: .4; }
  .basis-intro { font-size: 15px; line-height: 1.45; color: var(--im-dim); margin: 0 0 12px; }
  #cl-basis { margin-top: 8px; }
  #af-basis:not(:empty) { margin: 8px 0 0; }
  #cl-basis[data-empty]::before { content: "Basislisten er tom. Skriv en fast vare ovenfor."; color: var(--im-dim); padding: 12px 0; }
  .vk.shop[aria-pressed="true"] { background: var(--im-acc); color: #fff; }
  .toast { position: absolute; left: 50%; bottom: calc(28px + var(--safe-area-inset-bottom, 0px)); transform: translateX(-50%);
           display: flex; align-items: center; gap: 18px; width: max-content; max-width: calc(100% - 32px); box-sizing: border-box;
           padding: 12px 18px; border-radius: 14px;
           background: #2b2b2e; color: #fff; box-shadow: 0 8px 28px rgba(0,0,0,.3); z-index: 50; font-size: 15px; white-space: nowrap; }
  .toast span { overflow: hidden; text-overflow: ellipsis; white-space: normal; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .toast button { flex: none; }
  .katvalg { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,.35); display: flex; align-items: flex-end; justify-content: center; }
  .katvalg[hidden] { display: none; }
  .kv-ark { width: 100%; max-width: 560px; max-height: 80vh; overflow: auto; box-sizing: border-box; background: var(--im-bg);
            border-radius: 18px 18px 0 0; padding: 8px 16px calc(16px + var(--safe-area-inset-bottom, 0px));
            box-shadow: 0 -8px 30px rgba(0,0,0,.25); }
  .kv-greb { width: 38px; height: 5px; border-radius: 3px; background: var(--im-line); margin: 2px auto 10px; }
  .kv-ark h3 { margin: 0 0 8px; font-size: 17px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kv-k { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px;
          padding: 0 4px; font: inherit; font-size: 17px; color: var(--im-text); background: none; border: 0;
          border-bottom: 1px solid var(--im-line); text-align: left; cursor: pointer; }
  .kv-k.valgt { font-weight: 700; }
  .kv-k .kv-n { color: var(--im-dim); font-size: 15px; }
  .kv-k.valgt .kv-n { color: var(--im-acc-strong); font-size: 18px; }
  .kv-luk { display: block; width: 100%; min-height: 48px; margin-top: 10px; font: inherit; font-size: 17px; font-weight: 600;
            color: var(--im-acc); background: var(--im-bg2); border: 0; border-radius: 12px; cursor: pointer; }
  .toast button { color: var(--im-acc-strong); font-weight: 700; font-size: 15px; padding: 4px 2px; min-height: 32px; }
  .note { position: relative; }
  .insp { margin: 0 0 16px; padding: 10px 16px 12px; background: var(--im-bg2); border-radius: 14px; }
  .insp summary { cursor: pointer; font-weight: 600; color: var(--im-acc); list-style: none; min-height: 28px; display: flex; align-items: center; }
  .insp summary::-webkit-details-marker { display: none; }
  .insp input[type=search] { width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; padding: 10px 12px; margin: 10px 0 8px;
                             border-radius: 10px; border: 1px solid var(--im-line); background: var(--im-bg); color: var(--im-text); -webkit-appearance: none; }
  .insp-faner { display: flex; gap: 6px; margin-bottom: 6px; }
  .insp-faner button { padding: 6px 12px; border-radius: 999px; font-size: 14px; color: var(--im-dim); background: var(--im-bg); }
  .insp-faner button[aria-pressed="true"] { color: var(--im-text); font-weight: 600; box-shadow: inset 0 0 0 1.5px var(--im-acc); }
  .insp-liste { max-height: 46vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .ret-r { display: grid; grid-template-columns: 1fr auto; column-gap: 10px; width: 100%; text-align: left; padding: 9px 2px; border-bottom: 1px solid var(--im-line); font: inherit; }
  .ret-r:active { background: var(--im-bg); }
  .rn { font-weight: 500; font-size: 16px; }
  .rc { color: var(--im-dim); font-variant-numeric: tabular-nums; font-size: 14px; white-space: nowrap; }
  .ri { grid-column: 1 / -1; font-size: 13px; color: var(--im-dim); }
  .insp .fod { font-size: 13px; color: var(--im-dim); margin: 8px 0 0; }
  #cl[data-empty]::before { content: "Listen er tom. Skriv en vare ovenfor."; color: var(--im-dim); padding: 12px 0; }
  .ny-linje { color: var(--im-acc); font-weight: 600; padding: 14px 0; }
  .butik-fod { margin: 18px 0 calc(90px + var(--safe-area-inset-bottom, 0px)); }
  .butik-fod[hidden] { display: none; }
  .bf-liste { margin-bottom: 12px; border-radius: 14px; background: var(--im-bg2); overflow: hidden; }
  .bf-stop { display: flex; width: 100%; align-items: center; gap: 10px; min-height: 48px; padding: 0 14px; font: inherit; font-size: 16px;
             color: var(--im-text); background: none; border: 0; border-bottom: 1px solid var(--im-line); text-align: left; cursor: pointer; }
  .bf-stop:last-child { border-bottom: 0; }
  .bf-ok { color: var(--im-acc-strong); font-weight: 700; }
  .bf-tx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bf-pris { font-variant-numeric: tabular-nums; }
  .bf-pris.mangler { color: var(--im-acc); font-weight: 600; font-size: 15px; }
  .bf-knap { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 52px; border: 0; border-radius: 14px;
             font: inherit; font-size: 17px; font-weight: 700; color: #fff; background: var(--im-acc); cursor: pointer; }
  .bf-knap svg { width: 20px; height: 20px; }
  .bf-knap:disabled { background: var(--im-bg2); color: var(--im-dim); cursor: default; }
  .bf-hint { margin: 10px 2px 0; color: var(--im-dim); font-size: 14px; line-height: 1.4; text-align: center; }
  .katvalg.top { align-items: flex-start; }
  .katvalg.top .kv-ark { border-radius: 0 0 18px 18px; padding: calc(14px + var(--safe-area-inset-top, 0px)) 16px 16px; }
  .ba h3 { white-space: normal; }
  .ba-sub { margin: 0 0 12px; color: var(--im-dim); font-size: 15px; }
  .ba-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .ba-chips:empty { display: none; }
  .ba-chip { min-height: 36px; padding: 0 14px; border-radius: 18px; border: 1px solid var(--im-line); background: var(--im-bg);
             font: inherit; font-size: 15px; color: var(--im-text); cursor: pointer; }
  .ba-chip.valgt { background: var(--im-acc); border-color: var(--im-acc); color: #fff; font-weight: 600; }
  .ba-felt { display: block; margin-bottom: 12px; }
  .ba-felt > span:first-child { display: block; font-size: 13px; color: var(--im-dim); margin: 0 0 4px 2px; }
  .ba-felt i { font-style: normal; }
  .ba-felt input { width: 100%; box-sizing: border-box; font: inherit; font-size: 17px; padding: 12px; border-radius: 12px;
                   border: 1px solid var(--im-line); background: var(--im-bg2); color: var(--im-text); }
  .ba-kr { display: flex; align-items: center; gap: 8px; }
  .ba-kr > span { color: var(--im-dim); font-size: 17px; }
  .ba-fejl { color: #d33; margin: 0 0 10px; font-size: 15px; }
  .ba-flere { display: block; margin: -4px 0 14px 2px; color: var(--im-acc); font-size: 15px; text-align: left; }
  .ba-gem { display: block; width: 100%; min-height: 50px; border: 0; border-radius: 12px; font: inherit; font-size: 17px; font-weight: 700;
            color: #fff; background: var(--im-acc); cursor: pointer; }
  .ba-gem:disabled { opacity: .45; cursor: default; }
  .ba-fortryd { display: block; margin: 12px auto 0; color: var(--im-acc); font-size: 15px; }

  .plan-cta { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; margin: -4px 0 16px; padding: 12px 14px;
              border-radius: 14px; background: color-mix(in srgb, var(--im-acc-strong) 20%, var(--im-bg2)); }
  .plan-cta:active { filter: brightness(.96); }
  .pris-cta { padding: 0; gap: 0; margin: 0 0 14px; }
  .pris-cta[hidden] { display: none; }
  .pr-hoved { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; padding: 12px 4px 12px 14px; text-align: left; }
  .pr-luk { flex: none; min-width: 44px; min-height: 44px; font-size: 24px; line-height: 1; color: var(--im-dim); }
  .bf-faerdig { display: block; width: 100%; min-height: 48px; margin-top: 12px; border-radius: 14px; border: 1px solid var(--im-line);
                font-size: 16px; font-weight: 600; color: var(--im-acc); }
  .ba-rest { margin: 2px 0 14px; }
  .ba-rest[hidden] { display: none; }
  .br-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; color: var(--im-dim); margin: 0 2px 6px; }
  .br-top .link { font-size: 14px; }
  .br-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .br-chip { min-height: 34px; padding: 0 12px; border-radius: 17px; border: 1px solid var(--im-line); background: var(--im-bg2); font-size: 15px; }
  .br-chip.fjern { text-decoration: line-through; color: var(--im-dim); border-style: dashed; background: transparent; }
  .br-hint { margin: 8px 2px 0; font-size: 13.5px; color: var(--im-dim); line-height: 1.35; }
  .pc-ikon { font-size: 24px; line-height: 1; }
  .pc-tekst { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .pc-tekst b { font-size: 17px; }
  .pc-tekst small { font-size: 13.5px; color: var(--im-dim); margin-top: 1px; }
  .pc-pil { font-size: 26px; color: var(--im-acc); line-height: 1; }
  .skjult-r { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 16px; }
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
