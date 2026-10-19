import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
const storefrontHtmlPath = fileURLToPath(new URL('../../../Frontend/index.html', import.meta.url));
// Define upload middleware before registering any route that references it.
// Keeping these constants near app setup prevents a temporal-dead-zone crash at startup.
const productImageBucket = String(process.env.VINE_PRODUCT_IMAGES_BUCKET || 'vine-product-images').trim();
const productImageBody = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'], limit: '5mb' });
const catalogView = requirePermission(accountsAdmin, 'products.view', ['owner', 'admin', 'catalog']);
const catalogAdmin = requirePermission(accountsAdmin, 'products.manage', ['owner', 'admin', 'catalog']);
const supplierView = requirePermission(accountsAdmin, 'suppliers.view', ['owner', 'admin', 'catalog']);
const supplierManage = requirePermission(accountsAdmin, 'suppliers.manage', ['owner', 'admin', 'catalog']);
const operationsAdmin = requirePermission(accountsAdmin, 'orders.view', ['owner', 'admin', 'operations', 'support']);
const publicProductFields = 'id,category_id,sku,slug,name,description,price_kobo,compare_at_price_kobo,currency,image_url,gallery_urls,tag,rating,review_count,stock_quantity,reserved_quantity,status,metadata,created_at,updated_at,category:categories(id,name,slug)';

function toPublicProduct(row) {
  return {
    id: row.id, sku: row.sku, slug: row.slug, name: row.name, description: row.description,
    priceKobo: Number(row.price_kobo), priceNgn: Number(row.price_kobo) / 100,
    compareAtPriceKobo: row.compare_at_price_kobo == null ? null : Number(row.compare_at_price_kobo),
    compareAtPriceNgn: row.compare_at_price_kobo == null ? null : Number(row.compare_at_price_kobo) / 100,
    currency: row.currency, imageUrl: row.image_url, galleryUrls: row.gallery_urls || [],
    tag: row.tag, rating: Number(row.rating || 0), reviewCount: Number(row.review_count || 0),
    specifications: Array.isArray(row.metadata?.specifications) ? row.metadata.specifications.filter(x => x && typeof x.name === 'string' && typeof x.value === 'string').slice(0, 30) : [],
    availableQuantity: Math.max(0, Number(row.stock_quantity) - Number(row.reserved_quantity)),
    category: row.category ? { id: row.category.id, name: row.category.name, slug: row.category.slug } : null
  };
}

app.get(['/','/index.html'], (_req, res, next) => {
  // Serve the actual storefront from the Store API root as a fallback, so this
  // Render URL opens the shopping page instead of a status JSON or blank not-found page.
  // Keep a separate static-site deployment supported; both copies use the same APIs.
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Security-Policy', "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://accounts.google.com; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; connect-src 'self' https:; frame-src 'self' https:; font-src 'self' data: https:; object-src 'none'; base-uri 'self'; form-action 'self' https:; upgrade-insecure-requests");
  res.sendFile(storefrontHtmlPath, error => { if (error && !res.headersSent) next(error); });
});

app.get('/health', sendHealth);
app.get('/ready', asyncRoute(async (_req, res) => {
  const [a, b] = await Promise.all([
    productsDb.from('categories').select('id').limit(1),
    ordersDb.from('orders').select('id').limit(1)
  ]);
  if (a.error || b.error) throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'One or more Vine store databases are not ready.');
  res.json({ status: 'ready', service: process.env.SERVICE_NAME });
}));

const publicStoreSettings = {
  storefront: {
    storeName: 'Vine', tagline: 'Great finds. Great prices.', supportEmail: '', supportPhone: '',
    announcementEnabled: false, announcementText: ''
  },
  shipping: {
    baseFeeNgn: null, freeShippingEnabled: false, freeShippingThresholdNgn: null,
    estimatedMinDays: 2, estimatedMaxDays: 7, coverageStates: []
  },
  seo: {
    title: 'Vine — Great finds. Great prices.',
    description: 'Shop useful finds across everyday categories at Vine.',
    canonicalUrl: 'https://vinestore.com.ng', socialImageUrl: ''
  },
  policies: { returnsPolicy: '', privacyPolicy: '', termsOfService: '', shippingPolicy: '' }
};

function publicSettingGroup(group, saved) {
  const defaults = publicStoreSettings[group];
  const source = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const output = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = source[key];
    if (typeof defaults[key] === 'boolean') output[key] = typeof value === 'boolean' ? value : defaults[key];
    else if (typeof defaults[key] === 'number' || defaults[key] === null) output[key] = value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : defaults[key];
    else if (Array.isArray(defaults[key])) output[key] = Array.isArray(value) ? value.map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 40) : defaults[key];
    else if (typeof defaults[key] === 'string') output[key] = typeof value === 'string' ? value.trim().slice(0, key.toLowerCase().includes('policy') ? 8000 : 1000) : defaults[key];
  }
  if (!/^\S+@\S+\.\S+$/.test(output.supportEmail)) output.supportEmail = '';
  for (const key of ['canonicalUrl', 'socialImageUrl']) {
    if (!output[key]) continue;
    try { if (new URL(output[key]).protocol !== 'https:') output[key] = key === 'canonicalUrl' ? defaults.canonicalUrl : ''; }
    catch { output[key] = key === 'canonicalUrl' ? defaults.canonicalUrl : ''; }
  }
  if (output.estimatedMaxDays < output.estimatedMinDays) output.estimatedMaxDays = output.estimatedMinDays;
  if (output.freeShippingThresholdNgn === null || output.freeShippingThresholdNgn === 0) output.freeShippingEnabled = false;
  return output;
}

