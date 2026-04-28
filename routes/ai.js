const express = require('express');
const router = express.Router();
const axios = require('axios');
const { protect } = require('../middleware/auth');

const RAPIDAPI_KEY = process.env.RAPIDAPI_AI_KEY || process.env.RAPIDAPI_KEY;
const AI_HOST = process.env.RAPIDAPI_AI_HOST || 'open-ai21.p.rapidapi.com';

async function callAI(prompt) {
  const response = await axios.post(
    `https://${AI_HOST}/claude3`,
    { messages: [{ role: 'user', content: prompt }], web_access: false },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': AI_HOST,
        'x-rapidapi-key': RAPIDAPI_KEY,
      },
      timeout: 30000,
    }
  );
  const raw = response.data?.result || response.data?.message || response.data?.content || '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const clean = text.replace(/```json|```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('JSON nahi mila AI response mein');
  return JSON.parse(match[0]);
}

// ─── AD COPY GENERATOR ────────────────────────────────────────────────────────
// POST /api/ai/copy
router.post('/copy', protect, async (req, res) => {
  try {
    const { adTitle = '', industry = '', objective = '', tone = 'persuasive', count = 3 } = req.body;
    if (!adTitle && !industry) return res.status(400).json({ success: false, message: 'adTitle ya industry daalo' });

    const prompt = `You are a world-class TikTok ad copywriter. Generate ${count} unique ad copy variations.

AD INFO:
- Title/Topic: "${adTitle}"
- Industry: ${industry || 'ecommerce'}
- Objective: ${objective || 'conversions'}
- Tone: ${tone}

Return ONLY valid JSON (no markdown):
{
  "copies": [
    {
      "hook": "<attention-grabbing first line, max 10 words>",
      "body": "<2-3 sentences of persuasive ad copy>",
      "cta": "<call to action phrase>",
      "hashtags": ["#tag1", "#tag2", "#tag3"],
      "tone": "${tone}",
      "estimated_ctr": "<low|medium|high>"
    }
  ],
  "tips": ["<tip1>", "<tip2>"]
}`;

    const result = await callAI(prompt);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Ad copy error:', err.message);
    res.status(500).json({ success: false, message: 'Copy generation fail: ' + err.message });
  }
});

// ─── HOOK ANALYZER ───────────────────────────────────────────────────────────
// POST /api/ai/hook
router.post('/hook', protect, async (req, res) => {
  try {
    const { hook, adTitle = '', industry = '' } = req.body;
    if (!hook) return res.status(400).json({ success: false, message: 'Hook text daalo' });

    const prompt = `You are a TikTok ad expert specializing in scroll-stopping hooks (first 3 seconds).

Analyze this ad hook: "${hook}"
Industry: ${industry || 'unknown'}
Ad Title: ${adTitle || 'unknown'}

Return ONLY valid JSON:
{
  "score": <0-100>,
  "grade": "<A|B|C|D|F>",
  "verdict": "<EXCELLENT|GOOD|AVERAGE|WEAK>",
  "stop_scroll_power": <0-10>,
  "curiosity_factor": <0-10>,
  "clarity": <0-10>,
  "emotion_trigger": "<fear|curiosity|desire|urgency|humor|none>",
  "strengths": ["<s1>", "<s2>"],
  "weaknesses": ["<w1>", "<w2>"],
  "improved_versions": ["<better hook 1>", "<better hook 2>", "<better hook 3>"],
  "why_it_works": "<2 sentences>",
  "best_audience": "<who this hook targets>"
}`;

    const result = await callAI(prompt);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Hook analyzer error:', err.message);
    res.status(500).json({ success: false, message: 'Hook analysis fail: ' + err.message });
  }
});

// ─── TARGET AUDIENCE SUGGESTER ────────────────────────────────────────────────
// POST /api/ai/audience
router.post('/audience', protect, async (req, res) => {
  try {
    const { adTitle = '', industry = '', countries = [], likes = 0, comments = 0, objective = '' } = req.body;
    if (!adTitle && !industry) return res.status(400).json({ success: false, message: 'adTitle ya industry daalo' });

    const prompt = `You are a TikTok media buyer expert. Suggest the best target audience for this ad.

AD INFO:
- Title: "${adTitle}"
- Industry: ${industry}
- Objective: ${objective || 'conversions'}
- Likes: ${likes}, Comments: ${comments}
- Countries: ${countries.join(', ') || 'global'}

Return ONLY valid JSON:
{
  "primary_audience": {
    "age_range": "<e.g. 18-34>",
    "gender": "<male|female|all>",
    "interests": ["<interest1>", "<interest2>", "<interest3>", "<interest4>"],
    "behaviors": ["<behavior1>", "<behavior2>"],
    "income_level": "<low|middle|high>",
    "psychographics": "<2 sentences about mindset and values>"
  },
  "secondary_audience": {
    "age_range": "<range>",
    "gender": "<male|female|all>",
    "interests": ["<interest1>", "<interest2>"],
    "note": "<why secondary>"
  },
  "tiktok_targeting": {
    "interest_categories": ["<cat1>", "<cat2>", "<cat3>"],
    "hashtags_to_target": ["#tag1", "#tag2", "#tag3", "#tag4"],
    "creator_types": ["<creator type 1>", "<creator type 2>"]
  },
  "best_countries": ["<country1>", "<country2>", "<country3>"],
  "best_time_to_run": "<e.g. evenings 6-10PM local time>",
  "budget_recommendation": "<daily budget suggestion>",
  "audience_insight": "<2-3 sentences about this audience psychology>"
}`;

    const result = await callAI(prompt);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Audience suggester error:', err.message);
    res.status(500).json({ success: false, message: 'Audience suggestion fail: ' + err.message });
  }
});

// ─── COMPETITOR BRAND SEARCH (niche explorer) ─────────────────────────────────
// POST /api/ai/niche
router.post('/niche', protect, async (req, res) => {
  try {
    const { keyword, country = 'US' } = req.body;
    if (!keyword) return res.status(400).json({ success: false, message: 'Keyword daalo' });

    const prompt = `You are an ecommerce and TikTok advertising expert. 

For the niche/industry: "${keyword}"
Country focus: ${country}

Return ONLY valid JSON — trending sub-niches, competitor brands, and ad angles:
{
  "niche_score": <0-100, how profitable>,
  "competition_level": "<low|medium|high>",
  "trending": <true|false>,
  "sub_niches": [
    { "name": "<sub niche>", "score": <0-100>, "reason": "<why trending>" }
  ],
  "top_brands": [
    { "name": "<brand>", "estimated_spend": "<low|medium|high>", "platform": "TikTok" }
  ],
  "winning_angles": ["<angle 1>", "<angle 2>", "<angle 3>"],
  "best_products": ["<product idea 1>", "<product idea 2>", "<product idea 3>"],
  "seasonality": "<when is this niche hottest>",
  "audience_size": "<small|medium|large|massive>",
  "cpm_estimate": "<$X-$Y>",
  "summary": "<2-3 sentences about this niche opportunity>"
}`;

    const result = await callAI(prompt);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Niche explorer error:', err.message);
    res.status(500).json({ success: false, message: 'Niche analysis fail: ' + err.message });
  }
});

module.exports = router;
