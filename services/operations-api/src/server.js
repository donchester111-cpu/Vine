import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { applySecurity, finishApp, sendHealth } from '@vine/shared/app';
import { createAuthContext, createSupabaseClient } from '@vine/shared/db';
import { requireAuth } from '@vine/shared/auth';
import { requirePermission, resolveStaffAccess } from '@vine/shared/rbac';
import { registerAdminDeliveryDetailsRoute, registerDeliveryTrackingRoutes } from './delivery-tracking.js';
import { asyncRoute, HttpError } from '@vine/shared/errors';
import { escapeVineHtml, isVineEmailConfigured, sendVineEmail } from '@vine/shared/email';
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
const integrationsView = requirePermission(accountsAdmin, 'integrations.view', ['owner', 'admin', 'operations']);

// Assigned delivery workers may view and update only the deliveries that belong to them.
// Staff with the regular delivery permissions and the owner retain their existing wider scope.
async function assignedDeliveryView(req, _res, next) {
  try {
    await reconcileInactiveStaffAssignments();
    const access = await resolveStaffAccess(accountsAdmin, req.user);
    req.staffAccess = access;
    req.deliveryAssignedOnly = !access.permissions.some(key => key === '*' || key === 'deliveries.view' || key === 'deliveries.manage');
    next();
  } catch (error) { next(error); }
}

async function assignedDeliveryManage(req, _res, next) {
  try {
    await reconcileInactiveStaffAssignments();
    const access = await resolveStaffAccess(accountsAdmin, req.user);
    req.staffAccess = access;
    if (access.permissions.includes('*') || access.permissions.includes('deliveries.manage')) return next();
    const id = uuidSchema.parse(req.params.id);
    const { data: delivery, error } = await operationsDb.from('deliveries')
      .select('id,assigned_staff_id').eq('id', id).maybeSingle();
    if (error) throw new HttpError(503, 'DELIVERY_AUTH_CHECK_FAILED', 'The delivery assignment could not be checked.');
    if (!delivery) throw new HttpError(404, 'DELIVERY_NOT_FOUND', 'That delivery record was not found.');
    if (delivery.assigned_staff_id !== req.user.id) throw new HttpError(403, 'DELIVERY_ASSIGNMENT_REQUIRED', 'Only the assigned Vine staff member or an authorised delivery manager can update this delivery.');
    req.deliveryAssignedOnly = true;
    next();
  } catch (error) { next(error); }
}

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
  const { data: emailSettingsRow, error: emailSettingsError } = await accountsAdmin.from('vineowner_settings')
    .select('setting_value').eq('setting_key', 'notifications').maybeSingle();
  if (emailSettingsError) {
    console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'owner_notification_setting_unavailable', code: emailSettingsError.code || 'DB_ERROR' }));
  } else if (emailSettingsRow?.setting_value?.orderEmailsEnabled === false) {
    return; // Owner has explicitly disabled transactional order email notifications.
  }
  const dedupeKey = `order:${order.id}:${statusKey}:email`;
  const { error } = await operationsDb.from('notification_jobs').upsert({
    dedupe_key: dedupeKey, order_id: order.id, channel: 'email',
    template_key: statusKey, recipient_ref: order.email,
    payload: { orderNumber: order.order_number, status: statusKey }, status: 'pending', available_at: new Date().toISOString()
  }, { onConflict: 'dedupe_key', ignoreDuplicates: true });
  if (error) console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, message: 'Notification job could not be queued', code: error.code }));
}

function safeNotificationErrorCode(error) {
  const raw = String(error?.code || error?.name || 'NOTIFICATION_DELIVERY_FAILED').toUpperCase();
  return raw.replace(/[^A-Z0-9_]/g, '_').slice(0, 80) || 'NOTIFICATION_DELIVERY_FAILED';
}

