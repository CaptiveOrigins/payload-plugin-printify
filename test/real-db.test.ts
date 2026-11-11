import { createHmac } from 'node:crypto'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { ecommercePlugin } from '@payloadcms/plugin-ecommerce'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type CollectionConfig, type Payload, type PayloadRequest, type Plugin } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { printifyPlugin, PrintifySettleError, settleUnknownOrder, syncPrintifyProduct, type PrintifyProduct, type ResolvedPrintifyOptions } from '../src'

// A real Payload with Payload's own ecommerce plugin (and, for tenancy, its multi-tenant plugin) on
// an in-memory MongoDB replica set. Printify is a fake fetch: nothing here reaches Printify.
// Made-up shop, products, orders, people and addresses throughout.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const TOKEN = 'fake-printify-token-abc123'
const SECRET = 'fake-webhook-secret'
const SHOP = '123'
const PASSWORD = 'a-made-up-test-password'

/**
 * A fake Printify. Each order create waits a little (so racing callers overlap) and answers with
 * `create(n)` for the n-th create. `orders` is what Printify holds, for its GET order answers.
 */
function fakePrintify() {
  const state = {
    calls: [] as { method: string; path: string; body?: Doc }[],
    create: (n: number): Response | Promise<Response> => Response.json({ id: `pf-order-${n}` }),
    orders: new Map<string, Doc>(),
  }
  const fetch = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.printify.com/v1', '')
    const call = { method: String(init.method), path, body: init.body ? (JSON.parse(String(init.body)) as Doc) : undefined }
    state.calls.push(call)
    if (call.method === 'POST' && path === `/shops/${SHOP}/orders.json`) {
      await new Promise((r) => setTimeout(r, 25))
      return state.create(creates(state).length)
    }
    const order = path.match(/^\/shops\/\d+\/orders\/([^/]+)\.json$/)
    if (call.method === 'GET' && order) {
      const found = state.orders.get(order[1]!)
      return found ? Response.json(found) : Response.json({ error: 'not found' }, { status: 404 })
    }
    if (call.method === 'POST' && path.endsWith('/send_to_production.json')) return Response.json({})
    return Response.json({ error: `unexpected ${call.method} ${path}` }, { status: 500 })
  }) as typeof globalThis.fetch
  return { ...state, state, fetch }
}
const creates = (s: { calls: { method: string; path: string; body?: Doc }[] }) => s.calls.filter((c) => c.method === 'POST' && c.path === `/shops/${SHOP}/orders.json`)

const product = (id: string, variantId: number, title: string): PrintifyProduct => ({
  id,
  title,
  description: '<p>A made-up test product.</p>',
  options: [{ name: 'Size', type: 'size', values: [{ id: variantId, title: '11 oz' }] }],
  variants: [{ id: variantId, price: 1500, title: '11 oz', is_enabled: true, options: [variantId] }],
  images: [],
  visible: true,
  blueprint_id: 1,
  print_provider_id: 2,
})

const isAdmin = ({ req }: { req: PayloadRequest }) => (req.user as Doc | null)?.roles?.includes('admin') === true
const ecommerceAccess = {
  isAdmin,
  adminOnlyFieldAccess: isAdmin,
  adminOrPublishedStatus: ({ req }: { req: PayloadRequest }) => isAdmin({ req }) || { _status: { equals: 'published' } },
  customerOnlyFieldAccess: ({ req }: { req: PayloadRequest }) => Boolean(req.user),
  isCustomer: ({ req }: { req: PayloadRequest }) => Boolean(req.user),
  isDocumentOwner: ({ req }: { req: PayloadRequest }) => (req.user ? { customer: { equals: req.user.id } } : false),
}

/**
 * Some stores create the order before payment and mark it paid later. Payload's ecommerce plugin
 * creates it paid ('processing'); this host adds a 'pending' status before it, so tests can race two
 * saves that both turn an order paid.
 */
