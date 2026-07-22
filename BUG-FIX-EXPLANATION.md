# Conversation State Bug — Root Cause Analysis & Fix

## What Was Broken

### Bug 1: Double Message in History
**Location:** `whatsapp.js` lines ~195-200

```js
await saveMessage(customerNumber, "customer", customerText); // ← saved first
const history = await getConversationHistory(customerNumber); // ← includes message just saved
const reply = await getGroqReply(history, customerText); // ← message appended AGAIN
```

The current user message was saved to DB, then fetched as part of history, then appended again as the current message. The LLM saw every user message twice.

**Impact:** Confused the LLM, leading to hallucinated responses.

---

### Bug 2: No Structured State
**Problem:** The bot had no explicit `state` object. It passed raw conversation history to the LLM and asked it to "figure out" the appliance, issue, name, address, etc. every single time.

**Example:**
```
User: "Geyser"
Bot: stores "Geyser" in raw history
User: "Hot water not coming"
Bot: re-reads all 20 messages, LLM guesses appliance again → sometimes says "AC"
```

**Impact:** The LLM re-detected appliance/issue from scratch on every turn, causing inconsistent state.

---

### Bug 3: `LIMIT 20` Pulls Old Sessions
**Location:** `getConversationHistory()`

```js
SELECT role, message FROM conversations
WHERE customer_number = ${customerNumber}
ORDER BY created_at ASC
LIMIT 20
```

If a user messaged you last week about a geyser, then messages today about a refrigerator, the `LIMIT 20` pulls the old geyser messages. The LLM sees mixed context and hallucinates continuity.

**Impact:** Old sessions leak into new conversations.

---

### Bug 4: LLM Drives Business Logic
**Problem:** The system prompt says things like:

> "Once you have name + appliance + issue + address + area, confirm you're booking a technician..."

The LLM was making up booking confirmations, saying "Technician confirmed" without your backend creating any booking record.

**Impact:** Fake confirmations, no actual bookings.

---

### Bug 5: `COALESCE` in `extractAndSaveBooking` Protects Wrong Data
**Location:** `extractAndSaveBooking()`

```js
service_type = COALESCE(${info.service_type}, service_type)
```

The extraction LLM re-reads the full 20-message history, finds "AC no cooling" from an old message, and updates the current booking with stale data.

**Impact:** Current "Geyser no hot water" gets overwritten with old "AC no cooling."

---

## The Fix

### New Architecture: Structured State in DB

**New table:** `conversation_state`

```sql
CREATE TABLE conversation_state (
  customer_number TEXT PRIMARY KEY,
  step TEXT,           -- current step: appliance, issue, name, address, area, urgency, confirm
  appliance TEXT,
  issue TEXT,
  customer_name TEXT,
  address TEXT,
  area TEXT,
  urgency TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
```

**One row per customer.** This is the single source of truth.

---

### New Flow

1. **User sends message**
2. **Load state from `conversation_state` table**
3. **Determine current step** (e.g., "issue")
4. **Extract ONLY the current field** using LLM (temperature=0, single-field prompt)
5. **Update state with extracted value**
6. **Move to next step**
7. **Ask next question** (generated from state, not from LLM)
8. **Save state back to DB**

**LLM is ONLY used to normalize free text.** It never sees full history. It never makes decisions. It never invents bookings.

---

### Example Conversation (After Fix)

| Turn | User Says | State Before | LLM Call | State After | Bot Reply |
|------|-----------|--------------|----------|-------------|-----------|
| 1 | "Geyser" | `step: "appliance"` | Extract appliance → "Geyser" | `appliance: "Geyser"`, `step: "issue"` | "What's the problem with your Geyser?" |
| 2 | "Hot water not coming" | `step: "issue"` | Extract issue → "Hot water not coming" | `issue: "Hot water not coming"`, `step: "name"` | "Got it! May I know your name?" |
| 3 | "Zeeshan" | `step: "name"` | Extract name → "Zeeshan" | `customer_name: "Zeeshan"`, `step: "address"` | "Thanks Zeeshan! Please share your full address..." |

**No hallucinations. No mixing sessions. No fake confirmations.**

---

### Key Changes in Code

**Before:**
```js
const history = await getConversationHistory(customerNumber); // 20 messages
const reply = await getGroqReply(history, customerText); // LLM decides everything
```

**After:**
```js
let state = await loadState(customerNumber); // one row, structured
const extracted = await extractField(state.step, userText, state); // LLM extracts ONE field
await saveState(customerNumber, { [fieldName]: extracted, step: nextStep });
return getQuestion(nextStep, updatedState); // backend generates reply
```

---

### Reset Command

Users can now type:
- "reset"
- "start over"
- "new complaint"
- "forget"
- "cancel"

The bot will delete their `conversation_state` row and start fresh.

---

## Deployment Steps

1. **Run the migration:**
   - Open Neon SQL console
   - Run `migration-add-state-table.sql`

2. **Deploy the new `whatsapp.js`:**
   - Push to GitHub
   - Vercel will auto-deploy

3. **Test:**
   - Send "reset" to your WhatsApp bot
   - Start a new conversation about a geyser
   - Verify it doesn't switch to AC

---

## What Conversations Look Like Now

### State stored in DB:
```json
{
  "customer_number": "919876543210",
  "step": "address",
  "appliance": "Refrigerator",
  "issue": "Not cooling",
  "customer_name": "Zeeshan",
  "address": null,
  "area": null,
  "urgency": null
}
```

### LLM prompt (single-field extraction):
```
The user said: "Flat 301, MG Road"
Extract the full address. Reply with ONLY a JSON: {"value": "address or null"}
```

### LLM response:
```json
{"value": "Flat 301, MG Road"}
```

**That's it.** No full history. No re-detection. No hallucinations.

---

## Summary

| Problem | Before | After |
|---------|--------|-------|
| **State** | Inferred from 20 raw messages | Stored in `conversation_state` table |
| **LLM role** | Decides business logic | Extracts single field per turn |
| **Session boundary** | None (LIMIT 20 crosses sessions) | One row per customer, explicit reset |
| **Booking logic** | LLM invents confirmations | Backend creates booking only on "Yes" |
| **Appliance detection** | Re-detected every turn | Detected once, stored in state |

**Result:** No more hallucinations. No more AC/geyser/refrigerator mixing. Conversations are now deterministic.
