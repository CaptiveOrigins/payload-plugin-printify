import { createHmac } from 'node:crypto'
import type { Config, PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { PrintifyClient, PrintifyError, printifyPlugin, registerPrintifyWebhooks, syncPrintifyShop, type PrintifyProduct } from '../src'
import { pushVariantPriceHook } from '../src/prices'
import type { PrintifyPluginOptions, ResolvedPrintifyOptions } from '../src/types'
import { pushVisibilityHook } from '../src/visibility'
import { webhookEndpoint } from '../src/webhook'

// No test here reaches Printify: every client gets a fake fetch.
const TOKEN = 'fake-printify-token-abc123'
const SECRET = 'fake-webhook-secret'
const collections = ['products', 'variants', 'variantTypes', 'variantOptions', 'orders'].map((slug) => ({ slug, fields: [] }))
const resolved = (options: PrintifyPluginOptions) =>
  (printifyPlugin(options)({ collections, endpoints: [] } as unknown as Config) as Config & { custom: { printify: ResolvedPrintifyOptions } }).custom.printify

type Call = { method: string; url: string; auth: string | null; body?: string }
const recorder = (respond: (c: Call, n: number) => Response) => {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const c = { method: String(init.method), url, auth: new Headers(init.headers).get('authorization'), body: init.body ? String(init.body) : undefined }
    calls.push(c)
    return respond(c, calls.length)
  }) as typeof globalThis.fetch
  return { calls, fetch }
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })

const product = (overrides: Partial<PrintifyProduct> = {}): PrintifyProduct => ({
  id: 'pf-1',
  title: 'Gecko Mug',
  description: 'A mug.',
  options: [{ name: 'Size', type: 'size', values: [{ id: 1, title: '11oz' }] }],
  variants: [{ id: 501, price: 1500, title: '11oz', is_enabled: true, options: [1] }],
  images: [],
  visible: true,
  blueprint_id: 1,
  print_provider_id: 2,
  ...overrides,
})

describe('client', () => {
  it('sends the token only as a bearer header, only to api.printify.com', async () => {
    const { calls, fetch } = recorder(() => json([{ id: 1, title: 'Shop', sales_channel: 'api' }]))
    await new PrintifyClient(TOKEN, fetch).shops()
    expect(calls[0]!.url).toBe('https://api.printify.com/v1/shops.json')
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(calls[0]!.url).not.toContain(TOKEN)
  })

  it('retries rate limits, then reports errors without the token', async () => {
    const { calls, fetch } = recorder((_c, n) => (n === 1 ? new Response('slow', { status: 429, headers: { 'retry-after': '0.001' } }) : json({ id: 'o1' })))
    await expect(new PrintifyClient(TOKEN, fetch).order('1', 'o1')).resolves.toEqual({ id: 'o1' })
    expect(calls).toHaveLength(2)
    const refused = recorder(() => new Response('{"error":"not found"}', { status: 404 }))
    const error = await new PrintifyClient(TOKEN, refused.fetch).order('1', 'missing').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrintifyError)
    expect((error as PrintifyError).status).toBe(404)
    expect((error as Error).message).not.toContain(TOKEN)
    expect(refused.calls).toHaveLength(1)
  })

  it('retries a read after a 5xx', async () => {
    const { calls, fetch } = recorder((_c, n) => (n < 3 ? new Response('busy', { status: 503, headers: { 'retry-after': '0.001' } }) : json({ id: 'o1', status: 'on-hold' })))
    await expect(new PrintifyClient(TOKEN, fetch).order('1', 'o1')).resolves.toEqual({ id: 'o1', status: 'on-hold' })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET'])
  })

  it('never retries creating an order, on a 5xx or a 429', async () => {
    for (const status of [500, 502, 503, 504, 429]) {
      const { calls, fetch } = recorder(() => new Response('no', { status, headers: { 'retry-after': '0.001' } }))
      const error = await new PrintifyClient(TOKEN, fetch)
        .createOrder('1', { external_id: 'ord-1', line_items: [], shipping_method: 1, send_shipping_notification: false, address_to: { first_name: 'Sam', last_name: 'Sample', country: 'US', address1: '1 Test Way', city: 'Testville', zip: '85000' } })
        .catch((e: unknown) => e)
      expect((error as PrintifyError).status).toBe(status)
      expect(calls).toHaveLength(1)
    }
  })
})

