/**
 * monitor.js
 * Playwright-based watcher that scrapes cards from a page and posts new ones to a Discord webhook.
 * - Supports RUN_ONCE=true for one-shot runs (useful for GitHub Actions).
 * - If GITHUB_TOKEN and GITHUB_REPOSITORY are present, it will load/save seen.json
 *   from/to the repository via the GitHub Contents API so state persists between runs.
 *
 * This file uses plain Playwright with init scripts to reduce automation fingerprinting.
 * It also includes a fallback that attempts to fetch the site's JSON/XHR endpoints
 * (including Next.js /_next/data/* JSON pages and /api/* endpoints) so the scraper
 * can run from CI without proxies when possible.
 *
 * Requires: axios, dotenv, playwright
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { chromium } = require('playwright');

dotenv.config();

const CONFIG = {
  TARGET_URL: process.env.TARGET_URL || 'https://ugcleaks.vercel.app/leaks',
  POLL_INTERVAL_SECONDS: Number(process.env.POLL_INTERVAL_SECONDS || 30),
  CARD_SELECTOR: process.env.CARD_SELECTOR || '',
  TITLE_SELECTOR: process.env.TITLE_SELECTOR || '',
  LINK_SELECTOR: process.env.LINK_SELECTOR || '',
  TIMESTAMP_SELECTOR: process.env.TIMESTAMP_SELECTOR || '',
  SEEN_STORE: process.env.SEEN_STORE || 'seen.json',
  WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  ROLE_ID_UPCOMING: process.env.ROLE_ID_UPCOMING || '1531464694869786675',
  COLORS: {
    upcoming: Number(process.env.COLOR_UPCOMING || 3447003),
    paid: Number(process.env.COLOR_PAID || 16766720),
    regular: Number(process.env.COLOR_REGULAR || 3066993),
    abandoned: Number(process.env.COLOR_ABANDONED || 10038562),
    active: Number(process.env.COLOR_ACTIVE || 15277667),
  },
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || null, // owner/repo
  DEBUG: (process.env.DEBUG || '').toLowerCase() === 'true',
  USER_AGENT: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ACCEPT_LANGUAGE: process.env.ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
};

if (!CONFIG.WEBHOOK_URL) {
  console.error('ERROR: DISCORD_WEBHOOK_URL not set in environment.');
  process.exit(1);
}

// Helper: GitHub Contents API helpers for seen.json persistence
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

// Local filesystem fallback
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

// Unified load/save functions
async function loadSeen() {
  if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) {
    return await loadSeenGithub();
  } else {
    return loadSeenLocal();
  }
}
async function saveSeen(store, previousSha) {
  if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) {
    return await saveSeenGithub(store, previousSha);
  } else {
    saveSeenLocal(store);
    return null;
  }
}

// Build ID, embed, and post to Discord
function idFromCard(card) {
  if (card.link) return card.link;
  return (card.title || '').trim().toLowerCase();
}
function buildWebhookPayload(card) {
  const category = (card.category || 'regular').toLowerCase();
  const color = CONFIG.COLORS[category] || CONFIG.COLORS.regular;
  const mention = CONFIG.ROLE_ID_UPCOMING ? `<@&${CONFIG.ROLE_ID_UPCOMING}>` : '';
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
  if (card.limit) embed.fields.push({ name: 'Limit', value: String(card.limit), inline: true });
  if (card.info) embed.fields.push({ name: 'Info', value: String(card.info).slice(0, 1024) });
  if (card.image) embed.image = { url: card.image };
  return {
    content: mention,
    embeds: [embed],
    allowed_mentions: { roles: mention ? [CONFIG.ROLE_ID_UPCOMING] : [] },
  };
}
async function postToDiscord(payload) {
  try {
    await axios.post(CONFIG.WEBHOOK_URL, payload);
    console.log('Posted to webhook:', payload.embeds?.[0]?.title);
  } catch (err) {
    console.error('Webhook post failed:', err.response?.status, err.response?.data || err.message);
  }
}

// Jitter helper: randomized delay to mimic human timing (1-3s default)
function jitterDelay(minMs = 1000, maxMs = 3000) {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  return new Promise(r => setTimeout(r, ms));
}

// Make browser with sane launch args
async function makeBrowser() {
  return await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-extensions',
    ],
  });
}

// Debug helpers
async function saveDebugArtifacts(page) {
  if (!CONFIG.DEBUG) return;
  try {
    await page.screenshot({ path: 'debug.png', fullPage: true });
    fs.writeFileSync('debug.html', await page.content());
    console.log('Saved debug.png and debug.html');
  } catch (e) {
    console.warn('Debug artifact save failed:', e?.message || e);
  }
}

// Attempt to click an "Upcoming" tab/button if present (helps surface specific listings)
async function tryClickUpcomingTab(page) {
  try {
    const handle = await page.evaluateHandle(() => {
      const nodes = Array.from(document.querySelectorAll('button, a'));
      for (const el of nodes) {
        const text = (el.innerText || '').trim();
        if (/\bupcoming\b/i.test(text)) return el;
      }
      return null;
    });
    if (handle) {
      try { await handle.asElement().click(); } catch {}
      await page.waitForTimeout(1200 + Math.floor(Math.random() * 2000));
      return true;
    }
  } catch (e) {
    console.warn('Upcoming tab click failed:', e?.message || e);
  }
  return false;
}

// Parse one card's innerText (labels and values are on separate lines)
function parseCard(text, imgSrc) {
  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const valueAfter = (label) => {
    const i = lines.findIndex(l => new RegExp(label, 'i').test(l) && l.length < 20);
    return i >= 0 ? (lines[i + 1] || '') : '';
  };
  const title = lines[0] || '';
  const creator = (lines.find(l => /^by\s/i.test(l)) || '').replace(/^by\s+/i, '');
  const method = valueAfter('method');
  const stock = valueAfter('stock');
  const limit = valueAfter('limit');
  const release = valueAfter('release');
  const infoIdx = lines.findIndex(l => /\binfo\b/i.test(l) && l.length < 20);
  const info = infoIdx >= 0
    ? lines.slice(infoIdx + 1).filter(l => !/click for details/i.test(l)).join(' ')
    : '';
  // Cards can share a name, so the ID mixes in creator, details and the image URL
  const id = [title, creator, method, limit, release, imgSrc || '', info].join('|').toLowerCase();
  return { id, title, link: '', timestamp: release, stock, method, limit, info, category: '', description: creator ? `by ${creator}` : '', image: '' };
}

async function collectCardsFromPage(page) {
  const SEL = CONFIG.CARD_SELECTOR || '';
  if (SEL) {
    try {
      const els = await page.$$(SEL);
      if (els.length > 0) {
        const cards = await page.$$eval(SEL, (els, cfg) => {
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
        }, { title: CONFIG.TITLE_SELECTOR, link: CONFIG.LINK_SELECTOR, timestamp: CONFIG.TIMESTAMP_SELECTOR }).catch(() => []);
        return cards;
      }
    } catch (e) {
      console.warn('Primary selector extraction failed:', e.message || e);
    }
  }
  return [];
}

// Heuristic fallback (keeps your original DOM heuristics)
async function heuristicDetect(page) {
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
      let title = el.querySelector('h2,h3,h1')?.innerText?.trim?.() || el.querySelector('strong')?.innerText?.trim?.() || (el.innerText||'').trim().split('\n').map(s=>s.trim()).find(s=>s.length>0) || '';
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
  return cards;
}

// Attempt to discover JSON/XHR endpoints from the loaded page and fetch them
async function fetchLeadsFromApi(page) {
  try {
    // Discover candidate URLs from scripts / inline JS
    const candidates = await page.evaluate(() => {
      const txts = [];
      for (const s of Array.from(document.scripts)) {
        if (s.src) txts.push(s.src);
        if (s.innerText) txts.push(s.innerText.slice(0, 3000));
      }
      // also scan inline HTML for links
      txts.push(document.documentElement.innerHTML.slice(0, 10000));
      const joined = txts.join('\n');
      const urls = new Set();
      const reNext = /\/_next\/data\/[^"'\s]+\.json/g;
      const reApi = /\/api\/[A-Za-z0-9_\-\/\.\?=&%]+/g;
      const m1 = joined.match(reNext) || [];
      const m2 = joined.match(reApi) || [];
      m1.concat(m2).forEach(u=>urls.add(u));
      return Array.from(urls);
    }).catch(() => []);

    const pageUrl = page.url();
    const origin = (new URL(pageUrl)).origin;

    // Build absolute URLs and add some common guesses
    const abs = [];
    for (const u of candidates) {
      try { abs.push(u.startsWith('http') ? u : new URL(u, pageUrl).href); } catch(e){}
    }
    // add likely endpoints relative to origin/path
    abs.push(new URL('/api/leaks', origin).href);
    abs.push(new URL('/api/v1/leaks', origin).href);
    abs.push(new URL('/leaks.json', origin).href);
    abs.push(new URL(pageUrl + '.json', origin).href);

    const uniq = [...new Set(abs)];
    if (!uniq.length) return [];

    const headers = {
      'User-Agent': CONFIG.USER_AGENT,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': CONFIG.ACCEPT_LANGUAGE,
      'Referer': CONFIG.TARGET_URL,
    };

    for (const url of uniq) {
      try {
        const res = await axios.get(url, { headers, timeout: 10000 });
        if (res.status === 200 && res.data) {
          const data = res.data;
          // try to find an array of items
          let items = null;
          if (Array.isArray(data)) items = data;
          else if (Array.isArray(data.items)) items = data.items;
          else if (Array.isArray(data.data)) items = data.data;
          else {
            const findArray = (obj) => {
              if (!obj || typeof obj !== 'object') return null;
              for (const k of Object.keys(obj)) {
                const val = obj[k];
                if (Array.isArray(val) && val.length && typeof val[0] === 'object') return val;
                if (typeof val === 'object') {
                  const nested = findArray(val);
                  if (nested) return nested;
                }
              }
              return null;
            };
            items = findArray(data);
          }
          if (items && items.length) {
            const cards = items.map(it => ({
              title: (it.title || it.name || it.heading || it.label || '').toString(),
              link: it.url || it.link || (it.path ? `${origin}${it.path}` : ''),
              timestamp: it.release || it.date || it.timestamp || it.time || '',
              stock: it.stock || it.inventory || '',
              method: it.method || it.type || '',
              info: it.info || it.description || it.desc || '',
              image: it.image || it.img || it.thumbnail || it.cover || '',
              category: it.category || it.tags || '',
            })).filter(c => c.title);
            if (cards.length) {
              console.log('API fallback succeeded fetching', url, '->', cards.length, 'items');
              return cards;
            }
          }
        } else {
          // non-200 helpful for debugging
          // console.log('API', url, 'returned', res.status);
        }
      } catch (err) {
        // ignore individual failures, log in debug
        if (CONFIG.DEBUG) console.warn('API fetch failed for', url, err?.message || err);
      }
    }
  } catch (e) {
    if (CONFIG.DEBUG) console.warn('API discovery failed', e?.message || e);
  }
  return [];
}

// Scraping flow with stealthy context, retry loop for challenges, and jitter
async function scrapeOnce(browser) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: CONFIG.USER_AGENT,
    locale: CONFIG.ACCEPT_LANGUAGE.split(',')[0] || 'en-US',
  });

  await context.setExtraHTTPHeaders({
    'accept-language': CONFIG.ACCEPT_LANGUAGE,
    'referer': CONFIG.TARGET_URL,
  });

  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] }); } catch (e) {}
    try { Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] }); } catch (e) {}
    try { window.chrome = window.chrome || { runtime: {} }; } catch (e) {}
    try {
      const orig = navigator.permissions && navigator.permissions.query;
      if (orig) {
        navigator.permissions.query = (parameters) => {
          if (parameters && parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission });
          }
          return orig(parameters);
        };
      }
    } catch (e) {}
  });

  const page = await context.newPage();

  page.on('response', async (res) => {
    try {
      const status = res.status();
      if (status >= 400) {
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        let bodyPreview = '';
        if (ct.includes('json') || ct.includes('text') || ct.includes('html')) {
          bodyPreview = (await res.text().catch(() => '')).slice(0, 300);
        }
        console.warn('HTTP', status, res.url(), bodyPreview ? `BODY_PREVIEW: ${bodyPreview}` : '');
      }
    } catch (e) { /* ignore */ }
  });

  await page.goto(CONFIG.TARGET_URL, { waitUntil: 'domcontentloaded' }).catch(() => null);

  const start = Date.now();
  const timeout = 10000; // 10s
  let challengeCleared = false;
  while (Date.now() - start < timeout) {
    await jitterDelay(500, 1200);
    const title = await page.title().catch(() => '');
    const bodyText = (await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')).toString();
    const markerRegex = /\b(just a moment|checking your browser|access denied|verify|captcha|attention required)\b/i;
    if (!markerRegex.test(title) && !markerRegex.test(bodyText)) { challengeCleared = true; break; }
  }
  if (!challengeCleared) {
    console.warn('Challenge/verification may still be present after timeout; continuing to attempt parsing (may be blocked).');
  } else if (CONFIG.DEBUG) {
    console.log('Challenge cleared — proceeding to parse DOM.');
  }

  await jitterDelay(1000, 3000);

  // Try configured selector first
  let cards = await collectCardsFromPage(page);

  // If no cards found, attempt to click Upcoming tab and re-collect
  if (!cards.length) {
    const clicked = await tryClickUpcomingTab(page);
    if (clicked) {
      await jitterDelay(1000, 2500);
      cards = await collectCardsFromPage(page);
    }
  }

  // Heuristic fallback
  if (!cards.length) {
    console.log('No exact card selector or no matches — using heuristic detector.');
    cards = await heuristicDetect(page);
  }

  // API fallback: try to discover and fetch JSON endpoints (works well for Vercel/Next.js sites)
  if (!cards.length) {
    const apiCards = await fetchLeadsFromApi(page);
    if (apiCards && apiCards.length) cards = apiCards;
  }

  if (CONFIG.DEBUG) await saveDebugArtifacts(page);

  await page.close();
  await context.close();

  return cards;
}

