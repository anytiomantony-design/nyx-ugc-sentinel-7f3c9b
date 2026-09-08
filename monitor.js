/**
 * monitor.js
 * Playwright-based watcher that scrapes cards from a page and posts new ones to a Discord webhook.
 *
 * Changes made:
 * - Stable idFromCard that avoids volatile relative timestamps
 * - normalizeAndDedupeCards to prune nested/duplicate heuristic hits
 * - Keep seen state in memory (load once in loop mode) and don't wipe it on transient failures
 *
 * Requires: axios, dotenv, playwright
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const crypto = require('crypto');
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
    upcoming: process.env.ROLE_ID_UPCOMING || null,
    paid: process.env.ROLE_ID_PAID || null,
    regular: process.env.ROLE_ID_REGULAR || null,
    abandoned: process.env.ROLE_ID_ABANDONED || null,
    active: process.env.ROLE_ID_ACTIVE || null,
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
  KEEP_HISTORY: Number(process.env.KEEP_HISTORY || 2000),
  SCRAPE_ATTEMPTS: Number(process.env.SCRAPE_ATTEMPTS || 3),
  SCRAPE_ATTEMPT_DELAY_MS: Number(process.env.SCRAPE_ATTEMPT_DELAY_MS || 2000),
  CLICK_SELECTOR: process.env.CLICK_SELECTOR || '',
};

// Posting is non-fatal: if webhook not set, posting will be skipped but scraper runs.
let POST_ENABLED = true;
if (!CONFIG.WEBHOOK_URL) {
  console.warn('WARNING: DISCORD_WEBHOOK_URL not set — posting disabled. The scraper will still run and save state but will not POST to webhook.');
  POST_ENABLED = false;
}

// GitHub Contents API helper (if configured)
const GITHUB_API = axios.create({
  baseURL: 'https://api.github.com',
  timeout: 15000,
  headers: CONFIG.GITHUB_TOKEN ? { Authorization: `token ${CONFIG.GITHUB_TOKEN}`, 'User-Agent': 'ugc-watcher' } : undefined,
});

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

function loadFileLocal(filename, defaultObj) {
  try {
    const raw = fs.readFileSync(filename, 'utf8');
    return { obj: JSON.parse(raw), sha: null };
  } catch (e) {
    return { obj: defaultObj, sha: null };
  }
}
function saveFileLocal(filename, obj) {
  fs.writeFileSync(filename, JSON.stringify(obj, null, 2));
}

async function loadJson(filename, defaultObj) {
  if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) return await loadFileGithub(filename, defaultObj);
  return loadFileLocal(filename, defaultObj);
}
async function saveJson(filename, obj, previousSha, commitMessage) {
  if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPOSITORY) return await saveFileGithub(filename, obj, previousSha, commitMessage);
  saveFileLocal(filename, obj);
  return null;
}

async function loadSeen() {
  const def = { seen: [], last_top: null };
  const res = await loadJson(CONFIG.SEEN_STORE, def);
  // unify shape: return { store: {...}, sha }
  return { store: res.obj, sha: res.sha };
}
async function saveSeen(store, previousSha) {
  // Returns new sha or null; caller must handle failure (do not wipe memory)
  try {
    return await saveJson(CONFIG.SEEN_STORE, store, previousSha, 'Update seen.json by ugc-watcher');
  } catch (e) {
    console.error('saveSeen failed:', e?.message || e);
    return null;
  }
}

async function loadFetched() { const def = { fetched: [], scraped_at: null }; return await loadJson(CONFIG.FETCH_STORE, def); }
async function saveFetched(obj, previousSha) { return await saveJson(CONFIG.FETCH_STORE, obj, previousSha, 'Update fetched.json by ugc-watcher'); }
async function loadArchive() { const def = { archive: [] }; return await loadJson(CONFIG.ARCHIVE_STORE, def); }
async function saveArchive(obj, previousSha) { return await saveJson(CONFIG.ARCHIVE_STORE, obj, previousSha, 'Append archive.json by ugc-watcher'); }

// Build stable id: prefer link; otherwise hash of title/info/image filename (exclude volatile timestamp)
function idFromCard(card) {
  try {
    if (card.link && String(card.link).trim()) return String(card.link).trim();
    const titlePart = (card.title || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const infoPart = (card.info || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const imagePart = (card.image || '').split('/').pop() || '';
    const base = `${titlePart}||${infoPart}||${imagePart}`;
    const hash = crypto.createHash('sha1').update(base, 'utf8').digest('hex').slice(0, 12);
    return `title:${hash}`;
  } catch (e) {
    return `${card.title || 'no-title'}###${(card.timestamp || '').slice(0,20)}`;
  }
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
  if (!POST_ENABLED) {
    console.log('Posting disabled — skipping post for:', payload.embeds?.[0]?.title);
    return;
  }
  try {
    await axios.post(CONFIG.WEBHOOK_URL, payload);
    console.log('Posted to webhook:', payload.embeds?.[0]?.title);
  } catch (err) {
    console.error('Webhook post failed:', err.response?.status, err.response?.data || err.message);
  }
}

// Node-side normalization & dedupe to collapse nested duplicates from the in-page heuristic
function normalizeAndDedupeCards(cards) {
  const norm = (cards || []).map(c => ({
    title: (c.title || '').trim(),
    link: (c.link || '').trim(),
    timestamp: (c.timestamp || '').trim(),
    info: (c.info || '').trim(),
    image: (c.image || '').trim(),
    method: (c.method || '').trim(),
    stock: (c.stock || '').trim(),
    category: (c.category || '').trim(),
    description: (c.description || '').trim(),
  })).filter(c => c.title || c.link); // drop empty junk

  // Deduplicate by link or stable id
  const seen = new Set();
  const out = [];
  for (const c of norm) {
    const key = c.link || idFromCard(c);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    } else {
      // If we already have it but the new candidate has a link and existing didn't, prefer link
      if (c.link) {
        // replace existing entry if it had no link
        const idx = out.findIndex(x => (x.link || idFromCard(x)) === key);
        if (idx >= 0 && !out[idx].link) out[idx] = c;
      }
    }
  }
  return out;
}

// Scrape with heuristics (unchanged in-page logic), but dedupe on Node side before returning
async function scrapeOnce(browser) {
  const page = await browser.newPage();
  await page.goto(CONFIG.TARGET_URL, { waitUntil: 'networkidle' }).catch(() => page.waitForLoadState('domcontentloaded'));

  // Try exact selector first if provided
  try {
    if (CONFIG.CARD_SELECTOR) {
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
        const normalized = normalizeAndDedupeCards(cards);
        return normalized;
      }
    }
  } catch (e) {
    console.warn('Primary selector extraction failed:', e.message || e);
  }

  // Heuristic fallback (evaluate in page)
  console.log('No exact card selector or no matches — using heuristic detector.');
  const heuristicKeywords = ['STOCK','METHOD','RELEASE','INFO','LIMIT','CLICK FOR DETAILS','RELEASE DATE','RELEASE:','CODE DROP'];

  let cards = [];
  try {
    cards = await page.evaluate((keywords) => {
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
      // Dedupe minimally inside page by title/link slice
      const uniq = []; const seen = new Set();
      for (const c of result) { const key = (c.link||'') + '||' + (c.title||'').slice(0,80); if (!seen.has(key)) { seen.add(key); uniq.push(c); } }
      return uniq;
    }, heuristicKeywords);
  } catch (e) {
    console.warn('Heuristic extraction failed:', e?.message || e);
  }

  await page.close();

  // Node-side normalization and dedupe to collapse nested duplicates
  const normalized = normalizeAndDedupeCards(cards);
  return normalized;
}

// runOnceFlow: posts new items and persists seen (safely)
async function runOnceFlow(browser, seenState) {
  const items = await scrapeOnce(browser);
  if (!items || items.length === 0) {
    console.log('No items found on page.');
    return;
  }

  const newItems = [];
  for (const card of items) {
    const id = idFromCard(card);
    if (!seenState.store.seen.includes(id)) {
      newItems.push(card);
      seenState.store.seen.push(id);
    }
  }

  if (newItems.length) {
    console.log('Found', newItems.length, 'new item(s). Posting...');
    for (const it of newItems) {
      const payload = buildWebhookPayload(it);
      await postToDiscord(payload);
      await new Promise(r => setTimeout(r, 750));
    }
    // persist seen list (do not wipe memory on failure)
    const newSha = await saveSeen(seenState.store, seenState.sha);
    if (newSha) {
      seenState.sha = newSha;
      console.log('Saved seen.json (sha:', newSha, ')');
    } else {
      console.warn('Failed to persist seen.json — keeping in-memory state.');
    }
  } else {
    console.log('No new items to post.');
  }

  // Also persist fetched/archive to help debugging/history (best-effort)
  try {
    await persistFetchedAndArchive(items, seenState);
  } catch (e) {
    console.warn('persistFetchedAndArchive error:', e?.message || e);
  }
}

async function persistFetchedAndArchive(items, seenState) {
  const now = Date.now();
  const annotated = (items || []).map(it => ({
    id: idFromCard(it),
    title: it.title || '',
    link: it.link || '',
    timestamp_raw: it.timestamp || '',
    timestamp_parsed: 0,
    category: it.category || '',
    image: it.image || '',
    method: it.method || '',
    stock: it.stock || '',
    info: it.info || '',
    scraped_at: now
  }));

  const fetchedState = await loadFetched();
  const fetchedPrev = fetchedState.obj || { fetched: [], scraped_at: null };
  const archiveState = await loadArchive();
  const archivePrev = archiveState.obj || { archive: [] };

  // sort by scraped_at
  annotated.sort((a,b)=> (b.scraped_at||0) - (a.scraped_at||0));
  const fetchedObj = { fetched: annotated, scraped_at: now };
  const fetchedStrNew = JSON.stringify(fetchedObj, null, 2);
  const fetchedStrPrev = JSON.stringify(fetchedPrev, null, 2);
  if (fetchedStrNew !== fetchedStrPrev) {
    console.log('fetched.json changed — saving updated fetched list.');
    await saveFetched(fetchedObj, fetchedState.sha);
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
    await saveArchive(archiveObj, archiveState.sha);
  } else {
    console.log('No new archive items to append.');
  }
}

// Loop mode: load seen once and keep it in memory; do not wipe on transient errors
async function runLoopMode() {
  const browser = await chromium.launch({ headless: true });
  try {
    let seenState = await loadSeen();
    if (!seenState || !seenState.store) seenState = { store: { seen: [], last_top: null }, sha: null };

    while (true) {
      try {
        console.log('Checking', CONFIG.TARGET_URL, 'at', new Date().toISOString());
        await runOnceFlow(browser, seenState);
      } catch (err) {
        console.error('Loop error:', err?.message || err);
        // KEEP in-memory seenState intact on errors
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