// Public configuration deliberately exposes only fields rendered by the storefront.
// Payment, account, owner, secret, and internal operations settings are never returned.
app.get('/api/v1/storefront/config', asyncRoute(async (_req, res) => {
  const { data, error } = await accountsAdmin.from('vineowner_settings')
    .select('setting_key,setting_value,updated_at')
    .in('setting_key', ['storefront', 'shipping', 'seo', 'policies']);
  if (error) throw new HttpError(503, 'STOREFRONT_CONFIG_UNAVAILABLE', 'Store information could not be loaded. Please try again shortly.');
  const rows = new Map((data || []).map(row => [row.setting_key, row]));
  const config = Object.fromEntries(Object.keys(publicStoreSettings).map(key => [key, publicSettingGroup(key, rows.get(key)?.setting_value)]));
  config.shipping.pricingConfigured = Boolean(rows.has('shipping') && Number.isFinite(Number(rows.get('shipping')?.setting_value?.baseFeeNgn)) && Number(rows.get('shipping')?.setting_value?.baseFeeNgn) >= 0);
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  res.json({ data: { ...config, updatedAt: Object.fromEntries([...rows].map(([key, row]) => [key, row.updated_at])) } });
}));

app.get('/api/v1/categories', asyncRoute(async (_req, res) => {
  const { data, error } = await productsDb.from('categories').select('id,name,slug,description,sort_order').eq('is_active', true).order('sort_order').order('name');
  if (error) throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'The product catalogue is temporarily unavailable.');
  res.json({ data: data || [] });
}));

// Staff-only category list includes inactive categories so existing products can be edited safely.
app.get('/api/v1/admin/categories', auth, catalogView, asyncRoute(async (_req, res) => {
  const { data, error } = await productsDb.from('categories')
    .select('id,name,slug,description,sort_order,is_active,created_at,updated_at')
    .order('sort_order').order('name');
  if (error) throw new HttpError(503, 'CATEGORIES_UNAVAILABLE', 'Product categories could not be loaded.');
  res.json({ data: data || [] });
}));


app.get('/api/v1/products', asyncRoute(async (req, res) => {
  const { error: expiryError } = await productsDb.rpc('expire_vine_inventory_reservations');
  // Expired-reservation cleanup must not make an otherwise readable storefront go blank.
  // A cleanup error is logged without database details; inventory changes remain guarded
  // by the checkout/reservation routines and the product list still applies stock safety.
  if (expiryError) {
    console.warn(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'inventory_expiry_cleanup_failed', code: String(expiryError.code || 'RPC_FAILED').slice(0, 40) }));
  }
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

function makeReviewerDisplayName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Vine shopper';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase() + parts[0].slice(1);
  return `${parts[0]} ${parts[parts.length - 1].slice(0, 1).toUpperCase()}.`;
}

app.get('/api/v1/products/:slug/reviews', asyncRoute(async (req, res) => {
  const slug = safeText(180).parse(req.params.slug);
  const { data: product, error: productError } = await productsDb.from('products')
    .select('id,rating,review_count').eq('slug', slug).eq('status', 'published').maybeSingle();
  if (productError) throw new HttpError(503, 'PRODUCT_REVIEWS_UNAVAILABLE', 'Reviews are temporarily unavailable.');
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'That product could not be found.');

  const page = clampInt(req.query.page, 1, 1, 10000);
  const limit = clampInt(req.query.limit, 8, 1, 20);
  const sort = ['newest', 'highest', 'lowest', 'helpful'].includes(String(req.query.sort)) ? String(req.query.sort) : 'newest';
  const ratingRaw = String(req.query.rating || '').trim();
  const ratingFilter = ratingRaw ? Number(ratingRaw) : null;
  if (ratingFilter !== null && (!Number.isInteger(ratingFilter) || ratingFilter < 1 || ratingFilter > 5)) {
    throw new HttpError(400, 'REVIEW_FILTER_INVALID', 'Choose a rating from 1 to 5 stars.');
  }
  const photosOnly = String(req.query.photosOnly || '').toLowerCase() === 'true';
  let query = productsDb.from('product_reviews')
    .select('id,rating,title,body,pros,cons,image_urls,helpful_count,is_verified_purchase,created_at,updated_at,customer_id', { count: 'exact' })
    .eq('product_id', product.id).eq('status', 'published');
  if (ratingFilter !== null) query = query.eq('rating', ratingFilter);
  if (photosOnly) query = query.not('image_urls', 'eq', '{}');
  if (sort === 'highest') query = query.order('rating', { ascending: false }).order('created_at', { ascending: false });
  else if (sort === 'lowest') query = query.order('rating', { ascending: true }).order('created_at', { ascending: false });
  else if (sort === 'helpful') query = query.order('helpful_count', { ascending: false }).order('created_at', { ascending: false });
  else query = query.order('created_at', { ascending: false });
  const from = (page - 1) * limit;
  const [{ data: reviews, error: reviewError, count }, ...ratingCounts] = await Promise.all([
    query.range(from, from + limit - 1),
    ...[1,2,3,4,5].map(rating => productsDb.from('product_reviews').select('id', { count: 'exact', head: true }).eq('product_id', product.id).eq('status', 'published').eq('rating', rating))
  ]);
  if (reviewError || ratingCounts.some(x => x.error)) throw new HttpError(503, 'PRODUCT_REVIEWS_UNAVAILABLE', 'Reviews are temporarily unavailable.');
  const userIds = [...new Set((reviews || []).map(row => row.customer_id))];
  let profileRows = [];
  if (userIds.length) {
    const { data, error } = await accountsAdmin.from('profiles').select('user_id,full_name').in('user_id', userIds);
    if (!error) profileRows = data || [];
  }
  const names = new Map(profileRows.map(row => [row.user_id, makeReviewerDisplayName(row.full_name)]));
  res.json({ data: {
    productId: product.id,
    summary: {
      averageRating: Number(product.rating || 0),
      reviewCount: Number(product.review_count || 0),
      distribution: Object.fromEntries([1,2,3,4,5].map((rating, index) => [rating, Number(ratingCounts[index].count || 0)]))
    },
    reviews: (reviews || []).map(row => ({
      id: row.id, rating: Number(row.rating), title: row.title, body: row.body,
      pros: row.pros || '', cons: row.cons || '', imageUrls: row.image_urls || [],
      helpfulCount: Number(row.helpful_count || 0), verifiedPurchase: Boolean(row.is_verified_purchase),
      reviewerName: names.get(row.customer_id) || 'Vine shopper', createdAt: row.created_at, updatedAt: row.updated_at
    })),
    total: Number(count || 0), page, limit, hasMore: page * limit < Number(count || 0)
  }});
}));

