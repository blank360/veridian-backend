// server.js - FINAL VERSION (2-Day Cache Update)
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const admin = require('firebase-admin');
const { Groq } = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- 1. FIREBASE INIT ---
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('[Firebase] Initialized successfully');
  } catch (error) {
    console.error('[Firebase] Init Error:', error.message);
  }
}
const db = admin.firestore();

// --- 2. GROQ INIT ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- CONSTANTS ---
const CONFIG = {
  // CHANGED: Cache now lasts for 2 Days (48 Hours)
  CONTEST_CACHE_TTL: 48 * 60 * 60 * 1000, 
  REQUEST_TIMEOUT: 15000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  CONTEST_LOOKAHEAD_DAYS: 90
};


// ============================================================================
//  SECTION A: CONTEST AGGREGATOR (FULL VERSION)
// ============================================================================

// 1. Codeforces (Direct API - Very Reliable)
async function fetchCodeforcesContests() {
  try {
    const response = await axios.get('https://codeforces.com/api/contest.list', { timeout: CONFIG.REQUEST_TIMEOUT });
    if (response.data.status !== 'OK') return [];
    
    const now = Math.floor(Date.now() / 1000);
    const maxFuture = now + (CONFIG.CONTEST_LOOKAHEAD_DAYS * 86400);

    return response.data.result
      .filter(c => c.phase === 'BEFORE' && c.startTimeSeconds > now && c.startTimeSeconds <= maxFuture)
      .map(c => ({
        site: 'CodeForces',
        name: c.name,
        start_time: new Date(c.startTimeSeconds * 1000).toISOString(),
        end_time: new Date((c.startTimeSeconds + c.durationSeconds) * 1000).toISOString(),
        duration: c.durationSeconds.toString(),
        url: `https://codeforces.com/contest/${c.id}`
      }));
  } catch (e) { 
    console.error('[Contest] Codeforces failed:', e.message);
    return []; 
  }
}

// 2. LeetCode (GraphQL - Reliable)
async function fetchLeetCodeContests() {
  try {
    const query = `query contestList { allContests { title titleSlug startTime duration } }`;
    const response = await axios.post('https://leetcode.com/graphql', { query }, {
       headers: { 'Content-Type': 'application/json', 'User-Agent': CONFIG.USER_AGENT },
       timeout: CONFIG.REQUEST_TIMEOUT
    });
    
    const now = Date.now() / 1000;
    return response.data.data.allContests
      .filter(c => c.startTime > now)
      .map(c => ({
        site: 'LeetCode',
        name: c.title,
        start_time: new Date(c.startTime * 1000).toISOString(),
        duration: c.duration.toString(),
        url: `https://leetcode.com/contest/${c.titleSlug}/`
      }));
  } catch (e) { 
    console.error('[Contest] LeetCode failed:', e.message);
    return []; 
  }
}

// 3. Kontests API (The "Safety Net" for AtCoder, CodeChef, HackerRank, etc.)
async function fetchKontestsAggregator() {
  try {
    // We fetch ALL known contests from this public aggregator
    const response = await axios.get('https://kontests.net/api/v1/all', { timeout: 15000 });
    const now = new Date();
    
    return response.data
      .filter(c => {
        const t = new Date(c.start_time);
        return t > now && !isNaN(t.getTime());
      })
      .map(c => {
        // Normalizing names for consistency
        let siteName = c.site;
        if (siteName === 'CodeChef') siteName = 'CodeChef';
        if (siteName === 'AtCoder') siteName = 'AtCoder';
        if (siteName === 'HackerRank') siteName = 'HackerRank';
        if (siteName === 'HackerEarth') siteName = 'HackerEarth';

        return {
          site: siteName,
          name: c.name,
          start_time: c.start_time,
          duration: c.duration,
          url: c.url
        };
      });
  } catch (e) { 
    console.error('[Contest] Kontests API failed:', e.message);
    return []; 
  }
}

