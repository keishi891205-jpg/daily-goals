// File: sw.js
"use strict";

const CACHE_VERSION = "v1";
const BASE = new URL("./", self.location.href);

// 他のGitHub Pagesプロジェクトのキャッシュと区別する。
const CACHE_PREFIX = `daily-goals:${self.registration.scope}:`;
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

const FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

const ASSET_URLS = FILES.map((path) => new URL(path, BASE).href);
const INDEX_URL = new URL("./index.html", BASE).href;
const HOME_PATH = BASE.pathname;
const INDEX_PATH = new URL("./index.html", BASE).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // 1つでも取得できない場合、準備完了とは扱わない。
      await cache.addAll(
        ASSET_URLS.map((url) =>
          new Request(url, { cache: "reload" })
        )
      );

      // 更新時は、古い画面がすべて閉じるまで待つ。
      // 強制的なskipWaitingは行わない。
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();

      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith(CACHE_PREFIX) &&
              name !== CACHE_NAME
          )
          .map((name) => caches.delete(name))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== BASE.origin) {
    return;
  }

  const isAppNavigation =
    request.mode === "navigate" &&
    (url.pathname === HOME_PATH || url.pathname === INDEX_PATH);

  const isStaticAsset = ASSET_URLS.includes(url.href);

  if (!isAppNavigation && !isStaticAsset) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const key = isAppNavigation ? INDEX_URL : request.url;
      const cached = await cache.match(key);

      if (cached) {
        return cached;
      }

      return fetch(request);
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CHECK_OFFLINE" || !event.ports[0]) {
    return;
  }

  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        const results = await Promise.all(
          ASSET_URLS.map((url) => cache.match(url))
        );

        event.ports[0].postMessage({
          ready: results.every(Boolean)
        });
      } catch {
        event.ports[0].postMessage({
          ready: false
        });
      }
    })()
  );
});