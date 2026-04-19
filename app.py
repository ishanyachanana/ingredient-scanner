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


@app.route("/debug")
def debug():
    return jsonify({
        "base_dir": BASE_DIR,
        "root_contents": sorted(os.listdir(BASE_DIR)),
        "static_dir": STATIC_DIR,
        "static_exists": os.path.isdir(STATIC_DIR),
        "static_contents": sorted(os.listdir(STATIC_DIR)) if os.path.isdir(STATIC_DIR) else None,
    })

import time

def call_claude(product_name, ingredients, retries=1):
    user = f'Product: "{product_name}"\nIngredients (in order):\n{json.dumps(ingredients)}'
    last_err = None
    for attempt in range(retries + 1):
        try:
            resp = get_client().messages.create(
                model=MODEL, max_tokens=1500, system=SYSTEM,
                messages=[{"role": "user", "content": user}],
            )
            text = resp.content[0].text.strip()
            if text.startswith("```"):
                text = text.strip("`")
                if text.lstrip().lower().startswith("json"):
                    text = text.split("\n", 1)[1] if "\n" in text else text[4:]
            parsed = json.loads(text)
            if not isinstance(parsed.get("ingredients"), list) or not isinstance(parsed.get("top_insights"), list):
                raise ValueError("Claude returned unexpected shape")
            # Normalize each ingredient
            for ing in parsed["ingredients"]:
                if ing.get("class") not in ("beneficial", "neutral", "potential concern"):
                    ing["class"] = "neutral"
                ing.setdefault("function", "")
                ing.setdefault("concerns", "None")
            parsed["top_insights"] = [str(x) for x in parsed["top_insights"][:3]]
            return parsed
        except Exception as e:
            last_err = e
            # Retry on transient errors only
            msg = str(e).lower()
            if attempt < retries and ("529" in msg or "overloaded" in msg or "timeout" in msg):
                time.sleep(1.5)
                continue
            raise
    raise last_err

@app.route("/debug/env")
def debug_env():
    all_keys = sorted(os.environ.keys())
    system_prefixes = ("AWS_", "VERCEL_", "LAMBDA_", "_", "PATH", "HOME", "PWD",
                       "LANG", "LC_", "PYTHON", "TZ", "SHLVL", "HOSTNAME")
    custom_keys = [k for k in all_keys if not k.startswith(system_prefixes)]
    return jsonify({
        "anthropic_exact_match": os.environ.get("ANTHROPIC_API_KEY") is not None,
        "custom_env_var_names": custom_keys,
        "names_containing_anth_or_api": [k for k in all_keys if "ANTH" in k.upper() or "API" in k.upper()],
    })

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

@app.route("/ping-2026")
def ping():
    return jsonify({
        "deployed": True,
        "anthropic_present": os.environ.get("ANTHROPIC_API_KEY") is not None,
        "all_custom_env_keys": [k for k in os.environ.keys()
                                if not k.startswith(("AWS_", "VERCEL_", "LAMBDA_",
                                "_", "PATH", "HOME", "PWD", "LANG", "LC_",
                                "PYTHON", "TZ", "SHLVL", "HOSTNAME"))],
    })
@app.route("/api/analyze-ingredients", methods=["POST", "OPTIONS"])
def analyze_ingredients():
    cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }
    if request.method == "OPTIONS":
        return ("", 204, cors)

    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "Unknown product").strip()
    ingredients = [i.strip() for i in body.get("ingredients", []) if i and i.strip()]
    if not ingredients:
        return (jsonify({"error": "No ingredients provided"}), 400, cors)

    try:
        analysis = call_claude(name, ingredients[:25])
    except Exception as e:
        return (jsonify({"error": f"Analysis failed: {e}"}), 500, cors)

    return (jsonify({
        "product": {"name": name},
        "top_insights": analysis["top_insights"],
        "ingredients": analysis["ingredients"],
        "verdict": compute_verdict(analysis["ingredients"]),
    }), 200, cors)
