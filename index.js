// index.js (hardcore m3u8 sniffer)
import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
const PORT = process.env.PORT || 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get("/scrape", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ success: false, error: "Falta parámetro ?url=" });

  // Configurables
  const NAV_TIMEOUT = 60000;      // tiempo para goto
  const TOTAL_WAIT = 90000;       // tiempo máximo total de sniffing (ms)
  const CLICK_ROUNDS = 12;        // intentos de click
  const CLICK_DELAY = 2500;       // ms entre clicks
  const AFTER_CLICK_WAIT = 2000;  // espera tras click

  let browser = null;
  let page = null;
  const found = new Set();
  let responded = false;

  try {
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

    // ---------- 1) CDP Network listener (no perder requests) ----------
    const client = await page.target().createCDPSession();
    await client.send("Network.enable");

    client.on("Network.requestWillBeSent", (ev) => {
      try {
        const url = ev?.request?.url;
        if (url && url.includes(".m3u8")) found.add(url);
      } catch (e) {}
    });

    client.on("Network.responseReceived", (ev) => {
      try {
        const url = ev?.response?.url;
        if (url && url.includes(".m3u8")) found.add(url);
      } catch (e) {}
    });

    // ---------- 2) request interception (equiv. shouldInterceptRequest) ----------
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      try {
        const url = r.url();
        if (url && url.includes(".m3u8")) found.add(url);
      } catch (e) {}
      // siempre continuar (no bloquear)
      try { r.continue(); } catch (e) { try { r.continue(); } catch (er){} }
    });

    // ---------- 3) Inyectar sniffer JS ANTES de cualquier script (igual al PlayerActivity) ----------
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

      // buscar en el HTML inline inicial
      try {
        const html = document.documentElement.innerHTML || "";
        const m = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
        if (m && m[0]) safeReport(m[0]);
      } catch (e) {}
    });

    // ---------- 4) También escuchar console logs por si el sniffer loguea ----------
    page.on("console", (msg) => {
      try {
        const text = msg.text();
        if (text && text.includes("FOUND_M3U8_INJECT:")) {
          const u = text.split("FOUND_M3U8_INJECT:")[1];
          if (u) found.add(u.trim());
        }
      } catch (e) {}
    });

    // ---------- 5) Navegar a la página ----------
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

    // pequeña espera para que scripts base empiecen
    await sleep(1200);

    // Si hay iframes, inyectar sniffer en cada frame ya existente
    async function injectToFrames() {
      const frames = page.frames();
      for (const frame of frames) {
        try {
          // ejecutar en frame context (no rompe si cross-origin; atrapamos errores)
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

    // ---------- 6) Click loops + frame clicks + cerrar popups ----------
    const startClicks = Date.now();
    for (let round = 0; round < CLICK_ROUNDS && (Date.now() - startClicks) < (TOTAL_WAIT/2) && found.size === 0; round++) {
      try {
        // click center viewport
        const vp = page.viewport() || { width: 1280, height: 720 };
        await page.mouse.click(Math.floor(vp.width/2), Math.floor(vp.height/2), { delay: 100 }).catch(()=>{});
      } catch (e) {}

      // try clicking common selectors inside frames
      const frames = page.frames();
      for (const frame of frames) {
        try {
          // selectors comunes
          const selectors = [
            'button.vjs-big-play-button',
            '.vjs-big-play-button',
            '.jw-icon-play',
            '.jw-button-color.jw-icon-playback',
            'button.play',
            '.play-button',
            '[aria-label="Play"]',
            'button[title*="Play"]',
            'video'
          ];
          for (const sel of selectors) {
            try {
              const el = await frame.$(sel);
              if (el) {
                try { await el.click({ delay: 80 }); } catch (e) {}
                await sleep(300);
              }
            } catch (e) {}
          }
        } catch (e) {}
      }

      // cerrar popups si aparecen
      try {
        const pages = await browser.pages();
        if (pages.length > 1) {
          for (let i = pages.length - 1; i > 0; i--) {
            try { await pages[i].close(); } catch (e) {}
          }
        }
      } catch (e) {}

      // inyectar a frames de nuevo (por si se añadieron nuevos)
      await injectToFrames().catch(()=>{});
      await sleep(CLICK_DELAY);
    }

    // ---------- 7) Espera total para sniffing (lectura de window.__FOUND_M3U8__ también) ----------
    const start = Date.now();
    while ((Date.now() - start) < TOTAL_WAIT && found.size === 0) {
      // chequear sniffer variables dentro de page y frames
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

    // ---------- 8) fallback: scan HTML of frames/pages for inline m3u8 strings ----------
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
      return res.json({ success: true, m3u8s: result });
    } else {
      responded = true;
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

app.listen(PORT, () => {
  console.log(`🚀 m3u8-scraper hardcore listo en puerto ${PORT}`);
});
