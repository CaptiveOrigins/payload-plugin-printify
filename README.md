# Printify plugin for Payload ecommerce

Connects a [Printify](https://printify.com) shop to a store built with Payload's official
[ecommerce plugin](https://payloadcms.com/docs/ecommerce/overview):

- **Products → store.** Products published (or created/updated) in Printify are synced into the
  store's `products`, `variants`, `variantTypes` and `variantOptions`, with prices (cents),
  enabled variants and mockup image links. Products removed in Printify become drafts.
  Works with any sales channel (Pop-Up Store, Etsy, Shopify, ...). For shops on Printify's
  **API** channel, `publishHandshake: true` also answers Printify's publishing events
  (`publishing_succeeded` with your product URL).
- **Prices → Printify (optional).** With `pushPrices: true`, a price edited on a synced variant
  in Payload is written to the Printify product first; if Printify refuses (product locked
  while publishing, API error, your guard), the edit is refused, so the two never disagree.
- **Visibility, both ways.** Hidden Printify products are imported as drafts; visible ones are
  published. With `pushVisibility: true`, Publish/Unpublish on a synced product in Payload also
  publishes/unpublishes it in Printify first (refused if Printify refuses). "Save draft" does not.
- **Orders → Printify.** When an order becomes paid (`status: processing`), its Printify items are
  sent as a Printify order (`external_id` = your order id). Orders wait in Printify for approval
  unless `sendToProduction: true`. The order is sent once and never retried. If Printify answers
  with a server error, times out or the connection drops, it may have created the order anyway, so
  `fulfillment.status` becomes `unknown` and the plugin won't send that order again on its own.
  If Printify did create it, its next order webhook settles the order by `external_id`. Otherwise
  staff settle it (see [Orders with an unknown outcome](#orders-with-an-unknown-outcome)).
- **Printify → orders.** Order and shipment webhooks update `fulfillment` on the order
  (status, carrier, tracking number and URL).

Self-contained: it depends only on `payload` and Node's `crypto`.

## On its own, and with others

**On its own.** Printify needs Payload's official ecommerce plugin, listed before it, plus a Printify shop, a personal access token and a webhook secret. It doesn't use any other Captive Origins plugin.

**Works with:**

- **Payload ecommerce** (`@payloadcms/plugin-ecommerce`): required. Printify adds fields and hooks to its products, variants and orders.
- **Multi-tenant stores** (for example `@payloadcms/plugin-multi-tenant`): the `tenant` option says which site owns the synced products.

**Family.** Printify is in the Patronage family, with Membership, Sponsors, Backing, Credits and Roadmap, though nothing in the code links it to them yet. The families are a working draft that may change.

## Install

```bash
npm install @captiveorigins/payload-plugin-printify
```

```ts
import { ecommercePlugin } from '@payloadcms/plugin-ecommerce'
import { printifyPlugin } from '@captiveorigins/payload-plugin-printify'

export default buildConfig({
  plugins: [
    ecommercePlugin({ /* ... */ inventory: false }), // print on demand: no stock to count
    printifyPlugin({
      apiToken: process.env.PRINTIFY_API_TOKEN,
      shopId: process.env.PRINTIFY_SHOP_ID,
      webhookSecret: process.env.PRINTIFY_WEBHOOK_SECRET,
      productURL: ({ slug }) => `https://example.com/shop/${slug}`,
      // Optional:
      // sendToProduction: true,
      // pushPrices: true,
      // pushVisibility: true,
      // publishHandshake: true,                                          // shop on the API sales channel
      // beforePrintifyWrite: ({ action, doc, req }) => { if (!isProduction) throw new Error('staging only reads Printify') },
      // access: { manage: ({ req }) => req.user?.roles?.includes('admin') === true }, // who may settle orders
      // currency: 'USD',                                                 // priceIn<currency> fields
      // tenant: { field: 'tenant', resolve: async (payload) => tenantId }, // multi-tenant stores
      // collections: { products: 'products', orders: 'orders' },          // custom slugs
    }),
  ],
})
```

Add it **after** `ecommercePlugin`. It adds:

| Collection | Fields |
|---|---|
| products | `title`, `slug`, `description`, `images[]` (only if missing) and `printify` (productId, shopId, blueprintId, printProviderId, syncedAt) |
| variants | `printify` (variantId, sku), the price push and "from" price hooks |
| orders | `fulfillment` (provider, externalId, status, error, submittedAt, shipments[]) and the submit hook |

and two endpoints: `POST /api/printify/webhook`, which rejects requests without a valid
`X-Pfy-Signature` (HMAC-SHA256 of the body with `webhookSecret`), and
`POST /api/printify/orders/:id/settle` (below).

## Set up

1. Printify → My Profile → Connections → generate a **personal access token**
   (scopes: shops, products, orders, webhooks). Store it as an environment variable.
2. Find the shop id: `listPrintifyShops(token)` → `[{ id, title, sales_channel }]`.
3. Generate a webhook secret: `openssl rand -hex 20`.
4. Deploy, then register webhooks once per deployment URL:
   `await registerPrintifyWebhooks(payload, 'https://example.com')`.
5. Import existing products: `await syncPrintifyShop(payload)` (safe to re-run; read-only on Printify).

## Staging copies

Staging and production usually read the same Printify shop. Pass `beforePrintifyWrite` and
throw outside production: orders are then marked `held` and price and visibility edits are refused, while
product sync (read-only on Printify) keeps working everywhere.

## Orders with an unknown outcome

When creating a Printify order fails with a server error, a timeout or a dropped connection,
Printify may have created it anyway. The order gets `fulfillment.status: unknown` and is never
sent again on its own. There are two ways out.

**Printify tells us.** Any signed Printify order event whose order has our order id as
`external_id` settles it: the Printify id and status are recorded. This only happens while some
order is `unknown`, so other order events cost no extra Printify call.

**Staff settle it.** Look for the order id in Printify (it's the order's `external_id` and label),
then:

```ts
import { settleUnknownOrder } from '@captiveorigins/payload-plugin-printify'