async function deliverNotificationJob(job) {
  const currentAttempt = Number(job.attempts || 0) + 1;
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await operationsDb.from('notification_jobs')
    .update({ status: 'processing', attempts: currentAttempt, updated_at: now })
    .eq('id', job.id).eq('status', 'pending')
    .select('id,order_id,channel,template_key,recipient_ref,payload,attempts')
    .maybeSingle();
  if (claimError) {
    console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'notification_claim_failed', jobId: job.id, code: claimError.code || 'DB_ERROR' }));
    return;
  }
  if (!claimed) return; // Another worker already claimed this job.

  try {
    if (claimed.channel !== 'email') throw new HttpError(422, 'NOTIFICATION_CHANNEL_NOT_CONFIGURED', 'Only email delivery is configured for this notification worker.');
    const recipient = String(claimed.recipient_ref || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(recipient)) throw new HttpError(422, 'NOTIFICATION_RECIPIENT_INVALID', 'The saved message recipient is not a valid email address.');
    const { data: order, error: orderError } = await ordersDb.from('orders')
      .select('id,order_number,status,payment_status,total_kobo,currency,email')
      .eq('id', claimed.order_id).maybeSingle();
    if (orderError) throw new HttpError(503, 'NOTIFICATION_ORDER_LOOKUP_FAILED', 'The order details needed for this message could not be loaded.');
    if (!order) throw new HttpError(404, 'NOTIFICATION_ORDER_NOT_FOUND', 'The order linked to this message no longer exists.');

    let subject;
    let heading;
    let message;
    if (claimed.template_key === 'customer.order_paid') {
      if (order.payment_status !== 'paid') throw new HttpError(409, 'ORDER_NOT_CONFIRMED_PAID', 'The order is not confirmed as paid.');
      subject = `Payment confirmed for Vine order ${order.order_number}`;
      heading = 'Your payment is confirmed';
      message = `Payment for order ${order.order_number} has been confirmed. Vine will keep you updated as your order moves through fulfilment.`;
    } else if (claimed.template_key === 'customer.order_processing') {
      if (order.payment_status !== 'paid' || !['processing','shipped','delivered'].includes(order.status)) throw new HttpError(409, 'ORDER_NOT_READY_FOR_FULFILMENT_NOTICE', 'The order is not in a paid fulfilment status.');
      subject = `Vine order ${order.order_number} is being prepared`;
      heading = 'Your order is being prepared';
      message = `Order ${order.order_number} is being prepared for delivery. We will share further updates as its delivery progresses.`;
    } else {
      throw new HttpError(422, 'NOTIFICATION_TEMPLATE_NOT_CONFIGURED', 'This message template is not configured for delivery.');
    }

    await sendVineEmail({
      to: recipient,
      subject,
      text: `${message}\n\nThank you for shopping with Vine.\nhttps://vinestore.com.ng`,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#173b28;max-width:560px;margin:0 auto"><h2 style="color:#087f45">${escapeVineHtml(heading)}</h2><p>${escapeVineHtml(message)}</p><p><a href="https://vinestore.com.ng" style="color:#087f45;font-weight:700">Open Vine</a></p><p style="font-size:12px;color:#64756a">This is an order update from Vine.</p></div>`,
      idempotencyKey: `vine-notification:${claimed.id}`
    });
    const sentAt = new Date().toISOString();
    const { error: sentError } = await operationsDb.from('notification_jobs')
      .update({ status: 'sent', sent_at: sentAt, last_error_code: null, updated_at: sentAt })
      .eq('id', claimed.id).eq('status', 'processing');
    if (sentError) throw new HttpError(503, 'NOTIFICATION_STATUS_SAVE_FAILED', 'The email provider accepted the message, but Vine could not record its delivered status.');
    await addAudit({ action: 'notification.sent', entityType: 'notification_job', entityId: claimed.id, metadata: { templateKey: claimed.template_key, provider: 'resend' } });
  } catch (error) {
    const errorCode = safeNotificationErrorCode(error);
    const failedAt = new Date().toISOString();
    const { error: failSaveError } = await operationsDb.from('notification_jobs')
      .update({ status: 'failed', last_error_code: errorCode, updated_at: failedAt })
      .eq('id', claimed.id).eq('status', 'processing');
    console.warn(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'notification_delivery_failed', jobId: claimed.id, code: errorCode, statusSaveFailed: Boolean(failSaveError) }));
  }
}

let notificationWorkerRunning = false;
async function processNotificationQueue() {
  if (!isVineEmailConfigured() || notificationWorkerRunning) return;
  notificationWorkerRunning = true;
  try {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    const nowIso = now.toISOString();
    const { error: recoveryError } = await operationsDb.from('notification_jobs')
      .update({ status: 'pending', available_at: nowIso, last_error_code: 'WORKER_RESTART_RECOVERY', updated_at: nowIso })
      .eq('status', 'processing').lt('updated_at', staleBefore);
    if (recoveryError) console.warn(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'notification_recovery_failed', code: recoveryError.code || 'DB_ERROR' }));

    const { data: jobs, error } = await operationsDb.from('notification_jobs')
      .select('id,order_id,channel,template_key,recipient_ref,payload,attempts,available_at')
      .eq('status', 'pending').lte('available_at', nowIso).order('available_at', { ascending: true }).limit(10);
    if (error) throw new HttpError(503, 'NOTIFICATION_QUEUE_READ_FAILED', 'The notification queue could not be read.');
    for (const job of jobs || []) await deliverNotificationJob(job);
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'notification_worker_failed', code: safeNotificationErrorCode(error) }));
  } finally {
    notificationWorkerRunning = false;
  }
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

async function loadAssignmentRoster() {
  const { data: memberships, error } = await accountsAdmin.from('staff_memberships')
    .select('user_id,role_id,status,staff_roles(name,is_owner_role)')
    .eq('status', 'active');
  if (error) throw new HttpError(503, 'FULFILMENT_STAFF_UNAVAILABLE', 'Vine could not check staff availability. Order assignment will be retried.');
  const active = (memberships || []).filter(member => member.user_id);
  const staff = active.filter(member => {
    const role = Array.isArray(member.staff_roles) ? member.staff_roles[0] : member.staff_roles;
    return !role?.is_owner_role && String(role?.name || '').trim().toLowerCase() !== 'owner';
  });
  const ownerMembers = active.filter(member => {
    const role = Array.isArray(member.staff_roles) ? member.staff_roles[0] : member.staff_roles;
    return Boolean(role?.is_owner_role) || String(role?.name || '').trim().toLowerCase() === 'owner';
  });
  const configuredOwnerId = String(process.env.VINE_OWNER_USER_ID || '').trim();
  const owner = ownerMembers.find(member => member.user_id === configuredOwnerId) || ownerMembers[0] || null;
  // The configured owner ID is a last-resort fallback only; validate it against Auth before use.
  if (!owner && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configuredOwnerId)) {
    const { data: ownerUser, error: ownerLookupError } = await accountsAdmin.auth.admin.getUserById(configuredOwnerId);
    if (!ownerLookupError && ownerUser?.user?.id) ownerMembers.push({ user_id: ownerUser.user.id, role_id: null, status: 'configured-owner-fallback' });
  }
  const fallbackOwner = owner || ownerMembers[0] || null;
  return { staff, owner: fallbackOwner };
}