async function runOnceFlow(browser, seenState) {
  const items = await scrapeOnce(browser);
  if (!items.length) { console.log('No cards found on the page.'); return; }
  const newItems = [];
  for (const card of items) {
    const id = idFromCard(card);
    if (!seenState.store.seen.includes(id)) {
      newItems.push(card);
      seenState.store.seen.push(id);
    }
  }
  const needsSeed = process.env.SEED_ONLY === 'true' || seenState.store.version !== 2;
  if (needsSeed) {
    seenState.store.version = 2;
    console.log('Seeding: marking', newItems.length, 'card(s) as seen without posting (', seenState.store.seen.length, 'total ).');
    const sha = await saveSeen(seenState.store, seenState.sha);
    if (sha) seenState.sha = sha;
    else if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) console.error('WARNING: seeding could not be saved to GitHub.');
    return;
  }
  if (newItems.length) {
    console.log('Found', newItems.length, 'new item(s). Posting...');
    for (const it of newItems) {
      const payload = buildWebhookPayload(it);
      await postToDiscord(payload);
      await new Promise(r => setTimeout(r, 750));
    }
    const newSha = await saveSeen(seenState.store, seenState.sha);
    if (newSha) {
      seenState.sha = newSha;
    } else if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) {
      console.error('WARNING: seen.json failed to persist to GitHub — next run will likely repost these items.');
    }
  } else {
    console.log('No new items.');
  }
}

async function runLoopMode() {
  const browser = await makeBrowser();
  try {
    while (true) {
      try {
        const seenState = await loadSeen();
        console.log('Checking', CONFIG.TARGET_URL, 'at', new Date().toISOString());
        await runOnceFlow(browser, seenState);
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
  const browser = await makeBrowser();
  try {
    const seenState = await loadSeen();
    console.log('One-shot: Checking', CONFIG.TARGET_URL, 'at', new Date().toISOString());
    await runOnceFlow(browser, seenState);
  } finally {
    await browser.close();
  }
}

// Entrypoint
(async () => {
  const runOnceEnv = (process.env.RUN_ONCE || '').toLowerCase() === 'true';
  if (runOnceEnv) {
    await runOnceMode();
    process.exit(0);
  } else {
    await runLoopMode();
  }
})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
