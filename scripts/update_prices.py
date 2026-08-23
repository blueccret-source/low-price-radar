import json, re, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / 'products.json').read_text(encoding='utf-8'))
LATEST = ROOT / 'data' / 'latest.json'
HISTORY = ROOT / 'data' / 'history.json'
TW = timezone(timedelta(hours=8))
TODAY = datetime.now(TW).date().isoformat()

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
}

PRICE_PATTERNS = [
    r'"price"\s*:\s*"?([0-9][0-9,]*(?:\.[0-9]+)?)"?',
    r'product:price:amount[^>]*content=["\']([0-9][0-9,]*(?:\.[0-9]+)?)["\']',
    r'itemprop=["\']price["\'][^>]*content=["\']([0-9][0-9,]*(?:\.[0-9]+)?)["\']',
    r'NT\$\s*([0-9][0-9,]*)',
]
OLD_PRICE_PATTERNS = [
    r'"highPrice"\s*:\s*"?([0-9][0-9,]*(?:\.[0-9]+)?)"?',
    r'原價[^0-9]{0,20}([0-9][0-9,]*)',
    r'定價[^0-9]{0,20}([0-9][0-9,]*)',
]

def money(v):
    try: return round(float(str(v).replace(',', '')), 2)
    except: return None

def get_html(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8', errors='ignore')

def extract_first(html, patterns):
    for pat in patterns:
        m = re.search(pat, html, flags=re.I|re.S)
        if m:
            v = money(m.group(1))
            if v and 10 <= v <= 100000:
                return v
    return None

def load_json(path, default):
    if not path.exists(): return default
    try: return json.loads(path.read_text(encoding='utf-8'))
    except: return default

def save_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

history = load_json(HISTORY, {'products': {}})
latest = {'updated_at': datetime.now(TW).isoformat(timespec='seconds'), 'products': []}
near_ratio = float(CFG.get('near_low_ratio', 1.05))
min_points = int(CFG.get('min_history_points', 3))

for p in CFG['products']:
    html = ''
    price = None
    old_price = None
    source = 'fallback'
    error = None
    try:
        html = get_html(p['url'])
        price = extract_first(html, PRICE_PATTERNS)
        old_price = extract_first(html, OLD_PRICE_PATTERNS)
        if price is not None:
            source = 'live'
    except Exception as e:
        error = f'{type(e).__name__}: {e}'[:180]

    if price is None:
        price = money(p.get('fallback_price'))
    if old_price is None:
        old_price = money(p.get('reference_regular_price'))

    rows = history['products'].setdefault(p['id'], [])
    if price is not None:
        if rows and rows[-1].get('date') == TODAY:
            rows[-1].update({'price': price, 'source': source})
        else:
            rows.append({'date': TODAY, 'price': price, 'source': source})
        if len(rows) > 730:
            del rows[:-730]

    live_prices = [r['price'] for r in rows if isinstance(r.get('price'), (int, float))]
    hist_low = min(live_prices) if live_prices else price
    points = len(live_prices)
    discount_pct = None
    if old_price and price and old_price > price:
        discount_pct = round((old_price-price)/old_price*100, 1)

    near_low = bool(price and hist_low and points >= min_points and price <= hist_low * near_ratio)
    strong_discount = bool(discount_pct is not None and discount_pct >= 20)
    hot = near_low or strong_discount
    unit_price = round(price / float(p.get('unit_divisor', 1)), 2) if price else None

    latest['products'].append({
        'id': p['id'], 'store': p['store'], 'store_name': p['store_name'], 'name': p['name'],
        'url': p['url'], 'price': price, 'old_price': old_price, 'discount_pct': discount_pct,
        'unit_price': unit_price, 'unit_label': p.get('unit_label',''),
        'history_low': hist_low, 'history_points': points, 'hot': hot,
        'reason': '接近歷史低價' if near_low else ('大幅折扣' if strong_discount else '持續觀察'),
        'source': source, 'error': error
    })

save_json(HISTORY, history)
save_json(LATEST, latest)

hot = [p for p in latest['products'] if p['hot']]
print(f'Updated {len(latest["products"])} products; hot={len(hot)}')
for p in hot:
    print(f'🔥 {p["name"]}: NT${p["price"]} ({p["reason"]})')
