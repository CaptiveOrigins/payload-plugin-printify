import type { Config, PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { printifyPlugin, PrintifySettleError, settleUnknownOrder } from '../src'
import { submitOrderHook } from '../src/orders'
import { settleEndpoint } from '../src/settle'
import type { PrintifyPluginOptions, ResolvedPrintifyOptions } from '../src/types'

// Settling decides whether a paid order is created in Printify again. Every call here goes to a
// fake fetch and a small in-memory Payload; nothing reaches Printify.
const TOKEN = 'fake-printify-token-abc123'
const collections = ['products', 'variants', 'variantTypes', 'variantOptions', 'orders'].map((slug) => ({ slug, fields: [] }))
const staffOnly = { manage: ({ req }: { req: { user?: { role?: string } } }) => req.user?.role === 'staff' }
const resolved = (options: Partial<PrintifyPluginOptions> = {}) =>
  (
    printifyPlugin({ apiToken: TOKEN, shopId: '123', access: staffOnly as never, ...options })({ collections, endpoints: [] } as unknown as Config) as Config & {
      custom: { printify: ResolvedPrintifyOptions }
    }
  ).custom.printify

const unknownOrder = (extra: Record<string, unknown> = {}) => ({
  id: 'ord-1',
  status: 'processing',
  shippingAddress: { firstName: 'Sam', lastName: 'Sample', country: 'US', addressLine1: '1 Test Way', city: 'Testville', postalCode: '85000' },
  items: [{ variant: 'v1', quantity: 2 }],
  fulfillment: { provider: 'printify', status: 'unknown', error: 'Outcome unknown, check Printify before sending again (external_id ord-1). 502' },
  ...extra,
})

type Doc = Record<string, any>
/** Orders and one Printify variant. `db.updateOne` checks its `where` and writes in one step, like a conditional database write. */
const store = (options: Partial<PrintifyPluginOptions> = {}, orders: Doc[] = [unknownOrder()]) => {
  const requests: { method: string; url: string; body: unknown }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify({ id: 'pf-order-9' }), { status: 200 })
  }) as typeof globalThis.fetch
  const opts = resolved({ fetch, ...options })
  const docs: Record<string, Doc[]> = { orders: orders.map((o) => structuredClone(o)) }
  const writes: { op: string; id: unknown; data: Doc }[] = []
  const get = (doc: Doc, path: string) => path.split('.').reduce<any>((v, k) => v?.[k], doc)
  const matches = (doc: Doc, where: any): boolean =>
    Array.isArray(where.and) ? where.and.every((w: unknown) => matches(doc, w)) : Object.entries(where).every(([path, c]: [string, any]) => get(doc, path) === c.equals)
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const payload = {
    config: { custom: { printify: opts } },
    find: async ({ collection, where }: { collection: string; where: unknown }) => {
      await tick()
      return { docs: (docs[collection] ?? []).filter((d) => matches(d, where)).map((d) => structuredClone(d)) }
    },
    findByID: async ({ id }: { id: string }) =>
      id === 'v1' ? { id: 'v1', printify: { variantId: 1001 }, product: { id: 'p1', printify: { productId: 'pf-1' } } } : null,
    update: async ({ collection, id, data }: { collection: string; id: unknown; data: Doc }) => {
      await tick()
      const doc = docs[collection]!.find((d) => d.id === id)!
      Object.assign(doc, data)
      writes.push({ op: 'update', id, data })
      return doc
    },
    db: {
      updateOne: async ({ collection, where, data }: { collection: string; where: unknown; data: Doc }) => {
        await tick()
        const doc = (docs[collection] ?? []).find((d) => matches(d, where))
        if (!doc) return null
        Object.assign(doc, data)
        writes.push({ op: 'db.updateOne', id: doc.id, data })
        return doc
      },
    },
    logger: { info: () => {}, error: () => {} },
  }
  const req = (role?: string) => ({ payload, user: role ? { role } : null }) as unknown as PayloadRequest
  const order = () => docs.orders![0]!
  return { opts, payload: payload as never, req, requests, writes, order }
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as PrintifySettleError)

