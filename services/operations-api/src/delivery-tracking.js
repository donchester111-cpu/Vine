import { asyncRoute, HttpError } from '@vine/shared/errors';
import { uuidSchema } from '@vine/shared/validation';

const CUSTOMER_VISIBLE_DELIVERY_STATUSES = new Set([
  'pending', 'preparing', 'dispatched', 'in_transit', 'delivered',
  'failed', 'returned', 'cancelled'
]);

const TERMINAL_DELIVERY_STATUSES = new Set(['delivered', 'failed', 'returned', 'cancelled']);

function safeTimelineEvent(row) {
  // Internal staff notes and actor identifiers must never be returned to customers.
  if (!CUSTOMER_VISIBLE_DELIVERY_STATUSES.has(String(row.status || ''))) return null;
  return { status: row.status, at: row.created_at };
}

/**
 * Status-based customer order tracking for Vine.
 * No courier GPS, map, coordinates, or location permission is used by this module.
 * The order-owner check is performed in the database query before any delivery data
 * or courier contact information is returned.
 */
export function registerDeliveryTrackingRoutes({ app, auth, ordersDb, operationsDb }) {
  app.get('/api/v1/me/orders/:id/tracking', auth, asyncRoute(async (req, res) => {
    const orderId = uuidSchema.parse(req.params.id);
    const { data: order, error: orderError } = await ordersDb
      .from('orders')
      .select('id,order_number,customer_id,status,payment_status,created_at,paid_at,shipping_address')
      .eq('id', orderId)
      .eq('customer_id', req.user.id)
      .maybeSingle();

    if (orderError) throw new HttpError(503, 'ORDER_TRACKING_UNAVAILABLE', 'Order tracking is temporarily unavailable.');
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'That order was not found.');

    const { data: delivery, error: deliveryError } = await operationsDb
      .from('deliveries')
      .select('id,order_id,delivery_provider,tracking_code,status,estimated_delivery_at,dispatched_at,delivered_at,courier_name,courier_phone,created_at,updated_at')
      .eq('order_id', orderId)
      .maybeSingle();
    if (deliveryError) throw new HttpError(503, 'DELIVERY_TRACKING_UNAVAILABLE', 'Delivery progress is temporarily unavailable.');

    let timeline = [];
    if (delivery) {
      const { data: rows, error: eventsError } = await operationsDb
        .from('delivery_events')
        .select('status,created_at')
        .eq('delivery_id', delivery.id)
        .order('created_at', { ascending: true })
        .limit(100);
      if (eventsError) throw new HttpError(503, 'DELIVERY_TIMELINE_UNAVAILABLE', 'Delivery history is temporarily unavailable.');
      timeline = (rows || []).map(safeTimelineEvent).filter(Boolean);
    }

    const orderStatus = String(order.status || '').toLowerCase();
    const deliveryStatus = String(delivery?.status || '').toLowerCase();
    const status = deliveryStatus || orderStatus || 'pending_payment';
    // Once a delivery record exists, its saved fulfilment status is authoritative;
    // order status remains a fallback for older orders without a delivery record.
    const delivered = delivery ? deliveryStatus === 'delivered' : orderStatus === 'delivered';
    const terminal = TERMINAL_DELIVERY_STATUSES.has(deliveryStatus) || ['delivered', 'cancelled', 'refunded'].includes(orderStatus);
    const dispatched = delivery ? ['dispatched', 'in_transit'].includes(deliveryStatus) : ['shipped', 'delivered'].includes(orderStatus);
    const preparing = delivery ? ['preparing', 'dispatched', 'in_transit', 'delivered'].includes(deliveryStatus) : ['processing', 'shipped', 'delivered'].includes(orderStatus);
    const failed = ['failed', 'returned', 'cancelled'].includes(deliveryStatus) || ['cancelled', 'refunded'].includes(orderStatus);
    const paymentConfirmed = String(order.payment_status || '').toLowerCase() === 'paid';
    const allowCourierContact = paymentConfirmed && Boolean(delivery?.courier_phone) && dispatched && !terminal;
    const destinationAddress = order.shipping_address && typeof order.shipping_address === 'object'
      ? { city: order.shipping_address.city || null, state: order.shipping_address.state || null }
      : { city: null, state: null };

    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: {
      order: {
        id: order.id,
        orderNumber: order.order_number,
        status: order.status,
        paymentStatus: order.payment_status,
        createdAt: order.created_at,
        paidAt: order.paid_at,
        destination: destinationAddress
      },
      delivery: delivery ? {
        id: delivery.id,
        provider: delivery.delivery_provider,
        trackingCode: delivery.tracking_code,
        status: delivery.status,
        estimatedDeliveryAt: delivery.estimated_delivery_at,
        dispatchedAt: delivery.dispatched_at,
        deliveredAt: delivery.delivered_at,
        courier: delivery.courier_name ? {
          name: delivery.courier_name,
          phone: allowCourierContact ? delivery.courier_phone : null,
          contactAvailable: allowCourierContact
        } : null,
        timeline
      } : null,
      status: { current: status, paid: paymentConfirmed, preparing, dispatched, delivered, failed, terminal },
      refreshAfterSeconds: 15
    }});
  }));
}