// It's in Printify: record its id. Status becomes `submitted` until Printify's next webhook.
await settleUnknownOrder(payload, { order: orderId, outcome: 'sent', printifyId: 'Printify order id', req })

// It isn't: send it now, once.
await settleUnknownOrder(payload, { order: orderId, outcome: 'resend', req })
```

From the admin (signed in), the same as a request:

```bash
curl -X POST https://example.com/api/printify/orders/ORDER_ID/settle \
  -H 'Content-Type: application/json' -b 'payload-token=...' \
  -d '{"outcome":"resend"}'
```

It answers 200 with the new `fulfillment`, 400 for a missing `printifyId` or a wrong outcome,
403 when you may not, and 409 when the order isn't `unknown` (or, for `resend`, isn't paid any more
or Printify is turned off here).

- Only people the `access.manage` option answers exactly `true` for may settle. A query, any other
  truthy value or an error is a no. With no `access.manage`, nobody can.
- The order must still be `unknown` when the change is written: the status is part of the write's
  condition (`payload.db.updateOne` with it in `where`). Of two staff resending at once, one sends
  and the other gets a 409. This relies on the database adapter doing that conditional update in one
  step, as MongoDB's does. It is tested against a fake, not a real database.
- `resend` goes through the same path as a paid order: the tenant check and `beforePrintifyWrite`
  still apply, and its outcome can be `unknown` again.
- There's no button in the admin yet; the field's description points to the endpoint.

## Notes

- Prices are Printify's retail prices in cents, as Payload ecommerce stores them (`priceInUSD`).
  The product's own price is the lowest published variant price ("from" price).
- Printify updates a product's variants as a whole list; a price push sends every variant with
  one price changed. A shop's channel (e.g. the Pop-Up Store) may need the product republished
  in Printify to show the new price there.
- Mockups are linked from Printify's CDN, not copied into uploads.
- Shipping cost for a cart: `new PrintifyClient(token).shippingCost(shopId, { line_items, address_to })`.
- API limits: 600 requests/minute. The client retries 429 with backoff, and server errors only
  for reads. Creating an order is never retried.