const withPending = ({ defaultCollection }: { defaultCollection: CollectionConfig }): CollectionConfig => ({
  ...defaultCollection,
  fields: defaultCollection.fields.map((f) =>
    'name' in f && f.name === 'status' && f.type === 'select' ? { ...f, options: [{ label: 'Pending', value: 'pending' }, ...f.options] } : f,
  ),
})

type Store = {
  key: string
  payload: Payload
  printify: ReturnType<typeof fakePrintify>
  opts: ResolvedPrintifyOptions
  users: Record<string, Doc>
  tokens: Map<string, string>
}

async function boot(
  mongo: MongoMemoryReplSet,
  key: string,
  tenancy: { tenants: Plugin; resolve: () => string | null } | null,
  { transactions = true } = {},
): Promise<Store> {
  const printify = fakePrintify()
  const payload = await getPayload({
    key,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://shop.example.com',
      typescript: { autoGenerate: false },
      // Without transactions, as Payload runs on a MongoDB that isn't a replica set.
      db: mongooseAdapter({ url: mongo.getUri(key), ensureIndexes: true, ...(transactions ? {} : { transactionOptions: false as const }) }),
      collections: [
        ...(tenancy ? [{ slug: 'tenants', fields: [{ name: 'name', type: 'text' as const }] }] : []),
        { slug: 'users', auth: true, fields: [{ name: 'roles', type: 'select', hasMany: true, options: ['admin', 'staff', 'customer'] }] },
      ],
      admin: { user: 'users' },
      plugins: [
        ecommercePlugin({
          access: ecommerceAccess as never,
          customers: { slug: 'users' },
          inventory: false,
          products: { variants: true },
          orders: { ordersCollectionOverride: withPending as never },
        }),
        printifyPlugin({
          apiToken: TOKEN,
          shopId: SHOP,
          webhookSecret: SECRET,
          fetch: printify.fetch,
          access: { manage: ({ req }) => (req.user as Doc | null)?.roles?.includes('admin') === true },
          ...(tenancy ? { tenant: { field: 'tenant', resolve: async () => tenancy.resolve() } } : {}),
        }),
        ...(tenancy ? [tenancy.tenants] : []),
      ],
    }),
  } as never)
  const users: Record<string, Doc> = {}
  for (const [name, roles] of [
    ['admin', ['admin']],
    ['staff', ['staff']],
    ['customer', ['customer']],
  ] as const)
    users[name] = await payload.create({ collection: 'users', data: { email: `${name}@example.com`, password: PASSWORD, roles: [...roles] } as never })
  return { key, payload, printify, opts: payload.config.custom.printify as ResolvedPrintifyOptions, users, tokens: new Map() }
}

/** Through Payload's own REST routing, as the admin's browser or Printify would send it. */
async function rest(s: Store, path: string, init: { user?: string; body?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', ...init.headers })
  if (init.user) {
    if (!s.tokens.has(init.user))
      s.tokens.set(init.user, (await s.payload.login({ collection: 'users', data: { email: `${init.user}@example.com`, password: PASSWORD } })).token!)
    headers.set('Authorization', `JWT ${s.tokens.get(init.user)}`)
  }
  const request = new Request(`https://shop.example.com/api${path}`, { method: 'POST', headers, body: init.body })
  const res = await handleEndpoints({ config: Promise.resolve(s.payload.config), payloadInstanceCacheKey: s.key, request } as never)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Doc }
}

const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
const webhook = (s: Store, event: Doc, signature?: string | null) => {
  const body = JSON.stringify(event)
  return rest(s, '/printify/webhook', { body, headers: signature === null ? {} : { 'x-pfy-signature': signature ?? sign(body) } })
}
const orderEvent = (printifyId: string, n = 1) => ({ id: `evt-${printifyId}-${n}`, type: 'order:updated', resource: { id: printifyId, type: 'order' } })
const settleOver = (s: Store, id: unknown, user: string | undefined, body: Doc) => rest(s, `/printify/orders/${id}/settle`, { user, body: JSON.stringify(body) })

