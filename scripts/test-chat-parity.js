// scripts/test-chat-parity.js
// ─────────────────────────────────────────────────────────────────────────────
// Automated regression tests for the shared conversation engine.
// Website Chat vs WhatsApp MUST behave identically because both channels run
// the SAME engine (api/_lib/conversation-engine.js).
//
//   npm test
//
// The engine's database (Neon) and LLM (Groq) are both mocked so the tests are
// deterministic and run fully offline. The ONLY difference between the two
// channels under test is the `channel` option passed to handleMessage():
//
//   channel = "whatsapp"   (api/whatsapp.js)
//   channel = "website"    (api/chat.js, shopId = null)
//
// If a test fails, the two channels have drifted apart — the fix is in the
// shared engine, never in a per-channel copy.

"use strict";

// callGroq() bails out when GROQ_API_KEY is missing — set a dummy so the
// stubbed fetch below is actually exercised (never a real network call).
process.env.GROQ_API_KEY = "test-key";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// ─── In-memory fake DB ────────────────────────────────────────────────────────
// Intercept @neondatabase/serverless BEFORE the engine is required.
const Module = require("module");

function createFakeDb() {
  const state = new Map(); // customer_number -> row
  const conversations = [];
  const bookings = []; // stored booking rows (id, status, technician, etc.)
  // ── Dashboard tables (what the shop dashboard reads) ─────────────────────
  const waLogs = [];        // whatsapp_conversations — “WhatsApp Logs” page
  const analytics = [];     // conversation_analytics — per-shop daily rows
  const notifications = []; // shop_notifications — bell icon
  let bookingSeq = 0; // global booking id sequence (like the real DB's SERIAL)

  function nowIso() {
    return new Date().toISOString();
  }

  // neon client. Supports BOTH call forms used by the engine:
  //   sql`SELECT ... WHERE x = ${v}`   (tagged template → array of strings)
  //   sql("UPDATE ... = $1 WHERE id = $2", v, id)  (plain function call → string)
  function sql(strings, ...values) {
    let query;
    if (typeof strings === "string") {
      query = strings; // plain function-call form — placeholders are already $1/$2
    } else {
      const parts = [];
      for (let i = 0; i < strings.length; i++) {
        parts.push(strings[i]);
        if (i < values.length) parts.push("$" + (i + 1));
      }
      query = parts.join("");
    }
    const lower = query.toLowerCase();

    if (lower.includes("from conversation_state") && lower.includes("select *")) {
      const row = state.get(values[0]);
      return Promise.resolve(row ? [{ ...row }] : []);
    }
    if (lower.includes("select id from conversation_state")) {
      return Promise.resolve(state.has(values[0]) ? [{ id: 1 }] : []);
    }
    // NOTE: the engine's SQL template literals begin with a newline + indent,
    // so matching must use `includes`, not `startsWith`.
    if (lower.includes("update conversation_state")) {
      const row = state.get(values[values.length - 1]); // last value is the WHERE key
      if (row) {
        // Extract the assigned column names with a regex — naive split(",")
        // would break on the comma inside COALESCE($N, col).
        const setClause = query.match(/set\s+([\s\S]*?)\s+where/i)[1];
        const cols = [];
        const colRe = /([a-z_]+)\s*=\s*COALESCE\(/gi;
        let cm;
        while ((cm = colRe.exec(setClause)) !== null) cols.push(cm[1]);
        cols.forEach((col, i) => {
          const v = values[i];
          if (v !== null && v !== undefined) row[col] = v; // COALESCE(v, existing)
        });
        row.updated_at = nowIso();
      }
      return Promise.resolve([]);
    }
    if (lower.includes("insert into conversation_state")) {
      const cols = query
        .match(/insert into conversation_state\s*\(([^)]+)\)/is)[1]
        .split(",")
        .map((c) => c.trim());
      const row = { customer_number: values[0] };
      cols.forEach((col, i) => { row[col] = values[i]; });
      row.updated_at = nowIso();
      state.set(values[0], row);
      return Promise.resolve([]);
    }
    if (lower.startsWith("delete from conversation_state")) {
      state.delete(values[0]);
      return Promise.resolve([]);
    }
    if (lower.includes("insert into conversations")) {
      const rec = {
        id: conversations.length + 1,
        customer_number: values[0],
        role: values[1],
        message: values[2],
        channel: values[3],
        created_at: nowIso(),
      };
      conversations.push(rec);
      return Promise.resolve([{ id: rec.id, created_at: rec.created_at }]);
    }
    if (lower.includes("count(*) as c") && lower.includes("from conversations")) {
      // trackConversationFirstMessage: SELECT COUNT(*) AS c FROM conversations
      // WHERE customer_number = $1 AND id <> $2  (values = [customerNumber, savedInId])
      const rows = conversations.filter((c) => c.customer_number === values[0] && c.id !== values[1]);
      return Promise.resolve([{ c: rows.length }]);
    }
    if (lower.includes("from conversations")) {
      let rows = conversations.filter((c) => c.customer_number === values[0]);
      // Support the engine's duplicate-suppression check:
      //   SELECT id FROM conversations WHERE customer_number=$1 AND role='customer'
      //     AND message=$2 AND channel=$3 AND created_at > now() - interval '...'
      // values are [customerNumber, message, channel] in that case.
      if (lower.includes("role = 'customer'") && lower.includes("message =")) {
        rows = rows.filter((c) => c.role === "customer" && c.message === String(values[1] ?? ""));
        if (values[2] !== undefined) rows = rows.filter((c) => c.channel === values[2]);
      }
      return Promise.resolve(rows);
    }
    if (lower.includes("insert into whatsapp_conversations")) {
      const rec = {
        id: waLogs.length + 1,
        repair_shop_id: values[0],
        customer_number: values[1],
        direction: values[2],
        message_text: values[3],
        channel: values[4] || "whatsapp",
        status: values[5] || "delivered",
        created_at: nowIso(),
      };
      waLogs.push(rec);
      return Promise.resolve([]);
    }
    if (lower.includes("from whatsapp_conversations")) {
      const rows = waLogs.filter((l) => l.repair_shop_id === values[0]);
      return Promise.resolve(rows);
    }
    if (lower.includes("insert into conversation_analytics")) {
      // trackAnalytics / trackConversationFirstMessage upsert:
      //   INSERT INTO conversation_analytics (repair_shop_id, date, <metric>)
      //   VALUES (shopId, today, 1) ON CONFLICT (repair_shop_id, date)
      //   DO UPDATE SET <metric> = COALESCE(conversation_analytics.<metric>, 0) + 1
      const shopId = values[0];
      const date = String(values[1]);
      const metricMatch = query.match(/conversation_analytics\s*\(([^)]+)\)/i);
      const cols = metricMatch ? metricMatch[1].split(",").map((c) => c.trim()) : [];
      const metric = cols.find((c) => c === "total_conversations" || c === "booking_completed" || c === "human_handoff") || "total_conversations";
      let row = analytics.find((a) => a.repair_shop_id === shopId && a.date === date);
      if (!row) {
        row = { repair_shop_id: shopId, date, total_conversations: 0, booking_completed: 0, human_handoff: 0 };
        analytics.push(row);
      }
      row[metric] = parseInt(row[metric] || 0, 10) + 1;
      return Promise.resolve([]);
    }
    if (lower.includes("from conversation_analytics")) {
      return Promise.resolve(analytics.filter((a) => a.repair_shop_id === values[0]));
    }
    if (lower.includes("insert into shop_notifications")) {
      // Two SQL shapes reach here:
      //   • notifyHumanHandoff: type/title/link are LITERALS in the SQL text
      //     (VALUES ($1, 'human_handoff', 'Human Handoff …', $2, '/shop-dashboard.html'))
      //   • trackConversationFirstMessage: type/title/message are bound params
      //     (VALUES ($1, $2, $3, $4, '/shop-dashboard.html'))
      const literals = [...query.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      const hasLiteralType = literals.length > 0 && !literals[0].startsWith("/");
      notifications.push({
        id: notifications.length + 1,
        repair_shop_id: values[0],
        type: hasLiteralType ? literals[0] : values[1],
        title: hasLiteralType ? literals[1] : values[2],
        message: hasLiteralType ? values[values.length - 1] : values[3],
        link: literals[literals.length - 1] || values[4],
        created_at: nowIso(),
      });
      return Promise.resolve([]);
    }
    if (lower.includes("from shop_notifications")) {
      return Promise.resolve(notifications.filter((n) => n.repair_shop_id === values[0]));
    }
    if (lower.includes("insert into bookings")) {
      const cn = values[0];
      bookingSeq += 1;
      const id = bookingSeq;
      // Engine INSERT values:
      //   [customer_number, customer_name, customer_phone, address,
      //    service_type, area, urgency, image_urls, file_urls,
      //    repair_shop_id, channel]
      // ('open' status and 'neutral' sentiment are literals in the SQL, so the
      // shop id is at index 9 and the channel/source at index 10.)
      bookings.push({
        id,
        customer_number: cn,
        customer_name: values[1],
        customer_phone: values[2],
        address: values[3],
        service_type: values[4],
        area: values[5],
        urgency: values[6],
        status: "open",
        repair_shop_id: values[9] ?? null,
        source: values[10] ?? "whatsapp",
        technician_name: null,
        technician_id: null,
        estimated_cost: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return Promise.resolve([{ id }]);
    }
    if (lower.includes("from bookings")) {
      const id = parseInt(values[0], 10);
      const row = bookings.find((b) => b.id === id);
      return Promise.resolve(row ? [{ ...row }] : []);
    }
    if (lower.includes("update bookings")) {
      // UPDATE bookings SET status = 'cancelled' WHERE id = $1  (values = [id])
      const id = parseInt(values[values.length - 1], 10);
      const row = bookings.find((b) => b.id === id);
      if (row) {
        const statusMatch = query.match(/set\s+status\s*=\s*'([^']+)'/i);
        if (statusMatch) row.status = statusMatch[1];
        const colMatch = query.match(/set\s+(\w+)\s*=\s*\$/i);
        if (colMatch && values.length > 1) {
          const col = colMatch[1];
          if (col === "service_type" || col === "urgency" || col === "address" || col === "area" || col === "customer_name") {
            row[col] = values[0];
          }
        }
      }
      return Promise.resolve([]);
    }
    if (lower.includes("from technicians")) {
      return Promise.resolve([]); // no technicians configured -> booking stays 'open'
    }
    // Anything else the engine asks — resolve empty so it can continue.
    return Promise.resolve([]);
  }

  return { sql, state, conversations, bookings, waLogs, analytics, notifications };
}

const db = createFakeDb();
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@neondatabase/serverless") {
    // The engine does `const { neon } = require("@neondatabase/serverless")`,
    // so the mock module must export a `neon` factory like the real one.
    return { neon: function neonFake() { return db.sql; } };
  }
  return originalLoad.apply(this, arguments);
};

