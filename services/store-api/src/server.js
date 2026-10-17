import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { applySecurity, finishApp, sendHealth } from '@vine/shared/app';
import { createAuthContext, createSupabaseClient } from '@vine/shared/db';
import { requireAuth } from '@vine/shared/auth';
import { requirePermission } from '@vine/shared/rbac';
import { asyncRoute, HttpError } from '@vine/shared/errors';
import { clampInt, emailSchema, normalizeProductQuery, optionalText, phoneSchema, safeText, uuidSchema } from '@vine/shared/validation';

process.env.SERVICE_NAME = 'vine-store-api';
const { authClient, accountsAdmin } = createAuthContext();
if (!accountsAdmin) throw new Error('ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY is required for vine-store-api.');
const productsDb = createSupabaseClient(process.env.PRODUCTS_SUPABASE_URL, process.env.PRODUCTS_SUPABASE_SERVICE_ROLE_KEY, 'Vine products database');
const ordersDb = createSupabaseClient(process.env.ORDERS_SUPABASE_URL, process.env.ORDERS_SUPABASE_SERVICE_ROLE_KEY, 'Vine orders database');
const app = express();
applySecurity(app, { requestLimit: 180 });
app.use(express.json({ limit: '128kb' }));
const auth = requireAuth(authClient);
const catalogAdmin = requirePermission(accountsAdmin, 'products.manage', ['owner', 'admin', 'catalog']);
const supplierView = requirePermission(accountsAdmin, 'suppliers.view', ['owner', 'admin', 'catalog']);
const supplierManage = requirePermission(accountsAdmin, 'suppliers.manage', ['owner', 'admin', 'catalog']);
const operationsAdmin = requirePermission(accountsAdmin, 'orders.view', ['owner', 'admin', 'operations', 'support']);
const publicProductFields = 'id,category_id,sku,slug,name,description,price_kobo,compare_at_price_kobo,currency,image_url,gallery_urls,tag,rating,review_count,stock_quantity,reserved_quantity,status,created_at,updated_at,category:categories(id,name,slug)';

function toPublicProduct(row) {
  return {
    id: row.id, sku: row.sku, slug: row.slug, name: row.name, description: row.description,
    priceKobo: Number(row.price_kobo), priceNgn: Number(row.price_kobo) / 100,
    compareAtPriceKobo: row.compare_at_price_kobo == null ? null : Number(row.compare_at_price_kobo),
    compareAtPriceNgn: row.compare_at_price_kobo == null ? null : Number(row.compare_at_price_kobo) / 100,
    currency: row.currency, imageUrl: row.image_url, galleryUrls: row.gallery_urls || [],
    tag: row.tag, rating: Number(row.rating || 0), reviewCount: Number(row.review_count || 0),
    availableQuantity: Math.max(0, Number(row.stock_quantity) - Number(row.reserved_quantity)),
    category: row.category ? { id: row.category.id, name: row.category.name, slug: row.category.slug } : null
  };
}

app.get('/health', sendHealth);
app.get('/ready', asyncRoute(async (_req, res) => {
  const [a, b] = await Promise.all([
    productsDb.from('categories').select('id').limit(1),
    ordersDb.from('orders').select('id').limit(1)
  ]);
  if (a.error || b.error) throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'One or more Vine store databases are not ready.');
  res.json({ status: 'ready', service: process.env.SERVICE_NAME });
}));

app.get('/api/v1/categories', asyncRoute(async (_req, res) => {
  const { data, error } = await productsDb.from('categories').select('id,name,slug,description,sort_order').eq('is_active', true).order('sort_order').order('name');
  if (error) throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'The product catalogue is temporarily unavailable.');
  res.json({ data: data || [] });
}));

