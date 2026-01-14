// server.js - FINAL CORRECTED VERSION
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const admin = require('firebase-admin');
const { Groq } = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(cors());
// IMPORTANT: Increase payload limit for large roadmap JSONs
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
  CONTEST_CACHE_TTL: 60 * 60 * 1000,
  REQUEST_TIMEOUT: 12000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  CONTEST_LOOKAHEAD_DAYS: 90
};


// ============================================================================
//  SECTION A: ROADMAP SERVICE (Restored Original Prompts)
// ============================================================================

// 1. THE EXACT SYSTEM PROMPT FROM YOUR ORIGINAL CODE
const ROADMAP_SYSTEM_PROMPT = `You are an expert coding mentor. Generate a detailed, structured learning roadmap.
CRITICAL: Output STRICT JSON only. No markdown.

JSON STRUCTURE:
{
  "roadmap_title": "string",
  "user_level": "string",
  "strategy_summary": "string",
  "phases": [
    {
      "phase_number": 1,
      "phase_title": "string",
      "duration_days": 5,
      "focus_reason": "string",
      "tasks": [
        {
          "concept_name": "string",
          "priority": "High",
          "estimated_time_minutes": 90,
          "difficulty": "Medium",
          "why_this_matters": "string",
          "practice_questions": [
             { 
               "question_title": "string", 
               "question_description": "string", 
               "difficulty": "Easy", 
               "platform": "LeetCode", 
               "problem_id": "1"
             }
          ]
        }
      ]
    }
  ]
}`;

