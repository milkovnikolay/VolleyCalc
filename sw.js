/* VolleyCalc: работает без интернета. Страница — сначала из сети (чтобы приходили обновления), при отсутствии сети — из кэша. */
const CACHE = "vc-site-v14";
const FILES = ["./", "./index.html", "./coach.html", "./coach.dat", "./stats.js", "./pdf.js", "./player.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method === "POST" && url.origin === location.origin && url.pathname.endsWith("/share-target")) {   // «Поделиться → VolleyCalc» на Android
    e.respondWith((async () => {
      try { const fd = await req.formData(), c = await caches.open("vc-share"); let i = 0;
        for (const f of fd.getAll("files")) { if (f && f.size) await c.put("./shared-file?i=" + (i++) + "&n=" + encodeURIComponent(f.name || "file.json"), new Response(f)); } } catch (err) {}
      return Response.redirect("./player.html?shared=1", 303);
    })());
    return;
  }
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))));
});