/** A small in-memory Payload for the webhook and sync paths. */
const fakePayload = (opts: ResolvedPrintifyOptions, docs: Record<string, Record<string, unknown>[]> = {}) => {
  const writes: { op: string; collection: string; id?: unknown; data: Record<string, unknown> }[] = []
  let next = 1
  const matches = (doc: Record<string, unknown>, where: unknown): boolean => {
    const w = where as Record<string, unknown>
    if (Array.isArray(w.and)) return w.and.every((x) => matches(doc, x))
    return Object.entries(w).every(([path, cond]) => {
      const value = path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], doc)
      const c = cond as { equals?: unknown; exists?: boolean; not_equals?: unknown }
      if ('exists' in c) return (value != null) === c.exists
      if ('not_equals' in c) return value !== c.not_equals
      // Worst case: an adapter that drops an undefined constraint matches everything.
      if (c.equals === undefined) return true
      return value === c.equals
    })
  }
  const payload = {
    config: { routes: { api: '/api' }, custom: { printify: opts } },
    find: async ({ collection, where }: { collection: string; where: unknown }) => ({ docs: (docs[collection] ?? []).filter((d) => matches(d, where)) }),
    create: async ({ collection, data }: { collection: string; data: Record<string, unknown> }) => {
      const doc = { id: `new-${next++}`, ...data }
      ;(docs[collection] ??= []).push(doc)
      writes.push({ op: 'create', collection, data })
      return doc
    },
    update: async ({ collection, id, data }: { collection: string; id: unknown; data: Record<string, unknown> }) => {
      writes.push({ op: 'update', collection, id, data })
      return { id, ...data }
    },
    db: {
      // A conditional write: only a document matching `where` is changed.
      updateOne: async ({ collection, where, data }: { collection: string; where: unknown; data: Record<string, unknown> }) => {
        const doc = (docs[collection] ?? []).find((d) => matches(d, where))
        if (!doc) return null
        Object.assign(doc, data)
        writes.push({ op: 'db.updateOne', collection, id: doc.id, data })
        return doc
      },
    },
    logger: { info: () => {}, error: () => {} },
  }
  return { payload, writes }
}

