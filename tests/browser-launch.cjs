// Общий выбор браузера для браузерных тестов (Chromium через Playwright).
// Порядок: CHROMIUM_PATH (свой Chrome/Chromium) → SPARTICUZ=1 (пакет @sparticuz/chromium) → встроенный Playwright.
module.exports = async function browserLaunchOptions() {
  if (process.env.CHROMIUM_PATH) return { headless: true, executablePath: process.env.CHROMIUM_PATH };
  if (process.env.SPARTICUZ) {
    const pkg = require('@sparticuz/chromium'), bin = pkg.default || pkg;
    return { headless: true, args: bin.args, executablePath: await bin.executablePath() };
  }
  return { headless: true };
};
