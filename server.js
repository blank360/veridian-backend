// server.js - COMPLETE PRODUCTION BACKEND
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const admin = require('firebase-admin');
const { Groq } = require('groq-sdk');
require('dotenv').config();

const app = express();

// --- CONFIGURATION ---
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// --- HEALTH CHECK ---
app.get('/health', (req, res) => res.json({ 
  status: 'ok', 
  timestamp: new Date().toISOString(),
  version: '4.5.0' // Bumped for Quantity Fix
}));

// --- FIREBASE INIT ---
if (!admin.apps.length) {
  try {
    const serviceAccount = process.env.FIREBASE_KEY 
      ? JSON.parse(process.env.FIREBASE_KEY)
      : require('./serviceAccountKey.json');
    
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('[Firebase] ✅ Initialized');
  } catch (error) {
    console.error('[Firebase] ❌ Error:', error.message);
    process.exit(1);
  }
}
const db = admin.firestore();

// --- GROQ INIT ---
if (!process.env.GROQ_API_KEY) {
  console.error('[Groq] ❌ Missing API Key');
  process.exit(1);
}
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- CONSTANTS ---
const CONFIG = {
  CONTEST_CACHE_TTL: 2 * 60 * 60 * 1000, 
  REQUEST_TIMEOUT: 15000,                
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  CONTEST_LOOKAHEAD_DAYS: 90
};

// ============================================================================
//  SECTION 1: ROBUST CONTEST FETCHING
// ============================================================================

const isContestInTimeframe = (startTimeSeconds) => {
  const now = Math.floor(Date.now() / 1000);
  const max = now + (CONFIG.CONTEST_LOOKAHEAD_DAYS * 24 * 60 * 60);
  return startTimeSeconds > now && startTimeSeconds <= max;
};

