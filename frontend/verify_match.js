const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8090/login");
  await page.fill("input[name=\"username\"]", "admin");
  await page.fill("input[name=\"password\"]", "REDACTED");
  await page.click("button[type=\"submit\"]");
  await page.waitForTimeout(2000);
  await page.goto("http://127.0.0.1:8090/irc/Supernets/channel/superbowl");
  await page.waitForTimeout(5000);

  const ourHTML = await page.evaluate(() => {
    const el = document.querySelector("#member-count");
    return el ? el.outerHTML : "not found";
  });

  const normalized = ourHTML.replace(/ id="[^"]*"/, "").trim();
  const target = '<span class="totalMemberCount memberToggle" role="button" tabindex="0" title="Members list" aria-label="Members list" aria-expanded="true"><i class="fa fa-list-ul"></i><i class="fa fa-twitch"></i><span>231</span></span>';

  console.log("Our HTML (no id):", normalized);
  console.log("Target HTML:      ", target);
  console.log("Match:", normalized === target ? "YES - 100%" : "NO");

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