app.post('/api/v1/products/:slug/reviews', auth, asyncRoute(async (req, res) => {
  const slug = safeText(180).parse(req.params.slug);
  const input = z.object({
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().min(3).max(120),
    body: z.string().trim().min(10).max(3000),
    pros: z.string().trim().max(700).default(''),
    cons: z.string().trim().max(700).default(''),
    imagePaths: z.array(z.string().trim().regex(/^reviews\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i)).max(3).default([])
  }).parse(req.body);
  const { data: product, error: productError } = await productsDb.from('products').select('id').eq('slug', slug).eq('status', 'published').maybeSingle();
  if (productError) throw new HttpError(503, 'PRODUCT_UNAVAILABLE', 'We could not confirm this product. Please try again.');
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'That product could not be found.');

  const { data: paidOrders, error: ordersError } = await ordersDb.from('orders').select('id')
    .eq('customer_id', req.user.id).eq('payment_status', 'paid').limit(500);
  if (ordersError) throw new HttpError(503, 'PURCHASE_CHECK_FAILED', 'Your purchase could not be verified yet. Please try again.');
  const orderIds = (paidOrders || []).map(row => row.id);
  if (!orderIds.length) throw new HttpError(403, 'VERIFIED_PURCHASE_REQUIRED', 'Only customers who purchased this product through Vine can leave a review.');
  const { data: matchingItems, error: itemsError } = await ordersDb.from('order_items').select('order_id')
    .eq('product_id', product.id).in('order_id', orderIds).limit(1);
  if (itemsError) throw new HttpError(503, 'PURCHASE_CHECK_FAILED', 'Your purchase could not be verified yet. Please try again.');
  if (!matchingItems?.length) throw new HttpError(403, 'VERIFIED_PURCHASE_REQUIRED', 'Only customers who purchased this product through Vine can leave a review.');

  const storage = productsDb.storage.from(productImageBucket);
  const validPrefix = `reviews/${req.user.id}/`;
  if (input.imagePaths.some(path => !path.startsWith(validPrefix))) throw new HttpError(400, 'REVIEW_IMAGE_INVALID', 'One of the selected review photos is invalid. Remove it and try again.');
  const imageUrls = input.imagePaths.map(path => storage.getPublicUrl(path)?.data?.publicUrl).filter(url => typeof url === 'string' && /^https:\/\//i.test(url));
  if (imageUrls.length !== input.imagePaths.length) throw new HttpError(400, 'REVIEW_IMAGE_INVALID', 'One of the selected review photos could not be identified.');

  const { data, error } = await productsDb.from('product_reviews').upsert({
    product_id: product.id, customer_id: req.user.id, order_id: matchingItems[0].order_id,
    rating: input.rating, title: input.title, body: input.body, pros: input.pros, cons: input.cons,
    image_urls: imageUrls, status: 'published', is_verified_purchase: true, updated_at: new Date().toISOString()
  }, { onConflict: 'product_id,customer_id' })
    .select('id,rating,title,body,pros,cons,image_urls,helpful_count,is_verified_purchase,created_at,updated_at')
    .single();
  if (error || !data) throw new HttpError(503, 'REVIEW_SAVE_FAILED', 'Your review could not be saved. Please try again.');
  res.status(201).json({ data: { ...data, imageUrls: data.image_urls || [], rating: Number(data.rating), helpfulCount: Number(data.helpful_count || 0), verifiedPurchase: true } });
}));

