// Minimal service worker: lets the page show system notifications (required on Android Chrome)
// and focuses the app when a notification is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = all.find((c) => c.url.includes('/btc-patterns/'));
    if (url.startsWith('http') && !url.includes('/btc-patterns/')) return self.clients.openWindow(url);
    if (app) return app.focus();
    return self.clients.openWindow(url);
  })());
});
