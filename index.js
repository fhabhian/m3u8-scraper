const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    let m3u8Url = null;

    page.on("response", (response) => {
      try {
        const reqUrl = response.url();
        if (reqUrl.includes(".m3u8")) {
          m3u8Url = reqUrl;
        }
      } catch (err) {}
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForTimeout(8000);

    if (m3u8Url) {
      res.json({ success: true, m3u8: m3u8Url });
    } else {
      res.json({ success: false, error: "No se detectó m3u8" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
