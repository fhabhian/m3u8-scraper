import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ API funcionando. Usa /scrape?url=...");
});

app.get("/scrape", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.json({ error: "Falta parámetro ?url=" });

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    let m3u8Found = null;

    // Exponer función al navegador
    await page.exposeFunction("reportStream", (url) => {
      if (url.includes(".m3u8") && !m3u8Found) {
        m3u8Found = url;
      }
    });

    // Inyectar sniffer antes de cargar la página
    await page.evaluateOnNewDocument(() => {
      function report(u) {
        if (u && u.indexOf(".m3u8") !== -1) {
          window.reportStream(u);
        }
      }
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) {
        try { report(u); } catch {}
        return origOpen.apply(this, arguments);
      };
      const origFetch = window.fetch;
      window.fetch = function (...args) {
        try {
          const u = typeof args[0] === "string" ? args[0] : args[0].url;
          report(u);
        } catch {}
        return origFetch.apply(this, args);
      };
    });

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Esperar hasta 30s que aparezca un m3u8
    const maxWait = 30000;
    const start = Date.now();
    while (!m3u8Found && Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 500));
    }

    if (m3u8Found) {
      res.json({ success: true, m3u8: m3u8Found });
    } else {
      res.json({ error: "No se encontró ningún .m3u8 en la página" });
    }

  } catch (err) {
    res.json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => console.log("Servidor corriendo en puerto", PORT));