app.get('/api/v1/products', asyncRoute(async (req, res) => {
  const { error: expiryError } = await productsDb.rpc('expire_vine_inventory_reservations');
  if (expiryError) throw new HttpError(503, 'INVENTORY_UNAVAILABLE', 'Product availability could not be refreshed.');
  const page = clampInt(req.query.page, 1, 1, 10_000);
  const limit = clampInt(req.query.limit, 24, 1, 48);
  const search = normalizeProductQuery(req.query.search);
  const categorySlug = String(req.query.category || '').trim().toLowerCase().slice(0, 80);
  const sort = ['featured','price_asc','price_desc','rating'].includes(req.query.sort) ? req.query.sort : 'featured';
  let query = productsDb.from('products').select(publicProductFields, { count: 'exact' }).eq('status', 'published');
  if (categorySlug && categorySlug !== 'all') {
    const { data: category, error: categoryError } = await productsDb.from('categories').select('id').eq('slug', categorySlug).eq('is_active', true).maybeSingle();
    if (categoryError) throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'The product catalogue is temporarily unavailable.');
    if (!category) return res.json({ data: { products: [], page, limit, total: 0 } });
    query = query.eq('category_id', category.id);
  }
  if (search) query = query.textSearch('name', search, { type: 'websearch', config: 'simple' });
  if (sort === 'price_asc') query = query.order('price_kobo', { ascending: true });
  else if (sort === 'price_desc') query = query.order('price_kobo', { ascending: false });
  else if (sort === 'rating') query = query.order('rating', { ascending: false }).order('review_count', { ascending: false });
  else query = query.order('created_at', { ascending: false });
  const from = (page - 1) * limit;
  const { data, error, count } = await query.range(from, from + limit - 1);
  if (error) throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'The product catalogue is temporarily unavailable.');
  res.json({ data: { products: (data || []).map(toPublicProduct), page, limit, total: count || 0 } });
}));

app.get('/api/v1/products/:slug', asyncRoute(async (req, res) => {
  const { error: expiryError } = await productsDb.rpc('expire_vine_inventory_reservations');
  if (expiryError) throw new HttpError(503, 'INVENTORY_UNAVAILABLE', 'Product availability could not be refreshed.');
  const slug = safeText(180).parse(req.params.slug);
  const { data, error } = await productsDb.from('products').select(publicProductFields).eq('slug', slug).eq('status', 'published').maybeSingle();
  if (error) throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'The product catalogue is temporarily unavailable.');
  if (!data) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'That product could not be found.');
  res.json({ data: toPublicProduct(data) });
}));

// Private catalogue administration: never accept supplier costs from public customer routes.
app.post('/api/v1/admin/categories', auth, catalogAdmin, asyncRoute(async (req, res) => {
  const input = z.object({ name: safeText(80), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80), description: optionalText(500), sortOrder: z.number().int().min(0).max(10000).default(0) }).parse(req.body);
  const { data, error } = await productsDb.from('categories').insert({ name: input.name, slug: input.slug, description: input.description || null, sort_order: input.sortOrder }).select('id,name,slug,description,sort_order').single();
  if (error) throw new HttpError(409, 'CATEGORY_CREATE_FAILED', 'The category could not be created. Check whether its name or slug is already used.');
  res.status(201).json({ data });
}));

const httpsUrlSchema = z.string().url().max(2048).refine(value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } }, 'Only HTTPS image URLs are allowed.');
const productCreateSchema = z.object({
  categoryId: uuidSchema.nullable().optional(), sku: safeText(80), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(180),
  name: safeText(180), description: z.string().max(10000).default(''),
  priceNgn: z.number().finite().min(0).max(100000000), compareAtPriceNgn: z.number().finite().min(0).max(100000000).nullable().optional(),
  imageUrl: httpsUrlSchema.nullable().optional(), galleryUrls: z.array(httpsUrlSchema).max(8).default([]),
  tag: optionalText(40), stockQuantity: z.number().int().min(0).max(10000000).default(0),
  status: z.enum(['draft','published','archived']).default('draft')
}).refine(v => v.compareAtPriceNgn == null || v.compareAtPriceNgn >= v.priceNgn, { path: ['compareAtPriceNgn'], message: 'Compare-at price must not be lower than the selling price.' });

