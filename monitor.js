/*
 * monitor.js
 * Full-history mode with retries/auto-scroll support and improved timestamp-first detection.
 * Safety change: if DISCORD_WEBHOOK_URL is not provided, the script will no longer exit with code 1.
 * Instead, posting is disabled and the scraper will continue to fetch/save data so the workflow does not fail silently.
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
  FETCH_STORE: process.env.FETCH_STORE || 'fetched.json',
  ARCHIVE_STORE: process.env.ARCHIVE_STORE || 'archive.json',
  WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
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
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || null,
  MIN_FRESHNESS_MINUTES: Number(process.env.MIN_FRESHNESS_MINUTES || 0),
  KEEP_HISTORY: Number(process.env.KEEP_HISTORY || 2000), // max archive items
  SCRAPE_ATTEMPTS: Number(process.env.SCRAPE_ATTEMPTS || 5),
  SCRAPE_ATTEMPT_DELAY_MS: Number(process.env.SCRAPE_ATTEMPT_DELAY_MS || 3000),
  CLICK_SELECTOR: process.env.CATEGORY_BUTTON_SELECTOR || process.env.CLICK_SELECTOR || '',
};

// If webhook not set, don't exit — disable posting but continue scraping & persisting so workflow won't fail.
let POST_ENABLED = true;
if (!CONFIG.WEBHOOK_URL) {
  console.warn('WARNING: DISCORD_WEBHOOK_URL not set — posting disabled. The scraper will still run and save fetched/archive/seen but will not POST to webhook.');
  POST_ENABLED = false;
}

const GITHUB_API = axios.create({
  baseURL: 'https://api.github.com',
  timeout: 15000,
  headers: CONFIG.GITHUB_TOKEN ? { Authorization: `token ${CONFIG.GITHUB_TOKEN}`, 'User-Agent': 'ugc-watcher' } : undefined,
});

// Helpers for generic file loads/saves via GitHub Contents API
async function loadFileGithub(filename, defaultObj) {
  try {
    const url = `/repos/${CONFIG.GITHUB_REPOSITORY}/contents/${encodeURIComponent(filename)}`;
    const res = await GITHUB_API.get(url);
    const content = Buffer.from(res.data.content, 'base64').toString('utf8');
    return { obj: JSON.parse(content), sha: res.data.sha };
  } catch (err) {
    if (err.response && err.response.status === 404) return { obj: defaultObj, sha: null };
    console.warn(`GitHub load ${filename} failed:`, err.message || err.toString());
    return { obj: defaultObj, sha: null };
  }
}

async function saveFileGithub(filename, obj, previousSha, commitMessage) {
  try {
    const url = `/repos/${CONFIG.GITHUB_REPOSITORY}/contents/${encodeURIComponent(filename)}`;
    const contentBase64 = Buffer.from(JSON.stringify(obj, null, 2), 'utf8').toString('base64');
    const payload = { message: commitMessage || `Update ${filename} by ugc-watcher`, content: contentBase64 };
    if (previousSha) payload.sha = previousSha;
    const res = await GITHUB_API.put(url, payload);
    return res.data.content.sha;
  } catch (err) {
    console.error(`GitHub save ${filename} failed:`, err.response?.status, err.response?.data || err.message);
    return null;
  }
}

function loadFileLocal(filename, defaultObj) { try { const raw = fs.readFileSync(filename, 'utf8'); return { obj: JSON.parse(raw), sha: null }; } catch (e) { return { obj: defaultObj, sha: null }; } }
function saveFileLocal(filename, obj) { fs.writeFileSync(filename, JSON.stringify(obj, null, 2)); }
async function loadJson(filename, defaultObj) { if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) return await loadFileGithub(filename, defaultObj); return loadFileLocal(filename, defaultObj); }
async function saveJson(filename, obj, previousSha, commitMessage) { if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) return await saveFileGithub(filename, obj, previousSha, commitMessage); saveFileLocal(filename, obj); return null; }
async function loadSeen() { const def = { seen: [], last_top: null }; return await loadJson(CONFIG.SEEN_STORE, def); }
async function saveSeen(store, previousSha) { return await saveJson(CONFIG.SEEN_STORE, store, previousSha, 'Update seen.json by ugc-watcher'); }
async function loadFetched() { const def = { fetched: [], scraped_at: null }; return await loadJson(CONFIG.FETCH_STORE, def); }
async function saveFetched(obj, previousSha) { return await saveJson(CONFIG.FETCH_STORE, obj, previousSha, 'Update fetched.json by ugc-watcher'); }
async function loadArchive() { const def = { archive: [] }; return await loadJson(CONFIG.ARCHIVE_STORE, def); }
async function saveArchive(obj, previousSha) { return await saveJson(CONFIG.ARCHIVE_STORE, obj, previousSha, 'Append archive.json by ugc-watcher'); }

function idFromCard(card) { if (card.link) return card.link; return `${card.title}###${card.timestamp || ''}`; }
function buildWebhookPayload(card) { const category = (card.category || 'regular').toLowerCase(); const roleId = CONFIG.ROLE_IDS[category] || null; const color = CONFIG.COLORS[category] || CONFIG.COLORS.regular; const mention = roleId ? `<@&${roleId}>` : ''; const embed = { title: card.title || 'UGC Item', url: card.link || undefined, description: card.description || '', color, fields: [], timestamp: new Date().toISOString(), }; if (card.timestamp) embed.fields.push({ name: 'Release / Time', value: String(card.timestamp), inline: true }); if (card.method) embed.fields.push({ name: 'Method', value: String(card.method), inline: true }); if (card.stock) embed.fields.push({ name: 'Stock', value: String(card.stock), inline: true }); if (card.info) embed.fields.push({ name: 'Info', value: String(card.info).slice(0, 1024) }); if (card.image) embed.image = { url: card.image }; return { content: mention, embeds: [embed] }; }
async function postToDiscord(payload) { if (!POST_ENABLED) { console.log('Posting disabled — webhook not configured. Skipping post for:', payload.embeds?.[0]?.title); return; } try { await axios.post(CONFIG.WEBHOOK_URL, payload); console.log('Posted to webhook:', payload.embeds?.[0]?.title); } catch (err) { console.error('Webhook post failed:', err.response?.status, err.response?.data || err.message); } }

function parseTimestampToMillis(tsText) { if (!tsText) return 0; const s = String(tsText).trim(); const relMatchFull = s.match(/in\s*((?:\d+\s*d)?\s*(?:\d+\s*h)?\s*(?:\d+\s*m)?\s*(?:\d+\s*s)?)/i); if (relMatchFull) { const rel = relMatchFull[1]; const regex = /(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i; const m = rel.match(regex); if (m) { const days = parseInt(m[1] || '0', 10); const hours = parseInt(m[2] || '0', 10); const mins = parseInt(m[3] || '0', 10); const secs = parseInt(m[4] || '0', 10); const delta = (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000; if (delta > 0) return Date.now() + delta; } } const parsed = Date.parse(s); if (!isNaN(parsed)) return parsed; const cleaned = s.replace(/(release[:]?|at\s+|on\s+|pm|am)/ig, '').trim(); const parsed2 = Date.parse(cleaned); if (!isNaN(parsed2)) return parsed2; const rel2 = s.match(/(\d+\s*d|\d+\s*h|\d+\s*m|\d+\s*s)/ig); if (rel2) { let days=0,hours=0,mins=0,secs=0; rel2.forEach(part => { if (part.toLowerCase().includes('d')) days += parseInt(part); else if (part.toLowerCase().includes('h')) hours += parseInt(part); else if (part.toLowerCase().includes('m')) mins += parseInt(part); else if (part.toLowerCase().includes('s')) secs += parseInt(part); }); const delta = (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000; if (delta>0) return Date.now()+delta; } const isoMatch = s.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:?\d{0,2}Z?/); if (isoMatch) { const p = Date.parse(isoMatch[0]); if (!isNaN(p)) return p; } return 0; }

// SCRAPE WITH RETRIES, CLICK, AND SCROLL + improved timestamp-first detection
async function scrapeOnce(browser) {
  const page = await browser.newPage();
  await page.goto(CONFIG.TARGET_URL, { waitUntil: 'networkidle' }).catch(() => page.waitForLoadState('domcontentloaded'));

  // Helper that performs the extraction on the page (uses CARD_SELECTOR if present else heuristic)
  async function extract() {
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
          return cards;
        }
      } catch (e) {
        console.warn('Primary selector extraction failed inside extract():', e.message || e);
      }
    }

    // heuristic extraction with timestamp-first candidate addition
    const cards = await page.evaluate(() => {
      const keywords = ['STOCK','METHOD','RELEASE','INFO','LIMIT','CLICK FOR DETAILS','RELEASE DATE','RELEASE:','CODE DROP'];

      const candidateSet = new Set();

      // 1) Timestamp-first: find nodes that contain relative time patterns like "in 2m", "2m 49s", etc.
      const relRegex = /(?:\bin\s*)?\d+\s*(?:d|h|m|s)\b/i;
      try {
        const all = Array.from(document.querySelectorAll('body *'));
        for (const n of all) {
          try {
            const txt = (n.innerText || '');
            if (relRegex.test(txt)) {
              // add a nearby ancestor that looks card-like
              let ancestor = n;
              for (let i=0; i<6 && ancestor && ancestor.tagName !== 'BODY'; i++) {
                const imgs = ancestor.querySelectorAll('img').length;
                const links = ancestor.querySelectorAll('a').length;
                const headings = ancestor.querySelectorAll('h1,h2,h3').length;
                const textLen = (ancestor.innerText || '').length;
                if ((imgs + links + headings) >= 1 && textLen > 20) { candidateSet.add(ancestor); break; }
                ancestor = ancestor.parentElement;
              }
            }
          } catch (e) { }
        }
      } catch (e) { }

      // 2) Keyword-based hits (previous heuristic)
      try {
        const hits = Array.from(document.querySelectorAll('body *')).filter(el => {
          if (!el.offsetParent && el.clientHeight === 0 && el.clientWidth === 0) return false;
          try { const txt=(el.innerText||'').toUpperCase(); return keywords.some(k=>txt.includes(k)); } catch { return false; }
        });
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
      } catch (e) { }

      // 3) fallback: main/section divs
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
        const catNode = Array.from(el.querySelectorAll('*')).find(n => { const t=(n.innerText||'').toLowerCase(); return ['upcoming','active','paid','regular','abandoned'].some(k=>t.includes(k)); });
        if (catNode) category = (catNode.innerText||'').trim().toLowerCase();
        return { title, link, timestamp, stock, method, info, image, category };
      };

      const result = [];
      candidateSet.forEach(el => { try { result.push(makeCard(el)); } catch {} });
      const uniq = []; const seen = new Set();
      for (const c of result) { const key = (c.link||'') + '||' + (c.title||'').slice(0,80); if (!seen.has(key)) { seen.add(key); uniq.push(c); } }
      return uniq;
    });

    return cards;
  }

  // Try multiple attempts with optional click/scroll/wait between
  let lastResult = [];
  for (let attempt = 1; attempt <= CONFIG.SCRAPE_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) console.log(`Scrape attempt ${attempt}/${CONFIG.SCRAPE_ATTEMPTS}...`);

      // optionally click a button that reveals content
      if (CONFIG.CLICK_SELECTOR) {
        try {
          const button = await page.$(CONFIG.CLICK_SELECTOR);
          if (button) {
            console.log('Clicking selector to reveal content:', CONFIG.CLICK_SELECTOR);
            await button.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(400);
          }
        } catch (e) { /* ignore click errors */ }
      }

      const cards = await extract();
      if (cards && cards.length > 0) {
        await page.close();
        return cards;
      }

      // If nothing found, try scrolling to load more and wait
      lastResult = cards || [];
      console.log('No cards found on attempt', attempt, '- scrolling and waiting...');
      await page.evaluate(() => { window.scrollBy(0, window.innerHeight); });
      await page.waitForTimeout(CONFIG.SCRAPE_ATTEMPT_DELAY_MS);

    } catch (err) {
      console.warn('Scrape attempt error:', err?.message || err);
      // small wait and continue
      await page.waitForTimeout(500);
    }
  }

  await page.close();
  return lastResult;
}

