import crypto from 'node:crypto';
import { z } from 'zod';
import { asyncRoute, HttpError } from '@vine/shared/errors';
import { resolveStaffAccess } from '@vine/shared/rbac';
import { assertVineEmailConfigured, escapeVineHtml, isVineEmailConfigured, sendVineEmail } from '@vine/shared/email';


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
    res.json({ data: {
      provider: configured ? 'resend' : null,
      configured,
      senderAddressPresent: Boolean(String(process.env.VINE_EMAIL_FROM || '').trim()),
      message: configured
        ? 'Email provider settings are present. Resend must still accept the sender domain before delivery can be considered verified.'
        : 'Email sending is not configured. Add RESEND_API_KEY and VINE_EMAIL_FROM to the Accounts and Operations services.'
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
    const input=z.object({
      email:z.string().trim().email().max(254),
      roleId:z.string().uuid(),
      fullName:z.string().trim().max(120).default(''),
      emailVerificationRequired:z.boolean().default(true)
    }).parse(req.body);
    assertVineEmailConfigured();
    const email=input.email.trim().toLowerCase();
    const {data:role,error:roleErr}=await accountsAdmin.from('staff_roles').select('id,name,is_owner_role').eq('id',input.roleId).single();
    if(roleErr||!role||role.is_owner_role) throw new HttpError(400,'STAFF_ROLE_INVALID','Choose a valid non-owner worker role.');

    const existingUser=await findAuthUserByEmail(accountsAdmin,email);
    const redirectTo=String(process.env.VINE_STAFF_INVITE_REDIRECT_URL||'https://vinestore.com.ng/vineger.html').trim();
    let user=existingUser;
    let linkResult;
    let newlyCreated=false;
    const userMetadata={...(existingUser?.user_metadata||{}),account_type:'vine_staff'};
    if(input.fullName) userMetadata.full_name=input.fullName;

    if(existingUser){
      const updatePayload={user_metadata:userMetadata};
      if(!input.emailVerificationRequired) updatePayload.email_confirm=true;
      const {data:updateData,error:updateError}=await accountsAdmin.auth.admin.updateUserById(existingUser.id,updatePayload);
      if(updateError||!updateData?.user) throw new HttpError(503,'STAFF_ACCOUNT_UPDATE_FAILED','The existing account could not be prepared for staff access.');
      user=updateData.user;
      // Vineger uses passwordless, one-time sign-in links. When email confirmation is
      // required, the magic link is the email ownership step for an existing account.
      const {data,error}=await accountsAdmin.auth.admin.generateLink({type:'magiclink',email,options:{redirectTo}});
      if(error||!data?.properties?.action_link) throw new HttpError(503,'STAFF_LINK_GENERATION_FAILED','A secure staff sign-in link could not be prepared.');
      linkResult=data;
    }else if(input.emailVerificationRequired){
      const {data,error}=await accountsAdmin.auth.admin.generateLink({type:'invite',email,options:{data:userMetadata,redirectTo}});
      if(error||!data?.user||!data?.properties?.action_link) throw new HttpError(400,'STAFF_INVITE_FAILED','Vine could not prepare this invitation. Check the address and try again.');
      user=data.user;
      linkResult=data;
    }else{
      // Owner-approved invitation: pre-confirm the email in Supabase, but still send a
      // one-time magic sign-in link. This avoids a separate verification step without
      // disabling authentication or exposing a generated password to email.
      const oneTimePassword=crypto.randomBytes(48).toString('base64url');
      const {data:createData,error:createError}=await accountsAdmin.auth.admin.createUser({email,password:oneTimePassword,email_confirm:true,user_metadata:userMetadata});
      if(createError||!createData?.user) throw new HttpError(400,'STAFF_CREATE_FAILED','Vine could not create this owner-approved staff account. Check whether the email is already registered.');
      user=createData.user;
      newlyCreated=true;
      const {data,error}=await accountsAdmin.auth.admin.generateLink({type:'magiclink',email,options:{redirectTo}});
      if(error||!data?.properties?.action_link){
        await accountsAdmin.auth.admin.deleteUser(user.id).catch(()=>{});
        throw new HttpError(503,'STAFF_LINK_GENERATION_FAILED','The account was created but Vine could not prepare its secure sign-in link. Please retry the invitation.');
      }
      linkResult=data;
    }

    const {error:membershipErr}=await accountsAdmin.from('staff_memberships').upsert({user_id:user.id,role_id:role.id,status:'active',assigned_by:req.user.id,updated_at:new Date().toISOString()},{onConflict:'user_id'});
    if(membershipErr){
      if(newlyCreated) await accountsAdmin.auth.admin.deleteUser(user.id).catch(()=>{});
      throw new HttpError(503,'STAFF_ASSIGN_FAILED','The account was prepared, but its staff role could not be saved. Refresh the staff list before retrying.');
    }

    const actionLink=linkResult.properties.action_link;
    const subject=input.emailVerificationRequired?'You are invited to Vineger':'Your Vineger staff access is ready';
    const verificationText=input.emailVerificationRequired
      ? 'Open the secure invitation link to accept the invitation and enter Vineger.'
      : 'The Vine owner has pre-approved this account, so no separate email confirmation is required. Use the secure one-time sign-in link below to enter Vineger. For future sign-ins, use the Vineger staff sign-in page to request a fresh secure link.';
    const buttonLabel=input.emailVerificationRequired?'Accept invitation and sign in':'Sign in to Vineger';
    try {
      await sendVineEmail({
        to:email,
        subject,
        text:`You have been granted the Vine staff role: ${role.name}. ${verificationText}\n\n${actionLink}\n\nIf you were not expecting this message, contact the Vine owner.`,
        html:`<div style="font-family:Arial,sans-serif;line-height:1.6;color:#173b28;max-width:560px;margin:0 auto"><h2 style="color:#087f45">${input.emailVerificationRequired?'Welcome to Vineger':'Your Vineger staff access is ready'}</h2><p>You have been granted the Vine staff role <strong>${escapeVineHtml(role.name)}</strong>.</p><p>${escapeVineHtml(verificationText)}</p><p><a href="${escapeVineHtml(actionLink)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#087f45;color:#fff;text-decoration:none;font-weight:700">${escapeVineHtml(buttonLabel)}</a></p><p style="font-size:12px;color:#64756a">This is a secure sign-in link for the invited account. If you were not expecting this message, contact the Vine owner.</p></div>`,
        idempotencyKey:`vineger-invite:${user.id}:${linkResult.properties?.email_otp||linkResult.properties?.hashed_token||Date.now()}`
      });
    } catch(error) {
      await audit(req,'staff.invitation_email_failed','staff',user.id,{email,role:role.name,emailVerificationRequired:input.emailVerificationRequired,code:error.code||'EMAIL_DELIVERY_FAILED'});
      throw error;
    }
    await audit(req,'staff.invited','staff',user.id,{email,role:role.name,delivery:'sent',emailVerificationRequired:input.emailVerificationRequired});
    res.status(201).json({data:{userId:user.id,email,role:role.name,status:'invited',emailSent:true,emailVerificationRequired:input.emailVerificationRequired}});
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
  app.delete('/api/v1/owner/staff/:userId', ...owner, asyncRoute(async(req,res)=>{
    const userId=z.string().uuid().parse(req.params.userId);
    const configuredOwnerId=String(process.env.VINE_OWNER_USER_ID||'').trim().toLowerCase();
    const configuredOwnerEmail=String(process.env.VINE_OWNER_EMAIL||'donchester111@gmail.com').trim().toLowerCase();
    if(userId===req.user.id||userId.toLowerCase()===configuredOwnerId) throw new HttpError(403,'SELF_DELETE_BLOCKED','The owner account cannot be deleted from staff management.');

    const {data:membership,error:membershipError}=await accountsAdmin.from('staff_memberships')
      .select('user_id,status,staff_roles(name,is_owner_role)').eq('user_id',userId).maybeSingle();
    if(membershipError) throw new HttpError(503,'STAFF_DELETE_LOOKUP_FAILED','The staff membership could not be checked.');
    const {data:authResult,error:authLookupError}=await accountsAdmin.auth.admin.getUserById(userId);
    const targetUser=authResult?.user||null;
    if(authLookupError) throw new HttpError(503,'STAFF_DELETE_LOOKUP_FAILED','The staff identity could not be checked safely. Retry before deleting any account data.');
    if(!membership&&!targetUser) throw new HttpError(404,'STAFF_NOT_FOUND','That staff account was not found.');
    const roleData=Array.isArray(membership?.staff_roles)?membership.staff_roles[0]:membership?.staff_roles;
    const {data:legacyRows,error:legacyError}=await accountsAdmin.from('admin_roles').select('role').eq('user_id',userId);
    if(legacyError) throw new HttpError(503,'STAFF_DELETE_LOOKUP_FAILED','Legacy staff access could not be checked.');
    const isOwnerRole=Boolean(roleData?.is_owner_role)||String(roleData?.name||'').toLowerCase()==='owner'||(legacyRows||[]).some(row=>String(row.role||'').toLowerCase()==='owner')||String(targetUser?.email||'').trim().toLowerCase()===configuredOwnerEmail;
    if(isOwnerRole) throw new HttpError(403,'OWNER_DELETE_BLOCKED','The protected Vine owner account cannot be deleted.');
    if(membership&&membership.status!=='suspended') throw new HttpError(409,'STAFF_MUST_BE_SUSPENDED','Suspend this staff member and complete delivery handover before permanent deletion.');
    const accountType=String(targetUser?.user_metadata?.account_type||'').toLowerCase();
    const isStaff=Boolean(membership)||(legacyRows||[]).some(row=>['admin','catalog','operations','support'].includes(String(row.role||'').toLowerCase()))||accountType==='vine_staff';
    if(!isStaff) throw new HttpError(403,'NOT_A_STAFF_ACCOUNT','Only an identified Vine staff account can be deleted here.');

    // Suspend/revoke access before cleanup. Keep audit history but detach the deleted
    // identity as an actor so audit retention does not block Auth account removal.
    if(membership){
      const {error}=await accountsAdmin.from('staff_memberships').update({status:'suspended',updated_at:new Date().toISOString()}).eq('user_id',userId);
      if(error) throw new HttpError(503,'STAFF_DELETE_REVOKE_FAILED','Staff access could not be revoked; deletion was stopped.');
    }
    const cleanupSteps=[
      ['staff_user_permissions','user_id'],
      ['admin_roles','user_id'],
      ['addresses','user_id'],
      ['profiles','user_id']
    ];
    for(const [table,column] of cleanupSteps){
      const {error}=await accountsAdmin.from(table).delete().eq(column,userId);
      if(error) throw new HttpError(503,'STAFF_DELETE_CLEANUP_FAILED',`The account was suspended, but Vine could not clear its ${table} records. Permanent deletion was stopped.`);
    }
    // Preserve other staff memberships while removing references to this inviter.
    const {error:assignerError}=await accountsAdmin.from('staff_memberships').update({assigned_by:null}).eq('assigned_by',userId);
    if(assignerError) throw new HttpError(503,'STAFF_DELETE_CLEANUP_FAILED','The account was suspended, but inviter references could not be cleaned. Permanent deletion was stopped.');
    if(membership){
      const {error}=await accountsAdmin.from('staff_memberships').delete().eq('user_id',userId);
      if(error) throw new HttpError(503,'STAFF_DELETE_CLEANUP_FAILED','Staff access is suspended, but the membership row could not be removed.');
    }
    const {error:auditActorError}=await accountsAdmin.from('vineowner_audit_log').update({actor_user_id:null}).eq('actor_user_id',userId);
    if(auditActorError) throw new HttpError(503,'STAFF_DELETE_AUDIT_CLEANUP_FAILED','Staff access has been removed, but audit references could not be detached. Permanent deletion was stopped.');
    await audit(req,'staff.permanently_deleted','staff',userId,{email:targetUser?.email||'',fullName:targetUser?.user_metadata?.full_name||'',previousRole:roleData?.name||null});
    const {error:deleteAuthError}=await accountsAdmin.auth.admin.deleteUser(userId);
    if(deleteAuthError) throw new HttpError(503,'STAFF_AUTH_DELETE_FAILED','Staff access has been removed from Vine, but Supabase Auth could not permanently delete the identity. Retry after resolving its remaining database references.');
    res.status(204).end();
  }));
  app.get('/api/v1/owner/staff', ...owner, asyncRoute(async(req,res)=>{
    const {data,error}=await accountsAdmin.from('staff_memberships').select('user_id,role_id,status,created_at,updated_at,staff_roles(name,is_owner_role)').order('created_at',{ascending:false});
    if(error) throw new HttpError(503,'STAFF_LIST_FAILED','Staff list could not be loaded.');
    const rows=await Promise.all((data||[]).map(async row=>{const {data:u}=await accountsAdmin.auth.admin.getUserById(row.user_id);return {...row,email:u?.user?.email||'',fullName:u?.user?.user_metadata?.full_name||''};}));res.json({data:rows});
  }));
  const settingKeys = new Set(['storefront','commerce','shipping','payments','notifications','security','seo','policies','marketing']);
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
    // Integration status is derived from server-side environment, never trusted from a browser or persisted as owner input.
    settings.integrations = {
      paystackConfigured: Boolean(String(process.env.PAYSTACK_SECRET_KEY || '').trim()),
      emailProviderConfigured: isVineEmailConfigured(),
      smsProviderConfigured: Boolean(String(process.env.SMS_PROVIDER || '').trim())
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: { settings, updatedAt: Object.fromEntries((data || []).map(row => [row.setting_key, row.updated_at])), readOnlyGroups: ['integrations'] } });
  }));

  app.put('/api/v1/owner/settings/:key', ...owner, asyncRoute(async (req, res) => {
    const key = String(req.params.key || '');
    if (key === 'integrations') throw new HttpError(403, 'SETTING_GROUP_READ_ONLY', 'Integration status is computed from service environment variables and cannot be edited here.');
    if (!settingKeys.has(key)) throw new HttpError(404, 'SETTING_GROUP_NOT_FOUND', 'That settings group is not supported.');
    const input = z.object({ value: z.record(z.string(), z.any()) }).strict().parse(req.body);
    const allowedSettingFields = {
      storefront: ['storeName','tagline','supportEmail','supportPhone','currency','timezone','maintenanceMode','announcementEnabled','announcementText'],
      commerce: ['checkoutEnabled','minOrderNgn','maxItemsPerOrder','allowGuestCheckout','orderNumberPrefix'],
      shipping: ['baseFeeNgn','freeShippingEnabled','freeShippingThresholdNgn','estimatedMinDays','estimatedMaxDays','coverageStates'],
      payments: ['paystackEnabled','bankTransferEnabled','bankName','accountName','accountNumber','manualTransferReview','paymentHoldMinutes'],
      notifications: ['orderEmailsEnabled','marketingEmailsEnabled','smsEnabled','provider','senderName'],
      security: ['requireEmailConfirmation','staffInviteApproval','sessionMinutes','alertOnRoleChanges'],
      seo: ['title','description','canonicalUrl','socialImageUrl'],
      policies: ['returnsPolicy','privacyPolicy','termsOfService','shippingPolicy'],
      marketing: ['promotionsEnabled','newsletterEnabled','loyaltyEnabled']
    };
    const unsupportedFields = Object.keys(input.value).filter(field => !allowedSettingFields[key].includes(field));
    if (unsupportedFields.length) throw new HttpError(400, 'SETTING_FIELD_NOT_SUPPORTED', `Unsupported field(s) in ${key}: ${unsupportedFields.join(', ')}. Refresh the owner settings page and try again.`);
    const booleanFields = {
      storefront: ['maintenanceMode','announcementEnabled'], commerce: ['checkoutEnabled','allowGuestCheckout'],
      shipping: ['freeShippingEnabled'], payments: ['paystackEnabled','bankTransferEnabled','manualTransferReview'],
      notifications: ['orderEmailsEnabled','marketingEmailsEnabled','smsEnabled'],
      security: ['requireEmailConfirmation','staffInviteApproval','alertOnRoleChanges'],
      marketing: ['promotionsEnabled','newsletterEnabled','loyaltyEnabled']
    };
    for (const field of booleanFields[key] || []) if (input.value[field] !== undefined && typeof input.value[field] !== 'boolean') {
      throw new HttpError(400, 'SETTING_FIELD_INVALID', `${field} must be true or false.`);
    }
    const numericRules = {
      minOrderNgn: [0, 100000000, false], maxItemsPerOrder: [1, 50, true],
      baseFeeNgn: [0, 100000000, false], freeShippingThresholdNgn: [0, 100000000, false],
      estimatedMinDays: [0, 365, true], estimatedMaxDays: [0, 365, true],
      paymentHoldMinutes: [5, 1440, true], sessionMinutes: [5, 120, true]
    };
    for (const [field, [min, max, integer]] of Object.entries(numericRules)) if (input.value[field] !== undefined) {
      const value = input.value[field];
      const nullable = ['baseFeeNgn','freeShippingThresholdNgn'].includes(field);
      if (value === null && nullable) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        throw new HttpError(400, 'SETTING_FIELD_INVALID', `${field} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`);
      }
    }
    if (key === 'payments' && input.value.accountNumber !== undefined && input.value.accountNumber !== '' && !/^\d{10}$/.test(String(input.value.accountNumber))) {
      throw new HttpError(400, 'BANK_ACCOUNT_NUMBER_INVALID', 'The public receiving account number must contain exactly 10 digits.');
    }
    if (key === 'storefront' && input.value.supportEmail && !/^\S+@\S+\.\S+$/.test(String(input.value.supportEmail))) {
      throw new HttpError(400, 'SUPPORT_EMAIL_INVALID', 'Enter a valid support email address or leave the field blank.');
    }
    for (const field of ['canonicalUrl','socialImageUrl']) if (key === 'seo' && input.value[field]) {
      try { if (new URL(String(input.value[field])).protocol !== 'https:') throw new Error('protocol'); }
      catch { throw new HttpError(400, 'SEO_URL_INVALID', `${field} must be a valid HTTPS URL or blank.`); }
    }
    if (key === 'shipping' && Number.isInteger(input.value.estimatedMinDays) && Number.isInteger(input.value.estimatedMaxDays) && input.value.estimatedMaxDays < input.value.estimatedMinDays) {
      throw new HttpError(400, 'DELIVERY_WINDOW_INVALID', 'Estimated maximum delivery days must be at least the minimum days.');
    }
    assertSafeSettings(input.value);
    const { data, error } = await accountsAdmin.from('vineowner_settings').upsert({
      setting_key: key, setting_value: input.value, updated_by: req.user.id, updated_at: new Date().toISOString()
    }, { onConflict: 'setting_key' }).select('setting_key,setting_value,updated_at').single();
    if (error) {
      // Log only provider diagnostics—not the setting values, tokens, or bank-account payload.
      console.error(JSON.stringify({ level: 'error', service: process.env.SERVICE_NAME, event: 'owner_settings_save_failed', settingKey: key, code: error.code || null, message: String(error.message || '').slice(0, 300), details: String(error.details || '').slice(0, 300), hint: String(error.hint || '').slice(0, 200) }));
      throw new HttpError(503, 'SETTINGS_SAVE_FAILED', `Settings could not be saved (database code ${String(error.code || 'unknown').slice(0, 32)}). Check the Accounts API logs for the diagnostic detail.`);
    }
    let auditRecorded = true;
    try { await audit(req, 'settings.updated', 'settings', key, { settingKey: key, fieldCount: Object.keys(input.value).length }); }
    catch (auditError) {
      auditRecorded = false;
      console.error(JSON.stringify({ level: 'error', service: process.env.SERVICE_NAME, event: 'owner_settings_audit_failed', settingKey: key, code: auditError.code || 'AUDIT_WRITE_FAILED' }));
    }
    res.json({ data: { key: data.setting_key, value: data.setting_value, updatedAt: data.updated_at, auditRecorded } });
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
