import os, json, requests
from flask import Flask, request, jsonify, send_from_directory
from anthropic import Anthropic

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "web")
app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
_client = None
def get_client():
    global _client
    if _client is None:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        _client = Anthropic(api_key=key)
    return _client

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


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/analyze")
def analyze():
    barcode = request.args.get("barcode", "").strip()
    if not barcode.isdigit():
        return jsonify({"error": "Invalid barcode"}), 400

    try:
        r = requests.get(OBF_URL.format(barcode=barcode), timeout=10)
        data = r.json()
    except Exception:
        return jsonify({"error": "Could not reach Open Beauty Facts"}), 502

    if data.get("status") != 1:
        return jsonify({"error": "Product not found on Open Beauty Facts"}), 404

    product = data["product"]
    name = product.get("product_name") or product.get("generic_name") or "Unknown product"
    brand = product.get("brands", "")
    parsed = [i["text"] for i in product.get("ingredients", []) if i.get("text")]
    if not parsed:
        text = product.get("ingredients_text") or ""
        parsed = [x.strip() for x in text.split(",") if x.strip()]
    if not parsed:
        return jsonify({"error": "No ingredients listed for this product"}), 404
    parsed = parsed[:40]

    try:
        analysis = call_claude(name, parsed)
    except Exception as e:
        return jsonify({"error": f"Analysis failed: {e}"}), 500

    return jsonify({
        "product": {"name": name, "brand": brand},
        "top_insights": analysis["top_insights"],
        "ingredients": analysis["ingredients"],
        "verdict": compute_verdict(analysis["ingredients"]),
    })


def call_claude(product_name, ingredients):
    user = f'Product: "{product_name}"\nIngredients (in order):\n{json.dumps(ingredients)}'
    resp = get_client().messages.create(
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
