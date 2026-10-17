import { z } from 'zod';
import { asyncRoute, HttpError } from '@vine/shared/errors';
import { resolveStaffAccess } from '@vine/shared/rbac';

export function registerOwnerAdmin(app, { accountsAdmin, auth }) {
  const ownerOnly = async (req, _res, next) => {
    try {
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
    const {data:role,error:roleErr}=await accountsAdmin.from('staff_roles').select('id,name,is_owner_role').eq('id',input.roleId).single();
    if(roleErr||!role||role.is_owner_role) throw new HttpError(400,'STAFF_ROLE_INVALID','Choose a valid non-owner worker role.');
    const {data,error}=await accountsAdmin.auth.admin.inviteUserByEmail(input.email,{data:{full_name:input.fullName,account_type:'vine_staff'},redirectTo:process.env.VINE_STAFF_INVITE_REDIRECT_URL||'https://vinestore.com.ng/vineger.html'});
    if(error||!data?.user) throw new HttpError(400,'STAFF_INVITE_FAILED','Staff invitation failed. The email may already have an account.');
    const {error:membershipErr}=await accountsAdmin.from('staff_memberships').upsert({user_id:data.user.id,role_id:role.id,status:'active',assigned_by:req.user.id,updated_at:new Date().toISOString()},{onConflict:'user_id'});
    if(membershipErr) throw new HttpError(503,'STAFF_ASSIGN_FAILED','The invite was created but the role assignment failed; resolve it in Vineowner before inviting again.');
    await audit(req,'staff.invited','staff',data.user.id,{email:input.email,role:role.name});res.status(201).json({data:{userId:data.user.id,email:input.email,role:role.name,status:'invited'}});
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
  app.get('/api/v1/owner/audit', ...owner, asyncRoute(async(req,res)=>{
    const limit=Math.min(200,Math.max(1,Number(req.query.limit)||100));const {data,error}=await accountsAdmin.from('vineowner_audit_log').select('id,actor_user_id,action,target_type,target_id,details,created_at').order('created_at',{ascending:false}).limit(limit);
    if(error) throw new HttpError(503,'AUDIT_UNAVAILABLE','Audit log could not be loaded.');res.json({data});
  }));
}