function productPatchRow(input) {
  const row = {};
  const map = { categoryId: 'category_id', sku: 'sku', slug: 'slug', name: 'name', description: 'description', imageUrl: 'image_url', galleryUrls: 'gallery_urls', tag: 'tag', status: 'status' };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'priceNgn') row.price_kobo = Math.round(value * 100);
    else if (key === 'compareAtPriceNgn') row.compare_at_price_kobo = value == null ? null : Math.round(value * 100);
    else if (key === 'stockQuantity') row.stock_quantity = value;
    else if (map[key]) row[map[key]] = value === '' ? null : value;
  }
  row.updated_at = new Date().toISOString();
  return row;
}

app.post('/api/v1/admin/products', auth, catalogAdmin, asyncRoute(async (req, res) => {
  const input = productCreateSchema.parse(req.body);
  const { data, error } = await productsDb.from('products').insert({
    category_id: input.categoryId || null, sku: input.sku, slug: input.slug, name: input.name, description: input.description,
    price_kobo: Math.round(input.priceNgn * 100), compare_at_price_kobo: input.compareAtPriceNgn == null ? null : Math.round(input.compareAtPriceNgn * 100),
    image_url: input.imageUrl || null, gallery_urls: input.galleryUrls, tag: input.tag || null,
    stock_quantity: input.stockQuantity, status: input.status
  }).select(publicProductFields).single();
  if (error) throw new HttpError(409, 'PRODUCT_CREATE_FAILED', 'The product could not be created. Check the SKU, slug, and category.');
  res.status(201).json({ data: toPublicProduct(data) });
}));

app.patch('/api/v1/admin/products/:id', auth, catalogAdmin, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const input = productCreateSchema.partial().refine(v => Object.keys(v).length > 0, 'Provide at least one field.').parse(req.body);
  if (input.priceNgn !== undefined && input.compareAtPriceNgn !== undefined && input.compareAtPriceNgn != null && input.compareAtPriceNgn < input.priceNgn) throw new HttpError(400, 'INVALID_PRICE', 'Compare-at price must not be lower than the selling price.');
  const { data, error } = await productsDb.from('products').update(productPatchRow(input)).eq('id', id).select(publicProductFields).maybeSingle();
  if (error) throw new HttpError(400, 'PRODUCT_UPDATE_FAILED', 'The product could not be updated. Check its fields and stock reservations.');
  if (!data) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'That product was not found.');
  res.json({ data: toPublicProduct(data) });
}));