async function persistFetchedAndArchive(items, seenState) {
  // annotate items
  const now = Date.now();
  const annotated = items.map(it => ({ id: idFromCard(it), title: it.title || '', link: it.link || '', timestamp_raw: it.timestamp || '', timestamp_parsed: parseTimestampToMillis(it.timestamp) || 0, category: it.category || '', image: it.image || '', method: it.method || '', stock: it.stock || '', info: it.info || '', scraped_at: now }));

  const fetchedState = await loadFetched();
  const fetchedPrev = fetchedState.obj || { fetched: [], scraped_at: null };
  const archiveState = await loadArchive();
  const archivePrev = archiveState.obj || { archive: [] };

  annotated.sort((a,b)=> (b.timestamp_parsed||0) - (a.timestamp_parsed||0));
  const fetchedObj = { fetched: annotated, scraped_at: now };
  const fetchedStrNew = JSON.stringify(fetchedObj, null, 2);
  const fetchedStrPrev = JSON.stringify(fetchedPrev, null, 2);
  if (fetchedStrNew !== fetchedStrPrev) {
    console.log('fetched.json changed — saving updated fetched list.');
    const newSha = await saveFetched(fetchedObj, fetchedState.sha);
    if (newSha) console.log('Saved fetched.json (sha:', newSha, ')');
  } else {
    console.log('fetched.json unchanged — not committing.');
  }

  const existingArchiveIds = new Set((archivePrev.archive||[]).map(a=>a.id));
  const seenIds = new Set(seenState.store.seen || []);
  const toAppend = [];
  for (const it of annotated) if (!seenIds.has(it.id) && !existingArchiveIds.has(it.id)) toAppend.push(it);
  if (toAppend.length > 0) {
    console.log('Appending', toAppend.length, 'new item(s) to archive.json');
    const newArchive = (archivePrev.archive||[]).concat(toAppend);
    newArchive.sort((a,b)=> (b.scraped_at||0) - (a.scraped_at||0));
    if (CONFIG.KEEP_HISTORY > 0 && newArchive.length > CONFIG.KEEP_HISTORY) newArchive.length = CONFIG.KEEP_HISTORY;
    const archiveObj = { archive: newArchive };
    const newSha = await saveArchive(archiveObj, archiveState.sha);
    if (newSha) console.log('Saved archive.json (sha:', newSha, ')');
  } else {
    console.log('No new archive items to append.');
  }
}