// ─── Deterministic LLM stub (replaces Groq's fetch) ──────────────────────────
// Mirrors the engine's mode-aware intent lists so the test drives the same
// classification the real LLM would (deterministically).
function fakeIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (/^(yes|yeah|yep|confirm|ok|okay|sure)$/.test(t)) return "confirm_yes";
  if (/^(no|nope|cancel)$/.test(t)) return "confirm_no";
  if (t.includes("reschedule") || t.includes("reschedule my") || t.includes("change the date") || t.includes("move my booking")) return "reschedule";
  if (t.includes("cancel")) return "cancel_booking";
  if (t.includes("new booking") || t.includes("book another")) return "new_booking";
  if (t.includes("status")) return "booking_status";
  if (t.includes("cost") || t.includes("price") || t.includes("charge") || t.includes("how much")) return "price_enquiry";
  if (t.includes("technician") && (t.includes("who") || t.includes("assigned") || t.includes("name"))) return "technician_status";
  if (t.includes("when") || t.includes("eta") || t.includes("arrive")) return "eta";
  if (t.includes("thank")) return "thanks";
  if (t.includes("complaint") || t.includes("complain")) return "complaint";
  if (t.includes("human") || t.includes("agent") || t.includes("person") || t.includes("support") || t.includes("manager")) return "human_support";
  if (t.includes("change") || t.includes("modify") || t.includes("update")) return "modify_booking";
  return "general_question";
}