app.get('/api/v1/admin/suppliers', auth, supplierView, asyncRoute(async (req, res) => {
  const { data, error } = await productsDb.from('suppliers').select('id,name,contact_name,contact_email,contact_phone,shipping_method,internal_notes,status,created_at,updated_at').order('name');
  if (error) throw new HttpError(503, 'SUPPLIERS_UNAVAILABLE', 'Supplier records could not be loaded.');
  res.json({ data: data || [] });
}));
app.post('/api/v1/admin/suppliers', auth, supplierManage, asyncRoute(async (req, res) => {
  const input = z.object({ name: safeText(160), contactName: optionalText(160), contactEmail: z.string().email().max(254).optional().or(z.literal('')), contactPhone: optionalText(40), shippingMethod: optionalText(160), internalNotes: optionalText(3000), status: z.enum(['active','paused','retired']).default('active') }).parse(req.body);
  const { data, error } = await productsDb.from('suppliers').insert({ name: input.name, contact_name: input.contactName || null, contact_email: input.contactEmail || null, contact_phone: input.contactPhone || null, shipping_method: input.shippingMethod || null, internal_notes: input.internalNotes || null, status: input.status }).select('id,name,contact_name,contact_email,contact_phone,shipping_method,internal_notes,status,created_at,updated_at').single();
  if (error) throw new HttpError(400, 'SUPPLIER_CREATE_FAILED', 'Supplier could not be created.');
  // Supplier contact and wholesale pricing data stays server-side and is never returned by public catalogue routes.
  console.log(JSON.stringify({ level: 'info', service: process.env.SERVICE_NAME, action: 'supplier.created', supplierId: data.id }));
  res.status(201).json({ data });
}));
app.patch('/api/v1/admin/suppliers/:id', auth, supplierManage, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const input = z.object({ name: safeText(160).optional(), contactName: optionalText(160), contactEmail: z.string().email().max(254).optional().or(z.literal('')), contactPhone: optionalText(40), shippingMethod: optionalText(160), internalNotes: optionalText(3000), status: z.enum(['active','paused','retired']).optional() }).refine(v => Object.keys(v).length > 0, 'Provide at least one field.').parse(req.body);
  const map = { name:'name', contactName:'contact_name', contactEmail:'contact_email', contactPhone:'contact_phone', shippingMethod:'shipping_method', internalNotes:'internal_notes', status:'status' };
  const patch = { updated_at: new Date().toISOString() };
  for (const [key,value] of Object.entries(input)) patch[map[key]] = value === '' ? null : value;
  const { data, error } = await productsDb.from('suppliers').update(patch).eq('id',id).select('id,name,contact_name,contact_email,contact_phone,shipping_method,internal_notes,status,created_at,updated_at').maybeSingle();
  if (error) throw new HttpError(400, 'SUPPLIER_UPDATE_FAILED', 'Supplier could not be updated.');
  if (!data) throw new HttpError(404, 'SUPPLIER_NOT_FOUND', 'Supplier was not found.');
  res.json({ data });
}));
app.get('/api/v1/admin/supplier-products', auth, supplierView, asyncRoute(async (_req, res) => {
  const { data, error } = await productsDb.from('supplier_products').select('id,supplier_id,product_id,supplier_sku,cost_price_kobo,lead_time_days,supplier_url,is_primary,created_at,suppliers(name),products(name,sku)').order('created_at', { ascending: false });
  if (error) throw new HttpError(503, 'SUPPLIER_PRODUCTS_UNAVAILABLE', 'Supplier product mappings could not be loaded.');
  res.json({ data: (data || []).map(row => ({ ...row, cost_price_ngn: Number(row.cost_price_kobo) / 100, cost_price_kobo: Number(row.cost_price_kobo) })) });
}));
app.post('/api/v1/admin/supplier-products', auth, supplierManage, asyncRoute(async (req, res) => {
  const input = z.object({ supplierId: uuidSchema, productId: uuidSchema, supplierSku: optionalText(120), costPriceNgn: z.number().finite().min(0).max(100000000), leadTimeDays: z.number().int().min(0).max(365).optional(), supplierUrl: z.string().url().refine(value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } }, 'Supplier URL must use HTTPS.').optional().or(z.literal('')), isPrimary: z.boolean().default(false) }).parse(req.body);
  if (input.isPrimary) {
    const { error: clearError } = await productsDb.from('supplier_products').update({ is_primary: false }).eq('product_id', input.productId).eq('is_primary', true);
    if (clearError) throw new HttpError(503, 'SUPPLIER_MAPPING_FAILED', 'The primary supplier could not be changed.');
  }
  const { data, error } = await productsDb.from('supplier_products').upsert({ supplier_id: input.supplierId, product_id: input.productId, supplier_sku: input.supplierSku || null, cost_price_kobo: Math.round(input.costPriceNgn * 100), lead_time_days: input.leadTimeDays ?? null, supplier_url: input.supplierUrl || null, is_primary: input.isPrimary }, { onConflict: 'supplier_id,product_id' }).select('id,supplier_id,product_id,supplier_sku,cost_price_kobo,lead_time_days,supplier_url,is_primary,created_at').single();
  if (error) throw new HttpError(400, 'SUPPLIER_MAPPING_FAILED', 'Supplier product mapping could not be saved. Confirm that the product and supplier exist.');
  res.status(201).json({ data: { ...data, cost_price_kobo: Number(data.cost_price_kobo), cost_price_ngn: Number(data.cost_price_kobo) / 100 } });
}));

