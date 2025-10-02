// index.js
import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
const PORT = process.env.PORT || 3000;

// Helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.get("/", (req, res) => {
  res.send("✅ m3u8-scraper API. Usa /scrape?url=...");
});

app.get("/scrape", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: "Falta parámetro ?url=" });

  let browser;
  let page;
  const found = new Set();

  // Timeouts/config
  const NAV_TIMEOUT = 60000;      // 60s navegación
  const TOTAL_WAIT = 30000;       // 30s espera total para sniffing
  const CLICK_ROUNDS = 6;         // número de intentos de click
  const CLICK_DELAY = 2000;       // ms entre clicks

  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote"
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    // Exponer función para que el sniffer en la página nos reporte
    await page.exposeFunction("reportM3u8ToNode", (u) => {
      try {
        if (typeof u === "string" && u.includes(".m3u8")) {
          found.add(u);
        }
      } catch (e) { /* ignore */ }
    });

    // Inyectar sniffer ANTES de que se ejecute cualquier script en la página
    await page.evaluateOnNewDocument(() => {
      function safeReport(u) {
        try {
          if (u && u.indexOf && u.indexOf(".m3u8") !== -1) {
            if (window.reportM3u8ToNode) {
              window.reportM3u8ToNode(u).catch(()=>{});
            }
          }
        } catch (e) {}
      }

      // Overwrite XMLHttpRequest.open
      (function(open) {
        XMLHttpRequest.prototype.open = function(method, url) {
          try { safeReport(url); } catch (e) {}
          return open.apply(this, arguments);
        };
      })(XMLHttpRequest.prototype.open);

      // Overwrite fetch
      (function(fetchOrig) {
        window.fetch = function(input, init) {
          try {
            const u = (typeof input === "string") ? input : (input && input.url ? input.url : null);
            safeReport(u);
          } catch (e) {}
          return fetchOrig.apply(this, arguments);
        };
      })(window.fetch);

      // Parse inline HTML for m3u8 strings too (best-effort)
      try {
        const html = document.documentElement.innerHTML || "";
        const m = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
        if (m && m[0]) safeReport(m[0]);
      } catch (e) {}
    });

    // También escuchamos requests/responses desde Node (doble capa)
    page.on("request", req => {
      try {
        const url = req.url();
        if (url && url.includes(".m3u8")) found.add(url);
      } catch (e) {}
    });

    page.on("response", async (resp) => {
      try {
        const url = resp.url();
        if (url && url.includes(".m3u8")) found.add(url);
      } catch (e) {}
    });

    // Navegar a la URL
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

    // Espera corta inicial para que cargue JS base
    await sleep(2000);

    // Intentos de click para forzar play si es necesario (click en centro y en frames)
    for (let round = 0; round < CLICK_ROUNDS && found.size === 0; round++) {
      // 1) click en el centro de la viewport
      try {
        const viewport = page.viewport();
        const cx = Math.floor((viewport?.width || 800) / 2);
        const cy = Math.floor((viewport?.height || 600) / 2);
        await page.mouse.click(cx, cy, { delay: 100 });
      } catch (e) {}

      // 2) intentar buscar botones de play dentro de frames y clickearlos
      try {
        const frames = page.frames();
        for (const frame of frames) {
          if (!frame) continue;
          try {
            // selectores comunes de botones play en distintos reproductores
            const selectors = [
              'button.vjs-big-play-button',
              '.vjs-big-play-button',
              '.jw-icon-play',
              '.jw-button-color.jw-icon-playback',
              'button.play',
              '.play-button',
              '[aria-label="Play"]',
              'button[title*="Play"]'
            ];
            for (const sel of selectors) {
              const btn = await frame.$(sel);
              if (btn) {
                await btn.click({ delay: 100 }).catch(()=>{});
                await sleep(500);
                break;
              }
            }
            // click genérico en el centro del frame
            const box = await frame.evaluate(() => {
              const el = document.querySelector('video, .player, .play, button.vjs-big-play-button');
              if (el) {
                const r = el.getBoundingClientRect();
                return { x: r.left + r.width/2, y: r.top + r.height/2 };
              }
              return null;
            });
            if (box) {
              // coords are relative to viewport; use page.mouse
              await page.mouse.click(Math.floor(box.x), Math.floor(box.y), { delay: 100 }).catch(()=>{});
            }
          } catch (e) {}
        }
      } catch (e) {}

      // 3) si han aparecido nuevas páginas (popups), ciérralas
      try {
        const pages = await browser.pages();
        if (pages.length > 1) {
          // cerramos pestañas adicionales (normalmente los popups están al final)
          for (let i = pages.length - 1; i > 0; i--) {
            try {
              await pages[i].close();
            } catch (e) {}
          }
        }
      } catch (e) {}

      // small wait before next round
      await sleep(CLICK_DELAY);
    }

    // Después de los clicks, esperamos un tiempo para que salgan requests
    const start = Date.now();
    while (Date.now() - start < TOTAL_WAIT && found.size === 0) {
      await sleep(500);
    }

    // Si no encontró nada en toda la espera, intentamos revisar frames con evaluate (HTML)
    if (found.size === 0) {
      try {
        const frames = page.frames();
        for (const frame of frames) {
          try {
            const html = await frame.content();
            const m = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
            if (m && m[0]) found.add(m[0]);
          } catch (e) {}
        }
      } catch (e) {}
    }

    // Preparar respuesta
    const arr = Array.from(found);
    if (arr.length > 0) {
      // Responder con todos los m3u8 encontrados (normalmente el primero es la real)
      return res.json({ success: true, m3u8s: arr });
    } else {
      return res.json({ success: false, error: "No se encontró ningún .m3u8 en la página" });
    }

  } catch (err) {
    console.error("Error scraper:", err);
    return res.status(500).json({ error: String(err.message || err) });
  } finally {
    try { if (page && !page.isClosed && typeof page.close === "function") await page.close(); } catch(e){}
    try { if (browser) await browser.close(); } catch (e){}
  }
});

app.listen(PORT, () => {
  console.log(`🚀 m3u8 scraper listo en puerto ${PORT}`);
});
