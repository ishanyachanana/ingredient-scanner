from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json, os, requests
from anthropic import Anthropic

OBF_URL = "https://world.openbeautyfacts.org/api/v2/product/{barcode}.json"
MODEL = "claude-haiku-4-5-20251001"

SYSTEM = """You are a cosmetic ingredient analyzer. Given a product name and ingredient list, return plain-English explanations.

For each ingredient return an object with:
- "name": ingredient name
- "function": one short sentence on what it does in cosmetics
- "concerns": one short sentence on concerns (irritation, allergen, comedogenic, sensitizer, etc.), or "None"
- "class": exactly one of "beneficial", "neutral", "potential concern"

Also return "top_insights": an array of exactly 3 short strings with the most useful things a shopper should know.

Return ONLY valid JSON, no markdown, no prose. Shape: {"ingredients":[...], "top_insights":[...]}"""

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def call_claude(product_name, ingredients):
    user = f'Product: "{product_name}"\nIngredients (in order):\n{json.dumps(ingredients)}'
    resp = client.messages.create(
        model=MODEL, max_tokens=2000, system=SYSTEM,
        messages=[{"role": "user", "content": user}],
    )
    text = resp.content[0].text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lstrip().lower().startswith("json"):
            text = text.split("\n", 1)[1] if "\n" in text else text[4:]
    return json.loads(text)


def compute_verdict(ingredients):
    total = len(ingredients)
    if total == 0:
        return "Mixed, depends on skin type"
    concerns = sum(1 for i in ingredients if i.get("class") == "potential concern")
    if concerns == 0:
        return "Generally safe and effective"
    if concerns / total < 0.2:
        return "Mixed, depends on skin type"
    return "May cause irritation for some"


class handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        barcode = (query.get("barcode", [""])[0] or "").strip()
        if not barcode.isdigit():
            return self._send(400, {"error": "Invalid barcode"})

        try:
            r = requests.get(OBF_URL.format(barcode=barcode), timeout=10)
            data = r.json()
        except Exception:
            return self._send(502, {"error": "Could not reach Open Beauty Facts"})

        if data.get("status") != 1:
            return self._send(404, {"error": "Product not found on Open Beauty Facts"})

        product = data["product"]
        name = product.get("product_name") or product.get("generic_name") or "Unknown product"
        brand = product.get("brands", "")
        parsed = [i["text"] for i in product.get("ingredients", []) if i.get("text")]
        if not parsed:
            text = product.get("ingredients_text") or ""
            parsed = [x.strip() for x in text.split(",") if x.strip()]
        if not parsed:
            return self._send(404, {"error": "No ingredients listed for this product"})
        parsed = parsed[:40]

        try:
            analysis = call_claude(name, parsed)
        except Exception as e:
            return self._send(500, {"error": f"Analysis failed: {e}"})

        verdict = compute_verdict(analysis["ingredients"])
        return self._send(200, {
            "product": {"name": name, "brand": brand},
            "top_insights": analysis["top_insights"],
            "ingredients": analysis["ingredients"],
            "verdict": verdict,
        })
