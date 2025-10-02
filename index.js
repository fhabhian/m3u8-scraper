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

  try {
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: "networkidle2" });

    // Capturar peticiones .m3u8
    let m3u8Url = null;
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes(".m3u8") && !m3u8Url) {
        m3u8Url = url;
      }
    });

    // Esperar un poco a que cargue
    await page.waitForTimeout(5000);

    await browser.close();

    if (m3u8Url) {
      res.json({ m3u8: m3u8Url });
    } else {
      res.json({ error: "No se encontró m3u8" });
    }
  } catch (err) {
    console.error(err);
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