async function chooseRandomActiveFulfilmentStaff(excludeUserIds = []) {
  const roster = await loadAssignmentRoster();
  const excluded = new Set(excludeUserIds);
  const candidates = roster.staff.filter(member => !excluded.has(member.user_id));
  if (candidates.length) return { ...candidates[crypto.randomInt(0, candidates.length)], assignmentFallback: false };
  if (roster.owner?.user_id) return { ...roster.owner, assignmentFallback: true };
  throw new HttpError(503, 'FULFILMENT_STAFF_UNAVAILABLE', 'No active fulfilment team members are available. Vine could not verify the owner fallback, so this order remains safely queued for assignment.');
}

const NON_TERMINAL_ASSIGNMENT_STATUSES = ['pending', 'preparing', 'dispatched', 'in_transit', 'failed', 'returned'];

async function reassignStaffDeliveries(staffUserId, actorId = null) {
  const roster = await loadAssignmentRoster();
  const ownerId = roster.owner?.user_id || null;
  if (!roster.staff.length && !ownerId) {
    throw new HttpError(503, 'DELIVERY_OWNER_FALLBACK_UNAVAILABLE', 'No active fulfilment staff or verified owner account is available. Order responsibility could not be safely transferred.');
  }
  let reassigned = 0;
  let assignedToOwner = 0;
  let skipped = 0;
  // Repeatedly read the first page because each successful transfer removes that row
  // from the suspended worker's queue. This avoids offset skips when queues are large.
  for (let batch = 0; batch < 100; batch += 1) {
    const { data: deliveries, error } = await operationsDb.from('deliveries')
      .select('id,order_id,status,assigned_staff_id,internal_notes')
      .eq('assigned_staff_id', staffUserId)
      .in('status', NON_TERMINAL_ASSIGNMENT_STATUSES)
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) throw new HttpError(503, 'DELIVERY_REASSIGN_LOOKUP_FAILED', 'Vine could not load the suspended worker’s delivery queue. Please retry the transfer.');
    if (!deliveries?.length) break;
    let changedInBatch = 0;
    for (const delivery of deliveries) {
      const candidates = roster.staff.filter(member => member.user_id !== staffUserId);
      const target = candidates.length
        ? candidates[crypto.randomInt(0, candidates.length)]
        : (ownerId ? { user_id: ownerId } : null);
      if (!target?.user_id) { skipped += 1; continue; }
      const now = new Date().toISOString();
      const nextNote = [delivery.internal_notes, `Responsibility reassigned on ${now} because the previous staff assignment is no longer active.`]
        .filter(Boolean).join('\n').slice(-5000);
      const { data: updated, error: updateError } = await operationsDb.from('deliveries')
        .update({ assigned_staff_id: target.user_id, assigned_at: now, updated_at: now, internal_notes: nextNote })
        .eq('id', delivery.id).eq('assigned_staff_id', staffUserId)
        .select('id,order_id,status,assigned_staff_id').maybeSingle();
      if (updateError) throw new HttpError(503, 'DELIVERY_REASSIGN_SAVE_FAILED', 'Vine could not finish transferring a delivery. Refresh the workspace and retry.');
      if (!updated) { skipped += 1; continue; }
      const recipientLabel = target.user_id === ownerId && !candidates.length ? 'the Vine owner' : 'another available Vine team member';
      const { error: eventError } = await operationsDb.from('delivery_events').insert({
        delivery_id: updated.id,
        status: updated.status,
        note: `Vine transferred order responsibility to ${recipientLabel} to keep delivery updates moving.`,
        source: 'system',
        actor_id: null
      });
      if (eventError) {
        console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'delivery_reassignment_timeline_failed', deliveryId: updated.id, code: eventError.code || 'DB_ERROR' }));
      }
      try {
        await addAudit({ actorId, actorType: actorId ? 'admin' : 'system', action: 'delivery.assignment_transferred', entityType: 'delivery', entityId: updated.id, metadata: { previousStaffId: staffUserId, nextStaffId: target.user_id, fallbackOwner: target.user_id === ownerId && !candidates.length, reason: 'staff_unavailable' } });
      } catch (auditError) {
        console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'delivery_reassignment_audit_failed', deliveryId: updated.id, code: auditError?.code || 'AUDIT_WRITE_FAILED' }));
      }
      reassigned += 1;
      if (target.user_id === ownerId && !candidates.length) assignedToOwner += 1;
      changedInBatch += 1;
    }
    if (changedInBatch === 0) break;
  }
  return { reassigned, assignedToOwner, skipped };
}