const signed = (event: unknown, opts: ResolvedPrintifyOptions, payload: unknown, secret = SECRET) => {
  const body = JSON.stringify(event)
  const headers = new Headers({ 'x-pfy-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` })
  return webhookEndpoint(opts).handler({ text: async () => body, headers, payload } as unknown as PayloadRequest)
}

describe('webhook', () => {
  it('refuses wrong signatures, a missing secret, and a turned-off plugin, before reading anything', async () => {
    const api = recorder(() => json(product()))
    const on = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: api.fetch })
    const event = { id: 'e1', type: 'product:updated', resource: { id: 'pf-1', type: 'product' } }
    const store = fakePayload(on)
    expect((await signed(event, on, store.payload, 'wrong-secret')).status).toBe(401)
    expect((await signed(event, resolved({ apiToken: TOKEN, shopId: '1', fetch: api.fetch }), store.payload)).status).toBe(401)
    expect((await signed(event, resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, enabled: false, fetch: api.fetch }), store.payload)).status).toBe(401)
    expect(api.calls).toHaveLength(0)
    expect(store.writes).toHaveLength(0)
  })

  it('refuses events when the store tenant is unknown', async () => {
    const api = recorder(() => json(product()))
    const opts = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: api.fetch, tenant: { resolve: async () => null } })
    const store = fakePayload(opts)
    const res = await signed({ id: 'e1', type: 'product:updated', resource: { id: 'pf-1', type: 'product' } }, opts, store.payload)
    expect(res.status).toBe(500)
    expect(api.calls).toHaveLength(0)
    expect(store.writes).toHaveLength(0)
  })

  it('copies order status and tracking onto the matching order only', async () => {
    const api = recorder(() => json({ id: 'pf-order-9', status: 'fulfilled', shipments: [{ carrier: 'usps', number: 'TRACK1', url: 'https://tracking.example.test/TRACK1' }] }))
    const opts = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: api.fetch })
    const store = fakePayload(opts, { orders: [{ id: 'ord-1', fulfillment: { provider: 'printify', externalId: 'pf-order-9', status: 'on-hold' } }] })
    await signed({ id: 'e2', type: 'order:shipment:created', resource: { id: 'pf-order-9', type: 'order' } }, opts, store.payload)
    expect(store.writes).toEqual([
      {
        op: 'update',
        collection: 'orders',
        id: 'ord-1',
        data: { fulfillment: { provider: 'printify', externalId: 'pf-order-9', status: 'fulfilled', shipments: [{ carrier: 'usps', number: 'TRACK1', url: 'https://tracking.example.test/TRACK1', deliveredAt: null }] } },
      },
    ])
    store.writes.length = 0
    await signed({ id: 'e3', type: 'order:updated', resource: { id: 'pf-order-unknown', type: 'order' } }, opts, store.payload)
    expect(store.writes).toHaveLength(0)
  })

  describe('an order whose create had an unclear outcome', () => {
    const unknown = (extra: Record<string, unknown> = {}) => ({
      id: 'ord-1',
      status: 'processing',
      tenant: 't1',
      fulfillment: { provider: 'printify', status: 'unknown', error: 'Outcome unknown, check Printify before sending again (external_id ord-1). 502' },
      ...extra,
    })
    const printifyOrder = (extra: Record<string, unknown> = {}) => json({ id: 'pf-order-9', external_id: 'ord-1', status: 'on-hold', shipments: [], ...extra })

    it('is settled by a signed order event whose external_id is its id', async () => {
      const api = recorder(() => printifyOrder())
      const opts = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: api.fetch })
      const store = fakePayload(opts, { orders: [unknown()] })
      const res = await signed({ id: 'e6', type: 'order:created', resource: { id: 'pf-order-9', type: 'order' } }, opts, store.payload)
      expect(res.status).toBe(200)
      expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.printify.com/v1/shops/1/orders/pf-order-9.json'])
      expect(store.writes).toHaveLength(1)
      expect(store.writes[0]).toMatchObject({ op: 'db.updateOne', collection: 'orders', id: 'ord-1' })
      expect(store.writes[0]!.data.fulfillment).toMatchObject({ provider: 'printify', externalId: 'pf-order-9', status: 'on-hold', error: null, shipments: [] })
      expect(typeof (store.writes[0]!.data.fulfillment as Record<string, unknown>).submittedAt).toBe('string')
    })

    it('is left alone when the event is unsigned, for another order, or for an order that is not unknown', async () => {
      const api = recorder(() => printifyOrder())
      const opts = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: api.fetch })
      const event = { id: 'e7', type: 'order:updated', resource: { id: 'pf-order-9', type: 'order' } }

      const forged = fakePayload(opts, { orders: [unknown()] })
      expect((await signed(event, opts, forged.payload, 'wrong-secret')).status).toBe(401)
      expect(forged.writes).toHaveLength(0)

      // Printify's order belongs to some other order of ours, or to none (no external_id).
      for (const external_id of ['ord-2', undefined]) {
        const elsewhere = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: recorder(() => printifyOrder({ external_id })).fetch })
        const other = fakePayload(elsewhere, { orders: [unknown()] })
        await signed(event, elsewhere, other.payload)
        expect(other.writes).toHaveLength(0)
      }

      for (const status of ['failed', 'held', 'on-hold']) {
        const settled = fakePayload(opts, { orders: [unknown({ fulfillment: { provider: 'printify', status } })] })
        await signed(event, opts, settled.payload)
        expect(settled.writes).toHaveLength(0)
      }
    })

    it('is settled only in its own store', async () => {
      const api = recorder(() => printifyOrder())
      const theirs = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: api.fetch, tenant: { resolve: async () => 't2' } })
      const store = fakePayload(theirs, { orders: [unknown()] })
      await signed({ id: 'e8', type: 'order:created', resource: { id: 'pf-order-9', type: 'order' } }, theirs, store.payload)
      expect(store.writes).toHaveLength(0)
      const ours = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: api.fetch, tenant: { resolve: async () => 't1' } })
      await signed({ id: 'e9', type: 'order:created', resource: { id: 'pf-order-9', type: 'order' } }, ours, store.payload)
      expect(store.writes).toHaveLength(1)
    })

    it('costs no Printify call when no order is unknown', async () => {
      const api = recorder(() => printifyOrder())
      const opts = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: api.fetch })
      const store = fakePayload(opts, { orders: [unknown({ fulfillment: { provider: 'printify', status: 'failed' } })] })
      await signed({ id: 'e10', type: 'order:updated', resource: { id: 'pf-order-elsewhere', type: 'order' } }, opts, store.payload)
      expect(api.calls).toHaveLength(0)
      expect(store.writes).toHaveLength(0)
    })
  })

  it('turns a product deleted in Printify into a draft, keeping it for order history', async () => {
    const opts = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: recorder(() => json({})).fetch })
    const store = fakePayload(opts, { products: [{ id: 'p1', printify: { productId: 'pf-1' }, _status: 'published' }] })
    await signed({ id: 'e4', type: 'product:deleted', resource: { id: 'pf-1', type: 'product' } }, opts, store.payload)
    expect(store.writes).toEqual([{ op: 'update', collection: 'products', id: 'p1', data: { _status: 'draft' } }])
  })

  it('tells Printify when publishing fails on the API channel', async () => {
    const api = recorder((c) => (c.method === 'GET' ? json(product()) : json({})))
    const opts = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: api.fetch, publishHandshake: true })
    const store = fakePayload(opts)
    store.payload.create = async () => {
      throw new Error('database unavailable')
    }
    await expect(signed({ id: 'e5', type: 'product:publish:started', resource: { id: 'pf-1', type: 'product', data: { action: 'create' } } }, opts, store.payload)).rejects.toThrow(/database/)
    expect(api.calls.at(-1)!.url).toBe('https://api.printify.com/v1/shops/1/products/pf-1/publishing_failed.json')
  })
})

