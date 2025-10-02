import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/scrape", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.json({ success: false, error: "Falta el parámetro ?url=" });
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // Array para guardar .m3u8 encontrados
    let foundM3u8 = null;

    // --------- 1. Intercepta TODAS las requests (imitando shouldInterceptRequest) ---------
    await page.setRequestInterception(true);
    page.on("request", (reqIntercept) => {
      const url = reqIntercept.url();
      if (url.includes(".m3u8") && !foundM3u8) {
        foundM3u8 = url;
        console.log("📡 Capturado por request interception:", url);
      }
      reqIntercept.continue();
    });

    // --------- 2. Sniffer JS inyectado (como en tu PlayerActivity) ---------
    await page.evaluateOnNewDocument(() => {
      const sendUrl = (url) => {
        if (url.includes(".m3u8")) {
          window.__FOUND_STREAM__ = url;
          console.log("📡 Sniffer detectó:", url);
        }
      };

      // Hook XMLHttpRequest
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (...args) {
        this.addEventListener("load", () => sendUrl(args[1]));
        return open.apply(this, args);
      };

      // Hook fetch
      const origFetch = window.fetch;
      window.fetch = async (...args) => {
        sendUrl(args[0]);
        return origFetch.apply(this, args);
      };
    });

    // --------- 3. Carga página ---------
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // --------- 4. Simula un click para saltar publicidad / arrancar player ---------
    try {
      await page.mouse.click(200, 200); // click genérico
      console.log("👆 Click simulado en la página");
    } catch (e) {
      console.log("⚠️ No se pudo simular click:", e.message);
    }

    // --------- 5. Espera hasta 60 segundos a que aparezca el .m3u8 ---------
    const start = Date.now();
    while (!foundM3u8 && Date.now() - start < 60000) {
      await new Promise((r) => setTimeout(r, 2000));
      // Revisa si el sniffer interno lo detectó
      const snifferUrl = await page.evaluate(() => window.__FOUND_STREAM__);
      if (snifferUrl && !foundM3u8) {
        foundM3u8 = snifferUrl;
        console.log("📡 Capturado por sniffer injectado:", snifferUrl);
      }
    }

    if (!foundM3u8) {
      return res.json({ success: false, error: "No se encontró ningún .m3u8 en la página" });
    }

    res.json({ success: true, m3u8: foundM3u8 });
  } catch (err) {
    console.error("❌ Error en scrape:", err);
    res.json({ success: false, error: err.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
