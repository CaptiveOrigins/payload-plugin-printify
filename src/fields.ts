import type { CollectionConfig, Field } from 'payload'

const ro = { readOnly: true }
/** Whether a field exists at the top level of the data (looking inside rows, collapsibles and unnamed tabs). */
const hasField = (fields: Field[], name: string): boolean =>
  fields.some((f) =>
    'name' in f && f.name
      ? f.name === name
      : ('fields' in f && hasField(f.fields, name)) ||
        (f.type === 'tabs' && f.tabs.some((t) => !('name' in t && t.name) && hasField(t.fields, name))),
  )
const has = (c: CollectionConfig, name: string) => hasField(c.fields, name)

/** Fields a synced product needs; added only where the collection lacks them. */
export const productContentFields = (c: CollectionConfig): Field[] =>
  [
    !has(c, 'title') && ({ name: 'title', type: 'text', required: true } satisfies Field),
    !has(c, 'slug') && ({ name: 'slug', type: 'text', index: true } satisfies Field),
    !has(c, 'description') && ({ name: 'description', type: 'textarea' } satisfies Field),
    !has(c, 'images') &&
      ({
        name: 'images',
        type: 'array',
        fields: [
          { name: 'url', type: 'text', required: true },
          { name: 'alt', type: 'text' },
          { name: 'variantIds', type: 'number', hasMany: true },
          { name: 'isDefault', type: 'checkbox', defaultValue: false },
        ],
      } satisfies Field),
  ].filter(Boolean) as Field[]

export const productPrintifyField: Field = {
  name: 'printify',
  type: 'group',
  admin: { position: 'sidebar', description: 'Set by the Printify sync; edit the product in Printify.' },
  fields: [
    { name: 'productId', type: 'text', index: true, admin: ro },
    { name: 'shopId', type: 'text', admin: ro },
    { name: 'blueprintId', type: 'number', admin: ro },
    { name: 'printProviderId', type: 'number', admin: ro },
    { name: 'syncedAt', type: 'date', admin: ro },
  ],
}

export const variantPrintifyField: Field = {
  name: 'printify',
  type: 'group',
  admin: { position: 'sidebar' },
  fields: [
    { name: 'variantId', type: 'number', index: true, admin: ro },
    { name: 'sku', type: 'text', admin: ro },
  ],
}

export const orderFulfillmentField: Field = {
  name: 'fulfillment',
  type: 'group',
  admin: { position: 'sidebar' },
  fields: [
    { name: 'provider', type: 'select', options: ['printify', 'manual'].map((v) => ({ label: v[0]!.toUpperCase() + v.slice(1), value: v })) },
    { name: 'externalId', type: 'text', index: true, admin: { ...ro, description: 'Printify order ID.' } },
    {
      name: 'status',
      type: 'text',
      admin: {
        ...ro,
        description: '"unknown": the create may or may not have reached Printify. Look for this order id in Printify, then settle it (POST /api/printify/orders/<id>/settle).',
      },
    },
    { name: 'error', type: 'textarea', admin: ro },
    { name: 'submittedAt', type: 'date', admin: ro },
    {
      name: 'shipments',
      type: 'array',
      admin: ro,
      fields: [
        { name: 'carrier', type: 'text' },
        { name: 'number', type: 'text' },
        { name: 'url', type: 'text' },
        { name: 'deliveredAt', type: 'date' },
      ],
    },
  ],
}
