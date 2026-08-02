// scripts/test-chat-parity.js
// ─────────────────────────────────────────────────────────────────────────────
// Automated parity tests: Website Chat vs WhatsApp MUST behave identically
// because both channels run the SAME engine (api/_lib/conversation-engine.js).
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
  const bookingSeq = new Map(); // customer_number -> next booking id (per-customer, like the real DB)

  function nowIso() {
    return new Date().toISOString();
  }

  // Tagged-template neon client: `sql`SELECT ... WHERE x = ${v}``
  function sql(strings, ...values) {
    const parts = [];
    for (let i = 0; i < strings.length; i++) {
      parts.push(strings[i]);
      if (i < values.length) parts.push("$" + (i + 1));
    }
    const query = parts.join("");
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
    if (lower.includes("from conversations")) {
      return Promise.resolve(conversations.filter((c) => c.customer_number === values[0]));
    }
    if (lower.includes("insert into bookings")) {
      const cn = values[0];
      const id = (bookingSeq.get(cn) || 0) + 1;
      bookingSeq.set(cn, id);
      return Promise.resolve([{ id }]);
    }
    if (lower.includes("from technicians")) {
      return Promise.resolve([]); // no technicians configured -> booking stays 'open'
    }
    // Anything else the engine asks — resolve empty so it can continue.
    return Promise.resolve([]);
  }

  return { sql, state, conversations };
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
function fakeIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (/^(yes|yeah|yep|confirm|ok|okay|sure)$/.test(t)) return "confirm_yes";
  if (/^(no|nope|cancel)$/.test(t)) return "confirm_no";
  if (t.includes("cancel")) return "cancel_booking";
  if (t.includes("new booking") || t.includes("book another")) return "new_booking";
  if (t === "status" || t.startsWith("status")) return "view_status";
  if (t.includes("thank")) return "thanks";
  if (t.includes("change") || t.includes("modify") || t.includes("update")) return "modify_booking";
  if (t.includes("human") || t.includes("agent") || t.includes("person") || t.includes("support")) return "human_handoff";
  return "answer_field";
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
  if (prompt.includes("Extract appliance")) return jsonResponse({ value: "AC" });
  if (prompt.includes("Extract issue")) return jsonResponse({ value: "not cooling" });
  if (prompt.includes("Extract full address")) return jsonResponse({ value: "123 Main St" });
  if (prompt.includes("Extract area/locality")) return jsonResponse({ value: "Downtown" });
  if (prompt.includes("Extract service date preference")) return jsonResponse({ value: "today" });
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
const { handleMessage, saveState, STATUS, t } = engine;

const ASK_PHOTO = t("en").askPhoto;
const ASK_NAME = t("en").askName;
const WELCOME = t("en").welcome;
const FALLBACK = t("en").fallback;
const HUMAN_HANDOFF = t("en").humanHandoff;

function webOpts() {
  return { channel: "website", shopId: null }; // shopId null => no branding/shop-specific branches
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

test("website chat and whatsapp produce IDENTICAL replies for the same inputs", async () => {
  const wa = "wa_parity_test_1";
  const web = "web_parity_test_1";
  // NOTE: the engine consumes one field per turn, and the very first message
  // only starts the session (it returns the welcome). The photo step also
  // consumes one turn before the name step, so the sequence below matches the
  // real state machine 1:1.
  const inputs = ["AC", "It's not cooling", "not cooling", "no photo", "Ravi", "123 Main St", "Downtown", "today", "yes"];

  const waReplies = [];
  const webReplies = [];
  for (const input of inputs) {
    waReplies.push(await handleMessage(wa, input, "text", null, { channel: "whatsapp" }));
    webReplies.push(await handleMessage(web, input, "text", null, webOpts()));
  }

  assert.deepEqual(webReplies, waReplies, "website replies must EXACTLY match whatsapp replies");

  // Spot-check the booking flow actually progressed (not fallback-everywhere).
  assert.equal(waReplies[0], WELCOME, "first message should be the welcome");
  assert.equal(waReplies[1], t("en").whatProblem({ appliance: "AC" }), "second should ask the issue");
  assert.equal(waReplies[2], ASK_PHOTO, "third should ask for the optional photo");
  assert.equal(waReplies[3], ASK_NAME, "no photo at the photo step continues to the name");
  assert.ok(waReplies[8].includes("Booking confirmed"), "yes at confirmation should create the booking");
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
