// Rahul's Steel Toolkit proxy for Cloudflare Workers (free plan is fine).
// Secrets/variables to add in Cloudflare (Settings > Variables and Secrets):
//   GROQ_KEY      (secret)  free key from console.groq.com/keys   [text questions, fast]
//   GEMINI_KEY    (secret)  optional, from aistudio.google.com/apikey [needed to read images]
//   ACCESS_CODE   (secret)  optional password the toolkit sends, stops strangers using your quota
//   GROQ_MODELS   (text)    optional. Leave empty: the server asks Groq which models work and picks the best.
//   GEMINI_MODELS (text)    optional, comma list. default: gemini-3.8-flash
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,x-code",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const out = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(env, model, system, contents, wantJson) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.3, ...(wantJson ? { responseMimeType: "application/json" } : {}) },
  };
  for (let n = 0; n < 2; n++) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const t = ((j.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
      if (t) return t;
      throw new Error("empty answer");
    }
    const msg = j?.error?.message || "HTTP " + r.status;
    if ([500, 503, 504].includes(r.status) && n === 0) { await sleep(1200); continue; }
    throw new Error(msg.slice(0, 160));
  }
}

async function callGroq(env, model, system, contents, wantJson) {
  const messages = [
    { role: "system", content: system },
    ...contents.map(c => ({
      role: c.role === "user" ? "user" : "assistant",
      content: c.parts.map(p => p.text || "").join("\n"),
    })),
  ];
  for (let n = 0; n < 2; n++) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.GROQ_KEY },
      body: JSON.stringify({ model, messages, temperature: 0.3, ...(wantJson ? { response_format: { type: "json_object" } } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const t = j.choices?.[0]?.message?.content || "";
      if (t) return t;
      throw new Error("empty answer");
    }
    const msg = j?.error?.message || "HTTP " + r.status;
    if ([429, 500, 503].includes(r.status) && n === 0) { await sleep(2000); continue; }
    throw new Error(msg.slice(0, 160));
  }
}


// Groq retires model names often, so ask Groq which models this key can use and pick the best few.
let groqCache = { t: 0, list: [] };
async function groqModels(env) {
  if (env.GROQ_MODELS) return env.GROQ_MODELS.split(",").map(s => s.trim()).filter(Boolean);
  if (Date.now() - groqCache.t < 600000 && groqCache.list.length) return groqCache.list;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: "Bearer " + env.GROQ_KEY } });
    const j = await r.json();
    const ids = (j.data || []).map(m => m.id).filter(id => !/whisper|guard|tts|playai|orpheus|embed|safeguard|compound|moderation/i.test(id));
    const score = id => (/gpt-oss-120b/.test(id) ? 6 : 0) + (/70b|maverick|120b/.test(id) ? 4 : 0) + (/versatile/.test(id) ? 2 : 0) + (/qwen|kimi|scout|gpt-oss/.test(id) ? 2 : 0) + (/instant|8b|20b/.test(id) ? 1 : 0);
    const list = ids.sort((a, b) => score(b) - score(a)).slice(0, 4);
    if (list.length) groqCache = { t: Date.now(), list };
    return list;
  } catch (e) { return []; }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return new Response("Steel toolkit proxy is running.", { headers: CORS });
    if (env.ACCESS_CODE && req.headers.get("x-code") !== env.ACCESS_CODE)
      return out({ error: "Wrong or missing access code." }, 401);

    let b;
    try { b = await req.json(); } catch { return out({ error: "Bad request." }, 400); }
    const system = String(b.system || "").slice(0, 20000);
    const contents = Array.isArray(b.contents) ? b.contents : [];
    const wantJson = !!b.json;
    const hasImg = contents.some(c => (c.parts || []).some(p => p.inlineData));
    if (!contents.length) return out({ error: "Nothing to answer." }, 400);

    const errs = [];
    const gm = (env.GEMINI_MODELS || "gemini-3.8-flash").split(",").map(s => s.trim()).filter(Boolean);
    const qm = (!hasImg && env.GROQ_KEY) ? await groqModels(env) : [];
    const plan = [];
    if (!hasImg && env.GROQ_KEY) qm.forEach(m => plan.push(["groq", m]));
    if (env.GEMINI_KEY) gm.forEach(m => plan.push(["gemini", m]));
    if (hasImg && !env.GEMINI_KEY) return out({ error: "Reading images needs GEMINI_KEY on the server." }, 400);
    if (!plan.length) return out({ error: "No GROQ_KEY or GEMINI_KEY set on the server." }, 500);

    for (const [prov, model] of plan) {
      try {
        const text = prov === "groq"
          ? await callGroq(env, model, system, contents, wantJson)
          : await callGemini(env, model, system, contents, wantJson);
        return out({ text, model: prov + ":" + model });
      } catch (e) {
        errs.push(prov + ":" + model + " -> " + e.message);
      }
    }
    return out({ error: "All free models failed. " + errs.join(" | ") }, 502);
  },
};
