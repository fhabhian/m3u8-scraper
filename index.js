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
  if (!targetUrl) {
    return res.json({ error: "Falta parámetro ?url=" });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);

    let m3u8Url = null;

    // Escuchar TODAS las respuestas
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes(".m3u8") && !m3u8Url) {
        m3u8Url = url;
        console.log("🎯 Encontrado m3u8:", url);
      }
    });

    // Navegar a la página
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Esperar hasta 15 seg máximo a que aparezca un m3u8
    const start = Date.now();
    while (!m3u8Url && Date.now() - start < 15000) {
      await new Promise((r) => setTimeout(r, 500));
    }

    await browser.close();

    if (m3u8Url) {
      return res.json({ m3u8: m3u8Url });
    } else {
      return res.json({ error: "No se encontró ningún .m3u8 en la página" });
    }
  } catch (err) {
    console.error("❌ Error:", err);
    if (browser) await browser.close();
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