app.post('/api/v1/reviews/images', auth, productImageBody, asyncRoute(async (req, res) => {
  // Review photos are accepted only after checking that this signed-in customer purchased this exact item.
  // This prevents the public-read storage bucket from becoming a general-purpose image-hosting endpoint.
  const reviewSlug = safeText(180).parse(String(req.get('x-vine-product-slug') || '').trim());
  const { data: reviewProduct, error: reviewProductError } = await productsDb.from('products')
    .select('id').eq('slug', reviewSlug).eq('status', 'published').maybeSingle();
  if (reviewProductError) throw new HttpError(503, 'PURCHASE_CHECK_FAILED', 'We could not verify this product before uploading a review photo. Please try again.');
  if (!reviewProduct) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'That product could not be found.');
  const { data: paidOrders, error: paidOrdersError } = await ordersDb.from('orders')
    .select('id').eq('customer_id', req.user.id).eq('payment_status', 'paid').limit(500);
  if (paidOrdersError) throw new HttpError(503, 'PURCHASE_CHECK_FAILED', 'Your purchase could not be verified. Please try again.');
  const orderIds = (paidOrders || []).map(row => row.id);
  if (!orderIds.length) throw new HttpError(403, 'VERIFIED_PURCHASE_REQUIRED', 'Only customers who purchased this product through Vine can upload review photos.');
  const { data: matchingItems, error: itemsError } = await ordersDb.from('order_items')
    .select('order_id').eq('product_id', reviewProduct.id).in('order_id', orderIds).limit(1);
  if (itemsError) throw new HttpError(503, 'PURCHASE_CHECK_FAILED', 'Your product purchase could not be verified. Please try again.');
  if (!matchingItems?.length) throw new HttpError(403, 'VERIFIED_PURCHASE_REQUIRED', 'Only customers who purchased this product through Vine can upload review photos.');

  const contentType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const type = productImageTypes.get(contentType);
  if (!type) throw new HttpError(415, 'REVIEW_IMAGE_TYPE_UNSUPPORTED', 'Choose a JPG, PNG or WebP image.');
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'REVIEW_IMAGE_EMPTY', 'Choose a photo before uploading.');
  if (!type.signature(req.body)) throw new HttpError(400, 'REVIEW_IMAGE_INVALID', 'The selected file is not a valid image. Choose another photo.');
  if (req.body.length > 5 * 1024 * 1024) throw new HttpError(413, 'REVIEW_IMAGE_TOO_LARGE', 'The optimised photo must be 5 MB or smaller.');
  const path = `reviews/${req.user.id}/${crypto.randomUUID()}.${type.extension}`;
  const storage = productsDb.storage.from(productImageBucket);
  const { error } = await storage.upload(path, req.body, { contentType, cacheControl: '31536000', upsert: false });
  if (error) throw new HttpError(503, 'REVIEW_IMAGE_UPLOAD_FAILED', 'This review photo could not be saved. Please try again.');
  const imageUrl = storage.getPublicUrl(path)?.data?.publicUrl;
  if (!imageUrl || !/^https:\/\//i.test(imageUrl)) {
    await storage.remove([path]).catch(() => {});
    throw new HttpError(503, 'REVIEW_IMAGE_URL_FAILED', 'The photo was saved but its public link could not be created.');
  }
  res.status(201).json({ data: { imageUrl, path, contentType, sizeBytes: req.body.length } });
}));

app.delete('/api/v1/reviews/images', auth, asyncRoute(async (req, res) => {
  const input = z.object({ path: z.string().trim().regex(/^reviews\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i) }).parse(req.body);
  if (!input.path.startsWith(`reviews/${req.user.id}/`)) throw new HttpError(403, 'REVIEW_IMAGE_OWNERSHIP_REQUIRED', 'You can only remove photos uploaded from your own account.');
  const storage = productsDb.storage.from(productImageBucket);
  const { data: linked, error: linkedError } = await productsDb.from('product_reviews').select('id').contains('image_urls', [storage.getPublicUrl(input.path).data.publicUrl]).limit(1);
  if (linkedError) throw new HttpError(503, 'REVIEW_IMAGE_REFERENCE_CHECK_FAILED', 'We could not safely check whether this photo is already in use.');
  if (linked?.length) throw new HttpError(409, 'REVIEW_IMAGE_IN_USE', 'This photo is already attached to a saved review.');
  const { error } = await storage.remove([input.path]);
  if (error) throw new HttpError(503, 'REVIEW_IMAGE_DELETE_FAILED', 'The unused photo could not be removed.');
  res.status(204).end();
}));

app.post('/api/v1/reviews/:reviewId/helpful', auth, asyncRoute(async (req, res) => {
  const reviewId = uuidSchema.parse(req.params.reviewId);
  const { data: review, error: reviewError } = await productsDb.from('product_reviews').select('id,status,customer_id').eq('id', reviewId).maybeSingle();
  if (reviewError) throw new HttpError(503, 'REVIEW_UNAVAILABLE', 'This review could not be loaded.');
  if (!review || review.status !== 'published') throw new HttpError(404, 'REVIEW_NOT_FOUND', 'This review is no longer available.');
  if (String(review.customer_id) === String(req.user.id)) throw new HttpError(409, 'REVIEW_SELF_VOTE', 'You cannot mark your own review as helpful.');
  const { error } = await productsDb.from('product_review_votes').upsert({ review_id: reviewId, customer_id: req.user.id }, { onConflict: 'review_id,customer_id', ignoreDuplicates: true });
  if (error) throw new HttpError(503, 'REVIEW_VOTE_FAILED', 'Your vote could not be saved. Please try again.');
  const { data: fresh, error: freshError } = await productsDb.from('product_reviews').select('helpful_count').eq('id', reviewId).single();
  if (freshError) throw new HttpError(503, 'REVIEW_VOTE_FAILED', 'Your vote was saved, but its count could not be refreshed.');
  res.json({ data: { reviewId, helpfulCount: Number(fresh.helpful_count || 0), markedHelpful: true } });
}));