app.get('/api/v1/admin/orders', auth, operationsAdmin, asyncRoute(async (req, res) => {
  const limit = clampInt(req.query.limit, 30, 1, 100);
  let query = ordersDb.from('orders').select('id,order_number,customer_id,email,phone,shipping_address,status,payment_status,subtotal_kobo,delivery_fee_kobo,total_kobo,created_at,paid_at').order('created_at', { ascending: false }).limit(limit);
  const status = String(req.query.status || '').trim();
  if (['pending_payment','paid','processing','shipped','delivered','cancelled','payment_review','refund_pending','refunded'].includes(status)) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new HttpError(503, 'ORDERS_UNAVAILABLE', 'Orders could not be loaded.');
  res.json({ data: data || [] });
}));

const checkoutSchema = z.object({
  addressId: uuidSchema,
  paymentMethod: z.enum(['paystack','bank_transfer']),
  items: z.array(z.object({ productId: uuidSchema, quantity: z.number().int().min(1).max(99) })).min(1).max(50)
}).refine(v => new Set(v.items.map(i => i.productId)).size === v.items.length, { path: ['items'], message: 'Each product should appear only once; quantities are combined by the storefront.' });

app.post('/api/v1/checkout', auth, asyncRoute(async (req, res) => {
  if (String(process.env.CHECKOUT_ENABLED).toLowerCase() !== 'true') throw new HttpError(503, 'CHECKOUT_NOT_ENABLED', 'Vine checkout is not open yet. Product, delivery, and payment settings must be confirmed first.');
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 120) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required to prevent duplicate orders.');
  const input = checkoutSchema.parse(req.body);
  if (!req.user.email) throw new HttpError(400, 'EMAIL_REQUIRED', 'Your account must have an email address before checkout.');
  const normalizedItems = [...input.items].sort((a,b) => a.productId.localeCompare(b.productId));
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ addressId: input.addressId, paymentMethod: input.paymentMethod, items: normalizedItems })).digest('hex');

  const { data: existing, error: existingError } = await ordersDb.from('orders')
    .select('id,order_number,customer_id,status,payment_status,total_kobo,currency,request_fingerprint')
    .eq('customer_id', req.user.id).eq('idempotency_key', idempotencyKey).maybeSingle();
  if (existingError) throw new HttpError(503, 'ORDERS_UNAVAILABLE', 'Order creation is temporarily unavailable.');
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This checkout key was already used for a different cart. Please restart checkout.');
    return res.status(200).json({ data: { orderId: existing.id, orderNumber: existing.order_number, status: existing.status, paymentStatus: existing.payment_status, totalKobo: Number(existing.total_kobo), currency: existing.currency, reused: true } });
  }

  const [{ data: address, error: addressError }, { data: profile, error: profileError }] = await Promise.all([
    accountsAdmin.from('addresses').select('id,user_id,recipient_name,phone,address_line1,address_line2,city,state,postal_code,country,landmark').eq('id', input.addressId).eq('user_id', req.user.id).maybeSingle(),
    accountsAdmin.from('profiles').select('full_name,phone').eq('user_id', req.user.id).maybeSingle()
  ]);
  if (addressError || profileError) throw new HttpError(503, 'CUSTOMER_DETAILS_UNAVAILABLE', 'Your saved customer details could not be loaded.');
  if (!address) throw new HttpError(400, 'ADDRESS_NOT_FOUND', 'Choose a saved delivery address that belongs to your account.');

  const productIds = normalizedItems.map(item => item.productId);
  const { data: productRows, error: productsError } = await productsDb.from('products')
    .select('id,sku,name,slug,price_kobo,stock_quantity,reserved_quantity,status')
    .in('id', productIds).eq('status', 'published');
  if (productsError) throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'Current prices and stock could not be checked.');
  const productMap = new Map((productRows || []).map(product => [product.id, product]));
  if (productMap.size !== normalizedItems.length) throw new HttpError(409, 'PRODUCT_UNAVAILABLE', 'One or more products are no longer available. Refresh your bag and try again.');

  const items = normalizedItems.map(item => {
    const product = productMap.get(item.productId);
    const unitPriceKobo = Number(product.price_kobo);
    return { product_id: product.id, sku_snapshot: product.sku, name_snapshot: product.name, unit_price_kobo: unitPriceKobo, quantity: item.quantity, line_total_kobo: unitPriceKobo * item.quantity };
  });
  const subtotalKobo = items.reduce((sum, item) => sum + item.line_total_kobo, 0);
  const deliveryFeeKobo = Number.parseInt(process.env.DELIVERY_FEE_KOBO ?? '0', 10);
  if (!Number.isSafeInteger(deliveryFeeKobo) || deliveryFeeKobo < 0) throw new HttpError(503, 'DELIVERY_CONFIGURATION_INVALID', 'Delivery pricing is not configured correctly.');
  const totalKobo = subtotalKobo + deliveryFeeKobo;
  if (!Number.isSafeInteger(totalKobo) || totalKobo > 9_000_000_000_000) throw new HttpError(400, 'ORDER_TOTAL_INVALID', 'The order total is outside the supported range.');

  const orderId = crypto.randomUUID();
  const reference = `VINE-${orderId.replaceAll('-', '').toUpperCase()}`;
  const reservePayload = items.map(item => ({ product_id: item.product_id, quantity: item.quantity }));
  const { error: reserveError } = await productsDb.rpc('reserve_vine_inventory', { p_order_id: orderId, p_items: reservePayload, p_ttl_minutes: 45 });
  if (reserveError) {
    const message = /insufficient stock|product unavailable/i.test(reserveError.message || '') ? 'One or more products do not have enough stock. Refresh your bag and try again.' : 'Stock could not be reserved. Please try again.';
    throw new HttpError(409, 'INVENTORY_RESERVATION_FAILED', message);
  }

  const addressSnapshot = {
    recipientName: address.recipient_name, phone: address.phone,
    addressLine1: address.address_line1, addressLine2: address.address_line2,
    city: address.city, state: address.state, postalCode: address.postal_code,
    country: address.country, landmark: address.landmark
  };
  const orderPayload = {
    id: orderId, customer_id: req.user.id, email: req.user.email,
    phone: address.phone || profile?.phone || '', shipping_address: addressSnapshot,
    subtotal_kobo: subtotalKobo, delivery_fee_kobo: deliveryFeeKobo, total_kobo: totalKobo,
    idempotency_key: idempotencyKey, request_fingerprint: fingerprint,
    expires_at: new Date(Date.now() + 45 * 60 * 1000).toISOString()
  };
  const paymentPayload = { provider: input.paymentMethod, reference, amount_kobo: totalKobo };
  const { data: order, error: createError } = await ordersDb.rpc('create_vine_order_bundle', { p_order: orderPayload, p_items: items, p_payment: paymentPayload });
  if (createError || !order) {
    await productsDb.rpc('release_vine_inventory', { p_order_id: orderId }).catch(() => {});
    // A simultaneous request with the same idempotency key may have won the race.
    const { data: raced } = await ordersDb.from('orders').select('id,order_number,customer_id,status,payment_status,total_kobo,currency,request_fingerprint').eq('customer_id', req.user.id).eq('idempotency_key', idempotencyKey).maybeSingle();
    if (raced && raced.request_fingerprint === fingerprint) return res.status(200).json({ data: { orderId: raced.id, orderNumber: raced.order_number, status: raced.status, paymentStatus: raced.payment_status, totalKobo: Number(raced.total_kobo), currency: raced.currency, reused: true } });
    throw new HttpError(503, 'ORDER_CREATE_FAILED', 'The order could not be created. Any inventory reservation was released; please try again.');
  }
  res.status(201).json({ data: { orderId: order.id, orderNumber: order.order_number, status: order.status, paymentStatus: order.payment_status, totalKobo: Number(order.total_kobo), currency: order.currency, paymentMethod: input.paymentMethod, expiresAt: order.expires_at, reused: false } });
}));

