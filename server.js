// server.js - PRODUCTION READY VERSION
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const { Groq } = require('groq-sdk');
require('dotenv').config();

const app = express();

// ============================================================================
// PRODUCTION CONFIGURATION
// ============================================================================

// CORS Configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// Health Check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ============================================================================
// FIREBASE INITIALIZATION
// ============================================================================

if (!admin.apps.length) {
  try {
    if (!process.env.FIREBASE_KEY) {
      throw new Error('FIREBASE_KEY environment variable is missing');
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('[Firebase] ✅ Initialized successfully');
  } catch (error) {
    console.error('[Firebase] ❌ Init Error:', error.message);
    process.exit(1); // Exit in production if Firebase fails
  }
}
const db = admin.firestore();

// ============================================================================
// GROQ INITIALIZATION
// ============================================================================

if (!process.env.GROQ_API_KEY) {
  console.error('[Groq] ❌ API Key is missing!');
  process.exit(1);
}
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ============================================================================
// CONSTANTS
// ============================================================================

const CONFIG = {
  CONTEST_CACHE_TTL: 48 * 60 * 60 * 1000, // 2 Days
  REQUEST_TIMEOUT: 15000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  CONTEST_LOOKAHEAD_DAYS: 90
};

// ============================================================================
// SECTION A: CONTEST AGGREGATOR
// ============================================================================

async function fetchCodeforcesContests() {
  try {
    const response = await axios.get('https://codeforces.com/api/contest.list', { 
      timeout: CONFIG.REQUEST_TIMEOUT,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    
    if (response.data?.status !== 'OK') return [];
    
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
    console.error('[Codeforces] Error:', e.message);
    return []; 
  }
}

async function fetchLeetCodeContests() {
  try {
    const query = `query contestList { allContests { title titleSlug startTime duration } }`;
    const response = await axios.post('https://leetcode.com/graphql', { query }, {
      headers: { 
        'Content-Type': 'application/json', 
        'User-Agent': CONFIG.USER_AGENT,
        'Referer': 'https://leetcode.com'
      },
      timeout: CONFIG.REQUEST_TIMEOUT
    });
    
    const now = Date.now() / 1000;
    const contests = response.data?.data?.allContests || [];
    
    return contests
      .filter(c => c.startTime > now)
      .map(c => ({
        site: 'LeetCode',
        name: c.title,
        start_time: new Date(c.startTime * 1000).toISOString(),
        duration: c.duration.toString(),
        url: `https://leetcode.com/contest/${c.titleSlug}/`
      }));
  } catch (e) { 
    console.error('[LeetCode] Error:', e.message);
    return []; 
  }
}

async function fetchOtherPlatforms() {
  try {
    const response = await axios.get('https://kontests.net/api/v1/all', { 
      timeout: CONFIG.REQUEST_TIMEOUT,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    
    const now = new Date();
    
    return (response.data || [])
      .filter(c => {
        const t = new Date(c.start_time);
        return t > now && !isNaN(t.getTime());
      })
      .map(c => {
        let site = c.site;
        if (site === 'Kick Start') site = 'Google';
        
        return {
          site: site,
          name: c.name,
          start_time: c.start_time,
          end_time: c.end_time,
          duration: c.duration,
          url: c.url
        };
      });
  } catch (e) { 
    console.error('[Kontests] Error:', e.message);
    return []; 
  }
}

async function fetchAllContests() {
  console.log('[Contests] 🔄 Fetching data...');
  const [cf, lc, others] = await Promise.all([
    fetchCodeforcesContests(),
    fetchLeetCodeContests(),
    fetchOtherPlatforms()
  ]);

  let all = [...cf, ...lc, ...others];
  
  // Remove duplicates
  const uniqueMap = new Map();
  all.forEach(c => {
    const key = `${c.name.toLowerCase().trim()}_${c.start_time}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, c);
    }
  });

  const result = Array.from(uniqueMap.values())
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  
  console.log(`[Contests] ✅ Fetched ${result.length} contests`);
  return result;
}

// ============================================================================
// SECTION B: PROFILE SCRAPERS
// ============================================================================

async function fetchLeetCodeData(username) {
  try {
    const query = `
      query userPublicProfile($username: String!) {
        matchedUser(username: $username) {
          submitStats { acSubmissionNum { difficulty count } }
          userCalendar { submissionCalendar totalActiveDays }
          profile { ranking reputation }
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
      { 
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': CONFIG.USER_AGENT,
          'Referer': 'https://leetcode.com'
        }, 
        timeout: 10000 
      }
    );

    const data = response.data?.data;
    if (!data?.matchedUser) return null;

    const stats = data.matchedUser.submitStats?.acSubmissionNum || [];
    const easy = stats.find(s => s.difficulty === 'Easy')?.count || 0;
    const medium = stats.find(s => s.difficulty === 'Medium')?.count || 0;
    const hard = stats.find(s => s.difficulty === 'Hard')?.count || 0;

    // Process topics
    const topicCount = {};
    const tagData = data.matchedUserStats?.tagProblemCounts;
    if (tagData) {
      const allTags = [
        ...(tagData.fundamental || []), 
        ...(tagData.intermediate || []), 
        ...(tagData.advanced || [])
      ];
      allTags.forEach(item => {
        if (item?.tagName && item.problemsSolved > 0) {
          topicCount[item.tagName] = (topicCount[item.tagName] || 0) + item.problemsSolved;
        }
      });
    }

    return {
      platform: 'LeetCode',
      username,
      totalSolved: easy + medium + hard,
      easy, 
      medium, 
      hard,
      ranking: data.matchedUser.profile?.ranking || 0,
      contestRating: data.userContestRanking?.rating || 0,
      contestsAttended: data.userContestRanking?.attendedContestsCount || 0,
      globalRank: data.userContestRanking?.globalRanking || 0,
      recentSubmissions: data.recentSubmissionList || [], 
      topics: topicCount,
      streak: data.matchedUser.userCalendar?.totalActiveDays > 0 ? 1 : 0,
      totalActiveDays: data.matchedUser.userCalendar?.totalActiveDays || 0
    };
  } catch (error) {
    console.error('[LeetCode Profile] Error:', error.message);
    return null;
  }
}

async function fetchCodeforcesData(username) {
  try {
    const [userInfo, userStatus] = await Promise.all([
      axios.get(`https://codeforces.com/api/user.info?handles=${username}`, { 
        timeout: 10000,
        headers: { 'User-Agent': CONFIG.USER_AGENT }
      }),
      axios.get(`https://codeforces.com/api/user.status?handle=${username}&from=1&count=100`, { 
        timeout: 10000,
        headers: { 'User-Agent': CONFIG.USER_AGENT }
      })
    ]);
    
    if (userInfo.data?.status !== 'OK') return null;
    
    const user = userInfo.data.result[0];
    const submissions = userStatus.data?.result || [];
    
    const solvedProblems = new Set();
    const topicCount = {};
    
    submissions.forEach(sub => {
      if (sub.verdict === 'OK') {
        solvedProblems.add(`${sub.problem.contestId}-${sub.problem.index}`);
        sub.problem.tags?.forEach(tag => { 
          topicCount[tag] = (topicCount[tag] || 0) + 1; 
        });
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
  } catch (error) { 
    console.error('[Codeforces Profile] Error:', error.message);
    return null; 
  }
}

// ============================================================================
// SECTION C: API ROUTES
// ============================================================================

// 1. UPDATE CODING PROFILE
app.post('/api/update-coding-profile', async (req, res) => {
  try {
    const { userId, userProfiles } = req.body;
    
    if (!userId || !userProfiles) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing userId or userProfiles' 
      });
    }
    
    const results = await Promise.all([
      userProfiles.leetcode ? fetchLeetCodeData(userProfiles.leetcode) : Promise.resolve(null),
      userProfiles.codeforces ? fetchCodeforcesData(userProfiles.codeforces) : Promise.resolve(null)
    ]);
    
    const validResults = results.filter(r => r !== null);
    
    if (validResults.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'No valid profile data found. Please check usernames.' 
      });
    }
    
    const totalSolved = validResults.reduce((acc, r) => acc + (r.totalSolved || 0), 0);
    const allTopics = {};
    validResults.forEach(r => { 
      if (r.topics) {
        Object.entries(r.topics).forEach(([k, v]) => {
          allTopics[k] = (allTopics[k] || 0) + v;
        });
      }
    });

    const newData = {
      userId,
      userProfiles,
      platforms: validResults,
      totalSolved,
      topics: allTopics,
      streakData: { 
        currentStreak: validResults.find(r => r.platform === 'LeetCode')?.streak || 0 
      }, 
      lastUpdated: new Date().toISOString()
    };

    await db.collection('CodingProfiles').doc(userId).set(newData, { merge: true });
    console.log(`[Profile] ✅ Updated for user: ${userId}`);
    res.json({ success: true, data: newData });
  } catch (e) { 
    console.error('[Profile Update] Error:', e);
    res.status(500).json({ success: false, error: e.message }); 
  }
});

// 2. GET CODING PROFILE
app.get('/api/coding-profile/:userId', async (req, res) => {
  try {
    const doc = await db.collection('CodingProfiles').doc(req.params.userId).get();
    res.json({ 
      success: true, 
      data: doc.exists ? doc.data() : null 
    });
  } catch (e) {
    console.error('[Profile Fetch] Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 3. GET CONTESTS
app.get('/api/contests', async (req, res) => {
  try {
    // Check cache
    const cacheDoc = await db.collection('cache').doc('contests').get();
    if (cacheDoc.exists) {
      const data = cacheDoc.data();
      if ((Date.now() - data.updatedAt) < CONFIG.CONTEST_CACHE_TTL) {
        console.log('[Contests] 📦 Serving from cache');
        return res.json({ contests: data.data, source: 'cache' });
      }
    }

    // Fetch fresh
    const freshContests = await fetchAllContests();

    // Save cache
    if (freshContests.length > 0) {
      await db.collection('cache').doc('contests').set({ 
        data: freshContests, 
        updatedAt: Date.now() 
      });
    }
    
    res.json({ contests: freshContests, source: 'api' });
  } catch (e) { 
    console.error('[Contests] Error:', e);
    res.status(500).json({ error: e.message, contests: [] }); 
  }
});

// 4. GENERATE ROADMAP
const ROADMAP_SYSTEM_PROMPT = `You are an expert coding mentor. Generate a detailed, structured learning roadmap.
CRITICAL: Output STRICT JSON only. No markdown, no extra text.
JSON STRUCTURE: {
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
              "problem_id": "1",
              "platform": "LeetCode",
              "difficulty": "Easy"
            }
          ]
        }
      ]
    }
  ]
}`;

app.post('/api/generate-roadmap', async (req, res) => {
  try {
    const { userId, userContext, skillSnapshot } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId' });
    }
    
    const userPrompt = `USER CONTEXT: ${userContext || 'Beginner programmer learning DSA'}
SKILL SNAPSHOT: ${JSON.stringify(skillSnapshot || {})}
INSTRUCTIONS: Create exactly 3 PHASES. Each phase must have exactly 3 TASKS. Each task must have exactly 6 QUESTIONS with this exact structure: {"question_title":"Two Sum", "problem_id":"1", "platform":"LeetCode", "difficulty":"Easy"}`;

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
    
    await db.collection('UserRoadmaps')
      .doc(userId)
      .collection('roadmaps')
      .doc(roadmapId)
      .set({
        id: roadmapId,
        userId,
        roadmap,
        createdAt: new Date().toISOString(),
        completedQuestions: []
      });
    
    console.log(`[Roadmap] ✅ Generated for user: ${userId}`);
    res.json({ success: true, roadmap: { id: roadmapId, ...roadmap } });
  } catch (e) {
    console.error('[Roadmap] Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 5. DELETE ROADMAP
app.delete('/api/roadmap/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const roadmapId = req.body.roadmapId || req.query.roadmapId;
    
    if (!roadmapId) {
      return res.status(400).json({ success: false, error: "Missing roadmapId" });
    }
    
    await db.collection('UserRoadmaps')
      .doc(userId)
      .collection('roadmaps')
      .doc(roadmapId)
      .delete();
    
    res.json({ success: true });
  } catch (e) {
    console.error('[Roadmap Delete] Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 6. UPDATE ROADMAP PROGRESS
app.post('/api/roadmap/:userId/progress', async (req, res) => {
  try {
    const { userId } = req.params;
    const { roadmapId, completedQuestions } = req.body;
    
    if (!roadmapId || !completedQuestions) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing roadmapId or completedQuestions' 
      });
    }
    
    await db.collection('UserRoadmaps')
      .doc(userId)
      .collection('roadmaps')
      .doc(roadmapId)
      .update({ completedQuestions });
    
    res.json({ success: true });
  } catch (e) {
    console.error('[Roadmap Progress] Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 7. GET JOBS
app.get('/api/jobs', async (req, res) => {
  try {
    const response = await axios.get('https://remotive.com/api/remote-jobs', {
      timeout: CONFIG.REQUEST_TIMEOUT,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    
    const jobs = (response.data?.jobs || [])
      .slice(0, 40)
      .map(j => ({
        id: j.id,
        title: j.title,
        company: j.company_name,
        location: 'Remote',
        type: j.job_type,
        logo: j.company_logo_url,
        apply_link: j.url
      }))
      .sort(() => Math.random() - 0.5);
    
    res.json({ success: true, jobs });
  } catch (e) {
    console.error('[Jobs] Error:', e);
    res.status(500).json({ success: false, error: e.message, jobs: [] });
  }
});

// 8. GENERATE APTITUDE TEST
app.post('/api/generate-aptitude-test', async (req, res) => {
  try {
    const { difficulty = 'medium' } = req.body;
    
    const prompt = `Create a General Aptitude Test with exactly 20 questions in strict JSON format:
{
  "categories": [
    {
      "name": "Logical Reasoning",
      "questions": [
        {
          "id": "1",
          "question": "Question text here",
          "options": {
            "A": "Option A",
            "B": "Option B",
            "C": "Option C",
            "D": "Option D"
          },
          "correctAnswer": "A"
        }
      ]
    }
  ]
}
Difficulty: ${difficulty}
Include these categories: Logical Reasoning (5 Qs), Quantitative Aptitude (5 Qs), Verbal Ability (5 Qs), Data Interpretation (5 Qs).`;

    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' }
    });
    
    const data = JSON.parse(completion.choices[0].message.content);
    res.json({ 
      success: true, 
      testData: { 
        ...data, 
        totalTime: 1200 
      } 
    });
  } catch (e) {
    console.error('[Aptitude] Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 9. SAVE TEST RESULT
app.post('/api/save-test-result', async (req, res) => {
  try {
    const { userId, stats } = req.body;
    
    if (!userId || !stats) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing userId or stats' 
      });
    }
    
    await db.collection('CodingProfiles').doc(userId).set({
      aptitudeStats: {
        lastScore: stats.totalScore,
        lastDate: new Date().toISOString(),
        history: admin.firestore.FieldValue.arrayUnion({
          date: new Date().toISOString(),
          score: stats.totalScore
        })
      }
    }, { merge: true });
    
    res.json({ success: true });
  } catch (e) {
    console.error('[Test Result] Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================================

app.use((err, req, res, next) => {
  console.error('[Server Error]:', err);
  res.status(500).json({ 
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false,
    error: 'Route not found',
    path: req.path
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log(`✅ Server running on Port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Firebase: Connected`);
  console.log(`🤖 Groq AI: Ready`);
  console.log('========================================');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