// 4. MAIN AGGREGATOR (Merge & Remove Duplicates)
async function fetchAllContests() {
    console.log('[Contests] Fetching from Codeforces, LeetCode, and Aggregator...');
    
    const [cf, lc, aggregated] = await Promise.all([
        fetchCodeforcesContests(),
        fetchLeetCodeContests(),
        fetchKontestsAggregator()
    ]);
    
    // Combine everything
    let allRaw = [...cf, ...lc, ...aggregated];
    
    // REMOVE DUPLICATES (Because Kontests might also return Codeforces data)
    const uniqueContests = [];
    const seenUrls = new Set();
    
    for (const contest of allRaw) {
        // Create a unique key based on URL or Name+Time
        const key = contest.url || `${contest.name}-${contest.start_time}`;
        
        if (!seenUrls.has(key)) {
            seenUrls.add(key);
            uniqueContests.push(contest);
        }
    }
    
    console.log(`[Contests] Total unique found: ${uniqueContests.length}`);
    
    // Sort by date (soonest first)
    return uniqueContests.sort((a,b) => new Date(a.start_time) - new Date(b.start_time));
}

// ============================================================================
//  SECTION B: ROADMAP SERVICE (Working)
// ============================================================================
const ROADMAP_SYSTEM_PROMPT = `You are an expert coding mentor. Generate a detailed, structured learning roadmap.
CRITICAL: Output STRICT JSON only. No markdown.
JSON STRUCTURE:
{
  "roadmap_title": "string", "user_level": "string", "strategy_summary": "string",
  "phases": [
    {
      "phase_number": 1, "phase_title": "string", "duration_days": 5, "focus_reason": "string",
      "tasks": [
        {
          "concept_name": "string", "priority": "High", "estimated_time_minutes": 90, "difficulty": "Medium",
          "why_this_matters": "string",
          "practice_questions": [ { "question_title": "string", "problem_id": "1", "platform": "LeetCode", "difficulty": "Easy" } ]
        }
      ]
    }
  ]
}`;

