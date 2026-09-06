/*
 * monitor.js
 * Updated: only post the newest item on each scrape (by parsed timestamp),
 * and ensure role pings work by providing fallback role IDs if env vars are missing.
 * Keeps one-shot vs loop behavior and GitHub persistence.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { chromium } = require('playwright');

dotenv.config();

const CONFIG = {
  TARGET_URL: process.env.TARGET_URL || 'https://ugcleaks.short-term.workers.dev/leaks',
  POLL_INTERVAL_SECONDS: Number(process.env.POLL_INTERVAL_SECONDS || 30),
  CARD_SELECTOR: process.env.CARD_SELECTOR || '',
  TITLE_SELECTOR: process.env.TITLE_SELECTOR || '',
  LINK_SELECTOR: process.env.LINK_SELECTOR || '',
  TIMESTAMP_SELECTOR: process.env.TIMESTAMP_SELECTOR || '',
  SEEN_STORE: process.env.SEEN_STORE || 'seen.json',
  WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  // Fallback role IDs - these are used if corresponding env vars are not set
  ROLE_IDS: {
    upcoming: process.env.ROLE_ID_UPCOMING || '1545880166683906118',
    paid: process.env.ROLE_ID_PAID || '1545880048567984188',
    regular: process.env.ROLE_ID_REGULAR || '1545881749064646777',
    abandoned: process.env.ROLE_ID_ABANDONED || '1545880971415527504',
    active: process.env.ROLE_ID_ACTIVE || '1545881407656558612',
  },
  COLORS: {
    upcoming: Number(process.env.COLOR_UPCOMING || 3447003),
    paid: Number(process.env.COLOR_PAID || 16766720),
    regular: Number(process.env.COLOR_REGULAR || 3066993),
    abandoned: Number(process.env.COLOR_ABANDONED || 10038562),
    active: Number(process.env.COLOR_ACTIVE || 15277667),
  },
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || null, // owner/repo
};

if (!CONFIG.WEBHOOK_URL) {
  console.error('ERROR: DISCORD_WEBHOOK_URL not set in environment.');
  process.exit(1);
}

const GITHUB_API = axios.create({
  baseURL: 'https://api.github.com',
  timeout: 15000,
  headers: CONFIG.GITHUB_TOKEN ? { Authorization: `token ${CONFIG.GITHUB_TOKEN}`, 'User-Agent': 'ugc-watcher' } : undefined,
});

async function loadSeenGithub() {
  try {
    const url = `/repos/${CONFIG.GITHUB_REPOSITORY}/contents/${encodeURIComponent(CONFIG.SEEN_STORE)}`;
    const res = await GITHUB_API.get(url);
    const content = Buffer.from(res.data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    return { store: parsed, sha: res.data.sha };
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return { store: { seen: [] }, sha: null };
    }
    console.warn('GitHub load seen failed:', err.message || err.toString());
    return { store: { seen: [] }, sha: null };
  }
}

async function saveSeenGithub(store, previousSha) {
  try {
    const url = `/repos/${CONFIG.GITHUB_REPOSITORY}/contents/${encodeURIComponent(CONFIG.SEEN_STORE)}`;
    const contentBase64 = Buffer.from(JSON.stringify(store, null, 2), 'utf8').toString('base64');
    const payload = {
      message: 'Update seen.json by ugc-watcher',
      content: contentBase64,
    };
    if (previousSha) payload.sha = previousSha;
    const res = await GITHUB_API.put(url, payload);
    return res.data.content.sha;
  } catch (err) {
    console.error('GitHub save seen failed:', err.response?.status, err.response?.data || err.message);
    return null;
  }
}

function loadSeenLocal() {
  try {
    const raw = fs.readFileSync(CONFIG.SEEN_STORE, 'utf8');
    return { store: JSON.parse(raw), sha: null };
  } catch (e) {
    return { store: { seen: [] }, sha: null };
  }
}
function saveSeenLocal(store) {
  fs.writeFileSync(CONFIG.SEEN_STORE, JSON.stringify(store, null, 2));
}

async function loadSeen() {
  if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) return await loadSeenGithub();
  return loadSeenLocal();
}
async function saveSeen(store, previousSha) {
  if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) return await saveSeenGithub(store, previousSha);
  saveSeenLocal(store);
  return null;
}

function idFromCard(card) {
  if (card.link) return card.link;
  return `${card.title}###${card.timestamp || ''}`;
}

function buildWebhookPayload(card) {
  const category = (card.category || 'regular').toLowerCase();
  const roleId = CONFIG.ROLE_IDS[category] || null;
  const color = CONFIG.COLORS[category] || CONFIG.COLORS.regular;
  const mention = roleId ? `<@&${roleId}>` : '';

  const embed = {
    title: card.title || 'UGC Item',
    url: card.link || undefined,
    description: card.description || '',
    color,
    fields: [],
    timestamp: new Date().toISOString(),
  };
  if (card.timestamp) embed.fields.push({ name: 'Release / Time', value: String(card.timestamp), inline: true });
  if (card.method) embed.fields.push({ name: 'Method', value: String(card.method), inline: true });
  if (card.stock) embed.fields.push({ name: 'Stock', value: String(card.stock), inline: true });
  if (card.info) embed.fields.push({ name: 'Info', value: String(card.info).slice(0, 1024) });
  if (card.image) embed.image = { url: card.image };

  return { content: mention, embeds: [embed] };
}

async function postToDiscord(payload) {
  try {
    await axios.post(CONFIG.WEBHOOK_URL, payload);
    console.log('Posted to webhook:', payload.embeds?.[0]?.title);
  } catch (err) {
    console.error('Webhook post failed:', err.response?.status, err.response?.data || err.message);
  }
}

// Parse timestamp strings to milliseconds since epoch. Supports absolute dates and relative 'in Xd Xh Xm' formats.
function parseTimestampToMillis(tsText) {
  if (!tsText) return 0;
  const s = String(tsText).trim();
  // Try direct Date parse
  const parsed = Date.parse(s);
  if (!isNaN(parsed)) return parsed;

  // Normalize: remove words like 'release', 'at', 'on', 'time', etc.
  const cleaned = s.replace(/release[:]?/i, '').replace(/at /i, '').replace(/on /i, '').trim();
  const parsed2 = Date.parse(cleaned);
  if (!isNaN(parsed2)) return parsed2;

  // Relative formats: 'in 6d 4h 37m', '6d 4h', '19h 32m 50s', 'in 19h 37m 11s'
  const rel = cleaned.toLowerCase().replace(/^in\s+/, '');
  const regex = /(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i;
  const m = rel.match(regex);
  if (m) {
    const days = parseInt(m[1] || '0', 10);
    const hours = parseInt(m[2] || '0', 10);
    const mins = parseInt(m[3] || '0', 10);
    const secs = parseInt(m[4] || '0', 10);
    const delta = (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
    if (delta > 0) {
      return Date.now() + delta;
    }
  }

  // Fallback: try to extract an ISO-like substring
  const isoMatch = s.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:?\d{0,2}Z?/);
  if (isoMatch) {
    const p = Date.parse(isoMatch[0]);
    if (!isNaN(p)) return p;
  }

  // Couldn't parse - return 0 so it will be treated as old
  return 0;
}

// Scraping heuristics (same as before)
async function scrapeOnce(browser) {
  const page = await browser.newPage();
  await page.goto(CONFIG.TARGET_URL, { waitUntil: 'networkidle' }).catch(() => page.waitForLoadState('domcontentloaded'));

  if (CONFIG.CARD_SELECTOR) {
    try {
      const els = await page.$$(CONFIG.CARD_SELECTOR);
      if (els.length > 0) {
        const cards = await page.$$eval(CONFIG.CARD_SELECTOR, (els, cfg) => {
          function pickText(el, sel) { if (!sel) return ''; const node = el.querySelector(sel); return node ? node.innerText.trim() : ''; }
          function pickHref(el, sel) { if (!sel) return ''; const node = el.querySelector(sel); return node ? (node.href || node.getAttribute('href') || '') : ''; }
          function pickImg(el) { const node = el.querySelector('img'); return node ? (node.src || node.getAttribute('data-src') || '') : ''; }
          return els.map(el => ({
            title: pickText(el, cfg.title) || (el.querySelector('h2')?.innerText?.trim?.() || el.querySelector('h3')?.innerText?.trim?.() || ''),
            link: pickHref(el, cfg.link) || Array.from(el.querySelectorAll('a')).map(a=>a.href).find(Boolean) || '',
            timestamp: pickText(el, cfg.timestamp) || '',
            stock: pickText(el, '.stock') || '',
            method: pickText(el, '.method') || '',
            info: pickText(el, '.info') || '',
            image: pickImg(el) || '',
            category: el.getAttribute('data-category') || '',
          }));
        }, { title: CONFIG.TITLE_SELECTOR, link: CONFIG.LINK_SELECTOR, timestamp: CONFIG.TIMESTAMP_SELECTOR });
        await page.close();
        return cards;
      }
    } catch (e) {
      console.warn('Primary selector extraction failed:', e.message || e);
    }
  }

  console.log('No exact card selector or no matches — using heuristic detector.');
  const heuristicKeywords = ['STOCK','METHOD','RELEASE','INFO','LIMIT','CLICK FOR DETAILS','RELEASE DATE','RELEASE:','CODE DROP'];

  const cards = await page.evaluate((keywords) => {
    function hasKeyword(node) { if (!node) return false; const txt=(node.innerText||'').toUpperCase(); return keywords.some(k=>txt.includes(k)); }
    const hits = Array.from(document.querySelectorAll('body *')).filter(el => {
      if (!el.offsetParent && el.clientHeight === 0 && el.clientWidth === 0) return false;
      try { return hasKeyword(el); } catch { return false; }
    });
    const candidateSet = new Set();
    for (const hit of hits) {
      let ancestor = hit;
      for (let i=0; i<6 && ancestor && ancestor.tagName !== 'BODY'; i++) {
        const imgs = ancestor.querySelectorAll('img').length;
        const links = ancestor.querySelectorAll('a').length;
        const headings = ancestor.querySelectorAll('h1,h2,h3').length;
        const textLen = (ancestor.innerText || '').length;
        if ((imgs + links + headings) >= 1 && textLen > 20) { candidateSet.add(ancestor); break; }
        ancestor = ancestor.parentElement;
      }
    }
    if (candidateSet.size === 0) {
      const mainCandidates = Array.from(document.querySelectorAll('main div, section div')).filter(n => {
        const t = (n.innerText||'').length; return t > 100 && n.querySelectorAll('a,img').length >= 1;
      }).slice(0,30);
      mainCandidates.forEach(n => candidateSet.add(n));
    }
    const makeCard = (el) => {
      let title = el.querySelector('h2,h3,h1')?.innerText?.trim?.() || el.querySelector('strong')?.innerText?.trim?.() || (el.innerText||'').trim().split('\n').map(s=>s.trim()).find(s=>s.length>2) || '';
      const anchors = Array.from(el.querySelectorAll('a')).map(a=>a.href).filter(Boolean);
      const link = anchors.find(a=>a.includes('roblox.com')) || anchors.find(a=>a.includes('/leaks/')) || anchors[0] || '';
      const candidateT = Array.from(el.querySelectorAll('*')).find(n => {
        const t=(n.innerText||'').toLowerCase(); return t.includes('release') || t.includes('release date') || /\d{1,2}\s*(d|h|m|s)|\d{1,2}:\d{2}/.test(t);
      });
      const timestamp = candidateT ? candidateT.innerText.trim() : '';
      const stock = Array.from(el.querySelectorAll('*')).find(n=>(n.innerText||'').toUpperCase().includes('STOCK'))?.innerText.trim() || '';
      const method = Array.from(el.querySelectorAll('*')).find(n=>(n.innerText||'').toUpperCase().includes('METHOD'))?.innerText.trim() || '';
      const info = (Array.from(el.querySelectorAll('*')).find(n=>(n.innerText||'').toUpperCase().includes('INFO')) || { innerText: '' }).innerText.trim() || '';
      const img = el.querySelector('img'); const image = img ? (img.src || img.getAttribute('data-src') || '') : '';
      let category = '';
      const catNode = Array.from(el.querySelectorAll('*')).find(n => { const t=(n.innerText||'').toLowerCase(); return ['upcoming','active','paid','regular','abandoned'].some(k=>t.includes(k));});
      if (catNode) category = (catNode.innerText||'').trim().toLowerCase();
      return { title, link, timestamp, stock, method, info, image, category };
    };
    const result = []; candidateSet.forEach(el => { try { result.push(makeCard(el)); } catch {} });
    const uniq = []; const seen = new Set();
    for (const c of result) { const key = (c.link||'') + '||' + (c.title||'').slice(0,80); if (!seen.has(key)) { seen.add(key); uniq.push(c); } }
    return uniq;
  }, heuristicKeywords);

  await page.close();
  return cards;
}

// New behavior: only consider the newest card by parsed timestamp and post it once if unseen
async function processNewestOnly(browser, seenState) {
  const items = await scrapeOnce(browser);
  if (!items || items.length === 0) return false;

  // Compute timestamp for each
  for (const it of items) {
    it._ts = parseTimestampToMillis(it.timestamp);
  }
  // Choose newest by _ts (max). If all ts are 0 (unparsable), fall back to the first item.
  items.sort((a,b) => (b._ts || 0) - (a._ts || 0));
  const newest = items[0];
  const newestId = idFromCard(newest);
  if (seenState.store.seen.includes(newestId)) {
    console.log('Newest item already seen:', newest.title || newest.link || '(no title)');
    return false;
  }

  // Post only the newest item
  console.log('Posting newest unseen item:', newest.title || newest.link || '(no title)');
  const payload = buildWebhookPayload(newest);
  await postToDiscord(payload);
  // mark seen and persist
  seenState.store.seen.push(newestId);
  const newSha = await saveSeen(seenState.store, seenState.sha);
  if (newSha) seenState.sha = newSha;
  return true;
}

async function runLoopMode() {
  const browser = await chromium.launch({ headless: true });
  try {
    while (true) {
      try {
        const seenState = await loadSeen();
        console.log('Checking', CONFIG.TARGET_URL, 'at', new Date().toISOString());
        await processNewestOnly(browser, seenState);
      } catch (err) {
        console.error('Loop error:', err?.message || err);
      }
      await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_SECONDS * 1000));
    }
  } finally {
    await browser.close();
  }
}

async function runOnceMode() {
  const browser = await chromium.launch({ headless: true });
  try {
    const seenState = await loadSeen();
    console.log('One-shot: Checking', CONFIG.TARGET_URL, 'at', new Date().toISOString());
    await processNewestOnly(browser, seenState);
  } finally {
    await browser.close();
  }
}

(async () => {
  const runOnceEnv = (process.env.RUN_ONCE || '').toLowerCase() === 'true';
  if (runOnceEnv) {
    await runOnceMode();
    process.exit(0);
  } else {
    await runLoopMode();
  }
})();
