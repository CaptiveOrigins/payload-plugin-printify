import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CollectionSlug, Endpoint, PayloadRequest } from 'payload'

import { clientOf } from './client'
import { fulfillmentFromPrintify, UNKNOWN_OUTCOME } from './orders'
import { settleFromPrintify } from './settle'
import { syncPrintifyProduct, unpublishPrintifyProduct } from './sync'
import type { ResolvedPrintifyOptions } from './types'

/** X-Pfy-Signature: "sha256=" + hex HMAC-SHA256 of the raw body with the shared secret. */
export function validPrintifySignature(body: string, header: string | null, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'))
  const given = Buffer.from(header.slice('sha256='.length))
  return expected.length === given.length && timingSafeEqual(expected, given)
}

type Event = { id: string; type: string; resource: { id: string; type: string; data?: { action?: string } | null } }

/**
 * Printify product and order events. Unsigned or wrongly signed requests are
 * rejected. Products sync into the store; order events refresh fulfillment
 * status and tracking, and settle an order whose create had an unclear outcome
 * when Printify's order carries its id as `external_id`.
 */
export const webhookEndpoint = (opts: ResolvedPrintifyOptions): Endpoint => ({
  path: opts.webhookPath,
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const body = (await req.text?.()) ?? ''
    if (!opts.enabled || !validPrintifySignature(body, req.headers.get('x-pfy-signature'), opts.webhookSecret))
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const event = JSON.parse(body) as Event
    const { payload } = req
    const tenantId = opts.tenant ? await opts.tenant.resolve(payload) : null
    if (opts.tenant && tenantId == null) return Response.json({ error: 'No store tenant' }, { status: 500 })
    const client = clientOf(opts)
    const shopId = opts.shopId!
    const id = event.resource.id

    if (event.type === 'product:deleted' || (event.type === 'product:publish:started' && event.resource.data?.action === 'delete')) {
      await unpublishPrintifyProduct(payload, opts, tenantId, id)
    } else if (event.type === 'product:publish:started' && opts.publishHandshake) {
      // API sales channel: publish into the store, then tell Printify where it lives.
      try {
        const ours = await syncPrintifyProduct(payload, opts, tenantId, await client.product(shopId, id))
        await client.publishingSucceeded(shopId, id, { id: ours.id, handle: opts.productURL?.(ours) ?? ours.slug })
      } catch (error) {
        await client.publishingFailed(shopId, id, (error as Error).message.slice(0, 200)).catch(() => {})
        throw error
      }
    } else if (event.type.startsWith('product:')) {
      // created, updated, or publishing to another channel (e.g. the Pop-Up Store): copy it.
      await syncPrintifyProduct(payload, opts, tenantId, await client.product(shopId, id))
    } else if (event.type.startsWith('order:')) {
      const orders = opts.collections.orders as CollectionSlug
      const order = (await payload.find({ collection: orders, where: { 'fulfillment.externalId': { equals: id } }, limit: 1, depth: 0 })).docs[0] as
        | { id: string; fulfillment?: Record<string, unknown> }
        | undefined
      if (order)
        await payload.update({
          collection: orders,
          id: order.id,
          data: { fulfillment: { ...order.fulfillment, ...fulfillmentFromPrintify(await client.order(shopId, id)) } } as never,
          context: { printify: true },
        })
      // Not ours by Printify id. If any order's create had an unclear outcome, this may be it:
      // Printify's order carries our order id as external_id.
      else if ((await payload.find({ collection: orders, where: { 'fulfillment.status': { equals: UNKNOWN_OUTCOME } }, limit: 1, depth: 0 })).docs.length > 0)
        await settleFromPrintify(payload, opts, tenantId, await client.order(shopId, id))
    }
    return Response.json({ received: event.id })
  },
})