function jsonResponse(obj) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }),
  });
}

const originalFetch = global.fetch;
global.fetch = async function fakeFetch(url, options) {
  const body = JSON.parse(options.body);
  const prompt = body.messages[body.messages.length - 1].content;
  if (prompt.includes("Classify this customer message intent")) {
    const m = prompt.match(/Message: "([^"]*)"/);
    return jsonResponse({ intent: fakeIntent(m ? m[1] : "") });
  }
  if (prompt.includes("Recognize synonyms")) return jsonResponse({ value: "AC" });
  if (prompt.includes("problem/issue description")) {
    // Only produce an issue when the user text actually describes one —
    // appliance-only messages ("AC") must NOT yield a fake issue.
    const m = prompt.match(/User: "([^"]*)"/);
    const userText = m ? m[1] : "";
    return jsonResponse({ value: /not|no\s|broken|leak|spin|cool|heat|water|error|noise|stopped|working/i.test(userText) ? "not cooling" : null });
  }
  if (prompt.includes("complete address")) return jsonResponse({ value: "123 Main St", area: "Downtown" });
  if (prompt.includes("Extract area/locality")) return jsonResponse({ value: "Downtown" });
  if (prompt.includes("Extract service date preference")) {
    // Extract the date the customer actually typed — makes the reschedule test
    // meaningful (the mock behaves like the real extraction LLM).
    const m = prompt.match(/User: "([^"]*)"/);
    return jsonResponse({ value: m ? m[1] : "today" });
  }
  return jsonResponse({ value: null });
};

// ─── Load the REAL engine — the module under test ─────────────────────────────
// Restore the real module loader + fetch once the suite finishes, so any future
// test files in this repo never accidentally inherit these fakes.
after(() => {
  Module._load = originalLoad;
  global.fetch = originalFetch;
});

const engine = require("../api/_lib/conversation-engine");
const { handleMessage, saveState, isDuplicateRequest, STATUS, MODE, t } = engine;

const WELCOME = t("en").welcome("CoolCare");
const ASK_PHOTO = t("en").askPhoto;
const ASK_NAME = t("en").askName;
const ASK_PHONE = t("en").askPhone;
const ASK_DATE = t("en").askDate;
const FALLBACK = t("en").fallback;
const HUMAN_HANDOFF = t("en").humanHandoff;
const CANCELLED = t("en").cancelled;

