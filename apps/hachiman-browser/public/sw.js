// The service worker of the browser host: content-free Web Push (contract §4 Push).
// Takusen sends an empty push for a new DM message. The push names no sender and no text:
// the open app has the keys, the service worker does not.

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window" });
      // A focused tab shows the message itself. Browsers want a notification for each push,
      // but allow one now and then without.
      if (windows.some((w) => w.focused)) return;
      await self.registration.showNotification("Hachiman", {
        body: "New message",
        tag: "message",
        icon: "/favicon.png",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const [open] = await self.clients.matchAll({ type: "window" });
      if (open) await open.focus();
      else await self.clients.openWindow("/");
    })(),
  );
});
