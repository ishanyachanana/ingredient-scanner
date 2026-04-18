const form = document.getElementById("form");
const input = document.getElementById("barcode");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("video");

form.addEventListener("submit", e => { e.preventDefault(); analyze(input.value.trim()); });
scanBtn.addEventListener("click", startScan);

async function startScan() {
  if (!("BarcodeDetector" in window)) {
    statusEl.textContent = "This browser can't scan. Please type the barcode.";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream; video.hidden = false; await video.play();
    const detector = new BarcodeDetector({ formats: ["ean_13","ean_8","upc_a","upc_e"] });
    statusEl.textContent = "Point the camera at the barcode...";
    const loop = async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          stream.getTracks().forEach(t => t.stop());
          video.hidden = true;
          input.value = codes[0].rawValue;
          analyze(codes[0].rawValue);
          return;
        }
      } catch {}
      requestAnimationFrame(loop);
    };
    loop();
  } catch (err) { statusEl.textContent = "Camera unavailable: " + err.message; }
}

async function analyze(barcode) {
  if (!barcode) return;
  statusEl.textContent = "Looking up product and analyzing ingredients...";
  resultEl.hidden = true;
  try {
    const r = await fetch("/api/analyze?barcode=" + encodeURIComponent(barcode));
    const data = await r.json();
    if (!r.ok) { statusEl.textContent = data.error || "Something went wrong."; return; }
    statusEl.textContent = "";
    render(data);
  } catch (err) { statusEl.textContent = "Network error: " + err.message; }
}

const verdictClass = v => v.startsWith("Generally") ? "safe" : v.startsWith("Mixed") ? "mixed" : "caution";
const classTag = c => c === "beneficial" ? "beneficial" : c === "potential concern" ? "concern" : "neutral";
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function render(data) {
  const p = data.product;
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="card">
      <div class="product-name">${esc(p.name)}</div>
      ${p.brand ? `<div class="brand">${esc(p.brand)}</div>` : ""}
      <div class="verdict ${verdictClass(data.verdict)}">${esc(data.verdict)}</div>
    </div>
    <div class="card">
      <h2>Top insights</h2>
      <ul class="insights">${data.top_insights.map(i => `<li>${esc(i)}</li>`).join("")}</ul>
    </div>
    <div class="card">
      <h2>Full ingredient breakdown</h2>
      ${data.ingredients.map(ing => `
        <div class="ingredient">
          <div class="ing-head">
            <span class="ing-name">${esc(ing.name)}</span>
            <span class="tag ${classTag(ing.class)}">${esc(ing.class)}</span>
          </div>
          <div class="ing-function">${esc(ing.function)}</div>
          ${ing.concerns && ing.concerns !== "None" ? `<div class="ing-concern">Heads up: ${esc(ing.concerns)}</div>` : ""}
        </div>`).join("")}
    </div>`;
}
