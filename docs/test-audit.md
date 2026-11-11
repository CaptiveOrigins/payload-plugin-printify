# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md` "Test self-audits". Newest first.

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
