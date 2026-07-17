/* Troškovnik izgradnje kuće — aplikacijska logika (bez servera, localStorage) */
(function () {
  "use strict";

  const STORAGE_KEY = "kuca-troskovnik-state-v1";
  const THEME_KEY = "kuca-troskovnik-theme";

  const MONTHS_HR = ["Sij", "Velj", "Ožu", "Tra", "Svi", "Lip", "Srp", "Kol", "Ruj", "Lis", "Stu", "Pro"];

  const STATUS_BADGE = {
    "Plan": "badge-neutral",
    "U ponudi": "badge-warning",
    "Ugovoreno": "badge-info",
    "U tijeku": "badge-warning",
    "Placeno": "badge-good",
    "Zavrseno": "badge-good",
    "Odgođeno": "badge-neutral",
    "Rizik": "badge-critical",
  };

  const NABAVA_STATUS_OPTIONS = ["Plan", "Za ponudu", "Projektna", "Naručeno", "Dostavljeno"];

  const CATEGORY_ACCENTS = [
    "var(--blue)", "var(--green)", "var(--magenta)", "var(--yellow)",
    "var(--aqua)", "var(--orange)", "var(--violet)", "var(--red)",
  ];
  function categoryAccent(cat) {
    const list = categoryList();
    const idx = list.indexOf(cat);
    return CATEGORY_ACCENTS[(idx < 0 ? 0 : idx) % CATEGORY_ACCENTS.length];
  }

  // ---------------------------------------------------------------- utils
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.startsWith("data-")) node.setAttribute(k, attrs[k]);
        else node[k] = attrs[k];
      }
    }
    if (children) {
      children.forEach((c) => { if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    }
    return node;
  }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  function eur(n) {
    const v = Math.round(Number(n) || 0);
    return v.toLocaleString("hr-HR") + " €";
  }
  function eur2(n) {
    const v = Number(n) || 0;
    return v.toLocaleString("hr-HR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  }
  function pctStr(n) {
    if (!isFinite(n)) return "0%";
    return Math.round(n * 100) + "%";
  }
  function monthLabel(ym) {
    if (!ym) return "—";
    const [y, m] = ym.split("-").map(Number);
    return MONTHS_HR[m - 1] + " '" + String(y).slice(2);
  }
  function monthRange(start, end) {
    const res = [];
    if (!start || !end) return res;
    let [y, m] = start.split("-").map(Number);
    const [ey, em] = end.split("-").map(Number);
    let guard = 0;
    while ((y < ey || (y === ey && m <= em)) && guard < 240) {
      res.push(y + "-" + String(m).padStart(2, "0"));
      m++; if (m > 12) { m = 1; y++; }
      guard++;
    }
    return res;
  }
  function toast(msg) {
    const t = $("#save-toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._h);
    toast._h = setTimeout(() => t.classList.remove("show"), 1400);
  }
  function debounce(fn, wait) {
    let h;
    return function (...args) { clearTimeout(h); h = setTimeout(() => fn.apply(this, args), wait); };
  }

  // ---------------------------------------------------------------- state
  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.dataVersion === DATA.dataVersion && Array.isArray(parsed.troskovnik)) {
          if (parsed.postavke && parsed.postavke.lokacija === "Mirna ulica bb, Zagreb - Odra") {
            parsed.postavke.lokacija = "Odra, Zagreb";
          }
          return parsed;
        }
      }
    } catch (e) { /* ignore, fall through */ }
    return JSON.parse(JSON.stringify(DATA));
  }

  const saveStateNow = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { console.warn("Spremanje nije uspjelo", e); }
  };
  const saveStateDebounced = debounce(() => { saveStateNow(); toast("Spremljeno"); }, 500);

  // -------------------------------------------------------- derived data
  function itemPlanBase(item) {
    return (item.ugovoreno && item.ugovoreno > 0) ? item.ugovoreno : (item.ukupno || 0);
  }
  function itemRazlika(item) {
    return round2(itemPlanBase(item) - (item.placeno || 0));
  }
  function categoryList() {
    return state.kategorije_lista && state.kategorije_lista.length ? state.kategorije_lista : Array.from(new Set(state.troskovnik.map((i) => i.kategorija)));
  }
  function categoryTotals(catName, items) {
    const list = items || state.troskovnik;
    const rows = list.filter((i) => i.kategorija === catName);
    let planirano = 0, ugovoreno = 0, placeno = 0;
    rows.forEach((i) => { planirano += i.ukupno || 0; ugovoreno += i.ugovoreno || 0; placeno += i.placeno || 0; });
    planirano = round2(planirano); ugovoreno = round2(ugovoreno); placeno = round2(placeno);
    return { planirano, ugovoreno, placeno, razlika: round2(planirano - placeno), count: rows.length };
  }
  function globalTotals(items) {
    const list = items || state.troskovnik;
    let planirano = 0, ugovoreno = 0, placeno = 0;
    list.forEach((i) => { planirano += i.ukupno || 0; ugovoreno += i.ugovoreno || 0; placeno += i.placeno || 0; });
    planirano = round2(planirano); ugovoreno = round2(ugovoreno); placeno = round2(placeno);
    return { planirano, ugovoreno, placeno, preostalo: round2(planirano - placeno), pct: planirano > 0 ? placeno / planirano : 0 };
  }
  function statusBadge(status) {
    const cls = STATUS_BADGE[status] || "badge-neutral";
    return `<span class="badge ${cls}"><span class="badge-dot"></span>${esc(status || "—")}</span>`;
  }

  // ---------------------------------------------------------------- tabs
  function switchTab(tab, opts) {
    $all(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $all(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + tab));
    renderView(tab, opts || {});
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }
  function renderView(tab, opts) {
    if (tab === "dashboard") renderDashboard();
    else if (tab === "troskovnik") renderTroskovnik(opts);
    else if (tab === "cashflow") renderCashflow();
    else if (tab === "nabava") renderNabava();
    else if (tab === "povrsine") renderPovrsine();
    else if (tab === "postavke") renderPostavke();
  }

  $all(".tab-btn").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  // ---------------------------------------------------------- theme
  function effectiveTheme() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr) return attr;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  (function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  })();
  $("#theme-toggle").addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
  });

  // =====================================================================
  // DASHBOARD
  // =====================================================================
  function renderDashboard() {
    const root = $("#view-dashboard");
    const g = globalTotals();
    const rezerva = categoryTotals("Rezerva").planirano;
    const p = state.postavke;
    const overBudget = g.planirano > (p.ciljani_budzet || g.planirano) + 0.5;

    root.innerHTML = "";
    root.appendChild(el("h2", { class: "view-title" }, [`${p.investitor || "Investitor"} — ${p.lokacija || ""}`]));

    const kpiGrid = el("div", { class: "kpi-grid" });
    kpiGrid.append(
      kpiCard("Planirano ukupno", eur(g.planirano), p.ciljani_budzet ? `Ciljani budžet: ${eur(p.ciljani_budzet)}` : "", "var(--blue)"),
      kpiCard("Ugovoreno", eur(g.ugovoreno), pctStr(g.planirano ? g.ugovoreno / g.planirano : 0) + " od plana", "var(--violet)"),
      kpiCard("Plaćeno", eur(g.placeno), pctStr(g.pct) + " od plana", "var(--green)"),
      kpiCard("Preostalo prema planu", eur(g.preostalo), overBudget ? "⚠ iznad ciljanog budžeta" : "", overBudget ? "var(--critical)" : "var(--text-muted)"),
      kpiCard("Rezerva", eur(rezerva), "planirana pričuva", "var(--orange)"),
      kpiCard("Iznos kredita", eur(p.iznos_kredita), "ukupno odobreno", "var(--yellow)"),
      kpiCard("Vlastita sredstva", eur(p.vlastita_sredstva), "", "var(--text-muted)"),
      kpiCard("% plaćeno", pctStr(g.pct), "", "var(--blue)")
    );
    root.appendChild(kpiGrid);

    // overall progress
    const progCard = el("div", { class: "card" });
    progCard.appendChild(el("div", { class: "card-title" }, ["Napredak plaćanja", el("span", { html: statusBadge(g.pct >= 1 ? "Zavrseno" : "U tijeku") })]));
    progCard.appendChild(progressBar(g.pct));
    root.appendChild(progCard);

    // category breakdown
    const catCard = el("div", { class: "card" });
    catCard.appendChild(el("div", { class: "card-title" }, ["Po kategorijama", el("span", { style: "font-weight:400;color:var(--text-muted);font-size:.72rem" }, ["dodir za detalje →"])]));
    categoryList().forEach((cat) => {
      const t = categoryTotals(cat);
      if (t.count === 0) return;
      const row = el("div", { class: "cat-row", style: `--cat-accent:${categoryAccent(cat)}` });
      row.addEventListener("click", () => switchTab("troskovnik", { category: cat }));
      row.appendChild(el("div", { class: "cat-row-top" }, [
        el("div", { class: "cat-row-name" }, [el("span", { class: "cat-dot" }), cat]),
        el("div", { class: "cat-row-nums" }, [`${eur(t.placeno)} / ${eur(t.planirano)}`]),
      ]));
      row.appendChild(progressBar(t.planirano ? t.placeno / t.planirano : 0, t.placeno > t.planirano));
      catCard.appendChild(row);
    });
    root.appendChild(catCard);

    // credit tranches summary
    const trancheCard = el("div", { class: "card" });
    trancheCard.appendChild(el("div", { class: "card-title" }, ["Tranše kredita", el("span", {}, [eur(sumBy(state.transe, "iznos"))])]));
    const wrap = el("div", { class: "simple-table-wrap" });
    const table = el("table", { class: "simple-table" });
    table.innerHTML = `<thead><tr><th>Transa</th><th>Mjesec</th><th>Milestone</th><th class="num">Iznos</th><th>Status</th></tr></thead>`;
    const tbody = el("tbody");
    state.transe.forEach((t) => {
      tbody.appendChild(el("tr", {}, [
        el("td", {}, [t.transa]),
        el("td", {}, [monthLabel(t.mjesec)]),
        el("td", { style: "white-space:normal;min-width:180px" }, [t.milestone]),
        el("td", { class: "num" }, [eur(t.iznos)]),
        el("td", { html: statusBadge(t.status) }),
      ]));
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    trancheCard.appendChild(wrap);
    root.appendChild(trancheCard);

    root.appendChild(el("p", { class: "empty-hint" }, ["Otvorite karticu 'Novčani tok' za grafikon plana i tranši kroz vrijeme."]));
  }

  function kpiCard(label, value, sub, accent) {
    return el("div", { class: "kpi-card", style: accent ? `--accent:${accent}` : "" }, [
      el("div", { class: "kpi-label" }, [label]),
      el("div", { class: "kpi-value" }, [value]),
      sub ? el("div", { class: "kpi-sub" }, [sub]) : null,
    ]);
  }
  function progressBar(fraction, over) {
    const f = Math.max(0, Math.min(1, fraction || 0));
    const bar = el("div", { class: "progress" + (over ? " over" : "") });
    bar.appendChild(el("span", { style: `width:${(f * 100).toFixed(1)}%` }));
    return bar;
  }
  function sumBy(arr, field) { return round2(arr.reduce((a, x) => a + (x[field] || 0), 0)); }

  // =====================================================================
  // TROSKOVNIK
  // =====================================================================
  let troFilter = { search: "", category: "Sve", status: "Sve" };
  const openCategories = new Set();

  function getFilteredTroskovnik() {
    const search = troFilter.search.trim().toLowerCase();
    return state.troskovnik.filter((i) => {
      if (troFilter.category !== "Sve" && i.kategorija !== troFilter.category) return false;
      if (troFilter.status !== "Sve" && i.status !== troFilter.status) return false;
      if (search) {
        const hay = `${i.wbs} ${i.opis} ${i.kategorija} ${i.izvodjac || ""} ${i.napomena || ""}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }

  function renderTroskovnik(opts) {
    if (opts && opts.category) {
      troFilter.category = opts.category;
      openCategories.add(opts.category);
    }
    const root = $("#view-troskovnik");
    root.innerHTML = "";
    root.appendChild(el("h2", { class: "view-title" }, ["Troškovnik po stavkama"]));

    // filters
    const filtersBar = el("div", { class: "filters-bar" });
    const searchInput = el("input", { type: "search", placeholder: "Pretraži opis, šifru, izvođača…", value: troFilter.search });
    searchInput.addEventListener("input", debounce(() => { troFilter.search = searchInput.value; rebuildList(); }, 200));
    const catSelect = el("select", {});
    catSelect.appendChild(el("option", { value: "Sve" }, ["Sve kategorije"]));
    categoryList().forEach((c) => catSelect.appendChild(el("option", { value: c }, [c])));
    catSelect.value = troFilter.category;
    catSelect.addEventListener("change", () => { troFilter.category = catSelect.value; rebuildList(); });
    filtersBar.append(searchInput, catSelect);
    root.appendChild(filtersBar);

    const chips = el("div", { class: "chips" });
    ["Sve"].concat(state.statusi_lista).forEach((s) => {
      const chip = el("button", { class: "chip" + (troFilter.status === s ? " active" : "") }, [s]);
      chip.addEventListener("click", () => {
        troFilter.status = s;
        $all(".chip", chips).forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        rebuildList();
      });
      chips.appendChild(chip);
    });
    root.appendChild(chips);

    const totalsStrip = el("div", { class: "totals-strip", id: "tro-totals" });
    root.appendChild(totalsStrip);

    const listWrap = el("div", { id: "tro-list" });
    root.appendChild(listWrap);

    listWrap.addEventListener("input", (e) => {
      const t = e.target;
      if (t.matches("input[data-field], textarea[data-field]")) handleItemFieldChange(t);
    });
    listWrap.addEventListener("change", (e) => {
      const t = e.target;
      if (t.matches("select[data-field]")) handleItemFieldChange(t);
    });
    listWrap.addEventListener("click", (e) => {
      const head = e.target.closest(".category-head");
      if (head) {
        const group = head.closest(".category-group");
        const cat = group.dataset.cat;
        if (openCategories.has(cat)) openCategories.delete(cat); else openCategories.add(cat);
        group.classList.toggle("open");
        return;
      }
      const napBtn = e.target.closest(".napomena-toggle");
      if (napBtn) {
        const box = napBtn.closest(".item-card").querySelector(".napomena-box");
        box.classList.toggle("open");
      }
    });

    rebuildList();

    function rebuildList() {
      listWrap.innerHTML = "";
      const filtered = getFilteredTroskovnik();
      updateTotalsStrip(filtered);

      if (!filtered.length) {
        listWrap.appendChild(el("p", { class: "empty-hint" }, ["Nema stavki koje odgovaraju filteru."]));
        return;
      }

      const cats = categoryList().filter((c) => filtered.some((i) => i.kategorija === c));
      cats.forEach((cat) => {
        const catItems = filtered.filter((i) => i.kategorija === cat);
        const accent = categoryAccent(cat);
        const group = el("div", { class: "category-group" + (openCategories.has(cat) ? " open" : ""), "data-cat": cat, style: `--cat-accent:${accent}` });
        const head = el("div", { class: "category-head" });
        const t = categoryTotals(cat, filtered);
        head.appendChild(el("div", { class: "category-head-top" }, [
          el("div", { class: "category-head-title" }, [el("span", { class: "chev" }, ["▶"]), el("span", { class: "cat-dot" }), `${cat} (${t.count})`]),
        ]));
        head.appendChild(el("div", { class: "category-head-nums" }, [
          el("span", {}, [`Plan: ${eur(t.planirano)}`]),
          el("span", {}, [`Ugovoreno: ${eur(t.ugovoreno)}`]),
          el("span", {}, [`Plaćeno: ${eur(t.placeno)}`]),
        ]));
        head.appendChild(progressBar(t.planirano ? t.placeno / t.planirano : 0, t.placeno > t.planirano));
        group.appendChild(head);

        const body = el("div", { class: "category-body" });
        catItems.forEach((item) => body.appendChild(buildItemCard(item)));
        group.appendChild(body);
        listWrap.appendChild(group);
      });
    }
  }

  function updateTotalsStrip(filtered) {
    const g = globalTotals(filtered);
    const strip = $("#tro-totals");
    if (!strip) return;
    strip.innerHTML = "";
    strip.append(
      el("div", {}, ["Planirano", el("b", {}, [eur(g.planirano)])]),
      el("div", {}, ["Ugovoreno", el("b", {}, [eur(g.ugovoreno)])]),
      el("div", {}, ["Plaćeno", el("b", {}, [eur(g.placeno)])]),
      el("div", {}, ["Preostalo", el("b", {}, [eur(g.preostalo)])]),
      el("div", {}, ["Stavki", el("b", {}, [String(filtered.length)])])
    );
  }

  function buildItemCard(item) {
    const card = el("div", { class: "item-card", "data-wbs": item.wbs });
    const top = el("div", { class: "item-card-top" });
    top.appendChild(el("div", {}, [
      el("span", { class: "item-wbs" }, [item.wbs + " · " + (item.izvor || "")]),
      el("div", { class: "item-opis" }, [item.opis]),
    ]));
    top.appendChild(el("div", { class: "item-plan" }, [eur(item.ukupno), el("div", { class: "field-label", style: "text-align:right;margin-top:2px" }, ["plan"])]));
    card.appendChild(top);

    card.appendChild(el("div", { class: "item-meta" }, [
      `${item.kolicina ?? ""} ${item.jedinica || ""} · JC materijal ${eur2(item.jc_materijal)} · JC rad ${eur2(item.jc_rad)} · ${item.tip_kolicine || ""}`,
    ]));

    const fields = el("div", { class: "item-fields" });
    fields.appendChild(field("Izvođač", el("input", { type: "text", "data-field": "izvodjac", value: item.izvodjac || "", placeholder: "—" })));
    fields.appendChild(field("Ugovoreno (€)", el("input", { type: "number", step: "1", min: "0", "data-field": "ugovoreno", value: item.ugovoreno || "" })));
    fields.appendChild(field("Plaćeno (€)", el("input", { type: "number", step: "1", min: "0", "data-field": "placeno", value: item.placeno || "" })));
    fields.appendChild(field("Status", buildStatusSelect(item)));
    card.appendChild(fields);

    const fields2 = el("div", { class: "item-fields" });
    fields2.appendChild(field("Plan mjesec", buildMonthSelect(item)));
    card.appendChild(fields2);

    const footer = el("div", { class: "item-footer" });
    const diff = itemRazlika(item);
    footer.appendChild(el("span", { class: diff <= 0 ? "diff-neg" : "diff-pos" }, [`Razlika: ${eur(diff)}`]));
    footer.appendChild(el("button", { class: "napomena-toggle" }, ["Napomena ✎"]));
    card.appendChild(footer);

    const napBox = el("div", { class: "napomena-box" + (item.napomena ? " open" : "") });
    napBox.appendChild(el("textarea", { "data-field": "napomena", placeholder: "Napomena…" }, [item.napomena || ""]));
    card.appendChild(napBox);

    return card;
  }
  function field(label, inputEl) {
    const wrap = el("div", {});
    wrap.appendChild(el("span", { class: "field-label" }, [label]));
    wrap.appendChild(inputEl);
    return wrap;
  }
  function buildStatusSelect(item) {
    const sel = el("select", { "data-field": "status" });
    state.statusi_lista.forEach((s) => sel.appendChild(el("option", { value: s, selected: s === item.status }, [s])));
    return sel;
  }
  function buildMonthSelect(item) {
    const months = monthRange(state.postavke.pocetak_plana, state.postavke.kraj_plana);
    const sel = el("select", { "data-field": "plan_mjesec" });
    sel.appendChild(el("option", { value: "" }, ["—"]));
    months.forEach((m) => sel.appendChild(el("option", { value: m, selected: m === item.plan_mjesec }, [monthLabel(m)])));
    return sel;
  }

  function handleItemFieldChange(inputEl) {
    const card = inputEl.closest("[data-wbs]");
    const wbs = card.dataset.wbs;
    const item = state.troskovnik.find((i) => i.wbs === wbs);
    if (!item) return;
    const fieldName = inputEl.dataset.field;
    let value = inputEl.value;
    if (fieldName === "ugovoreno" || fieldName === "placeno") value = value === "" ? 0 : round2(parseFloat(value));
    item[fieldName] = value;
    saveStateDebounced();

    // update this card's plan total badge only affected by ugovoreno/placeno
    const diff = itemRazlika(item);
    const diffSpan = card.querySelector(".item-footer span");
    if (diffSpan) {
      diffSpan.textContent = `Razlika: ${eur(diff)}`;
      diffSpan.className = diff <= 0 ? "diff-neg" : "diff-pos";
    }

    // update category header numbers within currently rendered list
    const group = card.closest(".category-group");
    const filtered = getFilteredTroskovnik();
    if (group) {
      const cat = group.dataset.cat;
      const t = categoryTotals(cat, filtered);
      const nums = group.querySelector(".category-head-nums");
      if (nums) {
        nums.innerHTML = "";
        nums.append(
          el("span", {}, [`Plan: ${eur(t.planirano)}`]),
          el("span", {}, [`Ugovoreno: ${eur(t.ugovoreno)}`]),
          el("span", {}, [`Plaćeno: ${eur(t.placeno)}`])
        );
      }
      const prog = group.querySelector(".category-head > .progress");
      if (prog) {
        const f = t.planirano ? t.placeno / t.planirano : 0;
        prog.classList.toggle("over", t.placeno > t.planirano);
        prog.querySelector("span").style.width = Math.max(0, Math.min(1, f)) * 100 + "%";
      }
    }

    // update totals strip using the currently active filter
    updateTotalsStrip(filtered);
  }

  // =====================================================================
  // CASH FLOW (charts)
  // =====================================================================
  function renderCashflow() {
    const root = $("#view-cashflow");
    root.innerHTML = "";
    root.appendChild(el("h2", { class: "view-title" }, ["Novčani tok i tranše kredita"]));

    const months = monthRange(state.postavke.pocetak_plana, state.postavke.kraj_plana);
    const monthly = months.map((m) => {
      const items = state.troskovnik.filter((i) => i.plan_mjesec === m);
      const planirano = round2(items.reduce((a, i) => a + (i.ukupno || 0), 0));
      const placeno = round2(items.reduce((a, i) => a + (i.placeno || 0), 0));
      const kredit = round2(state.transe.filter((t) => t.mjesec === m).reduce((a, t) => a + (t.iznos || 0), 0));
      return { m, planirano, placeno, kredit };
    });
    let cumPlan = 0, cumKredit = 0;
    monthly.forEach((row) => { cumPlan = round2(cumPlan + row.planirano); cumKredit = round2(cumKredit + row.kredit); row.cumPlan = cumPlan; row.cumKredit = cumKredit; row.neto = round2(cumKredit - cumPlan); });

    // Chart 1: monthly plan vs paid
    const card1 = el("div", { class: "card" });
    card1.appendChild(el("div", { class: "card-title" }, ["Mjesečno: plan vs. plaćeno"]));
    const wrap1 = el("div", { class: "chart-wrap" });
    card1.appendChild(wrap1);
    card1.appendChild(legend([["Planirano", "var(--blue)"], ["Plaćeno", "var(--green)"]]));
    card1.appendChild(el("p", { class: "scroll-hint" }, ["⇤ ⇥ povucite grafikon za sve mjesece"]));
    root.appendChild(card1);
    buildGroupedBarChart(wrap1, {
      labels: monthly.map((r) => monthLabel(r.m)),
      series: [
        { name: "Planirano", cls: "bar-plan", values: monthly.map((r) => r.planirano) },
        { name: "Plaćeno", cls: "bar-paid", values: monthly.map((r) => r.placeno) },
      ],
    });

    // Chart 2: cumulative planned vs credit
    const card2 = el("div", { class: "card" });
    card2.appendChild(el("div", { class: "card-title" }, ["Kumulativno: plan vs. isplata kredita"]));
    const wrap2 = el("div", { class: "chart-wrap" });
    card2.appendChild(wrap2);
    card2.appendChild(legend([["Kumulativno planirano", "var(--blue)"], ["Kumulativno kredit", "var(--yellow)"]]));
    card2.appendChild(el("p", { class: "scroll-hint" }, ["⇤ ⇥ povucite grafikon za sve mjesece"]));
    root.appendChild(card2);
    buildLineChart(wrap2, {
      labels: monthly.map((r) => monthLabel(r.m)),
      series: [
        { name: "Kumulativno planirano", cls: "line-plan", values: monthly.map((r) => r.cumPlan) },
        { name: "Kumulativno kredit", cls: "line-credit", values: monthly.map((r) => r.cumKredit) },
      ],
      extra: monthly.map((r) => r.neto),
    });

    // table view
    const tableCard = el("div", { class: "card" });
    tableCard.appendChild(el("div", { class: "card-title" }, ["Tablica po mjesecima"]));
    const wrap = el("div", { class: "simple-table-wrap" });
    const table = el("table", { class: "simple-table" });
    table.innerHTML = `<thead><tr><th>Mjesec</th><th class="num">Planirano</th><th class="num">Plaćeno</th><th class="num">Kredit</th><th class="num">Kum. plan</th><th class="num">Kum. kredit</th><th class="num">Neto pozicija</th></tr></thead>`;
    const tbody = el("tbody");
    monthly.forEach((r) => {
      tbody.appendChild(el("tr", {}, [
        el("td", {}, [monthLabel(r.m)]),
        el("td", { class: "num" }, [eur(r.planirano)]),
        el("td", { class: "num" }, [eur(r.placeno)]),
        el("td", { class: "num" }, [eur(r.kredit)]),
        el("td", { class: "num" }, [eur(r.cumPlan)]),
        el("td", { class: "num" }, [eur(r.cumKredit)]),
        el("td", { class: "num", style: r.neto < 0 ? "color:var(--critical);font-weight:700" : "color:var(--good);font-weight:700" }, [eur(r.neto)]),
      ]));
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    tableCard.appendChild(wrap);
    root.appendChild(tableCard);

    // tranches editable
    const trancheCard = el("div", { class: "card" });
    trancheCard.appendChild(el("div", { class: "card-title" }, ["Tranše kredita — status"]));
    state.transe.forEach((t) => {
      const row = el("div", { class: "item-card" });
      row.appendChild(el("div", { class: "item-card-top" }, [
        el("div", {}, [el("span", { class: "item-wbs" }, [t.transa + " · " + monthLabel(t.mjesec)]), el("div", { class: "item-opis" }, [t.milestone])]),
        el("div", { class: "item-plan" }, [eur(t.iznos)]),
      ]));
      row.appendChild(el("div", { class: "item-meta" }, [`${pctStr(t.postotak)} kredita · Dokumenti: ${t.dokumenti}`]));
      const fields = el("div", { class: "item-fields" });
      const sel = el("select", {});
      ["Plan", "Zatraženo", "Isplaćeno"].forEach((s) => sel.appendChild(el("option", { value: s, selected: s === t.status }, [s])));
      sel.addEventListener("change", () => { t.status = sel.value; saveStateDebounced(); });
      fields.appendChild(field("Status", sel));
      row.appendChild(fields);
      trancheCard.appendChild(row);
    });
    root.appendChild(trancheCard);
  }

  function legend(items) {
    const l = el("div", { class: "chart-legend" });
    items.forEach(([name, color]) => {
      l.appendChild(el("div", { class: "legend-item" }, [el("span", { class: "legend-swatch", style: `background:${color}` }), name]));
    });
    return l;
  }

  function niceMax(v) {
    if (v <= 0) return 100;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    let step;
    if (norm <= 1) step = 1; else if (norm <= 2) step = 2; else if (norm <= 5) step = 5; else step = 10;
    return step * mag;
  }

  function makeTooltip(wrap) {
    wrap.style.position = "relative";
    const tip = el("div", { class: "tooltip-box" });
    wrap.appendChild(tip);
    return {
      show(x, y, html) { tip.innerHTML = html; tip.style.left = x + "px"; tip.style.top = y + "px"; tip.classList.add("show"); },
      hide() { tip.classList.remove("show"); },
    };
  }

  function buildGroupedBarChart(wrap, opts) {
    const { labels, series } = opts;
    const n = labels.length;
    const groupW = 46;
    const width = Math.max(340, n * groupW);
    const height = 220;
    const pad = { top: 16, right: 10, bottom: 30, left: 52 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxVal = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.classList.add("chart-svg");

    const ns = "http://www.w3.org/2000/svg";
    function svgEl(tag, attrs) {
      const e = document.createElementNS(ns, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }

    // gridlines + y labels
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const y = pad.top + plotH - (plotH * i) / gridSteps;
      svg.appendChild(svgEl("line", { x1: pad.left, x2: width - pad.right, y1: y, y2: y, stroke: "var(--gridline)", "stroke-width": 1 }));
      const val = (maxVal * i) / gridSteps;
      const label = svgEl("text", { x: pad.left - 6, y: y + 3, "text-anchor": "end", "font-size": 9, fill: "var(--text-muted)" });
      label.textContent = val >= 1000 ? Math.round(val / 1000) + "k" : String(Math.round(val));
      svg.appendChild(label);
    }

    const barW = (groupW - 10) / series.length;
    const marks = [];
    labels.forEach((lab, gi) => {
      const gx = pad.left + gi * groupW + 5;
      series.forEach((s, si) => {
        const v = s.values[gi] || 0;
        const h = maxVal > 0 ? (v / maxVal) * plotH : 0;
        const x = gx + si * barW;
        const y = pad.top + plotH - h;
        const rect = svgEl("rect", { x, y, width: Math.max(2, barW - 3), height: Math.max(0, h), rx: 3, class: s.cls });
        marks.push([rect, lab, s.name, v]);
        svg.appendChild(rect);
      });
      const xlab = svgEl("text", { x: gx + (barW * series.length) / 2, y: height - pad.bottom + 14, "text-anchor": "middle", "font-size": 9, fill: "var(--text-muted)" });
      xlab.textContent = lab;
      svg.appendChild(xlab);
    });

    wrap.innerHTML = "";
    wrap.appendChild(svg);
    const tooltip = makeTooltip(wrap);
    marks.forEach(([rect, lab, name, v]) => {
      function showTip(e) {
        const r = wrap.getBoundingClientRect();
        tooltip.show(e.clientX - r.left, e.clientY - r.top, `<b>${esc(lab)}</b><br>${esc(name)}: ${eur(v)}`);
      }
      rect.addEventListener("pointerenter", showTip);
      rect.addEventListener("pointermove", showTip);
      rect.addEventListener("pointerleave", () => tooltip.hide());
    });
  }

  function buildLineChart(wrap, opts) {
    const { labels, series, extra } = opts;
    const n = labels.length;
    const stepX = 42;
    const width = Math.max(340, (n - 1) * stepX + 40);
    const height = 220;
    const pad = { top: 16, right: 16, bottom: 30, left: 56 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxVal = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));

    const ns = "http://www.w3.org/2000/svg";
    function svgEl(tag, attrs) {
      const e = document.createElementNS(ns, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.classList.add("chart-svg");

    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const y = pad.top + plotH - (plotH * i) / gridSteps;
      svg.appendChild(svgEl("line", { x1: pad.left, x2: width - pad.right, y1: y, y2: y, stroke: "var(--gridline)", "stroke-width": 1 }));
      const val = (maxVal * i) / gridSteps;
      const label = svgEl("text", { x: pad.left - 6, y: y + 3, "text-anchor": "end", "font-size": 9, fill: "var(--text-muted)" });
      label.textContent = val >= 1000 ? Math.round(val / 1000) + "k" : String(Math.round(val));
      svg.appendChild(label);
    }

    function xAt(i) { return pad.left + (n > 1 ? (i * plotW) / (n - 1) : plotW / 2); }
    function yAt(v) { return pad.top + plotH - (maxVal > 0 ? (v / maxVal) * plotH : 0); }

    series.forEach((s) => {
      let d = "";
      s.values.forEach((v, i) => { d += (i === 0 ? "M" : "L") + xAt(i).toFixed(1) + "," + yAt(v).toFixed(1) + " "; });
      svg.appendChild(svgEl("path", { d, fill: "none", class: s.cls, "stroke-width": 2 }));
    });

    labels.forEach((lab, i) => {
      if (i % Math.ceil(n / 10) !== 0 && i !== n - 1) return;
      const xlab = svgEl("text", { x: xAt(i), y: height - pad.bottom + 14, "text-anchor": "middle", "font-size": 9, fill: "var(--text-muted)" });
      xlab.textContent = lab;
      svg.appendChild(xlab);
    });

    const dots = [];
    labels.forEach((lab, i) => {
      series.forEach((s) => {
        const c = svgEl("circle", { cx: xAt(i), cy: yAt(s.values[i]), r: 4, class: s.cls.replace("line-", "dot-") });
        dots.push(c);
        svg.appendChild(c);
      });
    });

    wrap.innerHTML = "";
    wrap.appendChild(svg);
    const tooltip = makeTooltip(wrap);
    dots.forEach((c, idx) => {
      const i = Math.floor(idx / series.length);
      function showTip(e) {
        const r = wrap.getBoundingClientRect();
        let html = `<b>${esc(labels[i])}</b>`;
        series.forEach((s) => { html += `<br>${esc(s.name)}: ${eur(s.values[i])}`; });
        if (extra) html += `<br>Neto pozicija: ${eur(extra[i])}`;
        tooltip.show(e.clientX - r.left, e.clientY - r.top, html);
      }
      c.addEventListener("pointerenter", showTip);
      c.addEventListener("pointermove", showTip);
      c.addEventListener("pointerleave", () => tooltip.hide());
    });
  }

  // =====================================================================
  // NABAVA MATERIJALA
  // =====================================================================
  function renderNabava() {
    const root = $("#view-nabava");
    root.innerHTML = "";
    root.appendChild(el("h2", { class: "view-title" }, ["Nabava materijala"]));
    root.appendChild(el("p", { style: "font-size:.82rem;color:var(--text-secondary);margin:-6px 2px 14px" }, [
      "Ciljne cijene i budžeti za ključne materijale prije prikupljanja ponuda.",
    ]));

    const listWrap = el("div", {});
    root.appendChild(listWrap);
    listWrap.addEventListener("input", (e) => { if (e.target.matches("[data-mfield]")) handleMaterialChange(e.target); });
    listWrap.addEventListener("change", (e) => { if (e.target.matches("[data-mfield]")) handleMaterialChange(e.target); });

    state.nabava.forEach((mat, idx) => {
      const card = el("div", { class: "item-card", "data-midx": idx, style: "border:1px solid var(--border);border-radius:var(--radius-m);margin-bottom:10px" });
      card.appendChild(el("div", { class: "item-card-top" }, [
        el("div", {}, [el("span", { class: "item-wbs" }, [mat.cjelina]), el("div", { class: "item-opis" }, [mat.materijal])]),
        el("div", { class: "item-plan", id: `mat-budzet-${idx}` }, [eur(mat.budzet)]),
      ]));
      card.appendChild(el("div", { class: "item-meta" }, [`Rok narudžbe: ${monthLabel(mat.rok)}`]));

      const fields = el("div", { class: "item-fields" });
      fields.appendChild(field("Količina", el("input", { type: "number", step: "0.01", "data-mfield": "kolicina", value: mat.kolicina, "data-unit": mat.jedinica })));
      fields.appendChild(field(`Cijena/${mat.jedinica} (€)`, el("input", { type: "number", step: "0.01", "data-mfield": "ciljana_cijena", value: mat.ciljana_cijena })));
      fields.appendChild(field("Popust (%)", el("input", { type: "number", step: "1", "data-mfield": "popust", value: mat.popust })));
      const statusSel = el("select", { "data-mfield": "status" });
      NABAVA_STATUS_OPTIONS.forEach((s) => statusSel.appendChild(el("option", { value: s, selected: s === mat.status }, [s])));
      fields.appendChild(field("Status", statusSel));
      card.appendChild(fields);

      const fields2 = el("div", { class: "item-fields" });
      fields2.appendChild(field("Dobavljač", el("input", { type: "text", "data-mfield": "dobavljac", value: mat.dobavljac || "", placeholder: "—" })));
      card.appendChild(fields2);

      const napBox = el("div", { class: "napomena-box open" });
      napBox.appendChild(el("textarea", { "data-mfield": "napomena", placeholder: "Napomena…" }, [mat.napomena || ""]));
      card.appendChild(napBox);
      card.appendChild(el("div", { class: "izvor-note" }, [mat.izvor || ""]));

      listWrap.appendChild(card);
    });
  }

  function handleMaterialChange(inputEl) {
    const card = inputEl.closest("[data-midx]");
    const idx = Number(card.dataset.midx);
    const mat = state.nabava[idx];
    const fname = inputEl.dataset.mfield;
    let value = inputEl.value;
    if (["kolicina", "ciljana_cijena", "popust"].includes(fname)) value = value === "" ? 0 : parseFloat(value);
    mat[fname] = value;
    if (["kolicina", "ciljana_cijena", "popust"].includes(fname)) {
      mat.budzet = round2((mat.kolicina || 0) * (mat.ciljana_cijena || 0) * (1 - (mat.popust || 0) / 100));
      const budEl = $(`#mat-budzet-${idx}`);
      if (budEl) budEl.textContent = eur(mat.budzet);
    }
    saveStateDebounced();
  }

  // =====================================================================
  // POVRSINE PROJEKTA
  // =====================================================================
  function renderPovrsine() {
    const root = $("#view-povrsine");
    root.innerHTML = "";
    root.appendChild(el("h2", { class: "view-title" }, ["Površine projekta"]));

    const totalsGrid = el("div", { class: "kpi-grid" });
    const t = state.povrsine_totali;
    Object.keys(t).forEach((k) => totalsGrid.appendChild(kpiCard(k, t[k].toLocaleString("hr-HR") + " m²", "")));
    root.appendChild(totalsGrid);

    const etaze = Array.from(new Set(state.povrsine.map((p) => p.etaza)));
    etaze.forEach((et) => {
      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "card-title" }, [et]));
      const wrap = el("div", { class: "simple-table-wrap" });
      const table = el("table", { class: "simple-table" });
      table.innerHTML = `<thead><tr><th>Prostor</th><th>Obrada</th><th class="num">m²</th><th>Grijano</th><th>Pod/keramika</th></tr></thead>`;
      const tbody = el("tbody");
      state.povrsine.filter((p) => p.etaza === et).forEach((p) => {
        tbody.appendChild(el("tr", {}, [
          el("td", {}, [p.prostor + (p.napomena ? ` (${p.napomena})` : "")]),
          el("td", {}, [p.obrada || "—"]),
          el("td", { class: "num" }, [String(p.povrsina)]),
          el("td", {}, [p.grijano]),
          el("td", {}, [p.pod]),
        ]));
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      card.appendChild(wrap);
      root.appendChild(card);
    });
  }

  // =====================================================================
  // POSTAVKE
  // =====================================================================
  function renderPostavke() {
    const root = $("#view-postavke");
    root.innerHTML = "";
    root.appendChild(el("h2", { class: "view-title" }, ["Postavke projekta"]));

    const card = el("div", { class: "card" });
    const grid = el("div", { class: "form-grid" });
    const p = state.postavke;

    function settingField(label, key, type) {
      const wrap = el("div", { class: "form-field" });
      wrap.appendChild(el("label", {}, [label]));
      const input = el("input", { type: type || "text", value: p[key] == null ? "" : p[key] });
      input.addEventListener("input", () => {
        p[key] = (type === "number") ? (input.value === "" ? 0 : parseFloat(input.value)) : input.value;
        saveStateDebounced();
        if (key === "lokacija") updateHeaderSubtitle();
      });
      wrap.appendChild(input);
      return wrap;
    }
    grid.appendChild(settingField("Investitor", "investitor"));
    grid.appendChild(settingField("Lokacija", "lokacija"));
    grid.appendChild(settingField("Ciljani budžet (€)", "ciljani_budzet", "number"));
    grid.appendChild(settingField("Iznos kredita (€)", "iznos_kredita", "number"));
    grid.appendChild(settingField("Vlastita sredstva (€)", "vlastita_sredstva", "number"));
    grid.appendChild(settingField("Početak plana", "pocetak_plana", "month"));
    grid.appendChild(settingField("Kraj plana", "kraj_plana", "month"));
    card.appendChild(grid);

    const napWrap = el("div", { class: "form-field", style: "margin-top:12px" });
    napWrap.appendChild(el("label", {}, ["Napomena o PDV-u"]));
    const napInput = el("textarea", { style: "width:100%;min-height:50px" }, [p.pdv_napomena || ""]);
    napInput.addEventListener("input", () => { p.pdv_napomena = napInput.value; saveStateDebounced(); });
    napWrap.appendChild(napInput);
    card.appendChild(napWrap);
    root.appendChild(card);

    // izvori i napomene
    const izvorCard = el("div", { class: "card" });
    izvorCard.appendChild(el("div", { class: "card-title" }, ["Izvori i napomene projekta"]));
    (state.izvori || []).forEach((iz) => {
      const det = el("details", { class: "accordion-note" });
      det.appendChild(el("summary", {}, [`${iz.podrucje}`]));
      det.appendChild(el("p", {}, [iz.vrijednost]));
      det.appendChild(el("p", { style: "color:var(--text-muted);font-style:italic" }, [`Izvor: ${iz.izvor} — ${iz.napomena || ""}`]));
      izvorCard.appendChild(det);
    });
    root.appendChild(izvorCard);

    // data management
    const dataCard = el("div", { class: "card" });
    dataCard.appendChild(el("div", { class: "card-title" }, ["Upravljanje podacima"]));
    dataCard.appendChild(el("p", { style: "font-size:.8rem;color:var(--text-secondary)" }, [
      "Svi uneseni podaci spremaju se lokalno u pregledniku ovog uređaja (localStorage) — nema poslužitelja niti slanja podataka trećim stranama. Redovito izvezite sigurnosnu kopiju.",
    ]));
    const btnRow = el("div", { class: "btn-row" });
    const exportBtn = el("button", { class: "btn primary" }, ["⬇ Izvezi podatke (JSON)"]);
    exportBtn.addEventListener("click", exportData);
    const importLabel = el("label", { class: "btn" }, ["⬆ Uvezi podatke"]);
    const importInput = el("input", { type: "file", accept: "application/json", style: "display:none" });
    importInput.addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); });
    importLabel.appendChild(importInput);
    const resetBtn = el("button", { class: "btn danger" }, ["↺ Vrati izvorne podatke"]);
    resetBtn.addEventListener("click", () => {
      if (confirm("Vratiti sve podatke na izvorne vrijednosti iz Excela? Sve vaše izmjene bit će izgubljene.")) {
        state = JSON.parse(JSON.stringify(DATA));
        saveStateNow();
        updateHeaderSubtitle();
        toast("Vraćeno na izvorno");
        switchTab("dashboard");
      }
    });
    btnRow.append(exportBtn, importLabel, resetBtn);
    dataCard.appendChild(btnRow);
    root.appendChild(dataCard);
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: `troskovnik-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Izvezeno");
  }
  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.troskovnik)) throw new Error("neispravan format");
        state = parsed;
        saveStateNow();
        updateHeaderSubtitle();
        toast("Podaci uvezeni");
        switchTab("dashboard");
      } catch (e) {
        alert("Uvoz nije uspio: datoteka nije u ispravnom formatu.");
      }
    };
    reader.readAsText(file);
  }

  function updateHeaderSubtitle() {
    const subtitleEl = $("#project-subtitle");
    if (subtitleEl) subtitleEl.textContent = state.postavke.lokacija || "";
  }

  // ---------------------------------------------------------------- init
  updateHeaderSubtitle();
  renderDashboard();
})();
