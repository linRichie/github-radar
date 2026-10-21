#!/usr/bin/env node
// shoot.mjs —— 把仪表盘渲染成"长文图"（整页 PNG），供邮件内嵌查看。
// 用法：node scripts/shoot.mjs [输入.html 或 https://...] [输出.png]
// 依赖全局 puppeteer（ESM-only，按绝对路径动态 import）；无外部资源，file:// 亦可离屏渲染。

const mod = await import("/Users/WangLH/.npm-global/lib/node_modules/puppeteer/lib/puppeteer/puppeteer.js");
const puppeteer = mod.default || mod;
const { resolve } = await import("node:path");

const input = process.argv[2] || "index.html";
const output = process.argv[3] || "preview.png";
const target = /^https?:\/\//.test(input) ? input : "file://" + resolve(input);

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--force-device-scale-factor=1"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1040, height: 1200, deviceScaleFactor: 2 });
  await page.goto(target, { waitUntil: "networkidle0", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: output, fullPage: true });
  const fs = await import("node:fs");
  const kb = (fs.statSync(output).size / 1024).toFixed(0);
  console.log(`saved ${output} (${kb} KB) from ${target}`);
} finally {
  await browser.close();
}