// 2. GENERATE ROADMAP ROUTE
app.post('/api/generate-roadmap', async (req, res) => {
  try {
    const { userId, userContext, skillSnapshot } = req.body;
    
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    
    console.log(`[Roadmap] Generating for user: ${userId}`);

    // THE EXACT USER PROMPT INSTRUCTIONS FROM YOUR ORIGINAL CODE
    const userPrompt = `
    USER CONTEXT: ${userContext}
    SKILL SNAPSHOT: ${JSON.stringify(skillSnapshot)}
    
    INSTRUCTIONS:
    1. Create 3 PHASES. Each phase has 3 TASKS.
    2. For EACH Task, generate exactly 6 QUESTIONS (2 Easy, 2 Medium, 2 Hard).
    3. QUESTION SOURCE RULES (STRICT):
       - "platform": Must be "LeetCode" if possible.
       - "problem_id": MUST provide the exact LeetCode Question ID (e.g., "1", "206", "53"). Do NOT leave empty.
       - "question_title": Use the exact real problem name.
       - NO DUPLICATES: Never list the same Question ID twice.
    `;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: ROADMAP_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      model: 'llama-3.1-8b-instant', 
      temperature: 0.3,
      max_tokens: 8000,
      response_format: { type: 'json_object' }
    });

    const rawResponse = completion.choices[0].message.content;
    let roadmap;
    
    try {
      roadmap = JSON.parse(rawResponse);
    } catch (e) {
      console.error('[Roadmap] JSON Parse Error:', rawResponse);
      return res.status(500).json({ error: 'AI returned invalid JSON.' });
    }

    if (!roadmap.phases || roadmap.phases.length === 0) {
      return res.status(500).json({ error: 'AI generated incomplete roadmap.' });
    }

    const roadmapId = `roadmap_${Date.now()}`;
    const roadmapData = {
      id: roadmapId,
      userId,
      roadmap,
      createdAt: new Date().toISOString(),
      userContext,
      completedQuestions: []
    };

    // Save to Firestore
    await db.collection('UserRoadmaps')
      .doc(userId)
      .collection('roadmaps')
      .doc(roadmapId)
      .set(roadmapData);

    console.log(`[Roadmap] Success: ${roadmapId}`);
    res.json({ success: true, roadmap: roadmapData });

  } catch (error) {
    console.error('[Roadmap Error]:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 3. DELETE ROADMAP (Updated to support both Body and Query params)
app.delete('/api/roadmap/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const roadmapId = req.body.roadmapId || req.query.roadmapId;

    if (!roadmapId) return res.status(400).json({ error: "Missing roadmapId" });

    await db.collection('UserRoadmaps').doc(userId).collection('roadmaps').doc(roadmapId).delete();
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// 4. UPDATE PROGRESS (This was missing in the previous merged file!)
app.post('/api/roadmap/:userId/progress', async (req, res) => {
  try {
    const { userId } = req.params;
    const { roadmapId, completedQuestions } = req.body;
    
    await db.collection('UserRoadmaps').doc(userId).collection('roadmaps').doc(roadmapId)
      .update({ completedQuestions });
      
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});


// ============================================================================
//  SECTION B: SCRAPING SERVICE
// ============================================================================

async function fetchLeetCodeData(username) {
  try {
    const query = `
      query userPublicProfile($username: String!) {
        matchedUser(username: $username) {
          username
          submitStats { acSubmissionNum { difficulty count } }
          profile { ranking reputation }
          userCalendar { submissionCalendar totalActiveDays }
        }
        userContestRanking(username: $username) {
          attendedContestsCount
          rating
          globalRanking
        }
        recentSubmissionList(username: $username, limit: 10) {
          title
          titleSlug
          timestamp
          statusDisplay
          lang
        }
        matchedUserStats: matchedUser(username: $username) {
          tagProblemCounts {
            advanced { tagName problemsSolved }
            intermediate { tagName problemsSolved }
            fundamental { tagName problemsSolved }
          }
        }
      }
    `;
    const response = await axios.post(
      'https://leetcode.com/graphql',
      { query, variables: { username } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    const data = response.data.data;
    if (!data.matchedUser) return null;

    const stats = data.matchedUser.submitStats.acSubmissionNum || [];
    const easy = stats.find(s => s.difficulty === 'Easy')?.count || 0;
    const medium = stats.find(s => s.difficulty === 'Medium')?.count || 0;
    const hard = stats.find(s => s.difficulty === 'Hard')?.count || 0;

    const topicCount = {};
    const tagData = data.matchedUserStats?.tagProblemCounts;
    if (tagData) {
      const allTags = [...(tagData.fundamental || []), ...(tagData.intermediate || []), ...(tagData.advanced || [])];
      allTags.forEach(item => {
        if (item && item.tagName && item.problemsSolved > 0) {
          topicCount[item.tagName] = (topicCount[item.tagName] || 0) + item.problemsSolved;
        }
      });
    }

    let currentStreak = 0;
    if (data.matchedUser.userCalendar?.totalActiveDays) {
         currentStreak = data.matchedUser.userCalendar.totalActiveDays > 0 ? 1 : 0; 
    }

    return {
      platform: 'LeetCode',
      username,
      totalSolved: easy + medium + hard,
      easy, medium, hard,
      ranking: data.matchedUser.profile?.ranking || 0,
      contestRating: data.userContestRanking?.rating || 0,
      contestsAttended: data.userContestRanking?.attendedContestsCount || 0,
      globalRank: data.userContestRanking?.globalRanking || 0,
      recentSubmissions: data.recentSubmissionList || [],
      topics: topicCount,
      streak: currentStreak,
      totalActiveDays: data.matchedUser.userCalendar?.totalActiveDays || 0,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    return null;
  }
}

async function fetchCodeforcesData(username) {
  try {
    const [userInfo, userStatus] = await Promise.all([
      axios.get(`https://codeforces.com/api/user.info?handles=${username}`, { timeout: 10000 }),
      axios.get(`https://codeforces.com/api/user.status?handle=${username}&from=1&count=100`, { timeout: 10000 })
    ]);
    if(userInfo.data.status !== 'OK') return null;
    const user = userInfo.data.result[0];
    const submissions = userStatus.data.result || [];
    const solvedProblems = new Set();
    const topicCount = {};
    submissions.forEach(sub => {
      if (sub.verdict === 'OK') {
        solvedProblems.add(`${sub.problem.contestId}-${sub.problem.index}`);
        sub.problem.tags?.forEach(tag => { topicCount[tag] = (topicCount[tag] || 0) + 1; });
      }
    });
    return {
      platform: 'Codeforces',
      username,
      totalSolved: solvedProblems.size,
      rating: user.rating || 0,
      maxRating: user.maxRating || 0,
      rank: user.rank || 'unrated',
      topics: topicCount,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) { return null; }
}

async function fetchCodeChefData(username) {
  try {
    const response = await axios.get(`https://www.codechef.com/users/${username}`, { 
      headers: { 'User-Agent': CONFIG.USER_AGENT }, timeout: 10000
    });
    const $ = cheerio.load(response.data);
    const rating = $('.rating-number').first().text().trim() || '0';
    const problemsSolved = $('.problems-solved .content h5').text().split('(')[1]?.split(')')[0] || '0';
    return {
      platform: 'CodeChef',
      username,
      totalSolved: parseInt(problemsSolved) || 0,
      currentRating: parseInt(rating) || 0,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) { return null; }
}

async function aggregateAllPlatforms(userProfiles) {
  console.log('\n[Profile Aggregation] Starting...');
  const results = await Promise.all([
    (userProfiles.leetcode && userProfiles.leetcode.trim()) ? fetchLeetCodeData(userProfiles.leetcode) : null,
    (userProfiles.codeforces && userProfiles.codeforces.trim()) ? fetchCodeforcesData(userProfiles.codeforces) : null,
    (userProfiles.codechef && userProfiles.codechef.trim()) ? fetchCodeChefData(userProfiles.codechef) : null,
  ]);

  const validResults = results.filter(r => r !== null);
  const totalSolved = validResults.reduce((sum, r) => sum + (r.totalSolved || 0), 0);

  const allTopics = {};
  validResults.forEach(result => {
    if (result.topics) {
      Object.entries(result.topics).forEach(([topic, count]) => {
        allTopics[topic] = (allTopics[topic] || 0) + count;
      });
    }
  });

  return {
    totalSolved,
    platforms: validResults,
    topics: allTopics,
    streakData: { currentStreak: validResults[0]?.streak || 0 }, 
    lastUpdated: new Date().toISOString()
  };
}

// ============================================================================
//  SECTION C: JOB & APTITUDE & MAIN ROUTES
// ============================================================================

function normalizeJobType(type) {
  if (!type) return 'Full-time';
  const t = type.toLowerCase();
  if (t.includes('freelance')) return 'Freelance';
  if (t.includes('contract')) return 'Contract';
  if (t.includes('intern')) return 'Internship';
  if (t.includes('part')) return 'Part-time';
  return 'Full-time';
}

app.get('/api/jobs', async (req, res) => {
  try {
    const [remotiveRes, jobicyRes] = await Promise.allSettled([
      axios.get('https://remotive.com/api/remote-jobs'),
      axios.get('https://jobicy.com/api/v2/remote-jobs?count=20')
    ]);

    let allJobs = [];

    if (remotiveRes.status === 'fulfilled') {
      const rJobs = remotiveRes.value.data.jobs || [];
      allJobs.push(...rJobs.slice(0, 30).map(job => ({
        id: `rem-${job.id}`,
        title: job.title,
        company: job.company_name,
        location: job.candidate_required_location || 'Remote',
        type: normalizeJobType(job.job_type),
        logo: job.company_logo_url,
        apply_link: job.url,
        source: 'Remotive'
      })));
    }

    if (jobicyRes.status === 'fulfilled') {
      const jJobs = jobicyRes.value.data.jobs || [];
      allJobs.push(...jJobs.map(job => ({
        id: `jobicy-${job.id}`,
        title: job.jobTitle,
        company: job.companyName,
        location: job.jobGeo || 'Remote',
        type: normalizeJobType(Array.isArray(job.jobType) ? job.jobType[0] : job.jobType),
        logo: job.companyLogo,
        apply_link: job.url,
        source: 'Jobicy'
      })));
    }

    allJobs = allJobs.sort(() => Math.random() - 0.5);
    res.json({ success: true, jobs: allJobs });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/generate-aptitude-test', async (req, res) => {
  try {
    const { userId, difficulty = 'medium' } = req.body;
    const prompt = `Create a General Aptitude Test with 20 questions in strict JSON format.
    Structure: 4 Categories (5 questions each): Logical Reasoning, Quantitative Aptitude, Verbal Ability, Data Interpretation.
    Difficulty: ${difficulty}.
    JSON Schema: { "categories": [ { "name": "string", "questions": [ { "id": "uuid", "question": "str", "options": {"A":"str"}, "correctAnswer": "A", "explanation": "str" } ] } ] }`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You are a JSON generator. Output valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 4500
      },
      { headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` } }
    );

    let content = response.data.choices[0].message.content;
    const firstOpen = content.indexOf('{');
    const lastClose = content.lastIndexOf('}');
    if (firstOpen !== -1 && lastClose !== -1) content = content.substring(firstOpen, lastClose + 1);

    const questionsData = JSON.parse(content);
    res.json({ success: true, testData: { categories: questionsData.categories, totalTime: 1200, totalQuestions: 20 } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/save-test-result', async (req, res) => {
  try {
    const { userId, stats } = req.body;
    const { totalScore, topicBreakdown } = stats;
    const userRef = db.collection('CodingProfiles').doc(userId);
    const doc = await userRef.get();
    const currentStats = (doc.exists ? doc.data().aptitudeStats : {}) || {};
    const currentTotal = (currentStats.totalTests || 0);

    await userRef.set({
      aptitudeStats: {
        totalTests: currentTotal + 1,
        lastScore: totalScore,
        lastDate: new Date().toISOString(),
        topicPerformance: topicBreakdown,
        history: admin.firestore.FieldValue.arrayUnion({ date: new Date().toISOString(), score: totalScore })
      }
    }, { merge: true });

    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/update-coding-profile', async (req, res) => {
  try {
    const { userId, userProfiles } = req.body;
    if (!userId || !userProfiles) return res.status(400).json({ error: 'Missing data' });
    
    const aggregatedData = await aggregateAllPlatforms(userProfiles);

    await db.collection('CodingProfiles').doc(userId).set({
      userId,
      userProfiles,
      ...aggregatedData, 
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true, data: aggregatedData });
  } catch (error) {
    console.error('[API] Update Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/coding-profile/:userId', async (req, res) => {
  try {
    const doc = await db.collection('CodingProfiles').doc(req.params.userId).get();
    res.json({ success: true, data: doc.exists ? doc.data() : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/contests', async (req, res) => {
  try {
    const response = await axios.get('https://codeforces.com/api/contest.list');
    const now = Math.floor(Date.now()/1000);
    const contests = response.data.result
        .filter(c => c.phase === 'BEFORE' && c.startTimeSeconds > now)
        .map(c => ({
            site: 'CodeForces',
            name: c.name,
            start_time: new Date(c.startTimeSeconds * 1000).toISOString(),
            duration: c.durationSeconds.toString(),
            url: `https://codeforces.com/contest/${c.id}`
        }));
    res.json({ contests, source: 'api' });
  } catch(e) { res.json({ contests: [], error: e.message }); }
});

// START
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on Port ${PORT}`);
});