const get = (s: Store, id: unknown) => s.payload.findByID({ collection: 'orders', id: id as string, depth: 0 }) as Promise<Doc>
const reqAs = async (s: Store, user: string | null) => ({ payload: s.payload, user: user ? { ...s.users[user], collection: 'users' } : null }) as unknown as PayloadRequest

/** A Printify product synced into the store (by the plugin's own sync), and its variant. */
async function stocked(s: Store, tenantId: string | null, p: PrintifyProduct) {
  const ours = await syncPrintifyProduct(s.payload, s.opts, tenantId, p)
  const variant = (await s.payload.find({ collection: 'variants', where: { product: { equals: ours.id } }, depth: 0, draft: true })).docs[0] as Doc
  return { product: ours.id, variant: String(variant.id) }
}

let address = 0
async function order(s: Store, item: { product: string; variant: string }, data: Doc = {}) {
  address++
  return (await s.payload.create({
    collection: 'orders',
    // Test set-up. With the multi-tenant plugin, a create's first commands in a transaction are two
    // relationship checks at once, and MongoDB sometimes refuses the second under load (a Payload
    // and driver quirk, not this plugin's). Paying the order, an update, keeps its transaction.
    disableTransaction: true,
    data: {
      status: 'pending',
      customerEmail: `buyer${address}@example.com`,
      shippingAddress: { firstName: 'Sam', lastName: 'Sample', addressLine1: `${address} Test Way`, city: 'Testville', state: 'AZ', postalCode: '85000', country: 'US' },
      items: [{ product: item.product, variant: item.variant, quantity: 2 }],
      ...data,
    } as never,
  })) as Doc
}
const pay = (s: Store, id: unknown) => s.payload.update({ collection: 'orders', id: id as string, data: { status: 'processing' } as never })
/** An order whose Printify create had an unclear outcome (a 502), as the paid-order hook leaves it. */
async function unknownOrder(s: Store, item: { product: string; variant: string }, data: Doc = {}) {
  const o = await order(s, item, data)
  const before = s.printify.state.create
  s.printify.state.create = () => new Response('Bad gateway', { status: 502 })
  await pay(s, o.id)
  s.printify.state.create = before
  const doc = await get(s, o.id)
  expect(doc.fulfillment.status).toBe('unknown')
  return doc
}

let mongo: MongoMemoryReplSet
let one: Store
let item: { product: string; variant: string }

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  one = await boot(mongo, 'printify-single', null)
  item = await stocked(one, null, product('pf-prod-1', 1001, 'Test Mug'))
}, 120_000)

afterAll(async () => {
  for (const s of [one, many, bare].filter(Boolean)) await s.payload.destroy()
  await mongo?.stop()
})

