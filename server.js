// PromptPilot Backend v2 - Gemini 1.5 Flash + usage limits
const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const FREE_DAILY_LIMIT = 10;
const usageMap = new Map();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

function getIP(req) {
  return ((req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0]).trim();
}

function checkUsage(ip, licenseKey) {
  if (licenseKey && licenseKey.length > 10) return { allowed: true, pro: true };
  const key = ip + "_" + new Date().toISOString().slice(0, 10);
  const count = usageMap.get(key) || 0;
  if (count >= FREE_DAILY_LIMIT) return { allowed: false };
  usageMap.set(key, count + 1);
  return { allowed: true, used: count + 1, limit: FREE_DAILY_LIMIT };
}

function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    if (!GEMINI_KEY) return reject(new Error("Server not configured. Contact support."));

    const msg = "You are an expert prompt engineer. Improve the following prompt to be clearer, more specific, and more likely to get an excellent AI response.\n\nRules:\n- Keep the same intent and goal\n- Make it more specific and detailed\n- Add helpful context where missing\n- Use clear structure if the prompt is complex\n- Do NOT over-engineer simple prompts\n- Return ONLY the improved prompt. No preamble, no explanation.\n\nOriginal prompt:\n" + prompt;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: msg }] }],
      generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
    });

    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: "/v1beta/models/gemini-1.5-flash:generateContent?key=" + GEMINI_KEY,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const p = JSON.parse(d);
          if (res.statusCode === 429) return reject(new Error("Server busy. Try again."));
          if (res.statusCode !== 200) return reject(new Error((p.error && p.error.message) || "API error"));
          const text = p.candidates && p.candidates[0] && p.candidates[0].content && p.candidates[0].content.parts && p.candidates[0].content.parts[0] && p.candidates[0].content.parts[0].text;
          if (!text) return reject(new Error("Empty response"));
          resolve(text.trim());
        } catch (e) { reject(new Error("Parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

http.createServer(async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") { res.writeHead(200); return res.end(); }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "PromptPilot backend is live", version: "2.0.0" }));
  }

  if (req.method === "POST" && req.url === "/improve") {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", async () => {
      try {
        const { prompt, license_key } = JSON.parse(b);
        if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Valid prompt required (min 3 chars)" }));
        }
        if (prompt.length > 4000) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Prompt too long (max 4000 chars)" }));
        }
        const ip = getIP(req);
        const u = checkUsage(ip, license_key);
        if (!u.allowed) {
          res.writeHead(429);
          return res.end(JSON.stringify({
            error: "Free limit reached (10/day). Upgrade to Pro at promptpilot.app for unlimited!",
            upgrade: true
          }));
        }
        const improved = await callGemini(prompt.trim());
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, improved, usage: u }));
      } catch (err) {
        console.error("Error:", err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message || "Something went wrong" }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}).listen(PORT, () => console.log("PromptPilot v2 running on port " + PORT));
