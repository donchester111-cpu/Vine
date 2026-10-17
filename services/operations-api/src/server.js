import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { applySecurity, finishApp, sendHealth } from '@vine/shared/app';
import { createAuthContext, createSupabaseClient } from '@vine/shared/db';
import { requireAuth } from '@vine/shared/auth';
import { requirePermission } from '@vine/shared/rbac';
import { asyncRoute, HttpError } from '@vine/shared/errors';
import { clampInt, optionalText, safeText, uuidSchema } from '@vine/shared/validation';

process.env.SERVICE_NAME = 'vine-operations-api';
const { authClient, accountsAdmin } = createAuthContext();
if (!accountsAdmin) throw new Error('ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY is required for vine-operations-api.');
const productsDb = createSupabaseClient(process.env.PRODUCTS_SUPABASE_URL, process.env.PRODUCTS_SUPABASE_SERVICE_ROLE_KEY, 'Vine products database');
const ordersDb = createSupabaseClient(process.env.ORDERS_SUPABASE_URL, process.env.ORDERS_SUPABASE_SERVICE_ROLE_KEY, 'Vine orders database');
const operationsDb = createSupabaseClient(process.env.OPERATIONS_SUPABASE_URL, process.env.OPERATIONS_SUPABASE_SERVICE_ROLE_KEY, 'Vine operations database');
const app = express();
applySecurity(app, { requestLimit: 180 });
const auth = requireAuth(authClient);
const paymentAdmin = requirePermission(accountsAdmin, 'payments.manage', ['owner', 'admin', 'operations']);
const deliveryView = requirePermission(accountsAdmin, 'deliveries.view', ['owner', 'admin', 'operations', 'support']);
const deliveryAdmin = requirePermission(accountsAdmin, 'deliveries.manage', ['owner', 'admin', 'operations', 'support']);
const analyticsAdmin = requirePermission(accountsAdmin, 'analytics.view', ['owner', 'admin', 'operations']);
const notificationsView = requirePermission(accountsAdmin, 'notifications.view', ['owner', 'admin', 'operations', 'support']);
const notificationsManage = requirePermission(accountsAdmin, 'notifications.manage', ['owner', 'admin', 'operations']);

function safeProviderMessage(message) {
  return String(message || '').slice(0, 500).replace(/(sk_[a-zA-Z0-9]+|Bearer\s+\S+)/g, '[redacted]');
}

