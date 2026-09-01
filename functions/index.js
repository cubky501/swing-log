// Swing Log: 新着チャットが届いたら相手(コーチ⇔生徒)にプッシュ通知を送る、
// および レッスンのコメント傾向をAIで要約する Cloud Functions。
//
// Swing Logのデータは全て Firestore の "appState" コレクションに、
// 1ドキュメント = { value: JSON文字列 } という形で保存されている。
// チャットのドキュメントIDは "chat:messages:<生徒名>" で、値はそのやり取り全件が入った配列。
//
// デプロイ方法:
//   1. このフォルダを Firebase プロジェクト直下に functions/ として配置
//   2. cd functions && npm install
//   3. ANTHROPIC_API_KEYをシークレットとして登録(初回のみ):
//        firebase functions:secrets:set ANTHROPIC_API_KEY
//      (プロンプトが出たら sk-ant- から始まるAPIキーを貼り付けてEnter)
//   4. firebase deploy --only functions

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const r2AccountId = defineSecret("R2_ACCOUNT_ID");
const r2AccessKeyId = defineSecret("R2_ACCESS_KEY_ID");
const r2SecretAccessKey = defineSecret("R2_SECRET_ACCESS_KEY");

initializeApp();
const db = getFirestore("golfl"); // index.htmlと同じ、defaultではない名前付きデータベース
const messaging = getMessaging();

const CHAT_PREFIX = "chat:messages:";
const COACH_NAME = "平山 晶彦"; // index.html の COACH_NAME と合わせる
const ADMIN_DISPLAY_NAME = "運営"; // index.html の管理者ログイン時のsession.nameと合わせる
const FCM_TOKENS_DOC = "fcm:tokens";