let assignmentReconcileInProgress = null;
async function reconcileInactiveStaffAssignments() {
  if (assignmentReconcileInProgress) return assignmentReconcileInProgress;
  assignmentReconcileInProgress = (async () => {
    const roster = await loadAssignmentRoster();
    const activeIds = new Set([...roster.staff, ...(roster.owner ? [roster.owner] : [])].map(member => member.user_id));
    const inactiveIds = new Set();
    // Narrow the scan in Postgres to assignments whose staff IDs are not active. This
    // avoids rereading every healthy delivery as the marketplace grows. Sort by the
    // immutable delivery ID so paginated scans remain stable while assignments change.
    const activeIdList = [...activeIds].filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
    for (let from = 0; from < 1_000_000; from += 1000) {
      let query = operationsDb.from('deliveries')
        .select('id,assigned_staff_id,status')
        .not('assigned_staff_id', 'is', null)
        .in('status', NON_TERMINAL_ASSIGNMENT_STATUSES);
      if (activeIdList.length) query = query.not('assigned_staff_id', 'in', `(${activeIdList.join(',')})`);
      const { data, error } = await query.order('id', { ascending: true }).range(from, from + 999);
      if (error) throw new HttpError(503, 'DELIVERY_REASSIGN_SCAN_FAILED', 'Vine could not verify delivery ownership. Retry the delivery workspace.');
      for (const delivery of data || []) if (delivery.assigned_staff_id && !activeIds.has(delivery.assigned_staff_id)) inactiveIds.add(delivery.assigned_staff_id);
      if (!data || data.length < 1000) break;
    }
    const results = [];
    for (const userId of inactiveIds) results.push({ userId, ...(await reassignStaffDeliveries(userId)) });
    return results;
  })().finally(() => { assignmentReconcileInProgress = null; });
  return assignmentReconcileInProgress;
}

async function ensurePaidOrderDeliveryAssignment(order) {
  if (!order?.id || String(order.payment_status || '').toLowerCase() !== 'paid') return null;
  if (['delivered', 'cancelled', 'refunded'].includes(String(order.status || '').toLowerCase())) return null;

  const { data: existing, error: existingError } = await operationsDb.from('deliveries')
    .select('id,order_id,assigned_staff_id,status,created_at')
    .eq('order_id', order.id).maybeSingle();
  if (existingError) throw new HttpError(503, 'DELIVERY_ASSIGNMENT_LOOKUP_FAILED', 'Vine could not check the existing delivery assignment. Payment is recorded and assignment will be retried.');

  let delivery = existing;
  let created = false;
  if (!delivery || !delivery.assigned_staff_id) {
    const selectedStaff = await chooseRandomActiveFulfilmentStaff();
    const now = new Date().toISOString();
    if (!delivery) {
      const { data: inserted, error: insertError } = await operationsDb.from('deliveries').insert({
        order_id: order.id,
        status: 'preparing',
        assigned_staff_id: selectedStaff.user_id,
        assigned_at: now,
        created_by: null,
        internal_notes: 'Automatically assigned after verified payment.'
      }).select('id,order_id,assigned_staff_id,status,created_at').maybeSingle();
      if (insertError) {
        // A concurrent webhook may have inserted the unique order delivery first.
        if (insertError.code !== '23505') throw new HttpError(503, 'DELIVERY_ASSIGNMENT_CREATE_FAILED', 'Payment is verified, but Vine could not create the delivery record. Assignment will be retried.');
        const { data: raced, error: raceError } = await operationsDb.from('deliveries')
          .select('id,order_id,assigned_staff_id,status,created_at').eq('order_id', order.id).maybeSingle();
        if (raceError || !raced) throw new HttpError(503, 'DELIVERY_ASSIGNMENT_CREATE_FAILED', 'The delivery assignment needs reconciliation and will be retried.');
        delivery = raced;
      } else {
        delivery = inserted;
        created = true;
      }
    }

    if (delivery && !delivery.assigned_staff_id) {
      const { data: assigned, error: assignError } = await operationsDb.from('deliveries')
        .update({ assigned_staff_id: selectedStaff.user_id, assigned_at: now, updated_at: now })
        .eq('id', delivery.id).is('assigned_staff_id', null)
        .select('id,order_id,assigned_staff_id,status,created_at').maybeSingle();
      if (assignError) throw new HttpError(503, 'DELIVERY_ASSIGNMENT_SAVE_FAILED', 'The delivery exists, but Vine could not save its staff assignment. Assignment will be retried.');
      if (assigned) delivery = assigned;
      else {
        const { data: latest, error: latestError } = await operationsDb.from('deliveries')
          .select('id,order_id,assigned_staff_id,status,created_at').eq('id', delivery.id).maybeSingle();
        if (latestError || !latest?.assigned_staff_id) throw new HttpError(503, 'DELIVERY_ASSIGNMENT_SAVE_FAILED', 'The delivery assignment needs reconciliation and will be retried.');
        delivery = latest;
      }
    }
  }

  if (!delivery?.assigned_staff_id) throw new HttpError(503, 'DELIVERY_ASSIGNMENT_SAVE_FAILED', 'This paid order has no staff owner yet. Assignment will be retried.');

  if (delivery.status === 'pending') {
    const { data: preparingDelivery, error: preparingError } = await operationsDb.from('deliveries')
      .update({ status: 'preparing', updated_at: new Date().toISOString() })
      .eq('id', delivery.id).eq('status', 'pending')
      .select('id,order_id,assigned_staff_id,status,created_at').maybeSingle();
    if (preparingError) throw new HttpError(503, 'DELIVERY_STATUS_RECONCILE_FAILED', 'The paid order is assigned, but its fulfilment status needs reconciliation.');
    if (preparingDelivery) delivery = preparingDelivery;
    else {
      const { data: latest, error: latestError } = await operationsDb.from('deliveries')
        .select('id,order_id,assigned_staff_id,status,created_at').eq('id', delivery.id).maybeSingle();
      if (latestError || !latest) throw new HttpError(503, 'DELIVERY_STATUS_RECONCILE_FAILED', 'The delivery status could not be confirmed.');
      delivery = latest;
    }
  }
  if (['delivered', 'failed', 'returned', 'cancelled'].includes(String(delivery.status || '').toLowerCase())) return delivery;

  // Backfill the initial customer-visible milestone on retries as well as first creation.
  // A failed event write must not leave a paid order permanently without a tracking timeline.
  const { data: initialEvent, error: initialEventLookupError } = await operationsDb.from('delivery_events')
    .select('id').eq('delivery_id', delivery.id).eq('status', 'preparing').limit(1).maybeSingle();
  if (initialEventLookupError) throw new HttpError(503, 'DELIVERY_TIMELINE_LOOKUP_FAILED', 'The delivery is assigned, but its tracking history needs reconciliation.');
  if (!initialEvent) {
    const { error: eventError } = await operationsDb.from('delivery_events').insert({
      delivery_id: delivery.id, status: 'preparing', note: 'Payment verified. Your order has entered Vine fulfilment.', source: 'system', actor_id: null
    });
    if (eventError) throw new HttpError(503, 'DELIVERY_TIMELINE_CREATE_FAILED', 'The delivery is assigned, but its first tracking update needs reconciliation.');
  }
  if (created) {
    await addAudit({ action: 'delivery.auto_assigned', entityType: 'delivery', entityId: delivery.id, metadata: { orderId: order.id, assignedStaffId: delivery.assigned_staff_id, assignmentMethod: 'random_active_staff' } });
  }

  // Move the paid order into processing as its delivery record is created.
  if (String(order.status || '').toLowerCase() === 'paid') {
    const now = new Date().toISOString();
    const { error: orderStatusError } = await ordersDb.from('orders').update({ status: 'processing', updated_at: now })
      .eq('id', order.id).eq('payment_status', 'paid').eq('status', 'paid');
    if (orderStatusError) throw new HttpError(503, 'ORDER_FULFILMENT_STATUS_SAVE_FAILED', 'The delivery has been assigned, but the order status needs reconciliation.');
    await enqueueOrderNotice({ ...order, status: 'processing' }, 'customer.order_processing');
  }
  return delivery;
}

