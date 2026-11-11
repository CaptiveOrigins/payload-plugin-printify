# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md` "Test self-audits". Newest first.

## 2026-11-11: real-database tests

Suite: 50 → 74 tests in 5 files. The new file, `test/real-db.test.ts` (22 tests), runs a real Payload 3.92.1 with the official ecommerce plugin and, for tenancy, the official multi-tenant plugin. It uses an in-memory MongoDB 8.2 replica set (`mongodb-memory-server`, `ensureIndexes: true`) and requests go through `handleEndpoints`. Printify is still a fake `fetch`, and nothing reaches it. Products come in through the plugin's own sync. Orders are created through the Local API with made-up data. New dev dependencies, exact-pinned: `@payloadcms/db-mongodb`, `@payloadcms/plugin-ecommerce` and `@payloadcms/plugin-multi-tenant` at 3.92.1, and `mongodb-memory-server` 11.3.0.

### Bugs found and fixed

- **Duplicate paid orders without database transactions.** Payload turns transactions off on any MongoDB that isn't a replica set, for example a plain `mongodb://localhost` server. If two saves paid the same order at once, both saw it unpaid and both sent it to Printify. With a replica set, MongoDB's write conflict stopped the second save, so the bug only appeared once the test turned transactions off. Fix (`src/orders.ts`): just before the create, `sendPaidOrder` claims the send in one conditional write (`payload.db.updateOne`), and the claim only succeeds when the order has no Printify id and isn't already `unknown`. The claim marks the order `unknown`, so if the process stops mid-send, the order is left in the honest state, and settling handles it as before. If the claim fails, nothing is sent. The fakes were updated for the new write.
- **A webhook could write one store's order data onto another store's order.** The order webhook looked up `fulfillment.externalId` across every tenant. If a store B order carried the same Printify id (that field is read-only only in the admin UI), Printify's events for store A's order went to B's order. B got A's status and tracking, and A's order stopped updating. Fix (`src/webhook.ts`): both of the webhook's order lookups are now scoped to the store tenant.

### Proven on the real database

| Promise | Test (`real-db.test.ts`) |
| --- | --- |
| A paid order is sent once with the synced Printify ids and recorded; re-saves send nothing | "sends a paid order to Printify once…" |
| Two saves that pay an order at once send it once, with transactions (5 rounds) and without them (5 rounds, 2 or 3 saves) | "sends a paid order exactly once when two saves…race", "…two or three saves…race" |
| An order created already paid and re-saved at the same time is sent once | "sends an order created paid exactly once…" |
| While the create is out, the order reads `unknown` | "shows the order as unknown while the create is out…" |
| A 5xx marks the order `unknown`, and no re-save or re-payment (including racing ones) sends it again | "marks an order unknown on a 5xx…" |
| A 4xx marks the order `failed` | "marks an order failed on a 4xx…" |
| Two resends at once: one 200, one 409, one create (Local API ×3 rounds, endpoint, and without transactions) | "lets exactly one of two resends at once win…" (×3) |
| A resend racing a "sent": one wins, and the result is consistent | `lets only one of a resend and a "sent" at once win` |
| "sent" records the id (trimmed) without calling Printify, and can't be repeated or followed by a resend | `records the Printify id for "sent"…` |
| Signed out, customers and staff without `access.manage` get 403, with no read of Printify and no write | "refuses anyone but staff with access…" |
| Sent, failed, unpaid, canceled and missing orders get 409; bad bodies get 400 | "refuses orders that are not unknown…" |
| A signed order event updates only the order with that Printify id | "copies a signed order event…" |
| An `unknown` order is settled by `external_id`, once, even with two events at once | "settles an unknown order by external_id, once" |
| An `external_id` that isn't an unknown order, isn't an ObjectId, or is missing changes nothing | "leaves orders alone…" |
| Unsigned, empty, wrong-secret, bare-hex and tampered-body events get 401 before any Printify call | "refuses unsigned…" |
| Sync writes into the owning store only | "syncs into the owning store only" |
| Store B's paid orders are never sent, even after a resend | "sends store A's paid orders, and never store B's" |
| Webhooks settle by `external_id` only in store A, and with nothing unknown in store A they make no Printify call | "settles an unknown order by external_id only in store A" |
| An event for store A's order never touches a store B order with the same Printify id | "copies an order event onto store A's order only…" |

