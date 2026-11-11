import type { CollectionConfig, Payload, Plugin } from 'payload'

import { clientOf, PrintifyClient } from './client'
import { orderFulfillmentField, productContentFields, productPrintifyField, variantPrintifyField } from './fields'
import { submitOrderHook } from './orders'
import { productFromPriceHook, pushVariantPriceHook } from './prices'
import { settleEndpoint } from './settle'
import { storeScope, syncPrintifyProduct, unpublishPrintifyProduct } from './sync'
import type { PrintifyPluginOptions, ResolvedPrintifyOptions } from './types'
import { pushVisibilityHook } from './visibility'
import { webhookEndpoint } from './webhook'

export type { PrintifyPluginOptions, ResolvedPrintifyOptions } from './types'
export { clientOf, PrintifyClient, PrintifyError } from './client'
export type { PrintifyProduct, PrintifyShop, PrintifyOrder } from './client'
export { mapPrintifyProduct, syncPrintifyProduct, unpublishPrintifyProduct } from './sync'
export { validPrintifySignature } from './webhook'
export { PrintifySettleError, settleUnknownOrder } from './settle'
export type { SettleOutcome } from './settle'

/** Webhook topics the plugin handles. */
export const PRINTIFY_TOPICS = [
  'product:publish:started',
  'product:created',
  'product:updated',
  'product:deleted',
  'order:created',
  'order:updated',
  'order:sent-to-production',
  'order:shipment:created',
  'order:shipment:delivered',
] as const

const resolve = (o: PrintifyPluginOptions): ResolvedPrintifyOptions => ({
  ...o,
  enabled: o.enabled ?? Boolean(o.apiToken && o.shopId),
  sendToProduction: o.sendToProduction ?? false,
  publishHandshake: o.publishHandshake ?? false,
  pushPrices: o.pushPrices ?? false,
  pushVisibility: o.pushVisibility ?? false,
  currency: o.currency ?? 'USD',
  shippingMethod: o.shippingMethod ?? 1,
  webhookPath: o.webhookPath ?? '/printify/webhook',
  collections: {
    products: 'products',
    variants: 'variants',
    variantTypes: 'variantTypes',
    variantOptions: 'variantOptions',
    orders: 'orders',
    ...o.collections,
  },
})

/**
 * Printify for Payload's ecommerce plugin: products published in Printify
 * appear in the store (with variants, prices and mockups); paid orders are
 * sent to Printify; Printify's order and shipment events update the orders.
 * Add it after `ecommercePlugin`.
 */
export const printifyPlugin =
  (options: PrintifyPluginOptions): Plugin =>
  (config) => {
    const opts = resolve(options)
    const extend = (c: CollectionConfig): CollectionConfig => {
      if (c.slug === opts.collections.products)
        return {
          ...c,
          fields: [...productContentFields(c), ...c.fields, productPrintifyField],
          hooks: { ...c.hooks, beforeChange: [...(c.hooks?.beforeChange ?? []), pushVisibilityHook(opts)] },
        }
      if (c.slug === opts.collections.variants)
        return {
          ...c,
          fields: [...c.fields, variantPrintifyField],
          hooks: {
            ...c.hooks,
            beforeChange: [...(c.hooks?.beforeChange ?? []), pushVariantPriceHook(opts)],
            afterChange: [...(c.hooks?.afterChange ?? []), productFromPriceHook(opts)],
          },
        }
      if (c.slug === opts.collections.orders)
        return {
          ...c,
          fields: [...c.fields, orderFulfillmentField],
          hooks: { ...c.hooks, afterChange: [...(c.hooks?.afterChange ?? []), submitOrderHook(opts)] },
        }
      return c
    }
    return {
      ...config,
      collections: (config.collections ?? []).map(extend),
      endpoints: [...(config.endpoints ?? []), webhookEndpoint(opts), settleEndpoint()],
      custom: { ...config.custom, printify: opts },
    }
  }

const optionsOf = (payload: Payload) => {
  const opts = payload.config.custom?.printify as ResolvedPrintifyOptions | undefined
  if (!opts?.enabled || !opts.apiToken || !opts.shopId) throw new Error('Printify is not configured (apiToken and shopId)')
  return opts
}

/** The shops a token can see (to choose `shopId`). */
export const listPrintifyShops = (apiToken: string) => new PrintifyClient(apiToken).shops()

/** Import or refresh every product of the shop; products gone from Printify become drafts. */
export async function syncPrintifyShop(payload: Payload) {
  const opts = optionsOf(payload)
  const tenantId = opts.tenant ? await opts.tenant.resolve(payload) : null
  const products = await clientOf(opts).allProducts(opts.shopId!)
  const synced: { title: string; slug: string; visible: boolean }[] = []
  for (const p of products) {
    const ours = await syncPrintifyProduct(payload, opts, tenantId, p)
    synced.push({ title: p.title, slug: ours.slug, visible: p.visible !== false })
  }
  const { scoped, c } = storeScope(payload, opts, tenantId)
  const local = await payload.find({ collection: c('products'), where: scoped({ 'printify.productId': { exists: true } }), limit: 5000, depth: 0, draft: true, overrideAccess: true })
  const present = new Set(products.map((p) => p.id))
  let removed = 0
  for (const d of local.docs as { printify?: { productId?: string | null } }[])
    if (d.printify?.productId && !present.has(d.printify.productId) && (await unpublishPrintifyProduct(payload, opts, tenantId, d.printify.productId))) removed++
  return { synced, removed }
}

/** (Re-)register the plugin's webhooks at `${origin}/api${webhookPath}`; other hosts' registrations are left alone. */
export async function registerPrintifyWebhooks(payload: Payload, origin: string) {
  const opts = optionsOf(payload)
  if (!opts.webhookSecret) throw new Error('Set webhookSecret before registering webhooks')
  const client = clientOf(opts)
  const url = `${origin.replace(/\/$/, '')}${payload.config.routes.api}${opts.webhookPath}`
  const host = new URL(url).host
  for (const w of await client.webhooks(opts.shopId!)) if (new URL(w.url).host === host) await client.deleteWebhook(opts.shopId!, w.id, host)
  for (const topic of PRINTIFY_TOPICS) await client.createWebhook(opts.shopId!, topic, url, opts.webhookSecret)
  return { url, topics: PRINTIFY_TOPICS.length }
}