async function updateOrderAndPaymentPaid(payment, order, timestamp = new Date().toISOString()) {
  const { error: paymentError } = await ordersDb.from('payments').update({ status: 'paid', paid_at: timestamp, last_checked_at: timestamp, updated_at: timestamp }).eq('id', payment.id).neq('status', 'paid');
  if (paymentError) throw new HttpError(503, 'PAYMENT_UPDATE_FAILED', 'Payment status could not be saved. Provider confirmation will be retried.');
  const { data: updatedOrder, error: orderError } = await ordersDb.from('orders').update({ status: 'paid', payment_status: 'paid', paid_at: timestamp, updated_at: timestamp }).eq('id', order.id).neq('payment_status', 'paid').select('id,order_number,customer_id,email,status,payment_status,total_kobo,paid_at').maybeSingle();
  if (orderError) throw new HttpError(503, 'ORDER_UPDATE_FAILED', 'The payment is confirmed, but the order needs reconciliation.');
  const finalOrder = updatedOrder || { ...order, status: 'paid', payment_status: 'paid', paid_at: timestamp };
  const { error: ledgerError } = await operationsDb.rpc('record_vine_sale_once', { p_order_id: order.id, p_order_number: order.order_number, p_amount_kobo: Number(order.total_kobo), p_paid_at: timestamp });
  if (ledgerError) throw new HttpError(503, 'SALES_LEDGER_FAILED', 'The order is paid but sales analytics needs reconciliation. The event is safe to retry.');
  await ensurePaidOrderDeliveryAssignment(finalOrder);
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
    await ensurePaidOrderDeliveryAssignment(order);
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

  const { data: paymentSettingsRow, error: paymentSettingsError } = await accountsAdmin.from('vineowner_settings')
    .select('setting_value').eq('setting_key', 'payments').maybeSingle();
  if (paymentSettingsError) throw new HttpError(503, 'PAYMENT_SETTINGS_UNAVAILABLE', 'Payment settings could not be verified. Please contact Vine support.');
  const paymentSettings = paymentSettingsRow?.setting_value || {};
  if (payment.provider === 'paystack' && paymentSettings.paystackEnabled !== true) throw new HttpError(409, 'PAYMENT_METHOD_DISABLED', 'Paystack is currently disabled by the store owner.');
  if (payment.provider === 'bank_transfer' && paymentSettings.bankTransferEnabled !== true) throw new HttpError(409, 'PAYMENT_METHOD_DISABLED', 'Bank transfer is currently disabled by the store owner.');

  if (payment.provider === 'bank_transfer') {
    // Owner-entered receiving details are safe public instructions; Cloudflare Worker environment values take precedence.
    const bankName = String(process.env.BANK_TRANSFER_BANK_NAME || paymentSettings.bankName || '').trim();
    const accountName = String(process.env.BANK_TRANSFER_ACCOUNT_NAME || paymentSettings.accountName || '').trim();
    const accountNumber = String(process.env.BANK_TRANSFER_ACCOUNT_NUMBER || paymentSettings.accountNumber || '').trim();
    if (!bankName || !accountName || !/^\d{10}$/.test(accountNumber)) throw new HttpError(503, 'BANK_TRANSFER_NOT_CONFIGURED', 'Bank-transfer instructions are not configured yet. Please configure the public receiving account or contact Vine support.');
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

app.get('/api/v1/admin/integration-status', auth, integrationsView, asyncRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: {
    paystackConfigured: Boolean(String(process.env.PAYSTACK_SECRET_KEY || '').trim()),
    emailProviderConfigured: isVineEmailConfigured(),
    smsProviderConfigured: Boolean(String(process.env.SMS_PROVIDER || '').trim()),
    checkoutSafetyGate: String(process.env.CHECKOUT_ENABLED || '').toLowerCase() === 'true'
  } });
}));

