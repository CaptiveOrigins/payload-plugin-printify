import { createHmac } from 'node:crypto'
import type { Config, PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { mapPrintifyProduct, printifyPlugin, validPrintifySignature, type PrintifyProduct } from '../src'
import { pushVariantPriceHook } from '../src/prices'
import { pushVisibilityHook } from '../src/visibility'
import type { PrintifyPluginOptions, ResolvedPrintifyOptions } from '../src/types'
import { webhookEndpoint } from '../src/webhook'

/** Shaped like GET /v1/shops/{shop_id}/products/{id}.json. */
const tee = (overrides: Partial<PrintifyProduct> = {}): PrintifyProduct => ({
  id: 'pf-1',
  title: 'Leopard Gecko Tee',
  description: '<p>Soft cotton.</p><p>Printed &amp; shipped on demand.</p>',
  options: [
    { name: 'Colors', type: 'color', values: [{ id: 521, title: 'Black' }, { id: 522, title: 'White' }] },
    { name: 'Sizes', type: 'size', values: [{ id: 14, title: 'M' }, { id: 15, title: 'L' }, { id: 16, title: 'XL' }] },
  ],
  variants: [
    { id: 1001, sku: 'TEE-BLK-M', price: 2500, title: 'Black / M', is_enabled: true, is_available: true, options: [521, 14] },
    { id: 1002, sku: 'TEE-BLK-L', price: 2500, title: 'Black / L', is_enabled: true, is_available: true, options: [521, 15] },
    { id: 1003, sku: 'TEE-WHT-XL', price: 2700, title: 'White / XL', is_enabled: true, is_available: true, options: [522, 16] },
    { id: 1004, sku: 'TEE-WHT-M', price: 2500, title: 'White / M', is_enabled: false, options: [522, 14] },
  ],
  images: [
    { src: 'https://images-api.printify.com/mockup/back.jpg', variant_ids: [1001], position: 'back', is_default: false },
    { src: 'https://images-api.printify.com/mockup/front.jpg', variant_ids: [1001, 1002], position: 'front', is_default: true },
  ],
  visible: true,
  blueprint_id: 6,
  print_provider_id: 99,
  ...overrides,
})

const collections = ['products', 'variants', 'variantTypes', 'variantOptions', 'orders'].map((slug) => ({
  slug,
  fields: slug === 'products' ? [{ name: 'title', type: 'text' as const }] : [],
}))
const configure = (options: PrintifyPluginOptions) =>
  printifyPlugin(options)({ collections, endpoints: [] } as unknown as Config) as Config & { custom: { printify: ResolvedPrintifyOptions } }

/** Fake Printify API: GET returns the product, PUT records the body. */
const fakePrintify = (product: PrintifyProduct) => {
  const puts: { url: string; body: { variants: { id: number; price: number; is_enabled: boolean }[] } }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') puts.push({ url, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(product), { status: 200 })
  }) as typeof globalThis.fetch
  return { puts, fetch }
}

describe('mapping', () => {
  it('keeps enabled variants, used options, plain-text descriptions and the default image first', () => {
    const m = mapPrintifyProduct(tee())
    expect(m.description).toBe('Soft cotton.\nPrinted & shipped on demand.')
    expect(m.variants.map((v) => v.printifyId)).toEqual([1001, 1002, 1003])
    expect(m.options.find((o) => o.name === 'sizes')?.values.map((v) => v.label)).toEqual(['M', 'L', 'XL'])
    expect(m.minPrice).toBe(2500)
    expect(m.images[0]?.isDefault).toBe(true)
    expect(mapPrintifyProduct(tee({ visible: false })).published).toBe(false)
  })
})

describe('webhooks', () => {
  it('accepts only correctly signed bodies', () => {
    const body = JSON.stringify({ id: 'e1', type: 'product:updated' })
    const sig = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
    expect(validPrintifySignature(body, sig, 'secret')).toBe(true)
    expect(validPrintifySignature(body + ' ', sig, 'secret')).toBe(false)
    expect(validPrintifySignature(body, sig, 'other')).toBe(false)
    expect(validPrintifySignature(body, null, 'secret')).toBe(false)
    expect(validPrintifySignature(body, sig, '')).toBe(false)
  })

  it('rejects unsigned requests with 401', async () => {
    const opts = configure({ apiToken: 't', shopId: '1', webhookSecret: 'secret' }).custom.printify
    const req = { text: async () => '{}', headers: new Headers() } as unknown as PayloadRequest
    const res = await webhookEndpoint(opts).handler(req)
    expect(res.status).toBe(401)
  })
})