/**
 * Allows authorised fulfilment staff to revise carrier, tracking, courier, and ETA
 * details after a delivery record exists. Detail edits are audited separately and
 * deliberately do not create fake delivery-status timeline events.
 */
export function registerAdminDeliveryDetailsRoute({ app, auth, deliveryAdmin, operationsDb, addAudit }) {
  app.patch('/api/v1/admin/deliveries/:id/details', auth, deliveryAdmin, asyncRoute(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

    function readText(key, maxLength) {
      if (body[key] === undefined) return undefined;
      if (body[key] === null) return null;
      if (typeof body[key] !== 'string') throw new HttpError(400, 'DELIVERY_DETAILS_INVALID', `The ${key} field must be text.`);
      const value = body[key].trim();
      if (value.length > maxLength) throw new HttpError(400, 'DELIVERY_DETAILS_INVALID', `The ${key} field is too long.`);
      return value;
    }

    const input = {
      provider: readText('provider', 100),
      trackingCode: readText('trackingCode', 120),
      courierName: readText('courierName', 120),
      courierPhone: readText('courierPhone', 30),
      estimatedDeliveryAt: body.estimatedDeliveryAt
    };

    if (input.estimatedDeliveryAt !== undefined && input.estimatedDeliveryAt !== null && input.estimatedDeliveryAt !== '') {
      if (typeof input.estimatedDeliveryAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.estimatedDeliveryAt) || !Number.isFinite(Date.parse(input.estimatedDeliveryAt))) {
        throw new HttpError(400, 'DELIVERY_ETA_INVALID', 'Enter a valid estimated delivery date and time.');
      }
    } else if (input.estimatedDeliveryAt === '') {
      input.estimatedDeliveryAt = null;
    }
    if (input.courierPhone && !/^[+0-9() .-]{7,30}$/.test(input.courierPhone)) {
      throw new HttpError(400, 'COURIER_PHONE_INVALID', 'Enter a valid courier contact number.');
    }
    if ([input.provider, input.trackingCode, input.courierName, input.courierPhone, input.estimatedDeliveryAt].every(value => value === undefined)) {
      throw new HttpError(400, 'DELIVERY_DETAILS_EMPTY', 'Provide at least one delivery detail to update.');
    }

    const { data: current, error: currentError } = await operationsDb.from('deliveries')
      .select('id,order_id,estimated_delivery_at')
      .eq('id', id)
      .maybeSingle();
    if (currentError) throw new HttpError(503, 'DELIVERY_LOOKUP_FAILED', 'The delivery record could not be loaded.');
    if (!current) throw new HttpError(404, 'DELIVERY_NOT_FOUND', 'That delivery record was not found.');

    if (input.estimatedDeliveryAt) {
      const nextMinutes = Math.floor(Date.parse(input.estimatedDeliveryAt) / 60000);
      const priorMinutes = current.estimated_delivery_at ? Math.floor(Date.parse(current.estimated_delivery_at) / 60000) : null;
      if (Date.parse(input.estimatedDeliveryAt) <= Date.now() && nextMinutes !== priorMinutes) {
        throw new HttpError(400, 'DELIVERY_ETA_INVALID', 'A new estimated delivery time must be in the future.');
      }
    }

    const patch = { updated_at: new Date().toISOString() };
    if (input.provider !== undefined) patch.delivery_provider = input.provider || null;
    if (input.trackingCode !== undefined) patch.tracking_code = input.trackingCode || null;
    if (input.courierName !== undefined) patch.courier_name = input.courierName || null;
    if (input.courierPhone !== undefined) patch.courier_phone = input.courierPhone || null;
    if (input.estimatedDeliveryAt !== undefined) patch.estimated_delivery_at = input.estimatedDeliveryAt || null;

    const { data: delivery, error } = await operationsDb.from('deliveries')
      .update(patch)
      .eq('id', id)
      .select('id,order_id,delivery_provider,tracking_code,courier_name,courier_phone,status,estimated_delivery_at,dispatched_at,delivered_at,updated_at')
      .single();
    if (error) throw new HttpError(503, 'DELIVERY_DETAILS_SAVE_FAILED', 'Delivery details could not be saved.');

    await addAudit({
      actorId: req.user.id,
      actorType: 'admin',
      action: 'delivery.details_updated',
      entityType: 'delivery',
      entityId: id,
      requestId: req.id,
      metadata: { orderId: current.order_id, fields: Object.keys(patch).filter(key => key !== 'updated_at') }
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: delivery });
  }));
}