// Product questions and answers let shoppers ask clear product-specific questions and let authorised Vine staff reply.
app.get('/api/v1/products/:slug/questions', asyncRoute(async (req, res) => {
  const slug = safeText(180).parse(req.params.slug);
  const { data: product, error: productError } = await productsDb.from('products')
    .select('id').eq('slug', slug).eq('status', 'published').maybeSingle();
  if (productError) throw new HttpError(503, 'PRODUCT_QUESTIONS_UNAVAILABLE', 'Product questions are temporarily unavailable.');
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'That product could not be found.');

  const page = clampInt(req.query.page, 1, 1, 10000);
  const limit = clampInt(req.query.limit, 8, 1, 20);
  const from = (page - 1) * limit;
  const { data: questions, error, count } = await productsDb.from('product_questions')
    .select('id,question,answer,is_verified_purchase,created_at,answered_at,customer_id', { count: 'exact' })
    .eq('product_id', product.id).eq('status', 'answered')
    .order('answered_at', { ascending: false }).range(from, from + limit - 1);
  if (error) throw new HttpError(503, 'PRODUCT_QUESTIONS_UNAVAILABLE', 'Product questions are temporarily unavailable.');

  const userIds = [...new Set((questions || []).map(row => row.customer_id))];
  let profileRows = [];
  if (userIds.length) {
    const { data } = await accountsAdmin.from('profiles').select('user_id,full_name').in('user_id', userIds);
    profileRows = data || [];
  }
  const names = new Map(profileRows.map(row => [row.user_id, makeReviewerDisplayName(row.full_name)]));
  res.json({ data: {
    questions: (questions || []).map(row => ({
      id: row.id, question: row.question, answer: row.answer,
      verifiedPurchase: Boolean(row.is_verified_purchase),
      questionerName: names.get(row.customer_id) || 'Vine shopper',
      createdAt: row.created_at, answeredAt: row.answered_at
    })),
    total: Number(count || 0), page, limit, hasMore: page * limit < Number(count || 0)
  } });
}));

app.post('/api/v1/products/:slug/questions', auth, asyncRoute(async (req, res) => {
  const slug = safeText(180).parse(req.params.slug);
  const input = z.object({ question: z.string().trim().min(10).max(1500) }).parse(req.body);
  const { data: product, error: productError } = await productsDb.from('products')
    .select('id').eq('slug', slug).eq('status', 'published').maybeSingle();
  if (productError) throw new HttpError(503, 'PRODUCT_UNAVAILABLE', 'We could not confirm this product. Please try again.');
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'That product could not be found.');

  // Keep the form safe to use without a purchase, but prevent repeated accidental submissions.
  const { data: recentQuestion, error: recentError } = await productsDb.from('product_questions')
    .select('created_at').eq('product_id', product.id).eq('customer_id', req.user.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (recentError) throw new HttpError(503, 'QUESTION_CHECK_FAILED', 'Your question could not be checked. Please try again.');
  if (recentQuestion && Date.now() - new Date(recentQuestion.created_at).getTime() < 60_000) {
    throw new HttpError(429, 'QUESTION_COOLDOWN', 'Please wait a minute before sending another question about this product.');
  }

  let verifiedPurchase = false;
  try {
    const { data: paidOrders, error: ordersError } = await ordersDb.from('orders').select('id')
      .eq('customer_id', req.user.id).eq('payment_status', 'paid').limit(500);
    if (!ordersError && paidOrders?.length) {
      const orderIds = paidOrders.map(row => row.id);
      const { data: matchingItems, error: itemsError } = await ordersDb.from('order_items').select('order_id')
        .eq('product_id', product.id).in('order_id', orderIds).limit(1);
      verifiedPurchase = !itemsError && Boolean(matchingItems?.length);
    }
  } catch { verifiedPurchase = false; }

  const { data, error } = await productsDb.from('product_questions').insert({
    product_id: product.id, customer_id: req.user.id, question: input.question,
    status: 'pending', is_verified_purchase: verifiedPurchase
  }).select('id,question,status,is_verified_purchase,created_at').single();
  if (error || !data) throw new HttpError(503, 'QUESTION_SUBMIT_FAILED', 'Your question could not be sent. Please try again.');
  res.status(201).json({ data: { ...data, verifiedPurchase: Boolean(data.is_verified_purchase), message: 'Your question has been sent to Vine. It will appear here after a team member replies.' } });
}));