describe('the paid-order hook, on a real database', () => {
  it('sends a paid order to Printify once, with the synced Printify ids, and records it', async () => {
    const before = creates(one.printify).length
    const o = await order(one, item)
    expect(creates(one.printify).length).toBe(before) // not paid yet
    await pay(one, o.id)
    const sent = creates(one.printify).slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toMatchObject({ external_id: String(o.id), line_items: [{ product_id: 'pf-prod-1', variant_id: 1001, quantity: 2 }] })
    const doc = await get(one, o.id)
    expect(doc.fulfillment).toMatchObject({ provider: 'printify', externalId: `pf-order-${before + 1}`, status: 'on-hold', error: null })
    // Saving it again, paid, sends nothing more.
    await one.payload.update({ collection: 'orders', id: o.id, data: { customerEmail: 'changed@example.com' } as never })
    await pay(one, o.id)
    expect(creates(one.printify).length).toBe(before + 1)
  })

  it('sends a paid order exactly once when two saves that pay it race', async () => {
    for (let round = 0; round < 5; round++) {
      const o = await order(one, item)
      const before = creates(one.printify).length
      await Promise.allSettled([pay(one, o.id), pay(one, o.id)])
      const sent = creates(one.printify).slice(before)
      expect(sent.map((c) => c.body!.external_id)).toEqual([String(o.id)])
      const doc = await get(one, o.id)
      expect(doc.status).toBe('processing')
      expect(doc.fulfillment.externalId).toBe(`pf-order-${before + 1}`)
    }
  })

  it('sends an order created paid exactly once when it is saved again at the same time', async () => {
    const before = creates(one.printify).length
    const o = await order(one, item, { status: 'processing' })
    await Promise.allSettled([pay(one, o.id), pay(one, o.id), one.payload.update({ collection: 'orders', id: o.id, data: { customerEmail: 'again@example.com' } as never })])
    expect(creates(one.printify).slice(before).map((c) => c.body!.external_id)).toEqual([String(o.id)])
  })

  it('marks an order unknown on a 5xx and never sends it again on its own', async () => {
    const o = await unknownOrder(one, item)
    expect(o.fulfillment.error).toContain(`external_id ${o.id}`)
    expect(o.fulfillment.externalId ?? null).toBeNull()
    const before = creates(one.printify).length
    await one.payload.update({ collection: 'orders', id: o.id, data: { status: 'pending' } as never })
    await pay(one, o.id)
    await Promise.allSettled([pay(one, o.id), pay(one, o.id)])
    expect(creates(one.printify).length).toBe(before)
    expect((await get(one, o.id)).fulfillment.status).toBe('unknown')
  })

  it('marks an order failed on a 4xx, as a refusal', async () => {
    const o = await order(one, item)
    const before = one.printify.state.create
    one.printify.state.create = () => Response.json({ error: 'Invalid address' }, { status: 400 })
    await pay(one, o.id)
    one.printify.state.create = before
    const doc = await get(one, o.id)
    expect(doc.fulfillment.status).toBe('failed')
    expect(doc.fulfillment.error).toContain('Printify 400')
    expect(doc.fulfillment.externalId ?? null).toBeNull()
  })
})