async function processFlow(browser, seenState) {
  const items = await scrapeOnce(browser);
  if (!items || items.length === 0) { console.log('No items found on page.'); return false; }
  await persistFetchedAndArchive(items, seenState);
  items.forEach(it => it._ts = parseTimestampToMillis(it.timestamp) || 0);
  items.sort((a,b)=> (b._ts||0) - (a._ts||0));
  const newest = items[0];
  const newestId = idFromCard(newest);
  const now = Date.now();

  if ((process.env.RUN_SEED || '').toLowerCase() === 'true') {
    console.log('RUN_SEED=true: seeding seen.json with current fetched items (no posts).');
    for (const it of items) { const id = idFromCard(it); if (!seenState.store.seen.includes(id)) seenState.store.seen.push(id); }
    seenState.store.last_top = idFromCard(items[0]);
    await saveSeen(seenState.store, seenState.sha);
    return false;
  }

  if (CONFIG.MIN_FRESHNESS_MINUTES > 0 && (newest._ts || 0) > 0) {
    const threshold = now - CONFIG.MIN_FRESHNESS_MINUTES * 60 * 1000;
    if ((newest._ts || 0) < threshold) { console.log(`Newest item timestamp older than MIN_FRESHNESS_MINUTES=${CONFIG.MIN_FRESHNESS_MINUTES}. Skipping.`); seenState.store.last_top = idFromCard(items[0]); await saveSeen(seenState.store, seenState.sha); return false; }
  }

  if (!seenState.store.seen.includes(newestId) && (newest._ts || 0) > 0) {
    console.log('Posting newest unseen item by timestamp:', newest.title || newest.link || '(no title)');
    await postToDiscord(buildWebhookPayload(newest));
    seenState.store.seen.push(newestId);
    seenState.store.last_top = idFromCard(items[0]);
    await saveSeen(seenState.store, seenState.sha);
    return true;
  }

  const topItem = items[0];
  const topId = idFromCard(topItem);
  if (seenState.store.last_top !== topId) {
    console.log('Top-card changed (fallback). Previous top:', seenState.store.last_top, 'New top:', topId);
    if (!seenState.store.seen.includes(topId)) { console.log('Posting new top card (fallback):', topItem.title || topItem.link || '(no title)'); await postToDiscord(buildWebhookPayload(topItem)); seenState.store.seen.push(topId); } else { console.log('Top card has changed but was already in seen list. Updating last_top only.'); }
    seenState.store.last_top = topId;
    await saveSeen(seenState.store, seenState.sha);
    return true;
  }

  console.log('No new items to post. Newest by ts:', newest.title || '(no title)');
  return false;
}

async function runLoopMode() { const browser = await chromium.launch({ headless: true }); try { while (true) { try { const seenState = await loadSeen(); console.log('Checking', CONFIG.TARGET_URL, 'at', new Date().toISOString()); await processFlow(browser, seenState); } catch (err) { console.error('Loop error:', err?.message || err); } await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_SECONDS * 1000)); } } finally { await browser.close(); } }
async function runOnceMode() { const browser = await chromium.launch({ headless: true }); try { const seenState = await loadSeen(); console.log('One-shot: Checking', CONFIG.TARGET_URL, 'at', new Date().toISOString()); await processFlow(browser, seenState); } finally { await browser.close(); } }

(async () => { const runOnceEnv = (process.env.RUN_ONCE || '').toLowerCase() === 'true'; if (runOnceEnv) { await runOnceMode(); process.exit(0); } else { await runLoopMode(); } })();