Two fake tests were added in `orders.test.ts`: the claim's exact condition, and "sends nothing when another save claimed the send first".

Flakiness: the full suite passed 8 times in a row after one harness fix. With the multi-tenant plugin, an order create's first commands in a transaction are two relationship checks at once, and MongoDB sometimes refused the second under load ("does not match any in-progress transactions"). That's a Payload and driver quirk. The test helper creates orders with `disableTransaction: true`; paying an order, which is an update, keeps its transaction.

### Mutation check

16 guards were changed one at a time with a Python string replace, the full suite run, and each file restored byte for byte (hash checked). None survived:

- the webhook's order lookup unscoped, which undoes the fix (1 failed, the twin-id tenancy test);
- the webhook's unknown-order pre-check unscoped (1);
- a lost send claim still sends (2, including the no-transactions race);
- the claim without its `unknown` condition (2);
- the claim without its no-Printify-id condition (1);
- the hook's previous-status guard removed (1);
- the hook's `unknown` guard removed (3);
- a 5xx treated as a refusal (13);
- a 4xx treated as unknown (4);
- the settle claim ignores `unknown` (14);
- a lost settle claim treated as won (6);
- a resend of an unpaid order (2);
- a truthy access result passes (1);
- the webhook settle ignores the tenant (1);
- no signature check (4);
- another store's order sent (2).

Two of these are caught only by fakes. Dropping the claim's no-Printify-id condition is caught by the test of the claim's exact `where`; on the real database it would only matter for a third save reading a stale order, which is too timing-dependent to test reliably. Dropping the hook's `unknown` guard is caught by the fake tests, because on the real database the claim's own `unknown` condition still stops the send.

### Gaps skipped

- Postgres and SQLite. They aren't installed here. On Postgres the send claim should hold, because a conditional `UPDATE` rechecks its `WHERE` after a row lock, but that hasn't been tested.
- If a host's own hook throws after this plugin's hook in the same transaction, the save rolls back, along with the record of a create that Printify already received. A later payment would send the order again. This plugin can't prevent that, because it doesn't control other hooks. Noted for the lead.
- Product sync on the real database is exercised (every test stocks products through it), but slug clashes and variant updates aren't asserted yet.
- `settleUnknownOrder` isn't scoped by tenant. It trusts `access.manage`, and store B's orders are never sent anyway (proven above). A host that gives store-level staff `access.manage` should check the tenant itself.

## 2026-11-11: settling orders with an unknown outcome

Suite: 37 → 50 tests in 4 files (`test/settle.test.ts` is new). All against a fake `fetch` and a fake Payload; nothing reaches Printify.

**Closed: the two items left open on 2026-11-10.** An `unknown` order could only be cleared with the Local API or a database edit, and the order webhook couldn't settle one by `external_id`.

- `settleUnknownOrder(payload, { order, outcome: 'sent' | 'resend', printifyId?, req })`, also as `POST /api/printify/orders/:id/settle`. `'sent'` records the Printify id with status `submitted`; `'resend'` clears the unknown state and sends the order once, through the same code as the paid-order hook (now `sendPaidOrder`).
- New option `access.manage`. Only an exact `true` passes; a query, a truthy value, an error or no option at all is a refusal.
- The claim is a conditional write: `payload.db.updateOne` with `fulfillment.status: 'unknown'` in `where`, so of two callers one wins. `'resend'` also requires the order to still be paid (`status: processing`) and Printify to be on.
- A signed order event that doesn't match an order by Printify id now settles an `unknown` order whose id is the Printify order's `external_id` (in this store only). It looks for an `unknown` order first, so other events cost no Printify call.
- Schema: none. Only the admin description of `fulfillment.status` changed.

### Promises and the tests that prove them

