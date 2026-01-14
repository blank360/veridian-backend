// server.js - THE FINAL "MASTER" VERSION (All Features Restored)
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
  CONTEST_CACHE_TTL: 60 * 60 * 1000, // 1 Hour Cache
  REQUEST_TIMEOUT: 15000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  CONTEST_LOOKAHEAD_DAYS: 90
};

// ============================================================================
//  SECTION A: CONTEST AGGREGATOR (RESTORED)
// ============================================================================

// 1. Codeforces Fetcher
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
  } catch (e) { return []; }
}

// 2. LeetCode Fetcher
async function fetchLeetCodeContests() {
  try {
    const query = `query contestList { allContests { title titleSlug startTime duration } }`;
    const response = await axios.post('https://leetcode.com/graphql', { query }, {
       headers: { 'Content-Type': 'application/json', 'User-Agent': CONFIG.USER_AGENT },
       timeout: CONFIG.REQUEST_TIMEOUT
    });
    
    const now = Date.now() / 1000;
    const maxFuture = now + (CONFIG.CONTEST_LOOKAHEAD_DAYS * 86400);

    return response.data.data.allContests
      .filter(c => c.startTime > now && c.startTime <= maxFuture)
      .map(c => ({
        site: 'LeetCode',
        name: c.title,
        start_time: new Date(c.startTime * 1000).toISOString(),
        end_time: new Date((c.startTime + c.duration) * 1000).toISOString(),
        duration: c.duration.toString(),
        url: `https://leetcode.com/contest/${c.titleSlug}/`
      }));
  } catch (e) { return []; }
}

// 3. AtCoder Fetcher
async function fetchAtCoderContests() {
  try {
    const response = await axios.get('https://atcoder.jp/contests/', { headers: { 'User-Agent': CONFIG.USER_AGENT } });
    const $ = cheerio.load(response.data);
    const contests = [];
    const now = new Date();
    
    $('#contest-table-upcoming tbody tr').each((_, row) => {
      const cols = $(row).find('td');
      if (cols.length < 4) return;
      const startTime = new Date($(cols[0]).text().trim());
      const name = $(cols[1]).find('a').text().trim();
      const url = 'https://atcoder.jp' + $(cols[1]).find('a').attr('href');
      
      if (startTime > now) {
         contests.push({
           site: 'AtCoder',
           name,
           start_time: startTime.toISOString(),
           duration: '7200', // Approx
           url
         });
      }
    });
    return contests;
  } catch (e) { return []; }
}

// 4. Main Aggregator Function
async function fetchAllContests() {
    console.log('[Contests] Fetching from all sources...');
    const [cf, lc, ac] = await Promise.all([
        fetchCodeforcesContests(),
        fetchLeetCodeContests(),
        fetchAtCoderContests()
    ]);
    
    // Merge and sort by time
    const all = [...cf, ...lc, ...ac].sort((a,b) => new Date(a.start_time) - new Date(b.start_time));
    return all;
}

// 5. THE CONTEST ROUTE (With Caching)
app.get('/api/contests', async (req, res) => {
  try {
    // A. Check Cache
    const cacheDoc = await db.collection('cache').doc('contests').get();
    if (cacheDoc.exists) {
        const data = cacheDoc.data();
        const age = Date.now() - data.updatedAt;
        if (age < CONFIG.CONTEST_CACHE_TTL) {
            console.log('[Contests] Returning Cached Data');
            return res.json({ contests: data.data, source: 'cache' });
        }
    }

    // B. Fetch Fresh
    const freshContests = await fetchAllContests();

    // C. Save to Cache (if we got data)
    if (freshContests.length > 0) {
        await db.collection('cache').doc('contests').set({
            data: freshContests,
            updatedAt: Date.now()
        });
    }

    res.json({ contests: freshContests, source: 'api' });
  } catch (error) {
    res.status(500).json({ error: error.message, contests: [] });
  }
});


// ============================================================================
//  SECTION B: ROADMAP SERVICE (Restored Prompts & Logic)
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

    console.log(`[Roadmap] Generating for ${userId}...`);

    const userPrompt = `
    USER CONTEXT: ${userContext}
    SKILL SNAPSHOT: ${JSON.stringify(skillSnapshot)}
    INSTRUCTIONS:
    1. Create 3 PHASES. Each phase has 3 TASKS.
    2. For EACH Task, generate exactly 6 QUESTIONS.
    3. QUESTION SOURCE: "platform": "LeetCode", "problem_id": EXACT ID.
    `;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: ROADMAP_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.3,
      response_format: { type: 'json_object' }
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
//  SECTION C: PROFILE SCRAPERS (LeetCode/Codeforces)
// ============================================================================