async function paystackRequest(path, options = {}) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new HttpError(503, 'PAYSTACK_NOT_CONFIGURED', 'Online card payments are not configured yet. Please choose bank transfer or try later.');
  let response;
  try {
    response = await fetch(`https://api.paystack.co${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: AbortSignal.timeout(12_000)
    });
  } catch {
    throw new HttpError(502, 'PAYSTACK_UNAVAILABLE', 'The payment provider could not be reached. Please try again.');
  }
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || payload?.status !== true) {
    console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, provider: 'paystack', status: response.status, message: safeProviderMessage(payload?.message) }));
    throw new HttpError(502, 'PAYSTACK_REQUEST_FAILED', 'The payment provider could not process this request. Please try again.');
  }
  return payload.data;
}

function timingSafeHexEqual(expectedHex, received) {
  if (typeof received !== 'string' || !/^[a-f0-9]{128}$/i.test(received)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(received, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function addAudit({ actorId = null, actorType = 'system', action, entityType, entityId = null, requestId = null, metadata = {} }) {
  const { error } = await operationsDb.from('audit_events').insert({
    actor_id: actorId, actor_type: actorType, action, entity_type: entityType,
    entity_id: entityId == null ? null : String(entityId), request_id: requestId,
    metadata: metadata && typeof metadata === 'object' ? metadata : {}
  });
  if (error) console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, message: 'Audit event could not be recorded', action, entityType, code: error.code }));
}

async function enqueueOrderNotice(order, statusKey) {
  const dedupeKey = `order:${order.id}:${statusKey}:email`;
  const { error } = await operationsDb.from('notification_jobs').upsert({
    dedupe_key: dedupeKey, order_id: order.id, channel: 'email',
    template_key: statusKey, recipient_ref: order.email,
    payload: { orderNumber: order.order_number, status: statusKey }, status: 'pending', available_at: new Date().toISOString()
  }, { onConflict: 'dedupe_key', ignoreDuplicates: true });
  if (error) console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, message: 'Notification job could not be queued', code: error.code }));
}

async function loadPaymentById(paymentId) {
  const { data, error } = await ordersDb.from('payments').select('id,order_id,provider,reference,amount_kobo,currency,status,authorization_url,paid_at').eq('id', paymentId).maybeSingle();
  if (error) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Payment details could not be loaded.');
  if (!data) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'That payment was not found.');
  return data;
}

async function loadOrderForPayment(orderId) {
  const { data, error } = await ordersDb.from('orders').select('id,order_number,customer_id,email,phone,status,payment_status,total_kobo,currency,expires_at,paid_at').eq('id', orderId).maybeSingle();
  if (error) throw new HttpError(503, 'ORDERS_UNAVAILABLE', 'Order details could not be loaded.');
  if (!data) throw new HttpError(404, 'ORDER_NOT_FOUND', 'That order was not found.');
  return data;
}

async function updateOrderAndPaymentPaid(payment, order, timestamp = new Date().toISOString()) {
  const { error: paymentError } = await ordersDb.from('payments').update({ status: 'paid', paid_at: timestamp, last_checked_at: timestamp, updated_at: timestamp }).eq('id', payment.id).neq('status', 'paid');
  if (paymentError) throw new HttpError(503, 'PAYMENT_UPDATE_FAILED', 'Payment status could not be saved. Provider confirmation will be retried.');
  const { data: updatedOrder, error: orderError } = await ordersDb.from('orders').update({ status: 'paid', payment_status: 'paid', paid_at: timestamp, updated_at: timestamp }).eq('id', order.id).neq('payment_status', 'paid').select('id,order_number,customer_id,email,status,payment_status,total_kobo,paid_at').maybeSingle();
  if (orderError) throw new HttpError(503, 'ORDER_UPDATE_FAILED', 'The payment is confirmed, but the order needs reconciliation.');
  const finalOrder = updatedOrder || { ...order, status: 'paid', payment_status: 'paid', paid_at: timestamp };
  const { error: ledgerError } = await operationsDb.rpc('record_vine_sale_once', { p_order_id: order.id, p_order_number: order.order_number, p_amount_kobo: Number(order.total_kobo), p_paid_at: timestamp });
  if (ledgerError) throw new HttpError(503, 'SALES_LEDGER_FAILED', 'The order is paid but sales analytics needs reconciliation. The event is safe to retry.');
  await enqueueOrderNotice(finalOrder, 'customer.order_paid');
  return finalOrder;
}

async function markOrderPaymentReview(payment, order, reason, eventId = null) {
  const now = new Date().toISOString();
  await ordersDb.from('payments').update({ status: 'review_required', last_checked_at: now, updated_at: now }).eq('id', payment.id);
  await ordersDb.from('orders').update({ status: 'payment_review', payment_status: 'review_required', updated_at: now }).eq('id', order.id);
  if (eventId) await ordersDb.from('payment_events').update({ processing_status: 'review_required', failure_code: reason, processed_at: now }).eq('id', eventId);
  await addAudit({ action: 'payment.review_required', entityType: 'order', entityId: order.id, metadata: { reason, provider: payment.provider, paymentReferenceSuffix: payment.reference.slice(-6) } });
  return { needsReview: true };
}

app.get('/health', sendHealth);
app.get('/ready', asyncRoute(async (_req, res) => {
  const checks = await Promise.all([
    ordersDb.from('payments').select('id').limit(1),
    productsDb.from('products').select('id').limit(1),
    operationsDb.from('daily_sales_summary').select('sales_date').limit(1)
  ]);
  if (checks.some(c => c.error)) throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'One or more Vine operations databases are not ready.');
  res.json({ status: 'ready', service: process.env.SERVICE_NAME });
}));

// Webhooks must be verified against the raw request body before JSON parsing.
app.post('/api/v1/webhooks/paystack', express.raw({ type: 'application/json', limit: '1mb' }), asyncRoute(async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new HttpError(503, 'WEBHOOK_NOT_CONFIGURED', 'The payment webhook is not configured.');
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'INVALID_WEBHOOK_BODY', 'A valid JSON webhook body is required.');
  const receivedSignature = req.get('x-paystack-signature') || '';
  const expectedSignature = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
  if (!timingSafeHexEqual(expectedSignature, receivedSignature)) throw new HttpError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Webhook signature verification failed.');
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { throw new HttpError(400, 'INVALID_WEBHOOK_JSON', 'Webhook payload is not valid JSON.'); }
  if (payload?.event !== 'charge.success' || typeof payload?.data?.reference !== 'string') return res.status(200).json({ received: true });

  const reference = payload.data.reference;
  const eventKey = `${payload.event}:${reference}`.slice(0, 200);
  const digest = crypto.createHash('sha256').update(req.body).digest('hex');
  let eventId;
  const { data: insertedEvent, error: insertEventError } = await ordersDb.from('payment_events').insert({ provider: 'paystack', event_key: eventKey, payment_reference: reference, event_type: payload.event, payload_digest: digest, processing_status: 'received' }).select('id').single();
  if (!insertEventError) eventId = insertedEvent.id;
  else if (insertEventError.code === '23505') {
    const { data: prior, error: priorError } = await ordersDb.from('payment_events').select('id,processing_status').eq('provider', 'paystack').eq('event_key', eventKey).maybeSingle();
    if (priorError || !prior) throw new HttpError(503, 'WEBHOOK_EVENT_UNAVAILABLE', 'Webhook event state could not be loaded.');
    if (prior.processing_status === 'processed' || prior.processing_status === 'review_required') return res.status(200).json({ received: true });
    eventId = prior.id;
    await ordersDb.from('payment_events').update({ processing_status: 'received', payload_digest: digest }).eq('id', eventId);
  } else throw new HttpError(503, 'WEBHOOK_EVENT_UNAVAILABLE', 'Webhook event could not be recorded.');

  const { data: payment, error: paymentError } = await ordersDb.from('payments').select('id,order_id,provider,reference,amount_kobo,currency,status,authorization_url,paid_at').eq('reference', reference).maybeSingle();
  if (paymentError || !payment) {
    await ordersDb.from('payment_events').update({ processing_status: 'failed', failure_code: 'payment_not_found', processed_at: new Date().toISOString() }).eq('id', eventId);
    return res.status(200).json({ received: true });
  }
  const order = await loadOrderForPayment(payment.order_id);
  if (payment.provider !== 'paystack' || payment.currency !== 'NGN' || Number(payment.amount_kobo) !== Number(order.total_kobo)) {
    await markOrderPaymentReview(payment, order, 'payment_record_mismatch', eventId);
    return res.status(200).json({ received: true });
  }

  // Do not trust the webhook body alone; verify the reference directly with Paystack.
  const verified = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (verified.status !== 'success' || verified.reference !== reference || Number(verified.amount) !== Number(payment.amount_kobo) || verified.currency !== 'NGN') {
    await markOrderPaymentReview(payment, order, 'gateway_verification_mismatch', eventId);
    return res.status(200).json({ received: true });
  }
  if (payment.status === 'paid' && order.payment_status === 'paid') {
    await ordersDb.from('payment_events').update({ processing_status: 'processed', processed_at: new Date().toISOString() }).eq('id', eventId);
    await operationsDb.rpc('record_vine_sale_once', { p_order_id: order.id, p_order_number: order.order_number, p_amount_kobo: Number(order.total_kobo), p_paid_at: order.paid_at || new Date().toISOString() });
    return res.status(200).json({ received: true });
  }

  const inventoryResult = await productsDb.rpc('commit_vine_inventory', { p_order_id: order.id });
  if (inventoryResult.error) throw new HttpError(503, 'INVENTORY_COMMIT_FAILED', 'Payment is verified but stock allocation needs retry.');
  if (!['committed', 'already_committed'].includes(inventoryResult.data)) {
    await markOrderPaymentReview(payment, order, 'inventory_reservation_missing_after_payment', eventId);
    return res.status(200).json({ received: true });
  }
  await updateOrderAndPaymentPaid(payment, order, new Date().toISOString());
  await ordersDb.from('payment_events').update({ processing_status: 'processed', processed_at: new Date().toISOString() }).eq('id', eventId);
  await addAudit({ action: 'payment.verified', entityType: 'order', entityId: order.id, actorType: 'provider', metadata: { provider: 'paystack', paymentReferenceSuffix: reference.slice(-6) } });
  res.status(200).json({ received: true });
}));

app.use(express.json({ limit: '128kb' }));

app.get('/api/v1/payments/status', auth, asyncRoute(async (req, res) => {
  const reference = z.string().trim().min(8).max(120).parse(req.query.reference);
  const { data: payment, error } = await ordersDb.from('payments').select('id,order_id,provider,reference,status,amount_kobo,currency,paid_at,created_at').eq('reference', reference).maybeSingle();
  if (error) throw new HttpError(503, 'PAYMENT_STATUS_UNAVAILABLE', 'Payment status could not be checked.');
  if (!payment) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'That payment reference was not found.');
  const order = await loadOrderForPayment(payment.order_id);
  if (order.customer_id !== req.user.id) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'That payment reference was not found.');
  res.json({ data: { orderId: order.id, orderNumber: order.order_number, orderStatus: order.status, paymentStatus: order.payment_status, providerStatus: payment.status, amountKobo: Number(payment.amount_kobo), currency: payment.currency, paidAt: payment.paid_at || order.paid_at || null, checkedAt: new Date().toISOString(), note: payment.status === 'paid' ? 'Payment confirmed.' : 'Vine is waiting for verified payment confirmation. Do not pay again while confirmation is pending.' } });
}));

app.post('/api/v1/payments/initialize', auth, asyncRoute(async (req, res) => {
  const { orderId } = z.object({ orderId: uuidSchema }).parse(req.body);
  const order = await loadOrderForPayment(orderId);
  if (order.customer_id !== req.user.id) throw new HttpError(404, 'ORDER_NOT_FOUND', 'That order was not found.');
  if (order.payment_status === 'paid') return res.json({ data: { status: 'paid', orderNumber: order.order_number } });
  if (order.status !== 'pending_payment' || order.payment_status === 'review_required') throw new HttpError(409, 'ORDER_NOT_PAYABLE', 'This order cannot be paid in its current state. Contact Vine support.');
  if (new Date(order.expires_at).getTime() < Date.now()) {
    await productsDb.rpc('release_vine_inventory', { p_order_id: order.id });
    await ordersDb.from('payments').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('order_id', order.id).neq('status','paid');
    await ordersDb.from('orders').update({ status: 'cancelled', payment_status: 'expired', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', order.id).neq('payment_status','paid');
    throw new HttpError(409, 'ORDER_EXPIRED', 'This checkout has expired. Please return to your bag and start again.');
  }
  const { data: paymentRows, error: paymentError } = await ordersDb.from('payments').select('id,order_id,provider,reference,amount_kobo,currency,status,authorization_url').eq('order_id', order.id).order('created_at', { ascending: false }).limit(1);
  if (paymentError || !paymentRows?.length) throw new HttpError(503, 'PAYMENT_UNAVAILABLE', 'Payment details could not be loaded.');
  const payment = paymentRows[0];
  if (Number(payment.amount_kobo) !== Number(order.total_kobo) || payment.currency !== 'NGN') throw new HttpError(409, 'PAYMENT_AMOUNT_MISMATCH', 'The order total and payment amount do not match. Contact Vine support.');

  if (payment.provider === 'bank_transfer') {
    const bankName = String(process.env.BANK_TRANSFER_BANK_NAME || '').trim();
    const accountName = String(process.env.BANK_TRANSFER_ACCOUNT_NAME || '').trim();
    const accountNumber = String(process.env.BANK_TRANSFER_ACCOUNT_NUMBER || '').trim();
    if (!bankName || !accountName || !/^\d{10}$/.test(accountNumber)) throw new HttpError(503, 'BANK_TRANSFER_NOT_CONFIGURED', 'Bank-transfer instructions are not configured yet. Please contact Vine support.');
    const now = new Date().toISOString();
    const { error: updatePaymentError } = await ordersDb.from('payments').update({ status: 'awaiting_transfer', updated_at: now }).eq('id', payment.id).neq('status','paid');
    const { error: updateOrderError } = await ordersDb.from('orders').update({ payment_status: 'pending_verification', updated_at: now }).eq('id', order.id).neq('payment_status','paid');
    if (updatePaymentError || updateOrderError) throw new HttpError(503, 'PAYMENT_UPDATE_FAILED', 'Bank-transfer instructions could not be prepared.');
    await addAudit({ actorId: req.user.id, actorType: 'customer', action: 'payment.bank_transfer_instructions_requested', entityType: 'order', entityId: order.id, requestId: req.id, metadata: { provider: 'bank_transfer' } });
    return res.json({ data: { method: 'bank_transfer', status: 'awaiting_transfer', orderId: order.id, orderNumber: order.order_number, amountKobo: Number(order.total_kobo), amountNgn: Number(order.total_kobo) / 100, reference: payment.reference, bank: { name: bankName, accountName, accountNumber }, notice: 'Transfer the exact amount and use the reference above. Vine will verify the transfer manually; do not upload or send card details.' } });
  }
  if (payment.provider !== 'paystack') throw new HttpError(501, 'PAYMENT_PROVIDER_NOT_READY', 'This payment provider is not enabled yet.');
  if (payment.authorization_url) return res.json({ data: { method: 'paystack', status: payment.status, authorizationUrl: payment.authorization_url, reference: payment.reference } });
  const callbackUrl = process.env.PAYSTACK_CALLBACK_URL;
  const requestBody = { email: order.email, amount: Number(payment.amount_kobo), reference: payment.reference, currency: 'NGN', metadata: { order_id: order.id, customer_id: order.customer_id } };
  if (callbackUrl) requestBody.callback_url = callbackUrl;
  const initialized = await paystackRequest('/transaction/initialize', { method: 'POST', body: JSON.stringify(requestBody) });
  if (!initialized.authorization_url || initialized.reference !== payment.reference) throw new HttpError(502, 'PAYSTACK_RESPONSE_INVALID', 'The payment provider returned an incomplete response.');
  const { error: saveError } = await ordersDb.from('payments').update({ authorization_url: initialized.authorization_url, status: 'pending', updated_at: new Date().toISOString() }).eq('id', payment.id);
  if (saveError) throw new HttpError(503, 'PAYMENT_SAVE_FAILED', 'Payment was started but its secure checkout link could not be saved. Contact Vine support before retrying.');
  await addAudit({ actorId: req.user.id, actorType: 'customer', action: 'payment.paystack_initialized', entityType: 'order', entityId: order.id, requestId: req.id, metadata: { provider: 'paystack' } });
  res.json({ data: { method: 'paystack', status: 'pending', authorizationUrl: initialized.authorization_url, reference: payment.reference } });
}));

app.post('/api/v1/admin/payments/:id/confirm-bank-transfer', auth, paymentAdmin, asyncRoute(async (req, res) => {
  const paymentId = uuidSchema.parse(req.params.id);
  const { note } = z.object({ note: optionalText(500) }).parse(req.body || {});
  const payment = await loadPaymentById(paymentId);
  if (payment.provider !== 'bank_transfer') throw new HttpError(409, 'NOT_BANK_TRANSFER', 'Only manual bank-transfer payments can be confirmed by this route.');
  if (payment.status === 'paid') return res.json({ data: { paymentId: payment.id, status: 'paid', alreadyConfirmed: true } });
  if (!['awaiting_transfer','pending_verification','pending'].includes(payment.status)) throw new HttpError(409, 'PAYMENT_NOT_CONFIRMABLE', 'This payment is not awaiting manual confirmation.');
  const order = await loadOrderForPayment(payment.order_id);
  if (Number(payment.amount_kobo) !== Number(order.total_kobo) || payment.currency !== 'NGN') throw new HttpError(409, 'PAYMENT_AMOUNT_MISMATCH', 'Payment and order totals do not match.');
  const inventoryResult = await productsDb.rpc('commit_vine_inventory', { p_order_id: order.id });
  if (inventoryResult.error) throw new HttpError(503, 'INVENTORY_COMMIT_FAILED', 'Stock allocation could not be completed.');
  if (!['committed','already_committed'].includes(inventoryResult.data)) {
    await markOrderPaymentReview(payment, order, 'inventory_reservation_missing_after_manual_transfer');
    throw new HttpError(409, 'INVENTORY_REVIEW_REQUIRED', 'The transfer needs reconciliation because stock reservation is no longer available. Do not confirm delivery until it is reviewed.');
  }
  const paidOrder = await updateOrderAndPaymentPaid(payment, order);
  await ordersDb.from('payment_events').insert({ provider: 'bank_transfer', event_key: `manual-confirm:${payment.id}`, payment_reference: payment.reference, event_type: 'manual.bank_transfer.confirmed', processing_status: 'processed', payload_digest: crypto.createHash('sha256').update(`${payment.id}:${order.id}`).digest('hex'), processed_at: new Date().toISOString() }).then(() => {}).catch(() => {});
  await addAudit({ actorId: req.user.id, actorType: 'admin', action: 'payment.bank_transfer_confirmed', entityType: 'order', entityId: order.id, requestId: req.id, metadata: { paymentId: payment.id, note: note || '' } });
  res.json({ data: { paymentId: payment.id, orderId: paidOrder.id, orderNumber: paidOrder.order_number, paymentStatus: 'paid' } });
}));

app.post('/api/v1/admin/deliveries', auth, deliveryAdmin, asyncRoute(async (req, res) => {
  const input = z.object({ orderId: uuidSchema, provider: optionalText(100), trackingCode: optionalText(120), estimatedDeliveryAt: z.string().datetime().optional(), note: optionalText(500) }).parse(req.body);
  const order = await loadOrderForPayment(input.orderId);
  if (order.payment_status !== 'paid' || !['paid','processing'].includes(order.status)) throw new HttpError(409, 'ORDER_NOT_READY_FOR_DELIVERY', 'Only paid orders can be prepared for delivery.');
  const { data: existing } = await operationsDb.from('deliveries').select('id,order_id,status').eq('order_id', order.id).maybeSingle();
  if (existing) throw new HttpError(409, 'DELIVERY_EXISTS', 'A delivery record already exists for this order.');
  const { data: delivery, error } = await operationsDb.from('deliveries').insert({ order_id: order.id, delivery_provider: input.provider || null, tracking_code: input.trackingCode || null, status: 'preparing', estimated_delivery_at: input.estimatedDeliveryAt || null, created_by: req.user.id, internal_notes: input.note || null }).select('id,order_id,delivery_provider,tracking_code,status,estimated_delivery_at,created_at').single();
  if (error) throw new HttpError(503, 'DELIVERY_CREATE_FAILED', 'The delivery record could not be created.');
  await operationsDb.from('delivery_events').insert({ delivery_id: delivery.id, status: 'preparing', note: input.note || 'Order accepted for fulfilment.', source: 'admin', actor_id: req.user.id });
  await ordersDb.from('orders').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', order.id).eq('status','paid');
  await addAudit({ actorId: req.user.id, actorType: 'admin', action: 'delivery.created', entityType: 'delivery', entityId: delivery.id, requestId: req.id, metadata: { orderId: order.id } });
  await enqueueOrderNotice({ ...order }, 'customer.order_processing');
  res.status(201).json({ data: delivery });
}));

app.patch('/api/v1/admin/deliveries/:id/status', auth, deliveryAdmin, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const input = z.object({ status: z.enum(['preparing','dispatched','in_transit','delivered','failed','returned','cancelled']), trackingCode: optionalText(120), note: optionalText(1000) }).parse(req.body);
  const { data: current, error: currentError } = await operationsDb.from('deliveries').select('id,order_id,status,tracking_code').eq('id', id).maybeSingle();
  if (currentError) throw new HttpError(503, 'DELIVERY_UNAVAILABLE', 'The delivery record could not be loaded.');
  if (!current) throw new HttpError(404, 'DELIVERY_NOT_FOUND', 'That delivery record was not found.');
  const allowed = {
    pending: ['preparing','cancelled'], preparing: ['dispatched','cancelled','failed'],
    dispatched: ['in_transit','delivered','failed','returned'], in_transit: ['delivered','failed','returned'],
    failed: ['preparing','cancelled'], returned: ['preparing','cancelled'], delivered: [], cancelled: []
  };
  if (input.status !== current.status && !allowed[current.status]?.includes(input.status)) throw new HttpError(409, 'INVALID_DELIVERY_TRANSITION', `Delivery cannot move from ${current.status} to ${input.status}.`);
  const now = new Date().toISOString();
  const patch = { status: input.status, updated_at: now };
  if (input.trackingCode !== undefined) patch.tracking_code = input.trackingCode || null;
  if (input.status === 'dispatched') patch.dispatched_at = now;
  if (input.status === 'delivered') patch.delivered_at = now;
  const { data: delivery, error } = await operationsDb.from('deliveries').update(patch).eq('id', id).select('id,order_id,delivery_provider,tracking_code,status,estimated_delivery_at,dispatched_at,delivered_at,updated_at').single();
  if (error) throw new HttpError(503, 'DELIVERY_UPDATE_FAILED', 'The delivery status could not be saved.');
  await operationsDb.from('delivery_events').insert({ delivery_id: id, status: input.status, note: input.note || null, source: 'admin', actor_id: req.user.id });
  if (input.status === 'delivered') await ordersDb.from('orders').update({ status: 'delivered', updated_at: now }).eq('id', current.order_id).eq('payment_status','paid');
  else if (['dispatched','in_transit'].includes(input.status)) await ordersDb.from('orders').update({ status: 'shipped', updated_at: now }).eq('id', current.order_id).eq('payment_status','paid').in('status',['paid','processing','shipped']);
  await addAudit({ actorId: req.user.id, actorType: 'admin', action: 'delivery.status_changed', entityType: 'delivery', entityId: id, requestId: req.id, metadata: { from: current.status, to: input.status } });
  res.json({ data: delivery });
}));

app.get('/api/v1/admin/analytics/daily-sales', auth, analyticsAdmin, asyncRoute(async (req, res) => {
  const days = clampInt(req.query.days, 30, 1, 365);
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0,10);
  const { data, error } = await operationsDb.from('daily_sales_summary').select('sales_date,paid_orders,gross_revenue_kobo,updated_at').gte('sales_date', since).order('sales_date', { ascending: true });
  if (error) throw new HttpError(503, 'ANALYTICS_UNAVAILABLE', 'Sales analytics could not be loaded.');
  const rows = (data || []).map(row => ({ ...row, paid_orders: Number(row.paid_orders), gross_revenue_kobo: Number(row.gross_revenue_kobo), gross_revenue_ngn: Number(row.gross_revenue_kobo) / 100 }));
  res.json({ data: { days, since, daily: rows, totals: { paidOrders: rows.reduce((n,r) => n + r.paid_orders,0), grossRevenueKobo: rows.reduce((n,r) => n + r.gross_revenue_kobo,0), grossRevenueNgn: rows.reduce((n,r) => n + r.gross_revenue_kobo,0) / 100 } } });
}));

app.get('/api/v1/admin/notifications', auth, notificationsView, asyncRoute(async (req, res) => {
  const limit = clampInt(req.query.limit, 50, 1, 100);
  const { data, error } = await operationsDb.from('notification_jobs').select('id,order_id,channel,template_key,status,attempts,available_at,last_error_code,created_at,updated_at').order('created_at', { ascending: false }).limit(limit);
  if (error) throw new HttpError(503, 'NOTIFICATIONS_UNAVAILABLE', 'Notification jobs could not be loaded.');
  res.json({ data: data || [], note: 'Queue visibility is implemented; an email/SMS delivery provider and worker still need to be configured.' });
}));

app.post('/api/v1/admin/notifications/:id/requeue', auth, notificationsManage, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const { data, error } = await operationsDb.from('notification_jobs').update({ status: 'pending', attempts: 0, available_at: new Date().toISOString(), last_error_code: null, updated_at: new Date().toISOString() }).eq('id', id).in('status',['failed','cancelled']).select('id,status,available_at').maybeSingle();
  if (error) throw new HttpError(503, 'NOTIFICATION_REQUEUE_FAILED', 'The notification could not be requeued.');
  if (!data) throw new HttpError(409, 'NOTIFICATION_NOT_REQUEUEABLE', 'Only failed or cancelled notifications can be requeued.');
  await addAudit({ actorId: req.user.id, actorType: 'admin', action: 'notification.requeued', entityType: 'notification_job', entityId: id, requestId: req.id });
  res.json({ data });
}));

finishApp(app);
const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', service: process.env.SERVICE_NAME, port })));
