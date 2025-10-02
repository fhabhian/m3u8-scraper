// index.js
import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
const PORT = process.env.PORT || 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get("/", (req, res) => {
  res.send("✅ m3u8-scraper API. Usa /scrape?url=...");
});

app.get("/scrape", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: "Falta parámetro ?url=" });

  // Configuración - ajústalas si hace falta
  const NAV_TIMEOUT = 60000;       // tiempo máximo para navigation
  const TOTAL_WAIT = 35000;        // espera total para sniffing después de interacciones
  const CLICK_ROUNDS = 8;          // intentos de click para saltar ads/overlays
  const CLICK_DELAY = 2000;        // ms entre clicks
  const AFTER_CLICK_WAIT = 3000;   // ms a esperar tras cada click

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

    // Exponer a la página una función que el sniffer JS usará para reportar m3u8 a Node
    await page.exposeFunction("reportM3u8ToNode", (u) => {
      try {
        if (u && typeof u === "string" && u.includes(".m3u8")) {
          found.add(u);
        }
      } catch (e) {}
    });

    // Inyectar sniffer AL INICIO (antes de cualquier script de la página)
    await page.evaluateOnNewDocument(() => {
      function safeReport(u) {
        try {
          if (u && u.indexOf && u.indexOf(".m3u8") !== -1) {
            if (window.reportM3u8ToNode) {
              // report to Node (Promise)
              try { window.reportM3u8ToNode(u); } catch (e) {}
            }
            // también logueamos en consola por si queremos capturarlo desde page.on('console')
            try { console.log("FOUND_M3U8_INJECT:" + u); } catch (e) {}
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

      // Buscar en el HTML inicial (inline) por si hay m3u8 incrustado
      try {
        const html = document.documentElement.innerHTML || "";
        const m = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
        if (m && m[0]) safeReport(m[0]);
      } catch (e) {}
    });

    // También escuchamos requests/responses desde Node (doble capa)
    page.on("request", (req) => {
      try {
        const url = req.url();
        if (url && url.includes(".m3u8")) found.add(url);
      } catch (e) {}
    });

    page.on("response", (resp) => {
      try {
        const url = resp.url();
        if (url && url.includes(".m3u8")) found.add(url);
      } catch (e) {}
    });

    // Capturar console logs (por si el sniffer loguea)
    page.on("console", (msg) => {
      try {
        const text = msg.text();
        if (text && text.includes("FOUND_M3U8_INJECT:")) {
          const u = text.split("FOUND_M3U8_INJECT:")[1];
          if (u) found.add(u.trim());
        }
      } catch (e) {}
    });

    // Navegar a la página
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

    // Pequeña espera para que la página empiece a cargar scripts
    await sleep(1800);

    // Intentos de click en la página + en iframes para forzar play
    for (let round = 0; round < CLICK_ROUNDS && found.size === 0; round++) {
      // 1) Click genérico en el centro de la viewport
      try {
        const vp = page.viewport() || { width: 1280, height: 720 };
        const cx = Math.floor((vp.width) / 2);
        const cy = Math.floor((vp.height) / 2);
        await page.mouse.click(cx, cy, { delay: 150 }).catch(()=>{});
      } catch (e) {}

      // 2) Buscar selectores comunes dentro de frames y clickearlos
      try {
        const frames = page.frames();
        for (const frame of frames) {
          if (!frame) continue;
          try {
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
              const el = await frame.$(sel);
              if (el) {
                try { await el.click({ delay: 100 }); } catch (e) {}
                await sleep(400);
              }
            }
          } catch (e) {}
        }
      } catch (e) {}

      // 3) Cerrar popups/pestañas nuevas si aparecen
      try {
        const pages = await browser.pages();
        if (pages.length > 1) {
          for (let i = pages.length - 1; i > 0; i--) {
            try { await pages[i].close(); } catch (e) {}
          }
        }
      } catch (e) {}

      // Esperar un poco para que peticiones de la reproducción aparezcan
      await sleep(AFTER_CLICK_WAIT);
    }

    // Después de interacciones, esperar un tiempo total para sniffing
    const started = Date.now();
    while (Date.now() - started < TOTAL_WAIT && found.size === 0) {
      await sleep(300);
    }

    // Si aún no encontró nada, revisar el contenido de frames (búsqueda en HTML)
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

    const arr = Array.from(found);
    if (arr.length > 0) {
      responded = true;
      return res.json({ success: true, m3u8s: arr });
    } else {
      responded = true;
      return res.json({ success: false, error: "No se encontró ningún .m3u8 en la página" });
    }

  } catch (err) {
    console.error("Error scraper:", err);
    if (!responded) return res.status(500).json({ error: String(err.message || err) });
  } finally {
    try { if (page && !page.isClosed && typeof page.close === "function") await page.close(); } catch(e){}
    try { if (browser) await browser.close(); } catch(e){}
  }
});

app.listen(PORT, () => {
  console.log(`🚀 m3u8 scraper listo en puerto ${PORT}`);
});
