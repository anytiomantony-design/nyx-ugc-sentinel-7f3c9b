/**
 * monitor.js (resilient)
 * Playwright-based watcher that scrapes cards from a page and posts new ones to a Discord webhook.
 *
 * This version:
 * - Uses exact CARD_SELECTOR if provided.
 * - FALLS BACK to a heuristic detector that finds elements containing keywords
 *   (STOCK / METHOD / RELEASE / INFO / LIMIT / CLICK FOR DETAILS) and climbs
 *   up the DOM to guess a card container.
 *
 * Tune .env selectors if you want exact matching; fallback will try to work without them.
 */

const fs = require('fs');
const axios = require('axios');
const dotenv = require('dotenv');
const { chromium } = require('playwright');

dotenv.config();

const CONFIG = {
  TARGET_URL: process.env.TARGET_URL || 'https://ugcleaks.short-term.workers.dev/leaks',
  POLL_INTERVAL_SECONDS: Number(process.env.POLL_INTERVAL_SECONDS || 30),
  CATEGORY_BUTTON_SELECTOR: (process.env.CATEGORY_BUTTON_SELECTOR || '').trim() || null,
  CARD_SELECTOR: process.env.CARD_SELECTOR || '',
  TITLE_SELECTOR: process.env.TITLE_SELECTOR || '',
  LINK_SELECTOR: process.env.LINK_SELECTOR || '',
  TIMESTAMP_SELECTOR: process.env.TIMESTAMP_SELECTOR || '',
  SEEN_STORE: process.env.SEEN_STORE || 'seen.json',
  WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  ROLE_IDS: {
    upcoming: process.env.ROLE_ID_UPCOMING,
    paid: process.env.ROLE_ID_PAID,
    regular: process.env.ROLE_ID_REGULAR,
    abandoned: process.env.ROLE_ID_ABANDONED,
    active: process.env.ROLE_ID_ACTIVE,
  },
  COLORS: {
    upcoming: Number(process.env.COLOR_UPCOMING || 3447003),
    paid: Number(process.env.COLOR_PAID || 16766720),
    regular: Number(process.env.COLOR_REGULAR || 3066993),
    abandoned: Number(process.env.COLOR_ABANDONED || 10038562),
    active: Number(process.env.COLOR_ACTIVE || 15277667),
  },
};

if (!CONFIG.WEBHOOK_URL) {
  console.error('ERROR: DISCORD_WEBHOOK_URL not set in environment.');
  process.exit(1);
}

