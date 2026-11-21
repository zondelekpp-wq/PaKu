const CACHE_NAME = 'drip-reader-pwa-v38';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './install.js',
  './lib/pdf.min.mjs',
  './lib/pdf.worker.min.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // każdy plik osobno: brak jednego (np. folderu lib) nie blokuje instalacji aplikacji
      Promise.all(ASSETS_TO_CACHE.map((a) => cache.add(a).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // usuwamy tylko własne stare pamięci – inne aplikacje rodziny PaKu mają ten sam adres
      Promise.all(keys.filter((k) => k.startsWith('drip-reader-pwa-') && k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Pobierane z internetu książki (inne domeny) przechodzą bez cache'owania
  if (!req.url.startsWith(self.registration.scope)) return;

  // Strona (index.html): najpierw sieć, żeby aktualizacje były widoczne od razu; offline -> cache
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Reszta zasobów: najpierw cache, potem sieć
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});

// ===== Codzienne przypomnienie (Periodic Background Sync – tylko tam, gdzie przeglądarka na to pozwala) =====
function idbRead(key) {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open('paku-db', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onerror = () => resolve(null);
      r.onsuccess = () => {
        const db = r.result;
        const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); resolve(null); };
      };
    } catch (e) { resolve(null); }
  });
}
function idbWrite(key, val) {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open('paku-db', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onerror = () => resolve();
      r.onsuccess = () => {
        const db = r.result, tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = tx.onabort = () => { db.close(); resolve(); };
      };
    } catch (e) { resolve(); }
  });
}
function ymdLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
async function dailyReminder() {
  const cfg = await idbRead('reminder');
  if (!cfg || !cfg.on || !cfg.time) return;
  if (self.Notification && self.Notification.permission !== 'granted') return;
  const now = new Date(), today = ymdLocal(now);
  if (cfg.openedDate === today || cfg.lastDate === today) return; // dziś już czytasz lub przypomnienie było
  const [h, m] = String(cfg.time).split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes(), due = (h || 0) * 60 + (m || 0);
  if (mins < due || mins > due + 12 * 60) return;
  const bodies = (cfg.bodies && cfg.bodies.length) ? cfg.bodies : ['📖 PaKuReading czeka na Ciebie!'];
  const day = Math.floor(now.getTime() / 86400000);
  await self.registration.showNotification(cfg.title || 'PaKuReading', {
    body: bodies[day % bodies.length], icon: './icon-192.png', badge: './icon-192.png', tag: 'paku-daily', data: { url: './' }
  });
  cfg.lastDate = today;
  await idbWrite('reminder', cfg);
}
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'paku-daily') event.waitUntil(dailyReminder());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./');
    })
  );
});
// pomocniczo dla testów i ręcznego wywołania z aplikacji
self.addEventListener('message', (event) => {
  if (event.data === 'paku-run-reminder') event.waitUntil(dailyReminder());
});
