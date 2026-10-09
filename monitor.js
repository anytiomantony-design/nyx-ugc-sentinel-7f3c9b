/**
 * monitor.js
 * Playwright-based watcher that scrapes cards from a page and posts new ones to a Discord webhook.
 * - Supports RUN_ONCE=true for one-shot runs (useful for GitHub Actions).
 * - If GITHUB_TOKEN and GITHUB_REPOSITORY are present, it will load/save seen.json
 *   from/to the repository via the GitHub Contents API so state persists between runs.
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
  ROLE_ID_UPCOMING: '1531464694869786675',
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

// Scraping: Vercel page is client-rendered; wait for grid/cards to mount before parsing.
async function scrapeOnce(browser) {
  const page = await browser.newPage();
  await page.goto(CONFIG.TARGET_URL, { waitUntil: 'domcontentloaded' }).catch(() => page.waitForLoadState('domcontentloaded'));
  await page.waitForTimeout(5000);

  const selectors = [
    'div[class*="grid-cols"] > div',
    'div[class*="grid"] > div',
  ];

  let cards = [];
  for (const selector of selectors) {
    try {
      const exists = await page.$(selector);
      if (exists) {
        cards = await page.$$eval(selector, (els) => {
          return els
            .map((el) => {
              const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
              if (!text || text.length < 20) return null;

              const lines = (el.innerText || '')
                .split(/\n+/)
                .map((s) => s.trim())
                .filter(Boolean);

              const title = lines[0] || '';
              const stock = lines.find((line) => /stock/i.test(line)) || '';
              const method = lines.find((line) => /method/i.test(line)) || '';
              const release = lines.find((line) => /release/i.test(line)) || '';
              const info = lines.find((line) => /info/i.test(line)) || '';
              const link = Array.from(el.querySelectorAll('a')).map((a) => a.href).find(Boolean) || '';

              return {
                title: title || text.slice(0, 120),
                link,
                timestamp: release || '',
                stock,
                method,
                info,
                category: (el.getAttribute('data-category') || '').toLowerCase() || '',
                description: text,
              };
            })
            .filter(Boolean);
        });
        if (cards.length) {
          await page.close();
          return cards;
        }
      }
    } catch (err) {
      console.warn('Card selector failed:', selector, err?.message || err);
    }
  }

  // Final fallback: if the page still hasn't rendered card nodes, allow a bit more time and try again.
  await page.waitForTimeout(5000);
  for (const selector of selectors) {
    try {
      const exists = await page.$(selector);
      if (exists) {
        cards = await page.$$eval(selector, (els) => {
          return els
            .map((el) => {
              const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
              if (!text || text.length < 20) return null;
              const link = Array.from(el.querySelectorAll('a')).map((a) => a.href).find(Boolean) || '';
              return {
                title: text.split(/\s{2,}/)[0] || text.slice(0, 120),
                link,
                timestamp: '',
                stock: '',
                method: '',
                info: text,
                category: '',
                description: text,
              };
            })
            .filter(Boolean);
        });
        if (cards.length) {
          await page.close();
          return cards;
        }
      }
    } catch {}
  }

  await page.close();
  return [];
}

async function runOnceFlow(browser, seenState) {
  const items = await scrapeOnce(browser);
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
  const browser = await chromium.launch({ headless: true });
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
