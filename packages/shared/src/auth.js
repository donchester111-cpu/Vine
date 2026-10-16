import { HttpError } from './errors.js';

export function requireAuth(authClient) {
  return async function authenticate(req, _res, next) {
    try {
      const header = req.get('authorization') || '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in to continue.');
      const { data, error } = await authClient.auth.getUser(match[1]);
      if (error || !data?.user) throw new HttpError(401, 'INVALID_SESSION', 'Your session is invalid or expired. Please sign in again.');
      req.user = data.user;
      req.accessToken = match[1];
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRoles(accountsAdmin, allowedRoles = ['owner', 'admin']) {
  return async function authorize(req, _res, next) {
    try {
      if (!accountsAdmin) throw new HttpError(503, 'ADMIN_AUTH_UNAVAILABLE', 'Administrator authorization is not configured.');
      const { data, error } = await accountsAdmin.from('admin_roles')
        .select('role').eq('user_id', req.user?.id).in('role', allowedRoles);
      if (error) throw new HttpError(503, 'ADMIN_AUTH_UNAVAILABLE', 'Administrator authorization could not be checked.');
      if (!data?.length) throw new HttpError(403, 'ADMIN_REQUIRED', 'You do not have permission to perform this action.');
      req.adminRoles = data.map(row => row.role);
      next();
    } catch (error) { next(error); }
  };
}

export function isSupabaseError(result) {
  return Boolean(result?.error);
}
