const API = "https://ingredient-scanner-mu.vercel.app";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "analyze") return;
  fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: msg.name, ingredients: msg.ingredients }),
  })
    .then(r => r.json().then(d => ({ ok: r.ok, data: d })))
    .then(({ ok, data }) => sendResponse(ok ? { ok: true, data } : { ok: false, error: data.error || "Request failed" }))
    .catch(e => sendResponse({ ok: false, error: e.message }));
  return true; // keep channel open for async response
});
