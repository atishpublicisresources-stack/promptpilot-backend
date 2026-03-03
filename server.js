const express = require('express');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS fix — must be FIRST
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Wait a moment.' }
});
app.use('/improve', limiter);

app.get('/', (req, res) => {
  res.json({ status: 'PromptPilot backend is live', version: '1.0.0' });
});

app.post('/improve', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required' });
  if (prompt.trim().length < 3) return res.status(400).json({ error: 'Prompt too short' });
  if (prompt.length > 4000) return res.status(400).json({ error: 'Prompt too long' });
  try {
    const improved = await callGemini(prompt.trim());
    return res.json({ success: true, improved });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to improve prompt' });
  }
});

async function callGemini(originalPrompt) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error('Server not configured');

  const systemPrompt = `You are an expert prompt engineer. Improve the following prompt to be clearer, more specific, and more likely to get an excellent AI response.

Rules:
- Keep the same intent and goal
- Make it more specific and detailed
- Add context if helpful
- Use clear structure if complex
- Do NOT over-engineer simple prompts
- Return ONLY the improved prompt, nothing else.

Original prompt:
${originalPrompt}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: systemPrompt }] }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.7 }
      })
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    if (response.status === 429) throw new Error('Server busy. Try again in a moment.');
    throw new Error(err.error?.message || 'API error');
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from AI');
  return text.trim();
}

app.listen(PORT, () => console.log(`PromptPilot backend running on port ${PORT}`));
