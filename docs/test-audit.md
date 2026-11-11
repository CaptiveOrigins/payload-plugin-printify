# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md` "Test self-audits". Newest first.

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