app.post('/api/v1/me/orders/:id/cancel', auth, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const { data: order, error } = await ordersDb.from('orders').select('id,order_number,customer_id,status,payment_status,expires_at').eq('id', id).eq('customer_id', req.user.id).maybeSingle();
  if (error) throw new HttpError(503, 'ORDERS_UNAVAILABLE', 'Order details could not be loaded.');
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'That order was not found.');
  if (order.status === 'cancelled' && order.payment_status === 'expired') return res.json({ data: { orderId: id, status: 'cancelled', alreadyCancelled: true } });
  if (order.payment_status === 'paid' || order.status !== 'pending_payment') throw new HttpError(409, 'ORDER_NOT_CANCELLABLE', 'Paid or processing orders cannot be cancelled automatically. Contact Vine support.');
  const now = new Date().toISOString();
  const { error: releaseError } = await productsDb.rpc('release_vine_inventory', { p_order_id: id });
  if (releaseError) throw new HttpError(503, 'INVENTORY_RELEASE_FAILED', 'Stock could not be released. Please try again.');
  const { error: paymentUpdateError } = await ordersDb.from('payments').update({ status: 'expired', updated_at: now }).eq('order_id', id).neq('status','paid');
  const { data: cancelled, error: orderUpdateError } = await ordersDb.from('orders').update({ status: 'cancelled', payment_status: 'expired', cancelled_at: now, updated_at: now }).eq('id', id).eq('customer_id', req.user.id).neq('payment_status','paid').select('id,order_number,status,payment_status').maybeSingle();
  if (paymentUpdateError || orderUpdateError) throw new HttpError(503, 'ORDER_CANCEL_FAILED', 'The order cancellation could not be saved.');
  if (!cancelled) throw new HttpError(409, 'ORDER_NOT_CANCELLABLE', 'This order has changed state and cannot be cancelled automatically.');
  res.json({ data: { ...cancelled, stockReleased: true } });
}));

