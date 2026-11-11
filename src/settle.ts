import type { CollectionSlug, Endpoint, Payload, PayloadRequest, Where } from 'payload'

import type { PrintifyOrder } from './client'
import { fulfillmentFromPrintify, sendPaidOrder, UNKNOWN_OUTCOME } from './orders'
import type { ResolvedPrintifyOptions } from './types'

/** A refused settle: `status` is the HTTP status the endpoint answers with. */
export class PrintifySettleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'PrintifySettleError'
  }
}

type Fulfillment = Record<string, unknown>
type OrderDoc = { id: number | string; status?: unknown; fulfillment?: Fulfillment | null } & Record<string, unknown>

/**
 * Rewrite an `unknown` order's fulfillment, only if it is still `unknown` when
 * the write lands. The status is part of the write's `where`, so of two
 * callers racing for the same order, one gets the order back and the other
 * gets null. Hooks don't run (it's a database write).
 */
export async function claimUnknownOrder(
  payload: Payload,
  opts: ResolvedPrintifyOptions,
  args: { id: number | string; also?: Where[]; fulfillment: (current: Fulfillment) => Fulfillment; req?: Partial<PayloadRequest> },
): Promise<{ doc: OrderDoc; fulfillment: Fulfillment } | null> {
  const collection = opts.collections.orders as CollectionSlug
  const where: Where = { and: [{ id: { equals: args.id } }, { 'fulfillment.status': { equals: UNKNOWN_OUTCOME } }, ...(args.also ?? [])] }
  const doc = (await payload.find({ collection, where, limit: 1, depth: 0, overrideAccess: true, req: args.req })).docs[0] as OrderDoc | undefined
  if (!doc) return null
  const fulfillment = args.fulfillment({ ...(doc.fulfillment ?? {}) })
  const claimed = await payload.db.updateOne({ collection, where, data: { fulfillment }, req: args.req })
  return claimed ? { doc, fulfillment } : null
}

/**
 * A signed Printify order event for an order we don't know by Printify id: if
 * its `external_id` is one of our `unknown` orders (in this store), the create
 * did reach Printify. Record the Printify id and status. Returns whether it settled one.
 */
export async function settleFromPrintify(payload: Payload, opts: ResolvedPrintifyOptions, tenantId: number | string | null, order: PrintifyOrder): Promise<boolean> {
  if (!order.external_id || !order.id) return false
  const claimed = await claimUnknownOrder(payload, opts, {
    id: order.external_id,
    also: opts.tenant ? [{ [opts.tenant.field ?? 'tenant']: { equals: tenantId } }] : [],
    fulfillment: (current) => ({
      ...current,
      provider: 'printify',
      externalId: order.id,
      error: null,
      submittedAt: current.submittedAt ?? new Date().toISOString(),
      ...fulfillmentFromPrintify(order),
    }),
  })
  if (claimed) payload.logger.info({ order: claimed.doc.id }, 'Printify order with an unknown outcome found in Printify by external_id; recorded')
  return claimed != null
}

export type SettleOutcome = 'sent' | 'resend'

/**
 * Settle an order whose Printify create had an unclear outcome
 * (`fulfillment.status: 'unknown'`), after checking Printify for its `external_id`:
 *
 * - `'sent'`: it's in Printify. Records `printifyId` as `fulfillment.externalId`, status `submitted`.
 *   Printify's next order webhook replaces the status with its own.
 * - `'resend'`: it isn't in Printify. Clears the unknown state and sends the order now, once.
 *
 * Only someone the plugin's `access.manage` answers exactly `true` for may do it. Refused, with a
 * `PrintifySettleError`, for orders that aren't `unknown`, and when another call settled it first.
 */
export async function settleUnknownOrder(
  payload: Payload,
  args: { order: number | string | { id: number | string }; outcome: SettleOutcome; printifyId?: string; req: PayloadRequest },
): Promise<{ order: number | string; outcome: SettleOutcome; fulfillment: Fulfillment }> {
  const opts = payload.config.custom?.printify as ResolvedPrintifyOptions | undefined
  if (!opts) throw new PrintifySettleError('The Printify plugin is not installed.', 500)
  let allowed: unknown = false
  try {
    allowed = opts.access?.manage ? await opts.access.manage({ req: args.req } as never) : false
  } catch {
    allowed = false
  }
  if (allowed !== true) throw new PrintifySettleError('You can’t settle Printify orders.', 403)

  const { outcome } = args
  if (outcome !== 'sent' && outcome !== 'resend') throw new PrintifySettleError('Outcome must be "sent" or "resend".', 400)
  const printifyId = typeof args.printifyId === 'string' ? args.printifyId.trim() : ''
  if (outcome === 'sent' && !printifyId) throw new PrintifySettleError('Give the Printify order id you found (printifyId).', 400)
  if (outcome === 'resend' && !opts.enabled) throw new PrintifySettleError('Printify is turned off here, so the order can’t be sent.', 409)
  const id = typeof args.order === 'object' && args.order ? args.order.id : args.order
  if (id == null || id === '') throw new PrintifySettleError('Say which order to settle.', 400)

  const claimed = await claimUnknownOrder(payload, opts, {
    id,
    // Resending creates a paid Printify order: only for orders that are still paid.
    also: outcome === 'resend' ? [{ status: { equals: 'processing' } }] : [],
    fulfillment: (current) =>
      outcome === 'sent'
        ? { ...current, provider: 'printify', externalId: printifyId, status: 'submitted', error: null, submittedAt: current.submittedAt ?? new Date().toISOString() }
        : { ...current, status: null, error: null },
    req: args.req,
  })
  if (!claimed)
    throw new PrintifySettleError(
      outcome === 'resend'
        ? 'This order isn’t waiting to be settled: its Printify status isn’t unknown (someone may have settled it already), or it is no longer paid.'
        : 'This order isn’t waiting to be settled: its Printify status isn’t unknown (someone may have settled it already).',
      409,
    )
  payload.logger.info({ order: id, outcome }, 'Printify order with an unknown outcome settled by staff')
  if (outcome === 'sent') return { order: id, outcome, fulfillment: claimed.fulfillment }
  const sent = await sendPaidOrder(opts, { ...claimed.doc, fulfillment: claimed.fulfillment }, args.req)
  return { order: id, outcome, fulfillment: sent ?? claimed.fulfillment }
}

/** `POST /api/printify/orders/:id/settle` with `{ outcome, printifyId? }`, for the admin (signed-in session). */
export const settleEndpoint = (): Endpoint => ({
  path: '/printify/orders/:id/settle',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    let body: Record<string, unknown> = {}
    try {
      body = ((await req.json?.()) ?? {}) as Record<string, unknown>
    } catch {
      return Response.json({ error: 'Send a JSON body: { "outcome": "sent" | "resend", "printifyId"?: string }' }, { status: 400 })
    }
    try {
      const result = await settleUnknownOrder(req.payload, {
        order: String(req.routeParams?.id ?? ''),
        outcome: body.outcome as SettleOutcome,
        printifyId: typeof body.printifyId === 'string' ? body.printifyId : undefined,
        req,
      })
      return Response.json(result)
    } catch (error) {
      if (error instanceof PrintifySettleError) return Response.json({ error: error.message }, { status: error.status })
      throw error
    }
  },
})