function webOpts() {
  return { channel: "website", shopId: null }; // shopId null => no branding/shop-specific branches
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// The redesigned conversation flow, shared by both channels: greeting → issue →
// photo → name → address → phone → date → summary → confirm. The ONLY input
// that differs is the phone step — Website asks for the number, WhatsApp
// auto-uses the sender's number (confirmed with "same").
function bookingInputs(channel) {
  const isWhatsApp = channel === "whatsapp";
  return [
    "AC", "It's not cooling", "no photo", "Ravi", "123 Main St, Downtown",
    isWhatsApp ? "same" : "9876543210",
    "today", "yes",
  ];
}

// Drive a customer through the full booking flow, returning the last reply and
// the resulting state (which has booking_id + status BOOKED).
async function completeBooking(cn, opts) {
  const inputs = bookingInputs(opts.channel || "whatsapp");
  let reply = "";
  for (const input of inputs) {
    reply = await handleMessage(cn, input, "text", null, opts);
  }
  assert.ok(reply.includes("Booking confirmed"), "flow must end with a confirmed booking");
  const st = await engine.loadState(cn);
  return { reply, state: st };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("ALL photo-skip variants continue the booking flow (never the fallback)", async () => {
  const variants = ["no photo", "No photo", "NO PHOTO", "skip", "skip photo", "no", "nope", "no picture"];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const cn = "web_skip_" + i;
    await saveState(cn, {
      status: STATUS.COLLECTING_PHOTO,
      appliance: "AC",
      issue: "not cooling",
      language: "en",
      channel: "website",
    });
    const reply = await handleMessage(cn, v, "text", null, webOpts());
    assert.notEqual(reply, FALLBACK, `"${v}" must NOT hit the fallback`);
    assert.equal(reply, ASK_NAME, `"${v}" should skip the photo and ask for the name`);
  }
});

test("website chat and whatsapp use IDENTICAL flow (only the phone question differs)", async () => {
  const wa = "wa_parity_test_1";
  const web = "web_parity_test_1";
  // Same conversation on both channels — the ONLY divergence is the phone step:
  // Website asks for the number, WhatsApp auto-uses the sender's number.
  const shared = ["AC", "It's not cooling", "no photo", "Ravi", "123 Main St, Downtown"];
  const waReplies = [];
  const webReplies = [];
  for (const input of [...shared, "same", "today", "yes"]) {
    waReplies.push(await handleMessage(wa, input, "text", null, { channel: "whatsapp" }));
  }
  for (const input of [...shared, "9876543210", "today", "yes"]) {
    webReplies.push(await handleMessage(web, input, "text", null, webOpts()));
  }

  // The first reply greets the customer AND continues the flow when the very
  // first message names an appliance — identical on both channels.
  assert.ok(waReplies[0].includes(WELCOME), "first reply includes the branded greeting");
  assert.ok(waReplies[0].includes(t("en").whatProblem({ appliance: "AC" })), "first reply continues the flow with the AC problem question");

  // Steps 1-3 (photo, name, address) must be byte-identical.
  assert.deepEqual(webReplies.slice(1, 4), waReplies.slice(1, 4), "issue/photo/name/address steps must EXACTLY match across channels");
  assert.equal(waReplies[1], ASK_PHOTO, "after the issue we ask for the optional photo");
  assert.equal(waReplies[2], ASK_NAME, "no photo at the photo step continues to the name");

  // The phone step is the ONLY intended difference between the two channels.
  assert.equal(waReplies[4], t("en").askPhoneWhatsApp(wa), "whatsapp auto-uses the sender number (changeable)");
  assert.equal(webReplies[4], ASK_PHONE, "website asks for the mobile number");

  // Steps after the phone step must match again (date → summary → confirm).
  assert.equal(webReplies[5], waReplies[5], "date step must match");
  assert.equal(waReplies[5], ASK_DATE, "after the phone step we ask for the service date");
  assert.ok(waReplies[6].includes("Booking Summary"), "summary shown before confirmation");
  assert.ok(webReplies[6].includes("Booking Summary"), "summary shown before confirmation");
  assert.ok(waReplies[6].includes("Reply YES"), "confirmation prompt uses YES/NO");
  assert.ok(webReplies[6].includes("Reply YES"), "confirmation prompt uses YES/NO");

  // Confirmation is identical modulo independent booking refs (#1 vs #2).
  const norm = (s) => String(s).replace(/#\d+/g, "#N");
  assert.equal(norm(webReplies[7]), norm(waReplies[7]), "confirmation must be identical (modulo independent booking refs)");
  assert.ok(waReplies[7].includes("Booking confirmed"), "yes at confirmation should create the booking");
});

test("image handling is shared: an image at the photo step advances identically", async () => {
  const wa = "wa_img_test";
  const web = "web_img_test";
  await saveState(wa, { status: STATUS.COLLECTING_PHOTO, appliance: "AC", issue: "not cooling", language: "en", channel: "whatsapp" });
  await saveState(web, { status: STATUS.COLLECTING_PHOTO, appliance: "AC", issue: "not cooling", language: "en", channel: "website" });
  const media = { id: "media-1", link: "https://cdn.example/x.jpg" };

  const waReply = await handleMessage(wa, "", "image", media, { channel: "whatsapp" });
  const webReply = await handleMessage(web, "", "image", media, webOpts());

  assert.equal(webReply, waReply, "image handling must be identical across channels");
  assert.ok(waReply.includes("Thanks for the photo"), "photo at the photo step should advance the flow");
});

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION REDESIGN — natural, human, no duplicate questions
// ═══════════════════════════════════════════════════════════════════════════

test("first message with appliance AND issue is handled in ONE turn (no duplicate questions)", async () => {
  const cn = "wa_first_msg";
  const reply = await handleMessage(cn, "My washing machine is not spinning", "text", null, { channel: "whatsapp" });
  assert.ok(reply.includes(WELCOME), "first reply greets the customer");
  assert.ok(reply.includes(t("en").issueMoreDetail), "empathetic follow-up asks for a little more detail");
  assert.ok(!reply.toLowerCase().includes("which appliance"), "must never re-ask the appliance");
  const st = await engine.loadState(cn);
  assert.equal(st.appliance, "Washing Machine", "appliance silently extracted from the first message");
  assert.ok(st.issue, "issue silently extracted from the same message");
  assert.equal(st.status, STATUS.COLLECTING_ISSUE, "asking for more detail — never a duplicate question");
});

test("appliance synonyms are recognized deterministically (no LLM needed)", async () => {
  const cases = [
    ["my fridge is not cooling", "Refrigerator"],
    ["split ac not working", "AC"],
    ["front load washer issue", "Washing Machine"],
    ["ro purifier", "RO"],
    ["smart tv", "TV"],
    ["water heater leaking", "Geyser"],
  ];
  for (const [msg, expected] of cases) {
    const cn = "syn_" + expected.replace(/\s+/g, "_").toLowerCase();
    await handleMessage(cn, msg, "text", null, { channel: "whatsapp" });
    const st = await engine.loadState(cn);
    assert.equal(st.appliance, expected, `"${msg}" should map to ${expected}`);
    assert.ok(st.status === STATUS.COLLECTING_ISSUE || st.status === STATUS.COLLECTING_PHOTO, "flow advanced past the appliance");
  }
});

test("whatsapp auto-fills the sender number and allows changing it", async () => {
  const cn = "919876543210";
  const inputs = ["AC", "It's not cooling", "no photo", "Ravi", "123 Main St, Downtown"];
  let reply = "";
  for (const input of inputs) {
    reply = await handleMessage(cn, input, "text", null, { channel: "whatsapp" });
  }
  assert.ok(reply.includes("919876543210"), "sender number auto-filled into the phone question");

  // The customer can swap the number instead of confirming it.
  reply = await handleMessage(cn, "9988776655", "text", null, { channel: "whatsapp" });
  const st = await engine.loadState(cn);
  assert.equal(st.customer_phone, "9988776655", "customer can change the WhatsApp number");
  assert.equal(st.status, STATUS.COLLECTING_DATE, "after the phone we ask for the service date");
});

test("customer phone is stored on the booking and in the summary", async () => {
  const cn = "web_phone_booking";
  const { state } = await completeBooking(cn, webOpts());
  const booking = db.bookings.find((b) => b.customer_number === cn);
  assert.equal(booking.customer_phone, "9876543210", "booking carries the customer phone");
  assert.equal(state.customer_phone, "9876543210", "state carries the customer phone");
  const summary = t("en").confirmBooking({ ...state, image_urls: [] });
  assert.ok(summary.includes("9876543210"), "booking summary shows the phone");
  assert.ok(summary.includes("Photo: Not Provided"), "summary reports the photo status");
});

test("human handoff is shared and identical across channels", async () => {
  const wa = "wa_handoff_test";
  const web = "web_handoff_test";
  await saveState(wa, { status: STATUS.COLLECTING_APPLIANCE, language: "en", channel: "whatsapp" });
  await saveState(web, { status: STATUS.COLLECTING_APPLIANCE, language: "en", channel: "website" });

  const waReply = await handleMessage(wa, "I want to talk to a human", "text", null, { channel: "whatsapp" });
  const webReply = await handleMessage(web, "I want to talk to a human", "text", null, webOpts());

  assert.equal(webReply, waReply, "handoff must be identical across channels");
  assert.equal(waReply, HUMAN_HANDOFF, "handoff request should transfer to the team");
});

// ═══════════════════════════════════════════════════════════════════════════
// ISSUE 2 — AFTER-BOOKING MODE & INTENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

test("PRICE enquiry after booking returns shop pricing (never restarts booking)", async () => {
  const cn = "wa_price_test";
  const { state } = await completeBooking(cn, { channel: "whatsapp" });
  assert.equal(state.status, STATUS.BOOKED, "state must be BOOKED after confirmation");

  // Shop has a visiting charge configured → the engine must return it.
  const { bookings } = db;
  const b = bookings.find((x) => x.customer_number === cn);
  b.estimated_cost = 499;

  const reply = await handleMessage(cn, "How much will it cost?", "text", null, { channel: "whatsapp" });
  assert.ok(reply.includes("499"), "should quote the booking's estimated cost");
  assert.ok(!reply.includes(WELCOME), "must NOT restart the booking flow");
  assert.ok(!reply.includes("Which appliance"), "must NEVER re-ask for the appliance");

  const stAfter = await engine.loadState(cn);
  assert.equal(stAfter.status, STATUS.BOOKED, "state must remain BOOKED — no restart");
});

test("PRICE enquiry with NO shop pricing explains inspection politely (never restarts)", async () => {
  const cn = "web_price_none_test";
  const { state } = await completeBooking(cn, webOpts());
  assert.equal(state.status, STATUS.BOOKED);

  // No estimated_cost, no shop settings (shopId null) → polite inspection reply.
  const reply = await handleMessage(cn, "how much for this repair?", "text", null, webOpts());
  assert.ok(!reply.includes("Which appliance"), "must NEVER re-ask for the appliance");
  assert.ok(!reply.includes("Welcome"), "must NEVER restart the booking");
  const stAfter = await engine.loadState(cn);
  assert.equal(stAfter.status, STATUS.BOOKED, "state must remain BOOKED");
});

test("BOOKING STATUS works after booking and is identical across channels", async () => {
  const wa = "wa_status_test";
  const web = "web_status_test";
  await completeBooking(wa, { channel: "whatsapp" });
  await completeBooking(web, webOpts());

  const waReply = await handleMessage(wa, "what is the status of my booking?", "text", null, { channel: "whatsapp" });
  const webReply = await handleMessage(web, "what is the status of my booking?", "text", null, webOpts());

  // Normalize the independent booking refs (#5 vs #6) — behavior must match.
  const norm = (s) => String(s).replace(/#\d+/g, "#N");
  assert.equal(norm(webReply), norm(waReply), "status replies must match across channels");
  assert.ok(waReply.includes("Booking Status"), "should include a status header");
  assert.ok(waReply.includes("#1") || waReply.includes("Ref"), "should reference the booking id");
});

test("CANCEL booking works — booking status flips to cancelled, state closes", async () => {
  const cn = "wa_cancel_test";
  const { state } = await completeBooking(cn, { channel: "whatsapp" });
  const bookingId = parseInt(state.booking_id, 10);

  const reply = await handleMessage(cn, "cancel my booking please", "text", null, { channel: "whatsapp" });
  assert.equal(reply, CANCELLED, "should confirm cancellation");

  const stAfter = await engine.loadState(cn);
  assert.equal(stAfter.status, STATUS.CANCELLED, "state should move to CANCELLED");
  const booking = db.bookings.find((b) => b.id === bookingId);
  assert.equal(booking.status, "cancelled", "booking row must be cancelled in the DB");
});

test("RESCHEDULE flow collects a new date and updates the booking", async () => {
  const cn = "wa_resched_test";
  const { state } = await completeBooking(cn, { channel: "whatsapp" });
  const bookingId = parseInt(state.booking_id, 10);

  const askReply = await handleMessage(cn, "can I reschedule?", "text", null, { channel: "whatsapp" });
  assert.ok(askReply.includes("reschedule"), "should ask for a new date");
  const mid = await engine.loadState(cn);
  assert.equal(mid.status, STATUS.RESCHEDULING, "should enter the RESCHEDULING sub-flow");

  const doneReply = await handleMessage(cn, "tomorrow morning", "text", null, { channel: "whatsapp" });
  assert.ok(doneReply.includes("rescheduled"), "should confirm the reschedule");

  const stAfter = await engine.loadState(cn);
  assert.equal(stAfter.status, STATUS.BOOKED, "should return to BOOKED after rescheduling");
  assert.equal(stAfter.urgency, "tomorrow morning", "state urgency should be updated");
  const booking = db.bookings.find((b) => b.id === bookingId);
  assert.equal(booking.urgency, "tomorrow morning", "booking row urgency must be persisted via modifyBooking");
});

test("AFTER-BOOKING general question never re-asks booking details", async () => {
  const cn = "wa_general_test";
  const { state } = await completeBooking(cn, { channel: "whatsapp" });

  const reply = await handleMessage(cn, "do you have a warranty?", "text", null, { channel: "whatsapp" });
  // The mocked LLM returns the fallback text for general questions; the key
  // assertion is that the flow does NOT restart and state stays BOOKED.
  const stAfter = await engine.loadState(cn);
  assert.equal(stAfter.status, STATUS.BOOKED, "state must stay BOOKED for general questions");
  assert.ok(stAfter.booking_id, "booking must still exist");
});

test("MODE_CLOSED: completed booking still answers support questions", async () => {
  const cn = "wa_closed_test";
  const { state } = await completeBooking(cn, { channel: "whatsapp" });
  const bookingId = parseInt(state.booking_id, 10);

  // Shop marks the booking completed → engine should enter MODE_CLOSED.
  const booking = db.bookings.find((b) => b.id === bookingId);
  booking.status = "completed";

  const reply = await handleMessage(cn, "is the repair under warranty?", "text", null, { channel: "whatsapp" });
  const stAfter = await engine.loadState(cn);
  assert.equal(stAfter.status, STATUS.BOOKED, "state stays BOOKED; mode is derived");
  // MODE_CLOSED must still answer (never restart).
  assert.ok(!reply.includes(WELCOME), "must not restart the booking from a closed booking");
});

// ═══════════════════════════════════════════════════════════════════════════
// ISSUE 1 — NO DUPLICATE AI RESPONSES
// ═══════════════════════════════════════════════════════════════════════════

test("isDuplicateRequest suppresses the same message twice (both channels)", async () => {
  // WhatsApp: dedupe by provider message id.
  const waFirst = await isDuplicateRequest({
    channel: "whatsapp", customerNumber: "wa_dup_1", text: "hello", messageType: "text",
    externalId: "wamid.ABC123", requestId: "t1",
  });
  const waSecond = await isDuplicateRequest({
    channel: "whatsapp", customerNumber: "wa_dup_1", text: "hello", messageType: "text",
    externalId: "wamid.ABC123", requestId: "t2",
  });
  assert.equal(waFirst, false, "first delivery must NOT be suppressed");
  assert.equal(waSecond, true, "redelivery of the same message id MUST be suppressed");

  // Website: dedupe by identical text from the same visitor.
  const webFirst = await isDuplicateRequest({
    channel: "website", customerNumber: "web_dup_1", text: "AC", messageType: "text",
    externalId: null, requestId: "t3",
  });
  const webSecond = await isDuplicateRequest({
    channel: "website", customerNumber: "web_dup_1", text: "AC", messageType: "text",
    externalId: null, requestId: "t4",
  });
  assert.equal(webFirst, false, "first website message must NOT be suppressed");
  assert.equal(webSecond, true, "double-submitted identical text MUST be suppressed");
});

test("different customers / different texts are never suppressed", async () => {
  const a = await isDuplicateRequest({ channel: "website", customerNumber: "web_ok_1", text: "AC", messageType: "text" });
  const b = await isDuplicateRequest({ channel: "website", customerNumber: "web_ok_2", text: "AC", messageType: "text" });
  const c = await isDuplicateRequest({ channel: "website", customerNumber: "web_ok_1", text: "Fridge", messageType: "text" });
  assert.equal(a, false);
  assert.equal(b, false, "same text, different visitor → not a duplicate");
  assert.equal(c, false, "different text, same visitor → not a duplicate");
});

test("confirming twice cannot create two bookings (no double processing)", async () => {
  const cn = "wa_one_reply_test";
  const inputs = bookingInputs("whatsapp");
  for (const input of inputs) {
    await handleMessage(cn, input, "text", null, { channel: "whatsapp" });
  }
  const before = db.bookings.filter((b) => b.customer_number === cn).length;
  assert.equal(before, 1, "confirmation must create exactly one booking");

  // Redeliver the same confirmation (webhook retry / double-submit). The state
  // machine is already in MODE_AFTER_BOOKING, so this can never create a second
  // booking — and the shared isDuplicateRequest guard drops the duplicate before
  // the engine even runs.
  await handleMessage(cn, "yes", "text", null, { channel: "whatsapp" });
  const after = db.bookings.filter((b) => b.customer_number === cn).length;
  assert.equal(after, 1, "re-sending the confirmation must NOT create a second booking");
  const st = await engine.loadState(cn);
  assert.equal(st.status, STATUS.BOOKED, "state remains BOOKED");
});

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD DATA FLOW — both bots must write the SAME rows the dashboard reads
// ═══════════════════════════════════════════════════════════════════════════
// The dashboard reads three tables:
//   bookings                    → bookings list, stats, revenue
//   whatsapp_conversations      → “WhatsApp Logs” page + WhatsApp Status
//   conversation_analytics      → Conversation Analytics page (totals)
//   shop_notifications          → bell icon
// WhatsApp previously wrote ONLY bookings — it never logged conversations, so
// WhatsApp chats were invisible in WhatsApp Logs + analytics. Both channels
// must now write identical dashboard rows (the shared engine helpers do this).

// Simulate exactly what each channel front-end does per message:
//   saveMessage → logDashboardConversation → handleMessage → saveMessage →
//   logDashboardConversation → trackConversationFirstMessage
// (The front-ends are thin: everything shared lives in the engine helpers.)
async function driveChannelMessage(cn, channel, shopId, text, messageType = "text", mediaData = null) {
  const inboundLabel = text || (messageType === "image" ? "(sent an image)" : messageType === "document" ? "(sent a file)" : "");
  const savedIn = await engine.saveMessage(cn, "customer", inboundLabel, channel);
  await engine.logDashboardConversation(shopId, cn, "inbound", inboundLabel, channel, "req-" + cn);
  // First-message tracking BEFORE the bot reply is stored (matches both front-ends)
  await engine.trackConversationFirstMessage(shopId, cn, channel, savedIn?.id ?? 0, "req-" + cn);
  const reply = await handleMessage(cn, text, messageType, mediaData, { channel, shopId });
  await engine.saveMessage(cn, "bot", reply, channel);
  await engine.logDashboardConversation(shopId, cn, "outbound", reply, channel, "req-" + cn);
  return reply;
}

test("DASHBOARD: whatsapp bot writes bookings + WhatsApp Logs + analytics + notification", async () => {
  const cn = "wa_dash_test";
  const shopId = 555;
  const inputs = bookingInputs("whatsapp");
  for (const input of inputs) {
    await driveChannelMessage(cn, "whatsapp", shopId, input);
  }

  // bookings — the dashboard's booking list + stats
  const booking = db.bookings.find((b) => b.customer_number === cn);
  assert.ok(booking, "whatsapp booking must land in the bookings table");
  assert.equal(booking.repair_shop_id, shopId, "booking must be scoped to the shop");
  assert.equal(booking.source, "whatsapp", "booking source must be whatsapp");
  assert.ok(booking.customer_name && booking.service_type, "booking carries customer + appliance");

  // whatsapp_conversations — the “WhatsApp Logs” page
  const logs = db.waLogs.filter((l) => l.customer_number === cn);
  assert.ok(logs.length >= 16, "every inbound+outbound message must be logged (got " + logs.length + ")");
  assert.ok(logs.some((l) => l.direction === "inbound" && l.channel === "whatsapp"), "inbound rows logged with channel=whatsapp");
  assert.ok(logs.some((l) => l.direction === "outbound" && l.channel === "whatsapp"), "outbound rows logged with channel=whatsapp");
  assert.ok(logs.every((l) => l.repair_shop_id === shopId), "all log rows scoped to the shop");

  // conversation_analytics — total count + booking completion
  const a = db.analytics.find((x) => x.repair_shop_id === shopId);
  assert.ok(a, "analytics row must exist for the shop");
  assert.ok(a.total_conversations >= 1, "whatsapp conversation must be counted once");
  assert.ok(a.booking_completed >= 1, "booking completion must be tracked");

  // shop_notifications — bell icon (new conversation alert)
  const n = db.notifications.find((x) => x.repair_shop_id === shopId);
  assert.ok(n, "shop must be notified of the new whatsapp conversation");
  assert.equal(n.type, "whatsapp_chat");
});

test("DASHBOARD: website bot writes the SAME rows with channel=website", async () => {
  const cn = "web_dash_test";
  const shopId = 777;
  const inputs = bookingInputs("website");
  for (const input of inputs) {
    await driveChannelMessage(cn, "website", shopId, input);
  }

  const booking = db.bookings.find((b) => b.customer_number === cn);
  assert.ok(booking, "website booking must land in the bookings table");
  assert.equal(booking.repair_shop_id, shopId);
  assert.equal(booking.source, "website", "booking source must be website");

  const logs = db.waLogs.filter((l) => l.customer_number === cn);
  assert.ok(logs.length >= 16, "every inbound+outbound message must be logged (got " + logs.length + ")");
  assert.ok(logs.some((l) => l.direction === "inbound" && l.channel === "website"));
  assert.ok(logs.some((l) => l.direction === "outbound" && l.channel === "website"));
  assert.ok(logs.every((l) => l.repair_shop_id === shopId));

  const a = db.analytics.find((x) => x.repair_shop_id === shopId);
  assert.ok(a, "analytics row must exist");
  assert.ok(a.total_conversations >= 1);
  assert.ok(a.booking_completed >= 1);

  const n = db.notifications.find((x) => x.repair_shop_id === shopId);
  assert.ok(n, "shop must be notified of the new website conversation");
  assert.equal(n.type, "website_chat");
});

test("DASHBOARD: whatsapp and website produce IDENTICAL dashboard data shape", async () => {
  const wa = "wa_dash_parity";
  const web = "web_dash_parity";
  // Same 8-message flow on each channel; only the phone input differs.
  for (const input of bookingInputs("whatsapp")) {
    await driveChannelMessage(wa, "whatsapp", 1001, input);
  }
  for (const input of bookingInputs("website")) {
    await driveChannelMessage(web, "website", 1002, input);
  }

  // Same number of conversation-log rows (9 inbound + 9 outbound each)
  const waLogs = db.waLogs.filter((l) => l.customer_number === wa);
  const webLogs = db.waLogs.filter((l) => l.customer_number === web);
  assert.equal(waLogs.length, webLogs.length, "both channels must log the same number of dashboard rows");
  assert.equal(waLogs.filter((l) => l.direction === "inbound").length, webLogs.filter((l) => l.direction === "inbound").length);
  assert.equal(waLogs.filter((l) => l.direction === "outbound").length, webLogs.filter((l) => l.direction === "outbound").length);

  // Same analytics counters (one conversation + one booking per channel)
  const waA = db.analytics.find((x) => x.repair_shop_id === 1001);
  const webA = db.analytics.find((x) => x.repair_shop_id === 1002);
  assert.ok(waA && webA, "both channels must have analytics rows");
  assert.equal(waA.total_conversations, webA.total_conversations);
  assert.equal(waA.booking_completed, webA.booking_completed);

  // Both channels send exactly one notification each
  assert.equal(db.notifications.filter((x) => x.repair_shop_id === 1001).length, 1);
  assert.equal(db.notifications.filter((x) => x.repair_shop_id === 1002).length, 1);
});

test("DASHBOARD: human handoff writes human_handoff analytics + notification", async () => {
  const cn = "wa_handoff_dash";
  const shopId = 888;
  const inputs = bookingInputs("whatsapp");
  for (const input of inputs) {
    await driveChannelMessage(cn, "whatsapp", shopId, input);
  }
  const reply = await driveChannelMessage(cn, "whatsapp", shopId, "I want to talk to a human");
  assert.equal(reply, HUMAN_HANDOFF);

  const a = db.analytics.find((x) => x.repair_shop_id === shopId);
  assert.ok(a, "analytics row must exist");
  assert.ok(a.human_handoff >= 1, "handoff must increment human_handoff analytics");
  assert.ok(
    db.notifications.some((x) => x.repair_shop_id === shopId && x.type === "human_handoff"),
    "shop must get a human-handoff notification"
  );
});
