(function () {
  if (window.__ccInjected) return;
  window.__ccInjected = true;

  const btn = document.createElement("button");
  btn.id = "cc-btn";
  btn.textContent = "Check ingredients";
  document.body.appendChild(btn);
  btn.addEventListener("click", run);

  async function run() {
    const ingredients = findIngredients();
    const name = getProductName();
    if (!ingredients || ingredients.length < 3) {
      showOverlay({ error: "Couldn't find an ingredients list on this page. Try opening the 'Ingredients' tab/section first." });
      return;
    }
    showOverlay({ loading: true });
    chrome.runtime.sendMessage(
      { type: "analyze", name, ingredients },
      (resp) => {
        if (!resp?.ok) return showOverlay({ error: resp?.error || "Unknown error" });
        showOverlay({ data: resp.data });
      }
    );
  }

  function getProductName() {
    return (document.querySelector("h1")?.innerText || document.title).trim();
  }

  function findIngredients() {
    const candidates = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,strong,b,dt,span,div,p")]
      .filter(el => /^\s*(key\s+)?ingredients?\s*[:\-]?\s*$/i.test(el.innerText || "") && (el.innerText || "").length < 40);
    for (const label of candidates) {
      const text = grabTextAfter(label);
      if (text && text.includes(",") && text.length > 60) {
        return text.split(/[,;]/).map(s => s.replace(/\([^)]*\)/g, "").trim()).filter(Boolean);
      }
    }
    return null;
  }

  function grabTextAfter(label) {
    let sib = label.nextElementSibling;
    if (sib && sib.innerText.length > 60) return sib.innerText;
    const parent = label.parentElement;
    if (parent) {
      const raw = parent.innerText.replace(label.innerText, "").trim();
      if (raw.length > 60) return raw;
    }
    return "";
  }

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