// 1. CODEFORCES
async function fetchCodeforcesContests() {
  try {
    const res = await axios.get('https://codeforces.com/api/contest.list', {
      timeout: CONFIG.REQUEST_TIMEOUT,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    if (res.data?.status !== 'OK') return [];
    
    return res.data.result
      .filter(c => c.phase === 'BEFORE' && isContestInTimeframe(c.startTimeSeconds))
      .map(c => ({
        site: 'CodeForces',
        name: c.name,
        start_time: new Date(c.startTimeSeconds * 1000).toISOString(),
        end_time: new Date((c.startTimeSeconds + c.durationSeconds) * 1000).toISOString(),
        duration: c.durationSeconds.toString(),
        url: `https://codeforces.com/contest/${c.id}`
      }));
  } catch (e) { 
    console.error('[Contests] Codeforces fetch failed:', e.message);
    return []; 
  }
}

// 2. LEETCODE
async function fetchLeetCodeContests() {
  try {
    const query = `query { allContests { title titleSlug startTime duration } }`;
    const res = await axios.post('https://leetcode.com/graphql', { query }, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': CONFIG.USER_AGENT },
      timeout: CONFIG.REQUEST_TIMEOUT
    });
    
    const now = Date.now() / 1000;
    const max = now + (CONFIG.CONTEST_LOOKAHEAD_DAYS * 24 * 60 * 60);
    
    return (res.data?.data?.allContests || [])
      .filter(c => c.startTime > now && c.startTime <= max)
      .map(c => ({
        site: 'LeetCode',
        name: c.title,
        start_time: new Date(c.startTime * 1000).toISOString(),
        end_time: new Date((c.startTime + c.duration) * 1000).toISOString(),
        duration: c.duration.toString(),
        url: `https://leetcode.com/contest/${c.titleSlug}/`
      }));
  } catch (e) { 
    console.error('[Contests] LeetCode fetch failed:', e.message);
    return []; 
  }
}

// 3. ATCODER
async function fetchAtCoderContests() {
  try {
    const { data } = await axios.get('https://atcoder.jp/contests/', {
      headers: { 'User-Agent': CONFIG.USER_AGENT },
      timeout: CONFIG.REQUEST_TIMEOUT
    });
    
    const $ = cheerio.load(data);
    const contests = [];

    $('#contest-table-upcoming tbody tr').each((i, el) => {
      const tds = $(el).find('td');
      if (tds.length < 2) return;

      const timeStr = $(tds[0]).find('time').text() || $(tds[0]).text(); 
      const startTime = new Date(timeStr);
      
      const nameAnchor = $(tds[1]).find('a');
      const name = nameAnchor.text();
      const path = nameAnchor.attr('href');
      const url = `https://atcoder.jp${path}`;
      
      const durationStr = $(tds[2]).text().trim(); 
      const [h, m] = durationStr.split(':').map(Number);
      const durationSec = (h * 3600) + (m * 60);
      const endTime = new Date(startTime.getTime() + durationSec * 1000);

      if (isContestInTimeframe(startTime.getTime() / 1000)) {
        contests.push({
          site: 'AtCoder',
          name,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          duration: durationSec.toString(),
          url
        });
      }
    });
    return contests;
  } catch (e) {
    console.error('[Contests] AtCoder scrape failed:', e.message);
    return [];
  }
}

// 4. KONTESTS
async function fetchKontestsContests() {
  try {
    const res = await axios.get('https://kontests.net/api/v1/all', {
      timeout: 10000,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    
    const now = new Date();
    const max = new Date(now.getTime() + CONFIG.CONTEST_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
    
    return (res.data || [])
      .filter(c => {
        const site = c.site || '';
        if (site.includes('CodeForces') || site.includes('LeetCode') || site.includes('AtCoder')) return false;
        try {
          const start = new Date(c.start_time);
          const end = new Date(c.end_time);
          return end > now && start <= max;
        } catch { return false; }
      })
      .map(c => ({
        site: c.site || 'Other',
        name: c.name,
        start_time: c.start_time,
        end_time: c.end_time,
        duration: c.duration,
        url: c.url
      }));
  } catch (e) { 
    return []; 
  }
}

async function fetchAllContests() {
  const [cf, lc, ac, other] = await Promise.allSettled([
    fetchCodeforcesContests(),
    fetchLeetCodeContests(),
    fetchAtCoderContests(),
    fetchKontestsContests()
  ]);
  
  const all = [
    ...(cf.status === 'fulfilled' ? cf.value : []),
    ...(lc.status === 'fulfilled' ? lc.value : []),
    ...(ac.status === 'fulfilled' ? ac.value : []),
    ...(other.status === 'fulfilled' ? other.value : [])
  ];
  
  const unique = [];
  const seen = new Set();
  all.forEach(c => {
    const key = `${c.name.toLowerCase().trim()}-${new Date(c.start_time).getTime()}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  });
  
  return unique.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
}

async function getCachedContests() {
  try {
    const doc = await db.collection('cache').doc('contests').get();
    if (!doc.exists) return null;
    const data = doc.data();
    const age = Date.now() - data.updatedAt;
    return {
      contests: data.data || [],
      updatedAt: data.updatedAt,
      age,
      isExpired: age > CONFIG.CONTEST_CACHE_TTL
    };
  } catch { return null; }
}

async function saveCachedContests(contests) {
  try {
    await db.collection('cache').doc('contests').set({
      data: contests,
      updatedAt: Date.now(),
      count: contests.length
    });
    return true;
  } catch { return false; }
}

// ============================================================================
//  SECTION 2: PROFILES
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
          attendedContestsCount rating globalRanking
        }
        recentSubmissionList(username: $username, limit: 10) {
          title titleSlug timestamp statusDisplay lang
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
    
    const res = await axios.post('https://leetcode.com/graphql', 
      { query, variables: { username } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    
    const data = res.data?.data;
    if (!data?.matchedUser) return null;
    
    const stats = data.matchedUser.submitStats?.acSubmissionNum || [];
    const easy = stats.find(s => s.difficulty === 'Easy')?.count || 0;
    const medium = stats.find(s => s.difficulty === 'Medium')?.count || 0;
    const hard = stats.find(s => s.difficulty === 'Hard')?.count || 0;
    
    const topicCount = {};
    const tagData = data.matchedUserStats?.tagProblemCounts;
    if (tagData) {
      [...(tagData.fundamental || []), ...(tagData.intermediate || []), ...(tagData.advanced || [])]
        .forEach(item => {
          if (item?.tagName && item.problemsSolved > 0) {
            topicCount[item.tagName] = (topicCount[item.tagName] || 0) + item.problemsSolved;
          }
        });
    }
    
    let streak = 0;
    if (data.matchedUser.userCalendar?.submissionCalendar) {
      try {
        const cal = JSON.parse(data.matchedUser.userCalendar.submissionCalendar);
        const ts = Object.keys(cal).map(t => parseInt(t)).sort((a, b) => b - a);
        if (ts.length > 0) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          let check = Math.floor(today.getTime() / 1000);
          const day = 86400;
          for (let i = 0; i < ts.length; i++) {
            const d = new Date(ts[i] * 1000);
            d.setHours(0, 0, 0, 0);
            const subTs = Math.floor(d.getTime() / 1000);
            if (subTs === check || subTs === check - day) {
              if (subTs < check) { streak++; check = subTs; }
            } else if (subTs < check - day) break;
          }
        }
      } catch {}
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
      streak,
      totalActiveDays: data.matchedUser.userCalendar?.totalActiveDays || 0,
      lastUpdated: new Date().toISOString()
    };
  } catch { return null; }
}

async function fetchCodechefData(username) {
  try {
    const { data } = await axios.get(`https://www.codechef.com/users/${username}`, {
      headers: { 'User-Agent': CONFIG.USER_AGENT },
      timeout: CONFIG.REQUEST_TIMEOUT
    });
    
    const $ = cheerio.load(data);
    const rating = parseInt($('.rating-number').text().replace(/\D/g, '')) || 0;
    const stars = $('.rating-star').text().trim() || 'Unrated';
    const globalRank = parseInt($('.rating-ranks ul li:first-child a strong').text()) || 0;
    
    return {
      platform: 'CodeChef',
      username,
      rating,
      stars,
      globalRank,
      lastUpdated: new Date().toISOString()
    };
  } catch (e) {
    return null;
  }
}

async function fetchGeeksForGeeksData(username) {
  try {
    const { data } = await axios.get(`https://auth.geeksforgeeks.org/user/${username}/practice/`, {
      headers: { 'User-Agent': CONFIG.USER_AGENT },
      timeout: CONFIG.REQUEST_TIMEOUT
    });
    
    const $ = cheerio.load(data);
    let totalSolved = 0;
    let score = 0;
    
    $('div, span, h6').each((i, el) => {
      const text = $(el).text().trim();
      if (text.includes('Problem Solved') || text.includes('Problems Solved')) {
         const num = $(el).next().text() || $(el).parent().find('.scoreCard_head_card_left--score__pC6ZA').text();
         totalSolved = parseInt(num) || totalSolved;
      }
      if (text.includes('Coding Score')) {
         const num = $(el).next().text() || $(el).parent().find('.scoreCard_head_card_left--score__pC6ZA').text();
         score = parseInt(num) || score;
      }
    });

    if (totalSolved === 0) {
        const rawText = $.text();
        const solvedMatch = rawText.match(/Problems Solved:\s*(\d+)/);
        if (solvedMatch) totalSolved = parseInt(solvedMatch[1]);
    }

    return {
      platform: 'GeeksForGeeks',
      username,
      totalSolved,
      codingScore: score,
      lastUpdated: new Date().toISOString()
    };
  } catch (e) {
    return null;
  }
}

async function fetchAtCoderProfile(username) {
  try {
    const { data } = await axios.get(`https://atcoder.jp/users/${username}`, {
      headers: { 'User-Agent': CONFIG.USER_AGENT },
      timeout: CONFIG.REQUEST_TIMEOUT
    });
    
    const $ = cheerio.load(data);
    let rating = 0;
    let rank = 0;
    
    $('table.dl-table tbody tr').each((i, el) => {
      const header = $(el).find('th').text().trim();
      const value = $(el).find('td').text().trim();
      
      if (header === 'Rating') {
        rating = parseInt(value.split(' ')[0]);
      }
      if (header === 'Rank') {
        rank = parseInt(value);
      }
    });

    return {
      platform: 'AtCoder',
      username,
      rating,
      rank,
      lastUpdated: new Date().toISOString()
    };
  } catch (e) {
    return null;
  }
}

async function fetchCodeforcesData(username) {
  try {
    const [info, status] = await Promise.all([
      axios.get(`https://codeforces.com/api/user.info?handles=${username}`, { timeout: 10000 }),
      axios.get(`https://codeforces.com/api/user.status?handle=${username}&from=1&count=100`, { timeout: 10000 })
    ]);
    
    if (info.data?.status !== 'OK') return null;
    
    const user = info.data.result[0];
    const subs = status.data?.result || [];
    const solved = new Set();
    const topics = {};
    
    subs.forEach(s => {
      if (s.verdict === 'OK') {
        solved.add(`${s.problem.contestId}-${s.problem.index}`);
        s.problem.tags?.forEach(t => topics[t] = (topics[t] || 0) + 1);
      }
    });
    
    return {
      platform: 'Codeforces',
      username,
      totalSolved: solved.size,
      rating: user.rating || 0,
      maxRating: user.maxRating || 0,
      rank: user.rank || 'unrated',
      topics,
      lastUpdated: new Date().toISOString()
    };
  } catch { return null; }
}

async function aggregateAllPlatforms(userProfiles) {
  const results = await Promise.all([
    userProfiles.leetcode?.trim() ? fetchLeetCodeData(userProfiles.leetcode) : null,
    userProfiles.codeforces?.trim() ? fetchCodeforcesData(userProfiles.codeforces) : null,
    userProfiles.codechef?.trim() ? fetchCodechefData(userProfiles.codechef) : null,
    userProfiles.geeksforgeeks?.trim() ? fetchGeeksForGeeksData(userProfiles.geeksforgeeks) : null,
    userProfiles.atcoder?.trim() ? fetchAtCoderProfile(userProfiles.atcoder) : null
  ]);
  
  const valid = results.filter(r => r);
  const totalSolved = valid.reduce((sum, r) => sum + (r.totalSolved || 0), 0);
  
  const allTopics = {};
  valid.forEach(r => {
    if (r.topics) {
      Object.entries(r.topics).forEach(([k, v]) => {
        allTopics[k] = (allTopics[k] || 0) + v;
      });
    }
  });
  
  const maxStreak = Math.max(...valid.map(r => r.streak || 0), 0);
  
  return {
    totalSolved,
    platforms: valid,
    topics: allTopics,
    streakData: { currentStreak: maxStreak },
    lastUpdated: new Date().toISOString()
  };
}

// ============================================================================
//  SECTION 3: APTITUDE
// ============================================================================

async function generateAptitudeTest(userId, difficulty = 'medium') {
  try {
    const prompt = `Create General Aptitude Test (20 Qs, 4 categories, 5 each) JSON only:
{"categories":[{"name":"Logical Reasoning","questions":[{"id":"1","question":"str","options":{"A":"","B":"","C":"","D":""},"correctAnswer":"A","explanation":"str"}]}]}
Difficulty: ${difficulty}. Categories: Logical Reasoning, Quantitative, Verbal, Data Interpretation.`;
    
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'JSON generator. Valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 4500,
      response_format: { type: 'json_object' }
    });
    
    let content = completion.choices[0].message.content;
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end !== -1) content = content.substring(start, end + 1);
    
    const data = JSON.parse(content);
    return { 
      success: true, 
      testData: { ...data, totalTime: 1200, totalQuestions: 20 }
    };
  } catch (error) {
    throw new Error('AI JSON generation failed');
  }
}