app.get('/api/v1/me/orders', auth, asyncRoute(async (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 50);
  const { data, error } = await ordersDb.from('orders').select('id,order_number,status,payment_status,currency,subtotal_kobo,delivery_fee_kobo,total_kobo,created_at,paid_at').eq('customer_id', req.user.id).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new HttpError(503, 'ORDERS_UNAVAILABLE', 'Your orders could not be loaded.');
  res.json({ data: (data || []).map(order => ({ ...order, subtotal_kobo: Number(order.subtotal_kobo), delivery_fee_kobo: Number(order.delivery_fee_kobo), total_kobo: Number(order.total_kobo) })) });
}));

app.get('/api/v1/me/orders/:id', auth, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const { data: order, error } = await ordersDb.from('orders').select('id,order_number,status,payment_status,currency,subtotal_kobo,delivery_fee_kobo,total_kobo,shipping_address,created_at,paid_at').eq('id', id).eq('customer_id', req.user.id).maybeSingle();
  if (error) throw new HttpError(503, 'ORDERS_UNAVAILABLE', 'Order details could not be loaded.');
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'That order was not found.');
  const [{ data: items, error: itemsError }, { data: payment, error: paymentError }] = await Promise.all([
    ordersDb.from('order_items').select('product_id,sku_snapshot,name_snapshot,unit_price_kobo,quantity,line_total_kobo').eq('order_id', id),
    ordersDb.from('payments').select('provider,reference,status,authorization_url,paid_at,created_at').eq('order_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle()
  ]);
  if (itemsError || paymentError) throw new HttpError(503, 'ORDER_DETAILS_UNAVAILABLE', 'Order details could not be loaded.');
  res.json({ data: { ...order, subtotal_kobo: Number(order.subtotal_kobo), delivery_fee_kobo: Number(order.delivery_fee_kobo), total_kobo: Number(order.total_kobo), items: (items || []).map(i => ({ ...i, unit_price_kobo: Number(i.unit_price_kobo), line_total_kobo: Number(i.line_total_kobo) })), payment: payment ? { ...payment, reference: payment.reference } : null } });
}));

finishApp(app);
const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', service: process.env.SERVICE_NAME, port })));