app.get('/api/v1/admin/payments', auth, paymentAdmin, asyncRoute(async (req, res) => {
  const limit = clampInt(req.query.limit, 50, 1, 100);
  const { data: rows, error } = await ordersDb.from('payments')
    .select('id,order_id,provider,reference,amount_kobo,currency,status,paid_at,created_at,updated_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Payment records could not be loaded.');
  const orderIds = [...new Set((rows || []).map(row => row.order_id).filter(Boolean))];
  const { data: orderRows, error: orderError } = orderIds.length
    ? await ordersDb.from('orders').select('id,order_number,email,status,payment_status,total_kobo').in('id', orderIds)
    : { data: [], error: null };
  if (orderError) throw new HttpError(503, 'PAYMENT_ORDERS_UNAVAILABLE', 'Payment records loaded, but linked orders could not be loaded.');
  const orderMap = new Map((orderRows || []).map(order => [order.id, order]));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: (rows || []).map(row => ({ ...row, amount_kobo: Number(row.amount_kobo), order: orderMap.get(row.order_id) || null })) });
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


// Persisted delivery history is sourced from vine_operations and enriched from vine_orders_payments.
app.get('/api/v1/admin/deliveries', auth, assignedDeliveryView, asyncRoute(async (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 100);
  const status = String(req.query.status || '').trim().toLowerCase();
  const allowedStatuses = ['pending','preparing','dispatched','in_transit','delivered','failed','returned','cancelled'];
  if (status && !allowedStatuses.includes(status)) throw new HttpError(400, 'DELIVERY_STATUS_FILTER_INVALID', 'Choose a valid delivery status.');
  let query = operationsDb.from('deliveries')
    .select('id,order_id,delivery_provider,tracking_code,status,estimated_delivery_at,dispatched_at,delivered_at,created_by,created_at,updated_at,courier_name,courier_phone,internal_notes,assigned_staff_id,assigned_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);
  if (req.deliveryAssignedOnly) query = query.eq('assigned_staff_id', req.user.id);
  const { data: deliveries, error } = await query;
  if (error) throw new HttpError(503, 'DELIVERIES_UNAVAILABLE', 'Saved delivery records could not be loaded.');
  const rows = deliveries || [];
  if (!rows.length) return res.json({ data: [], total: 0, limit, status: status || 'all' });
  const orderIds = [...new Set(rows.map(row => row.order_id).filter(Boolean))];
  const { data: orderRows, error: ordersError } = await ordersDb.from('orders')
    .select('id,order_number,email,status,payment_status,total_kobo,currency,created_at')
    .in('id', orderIds);
  if (ordersError) throw new HttpError(503, 'DELIVERY_ORDERS_UNAVAILABLE', 'Delivery records loaded, but their linked order details could not be loaded.');
  const orderById = new Map((orderRows || []).map(order => [order.id, order]));
  const assignedIds = [...new Set(rows.map(row => row.assigned_staff_id).filter(Boolean))];
  let staffNameById = new Map();
  if (assignedIds.length) {
    const { data: staffProfiles, error: staffProfileError } = await accountsAdmin.from('profiles')
      .select('user_id,full_name').in('user_id', assignedIds);
    if (!staffProfileError) staffNameById = new Map((staffProfiles || []).map(row => [row.user_id, row.full_name]));
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    data: rows.map(delivery => ({
      ...delivery,
      assignedStaff: delivery.assigned_staff_id ? { id: delivery.assigned_staff_id, fullName: staffNameById.get(delivery.assigned_staff_id) || 'Assigned Vine staff' } : null,
      order: orderById.get(delivery.order_id) || null
    })),
    total: rows.length, limit, status: status || 'all'
  });
}));