describe('shop sync and webhook registration', () => {
  it('only reads from Printify, imports hidden products as drafts, and drafts products gone from Printify', async () => {
    const api = recorder((c) => (c.url.includes('/products.json') ? json({ data: [product({ visible: false })], last_page: 1 }) : json({})))
    const opts = resolved({ apiToken: TOKEN, shopId: '1', fetch: api.fetch })
    const store = fakePayload(opts, { products: [{ id: 'old', printify: { productId: 'pf-gone' }, _status: 'published' }] })
    const r = await syncPrintifyShop(store.payload as never)
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(r.removed).toBe(1)
    const created = store.writes.find((w) => w.op === 'create' && w.collection === 'products')!
    expect(created.data).toMatchObject({ _status: 'draft', priceInUSD: 1500, printify: { productId: 'pf-1' } })
    expect(store.writes).toContainEqual({ op: 'update', collection: 'products', id: 'old', data: { _status: 'draft' } })
  })

  it('replaces only this host’s webhooks, and refuses without a secret', async () => {
    const api = recorder((c) =>
      c.method === 'GET'
        ? json([
            { id: 'w1', topic: 'order:updated', url: 'https://shop.example.test/api/printify/webhook' },
            { id: 'w2', topic: 'order:updated', url: 'https://other.example.test/api/printify/webhook' },
          ])
        : json({}),
    )
    const opts = resolved({ apiToken: TOKEN, shopId: '1', webhookSecret: SECRET, fetch: api.fetch })
    await registerPrintifyWebhooks(fakePayload(opts).payload as never, 'https://shop.example.test/')
    const deletes = api.calls.filter((c) => c.method === 'DELETE')
    expect(deletes.map((c) => c.url)).toEqual(['https://api.printify.com/v1/shops/1/webhooks/w1.json?host=shop.example.test'])
    expect(api.calls.filter((c) => c.method === 'POST').every((c) => JSON.parse(c.body!).url === 'https://shop.example.test/api/printify/webhook')).toBe(true)
    const noSecret = resolved({ apiToken: TOKEN, shopId: '1', fetch: api.fetch })
    await expect(registerPrintifyWebhooks(fakePayload(noSecret).payload as never, 'https://shop.example.test')).rejects.toThrow(/webhookSecret/)
  })
})

describe('price and visibility pushes refuse when Printify does', () => {
  const variant = { id: 'v1', product: 'p1', priceInUSD: 1500, printify: { variantId: 501 } }
  const req = { payload: { findByID: async () => ({ id: 'p1', printify: { productId: 'pf-1' } }) }, query: {} } as unknown as PayloadRequest
  const price = (fetch: typeof globalThis.fetch, value: number) =>
    pushVariantPriceHook(resolved({ apiToken: TOKEN, shopId: '1', pushPrices: true, fetch }))({ data: { priceInUSD: value }, originalDoc: variant, operation: 'update', req, context: {} } as never)

  it('refuses prices that are not whole cents above zero, without calling Printify', async () => {
    const api = recorder(() => json(product()))
    for (const bad of [0, -100, 12.5]) await expect(price(api.fetch, bad)).rejects.toMatchObject({ status: 400 })
    expect(api.calls).toHaveLength(0)
  })

  it('refuses a price when Printify errors or no longer has the variant', async () => {
    const down = recorder((c) => (c.method === 'GET' ? json(product()) : new Response('nope', { status: 400 })))
    await expect(price(down.fetch, 1400)).rejects.toMatchObject({ status: 502 })
    const gone = recorder(() => json(product({ variants: [{ id: 999, price: 1500, title: 'x', is_enabled: true, options: [1] }] })))
    await expect(price(gone.fetch, 1400)).rejects.toMatchObject({ status: 409 })
    expect(gone.calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })

  it('refuses a visibility change when Printify errors', async () => {
    const down = recorder((c) => (c.method === 'GET' ? json(product()) : new Response('nope', { status: 400 })))
    const hook = pushVisibilityHook(resolved({ apiToken: TOKEN, shopId: '1', pushVisibility: true, fetch: down.fetch }))
    await expect(
      hook({ data: { _status: 'draft' }, originalDoc: { id: 'p1', _status: 'published', printify: { productId: 'pf-1' } }, operation: 'update', req, context: {} } as never),
    ).rejects.toMatchObject({ status: 502 })
  })
})