// ---- persistence helpers
function loadSeen() {
  try {
    const raw = fs.readFileSync(CONFIG.SEEN_STORE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { seen: [] };
  }
}
function saveSeen(store) {
  fs.writeFileSync(CONFIG.SEEN_STORE, JSON.stringify(store, null, 2));
}
function idFromCard(card) {
  if (card.link) return card.link;
  return `${card.title}###${card.timestamp || ''}`;
}

// ---- Discord helpers
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

// ---- scraping
async function scrapeOnce(browser) {
  const page = await browser.newPage();
  await page.goto(CONFIG.TARGET_URL, { waitUntil: 'networkidle' }).catch(() => page.waitForLoadState('domcontentloaded'));

  if (CONFIG.CATEGORY_BUTTON_SELECTOR) {
    try {
      const button = await page.$(CONFIG.CATEGORY_BUTTON_SELECTOR);
      if (button) {
        await button.click().catch(() => {});
        await page.waitForTimeout(800);
      }
    } catch (e) {
      console.warn('Category click failed:', e.message || e);
    }
  }

  // Primary attempt: use exact card selector if provided.
  if (CONFIG.CARD_SELECTOR) {
    try {
      const els = await page.$$(CONFIG.CARD_SELECTOR);
      if (els.length > 0) {
        // Extract using CARD_SELECTOR and optional inner selectors if provided; fallback to generic extraction
        const cards = await page.$$eval(CONFIG.CARD_SELECTOR, (els, cfg) => {
          function pickText(el, sel) {
            if (!sel) return '';
            const node = el.querySelector(sel);
            return node ? node.innerText.trim() : '';
          }
          function pickHref(el, sel) {
            if (!sel) return '';
            const node = el.querySelector(sel);
            return node ? (node.href || node.getAttribute('href') || '') : '';
          }
          function pickImg(el) {
            const node = el.querySelector('img');
            return node ? (node.src || node.getAttribute('data-src') || '') : '';
          }
          return els.map(el => {
            return {
              title: pickText(el, cfg.title) || (el.querySelector('h2')?.innerText?.trim && el.querySelector('h2').innerText.trim()) || (el.querySelector('h3')?.innerText?.trim && el.querySelector('h3').innerText.trim()) || '',
              link: pickHref(el, cfg.link) || Array.from(el.querySelectorAll('a')).map(a=>a.href).find(Boolean) || '',
              timestamp: pickText(el, cfg.timestamp) || '',
              stock: pickText(el, '.stock') || '',
              method: pickText(el, '.method') || '',
              info: pickText(el, '.info') || '',
              image: pickImg(el) || '',
              category: el.getAttribute('data-category') || '',
            };
          });
        }, { title: CONFIG.TITLE_SELECTOR, link: CONFIG.LINK_SELECTOR, timestamp: CONFIG.TIMESTAMP_SELECTOR });

        await page.close();
        return cards;
      }
    } catch (e) {
      console.warn('Primary selector extraction failed:', e.message || e);
    }
  }

  // FALLBACK: heuristic detector
  console.log('No exact card selector or no matches — using heuristic detector.');
  const heuristicKeywords = ['STOCK', 'METHOD', 'RELEASE', 'INFO', 'LIMIT', 'CLICK FOR DETAILS', 'RELEASE DATE', 'RELEASE:', 'CODE DROP'];

  const cards = await page.evaluate((keywords) => {
    function textOf(node) {
      return node?.innerText?.trim?.() || '';
    }
    function hasKeyword(node) {
      if (!node) return false;
      const txt = (node.innerText || '').toUpperCase();
      return keywords.some(k => txt.includes(k));
    }

    const hits = Array.from(document.querySelectorAll('body *')).filter(el => {
      if (!el.offsetParent && el.clientHeight === 0 && el.clientWidth === 0) return false;
      try {
        return hasKeyword(el);
      } catch (e) {
        return false;
      }
    });

    const candidateSet = new Set();
    for (const hit of hits) {
      let ancestor = hit;
      for (let i = 0; i < 6 && ancestor && ancestor.tagName !== 'BODY'; i++) {
        const imgs = ancestor.querySelectorAll('img').length;
        const links = ancestor.querySelectorAll('a').length;
        const headings = ancestor.querySelectorAll('h1,h2,h3').length;
        const textLen = (ancestor.innerText || '').length;

        if ((imgs + links + headings) >= 1 && textLen > 20) {
          candidateSet.add(ancestor);
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }

    if (candidateSet.size === 0) {
      const mainCandidates = Array.from(document.querySelectorAll('main div, section div')).filter(n => {
        const t = (n.innerText||'').length;
        return t > 100 && n.querySelectorAll('a,img').length >= 1;
      }).slice(0, 30);
      mainCandidates.forEach(n => candidateSet.add(n));
    }

    const makeCard = (el) => {
      const pick = (selectors) => {
        for (const s of selectors) {
          try {
            const node = el.querySelector(s);
            if (node && (node.innerText || node.href || node.src)) {
              if (node.href) return node.href;
              if (node.src) return node.src;
              if (node.innerText) return node.innerText.trim();
            }
          } catch (e) {}
        }
        return '';
      };

      let title = '';
      const h = el.querySelector('h2,h3,h1');
      if (h && h.innerText) title = h.innerText.trim();
      if (!title) {
        const strong = el.querySelector('strong');
        if (strong && strong.innerText) title = strong.innerText.trim();
      }
      if (!title) {
        const txt = (el.innerText || '').trim();
        if (txt) title = txt.split('\n').map(s=>s.trim()).find(s=>s.length>2) || '';
      }

      const anchors = Array.from(el.querySelectorAll('a')).map(a => a.href).filter(Boolean);
      let link = anchors.find(a => a.includes('roblox.com')) || anchors.find(a => a.includes('/leaks/')) || anchors[0] || '';

      let timestamp = '';
      const candidateT = Array.from(el.querySelectorAll('*')).find(n => {
        const t = (n.innerText || '').toLowerCase();
        return t.includes('release') || t.includes('release date') || t.match(/\d{1,2}\s*(d|h|m|s)|\d{1,2}[:]\d{2}/);
      });
      if (candidateT) timestamp = candidateT.innerText.trim();

      const stock = Array.from(el.querySelectorAll('*')).find(n => (n.innerText||'').toUpperCase().includes('STOCK'))?.innerText.trim() || '';
      const method = Array.from(el.querySelectorAll('*')).find(n => (n.innerText||'').toUpperCase().includes('METHOD'))?.innerText.trim() || '';
      const infoNode = Array.from(el.querySelectorAll('*')).find(n => (n.innerText||'').toUpperCase().includes('INFO')) || null;
      const info = infoNode ? infoNode.innerText.trim() : '';

      const img = el.querySelector('img');
      const image = img ? (img.src || img.getAttribute('data-src') || '') : '';

      let category = '';
      const catNode = Array.from(el.querySelectorAll('*')).find(n => {
        const t=(n.innerText||'').toLowerCase();
        return ['upcoming','active','paid','regular','abandoned'].some(k=>t.includes(k));
      });
      if (catNode) category = (catNode.innerText||'').trim().toLowerCase();

      return { title, link, timestamp, stock, method, info, image, category };
    };

    const result = [];
    candidateSet.forEach(el => {
      try {
        result.push(makeCard(el));
      } catch (e) {}
    });

    const uniq = [];
    const seen = new Set();
    for (const c of result) {
      const key = (c.link || '') + '||' + (c.title || '').slice(0, 80);
      if (!seen.has(key)) {
        seen.add(key);
        uniq.push(c);
      }
    }

    return uniq;
  }, heuristicKeywords);

  await page.close();
  return cards;
}

// ---- main loop
async function runLoop() {
  const seenStore = loadSeen();
  if (!Array.isArray(seenStore.seen)) seenStore.seen = [];
  const browser = await chromium.launch({ headless: true });

  try {
    while (true) {
      try {
        console.log('Checking', CONFIG.TARGET_URL, 'at', new Date().toISOString());
        const items = await scrapeOnce(browser);

        const newItems = [];
        for (const card of items) {
          const id = idFromCard(card);
          if (!seenStore.seen.includes(id)) {
            newItems.push(card);
            seenStore.seen.push(id);
          }
        }

        if (newItems.length) {
          console.log('Found', newItems.length, 'new item(s). Posting...');
          for (const it of newItems) {
            const payload = buildWebhookPayload(it);
            await postToDiscord(payload);
            await new Promise(r => setTimeout(r, 750));
          }
          saveSeen(seenStore);
        } else {
          console.log('No new items.');
        }
      } catch (err) {
        console.error('Loop error:', err?.message || err);
      }
      await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_SECONDS * 1000));
    }
  } finally {
    await browser.close();
  }
}

runLoop().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
