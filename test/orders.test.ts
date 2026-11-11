import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { printifyPlugin } from '../src'
import { submitOrderHook } from '../src/orders'
import type { PrintifyPluginOptions, ResolvedPrintifyOptions } from '../src/types'

// Paid orders cost real money in Printify. Every call here goes to a fake fetch.
const collections = ['products', 'variants', 'variantTypes', 'variantOptions', 'orders'].map((slug) => ({ slug, fields: [] }))
const resolved = (options: PrintifyPluginOptions) =>
  (printifyPlugin(options)({ collections, endpoints: [] } as unknown as Config) as Config & { custom: { printify: ResolvedPrintifyOptions } }).custom.printify

const TOKEN = 'fake-printify-token-abc123'

type Request = { method: string; url: string; auth: string | null; body: unknown }
const fakePrintify = (respond: (r: Request) => Response = () => new Response(JSON.stringify({ id: 'pf-order-9' }), { status: 200 })) => {
  const requests: Request[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const r = { method: String(init.method), url, auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(String(init.body)) : undefined }
    requests.push(r)
    return respond(r)
  }) as typeof globalThis.fetch
  return { requests, fetch }
}

/** A fake Payload: variants v1 (Printify) and v-local (not Printify); records order updates, send claims and logs. */
const fakeReq = () => {
  const updates: { id: unknown; data: { fulfillment: Record<string, unknown> }; context: unknown }[] = []
  const claims: { where: unknown; data: { fulfillment: Record<string, unknown> } }[] = []
  const logs: unknown[] = []
  const variants: Record<string, unknown> = {
    v1: { id: 'v1', printify: { variantId: 1001 }, product: { id: 'p1', printify: { productId: 'pf-1' } } },
    'v-local': { id: 'v-local', product: { id: 'p2' } },
  }
  const req = {
    payload: {
      findByID: async ({ id }: { id: string }) => variants[id],
      update: async (args: (typeof updates)[number]) => void updates.push(args),
      // The conditional write that claims the send. Its condition is proven on a real database (real-db.test.ts).
      db: { updateOne: async (args: (typeof claims)[number]) => (claims.push(args), { id: 'ord-1' }) },
      logger: { error: (obj: unknown) => void logs.push(obj) },
    },
  }
  return { req, updates, claims, logs }
}

const paidOrder = (extra: Record<string, unknown> = {}) => ({
  id: 'ord-1',
  status: 'processing',
  tenant: 't1',
  customerEmail: 'buyer@example.com',
  shippingAddress: { firstName: 'Sam', lastName: 'Sample', country: 'US', state: 'AZ', addressLine1: '1 Test Way', city: 'Testville', postalCode: '85000' },
  items: [
    { variant: 'v1', quantity: 2 },
    { variant: 'v-local', quantity: 1 },
  ],
  ...extra,
})

const run = async (options: PrintifyPluginOptions, args: { doc?: Record<string, unknown>; previousDoc?: Record<string, unknown>; operation?: string; context?: Record<string, unknown> } = {}) => {
  const fake = fakePrintify()
  const r = fakeReq()
  const hook = submitOrderHook(resolved({ apiToken: TOKEN, shopId: '123', fetch: fake.fetch, ...options }))
  const doc = args.doc ?? paidOrder()
  const returned = await hook({ doc, previousDoc: args.previousDoc ?? { status: 'pending' }, operation: args.operation ?? 'update', req: r.req, context: args.context ?? {} } as never)
  return { ...fake, ...r, returned, doc }
}