describe('settleUnknownOrder and its endpoint, on a real database', () => {
  it('lets exactly one of two resends at once win, and sends once (the atomic claim on MongoDB)', async () => {
    for (let round = 0; round < 3; round++) {
      const o = await unknownOrder(one, item)
      const before = creates(one.printify).length
      const admin = await reqAs(one, 'admin')
      const results = await Promise.allSettled([
        settleUnknownOrder(one.payload, { order: o.id, outcome: 'resend', req: admin }),
        settleUnknownOrder(one.payload, { order: o.id, outcome: 'resend', req: admin }),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(lost.reason).toBeInstanceOf(PrintifySettleError)
      expect(lost.reason.status).toBe(409)
      expect(creates(one.printify).slice(before).map((c) => c.body!.external_id)).toEqual([String(o.id)])
      expect((await get(one, o.id)).fulfillment).toMatchObject({ externalId: `pf-order-${before + 1}`, status: 'on-hold' })
    }
  })

  it('lets exactly one of two resends over the endpoint win', async () => {
    const o = await unknownOrder(one, item)
    const before = creates(one.printify).length
    await settleOver(one, 'warm-up', 'admin', { outcome: 'maybe' }) // signs in first: two sign-ins at once race on the session list
    const answers = await Promise.all([settleOver(one, o.id, 'admin', { outcome: 'resend' }), settleOver(one, o.id, 'admin', { outcome: 'resend' })])
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409])
    expect(creates(one.printify).length).toBe(before + 1)
  })

  it('lets only one of a resend and a "sent" at once win', async () => {
    const o = await unknownOrder(one, item)
    const before = creates(one.printify).length
    const admin = await reqAs(one, 'admin')
    const results = await Promise.allSettled([
      settleUnknownOrder(one.payload, { order: o.id, outcome: 'resend', req: admin }),
      settleUnknownOrder(one.payload, { order: o.id, outcome: 'sent', printifyId: 'pf-found-1', req: admin }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const doc = await get(one, o.id)
    const sent = creates(one.printify).length - before
    if (doc.fulfillment.externalId === 'pf-found-1') expect([sent, doc.fulfillment.status]).toEqual([0, 'submitted'])
    else expect([sent, doc.fulfillment.status]).toEqual([1, 'on-hold'])
  })

  it('records the Printify id for "sent", without calling Printify, and only once', async () => {
    const o = await unknownOrder(one, item)
    const calls = one.printify.calls.length
    const res = await settleOver(one, o.id, 'admin', { outcome: 'sent', printifyId: ' pf-found-2 ' })
    expect(res.status).toBe(200)
    expect(res.body.fulfillment).toMatchObject({ externalId: 'pf-found-2', status: 'submitted', error: null })
    expect((await get(one, o.id)).fulfillment).toMatchObject({ provider: 'printify', externalId: 'pf-found-2', status: 'submitted', error: null })
    expect(one.printify.calls.length).toBe(calls)
    expect((await settleOver(one, o.id, 'admin', { outcome: 'sent', printifyId: 'pf-found-3' })).status).toBe(409)
    expect((await settleOver(one, o.id, 'admin', { outcome: 'resend' })).status).toBe(409)
    expect((await get(one, o.id)).fulfillment.externalId).toBe('pf-found-2')
  })

  it('refuses anyone but staff with access, before touching the order', async () => {
    const o = await unknownOrder(one, item)
    const calls = one.printify.calls.length
    for (const user of [undefined, 'customer', 'staff'])
      expect((await settleOver(one, o.id, user, { outcome: 'resend' })).status, String(user)).toBe(403)
    await expect(settleUnknownOrder(one.payload, { order: o.id, outcome: 'resend', req: await reqAs(one, 'staff') })).rejects.toMatchObject({ status: 403 })
    expect(one.printify.calls.length).toBe(calls)
    expect((await get(one, o.id)).fulfillment.status).toBe('unknown')
  })

  it('refuses orders that are not unknown, no longer paid, or missing, and bad requests', async () => {
    const calls = one.printify.calls.length
    const sent = await order(one, item)
    await pay(one, sent.id)
    const failed = await order(one, item)
    one.printify.state.create = () => Response.json({ error: 'Invalid address' }, { status: 400 })
    await pay(one, failed.id)
    one.printify.state.create = (n) => Response.json({ id: `pf-order-${n}` })
    const unpaid = await order(one, item)
    const canceled = await unknownOrder(one, item)
    await one.payload.update({ collection: 'orders', id: canceled.id, data: { status: 'cancelled' } as never })
    const afterSetup = one.printify.calls.length
    for (const o of [sent, failed, unpaid]) {
      expect((await settleOver(one, o.id, 'admin', { outcome: 'resend' })).status).toBe(409)
      expect((await settleOver(one, o.id, 'admin', { outcome: 'sent', printifyId: 'pf-x' })).status).toBe(409)
    }
    expect((await settleOver(one, canceled.id, 'admin', { outcome: 'resend' })).status).toBe(409)
    expect((await get(one, canceled.id)).fulfillment.status).toBe('unknown')
    expect((await settleOver(one, '000000000000000000000000', 'admin', { outcome: 'resend' })).status).toBe(409)
    expect((await settleOver(one, canceled.id, 'admin', { outcome: 'sent' })).status).toBe(400)
    expect((await settleOver(one, canceled.id, 'admin', { outcome: 'maybe' })).status).toBe(400)
    expect((await rest(one, `/printify/orders/${canceled.id}/settle`, { user: 'admin', body: 'not json' })).status).toBe(400)
    expect(one.printify.calls.length).toBe(afterSetup)
    expect(afterSetup).toBeGreaterThan(calls)
    expect((await get(one, sent.id)).fulfillment.status).toBe('on-hold')
    expect((await get(one, failed.id)).fulfillment.status).toBe('failed')
  })
})

describe('webhooks, on a real database', () => {
  it('copies a signed order event onto the order with that Printify id, and no other', async () => {
    const a = await order(one, item)
    await pay(one, a.id)
    const b = await order(one, item)
    await pay(one, b.id)
    const pa = (await get(one, a.id)).fulfillment.externalId as string
    one.printify.state.orders.set(pa, { id: pa, status: 'fulfilled', external_id: String(a.id), shipments: [{ carrier: 'usps', number: 'TEST123', url: 'https://tracking.example.com/TEST123', delivered_at: null }] })
    const res = await webhook(one, orderEvent(pa))
    expect(res.status).toBe(200)
    expect((await get(one, a.id)).fulfillment).toMatchObject({ externalId: pa, status: 'fulfilled', shipments: [{ carrier: 'usps', number: 'TEST123' }] })
    expect((await get(one, b.id)).fulfillment.status).toBe('on-hold')
  })

  it('settles an unknown order by external_id, once', async () => {
    const o = await unknownOrder(one, item)
    one.printify.state.orders.set('pf-late-1', { id: 'pf-late-1', status: 'on-hold', external_id: String(o.id) })
    const before = creates(one.printify).length
    const [r1, r2] = await Promise.all([webhook(one, orderEvent('pf-late-1', 1)), webhook(one, orderEvent('pf-late-1', 2))])
    expect([r1.status, r2.status]).toEqual([200, 200])
    expect((await get(one, o.id)).fulfillment).toMatchObject({ externalId: 'pf-late-1', status: 'on-hold', error: null })
    expect(creates(one.printify).length).toBe(before)
    expect((await settleOver(one, o.id, 'admin', { outcome: 'resend' })).status).toBe(409)
  })

  it('leaves orders alone for an external_id that is not an unknown order, or not an order id at all', async () => {
    const o = await unknownOrder(one, item)
    const sent = await order(one, item)
    await pay(one, sent.id)
    const sentDoc = await get(one, sent.id)
    for (const [pid, external] of [
      ['pf-stray-1', String(sent.id)],
      ['pf-stray-2', 'not-an-order-id'],
      ['pf-stray-3', '000000000000000000000000'],
      ['pf-stray-4', undefined],
    ] as const) {
      one.printify.state.orders.set(pid, { id: pid, status: 'on-hold', ...(external ? { external_id: external } : {}) })
      expect((await webhook(one, orderEvent(pid))).status, pid).toBe(200)
    }
    expect((await get(one, o.id)).fulfillment.status).toBe('unknown')
    expect((await get(one, sent.id)).fulfillment).toMatchObject({ externalId: sentDoc.fulfillment.externalId, status: 'on-hold' })
  })

  it('refuses unsigned, wrongly signed and tampered events before reading or writing anything', async () => {
    const o = await unknownOrder(one, item)
    one.printify.state.orders.set('pf-forged', { id: 'pf-forged', status: 'fulfilled', external_id: String(o.id) })
    const calls = one.printify.calls.length
    const event = orderEvent('pf-forged')
    const body = JSON.stringify(event)
    const tampered = JSON.stringify({ ...event, resource: { ...event.resource, id: 'pf-other' } })
    const answers = [
      await webhook(one, event, null),
      await webhook(one, event, 'sha256='),
      await webhook(one, event, sign(body, 'wrong-secret')),
      await webhook(one, event, sign(body).replace('sha256=', '')),
      await rest(one, '/printify/webhook', { body: tampered, headers: { 'x-pfy-signature': sign(body) } }),
    ]
    expect(answers.map((a) => a.status)).toEqual([401, 401, 401, 401, 401])
    expect(one.printify.calls.length).toBe(calls)
    expect((await get(one, o.id)).fulfillment.status).toBe('unknown')
  })
})

// Two stores on one Payload with Payload's multi-tenant plugin. The Printify shop belongs to store A
// (the plugin's `tenant.resolve`); store B sells its own things.
let many: Store
let tenantA: string, tenantB: string
let itemA: { product: string; variant: string }, itemB: { product: string; variant: string }

describe('tenancy, with Payload’s multi-tenant plugin', () => {
  beforeAll(async () => {
    let owner: string | null = null
    many = await boot(mongo, 'printify-tenants', {
      tenants: multiTenantPlugin({
        collections: { products: {}, variants: {}, variantTypes: {}, variantOptions: {}, orders: {} },
        userHasAccessToAllTenants: (user) => (user as Doc).roles?.includes('admin') === true,
      }) as Plugin,
      resolve: () => owner,
    })
    tenantA = String((await many.payload.create({ collection: 'tenants' as never, data: { name: 'Store A' } as never })).id)
    tenantB = String((await many.payload.create({ collection: 'tenants' as never, data: { name: 'Store B' } as never })).id)
    owner = tenantA
    itemA = await stocked(many, tenantA, product('pf-prod-a', 2001, 'Store A Mug'))
    // Store B's copy of a Printify product, as if another integration had put it there.
    itemB = await stocked(many, tenantB, product('pf-prod-b', 3001, 'Store B Mug'))
  }, 120_000)

  const tenantOf = (d: Doc) => String(d.tenant?.id ?? d.tenant)

  it('syncs into the owning store only', async () => {
    const products = (await many.payload.find({ collection: 'products', depth: 0, draft: true, limit: 10 })).docs as Doc[]
    expect(products.map((p) => [p.printify.productId, tenantOf(p)]).sort()).toEqual([
      ['pf-prod-a', tenantA],
      ['pf-prod-b', tenantB],
    ])
  })

  it('sends store A’s paid orders, and never store B’s', async () => {
    const before = creates(many.printify).length
    const a = await order(many, itemA, { tenant: tenantA })
    const b = await order(many, itemB, { tenant: tenantB })
    await Promise.all([pay(many, a.id), pay(many, b.id)])
    expect(creates(many.printify).slice(before).map((c) => c.body!.external_id)).toEqual([String(a.id)])
    expect((await get(many, b.id)).fulfillment?.status ?? null).toBeNull()
    // Resending B's order over the endpoint sends nothing either.
    await many.payload.db.updateOne({ collection: 'orders', where: { id: { equals: b.id } }, data: { fulfillment: { provider: 'printify', status: 'unknown' } } })
    await settleOver(many, b.id, 'admin', { outcome: 'resend' })
    expect(creates(many.printify).length).toBe(before + 1)
  })

  it('settles an unknown order by external_id only in store A', async () => {
    // Store B's order in the unknown state (written directly: the plugin never sends B's orders).
    const b = await order(many, itemB, { tenant: tenantB })
    await many.payload.db.updateOne({ collection: 'orders', where: { id: { equals: b.id } }, data: { status: 'processing', fulfillment: { provider: 'printify', status: 'unknown' } } })
    many.printify.state.orders.set('pf-b-claim', { id: 'pf-b-claim', status: 'on-hold', external_id: String(b.id) })
    // With no unknown order in store A, an event that isn't ours costs no Printify call.
    const calls = many.printify.calls.length
    expect((await webhook(many, orderEvent('pf-b-claim'))).status).toBe(200)
    expect(many.printify.calls.length).toBe(calls)

    const a = await order(many, itemA, { tenant: tenantA })
    many.printify.state.create = () => new Response('Bad gateway', { status: 502 })
    await pay(many, a.id)
    many.printify.state.create = (n) => Response.json({ id: `pf-order-${n}` })
    expect((await get(many, a.id)).fulfillment.status).toBe('unknown')

    // Now store A has one, Printify is asked, and store B's order is still left alone.
    expect((await webhook(many, orderEvent('pf-b-claim', 2))).status).toBe(200)
    expect((await get(many, b.id)).fulfillment).toMatchObject({ status: 'unknown' })
    expect((await get(many, b.id)).fulfillment.externalId ?? null).toBeNull()

    many.printify.state.orders.set('pf-a-claim', { id: 'pf-a-claim', status: 'on-hold', external_id: String(a.id) })
    expect((await webhook(many, orderEvent('pf-a-claim'))).status).toBe(200)
    expect((await get(many, a.id)).fulfillment).toMatchObject({ externalId: 'pf-a-claim', status: 'on-hold' })
  })

  it('copies an order event onto store A’s order only, even when a store B order carries the same Printify id', async () => {
    const twin = async () => {
      const b = await order(many, itemB, { tenant: tenantB })
      await many.payload.db.updateOne({ collection: 'orders', where: { id: { equals: b.id } }, data: { status: 'processing', fulfillment: { provider: 'manual', externalId: 'pf-twin', status: 'on-hold' } } })
      return b
    }
    const b1 = await twin()
    const a = await order(many, itemA, { tenant: tenantA })
    many.printify.state.create = () => Response.json({ id: 'pf-twin' })
    await pay(many, a.id)
    many.printify.state.create = (n) => Response.json({ id: `pf-order-${n}` })
    const b2 = await twin()
    expect((await get(many, a.id)).fulfillment.externalId).toBe('pf-twin')

    many.printify.state.orders.set('pf-twin', { id: 'pf-twin', status: 'fulfilled', external_id: String(a.id), shipments: [{ carrier: 'usps', number: 'TEST456', url: 'https://tracking.example.com/TEST456' }] })
    expect((await webhook(many, orderEvent('pf-twin'))).status).toBe(200)
    for (const b of [b1, b2]) {
      const doc = await get(many, b.id)
      expect(doc.fulfillment, 'store B’s order').toMatchObject({ provider: 'manual', status: 'on-hold' })
      expect(doc.fulfillment.shipments ?? [], 'store B’s order').toEqual([])
    }
    expect((await get(many, a.id)).fulfillment).toMatchObject({ status: 'fulfilled', shipments: [{ number: 'TEST456' }] })
  })
})

// Payload runs without transactions on a MongoDB that isn't a replica set (and when told to). Then
// nothing in the database stops two saves from both seeing the order unpaid, so the plugin's own
// conditional write has to.
let bare: Store
let bareItem: { product: string; variant: string }

describe('without database transactions', () => {
  beforeAll(async () => {
    bare = await boot(mongo, 'printify-no-transactions', null, { transactions: false })
    bareItem = await stocked(bare, null, product('pf-prod-9', 9001, 'Test Tote'))
  }, 120_000)

  it('sends a paid order exactly once when two or three saves that pay it race', async () => {
    for (let round = 0; round < 5; round++) {
      const o = await order(bare, bareItem)
      const before = creates(bare.printify).length
      await Promise.allSettled([pay(bare, o.id), pay(bare, o.id), ...(round % 2 ? [pay(bare, o.id)] : [])])
      expect(creates(bare.printify).slice(before).map((c) => c.body!.external_id)).toEqual([String(o.id)])
      expect((await get(bare, o.id)).fulfillment).toMatchObject({ externalId: `pf-order-${before + 1}`, status: 'on-hold', error: null })
    }
  })

  it('shows the order as unknown while the create is out, so a crash mid-send leaves it true', async () => {
    const o = await order(bare, bareItem)
    let during: Doc | undefined
    bare.printify.state.create = async (n) => {
      during = await get(bare, o.id)
      return Response.json({ id: `pf-order-${n}` })
    }
    await pay(bare, o.id)
    bare.printify.state.create = (n) => Response.json({ id: `pf-order-${n}` })
    expect(during!.fulfillment).toMatchObject({ provider: 'printify', status: 'unknown' })
    expect(during!.fulfillment.error).toContain(`external_id ${o.id}`)
    expect((await get(bare, o.id)).fulfillment).toMatchObject({ status: 'on-hold', error: null })
  })

  it('lets exactly one of two resends at once win, and sends once', async () => {
    const o = await unknownOrder(bare, bareItem)
    const before = creates(bare.printify).length
    const admin = await reqAs(bare, 'admin')
    const results = await Promise.allSettled([
      settleUnknownOrder(bare.payload, { order: o.id, outcome: 'resend', req: admin }),
      settleUnknownOrder(bare.payload, { order: o.id, outcome: 'resend', req: admin }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(creates(bare.printify).length).toBe(before + 1)
  })
})