app.post('/api/v1/admin/deliveries', auth, deliveryAdmin, asyncRoute(async (req, res) => {
  const input = z.object({ orderId: uuidSchema, provider: optionalText(100), trackingCode: optionalText(120), estimatedDeliveryAt: z.string().datetime().optional(), note: optionalText(500) }).parse(req.body);
  const order = await loadOrderForPayment(input.orderId);
  if (order.payment_status !== 'paid' || !['paid','processing'].includes(order.status)) throw new HttpError(409, 'ORDER_NOT_READY_FOR_DELIVERY', 'Only paid orders can be prepared for delivery.');
  const { data: existing, error: existingError } = await operationsDb.from('deliveries').select('id,order_id,status').eq('order_id', order.id).maybeSingle();
  if (existingError) throw new HttpError(503, 'DELIVERY_LOOKUP_FAILED', 'Existing delivery status could not be checked. Try again.');
  if (existing) throw new HttpError(409, 'DELIVERY_EXISTS', 'A delivery record already exists for this order.');
  const selectedStaff = await chooseRandomActiveFulfilmentStaff();
  const assignedAt = new Date().toISOString();
  const { data: delivery, error } = await operationsDb.from('deliveries').insert({ order_id: order.id, delivery_provider: input.provider || null, tracking_code: input.trackingCode || null, status: 'preparing', estimated_delivery_at: input.estimatedDeliveryAt || null, created_by: req.user.id, internal_notes: input.note || null, assigned_staff_id: selectedStaff.user_id, assigned_at: assignedAt }).select('id,order_id,delivery_provider,tracking_code,status,estimated_delivery_at,assigned_staff_id,assigned_at,created_at').single();
  if (error) throw new HttpError(503, 'DELIVERY_CREATE_FAILED', 'The delivery record could not be created.');
  const { error: eventError } = await operationsDb.from('delivery_events').insert({ delivery_id: delivery.id, status: 'preparing', note: input.note || 'Order accepted for fulfilment.', source: 'admin', actor_id: req.user.id });
  if (eventError) throw new HttpError(503, 'DELIVERY_EVENT_CREATE_FAILED', 'The delivery was created, but its activity history could not be recorded. Refresh before retrying.');
  const { error: orderStatusError } = await ordersDb.from('orders').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', order.id).eq('status','paid');
  if (orderStatusError) throw new HttpError(503, 'ORDER_FULFILMENT_UPDATE_FAILED', 'The delivery was created, but the order status needs reconciliation. Refresh the order before continuing.');
  await addAudit({ actorId: req.user.id, actorType: 'admin', action: 'delivery.created', entityType: 'delivery', entityId: delivery.id, requestId: req.id, metadata: { orderId: order.id } });
  await enqueueOrderNotice({ ...order }, 'customer.order_processing');
  res.status(201).json({ data: delivery });
}));

app.patch('/api/v1/admin/deliveries/:id/status', auth, assignedDeliveryManage, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const input = z.object({ status: z.enum(['preparing','dispatched','in_transit','delivered','failed','returned','cancelled']), trackingCode: optionalText(120), note: optionalText(1000) }).parse(req.body);
  const { data: current, error: currentError } = await operationsDb.from('deliveries').select('id,order_id,status,tracking_code,assigned_staff_id').eq('id', id).maybeSingle();
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
  const { error: eventError } = await operationsDb.from('delivery_events').insert({ delivery_id: id, status: input.status, note: input.note || null, source: 'admin', actor_id: req.user.id });
  if (eventError) throw new HttpError(503, 'DELIVERY_EVENT_WRITE_FAILED', 'The status was changed, but its activity history could not be recorded. Refresh before making another change.');
  let orderStatusResult = { error: null };
  if (input.status === 'delivered') orderStatusResult = await ordersDb.from('orders').update({ status: 'delivered', updated_at: now }).eq('id', current.order_id).eq('payment_status','paid');
  else if (['dispatched','in_transit'].includes(input.status)) orderStatusResult = await ordersDb.from('orders').update({ status: 'shipped', updated_at: now }).eq('id', current.order_id).eq('payment_status','paid').in('status',['paid','processing','shipped']);
  if (orderStatusResult.error) throw new HttpError(503, 'ORDER_STATUS_SYNC_FAILED', 'Delivery status was changed, but the order status needs reconciliation. Refresh before continuing.');
  await addAudit({ actorId: req.user.id, actorType: 'admin', action: 'delivery.status_changed', entityType: 'delivery', entityId: id, requestId: req.id, metadata: { from: current.status, to: input.status } });
  res.json({ data: delivery });
}));

