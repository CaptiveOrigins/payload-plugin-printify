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
  Look for it in Printify by its `external_id`, then fill in `fulfillment.externalId`, or clear
  the status to let the next change to paid send it.
- **Printify → orders.** Order and shipment webhooks update `fulfillment` on the order
  (status, carrier, tracking number and URL).

Self-contained: it depends only on `payload` and Node's `crypto`.

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

and the endpoint `POST /api/printify/webhook`, which rejects requests without a valid
`X-Pfy-Signature` (HMAC-SHA256 of the body with `webhookSecret`).

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
