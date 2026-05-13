(function () {
  if (window.__ccInjected) return;
  window.__ccInjected = true;

  const btn = document.createElement("button");
  btn.id = "cc-btn";
  btn.textContent = "Check ingredients";
  document.body.appendChild(btn);

  let busy = false;
  btn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    try { await run(); } finally { setTimeout(() => busy = false, 3000); }
  });

  async function run() {
    showOverlay({ loading: true });

    const name = getProductName();
    const marketplace = window.location.hostname;

    // CHECK CACHE FIRST
    const cacheKey = "cc:" + name;
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (cached && Date.now() - cached.t < 7 * 24 * 3600 * 1000) {
      showOverlay({ data: cached.data });
      return;
    }

    // Try 1: scrape what's already visible / in DOM
    let ingredients = findIngredients();

    // Try 2: click anything labeled "Ingredients" to expand accordions/tabs, then scrape again
    if (!ingredients || ingredients.length < 8) {
      const opened = tryExpandIngredientSection();
      if (opened) {
        await waitMs(900);
        ingredients = findIngredients();
      }
    }

    // Try 3: regex the full body text as a last resort
    if (!ingredients || ingredients.length < 8) {
      ingredients = findByTextPattern();
    }

    if (!ingredients || ingredients.length < 8) {
      showOverlay({ error: "Ingredients not found. Try scrolling to the ingredients section and expanding it, then click again. If unavailable, this product may not list ingredients on this marketplace." });
      return;
    }

    try {
      chrome.runtime.sendMessage({ type: "analyze", name, ingredients, marketplace }, (resp) => {
        if (chrome.runtime.lastError) {
          return showOverlay({ error: "Extension was reloaded. Refresh this page and try again." });
        }
        if (!resp?.ok) return showOverlay({ error: resp?.error || "Unknown error" });
        chrome.storage.local.set({ [cacheKey]: { t: Date.now(), data: resp.data } });
        showOverlay({ data: resp.data });
      });
    } catch (e) {
      if (/Extension context invalidated/i.test(e.message)) {
        showOverlay({ error: "Extension was reloaded. Refresh this page and try again." });
      } else {
        showOverlay({ error: e.message });
      }
    }
  }

  function getProductName() {
    return (document.querySelector("h1")?.innerText || document.title).trim();
  }

  function tryExpandIngredientSection() {
    const selector = 'button, summary, [role="button"], [role="tab"], [aria-expanded], a, h2, h3, h4, div, span, li';
    const clickables = [...document.querySelectorAll(selector)].filter(el => {
      const t = (el.textContent || "").trim().toLowerCase();
      if (t.length === 0 || t.length > 50) return false;
      if (!/\bingredients?\b/.test(t)) return false;
      if (el.querySelectorAll("*").length > 20) return false;
      return true;
    });
    let clicked = false;
    for (const el of clickables) {
      try { el.click(); clicked = true; } catch {}
    }
    return clicked;
  }

  function findIngredients() {
    const labels = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,strong,b,dt,span,div,p,button,summary,th,td")]
      .filter(el => {
        const txt = (el.textContent || "").trim();
        return /^(key\s+|full\s+list\s+of\s+)?ingredients?\s*[:\-]?\s*$/i.test(txt) && txt.length < 50;
      });
    for (const label of labels) {
      const text = grabTextNear(label);
      const parsed = parseList(text);
      if (parsed) return parsed;
    }
    return null;
  }

  function grabTextNear(label) {
    let sib = label.nextElementSibling;
    while (sib) {
      const t = (sib.textContent || "").trim();
      if (t.length > 60 && t.includes(",")) return t;
      sib = sib.nextElementSibling;
    }
    const parent = label.parentElement;
    if (parent) {
      const raw = (parent.textContent || "").replace(label.textContent || "", "").trim();
      if (raw.length > 60 && raw.includes(",")) return raw;
      let pnext = parent.nextElementSibling;
      while (pnext) {
        const t = (pnext.textContent || "").trim();
        if (t.length > 60 && t.includes(",")) return t;
        pnext = pnext.nextElementSibling;
      }
    }
    return "";
  }

  function findByTextPattern() {
    const text = (document.body.textContent || "").replace(/\s+/g, " ");
    const match = text.match(/ingredients?\s*[:\-]\s*([A-Za-z0-9][^\n]{60,3000})/i);
    if (!match) return null;
    const cut = match[1].split(/\b(?:how to use|directions|warnings?|benefits|about this item|country of origin|storage|shelf life|manufactured)\b/i)[0];
    return parseList(cut);
  }

  function parseList(raw) {
    if (!raw) return null;
    const junkWords = /^(read more|show more|see more|view more|less|disclaimer|note|ml|g|oz|inr|rs|rupees|usd|free|new|sale)$/i;
    const seen = new Set();
    const parts = raw
      .split(/[,;]/)
      .map(s => s.replace(/\([^)]*\)/g, "").replace(/\*+/g, "").replace(/\s+/g, " ").trim())
      .filter(s => {
        if (s.length < 2 || s.length > 120) return false;
        if (!/[a-z]/i.test(s)) return false;
        if (/^\d+\s*(ml|g|oz|mg|kg|l|%)?$/i.test(s)) return false;
        if (junkWords.test(s)) return false;
        const key = s.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return parts.length >= 3 ? parts.slice(0, 60) : null;
  }

  const waitMs = (ms) => new Promise(r => setTimeout(r, ms));

  // Change 4: client-side comedogenic ingredient list
  // Comedogenic rating 4-5 (high risk) — common names + INCI names
  // Sources: Kligman & Mills scale, published dermatology comedogenicity research
  const COMEDOGENIC = new Set([

    // ── HIGHLY COMEDOGENIC OILS (rating 4-5) ──
    "coconut oil", "cocos nucifera oil", "cocos nucifera (coconut) oil",
    "cocoa butter", "theobroma cacao seed butter",
    "wheat germ oil", "triticum vulgare germ oil", "triticum vulgare (wheat) germ oil",
    "flaxseed oil", "linum usitatissimum seed oil",
    "linseed oil",
    "palm oil", "elaeis guineensis oil",
    "soybean oil", "glycine soja oil", "glycine soja (soybean) oil",
    "cotton seed oil", "gossypium herbaceum seed oil",
    "olive oil", "olea europaea fruit oil", "olea europaea (olive) fruit oil",
    "corn oil", "zea mays oil",
    "peach kernel oil", "prunus persica kernel oil",
    "apricot kernel oil", "prunus armeniaca kernel oil",
    "almond oil", "sweet almond oil", "prunus amygdalus dulcis oil",
    "avocado oil", "persea gratissima oil",
    "sesame oil", "sesamum indicum seed oil",
    "evening primrose oil", "oenothera biennis oil",
    "rosehip oil", "rosa canina fruit oil", "rosa moschata seed oil",
    "marula oil", "sclerocarya birrea seed oil",
    "hemp seed oil", "cannabis sativa seed oil",
    "pumpkin seed oil", "cucurbita pepo seed oil",

    // ── MODERATE-HIGH COMEDOGENIC OILS (rating 3-4) ──
    "shea butter", "butyrospermum parkii butter",
    "lanolin", "acetylated lanolin", "lanolin alcohol",
    "mink oil",
    "carrot oil", "daucus carota sativa oil",

    // ── PORE-CLOGGING ESTERS (rating 4-5) ──
    "isopropyl myristate",
    "isopropyl palmitate",
    "isopropyl isostearate",
    "butyl stearate",
    "isostearyl isostearate",
    "decyl oleate",
    "octyl stearate",
    "octyl palmitate", "ethylhexyl palmitate",
    "myristyl myristate",
    "myristyl lactate",
    "isocetyl stearate",
    "isodecyl oleate",
    "propylene glycol monostearate",
    "glyceryl-3-diisostearate",
    "hexadecyl alcohol",

    // ── IRRITATING / BARRIER-DISRUPTING ──
    "sodium lauryl sulfate", "sls",
    "sodium laureth sulfate", "sles",
    "ammonium lauryl sulfate",
    "alcohol denat", "denatured alcohol", "sd alcohol",
    "sd alcohol 40", "alcohol sd-40",

    // ── HEAVY SILICONES (occlusive, rating 3-4) ──
    "dimethicone",
    "cyclopentasiloxane",
    "cyclohexasiloxane",
    "cyclomethicone",

    // ── ALGAE / SEAWEED (can be comedogenic) ──
    "algae extract", "algae", "seaweed extract",
    "carrageenan",
    "red algae extract",

    // ── OTHER KNOWN COMEDOGENS ──
    "coal tar",
    "sodium chloride",          // table salt — clogs pores in rinse-off products
    "potassium chloride",
    "lauric acid",              // found in coconut — highly comedogenic component
    "myristic acid",
    "stearic acid",             // rating 2-3, included for awareness
    "acetylated lanolin alcohol",
    "peg-16 lanolin",
    "sulfated castor oil",
    "oleic acid",               // the comedogenic fraction in many oils
    "d&c red dyes",             // dyes linked to comedogenicity
    "benzaldehyde"
  ]);

  function isComedogenic(name) {
    // Strip parenthetical notes e.g. "Cocos Nucifera Oil (Coconut Oil)" → check both
    const clean = name.toLowerCase().trim();
    if (COMEDOGENIC.has(clean)) return true;
    // Also check content inside parentheses e.g. extract the "coconut oil" part
    const inner = clean.replace(/^[^(]*\(([^)]+)\).*$/, "$1").trim();
    return COMEDOGENIC.has(inner);
  }

  function showOverlay(state) {
    let root = document.getElementById("cc-overlay");
    if (!root) {
      root = document.createElement("div");
      root.id = "cc-overlay";
      document.body.appendChild(root);
    }

    if (state.loading) {
      root.innerHTML = `<div class="cc-card"><button class="cc-close">×</button>Analyzing ingredients...</div>`;

    } else if (state.error) {
      root.innerHTML = `<div class="cc-card"><button class="cc-close">×</button><div class="cc-err">${esc(state.error)}</div></div>`;

    } else {
      const d = state.data;

      // Change 1: top insights as styled bullet points with section label
      const insightsHTML = `
        <div class="cc-insights-block">
          <div class="cc-insights-title">Key Takeaways</div>
          ${d.top_insights.map(i => `
            <div class="cc-insight-item">
              <div class="cc-insight-dot"></div>
              <div class="cc-insight-text">${esc(i)}</div>
            </div>`).join("")}
        </div>`;

      // Changes 3 + 4: heads up only for real concerns, comedogenic tag added
      const ingredientsHTML = d.ingredients.map(i => {
        const hasRealConcern = i.concerns &&
          !i.concerns.toLowerCase().startsWith("none");
        const comedogenic = isComedogenic(i.name);
        return `
          <div class="cc-ing">
            <div class="cc-ing-name-row">
              <b>${esc(i.name)}</b>
              <span class="cc-tag cc-${tagCls(i.class)}">${esc(i.class)}</span>
              ${comedogenic ? `<span class="cc-tag cc-comedogenic">comedogenic</span>` : ""}
            </div>
            <div class="cc-ing-fn">${esc(i.function)}</div>
            ${hasRealConcern ? `
              <div class="cc-concern">
                <span class="cc-concern-icon">⚠️</span>
                <span>${esc(i.concerns)}</span>
              </div>` : ""}
          </div>`;
      }).join("");

      root.innerHTML = `
        <div class="cc-card">
          <button class="cc-close">×</button>
          <div class="cc-name">${esc(d.product.name)}</div>
          <div class="cc-verdict ${vclass(d.verdict)}">${esc(d.verdict)}</div>
          ${insightsHTML}
          <div class="cc-section-title">Ingredient Breakdown</div>
          ${ingredientsHTML}
        </div>`;
    }

    root.querySelector(".cc-close")?.addEventListener("click", () => root.remove());
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const vclass = v => {
    const lower = v.toLowerCase();
    if (lower.includes("safe") || lower.includes("good for") || lower.startsWith("generally")) return "safe";
    if (lower.includes("avoid") || lower.includes("not recommended")) return "caution";
    return "mixed";
  };
  const tagCls = c => c === "beneficial" ? "good" : c === "potential concern" ? "bad" : "neutral";
})();