function safeParseArray(value) {
  if (!value) return [];
  try {
    var parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// リージョンはFirestoreデータベース"golfl"の所在地(asia-northeast1 / 東京)に明示的に合わせている。
// Firestoreトリガーはデータベースと同じリージョンでしか動けない制約があり、今まで指定なしでも
// 自動的にこのリージョンへデプロイされていたが、他の関数(onCall系)とリージョンを統一する対応の
// 一環として、ここでも明示しておく(挙動は変わらない)
exports.onChatMessageWritten = onDocumentWritten({ document: "appState/{docId}", database: "golfl", region: "asia-northeast1" }, async (event) => {
  var docId = event.params.docId;
  if (!docId.startsWith(CHAT_PREFIX)) return; // チャット以外のドキュメントは無視

  // Firebase Functions(2nd世代)は「少なくとも1回は配信される」仕組みのため、
  // 同じ操作に対して稀に複数回実行されることがある(公式ドキュメントで明記されている仕様)。
  // event.id(実行1回ごとに一意なID)を使って、既に処理済みなら即座に終了させる
  var eventId = event.id;
  if (eventId) {
    var idempotencyRef = db.collection("appState").doc(sanitizeDocId("processed-event:" + eventId));
    var idempotencySnap = await idempotencyRef.get();
    if (idempotencySnap.exists) {
      console.log("[通知] 同じイベントの重複実行を検知したためスキップ。eventId=" + eventId);
      return;
    }
    await idempotencyRef.set({ value: JSON.stringify({ processedAt: Date.now() }) });
  }

  var studentName = fixMojibakeDocId(docId.slice(CHAT_PREFIX.length));
  var beforeData = event.data.before.exists ? event.data.before.data() : null;
  var afterData = event.data.after.exists ? event.data.after.data() : null;
  if (!afterData) return; // 削除は通知しない

  var beforeMessages = safeParseArray(beforeData && beforeData.value);
  var afterMessages = safeParseArray(afterData.value);

  var beforeIds = new Set(beforeMessages.map(function (m) { return m.id; }));
  var newMessages = afterMessages.filter(function (m) { return !beforeIds.has(m.id); });
  if (newMessages.length === 0) {
    console.log("[通知] 新着メッセージなし(編集・削除のみ)のため終了。docId=" + docId);
    return;
  }

  // まとめて複数件届いた場合は最後の1件を代表として通知する
  var latest = newMessages[newMessages.length - 1];
  // 生徒からのメッセージは、コーチ本人だけでなく管理者(運営)にも通知する。
  // コーチ(またはコーチとして振る舞う管理者)からのメッセージは、これまで通り生徒のみに通知する
  var recipientNames = latest.from === "coach" ? [studentName] : [COACH_NAME, ADMIN_DISPLAY_NAME];
  var senderLabel = latest.from === "coach" ? (latest.authorRole === "admin" ? "運営" : "コーチ") : studentName + "さん";
  var bodyText = latest.type === "text" ? latest.text : "質問動画が届きました";
  console.log("[通知] 新着1件を検知。宛先=" + recipientNames.join(",") + " 送信者=" + senderLabel);

  var tokensSnap = await db.collection("appState").doc(FCM_TOKENS_DOC).get();
  var tokensMap = safeParseObject(tokensSnap.exists ? tokensSnap.data().value : null);
  var tokens = [];
  recipientNames.forEach(function (n) { tokens = tokens.concat(tokensMap[n] || []); });
  console.log("[通知] " + recipientNames.join(",") + " 宛の登録トークン数=" + tokens.length);
  if (tokens.length === 0) {
    console.log("[通知] トークンが0件のため送信をスキップ。宛先がまだ通知を有効化していないか、登録名の表記が一致していない可能性があります");
    return;
  }

  var invalidTokens = [];
  try {
    // 「notification」形式で送ると、ブラウザ側が自動で1回表示するのに加えて、
    // アプリ側(Service Worker)も別途表示しようとして二重に表示されることがある(iOS Safariの
    // Web Pushで確認済み)。「data」形式にして、実際に画面へ表示する処理はアプリ側だけが
    // 担当するようにすることで、この二重表示を防ぐ
    var res = await messaging.sendEachForMulticast({
      tokens: tokens,
      data: {
        title: senderLabel + "からメッセージ",
        body: bodyText.length > 60 ? bodyText.slice(0, 60) + "…" : bodyText,
        // 通知をタップした時に、どの生徒とのチャットを開けばよいかをここに含める。
        // コーチ宛(生徒から届いた場合)は生徒名、生徒宛(コーチから届いた場合)は自分自身のチャットで
        // 良いため空文字にしておく(生徒側はコーチとの1対1なので選び直す必要がない)
        openChatStudent: latest.from === "coach" ? "" : studentName
      }
    });
    console.log("[通知] 送信結果: 成功=" + res.successCount + " 失敗=" + res.failureCount);
    res.responses.forEach(function (r, i) {
      if (!r.success) {
        console.log("[通知] 送信失敗の詳細: " + (r.error && r.error.message));
        invalidTokens.push(tokens[i]);
      }
    });
  } catch (e) {
    console.error("通知送信エラー", e);
    return;
  }

  // 期限切れ・無効なトークンはFirestoreから取り除いておく(宛先が複数の場合、それぞれの登録から該当トークンを除く)
  if (invalidTokens.length > 0) {
    recipientNames.forEach(function (n) {
      tokensMap[n] = (tokensMap[n] || []).filter(function (t) { return invalidTokens.indexOf(t) === -1; });
    });
    await db.collection("appState").doc(FCM_TOKENS_DOC).set({ value: JSON.stringify(tokensMap) });
  }
});

function safeParseObject(value) {
  if (!value) return {};
  try {
    var parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

// Firebase Functions v2のFirestoreトリガーで、ドキュメントIDに日本語などの非ASCII文字が
// 含まれていると、event.params.docId が「UTF-8のバイト列を1バイトずつラテン文字として誤読した」
// 状態(文字化け)で渡ってくることがある(2026年8月時点で確認済みの既知の挙動)。
// ここでその文字化けを検出せず修復すると、実際には既に正しいASCII文字列(半角英数)には
// 影響を与えない(1バイト文字は変換しても値が変わらないため、安全にそのまま通せる)。
function fixMojibakeDocId(s) {
  try {
    return Buffer.from(s, "latin1").toString("utf8");
  } catch (e) {
    return s;
  }
}

// FirestoreのドキュメントIDには使えない文字(スラッシュ等)が万一含まれていても安全なように置換する
function sanitizeDocId(s) {
  return String(s).replace(/[\/]/g, "_");
}

// ===== AIサマリー(レッスンコメントの傾向分析) =====
// 生徒名を受け取り、その生徒のレッスン履歴をAnthropic APIに渡して要約を生成する。
// 前回生成した時点のレッスン件数を保存しておき、件数が増えていなければAPIを呼ばず
// 保存済みの結果をそのまま返す(コーチ・生徒どちらが押しても、実際に課金が発生するのは
// 新しいレッスンが増えた後の最初の1回だけ)
const AI_SUMMARY_PREFIX = "ai-summary:";
const LESSONS_PREFIX = "lesson-feed:entries:";
const LESSON_PLAN_USAGE_PREFIX = "lesson-plan-ai-usage:"; // 次回レッスン計画AI提案の使用量制御(コスト対策)用
const LESSON_PLAN_MIN_INTERVAL_MS = 15 * 1000; // 同一会員への連続生成の最短間隔
const LESSON_PLAN_DAILY_LIMIT = 20; // 同一会員につき1日あたりの生成回数上限

const SUMMARY_SYSTEM_PROMPT =
  "あなたはゴルフコーチのアシスタントです。生徒のレッスン記録(日付・クラブ種別・コーチのコメント)の一覧を渡すので、" +
  "傾向を分析し、次のJSON形式で**日本語で**出力してください。JSON以外の文字列(前置き・説明文・コードブロック記法)は一切出力しないこと。\n\n" +
  "{\n" +
  '  "phases": [\n' +
  '    { "period": "序盤(◯月〜◯月)", "summary": "一言(10〜20文字程度)", "detail": "2〜3文の説明" },\n' +
  '    { "period": "中盤(◯月〜◯月)", "summary": "...", "detail": "..." },\n' +
  '    { "period": "直近(◯月〜◯月)", "summary": "...", "detail": "..." }\n' +
  "  ],\n" +
  '  "repeatedPoints": [\n' +
  '    { "title": "繰り返し出てくる指摘(15文字程度)", "occurrenceNote": "◯月・◯月の計◯回、のような一言", "detail": "背景や要因を含む1〜2文の説明" }\n' +
  "  ],\n" +
  '  "positiveProgressShort": ["短い進捗コメント(◯月)", "..."],\n' +
  '  "positiveProgressDetail": "良い進捗について2〜3文でまとめた文章。実際のコメントを一部引用しても良い",\n' +
  '  "nextPoints": "次に見るべきポイントについて1〜2文でまとめた文章"\n' +
  "}\n\n" +
  "phasesは3つ程度、repeatedPointsは2〜3個程度にすること。日付や回数など、渡されたデータから読み取れる具体的な事実に基づいて書き、憶測は避けること。";

async function callAnthropic(apiKey, lessons) {
  var lessonLines = lessons
    .map(function (l) { return (l.date || "") + "|" + (l.tag || "") + "|" + (l.comment || ""); })
    .join("\n");

  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: "以下はある生徒のレッスン記録です(日付|クラブ種別|コメント、の形式)。\n\n" + lessonLines }
      ]
    })
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error("Anthropic API エラー: " + res.status + " " + errText);
  }
  var data = await res.json();
  var text = (data.content || []).map(function (b) { return b.type === "text" ? b.text : ""; }).join("");
  var cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// region: onChatMessageWritten(Firestoreトリガー)と揃え、東京リージョンに統一。
