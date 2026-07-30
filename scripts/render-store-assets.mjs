import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const localRequire = createRequire(import.meta.url);
const dependencyRequire = process.env.STORE_ASSET_NODE_MODULES
  ? createRequire(path.join(process.env.STORE_ASSET_NODE_MODULES, "package.json"))
  : localRequire;
const { chromium } = dependencyRequire("playwright");
const sharp = dependencyRequire("sharp");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "store-listing", "assets");
const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
});

async function render({ source, output, width, height, query = "" }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const url = `${pathToFileURL(path.join(root, "store-listing", source)).href}${query}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(assets, output), type: "png" });
  await page.close();
}

await render({ source: "promo.html", output: "promo-large-1400x560.png", width: 1400, height: 560 });
await render({ source: "promo.html", output: "promo-small-440x280.png", width: 440, height: 280 });
await render({ source: "screenshot.html", output: "screenshot-clip-1280x800.png", width: 1280, height: 800 });
await render({ source: "screenshot.html", output: "screenshot-success-1280x800.png", width: 1280, height: 800, query: "?success=1" });
await render({ source: "settings.html", output: "screenshot-settings-1280x800.png", width: 1280, height: 800 });
await browser.close();

for (const name of [
  "promo-large-1400x560",
  "promo-small-440x280",
  "screenshot-clip-1280x800",
  "screenshot-success-1280x800",
  "screenshot-settings-1280x800"
]) {
  const source = path.join(assets, `${name}.png`);
  await sharp(source).png({ compressionLevel: 9 }).toFile(path.join(assets, `${name}-store.png`));
  await sharp(source).jpeg({ quality: 88, mozjpeg: true }).toFile(path.join(assets, `${name}-store.jpg`));
}

console.log("Store assets rendered.");
