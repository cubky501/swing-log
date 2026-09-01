// firebase-messaging-sw.js
// Swing Log のバックグラウンド通知(アプリを閉じている/裏に回っている間の通知)を担当する
// Service Worker。index.html と同じディレクトリのルート(/firebase-messaging-sw.js)に配置してデプロイする。

importScripts("https://www.gstatic.com/firebasejs/12.17.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.17.1/firebase-messaging-compat.js");

// index.html 内の firebaseConfig と同じ内容にしておくこと
firebase.initializeApp({
  apiKey: "AIzaSyAu-GxwhCOszGCwknKClvRB3bAxG-Ju7ko",
  authDomain: "golflesson-2142a.firebaseapp.com",
  projectId: "golflesson-2142a",
  storageBucket: "golflesson-2142a.firebasestorage.app",
  messagingSenderId: "615970186003",
  appId: "1:615970186003:web:410ffd0bab584e865170e6"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  // サーバー側は「notification」ではなく「data」形式で送るように変更した
  // (自動表示との二重表示を防ぐため)。ここが唯一の表示担当になる
  var title = (payload.data && payload.data.title) || "Swing Log";
  var body = (payload.data && payload.data.body) || "";
  var openChatStudent = (payload.data && payload.data.openChatStudent) || "";
  self.registration.showNotification(title, {
    body: body,
    icon: "/icon.png",
    badge: "/icon.png",
    data: { openChatStudent: openChatStudent } // クリック時にどのチャットを開くか、ここに持たせておく
  });
  // ホーム画面のアイコンに未読バッジを表示する(iOS 16.4以降・ホーム画面追加済み・通知許可済みが条件)
  if ("setAppBadge" in self.navigator) {
    self.navigator.setAppBadge(1).catch(function(){ /* 未対応環境などは無視 */ });
  }
});

// 通知をタップしたら、該当のチャット画面を開く(既に開いていればそのタブに切り替えて画面遷移、
// なければ新規タブをその画面で開く)
self.addEventListener("notificationclick", function(event) {
  event.notification.close();
  var openChatStudent = (event.notification.data && event.notification.data.openChatStudent) || "";
  var targetUrl = "/?openChat=" + encodeURIComponent(openChatStudent) + "&tab=chat";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ("focus" in client) {
          client.postMessage({ type: "openChat", studentName: openChatStudent });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
