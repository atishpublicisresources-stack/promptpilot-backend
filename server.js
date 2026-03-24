// PromptPilot Backend v3.2 - Groq API + Dodo Payments + File-based Pro storage
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_API_KEY;
const DODO_KEY = process.env.DODO_PAYMENTS_API_KEY;
const DODO_PRODUCT_ID = "pdt_0NZtEihugUgRG2kUCRtXW";
const FREE_DAILY_LIMIT = 10;
const PRO_FILE = path.join(__dirname, "pro_users.json");

const usageMap = new Map();

// ── Pro users: file-backed so restarts don't wipe them ──────────────────────
function loadProUsers() {
  try {
    if (fs.existsSync(PRO_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(PRO_FILE, "utf8")));
    }
  } catch (e) { console.error("Load pro users error:", e.message); }
  return new Set();
}
function saveProUsers(set) {
  try { fs.writeFileSync(PRO_FILE, JSON.stringify([...set])); }
  catch (e) { console.error("Save pro users error:", e.message); }
}
const proUsers = loadProUsers();
console.log(`Loaded ${proUsers.size} pro user(s) from disk`);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

function getIP(req) {
  return ((req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0]).trim();
}

function checkUsage(ip, email) {
  // Pro check by email
  if (email && proUsers.has(email.toLowerCase().trim())) {
    return { allowed: true, pro: true };
  }
  const key = ip + "_" + new Date().toISOString().slice(0, 10);
  const count = usageMap.get(key) || 0;
  if (count >= FREE_DAILY_LIMIT) return { allowed: false };
  usageMap.set(key, count + 1);
  return { allowed: true, used: count + 1, limit: FREE_DAILY_LIMIT };
}

function callGroq(prompt) {
  return new Promise((resolve, reject) => {
    if (!GROQ_KEY) return reject(new Error("Server not configured."));
    const msg = "You are an expert prompt engineer. Your ONLY output must be the improved prompt itself — nothing else. Do NOT write 'Here is', 'Here\\'s', 'Improved prompt:', or any intro/preamble whatsoever. Just output the raw improved prompt directly.\n\nImprove this prompt to be clearer, more specific, and more likely to get an excellent AI response:\n- Keep the same intent and goal\n- Make it more specific and detailed\n- Add helpful context where missing\n- Use clear structure if complex\n- Do NOT over-engineer simple prompts\n\nOriginal prompt:\n" + prompt;
    const body = JSON.stringify({ model: "llama-3.1-8b-instant", max_tokens: 1024, messages: [{ role: "user", content: msg }] });
    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer " + GROQ_KEY
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const p = JSON.parse(d);
          if (res.statusCode === 429) return reject(new Error("Server busy. Try again."));
          if (res.statusCode === 401) return reject(new Error("Server config error."));
          if (res.statusCode !== 200) return reject(new Error((p.error && p.error.message) || "API error"));
          const text = p.choices && p.choices[0] && p.choices[0].message && p.choices[0].message.content;
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

function createDodoCheckout(customerEmail) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      product_cart: [{ product_id: DODO_PRODUCT_ID, quantity: 1 }],
      customer: { email: customerEmail },
      return_url: `https://promptpilotpro.netlify.app/success?email=${encodeURIComponent(customerEmail)}`
    });
    const req = https.request({
      hostname: "live.dodopayments.com",
      path: "/checkouts",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer " + DODO_KEY
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const p = JSON.parse(d);
          if (res.statusCode !== 200) return reject(new Error("Checkout creation failed: " + JSON.stringify(p)));
          resolve(p.checkout_url);
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

  // ✅ Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "PromptPilot backend is live", version: "3.2.0", proUsers: proUsers.size }));
  }

  // ✅ Improve prompt — now accepts email for pro check
  if (req.method === "POST" && req.url === "/improve") {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", async () => {
      try {
        const { prompt, email } = JSON.parse(b);
        if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
          res.writeHead(400); return res.end(JSON.stringify({ error: "Valid prompt required" }));
        }
        if (prompt.length > 4000) {
          res.writeHead(400); return res.end(JSON.stringify({ error: "Prompt too long" }));
        }
        const ip = getIP(req);
        const u = checkUsage(ip, email);
        if (!u.allowed) {
          res.writeHead(429);
          return res.end(JSON.stringify({
            error: "Free limit reached (10/day). Upgrade to Pro for unlimited!",
            upgrade: true
          }));
        }
        const improved = await callGroq(prompt.trim());
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, improved, usage: u, pro: u.pro || false }));
      } catch (err) {
        console.error("Error:", err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message || "Something went wrong" }));
      }
    });
    return;
  }

  // 💳 Create Dodo checkout session
  if (req.method === "POST" && req.url === "/create-checkout") {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", async () => {
      try {
        const { email } = JSON.parse(b);
        if (!email) { res.writeHead(400); return res.end(JSON.stringify({ error: "Email required" })); }
        const checkoutUrl = await createDodoCheckout(email);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, checkout_url: checkoutUrl }));
      } catch (err) {
        console.error("Checkout error:", err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 🔔 Dodo webhook — fires when payment succeeds
  if (req.method === "POST" && req.url === "/webhook/dodo") {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => {
      try {
        const event = JSON.parse(b);
        console.log("Webhook received:", event.type);
        if (event.type === "subscription.active" || event.type === "payment.succeeded") {
          const email = event.data && event.data.customer && event.data.customer.email;
          if (email) {
            proUsers.add(email.toLowerCase().trim());
            saveProUsers(proUsers);
            console.log("✅ Pro user activated:", email);
          }
        }
        if (event.type === "subscription.cancelled" || event.type === "subscription.expired") {
          const email = event.data && event.data.customer && event.data.customer.email;
          if (email) {
            proUsers.delete(email.toLowerCase().trim());
            saveProUsers(proUsers);
            console.log("❌ Pro user removed:", email);
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ received: true }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Webhook error" }));
      }
    });
    return;
  }

  // 🔍 Check if user is pro
  if (req.method === "POST" && req.url === "/check-pro") {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => {
      try {
        const { email } = JSON.parse(b);
        const isPro = email ? proUsers.has(email.toLowerCase().trim()) : false;
        res.writeHead(200);
        res.end(JSON.stringify({ pro: isPro }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Error checking pro status" }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));

}).listen(PORT, () => console.log("PromptPilot v3.2 running on port " + PORT));