// これによりFirestore("golfl"データベース、東京)への読み書きがリージョンをまたがなくなり、
// レイテンシが改善する
exports.generateAiSummary = onCall({ secrets: [anthropicApiKey], region: "asia-northeast1" }, async (request) => {
  var studentName = request.data && request.data.studentName;
  if (!studentName || typeof studentName !== "string") {
    throw new HttpsError("invalid-argument", "studentNameが必要です。");
  }

  var lessonsSnap = await db.collection("appState").doc(LESSONS_PREFIX + studentName).get();
  var lessons = safeParseArray(lessonsSnap.exists ? lessonsSnap.data().value : null);
  if (lessons.length < 3) {
    throw new HttpsError("failed-precondition", "レッスン記録がまだ少ないため、サマリーを生成できません。");
  }

  var summaryDocRef = db.collection("appState").doc(AI_SUMMARY_PREFIX + studentName);
  var summarySnap = await summaryDocRef.get();
  var cached = safeParseObject(summarySnap.exists ? summarySnap.data().value : null);

  if (cached && cached.lessonCount === lessons.length && cached.result) {
    return { result: cached.result, cached: true, lessonCount: lessons.length };
  }

  var result = await callAnthropic(anthropicApiKey.value(), lessons);
  var toSave = { lessonCount: lessons.length, result: result, generatedAt: Date.now() };
  await summaryDocRef.set({ value: JSON.stringify(toSave) });

  return { result: result, cached: false, lessonCount: lessons.length };
});

