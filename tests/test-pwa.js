#!/usr/bin/env node
/**
 * tests/test-pwa.js —— PAIR PWA 資產離線驗證
 *
 * 純 Node（只用內建 fs / path / zlib / vm / crypto / child_process），
 * 零外部依賴、不開瀏覽器、不連網路。
 *
 * 執行：node tests/test-pwa.js
 * 失敗：印出每一條失敗原因並 process.exit(1)
 * 成功：印出斷言與行數統計後 exit 0
 *
 * 為什麼連像素都驗：manifest 與檔案存在與否很容易「看起來對」，
 * 但圖示真正會出錯的是 (a) 透明底（iOS/maskable 會被填黑）、
 * (b) maskable 圖素跑出安全區被裁掉、(c) 用錯顏色與站上不一致。
 * 這三件事只能解 PNG 像素才驗得出來。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const vm = require("vm");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const MANIFEST = path.join(REPO, "manifest.webmanifest");
const SW = path.join(REPO, "sw.js");

// 與 index.html :root 的 CSS 變數同色（--bg / --ink / --amber）
const BG = [0x0d, 0x0d, 0x11];
const INK = [0xe9, 0xe6, 0xdf];
const AMBER = [0xff, 0xb8, 0x4d];
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ICONS = [
  { src: "/icons/icon-192.png", size: 192, purpose: "any" },
  { src: "/icons/icon-512.png", size: 512, purpose: "any" },
  { src: "/icons/icon-maskable-512.png", size: 512, purpose: "maskable" },
  { src: "/icons/apple-touch-icon-180.png", size: 180, purpose: "any" },
];

// ------------------------------------------------------------------ 迷你斷言器
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message ? err.message : String(err) });
    console.log(`  FAIL  ${name}\n          ${err && err.message ? err.message : err}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------- 工具
const read = (p) => fs.readFileSync(p);
const repoPath = (url) => path.join(REPO, url.replace(/^\//, ""));

/** 去掉 // 與 /* *\/ 註解 —— 檢查「有沒有直接呼叫」時不能把註解算進去。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 解析 PNG：回傳 chunk 清單與 IHDR，並提供像素讀取（僅支援本專案輸出的 8-bit RGB）。 */
function decodePng(file) {
  const buf = read(file);
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("PNG 簽名不正確");
  const chunks = [];
  const idat = [];
  let ihdr = null;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const expectedCrc = buf.readUInt32BE(off + 8 + len);
    const actualCrc = zlib.crc32 ? zlib.crc32(data) : null;
    chunks.push({ type, len, data, expectedCrc, actualCrc });
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    }
    off += 12 + len;
  }
  if (!ihdr) throw new Error("找不到 IHDR");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * 3; // color type 2 (RGB) — 不透明，無 alpha
  const filters = [];
  for (let y = 0; y < ihdr.height; y++) filters.push(raw[y * (stride + 1)]);
  const pixel = (x, y) => {
    const p = y * (stride + 1) + 1 + x * 3;
    return [raw[p], raw[p + 1], raw[p + 2]];
  };
  return { buf, chunks, ihdr, filters, stride, pixel, raw };
}

