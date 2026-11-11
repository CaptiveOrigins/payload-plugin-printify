import type { Access, Payload, PayloadRequest } from 'payload'

export type PrintifyPluginOptions = {
  /** Turn the integration off without removing the plugin (fields stay). Default: on when apiToken and shopId are set. */
  enabled?: boolean
  /** Personal access token (Printify → My Profile → Connections). Keep it in an environment variable. */
  apiToken?: string
  /** The Printify shop to sync (`listPrintifyShops` shows the ids). */
  shopId?: string
  /** Shared secret Printify signs webhook requests with (`openssl rand -hex 20`). */
  webhookSecret?: string
  /** Paid orders go straight to production; otherwise they wait in Printify for approval. Default false. */
  sendToProduction?: boolean
  /**
   * Price edits made in Payload (on a synced variant) are written back to the
   * Printify product, so both stay the same. Default false: Printify's prices
   * win and edits are overwritten by the next sync.
   */
  pushPrices?: boolean
  /**
   * Publishing or unpublishing a synced product in Payload publishes or
   * unpublishes it in Printify too (Printify's own `visible` flag is
   * read-only; it follows). Default false: Printify's visibility wins and is
   * copied on each sync.
   */
  pushVisibility?: boolean
  /**
   * The shop's sales channel is Printify's "API" channel and this store is it:
   * answer Printify's publish events (publishing_succeeded / _failed with the
   * product URL). Leave off for shops on other channels (Pop-Up Store, Etsy,
   * Shopify ...); their products are copied without answering. Default false.
   */
  publishHandshake?: boolean
  /** Store currency; prices live in the ecommerce plugin's `priceIn<currency>` fields. Default USD. */
  currency?: string
  /** Printify shipping method for new orders: 1 standard, 2 priority, 3 Printify Express, 4 economy. Default 1. */
  shippingMethod?: number
  /** Collection slugs (defaults: the official ecommerce plugin's). */
  collections?: Partial<Record<'products' | 'variants' | 'variantTypes' | 'variantOptions' | 'orders', string>>
  /**
   * Multi-tenant setups: which tenant owns the synced products, and the name of
   * the tenant field on store collections. Omit for single-site stores.
   */
  tenant?: { field?: string; resolve: (payload: Payload) => Promise<number | string | null> }
  /**
   * Called right before the plugin changes anything in Printify: sending an
   * order (it costs money), pushing a price or a publish/unpublish. Throw to
   * block it. A blocked order is marked "held" with the error message; a
   * blocked price or visibility change is refused. Use it to keep staging/test copies away from a real shop.
   */
  beforePrintifyWrite?: (args: { action: 'order' | 'price' | 'visibility'; doc: Record<string, unknown>; req: PayloadRequest }) => void | Promise<void>
  /**
   * Who may do staff actions, such as settling an order whose Printify create had an unclear
   * outcome (`settleUnknownOrder`). A plain Payload access function, but only a result of exactly
   * `true` passes: a query, a truthy value or an error is a no. Default: nobody, so set it
   * (for example `({ req }) => req.user?.roles?.includes('admin') === true`).
   */
  access?: { manage?: Access }
  /** Public URL of a product page, reported to Printify after publishing. */
  productURL?: (product: { id: string; slug: string }) => string
  /** Endpoint path under /api (default /printify/webhook). */
  webhookPath?: string
  /** User-Agent sent to Printify (it asks integrations to identify themselves). */
  userAgent?: string
  /** fetch implementation (tests). */
  fetch?: typeof fetch
}

export type ResolvedPrintifyOptions = Required<
  Pick<PrintifyPluginOptions, 'sendToProduction' | 'publishHandshake' | 'pushPrices' | 'pushVisibility' | 'currency' | 'shippingMethod' | 'webhookPath'>
> &
  Omit<PrintifyPluginOptions, 'collections'> & {
    enabled: boolean
    collections: Required<NonNullable<PrintifyPluginOptions['collections']>>
  }
