import { HttpError } from './errors.js';

function normalizedRoleNames(rows) { return (rows || []).map(row => String(row.role || '').toLowerCase()); }

/** Resolve live worker access from database assignments. A membership row disables legacy role fallback. */
export async function resolveStaffAccess(accountsAdmin, user) {
  if (!accountsAdmin || !user?.id) throw new HttpError(503, 'STAFF_AUTH_UNAVAILABLE', 'Staff access could not be checked.');
  const { data: membership, error: membershipError } = await accountsAdmin
    .from('staff_memberships')
    .select('user_id,role_id,status,staff_roles(name,is_owner_role)')
    .eq('user_id', user.id)
    .maybeSingle();
  if (membershipError) throw new HttpError(503, 'STAFF_AUTH_UNAVAILABLE', 'Staff permissions could not be checked. Ensure the Vineowner migration is applied.');

  const configuredOwner = String(process.env.VINE_OWNER_EMAIL || 'donchester111@gmail.com').trim().toLowerCase();
  const email = String(user.email || '').trim().toLowerCase();
  if (membership) {
    if (membership.status !== 'active') throw new HttpError(403, 'STAFF_SUSPENDED', 'This staff account is suspended. Contact the Vine owner.');
    const roleData = Array.isArray(membership.staff_roles) ? membership.staff_roles[0] : membership.staff_roles;
    const isOwner = Boolean(roleData?.is_owner_role) && email === configuredOwner;
    if (roleData?.is_owner_role && !isOwner) throw new HttpError(403, 'OWNER_ACCOUNT_PROTECTED', 'The protected owner role cannot be used by this account.');

    const { data: grants, error: grantsError } = await accountsAdmin.from('staff_role_permissions').select('permission_id').eq('role_id', membership.role_id);
    if (grantsError) throw new HttpError(503, 'STAFF_AUTH_UNAVAILABLE', 'Role permissions could not be checked.');
    const roleIds = (grants || []).map(row => row.permission_id);
    const { data: rolePerms, error: rolePermsError } = roleIds.length
      ? await accountsAdmin.from('staff_permissions').select('id,permission_key').in('id', roleIds)
      : { data: [], error: null };
    if (rolePermsError) throw new HttpError(503, 'STAFF_AUTH_UNAVAILABLE', 'Role permissions could not be checked.');

    const { data: overrides, error: overridesError } = await accountsAdmin.from('staff_user_permissions').select('permission_id,effect').eq('user_id', user.id);
    if (overridesError) throw new HttpError(503, 'STAFF_AUTH_UNAVAILABLE', 'Individual permissions could not be checked.');
    const overrideIds = (overrides || []).map(row => row.permission_id);
    const { data: overridePerms, error: overridePermError } = overrideIds.length
      ? await accountsAdmin.from('staff_permissions').select('id,permission_key').in('id', overrideIds)
      : { data: [], error: null };
    if (overridePermError) throw new HttpError(503, 'STAFF_AUTH_UNAVAILABLE', 'Individual permissions could not be checked.');

    const keys = new Set((rolePerms || []).map(row => row.permission_key));
    const keyById = new Map((overridePerms || []).map(row => [row.id, row.permission_key]));
    for (const row of overrides || []) {
      const key = keyById.get(row.permission_id);
      if (!key) continue;
      if (row.effect === 'deny') keys.delete(key);
      else if (row.effect === 'allow') keys.add(key);
    }
    return { userId: user.id, email: user.email || '', fullName: user.user_metadata?.full_name || '', role: roleData?.name || 'Worker', status: membership.status, isOwner, permissions: isOwner ? ['*'] : [...keys], source: 'custom' };
  }

  // Temporary compatibility for staff created before configurable roles were introduced.
  const { data: legacyRoles, error: legacyError } = await accountsAdmin.from('admin_roles').select('role').eq('user_id', user.id);
  if (legacyError) throw new HttpError(503, 'STAFF_AUTH_UNAVAILABLE', 'Legacy staff access could not be checked.');
  const roles = normalizedRoleNames(legacyRoles);
  if (roles.includes('owner') && email !== configuredOwner) throw new HttpError(403, 'OWNER_ACCOUNT_PROTECTED', 'The protected owner role is restricted to the configured owner account.');
  const legacyMap = {
    owner: ['*'], admin: ['*'],
    catalog: ['products.view','products.manage','suppliers.view','suppliers.manage'],
    operations: ['orders.view','orders.manage','payments.view','payments.manage','deliveries.view','deliveries.manage','analytics.view','notifications.view','notifications.manage'],
    support: ['orders.view','deliveries.view','notifications.view']
  };
  const keys = new Set(roles.flatMap(role => legacyMap[role] || []));
  if (!keys.size) throw new HttpError(403, 'STAFF_ACCESS_REQUIRED', 'This account has no active Vine staff assignment. Ask the owner for access.');
  return { userId: user.id, email: user.email || '', fullName: user.user_metadata?.full_name || '', role: roles.join(', ') || 'Worker', status: 'active', isOwner: roles.includes('owner') && email === configuredOwner, permissions: roles.includes('owner') && email === configuredOwner ? ['*'] : [...keys], source: 'legacy' };
}

export function requirePermission(accountsAdmin, permissionKey, legacyRoles = []) {
  return async function authorizePermission(req, _res, next) {
    try {
      const access = await resolveStaffAccess(accountsAdmin, req.user);
      req.staffAccess = access;
      const manageImpliesView = permissionKey.endsWith('.view') && access.permissions.includes(permissionKey.replace(/\.view$/, '.manage'));
      if (access.permissions.includes('*') || access.permissions.includes(permissionKey) || manageImpliesView) return next();
      // Compatibility for legacy roles with endpoint-specific allowlists; custom membership never gets this bypass.
      if (access.source === 'legacy' && legacyRoles.length) {
        const { data, error } = await accountsAdmin.from('admin_roles').select('role').eq('user_id', req.user.id).in('role', legacyRoles);
        if (error) throw new HttpError(503, 'ADMIN_AUTH_UNAVAILABLE', 'Administrator authorization could not be checked.');
        if (data?.length) { req.adminRoles = data.map(row => row.role); return next(); }
      }
      throw new HttpError(403, 'PERMISSION_REQUIRED', `You do not have the ${permissionKey} permission.`);
    } catch (error) { next(error); }
  };
}