app.get('/api/v1/admin/questions', auth, catalogAdmin, asyncRoute(async (req, res) => {
  const status = String(req.query.status || 'pending');
  if (!['pending', 'answered', 'hidden', 'all'].includes(status)) {
    throw new HttpError(400, 'QUESTION_STATUS_INVALID', 'Choose pending, answered, hidden, or all questions.');
  }
  const limit = clampInt(req.query.limit, 100, 1, 200);
  let query = productsDb.from('product_questions')
    .select('id,product_id,customer_id,question,answer,status,is_verified_purchase,created_at,answered_at,updated_at,product:products(id,name,slug,image_url)', { count: 'exact' })
    .order('created_at', { ascending: false }).limit(limit);
  if (status !== 'all') query = query.eq('status', status);
  const { data, error, count } = await query;
  if (error) throw new HttpError(503, 'QUESTIONS_ADMIN_UNAVAILABLE', 'Customer questions could not be loaded.');
  const userIds = [...new Set((data || []).map(row => row.customer_id))];
  let profileRows = [];
  if (userIds.length) {
    const { data: profiles, error: profileError } = await accountsAdmin.from('profiles').select('user_id,full_name').in('user_id', userIds);
    if (profileError) throw new HttpError(503, 'QUESTIONS_CUSTOMERS_UNAVAILABLE', 'Questioner details could not be loaded.');
    profileRows = profiles || [];
  }
  const names = new Map(profileRows.map(row => [row.user_id, makeReviewerDisplayName(row.full_name)]));
  res.json({ data: (data || []).map(row => ({
    id: row.id, productId: row.product_id, customerId: row.customer_id,
    product: row.product || null, question: row.question, answer: row.answer,
    status: row.status, verifiedPurchase: Boolean(row.is_verified_purchase),
    questionerName: names.get(row.customer_id) || 'Vine shopper',
    createdAt: row.created_at, answeredAt: row.answered_at, updatedAt: row.updated_at
  })), total: Number(count || 0) });
}));

app.patch('/api/v1/admin/questions/:id', auth, catalogAdmin, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const input = z.object({
    answer: z.string().trim().min(10).max(3000).optional(),
    status: z.enum(['pending', 'hidden']).optional()
  }).refine(v => Object.keys(v).length > 0, 'Provide an answer or choose a status.').refine(v => !(v.answer !== undefined && v.status !== undefined), 'Save an answer or change status, not both at once.').parse(req.body);
  const now = new Date().toISOString();
  const patch = { updated_at: now };
  if (input.answer !== undefined) {
    patch.answer = input.answer;
    patch.status = 'answered';
    patch.answered_by = req.user.id;
    patch.answered_at = now;
  } else if (input.status === 'hidden') {
    patch.status = 'hidden';
  } else if (input.status === 'pending') {
    patch.status = 'pending';
    patch.answer = '';
    patch.answered_by = null;
    patch.answered_at = null;
  }
  const { data, error } = await productsDb.from('product_questions').update(patch).eq('id', id)
    .select('id,product_id,customer_id,question,answer,status,is_verified_purchase,created_at,answered_at,updated_at').maybeSingle();
  if (error) throw new HttpError(400, 'QUESTION_UPDATE_FAILED', 'This question could not be updated. Please try again.');
  if (!data) throw new HttpError(404, 'QUESTION_NOT_FOUND', 'That question could not be found.');
  res.json({ data: { ...data, verifiedPurchase: Boolean(data.is_verified_purchase) } });
}));

// Customer account history is served by the Store API because reviews, questions and favourites
// live in vine_products while the authenticated customer identity is verified against vine_accounts.
app.get('/api/v1/me/favorites', auth, asyncRoute(async (req, res) => {
  const { data: rows, error } = await productsDb.from('customer_favorites')
    .select('product_id,created_at').eq('customer_id', req.user.id)
    .order('created_at', { ascending: false }).limit(200);
  if (error) throw new HttpError(503, 'FAVORITES_UNAVAILABLE', 'Your saved products could not be loaded.');
  const productIds = [...new Set((rows || []).map(row => row.product_id))];
  if (!productIds.length) return res.json({ data: { favorites: [], count: 0 } });
  const { data: productRows, error: productsError } = await productsDb.from('products')
    .select(publicProductFields).in('id', productIds).eq('status', 'published');
  if (productsError) throw new HttpError(503, 'FAVORITES_UNAVAILABLE', 'Your saved products could not be loaded.');
  const productsById = new Map((productRows || []).map(row => [row.id, toPublicProduct(row)]));
  const favorites = (rows || []).filter(row => productsById.has(row.product_id)).map(row => ({
    product: productsById.get(row.product_id), createdAt: row.created_at
  }));
  res.json({ data: { favorites, count: favorites.length } });
}));

app.post('/api/v1/me/favorites/sync', auth, asyncRoute(async (req, res) => {
  const input = z.object({ productIds: z.array(uuidSchema).max(200) }).strict().parse(req.body);
  const productIds = [...new Set(input.productIds.map(String))];
  if (!productIds.length) return res.json({ data: { saved: 0, skipped: 0 } });
  const { data: products, error: productsError } = await productsDb.from('products')
    .select('id').in('id', productIds).eq('status', 'published');
  if (productsError) throw new HttpError(503, 'FAVORITES_SYNC_FAILED', 'Your saved items could not be synced. Please try again.');
  const validIds = (products || []).map(row => row.id);
  const rows = validIds.map(product_id => ({ customer_id: req.user.id, product_id }));
  if (rows.length) {
    const { error } = await productsDb.from('customer_favorites').upsert(rows, { onConflict: 'customer_id,product_id', ignoreDuplicates: true });
    if (error) throw new HttpError(503, 'FAVORITES_SYNC_FAILED', 'Your saved items could not be synced. Please try again.');
  }
  res.json({ data: { saved: validIds.length, skipped: productIds.length - validIds.length } });
}));

