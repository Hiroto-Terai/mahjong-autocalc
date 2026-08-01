// オフラインで動かすためのキャッシュ。
// 一度開けば、以降は電波が無くても (機内モードでも) 起動する。

const CACHE = "mahjong-autocalc-v1";

const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./worker.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./engine/tiles.js",
  "./engine/parser.js",
  "./engine/yaku.js",
  "./engine/scoring.js",
  "./vision/cv.js",
  "./vision/detect.js",
  "./vision/features.js",
  "./vision/glyph-data.js",
  "./vision/glyphs.js",
  "./vision/heuristic.js",
  "./vision/library.js",
  "./vision/pipeline.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 1 つでも失敗すると全体が入らないので、個別に入れて取りこぼしを許容する。
      .then((cache) => Promise.all(ASSETS.map((asset) => cache.add(asset).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // キャッシュ優先。裏で新しいものを取ってきて次回に備える。
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