describe('orders → Printify', () => {
  it('sends a paid order once, with only its Printify items, waiting for approval', async () => {
    const { requests, updates } = await run({})
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST https://api.printify.com/v1/shops/123/orders.json'])
    expect(requests[0]!.body).toMatchObject({
      external_id: 'ord-1',
      line_items: [{ product_id: 'pf-1', variant_id: 1001, quantity: 2 }],
      shipping_method: 1,
      send_shipping_notification: false,
      address_to: { first_name: 'Sam', country: 'US', zip: '85000', email: 'buyer@example.com' },
    })
    expect(updates).toHaveLength(1)
    expect(updates[0]!.data.fulfillment).toMatchObject({ provider: 'printify', externalId: 'pf-order-9', status: 'on-hold', error: null })
    expect(updates[0]!.context).toEqual({ printify: true })
  })

  it('sends to production only when asked', async () => {
    const { requests, updates } = await run({ sendToProduction: true })
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.printify.com/v1/shops/123/orders.json',
      'https://api.printify.com/v1/shops/123/orders/pf-order-9/send_to_production.json',
    ])
    expect(updates[0]!.data.fulfillment.status).toBe('sending-to-production')
  })

  it('never sends unpaid, already-sent, re-saved or sync-written orders, or when turned off', async () => {
    const cases = [
      await run({}, { doc: paidOrder({ status: 'pending' }) }),
      await run({}, { doc: paidOrder({ fulfillment: { externalId: 'pf-order-1' } }) }),
      await run({}, { previousDoc: { status: 'processing' } }),
      await run({}, { context: { printify: true } }),
      await run({ enabled: false }),
      await run({ apiToken: undefined }),
      await run({}, { doc: paidOrder({ items: [{ variant: 'v-local', quantity: 1 }] }) }),
    ]
    for (const c of cases) {
      expect(c.requests).toHaveLength(0)
      expect(c.updates).toHaveLength(0)
    }
  })

  it('sends a new order created already paid', async () => {
    const { requests } = await run({}, { operation: 'create', previousDoc: {} })
    expect(requests).toHaveLength(1)
  })

  it('never sends another store’s order, or when the store tenant is unknown', async () => {
    const other = await run({ tenant: { resolve: async () => 't2' } })
    const unknown = await run({ tenant: { resolve: async () => null } })
    const ours = await run({ tenant: { resolve: async () => 't1' } })
    expect(other.requests).toHaveLength(0)
    expect(unknown.requests).toHaveLength(0)
    expect(ours.requests).toHaveLength(1)
  })

  it('claims the send, as unknown, with one conditional write before calling Printify', async () => {
    const { claims, requests } = await run({})
    expect(claims).toHaveLength(1)
    expect(claims[0]!.where).toEqual({
      and: [{ id: { equals: 'ord-1' } }, { 'fulfillment.externalId': { exists: false } }, { 'fulfillment.status': { not_equals: 'unknown' } }],
    })
    expect(claims[0]!.data.fulfillment).toMatchObject({ provider: 'printify', status: 'unknown' })
    expect(requests).toHaveLength(1)
  })

  it('sends nothing when another save claimed the send first', async () => {
    const fake = fakePrintify()
    const r = fakeReq()
    ;(r.req.payload as unknown as { db: { updateOne: () => Promise<null> } }).db.updateOne = async () => null
    const hook = submitOrderHook(resolved({ apiToken: TOKEN, shopId: '123', fetch: fake.fetch }))
    await hook({ doc: paidOrder(), previousDoc: { status: 'pending' }, operation: 'update', req: r.req, context: {} } as never)
    expect(fake.requests).toHaveLength(0)
    expect(r.updates).toHaveLength(0)
  })

  it('holds the order when the guard blocks it, without calling Printify', async () => {
    const { requests, updates, claims } = await run({ beforePrintifyWrite: () => { throw new Error('staging only reads Printify') } })
    expect(claims).toHaveLength(0)
    expect(requests).toHaveLength(0)
    expect(updates[0]!.data.fulfillment).toMatchObject({ provider: 'printify', status: 'held', error: 'staging only reads Printify' })
  })

  it('records a refused order on the order without throwing, and never logs the token or address', async () => {
    const fake = fakePrintify(() => new Response('{"error":"bad address"}', { status: 400 }))
    const r = fakeReq()
    const hook = submitOrderHook(resolved({ apiToken: TOKEN, shopId: '123', fetch: fake.fetch }))
    const doc = paidOrder()
    await expect(hook({ doc, previousDoc: { status: 'pending' }, operation: 'update', req: r.req, context: {} } as never)).resolves.toBe(doc)
    expect(r.updates[0]!.data.fulfillment).toMatchObject({ status: 'failed' })
    expect(String(r.updates[0]!.data.fulfillment.error)).toContain('400')
    expect(String(r.updates[0]!.data.fulfillment.error)).not.toContain(TOKEN)
    expect(r.logs).toEqual([{ order: 'ord-1' }])
  })

  describe('a create whose outcome is unknown', () => {
    // Printify may have created the order before the 5xx, timeout or dropped connection.
    const failing = {
      '5xx': () => new Response('bad gateway', { status: 502 }),
      timeout: () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') },
      'network error': () => { throw new TypeError('fetch failed') },
    }
    for (const [name, respond] of Object.entries(failing)) {
      it(`sends a ${name} create once, marks it unknown, and never resends it`, async () => {
        const fake = fakePrintify(respond)
        const r = fakeReq()
        const hook = submitOrderHook(resolved({ apiToken: TOKEN, shopId: '123', fetch: fake.fetch, sendToProduction: true }))
        const doc = paidOrder()
        await expect(hook({ doc, previousDoc: { status: 'pending' }, operation: 'update', req: r.req, context: {} } as never)).resolves.toBe(doc)
        expect(fake.requests.map((q) => `${q.method} ${q.url}`)).toEqual(['POST https://api.printify.com/v1/shops/123/orders.json'])
        expect(r.updates).toHaveLength(1)
        const fulfillment = r.updates[0]!.data.fulfillment
        expect(fulfillment).toMatchObject({ provider: 'printify', status: 'unknown' })
        expect(fulfillment.externalId).toBeUndefined()
        expect(String(fulfillment.error)).toContain('Outcome unknown, check Printify before sending again')
        expect(String(fulfillment.error)).toContain('ord-1')
        expect(String(fulfillment.error)).not.toContain(TOKEN)

        // The next hook runs (re-saved, or set back to paid) send nothing.
        const saved = { ...doc, fulfillment }
        for (const previousDoc of [{ status: 'processing' }, { status: 'pending' }]) {
          await hook({ doc: saved, previousDoc, operation: 'update', req: r.req, context: {} } as never)
        }
        expect(fake.requests).toHaveLength(1)
        expect(r.updates).toHaveLength(1)
      })
    }

    it('still records a refused create (4xx) as failed, not unknown', async () => {
      const fake = fakePrintify(() => new Response('{"error":"bad address"}', { status: 422 }))
      const r = fakeReq()
      await submitOrderHook(resolved({ apiToken: TOKEN, shopId: '123', fetch: fake.fetch }))({ doc: paidOrder(), previousDoc: { status: 'pending' }, operation: 'update', req: r.req, context: {} } as never)
      expect(fake.requests).toHaveLength(1)
      expect(r.updates[0]!.data.fulfillment.status).toBe('failed')
    })

    it('keeps the Printify id when the order was created but sending to production failed', async () => {
      const fake = fakePrintify((q) => (q.url.endsWith('/orders.json') ? new Response(JSON.stringify({ id: 'pf-order-9' }), { status: 200 }) : new Response('down', { status: 503 })))
      const r = fakeReq()
      await submitOrderHook(resolved({ apiToken: TOKEN, shopId: '123', fetch: fake.fetch, sendToProduction: true }))({ doc: paidOrder(), previousDoc: { status: 'pending' }, operation: 'update', req: r.req, context: {} } as never)
      expect(fake.requests).toHaveLength(2)
      expect(r.updates[0]!.data.fulfillment).toMatchObject({ externalId: 'pf-order-9', status: 'failed' })
    })
  })
})
