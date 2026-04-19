(function () {
  if (window.__ccInjected) return;
  window.__ccInjected = true;

  const btn = document.createElement("button");
  btn.id = "cc-btn";
  btn.textContent = "Check ingredients";
  document.body.appendChild(btn);
  btn.addEventListener("click", run);

  async function run() {
    showOverlay({ loading: true });

    // Try 1: scrape what's already visible / in DOM
    let ingredients = findIngredients();

    // Try 2: click anything labeled "Ingredients" to expand accordions/tabs, then scrape again
    if (!ingredients || ingredients.length < 3) {
      const opened = tryExpandIngredientSection();
      if (opened) {
        await waitMs(900);
        ingredients = findIngredients();
      }
    }

    // Try 3: regex the full body text as a last resort
    if (!ingredients || ingredients.length < 3) {
      ingredients = findByTextPattern();
    }

    if (!ingredients || ingredients.length < 3) {
      showOverlay({ error: "Couldn't find an ingredients list. Open the Ingredients section on the page, then click the button again." });
      return;
    }

    const name = getProductName();
    chrome.runtime.sendMessage({ type: "analyze", name, ingredients }, (resp) => {
      if (!resp?.ok) return showOverlay({ error: resp?.error || "Unknown error" });
      showOverlay({ data: resp.data });
    });
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
      // Skip elements that contain huge trees — we want the header, not the whole card
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
    // Check following siblings first
    let sib = label.nextElementSibling;
    while (sib) {
      const t = (sib.textContent || "").trim();
      if (t.length > 60 && t.includes(",")) return t;
      sib = sib.nextElementSibling;
    }
    // Check parent's remaining text
    const parent = label.parentElement;
    if (parent) {
      const raw = (parent.textContent || "").replace(label.textContent || "", "").trim();
      if (raw.length > 60 && raw.includes(",")) return raw;
      // Check parent's following siblings (accordion pattern)
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
    // Cut at likely end markers
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
      if (!/[a-z]/i.test(s)) return false;          // must contain letters
      if (/^\d+\s*(ml|g|oz|mg|kg|l|%)?$/i.test(s)) return false;  // pure measurements
      if (junkWords.test(s)) return false;
      const key = s.toLowerCase();
      if (seen.has(key)) return false;              // dedupe
      seen.add(key);
      return true;
    });
  return parts.length >= 3 ? parts.slice(0, 60) : null;
}
  
  const waitMs = (ms) => new Promise(r => setTimeout(r, ms));

  function showOverlay(state) {
    let root = document.getElementById("cc-overlay");
    if (!root) {
      root = document.createElement("div");
      root.id = "cc-overlay";
      document.body.appendChild(root);
    }
    if (state.loading) {
      root.innerHTML = `<div class="cc-card"><button class="cc-close">×</button>Analyzing...</div>`;
    } else if (state.error) {
      root.innerHTML = `<div class="cc-card"><button class="cc-close">×</button><div class="cc-err">${esc(state.error)}</div></div>`;
    } else {
      const d = state.data;
      root.innerHTML = `
        <div class="cc-card">
          <button class="cc-close">×</button>
          <div class="cc-name">${esc(d.product.name)}</div>
          <div class="cc-verdict ${vclass(d.verdict)}">${esc(d.verdict)}</div>
          <h4>Top insights</h4>
          <ul>${d.top_insights.map(i => `<li>${esc(i)}</li>`).join("")}</ul>
          <h4>Ingredients</h4>
          ${d.ingredients.map(i => `
            <div class="cc-ing">
              <div><b>${esc(i.name)}</b> <span class="cc-tag cc-${tagCls(i.class)}">${esc(i.class)}</span></div>
              <div>${esc(i.function)}</div>
              ${i.concerns && i.concerns !== "None" ? `<div class="cc-concern">Heads up: ${esc(i.concerns)}</div>` : ""}
            </div>`).join("")}
        </div>`;
    }
    root.querySelector(".cc-close")?.addEventListener("click", () => root.remove());
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const vclass = v => v.startsWith("Generally") ? "safe" : v.startsWith("Mixed") ? "mixed" : "caution";
  const tagCls = c => c === "beneficial" ? "good" : c === "potential concern" ? "bad" : "neutral";
})();
