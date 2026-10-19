import { z } from 'zod';
import { asyncRoute, HttpError } from '@vine/shared/errors';
import { resolveStaffAccess } from '@vine/shared/rbac';
import { assertVineEmailConfigured, escapeVineHtml, getVineEmailProvider, isVineEmailConfigured, sendVineEmail } from '@vine/shared/email';


async function findAuthUserByEmail(accountsAdmin, email) {
  const normalized = String(email || '').trim().toLowerCase();
  const pageSize = 1000;
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await accountsAdmin.auth.admin.listUsers({ page, perPage: pageSize });
    if (error) throw new HttpError(503, 'STAFF_DIRECTORY_UNAVAILABLE', 'Vine could not verify the staff directory. Please try again shortly.');
    const users = data?.users || [];
    const found = users.find(user => String(user.email || '').trim().toLowerCase() === normalized);
    if (found) return found;
    if (users.length < pageSize) return null;
  }
  throw new HttpError(503, 'STAFF_DIRECTORY_UNAVAILABLE', 'Vine could not verify the staff directory. Please try again shortly.');
}

export function registerOwnerAdmin(app, { accountsAdmin, auth }) {
  const ownerOnly = async (req, _res, next) => {
    try {
      if (req.authType === 'owner-server') {
        const configuredEmail = String(process.env.VINE_OWNER_EMAIL || 'donchester111@gmail.com').trim().toLowerCase();
        const configuredId = String(process.env.VINE_OWNER_USER_ID || '').trim().toLowerCase();
        if (String(req.user?.email || '').trim().toLowerCase() !== configuredEmail || String(req.user?.id || '').toLowerCase() !== configuredId || !configuredId) {
          throw new HttpError(403, 'OWNER_REQUIRED', 'Only the configured Vine owner can use this control centre.');
        }
        req.staffAccess = { userId: req.user.id, email: req.user.email, fullName: 'Vine Owner', role: 'Owner', status: 'active', isOwner: true, permissions: ['*'], source: 'server' };
        return next();
      }
      const access = await resolveStaffAccess(accountsAdmin, req.user);
      if (!access.isOwner) throw new HttpError(403, 'OWNER_REQUIRED', 'Only the configured Vine owner can use this control centre.');
      req.staffAccess = access;
      next();
    } catch (e) { next(e); }
  };
  const owner = [auth, ownerOnly];
  const audit = async (req, action, targetType='system', targetId=null, details={}) => {
    const { error } = await accountsAdmin.from('vineowner_audit_log').insert({actor_user_id:req.user.id,action,target_type:targetType,target_id:targetId,details});
    if (error) throw new HttpError(503,'AUDIT_WRITE_FAILED','The audit record could not be saved; the operation was stopped.');
  };

  app.get('/api/v1/staff/me', auth, asyncRoute(async (req, res) => {
    const access = await resolveStaffAccess(accountsAdmin, req.user);
    res.json({ data: access });
  }));

  app.get('/api/v1/owner/email-provider-status', ...owner, asyncRoute(async (_req, res) => {
    const configured = isVineEmailConfigured();
    const provider = getVineEmailProvider();
    const gmailSenderPresent = Boolean(String(process.env.GMAIL_SENDER_EMAIL || '').trim());
    res.json({ data: {
      provider,
      configured,
      senderAddressPresent: Boolean(String(process.env.VINE_EMAIL_FROM || process.env.GMAIL_SENDER_EMAIL || '').trim()),
      message: configured
        ? provider === 'google-gmail'
          ? `Gmail email delivery is configured for ${String(process.env.GMAIL_SENDER_EMAIL).trim()}. Send a real test message to verify delivery.`
          : 'Resend settings are present. Confirm the sender domain is verified and test a real delivery.'
        : gmailSenderPresent
          ? 'The Gmail sender address is set, but the OAuth client and refresh token must be connected in Render.'
          : 'Email sending is not configured. Connect Google Gmail OAuth or configure a verified Resend sender on the Accounts and Operations services.'
    } });
  }));

  app.get('/api/v1/owner/summary', ...owner, asyncRoute(async (req,res)=>{
    const [roles, staff, perms, recent] = await Promise.all([
      accountsAdmin.from('staff_roles').select('id,name,description,is_owner_role,created_at').order('name'),
      accountsAdmin.from('staff_memberships').select('user_id,role_id,status,created_at,updated_at'),
      accountsAdmin.from('staff_permissions').select('id,permission_key,description').order('permission_key'),
      accountsAdmin.from('vineowner_audit_log').select('id,actor_user_id,action,target_type,target_id,details,created_at').order('created_at',{ascending:false}).limit(20)
    ]);
    for (const x of [roles,staff,perms,recent]) if (x.error) throw new HttpError(503,'OWNER_DATA_UNAVAILABLE','Owner control-centre data could not be loaded. Apply migration 002_vineowner_rbac.sql first.');
    res.json({data:{roles:roles.data,staff:staff.data,permissions:perms.data,audit:recent.data}});
  }));

  app.post('/api/v1/owner/roles', ...owner, asyncRoute(async(req,res)=>{
    const input=z.object({name:z.string().trim().min(2).max(80),description:z.string().max(300).default('')}).parse(req.body);
    const {data,error}=await accountsAdmin.from('staff_roles').insert({...input,created_by:req.user.id}).select('id,name,description,is_owner_role,created_at').single();
    if(error) throw new HttpError(400,'ROLE_CREATE_FAILED','Role could not be created; ensure its name is unique.');
    await audit(req,'role.created','role',data.id,{name:data.name}); res.status(201).json({data});
  }));
  app.patch('/api/v1/owner/roles/:id', ...owner, asyncRoute(async(req,res)=>{
    const input=z.object({name:z.string().trim().min(2).max(80).optional(),description:z.string().max(300).optional()}).refine(v=>Object.keys(v).length>0).parse(req.body);
    const {data:before,error:readErr}=await accountsAdmin.from('staff_roles').select('id,is_owner_role').eq('id',req.params.id).maybeSingle();
    if(readErr||!before) throw new HttpError(404,'ROLE_NOT_FOUND','Role was not found.');
    if(before.is_owner_role) throw new HttpError(403,'OWNER_ROLE_LOCKED','The protected owner role cannot be renamed or edited.');
    const {data,error}=await accountsAdmin.from('staff_roles').update({...input,updated_at:new Date().toISOString()}).eq('id',req.params.id).select('id,name,description,is_owner_role').single();
    if(error) throw new HttpError(400,'ROLE_UPDATE_FAILED','Role could not be updated.');
    await audit(req,'role.updated','role',data.id,input);res.json({data});
  }));
  app.delete('/api/v1/owner/roles/:id', ...owner, asyncRoute(async(req,res)=>{
    const {data:role,error:readErr}=await accountsAdmin.from('staff_roles').select('id,name,is_owner_role').eq('id',req.params.id).maybeSingle();
    if(readErr||!role) throw new HttpError(404,'ROLE_NOT_FOUND','Role was not found.');
    if(role.is_owner_role) throw new HttpError(403,'OWNER_ROLE_LOCKED','The owner role cannot be deleted.');
    const {count,error:countErr}=await accountsAdmin.from('staff_memberships').select('user_id',{count:'exact',head:true}).eq('role_id',role.id);
    if(countErr) throw new HttpError(503,'ROLE_CHECK_FAILED','Role assignments could not be checked.');
    if(count) throw new HttpError(409,'ROLE_IN_USE','Reassign staff before deleting this role.');
    const {error}=await accountsAdmin.from('staff_roles').delete().eq('id',role.id);if(error) throw new HttpError(400,'ROLE_DELETE_FAILED','Role could not be deleted.');
    await audit(req,'role.deleted','role',role.id,{name:role.name});res.status(204).end();
  }));
  app.post('/api/v1/owner/permissions', ...owner, asyncRoute(async(req,res)=>{
    const input=z.object({permissionKey:z.string().trim().min(3).max(150).regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){1,3}$/),description:z.string().max(300).default('')}).parse(req.body);
    const {data,error}=await accountsAdmin.from('staff_permissions').insert({permission_key:input.permissionKey,description:input.description,created_by:req.user.id}).select('id,permission_key,description').single();
    if(error) throw new HttpError(400,'PERMISSION_CREATE_FAILED','Permission could not be created; the key may already exist.');
    await audit(req,'permission.created','permission',data.id,{permissionKey:data.permission_key});res.status(201).json({data});
  }));
  app.get('/api/v1/owner/roles/:id/permissions', ...owner, asyncRoute(async(req,res)=>{
    const {data:role,error:roleErr}=await accountsAdmin.from('staff_roles').select('id').eq('id',req.params.id).maybeSingle();
    if(roleErr||!role) throw new HttpError(404,'ROLE_NOT_FOUND','Role was not found.');
    const {data,error}=await accountsAdmin.from('staff_role_permissions').select('permission_id').eq('role_id',role.id);
    if(error) throw new HttpError(503,'ROLE_PERMISSION_READ_FAILED','Role permissions could not be loaded.');
    res.json({data:{roleId:role.id,permissionIds:(data||[]).map(x=>x.permission_id)}});
  }));
  app.put('/api/v1/owner/roles/:id/permissions', ...owner, asyncRoute(async(req,res)=>{
    const input=z.object({permissionIds:z.array(z.string().uuid()).max(500)}).parse(req.body);
    const {data:role,error:roleErr}=await accountsAdmin.from('staff_roles').select('id,is_owner_role').eq('id',req.params.id).maybeSingle();
    if(roleErr||!role) throw new HttpError(404,'ROLE_NOT_FOUND','Role was not found.');
    if(role.is_owner_role) throw new HttpError(403,'OWNER_ROLE_LOCKED','The owner role has full control and is not edited through worker permissions.');
    const {error:delErr}=await accountsAdmin.from('staff_role_permissions').delete().eq('role_id',role.id);if(delErr) throw new HttpError(503,'ROLE_PERMISSION_UPDATE_FAILED','Existing role permissions could not be replaced.');
    if(input.permissionIds.length){const rows=input.permissionIds.map(permission_id=>({role_id:role.id,permission_id}));const {error}=await accountsAdmin.from('staff_role_permissions').insert(rows);if(error) throw new HttpError(400,'ROLE_PERMISSION_UPDATE_FAILED','One or more selected permissions are invalid.');}
    await audit(req,'role.permissions.updated','role',role.id,{permissionIds:input.permissionIds});res.json({data:{roleId:role.id,permissionIds:input.permissionIds}});
  }));
  app.post('/api/v1/owner/staff/invite', ...owner, asyncRoute(async(req,res)=>{
    const input=z.object({email:z.string().trim().email().max(254),roleId:z.string().uuid(),fullName:z.string().trim().max(120).default('')}).parse(req.body);
    assertVineEmailConfigured();
    const email=input.email.trim().toLowerCase();
    const {data:role,error:roleErr}=await accountsAdmin.from('staff_roles').select('id,name,is_owner_role').eq('id',input.roleId).single();
    if(roleErr||!role||role.is_owner_role) throw new HttpError(400,'STAFF_ROLE_INVALID','Choose a valid non-owner worker role.');

    const existingUser=await findAuthUserByEmail(accountsAdmin,email);
    const redirectTo=String(process.env.VINE_STAFF_INVITE_REDIRECT_URL||'https://vinestore.com.ng/vineger.html').trim();
    let user=existingUser;
    let linkResult;
    if(existingUser){
      const nextMetadata={...(existingUser.user_metadata||{}),account_type:'vine_staff'};
      if(input.fullName) nextMetadata.full_name=input.fullName;
      const {data:updateData,error:updateError}=await accountsAdmin.auth.admin.updateUserById(existingUser.id,{user_metadata:nextMetadata});
      if(updateError||!updateData?.user) throw new HttpError(503,'STAFF_ACCOUNT_UPDATE_FAILED','The existing account could not be prepared for staff access.');
      user=updateData.user;
      const {data,error}=await accountsAdmin.auth.admin.generateLink({type:'magiclink',email,options:{redirectTo}});
      if(error||!data?.properties?.action_link) throw new HttpError(503,'STAFF_LINK_GENERATION_FAILED','A secure staff sign-in link could not be prepared.');
      linkResult=data;
    }else{
      const {data,error}=await accountsAdmin.auth.admin.generateLink({type:'invite',email,options:{data:{full_name:input.fullName,account_type:'vine_staff'},redirectTo}});
      if(error||!data?.user||!data?.properties?.action_link) throw new HttpError(400,'STAFF_INVITE_FAILED','Vine could not prepare this invitation. Check the address and try again.');
      user=data.user;
      linkResult=data;
    }

    const {error:membershipErr}=await accountsAdmin.from('staff_memberships').upsert({user_id:user.id,role_id:role.id,status:'active',assigned_by:req.user.id,updated_at:new Date().toISOString()},{onConflict:'user_id'});
    if(membershipErr) throw new HttpError(503,'STAFF_ASSIGN_FAILED','The account was prepared, but its staff role could not be saved. Refresh the staff list before retrying.');

    const actionLink=linkResult.properties.action_link;
    try {
      await sendVineEmail({
        to:email,
        subject:'You are invited to Vineger',
        text:`You have been invited to the Vine staff workspace as ${role.name}. Open this secure link to sign in: ${actionLink}\n\nIf you were not expecting this invitation, you can ignore this email.`,
        html:`<div style="font-family:Arial,sans-serif;line-height:1.6;color:#173b28;max-width:560px;margin:0 auto"><h2 style="color:#087f45">Welcome to Vineger</h2><p>You have been invited to the Vine staff workspace as <strong>${escapeVineHtml(role.name)}</strong>.</p><p><a href="${escapeVineHtml(actionLink)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#087f45;color:#fff;text-decoration:none;font-weight:700">Accept invitation and sign in</a></p><p style="font-size:12px;color:#64756a">This secure link is for the invited account. If you were not expecting this invitation, you can ignore this email.</p></div>`,
        idempotencyKey:`vineger-invite:${user.id}:${linkResult.properties?.email_otp||linkResult.properties?.hashed_token||Date.now()}`
      });
    } catch(error) {
      await audit(req,'staff.invitation_email_failed','staff',user.id,{email,role:role.name,code:error.code||'EMAIL_DELIVERY_FAILED'});
      throw error;
    }
    await audit(req,'staff.invited','staff',user.id,{email,role:role.name,delivery:'sent'});
    res.status(201).json({data:{userId:user.id,email,role:role.name,status:'invited',emailSent:true}});
  }));
  app.patch('/api/v1/owner/staff/:userId', ...owner, asyncRoute(async(req,res)=>{
    const input=z.object({roleId:z.string().uuid().optional(),status:z.enum(['active','suspended']).optional()}).refine(v=>Object.keys(v).length>0).parse(req.body);
    if(req.params.userId===req.user.id) throw new HttpError(403,'SELF_CHANGE_BLOCKED','You cannot change your own owner access from this screen.');
    const {data:existing,error:existingErr}=await accountsAdmin.from('staff_memberships').select('user_id,role_id,status').eq('user_id',req.params.userId).maybeSingle();
    if(existingErr||!existing) throw new HttpError(404,'STAFF_NOT_FOUND','Staff membership was not found.');
    if(input.roleId){const {data:r,error}=await accountsAdmin.from('staff_roles').select('id,is_owner_role').eq('id',input.roleId).maybeSingle();if(error||!r||r.is_owner_role)throw new HttpError(400,'STAFF_ROLE_INVALID','A worker cannot be assigned the protected owner role.');}
    const {data,error}=await accountsAdmin.from('staff_memberships').update({...input,updated_at:new Date().toISOString()}).eq('user_id',req.params.userId).select('user_id,role_id,status,updated_at').single();
    if(error) throw new HttpError(400,'STAFF_UPDATE_FAILED','Staff account could not be updated.');
    await audit(req,'staff.updated','staff',req.params.userId,input);res.json({data});
  }));
  app.get('/api/v1/owner/staff', ...owner, asyncRoute(async(req,res)=>{
    const {data,error}=await accountsAdmin.from('staff_memberships').select('user_id,role_id,status,created_at,updated_at,staff_roles(name)').order('created_at',{ascending:false});
    if(error) throw new HttpError(503,'STAFF_LIST_FAILED','Staff list could not be loaded.');
    const rows=await Promise.all((data||[]).map(async row=>{const {data:u}=await accountsAdmin.auth.admin.getUserById(row.user_id);return {...row,email:u?.user?.email||'',fullName:u?.user?.user_metadata?.full_name||''};}));res.json({data:rows});
  }));
  const settingKeys = new Set(['storefront','shipping','seo','policies']);
  const assertSafeSettings = (value) => {
    const visit = (node, path = '') => {
      if (!node || typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node)) {
        if (/(secret|password|service.?role|api.?key|private.?key|access.?token|refresh.?token)/i.test(key)) {
          throw new HttpError(400, 'SECRET_NOT_ALLOWED', `Secrets are not permitted in store settings (${path}${key}). Set secrets in the service environment instead.`);
        }
        visit(child, `${path}${key}.`);
      }
    };
    visit(value);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 24576) {
      throw new HttpError(413, 'SETTINGS_TOO_LARGE', 'A settings group must be 24 KB or smaller.');
    }
  };

  app.get('/api/v1/owner/settings', ...owner, asyncRoute(async (req, res) => {
    const { data, error } = await accountsAdmin.from('vineowner_settings')
      .select('setting_key,setting_value,updated_at').order('setting_key');
    if (error) throw new HttpError(503, 'SETTINGS_UNAVAILABLE', 'Owner settings could not be loaded. Apply the Vineowner settings migration.');
    const settings = Object.fromEntries((data || []).map(row => [row.setting_key, row.setting_value]));
    res.json({ data: { settings, updatedAt: Object.fromEntries((data || []).map(row => [row.setting_key, row.updated_at])) } });
  }));

  app.put('/api/v1/owner/settings/:key', ...owner, asyncRoute(async (req, res) => {
    const key = String(req.params.key || '');
    if (!settingKeys.has(key)) throw new HttpError(404, 'SETTING_GROUP_NOT_FOUND', 'That settings group is not supported.');
    const input = z.object({ value: z.record(z.string(), z.any()) }).strict().parse(req.body);
    assertSafeSettings(input.value);
    const { data, error } = await accountsAdmin.from('vineowner_settings').upsert({
      setting_key: key, setting_value: input.value, updated_by: req.user.id, updated_at: new Date().toISOString()
    }, { onConflict: 'setting_key' }).select('setting_key,setting_value,updated_at').single();
    if (error) throw new HttpError(503, 'SETTINGS_SAVE_FAILED', 'Settings could not be saved.');
    await audit(req, 'settings.updated', 'settings', key, { settingKey: key, fieldCount: Object.keys(input.value).length });
    res.json({ data: { key: data.setting_key, value: data.setting_value, updatedAt: data.updated_at } });
  }));

  app.get('/api/v1/owner/staff/:userId/permissions', ...owner, asyncRoute(async (req, res) => {
    const userId = z.string().uuid().parse(req.params.userId);
    const { data: member, error: memberError } = await accountsAdmin.from('staff_memberships')
      .select('user_id,staff_roles(is_owner_role)').eq('user_id', userId).maybeSingle();
    if (memberError) throw new HttpError(503, 'STAFF_LOOKUP_FAILED', 'Staff access could not be checked.');
    if (!member) throw new HttpError(404, 'STAFF_NOT_FOUND', 'Staff membership was not found.');
    const role = Array.isArray(member.staff_roles) ? member.staff_roles[0] : member.staff_roles;
    if (role?.is_owner_role) throw new HttpError(403, 'OWNER_ACCESS_LOCKED', 'Individual overrides cannot be edited for the protected owner role.');
    const { data: rows, error } = await accountsAdmin.from('staff_user_permissions')
      .select('permission_id,effect,assigned_by,created_at').eq('user_id', userId).order('created_at');
    if (error) throw new HttpError(503, 'STAFF_PERMISSION_READ_FAILED', 'Individual permission overrides could not be loaded.');
    const ids = (rows || []).map(row => row.permission_id);
    const { data: permissions, error: permissionError } = ids.length
      ? await accountsAdmin.from('staff_permissions').select('id,permission_key,description').in('id', ids)
      : { data: [], error: null };
    if (permissionError) throw new HttpError(503, 'STAFF_PERMISSION_READ_FAILED', 'Permission definitions could not be loaded.');
    const byId = new Map((permissions || []).map(row => [row.id, row]));
    res.json({ data: { userId, overrides: (rows || []).map(row => ({ ...row, permission_key: byId.get(row.permission_id)?.permission_key || row.permission_id, description: byId.get(row.permission_id)?.description || '' })) } });
  }));

  app.put('/api/v1/owner/staff/:userId/permissions', ...owner, asyncRoute(async (req, res) => {
    const userId = z.string().uuid().parse(req.params.userId);
    const input = z.object({ overrides: z.array(z.object({ permissionId: z.string().uuid(), effect: z.enum(['allow','deny']) }).strict()).max(500) }).strict().parse(req.body);
    if (userId === req.user.id) throw new HttpError(403, 'SELF_CHANGE_BLOCKED', 'You cannot set individual overrides for your own owner session.');
    if (new Set(input.overrides.map(row => row.permissionId)).size !== input.overrides.length) {
      throw new HttpError(400, 'DUPLICATE_PERMISSION', 'Each permission may only appear once in an override set.');
    }
    const { data: member, error: memberError } = await accountsAdmin.from('staff_memberships')
      .select('user_id,staff_roles(is_owner_role)').eq('user_id', userId).maybeSingle();
    if (memberError) throw new HttpError(503, 'STAFF_LOOKUP_FAILED', 'Staff access could not be checked.');
    if (!member) throw new HttpError(404, 'STAFF_NOT_FOUND', 'Staff membership was not found.');
    const role = Array.isArray(member.staff_roles) ? member.staff_roles[0] : member.staff_roles;
    if (role?.is_owner_role) throw new HttpError(403, 'OWNER_ACCESS_LOCKED', 'Individual overrides cannot be edited for the protected owner role.');
    const desiredIds = input.overrides.map(row => row.permissionId);
    if (desiredIds.length) {
      const { data: valid, error: validError } = await accountsAdmin.from('staff_permissions').select('id').in('id', desiredIds);
      if (validError) throw new HttpError(503, 'PERMISSION_LOOKUP_FAILED', 'Permission definitions could not be checked.');
      if ((valid || []).length !== desiredIds.length) throw new HttpError(400, 'INVALID_PERMISSION', 'One or more permissions do not exist.');
      const rows = input.overrides.map(row => ({ user_id: userId, permission_id: row.permissionId, effect: row.effect, assigned_by: req.user.id }));
      const { error: upsertError } = await accountsAdmin.from('staff_user_permissions').upsert(rows, { onConflict: 'user_id,permission_id' });
      if (upsertError) throw new HttpError(503, 'STAFF_PERMISSION_SAVE_FAILED', 'Individual permission overrides could not be saved.');
    }
    const { data: existing, error: existingError } = await accountsAdmin.from('staff_user_permissions').select('permission_id').eq('user_id', userId);
    if (existingError) throw new HttpError(503, 'STAFF_PERMISSION_SAVE_FAILED', 'Existing overrides could not be reconciled.');
    const toRemove = (existing || []).map(row => row.permission_id).filter(id => !desiredIds.includes(id));
    if (toRemove.length) {
      const { error: deleteError } = await accountsAdmin.from('staff_user_permissions').delete().eq('user_id', userId).in('permission_id', toRemove);
      if (deleteError) throw new HttpError(503, 'STAFF_PERMISSION_SAVE_FAILED', 'Old permission overrides could not be removed.');
    }
    await audit(req, 'staff.permissions.updated', 'staff', userId, { overrideCount: input.overrides.length });
    res.json({ data: { userId, overrides: input.overrides, count: input.overrides.length } });
  }));

  app.get('/api/v1/owner/audit', ...owner, asyncRoute(async(req,res)=>{
    const limit=Math.min(200,Math.max(1,Number(req.query.limit)||100));const {data,error}=await accountsAdmin.from('vineowner_audit_log').select('id,actor_user_id,action,target_type,target_id,details,created_at').order('created_at',{ascending:false}).limit(limit);
    if(error) throw new HttpError(503,'AUDIT_UNAVAILABLE','Audit log could not be loaded.');res.json({data});
  }));
}
