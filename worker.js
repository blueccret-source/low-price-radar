export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://blueccret-source.github.io",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ ok: false, message: "This API only accepts POST requests." }, 405, corsHeaders);
    }

    const adminKey = request.headers.get("X-Admin-Key");
    if (!adminKey || adminKey !== env.ADMIN_KEY) {
      return json({ ok: false, message: "管理密碼錯誤" }, 401, corsHeaders);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, message: "資料格式錯誤" }, 400, corsHeaders); }

    const action = body.action || "add";
    const repo = "blueccret-source/low-price-radar";
    const path = "products.json";
    const githubHeaders = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "low-price-radar-worker",
    };

    const getResponse = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: githubHeaders });
    if (!getResponse.ok) {
      return json({ ok: false, message: "無法讀取 GitHub products.json", detail: await getResponse.text() }, 500, corsHeaders);
    }

    const fileInfo = await getResponse.json();
    let config;
    try {
      config = JSON.parse(decodeBase64Utf8(fileInfo.content.replace(/\n/g, "")));
    } catch {
      return json({ ok: false, message: "products.json 格式錯誤" }, 500, corsHeaders);
    }

    if (!config || typeof config !== "object" || !Array.isArray(config.products)) {
      return json({ ok: false, message: "products.json 缺少 products 商品陣列" }, 500, corsHeaders);
    }

    if (action === "delete") {
      const id = String(body.id || "");
      const url = String(body.url || "");
      const before = config.products.length;
      const removed = config.products.find(p => String(p.id) === id || (url && String(p.url) === url));
      config.products = config.products.filter(p => !(String(p.id) === id || (url && String(p.url) === url)));

      if (config.products.length === before) {
        return json({ ok: false, message: "找不到要刪除的追蹤商品" }, 404, corsHeaders);
      }

      const updateResponse = await writeConfig(repo, path, fileInfo.sha, config, githubHeaders, `Remove tracked product: ${removed?.name || body.name || id}`);
      if (!updateResponse.ok) {
        return json({ ok: false, message: "寫入 GitHub 失敗", detail: await updateResponse.text() }, 500, corsHeaders);
      }

      return json({ ok: true, message: "已停止追蹤", product: removed || null }, 200, corsHeaders);
    }

    if (action !== "add") {
      return json({ ok: false, message: "不支援的操作" }, 400, corsHeaders);
    }

    const { name, store, store_name, url, price, old_price } = body;
    if (!name || !store || !store_name || !url) {
      return json({ ok: false, message: "商品名稱、商店與網址為必填" }, 400, corsHeaders);
    }

    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error();
    } catch {
      return json({ ok: false, message: "商品網址格式不正確" }, 400, corsHeaders);
    }

    const normalizedName = name.trim().toLowerCase();
    const normalizedUrl = url.trim();
    const duplicated = config.products.some(product =>
      String(product.url || "").trim() === normalizedUrl ||
      String(product.name || "").trim().toLowerCase() === normalizedName
    );
    if (duplicated) {
      return json({ ok: false, message: "這個商品已經在追蹤清單中" }, 409, corsHeaders);
    }

    const newProduct = {
      id: createProductId(name),
      store: store.trim(),
      store_name: store_name.trim(),
      name: name.trim(),
      url: normalizedUrl,
      fallback_price: numberOrNull(price),
      unit_label: "",
    };
    const regularPrice = numberOrNull(old_price);
    if (regularPrice !== null) newProduct.reference_regular_price = regularPrice;

    config.products.push(newProduct);
    const updateResponse = await writeConfig(repo, path, fileInfo.sha, config, githubHeaders, `Add tracked product: ${name}`);
    if (!updateResponse.ok) {
      return json({ ok: false, message: "寫入 GitHub 失敗", detail: await updateResponse.text() }, 500, corsHeaders);
    }

    return json({ ok: true, message: "已加入每日低價追蹤", product: newProduct }, 200, corsHeaders);
  },
};

async function writeConfig(repo, path, sha, config, headers, message) {
  return fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: encodeBase64Utf8(JSON.stringify(config, null, 2)),
      sha,
      branch: "main",
    }),
  });
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function createProductId(name) {
  const base = String(name).toLowerCase().trim().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${base || "product"}-${Date.now().toString(36).slice(-6)}`;
}

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function decodeBase64Utf8(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