describe('config', () => {
  it('adds the Printify fields, hooks, webhook endpoint and settle endpoint', () => {
    const config = configure({ apiToken: 't', shopId: '1' })
    const bySlug = Object.fromEntries((config.collections ?? []).map((c) => [c.slug, c]))
    const names = (slug: string) => bySlug[slug]!.fields.map((f) => ('name' in f ? f.name : null))
    expect(names('products')).toEqual(expect.arrayContaining(['title', 'slug', 'description', 'images', 'printify']))
    expect(names('products').filter((n) => n === 'title')).toHaveLength(1)
    expect(names('variants')).toContain('printify')
    expect(names('orders')).toContain('fulfillment')
    expect(bySlug.variants!.hooks?.beforeChange).toHaveLength(1)
    expect(bySlug.products!.hooks?.beforeChange).toHaveLength(1)
    expect(bySlug.orders!.hooks?.afterChange).toHaveLength(1)
    expect(config.endpoints?.map((e) => `${e.method} ${e.path}`)).toEqual(['post /printify/webhook', 'post /printify/orders/:id/settle'])
    expect(config.custom.printify).toMatchObject({ enabled: true, pushPrices: false, pushVisibility: false, publishHandshake: false, currency: 'USD' })
  })

  it('is off without a token and shop id', () => {
    expect(configure({}).custom.printify.enabled).toBe(false)
  })
})

describe('price push', () => {
  const variant = { id: 'v2', product: 'p1', priceInUSD: 2500, printify: { variantId: 1002 } }
  const req = {
    payload: { findByID: async () => ({ id: 'p1', printify: { productId: 'pf-1' } }) },
  } as unknown as PayloadRequest
  const run = (options: PrintifyPluginOptions, price: number, context: Record<string, unknown> = {}) => {
    const hook = pushVariantPriceHook(configure({ apiToken: 't', shopId: '123', pushPrices: true, ...options }).custom.printify)
    return hook({ data: { priceInUSD: price }, originalDoc: variant, operation: 'update', req, context } as never)
  }

  it('sends every variant with the one price changed', async () => {
    const fake = fakePrintify(tee())
    await expect(run({ fetch: fake.fetch }, 2300)).resolves.toEqual({ priceInUSD: 2300 })
    expect(fake.puts).toHaveLength(1)
    expect(fake.puts[0]!.url).toBe('https://api.printify.com/v1/shops/123/products/pf-1.json')
    expect(fake.puts[0]!.body.variants).toEqual(
      tee().variants.map((v) => ({ id: v.id, price: v.id === 1002 ? 2300 : v.price, is_enabled: v.is_enabled })),
    )
  })

  it('refuses the edit when the guard blocks it or the product is locked', async () => {
    const fake = fakePrintify(tee())
    const blocked = run({ fetch: fake.fetch, beforePrintifyWrite: () => { throw new Error('staging only reads Printify') } }, 2300)
    await expect(blocked).rejects.toThrow(/staging only reads Printify/)
    const locked = fakePrintify(tee({ is_locked: true }))
    await expect(run({ fetch: locked.fetch }, 2300)).rejects.toThrow(/publishing/)
    expect(fake.puts.length + locked.puts.length).toBe(0)
  })

  it('leaves sync writes, unchanged prices and disabled pushes alone', async () => {
    const fake = fakePrintify(tee())
    await run({ fetch: fake.fetch }, 2300, { printify: true })
    await run({ fetch: fake.fetch }, 2500)
    await run({ fetch: fake.fetch, pushPrices: false }, 2300)
    expect(fake.puts).toHaveLength(0)
  })
})

describe('visibility push', () => {
  const product = { id: 'p1', _status: 'published', printify: { productId: 'pf-1' } }
  const calls = (product: PrintifyProduct) => {
    const posts: string[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(url)
      return new Response(JSON.stringify(product), { status: 200 })
    }) as typeof globalThis.fetch
    return { posts, fetch }
  }
  const run = (options: PrintifyPluginOptions, status: string, original = product, query: Record<string, unknown> = {}, context: Record<string, unknown> = {}) => {
    const hook = pushVisibilityHook(configure({ apiToken: 't', shopId: '123', pushVisibility: true, ...options }).custom.printify)
    return hook({ data: { _status: status }, originalDoc: original, operation: 'update', req: { query } as PayloadRequest, context } as never)
  }

  it('unpublishes and publishes in Printify', async () => {
    const fake = calls(tee())
    await run({ fetch: fake.fetch }, 'draft')
    await run({ fetch: fake.fetch }, 'published', { ...product, _status: 'draft' })
    expect(fake.posts).toEqual([
      'https://api.printify.com/v1/shops/123/products/pf-1/unpublish.json',
      'https://api.printify.com/v1/shops/123/products/pf-1/publish.json',
    ])
  })

  it('leaves draft saves, unchanged status, sync writes and disabled pushes alone', async () => {
    const fake = calls(tee())
    await run({ fetch: fake.fetch }, 'draft', product, { draft: 'true' })
    await run({ fetch: fake.fetch }, 'published')
    await run({ fetch: fake.fetch }, 'draft', product, {}, { printify: true })
    await run({ fetch: fake.fetch, pushVisibility: false }, 'draft')
    expect(fake.posts).toHaveLength(0)
  })

  it('refuses the change when the guard blocks it or the product is locked', async () => {
    const fake = calls(tee())
    await expect(run({ fetch: fake.fetch, beforePrintifyWrite: () => { throw new Error('staging only reads Printify') } }, 'draft')).rejects.toThrow(/staging/)
    const locked = calls(tee({ is_locked: true }))
    await expect(run({ fetch: locked.fetch }, 'draft')).rejects.toThrow(/publishing/)
    expect(fake.posts.length + locked.posts.length).toBe(0)
  })
})
