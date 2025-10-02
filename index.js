// index.js - m3u8 scraper + submit/get endpoints (hardcore + mixto)
// Requisitos en package.json: "type":"module", deps: express, puppeteer-core, @sparticuz/chromium

import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 10000;

// ----------------- CONFIG -----------------
const NAV_TIMEOUT = 60000;      // ms for page.goto
const TOTAL_WAIT = 90000;       // ms total sniffing wait
const CLICK_ROUNDS = 12;        // attempts to click
const CLICK_DELAY = 2500;       // ms between clicks
const AFTER_CLICK_WAIT = 2000;  // wait after click

// Temp store for mixto flow
const TEMP_STORE = new Map();
const DEFAULT_TTL = 90 * 1000; // ms (90s default) - ajuste según necesites

function makeKey() {
  return crypto.randomBytes(12).toString("hex");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Middleware para JSON en /submit
app.use(express.json({ limit: "16kb" }));

// ----------------- BASIC ROUTES -----------------
app.get("/", (req, res) => {
  res.send("✅ m3u8-scraper API. Endpoints: GET /scrape?url=..., POST /submit, GET /get?key=...");
});

// ----------------- MIXED FLOW: submit / get -----------------
app.post("/submit", (req, res) => {
  try {
    const { m3u8, referer } = req.body || {};
    if (!m3u8 || typeof m3u8 !== "string") {
      return res.status(400).json({ success: false, error: "Missing m3u8" });
    }
    const key = makeKey();
    const expiresAt = Date.now() + DEFAULT_TTL;
    TEMP_STORE.set(key, { m3u8, referer: referer || null, expiresAt });
    // Auto-delete after TTL
    setTimeout(() => TEMP_STORE.delete(key), DEFAULT_TTL + 2000);
    console.log(`[SUBMIT] key=${key} stored for ${DEFAULT_TTL/1000}s (referer=${referer || 'n/a'})`);
    return res.json({ success: true, key, expires_in: Math.floor(DEFAULT_TTL/1000) });
  } catch (err) {
    console.error("submit error:", err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.get("/get", (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ success: false, error: "Missing key" });
    const item = TEMP_STORE.get(key);
    if (!item) return res.status(404).json({ success: false, error: "Key not found or expired" });
    // delete on read to avoid reuse
    TEMP_STORE.delete(key);
    console.log(`[GET] key=${key} served (referer=${item.referer || 'n/a'})`);
    return res.json({ success: true, m3u8: item.m3u8, referer: item.referer });
  } catch (err) {
    console.error("get error:", err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// ----------------- HARDCORE SCRAPER: /scrape -----------------
app.get("/scrape", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ success: false, error: "Falta parámetro ?url=" });

  let browser = null;
  let page = null;
  const found = new Set();
  let responded = false;

  try {
    console.log(`[SCRAPE] Starting scrape for: ${targetUrl}`);

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    // 1) CDP listeners to not lose requests
    const client = await page.target().createCDPSession();
    await client.send("Network.enable");

    client.on("Network.requestWillBeSent", (ev) => {
      try {
        const url = ev?.request?.url;
        if (url && url.includes(".m3u8")) {
          found.add(url);
          console.log("[CDP] requestWillBeSent", url);
        }
      } catch (e) {}
    });

    client.on("Network.responseReceived", (ev) => {
      try {
        const url = ev?.response?.url;
        if (url && url.includes(".m3u8")) {
          found.add(url);
          console.log("[CDP] responseReceived", url);
        }
      } catch (e) {}
    });

    // 2) request interception (shouldInterceptRequest-like)
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      try {
        const url = r.url();
        if (url && url.includes(".m3u8")) {
          found.add(url);
          console.log("[REQ] intercepted", url);
        }
      } catch (e) {}
      try { r.continue(); } catch (e) { try { r.continue(); } catch(_){} }
    });

    // 3) inject sniffer JS before any script runs (like PlayerActivity)
    await page.evaluateOnNewDocument(() => {
      function safeReport(u) {
        try {
          if (!u) return;
          const s = (typeof u === "string") ? u : (u && u.url ? u.url : "");
          if (s && s.indexOf(".m3u8") !== -1) {
            try { window.__FOUND_M3U8__ = window.__FOUND_M3U8__ || []; window.__FOUND_M3U8__.push(s); } catch (e) {}
            try { console.log("FOUND_M3U8_INJECT:" + s); } catch (e) {}
          }
        } catch (e) {}
      }
      (function(open) {
        XMLHttpRequest.prototype.open = function(method, url) {
          try { safeReport(url); } catch (e) {}
          return open.apply(this, arguments);
        };
      })(XMLHttpRequest.prototype.open);
      (function(fetchOrig) {
        window.fetch = function(input, init) {
          try {
            const u = (typeof input === "string") ? input : (input && input.url ? input.url : null);
            safeReport(u);
          } catch (e) {}
          return fetchOrig.apply(this, arguments);
        };
      })(window.fetch);
      // inline HTML scan
      try {
        const html = document.documentElement.innerHTML || "";
        const m = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
        if (m && m[0]) safeReport(m[0]);
      } catch (e) {}
    });

    // 4) also listen console logs
    page.on("console", (msg) => {
      try {
        const text = msg.text();
        if (text && text.includes("FOUND_M3U8_INJECT:")) {
          const u = text.split("FOUND_M3U8_INJECT:")[1];
          if (u) {
            found.add(u.trim());
            console.log("[CONSOLE] injected sniffer found", u.trim());
          }
        }
      } catch (e) {}
    });

    // 5) also listen request/response node-side (extra)
    page.on("request", req => {
      try {
        const u = req.url();
        if (u && u.includes(".m3u8")) {
          found.add(u);
          console.log("[PAGE REQUEST] " + u);
        }
      } catch (e) {}
    });
    page.on("response", resp => {
      try {
        const u = resp.url();
        if (u && u.includes(".m3u8")) {
          found.add(u);
          console.log("[PAGE RESPONSE] " + u);
        }
      } catch (e) {}
    });

    // 6) navigate
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await sleep(1200);

    // helper to inject sniffer into existing frames (best-effort)
    async function injectToFrames() {
      const frames = page.frames();
      for (const frame of frames) {
        try {
          // try to evaluate inside frame; cross-origin frames will throw and be skipped
          await frame.evaluate(() => {
            function safeReport(u) {
              try {
                if (!u) return;
                const s = (typeof u === "string") ? u : (u && u.url ? u.url : "");
                if (s && s.indexOf(".m3u8") !== -1) {
                  try { window.__FOUND_M3U8__ = window.__FOUND_M3U8__ || []; window.__FOUND_M3U8__.push(s); } catch (e) {}
                }
              } catch (e) {}
            }
            try {
              const open = XMLHttpRequest.prototype.open;
              XMLHttpRequest.prototype.open = function(method, url) {
                try { safeReport(url); } catch (e) {}
                return open.apply(this, arguments);
              };
            } catch (e) {}
            try {
              const origFetch = window.fetch;
              window.fetch = function(input, init) {
                try {
                  const u = (typeof input === "string") ? input : (input && input.url ? input.url : null);
                  safeReport(u);
                } catch (e) {}
                return origFetch.apply(this, arguments);
              };
            } catch (e) {}
          }).catch(()=>{});
        } catch (e) {}
      }
    }

    await injectToFrames().catch(()=>{});

    // 7) click loops + frame clicks + close popups
    const clickStart = Date.now();
    for (let round = 0; round < CLICK_ROUNDS && (Date.now() - clickStart) < (TOTAL_WAIT/2) && found.size === 0; round++) {
      try {
        const vp = page.viewport() || { width: 1280, height: 720 };
        await page.mouse.click(Math.floor(vp.width/2), Math.floor(vp.height/2), { delay: 100 }).catch(()=>{});
      } catch (e) {}

      // click common selectors inside frames
      const frames = page.frames();
      for (const frame of frames) {
        try {
          const selectors = [
            'button.vjs-big-play-button',' .vjs-big-play-button',' .jw-icon-play',' .jw-button-color.jw-icon-playback',
            'button.play','.play-button','[aria-label="Play"]','button[title*="Play"]','video'
          ];
          for (const sel of selectors) {
            try {
              const el = await frame.$(sel);
              if (el) {
                try { await el.click({ delay: 80 }); } catch {}
                await sleep(300);
              }
            } catch (e) {}
          }
        } catch (e) {}
      }

      // close popups (additional pages)
      try {
        const pages = await browser.pages();
        if (pages.length > 1) {
          for (let i = pages.length - 1; i > 0; i--) {
            try { await pages[i].close(); } catch (e) {}
          }
        }
      } catch (e) {}

      await injectToFrames().catch(()=>{});
      await sleep(CLICK_DELAY);
    }

    // 8) final wait loop reading window.__FOUND_M3U8__ on page and frames
    const sniffStart = Date.now();
    while ((Date.now() - sniffStart) < TOTAL_WAIT && found.size === 0) {
      try {
        const pageFound = await page.evaluate(() => {
          try { return window.__FOUND_M3U8__ || null; } catch (e) { return null; }
        }).catch(()=>null);
        if (Array.isArray(pageFound)) pageFound.forEach(u => u && u.includes(".m3u8") && found.add(u));
      } catch (e) {}

      // check frames
      try {
        const frames = page.frames();
        for (const frame of frames) {
          try {
            const ff = await frame.evaluate(() => {
              try { return window.__FOUND_M3U8__ || null; } catch (e) { return null; }
            }).catch(()=>null);
            if (Array.isArray(ff)) ff.forEach(u => u && u.includes(".m3u8") && found.add(u));
          } catch (e) {}
        }
      } catch (e) {}

      if (found.size > 0) break;
      await sleep(500);
    }

    // 9) fallback: scan frame HTML for inline m3u8 strings
    if (found.size === 0) {
      try {
        const frames = page.frames();
        for (const frame of frames) {
          try {
            const html = await frame.content().catch(()=>null);
            if (html) {
              const m = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
              if (m && m[0]) found.add(m[0]);
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    const result = Array.from(found);
    if (result.length > 0) {
      responded = true;
      console.log(`[SCRAPE] Found ${result.length} m3u8(s). Returning first ones.`);
      return res.json({ success: true, m3u8s: result });
    } else {
      responded = true;
      console.log("[SCRAPE] No m3u8 found for", targetUrl);
      return res.json({ success: false, error: "No se encontró ningún .m3u8 en la página" });
    }
  } catch (err) {
    console.error("Scraper error:", err);
    if (!responded) return res.status(500).json({ success: false, error: String(err.message || err) });
  } finally {
    try { if (page && !page.isClosed && typeof page.close === "function") await page.close(); } catch(e){}
    try { if (browser) await browser.close(); } catch(e){}
  }
});

// ----------------- START -----------------
app.listen(PORT, () => {
  console.log(`🚀 m3u8-scraper hardcore + submit/get listo en puerto ${PORT}`);
});