| Promise | Test |
| --- | --- |
| Only exact `true` from `access.manage` may settle: wrong role, signed out, no option, a query, truthy values and a throwing check are refused before any read or write | `settle.test.ts` "refuses anyone the manage access does not answer exactly true for…" |
| Orders that aren't `unknown` (failed, sent, held, none) or don't exist are refused | "refuses orders that are not unknown, and missing orders" |
| `'sent'` needs a Printify id (blank refused); a wrong outcome is refused | `refuses "sent" without the Printify order id…` |
| No resend for an order no longer paid, or with Printify off | "refuses to resend an order that is no longer paid…" |
| `'sent'` records the id, calls nothing, and can't be done twice | `"sent" records the Printify id as submitted…` |
| `'resend'` sends exactly once; neither staff nor the hook sends it again | `"resend" sends the order exactly once…` |
| Two resends at once: one winner, one Printify create | "lets only one of two resends at once win" |
| A resend and a `'sent'` at once: one winner | `lets only one of a resend and a "sent" at once win` |
| The endpoint answers 403, 400 (incl. a body that isn't JSON), 409 and 200 | "answers over the endpoint…" |
| A signed order event settles the `unknown` order named by `external_id` | `client-webhook.test.ts` "is settled by a signed order event…" |
| Unsigned events, another order's `external_id`, no `external_id`, and orders that aren't `unknown` are left alone | "is left alone when…" |
| Only this store's order is settled | "is settled only in its own store" |
| No extra Printify call when nothing is `unknown` | "costs no Printify call when no order is unknown" |

Mutation check, 15 guards, each changed with a Python string replace and restored byte for byte (hash checked): truthy access passes (1 test failed), no `access.manage` allows (1), a throwing access check allows (1), outcome validation removed (1), `printifyId` requirement removed (2), resend with Printify off (1), resend of an unpaid order (1), claim ignores the `unknown` status (6), write not conditional (2), lost claim treated as won (2), webhook ignores the tenant (1), webhook without `external_id` (1), webhook always fetches (1), webhook doesn't settle (2), the hook's `unknown` guard removed (3). None survived.

### Gaps skipped

- A real database. The race is proven against a fake whose conditional write is one step. MongoDB's adapter does `findOneAndUpdate` with the full `where`, which is atomic; the SQL adapters weren't checked (not installed here). The `external_id` test's fake treats an undefined constraint as matching everything, the worst case, so the guard against it is tested.
- An admin button. The endpoint is the admin's way in for now.
- Checking that a `'sent'` Printify id exists in Printify, or isn't on another order: staff just looked it up, and the next order webhook overwrites the status.

## 2026-11-10: the lead's fixes after the first audit

Suite: 30 → 37 tests in 3 files. All against a fake `fetch` and a fake Payload; nothing reaches Printify.

**Fixed: possible duplicate paid orders.** The client retried every 5xx, including `POST /orders.json`, so a 502 sent after Printify had created the order made a second one.

- The client now retries server errors only for reads (`GET`, `HEAD`). Creating an order is never retried, not even on 429.
- A create that fails with a 5xx, a timeout, a network error or an unreadable answer is recorded as `fulfillment.status: 'unknown'`, with "Outcome unknown, check Printify before sending again" and the order id. The paid-order hook skips any order in that state, so nothing sends it again until someone clears it.
- A 4xx is still `failed`: Printify refused it, so nothing was created.
- Found on the way: if sending to production failed after the order was created, the Printify id was dropped. It is now kept, so the order can't be created twice.
- Idempotency: the order id was already sent as `external_id`. Nothing in this repo documents whether Printify refuses a repeated `external_id`, so the fix relies only on not retrying.

Tests: "never retries creating an order, on a 5xx or a 429", "retries a read after a 5xx" (`client-webhook.test.ts`); "sends a 5xx / timeout / network error create once, marks it unknown, and never resends it", "still records a refused create (4xx) as failed", "keeps the Printify id when … sending to production failed" (`orders.test.ts`).

Mutation check: putting back the old retry condition fails 3 tests; removing the hook's `unknown` guard fails 3; treating every error as a refusal fails 3. Each file was restored byte for byte.

Still open: `fulfillment.status` is read-only in the admin, so clearing an `unknown` order takes the Local API or a database edit. The order webhook matches only `fulfillment.externalId`, so it can't settle an `unknown` order by `external_id` on its own.

## 2026-11-10: first audit

Suite before: 11 tests in 1 file. After: 30 tests in 3 files. Every test uses a fake `fetch` and, where Payload is needed, a small in-memory fake. Nothing reaches Printify.

The biggest gap was money: the paid-order hook had no tests at all. It now has seven.

### Promises and the tests that prove them

| Promise (README, code docs) | Test |
| --- | --- |
| Products map to the store: enabled variants, used options, plain-text description, cents, default image first, hidden → draft | `plugin.test.ts` "mapping" |
| Shop sync is read-only on Printify; hidden products import as drafts; products gone from Printify become drafts | `client-webhook.test.ts` "only reads from Printify…" (added) |
| Products deleted in Printify become drafts, kept for order history | "turns a product deleted in Printify into a draft…" (added) |
| API channel: a failed publish is reported back to Printify | "tells Printify when publishing fails…" (added) |
| Webhook accepts only a valid HMAC signature | `plugin.test.ts` "accepts only correctly signed bodies", "rejects unsigned requests with 401" |
| Webhook refuses a wrong secret, no secret configured, or a turned-off plugin, before any read or write | "refuses wrong signatures, a missing secret…" (added) |
| Webhook refuses when the store tenant is unknown | "refuses events when the store tenant is unknown" (added) |
| Order and shipment events update `fulfillment` on the matching order only | "copies order status and tracking…" (added) |
| A paid order is sent once, with only its Printify items, waiting for approval | `orders.test.ts` "sends a paid order once…" (added) |
| `sendToProduction` sends to production; otherwise not | "sends to production only when asked" (added) |
| Unpaid, already-sent, re-saved, sync-written orders, a turned-off plugin and orders without Printify items are never sent | "never sends unpaid, already-sent…" (added) |
| Another tenant's order, or an unknown tenant, is never sent | "never sends another store's order…" (added) |
| The guard (`beforePrintifyWrite`) holds an order without calling Printify | "holds the order when the guard blocks it…" (added) |
| A refused order is recorded on the order, not thrown; logs carry no token or address | "records a refused order…" (added) |
| Price push sends every variant with one price changed | `plugin.test.ts` "sends every variant…" |
| Price push refused by the guard or a locked product; skipped for sync writes, unchanged prices, push off | `plugin.test.ts` "price push" |
| Prices must be whole cents above zero | "refuses prices that are not whole cents…" (added) |
| Price refused when Printify errors or the variant is gone | "refuses a price when Printify errors…" (added) |
| Visibility push publishes and unpublishes; "Save draft" doesn't; refused by guard or lock | `plugin.test.ts` "visibility push" |
| Visibility refused when Printify errors | "refuses a visibility change when Printify errors" (added) |
| The token goes only in the bearer header to api.printify.com; errors don't include it | `client-webhook.test.ts` "client" (added) |
| The client retries 429 | "retries rate limits…" (added) |
| Webhook registration replaces only this host's webhooks; refuses without a secret | "replaces only this host's webhooks…" (added) |
| Plugin adds fields, hooks and endpoint; off without token and shop id | `plugin.test.ts` "config" |

### Gaps added

- The paid-order hook: send once, production or approval, every no-send case, tenant checks, guard, failures recorded without throwing, no token or address in logs.
- Webhook refusals at the endpoint (wrong secret, no secret, turned off, unknown tenant) and the order, deletion and publish-failure paths.
- Token handling in the client; retry on 429.
- Shop sync touching Printify only with reads; drafts for hidden and removed products.
- Price validation and refusal when Printify errors, for prices and visibility.
- Webhook registration leaving other hosts alone.

### Gaps skipped

- `listPrintifyShops`, `shippingCost`, `fulfillmentFromPrintify` on its own, `plainText` and `slugify` edge cases: thin wrappers or covered by the mapping and webhook tests.
- The "from" price hook (`productFromPriceHook`): display only, recomputed on every variant edit; worth a test if it grows.
- Field layout inside tabs and rows (`hasField`): Payload config plumbing.
- Variant type and option reuse across products in sync: covered in spirit by the sync test; a real database test would prove it better (see below).

### Bugs found

None confirmed.

### For the lead

- **Possible duplicate orders:** `src/client.ts:89` retries any 5xx, including `POST /orders.json`. If Printify creates the order and then answers 502, the retry may create a second paid order. Whether Printify refuses a repeated `external_id` is unknown. Decide whether to retry only safe methods, or check for the order by `external_id` before retrying.
- A sync test against a real (in-memory) database, so tenant scoping, slug clashes and variant updates are proven with real queries rather than a fake.
- A signed webhook with a body that isn't JSON currently throws (500). Harmless, but a 400 would be clearer; decide and test.