const eq = (a, b, msg) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || "值不符"}：實際 ${sa}，預期 ${sb}`);
};

// =========================================================== 1. manifest
group("manifest.webmanifest");

let manifest = null;
check("存在且是合法 JSON", () => {
  manifest = JSON.parse(read(MANIFEST).toString("utf8"));
  if (typeof manifest !== "object" || manifest === null) throw new Error("不是物件");
});

check("name / short_name / description 正確", () => {
  eq(manifest.name, "PAIR — 對對相連", "name");
  eq(manifest.short_name, "PAIR", "short_name");
  eq(manifest.description, "找一對，連一條線。清空棋盤，進入下一關。", "description");
});

check("start_url 帶 ?from=pwa（用來分辨主畫面啟動）", () => {
  eq(manifest.start_url, "/?from=pwa", "start_url");
});

check("scope 為 /", () => eq(manifest.scope, "/", "scope"));

check("display=standalone / orientation=any / lang=zh-Hans", () => {
  eq(manifest.display, "standalone", "display");
  eq(manifest.orientation, "any", "orientation");
  eq(manifest.lang, "zh-Hans", "lang");
});

check("background_color 與 theme_color 為站上底色 #0d0d11", () => {
  eq(manifest.background_color, "#0d0d11", "background_color");
  eq(manifest.theme_color, "#0d0d11", "theme_color");
});

check("保持最小：沒有 screenshots / shortcuts / categories", () => {
  for (const k of ["screenshots", "shortcuts", "categories", "iarc_rating_id", "prefer_related_applications"]) {
    if (k in manifest) throw new Error(`不該出現的欄位：${k}`);
  }
});

check("icons 恰為四筆且路徑齊全", () => {
  if (!Array.isArray(manifest.icons)) throw new Error("icons 不是陣列");
  eq(manifest.icons.length, 4, "icons 數量");
  const srcs = manifest.icons.map((i) => i.src).sort();
  eq(srcs, ICONS.map((i) => i.src).sort(), "icons src 集合");
});

check("maskable 的 purpose 為 maskable、其餘為 any", () => {
  for (const want of ICONS) {
    const found = manifest.icons.find((i) => i.src === want.src);
    if (!found) throw new Error(`manifest 缺少 ${want.src}`);
    eq(found.purpose, want.purpose, `${want.src} purpose`);
    eq(found.type, "image/png", `${want.src} type`);
    eq(found.sizes, `${want.size}x${want.size}`, `${want.src} sizes`);
  }
  const maskable = manifest.icons.filter((i) => i.purpose === "maskable");
  eq(maskable.length, 1, "maskable 數量");
});

// =========================================================== 2. 圖示檔
group("icons/*.png");

check("四個圖示檔都存在於硬碟", () => {
  for (const i of ICONS) {
    const p = repoPath(i.src);
    if (!fs.existsSync(p)) throw new Error(`缺少檔案 ${p}`);
    if (fs.statSync(p).size < 200) throw new Error(`${i.src} 檔案過小，可能是佔位檔`);
  }
});

check("PNG 檔頭簽名為 89 50 4E 47 0D 0A 1A 0A", () => {
  for (const i of ICONS) {
    const head = read(repoPath(i.src)).subarray(0, 8);
    if (!head.equals(PNG_SIG)) throw new Error(`${i.src} 簽名 ${head.toString("hex")}`);
  }
});

check("IHDR 寬高與檔名相符", () => {
  for (const i of ICONS) {
    const { ihdr } = decodePng(repoPath(i.src));
    eq([ihdr.width, ihdr.height], [i.size, i.size], `${i.src} 尺寸`);
  }
});

check("PNG 不透明：bit depth 8 / color type 2 (RGB，無 alpha)", () => {
  for (const i of ICONS) {
    const { ihdr } = decodePng(repoPath(i.src));
    eq(ihdr.depth, 8, `${i.src} bit depth`);
    eq(ihdr.colorType, 2, `${i.src} color type`);
    eq(ihdr.interlace, 0, `${i.src} interlace`);
  }
});

check("只有 IHDR/IDAT/IEND，沒有 tIME 時間戳（可重現的前提）", () => {
  for (const i of ICONS) {
    const { chunks } = decodePng(repoPath(i.src));
    const types = chunks.map((c) => c.type);
    eq(types, ["IHDR", "IDAT", "IEND"], `${i.src} chunk 順序`);
    if (types.includes("tIME")) throw new Error(`${i.src} 含 tIME，輸出將不可重現`);
  }
});

check("所有像素列的 filter 都是 0（本專案 encoder 的契約）", () => {
  for (const i of ICONS) {
    const { filters, ihdr } = decodePng(repoPath(i.src));
    for (let y = 0; y < ihdr.height; y++) {
      if (filters[y] !== 0) throw new Error(`${i.src} 第 ${y} 列 filter=${filters[y]}`);
    }
  }
});

check("四角與外圈 10% 全是底色 #0d0d11（滿版填色、無透明、maskable 安全區留白）", () => {
  for (const i of ICONS) {
    const { ihdr, pixel } = decodePng(repoPath(i.src));
    const n = ihdr.width;
    const band = Math.max(1, Math.floor(n * 0.1));
    for (let k = 0; k < n; k++) {
      for (const [x, y] of [[k, 0], [k, n - 1], [0, k], [n - 1, k]]) {
        eq(pixel(x, y), BG, `${i.src} 邊界 (${x},${y})`);
      }
    }
    for (const [x, y] of [[0, 0], [band - 1, 0], [n - 1, band - 1], [n - band, n - 1], [band - 1, band - 1]]) {
      eq(pixel(x, y), BG, `${i.src} 外圈 (${x},${y})`);
    }
  }
});

check("中心像素是琥珀 #ffb84d（連線確實畫出來了，不是空白圖）", () => {
  for (const i of ICONS) {
    const { ihdr, pixel } = decodePng(repoPath(i.src));
    const c = Math.floor(ihdr.width / 2);
    eq(pixel(c, c), AMBER, `${i.src} 中心 (${c},${c})`);
  }
});

check("方塊是墨色 #e9e6df：在方塊中心取樣命中 INK", () => {
  for (const i of ICONS) {
    const { ihdr, pixel } = decodePng(repoPath(i.src));
    const n = ihdr.width;
    // 內容盒（左方塊中心）在 x = 25% 處，垂直置中
    const x = Math.round(n * 0.25);
    const y = Math.floor(n / 2) + Math.floor(n * 0.06);
    const p = pixel(x, y);
    const isInk = Math.abs(p[0] - INK[0]) <= 2 && Math.abs(p[1] - INK[1]) <= 2 && Math.abs(p[2] - INK[2]) <= 2;
    if (!isInk) throw new Error(`${i.src} (${x},${y}) = ${JSON.stringify(p)}，預期接近 ${JSON.stringify(INK)}`);
  }
});

check("maskable 圖素在中央 80% 直徑安全區外為零（Android 裁圓不會切到）", () => {
  const { ihdr, pixel } = decodePng(repoPath("/icons/icon-maskable-512.png"));
  const n = ihdr.width;
  const cx = (n - 1) / 2;
  const cy = (n - 1) / 2;
  const R = n * 0.4; // 安全區半徑 ＝ 中央 80% 直徑
  const step = 2;
  for (let y = 0; y < n; y += step) {
    for (let x = 0; x < n; x += step) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > R && d < R + 12) {
        const p = pixel(x, y);
        eq(p, BG, `安全區邊界 (${x},${y}) 距中心 ${d.toFixed(1)}px`);
      }
    }
  }
});

// =========================================================== 3. sw.js
group("sw.js");

const swSrc = read(SW).toString("utf8");
const swCode = stripComments(swSrc);

check("可用 new vm.Script 解析通過（語法合法）", () => {
  new vm.Script(swSrc, { filename: "sw.js" });
});

check('CACHE 常數為 "pair-v1"（可直接 bump）', () => {
  if (!/const CACHE = "pair-v1";/.test(swCode)) throw new Error('找不到 const CACHE = "pair-v1";');
});

check("預快取清單與 repo 實際檔案一致（不預快取不存在的檔案）", () => {
  const m = swCode.match(/const SHELL = \[([\s\S]*?)\];/);
  if (!m) throw new Error("找不到 SHELL 陣列");
  const shell = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (shell.length < 6) throw new Error(`SHELL 只有 ${shell.length} 筆，應含 6 筆最小外殼`);
  for (const url of shell) {
    const target = url === "/" ? path.join(REPO, "index.html") : repoPath(url);
    if (!fs.existsSync(target)) throw new Error(`SHELL 列了不存在的檔案：${url} -> ${target}`);
  }
  // manifest 裡的四張圖示都必須在外殼清單內
  for (const i of ICONS) {
    if (!shell.includes(i.src)) throw new Error(`SHELL 缺少 ${i.src}`);
  }
  if (!shell.includes("/manifest.webmanifest")) throw new Error("SHELL 缺少 manifest");
});

check("沒有 install 階段的 skipWaiting() 直接呼叫（只能在 message 分支裡）", () => {
  // 為什麼要這樣測：install 階段呼叫 skipWaiting 會讓新版 SW 立刻接管，
  // 頁面卻還跑著舊 JS，容易出現「明明更新了卻行為怪異」的鬼故事。
  // 更新時機必須由頁面透過 message 明確要求，所以我們檢查呼叫點只有一個，
  // 而且位置必須在 message 監聽器之後。註解已經先被剝掉，不會誤判。
  const calls = [...swCode.matchAll(/skipWaiting\(\)/g)];
  if (calls.length !== 1) throw new Error(`skipWaiting() 出現 ${calls.length} 次，應為 1 次（僅 message 分支）`);
  const msgIdx = swCode.indexOf('addEventListener("message"');
  if (msgIdx < 0) throw new Error('找不到 addEventListener("message"');
  if (calls[0].index < msgIdx) throw new Error("skipWaiting() 出現在 message 監聽器之前（可能在 install 階段）");
  const installBlock = swCode.match(/addEventListener\("install"[\s\S]*?\n\}\);/);
  if (!installBlock) throw new Error("找不到 install 監聽器");
  if (/skipWaiting/.test(installBlock[0])) throw new Error("install 區塊內出現 skipWaiting");
});

check('message 事件處理 {type:"SKIP_WAITING"} 才呼叫 self.skipWaiting()', () => {
  if (!/SKIP_WAITING/.test(swCode)) throw new Error("沒有處理 SKIP_WAITING");
  if (!/data\.type === "SKIP_WAITING"/.test(swCode)) throw new Error("沒有比對 data.type");
  if (!/self\.skipWaiting\(\)/.test(swCode)) throw new Error("沒有呼叫 self.skipWaiting()");
});

check('有 addEventListener("fetch") 且判斷 request.mode === "navigate"', () => {
  if (!/addEventListener\("fetch"/.test(swCode)) throw new Error('找不到 addEventListener("fetch"');
  if (!/request\.mode === "navigate"/.test(swCode)) throw new Error('找不到 request.mode === "navigate" 判斷');
});

check("只處理 GET 與同源請求，其餘放行", () => {
  if (!/request\.method !== "GET"\)\s*return;/.test(swCode)) throw new Error("缺少 GET 檢查");
  if (!/url\.origin !== self\.location\.origin\)\s*return;/.test(swCode)) throw new Error("缺少同源檢查");
});

check("navigation 走 network-first（HTML 不會被長快取）", () => {
  const navIdx = swCode.indexOf('request.mode === "navigate"');
  const navBlock = swCode.slice(navIdx, navIdx + 300);
  if (!/respondWith\(networkFirst\(request\)\)/.test(navBlock)) {
    throw new Error("navigate 分支沒有使用 networkFirst");
  }
  const nf = swCode.match(/async function networkFirst[\s\S]*?\n\}/);
  if (!nf) throw new Error("找不到 networkFirst");
  if (!/await fetch\(request\)/.test(nf[0])) throw new Error("networkFirst 沒有先打網路");
  if (!/caches\.match\(request\)/.test(nf[0])) throw new Error("networkFirst 缺少快取退路");
  if (!/caches\.match\("\/"\)/.test(nf[0])) throw new Error('networkFirst 缺少退到預快取 "/" 的路徑');
});

check("非導航的同源資源用 cache-first + 背景更新", () => {
  const navIdx = swCode.indexOf('request.mode === "navigate"');
  if (!/respondWith\(staleWhileRevalidate\(request\)\)/.test(swCode.slice(navIdx))) {
    throw new Error("非導航分支沒有使用 staleWhileRevalidate");
  }
  const swr = swCode.match(/async function staleWhileRevalidate[\s\S]*?\n\}/);
  if (!swr) throw new Error("找不到 staleWhileRevalidate");
  if (!/const cached = await caches\.match\(request\)/.test(swr[0])) throw new Error("不是 cache-first");
  if (!/if \(cached\) return cached;/.test(swr[0])) throw new Error("沒有先回快取");
});

check("activate 清掉非當前版本 cache 並 clients.claim()", () => {
  const act = swCode.match(/addEventListener\("activate"[\s\S]*?\n\}\);/);
  if (!act) throw new Error("找不到 activate 監聽器");
  if (!/caches\.keys\(\)/.test(act[0])) throw new Error("沒有列出 cache keys");
  if (!/key !== CACHE/.test(act[0])) throw new Error("沒有過濾非當前版本");
  if (!/caches\.delete\(key\)/.test(act[0])) throw new Error("沒有刪除舊 cache");
  if (!/self\.clients\.claim\(\)/.test(act[0])) throw new Error("沒有 clients.claim()");
});

check("回應非 200 / 非 basic 不進 cache", () => {
  if (!/response\.status === 200/.test(swCode)) throw new Error("沒有檢查 status 200");
  if (!/response\.type === "basic"/.test(swCode)) throw new Error('沒有檢查 type === "basic"');
  if (!/if \(isCacheable\(response\)\)/.test(swCode)) throw new Error("put 之前沒有過 isCacheable");
});

check("install 用最小外殼且個別容錯（單一資產失敗不會讓 SW 裝不上）", () => {
  const inst = swCode.match(/addEventListener\("install"[\s\S]*?\n\}\);/);
  if (!inst) throw new Error("找不到 install 監聽器");
  if (!/cache\.add\(/.test(inst[0])) throw new Error("沒有預快取動作");
  if (!/\.catch\(/.test(inst[0])) throw new Error("缺少個別容錯");
  if (!/cache: "reload"/.test(inst[0])) throw new Error("沒有繞過 HTTP 快取");
});

// =========================================================== 4. 確定性
group("可重現性");

check("重跑 make-icons.py 輸出位元組完全一致（無時間戳、無隨機）", () => {
  const script = path.join(REPO, "scripts", "make-icons.py");
  if (!fs.existsSync(script)) throw new Error("缺少 scripts/make-icons.py");
  const hash = (p) => crypto.createHash("sha256").update(read(p)).digest("hex");
  const before = ICONS.map((i) => hash(repoPath(i.src)));
  execFileSync("python3", [script], { cwd: REPO, stdio: "pipe" });
  const after = ICONS.map((i) => hash(repoPath(i.src)));
  for (let k = 0; k < ICONS.length; k++) {
    if (before[k] !== after[k]) {
      throw new Error(`${ICONS[k].src} 重跑後位元組改變：${before[k].slice(0, 12)} -> ${after[k].slice(0, 12)}`);
    }
  }
});

// =========================================================== 結果
const manifestLines = read(MANIFEST).toString("utf8").split("\n").length - 1;
const swLines = swSrc.split("\n").length - 1;
const testLines = read(__filename).toString("utf8").split("\n").length - 1;
const iconBytes = ICONS.map((i) => `${i.src.split("/").pop()}=${fs.statSync(repoPath(i.src)).size}`).join(" ");

console.log("");
console.log(`行數統計: manifest.webmanifest=${manifestLines}  sw.js=${swLines}  tests/test-pwa.js=${testLines}  scripts/make-icons.py=${read(path.join(REPO, "scripts", "make-icons.py")).toString("utf8").split("\n").length - 1}`);
console.log(`圖示位元組: ${iconBytes}`);
console.log(`斷言統計: ${passed} 通過, ${failures.length} 失敗, 共 ${passed + failures.length} 條`);

if (failures.length) {
  console.log("\n失敗明細:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log("\nAll PWA assets OK.");