app.post('/api/v1/admin/staff/:userId/reconcile-deliveries', auth, asyncRoute(async (req, res) => {
  const access = await resolveStaffAccess(accountsAdmin, req.user);
  if (!access.isOwner) throw new HttpError(403, 'OWNER_REQUIRED', 'Only the Vine owner can trigger a staff delivery handover.');
  const staffUserId = uuidSchema.parse(req.params.userId);
  const { data: membership, error: membershipError } = await accountsAdmin.from('staff_memberships')
    .select('user_id,status,staff_roles(name,is_owner_role)').eq('user_id', staffUserId).maybeSingle();
  if (membershipError) throw new HttpError(503, 'STAFF_STATUS_CHECK_FAILED', 'Vine could not verify the worker’s current access status.');
  if (!membership) throw new HttpError(404, 'STAFF_NOT_FOUND', 'That staff assignment could not be found.');
  if (membership.status !== 'suspended') throw new HttpError(409, 'STAFF_NOT_SUSPENDED', 'Delivery handover is only available after a staff account has been suspended.');
  const role = Array.isArray(membership.staff_roles) ? membership.staff_roles[0] : membership.staff_roles;
  if (role?.is_owner_role || String(role?.name || '').trim().toLowerCase() === 'owner') throw new HttpError(403, 'OWNER_HANDOVER_BLOCKED', 'The owner account cannot be handled as a staff suspension.');
  const result = await reassignStaffDeliveries(staffUserId, req.user.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: { staffUserId, ...result, destination: result.assignedToOwner ? 'owner' : 'available_staff' } });
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
  res.json({ data: data || [], delivery: { provider: isVineEmailConfigured() ? 'resend' : null, configured: isVineEmailConfigured(), workerEnabled: isVineEmailConfigured(), message: isVineEmailConfigured() ? 'Transactional email delivery is enabled. Sent and failed messages are recorded here.' : 'Transactional email delivery is disabled until RESEND_API_KEY and VINE_EMAIL_FROM are configured on this Operations service.' } });
}));

app.post('/api/v1/admin/notifications/:id/requeue', auth, notificationsManage, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const { data, error } = await operationsDb.from('notification_jobs').update({ status: 'pending', attempts: 0, available_at: new Date().toISOString(), last_error_code: null, updated_at: new Date().toISOString() }).eq('id', id).in('status',['failed','cancelled']).select('id,status,available_at').maybeSingle();
  if (error) throw new HttpError(503, 'NOTIFICATION_REQUEUE_FAILED', 'The notification could not be requeued.');
  if (!data) throw new HttpError(409, 'NOTIFICATION_NOT_REQUEUEABLE', 'Only failed or cancelled notifications can be requeued.');
  await addAudit({ actorId: req.user.id, actorType: 'admin', action: 'notification.requeued', entityType: 'notification_job', entityId: id, requestId: req.id });
  res.json({ data });
}));

registerDeliveryTrackingRoutes({ app, auth, ordersDb, operationsDb, productsDb });
registerAdminDeliveryDetailsRoute({ app, auth, deliveryAdmin: assignedDeliveryManage, operationsDb, addAudit });

// Reconcile recent paid orders after deployment/restart so existing successful orders also gain tracking.
async function reconcileRecentPaidOrderDeliveries() {
  const { data: paidOrders, error: paidOrdersError } = await ordersDb.from('orders')
    .select('id,order_number,status,payment_status,total_kobo,email')
    .eq('payment_status', 'paid').order('paid_at', { ascending: false }).limit(250);
  if (paidOrdersError) {
    console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'paid_order_delivery_reconciliation_failed', code: paidOrdersError.code || 'DB_ERROR' }));
    return;
  }
  const eligibleOrders = (paidOrders || []).filter(order => !['cancelled', 'refunded'].includes(String(order.status || '').toLowerCase()));
  if (!eligibleOrders.length) return;
  const orderIds = eligibleOrders.map(order => order.id);
  const { data: existingDeliveries, error: deliveriesError } = await operationsDb.from('deliveries')
    .select('order_id,assigned_staff_id,status').in('order_id', orderIds);
  if (deliveriesError) {
    console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'paid_order_delivery_reconciliation_failed', code: deliveriesError.code || 'DB_ERROR' }));
    return;
  }
  const deliveryByOrder = new Map((existingDeliveries || []).map(row => [row.order_id, row]));
  for (const order of eligibleOrders) {
    const delivery = deliveryByOrder.get(order.id);
    if (delivery?.assigned_staff_id) continue;
    if (String(order.status || '').toLowerCase() === 'delivered') continue;
    if (delivery && ['delivered', 'failed', 'returned', 'cancelled'].includes(String(delivery.status || '').toLowerCase())) continue;
    try { await ensurePaidOrderDeliveryAssignment(order); }
    catch (error) {
      console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'paid_order_delivery_assignment_retry_needed', orderId: order.id, code: error?.code || error?.name || 'ASSIGNMENT_FAILED' }));
    }
  }
}
// Cloudflare Workers are request-driven; scheduled reconciliation is invoked by the
// Operations Worker cron trigger instead of process-lifetime timers.
export async function runScheduledOperations() {
  await reconcileRecentPaidOrderDeliveries();
  try {
    await reconcileInactiveStaffAssignments();
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'inactive_staff_assignment_reconcile_failed', code: error?.code || error?.name || 'RECONCILE_FAILED' }));
  }
  if (isVineEmailConfigured()) await processNotificationQueue();
}

finishApp(app);
const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', service: process.env.SERVICE_NAME, port, emailDeliveryConfigured: isVineEmailConfigured(), notificationWorker: 'cloudflare-cron' }));
  if (!isVineEmailConfigured()) {
    console.warn(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME, event: 'notification_worker_not_started', code: 'EMAIL_PROVIDER_NOT_CONFIGURED' }));
  }
});