async function saveTestResult(userId, stats) {
  try {
    const { totalScore, topicBreakdown } = stats;
    const ref = db.collection('CodingProfiles').doc(userId);
    const doc = await ref.get();
    const current = doc.exists ? doc.data().aptitudeStats || {} : {};
    const total = current.totalTests || current.totalRounds || 0;
    
    await ref.set({
      aptitudeStats: {
        totalTests: total + 1,
        totalRounds: total + 1,
        lastScore: totalScore,
        lastDate: new Date().toISOString(),
        topicPerformance: topicBreakdown,
        history: [{
          testDate: new Date().toISOString(),
          score: totalScore,
          topicPerformance: topicBreakdown
        }]
      }
    }, { merge: true });
    
    return { success: true };
  } catch (error) {
    throw error;
  }
}

// ============================================================================
//  SECTION 4: ROADMAP (HIGH QUALITY & HIGH QUANTITY)
// ============================================================================

// --- REVISED PROMPT WITH STRICT QUANTITY CONTROLS ---
const ROADMAP_PROMPT = `You are a Senior Technical Curriculum Developer. Generate a structured learning roadmap.

CRITICAL INSTRUCTION: DETECT THE DOMAIN (DSA vs DEVELOPMENT)

--- GLOBAL RULE: QUANTITY ---
Each Task MUST contain 5 to 8 items/questions. Do NOT generate fewer than 5.

--- MODE A: DSA & COMPETITIVE PROGRAMMING ---
(Triggered by: "Arrays", "DP", "Trees", "LeetCode", "Logic")
* **Focus:** Raw coding practice.
* **Item Style:** Real Algorithmic Problems.
* **Platform:** "LeetCode", "CodeForces".
* **Title:** "Two Sum", "Merge Intervals".

--- MODE B: DEVELOPMENT & ENGINEERING (THEORY + PRACTICE) ---
(Triggered by: "React", "Node", "Web Dev", "App Dev", "System Design", "Backend")
* **Focus:** A "University Course" style curriculum.
* **Item Style:** You MUST mix "Concepts" with "Tasks". Do NOT just list projects.
* **Structure per Task:**
    1.  **Concept:** A topic the user must read about (Platform: "Concept").
    2.  **Action:** A small code task to verify knowledge (Platform: "Task").
    3.  **Project:** A mini implementation (Platform: "Project").
* **Example Output for Dev:**
    - Item 1: "Learn React State vs Props" (Platform: "Concept")
    - Item 2: "Build a Counter Component" (Platform: "Task")
    - Item 3: "Understand useEffect Lifecycle" (Platform: "Concept")
    - Item 4: "Fetch Data from API" (Platform: "Task")
    - Item 5: "Build a Todo List" (Platform: "Project")

JSON STRUCTURE (Strictly follow this):
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
          "concept_name": "string (e.g., 'Component Lifecycle' or 'Sliding Window')",
          "priority": "High",
          "difficulty": "Medium",
          "why_this_matters": "string",
          "practice_questions": [
             { 
               "question_title": "string (The specific concept or task)", 
               "problem_id": "string (slug, e.g., 'concept-props' or '1')", 
               "platform": "string (Concept, Task, Project, or LeetCode)", 
               "difficulty": "Easy",
               "question_description": "Brief instruction on what to learn or build."
             }
          ]
        }
      ]
    }
  ]
}`;