async function fetchLeetCodeData(username) {
  try {
    const query = `query userPublicProfile($username: String!) {
        matchedUser(username: $username) {
          submitStats { acSubmissionNum { difficulty count } }
          userCalendar { submissionCalendar totalActiveDays }
        }
        userContestRanking(username: $username) { rating globalRanking }
        recentSubmissionList(username: $username, limit: 5) { title timestamp statusDisplay lang }
        matchedUserStats: matchedUser(username: $username) {
          tagProblemCounts {
            fundamental { tagName problemsSolved }
            intermediate { tagName problemsSolved }
            advanced { tagName problemsSolved }
          }
        }
    }`;
    const response = await axios.post('https://leetcode.com/graphql', { query, variables: { username } }, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
    const data = response.data.data;
    if (!data.matchedUser) return null;

    const stats = data.matchedUser.submitStats.acSubmissionNum || [];
    const total = stats.reduce((acc, curr) => acc + curr.count, 0); // Sum of easy/med/hard is safer than 'All' sometimes
    const topicCount = {};
    
    // Flatten tags
    ['fundamental', 'intermediate', 'advanced'].forEach(level => {
        data.matchedUserStats?.tagProblemCounts?.[level]?.forEach(t => {
            topicCount[t.tagName] = (topicCount[t.tagName] || 0) + t.problemsSolved;
        });
    });

    return {
      platform: 'LeetCode', username,
      totalSolved: total,
      easy: stats.find(s=>s.difficulty==='Easy')?.count||0,
      medium: stats.find(s=>s.difficulty==='Medium')?.count||0,
      hard: stats.find(s=>s.difficulty==='Hard')?.count||0,
      contestRating: data.userContestRanking?.rating || 0,
      recentSubmissions: data.recentSubmissionList || [],
      topics: topicCount,
      streak: data.matchedUser.userCalendar?.totalActiveDays > 0 ? 1 : 0
    };
  } catch (e) { return null; }
}

async function fetchCodeforcesData(username) {
  try {
    const info = await axios.get(`https://codeforces.com/api/user.info?handles=${username}`, { timeout: 8000 });
    const status = await axios.get(`https://codeforces.com/api/user.status?handle=${username}&from=1&count=100`, { timeout: 8000 });
    
    if (info.data.status !== 'OK') return null;
    const user = info.data.result[0];
    const solved = new Set();
    const topics = {};

    status.data.result?.forEach(sub => {
        if (sub.verdict === 'OK') {
            solved.add(`${sub.problem.contestId}-${sub.problem.index}`);
            sub.problem.tags?.forEach(t => topics[t] = (topics[t]||0)+1);
        }
    });

    return {
        platform: 'Codeforces', username,
        totalSolved: solved.size,
        rating: user.rating || 0,
        rank: user.rank || 'unrated',
        topics
    };
  } catch (e) { return null; }
}

app.post('/api/update-coding-profile', async (req, res) => {
  try {
    const { userId, userProfiles } = req.body;
    
    // Aggregation Logic
    const results = await Promise.all([
        (userProfiles.leetcode) ? fetchLeetCodeData(userProfiles.leetcode) : null,
        (userProfiles.codeforces) ? fetchCodeforcesData(userProfiles.codeforces) : null
    ]);
    
    const validResults = results.filter(r => r !== null);
    const totalSolved = validResults.reduce((acc, r) => acc + (r.totalSolved||0), 0);
    const allTopics = {};
    validResults.forEach(r => {
        if(r.topics) Object.entries(r.topics).forEach(([k,v]) => allTopics[k] = (allTopics[k]||0)+v);
    });

    const newData = {
        userId, userProfiles, platforms: validResults, totalSolved, topics: allTopics,
        lastUpdated: new Date().toISOString()
    };

    await db.collection('CodingProfiles').doc(userId).set(newData, { merge: true });
    res.json({ success: true, data: newData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/coding-profile/:userId', async (req, res) => {
    const doc = await db.collection('CodingProfiles').doc(req.params.userId).get();
    res.json({ success: true, data: doc.exists ? doc.data() : null });
});


// ============================================================================
//  SECTION D: JOBS & APTITUDE
// ============================================================================
app.get('/api/jobs', async (req, res) => {
    try {
        const res1 = await axios.get('https://remotive.com/api/remote-jobs');
        const jobs = (res1.data.jobs || []).slice(0, 40).map(j => ({
            id: j.id, title: j.title, company: j.company_name, 
            location: 'Remote', type: j.job_type, logo: j.company_logo_url, apply_link: j.url
        }));
        res.json({ success: true, jobs: jobs.sort(() => Math.random() - 0.5) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-aptitude-test', async (req, res) => {
    try {
        const { difficulty = 'medium' } = req.body;
        const prompt = `Create a General Aptitude Test (20 Qs) in strict JSON: { "categories": [ { "name": "string", "questions": [ { "id": "1", "question": "str", "options": {"A":"str"}, "correctAnswer": "A" } ] } ] } Difficulty: ${difficulty}`;
        
        const completion = await groq.chat.completions.create({
            messages: [{role: 'user', content: prompt}],
            model: 'llama-3.3-70b-versatile',
            response_format: { type: 'json_object' }
        });
        
        const data = JSON.parse(completion.choices[0].message.content);
        res.json({ success: true, testData: { ...data, totalTime: 1200 } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-test-result', async (req, res) => {
    try {
        const { userId, stats } = req.body;
        await db.collection('CodingProfiles').doc(userId).set({
            aptitudeStats: {
                lastScore: stats.totalScore,
                lastDate: new Date().toISOString(),
                history: admin.firestore.FieldValue.arrayUnion({ date: new Date().toISOString(), score: stats.totalScore })
            }
        }, { merge: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// START
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on Port ${PORT}`));