app.put('/api/v1/me/favorites/:productId', auth, asyncRoute(async (req, res) => {
  const productId = uuidSchema.parse(req.params.productId);
  const { data: product, error: productError } = await productsDb.from('products')
    .select('id').eq('id', productId).eq('status', 'published').maybeSingle();
  if (productError) throw new HttpError(503, 'FAVORITE_SAVE_FAILED', 'This product could not be checked. Please try again.');
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Only currently published products can be saved.');
  const { error } = await productsDb.from('customer_favorites').upsert({
    customer_id: req.user.id, product_id: productId
  }, { onConflict: 'customer_id,product_id', ignoreDuplicates: true });
  if (error) throw new HttpError(503, 'FAVORITE_SAVE_FAILED', 'This product could not be saved to your account. Please try again.');
  res.status(200).json({ data: { productId, saved: true } });
}));

app.delete('/api/v1/me/favorites/:productId', auth, asyncRoute(async (req, res) => {
  const productId = uuidSchema.parse(req.params.productId);
  const { error } = await productsDb.from('customer_favorites').delete()
    .eq('customer_id', req.user.id).eq('product_id', productId);
  if (error) throw new HttpError(503, 'FAVORITE_REMOVE_FAILED', 'This saved product could not be removed. Please try again.');
  res.status(204).end();
}));

app.get('/api/v1/me/reviews', auth, asyncRoute(async (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 100);
  const { data: reviews, error } = await productsDb.from('product_reviews')
    .select('id,product_id,rating,title,body,pros,cons,image_urls,status,is_verified_purchase,helpful_count,created_at,updated_at')
    .eq('customer_id', req.user.id).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new HttpError(503, 'MY_REVIEWS_UNAVAILABLE', 'Your review history could not be loaded.');
  const productIds = [...new Set((reviews || []).map(row => row.product_id))];
  let productsById = new Map();
  if (productIds.length) {
    const { data: products, error: productsError } = await productsDb.from('products')
      .select('id,name,slug,image_url,status').in('id', productIds);
    if (productsError) throw new HttpError(503, 'MY_REVIEWS_UNAVAILABLE', 'Product details for your reviews could not be loaded.');
    productsById = new Map((products || []).map(row => [row.id, row]));
  }
  res.json({ data: (reviews || []).map(row => {
    const product = productsById.get(row.product_id);
    return {
      id: row.id, productId: row.product_id, rating: Number(row.rating), title: row.title, body: row.body,
      pros: row.pros || '', cons: row.cons || '', imageUrls: row.image_urls || [], status: row.status,
      verifiedPurchase: Boolean(row.is_verified_purchase), helpfulCount: Number(row.helpful_count || 0),
      createdAt: row.created_at, updatedAt: row.updated_at,
      product: product ? { id: product.id, name: product.name, slug: product.slug, imageUrl: product.image_url, status: product.status } : null
    };
  }) });
}));