// ============================================================================
//  SECTION 5: JOBS
// ============================================================================

const normalizeType = (type) => {
  if (!type) return 'Full-time';
  const t = type.toLowerCase();
  if (t.includes('freelance')) return 'Freelance';
  if (t.includes('contract')) return 'Contract';
  if (t.includes('intern')) return 'Internship';
  if (t.includes('part')) return 'Part-time';
  return 'Full-time';
};

async function fetchJobs() {
  const [rem, job, him] = await Promise.allSettled([
    axios.get('https://remotive.com/api/remote-jobs', { timeout: CONFIG.REQUEST_TIMEOUT }),
    axios.get('https://jobicy.com/api/v2/remote-jobs?count=50', { timeout: CONFIG.REQUEST_TIMEOUT }),
    axios.get('https://himalayas.app/jobs/api?limit=50', { timeout: CONFIG.REQUEST_TIMEOUT })
  ]);
  
  let all = [];
  
  if (rem.status === 'fulfilled') {
    const jobs = rem.value.data.jobs || [];
    all.push(...jobs.map(j => ({
      id: `rem-${j.id}`,
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || 'Remote',
      type: normalizeType(j.job_type),
      logo: j.company_logo_url || '',
      apply_link: j.url,
      source: 'Remotive'
    })));
  }
  
  if (job.status === 'fulfilled') {
    const jobs = job.value.data.jobs || [];
    all.push(...jobs.map(j => ({
      id: `job-${j.id}`,
      title: j.jobTitle,
      company: j.companyName,
      location: j.jobGeo || 'Remote',
      type: normalizeType(Array.isArray(j.jobType) ? j.jobType[0] : j.jobType),
      logo: j.companyLogo || '',
      apply_link: j.url,
      source: 'Jobicy'
    })));
  }
  
  if (him.status === 'fulfilled') {
    const jobs = him.value.data.jobs || [];
    all.push(...jobs.map(j => ({
      id: `him-${j.guid}`,
      title: j.title,
      company: j.companyName,
      location: j.locationRestrictions?.[0] || 'Remote',
      type: normalizeType(j.employmentType),
      logo: j.companyLogo || '',
      apply_link: j.applicationLink,
      source: 'Himalayas'
    })));
  }
  
  return all.sort(() => Math.random() - 0.5);
}