describe('settling an order whose Printify create had an unclear outcome', () => {
  it('refuses anyone the manage access does not answer exactly true for, before reading or writing', async () => {
    const cases: [Partial<PrintifyPluginOptions>, string | undefined][] = [
      [{}, 'customer'], // wrong role
      [{}, undefined], // signed out
      [{ access: undefined }, 'staff'], // no manage access configured: nobody
      [{ access: { manage: () => ({ tenant: { equals: 't1' } }) } }, 'staff'], // a query is not a yes
      [{ access: { manage: (() => 'yes') as never } }, 'staff'], // truthy is not a yes
      [{ access: { manage: (() => 1) as never } }, 'staff'],
      [{ access: { manage: () => { throw new Error('roles service down') } } }, 'staff'], // an error is a no
    ]
    for (const [options, role] of cases) {
      const s = store(options)
      for (const outcome of ['sent', 'resend'] as const) {
        const error = await refusal(settleUnknownOrder(s.payload, { order: 'ord-1', outcome, printifyId: 'pf-order-9', req: s.req(role) }))
        expect(error).toBeInstanceOf(PrintifySettleError)
        expect(error!.status).toBe(403)
      }
      expect(s.writes).toHaveLength(0)
      expect(s.requests).toHaveLength(0)
      expect(s.order().fulfillment.status).toBe('unknown')
    }
  })

  it('refuses orders that are not unknown, and missing orders', async () => {
    const others = [
      unknownOrder({ fulfillment: { provider: 'printify', status: 'failed', error: 'bad address' } }),
      unknownOrder({ fulfillment: { provider: 'printify', status: 'on-hold', externalId: 'pf-order-1' } }),
      unknownOrder({ fulfillment: { provider: 'printify', status: 'held' } }),
      unknownOrder({ fulfillment: null }),
    ]
    for (const doc of others) {
      const s = store({}, [doc])
      for (const outcome of ['sent', 'resend'] as const) {
        const error = await refusal(settleUnknownOrder(s.payload, { order: 'ord-1', outcome, printifyId: 'pf-order-9', req: s.req('staff') }))
        expect(error!.status).toBe(409)
      }
      expect(s.writes).toHaveLength(0)
      expect(s.requests).toHaveLength(0)
    }
    const s = store()
    expect((await refusal(settleUnknownOrder(s.payload, { order: 'ord-404', outcome: 'resend', req: s.req('staff') })))!.status).toBe(409)
    expect(s.writes).toHaveLength(0)
  })

  it('refuses "sent" without the Printify order id, and an unknown outcome', async () => {
    const s = store()
    for (const printifyId of [undefined, '', '   ']) {
      const error = await refusal(settleUnknownOrder(s.payload, { order: 'ord-1', outcome: 'sent', printifyId, req: s.req('staff') }))
      expect(error!.status).toBe(400)
    }
    expect((await refusal(settleUnknownOrder(s.payload, { order: 'ord-1', outcome: 'retry' as never, req: s.req('staff') })))!.status).toBe(400)
    expect(s.writes).toHaveLength(0)
    expect(s.order().fulfillment.status).toBe('unknown')
  })

  it('refuses to resend an order that is no longer paid, or when Printify is turned off', async () => {
    const canceled = store({}, [unknownOrder({ status: 'canceled' })])
    expect((await refusal(settleUnknownOrder(canceled.payload, { order: 'ord-1', outcome: 'resend', req: canceled.req('staff') })))!.status).toBe(409)
    const off = store({ enabled: false })
    expect((await refusal(settleUnknownOrder(off.payload, { order: 'ord-1', outcome: 'resend', req: off.req('staff') })))!.status).toBe(409)
    for (const s of [canceled, off]) {
      expect(s.writes).toHaveLength(0)
      expect(s.requests).toHaveLength(0)
      expect(s.order().fulfillment.status).toBe('unknown')
    }
  })

  it('"sent" records the Printify id as submitted, without calling Printify', async () => {
    const s = store()
    const result = await settleUnknownOrder(s.payload, { order: 'ord-1', outcome: 'sent', printifyId: ' pf-order-7 ', req: s.req('staff') })
    expect(result.fulfillment).toMatchObject({ provider: 'printify', externalId: 'pf-order-7', status: 'submitted', error: null })
    expect(s.order().fulfillment).toMatchObject({ externalId: 'pf-order-7', status: 'submitted', error: null })
    expect(s.writes.map((w) => w.op)).toEqual(['db.updateOne'])
    expect(s.requests).toHaveLength(0)
    // Settled once: a second try is refused.
    expect((await refusal(settleUnknownOrder(s.payload, { order: 'ord-1', outcome: 'sent', printifyId: 'pf-order-8', req: s.req('staff') })))!.status).toBe(409)
    expect(s.order().fulfillment.externalId).toBe('pf-order-7')
  })

  it('"resend" sends the order exactly once, and nothing sends it again', async () => {
    const s = store()
    const result = await settleUnknownOrder(s.payload, { order: { id: 'ord-1' }, outcome: 'resend', req: s.req('staff') })
    expect(s.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST https://api.printify.com/v1/shops/123/orders.json'])
    expect(s.requests[0]!.body).toMatchObject({ external_id: 'ord-1', line_items: [{ product_id: 'pf-1', variant_id: 1001, quantity: 2 }] })
    expect(result.fulfillment).toMatchObject({ externalId: 'pf-order-9', status: 'on-hold', error: null })
    expect(s.order().fulfillment).toMatchObject({ externalId: 'pf-order-9', status: 'on-hold' })

    // Again by staff, or by the paid-order hook on a re-save or a change back to paid: nothing more.
    expect((await refusal(settleUnknownOrder(s.payload, { order: 'ord-1', outcome: 'resend', req: s.req('staff') })))!.status).toBe(409)
    const hook = submitOrderHook(s.opts)
    for (const previousDoc of [{ status: 'processing' }, { status: 'pending' }])
      await hook({ doc: s.order(), previousDoc, operation: 'update', req: s.req('staff'), context: {} } as never)
    expect(s.requests).toHaveLength(1)
  })

  it('lets only one of two resends at once win', async () => {
    const s = store()
    const results = await Promise.allSettled([
      settleUnknownOrder(s.payload, { order: 'ord-1', outcome: 'resend', req: s.req('staff') }),
      settleUnknownOrder(s.payload, { order: 'ord-1', outcome: 'resend', req: s.req('staff') }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((lost.reason as PrintifySettleError).status).toBe(409)
    expect(s.requests.filter((r) => r.url.endsWith('/orders.json'))).toHaveLength(1)
    expect(s.writes.filter((w) => w.op === 'db.updateOne')).toHaveLength(1)
  })

  it('lets only one of a resend and a "sent" at once win', async () => {
    const s = store()
    const results = await Promise.allSettled([
      settleUnknownOrder(s.payload, { order: 'ord-1', outcome: 'sent', printifyId: 'pf-order-7', req: s.req('staff') }),
      settleUnknownOrder(s.payload, { order: 'ord-1', outcome: 'resend', req: s.req('staff') }),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(s.requests).toHaveLength(0)
    expect(s.order().fulfillment.externalId).toBe('pf-order-7')
  })

  it('answers over the endpoint with 403, 400, 409 and 200', async () => {
    const s = store()
    const call = (role: string | undefined, body: unknown) =>
      settleEndpoint().handler({ ...s.req(role), routeParams: { id: 'ord-1' }, json: async () => body } as unknown as PayloadRequest)
    expect((await call('customer', { outcome: 'resend' })).status).toBe(403)
    expect((await call('staff', { outcome: 'sent' })).status).toBe(400)
    const bad = await settleEndpoint().handler({ ...s.req('staff'), routeParams: { id: 'ord-1' }, json: async () => { throw new SyntaxError('not JSON') } } as unknown as PayloadRequest)
    expect(bad.status).toBe(400)
    const ok = await call('staff', { outcome: 'sent', printifyId: 'pf-order-7' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ order: 'ord-1', outcome: 'sent', fulfillment: { externalId: 'pf-order-7', status: 'submitted' } })
    expect((await call('staff', { outcome: 'resend' })).status).toBe(409)
    expect(s.requests).toHaveLength(0)
  })
})