// ===== 次回レッスン計画の提案(コーチ入力欄の叩き台) =====
// AIサマリーと違い、こちらはキャッシュしない(コーチがボタンを押すたびに生成する)。
// 呼び出し頻度はコーチが計画を見直す時だけ(月1〜2回程度)なので、キャッシュの複雑さを持ち込むより
// シンプルに都度生成する方針にしている
const LESSON_PLAN_SYSTEM_PROMPT =
  "あなたはゴルフコーチのアシスタントです。生徒のレッスン記録(日付・クラブ種別・コーチのコメント)の一覧を渡すので、" +
  "今後1〜2ヶ月のレッスン計画を、コーチが生徒本人に向けて話しかける口調で、**日本語で**箇条書き5行程度にまとめてください。" +
  "各行は「・」で始め、1行は40文字程度までの簡潔な文にすること。" +
  "レッスン記録から読み取れる繰り返しの指摘や直近の変化など、具体的な事実に基づいて書き、憶測は避けること。" +
  "箇条書き以外の前置き・説明文・見出し・コードブロック記法は一切出力しないこと。";

async function callAnthropicForLessonPlan(apiKey, lessons) {
  var lessonLines = lessons
    .map(function (l) { return (l.date || "") + "|" + (l.tag || "") + "|" + (l.comment || ""); })
    .join("\n");

  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: LESSON_PLAN_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: "以下はある生徒のレッスン記録です(日付|クラブ種別|コメント、の形式)。\n\n" + lessonLines }
      ]
    })
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error("Anthropic API エラー: " + res.status + " " + errText);
  }
  var data = await res.json();
  var text = (data.content || []).map(function (b) { return b.type === "text" ? b.text : ""; }).join("");
  return text.trim();
}

exports.generateNextLessonPlan = onCall({ secrets: [anthropicApiKey], region: "asia-northeast1" }, async (request) => {
  var studentName = request.data && request.data.studentName;
  if (!studentName || typeof studentName !== "string") {
    throw new HttpsError("invalid-argument", "studentNameが必要です。");
  }

  // ---- コスト制御: 連打・誤操作での無制限なAPI呼び出しを防ぐ ----
  // AIサマリーと違いキャッシュせず毎回生成する仕様のため、ここでガードをかけておかないと
  // ボタン連打や何らかの不具合で呼び出しが繰り返された場合に課金が青天井になってしまう。
  // ・同一会員への連続生成は15秒あける(ボタンの誤連打・二重送信対策)
  // ・同一会員につき1日20回まで(通常は月1〜2回の想定なので、これでも十分すぎる余裕を持たせている)
  var usageDocRef = db.collection("appState").doc(LESSON_PLAN_USAGE_PREFIX + studentName);
  var usageSnap = await usageDocRef.get();
  var usage = safeParseObject(usageSnap.exists ? usageSnap.data().value : null) || {};
  var today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"(UTC基準。日次上限のリセットタイミングがズレても実害は無いため簡略化している)
  var now = Date.now();

  if (usage.lastAt && (now - usage.lastAt) < LESSON_PLAN_MIN_INTERVAL_MS) {
    throw new HttpsError("resource-exhausted", "少し間隔をあけてからもう一度お試しください。");
  }
  var todaysCount = (usage.day === today) ? (usage.count || 0) : 0;
  if (todaysCount >= LESSON_PLAN_DAILY_LIMIT) {
    throw new HttpsError("resource-exhausted", "本日の生成回数の上限に達しました。日を改めてお試しください。");
  }

  var lessonsSnap = await db.collection("appState").doc(LESSONS_PREFIX + studentName).get();
  var lessons = safeParseArray(lessonsSnap.exists ? lessonsSnap.data().value : null);
  if (lessons.length < 3) {
    throw new HttpsError("failed-precondition", "レッスン記録がまだ少ないため、計画を提案できません。");
  }

  var text = await callAnthropicForLessonPlan(anthropicApiKey.value(), lessons);

  // 実際にAPIを呼んだ後にだけ使用量を記録する(件数不足などで弾かれたケースはカウントしない)
  await usageDocRef.set({ value: JSON.stringify({ day: today, count: todaysCount + 1, lastAt: now }) });

  return { text: text };
});


