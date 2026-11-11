/**
 * Minimal Printify REST client (https://developers.printify.com, API v1).
 * Server-side only (the API has no CORS). Personal access token from
 * PRINTIFY_API_TOKEN; never logged. Retries 429 a few times with backoff
 * (limit: 600 requests/minute per account), and 5xx only for reads. Creating an
 * order is never retried: a 5xx or timeout may come after Printify created it,
 * and a retry would create a second paid order.
 */
const BASE = 'https://api.printify.com/v1'
const USER_AGENT = 'payload-plugin-printify'

export class PrintifyError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Printify ${status} on ${path}: ${body.slice(0, 300)}`)
    this.name = 'PrintifyError'
  }
}

export type PrintifyShop = { id: number; title: string; sales_channel: string }

export type PrintifyProduct = {
  id: string
  title: string
  description: string
  tags?: string[]
  options: { name: string; type: string; values: { id: number; title: string; colors?: string[] }[] }[]
  variants: {
    id: number
    sku?: string
    price: number
    cost?: number
    title: string
    is_enabled: boolean
    is_available?: boolean
    is_default?: boolean
    options: number[]
  }[]
  images: { src: string; variant_ids: number[]; position: string; is_default: boolean }[]
  visible?: boolean
  is_locked?: boolean
  blueprint_id: number
  print_provider_id: number
  shop_id?: number
  external?: { id: string; handle: string } | null
}

export type PrintifyAddress = {
  first_name: string
  last_name: string
  email?: string
  phone?: string
  country: string
  region?: string
  address1: string
  address2?: string
  city: string
  zip: string
}

export type PrintifyOrder = {
  id: string
  status: string
  external_id?: string
  shipments?: { carrier: string; number: string; url: string; delivered_at?: string | null }[]
}

type Fetch = typeof fetch

/** Methods that are safe to repeat after a 5xx: they don't create anything. */
const RETRY_5XX = new Set(['GET', 'HEAD'])

/**
 * Whether a failed create may have happened anyway: a 5xx, a timeout, a network
 * error or an unreadable answer. Only a 4xx or 429 means Printify refused it.
 */
export const outcomeUnknown = (error: unknown) => !(error instanceof PrintifyError) || error.status >= 500

export class PrintifyClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly userAgent: string = USER_AGENT,
  ) {}

  async request<T>(method: string, path: string, body?: unknown, attempt = 0, retry = true): Promise<T> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'User-Agent': this.userAgent,
        'Content-Type': 'application/json;charset=utf-8',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    if (retry && (res.status === 429 || (res.status >= 500 && RETRY_5XX.has(method))) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt
      await new Promise((r) => setTimeout(r, wait))
      return this.request(method, path, body, attempt + 1)
    }
    const text = await res.text()
    if (!res.ok) throw new PrintifyError(res.status, path, text)
    return (text ? JSON.parse(text) : {}) as T
  }

  shops = () => this.request<PrintifyShop[]>('GET', '/shops.json')

  /** Every product of a shop (pages of 50). */
  async allProducts(shopId: number | string): Promise<PrintifyProduct[]> {
    const out: PrintifyProduct[] = []
    for (let page = 1; ; page++) {
      const r = await this.request<{ data: PrintifyProduct[]; last_page: number }>(
        'GET',
        `/shops/${shopId}/products.json?limit=50&page=${page}`,
      )
      out.push(...r.data)
      if (page >= r.last_page) return out
    }
  }

  product = (shopId: number | string, id: string) =>
    this.request<PrintifyProduct>('GET', `/shops/${shopId}/products/${id}.json`)

  /** Change product fields. Variant updates must list every variant; locked (publishing) products are refused. */
  updateProduct = (
    shopId: number | string,
    id: string,
    body: Partial<{ title: string; description: string; variants: { id: number; price: number; is_enabled: boolean }[] }>,
  ) => this.request<PrintifyProduct>('PUT', `/shops/${shopId}/products/${id}.json`, body)

  /** Publish to the shop's sales channel (Printify's own channels act on it; API shops get product:publish:started). */
  publish = (shopId: number | string, id: string) =>
    this.request('POST', `/shops/${shopId}/products/${id}/publish.json`, {
      title: true,
      description: true,
      images: true,
      variants: true,
      tags: true,
      keyFeatures: true,
      shipping_template: true,
    })

  /** Mark a product unpublished (hidden from the sales channel). */
  unpublish = (shopId: number | string, id: string) => this.request('POST', `/shops/${shopId}/products/${id}/unpublish.json`, {})

  publishingSucceeded = (shopId: number | string, id: string, external: { id: string; handle: string }) =>
    this.request('POST', `/shops/${shopId}/products/${id}/publishing_succeeded.json`, { external })

  publishingFailed = (shopId: number | string, id: string, reason: string) =>
    this.request('POST', `/shops/${shopId}/products/${id}/publishing_failed.json`, { reason })

  /**
   * Create an order. Sent once, never retried (not even on 429): if it fails with
   * `outcomeUnknown(error)`, check Printify for `external_id` before sending again.
   * Printify's docs in this repo say nothing on whether a repeated `external_id`
   * is refused, so nothing here relies on it.
   */
  createOrder = (
    shopId: number | string,
    order: {
      external_id: string
      label?: string
      line_items: { product_id: string; variant_id: number; quantity: number }[]
      shipping_method: number
      send_shipping_notification: boolean
      address_to: PrintifyAddress
    },
  ) => this.request<{ id: string }>('POST', `/shops/${shopId}/orders.json`, order, 0, false)

  order = (shopId: number | string, id: string) =>
    this.request<PrintifyOrder>('GET', `/shops/${shopId}/orders/${id}.json`)

  sendToProduction = (shopId: number | string, id: string) =>
    this.request('POST', `/shops/${shopId}/orders/${id}/send_to_production.json`)

  /** Shipping options and costs (cents) for a cart and address. */
  shippingCost = (
    shopId: number | string,
    body: { line_items: { product_id: string; variant_id: number; quantity: number }[]; address_to: PrintifyAddress },
  ) => this.request<Record<string, number>>('POST', `/shops/${shopId}/orders/shipping.json`, body)

  webhooks = (shopId: number | string) =>
    this.request<{ id: string; topic: string; url: string }[]>('GET', `/shops/${shopId}/webhooks.json`)

  createWebhook = (shopId: number | string, topic: string, url: string, secret: string) =>
    this.request('POST', `/shops/${shopId}/webhooks.json`, { topic, url, secret })

  deleteWebhook = (shopId: number | string, id: string, host: string) =>
    this.request('DELETE', `/shops/${shopId}/webhooks/${id}.json?host=${encodeURIComponent(host)}`)
}

/** A client with the plugin's token, user agent and fetch. */
export const clientOf = (opts: { apiToken?: string; userAgent?: string; fetch?: Fetch }) =>
  new PrintifyClient(opts.apiToken!, opts.fetch ?? fetch, opts.userAgent)