app.get('/api/v1/me/questions', auth, asyncRoute(async (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 100);
  const { data: questions, error } = await productsDb.from('product_questions')
    .select('id,product_id,question,answer,status,is_verified_purchase,created_at,answered_at,updated_at')
    .eq('customer_id', req.user.id).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new HttpError(503, 'MY_QUESTIONS_UNAVAILABLE', 'Your product questions could not be loaded.');
  const productIds = [...new Set((questions || []).map(row => row.product_id))];
  let productsById = new Map();
  if (productIds.length) {
    const { data: products, error: productsError } = await productsDb.from('products')
      .select('id,name,slug,image_url,status').in('id', productIds);
    if (productsError) throw new HttpError(503, 'MY_QUESTIONS_UNAVAILABLE', 'Product details for your questions could not be loaded.');
    productsById = new Map((products || []).map(row => [row.id, row]));
  }
  res.json({ data: (questions || []).map(row => {
    const product = productsById.get(row.product_id);
    return {
      id: row.id, productId: row.product_id, question: row.question, answer: row.answer || '', status: row.status,
      verifiedPurchase: Boolean(row.is_verified_purchase), createdAt: row.created_at, answeredAt: row.answered_at,
      updatedAt: row.updated_at,
      product: product ? { id: product.id, name: product.name, slug: product.slug, imageUrl: product.image_url, status: product.status } : null
    };
  }) });
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

// Product photos are uploaded through the Store API so only staff with catalogue permissions can write to Storage.
// The public bucket allows storefront image reads; uploads and deletions remain server-side using service-role credentials.
const productImageTypes = new Map([
  ['image/jpeg', { extension: 'jpg', signature: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  ['image/png', { extension: 'png', signature: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) }],
  ['image/webp', { extension: 'webp', signature: buffer => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' }]
]);

app.post('/api/v1/admin/product-images', auth, catalogAdmin, productImageBody, asyncRoute(async (req, res) => {
  const contentType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const type = productImageTypes.get(contentType);
  if (!type) throw new HttpError(415, 'PRODUCT_IMAGE_TYPE_UNSUPPORTED', 'Choose a JPG, PNG or WebP image.');
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'PRODUCT_IMAGE_EMPTY', 'Choose a photo before uploading.');
  if (!type.signature(req.body)) throw new HttpError(400, 'PRODUCT_IMAGE_INVALID', 'The selected file is not a valid image. Choose another photo.');
  if (req.body.length > 5 * 1024 * 1024) throw new HttpError(413, 'PRODUCT_IMAGE_TOO_LARGE', 'The optimised photo must be 5 MB or smaller.');

  const path = `products/${crypto.randomUUID()}.${type.extension}`;
  const storage = productsDb.storage.from(productImageBucket);
  const { error } = await storage.upload(path, req.body, { contentType, cacheControl: '31536000', upsert: false });
  if (error) {
    console.error(JSON.stringify({ level: 'error', service: process.env.SERVICE_NAME, action: 'product-image.upload.failed', requestId: req.id, code: error.code || 'STORAGE_ERROR' }));
    throw new HttpError(503, 'PRODUCT_IMAGE_UPLOAD_FAILED', 'The photo could not be saved. Please try again. If the problem continues, ask the Vine administrator to check product photo storage.');
  }
  const imageUrl = storage.getPublicUrl(path)?.data?.publicUrl;
  if (!imageUrl || !/^https:\/\//i.test(imageUrl)) {
    await storage.remove([path]).catch(() => {});
    throw new HttpError(503, 'PRODUCT_IMAGE_URL_FAILED', 'The photo was saved but its public link could not be created. Please try again.');
  }
  res.status(201).json({ data: { imageUrl, path, contentType, sizeBytes: req.body.length } });
}));

app.delete('/api/v1/admin/product-images', auth, catalogAdmin, asyncRoute(async (req, res) => {
  const input = z.object({ path: z.string().trim().regex(/^products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i) }).parse(req.body);
  const storage = productsDb.storage.from(productImageBucket);
  const imageUrl = storage.getPublicUrl(input.path)?.data?.publicUrl;
  if (!imageUrl) throw new HttpError(400, 'PRODUCT_IMAGE_PATH_INVALID', 'That photo could not be identified.');
  const [mainImage, galleryImage] = await Promise.all([
    productsDb.from('products').select('id').eq('image_url', imageUrl).limit(1),
    productsDb.from('products').select('id').contains('gallery_urls', [imageUrl]).limit(1)
  ]);
  if (mainImage.error || galleryImage.error) throw new HttpError(503, 'PRODUCT_IMAGE_REFERENCE_CHECK_FAILED', 'We could not safely check whether this photo is in use.');
  if ((mainImage.data || []).length || (galleryImage.data || []).length) throw new HttpError(409, 'PRODUCT_IMAGE_IN_USE', 'This photo is already attached to a product and cannot be removed.');
  const { error } = await storage.remove([input.path]);
  if (error) throw new HttpError(503, 'PRODUCT_IMAGE_DELETE_FAILED', 'The unused photo could not be removed.');
  res.status(204).end();
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
  specifications: z.array(z.object({ name: safeText(80), value: safeText(240) })).max(30).default([]),
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
    else if (key === 'specifications') row.metadata = { specifications: value };
    else if (map[key]) row[map[key]] = value === '' ? null : value;
  }
  row.updated_at = new Date().toISOString();
  return row;
}


// Staff catalogue view: includes draft and archived records, unlike the public storefront listing.
app.get('/api/v1/admin/products', auth, catalogView, asyncRoute(async (req, res) => {
  const page = clampInt(req.query.page, 1, 1, 10000);
  const limit = clampInt(req.query.limit, 100, 1, 100);
  const status = String(req.query.status || 'all').trim().toLowerCase();
  if (!['all','draft','published','archived'].includes(status)) {
    throw new HttpError(400, 'PRODUCT_STATUS_FILTER_INVALID', 'Choose all products, drafts, published products or archived products.');
  }
  const search = normalizeProductQuery(req.query.search);
  let query = productsDb.from('products').select(publicProductFields, { count: 'exact' });
  if (status !== 'all') query = query.eq('status', status);
  if (search) query = query.textSearch('name', search, { type: 'websearch', config: 'simple' });
  query = query.order('updated_at', { ascending: false }).order('created_at', { ascending: false });
  const from = (page - 1) * limit;
  const { data, error, count } = await query.range(from, from + limit - 1);
  if (error) throw new HttpError(503, 'ADMIN_CATALOG_UNAVAILABLE', 'The staff product list could not be loaded.');
  const rows = (data || []).map(row => ({
    ...toPublicProduct(row),
    status: row.status,
    stockQuantity: Number(row.stock_quantity),
    reservedQuantity: Number(row.reserved_quantity),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
  res.json({ data: { products: rows, page, limit, total: Number(count || 0), status } });
}));

app.post('/api/v1/admin/products', auth, catalogAdmin, asyncRoute(async (req, res) => {
  const input = productCreateSchema.parse(req.body);
  const { data, error } = await productsDb.from('products').insert({
    category_id: input.categoryId || null, sku: input.sku, slug: input.slug, name: input.name, description: input.description,
    price_kobo: Math.round(input.priceNgn * 100), compare_at_price_kobo: input.compareAtPriceNgn == null ? null : Math.round(input.compareAtPriceNgn * 100),
    image_url: input.imageUrl || null, gallery_urls: input.galleryUrls, tag: input.tag || null,
    metadata: { specifications: input.specifications || [] }, stock_quantity: input.stockQuantity, status: input.status
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