// ===== 動画ストレージ(Cloudflare R2) =====
// R2にはFirebase Storageのようなセキュリティルールが無いため、
// 「アップロード(書き込み)」だけはCloud Functions経由で一時的な署名付きURLを発行して制限する。
// 「閲覧(読み込み)」はバケットを公開設定にしているので、発行したURLがそのままずっと使える
// (今までのFirebase Storageの getDownloadURL と同じ感覚で使える)。
//
// 追加セットアップ:
//   1. functions/package.json の dependencies に以下を追加して npm install:
//        "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"
//   2. R2の認証情報をシークレットとして登録(初回のみ):
//        firebase functions:secrets:set R2_ACCOUNT_ID
//        firebase functions:secrets:set R2_ACCESS_KEY_ID
//        firebase functions:secrets:set R2_SECRET_ACCESS_KEY
//   3. 下の R2_BUCKET_NAME と R2_PUBLIC_BASE_URL を、実際に作成したバケット名・
//      公開URL(Cloudflareダッシュボードの「Public access」で発行されたr2.devのURL)に書き換える

const R2_BUCKET_NAME = "swing-log-videos"; // ← Cloudflareで作成した実際のバケット名に合わせる
const R2_PUBLIC_BASE_URL = "https://pub-44e96a63ef734da7adf82623d4b57779.r2.dev";

function getR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: "https://" + r2AccountId.value() + ".r2.cloudflarestorage.com",
    forcePathStyle: true, // バケット名をサブドメインに含めず、パスに含める形式に強制(SSL証明書エラー対策)
    requestChecksumCalculation: "WHEN_REQUIRED", // SDKが自動でCRC32チェックサムを付与する挙動を無効化(R2との相性問題でPUTが400になるのを防ぐ)
    credentials: {
      accessKeyId: r2AccessKeyId.value(),
      secretAccessKey: r2SecretAccessKey.value()
    }
  });
}

// クライアントから呼ぶ: { pathPrefix: "lesson/遠藤 洋平", fileName: "movie.mp4", contentType: "video/mp4" }
// 戻り値: { uploadUrl (10分だけ有効なPUT先), publicUrl (保存後ずっと使える閲覧用URL), key }
// R2のキー(パス)は、日本語・スペース・カッコなどが混じると、ブラウザとサーバーで
// URLエンコードの解釈が微妙にズレて署名が一致しなくなることがあるため、
// 安全な文字(英数字・._-)だけに変換してから使う
function sanitizeForR2Key(s) {
  // \w(半角英数字)だけだと日本語がすべて失われて"file"に潰れてしまうため、
  // Unicodeの「文字」「数字」区分(\p{L}\p{N} = 漢字・ひらがな・カタカナ等も含む)は保持し、
  // スペース・カッコなど署名エラーの原因になった記号だけを置換する
  return String(s || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "file";
}

exports.getR2UploadUrl = onCall({ secrets: [r2AccountId, r2AccessKeyId, r2SecretAccessKey], region: "asia-northeast1" }, async (request) => {
  var pathPrefix = request.data && request.data.pathPrefix;
  var fileName = request.data && request.data.fileName;
  var contentType = (request.data && request.data.contentType) || "video/mp4";
  if (!pathPrefix || !fileName) {
    throw new HttpsError("invalid-argument", "pathPrefix, fileName が必要です。");
  }

  var safePathPrefix = pathPrefix.split("/").map(sanitizeForR2Key).join("/");
  var safeFileName = sanitizeForR2Key(fileName);
  var key = safePathPrefix + "/" + Date.now() + "_" + safeFileName;
  var s3 = getR2Client();
  var command = new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, ContentType: contentType });
  var uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });

  return { uploadUrl: uploadUrl, publicUrl: R2_PUBLIC_BASE_URL + "/" + key, key: key };
});

// クライアントから呼ぶ: { key: "lesson/遠藤 洋平/1234_movie.mp4" }
// 差し替え・削除で不要になった動画をR2から消す
exports.deleteR2Object = onCall({ secrets: [r2AccountId, r2AccessKeyId, r2SecretAccessKey], region: "asia-northeast1" }, async (request) => {
  var key = request.data && request.data.key;
  if (!key) throw new HttpsError("invalid-argument", "key が必要です。");

  var s3 = getR2Client();
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  } catch (e) {
    console.error("R2削除エラー", key, e);
    throw new HttpsError("internal", "R2からの削除に失敗しました。");
  }
  return { deleted: true };
});