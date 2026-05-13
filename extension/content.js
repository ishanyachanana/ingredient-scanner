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
    if (!ingredients || ingredients.length < 3) {
      const opened = tryExpandIngredientSection();
      if (opened) {
        await waitMs(1500);
        ingredients = findIngredients();
      }
    }

    // Try 3: regex the full body text as a last resort
    if (!ingredients || ingredients.length < 3) {
      ingredients = findByTextPattern();
    }

    if (!ingredients || ingredients.length < 3) {
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
      if (t.length === 0 || t.length > 60) return false;
      // Match: "ingredients", "key ingredients", "full ingredients", "ingredient list" etc.
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
        // Match: "Ingredients", "Key Ingredients", "Full Ingredients", "Ingredient List", "All Ingredients" etc.
        return /^(key\s+|full\s+|all\s+|complete\s+|active\s+|full\s+list\s+of\s+)?ingredients?\s*(list)?\s*[:\-]?\s*$/i.test(txt) && txt.length < 60;
      });
    for (const label of labels) {
      const text = grabTextNear(label);
      const parsed = parseList(text);
      if (parsed) return parsed;
    }
    return null;
  }

  function grabTextNear(label) {
    // Check following siblings first
    let sib = label.nextElementSibling;
    while (sib) {
      const t = (sib.textContent || "").trim();
      // Standard comma-separated text
      if (t.length > 60 && t.includes(",")) return t;
      // ul/li list (Clinikally-style) — join li items with commas
      const listItems = [...sib.querySelectorAll("li")]
        .map(li => li.textContent.trim()).filter(s => s.length > 1);
      if (listItems.length >= 3) return listItems.join(", ");
      sib = sib.nextElementSibling;
    }
    const parent = label.parentElement;
    if (parent) {
      const raw = (parent.textContent || "").replace(label.textContent || "", "").trim();
      if (raw.length > 60 && raw.includes(",")) return raw;
      // Check parent's following siblings
      let pnext = parent.nextElementSibling;
      while (pnext) {
        const t = (pnext.textContent || "").trim();
        if (t.length > 60 && t.includes(",")) return t;
        // ul/li inside parent sibling
        const listItems = [...pnext.querySelectorAll("li")]
          .map(li => li.textContent.trim()).filter(s => s.length > 1);
        if (listItems.length >= 3) return listItems.join(", ");
        pnext = pnext.nextElementSibling;
      }
    }
    return "";
  }

  function findByTextPattern() {
    const text = (document.body.textContent || "").replace(/\s+/g, " ");
    const match = text.match(/(?:key\s+|full\s+|all\s+)?ingredients?\s*[:\-]\s*([A-Za-z0-9][^\n]{60,3000})/i);
    if (!match) return null;
    const cut = match[1].split(/\b(?:how to use|directions|warnings?|benefits|about this item|country of origin|storage|shelf life|manufactured)\b/i)[0];
    return parseList(cut);
  }

  function parseList(raw) {
    if (!raw) return null;
    const junkWords = /^(read more|show more|see more|view more|less|disclaimer|note|ml|g|oz|inr|rs|rupees|usd|free|new|sale)$/i;

    // Reject free-from claim words e.g. "No parabens, No sulfates" sections
    const categoryLabels = /^(parabens?|sulfates?|alcohols?|silicones?|mineral oils?|essential oils?|animal products?|fragrances?|dyes?|preservatives?|surfactants?|phthalates?|formaldehyde|microplastics?|no\s+\w+)$/i;

    const seen = new Set();
    const parts = raw
      .split(/[,;]/)
      .map(s => s.replace(/\([^)]*\)/g, "").replace(/\*+/g, "").replace(/\s+/g, " ").trim())
      .filter(s => {
        if (s.length < 2 || s.length > 120) return false;
        if (!/[a-z]/i.test(s)) return false;
        if (/^\d+\s*(ml|g|oz|mg|kg|l|%)?$/i.test(s)) return false;
        if (junkWords.test(s)) return false;
        if (categoryLabels.test(s)) return false;
        const key = s.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    // Reject if looks like a free-from/category list (few items, mostly single words)
    const singleWordCount = parts.filter(p => !p.includes(" ")).length;
    if (parts.length < 10 && singleWordCount / parts.length > 0.5) return null;

    return parts.length >= 3 ? parts.slice(0, 60) : null;
  }

  const waitMs = (ms) => new Promise(r => setTimeout(r, ms));

  // Change 4: client-side comedogenic ingredient list
  // Comedogenic ratings directly from Fulton (1989) Table I
  // Journal of the Society of Cosmetic Chemists, 40, 321-333
  // Only ingredients rated 4-5 (confirmed) included
  // Grade 3 ingredients noted separately for reference but not flagged

  const COMEDOGENIC = new Set([

    // ── LANOLINS — rated 4 (Fulton Table I) ──
    "acetylated lanolin alcohol",
    "peg-16 lanolin", "peg 16 lanolin",

    // ── FATTY ACIDS & ESTERS — rated 4-5 (Fulton Table I) ──
    "lauric acid",                    // rated 4
    "cetyl acetate",                  // rated 4
    "ethylhexyl palmitate",           // rated 4
    "isopropyl linolate",             // rated 4
    "isopropyl isostearate",          // rated 5
    "isopropyl myristate",            // rated 5
    "isopropyl palmitate",            // rated 4
    "isostearyl isostearate",         // rated 4
    "myristyl lactate",               // rated 4
    "myristyl myristate",             // rated 5
    "stearyl heptanoate",             // rated 4

    // ── ALCOHOLS — rated 4 (Fulton Table I) ──
    "isocetyl alcohol",               // rated 4
    "oleyl alcohol",                  // rated 4
    "cetearyl alcohol",               // rated 4 (when combined with ceteareth-20)

    // ── GLYCOLS & DERIVATIVES — rated 4 (Fulton Table I) ──
    "glyceryl-3-diisostearate",       // rated 4
    "polyglyceryl-3-diisostearate",   // rated 4
    "polyglyceryl 3 diisostearate",

    // ── ETHOXYLATES — rated 4-5 (Fulton Table I) ──
    "laureth-4",                      // rated 5
    "steareth-10",                    // rated 4
    "oleth-3",                        // rated 5
    "ppp 5 ceteth 10 phosphate",      // rated 4

    // ── OILS — rated 4 (Fulton Table I) ──
    "cocoa butter", "theobroma cacao seed butter",          // rated 4
    "coconut butter", "coconut oil", "cocos nucifera oil",  // rated 4

    // ── GRADE 3 (borderline, worth flagging) ──
    "butyl stearate",                 // rated 3
    "decyl oleate",                   // rated 3
    "dioctyl malate",                 // rated 3
    "dioctyl succinate",              // rated 3
    "wheat germ glyceride",           // rated 3
    "peg-8 stearate", "peg 8 stearate", // rated 3
    "peg-200 dilaurate", "peg 200 dilaurate", // rated 3
    "laureth-23",                     // rated 3
    "oleth-5",                        // rated 3
    "sulfated jojoba oil",            // rated 3
    "glyceryl stearate se",           // rated 3 (SE form only)
    "sorbitan oleate",                // rated 3
    "myristic acid",                  // rated 3
    "hydrogenated vegetable oil",     // rated 3
    "sesame oil", "sesamum indicum seed oil",   // rated 3
    "corn oil", "zea mays oil",                 // rated 3
    "avocado oil", "persea gratissima oil",      // rated 3
    "evening primrose oil", "oenothera biennis oil", // rated 3
    "mink oil",                       // rated 3
    "soybean oil", "glycine soja oil", // rated 3
    "shark liver oil",                // rated 3
    "cotton seed oil", "gossypium herbaceum seed oil", // rated 3
    "ppg-2 myristyl propionate", "ppg 2 myristyl propionate", // rated 3
    "ppg-10 cetyl ether", "ppg 10 cetyl ether",  // rated 3
    "water-soluble sulfur",           // rated 3
    "stearic acid tea", "stearic acid:tea",       // rated 3
    "xylene",                         // rated 4 (solvent, rare in cosmetics)
    "d&c red #3", "d&c red 3",       // rated 3
    "d&c red #17", "d&c red 17",     // rated 3
    "d&c red #30", "d&c red 30",     // rated 3
    "d&c red #36", "d&c red 36",     // rated 3
  ]);

  // Grade 2 — low concern, borderline (Fulton 1989)
  const LOW_CONCERN = new Set([
    // Lanolins — rated 2
    "lanolin alcohol", "laneth-10", "ppg-12 peg-65 lanolin oil",

    // Fatty acids — rated 2
    "capric acid", "palmitic acid", "stearic acid",
    "ascorbyl palmitate", "di (2 ethylhexyl) succinate",
    "ethylhexyl pelargonate", "isodecyl oleate",

    // Alcohols — rated 2
    "myristyl alcohol", "cetyl alcohol", "cetearyl alcohol",
    "stearyl alcohol", "ceteareth-20",

    // Glycols & derivatives — rated 2
    "pg caprylate/caprate", "pg dipelargonate",
    "glyceryl stearate se",
    "pentaerythrital tetra isostearate",
    "peg-100 distearate", "peg-150 distearate",
    "steareth-2", "steareth-20",
    "oleth-10",

    // Oils — rated 2
    "olive oil", "olea europaea fruit oil",
    "sandalwood seed oil",
    "almond oil", "prunus amygdalus dulcis oil",
    "apricot kernel oil", "prunus armeniaca kernel oil",
    "peanut oil", "arachis hypogaea oil",

    // Silicones — rated 1 (very low, but worth surfacing)
    "dimethicone", "simethicone",

    // Waxes — rated 2 (variable)
    "beeswax", "cera alba",
    "jojoba oil", "simmondsia chinensis seed oil",

    // Vitamins — rated 2 (variable)
    "tocopherol", "vitamin e",
    "vitamin a palmitate", "retinyl palmitate",

    // Misc — rated 2
    "myristic acid",
    "phytantriol",
    "triethanolamine",
    "d&c red #4", "d&c red 4",
    "d&c red #21", "d&c red 21",
    "d&c red #27", "d&c red 27",
  ]);

  function getComedogenicTier(name) {
    const clean = name.toLowerCase().trim();
    const inner = clean.replace(/^[^(]*\(([^)]+)\).*$/, "$1").trim();
    if (COMEDOGENIC.has(clean) || COMEDOGENIC.has(inner)) return "high";
    if (LOW_CONCERN.has(clean) || LOW_CONCERN.has(inner)) return "low";
    return null;
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

      // Changes 3 + 4: heads up only for real concerns, two-tier comedogenic tags
      const ingredientsHTML = d.ingredients.map(i => {
        const hasRealConcern = i.concerns &&
          !i.concerns.toLowerCase().startsWith("none");
        const tier = getComedogenicTier(i.name);
        return `
          <div class="cc-ing">
            <div class="cc-ing-name-row">
              <b>${esc(i.name)}</b>
              <span class="cc-tag cc-${tagCls(i.class)}">${esc(i.class)}</span>
              ${tier === "high" ? `<span class="cc-tag cc-comedogenic">comedogenic</span>` : ""}
              ${tier === "low" ? `<span class="cc-tag cc-lowconcern">low concern</span>` : ""}
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