app.post('/api/generate-roadmap', async (req, res) => {
  try {
    const { userId, userContext, skillSnapshot } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const userPrompt = `USER CONTEXT: ${userContext}. SKILL SNAPSHOT: ${JSON.stringify(skillSnapshot)}
    INSTRUCTIONS: Create 3 PHASES. Each phase has 3 TASKS. Each Task has 6 QUESTIONS ("platform":"LeetCode", "problem_id": EXACT ID).`;

    const completion = await groq.chat.completions.create({
      messages: [ { role: 'system', content: ROADMAP_SYSTEM_PROMPT }, { role: 'user', content: userPrompt } ],
      model: 'llama-3.1-8b-instant', temperature: 0.3, response_format: { type: 'json_object' }
    });
    const roadmap = JSON.parse(completion.choices[0].message.content);
    const roadmapId = `roadmap_${Date.now()}`;
    await db.collection('UserRoadmaps').doc(userId).collection('roadmaps').doc(roadmapId).set({
      id: roadmapId, userId, roadmap, createdAt: new Date().toISOString(), completedQuestions: []
    });
    res.json({ success: true, roadmap: { id: roadmapId, ...roadmap } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/roadmap/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const roadmapId = req.body.roadmapId || req.query.roadmapId;
    if (!roadmapId) return res.status(400).json({ error: "Missing roadmapId" });
    await db.collection('UserRoadmaps').doc(userId).collection('roadmaps').doc(roadmapId).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/roadmap/:userId/progress', async (req, res) => {
  try {
    const { userId } = req.params;
    const { roadmapId, completedQuestions } = req.body;
    await db.collection('UserRoadmaps').doc(userId).collection('roadmaps').doc(roadmapId).update({ completedQuestions });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================================
//  SECTION C: PROFILE SCRAPERS (Working)
// ============================================================================
async function fetchLeetCodeData(username) {
  try {
    const query = `query userPublicProfile($username: String!) {
        matchedUser(username: $username) { submitStats { acSubmissionNum { difficulty count } } userCalendar { totalActiveDays } }
        matchedUserStats: matchedUser(username: $username) { tagProblemCounts { fundamental { tagName problemsSolved } intermediate { tagName problemsSolved } advanced { tagName problemsSolved } } }
    }`;
    const response = await axios.post('https://leetcode.com/graphql', { query, variables: { username } }, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
    const data = response.data.data;
    if (!data.matchedUser) return null;
    const stats = data.matchedUser.submitStats.acSubmissionNum || [];
    const total = stats.reduce((acc, curr) => acc + curr.count, 0);
    const topicCount = {};
    ['fundamental', 'intermediate', 'advanced'].forEach(l => data.matchedUserStats?.tagProblemCounts?.[l]?.forEach(t => topicCount[t.tagName] = (topicCount[t.tagName]||0)+t.problemsSolved));
    return { platform: 'LeetCode', username, totalSolved: total, topics: topicCount, streak: data.matchedUser.userCalendar?.totalActiveDays > 0 ? 1 : 0 };
  } catch (e) { return null; }
}

async function fetchCodeforcesData(username) {
  try {
    const status = await axios.get(`https://codeforces.com/api/user.status?handle=${username}&from=1&count=100`, { timeout: 8000 });
    const solved = new Set();
    const topics = {};
    status.data.result?.forEach(sub => {
        if (sub.verdict === 'OK') {
            solved.add(`${sub.problem.contestId}-${sub.problem.index}`);
            sub.problem.tags?.forEach(t => topics[t] = (topics[t]||0)+1);
        }
    });
    return { platform: 'Codeforces', username, totalSolved: solved.size, topics };
  } catch (e) { return null; }
}

app.post('/api/update-coding-profile', async (req, res) => {
  try {
    const { userId, userProfiles } = req.body;
    const results = await Promise.all([
        (userProfiles.leetcode) ? fetchLeetCodeData(userProfiles.leetcode) : null,
        (userProfiles.codeforces) ? fetchCodeforcesData(userProfiles.codeforces) : null
    ]);
    const validResults = results.filter(r => r !== null);
    const totalSolved = validResults.reduce((acc, r) => acc + (r.totalSolved||0), 0);
    const allTopics = {};
    validResults.forEach(r => { if(r.topics) Object.entries(r.topics).forEach(([k,v]) => allTopics[k] = (allTopics[k]||0)+v); });
    const newData = { userId, userProfiles, platforms: validResults, totalSolved, topics: allTopics, lastUpdated: new Date().toISOString() };
    await db.collection('CodingProfiles').doc(userId).set(newData, { merge: true });
    res.json({ success: true, data: newData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/coding-profile/:userId', async (req, res) => {
    const doc = await db.collection('CodingProfiles').doc(req.params.userId).get();
    res.json({ success: true, data: doc.exists ? doc.data() : null });
});


// ============================================================================
//  SECTION D: JOBS & APTITUDE (Working)
// ============================================================================
app.get('/api/jobs', async (req, res) => {
    try {
        const res1 = await axios.get('https://remotive.com/api/remote-jobs');
        const jobs = (res1.data.jobs || []).slice(0, 40).map(j => ({
            id: j.id, title: j.title, company: j.company_name, location: 'Remote', type: j.job_type, logo: j.company_logo_url, apply_link: j.url
        }));
        res.json({ success: true, jobs: jobs.sort(() => Math.random() - 0.5) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-aptitude-test', async (req, res) => {
    try {
        const { difficulty = 'medium' } = req.body;
        const prompt = `Create a General Aptitude Test (20 Qs) in strict JSON: { "categories": [ { "name": "string", "questions": [ { "id": "1", "question": "str", "options": {"A":"str"}, "correctAnswer": "A" } ] } ] } Difficulty: ${difficulty}`;
        const completion = await groq.chat.completions.create({ messages: [{role: 'user', content: prompt}], model: 'llama-3.3-70b-versatile', response_format: { type: 'json_object' } });
        const data = JSON.parse(completion.choices[0].message.content);
        res.json({ success: true, testData: { ...data, totalTime: 1200 } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-test-result', async (req, res) => {
    try {
        const { userId, stats } = req.body;
        await db.collection('CodingProfiles').doc(userId).set({
            aptitudeStats: { lastScore: stats.totalScore, lastDate: new Date().toISOString(), history: admin.firestore.FieldValue.arrayUnion({ date: new Date().toISOString(), score: stats.totalScore }) }
        }, { merge: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================================
//  SECTION E: CONTEST ROUTE (The Fixed Part)
// ============================================================================
app.get('/api/contests', async (req, res) => {
  try {
    // 1. Check Cache
    const cacheDoc = await db.collection('cache').doc('contests').get();
    if (cacheDoc.exists) {
        const data = cacheDoc.data();
        // Check if cache is younger than 2 DAYS (48 hours)
        if ((Date.now() - data.updatedAt) < CONFIG.CONTEST_CACHE_TTL) {
            return res.json({ contests: data.data, source: 'cache' });
        }
    }

    // 2. Fetch Fresh
    const freshContests = await fetchAllContests();

    // 3. Save Cache
    if (freshContests.length > 0) {
        await db.collection('cache').doc('contests').set({ data: freshContests, updatedAt: Date.now() });
    }
    res.json({ contests: freshContests, source: 'api' });
  } catch (e) { res.status(500).json({ error: e.message, contests: [] }); }
});

// START
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on Port ${PORT}`));

