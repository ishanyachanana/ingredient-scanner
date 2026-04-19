const API = "https://ingredient-scanner-mu.vercel.app/api/analyze-ingredients";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "analyze") return;

  console.log("[cc] received request:", msg.name, "ingredient count:", msg.ingredients?.length);

  (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);

      console.log("[cc] fetching:", API);

      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: msg.name, ingredients: msg.ingredients }),
        signal: controller.signal,
      });

      clearTimeout(timer);
      console.log("[cc] status:", r.status);

      const rawText = await r.text();
      console.log("[cc] raw response (first 300 chars):", rawText.slice(0, 300));

      let data;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        console.error("[cc] response was not JSON");
        sendResponse({
          ok: false,
          error: "Server returned non-JSON. First 100 chars: " + rawText.slice(0, 100),
        });
        return;
      }

      console.log("[cc] parsed body:", data);

      if (r.ok) {
        sendResponse({ ok: true, data });
      } else {
        sendResponse({ ok: false, error: data.error || `HTTP ${r.status}` });
      }
    } catch (e) {
      console.error("[cc] fetch failed:", e);
      sendResponse({
        ok: false,
        error: e.name === "AbortError" ? "Request timed out after 25 seconds" : (e.message || String(e)),
      });
    }
  })();

  return true; // keep message channel open for async sendResponse
});

console.log("[cc] service worker loaded, API =", API);