// ============================================================================
//  SECTION 6: ROUTES
// ============================================================================

// --- Profile Routes ---
app.post('/api/update-coding-profile', async (req, res) => {
  try {
    const { userId, userProfiles } = req.body;
    if (!userId || !userProfiles) return res.status(400).json({ error: 'Missing data' });
    
    const data = await aggregateAllPlatforms(userProfiles);
    if (data.platforms.length === 0) {
      return res.status(404).json({ error: 'No valid profiles found' });
    }
    
    await db.collection('CodingProfiles').doc(userId).set({
      userId,
      userProfiles,
      ...data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/coding-profile/:userId', async (req, res) => {
  try {
    const doc = await db.collection('CodingProfiles').doc(req.params.userId).get();
    res.json({ success: true, data: doc.exists ? doc.data() : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Contest Routes ---
app.get('/api/contests', async (req, res) => {
  try {
    const cached = await getCachedContests();
    
    if (cached && !cached.isExpired && cached.contests.length > 0) {
      return res.json({ contests: cached.contests, source: 'cache' });
    }
    
    const fresh = await fetchAllContests();
    
    if (fresh && fresh.length > 0) {
      await saveCachedContests(fresh);
      return res.json({ contests: fresh, source: 'api' });
    }
    
    if (cached && cached.contests.length > 0) {
      return res.json({ contests: cached.contests, source: 'cache_stale' });
    }
    
    res.status(503).json({ error: 'Service unavailable' });
  } catch (e) {
    res.status(500).json({ error: e.message, contests: [] });
  }
});

// --- Aptitude Routes ---
app.post('/api/generate-aptitude-test', async (req, res) => {
  try {
    const { userId, difficulty } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    
    const result = await generateAptitudeTest(userId, difficulty || 'medium');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/save-test-result', async (req, res) => {
  try {
    const { userId, stats } = req.body;
    if (!userId || !stats) return res.status(400).json({ error: 'Missing data' });
    
    const result = await saveTestResult(userId, stats);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/aptitude-history/:userId', async (req, res) => {
  try {
    const doc = await db.collection('CodingProfiles').doc(req.params.userId).get();
    const stats = doc.exists ? doc.data().aptitudeStats : null;
    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Roadmap Routes (UPDATED WITH QUANTITY) ---
app.post('/api/generate-roadmap', async (req, res) => {
  try {
    const { userId, userContext, skillSnapshot } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    
    // CONTEXTUAL PROMPT
    const userPrompt = `
    USER CONTEXT: "${userContext || 'Full Stack Development'}"
    STATS: ${JSON.stringify(skillSnapshot || {})}
    
    INSTRUCTIONS:
    1. Create a 3-Phase Roadmap.
    2. **QUANTITY:** MINIMUM 5-8 QUESTIONS/STEPS PER TASK. (Mandatory).
    3. **IF DEVELOPMENT (Web/App/ML):**
       - Break it down: Concept -> Task -> Implementation.
       - Use "Platform" field to indicate "Concept", "Doc Read", or "Code Task".
    4. **IF DSA:**
       - Provide standard LeetCode/CodeForces problems (5-8 per task).
    
    Output STRICT JSON.
    `;
    
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: ROADMAP_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      // USING 70B MODEL FOR BETTER LOGIC/STRUCTURE
      model: 'llama-3.3-70b-versatile', 
      temperature: 0.2,
      max_tokens: 8000,
      response_format: { type: 'json_object' }
    });
    
    let rawResponse = completion.choices[0].message.content;
    const firstOpen = rawResponse.indexOf('{');
    const lastClose = rawResponse.lastIndexOf('}');
    if (firstOpen !== -1 && lastClose !== -1) {
        rawResponse = rawResponse.substring(firstOpen, lastClose + 1);
    }

    const roadmap = JSON.parse(rawResponse);
    const id = `roadmap_${Date.now()}`;
    
    await db.collection('UserRoadmaps').doc(userId).collection('roadmaps').doc(id).set({
      id, userId, roadmap, createdAt: new Date().toISOString(), completedQuestions: []
    });
    
    res.json({ success: true, roadmap: { id, ...roadmap } });
  } catch (e) {
    console.error("Roadmap Gen Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/roadmap/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const roadmapId = req.body.roadmapId || req.query.roadmapId;
    if (!roadmapId) return res.status(400).json({ error: 'Missing roadmapId' });
    
    await db.collection('UserRoadmaps').doc(userId).collection('roadmaps').doc(roadmapId).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/roadmap/:userId/progress', async (req, res) => {
  try {
    const { userId } = req.params;
    const { roadmapId, completedQuestions } = req.body;
    if (!roadmapId) return res.status(400).json({ error: 'Missing data' });
    
    await db.collection('UserRoadmaps').doc(userId).collection('roadmaps').doc(roadmapId)
      .update({ completedQuestions });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Jobs Route ---
app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await fetchJobs();
    res.json({ success: true, jobs });
  } catch (e) {
    res.status(500).json({ error: e.message, jobs: [] });
  }
});

// --- AI Interview Route ---
app.post('/api/interview-practice', async (req, res) => {
  try {
    const { language } = req.body;
    if (!language || typeof language !== 'string') {
        return res.status(400).json({ error: 'Language is required' });
    }

    const prompt = `Generate 20 multiple-choice interview questions for "${language}".
    Difficulty: Mixed (Junior to Senior).
    CRITICAL: Output STRICT JSON only. No markdown.
    
    JSON Format:
    {
      "questions": [
        {
          "id": 1,
          "question": "Question text?",
          "options": ["Option A Text", "Option B Text", "Option C Text", "Option D Text"],
          "correctAnswer": "Option B Text", 
          "explanation": "Explanation here."
        }
      ]
    }
    IMPORTANT: "correctAnswer" MUST be the EXACT string from the "options" array. Do NOT use "A", "B", "C", or "D".`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'You are a technical interviewer. Output JSON only.' },
        { role: 'user', content: prompt }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    const data = JSON.parse(completion.choices[0].message.content);
    res.json({ success: true, questions: data.questions });

  } catch (error) {
    console.error('AI Gen Error:', error.message);
    res.status(500).json({ error: 'Failed to generate questions' });
  }
});

// --- FINAL MIDDLEWARE ---
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

app.use((err, req, res, next) => {
  console.error('[Error]:', err);
  res.status(500).json({ error: 'Internal Error' });
});

// --- START SERVER ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log(` SERVER RUNNING ON PORT ${PORT}`);
});
