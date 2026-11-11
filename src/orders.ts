import type { CollectionAfterChangeHook, CollectionSlug, PayloadRequest } from 'payload'

import { clientOf, outcomeUnknown, type PrintifyOrder } from './client'
import type { ResolvedPrintifyOptions } from './types'

const idOf = (v: unknown) => (v && typeof v === 'object' ? String((v as { id: unknown }).id) : v ? String(v) : '')
type Address = Partial<Record<'firstName' | 'lastName' | 'phone' | 'country' | 'state' | 'addressLine1' | 'addressLine2' | 'city' | 'postalCode', string | null>>

/** `fulfillment.status` of an order whose create may or may not have reached Printify. */
export const UNKNOWN_OUTCOME = 'unknown'

/**
 * orders afterChange: when an order becomes paid ("processing"), create the
 * Printify order for its Printify items (our order id as external_id).
 * Failures and blocks are recorded on the order, never thrown: the customer
 * has already paid.
 *
 * The create is sent once. If it fails with a 5xx, a timeout or a network
 * error, Printify may have created the order anyway, so the order is marked
 * `fulfillment.status: 'unknown'` and this hook never sends it again on its
 * own. A signed Printify order webhook carrying that `external_id` settles it,
 * or staff settle it with `settleUnknownOrder` (see settle.ts).
 */
export const submitOrderHook =
  (opts: ResolvedPrintifyOptions): CollectionAfterChangeHook =>
  async ({ doc, previousDoc, operation, req, context }) => {
    if (context.printify || !opts.enabled || doc.status !== 'processing') return doc
    if (doc.fulfillment?.externalId) return doc
    if (doc.fulfillment?.status === UNKNOWN_OUTCOME) return doc
    if (operation === 'update' && previousDoc?.status === 'processing') return doc
    await sendPaidOrder(opts, doc, req)
    return doc
  }

/**
 * Create the Printify order for a paid order's Printify items, once, and record
 * the result on the order. Returns the recorded `fulfillment`, or null when
 * there was nothing to send (another store's order, no Printify items).
 * Callers check first that the order hasn't been sent and isn't `unknown`.
 */
export async function sendPaidOrder(opts: ResolvedPrintifyOptions, doc: Record<string, any>, req: PayloadRequest): Promise<Record<string, unknown> | null> {
  const { payload } = req
  if (opts.tenant) {
    const owner = await opts.tenant.resolve(payload)
    if (owner == null || idOf(doc[opts.tenant.field ?? 'tenant']) !== String(owner)) return null
  }

  const lineItems: { product_id: string; variant_id: number; quantity: number }[] = []
  for (const item of (doc.items ?? []) as { variant?: unknown; quantity: number }[]) {
    if (!item.variant) continue
    const variant = (await payload.findByID({ collection: opts.collections.variants as CollectionSlug, id: idOf(item.variant), depth: 1, draft: true, req })) as {
      printify?: { variantId?: number | null }
      product?: { printify?: { productId?: string | null } } | string
    }
    const product = typeof variant?.product === 'object' ? variant.product : null
    if (variant?.printify?.variantId != null && product?.printify?.productId)
      lineItems.push({ product_id: product.printify.productId, variant_id: variant.printify.variantId, quantity: item.quantity })
  }
  if (lineItems.length === 0) return null

  const record = async (fulfillment: Record<string, unknown>) => {
    const written = { provider: 'printify', ...fulfillment }
    await payload.update({
      collection: opts.collections.orders as CollectionSlug,
      id: doc.id,
      data: { fulfillment: written } as never,
      context: { printify: true },
      req,
    })
    return written
  }
  try {
    await opts.beforePrintifyWrite?.({ action: 'order', doc, req })
  } catch (error) {
    return record({ status: 'held', error: (error as Error).message })
  }
  const a = (doc.shippingAddress ?? {}) as Address
  const client = clientOf(opts)
  let created: { id: string }
  try {
    created = await client.createOrder(opts.shopId!, {
      external_id: String(doc.id),
      label: String(doc.id),
      line_items: lineItems,
      shipping_method: opts.shippingMethod,
      send_shipping_notification: false,
      address_to: {
        first_name: a.firstName ?? '',
        last_name: a.lastName ?? '',
        email: (doc.customerEmail as string | undefined) ?? undefined,
        phone: a.phone ?? undefined,
        country: a.country ?? '',
        region: a.state ?? undefined,
        address1: a.addressLine1 ?? '',
        address2: a.addressLine2 ?? undefined,
        city: a.city ?? '',
        zip: a.postalCode ?? '',
      },
    })
  } catch (error) {
    const message = (error as Error).message
    if (outcomeUnknown(error)) {
      payload.logger.error({ order: doc.id }, `Printify order outcome unknown: ${message}`)
      return record({
        status: UNKNOWN_OUTCOME,
        error: `Outcome unknown, check Printify before sending again (external_id ${String(doc.id)}). ${message}`.slice(0, 500),
      })
    }
    payload.logger.error({ order: doc.id }, `Printify order failed: ${message}`)
    return record({ status: 'failed', error: message.slice(0, 500) })
  }
  try {
    if (opts.sendToProduction) await client.sendToProduction(opts.shopId!, created.id)
    return await record({
      externalId: created.id,
      status: opts.sendToProduction ? 'sending-to-production' : 'on-hold',
      error: null,
      submittedAt: new Date().toISOString(),
    })
  } catch (error) {
    // The order exists in Printify: keep its id so it is never created twice.
    payload.logger.error({ order: doc.id }, `Printify send to production failed: ${(error as Error).message}`)
    return record({ externalId: created.id, status: 'failed', error: (error as Error).message.slice(0, 500), submittedAt: new Date().toISOString() })
  }
}

/** Printify's status and shipments, as stored on the order. */
export const fulfillmentFromPrintify = (o: PrintifyOrder) => ({
  status: o.status,
  shipments: (o.shipments ?? []).map((s) => ({ carrier: s.carrier, number: s.number, url: s.url, deliveredAt: s.delivered_at ?? null })),
})
