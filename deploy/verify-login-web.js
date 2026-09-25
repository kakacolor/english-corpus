/**
 * 线上登录报错提示验证（真实浏览器）
 *
 * 验证点：
 *   1) 空账号/空密码提交 -> 页面出现「请输入账号」
 *   2) 错误密码提交     -> 页面出现「账号或密码错误」
 *   3) 无 JS 运行时报错
 *
 * 用法：node deploy/verify-login-web.js [页面地址]
 */
const fs = require('fs');
const puppeteer = require('puppeteer');

const url = process.argv[2] || 'http://127.0.0.1:3000/';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // 交给 puppeteer 自带的 Chromium
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找到「登录」按钮并真实点击（react-native-web 的按钮是 div，需要真实鼠标事件） */
async function clickLoginButton(page) {
  const handle = await page.evaluateHandle(() => {
    const all = Array.from(document.querySelectorAll('div,span,button'));
    return (
      all.find(
        (el) =>
          el.textContent.trim() === '登录' &&
          el.getBoundingClientRect().height > 20 &&
          el.getBoundingClientRect().width > 60
      ) || null
    );
  });
  const el = handle.asElement();
  if (!el) throw new Error('找不到「登录」按钮');
  await el.click();
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: findChrome(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--window-size=1280,900'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!u.includes('favicon')) pageErrors.push(`REQFAIL ${u} ${r.failure() && r.failure().errorText}`);
  });

  const results = [];
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    await sleep(3500);

    const initialText = await page.evaluate(() => document.body.innerText);
    results.push(['登录页已渲染', initialText.includes('登录') && initialText.includes('英语语料积累')]);

    // ——— 1) 空提交 ———
    await clickLoginButton(page);
    await sleep(900);
    const afterEmpty = await page.evaluate(() => document.body.innerText);
    results.push(['空提交 -> 出现「请输入账号」', afterEmpty.includes('请输入账号')]);

    // ——— 2) 错误密码 ———
    await page.type('input[placeholder*="账号"]', 'nosuchuser_e2e', { delay: 12 });
    await page.type('input[placeholder*="密码"]', 'WrongPass123', { delay: 12 });
    await clickLoginButton(page);
    await sleep(3500);
    const afterWrong = await page.evaluate(() => document.body.innerText);
    results.push(['错误密码 -> 出现「账号或密码错误」', afterWrong.includes('账号或密码错误')]);
    results.push(['错误密码 -> 提示为红色警示样式', await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('div'));
      return nodes.some((n) => {
        const t = (n.textContent || '').trim();
        if (!t.includes('账号或密码错误')) return false;
        return /rgb\(185,\s*28,\s*28\)/.test(getComputedStyle(n).color);
      });
    })]);

    console.log('=== 页面可见文本（错误密码后）===');
    console.log(afterWrong.slice(0, 700));
    console.log('');
  } catch (err) {
    results.push([`执行异常：${err.message}`, false]);
  }

  console.log('=== 验证结果 ===');
  let pass = 0;
  for (const [name, ok] of results) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
    if (ok) pass += 1;
  }
  console.log(`\n通过 ${pass} / ${results.length}`);
  console.log(`页面 JS 错误：${pageErrors.length ? pageErrors.join(' | ') : '无'}`);

  await browser.close();
  process.exit(pass === results.length && pageErrors.length === 0 ? 0 : 1);
})();
