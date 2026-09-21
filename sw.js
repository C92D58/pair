/* PAIR — service worker（單檔、零依賴）
 *
 * 改動前先讀這三條約束：
 *  1. 本站 _headers 對 /* 送出 `cache-control: no-cache`，目的是讓使用者永遠拿到
 *     新版 HTML。所以 navigation 一律 network-first：先打網路，失敗才退快取。
 *     離線可玩與「永遠拿新版」就是靠這個平衡點成立的。
 *  2. install 階段不呼叫 skipWaiting()。新版 SW 會停在 waiting，等頁面送來
 *     {type:"SKIP_WAITING"} 才接管 —— 更新時機由 index.html 決定。
 *  3. 預快取清單只列 repo 裡真實存在的檔案（見 SHELL）。
 */

const CACHE = "pair-v1";

// 最小外殼：每一筆都必須是 repo 中真實存在的檔案，否則 install 只是在浪費請求。
//   "/"                        -> index.html（CF Pages 根路徑）
//   "/manifest.webmanifest"    -> manifest.webmanifest
//   "/icons/*.png"             -> scripts/make-icons.py 產生的四張圖示
// 增減此清單時，請同步 tests/test-pwa.js 的「預快取清單與實際檔案一致」斷言。
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon-180.png",
];

// 只有「同源 + status 200 + type basic」的回應值得進快取。
// opaque（跨域 no-cors）與 redirect 一律不存，避免把壞資料當成離線內容端上桌。
function isCacheable(response) {
  return !!response && response.status === 200 && response.type === "basic";
}

// 放進快取但不改變回傳給頁面的回應；快取失敗（配額、Range 請求等）不該弄壞頁面。
async function putIfCacheable(request, response) {
  if (isCacheable(response)) {
    try {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    } catch (err) {
      // 刻意吞掉：拿不到快取只是少了離線能力，不影響這次瀏覽。
    }
  }
  return response;
}

// navigation：network-first。_headers 的 no-cache 是主防線，這裡是第二道：
// 只要網路活著就回網路版 HTML，離線（throw）才退快取。
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    await putIfCacheable(request, response);
    return response;
  } catch (err) {
    // 先比對同一個 URL（可能帶 ?from=pwa 之類 query），再退預快取的 "/"。
    const exact = await caches.match(request);
    if (exact) return exact;
    const shell = await caches.match("/");
    if (shell) return shell;
    return Response.error();
  }
}

// 其他同源資源：cache-first + 背景更新（stale-while-revalidate 的簡化版）。
// 圖示這類不常變的資產先回快取讓首屏快，同時背景抓新版補進去。
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((response) => putIfCacheable(request, response))
    .catch(() => null);
  if (cached) return cached;
  const fresh = await network;
  return fresh || Response.error();
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        SHELL.map((url) =>
          // cache: "reload" 繞過 HTTP 快取，確保外殼是新鮮的。
          cache.add(new Request(url, { cache: "reload" })).catch(() => {
            // 單一資產缺失（例如首次部署尚未上傳）不該讓整個 install 失敗，
            // 否則 SW 永遠裝不上，離線能力等於零。
          })
        )
      )
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // 只處理 GET；POST 等其餘方法直接放行。
  if (request.method !== "GET") return;

  // 只處理同源請求；跨域直接放行給瀏覽器預設行為。
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Chrome 的 only-if-cached 只允許 same-origin 模式，否則這裡會直接拋錯。
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

  if (request.mode === "navigate") {
    // HTML 一律網路優先，理由見 networkFirst 上方註解。
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

// 更新時機由頁面控制：保留 waiting 中的新版本，收到明確指令才接管。
// 這一點是刻意的 —— 絕不在 install 階段自作主張跳版。
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
